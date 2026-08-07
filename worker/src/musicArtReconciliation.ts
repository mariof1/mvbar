import { opendir, readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { db } from './db.js';
import {
  isCurrentMusicArtPath,
  MUSIC_ART_MAX_DIMENSION,
  MUSIC_ART_MAX_SOURCE_BYTES,
  writeMusicArt,
} from './art.js';
import logger from './logger.js';
import { readTags } from './metadata.js';
import { resolveInside } from './pathSafety.js';

const ART_DIR = process.env.ART_DIR ?? '/data/cache/art';
const RECONCILIATION_CONCURRENCY = 2;
const MAX_WARNING_SAMPLES = 20;

type ArtworkReference = { art_path: string };
type TrackSource = { mount_path: string; path: string };

function resolveArtPath(relativePath: string): string {
  return resolveInside(ART_DIR, relativePath);
}

async function isFile(relativePath: string): Promise<boolean> {
  try {
    return (await stat(resolveArtPath(relativePath))).isFile();
  } catch {
    return false;
  }
}

async function directoryContainsFile(directory: string): Promise<boolean> {
  try {
    const entries = await opendir(directory);
    for await (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isFile()) return true;
      if (entry.isDirectory() && await directoryContainsFile(path.join(directory, entry.name))) return true;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return false;
}

async function hasAvailableMusicSource(): Promise<boolean> {
  const libraries = await db().query<{ mount_path: string }>(
    `SELECT DISTINCT l.mount_path
     FROM libraries l
     JOIN tracks t ON t.library_id = l.id
     WHERE l.enabled = TRUE
       AND t.deleted_at IS NULL
       AND t.art_path IS NOT NULL`,
  );
  for (const library of libraries.rows) {
    try {
      if ((await stat(path.resolve(library.mount_path))).isDirectory()) return true;
    } catch {
      // Try the next configured library root.
    }
  }
  return false;
}

async function recoverEmbeddedArtwork(relativePath: string): Promise<Buffer | null> {
  const sources = await db().query<TrackSource>(
    `SELECT l.mount_path, t.path
     FROM tracks t
     JOIN libraries l ON l.id = t.library_id
     WHERE t.art_path = $1
       AND t.deleted_at IS NULL
       AND l.enabled = TRUE
     LIMIT 5`,
    [relativePath],
  );
  for (const source of sources.rows) {
    try {
      const tags = await readTags(resolveInside(source.mount_path, source.path));
      if (tags.artData) return Buffer.from(tags.artData);
    } catch {
      // Try another track sharing the same artwork.
    }
  }
  return null;
}

async function processWithConcurrency<T>(
  items: T[],
  concurrency: number,
  processor: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  async function run() {
    while (index < items.length) {
      const item = items[index++];
      await processor(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()));
}

export async function reconcileMusicArtwork(): Promise<{
  migrated: number;
  recovered: number;
  failed: number;
}> {
  const references = await db().query<ArtworkReference>(
    `SELECT DISTINCT art_path
     FROM (
       SELECT art_path FROM tracks WHERE art_path IS NOT NULL
       UNION
       SELECT art_path FROM artists WHERE art_path IS NOT NULL
     ) artwork`,
  );
  if (references.rows.length === 0) return { migrated: 0, recovered: 0, failed: 0 };

  // A database-only portable restore may have neither cache nor mounted media.
  // Avoid thousands of doomed recovery attempts on a metadata-only host.
  const cacheHasFiles = await directoryContainsFile(path.resolve(ART_DIR));
  if (!cacheHasFiles && !(await hasAvailableMusicSource())) {
    logger.info('music-art', 'Music artwork cache is empty and no music source is mounted; reconciliation skipped');
    return { migrated: 0, recovered: 0, failed: 0 };
  }

  const candidates: ArtworkReference[] = [];
  for (const reference of references.rows) {
    if (!isCurrentMusicArtPath(reference.art_path) || !(await isFile(reference.art_path))) {
      candidates.push(reference);
    }
  }
  if (candidates.length === 0) return { migrated: 0, recovered: 0, failed: 0 };

  logger.info(
    'music-art',
    `Reconciling ${candidates.length} legacy or missing music artwork files as ${MUSIC_ART_MAX_DIMENSION}px JPEGs...`,
  );

  let attempted = 0;
  let migrated = 0;
  let recovered = 0;
  let failed = 0;
  await processWithConcurrency(candidates, RECONCILIATION_CONCURRENCY, async (reference) => {
    let oldFileExists = false;
    try {
      let source: Buffer | null = null;
      try {
        const oldPath = resolveArtPath(reference.art_path);
        const oldStat = await stat(oldPath);
        if (!oldStat.isFile()) throw new Error('cached artwork is not a file');
        if (oldStat.size > MUSIC_ART_MAX_SOURCE_BYTES) {
          throw new Error(`cached artwork is larger than ${MUSIC_ART_MAX_SOURCE_BYTES} bytes`);
        }
        source = await readFile(oldPath);
        oldFileExists = true;
      } catch {
        source = await recoverEmbeddedArtwork(reference.art_path);
        if (source) recovered += 1;
      }
      if (!source) throw new Error('cached file and source media artwork are unavailable');

      const normalized = await writeMusicArt(ART_DIR, source);
      const client = await db().connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `UPDATE tracks
           SET art_path = $1, art_mime = $2, art_hash = $3
           WHERE art_path = $4`,
          [normalized.relPath, normalized.mime, normalized.hash, reference.art_path],
        );
        await client.query(
          'UPDATE artists SET art_path = $1, art_hash = $2 WHERE art_path = $3',
          [normalized.relPath, normalized.hash, reference.art_path],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }

      if (oldFileExists && normalized.relPath !== reference.art_path) {
        await unlink(resolveArtPath(reference.art_path)).catch(() => undefined);
      }
      migrated += 1;
    } catch (error) {
      failed += 1;
      if (failed <= MAX_WARNING_SAMPLES) {
        logger.warn(
          'music-art',
          `Could not reconcile ${reference.art_path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally {
      attempted += 1;
      if (attempted % 250 === 0) {
        logger.info('music-art', `Artwork reconciliation progress: ${attempted}/${candidates.length}`);
      }
    }
  });

  if (failed > MAX_WARNING_SAMPLES) {
    logger.warn('music-art', `${failed - MAX_WARNING_SAMPLES} additional artwork reconciliation failures were suppressed`);
  }
  logger.success(
    'music-art',
    `Music artwork reconciliation complete: ${migrated} normalized, ${recovered} recovered from media, ${failed} failed`,
  );
  return { migrated, recovered, failed };
}

import { readdir, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { db } from './db.js';
import logger from './logger.js';
import { readTags } from './metadata.js';
import { writeArt } from './art.js';

const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.m4b', '.flac', '.aac', '.ogg', '.opus', '.wav']);
const COVER_NAMES = ['cover.jpg', 'cover.png', 'folder.jpg', 'folder.png'];
const ART_DIR = '/data/cache/audiobook-art';

function naturalSort(a: string, b: string): number {
  const re = /(\d+)|(\D+)/g;
  const aParts = a.match(re) || [];
  const bParts = b.match(re) || [];
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const aPart = aParts[i] || '';
    const bPart = bParts[i] || '';
    const aNum = Number(aPart);
    const bNum = Number(bPart);
    if (!isNaN(aNum) && !isNaN(bNum)) {
      if (aNum !== bNum) return aNum - bNum;
    } else {
      const cmp = aPart.localeCompare(bPart);
      if (cmp !== 0) return cmp;
    }
  }
  return 0;
}

function mimeFromExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case '.png': return 'image/png';
    case '.jpg': case '.jpeg': return 'image/jpeg';
    default: return 'image/jpeg';
  }
}

async function detectCover(
  audiobookDir: string,
  files: string[],
  firstFileTags: { artData: Uint8Array | null; artMime: string | null },
): Promise<string | null> {
  // Look for cover image files (case insensitive)
  const lowerMap = new Map(files.map(f => [f.toLowerCase(), f]));
  for (const name of COVER_NAMES) {
    const actual = lowerMap.get(name);
    if (actual) {
      try {
        const data = await readFile(path.join(audiobookDir, actual));
        const mime = mimeFromExt(path.extname(actual));
        const result = await writeArt(ART_DIR, data, mime);
        return result.relPath;
      } catch {
        // fall through to embedded art
      }
    }
  }

  // Try embedded art from first audio file
  if (firstFileTags.artData && firstFileTags.artMime) {
    try {
      const result = await writeArt(ART_DIR, firstFileTags.artData, firstFileTags.artMime);
      return result.relPath;
    } catch {
      // ignore
    }
  }

  return null;
}

async function scanOneAudiobook(audiobookDir: string): Promise<{
  chapterCount: number;
  totalDurationMs: number;
} | null> {
  let entries;
  try {
    entries = await readdir(audiobookDir, { withFileTypes: true });
  } catch (e) {
    logger.warn('audiobook-scan', `Cannot read directory: ${audiobookDir}`, {
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }

  const allFiles: string[] = [];
  const audioFiles: string[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    allFiles.push(entry.name);
    const ext = path.extname(entry.name).toLowerCase();
    if (AUDIO_EXTS.has(ext)) {
      audioFiles.push(entry.name);
    }
  }

  if (audioFiles.length === 0) return null;

  // Natural sort to determine chapter order
  audioFiles.sort(naturalSort);

  // Read metadata from first file
  const firstFilePath = path.join(audiobookDir, audioFiles[0]);
  let firstTags: Awaited<ReturnType<typeof readTags>> | null = null;
  try {
    firstTags = await readTags(firstFilePath);
  } catch {
    logger.warn('audiobook-scan', `Failed to read tags from: ${firstFilePath}`);
  }

  // Determine audiobook metadata
  const dirName = path.basename(audiobookDir);
  const title = firstTags?.album || dirName;
  const author = firstTags?.albumartist || firstTags?.artist || null;
  const narrator =
    firstTags?.albumartist && firstTags?.artist && firstTags.albumartist !== firstTags.artist
      ? firstTags.artist
      : null;

  // Detect cover art
  const coverPath = await detectCover(audiobookDir, allFiles, {
    artData: firstTags?.artData ?? null,
    artMime: firstTags?.artMime ?? null,
  });

  // Collect chapter info (tags + stat for each file)
  interface ChapterInfo {
    filename: string;
    position: number;
    title: string;
    durationMs: number | null;
    sizeBytes: number;
    mtimeMs: number;
  }

  const chapters: ChapterInfo[] = [];
  let totalDurationMs = 0;
  let allDurationsKnown = true;

  for (let i = 0; i < audioFiles.length; i++) {
    const filename = audioFiles[i];
    const filePath = path.join(audiobookDir, filename);

    // Get tags — reuse firstTags for position 0
    let tags: Awaited<ReturnType<typeof readTags>> | null = null;
    if (i === 0) {
      tags = firstTags;
    } else {
      try {
        tags = await readTags(filePath);
      } catch {
        // duration will be null
      }
    }

    let st;
    try {
      st = await stat(filePath);
    } catch {
      logger.warn('audiobook-scan', `Cannot stat file: ${filePath}`);
      continue;
    }

    const chapterTitle = tags?.title || path.basename(filename, path.extname(filename));
    const durationMs = tags?.durationMs ?? null;

    if (durationMs != null) {
      totalDurationMs += durationMs;
    } else {
      allDurationsKnown = false;
    }

    chapters.push({
      filename,
      position: chapters.length,
      title: chapterTitle,
      durationMs,
      sizeBytes: st.size,
      mtimeMs: Math.floor(st.mtimeMs),
    });
  }

  if (!allDurationsKnown) totalDurationMs = 0;

  // Upsert audiobook
  const { rows } = await db().query<{ id: number }>(
    `INSERT INTO audiobooks (path, title, author, narrator, cover_path, duration_ms)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (path) DO UPDATE SET
       title = EXCLUDED.title, author = EXCLUDED.author, narrator = EXCLUDED.narrator,
       cover_path = EXCLUDED.cover_path, duration_ms = EXCLUDED.duration_ms,
       updated_at = now()
     RETURNING id`,
    [audiobookDir, title, author, narrator, coverPath, totalDurationMs],
  );
  const audiobookId = rows[0].id;

  // Upsert chapters
  for (const ch of chapters) {
    await db().query(
      `INSERT INTO audiobook_chapters (audiobook_id, path, title, position, duration_ms, size_bytes, mtime_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (audiobook_id, path) DO UPDATE SET
         title = EXCLUDED.title, position = EXCLUDED.position,
         duration_ms = EXCLUDED.duration_ms, size_bytes = EXCLUDED.size_bytes,
         mtime_ms = EXCLUDED.mtime_ms`,
      [audiobookId, ch.filename, ch.title, ch.position, ch.durationMs, ch.sizeBytes, ch.mtimeMs],
    );
  }

  // Remove stale chapters no longer on disk
  const currentFilenames = chapters.map(ch => ch.filename);
  await db().query(
    `DELETE FROM audiobook_chapters WHERE audiobook_id = $1 AND path != ALL($2::text[])`,
    [audiobookId, currentFilenames],
  );

  return { chapterCount: chapters.length, totalDurationMs };
}

export async function scanAudiobooks(audiobookDirs: string[]): Promise<void> {
  const startedAt = Date.now();
  logger.info('audiobook-scan', `Starting audiobook scan across ${audiobookDirs.length} director${audiobookDirs.length === 1 ? 'y' : 'ies'}`);

  let audiobookCount = 0;
  let totalChapters = 0;
  let totalDurationMs = 0;
  const validPaths = new Set<string>();

  for (const rootDir of audiobookDirs) {
    let topEntries;
    try {
      topEntries = await readdir(rootDir, { withFileTypes: true });
    } catch (e) {
      logger.error('audiobook-scan', `Cannot read audiobook root: ${rootDir}`, {
        error: e instanceof Error ? e.message : String(e),
      });
      continue;
    }

    for (const entry of topEntries) {
      if (!entry.isDirectory()) continue;

      const audiobookDir = path.join(rootDir, entry.name);
      try {
        const result = await scanOneAudiobook(audiobookDir);
        if (result) {
          validPaths.add(audiobookDir);
          audiobookCount++;
          totalChapters += result.chapterCount;
          totalDurationMs += result.totalDurationMs;
        }
      } catch (e) {
        logger.error('audiobook-scan', `Failed to scan audiobook: ${audiobookDir}`, {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  // Remove stale audiobooks no longer on disk
  if (validPaths.size > 0) {
    await db().query(
      `DELETE FROM audiobooks WHERE path != ALL($1::text[])`,
      [Array.from(validPaths)],
    );
  } else {
    // If no valid audiobooks found at all, remove everything
    await db().query(`DELETE FROM audiobooks`);
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  const durationHrs = (totalDurationMs / 3_600_000).toFixed(1);
  logger.success(
    'audiobook-scan',
    `Scan complete in ${elapsed}s — ${audiobookCount} audiobook${audiobookCount === 1 ? '' : 's'}, ${totalChapters} chapters, ${durationHrs}h total duration`,
  );
}

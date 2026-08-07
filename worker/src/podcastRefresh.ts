import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, opendir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { db } from './db.js';
import logger from './logger.js';

const PODCAST_ART_DIR = process.env.PODCAST_ART_DIR ?? '/data/cache/podcast-art';
const PODCAST_REFRESH_INTERVAL_MS = parseInt(process.env.PODCAST_REFRESH_INTERVAL_MS ?? '3600000', 10); // 1 hour
const FFMPEG_PATH = process.env.FFMPEG_PATH ?? 'ffmpeg';
const PODCAST_ART_CACHE_VERSION = 'v2';
const PODCAST_ART_MAX_DIMENSION = 640;
const PODCAST_ART_JPEG_QUALITY = 3;
const PODCAST_ART_MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const PODCAST_ART_MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
const PODCAST_ART_BACKFILL_CONCURRENCY = 4;

interface Podcast {
  id: number;
  feed_url: string;
  title: string;
  image_url: string | null;
  image_path: string | null;
}

let refreshInProgress = false;

export function isCurrentPodcastArtPath(relativePath: string | null): boolean {
  if (!relativePath) return false;
  return relativePath.replaceAll('\\', '/').startsWith(`${PODCAST_ART_CACHE_VERSION}/`);
}

function resolvePodcastArtPath(relativePath: string): string {
  const root = path.resolve(PODCAST_ART_DIR);
  const resolved = path.resolve(root, relativePath);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Unsafe podcast artwork path: ${relativePath}`);
  }
  return resolved;
}

async function cachedImageExists(relativePath: string | null): Promise<boolean> {
  if (!isCurrentPodcastArtPath(relativePath)) return false;
  try {
    const imageStat = await stat(resolvePodcastArtPath(relativePath!));
    return imageStat.isFile();
  } catch {
    return false;
  }
}

async function responseBuffer(response: Response): Promise<Buffer> {
  const declaredSize = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declaredSize) && declaredSize > PODCAST_ART_MAX_SOURCE_BYTES) {
    throw new Error(`Image is larger than ${PODCAST_ART_MAX_SOURCE_BYTES} bytes`);
  }
  if (!response.body) throw new Error('Image response has no body');

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > PODCAST_ART_MAX_SOURCE_BYTES) {
      await reader.cancel();
      throw new Error(`Image is larger than ${PODCAST_ART_MAX_SOURCE_BYTES} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size);
}

export function resizePodcastArtwork(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const filter = [
      `scale=w='min(${PODCAST_ART_MAX_DIMENSION},iw)'`,
      `h='min(${PODCAST_ART_MAX_DIMENSION},ih)'`,
      'force_original_aspect_ratio=decrease',
      'force_divisible_by=2',
    ].join(':');
    const child = spawn(FFMPEG_PATH, [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', 'pipe:0',
      '-vf', filter,
      '-frames:v', '1',
      '-an',
      '-sn',
      '-map_metadata', '-1',
      '-c:v', 'mjpeg',
      '-q:v', String(PODCAST_ART_JPEG_QUALITY),
      '-pix_fmt', 'yuvj420p',
      '-f', 'image2pipe',
      'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let outputSize = 0;
    let rejectedForSize = false;
    child.stdout.on('data', (chunk: Buffer) => {
      outputSize += chunk.length;
      if (outputSize > PODCAST_ART_MAX_OUTPUT_BYTES) {
        rejectedForSize = true;
        child.kill('SIGKILL');
        return;
      }
      output.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (errors.reduce((total, value) => total + value.length, 0) < 8192) errors.push(chunk);
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (rejectedForSize) {
        reject(new Error(`Resized image exceeded ${PODCAST_ART_MAX_OUTPUT_BYTES} bytes`));
        return;
      }
      if (code !== 0 || outputSize === 0) {
        const detail = Buffer.concat(errors).toString('utf8').trim();
        reject(new Error(detail || `FFmpeg exited with code ${code}`));
        return;
      }
      resolve(Buffer.concat(output, outputSize));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

async function storeNormalizedArtwork(source: Buffer): Promise<string> {
  const resized = await resizePodcastArtwork(source);
  const hash = createHash('sha1').update(resized).digest('hex');
  const relativePath = `${PODCAST_ART_CACHE_VERSION}/${hash.slice(0, 2)}/${hash}.jpg`;
  const absolutePath = resolvePodcastArtPath(relativePath);
  try {
    const imageStat = await stat(absolutePath);
    if (imageStat.isFile()) return relativePath;
  } catch {
    // Write the normalized file below.
  }
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, resized);
  return relativePath;
}

// Download, resize, and cache an image, returning its portable cached path.
async function cacheImage(imageUrl: string, _prefix = 'artwork'): Promise<string | null> {
  if (!imageUrl) return null;
  try {
    const response = await fetch(imageUrl, {
      headers: { 'User-Agent': 'mvbar/1.0 Podcast Client' },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      logger.warn('podcast', `Failed to fetch image: ${response.status} ${imageUrl}`);
      return null;
    }
    const relativePath = await storeNormalizedArtwork(await responseBuffer(response));
    logger.debug('podcast', `Cached resized image: ${relativePath}`);
    return relativePath;
  } catch (e) {
    logger.warn('podcast', `Error caching image: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

type StoredArtworkRow = {
  kind: 'podcast' | 'episode';
  id: number;
  image_url: string;
  image_path: string | null;
};

async function migrateLegacyArtwork(): Promise<{ migrated: number; failed: number }> {
  const legacy = await db().query<{ image_path: string }>(
    `SELECT DISTINCT image_path
     FROM (
       SELECT image_path FROM podcasts WHERE image_path IS NOT NULL
       UNION
       SELECT image_path FROM podcast_episodes WHERE image_path IS NOT NULL
     ) artwork
     WHERE image_path NOT LIKE $1`,
    [`${PODCAST_ART_CACHE_VERSION}/%`],
  );
  if (legacy.rows.length === 0) return { migrated: 0, failed: 0 };

  logger.info('podcast', `Migrating ${legacy.rows.length} legacy artwork files to ${PODCAST_ART_MAX_DIMENSION}px JPEGs...`);
  let migrated = 0;
  let failed = 0;
  for (const row of legacy.rows) {
    try {
      const oldAbsolutePath = resolvePodcastArtPath(row.image_path);
      const oldStat = await stat(oldAbsolutePath);
      if (!oldStat.isFile()) continue;
      if (oldStat.size > PODCAST_ART_MAX_SOURCE_BYTES) {
        throw new Error(`Source image is larger than ${PODCAST_ART_MAX_SOURCE_BYTES} bytes`);
      }

      const newPath = await storeNormalizedArtwork(await readFile(oldAbsolutePath));
      const client = await db().connect();
      try {
        await client.query('BEGIN');
        await client.query('UPDATE podcasts SET image_path = $1 WHERE image_path = $2', [newPath, row.image_path]);
        await client.query('UPDATE podcast_episodes SET image_path = $1 WHERE image_path = $2', [newPath, row.image_path]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      await unlink(oldAbsolutePath).catch(() => undefined);
      migrated += 1;
      if (migrated % 250 === 0) {
        logger.info('podcast', `Artwork migration progress: ${migrated}/${legacy.rows.length}`);
      }
    } catch (error) {
      failed += 1;
      logger.warn('podcast', `Could not migrate ${row.image_path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { migrated, failed };
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

async function backfillStoredArtwork(): Promise<{ refreshed: number; failed: number }> {
  const pending = await db().query<StoredArtworkRow>(
    `SELECT 'podcast'::text AS kind, id, image_url, image_path
     FROM podcasts
     WHERE image_url IS NOT NULL
       AND (image_path IS NULL OR image_path NOT LIKE $1)
     UNION ALL
     SELECT 'episode'::text AS kind, id, image_url, image_path
     FROM podcast_episodes
     WHERE image_url IS NOT NULL
       AND (image_path IS NULL OR image_path NOT LIKE $1)`,
    [`${PODCAST_ART_CACHE_VERSION}/%`],
  );
  if (pending.rows.length === 0) return { refreshed: 0, failed: 0 };

  logger.info('podcast', `Refreshing ${pending.rows.length} missing or legacy artwork references...`);
  const downloads = new Map<string, Promise<string | null>>();
  let refreshed = 0;
  let failed = 0;
  await processWithConcurrency(pending.rows, PODCAST_ART_BACKFILL_CONCURRENCY, async (row) => {
    let download = downloads.get(row.image_url);
    if (!download) {
      download = cacheImage(row.image_url);
      downloads.set(row.image_url, download);
    }
    const newPath = await download;
    if (!newPath) {
      failed += 1;
      return;
    }
    if (row.kind === 'podcast') {
      await db().query('UPDATE podcasts SET image_path = $1 WHERE id = $2', [newPath, row.id]);
    } else {
      await db().query('UPDATE podcast_episodes SET image_path = $1 WHERE id = $2', [newPath, row.id]);
    }
    refreshed += 1;
    if (refreshed % 250 === 0) {
      logger.info('podcast', `Artwork backfill progress: ${refreshed}/${pending.rows.length}`);
    }
  });
  return { refreshed, failed };
}

async function pruneUnreferencedArtwork(): Promise<number> {
  const referenced = await db().query<{ image_path: string }>(
    `SELECT DISTINCT image_path
     FROM (
       SELECT image_path FROM podcasts WHERE image_path IS NOT NULL
       UNION
       SELECT image_path FROM podcast_episodes WHERE image_path IS NOT NULL
     ) artwork`,
  );
  const keep = new Set(referenced.rows.map((row) => row.image_path.replaceAll('\\', '/')));
  let removed = 0;

  async function walk(directory: string, relativeDirectory: string): Promise<void> {
    const entries = await opendir(directory);
    for await (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
      } else if (entry.isFile() && !keep.has(relativePath)) {
        await unlink(absolutePath);
        removed += 1;
      }
    }
  }

  try {
    await walk(path.resolve(PODCAST_ART_DIR), '');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return removed;
}

// Refresh a single podcast's feed and cache images
async function refreshPodcast(podcast: Podcast): Promise<{ newEpisodes: number; imagesCached: number }> {
  let newEpisodes = 0;
  let imagesCached = 0;
  
  try {
    // Fetch and parse RSS feed
    const response = await fetch(podcast.feed_url, {
      headers: { 'User-Agent': 'mvbar/1.0 Podcast Client' },
      signal: AbortSignal.timeout(60000)
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const xml = await response.text();
    const { XMLParser } = await import('fast-xml-parser');
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_'
    });
    
    const parsed = parser.parse(xml);
    const channel = parsed?.rss?.channel;
    if (!channel) throw new Error('Invalid RSS feed');
    
    // Cache podcast image if not already cached
    if (podcast.image_url && !(await cachedImageExists(podcast.image_path))) {
      const imagePath = await cacheImage(podcast.image_url, 'podcasts');
      if (imagePath) {
        await db().query('UPDATE podcasts SET image_path = $1 WHERE id = $2', [imagePath, podcast.id]);
        imagesCached++;
      }
    }
    
    // Parse episodes
    const items = Array.isArray(channel.item) ? channel.item : channel.item ? [channel.item] : [];
    
    for (const item of items) {
      const enclosure = item.enclosure;
      if (!enclosure?.['@_url']) continue;
      
      const guid = item.guid?.['#text'] || item.guid || enclosure['@_url'];
      const title = item.title || 'Untitled';
      const description = item.description || item['itunes:summary'] || '';
      const audioUrl = enclosure['@_url'];
      const durationMs = parseDuration(item['itunes:duration']);
      const publishedAt = item.pubDate ? new Date(item.pubDate) : null;
      const episodeImageUrl = item['itunes:image']?.['@_href'] || null;
      
      // Upsert episode
      const result = await db().query<{ id: number; image_path: string | null }>(
        `INSERT INTO podcast_episodes (podcast_id, guid, title, description, audio_url, duration_ms, published_at, image_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (podcast_id, guid) DO UPDATE SET
           title = EXCLUDED.title,
           description = EXCLUDED.description,
           audio_url = EXCLUDED.audio_url,
           duration_ms = COALESCE(EXCLUDED.duration_ms, podcast_episodes.duration_ms)
         RETURNING id, image_path`,
        [podcast.id, guid, title, description.slice(0, 10000), audioUrl, durationMs, publishedAt, episodeImageUrl]
      );
      
      if (result.rows.length > 0) {
        const episode = result.rows[0];
        
        // Cache episode image if has custom image and not cached
        if (episodeImageUrl && !(await cachedImageExists(episode.image_path))) {
          const imagePath = await cacheImage(episodeImageUrl, 'episodes');
          if (imagePath) {
            await db().query('UPDATE podcast_episodes SET image_path = $1 WHERE id = $2', [imagePath, episode.id]);
            imagesCached++;
          }
        }
        
        newEpisodes++;
      }
    }
    
    // Update last_fetched_at
    await db().query('UPDATE podcasts SET last_fetched_at = NOW() WHERE id = $1', [podcast.id]);
    
  } catch (e) {
    logger.warn('podcast', `Failed to refresh ${podcast.title}: ${e instanceof Error ? e.message : String(e)}`);
  }
  
  return { newEpisodes, imagesCached };
}

// Parse iTunes duration format to milliseconds
function parseDuration(duration: string | number | undefined): number | null {
  if (!duration) return null;
  if (typeof duration === 'number') return duration * 1000;
  
  const parts = String(duration).split(':').map(Number);
  if (parts.length === 3) {
    return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
  } else if (parts.length === 2) {
    return (parts[0] * 60 + parts[1]) * 1000;
  } else if (parts.length === 1 && !isNaN(parts[0])) {
    return parts[0] * 1000;
  }
  return null;
}

// Refresh all podcasts that have at least one subscriber
async function refreshAllPodcasts(): Promise<void> {
  if (refreshInProgress) {
    logger.info('podcast', 'Podcast refresh already in progress');
    return;
  }
  refreshInProgress = true;
  logger.info('podcast', 'Starting automatic podcast refresh...');
  
  try {
    const migration = await migrateLegacyArtwork();
    const backfill = await backfillStoredArtwork();

    // Get all podcasts that have at least one subscriber
    const podcasts = await db().query<Podcast>(
      `SELECT DISTINCT p.id, p.feed_url, p.title, p.image_url, p.image_path
       FROM podcasts p
       JOIN user_podcast_subscriptions ups ON ups.podcast_id = p.id`
    );
    
    if (podcasts.rows.length === 0) {
      const pruned = await pruneUnreferencedArtwork();
      logger.info(
        'podcast',
        `No subscribed podcasts to refresh; migrated ${migration.migrated}, refreshed ${backfill.refreshed}, pruned ${pruned} artwork files`,
      );
      return;
    }
    
    let totalNewEpisodes = 0;
    let totalImagesCached = 0;
    
    for (const podcast of podcasts.rows) {
      const { newEpisodes, imagesCached } = await refreshPodcast(podcast);
      totalNewEpisodes += newEpisodes;
      totalImagesCached += imagesCached;
    }

    const pruned = await pruneUnreferencedArtwork();
    logger.success(
      'podcast',
      `Refreshed ${podcasts.rows.length} podcasts: ${totalNewEpisodes} episodes processed, ${totalImagesCached} feed images cached; `
      + `${migration.migrated} legacy files resized (${migration.failed} failed), `
      + `${backfill.refreshed} stored references refreshed (${backfill.failed} failed), ${pruned} unreferenced files pruned`,
    );
  } catch (e) {
    logger.error('podcast', `Podcast refresh failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    refreshInProgress = false;
  }
}

// Start the periodic podcast refresh
export function startPodcastRefresh(): void {
  logger.info('podcast', `Scheduling podcast refresh every ${PODCAST_REFRESH_INTERVAL_MS / 60000} minutes`);
  
  // Initial refresh after a short delay (let other services start first)
  setTimeout(() => {
    refreshAllPodcasts();
  }, 30000);
  
  // Then refresh periodically
  setInterval(() => {
    refreshAllPodcasts();
  }, PODCAST_REFRESH_INTERVAL_MS);
}

// Export for manual refresh
export { refreshAllPodcasts, refreshPodcast, cacheImage };

import { createHash } from 'node:crypto';
import { writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { db } from './db.js';
import logger from './logger.js';

const PODCAST_ART_DIR = process.env.PODCAST_ART_DIR ?? '/data/cache/podcast-art';
const PODCAST_REFRESH_INTERVAL_MS = parseInt(process.env.PODCAST_REFRESH_INTERVAL_MS ?? '3600000', 10); // 1 hour

interface Podcast {
  id: number;
  feed_url: string;
  title: string;
  image_url: string | null;
  image_path: string | null;
}

// Download and cache an image, return the cached path
async function cacheImage(imageUrl: string, prefix: string): Promise<string | null> {
  if (!imageUrl) return null;
  
  try {
    const response = await fetch(imageUrl, {
      headers: { 'User-Agent': 'mvbar/1.0 Podcast Client' },
      signal: AbortSignal.timeout(30000)
    });
    
    if (!response.ok) {
      logger.warn('podcast', `Failed to fetch image: ${response.status} ${imageUrl}`);
      return null;
    }
    
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const buffer = Buffer.from(await response.arrayBuffer());
    
    // Hash the image data for deduplication
    const hash = createHash('sha1').update(buffer).digest('hex');
    const ext = contentType.includes('png') ? '.png' : contentType.includes('webp') ? '.webp' : '.jpg';
    const relPath = `${prefix}/${hash.slice(0, 2)}/${hash}${ext}`;
    const absPath = path.join(PODCAST_ART_DIR, relPath);
    
    // Check if already cached
    try {
      await stat(absPath);
      return relPath; // Already exists
    } catch {
      // Doesn't exist, write it
    }
    
    await mkdir(path.dirname(absPath), { recursive: true });
    await writeFile(absPath, buffer);
    
    logger.debug('podcast', `Cached image: ${relPath}`);
    return relPath;
  } catch (e) {
    logger.warn('podcast', `Error caching image: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
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
    if (podcast.image_url && !podcast.image_path) {
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
        if (episodeImageUrl && !episode.image_path) {
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
  logger.info('podcast', 'Starting automatic podcast refresh...');
  
  try {
    // Get all podcasts that have at least one subscriber
    const podcasts = await db().query<Podcast>(
      `SELECT DISTINCT p.id, p.feed_url, p.title, p.image_url, p.image_path
       FROM podcasts p
       JOIN user_podcast_subscriptions ups ON ups.podcast_id = p.id`
    );
    
    if (podcasts.rows.length === 0) {
      logger.info('podcast', 'No subscribed podcasts to refresh');
      return;
    }
    
    let totalNewEpisodes = 0;
    let totalImagesCached = 0;
    
    for (const podcast of podcasts.rows) {
      const { newEpisodes, imagesCached } = await refreshPodcast(podcast);
      totalNewEpisodes += newEpisodes;
      totalImagesCached += imagesCached;
    }
    
    logger.success('podcast', `Refreshed ${podcasts.rows.length} podcasts: ${totalNewEpisodes} episodes processed, ${totalImagesCached} images cached`);
  } catch (e) {
    logger.error('podcast', `Podcast refresh failed: ${e instanceof Error ? e.message : String(e)}`);
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

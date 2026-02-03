/**
 * Podcasts API
 * 
 * RSS feed subscriptions with streaming/download support
 */

import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { db } from './db.js';
import { XMLParser } from 'fast-xml-parser';
import crypto from 'crypto';

const PODCAST_DIR = process.env.PODCAST_DIR ?? '/podcasts';

// ============================================================================
// TYPES
// ============================================================================

interface Podcast {
  id: number;
  feed_url: string;
  title: string;
  author: string | null;
  description: string | null;
  image_url: string | null;
  image_path: string | null;
  link: string | null;
  language: string | null;
  last_fetched_at: Date | null;
  created_at: Date;
}

interface Episode {
  id: number;
  podcast_id: number;
  guid: string;
  title: string;
  description: string | null;
  audio_url: string;
  audio_type: string | null;
  duration_ms: number | null;
  file_size_bytes: number | null;
  image_url: string | null;
  link: string | null;
  published_at: Date | null;
  downloaded_path: string | null;
  downloaded_at: Date | null;
}

interface EpisodeWithProgress extends Episode {
  position_ms: number;
  played: boolean;
}

// ============================================================================
// RSS PARSER
// ============================================================================

interface ParsedPodcast {
  title: string;
  author: string | null;
  description: string | null;
  imageUrl: string | null;
  link: string | null;
  language: string | null;
  lastBuildDate: Date | null;
  episodes: ParsedEpisode[];
}

interface ParsedEpisode {
  guid: string;
  title: string;
  description: string | null;
  audioUrl: string;
  audioType: string | null;
  durationMs: number | null;
  fileSizeBytes: number | null;
  imageUrl: string | null;
  link: string | null;
  publishedAt: Date | null;
}

function parseDuration(val: any): number | null {
  if (!val) return null;
  // Handle object with #text (XML parsing)
  const str = typeof val === 'object' ? val['#text'] : String(val);
  if (!str) return null;
  // Handle HH:MM:SS or MM:SS or seconds
  const parts = str.split(':').map(Number);
  if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
  if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
  if (parts.length === 1 && !isNaN(parts[0])) return parts[0] * 1000;
  return null;
}

async function fetchAndParseRSS(feedUrl: string): Promise<ParsedPodcast> {
  const response = await fetch(feedUrl, {
    headers: { 'User-Agent': 'mvbar/1.0 Podcast Client' }
  });
  
  if (!response.ok) {
    throw new Error(`Failed to fetch RSS feed: ${response.status}`);
  }
  
  const xml = await response.text();
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    isArray: (name) => name === 'item'
  });
  
  const parsed = parser.parse(xml);
  const channel = parsed.rss?.channel || parsed.feed;
  
  if (!channel) {
    throw new Error('Invalid RSS feed: no channel found');
  }
  
  // Parse channel info
  const title = channel.title?.['#text'] || channel.title || 'Unknown Podcast';
  const author = channel['itunes:author'] || channel.author?.name || channel['dc:creator'] || null;
  const description = channel.description?.['#text'] || channel.description || channel.summary || null;
  const imageUrl = channel['itunes:image']?.['@_href'] || channel.image?.url || null;
  const link = channel.link?.['@_href'] || channel.link || null;
  const language = channel.language || null;
  const lastBuildDate = channel.lastBuildDate ? new Date(channel.lastBuildDate) : null;
  
  // Parse episodes
  const items = channel.item || [];
  const episodes: ParsedEpisode[] = items.map((item: any) => {
    const enclosure = item.enclosure || {};
    const guid = item.guid?.['#text'] || item.guid || item.id || enclosure['@_url'] || crypto.randomUUID();
    
    return {
      guid: String(guid),
      title: item.title?.['#text'] || item.title || 'Untitled Episode',
      description: item.description?.['#text'] || item.description || item['itunes:summary'] || null,
      audioUrl: enclosure['@_url'] || item.link || '',
      audioType: enclosure['@_type'] || 'audio/mpeg',
      durationMs: parseDuration(item['itunes:duration']),
      fileSizeBytes: enclosure['@_length'] ? parseInt(enclosure['@_length'], 10) : null,
      imageUrl: item['itunes:image']?.['@_href'] || imageUrl,
      link: item.link?.['@_href'] || item.link || null,
      publishedAt: item.pubDate ? new Date(item.pubDate) : null
    };
  }).filter((ep: ParsedEpisode) => ep.audioUrl);
  
  return { title, author, description, imageUrl, link, language, lastBuildDate, episodes };
}

// ============================================================================
// PLUGIN
// ============================================================================

export const podcastsPlugin: FastifyPluginAsync = fp(async (app) => {
  
  // ========================================================================
  // SEARCH PODCASTS (iTunes Search API)
  // ========================================================================
  
  interface iTunesPodcast {
    collectionId: number;
    collectionName: string;
    artistName: string;
    artworkUrl600?: string;
    artworkUrl100?: string;
    feedUrl?: string;
    primaryGenreName?: string;
    trackCount?: number;
  }
  
  app.get('/api/podcasts/search', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    
    const { q, limit = 25 } = req.query as { q?: string; limit?: number };
    if (!q || q.trim().length < 2) {
      return reply.code(400).send({ ok: false, error: 'Query must be at least 2 characters' });
    }
    
    try {
      const searchUrl = new URL('https://itunes.apple.com/search');
      searchUrl.searchParams.set('term', q.trim());
      searchUrl.searchParams.set('media', 'podcast');
      searchUrl.searchParams.set('limit', String(Math.min(limit, 50)));
      
      const response = await fetch(searchUrl.toString(), {
        headers: { 'User-Agent': 'mvbar/1.0 Podcast Client' }
      });
      
      if (!response.ok) {
        throw new Error(`iTunes API error: ${response.status}`);
      }
      
      const data = await response.json() as { resultCount: number; results: iTunesPodcast[] };
      
      // Transform to our format and deduplicate by feedUrl
      const seen = new Set<string>();
      const results = data.results
        .filter(p => p.feedUrl) // Only include podcasts with RSS feeds
        .filter(p => {
          if (seen.has(p.feedUrl!)) return false;
          seen.add(p.feedUrl!);
          return true;
        })
        .map(p => ({
          id: p.collectionId,
          title: p.collectionName,
          author: p.artistName,
          imageUrl: p.artworkUrl600 || p.artworkUrl100 || null,
          feedUrl: p.feedUrl,
          genre: p.primaryGenreName || null,
          episodeCount: p.trackCount || null
        }));
      
      return { ok: true, results };
    } catch (error: any) {
      req.log.error({ error }, 'Podcast search failed');
      return reply.code(500).send({ ok: false, error: 'Search failed' });
    }
  });
  
  // ========================================================================
  // SUBSCRIBE TO PODCAST
  // ========================================================================
  
  app.post('/api/podcasts/subscribe', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    
    const { feedUrl } = req.body as { feedUrl?: string };
    if (!feedUrl) return reply.code(400).send({ ok: false, error: 'feedUrl is required' });
    
    try {
      // Check if podcast already exists
      let podcastR = await db().query<{ id: number }>('SELECT id FROM podcasts WHERE feed_url = $1', [feedUrl]);
      let podcastId: number;
      
      if (podcastR.rows.length === 0) {
        // Fetch and parse the RSS feed
        const parsed = await fetchAndParseRSS(feedUrl);
        
        // Insert podcast
        const insertR = await db().query<{ id: number }>(
          `INSERT INTO podcasts (feed_url, title, author, description, image_url, link, language, last_build_date, last_fetched_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
           RETURNING id`,
          [feedUrl, parsed.title, parsed.author, parsed.description, parsed.imageUrl, parsed.link, parsed.language, parsed.lastBuildDate]
        );
        podcastId = insertR.rows[0].id;
        
        // Insert episodes
        for (const ep of parsed.episodes) {
          await db().query(
            `INSERT INTO podcast_episodes (podcast_id, guid, title, description, audio_url, audio_type, duration_ms, file_size_bytes, image_url, link, published_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             ON CONFLICT (podcast_id, guid) DO UPDATE SET
               title = EXCLUDED.title,
               description = EXCLUDED.description,
               audio_url = EXCLUDED.audio_url,
               duration_ms = EXCLUDED.duration_ms`,
            [podcastId, ep.guid, ep.title, ep.description, ep.audioUrl, ep.audioType, ep.durationMs, ep.fileSizeBytes, ep.imageUrl, ep.link, ep.publishedAt]
          );
        }
      } else {
        podcastId = podcastR.rows[0].id;
      }
      
      // Subscribe user
      await db().query(
        `INSERT INTO user_podcast_subscriptions (user_id, podcast_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [req.user.userId, podcastId]
      );
      
      // Return podcast info
      const podcast = await db().query<Podcast>(
        'SELECT id, feed_url, title, author, description, image_url, image_path, link, language, last_fetched_at, created_at FROM podcasts WHERE id = $1',
        [podcastId]
      );
      
      return { ok: true, podcast: podcast.rows[0] };
    } catch (error: any) {
      req.log.error({ error: error.message, feedUrl }, 'Failed to subscribe to podcast');
      return reply.code(400).send({ ok: false, error: error.message || 'Failed to subscribe' });
    }
  });
  
  // ========================================================================
  // UNSUBSCRIBE FROM PODCAST
  // ========================================================================
  
  app.delete('/api/podcasts/:podcastId/unsubscribe', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    
    const podcastId = Number((req.params as { podcastId: string }).podcastId);
    if (!Number.isFinite(podcastId)) return reply.code(400).send({ ok: false });
    
    await db().query(
      'DELETE FROM user_podcast_subscriptions WHERE user_id = $1 AND podcast_id = $2',
      [req.user.userId, podcastId]
    );
    
    return { ok: true };
  });
  
  // ========================================================================
  // LIST USER'S SUBSCRIBED PODCASTS
  // ========================================================================
  
  app.get('/api/podcasts', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    
    const r = await db().query<Podcast & { unplayed_count: number }>(
      `SELECT p.*, 
              (SELECT COUNT(*) FROM podcast_episodes e 
               LEFT JOIN user_episode_progress uep ON uep.episode_id = e.id AND uep.user_id = $1
               WHERE e.podcast_id = p.id AND (uep.played IS NULL OR uep.played = false))::int as unplayed_count
       FROM podcasts p
       JOIN user_podcast_subscriptions ups ON ups.podcast_id = p.id
       WHERE ups.user_id = $1
       ORDER BY p.title`,
      [req.user.userId]
    );
    
    return { ok: true, podcasts: r.rows };
  });
  
  // ========================================================================
  // GET PODCAST DETAILS WITH EPISODES
  // ========================================================================
  
  app.get('/api/podcasts/:podcastId', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    
    const podcastId = Number((req.params as { podcastId: string }).podcastId);
    if (!Number.isFinite(podcastId)) return reply.code(400).send({ ok: false });
    
    // Check subscription
    const subR = await db().query(
      'SELECT 1 FROM user_podcast_subscriptions WHERE user_id = $1 AND podcast_id = $2',
      [req.user.userId, podcastId]
    );
    if (subR.rows.length === 0) return reply.code(404).send({ ok: false, error: 'Not subscribed' });
    
    // Get podcast
    const podcastR = await db().query<Podcast>(
      'SELECT id, feed_url, title, author, description, image_url, image_path, link, language, last_fetched_at, created_at FROM podcasts WHERE id = $1',
      [podcastId]
    );
    if (podcastR.rows.length === 0) return reply.code(404).send({ ok: false });
    
    // Get episodes with progress
    const episodesR = await db().query<EpisodeWithProgress>(
      `SELECT e.*, 
              COALESCE(uep.position_ms, 0) as position_ms,
              COALESCE(uep.played, false) as played,
              (e.downloaded_path IS NOT NULL) as downloaded
       FROM podcast_episodes e
       LEFT JOIN user_episode_progress uep ON uep.episode_id = e.id AND uep.user_id = $1
       WHERE e.podcast_id = $2
       ORDER BY e.published_at DESC NULLS LAST`,
      [req.user.userId, podcastId]
    );
    
    return { ok: true, podcast: podcastR.rows[0], episodes: episodesR.rows };
  });
  
  // ========================================================================
  // GET NEW EPISODES (ACROSS ALL SUBSCRIPTIONS)
  // ========================================================================
  
  app.get('/api/podcasts/episodes/new', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    
    const limit = Math.min(100, Math.max(1, Number((req.query as any).limit) || 50));
    
    // "Continue Listening" - only episodes listened for at least 30 seconds but not finished
    const r = await db().query<EpisodeWithProgress & { podcast_title: string; podcast_image_url: string | null }>(
      `SELECT e.*, p.title as podcast_title, p.image_url as podcast_image_url,
              COALESCE(uep.position_ms, 0) as position_ms,
              COALESCE(uep.played, false) as played,
              (e.downloaded_path IS NOT NULL) as downloaded
       FROM podcast_episodes e
       JOIN podcasts p ON p.id = e.podcast_id
       JOIN user_podcast_subscriptions ups ON ups.podcast_id = p.id AND ups.user_id = $1
       JOIN user_episode_progress uep ON uep.episode_id = e.id AND uep.user_id = $1
       WHERE uep.position_ms > 30000 AND (uep.played IS NULL OR uep.played = false)
       ORDER BY uep.updated_at DESC
       LIMIT $2`,
      [req.user.userId, limit]
    );
    
    return { ok: true, episodes: r.rows };
  });
  
  // ========================================================================
  // UPDATE EPISODE PROGRESS
  // ========================================================================
  
  app.post('/api/podcasts/episodes/:episodeId/progress', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    
    const episodeId = Number((req.params as { episodeId: string }).episodeId);
    if (!Number.isFinite(episodeId)) return reply.code(400).send({ ok: false });
    
    const { positionMs, played } = req.body as { positionMs?: number; played?: boolean };
    
    // Verify episode exists and user is subscribed
    const checkR = await db().query(
      `SELECT 1 FROM podcast_episodes e
       JOIN user_podcast_subscriptions ups ON ups.podcast_id = e.podcast_id AND ups.user_id = $1
       WHERE e.id = $2`,
      [req.user.userId, episodeId]
    );
    if (checkR.rows.length === 0) return reply.code(404).send({ ok: false });
    
    await db().query(
      `INSERT INTO user_episode_progress (user_id, episode_id, position_ms, played, updated_at)
       VALUES ($1, $2, COALESCE($3, 0), COALESCE($4, false), now())
       ON CONFLICT (user_id, episode_id) DO UPDATE SET
         position_ms = COALESCE($3, user_episode_progress.position_ms),
         played = COALESCE($4, user_episode_progress.played),
         updated_at = now()`,
      [req.user.userId, episodeId, positionMs ?? null, played ?? null]
    );
    
    return { ok: true };
  });
  
  // ========================================================================
  // MARK EPISODE AS PLAYED/UNPLAYED
  // ========================================================================
  
  app.post('/api/podcasts/episodes/:episodeId/played', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    
    const episodeId = Number((req.params as { episodeId: string }).episodeId);
    const { played } = req.body as { played: boolean };
    
    await db().query(
      `INSERT INTO user_episode_progress (user_id, episode_id, played, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (user_id, episode_id) DO UPDATE SET played = $3, updated_at = now()`,
      [req.user.userId, episodeId, played]
    );
    
    return { ok: true };
  });
  
  // ========================================================================
  // STREAM EPISODE (PROXY OR REDIRECT)
  // ========================================================================
  
  app.get('/api/podcasts/episodes/:episodeId/stream', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    
    const episodeId = Number((req.params as { episodeId: string }).episodeId);
    
    const r = await db().query<Episode>(
      `SELECT e.* FROM podcast_episodes e
       JOIN user_podcast_subscriptions ups ON ups.podcast_id = e.podcast_id AND ups.user_id = $1
       WHERE e.id = $2`,
      [req.user.userId, episodeId]
    );
    
    if (r.rows.length === 0) return reply.code(404).send({ ok: false });
    
    const episode = r.rows[0];
    
    // If downloaded, serve from local file
    if (episode.downloaded_path) {
      const fs = await import('fs');
      const path = await import('path');
      
      try {
        const stat = fs.statSync(episode.downloaded_path);
        const ext = path.extname(episode.downloaded_path).toLowerCase();
        const mimeTypes: Record<string, string> = {
          '.mp3': 'audio/mpeg',
          '.m4a': 'audio/mp4',
          '.ogg': 'audio/ogg',
          '.opus': 'audio/opus',
          '.wav': 'audio/wav',
          '.aac': 'audio/aac'
        };
        const contentType = mimeTypes[ext] || 'audio/mpeg';
        
        reply.header('Content-Type', contentType);
        reply.header('Content-Length', stat.size);
        reply.header('Accept-Ranges', 'bytes');
        
        const stream = fs.createReadStream(episode.downloaded_path);
        return reply.send(stream);
      } catch (e) {
        // File doesn't exist, fall through to redirect
        await db().query(
          `UPDATE podcast_episodes SET downloaded_path = NULL, downloaded_at = NULL WHERE id = $1`,
          [episodeId]
        );
      }
    }
    
    // Otherwise redirect to audio URL
    return reply.redirect(302, episode.audio_url);
  });
  
  // ========================================================================
  // REFRESH PODCAST FEED
  // ========================================================================
  
  app.post('/api/podcasts/:podcastId/refresh', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    
    const podcastId = Number((req.params as { podcastId: string }).podcastId);
    
    // Check subscription
    const subR = await db().query(
      'SELECT 1 FROM user_podcast_subscriptions WHERE user_id = $1 AND podcast_id = $2',
      [req.user.userId, podcastId]
    );
    if (subR.rows.length === 0) return reply.code(404).send({ ok: false });
    
    // Get podcast
    const podcastR = await db().query<Podcast>(
      'SELECT id, feed_url, title, author, description, image_url, image_path, link, language, last_fetched_at, created_at FROM podcasts WHERE id = $1',
      [podcastId]
    );
    if (podcastR.rows.length === 0) return reply.code(404).send({ ok: false });
    
    const podcast = podcastR.rows[0];
    
    try {
      const parsed = await fetchAndParseRSS(podcast.feed_url);
      
      // Update podcast info
      await db().query(
        `UPDATE podcasts SET title = $1, author = $2, description = $3, image_url = $4, 
         last_build_date = $5, last_fetched_at = now(), updated_at = now()
         WHERE id = $6`,
        [parsed.title, parsed.author, parsed.description, parsed.imageUrl, parsed.lastBuildDate, podcastId]
      );
      
      // Upsert episodes
      let newCount = 0;
      for (const ep of parsed.episodes) {
        const insertR = await db().query(
          `INSERT INTO podcast_episodes (podcast_id, guid, title, description, audio_url, audio_type, duration_ms, file_size_bytes, image_url, link, published_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (podcast_id, guid) DO UPDATE SET
             title = EXCLUDED.title,
             description = EXCLUDED.description,
             audio_url = EXCLUDED.audio_url,
             duration_ms = EXCLUDED.duration_ms
           RETURNING (xmax = 0) as is_new`,
          [podcastId, ep.guid, ep.title, ep.description, ep.audioUrl, ep.audioType, ep.durationMs, ep.fileSizeBytes, ep.imageUrl, ep.link, ep.publishedAt]
        );
        if (insertR.rows[0]?.is_new) newCount++;
      }
      
      return { ok: true, newEpisodes: newCount };
    } catch (error: any) {
      return reply.code(500).send({ ok: false, error: error.message });
    }
  });
  
  // ========================================================================
  // DOWNLOAD EPISODE
  // ========================================================================
  
  app.post('/api/podcasts/episodes/:episodeId/download', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    
    const episodeId = Number((req.params as { episodeId: string }).episodeId);
    
    // Check subscription and get episode
    const r = await db().query<Episode>(
      `SELECT e.* FROM podcast_episodes e
       JOIN user_podcast_subscriptions ups ON ups.podcast_id = e.podcast_id AND ups.user_id = $1
       WHERE e.id = $2`,
      [req.user.userId, episodeId]
    );
    
    if (r.rows.length === 0) return reply.code(404).send({ ok: false });
    
    const episode = r.rows[0];
    
    // Already downloaded?
    if (episode.downloaded_path) {
      return { ok: true, downloaded: true, path: episode.downloaded_path };
    }
    
    try {
      const fs = await import('fs/promises');
      const path = await import('path');
      
      // Create podcast directory if needed
      const podcastDir = path.join(PODCAST_DIR, String(episode.podcast_id));
      await fs.mkdir(podcastDir, { recursive: true });
      
      // Determine file extension from URL or content type
      const url = new URL(episode.audio_url);
      let ext = path.extname(url.pathname) || '.mp3';
      if (!ext.match(/^\.(mp3|m4a|ogg|opus|wav|aac)$/i)) ext = '.mp3';
      
      const filename = `${episode.id}${ext}`;
      const filePath = path.join(podcastDir, filename);
      
      // Download the file
      req.log.info({ episodeId, url: episode.audio_url }, 'Downloading podcast episode');
      
      const response = await fetch(episode.audio_url, {
        headers: { 'User-Agent': 'mvbar/1.0 Podcast Client' }
      });
      
      if (!response.ok) {
        throw new Error(`Failed to download: ${response.status}`);
      }
      
      const arrayBuffer = await response.arrayBuffer();
      await fs.writeFile(filePath, Buffer.from(arrayBuffer));
      
      // Update database with download path
      await db().query(
        `UPDATE podcast_episodes SET downloaded_path = $1, downloaded_at = now() WHERE id = $2`,
        [filePath, episodeId]
      );
      
      req.log.info({ episodeId, filePath, size: arrayBuffer.byteLength }, 'Episode downloaded');
      
      return { ok: true, downloaded: true, path: filePath, size: arrayBuffer.byteLength };
    } catch (error: any) {
      req.log.error({ error, episodeId }, 'Failed to download episode');
      return reply.code(500).send({ ok: false, error: error.message || 'Download failed' });
    }
  });
  
  // ========================================================================
  // DELETE DOWNLOADED EPISODE
  // ========================================================================
  
  app.delete('/api/podcasts/episodes/:episodeId/download', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    
    const episodeId = Number((req.params as { episodeId: string }).episodeId);
    
    const r = await db().query<Episode>(
      `SELECT e.* FROM podcast_episodes e
       JOIN user_podcast_subscriptions ups ON ups.podcast_id = e.podcast_id AND ups.user_id = $1
       WHERE e.id = $2`,
      [req.user.userId, episodeId]
    );
    
    if (r.rows.length === 0) return reply.code(404).send({ ok: false });
    
    const episode = r.rows[0];
    
    if (episode.downloaded_path) {
      try {
        const fs = await import('fs/promises');
        await fs.unlink(episode.downloaded_path);
      } catch (e) {
        // File might not exist, ignore
      }
      
      await db().query(
        `UPDATE podcast_episodes SET downloaded_path = NULL, downloaded_at = NULL WHERE id = $1`,
        [episodeId]
      );
    }
    
    return { ok: true };
  });
});

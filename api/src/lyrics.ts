import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { db } from './db.js';
import { allowedLibrariesForUser, isLibraryAllowed } from './access.js';
import logger from './logger.js';

const LYRICS_DIR = process.env.LYRICS_DIR ?? '/data/cache/lyrics';
const LRCLIB_API = 'https://lrclib.net/api/get';

function safeJoinLyrics(relPath: string) {
  const abs = path.resolve(LYRICS_DIR, relPath);
  const base = path.resolve(LYRICS_DIR);
  if (!abs.startsWith(base + path.sep)) throw new Error('invalid path');
  return abs;
}

// Fetch lyrics from LRCLIB (community-sourced synced lyrics)
async function fetchFromLrclib(
  artist: string,
  title: string,
  album?: string,
  durationSec?: number
): Promise<{ syncedLyrics?: string; plainLyrics?: string } | null> {
  try {
    const params = new URLSearchParams({
      artist_name: artist,
      track_name: title,
    });
    if (album) params.set('album_name', album);
    if (durationSec && durationSec > 0) params.set('duration', String(Math.round(durationSec)));

    const res = await fetch(`${LRCLIB_API}?${params}`, {
      headers: { 'User-Agent': 'mvbar/1.0 (https://github.com/mvbar)' },
    });

    if (!res.ok) return null;

    const data = await res.json() as {
      syncedLyrics?: string;
      plainLyrics?: string;
    };

    return data;
  } catch (e) {
    logger.error('lyrics', 'LRCLIB fetch error');
    return null;
  }
}

// Cache lyrics to disk
async function cacheLyrics(trackId: number, lyrics: string, synced: boolean): Promise<string | null> {
  try {
    const cacheDir = path.join(LYRICS_DIR, 'cache');
    await mkdir(cacheDir, { recursive: true });
    const filename = `${trackId}.${synced ? 'lrc' : 'txt'}`;
    const filePath = path.join(cacheDir, filename);
    await writeFile(filePath, lyrics, 'utf8');
    // Update database with cached path
    const relPath = path.join('cache', filename);
    await db().query('UPDATE tracks SET lyrics_path = $1 WHERE id = $2', [relPath, trackId]);
    return relPath;
  } catch (e) {
    logger.error('lyrics', 'Cache write error');
    return null;
  }
}

// Background fetch and cache lyrics (called when track starts playing)
async function prefetchLyrics(trackId: number): Promise<void> {
  try {
    const r = await db().query<{
      lyrics_path: string | null;
      title: string;
      artist: string;
      album: string | null;
      duration_ms: number | null;
    }>('SELECT lyrics_path, title, artist, album, duration_ms from tracks WHERE id=$1', [trackId]);
    const row = r.rows[0];
    if (!row) return;

    // Already have cached lyrics
    if (row.lyrics_path) {
      try {
        const abs = safeJoinLyrics(row.lyrics_path);
        await readFile(abs, 'utf8');
        return; // Lyrics exist, no need to fetch
      } catch {
        // File not found, continue to fetch
      }
    }

    // Fetch from LRCLIB in background
    const durationSec = row.duration_ms ? row.duration_ms / 1000 : undefined;
    const lrcData = await fetchFromLrclib(row.artist, row.title, row.album ?? undefined, durationSec);

    if (lrcData?.syncedLyrics) {
      // Only cache synced lyrics
      await cacheLyrics(trackId, lrcData.syncedLyrics, true);
      logger.info('lyrics', `Prefetched synced lyrics for track ${trackId}`);
    }
  } catch (e) {
    logger.error('lyrics', `Prefetch error for track ${trackId}`);
  }
}

export const lyricsPlugin: FastifyPluginAsync = fp(async (app) => {
  // Prefetch endpoint - called when track starts playing
  app.post('/api/library/tracks/:id/lyrics/prefetch', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });

    const id = Number((req.params as { id: string }).id);
    if (!Number.isFinite(id)) return reply.code(400).send({ ok: false });

    // Fire and forget - don't wait for prefetch to complete
    prefetchLyrics(id).catch(() => {});

    return { ok: true };
  });

  app.get('/api/library/tracks/:id/lyrics', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });

    const id = Number((req.params as { id: string }).id);
    if (!Number.isFinite(id)) return reply.code(400).send({ ok: false });

    const r = await db().query<{
      library_id: number;
      lyrics_path: string | null;
      title: string;
      artist: string;
      album: string | null;
      duration_ms: number | null;
    }>('SELECT library_id, lyrics_path, title, artist, album, duration_ms from active_tracks WHERE id=$1', [id]);
    const row = r.rows[0];
    if (!row) return reply.code(404).send({ ok: false });

    const allowed = await allowedLibrariesForUser(req.user.userId, req.user.role);
    if (!isLibraryAllowed(Number(row.library_id), allowed)) return reply.code(204).send();

    // Try local lyrics first
    if (row.lyrics_path) {
      try {
        const abs = safeJoinLyrics(row.lyrics_path);
        const text = await readFile(abs, 'utf8');
        // Only return if it's synced lyrics (contains timestamps)
        if (text.includes('[') && /\[\d{2}:\d{2}/.test(text)) {
          reply.header('content-type', 'text/plain; charset=utf-8');
          return reply.send(text);
        }
      } catch {
        // File not found, continue to fetch from LRCLIB
      }
    }

    // Fetch from LRCLIB - only synced lyrics
    const durationSec = row.duration_ms ? row.duration_ms / 1000 : undefined;
    const lrcData = await fetchFromLrclib(row.artist, row.title, row.album ?? undefined, durationSec);

    if (lrcData?.syncedLyrics) {
      // Cache for future use
      await cacheLyrics(id, lrcData.syncedLyrics, true);
      reply.header('content-type', 'text/plain; charset=utf-8');
      return reply.send(lrcData.syncedLyrics);
    }

    return reply.code(204).send();
  });
});

import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
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

function safeJoinMount(mountPath: string, relPath: string) {
  const abs = path.resolve(mountPath, relPath);
  const base = path.resolve(mountPath);
  if (!abs.startsWith(base + path.sep)) throw new Error('invalid path');
  return abs;
}

function isSyncedLyrics(text: string): boolean {
  return /\[\d{2}:\d{2}/.test(text);
}

function isGeneratedLyricsCache(relPath: string): boolean {
  return relPath === 'cache' || relPath.startsWith('cache/') || relPath.startsWith('cache\\');
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
  } catch {
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
  } catch {
    logger.error('lyrics', 'Cache write error');
    return null;
  }
}

// Try reading a file, return content or null
async function tryReadFile(absPath: string): Promise<string | null> {
  try {
    const st = await stat(absPath);
    if (!st.isFile()) return null;
    return await readFile(absPath, 'utf8');
  } catch {
    return null;
  }
}

// Read a sidecar lyrics file alongside audio (in the music dir)
async function readMusicSidecar(mountPath: string, trackPath: string, ext: string): Promise<string | null> {
  try {
    const baseNoExt = trackPath.replace(/\.[^./\\]+$/, '');
    const abs = safeJoinMount(mountPath, baseNoExt + ext);
    return await tryReadFile(abs);
  } catch {
    return null;
  }
}

// Background fetch and cache lyrics (called when track starts playing)
async function prefetchLyrics(trackId: number): Promise<void> {
  try {
    const r = await db().query<{
      lyrics_path: string | null;
      embedded_lyrics: string | null;
      embedded_lyrics_synced: boolean;
      title: string;
      artist: string;
      album: string | null;
      duration_ms: number | null;
      path: string;
      mount_path: string;
    }>(`SELECT t.lyrics_path, t.embedded_lyrics, t.embedded_lyrics_synced,
              t.title, t.artist, t.album, t.duration_ms, t.path, l.mount_path
        FROM tracks t JOIN libraries l ON l.id = t.library_id
        WHERE t.id=$1`, [trackId]);
    const row = r.rows[0];
    if (!row) return;

    let hasLocalUnsynced = false;

    // Already have synced cached lyrics. Plain generated cache is not enough:
    // keep looking so LRCLIB can upgrade it to synced lyrics later.
    if (row.lyrics_path && !row.lyrics_path.startsWith('music:')) {
      try {
        const abs = safeJoinLyrics(row.lyrics_path);
        const text = await readFile(abs, 'utf8');
        if (text.trim()) {
          if (isSyncedLyrics(text)) return;
          if (!isGeneratedLyricsCache(row.lyrics_path)) hasLocalUnsynced = true;
        }
      } catch {
        // File not found, continue to fetch
      }
    }

    if (row.lyrics_path?.startsWith('music:')) {
      try {
        const text = await tryReadFile(safeJoinMount(row.mount_path, row.lyrics_path.slice(6)));
        if (text?.trim()) {
          if (isSyncedLyrics(text)) return;
          hasLocalUnsynced = true;
        }
      } catch {
        // invalid stored sidecar path; continue with other sources
      }
    }

    const lrcSidecar = await readMusicSidecar(row.mount_path, row.path, '.lrc');
    if (lrcSidecar?.trim()) {
      if (isSyncedLyrics(lrcSidecar)) return;
      hasLocalUnsynced = true;
    }

    if (row.embedded_lyrics?.trim()) {
      if (row.embedded_lyrics_synced) return;
      hasLocalUnsynced = true;
    }

    const txtSidecar = await readMusicSidecar(row.mount_path, row.path, '.txt');
    if (txtSidecar?.trim()) hasLocalUnsynced = true;

    // Fetch from LRCLIB in background
    const durationSec = row.duration_ms ? row.duration_ms / 1000 : undefined;
    const lrcData = await fetchFromLrclib(row.artist, row.title, row.album ?? undefined, durationSec);

    if (lrcData?.syncedLyrics) {
      await cacheLyrics(trackId, lrcData.syncedLyrics, true);
      logger.info('lyrics', `Prefetched synced lyrics for track ${trackId}`);
    } else if (lrcData?.plainLyrics && !hasLocalUnsynced) {
      // Cache online plain lyrics only when there is no local file/tag text.
      await cacheLyrics(trackId, lrcData.plainLyrics, false);
      logger.info('lyrics', `Prefetched plain lyrics for track ${trackId}`);
    }
  } catch {
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

  // Lyrics fallback chain:
  // 1. Local synced lyrics: cache/sidecar .lrc, music .lrc, embedded synced tags
  // 2. LRCLIB synced lyrics, cached for future use when found
  // 3. Local unsynced lyrics: lyrics file, music sidecar, embedded tags
  // 4. Existing generated plain cache
  // 5. LRCLIB plain lyrics only when there is no local text
  app.get('/api/library/tracks/:id/lyrics', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });

    const id = Number((req.params as { id: string }).id);
    if (!Number.isFinite(id)) return reply.code(400).send({ ok: false });

    const r = await db().query<{
      library_id: number;
      lyrics_path: string | null;
      embedded_lyrics: string | null;
      embedded_lyrics_synced: boolean;
      title: string;
      artist: string;
      album: string | null;
      duration_ms: number | null;
      path: string;
      mount_path: string;
    }>(`SELECT t.library_id, t.lyrics_path, t.embedded_lyrics, t.embedded_lyrics_synced,
              t.title, t.artist, t.album, t.duration_ms, t.path, l.mount_path
        FROM active_tracks t JOIN libraries l ON l.id = t.library_id
        WHERE t.id=$1`, [id]);
    const row = r.rows[0];
    if (!row) return reply.code(404).send({ ok: false });

    const allowed = await allowedLibrariesForUser(req.user.userId, req.user.role);
    if (!isLibraryAllowed(Number(row.library_id), allowed)) return reply.code(204).send();

    const sendLyrics = (text: string, type: 'synced' | 'unsynced') => {
      reply.header('content-type', 'application/json; charset=utf-8');
      return reply.send({ lyrics: text, type });
    };

    let lyricsDirPlain: string | null = null;
    let generatedPlainCache: string | null = null;
    let musicSidecarPlain: string | null = null;

    // 1a. Lyrics file in LYRICS_DIR. Synced returns immediately; plain waits
    // until after the online synced upgrade attempt.
    if (row.lyrics_path && !row.lyrics_path.startsWith('music:')) {
      try {
        const abs = safeJoinLyrics(row.lyrics_path);
        const text = await readFile(abs, 'utf8');
        if (text.trim()) {
          const synced = isSyncedLyrics(text);
          if (synced) return sendLyrics(text, 'synced');
          if (isGeneratedLyricsCache(row.lyrics_path)) {
            generatedPlainCache = text;
          } else {
            lyricsDirPlain = text;
          }
        }
      } catch {
        // File not found, continue
      }
    }

    // 1b. Sidecar file alongside audio. A .txt path can be stored here too.
    if (row.lyrics_path?.startsWith('music:')) {
      const musicRelPath = row.lyrics_path.slice(6); // strip "music:" prefix
      try {
        const abs = safeJoinMount(row.mount_path, musicRelPath);
        const text = await tryReadFile(abs);
        if (text?.trim() && isSyncedLyrics(text)) {
          return sendLyrics(text, 'synced');
        }
        if (text?.trim()) musicSidecarPlain = text;
      } catch { /* continue */ }
    }

    // Try .lrc sidecar even if not stored in lyrics_path.
    const lrcText = await readMusicSidecar(row.mount_path, row.path, '.lrc');
    if (lrcText?.trim() && isSyncedLyrics(lrcText)) {
      return sendLyrics(lrcText, 'synced');
    }
    if (lrcText?.trim() && !musicSidecarPlain) {
      musicSidecarPlain = lrcText;
    }

    // 1c. Embedded synced lyrics from DB
    if (row.embedded_lyrics && row.embedded_lyrics_synced) {
      return sendLyrics(row.embedded_lyrics, 'synced');
    }

    // 2. LRCLIB online fetch. Synced is an upgrade over local plain lyrics;
    // plain is held until every local source has had a chance.
    const durationSec = row.duration_ms ? row.duration_ms / 1000 : undefined;
    const lrcData = await fetchFromLrclib(row.artist, row.title, row.album ?? undefined, durationSec);

    if (lrcData?.syncedLyrics) {
      // Cache for future use
      await cacheLyrics(id, lrcData.syncedLyrics, true);
      return sendLyrics(lrcData.syncedLyrics, 'synced');
    }

    const onlinePlain = lrcData?.plainLyrics?.trim() ? lrcData.plainLyrics : null;

    // 3. Local unsynced lyrics from file/tag sources.
    if (lyricsDirPlain) return sendLyrics(lyricsDirPlain, 'unsynced');
    if (musicSidecarPlain) return sendLyrics(musicSidecarPlain, 'unsynced');
    if (row.embedded_lyrics) return sendLyrics(row.embedded_lyrics, 'unsynced');

    const txtText = await readMusicSidecar(row.mount_path, row.path, '.txt');
    if (txtText?.trim()) return sendLyrics(txtText, 'unsynced');

    // 4. Previously generated online plain cache.
    if (generatedPlainCache) return sendLyrics(generatedPlainCache, 'unsynced');

    // 5. Online plain lyrics only when there is no local text.
    if (onlinePlain) {
      await cacheLyrics(id, onlinePlain, false);
      return sendLyrics(onlinePlain, 'unsynced');
    }

    return reply.code(204).send();
  });
});

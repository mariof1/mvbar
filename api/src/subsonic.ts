/**
 * Subsonic/OpenSubsonic API Implementation
 * 
 * Supports both legacy Subsonic clients (DSub) and modern OpenSubsonic clients (Symfonium)
 * API Version: 1.16.1 (OpenSubsonic compatible)
 */

import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { db, redis } from './db.js';
import * as crypto from 'crypto';
import logger from './logger.js';
import { allowedLibrariesForUser, isLibraryAllowed } from './access.js';
import type { Role } from './store.js';
import { verifyPassword } from './security.js';
import { createReadStream, existsSync } from 'node:fs';
import { stat, readFile } from 'node:fs/promises';
import path from 'node:path';

const ART_DIR = process.env.ART_DIR ?? '/data/cache/art';
const AVATARS_DIR = process.env.AVATARS_DIR ?? '/data/cache/avatars';
const LYRICS_DIR = process.env.LYRICS_DIR ?? '/data/cache/lyrics';

const SUBSONIC_API_VERSION = '1.16.1';
const SERVER_NAME = 'mvbar';

// OpenSubsonic extensions we support
const OPENSUBSONIC_EXTENSIONS = [
  { name: 'transcodeOffset', versions: [1] },
  { name: 'formPost', versions: [1] },
  { name: 'songLyrics', versions: [1] },
];

// ========== Response Helpers ==========

interface SubsonicResponse {
  'subsonic-response': {
    status: 'ok' | 'failed';
    version: string;
    type: string;
    serverVersion: string;
    openSubsonic?: boolean;
    error?: { code: number; message: string };
    [key: string]: any;
  };
}

function createResponse(data: Record<string, any> = {}): SubsonicResponse {
  return {
    'subsonic-response': {
      status: 'ok',
      version: SUBSONIC_API_VERSION,
      type: SERVER_NAME,
      serverVersion: '1.0.0',
      openSubsonic: true,
      ...data,
    },
  };
}

function createError(code: number, message: string): SubsonicResponse {
  return {
    'subsonic-response': {
      status: 'failed',
      version: SUBSONIC_API_VERSION,
      type: SERVER_NAME,
      serverVersion: '1.0.0',
      error: { code, message },
    },
  };
}

// Error codes per Subsonic spec
const ERROR = {
  GENERIC: { code: 0, message: 'A generic error.' },
  MISSING_PARAM: { code: 10, message: 'Required parameter is missing.' },
  AUTH_FAILED: { code: 40, message: 'Wrong username or password.' },
  NOT_AUTHORIZED: { code: 50, message: 'User is not authorized for the given operation.' },
  NOT_FOUND: { code: 70, message: 'The requested data was not found.' },
};

// ========== Authentication ==========

type SubsonicParams = {
  u?: string;
  p?: string;
  t?: string;
  s?: string;
  v?: string;
  c?: string;
  f?: string;
};

function getParams(req: FastifyRequest): SubsonicParams & Record<string, string | undefined> {
  const query = req.query as Record<string, string | undefined>;
  const body = (req.body as Record<string, string | undefined>) || {};
  return { ...body, ...query };
}

async function authenticate(req: FastifyRequest): Promise<{ userId: string; username: string; role: Role } | null> {
  const params = getParams(req);
  const { u: username, p: password, t: token, s: salt } = params;
  
  if (!username) return null;
  
  const r = await db().query<{ id: string; email: string; password_hash: string; subsonic_password: string | null; role: Role }>(
    'SELECT id, email, password_hash, subsonic_password, role FROM users WHERE email = $1',
    [username]
  );
  const user = r.rows[0];
  if (!user) return null;
  
  // Token-based authentication (requires subsonic_password to be set)
  if (token && salt && user.subsonic_password) {
    const expectedToken = crypto.createHash('md5').update(user.subsonic_password + salt).digest('hex');
    if (token.toLowerCase() === expectedToken.toLowerCase()) {
      return { userId: user.id, username: user.email, role: user.role };
    }
  }
  
  // Legacy password authentication
  if (password) {
    let plainPassword = password;
    if (password.startsWith('enc:')) {
      plainPassword = Buffer.from(password.slice(4), 'hex').toString('utf-8');
    }
    if (verifyPassword(plainPassword, user.password_hash)) {
      // Auto-populate subsonic_password for future token auth
      if (!user.subsonic_password) {
        await db().query('UPDATE users SET subsonic_password = $1 WHERE id = $2', [plainPassword, user.id]);
      }
      return { userId: user.id, username: user.email, role: user.role };
    }
  }
  
  return null;
}

// ========== Format Helpers ==========

function sendResponse(reply: FastifyReply, data: SubsonicResponse, format: string = 'xml') {
  if (format === 'json' || format === 'jsonp') {
    reply.type('application/json').send(data);
  } else {
    reply.type('application/xml').send(toXml(data));
  }
}

function toXml(obj: any, rootName?: string): string {
  if (rootName === undefined) {
    const key = Object.keys(obj)[0];
    return `<?xml version="1.0" encoding="UTF-8"?>\n${toXml(obj[key], key)}`;
  }
  
  if (obj === null || obj === undefined) return `<${rootName}/>`;
  if (typeof obj !== 'object') return `<${rootName}>${escapeXml(String(obj))}</${rootName}>`;
  if (Array.isArray(obj)) return obj.map(item => toXml(item, rootName)).join('');
  
  const attrs: string[] = [];
  const children: string[] = [];
  
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'object' && !Array.isArray(value)) {
      children.push(toXml(value, key));
    } else if (Array.isArray(value)) {
      children.push(value.map(item => toXml(item, key)).join(''));
    } else {
      attrs.push(`${key}="${escapeXml(String(value))}"`);
    }
  }
  
  const attrStr = attrs.length > 0 ? ' ' + attrs.join(' ') : '';
  if (children.length === 0) return `<${rootName}${attrStr}/>`;
  return `<${rootName}${attrStr}>${children.join('')}</${rootName}>`;
}

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// ========== Data Formatters ==========

function formatSong(track: any): Record<string, any> {
  return {
    id: String(track.id),
    parent: '1',
    isDir: false,
    title: track.title || 'Unknown',
    album: track.album || '',
    artist: track.artist || 'Unknown Artist',
    track: track.track_number || 0,
    year: track.year || 0,
    genre: track.genre || '',
    coverArt: String(track.id),
    size: track.size_bytes || 0,
    contentType: 'audio/mpeg',
    suffix: track.ext || 'mp3',
    duration: Math.round((track.duration_ms || 0) / 1000),
    bitRate: 320,
    path: track.path || '',
    discNumber: track.disc_number || 1,
    created: track.updated_at || new Date().toISOString(),
    albumId: track.album ? `al-${encodeURIComponent(track.album)}` : undefined,
    type: 'music',
    isVideo: false,
    playCount: track.play_count || 0,
    starred: track.starred_at || undefined,
  };
}

function formatAlbum(album: any): Record<string, any> {
  return {
    id: `al-${encodeURIComponent(album.name || album.album || 'Unknown')}`,
    name: album.name || album.album || 'Unknown Album',
    artist: album.artist || 'Unknown Artist',
    coverArt: album.art_track_id ? String(album.art_track_id) : undefined,
    songCount: album.track_count || 0,
    duration: Math.round((album.total_duration_ms || 0) / 1000),
    created: album.created_at || new Date().toISOString(),
    year: album.year || 0,
    genre: album.genre || '',
    playCount: album.play_count || 0,
  };
}

function formatArtist(artist: any): Record<string, any> {
  return {
    id: `ar-${artist.id}`,
    name: artist.name || 'Unknown Artist',
    coverArt: artist.art_track_id ? String(artist.art_track_id) : undefined,
    albumCount: artist.album_count || 0,
  };
}

// ========== Plugin ==========

export const subsonicPlugin: FastifyPluginAsync = async (app) => {
  // Allow browser-based Subsonic clients (e.g. Airsonic Refix) to call /rest/* cross-origin.
  // (Must run before body parsing so CORS headers are present even on 4xx/415 errors.)
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/rest/')) return;

    reply
      .header('Access-Control-Allow-Origin', '*')
      .header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
      .header('Access-Control-Allow-Headers', '*');

    if (req.method === 'OPTIONS') return reply.code(204).send();
  });

  // Support clients that POST form-encoded params (u/p/t/s/etc)
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => {
    try {
      const s = body as string;
      const out: Record<string, string> = {};
      for (const [k, v] of new URLSearchParams(s)) out[k] = v;
      done(null, out);
    } catch (e) {
      done(e as any, undefined);
    }
  });

  // Middleware for auth and logging
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/rest/')) return;
    
    const params = getParams(req);
    const endpoint = req.url.split('?')[0].replace('/rest/', '').replace('.view', '');
    logger.info('subsonic', `${req.method} ${endpoint} user=${params.u || 'anon'} format=${params.f || 'xml'}`);
    
    const user = await authenticate(req);
    if (!user) {
      logger.warn('subsonic', `Auth failed for user=${params.u || 'unknown'}`);
      sendResponse(reply, createError(ERROR.AUTH_FAILED.code, ERROR.AUTH_FAILED.message), params.f);
      return reply;
    }
    (req as any).subsonicUser = user;
  });

  // ========== System ==========

  app.all('/rest/ping', async (req, reply) => {
    sendResponse(reply, createResponse(), getParams(req).f);
  });
  app.all('/rest/ping.view', async (req, reply) => {
    sendResponse(reply, createResponse(), getParams(req).f);
  });

  app.all('/rest/getLicense', async (req, reply) => {
    sendResponse(reply, createResponse({
      license: { valid: true, email: 'user@example.com', licenseExpires: '2099-12-31T23:59:59' },
    }), getParams(req).f);
  });
  app.all('/rest/getLicense.view', async (req, reply) => {
    sendResponse(reply, createResponse({
      license: { valid: true, email: 'user@example.com', licenseExpires: '2099-12-31T23:59:59' },
    }), getParams(req).f);
  });

  app.all('/rest/getOpenSubsonicExtensions', async (req, reply) => {
    sendResponse(reply, createResponse({ openSubsonicExtensions: OPENSUBSONIC_EXTENSIONS }), getParams(req).f);
  });
  app.all('/rest/getOpenSubsonicExtensions.view', async (req, reply) => {
    sendResponse(reply, createResponse({ openSubsonicExtensions: OPENSUBSONIC_EXTENSIONS }), getParams(req).f);
  });

  // ========== Browsing ==========

  app.all('/rest/getMusicFolders', async (req, reply) => {
    sendResponse(reply, createResponse({
      musicFolders: { musicFolder: [{ id: 1, name: 'Music Library' }] },
    }), getParams(req).f);
  });
  app.all('/rest/getMusicFolders.view', async (req, reply) => {
    sendResponse(reply, createResponse({
      musicFolders: { musicFolder: [{ id: 1, name: 'Music Library' }] },
    }), getParams(req).f);
  });

  // getGenres - matches /api/browse/genres query (splits semicolon-separated genres)
  async function handleGetGenres(req: FastifyRequest, reply: FastifyReply) {
    const r = await db().query(`
      SELECT 
        TRIM(g) as genre,
        COUNT(DISTINCT t.id)::int as song_count,
        COUNT(DISTINCT t.album)::int as album_count
      FROM active_tracks t, UNNEST(STRING_TO_ARRAY(t.genre, ';')) as g
      WHERE t.genre IS NOT NULL AND TRIM(g) <> ''
      GROUP BY TRIM(g)
      ORDER BY genre
    `);
    sendResponse(reply, createResponse({
      genres: {
        genre: r.rows.map(g => ({ songCount: Number(g.song_count), albumCount: Number(g.album_count), value: g.genre })),
      },
    }), getParams(req).f);
  }
  app.all('/rest/getGenres', handleGetGenres);
  app.all('/rest/getGenres.view', handleGetGenres);

  // getArtists - matches /api/browse/artists query
  async function handleGetArtists(req: FastifyRequest, reply: FastifyReply) {
    const r = await db().query(`
      SELECT 
        a.id, 
        a.name, 
        COUNT(DISTINCT t.id)::int as track_count,
        COUNT(DISTINCT NULLIF(t.album, ''))::int as album_count
      FROM artists a
      JOIN track_artists ta ON ta.artist_id = a.id
      JOIN active_tracks t ON t.id = ta.track_id
      WHERE a.name IS NOT NULL AND a.name <> ''
      GROUP BY a.id, a.name
      ORDER BY a.name
    `);
    
    const indexes: Record<string, any[]> = {};
    for (const artist of r.rows) {
      const firstChar = (artist.name || 'Unknown')[0].toUpperCase();
      const indexKey = /[A-Z]/.test(firstChar) ? firstChar : '#';
      if (!indexes[indexKey]) indexes[indexKey] = [];
      indexes[indexKey].push(formatArtist(artist));
    }
    
    sendResponse(reply, createResponse({
      artists: {
        ignoredArticles: 'The El La Los Las Le Les',
        index: Object.entries(indexes).map(([name, artistList]) => ({ name, artist: artistList })),
      },
    }), getParams(req).f);
  }
  app.all('/rest/getArtists', handleGetArtists);
  app.all('/rest/getArtists.view', handleGetArtists);

  // getArtist
  async function handleGetArtist(req: FastifyRequest, reply: FastifyReply) {
    const params = getParams(req);
    const artistId = params.id?.replace('ar-', '');
    if (!artistId) return sendResponse(reply, createError(ERROR.MISSING_PARAM.code, 'Missing id parameter'), params.f);
    
    const ar = await db().query(`
      SELECT a.id, a.name, COUNT(DISTINCT t.album) as album_count
      FROM artists a 
      LEFT JOIN track_artists ta ON ta.artist_id = a.id AND ta.role = 'albumartist'
      LEFT JOIN active_tracks t ON t.id = ta.track_id
      WHERE a.id = $1 GROUP BY a.id, a.name
    `, [artistId]);
    
    if (ar.rows.length === 0) return sendResponse(reply, createError(ERROR.NOT_FOUND.code, 'Artist not found'), params.f);
    
    const albums = await db().query(`
      SELECT t.album as name, t.artist, MIN(t.year) as year,
             COUNT(*) as track_count, SUM(t.duration_ms) as total_duration_ms,
             (SELECT t2.id FROM active_tracks t2 JOIN track_artists ta2 ON ta2.track_id = t2.id WHERE t2.album = t.album AND ta2.artist_id = $1 AND t2.art_path IS NOT NULL LIMIT 1) as art_track_id
      FROM active_tracks t
      JOIN track_artists ta ON ta.track_id = t.id
      WHERE ta.artist_id = $1 AND t.album IS NOT NULL
      GROUP BY t.album, t.artist
      ORDER BY year DESC, t.album
    `, [artistId]);
    
    sendResponse(reply, createResponse({
      artist: { ...formatArtist(ar.rows[0]), album: albums.rows.map(a => ({ ...formatAlbum(a), artistId: `ar-${artistId}` })) },
    }), params.f);
  }
  app.all('/rest/getArtist', handleGetArtist);
  app.all('/rest/getArtist.view', handleGetArtist);

  // getTopSongs (used by some clients when viewing an artist)
  async function handleGetTopSongs(req: FastifyRequest, reply: FastifyReply) {
    const params = getParams(req);
    const userId = (req as any).subsonicUser?.userId;

    const count = Math.min(parseInt((params as any).count || '50'), 500);
    const artistName = (params as any).artist as string | undefined;
    const artistIdRaw = (params as any).artistId as string | undefined;

    if (!artistName && !artistIdRaw) {
      return sendResponse(reply, createError(ERROR.MISSING_PARAM.code, 'Missing artist/artistId parameter'), params.f);
    }

    let r;
    if (artistIdRaw) {
      const artistId = Number(artistIdRaw.replace('ar-', ''));
      r = await db().query(
        `
        SELECT t.*, f.added_at as starred_at
        FROM active_tracks t
        JOIN track_artists ta ON ta.track_id = t.id
        LEFT JOIN favorite_tracks f ON f.track_id = t.id AND f.user_id = $1
        WHERE ta.artist_id = $2
        ORDER BY t.id DESC
        LIMIT $3
      `,
        [userId, artistId, count]
      );
    } else {
      r = await db().query(
        `
        SELECT t.*, f.added_at as starred_at
        FROM active_tracks t
        LEFT JOIN favorite_tracks f ON f.track_id = t.id AND f.user_id = $1
        WHERE lower(t.artist) = lower($2)
        ORDER BY t.id DESC
        LIMIT $3
      `,
        [userId, artistName, count]
      );
    }

    sendResponse(reply, createResponse({ topSongs: { song: r.rows.map(formatSong) } }), params.f);
  }
  app.all('/rest/getTopSongs', handleGetTopSongs);
  app.all('/rest/getTopSongs.view', handleGetTopSongs);

  // getAlbum
  async function handleGetAlbum(req: FastifyRequest, reply: FastifyReply) {
    const params = getParams(req);
    let albumId = params.id?.replace('al-', '');
    if (!albumId) return sendResponse(reply, createError(ERROR.MISSING_PARAM.code, 'Missing id parameter'), params.f);
    
    const userId = (req as any).subsonicUser?.userId;
    const albumName = decodeURIComponent(albumId);
    
    const tracks = await db().query(`
      SELECT t.*, f.added_at as starred_at
      FROM active_tracks t
      LEFT JOIN favorite_tracks f ON f.track_id = t.id AND f.user_id = $1
      WHERE t.album = $2
      ORDER BY t.disc_number, t.track_number, t.title
    `, [userId, albumName]);
    
    if (tracks.rows.length === 0) return sendResponse(reply, createError(ERROR.NOT_FOUND.code, 'Album not found'), params.f);
    
    const firstTrack = tracks.rows[0];
    const album = {
      id: `al-${encodeURIComponent(firstTrack.album)}`,
      name: firstTrack.album,
      artist: firstTrack.artist,
      coverArt: String(firstTrack.id),
      songCount: tracks.rows.length,
      duration: Math.round(tracks.rows.reduce((sum: number, t: any) => sum + (t.duration_ms || 0), 0) / 1000),
      created: firstTrack.updated_at || new Date().toISOString(),
      year: firstTrack.year || 0,
      genre: firstTrack.genre || '',
    };
    
    sendResponse(reply, createResponse({ album: { ...album, song: tracks.rows.map(formatSong) } }), params.f);
  }
  app.all('/rest/getAlbum', handleGetAlbum);
  app.all('/rest/getAlbum.view', handleGetAlbum);

  // getSong
  async function handleGetSong(req: FastifyRequest, reply: FastifyReply) {
    const params = getParams(req);
    const songId = params.id;
    if (!songId) return sendResponse(reply, createError(ERROR.MISSING_PARAM.code, 'Missing id parameter'), params.f);
    
    const userId = (req as any).subsonicUser?.userId;
    const r = await db().query(`
      SELECT t.*, f.added_at as starred_at
      FROM active_tracks t
      LEFT JOIN favorite_tracks f ON f.track_id = t.id AND f.user_id = $1
      WHERE t.id = $2
    `, [userId, songId]);
    
    if (r.rows.length === 0) return sendResponse(reply, createError(ERROR.NOT_FOUND.code, 'Song not found'), params.f);
    sendResponse(reply, createResponse({ song: formatSong(r.rows[0]) }), params.f);
  }
  app.all('/rest/getSong', handleGetSong);
  app.all('/rest/getSong.view', handleGetSong);

  // ========== Album Lists ==========

  async function handleGetAlbumList2(req: FastifyRequest, reply: FastifyReply) {
    const params = getParams(req);
    const type = params.type || 'alphabeticalByName';
    const size = Math.min(parseInt(params.size || '10'), 500);
    const offset = parseInt(params.offset || '0');
    
    let orderBy = 'ua.album';
    switch (type) {
      case 'random': orderBy = 'RANDOM()'; break;
      case 'newest': orderBy = 'ac.max_updated DESC'; break;
      case 'alphabeticalByName': orderBy = 'ua.album'; break;
      case 'alphabeticalByArtist': orderBy = 'display_artist, ua.album'; break;
      case 'byYear': orderBy = 'ua.year DESC, ua.album'; break;
      case 'byGenre': orderBy = 'ua.album'; break;
      default: orderBy = 'ua.album';
    }

    const genreRaw = (params as any).genre as string | undefined;
    const genre = genreRaw?.trim();
    // Match genre tokens the same way getGenres does (split on ';' and trim).
    const whereGenre =
      type === 'byGenre' && genre
        ? `AND EXISTS (
             SELECT 1
             FROM UNNEST(STRING_TO_ARRAY(t.genre, ';')) as g
             WHERE TRIM(g) ILIKE $3
           )`
        : '';
    const args: any[] = [size, offset];
    if (type === 'byGenre' && genre) args.push(genre);

    // Match browse/albums query structure
    const r = await db().query(`
      WITH unique_albums AS (
        SELECT DISTINCT ON (t.album)
          t.album,
          t.id as first_track_id,
          t.art_path,
          t.year,
          t.updated_at
        FROM active_tracks t
        WHERE t.album IS NOT NULL AND t.album <> ''
          ${whereGenre}
        ORDER BY t.album, t.path
      ),
      album_counts AS (
        SELECT t.album, COUNT(*)::int as track_count, SUM(t.duration_ms) as total_duration_ms, MAX(t.updated_at) as max_updated
        FROM active_tracks t
        WHERE t.album IS NOT NULL AND t.album <> ''
          ${whereGenre}
        GROUP BY t.album
      )
      SELECT
        ua.album as name,
        COALESCE(
          (SELECT a.name FROM track_artists ta JOIN artists a ON a.id = ta.artist_id 
           WHERE ta.track_id = ua.first_track_id AND ta.role = 'albumartist' 
           ORDER BY a.name LIMIT 1),
          (SELECT a.name FROM track_artists ta JOIN artists a ON a.id = ta.artist_id 
           WHERE ta.track_id = ua.first_track_id AND ta.role = 'artist' 
           ORDER BY a.name LIMIT 1)
        ) as display_artist,
        ac.track_count,
        ac.total_duration_ms,
        ua.first_track_id as art_track_id,
        ua.year,
        ac.max_updated
      FROM unique_albums ua
      JOIN album_counts ac ON ac.album = ua.album
      ORDER BY ${orderBy}
      LIMIT $1 OFFSET $2
    `, args);
    
    const albums = r.rows.map(row => ({
      id: `al-${encodeURIComponent(row.name)}`,
      name: row.name,
      artist: row.display_artist || 'Unknown Artist',
      coverArt: row.art_track_id ? String(row.art_track_id) : undefined,
      songCount: row.track_count || 0,
      duration: Math.round((row.total_duration_ms || 0) / 1000),
      year: row.year || 0,
    }));
    
    sendResponse(reply, createResponse({ albumList2: { album: albums } }), params.f);
  }
  app.all('/rest/getAlbumList2', handleGetAlbumList2);
  app.all('/rest/getAlbumList2.view', handleGetAlbumList2);

  // getRandomSongs
  async function handleGetRandomSongs(req: FastifyRequest, reply: FastifyReply) {
    const params = getParams(req);
    const size = Math.min(parseInt(params.size || '10'), 500);
    const userId = (req as any).subsonicUser?.userId;
    
    const r = await db().query(`
      SELECT t.*, f.added_at as starred_at
      FROM active_tracks t
      LEFT JOIN favorite_tracks f ON f.track_id = t.id AND f.user_id = $1
      ORDER BY RANDOM() LIMIT $2
    `, [userId, size]);
    
    sendResponse(reply, createResponse({ randomSongs: { song: r.rows.map(formatSong) } }), params.f);
  }
  app.all('/rest/getRandomSongs', handleGetRandomSongs);
  app.all('/rest/getRandomSongs.view', handleGetRandomSongs);

  // ========== Search ==========

  async function handleSearch3(req: FastifyRequest, reply: FastifyReply) {
    const params = getParams(req);
    const query = params.query || '';
    const artistCount = Math.min(parseInt(params.artistCount || '20'), 100);
    const albumCount = Math.min(parseInt(params.albumCount || '20'), 100);
    const songCount = Math.min(parseInt(params.songCount || '20'), 100);
    const userId = (req as any).subsonicUser?.userId;
    const pattern = `%${query}%`;
    
    const artists = await db().query(`
      SELECT a.id, a.name, COUNT(DISTINCT t.album) as album_count
      FROM artists a 
      LEFT JOIN track_artists ta ON ta.artist_id = a.id AND ta.role = 'albumartist'
      LEFT JOIN active_tracks t ON t.id = ta.track_id
      WHERE a.name ILIKE $1 GROUP BY a.id, a.name ORDER BY a.name LIMIT $2
    `, [pattern, artistCount]);
    
    const albums = await db().query(`
      SELECT album as name, artist, MIN(year) as year,
             COUNT(*) as track_count, SUM(duration_ms) as total_duration_ms,
             (SELECT id FROM active_tracks t2 WHERE t2.album = t.album AND t2.art_path IS NOT NULL LIMIT 1) as art_track_id
      FROM active_tracks t
      WHERE album ILIKE $1 GROUP BY album, artist ORDER BY album LIMIT $2
    `, [pattern, albumCount]);
    
    const songs = await db().query(`
      SELECT t.*, f.added_at as starred_at
      FROM active_tracks t
      LEFT JOIN favorite_tracks f ON f.track_id = t.id AND f.user_id = $1
      WHERE t.title ILIKE $2 OR t.artist ILIKE $2 OR t.album ILIKE $2
      ORDER BY t.title LIMIT $3
    `, [userId, pattern, songCount]);
    
    sendResponse(reply, createResponse({
      searchResult3: {
        artist: artists.rows.map(formatArtist),
        album: albums.rows.map(formatAlbum),
        song: songs.rows.map(formatSong),
      },
    }), params.f);
  }
  app.all('/rest/search3', handleSearch3);
  app.all('/rest/search3.view', handleSearch3);

  // ========== Media Retrieval ==========

  function safeJoinMount(mountPath: string, relPath: string) {
    const abs = path.resolve(mountPath, relPath);
    const base = path.resolve(mountPath);
    if (!abs.startsWith(base + path.sep)) throw new Error('invalid path');
    return abs;
  }

  function safeJoinDir(baseDir: string, relPath: string) {
    const abs = path.resolve(baseDir, relPath);
    const base = path.resolve(baseDir);
    if (!abs.startsWith(base + path.sep)) throw new Error('invalid path');
    return abs;
  }

  async function setNowPlaying(username: string, trackId: string) {
    try {
      const key = `subsonic:nowPlaying:${encodeURIComponent(username)}`;
      await redis().set(key, JSON.stringify({ trackId, username, at: Date.now() }), 'EX', 60 * 30);
    } catch {
      // ignore
    }
  }

  async function handleStream(req: FastifyRequest, reply: FastifyReply) {
    const params = getParams(req);
    const id = params.id;
    if (!id) return sendResponse(reply, createError(ERROR.MISSING_PARAM.code, 'Missing id parameter'), params.f);

    const user = (req as any).subsonicUser as { userId: string; role: Role } | undefined;
    if (!user) return sendResponse(reply, createError(ERROR.AUTH_FAILED.code, ERROR.AUTH_FAILED.message), params.f);

    const r = await db().query<{ path: string; ext: string; library_id: number; mount_path: string }>(
      'select t.path, t.ext, t.library_id, l.mount_path from active_tracks t join libraries l on l.id=t.library_id where t.id=$1',
      [Number(id)]
    );
    const row = r.rows[0];
    if (!row) return reply.code(404).send();

    const allowed = await allowedLibrariesForUser(user.userId, user.role);
    if (!isLibraryAllowed(Number(row.library_id), allowed)) return reply.code(404).send();

    const abs = safeJoinMount(row.mount_path, row.path);
    const st = await stat(abs);
    const range = req.headers.range;

    const contentType = row.ext === '.mp3' ? 'audio/mpeg' : 'application/octet-stream';

    if (range) {
      const m = /^bytes=(\d+)-(\d+)?$/.exec(range);
      if (!m) return reply.code(416).send();
      const start = Number(m[1]);
      const end = m[2] ? Number(m[2]) : st.size - 1;
      if (start >= st.size || end >= st.size || start > end) return reply.code(416).send();

      reply
        .code(206)
        .header('Content-Range', `bytes ${start}-${end}/${st.size}`)
        .header('Accept-Ranges', 'bytes')
        .header('Content-Length', String(end - start + 1))
        .header('Content-Type', contentType);

      return reply.send(createReadStream(abs, { start, end }));
    }

    reply.header('Content-Length', String(st.size)).header('Accept-Ranges', 'bytes').header('Content-Type', contentType);
    return reply.send(createReadStream(abs));
  }

  app.all('/rest/stream', handleStream);
  app.all('/rest/stream.view', handleStream);
  app.all('/rest/download', handleStream);
  app.all('/rest/download.view', handleStream);

  async function handleGetCoverArt(req: FastifyRequest, reply: FastifyReply) {
    const params = getParams(req);
    const id = params.id;
    if (!id) return sendResponse(reply, createError(ERROR.MISSING_PARAM.code, 'Missing id parameter'), params.f);

    let trackId = id;
    if (id.startsWith('al-')) {
      const albumName = decodeURIComponent(id.slice(3));
      const r = await db().query('SELECT id FROM active_tracks WHERE album = $1 AND art_path IS NOT NULL LIMIT 1', [albumName]);
      if (r.rows.length > 0) trackId = String(r.rows[0].id);
    } else if (id.startsWith('ar-')) {
      const artistId = id.slice(3);
      const r = await db().query(
        `
        SELECT t.id FROM active_tracks t
        JOIN track_artists ta ON ta.track_id = t.id
        WHERE ta.artist_id = $1 AND t.art_path IS NOT NULL LIMIT 1
      `,
        [artistId]
      );
      if (r.rows.length > 0) trackId = String(r.rows[0].id);
    }

    const artResult = await db().query<{ art_path: string | null; art_mime: string | null }>(
      'SELECT art_path, art_mime FROM active_tracks WHERE id = $1',
      [Number(trackId)]
    );
    const row = artResult.rows[0];
    if (!row?.art_path) return reply.code(404).send();

    try {
      const abs = safeJoinDir(ART_DIR, row.art_path);
      const st = await stat(abs);
      const mime = row.art_mime || 'image/jpeg';

      reply
        .header('Content-Type', mime)
        .header('Content-Length', String(st.size))
        .header('Cache-Control', 'public, max-age=86400');

      return reply.send(createReadStream(abs));
    } catch {
      return reply.code(404).send();
    }
  }
  app.all('/rest/getCoverArt', handleGetCoverArt);
  app.all('/rest/getCoverArt.view', handleGetCoverArt);

  async function handleGetAvatar(req: FastifyRequest, reply: FastifyReply) {
    const params = getParams(req);
    const username = (params as any).username as string | undefined;
    if (!username) return sendResponse(reply, createError(ERROR.MISSING_PARAM.code, 'Missing username parameter'), params.f);

    const r = await db().query<{ avatar_path: string | null }>('select avatar_path from users where email=$1', [username]);
    const row = r.rows[0];
    if (!row?.avatar_path) return reply.code(404).send();

    try {
      const abs = safeJoinDir(AVATARS_DIR, row.avatar_path);
      if (!existsSync(abs)) return reply.code(404).send();
      const st = await stat(abs);

      reply
        .header('Content-Type', 'image/jpeg')
        .header('Content-Length', String(st.size))
        .header('Cache-Control', 'public, max-age=86400');

      return reply.send(createReadStream(abs));
    } catch {
      return reply.code(404).send();
    }
  }
  app.all('/rest/getAvatar', handleGetAvatar);
  app.all('/rest/getAvatar.view', handleGetAvatar);

  async function handleGetLyrics(req: FastifyRequest, reply: FastifyReply) {
    const params = getParams(req);
    const artist = (params as any).artist as string | undefined;
    const title = (params as any).title as string | undefined;

    if (!artist || !title) {
      sendResponse(reply, createResponse({ lyrics: { artist: artist ?? '', title: title ?? '', value: '' } }), params.f);
      return;
    }

    const r = await db().query<{ id: number; lyrics_path: string | null }>(
      `select id, lyrics_path
       from active_tracks
       where lower(artist)=lower($1) and lower(title)=lower($2)
       order by id asc
       limit 1`,
      [artist, title]
    );
    const row = r.rows[0];

    if (!row?.lyrics_path) {
      sendResponse(reply, createResponse({ lyrics: { artist, title, value: '' } }), params.f);
      return;
    }

    try {
      const abs = safeJoinDir(LYRICS_DIR, row.lyrics_path);
      const text = await readFile(abs, 'utf8');
      sendResponse(reply, createResponse({ lyrics: { artist, title, value: text } }), params.f);
    } catch {
      sendResponse(reply, createResponse({ lyrics: { artist, title, value: '' } }), params.f);
    }
  }
  app.all('/rest/getLyrics', handleGetLyrics);
  app.all('/rest/getLyrics.view', handleGetLyrics);

  async function handleGetNowPlaying(req: FastifyRequest, reply: FastifyReply) {
    const params = getParams(req);

    let entries: any[] = [];
    try {
      const keys = await redis().keys('subsonic:nowPlaying:*');
      if (keys.length > 0) {
        const vals = await redis().mget(keys);
        const parsed = vals
          .map(v => {
            try {
              return v ? (JSON.parse(v) as { trackId: string; username: string; at: number }) : null;
            } catch {
              return null;
            }
          })
          .filter(Boolean) as { trackId: string; username: string; at: number }[];

        if (parsed.length > 0) {
          const ids = parsed.map(p => Number(p.trackId)).filter(n => Number.isFinite(n));
          const tracks = await db().query('select * from active_tracks where id = any($1)', [ids]);
          const trackById = new Map<number, any>(tracks.rows.map((t: any) => [Number(t.id), t]));

          entries = parsed
            .map(p => {
              const t = trackById.get(Number(p.trackId));
              if (!t) return null;
              const s = formatSong(t);
              return {
                ...s,
                username: p.username,
                minutesAgo: Math.max(0, Math.floor((Date.now() - p.at) / 60000)),
                playerId: 0,
              };
            })
            .filter(Boolean);
        }
      }
    } catch {
      // ignore
    }

    sendResponse(reply, createResponse({ nowPlaying: { entry: entries } }), params.f);
  }
  app.all('/rest/getNowPlaying', handleGetNowPlaying);
  app.all('/rest/getNowPlaying.view', handleGetNowPlaying);

  async function handleGetAlbumInfo2(req: FastifyRequest, reply: FastifyReply) {
    const params = getParams(req);
    const id = params.id;
    if (!id) return sendResponse(reply, createError(ERROR.MISSING_PARAM.code, 'Missing id parameter'), params.f);

    sendResponse(
      reply,
      createResponse({
        albumInfo: {
          notes: '',
          musicBrainzId: '',
          smallImageUrl: '',
          mediumImageUrl: '',
          largeImageUrl: '',
        },
      }),
      params.f
    );
  }
  app.all('/rest/getAlbumInfo2', handleGetAlbumInfo2);
  app.all('/rest/getAlbumInfo2.view', handleGetAlbumInfo2);

  async function handleGetArtistInfo2(req: FastifyRequest, reply: FastifyReply) {
    const params = getParams(req);
    const id = params.id;
    if (!id) return sendResponse(reply, createError(ERROR.MISSING_PARAM.code, 'Missing id parameter'), params.f);

    sendResponse(
      reply,
      createResponse({
        artistInfo2: {
          biography: '',
          musicBrainzId: '',
          smallImageUrl: '',
          mediumImageUrl: '',
          largeImageUrl: '',
        },
      }),
      params.f
    );
  }
  app.all('/rest/getArtistInfo2', handleGetArtistInfo2);
  app.all('/rest/getArtistInfo2.view', handleGetArtistInfo2);

  async function handleSetRating(req: FastifyRequest, reply: FastifyReply) {
    const params = getParams(req);
    const id = params.id;
    const rating = (params as any).rating as string | undefined;
    if (!id) return sendResponse(reply, createError(ERROR.MISSING_PARAM.code, 'Missing id parameter'), params.f);
    if (rating === undefined) return sendResponse(reply, createError(ERROR.MISSING_PARAM.code, 'Missing rating parameter'), params.f);

    // mvbar doesn't have a ratings model yet; accept and no-op.
    sendResponse(reply, createResponse(), params.f);
  }
  app.all('/rest/setRating', handleSetRating);
  app.all('/rest/setRating.view', handleSetRating);


  async function handleStar(req: FastifyRequest, reply: FastifyReply) {
    const params = getParams(req);
    const userId = (req as any).subsonicUser?.userId;

    const ids: string[] = [];
    if (params.id) ids.push(params.id);

    const albumId = (params as any).albumId as string | undefined;
    if (albumId) {
      const albumName = albumId.startsWith('al-') ? decodeURIComponent(albumId.slice(3)) : decodeURIComponent(albumId);
      const r = await db().query<{ id: number }>('select id from active_tracks where album=$1', [albumName]);
      for (const row of r.rows) ids.push(String(row.id));
    }

    const artistId = (params as any).artistId as string | undefined;
    if (artistId) {
      const arId = artistId.replace('ar-', '');
      const r = await db().query<{ id: number }>(
        `select t.id
         from active_tracks t
         join track_artists ta on ta.track_id=t.id
         where ta.artist_id=$1`,
        [Number(arId)]
      );
      for (const row of r.rows) ids.push(String(row.id));
    }

    if (ids.length === 0) {
      return sendResponse(reply, createError(ERROR.MISSING_PARAM.code, 'Missing id/albumId/artistId parameter'), params.f);
    }

    for (const id of ids) {
      await db().query('INSERT INTO favorite_tracks (user_id, track_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, id]);
    }

    sendResponse(reply, createResponse(), params.f);
  }
  app.all('/rest/star', handleStar);
  app.all('/rest/star.view', handleStar);

  async function handleUnstar(req: FastifyRequest, reply: FastifyReply) {
    const params = getParams(req);
    const userId = (req as any).subsonicUser?.userId;

    const ids: string[] = [];
    if (params.id) ids.push(params.id);

    const albumId = (params as any).albumId as string | undefined;
    if (albumId) {
      const albumName = albumId.startsWith('al-') ? decodeURIComponent(albumId.slice(3)) : decodeURIComponent(albumId);
      const r = await db().query<{ id: number }>('select id from active_tracks where album=$1', [albumName]);
      for (const row of r.rows) ids.push(String(row.id));
    }

    const artistId = (params as any).artistId as string | undefined;
    if (artistId) {
      const arId = artistId.replace('ar-', '');
      const r = await db().query<{ id: number }>(
        `select t.id
         from active_tracks t
         join track_artists ta on ta.track_id=t.id
         where ta.artist_id=$1`,
        [Number(arId)]
      );
      for (const row of r.rows) ids.push(String(row.id));
    }

    if (ids.length === 0) {
      return sendResponse(reply, createError(ERROR.MISSING_PARAM.code, 'Missing id/albumId/artistId parameter'), params.f);
    }

    // Batch delete instead of N individual queries
    if (ids.length > 0) {
      const numericIds = ids.map(id => Number(id));
      await db().query('DELETE FROM favorite_tracks WHERE user_id = $1 AND track_id = ANY($2::bigint[])', [userId, numericIds]);
    }

    sendResponse(reply, createResponse(), params.f);
  }
  app.all('/rest/unstar', handleUnstar);
  app.all('/rest/unstar.view', handleUnstar);

  async function handleGetStarred2(req: FastifyRequest, reply: FastifyReply) {
    const params = getParams(req);
    const userId = (req as any).subsonicUser?.userId;
    
    const r = await db().query(`
      SELECT t.*, f.added_at as starred_at
      FROM favorite_tracks f
      JOIN active_tracks t ON t.id = f.track_id
      WHERE f.user_id = $1
      ORDER BY f.added_at DESC
    `, [userId]);
    
    sendResponse(reply, createResponse({ starred2: { song: r.rows.map(formatSong) } }), params.f);
  }
  app.all('/rest/getStarred2', handleGetStarred2);
  app.all('/rest/getStarred2.view', handleGetStarred2);

  // ========== Scrobble ==========

  async function handleScrobble(req: FastifyRequest, reply: FastifyReply) {
    const params = getParams(req);
    const id = params.id;
    const submission = params.submission !== 'false';
    if (!id) return sendResponse(reply, createError(ERROR.MISSING_PARAM.code, 'Missing id parameter'), params.f);

    const user = (req as any).subsonicUser as { userId: string; username: string } | undefined;

    // "Now playing" notification (store ephemeral state for getNowPlaying)
    if (!submission) {
      if (user?.username) await setNowPlaying(user.username, id);
      sendResponse(reply, createResponse(), params.f);
      return;
    }

    if (submission) {
      const userId = user?.userId;
      await db().query('INSERT INTO play_history (user_id, track_id) VALUES ($1, $2)', [userId, id]);
      await db().query(
        'INSERT INTO user_track_stats (user_id, track_id, play_count, last_played_at) VALUES ($1, $2, 1, now()) ON CONFLICT (user_id, track_id) DO UPDATE SET play_count = user_track_stats.play_count + 1, last_played_at = now()',
        [userId, id]
      );
    }
    sendResponse(reply, createResponse(), params.f);
  }
  app.all('/rest/scrobble', handleScrobble);
  app.all('/rest/scrobble.view', handleScrobble);

  // ========== User ==========

  app.all('/rest/getUser', async (req, reply) => {
    const params = getParams(req);
    const username = params.username || (req as any).subsonicUser?.username;
    sendResponse(reply, createResponse({
      user: {
        username, email: '', scrobblingEnabled: true, adminRole: true, settingsRole: true,
        downloadRole: true, uploadRole: false, playlistRole: true, coverArtRole: true,
        commentRole: true, podcastRole: false, streamRole: true, jukeboxRole: false,
        shareRole: true, videoConversionRole: false,
      },
    }), params.f);
  });
  app.all('/rest/getUser.view', async (req, reply) => {
    const params = getParams(req);
    const username = params.username || (req as any).subsonicUser?.username;
    sendResponse(reply, createResponse({
      user: {
        username, email: '', scrobblingEnabled: true, adminRole: true, settingsRole: true,
        downloadRole: true, uploadRole: false, playlistRole: true, coverArtRole: true,
        commentRole: true, podcastRole: false, streamRole: true, jukeboxRole: false,
        shareRole: true, videoConversionRole: false,
      },
    }), params.f);
  });

  // ========== Play Queue ==========

  // Minimal play queue support (clients often call this on startup)
  app.all('/rest/getPlayQueue', async (req, reply) => {
    const params = getParams(req);
    sendResponse(reply, createResponse({ playQueue: { entry: [], current: 0, position: 0 } }), params.f);
  });
  app.all('/rest/getPlayQueue.view', async (req, reply) => {
    const params = getParams(req);
    sendResponse(reply, createResponse({ playQueue: { entry: [], current: 0, position: 0 } }), params.f);
  });

  app.all('/rest/savePlayQueue', async (req, reply) => {
    const params = getParams(req);
    sendResponse(reply, createResponse(), params.f);
  });
  app.all('/rest/savePlayQueue.view', async (req, reply) => {
    const params = getParams(req);
    sendResponse(reply, createResponse(), params.f);
  });

  // ========== Playlists ==========

  async function handleGetPlaylists(req: FastifyRequest, reply: FastifyReply) {
    const params = getParams(req);
    const userId = (req as any).subsonicUser?.userId;
    
    const r = await db().query(`
      SELECT p.id, p.name, p.created_at,
             (SELECT COUNT(*) FROM playlist_items pi WHERE pi.playlist_id = p.id) as song_count,
             (SELECT SUM(t.duration_ms) FROM playlist_items pi JOIN active_tracks t ON t.id = pi.track_id WHERE pi.playlist_id = p.id) as duration
      FROM playlists p
      WHERE p.user_id = $1
      ORDER BY p.name
    `, [userId]);
    
    sendResponse(reply, createResponse({
      playlists: {
        playlist: r.rows.map(p => ({
          id: String(p.id),
          name: p.name,
          owner: (req as any).subsonicUser?.username || 'admin',
          public: false,
          songCount: Number(p.song_count) || 0,
          duration: Math.round((Number(p.duration) || 0) / 1000),
          created: p.created_at,
          changed: p.created_at,
        })),
      },
    }), params.f);
  }
  app.all('/rest/getPlaylists', handleGetPlaylists);
  app.all('/rest/getPlaylists.view', handleGetPlaylists);

  async function handleGetPlaylist(req: FastifyRequest, reply: FastifyReply) {
    const params = getParams(req);
    const playlistId = params.id;
    if (!playlistId) return sendResponse(reply, createError(ERROR.MISSING_PARAM.code, 'Missing id parameter'), params.f);
    
    const userId = (req as any).subsonicUser?.userId;
    
    const pr = await db().query('SELECT id, name, user_id, created_at FROM playlists WHERE id = $1 AND user_id = $2', [playlistId, userId]);
    if (pr.rows.length === 0) return sendResponse(reply, createError(ERROR.NOT_FOUND.code, 'Playlist not found'), params.f);
    
    const songs = await db().query(`
      SELECT t.*, f.added_at as starred_at
      FROM playlist_items pi
      JOIN active_tracks t ON t.id = pi.track_id
      LEFT JOIN favorite_tracks f ON f.track_id = t.id AND f.user_id = $1
      WHERE pi.playlist_id = $2
      ORDER BY pi.position
    `, [userId, playlistId]);
    
    const playlist = pr.rows[0];
    sendResponse(reply, createResponse({
      playlist: {
        id: String(playlist.id),
        name: playlist.name,
        owner: (req as any).subsonicUser?.username || 'admin',
        public: false,
        songCount: songs.rows.length,
        duration: Math.round(songs.rows.reduce((sum: number, s: any) => sum + (s.duration_ms || 0), 0) / 1000),
        created: playlist.created_at,
        changed: playlist.created_at,
        entry: songs.rows.map(formatSong),
      },
    }), params.f);
  }
  app.all('/rest/getPlaylist', handleGetPlaylist);
  app.all('/rest/getPlaylist.view', handleGetPlaylist);

  logger.success('subsonic', 'Subsonic/OpenSubsonic API enabled at /rest/*');
};

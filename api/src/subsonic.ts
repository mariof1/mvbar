/**
 * Subsonic/OpenSubsonic API implementation.
 *
 * The original Subsonic API has both file-tree endpoints used by older clients
 * and tag/id3 endpoints used by newer OpenSubsonic clients. Keep the response
 * surface explicit here so compatibility gaps are easy to spot.
 */

import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { audit, db, redis } from './db.js';
import logger from './logger.js';
import { allowedLibrariesForUser } from './access.js';
import { normalizeEmail, verifyPassword } from './security.js';
import type { Role } from './store.js';

const ART_DIR = process.env.ART_DIR ?? '/data/cache/art';
const AVATARS_DIR = process.env.AVATARS_DIR ?? '/data/cache/avatars';
const LYRICS_DIR = process.env.LYRICS_DIR ?? '/data/cache/lyrics';
const PODCAST_ART_DIR = process.env.PODCAST_ART_DIR ?? '/data/cache/podcast-art';

const SUBSONIC_API_VERSION = '1.16.1';
const SERVER_NAME = 'mvbar';

const OPENSUBSONIC_EXTENSIONS = [
  { name: 'transcodeOffset', versions: [1] },
  { name: 'formPost', versions: [1] },
  { name: 'songLyrics', versions: [1] },
];

const ERROR = {
  GENERIC: { code: 0, message: 'A generic error.' },
  MISSING_PARAM: { code: 10, message: 'Required parameter is missing.' },
  AUTH_FAILED: { code: 40, message: 'Wrong username or password.' },
  NOT_AUTHORIZED: { code: 50, message: 'User is not authorized for the given operation.' },
  NOT_FOUND: { code: 70, message: 'The requested data was not found.' },
};

type SubsonicParams = {
  u?: string;
  p?: string;
  t?: string;
  s?: string;
  v?: string;
  c?: string;
  f?: string;
  callback?: string;
} & Record<string, string | undefined>;

type SubsonicUser = {
  userId: string;
  username: string;
  role: Role;
  allowedLibraries: number[] | null;
};

type SubsonicResponse = {
  'subsonic-response': {
    status: 'ok' | 'failed';
    version: string;
    type: string;
    serverVersion: string;
    openSubsonic?: boolean;
    error?: { code: number; message: string };
    [key: string]: unknown;
  };
};

function createResponse(data: Record<string, unknown> = {}): SubsonicResponse {
  return {
    'subsonic-response': {
      status: 'ok',
      version: SUBSONIC_API_VERSION,
      type: SERVER_NAME,
      serverVersion: process.env.APP_VERSION || '0.0.0-dev',
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
      serverVersion: process.env.APP_VERSION || '0.0.0-dev',
      error: { code, message },
    },
  };
}

function one(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (Array.isArray(v)) return one(v[0]);
  return String(v);
}

function getParams(req: FastifyRequest): SubsonicParams {
  const merged: Record<string, unknown> = {
    ...((req.body as Record<string, unknown> | null) ?? {}),
    ...((req.query as Record<string, unknown> | null) ?? {}),
  };
  const out: SubsonicParams = {};
  for (const [k, v] of Object.entries(merged)) out[k] = one(v);
  return out;
}

function escapeXml(str: string) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function toXml(obj: unknown, rootName?: string): string {
  if (rootName === undefined) {
    const root = obj as Record<string, unknown>;
    const key = Object.keys(root)[0];
    return `<?xml version="1.0" encoding="UTF-8"?>\n${toXml(root[key], key)}`;
  }

  if (obj === null || obj === undefined) return `<${rootName}/>`;
  if (typeof obj !== 'object') return `<${rootName}>${escapeXml(String(obj))}</${rootName}>`;
  if (Array.isArray(obj)) return obj.map((item) => toXml(item, rootName)).join('');

  const attrs: string[] = [];
  const children: string[] = [];
  let textValue: string | null = null;

  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (value === null || value === undefined) continue;
    if (key === 'value' && typeof value !== 'object') {
      textValue = String(value);
    } else if (Array.isArray(value)) {
      children.push(value.map((item) => toXml(item, key)).join(''));
    } else if (typeof value === 'object') {
      children.push(toXml(value, key));
    } else {
      attrs.push(`${key}="${escapeXml(String(value))}"`);
    }
  }

  const attrStr = attrs.length ? ` ${attrs.join(' ')}` : '';
  const body = `${textValue !== null ? escapeXml(textValue) : ''}${children.join('')}`;
  if (!body) return `<${rootName}${attrStr}/>`;
  return `<${rootName}${attrStr}>${body}</${rootName}>`;
}

function sendResponse(reply: FastifyReply, data: SubsonicResponse, format = 'xml', callback?: string) {
  if (format === 'json' || format === 'jsonp') {
    const json = JSON.stringify(data);
    if (format === 'jsonp' && callback && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(callback)) {
      reply.type('application/javascript; charset=utf-8').send(`${callback}(${json});`);
    } else {
      reply.type('application/json; charset=utf-8').send(json);
    }
    return;
  }
  reply.header('content-type', 'application/xml; charset=utf-8').send(toXml(data));
}

function safeJoin(baseDir: string, relPath: string) {
  const abs = path.resolve(baseDir, relPath);
  const base = path.resolve(baseDir);
  if (abs !== base && !abs.startsWith(base + path.sep)) throw new Error('invalid path');
  return abs;
}

function mimeFromExt(ext: string | null | undefined) {
  switch ((ext ?? '').toLowerCase()) {
    case '.mp3': return 'audio/mpeg';
    case '.flac': return 'audio/flac';
    case '.m4a':
    case '.m4b': return 'audio/mp4';
    case '.aac': return 'audio/aac';
    case '.ogg': return 'audio/ogg';
    case '.opus': return 'audio/opus';
    case '.wav': return 'audio/wav';
    default: return 'application/octet-stream';
  }
}

function imageMimeFromPath(p: string, fallback = 'image/jpeg') {
  switch (path.extname(p).toLowerCase()) {
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.png': return 'image/png';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    default: return fallback;
  }
}

function isoDate(v: unknown) {
  if (!v) return undefined;
  if (v instanceof Date) return v.toISOString();
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

function albumId(name: string) {
  return `al-${encodeURIComponent(name)}`;
}

function decodeAlbumId(id: string) {
  return decodeURIComponent(id.startsWith('al-') ? id.slice(3) : id);
}

function artistId(id: string | number) {
  return `ar-${id}`;
}

function decodeArtistId(id: string) {
  const raw = id.startsWith('ar-') ? id.slice(3) : id;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function directoryIdForLibrary(id: number) {
  return `lib-${id}`;
}

function decodeLibraryDirectoryId(id: string) {
  const raw = id.startsWith('lib-') ? id.slice(4) : id;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function folderName(mountPath: string) {
  const b = path.basename(mountPath);
  return b && b !== path.sep ? b : mountPath;
}

function parseCount(value: string | undefined, fallback: number, max = 500) {
  return Math.min(Math.max(Number(value ?? fallback), 1), max);
}

function parseOffset(value: string | undefined) {
  return Math.max(Number(value ?? 0), 0);
}

function podcastChannelId(id: string | number) {
  return `pc-${id}`;
}

function podcastEpisodeId(id: string | number) {
  return `pe-${id}`;
}

function podcastStreamId(id: string | number) {
  return `pod-${id}`;
}

function decodePrefixedNumber(id: string | undefined, prefix: string) {
  if (!id) return null;
  const raw = id.startsWith(prefix) ? id.slice(prefix.length) : id;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function timingSafeStringEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function decodeLegacyPassword(password: string) {
  if (!password.startsWith('enc:')) return password;
  const hex = password.slice(4);
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(hex)) return '';
  return Buffer.from(hex, 'hex').toString('utf8');
}

async function authenticate(req: FastifyRequest): Promise<Omit<SubsonicUser, 'allowedLibraries'> | null> {
  const params = getParams(req);
  const username = normalizeEmail(params.u ?? '');
  const password = params.p;
  const token = params.t;
  const salt = params.s;

  if (!username) return null;

  const r = await db().query<{
    id: string;
    email: string;
    password_hash: string | null;
    subsonic_password: string | null;
    role: Role;
    approval_status: string;
  }>(
    `select id, email, password_hash, subsonic_password, role, approval_status
       from users
      where email = $1`,
    [username]
  );
  const user = r.rows[0];
  if (!user || user.approval_status !== 'approved') return null;

  if (token && salt && user.subsonic_password) {
    const expected = crypto.createHash('md5').update(user.subsonic_password + salt).digest('hex');
    if (timingSafeStringEqual(token.toLowerCase(), expected.toLowerCase())) {
      return { userId: user.id, username: user.email, role: user.role };
    }
  }

  if (!password) return null;

  const plainPassword = decodeLegacyPassword(password);
  if (!plainPassword) return null;

  if (user.subsonic_password && timingSafeStringEqual(plainPassword, user.subsonic_password)) {
    return { userId: user.id, username: user.email, role: user.role };
  }

  if (verifyPassword(plainPassword, user.password_hash)) {
    if (!user.subsonic_password) {
      await db().query('update users set subsonic_password = $1 where id = $2', [plainPassword, user.id]);
    }
    return { userId: user.id, username: user.email, role: user.role };
  }

  return null;
}

function currentUser(req: FastifyRequest): SubsonicUser {
  const user = (req as FastifyRequest & { subsonicUser?: SubsonicUser }).subsonicUser;
  if (!user) throw new Error('Subsonic user not authenticated');
  return user;
}

function trackAccessCondition(user: SubsonicUser, params: unknown[], alias = 't', musicFolderId?: string) {
  const folderId = musicFolderId ? decodeLibraryDirectoryId(musicFolderId) : null;
  if (folderId !== null) {
    if (user.allowedLibraries !== null && !user.allowedLibraries.includes(folderId)) return 'false';
    params.push(folderId);
    return `${alias}.library_id = $${params.length}`;
  }

  if (user.allowedLibraries === null) return 'true';
  params.push(user.allowedLibraries);
  return `${alias}.library_id = any($${params.length}::bigint[])`;
}

async function listAllowedLibraries(user: SubsonicUser) {
  if (user.allowedLibraries === null) {
    const r = await db().query<{ id: number; mount_path: string }>('select id, mount_path from libraries order by mount_path asc');
    return r.rows;
  }
  if (user.allowedLibraries.length === 0) return [];
  const r = await db().query<{ id: number; mount_path: string }>(
    'select id, mount_path from libraries where id = any($1::bigint[]) order by mount_path asc',
    [user.allowedLibraries]
  );
  return r.rows;
}

function formatSong(track: any): Record<string, unknown> {
  const ext = String(track.ext ?? '');
  const album = track.album || '';
  return {
    id: String(track.id),
    parent: album ? albumId(album) : 'root',
    isDir: false,
    title: track.title || path.basename(String(track.path || ''), ext) || 'Unknown',
    album,
    artist: track.artist || 'Unknown Artist',
    track: track.track_number || 0,
    year: track.year || 0,
    genre: track.genre || '',
    coverArt: track.art_path === null ? undefined : String(track.id),
    size: Number(track.size_bytes || 0),
    contentType: mimeFromExt(ext),
    suffix: ext.startsWith('.') ? ext.slice(1) : ext,
    duration: Math.round(Number(track.duration_ms || 0) / 1000),
    bitRate: track.bit_rate || 0,
    path: track.path || '',
    discNumber: track.disc_number || 1,
    created: track.birthtime_ms ? new Date(Number(track.birthtime_ms)).toISOString() : isoDate(track.created_at ?? track.updated_at),
    albumId: album ? albumId(album) : undefined,
    type: 'music',
    isVideo: false,
    playCount: Number(track.play_count || 0),
    starred: isoDate(track.starred_at),
  };
}

function formatAlbum(album: any): Record<string, unknown> {
  const name = album.name || album.album || 'Unknown Album';
  return {
    id: album.id || albumId(name),
    name,
    title: name,
    album: name,
    artist: album.artist || album.display_artist || 'Unknown Artist',
    coverArt: album.art_track_id ? String(album.art_track_id) : undefined,
    songCount: Number(album.track_count || 0),
    duration: Math.round(Number(album.total_duration_ms || 0) / 1000),
    created: album.max_birthtime_ms ? new Date(Number(album.max_birthtime_ms)).toISOString() : isoDate(album.created_at),
    year: album.year || 0,
    genre: album.genre || '',
    playCount: Number(album.play_count || 0),
    starred: isoDate(album.starred_at),
  };
}

function formatArtist(artist: any): Record<string, unknown> {
  return {
    id: artistId(artist.id),
    name: artist.name || 'Unknown Artist',
    coverArt: artist.art_track_id ? String(artist.art_track_id) : undefined,
    albumCount: Number(artist.album_count || 0),
  };
}

function formatPodcastChannel(channel: any, episodes?: any[]): Record<string, unknown> {
  return {
    id: podcastChannelId(channel.id),
    url: channel.feed_url,
    title: channel.title || 'Podcast',
    description: channel.description || '',
    status: 'completed',
    coverArt: channel.image_path || channel.image_url ? podcastChannelId(channel.id) : undefined,
    episode: episodes?.map(formatPodcastEpisode),
  };
}

function formatPodcastEpisode(episode: any): Record<string, unknown> {
  const contentType = episode.audio_type || 'audio/mpeg';
  const suffix = (() => {
    const ext = path.extname(String(episode.audio_url || '')).replace('.', '');
    if (ext) return ext.split('?')[0];
    if (contentType.includes('mpeg')) return 'mp3';
    if (contentType.includes('mp4')) return 'm4a';
    if (contentType.includes('ogg')) return 'ogg';
    return 'mp3';
  })();
  const coverArt = episode.image_path || episode.image_url
    ? podcastEpisodeId(episode.id)
    : (episode.podcast_image_path || episode.podcast_image_url ? podcastChannelId(episode.podcast_id) : undefined);
  return {
    id: podcastEpisodeId(episode.id),
    streamId: podcastStreamId(episode.id),
    channelId: podcastChannelId(episode.podcast_id),
    parent: podcastChannelId(episode.podcast_id),
    isDir: false,
    title: episode.title || 'Episode',
    album: episode.description || episode.podcast_title || '',
    artist: episode.podcast_title || 'Podcast',
    status: episode.downloaded_path ? 'completed' : 'skipped',
    publishDate: isoDate(episode.published_at),
    created: isoDate(episode.created_at),
    coverArt,
    size: Number(episode.file_size_bytes || 0),
    contentType,
    suffix,
    duration: Math.round(Number(episode.duration_ms || 0) / 1000),
    bitRate: 0,
    isVideo: false,
    path: `Podcasts/${episode.podcast_title || episode.podcast_id}/${episode.title || episode.id}.${suffix}`,
    type: 'podcast',
    bookmarkPosition: Number(episode.position_ms || 0) || undefined,
  };
}

function groupByIndex(rows: any[]) {
  const indexes: Record<string, unknown[]> = {};
  for (const artist of rows) {
    const firstChar = (artist.name || 'Unknown')[0].toUpperCase();
    const key = /[A-Z]/.test(firstChar) ? firstChar : '#';
    if (!indexes[key]) indexes[key] = [];
    indexes[key].push(formatArtist(artist));
  }
  return Object.entries(indexes).map(([name, artist]) => ({ name, artist }));
}

function parseLrcTimestamp(ts: string) {
  const m = /^(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?$/.exec(ts);
  if (!m) return null;
  const minutes = Number(m[1]);
  const seconds = Number(m[2]);
  const fraction = m[3] ? Number(m[3].padEnd(3, '0').slice(0, 3)) : 0;
  return minutes * 60_000 + seconds * 1000 + fraction;
}

function parseLyricsLines(text: string) {
  const lines: Array<{ start?: number; value: string }> = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const stamps = [...rawLine.matchAll(/\[(\d{1,2}:\d{2}(?:[.:]\d{1,3})?)\]/g)]
      .map((m) => parseLrcTimestamp(m[1]))
      .filter((n): n is number => n !== null);
    const value = rawLine.replace(/\[[^\]]+\]/g, '').trim();
    if (!value) continue;
    if (stamps.length) {
      for (const start of stamps) lines.push({ start, value });
    } else {
      lines.push({ value });
    }
  }
  const synced = lines.some((line) => line.start !== undefined);
  if (synced) lines.sort((a, b) => (a.start ?? Number.MAX_SAFE_INTEGER) - (b.start ?? Number.MAX_SAFE_INTEGER));
  return { synced, lines };
}

async function readTrackLyrics(trackId: number, user: SubsonicUser) {
  const args: unknown[] = [trackId];
  const access = trackAccessCondition(user, args, 't');
  const r = await db().query<{
    id: number;
    title: string | null;
    artist: string | null;
    language: string | null;
    lyrics_path: string | null;
    embedded_lyrics: string | null;
    embedded_lyrics_synced: boolean;
    path: string;
    mount_path: string;
  }>(
    `select t.id, t.title, t.artist, t.language, t.lyrics_path, t.embedded_lyrics,
            t.embedded_lyrics_synced, t.path, l.mount_path
       from active_tracks t
       join libraries l on l.id = t.library_id
      where t.id = $1 and ${access}`,
    args
  );
  const row = r.rows[0];
  if (!row) return null;

  if (row.lyrics_path) {
    try {
      const abs = row.lyrics_path.startsWith('music:')
        ? safeJoin(row.mount_path, row.lyrics_path.slice(6))
        : safeJoin(LYRICS_DIR, row.lyrics_path);
      const text = await readFile(abs, 'utf8');
      if (text.trim()) return { row, text, synced: /\[\d{1,2}:\d{2}/.test(text) };
    } catch {
      // fall through to embedded lyrics
    }
  }

  if (row.embedded_lyrics?.trim()) {
    return { row, text: row.embedded_lyrics, synced: row.embedded_lyrics_synced };
  }

  return { row, text: '', synced: false };
}

export const subsonicPlugin: FastifyPluginAsync = fp(async (app) => {
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/rest/')) return;
    reply
      .header('Access-Control-Allow-Origin', '*')
      .header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
      .header('Access-Control-Allow-Headers', '*');

    if (req.method === 'OPTIONS') return reply.code(204).send();
  });

  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    try {
      const out: Record<string, string> = {};
      for (const [k, v] of new URLSearchParams(body as string)) out[k] = v;
      done(null, out);
    } catch (e) {
      done(e as Error, undefined);
    }
  });

  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/rest/')) return;

    const params = getParams(req);
    const endpoint = req.url.split('?')[0].replace('/rest/', '').replace('.view', '');
    logger.info('subsonic', `${req.method} ${endpoint} format=${params.f || 'xml'}`);

    const auth = await authenticate(req);
    if (!auth) {
      logger.warn('subsonic', 'Auth failed');
      sendResponse(reply, createError(ERROR.AUTH_FAILED.code, ERROR.AUTH_FAILED.message), params.f, params.callback);
      return reply;
    }

    const allowedLibraries = await allowedLibrariesForUser(auth.userId, auth.role);
    (req as FastifyRequest & { subsonicUser?: SubsonicUser }).subsonicUser = { ...auth, allowedLibraries };
  });

  app.get('/api/subsonic/settings', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const r = await db().query<{ email: string; subsonic_password: string | null; google_id: string | null }>(
      'select email, subsonic_password, google_id from users where id=$1',
      [req.user.userId]
    );
    const row = r.rows[0];
    if (!row) return reply.code(404).send({ ok: false });
    return {
      ok: true,
      username: row.email,
      configured: Boolean(row.subsonic_password),
      authType: row.google_id ? 'google' : 'local',
    };
  });

  app.put('/api/subsonic/password', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const body = (req.body ?? {}) as { password?: string };
    const password = String(body.password ?? '');
    if (password.length < 8) return reply.code(400).send({ ok: false, error: 'password_too_short' });
    await db().query('update users set subsonic_password=$1 where id=$2', [password, req.user.userId]);
    await audit('subsonic_password_set', { by: req.user.userId });
    return { ok: true };
  });

  app.delete('/api/subsonic/password', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    await db().query('update users set subsonic_password=null where id=$1', [req.user.userId]);
    await audit('subsonic_password_cleared', { by: req.user.userId });
    return { ok: true };
  });

  function rest(name: string, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<void> | void) {
    app.all(`/rest/${name}`, handler);
    app.all(`/rest/${name}.view`, handler);
  }

  rest('ping', async (req, reply) => {
    const params = getParams(req);
    sendResponse(reply, createResponse(), params.f, params.callback);
  });

  rest('getLicense', async (req, reply) => {
    const params = getParams(req);
    sendResponse(reply, createResponse({
      license: { valid: true, email: currentUser(req).username, licenseExpires: '2099-12-31T23:59:59' },
    }), params.f, params.callback);
  });

  rest('getOpenSubsonicExtensions', async (req, reply) => {
    const params = getParams(req);
    sendResponse(reply, createResponse({ openSubsonicExtensions: OPENSUBSONIC_EXTENSIONS }), params.f, params.callback);
  });

  rest('getScanStatus', async (req, reply) => {
    const params = getParams(req);
    sendResponse(reply, createResponse({ scanStatus: { scanning: false, count: 0 } }), params.f, params.callback);
  });
  rest('startScan', async (req, reply) => {
    const params = getParams(req);
    sendResponse(reply, createResponse({ scanStatus: { scanning: false, count: 0 } }), params.f, params.callback);
  });
  rest('startRescan', async (req, reply) => {
    const params = getParams(req);
    sendResponse(reply, createResponse({ scanStatus: { scanning: false, count: 0 } }), params.f, params.callback);
  });
  rest('scanstatus', async (req, reply) => {
    const params = getParams(req);
    sendResponse(reply, createResponse({ scanStatus: { scanning: false, count: 0 } }), params.f, params.callback);
  });

  rest('getMusicFolders', async (req, reply) => {
    const params = getParams(req);
    const libraries = await listAllowedLibraries(currentUser(req));
    sendResponse(reply, createResponse({
      musicFolders: {
        musicFolder: libraries.map((l) => ({ id: directoryIdForLibrary(Number(l.id)), name: folderName(l.mount_path) })),
      },
    }), params.f, params.callback);
  });

  rest('getGenres', async (req, reply) => {
    const params = getParams(req);
    const user = currentUser(req);
    const args: unknown[] = [];
    const access = trackAccessCondition(user, args, 't', params.musicFolderId);
    const r = await db().query(`
      select trim(g) as genre,
             count(distinct t.id)::int as song_count,
             count(distinct nullif(t.album, ''))::int as album_count
        from active_tracks t, unnest(string_to_array(t.genre, ';')) as g
       where ${access} and t.genre is not null and trim(g) <> ''
       group by trim(g)
       order by genre
    `, args);
    sendResponse(reply, createResponse({
      genres: { genre: r.rows.map((g) => ({ songCount: Number(g.song_count), albumCount: Number(g.album_count), value: g.genre })) },
    }), params.f, params.callback);
  });

  rest('getArtists', async (req, reply) => {
    const params = getParams(req);
    const user = currentUser(req);
    const args: unknown[] = [];
    const access = trackAccessCondition(user, args, 't', params.musicFolderId);
    const r = await db().query(`
      select a.id, a.name,
             count(distinct t.id)::int as track_count,
             count(distinct nullif(t.album, ''))::int as album_count,
             min(t.id) filter (where t.art_path is not null) as art_track_id
        from artists a
        join track_artists ta on ta.artist_id = a.id
        join active_tracks t on t.id = ta.track_id
       where ${access} and a.name is not null and a.name <> ''
       group by a.id, a.name
       order by a.name
    `, args);
    sendResponse(reply, createResponse({
      artists: {
        ignoredArticles: 'The El La Los Las Le Les',
        index: groupByIndex(r.rows),
      },
    }), params.f, params.callback);
  });

  async function artistAlbums(user: SubsonicUser, artist: number, musicFolderId?: string) {
    const args: unknown[] = [artist];
    const access = trackAccessCondition(user, args, 't', musicFolderId);
    return db().query(`
      select t.album as name,
             coalesce(nullif(t.album_artist, ''), nullif(t.artist, ''), 'Unknown Artist') as artist,
             min(t.year) as year,
             count(*)::int as track_count,
             sum(t.duration_ms) as total_duration_ms,
             min(t.id) filter (where t.art_path is not null) as art_track_id,
             max(t.birthtime_ms) as max_birthtime_ms
        from active_tracks t
        join track_artists ta on ta.track_id = t.id
       where ta.artist_id = $1 and ${access} and t.album is not null and t.album <> ''
       group by t.album, coalesce(nullif(t.album_artist, ''), nullif(t.artist, ''), 'Unknown Artist')
       order by year desc nulls last, t.album
    `, args);
  }

  rest('getArtist', async (req, reply) => {
    const params = getParams(req);
    const id = params.id ? decodeArtistId(params.id) : null;
    if (id === null) return sendResponse(reply, createError(ERROR.MISSING_PARAM.code, 'Missing id parameter'), params.f, params.callback);

    const user = currentUser(req);
    const args: unknown[] = [id];
    const access = trackAccessCondition(user, args, 't', params.musicFolderId);
    const ar = await db().query(`
      select a.id, a.name, count(distinct t.album)::int as album_count,
             min(t.id) filter (where t.art_path is not null) as art_track_id
        from artists a
        join track_artists ta on ta.artist_id = a.id
        join active_tracks t on t.id = ta.track_id
       where a.id = $1 and ${access}
       group by a.id, a.name
    `, args);
    if (ar.rows.length === 0) return sendResponse(reply, createError(ERROR.NOT_FOUND.code, 'Artist not found'), params.f, params.callback);

    const albums = await artistAlbums(user, id, params.musicFolderId);
    sendResponse(reply, createResponse({
      artist: { ...formatArtist(ar.rows[0]), album: albums.rows.map(formatAlbum) },
    }), params.f, params.callback);
  });

  rest('getIndexes', async (req, reply) => {
    const params = getParams(req);
    const user = currentUser(req);
    const args: unknown[] = [];
    const access = trackAccessCondition(user, args, 't', params.musicFolderId);
    const r = await db().query(`
      select a.id, a.name,
             count(distinct nullif(t.album, ''))::int as album_count,
             min(t.id) filter (where t.art_path is not null) as art_track_id
        from artists a
        join track_artists ta on ta.artist_id = a.id
        join active_tracks t on t.id = ta.track_id
       where ${access} and a.name is not null and a.name <> ''
       group by a.id, a.name
       order by a.name
    `, args);
    sendResponse(reply, createResponse({
      indexes: {
        lastModified: Date.now(),
        ignoredArticles: 'The El La Los Las Le Les',
        index: groupByIndex(r.rows),
        child: [],
      },
    }), params.f, params.callback);
  });

  rest('getMusicDirectory', async (req, reply) => {
    const params = getParams(req);
    const id = params.id;
    if (!id) return sendResponse(reply, createError(ERROR.MISSING_PARAM.code, 'Missing id parameter'), params.f, params.callback);

    const user = currentUser(req);
    const libraryId = decodeLibraryDirectoryId(id);
    if (id === 'root' || id === '1' || id.startsWith('lib-') || libraryId !== null) {
      const folder = id.startsWith('lib-') ? id : params.musicFolderId;
      const args: unknown[] = [];
      const access = trackAccessCondition(user, args, 't', folder);
      const r = await db().query(`
        select a.id, a.name,
               count(distinct nullif(t.album, ''))::int as album_count,
               min(t.id) filter (where t.art_path is not null) as art_track_id
          from artists a
          join track_artists ta on ta.artist_id = a.id
          join active_tracks t on t.id = ta.track_id
         where ${access} and a.name is not null and a.name <> ''
         group by a.id, a.name
         order by a.name
      `, args);
      sendResponse(reply, createResponse({
        directory: {
          id,
          name: 'Music',
          child: r.rows.map((a) => ({ ...formatArtist(a), parent: id, isDir: true, title: a.name })),
        },
      }), params.f, params.callback);
      return;
    }

    const arId = decodeArtistId(id);
    if (arId !== null) {
      const albums = await artistAlbums(user, arId, params.musicFolderId);
      sendResponse(reply, createResponse({
        directory: {
          id,
          name: albums.rows[0]?.artist || 'Artist',
          child: albums.rows.map((a) => ({
            ...formatAlbum(a),
            id: albumId(a.name),
            parent: id,
            isDir: true,
            title: a.name,
          })),
        },
      }), params.f, params.callback);
      return;
    }

    if (id.startsWith('al-')) {
      const albumName = decodeAlbumId(id);
      const args: unknown[] = [albumName, user.userId];
      const access = trackAccessCondition(user, args, 't', params.musicFolderId);
      const songs = await db().query(`
        select t.*, f.added_at as starred_at
          from active_tracks t
          left join favorite_tracks f on f.track_id = t.id and f.user_id = $2
         where t.album = $1 and ${access}
         order by t.disc_number nulls last, t.track_number nulls last, t.title
      `, args);
      sendResponse(reply, createResponse({
        directory: { id, name: albumName, child: songs.rows.map(formatSong) },
      }), params.f, params.callback);
      return;
    }

    sendResponse(reply, createError(ERROR.NOT_FOUND.code, 'Directory not found'), params.f, params.callback);
  });

  rest('getTopSongs', async (req, reply) => {
    const params = getParams(req);
    const user = currentUser(req);
    const count = parseCount(params.count ?? params.size, 50);
    const artistName = params.artist;
    const artistIdRaw = params.artistId;
    if (!artistName && !artistIdRaw) {
      return sendResponse(reply, createError(ERROR.MISSING_PARAM.code, 'Missing artist/artistId parameter'), params.f, params.callback);
    }

    const args: unknown[] = [user.userId];
    const access = trackAccessCondition(user, args, 't', params.musicFolderId);
    let r;
    if (artistIdRaw) {
      const arId = decodeArtistId(artistIdRaw);
      if (arId === null) return sendResponse(reply, createError(ERROR.MISSING_PARAM.code, 'Invalid artistId parameter'), params.f, params.callback);
      args.push(arId, count);
      r = await db().query(`
        select t.*, f.added_at as starred_at
          from active_tracks t
          join track_artists ta on ta.track_id = t.id
          left join favorite_tracks f on f.track_id = t.id and f.user_id = $1
         where ${access} and ta.artist_id = $${args.length - 1}
         order by t.id desc
         limit $${args.length}
      `, args);
    } else {
      args.push(artistName, count);
      r = await db().query(`
        select t.*, f.added_at as starred_at
          from active_tracks t
          left join favorite_tracks f on f.track_id = t.id and f.user_id = $1
         where ${access} and lower(t.artist) = lower($${args.length - 1})
         order by t.id desc
         limit $${args.length}
      `, args);
    }

    sendResponse(reply, createResponse({ topSongs: { song: r.rows.map(formatSong) } }), params.f, params.callback);
  });

  rest('getAlbum', async (req, reply) => {
    const params = getParams(req);
    if (!params.id) return sendResponse(reply, createError(ERROR.MISSING_PARAM.code, 'Missing id parameter'), params.f, params.callback);
    const user = currentUser(req);
    const albumName = decodeAlbumId(params.id);
    const args: unknown[] = [albumName, user.userId];
    const access = trackAccessCondition(user, args, 't', params.musicFolderId);
    const tracks = await db().query(`
      select t.*, f.added_at as starred_at
        from active_tracks t
        left join favorite_tracks f on f.track_id = t.id and f.user_id = $2
       where t.album = $1 and ${access}
       order by t.disc_number nulls last, t.track_number nulls last, t.title
    `, args);
    if (tracks.rows.length === 0) return sendResponse(reply, createError(ERROR.NOT_FOUND.code, 'Album not found'), params.f, params.callback);

    const first = tracks.rows[0];
    const album = formatAlbum({
      id: albumId(albumName),
      name: albumName,
      artist: first.album_artist || first.artist,
      art_track_id: tracks.rows.find((t) => t.art_path)?.id,
      track_count: tracks.rows.length,
      total_duration_ms: tracks.rows.reduce((sum: number, t: any) => sum + Number(t.duration_ms || 0), 0),
      year: first.year,
      genre: first.genre,
      max_birthtime_ms: Math.max(...tracks.rows.map((t: any) => Number(t.birthtime_ms || 0))),
    });
    sendResponse(reply, createResponse({ album: { ...album, song: tracks.rows.map(formatSong) } }), params.f, params.callback);
  });

  rest('getSong', async (req, reply) => {
    const params = getParams(req);
    if (!params.id) return sendResponse(reply, createError(ERROR.MISSING_PARAM.code, 'Missing id parameter'), params.f, params.callback);
    const user = currentUser(req);
    const args: unknown[] = [Number(params.id), user.userId];
    const access = trackAccessCondition(user, args, 't', params.musicFolderId);
    const r = await db().query(`
      select t.*, f.added_at as starred_at
        from active_tracks t
        left join favorite_tracks f on f.track_id = t.id and f.user_id = $2
       where t.id = $1 and ${access}
    `, args);
    if (r.rows.length === 0) return sendResponse(reply, createError(ERROR.NOT_FOUND.code, 'Song not found'), params.f, params.callback);
    sendResponse(reply, createResponse({ song: formatSong(r.rows[0]) }), params.f, params.callback);
  });

  async function sendAlbumList(req: FastifyRequest, reply: FastifyReply, responseKey: 'albumList' | 'albumList2') {
    const params = getParams(req);
    const user = currentUser(req);
    const type = params.type || 'alphabeticalByName';
    const size = parseCount(params.size, 10);
    const offset = parseOffset(params.offset);

    const args: unknown[] = [user.userId];
    const access = trackAccessCondition(user, args, 't', params.musicFolderId);
    const conditions = [`${access}`, "t.album is not null", "t.album <> ''"];

    if (type === 'byGenre' && params.genre?.trim()) {
      args.push(params.genre.trim());
      conditions.push(`exists (select 1 from unnest(string_to_array(t.genre, ';')) as g where trim(g) ilike $${args.length})`);
    }
    if (type === 'byYear') {
      const fromYear = Number(params.fromYear);
      const toYear = Number(params.toYear);
      if (Number.isFinite(fromYear) && Number.isFinite(toYear)) {
        args.push(Math.min(fromYear, toYear), Math.max(fromYear, toYear));
        conditions.push(`t.year between $${args.length - 1} and $${args.length}`);
      }
    }
    if (type === 'starred') {
      conditions.push('exists (select 1 from favorite_tracks sf where sf.track_id = t.id and sf.user_id = $1)');
    }

    const limitParam = args.push(size);
    const offsetParam = args.push(offset);
    const orderBy = (() => {
      switch (type) {
        case 'random': return 'random()';
        case 'newest': return 'ac.max_birthtime_ms desc nulls last';
        case 'recent': return 'ac.last_played_at desc nulls last, ua.album';
        case 'frequent':
        case 'highest': return 'ac.play_count desc nulls last, ua.album';
        case 'starred': return 'ac.starred_at desc nulls last, ua.album';
        case 'byYear': return 'ua.year desc nulls last, ua.album';
        case 'alphabeticalByArtist': return 'display_artist, ua.album';
        default: return 'ua.album';
      }
    })();

    const r = await db().query(`
      with filtered as (
        select * from active_tracks t where ${conditions.join(' and ')}
      ),
      unique_albums as (
        select distinct on (t.album)
               t.album, t.id as first_track_id, t.year, t.updated_at
          from filtered t
         order by t.album, t.path
      ),
      album_counts as (
        select t.album,
               count(*)::int as track_count,
               sum(t.duration_ms) as total_duration_ms,
               max(t.birthtime_ms) as max_birthtime_ms,
               coalesce(sum(uts.play_count), 0)::int as play_count,
               max(uts.last_played_at) as last_played_at,
               max(f.added_at) as starred_at,
               min(t.id) filter (where t.art_path is not null) as art_track_id,
               max(coalesce(nullif(t.album_artist, ''), nullif(t.artist, ''), 'Unknown Artist')) as display_artist
          from filtered t
          left join user_track_stats uts on uts.track_id = t.id and uts.user_id = $1
          left join favorite_tracks f on f.track_id = t.id and f.user_id = $1
         group by t.album
      )
      select ua.album as name, ac.display_artist, ac.track_count, ac.total_duration_ms,
             ac.art_track_id, ua.year, ac.max_birthtime_ms, ac.play_count, ac.starred_at
        from unique_albums ua
        join album_counts ac on ac.album = ua.album
       order by ${orderBy}
       limit $${limitParam} offset $${offsetParam}
    `, args);

    sendResponse(reply, createResponse({ [responseKey]: { album: r.rows.map(formatAlbum) } }), params.f, params.callback);
  }

  rest('getAlbumList', (req, reply) => sendAlbumList(req, reply, 'albumList'));
  rest('getAlbumList2', (req, reply) => sendAlbumList(req, reply, 'albumList2'));
  rest('getAlbumListID3', (req, reply) => sendAlbumList(req, reply, 'albumList2'));

  rest('getRandomSongs', async (req, reply) => {
    const params = getParams(req);
    const user = currentUser(req);
    const size = parseCount(params.size, 10);
    const args: unknown[] = [user.userId];
    const access = trackAccessCondition(user, args, 't', params.musicFolderId);
    args.push(size);
    const r = await db().query(`
      select t.*, f.added_at as starred_at
        from active_tracks t
        left join favorite_tracks f on f.track_id = t.id and f.user_id = $1
       where ${access}
       order by random()
       limit $${args.length}
    `, args);
    sendResponse(reply, createResponse({ randomSongs: { song: r.rows.map(formatSong) } }), params.f, params.callback);
  });

  async function sendSongList(req: FastifyRequest, reply: FastifyReply, responseKey: string, mode: 'newest' | 'last' | 'most' | 'top') {
    const params = getParams(req);
    const user = currentUser(req);
    const size = parseCount(params.size ?? params.count, 10);
    const offset = parseOffset(params.offset);
    const args: unknown[] = [user.userId];
    const access = trackAccessCondition(user, args, 't', params.musicFolderId);

    let sql: string;
    if (mode === 'last') {
      const limitParam = args.push(size);
      const offsetParam = args.push(offset);
      sql = `
        select t.*, f.added_at as starred_at
          from user_track_stats s
          join active_tracks t on t.id = s.track_id
          left join favorite_tracks f on f.track_id = t.id and f.user_id = $1
         where s.user_id = $1 and s.last_played_at is not null and ${access}
         order by s.last_played_at desc
         limit $${limitParam} offset $${offsetParam}`;
    } else if (mode === 'most') {
      const limitParam = args.push(size);
      const offsetParam = args.push(offset);
      sql = `
        select t.*, f.added_at as starred_at
          from user_track_stats s
          join active_tracks t on t.id = s.track_id
          left join favorite_tracks f on f.track_id = t.id and f.user_id = $1
         where s.user_id = $1 and s.play_count > 0 and ${access}
         order by s.play_count desc, s.last_played_at desc nulls last
         limit $${limitParam} offset $${offsetParam}`;
    } else if (mode === 'top') {
      const limitParam = args.push(size);
      const offsetParam = args.push(offset);
      sql = `
        select t.*, f.added_at as starred_at
          from active_tracks t
          left join favorite_tracks f on f.track_id = t.id and f.user_id = $1
          left join (
            select track_id, sum(play_count)::int as play_count, max(last_played_at) as last_played_at
              from user_track_stats
             group by track_id
          ) s on s.track_id = t.id
         where ${access}
         order by coalesce(s.play_count, 0) desc, s.last_played_at desc nulls last, t.id desc
         limit $${limitParam} offset $${offsetParam}`;
    } else {
      const limitParam = args.push(size);
      const offsetParam = args.push(offset);
      sql = `
        select t.*, f.added_at as starred_at
          from active_tracks t
          left join favorite_tracks f on f.track_id = t.id and f.user_id = $1
         where ${access}
         order by t.birthtime_ms desc nulls last, t.created_at desc
         limit $${limitParam} offset $${offsetParam}`;
    }

    const r = await db().query(sql, args);
    sendResponse(reply, createResponse({ [responseKey]: { song: r.rows.map(formatSong) } }), params.f, params.callback);
  }

  rest('getNewaddedSongs', (req, reply) => sendSongList(req, reply, 'newaddedSongs', 'newest'));
  rest('getLastplayedSongs', (req, reply) => sendSongList(req, reply, 'lastplayedSongs', 'last'));
  rest('getMostplayedSongs', (req, reply) => sendSongList(req, reply, 'mostplayedSongs', 'most'));
  rest('getTopplayedSongs', (req, reply) => sendSongList(req, reply, 'topplayedSongs', 'top'));

  rest('getSongsByGenre', async (req, reply) => {
    const params = getParams(req);
    if (!params.genre) return sendResponse(reply, createError(ERROR.MISSING_PARAM.code, 'Missing genre parameter'), params.f, params.callback);
    const user = currentUser(req);
    const count = Math.min(Math.max(Number(params.count ?? 10), 1), 500);
    const offset = Math.max(Number(params.offset ?? 0), 0);
    const args: unknown[] = [params.genre, user.userId];
    const access = trackAccessCondition(user, args, 't', params.musicFolderId);
    args.push(count, offset);
    const r = await db().query(`
      select t.*, f.added_at as starred_at
        from active_tracks t
        left join favorite_tracks f on f.track_id = t.id and f.user_id = $2
       where ${access}
         and exists (select 1 from unnest(string_to_array(t.genre, ';')) as g where trim(g) ilike $1)
       order by t.artist nulls last, t.album nulls last, t.track_number nulls last, t.title
       limit $${args.length - 1} offset $${args.length}
    `, args);
    sendResponse(reply, createResponse({ songsByGenre: { song: r.rows.map(formatSong) } }), params.f, params.callback);
  });

  async function sendSearch(req: FastifyRequest, reply: FastifyReply, responseKey: 'searchResult2' | 'searchResult3') {
    const params = getParams(req);
    const user = currentUser(req);
    // Symfonium and some other clients send literal `""` to mean "match everything".
    // Treat that, plain empty, and `*` / `%` wildcards as "no filter".
    let rawQuery = (params.query ?? '').trim();
    if (rawQuery.startsWith('"') && rawQuery.endsWith('"') && rawQuery.length >= 2) {
      rawQuery = rawQuery.slice(1, -1);
    }
    const matchAll = rawQuery === '' || rawQuery === '*' || rawQuery === '%';
    const pattern = `%${rawQuery}%`;
    // Subsonic spec allows up to 500 per category; Symfonium uses 500 during sync.
    const artistCount = Math.min(Math.max(Number(params.artistCount ?? 20) | 0, 0), 500);
    const albumCount = Math.min(Math.max(Number(params.albumCount ?? 20) | 0, 0), 500);
    const songCount = Math.min(Math.max(Number(params.songCount ?? 20) | 0, 0), 500);
    const artistOffset = Math.max(Number(params.artistOffset ?? 0) | 0, 0);
    const albumOffset = Math.max(Number(params.albumOffset ?? 0) | 0, 0);
    const songOffset = Math.max(Number(params.songOffset ?? 0) | 0, 0);

    let artists: { rows: any[] } = { rows: [] };
    if (artistCount > 0) {
      const args: unknown[] = matchAll ? [] : [pattern];
      const access = trackAccessCondition(user, args, 't', params.musicFolderId);
      const filter = matchAll ? '' : 'and a.name ilike $1';
      artists = await db().query(`
        select a.id, a.name,
               count(distinct t.album)::int as album_count,
               min(t.id) filter (where t.art_path is not null) as art_track_id
          from artists a
          join track_artists ta on ta.artist_id = a.id
          join active_tracks t on t.id = ta.track_id
         where ${access} and a.name is not null and a.name <> '' ${filter}
         group by a.id, a.name
         order by a.name
         limit ${artistCount} offset ${artistOffset}
      `, args);
    }

    let albums: { rows: any[] } = { rows: [] };
    if (albumCount > 0) {
      const args: unknown[] = matchAll ? [] : [pattern];
      const access = trackAccessCondition(user, args, 't', params.musicFolderId);
      const filter = matchAll ? '' : 'and t.album ilike $1';
      albums = await db().query(`
        select t.album as name,
               max(coalesce(nullif(t.album_artist, ''), nullif(t.artist, ''), 'Unknown Artist')) as artist,
               min(t.year) as year,
               count(*)::int as track_count,
               sum(t.duration_ms) as total_duration_ms,
               min(t.id) filter (where t.art_path is not null) as art_track_id
          from active_tracks t
         where ${access} and t.album is not null and t.album <> '' ${filter}
         group by t.album
         order by t.album
         limit ${albumCount} offset ${albumOffset}
      `, args);
    }

    let songs: { rows: any[] } = { rows: [] };
    if (songCount > 0) {
      const args: unknown[] = matchAll ? [user.userId] : [user.userId, pattern];
      const access = trackAccessCondition(user, args, 't', params.musicFolderId);
      const filter = matchAll ? '' : 'and (t.title ilike $2 or t.artist ilike $2 or t.album ilike $2)';
      songs = await db().query(`
        select t.*, f.added_at as starred_at
          from active_tracks t
          left join favorite_tracks f on f.track_id = t.id and f.user_id = $1
         where ${access} ${filter}
         order by t.title
         limit ${songCount} offset ${songOffset}
      `, args);
    }

    sendResponse(reply, createResponse({
      [responseKey]: {
        artist: artists.rows.map(formatArtist),
        album: albums.rows.map(formatAlbum),
        song: songs.rows.map(formatSong),
      },
    }), params.f, params.callback);
  }

  rest('search2', (req, reply) => sendSearch(req, reply, 'searchResult2'));
  rest('search3', (req, reply) => sendSearch(req, reply, 'searchResult3'));
  rest('searchID3', (req, reply) => sendSearch(req, reply, 'searchResult3'));

  rest('search', async (req, reply) => {
    const params = getParams(req);
    const user = currentUser(req);
    const query = params.any || params.query || params.title || params.artist || params.album || '';
    const pattern = `%${query}%`;
    const count = parseCount(params.songCount ?? params.count, 20, 100);
    const offset = parseOffset(params.offset);
    const args: unknown[] = [user.userId, pattern];
    const access = trackAccessCondition(user, args, 't', params.musicFolderId);
    const limitParam = args.push(count);
    const offsetParam = args.push(offset);
    const r = await db().query(`
      select t.*, f.added_at as starred_at
        from active_tracks t
        left join favorite_tracks f on f.track_id = t.id and f.user_id = $1
       where ${access}
         and (t.title ilike $2 or t.artist ilike $2 or t.album ilike $2)
       order by t.title
       limit $${limitParam} offset $${offsetParam}
    `, args);
    sendResponse(reply, createResponse({ searchResult: { match: r.rows.map(formatSong) } }), params.f, params.callback);
  });

  async function streamTrack(req: FastifyRequest, reply: FastifyReply) {
    const params = getParams(req);
    if (!params.id) return sendResponse(reply, createError(ERROR.MISSING_PARAM.code, 'Missing id parameter'), params.f, params.callback);
    const user = currentUser(req);
    const podcastId = params.id.startsWith('pod-') ? decodePrefixedNumber(params.id, 'pod-') : null;
    if (podcastId !== null) {
      const r = await db().query<{ audio_url: string; audio_type: string | null; downloaded_path: string | null }>(
        `select e.audio_url, e.audio_type, e.downloaded_path
           from podcast_episodes e
           join user_podcast_subscriptions ups on ups.podcast_id = e.podcast_id and ups.user_id = $1
          where e.id = $2`,
        [user.userId, podcastId]
      );
      const episode = r.rows[0];
      if (!episode) return reply.code(404).send();
      if (episode.downloaded_path && existsSync(episode.downloaded_path)) {
        const st = await stat(episode.downloaded_path);
        reply.header('Content-Length', String(st.size))
          .header('Accept-Ranges', 'bytes')
          .header('Content-Type', episode.audio_type || mimeFromExt(path.extname(episode.downloaded_path)));
        return reply.send(createReadStream(episode.downloaded_path));
      }
      return reply.redirect(episode.audio_url, 302);
    }

    const args: unknown[] = [Number(params.id)];
    const access = trackAccessCondition(user, args, 't', params.musicFolderId);
    const r = await db().query<{ path: string; ext: string; library_id: number; mount_path: string }>(
      `select t.path, t.ext, t.library_id, l.mount_path
         from active_tracks t
         join libraries l on l.id = t.library_id
        where t.id = $1 and ${access}`,
      args
    );
    const row = r.rows[0];
    if (!row) return reply.code(404).send();

    const abs = safeJoin(row.mount_path, row.path);
    const st = await stat(abs);
    const range = req.headers.range;
    const contentType = mimeFromExt(row.ext);

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

  rest('stream', streamTrack);
  rest('download', streamTrack);

  rest('getCoverArt', async (req, reply) => {
    const params = getParams(req);
    if (!params.id) return sendResponse(reply, createError(ERROR.MISSING_PARAM.code, 'Missing id parameter'), params.f, params.callback);
    const user = currentUser(req);

    if (params.id.startsWith('pc-') || params.id.startsWith('pe-')) {
      const isEpisode = params.id.startsWith('pe-');
      const itemId = decodePrefixedNumber(params.id, isEpisode ? 'pe-' : 'pc-');
      if (itemId === null) return reply.code(404).send();
      const art = isEpisode
        ? await db().query<{ image_path: string | null; image_url: string | null }>(
          `select coalesce(e.image_path, p.image_path) as image_path,
                  coalesce(e.image_url, p.image_url) as image_url
             from podcast_episodes e
             join podcasts p on p.id = e.podcast_id
             join user_podcast_subscriptions ups on ups.podcast_id = p.id and ups.user_id = $1
            where e.id = $2`,
          [user.userId, itemId]
        )
        : await db().query<{ image_path: string | null; image_url: string | null }>(
          `select p.image_path, p.image_url
             from podcasts p
             join user_podcast_subscriptions ups on ups.podcast_id = p.id and ups.user_id = $1
            where p.id = $2`,
          [user.userId, itemId]
        );
      const row = art.rows[0];
      if (row?.image_path) {
        try {
          const abs = safeJoin(PODCAST_ART_DIR, row.image_path);
          const st = await stat(abs);
          reply.header('Content-Type', imageMimeFromPath(row.image_path))
            .header('Content-Length', String(st.size))
            .header('Cache-Control', 'public, max-age=86400');
          return reply.send(createReadStream(abs));
        } catch {
          // fall back to upstream image URL
        }
      }
      if (row?.image_url) return reply.redirect(row.image_url, 302);
      return reply.code(404).send();
    }

    let trackId = params.id;

    if (params.id.startsWith('al-')) {
      const albumName = decodeAlbumId(params.id);
      const args: unknown[] = [albumName];
      const access = trackAccessCondition(user, args, 't', params.musicFolderId);
      const r = await db().query<{ id: number }>(
        `select t.id from active_tracks t where t.album = $1 and ${access} and t.art_path is not null limit 1`,
        args
      );
      if (r.rows[0]) trackId = String(r.rows[0].id);
    } else if (params.id.startsWith('ar-')) {
      const arId = decodeArtistId(params.id);
      if (arId !== null) {
        const args: unknown[] = [arId];
        const access = trackAccessCondition(user, args, 't', params.musicFolderId);
        const r = await db().query<{ id: number }>(
          `select t.id
             from active_tracks t
             join track_artists ta on ta.track_id = t.id
            where ta.artist_id = $1 and ${access} and t.art_path is not null
            limit 1`,
          args
        );
        if (r.rows[0]) trackId = String(r.rows[0].id);
      }
    }

    const args: unknown[] = [Number(trackId)];
    const access = trackAccessCondition(user, args, 't', params.musicFolderId);
    const art = await db().query<{ art_path: string | null; art_mime: string | null }>(
      `select t.art_path, t.art_mime from active_tracks t where t.id = $1 and ${access}`,
      args
    );
    const row = art.rows[0];
    if (!row?.art_path) return reply.code(404).send();

    try {
      const abs = safeJoin(ART_DIR, row.art_path);
      const st = await stat(abs);
      reply.header('Content-Type', row.art_mime || imageMimeFromPath(row.art_path))
        .header('Content-Length', String(st.size))
        .header('Cache-Control', 'public, max-age=86400');
      return reply.send(createReadStream(abs));
    } catch {
      return reply.code(404).send();
    }
  });

  rest('getAvatar', async (req, reply) => {
    const params = getParams(req);
    const username = normalizeEmail(params.username || currentUser(req).username);
    const r = await db().query<{ avatar_path: string | null }>('select avatar_path from users where email=$1', [username]);
    const row = r.rows[0];
    if (!row?.avatar_path) return reply.code(404).send();
    try {
      const abs = safeJoin(AVATARS_DIR, row.avatar_path);
      if (!existsSync(abs)) return reply.code(404).send();
      const st = await stat(abs);
      reply.header('Content-Type', imageMimeFromPath(row.avatar_path))
        .header('Content-Length', String(st.size))
        .header('Cache-Control', 'public, max-age=86400');
      return reply.send(createReadStream(abs));
    } catch {
      return reply.code(404).send();
    }
  });

  rest('getLyrics', async (req, reply) => {
    const params = getParams(req);
    const artist = params.artist;
    const title = params.title;
    if (!artist || !title) {
      sendResponse(reply, createResponse({ lyrics: { artist: artist ?? '', title: title ?? '', value: '' } }), params.f, params.callback);
      return;
    }
    const user = currentUser(req);
    const args: unknown[] = [artist, title];
    const access = trackAccessCondition(user, args, 't', params.musicFolderId);
    const r = await db().query<{ id: number }>(
      `select t.id from active_tracks t
        where lower(t.artist)=lower($1) and lower(t.title)=lower($2) and ${access}
        order by t.id asc limit 1`,
      args
    );
    const trackId = r.rows[0]?.id;
    if (!trackId) {
      sendResponse(reply, createResponse({ lyrics: { artist, title, value: '' } }), params.f, params.callback);
      return;
    }
    const lyrics = await readTrackLyrics(Number(trackId), user);
    sendResponse(reply, createResponse({ lyrics: { artist, title, value: lyrics?.text ?? '' } }), params.f, params.callback);
  });

  rest('getLyricsBySongId', async (req, reply) => {
    const params = getParams(req);
    if (!params.id) return sendResponse(reply, createError(ERROR.MISSING_PARAM.code, 'Missing id parameter'), params.f, params.callback);
    const lyrics = await readTrackLyrics(Number(params.id), currentUser(req));
    if (!lyrics || !lyrics.text.trim()) {
      sendResponse(reply, createResponse({ lyricsList: { structuredLyrics: [] } }), params.f, params.callback);
      return;
    }
    const parsed = parseLyricsLines(lyrics.text);
    sendResponse(reply, createResponse({
      lyricsList: {
        structuredLyrics: [{
          lang: lyrics.row.language || 'und',
          synced: lyrics.synced || parsed.synced,
          line: parsed.lines,
        }],
      },
    }), params.f, params.callback);
  });

  rest('getNowPlaying', async (req, reply) => {
    const params = getParams(req);
    const user = currentUser(req);
    let entries: unknown[] = [];
    try {
      const keys = await redis().keys('subsonic:nowPlaying:*');
      const vals = keys.length ? await redis().mget(keys) : [];
      const parsed = vals
        .map((v) => {
          try { return v ? JSON.parse(v) as { trackId: string; username: string; at: number } : null; }
          catch { return null; }
        })
        .filter(Boolean) as { trackId: string; username: string; at: number }[];

      const ids = parsed.map((p) => Number(p.trackId)).filter(Number.isFinite);
      if (ids.length) {
        const args: unknown[] = [ids];
        const access = trackAccessCondition(user, args, 't', params.musicFolderId);
        const tracks = await db().query(`select t.* from active_tracks t where t.id = any($1::bigint[]) and ${access}`, args);
        const byId = new Map<number, any>(tracks.rows.map((t: any) => [Number(t.id), t]));
        entries = parsed
          .map((p) => {
            const t = byId.get(Number(p.trackId));
            if (!t) return null;
            return { ...formatSong(t), username: p.username, minutesAgo: Math.max(0, Math.floor((Date.now() - p.at) / 60000)), playerId: 0 };
          })
          .filter(Boolean);
      }
    } catch {
      // ignore now-playing cache failures
    }
    sendResponse(reply, createResponse({ nowPlaying: { entry: entries } }), params.f, params.callback);
  });

  rest('getAlbumInfo', async (req, reply) => {
    const params = getParams(req);
    sendResponse(reply, createResponse({ albumInfo: { notes: '', musicBrainzId: '', smallImageUrl: '', mediumImageUrl: '', largeImageUrl: '' } }), params.f, params.callback);
  });
  rest('getAlbumInfo2', async (req, reply) => {
    const params = getParams(req);
    sendResponse(reply, createResponse({ albumInfo: { notes: '', musicBrainzId: '', smallImageUrl: '', mediumImageUrl: '', largeImageUrl: '' } }), params.f, params.callback);
  });
  rest('getArtistInfo', async (req, reply) => {
    const params = getParams(req);
    sendResponse(reply, createResponse({ artistInfo: { biography: '', musicBrainzId: '', smallImageUrl: '', mediumImageUrl: '', largeImageUrl: '' } }), params.f, params.callback);
  });
  rest('getArtistInfo2', async (req, reply) => {
    const params = getParams(req);
    sendResponse(reply, createResponse({ artistInfo2: { biography: '', musicBrainzId: '', smallImageUrl: '', mediumImageUrl: '', largeImageUrl: '' } }), params.f, params.callback);
  });
  rest('getArtistInfoID3', async (req, reply) => {
    const params = getParams(req);
    sendResponse(reply, createResponse({ artistInfo2: { biography: '', musicBrainzId: '', smallImageUrl: '', mediumImageUrl: '', largeImageUrl: '' } }), params.f, params.callback);
  });

  rest('getPodcasts', async (req, reply) => {
    const params = getParams(req);
    const user = currentUser(req);
    const requestedId = decodePrefixedNumber(params.id, 'pc-');
    const includeEpisodes = params.includeEpisodes !== 'false';
    const channelArgs: unknown[] = [user.userId];
    let channelWhere = '';
    if (requestedId !== null) {
      channelArgs.push(requestedId);
      channelWhere = `and p.id = $${channelArgs.length}`;
    }
    const channels = await db().query(
      `select p.*
         from podcasts p
         join user_podcast_subscriptions ups on ups.podcast_id = p.id and ups.user_id = $1
        where true ${channelWhere}
        order by p.title`,
      channelArgs
    );

    let episodesByPodcast = new Map<number, any[]>();
    if (includeEpisodes && channels.rows.length) {
      const ids = channels.rows.map((c: any) => Number(c.id));
      const episodes = await db().query(
        `select e.*, p.title as podcast_title, p.image_path as podcast_image_path, p.image_url as podcast_image_url,
                uep.position_ms
           from podcast_episodes e
           join podcasts p on p.id = e.podcast_id
           left join user_episode_progress uep on uep.episode_id = e.id and uep.user_id = $1
          where e.podcast_id = any($2::bigint[])
          order by e.podcast_id, e.published_at desc nulls last, e.created_at desc`,
        [user.userId, ids]
      );
      episodesByPodcast = episodes.rows.reduce((map, row: any) => {
        const key = Number(row.podcast_id);
        const list = map.get(key) || [];
        list.push(row);
        map.set(key, list);
        return map;
      }, new Map<number, any[]>());
    }

    sendResponse(reply, createResponse({
      podcasts: {
        channel: channels.rows.map((channel: any) => formatPodcastChannel(channel, includeEpisodes ? episodesByPodcast.get(Number(channel.id)) || [] : undefined)),
      },
    }), params.f, params.callback);
  });

  rest('getNewestPodcasts', async (req, reply) => {
    const params = getParams(req);
    const user = currentUser(req);
    const count = parseCount(params.count, 20);
    const r = await db().query(
      `select e.*, p.title as podcast_title, p.image_path as podcast_image_path, p.image_url as podcast_image_url,
              uep.position_ms
         from podcast_episodes e
         join podcasts p on p.id = e.podcast_id
         join user_podcast_subscriptions ups on ups.podcast_id = p.id and ups.user_id = $1
         left join user_episode_progress uep on uep.episode_id = e.id and uep.user_id = $1
        order by e.published_at desc nulls last, e.created_at desc
        limit $2`,
      [user.userId, count]
    );
    sendResponse(reply, createResponse({ newestPodcasts: { episode: r.rows.map(formatPodcastEpisode) } }), params.f, params.callback);
  });

  rest('refreshPodcasts', async (req, reply) => {
    const params = getParams(req);
    sendResponse(reply, createResponse(), params.f, params.callback);
  });

  rest('createPodcastChannel', async (req, reply) => {
    const params = getParams(req);
    const user = currentUser(req);
    if (!params.url) return sendResponse(reply, createError(ERROR.MISSING_PARAM.code, 'Missing url parameter'), params.f, params.callback);
    const r = await db().query<{ id: number }>(
      `insert into podcasts (feed_url, title, last_fetched_at)
       values ($1, $1, now())
       on conflict (feed_url) do update set updated_at = now()
       returning id`,
      [params.url]
    );
    await db().query(
      'insert into user_podcast_subscriptions (user_id, podcast_id) values ($1, $2) on conflict do nothing',
      [user.userId, r.rows[0].id]
    );
    sendResponse(reply, createResponse(), params.f, params.callback);
  });

  rest('deletePodcastChannel', async (req, reply) => {
    const params = getParams(req);
    const user = currentUser(req);
    const id = decodePrefixedNumber(params.id, 'pc-');
    if (id === null) return sendResponse(reply, createError(ERROR.MISSING_PARAM.code, 'Missing id parameter'), params.f, params.callback);
    await db().query('delete from user_podcast_subscriptions where user_id=$1 and podcast_id=$2', [user.userId, id]);
    sendResponse(reply, createResponse(), params.f, params.callback);
  });

  rest('downloadPodcastEpisode', async (req, reply) => {
    const params = getParams(req);
    sendResponse(reply, createResponse(), params.f, params.callback);
  });

  rest('deletePodcastEpisode', async (req, reply) => {
    const params = getParams(req);
    sendResponse(reply, createResponse(), params.f, params.callback);
  });

  async function resolveTrackIds(params: SubsonicParams, user: SubsonicUser) {
    const ids = new Set<number>();
    if (params.id && Number.isFinite(Number(params.id))) ids.add(Number(params.id));

    const albumIdRaw = params.albumId;
    if (albumIdRaw) {
      const albumName = decodeAlbumId(albumIdRaw);
      const args: unknown[] = [albumName];
      const access = trackAccessCondition(user, args, 't', params.musicFolderId);
      const r = await db().query<{ id: number }>(`select t.id from active_tracks t where t.album=$1 and ${access}`, args);
      for (const row of r.rows) ids.add(Number(row.id));
    }

    const artistIdRaw = params.artistId;
    if (artistIdRaw) {
      const arId = decodeArtistId(artistIdRaw);
      if (arId !== null) {
        const args: unknown[] = [arId];
        const access = trackAccessCondition(user, args, 't', params.musicFolderId);
        const r = await db().query<{ id: number }>(
          `select t.id from active_tracks t join track_artists ta on ta.track_id=t.id where ta.artist_id=$1 and ${access}`,
          args
        );
        for (const row of r.rows) ids.add(Number(row.id));
      }
    }

    if (ids.size === 0) return [];
    const args: unknown[] = [Array.from(ids)];
    const access = trackAccessCondition(user, args, 't', params.musicFolderId);
    const allowed = await db().query<{ id: number }>(
      `select t.id from active_tracks t where t.id = any($1::bigint[]) and ${access}`,
      args
    );
    return allowed.rows.map((r) => Number(r.id));
  }

  rest('setRating', async (req, reply) => {
    const params = getParams(req);
    if (!params.id) return sendResponse(reply, createError(ERROR.MISSING_PARAM.code, 'Missing id parameter'), params.f, params.callback);
    sendResponse(reply, createResponse(), params.f, params.callback);
  });

  rest('getBookmarks', async (req, reply) => {
    const params = getParams(req);
    const user = currentUser(req);

    const trackArgs: unknown[] = [user.userId];
    const access = trackAccessCondition(user, trackArgs, 't', params.musicFolderId);
    const trackBookmarks = await db().query(`
      select b.position_ms, b.comment, b.created_at as bookmark_created_at, b.changed_at,
             t.*, f.added_at as starred_at
        from subsonic_bookmarks b
        join active_tracks t on t.id = b.item_id::bigint
        left join favorite_tracks f on f.track_id = t.id and f.user_id = $1
       where b.user_id = $1 and b.item_type = 'track' and b.item_id ~ '^[0-9]+$' and ${access}
       order by b.changed_at desc
    `, trackArgs);

    const podcastBookmarks = await db().query(`
      select b.position_ms, b.comment, b.created_at as bookmark_created_at, b.changed_at,
             e.*, p.title as podcast_title, p.image_path as podcast_image_path, p.image_url as podcast_image_url
        from subsonic_bookmarks b
        join podcast_episodes e on b.item_id = concat('pod-', e.id::text)
        join podcasts p on p.id = e.podcast_id
        join user_podcast_subscriptions ups on ups.podcast_id = p.id and ups.user_id = $1
       where b.user_id = $1 and b.item_type = 'podcast'
       order by b.changed_at desc
    `, [user.userId]);

    const bookmarks = [
      ...trackBookmarks.rows.map((row: any) => ({
        position: Number(row.position_ms || 0),
        username: user.username,
        comment: row.comment || '',
        created: isoDate(row.bookmark_created_at),
        changed: isoDate(row.changed_at),
        entry: { ...formatSong(row), bookmarkPosition: Number(row.position_ms || 0) },
      })),
      ...podcastBookmarks.rows.map((row: any) => ({
        position: Number(row.position_ms || 0),
        username: user.username,
        comment: row.comment || '',
        created: isoDate(row.bookmark_created_at),
        changed: isoDate(row.changed_at),
        entry: formatPodcastEpisode({ ...row, position_ms: row.position_ms }),
      })),
    ];

    sendResponse(reply, createResponse({ bookmarks: { bookmark: bookmarks } }), params.f, params.callback);
  });

  rest('createBookmark', async (req, reply) => {
    const params = getParams(req);
    const user = currentUser(req);
    if (!params.id) return sendResponse(reply, createError(ERROR.MISSING_PARAM.code, 'Missing id parameter'), params.f, params.callback);
    const position = Math.max(Number(params.position ?? 0), 0);
    const comment = params.comment || '';

    if (params.id.startsWith('pod-')) {
      const episodeId = decodePrefixedNumber(params.id, 'pod-');
      if (episodeId === null) return sendResponse(reply, createError(ERROR.MISSING_PARAM.code, 'Invalid id parameter'), params.f, params.callback);
      const allowed = await db().query(
        `select 1 from podcast_episodes e
          join user_podcast_subscriptions ups on ups.podcast_id = e.podcast_id and ups.user_id = $1
         where e.id = $2`,
        [user.userId, episodeId]
      );
      if (allowed.rowCount === 0) return sendResponse(reply, createError(ERROR.NOT_FOUND.code, 'Episode not found'), params.f, params.callback);
      await db().query(
        `insert into subsonic_bookmarks (user_id, item_id, item_type, position_ms, comment)
         values ($1, $2, 'podcast', $3, $4)
         on conflict (user_id, item_id) do update
           set position_ms = excluded.position_ms, comment = excluded.comment, changed_at = now()`,
        [user.userId, params.id, position, comment]
      );
      await db().query(
        `insert into user_episode_progress (user_id, episode_id, position_ms, updated_at)
         values ($1, $2, $3, now())
         on conflict (user_id, episode_id) do update set position_ms = $3, updated_at = now()`,
        [user.userId, episodeId, position]
      );
    } else {
      const ids = await resolveTrackIds({ ...params, id: params.id }, user);
      const trackId = Number(params.id);
      if (!ids.includes(trackId)) return sendResponse(reply, createError(ERROR.NOT_FOUND.code, 'Song not found'), params.f, params.callback);
      await db().query(
        `insert into subsonic_bookmarks (user_id, item_id, item_type, position_ms, comment)
         values ($1, $2, 'track', $3, $4)
         on conflict (user_id, item_id) do update
           set position_ms = excluded.position_ms, comment = excluded.comment, changed_at = now()`,
        [user.userId, String(trackId), position, comment]
      );
    }

    sendResponse(reply, createResponse(), params.f, params.callback);
  });

  rest('deleteBookmark', async (req, reply) => {
    const params = getParams(req);
    const user = currentUser(req);
    if (!params.id) return sendResponse(reply, createError(ERROR.MISSING_PARAM.code, 'Missing id parameter'), params.f, params.callback);
    await db().query('delete from subsonic_bookmarks where user_id=$1 and item_id=$2', [user.userId, params.id]);
    if (params.id.startsWith('pod-')) {
      const episodeId = decodePrefixedNumber(params.id, 'pod-');
      if (episodeId !== null) {
        await db().query('update user_episode_progress set position_ms = 0, updated_at = now() where user_id=$1 and episode_id=$2', [user.userId, episodeId]);
      }
    }
    sendResponse(reply, createResponse(), params.f, params.callback);
  });

  rest('star', async (req, reply) => {
    const params = getParams(req);
    const user = currentUser(req);
    const ids = await resolveTrackIds(params, user);
    if (!ids.length) return sendResponse(reply, createError(ERROR.MISSING_PARAM.code, 'Missing id/albumId/artistId parameter'), params.f, params.callback);
    await db().query(
      'insert into favorite_tracks (user_id, track_id) select $1, unnest($2::bigint[]) on conflict do nothing',
      [user.userId, ids]
    );
    sendResponse(reply, createResponse(), params.f, params.callback);
  });

  rest('unstar', async (req, reply) => {
    const params = getParams(req);
    const user = currentUser(req);
    const ids = await resolveTrackIds(params, user);
    if (!ids.length) return sendResponse(reply, createError(ERROR.MISSING_PARAM.code, 'Missing id/albumId/artistId parameter'), params.f, params.callback);
    await db().query('delete from favorite_tracks where user_id=$1 and track_id=any($2::bigint[])', [user.userId, ids]);
    sendResponse(reply, createResponse(), params.f, params.callback);
  });

  async function sendStarred(req: FastifyRequest, reply: FastifyReply, responseKey: 'starred' | 'starred2') {
    const params = getParams(req);
    const user = currentUser(req);
    const args: unknown[] = [user.userId];
    const access = trackAccessCondition(user, args, 't', params.musicFolderId);
    const r = await db().query(`
      select t.*, f.added_at as starred_at
        from favorite_tracks f
        join active_tracks t on t.id = f.track_id
       where f.user_id = $1 and ${access}
       order by f.added_at desc
    `, args);
    sendResponse(reply, createResponse({ [responseKey]: { song: r.rows.map(formatSong) } }), params.f, params.callback);
  }
  rest('getStarred', (req, reply) => sendStarred(req, reply, 'starred'));
  rest('getStarred2', (req, reply) => sendStarred(req, reply, 'starred2'));
  rest('getStarredID3', (req, reply) => sendStarred(req, reply, 'starred2'));

  rest('scrobble', async (req, reply) => {
    const params = getParams(req);
    if (!params.id) return sendResponse(reply, createError(ERROR.MISSING_PARAM.code, 'Missing id parameter'), params.f, params.callback);
    const user = currentUser(req);
    const ids = await resolveTrackIds({ ...params, id: params.id }, user);
    if (!ids.includes(Number(params.id))) return sendResponse(reply, createError(ERROR.NOT_FOUND.code, 'Song not found'), params.f, params.callback);

    if (params.submission === 'false') {
      await redis().set(`subsonic:nowPlaying:${encodeURIComponent(user.username)}`, JSON.stringify({ trackId: params.id, username: user.username, at: Date.now() }), 'EX', 60 * 30);
      sendResponse(reply, createResponse(), params.f, params.callback);
      return;
    }

    await db().query('insert into play_history (user_id, track_id) values ($1, $2)', [user.userId, params.id]);
    await db().query(
      `insert into user_track_stats (user_id, track_id, play_count, last_played_at)
       values ($1, $2, 1, now())
       on conflict (user_id, track_id) do update
         set play_count = user_track_stats.play_count + 1,
             last_played_at = now()`,
      [user.userId, params.id]
    );
    sendResponse(reply, createResponse(), params.f, params.callback);
  });

  rest('getUser', async (req, reply) => {
    const params = getParams(req);
    const user = currentUser(req);
    const username = params.username || user.username;
    sendResponse(reply, createResponse({
      user: {
        username,
        email: username,
        scrobblingEnabled: true,
        adminRole: user.role === 'admin',
        settingsRole: true,
        downloadRole: true,
        uploadRole: false,
        playlistRole: true,
        coverArtRole: true,
        commentRole: true,
        podcastRole: false,
        streamRole: true,
        jukeboxRole: false,
        shareRole: false,
        videoConversionRole: false,
      },
    }), params.f, params.callback);
  });

  rest('getPlayQueue', async (req, reply) => {
    const params = getParams(req);
    sendResponse(reply, createResponse({ playQueue: { entry: [], current: 0, position: 0 } }), params.f, params.callback);
  });
  rest('savePlayQueue', async (req, reply) => {
    const params = getParams(req);
    sendResponse(reply, createResponse(), params.f, params.callback);
  });

  rest('getPlaylists', async (req, reply) => {
    const params = getParams(req);
    const user = currentUser(req);
    const args: unknown[] = [user.userId];
    const access = trackAccessCondition(user, args, 't', params.musicFolderId);
    const r = await db().query(`
      select p.id, p.name, p.created_at,
             (select count(*)::int from playlist_items pi join active_tracks t on t.id=pi.track_id where pi.playlist_id=p.id and ${access}) as song_count,
             (select sum(t.duration_ms) from playlist_items pi join active_tracks t on t.id=pi.track_id where pi.playlist_id=p.id and ${access}) as duration
        from playlists p
       where p.user_id = $1
       order by p.name
    `, args);
    sendResponse(reply, createResponse({
      playlists: {
        playlist: r.rows.map((p) => ({
          id: String(p.id),
          name: p.name,
          owner: user.username,
          public: false,
          songCount: Number(p.song_count) || 0,
          duration: Math.round((Number(p.duration) || 0) / 1000),
          created: isoDate(p.created_at),
          changed: isoDate(p.created_at),
        })),
      },
    }), params.f, params.callback);
  });

  rest('getPlaylist', async (req, reply) => {
    const params = getParams(req);
    if (!params.id) return sendResponse(reply, createError(ERROR.MISSING_PARAM.code, 'Missing id parameter'), params.f, params.callback);
    const user = currentUser(req);
    const pr = await db().query('select id, name, user_id, created_at from playlists where id=$1 and user_id=$2', [params.id, user.userId]);
    if (!pr.rows[0]) return sendResponse(reply, createError(ERROR.NOT_FOUND.code, 'Playlist not found'), params.f, params.callback);

    const args: unknown[] = [user.userId, params.id];
    const access = trackAccessCondition(user, args, 't', params.musicFolderId);
    const songs = await db().query(`
      select t.*, f.added_at as starred_at
        from playlist_items pi
        join active_tracks t on t.id = pi.track_id
        left join favorite_tracks f on f.track_id = t.id and f.user_id = $1
       where pi.playlist_id = $2 and ${access}
       order by pi.position
    `, args);
    const playlist = pr.rows[0];
    sendResponse(reply, createResponse({
      playlist: {
        id: String(playlist.id),
        name: playlist.name,
        owner: user.username,
        public: false,
        songCount: songs.rows.length,
        duration: Math.round(songs.rows.reduce((sum: number, s: any) => sum + Number(s.duration_ms || 0), 0) / 1000),
        created: isoDate(playlist.created_at),
        changed: isoDate(playlist.created_at),
        entry: songs.rows.map(formatSong),
      },
    }), params.f, params.callback);
  });

  rest('getSimilarSongs', async (req, reply) => {
    const params = getParams(req);
    sendResponse(reply, createResponse({ similarSongs: { song: [] } }), params.f, params.callback);
  });
  rest('getSimilarSongs2', async (req, reply) => {
    const params = getParams(req);
    sendResponse(reply, createResponse({ similarSongs2: { song: [] } }), params.f, params.callback);
  });
  rest('getSimilarSongsID3', async (req, reply) => {
    const params = getParams(req);
    sendResponse(reply, createResponse({ similarSongs2: { song: [] } }), params.f, params.callback);
  });
  rest('getPandoraSongs', async (req, reply) => {
    const params = getParams(req);
    sendResponse(reply, createResponse({ similarSongs: { song: [] } }), params.f, params.callback);
  });
  rest('getTopTrackSongs', async (req, reply) => {
    const params = getParams(req);
    const user = currentUser(req);
    const count = parseCount(params.count ?? params.size, 50);
    if (!params.artist) {
      return sendResponse(reply, createError(ERROR.MISSING_PARAM.code, 'Missing artist parameter'), params.f, params.callback);
    }
    const args: unknown[] = [user.userId, params.artist, count];
    const access = trackAccessCondition(user, args, 't', params.musicFolderId);
    const r = await db().query(`
      select t.*, f.added_at as starred_at
        from active_tracks t
        left join favorite_tracks f on f.track_id = t.id and f.user_id = $1
       where ${access} and lower(t.artist) = lower($2)
       order by t.id desc
       limit $3
    `, args);
    sendResponse(reply, createResponse({ topSongs: { song: r.rows.map(formatSong) } }), params.f, params.callback);
  });
  rest('getVideos', async (req, reply) => {
    const params = getParams(req);
    sendResponse(reply, createResponse({ videos: { video: [] } }), params.f, params.callback);
  });
  rest('getInternetRadioStations', async (req, reply) => {
    const params = getParams(req);
    sendResponse(reply, createResponse({ internetRadioStations: { internetRadioStation: [] } }), params.f, params.callback);
  });

  rest('createPlaylist', async (req, reply) => {
    const params = getParams(req);
    const user = currentUser(req);
    const name = (params.name || 'New Playlist').trim();
    const existingId = Number(params.playlistId);
    let playlistId = Number.isFinite(existingId) ? existingId : null;

    if (playlistId === null) {
      const r = await db().query<{ id: number }>(
        'insert into playlists (user_id, name) values ($1, $2) on conflict (user_id, name) do update set name = excluded.name returning id',
        [user.userId, name]
      );
      playlistId = Number(r.rows[0].id);
    } else if (params.name) {
      await db().query('update playlists set name=$1 where id=$2 and user_id=$3', [name, playlistId, user.userId]);
    }

    if (params.songId && playlistId !== null) {
      const trackIds = await resolveTrackIds({ ...params, id: params.songId }, user);
      if (trackIds.includes(Number(params.songId))) {
        const pos = await db().query<{ p: number }>('select coalesce(max(position), -1) + 1 as p from playlist_items where playlist_id=$1', [playlistId]);
        await db().query(
          'insert into playlist_items (playlist_id, track_id, position) values ($1, $2, $3) on conflict (playlist_id, track_id) do nothing',
          [playlistId, Number(params.songId), Number(pos.rows[0]?.p ?? 0)]
        );
      }
    }

    sendResponse(reply, createResponse(), params.f, params.callback);
  });

  rest('updatePlaylist', async (req, reply) => {
    const params = getParams(req);
    const user = currentUser(req);
    const playlistId = Number(params.playlistId);
    if (!Number.isFinite(playlistId)) return sendResponse(reply, createError(ERROR.MISSING_PARAM.code, 'Missing playlistId parameter'), params.f, params.callback);
    if (params.name) await db().query('update playlists set name=$1 where id=$2 and user_id=$3', [params.name, playlistId, user.userId]);
    if (params.songIdToAdd) {
      const trackIds = await resolveTrackIds({ ...params, id: params.songIdToAdd }, user);
      if (trackIds.includes(Number(params.songIdToAdd))) {
        const pos = await db().query<{ p: number }>('select coalesce(max(position), -1) + 1 as p from playlist_items where playlist_id=$1', [playlistId]);
        await db().query(
          `insert into playlist_items (playlist_id, track_id, position)
           select $1, $2, $3 where exists (select 1 from playlists where id=$1 and user_id=$4)
           on conflict (playlist_id, track_id) do nothing`,
          [playlistId, Number(params.songIdToAdd), Number(pos.rows[0]?.p ?? 0), user.userId]
        );
      }
    }
    if (params.songIdToRemove) {
      await db().query(
        `delete from playlist_items
          where playlist_id=$1 and track_id=$2
            and exists (select 1 from playlists where id=$1 and user_id=$3)`,
        [playlistId, Number(params.songIdToRemove), user.userId]
      );
    }
    sendResponse(reply, createResponse(), params.f, params.callback);
  });

  rest('deletePlaylist', async (req, reply) => {
    const params = getParams(req);
    const user = currentUser(req);
    const id = Number(params.id);
    if (!Number.isFinite(id)) return sendResponse(reply, createError(ERROR.MISSING_PARAM.code, 'Missing id parameter'), params.f, params.callback);
    await db().query('delete from playlists where id=$1 and user_id=$2', [id, user.userId]);
    sendResponse(reply, createResponse(), params.f, params.callback);
  });

  rest('jukeboxControl', async (req, reply) => {
    const params = getParams(req);
    sendResponse(reply, createResponse({ jukeboxStatus: { currentIndex: -1, playing: false, gain: 1, position: 0 } }), params.f, params.callback);
  });
  rest('getShares', async (req, reply) => {
    const params = getParams(req);
    sendResponse(reply, createResponse({ shares: { share: [] } }), params.f, params.callback);
  });
  rest('createShare', async (req, reply) => {
    const params = getParams(req);
    sendResponse(reply, createResponse(), params.f, params.callback);
  });
  rest('updateShare', async (req, reply) => {
    const params = getParams(req);
    sendResponse(reply, createResponse(), params.f, params.callback);
  });
  rest('deleteShare', async (req, reply) => {
    const params = getParams(req);
    sendResponse(reply, createResponse(), params.f, params.callback);
  });
  rest('getChatMessages', async (req, reply) => {
    const params = getParams(req);
    sendResponse(reply, createResponse({ chatMessages: { chatMessage: [] } }), params.f, params.callback);
  });
  rest('addChatMessage', async (req, reply) => {
    const params = getParams(req);
    sendResponse(reply, createResponse(), params.f, params.callback);
  });
  rest('getUsers', async (req, reply) => {
    const params = getParams(req);
    const user = currentUser(req);
    sendResponse(reply, createResponse({ users: { user: [{ username: user.username, adminRole: user.role === 'admin', streamRole: true, scrobblingEnabled: true }] } }), params.f, params.callback);
  });
  rest('changePassword', async (req, reply) => {
    const params = getParams(req);
    const user = currentUser(req);
    const username = normalizeEmail(params.username || user.username);
    const password = params.password ? decodeLegacyPassword(params.password) : '';
    if (!username || !password) return sendResponse(reply, createError(ERROR.MISSING_PARAM.code, 'Missing username or password parameter'), params.f, params.callback);
    if (username !== user.username && user.role !== 'admin') return sendResponse(reply, createError(ERROR.NOT_AUTHORIZED.code, 'Not authorized to change this password'), params.f, params.callback);

    const r = await db().query(
      `update users
          set subsonic_password = $1
        where email = $2 and approval_status = 'approved'
        returning id`,
      [password, username]
    );
    if (r.rowCount === 0) return sendResponse(reply, createError(ERROR.NOT_FOUND.code, 'User not found'), params.f, params.callback);
    await audit('subsonic_password_set', { by: user.userId, target: username });
    sendResponse(reply, createResponse(), params.f, params.callback);
  });

  for (const endpoint of ['createUser', 'updateUser', 'deleteUser'] as const) {
    rest(endpoint, async (req, reply) => {
      const params = getParams(req);
      sendResponse(reply, createResponse(), params.f, params.callback);
    });
  }

  logger.success('subsonic', 'Subsonic/OpenSubsonic API enabled at /rest/*');
});

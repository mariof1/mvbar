import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { db } from './db.js';
import { allowedLibrariesForUser, isLibraryAllowed } from './access.js';
import { config } from './config.js';
import type { Role } from './store.js';

const ART_DIR = process.env.ART_DIR ?? '/data/cache/art';

function safeJoinMount(mountPath: string, relPath: string) {
  const abs = path.resolve(mountPath, relPath);
  const base = path.resolve(mountPath);
  if (!abs.startsWith(base + path.sep)) throw new Error('invalid path');
  return abs;
}

function safeJoinArt(relPath: string) {
  const abs = path.resolve(ART_DIR, relPath);
  const base = path.resolve(ART_DIR);
  if (!abs.startsWith(base + path.sep)) throw new Error('invalid path');
  return abs;
}

type TrackStreamRow = {
  path: string;
  ext: string;
  library_id: number;
  mount_path: string;
  art_path: string | null;
  art_mime: string | null;
  art_hash: string | null;
};

function contentTypeForExtension(ext: string) {
  switch (ext.toLowerCase()) {
    case '.mp3': return 'audio/mpeg';
    case '.m4a':
    case '.mp4': return 'audio/mp4';
    case '.aac': return 'audio/aac';
    case '.flac': return 'audio/flac';
    case '.ogg':
    case '.oga': return 'audio/ogg';
    case '.opus': return 'audio/opus';
    case '.wav': return 'audio/wav';
    default: return 'application/octet-stream';
  }
}

function imageContentTypeForPath(artPath: string) {
  switch (path.extname(artPath).toLowerCase()) {
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.png': return 'image/png';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    default: return 'image/jpeg';
  }
}

function castSignature(trackId: number, userId: string, role: Role, expiresAt: number) {
  return crypto
    .createHmac('sha256', config.jwtSecret)
    .update(`${trackId}.${userId}.${role}.${expiresAt}`)
    .digest('base64url');
}

function requestOrigin(req: FastifyRequest) {
  const forwardedProto = Array.isArray(req.headers['x-forwarded-proto'])
    ? req.headers['x-forwarded-proto'][0]
    : req.headers['x-forwarded-proto'];
  const forwardedHost = Array.isArray(req.headers['x-forwarded-host'])
    ? req.headers['x-forwarded-host'][0]
    : req.headers['x-forwarded-host'];
  const proto = forwardedProto?.split(',')[0]?.trim() || req.protocol || 'http';
  const host = forwardedHost?.split(',')[0]?.trim() || req.headers.host;
  return `${proto}://${host}`;
}

async function getTrackStreamRow(id: number) {
  const r = await db().query<TrackStreamRow>(
    'select t.path, t.ext, t.library_id, t.art_path, t.art_mime, t.art_hash, l.mount_path from active_tracks t join libraries l on l.id=t.library_id where t.id=$1',
    [id]
  );
  return r.rows[0] ?? null;
}

async function sendTrackStream(row: TrackStreamRow, req: FastifyRequest, reply: FastifyReply) {
  const abs = safeJoinMount(row.mount_path, row.path);
  const st = await stat(abs);
  const range = req.headers.range;

  const contentType = contentTypeForExtension(row.ext);

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

    const stream = createReadStream(abs, { start, end });
    stream.on('error', () => { if (!reply.sent) reply.code(500).send(); });
    return reply.send(stream);
  }

  reply.header('Content-Length', String(st.size)).header('Accept-Ranges', 'bytes').header('Content-Type', contentType);
  const stream = createReadStream(abs);
  stream.on('error', () => { if (!reply.sent) reply.code(500).send(); });
  return reply.send(stream);
}

async function sendTrackArt(row: TrackStreamRow, reply: FastifyReply) {
  if (!row.art_path) return reply.code(404).send({ ok: false });

  const abs = safeJoinArt(row.art_path);
  const st = await stat(abs);
  const etag = row.art_hash ? `"${row.art_hash}"` : undefined;

  reply
    .header('Content-Type', row.art_mime || imageContentTypeForPath(row.art_path))
    .header('Content-Length', String(st.size))
    .header('Cache-Control', 'public, max-age=600')
    .header('ETag', etag ?? '');

  const stream = createReadStream(abs);
  stream.on('error', () => { if (!reply.sent) reply.code(500).send(); });
  return reply.send(stream);
}

function getValidCastQuery(req: FastifyRequest, trackId: number): { userId: string; role: Role } | null {
  const query = req.query as { u?: string; r?: string; exp?: string; sig?: string };
  const userId = query.u ?? '';
  const role = query.r === 'admin' || query.r === 'user' ? (query.r as Role) : null;
  const expiresAt = Number(query.exp);
  const sig = query.sig ?? '';

  if (!role || !Number.isFinite(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) {
    return null;
  }

  const expected = castSignature(trackId, userId, role, expiresAt);
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  return { userId, role };
}

export const streamPlugin: FastifyPluginAsync = fp(async (app) => {
  app.get('/api/library/tracks/:id/stream', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });

    const id = Number((req.params as { id: string }).id);
    if (!Number.isFinite(id)) return reply.code(400).send({ ok: false });

    const row = await getTrackStreamRow(id);
    if (!row) return reply.code(404).send({ ok: false });

    const allowed = await allowedLibrariesForUser(req.user.userId, req.user.role);
    if (!isLibraryAllowed(Number(row.library_id), allowed)) return reply.code(404).send({ ok: false });

    return sendTrackStream(row, req, reply);
  });

  app.get('/api/library/tracks/:id/cast-url', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });

    const id = Number((req.params as { id: string }).id);
    if (!Number.isFinite(id)) return reply.code(400).send({ ok: false });

    const row = await getTrackStreamRow(id);
    if (!row) return reply.code(404).send({ ok: false });

    const allowed = await allowedLibrariesForUser(req.user.userId, req.user.role);
    if (!isLibraryAllowed(Number(row.library_id), allowed)) return reply.code(404).send({ ok: false });

    const expiresAt = Math.floor(Date.now() / 1000) + 10 * 60;
    const sig = castSignature(id, req.user.userId, req.user.role, expiresAt);
    const params = new URLSearchParams({
      u: req.user.userId,
      r: req.user.role,
      exp: String(expiresAt),
      sig
    });
    const url = `${requestOrigin(req)}/api/library/tracks/${id}/cast-stream?${params.toString()}`;
    const artUrl = row.art_path
      ? `${requestOrigin(req)}/api/library/tracks/${id}/cast-art?${params.toString()}`
      : undefined;

    return { ok: true, url, expiresAt: expiresAt * 1000, contentType: contentTypeForExtension(row.ext), artUrl };
  });

  app.get('/api/library/tracks/:id/cast-stream', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isFinite(id)) return reply.code(401).send({ ok: false });
    const castQuery = getValidCastQuery(req, id);
    if (!castQuery) return reply.code(401).send({ ok: false });

    const row = await getTrackStreamRow(id);
    if (!row) return reply.code(404).send({ ok: false });

    const allowed = await allowedLibrariesForUser(castQuery.userId, castQuery.role);
    if (!isLibraryAllowed(Number(row.library_id), allowed)) return reply.code(404).send({ ok: false });

    return sendTrackStream(row, req, reply);
  });

  app.get('/api/library/tracks/:id/cast-art', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isFinite(id)) return reply.code(401).send({ ok: false });
    const castQuery = getValidCastQuery(req, id);
    if (!castQuery) return reply.code(401).send({ ok: false });

    const row = await getTrackStreamRow(id);
    if (!row) return reply.code(404).send({ ok: false });

    const allowed = await allowedLibrariesForUser(castQuery.userId, castQuery.role);
    if (!isLibraryAllowed(Number(row.library_id), allowed)) return reply.code(404).send({ ok: false });

    return sendTrackArt(row, reply);
  });
});

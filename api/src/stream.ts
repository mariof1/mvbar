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

function safeJoinMount(mountPath: string, relPath: string) {
  const abs = path.resolve(mountPath, relPath);
  const base = path.resolve(mountPath);
  if (!abs.startsWith(base + path.sep)) throw new Error('invalid path');
  return abs;
}

type TrackStreamRow = { path: string; ext: string; library_id: number; mount_path: string };

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
    'select t.path, t.ext, t.library_id, l.mount_path from active_tracks t join libraries l on l.id=t.library_id where t.id=$1',
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

    return { ok: true, url, expiresAt: expiresAt * 1000 };
  });

  app.get('/api/library/tracks/:id/cast-stream', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const query = req.query as { u?: string; r?: string; exp?: string; sig?: string };
    const userId = query.u ?? '';
    const role = query.r === 'admin' || query.r === 'user' ? query.r : null;
    const expiresAt = Number(query.exp);
    const sig = query.sig ?? '';

    if (!Number.isFinite(id) || !role || !Number.isFinite(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) {
      return reply.code(401).send({ ok: false });
    }

    const expected = castSignature(id, userId, role, expiresAt);
    const sigBuf = Buffer.from(sig);
    const expectedBuf = Buffer.from(expected);
    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      return reply.code(401).send({ ok: false });
    }

    const row = await getTrackStreamRow(id);
    if (!row) return reply.code(404).send({ ok: false });

    const allowed = await allowedLibrariesForUser(userId, role);
    if (!isLibraryAllowed(Number(row.library_id), allowed)) return reply.code(404).send({ ok: false });

    return sendTrackStream(row, req, reply);
  });
});

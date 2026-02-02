import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { createReadStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { db } from './db.js';
import { allowedLibrariesForUser, isLibraryAllowed } from './access.js';

const HLS_DIR = process.env.HLS_DIR ?? '/hls';

function safeJoin(baseDir: string, rel: string) {
  const abs = path.resolve(baseDir, rel);
  const base = path.resolve(baseDir);
  if (!abs.startsWith(base + path.sep)) throw new Error('invalid path');
  return abs;
}

async function getTrackRow(trackId: number) {
  const r = await db().query<{
    id: number;
    path: string;
    ext: string;
    library_id: number;
    mount_path: string;
    mtime_ms: number;
    size_bytes: number;
  }>(
    'select t.id, t.path, t.ext, t.library_id, l.mount_path, t.mtime_ms, t.size_bytes from active_tracks t join libraries l on l.id=t.library_id where t.id=$1',
    [trackId]
  );
  return r.rows[0] ?? null;
}

function cacheKeyForTrack(t: { id: number; mtime_ms: number; size_bytes: number; ext: string }) {
  return `t${t.id}_${t.mtime_ms}_${t.size_bytes}${t.ext}`.replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function getLatestDoneJob(trackId: number, cacheKey: string) {
  const r = await db().query<{ id: number; out_dir: string }>(
    "select id, out_dir from transcode_jobs where track_id=$1 and state='done' and cache_key=$2 order by id desc limit 1",
    [trackId, cacheKey]
  );
  return r.rows[0] ?? null;
}

async function getLatestJob(trackId: number, cacheKey: string) {
  const r = await db().query<{ id: number; state: string; out_dir: string | null; error: string | null }>(
    'select id, state, out_dir, error from transcode_jobs where track_id=$1 and cache_key=$2 order by id desc limit 1',
    [trackId, cacheKey]
  );
  return r.rows[0] ?? null;
}

async function enqueueJob(trackId: number, cacheKey: string, requestedBy: string) {
  await mkdir(HLS_DIR, { recursive: true });
  const r = await db().query<{ id: number }>(
    "insert into transcode_jobs(track_id, cache_key, state, requested_by) values ($1,$2,'queued',$3) returning id",
    [trackId, cacheKey, requestedBy]
  );
  return r.rows[0].id;
}

export const hlsPlugin: FastifyPluginAsync = fp(async (app) => {
  // Request an HLS transcode (idempotent for the current file version).
  app.post('/api/hls/:id/request', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const id = Number((req.params as { id: string }).id);
    if (!Number.isFinite(id)) return reply.code(400).send({ ok: false });

    const t = await getTrackRow(id);
    if (!t) return reply.code(404).send({ ok: false });

    const allowed = await allowedLibrariesForUser(req.user.userId, req.user.role);
    if (!isLibraryAllowed(Number(t.library_id), allowed)) return reply.code(404).send({ ok: false });

    const cacheKey = cacheKeyForTrack(t);
    const done = await getLatestDoneJob(id, cacheKey);
    if (done) {
      return { ok: true, state: 'done', jobId: done.id, ready: true, manifestUrl: `/api/hls/${id}/index.m3u8` };
    }

    const existing = await getLatestJob(id, cacheKey);
    if (existing && (existing.state === 'queued' || existing.state === 'running')) {
      return { ok: true, state: existing.state, jobId: existing.id, ready: false };
    }

    const jobId = await enqueueJob(id, cacheKey, req.user.userId);
    return { ok: true, state: 'queued', jobId, ready: false };
  });

  app.get('/api/hls/:id/status', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const id = Number((req.params as { id: string }).id);
    if (!Number.isFinite(id)) return reply.code(400).send({ ok: false });

    const t = await getTrackRow(id);
    if (!t) return reply.code(404).send({ ok: false });

    const allowed = await allowedLibrariesForUser(req.user.userId, req.user.role);
    if (!isLibraryAllowed(Number(t.library_id), allowed)) return reply.code(404).send({ ok: false });

    const cacheKey = cacheKeyForTrack(t);
    const job = await getLatestJob(id, cacheKey);
    if (!job) return { ok: true, state: 'missing', ready: false };

    const ready = job.state === 'done';
    return {
      ok: true,
      state: job.state,
      jobId: job.id,
      ready,
      error: job.error ?? null,
      manifestUrl: ready ? `/api/hls/${id}/index.m3u8` : null
    };
  });

  // Serve manifest + segments for the *current* file version.
  app.get('/api/hls/:id/:file', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const id = Number((req.params as { id: string }).id);
    const file = (req.params as { file: string }).file;
    if (!Number.isFinite(id)) return reply.code(400).send({ ok: false });

    const t = await getTrackRow(id);
    if (!t) return reply.code(404).send({ ok: false });

    const allowed = await allowedLibrariesForUser(req.user.userId, req.user.role);
    if (!isLibraryAllowed(Number(t.library_id), allowed)) return reply.code(404).send({ ok: false });

    const cacheKey = cacheKeyForTrack(t);
    const done = await getLatestDoneJob(id, cacheKey);
    if (!done) return reply.code(404).send({ ok: false, error: 'not_ready' });

    const rel = path.join(cacheKey, file);
    const abs = safeJoin(HLS_DIR, rel);

    try {
      const st = await stat(abs);
      if (!st.isFile()) return reply.code(404).send({ ok: false });
    } catch {
      return reply.code(404).send({ ok: false });
    }

    const ct = file.endsWith('.m3u8')
      ? 'application/vnd.apple.mpegurl'
      : file.endsWith('.ts')
        ? 'video/mp2t'
        : 'application/octet-stream';

    reply.header('Content-Type', ct);
    return reply.send(createReadStream(abs));
  });
});

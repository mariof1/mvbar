import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { audit, db } from './db.js';
import * as stats from './statsRepo.js';
import { allowedLibrariesForUser, isLibraryAllowed } from './access.js';

export const statsPlugin: FastifyPluginAsync = fp(async (app) => {
  app.post('/api/stats/skip/:trackId', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const trackId = Number((req.params as { trackId: string }).trackId);
    if (!Number.isFinite(trackId)) return reply.code(400).send({ ok: false });

    const body = (req.body ?? {}) as { pct?: number };
    const pct = typeof body.pct === 'number' && Number.isFinite(body.pct) ? body.pct : null;

    const r = await db().query<{ library_id: number }>('select library_id from active_tracks where id=$1', [trackId]);
    const row = r.rows[0];
    if (!row) return reply.code(404).send({ ok: false });
    const allowed = await allowedLibrariesForUser(req.user.userId, req.user.role);
    if (!isLibraryAllowed(Number(row.library_id), allowed)) return reply.code(404).send({ ok: false });

    await stats.incSkip(req.user.userId, trackId);
    await audit('track_skipped', { by: req.user.userId, trackId, pct });
    return { ok: true };
  });

  app.get('/api/stats/top/tracks', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const q = req.query as { limit?: string; offset?: string };
    const limit = Math.min(200, Math.max(1, Number(q.limit ?? 50)));
    const offset = Math.max(0, Number(q.offset ?? 0));

    const allowed = await allowedLibrariesForUser(req.user.userId, req.user.role);
    const tracks = await stats.topTracksByPlays(req.user.userId, limit, offset, allowed);
    return { ok: true, tracks, limit, offset };
  });
});

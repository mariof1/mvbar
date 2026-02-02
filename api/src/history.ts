import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { audit, db } from './db.js';
import * as hist from './historyRepo.js';
import * as stats from './statsRepo.js';
import { allowedLibrariesForUser, isLibraryAllowed } from './access.js';

export const historyPlugin: FastifyPluginAsync = fp(async (app) => {
  app.post('/api/history/:trackId', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const trackId = Number((req.params as { trackId: string }).trackId);
    if (!Number.isFinite(trackId)) return reply.code(400).send({ ok: false });

    const r = await db().query<{ library_id: number }>('select library_id from active_tracks where id=$1', [trackId]);
    const row = r.rows[0];
    if (!row) return reply.code(404).send({ ok: false });
    const allowed = await allowedLibrariesForUser(req.user.userId, req.user.role);
    if (!isLibraryAllowed(Number(row.library_id), allowed)) return reply.code(404).send({ ok: false });

    await hist.addPlay(req.user.userId, trackId);
    await stats.incPlay(req.user.userId, trackId);
    await audit('track_played', { by: req.user.userId, trackId });
    return { ok: true };
  });

  app.get('/api/history', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const q = req.query as { limit?: string; offset?: string };
    const limit = Math.min(200, Math.max(1, Number(q.limit ?? 50)));
    const offset = Math.max(0, Number(q.offset ?? 0));

    const allowed = await allowedLibrariesForUser(req.user.userId, req.user.role);
    const tracks = await hist.listHistory(req.user.userId, limit, offset, allowed);
    return { ok: true, tracks, limit, offset };
  });
});

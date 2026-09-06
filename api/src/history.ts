import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { audit, db } from './db.js';
import * as hist from './historyRepo.js';
import * as stats from './statsRepo.js';
import { allowedLibrariesForUser, isLibraryAllowed } from './access.js';
import { broadcastToUser } from './websocket.js';
import { artistDisplay } from './artistDisplay.js';
import { invalidateRecommendationCache } from './recommendationCache.js';
import { markRecommendationAction } from './recommendationTelemetry.js';
import { normalizePlaybackSignal, type PlaybackSignalBody } from './playbackSignal.js';

export const historyPlugin: FastifyPluginAsync = fp(async (app) => {
  app.post('/api/history/:trackId', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const trackId = Number((req.params as { trackId: string }).trackId);
    if (!Number.isFinite(trackId)) return reply.code(400).send({ ok: false });

    const r = await db().query<{ library_id: number; duration_ms: number | null }>(
      'select library_id, duration_ms from active_tracks where id=$1',
      [trackId],
    );
    const row = r.rows[0];
    if (!row) return reply.code(404).send({ ok: false });
    const allowed = await allowedLibrariesForUser(req.user.userId, req.user.role);
    if (!isLibraryAllowed(Number(row.library_id), allowed)) return reply.code(404).send({ ok: false });

    const signal = normalizePlaybackSignal(req.body as PlaybackSignalBody | undefined, row.duration_ms, 1);
    await hist.addPlay(req.user.userId, trackId);
    await stats.incPlay(req.user.userId, trackId, signal);
    await markRecommendationAction(
      req.user.userId,
      trackId,
      'completed',
      signal.context,
      signal.listenedMs,
      signal.completionPct,
    );
    await invalidateRecommendationCache(req.user.userId);
    await audit('track_played', {
      by: req.user.userId,
      trackId,
      listenedMs: signal.listenedMs,
      completionPct: signal.completionPct,
      recommendation: signal.context.slateId ? signal.context : undefined,
    });
    broadcastToUser(req.user.userId, 'history:added', { trackId, ts: Date.now() });
    return { ok: true };
  });

  app.get('/api/history', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const q = req.query as { limit?: string; offset?: string };
    const limit = Math.min(200, Math.max(1, Number(q.limit ?? 50)));
    const offset = Math.max(0, Number(q.offset ?? 0));

    const allowed = await allowedLibrariesForUser(req.user.userId, req.user.role);
    const tracks = (await hist.listHistory(req.user.userId, limit, offset, allowed)).map((track: any) => ({
      ...track,
      display_artist: artistDisplay(track.artist, track.album_artist),
    }));
    return { ok: true, tracks, limit, offset };
  });
});

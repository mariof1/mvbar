import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { audit, db } from './db.js';
import * as stats from './statsRepo.js';
import { allowedLibrariesForUser, isLibraryAllowed } from './access.js';
import { invalidateRecommendationCache } from './recommendationCache.js';
import { markRecommendationAction } from './recommendationTelemetry.js';
import {
  normalizeCompletionRatio,
  normalizePlaybackSignal,
  type PlaybackSignalBody,
} from './playbackSignal.js';

export const statsPlugin: FastifyPluginAsync = fp(async (app) => {
  app.post('/api/stats/skip/:trackId', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const trackId = Number((req.params as { trackId: string }).trackId);
    if (!Number.isFinite(trackId)) return reply.code(400).send({ ok: false });

    const body = (req.body ?? {}) as PlaybackSignalBody & { pct?: unknown };
    // Older Android releases send whole percentages (for example 12), while
    // the web client sends a 0..1 ratio.
    const legacyPct = normalizeCompletionRatio(body.pct);
    const signalBody = body.completionPct === undefined && legacyPct != null
      ? { ...body, completionPct: legacyPct }
      : body;

    const r = await db().query<{ library_id: number; duration_ms: number | null }>(
      'select library_id, duration_ms from active_tracks where id=$1',
      [trackId],
    );
    const row = r.rows[0];
    if (!row) return reply.code(404).send({ ok: false });
    const allowed = await allowedLibrariesForUser(req.user.userId, req.user.role);
    if (!isLibraryAllowed(Number(row.library_id), allowed)) return reply.code(404).send({ ok: false });

    const signal = normalizePlaybackSignal(signalBody, row.duration_ms, legacyPct ?? 0);
    if ((signal.completionPct ?? 0) >= 0.25) {
      // A manual next near the end is not a dislike. Legacy Android clients
      // reported every manual transition through this endpoint, so retain the
      // listening evidence without adding a negative skip signal.
      await stats.recordPartialListen(req.user.userId, trackId, signal);
      await markRecommendationAction(
        req.user.userId,
        trackId,
        'played',
        signal.context,
        signal.listenedMs,
        signal.completionPct,
      );
      await audit('track_partially_played', {
        by: req.user.userId,
        trackId,
        listenedMs: signal.listenedMs,
        completionPct: signal.completionPct,
        recommendation: signal.context.slateId ? signal.context : undefined,
      });
      return { ok: true, outcome: 'partial' };
    }

    await stats.incSkip(req.user.userId, trackId, signal);
    await markRecommendationAction(
      req.user.userId,
      trackId,
      'skipped',
      signal.context,
      signal.listenedMs,
      signal.completionPct,
    );
    await invalidateRecommendationCache(req.user.userId);
    await audit('track_skipped', {
      by: req.user.userId,
      trackId,
      listenedMs: signal.listenedMs,
      completionPct: signal.completionPct,
      recommendation: signal.context.slateId ? signal.context : undefined,
    });
    return { ok: true, outcome: 'skipped' };
  });

  app.post('/api/stats/listen/:trackId', async (req, reply) => {
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

    const signal = normalizePlaybackSignal(req.body as PlaybackSignalBody | undefined, row.duration_ms, null);
    await stats.recordPartialListen(req.user.userId, trackId, signal);
    await markRecommendationAction(
      req.user.userId,
      trackId,
      'played',
      signal.context,
      signal.listenedMs,
      signal.completionPct,
    );
    await audit('track_partially_played', {
      by: req.user.userId,
      trackId,
      listenedMs: signal.listenedMs,
      completionPct: signal.completionPct,
      recommendation: signal.context.slateId ? signal.context : undefined,
    });
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

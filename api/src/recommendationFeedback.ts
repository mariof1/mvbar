import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { allowedLibrariesForUser, isLibraryAllowed } from './access.js';
import { audit, db } from './db.js';
import { recommendationArtistKeys } from './recommendationFeatures.js';
import { invalidateRecommendationCache } from './recommendationCache.js';
import {
  clearAllRecommendationPreferences,
  clearRecommendationPreference,
  setRecommendationPreference,
  type RecommendationFeedback,
  type RecommendationPreferenceSubject,
} from './recommendationTelemetry.js';

const FEEDBACK_ACTIONS = new Set<RecommendationFeedback>([
  'more_like_this',
  'not_for_me',
  'less_like_artist',
  'hide_bucket',
]);
const SUBJECT_TYPES = new Set<RecommendationPreferenceSubject>(['track', 'artist', 'bucket']);

function normalizedBucketKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const key = value.trim();
  return key && key.length <= 160 && /^[a-z0-9_:-]+$/i.test(key) ? key : null;
}

async function visibleTrack(
  userId: string,
  role: 'admin' | 'user',
  trackId: number,
): Promise<{ artist: string | null } | null> {
  const result = await db().query<{ library_id: number; artist: string | null }>(
    'select library_id, artist from active_tracks where id=$1',
    [trackId],
  );
  const track = result.rows[0];
  if (!track) return null;
  const allowed = await allowedLibrariesForUser(userId, role);
  return isLibraryAllowed(Number(track.library_id), allowed) ? track : null;
}

export const recommendationFeedbackPlugin: FastifyPluginAsync = fp(async (app) => {
  app.post('/api/recommendations/feedback', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const body = (req.body ?? {}) as {
      action?: unknown;
      trackId?: unknown;
      artist?: unknown;
      bucketKey?: unknown;
    };
    const action = typeof body.action === 'string' && FEEDBACK_ACTIONS.has(body.action as RecommendationFeedback)
      ? body.action as RecommendationFeedback
      : null;
    if (!action) return reply.code(400).send({ ok: false, error: 'invalid_feedback' });

    let subjectType: RecommendationPreferenceSubject;
    let subjectKey: string;
    let preference: number;
    if (action === 'hide_bucket') {
      const bucketKey = normalizedBucketKey(body.bucketKey);
      if (!bucketKey) return reply.code(400).send({ ok: false, error: 'invalid_bucket' });
      subjectType = 'bucket';
      subjectKey = bucketKey;
      preference = -2;
    } else {
      const trackId = Number(body.trackId);
      if (!Number.isSafeInteger(trackId) || trackId <= 0) {
        return reply.code(400).send({ ok: false, error: 'invalid_track' });
      }
      const track = await visibleTrack(req.user.userId, req.user.role, trackId);
      if (!track) return reply.code(404).send({ ok: false, error: 'track_not_found' });

      if (action === 'less_like_artist') {
        const suppliedArtist = typeof body.artist === 'string' ? body.artist : track.artist;
        const artistKey = recommendationArtistKeys(suppliedArtist)[0];
        if (!artistKey) return reply.code(400).send({ ok: false, error: 'invalid_artist' });
        subjectType = 'artist';
        subjectKey = artistKey;
        preference = -2;
      } else {
        subjectType = 'track';
        subjectKey = String(trackId);
        preference = action === 'more_like_this' ? 2 : -2;
      }
    }

    await setRecommendationPreference(req.user.userId, subjectType, subjectKey, preference);
    await invalidateRecommendationCache(req.user.userId);
    await audit('recommendation_feedback', {
      by: req.user.userId,
      action,
      subjectType,
      subjectKey,
    });
    return { ok: true, action, subjectType, subjectKey, preference };
  });

  app.delete('/api/recommendations/feedback/all', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const removed = await clearAllRecommendationPreferences(req.user.userId);
    if (removed > 0) await invalidateRecommendationCache(req.user.userId);
    await audit('recommendation_feedback_reset', {
      by: req.user.userId,
      removed,
    });
    return { ok: true, removed };
  });

  app.delete('/api/recommendations/feedback', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const query = req.query as { subjectType?: string; subjectKey?: string };
    const subjectType = SUBJECT_TYPES.has(query.subjectType as RecommendationPreferenceSubject)
      ? query.subjectType as RecommendationPreferenceSubject
      : null;
    const subjectKey = typeof query.subjectKey === 'string' ? query.subjectKey.trim().slice(0, 160) : '';
    if (!subjectType || !subjectKey) return reply.code(400).send({ ok: false, error: 'invalid_subject' });

    const removed = await clearRecommendationPreference(req.user.userId, subjectType, subjectKey);
    if (removed) await invalidateRecommendationCache(req.user.userId);
    return { ok: true, removed };
  });

  app.get('/api/recommendations/feedback', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const result = await db().query<{
      subject_type: RecommendationPreferenceSubject;
      subject_key: string;
      preference: number;
      updated_at: Date;
    }>(
      `select subject_type, subject_key, preference, updated_at
         from recommendation_preferences
        where user_id=$1
        order by updated_at desc
        limit 500`,
      [req.user.userId],
    );
    return { ok: true, preferences: result.rows };
  });
});

import crypto from 'node:crypto';
import { db } from './db.js';

export type RecommendationPreferenceSubject = 'track' | 'artist' | 'bucket';
export type RecommendationFeedback = 'more_like_this' | 'not_for_me' | 'less_like_artist' | 'hide_bucket';

export type RecommendationContext = {
  slateId?: string | null;
  bucketKey?: string | null;
};

type ImpressionBucket = {
  key: string;
  tracks: Array<{ id: number }>;
};

export function recommendationSlateId(userId: string, buckets: ImpressionBucket[]): string {
  const signature = buckets.map((bucket) => [bucket.key, bucket.tracks.map((track) => Number(track.id))]);
  return crypto
    .createHash('sha256')
    .update(`${userId}:${JSON.stringify(signature)}`)
    .digest('hex')
    .slice(0, 24);
}

export async function recordRecommendationImpressions(
  userId: string,
  slateId: string,
  buckets: ImpressionBucket[],
): Promise<void> {
  const rows = buckets.flatMap((bucket) => bucket.tracks.map((track, position) => ({
    bucketKey: bucket.key,
    trackId: Number(track.id),
    position,
  }))).filter((row) => Number.isSafeInteger(row.trackId) && row.trackId > 0);
  if (rows.length === 0) return;

  await db().query(
    `insert into recommendation_impressions(user_id, slate_id, bucket_key, track_id, position)
     select $1, $2, impression.bucket_key, impression.track_id, impression.position
       from unnest($3::text[], $4::bigint[], $5::integer[])
            as impression(bucket_key, track_id, position)
     on conflict (user_id, slate_id, bucket_key, track_id) do nothing`,
    [
      userId,
      slateId,
      rows.map((row) => row.bucketKey),
      rows.map((row) => row.trackId),
      rows.map((row) => row.position),
    ],
  );
}

export async function markRecommendationAction(
  userId: string,
  trackId: number,
  action: 'played' | 'completed' | 'skipped',
  context: RecommendationContext,
  listenedMs: number,
  completionPct: number | null,
): Promise<void> {
  const slateId = context.slateId?.trim();
  const bucketKey = context.bucketKey?.trim();
  if (!slateId || !bucketKey) return;

  await db().query(
    `update recommendation_impressions
        set played_at = case
              when $5::text in ('played', 'completed') then coalesce(played_at, now())
              else played_at
            end,
            completed_at = case
              when $5::text = 'completed' then coalesce(completed_at, now())
              else completed_at
            end,
            skipped_at = case
              when $5::text = 'skipped' then coalesce(skipped_at, now())
              else skipped_at
            end,
            listened_ms = greatest(listened_ms, $6),
            completion_pct = case
              when $7::double precision is null then completion_pct
              else greatest(coalesce(completion_pct, 0), $7::double precision)
            end
      where user_id=$1 and slate_id=$2 and bucket_key=$3 and track_id=$4`,
    [userId, slateId, bucketKey, trackId, action, listenedMs, completionPct],
  );
}

export async function setRecommendationPreference(
  userId: string,
  subjectType: RecommendationPreferenceSubject,
  subjectKey: string,
  preference: number,
): Promise<void> {
  await db().query(
    `insert into recommendation_preferences(user_id, subject_type, subject_key, preference)
     values ($1, $2, $3, $4)
     on conflict (user_id, subject_type, subject_key) do update
       set preference=excluded.preference, updated_at=now()`,
    [userId, subjectType, subjectKey, preference],
  );
}

export async function clearRecommendationPreference(
  userId: string,
  subjectType: RecommendationPreferenceSubject,
  subjectKey: string,
): Promise<boolean> {
  const result = await db().query(
    'delete from recommendation_preferences where user_id=$1 and subject_type=$2 and subject_key=$3',
    [userId, subjectType, subjectKey],
  );
  return Boolean(result.rowCount);
}

export async function clearAllRecommendationPreferences(userId: string): Promise<number> {
  const result = await db().query(
    'delete from recommendation_preferences where user_id=$1',
    [userId],
  );
  return result.rowCount ?? 0;
}

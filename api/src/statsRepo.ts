import { db } from './db.js';

export type ListeningSignal = {
  listenedMs?: number;
  completionPct?: number | null;
};

export async function incPlay(userId: string, trackId: number, signal: ListeningSignal = {}) {
  const listenedMs = Math.max(0, Math.trunc(signal.listenedMs ?? 0));
  const completionPct = signal.completionPct == null
    ? null
    : Math.max(0, Math.min(1, signal.completionPct));
  await db().query(
    `
    insert into user_track_stats(
      user_id, track_id, play_count, skip_count, last_played_at,
      total_listened_ms, completion_count, last_completion_pct
    )
    values ($1, $2, 1, 0, now(), $3, 1, $4)
    on conflict (user_id, track_id)
    do update set
      play_count = user_track_stats.play_count + 1,
      last_played_at = now(),
      total_listened_ms = user_track_stats.total_listened_ms + excluded.total_listened_ms,
      completion_count = user_track_stats.completion_count + 1,
      last_completion_pct = coalesce(excluded.last_completion_pct, user_track_stats.last_completion_pct)
    `,
    [userId, trackId, listenedMs, completionPct]
  );
}

export async function incSkip(userId: string, trackId: number, signal: ListeningSignal = {}) {
  const listenedMs = Math.max(0, Math.trunc(signal.listenedMs ?? 0));
  const completionPct = signal.completionPct == null
    ? null
    : Math.max(0, Math.min(1, signal.completionPct));
  const earlySkip = completionPct == null || completionPct < 0.25 ? 1 : 0;
  await db().query(
    `
    insert into user_track_stats(
      user_id, track_id, play_count, skip_count, last_skipped_at,
      total_listened_ms, early_skip_count, last_completion_pct
    )
    values ($1, $2, 0, 1, now(), $3, $4, $5)
    on conflict (user_id, track_id)
    do update set
      skip_count = user_track_stats.skip_count + 1,
      last_skipped_at = now(),
      total_listened_ms = user_track_stats.total_listened_ms + excluded.total_listened_ms,
      early_skip_count = user_track_stats.early_skip_count + excluded.early_skip_count,
      last_completion_pct = coalesce(excluded.last_completion_pct, user_track_stats.last_completion_pct)
    `,
    [userId, trackId, listenedMs, earlySkip, completionPct]
  );
}

export async function recordPartialListen(userId: string, trackId: number, signal: ListeningSignal) {
  const listenedMs = Math.max(0, Math.trunc(signal.listenedMs ?? 0));
  const completionPct = signal.completionPct == null
    ? null
    : Math.max(0, Math.min(1, signal.completionPct));
  if (listenedMs === 0 && completionPct == null) return;

  await db().query(
    `insert into user_track_stats(
       user_id, track_id, play_count, skip_count, total_listened_ms, last_completion_pct
     )
     values ($1, $2, 0, 0, $3, $4)
     on conflict (user_id, track_id) do update set
       total_listened_ms = user_track_stats.total_listened_ms + excluded.total_listened_ms,
       last_completion_pct = coalesce(excluded.last_completion_pct, user_track_stats.last_completion_pct)`,
    [userId, trackId, listenedMs, completionPct],
  );
}

export async function topTracksByPlays(userId: string, limit: number, offset: number, allowedLibraries: number[] | null) {
  const where = allowedLibraries === null ? '' : `and t.library_id = any($4)`;
  const params = allowedLibraries === null ? [userId, limit, offset] : [userId, limit, offset, allowedLibraries];

  const r = await db().query(
    `
    select
      s.track_id as id,
      t.path,
      t.ext,
      t.title,
      t.artist,
      t.album,
      t.duration_ms,
      s.play_count,
      s.skip_count,
      s.last_played_at
    from user_track_stats s
    join active_tracks t on t.id = s.track_id
    where s.user_id = $1
    ${where}
    order by s.play_count desc, s.last_played_at desc nulls last
    limit $2 offset $3
    `,
    params as any
  );
  return r.rows;
}

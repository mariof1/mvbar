import { db } from './db.js';

export async function incPlay(userId: string, trackId: number) {
  await db().query(
    `
    insert into user_track_stats(user_id, track_id, play_count, skip_count, last_played_at)
    values ($1, $2, 1, 0, now())
    on conflict (user_id, track_id)
    do update set play_count = user_track_stats.play_count + 1, last_played_at = now()
    `,
    [userId, trackId]
  );
}

export async function incSkip(userId: string, trackId: number) {
  await db().query(
    `
    insert into user_track_stats(user_id, track_id, play_count, skip_count, last_skipped_at)
    values ($1, $2, 0, 1, now())
    on conflict (user_id, track_id)
    do update set skip_count = user_track_stats.skip_count + 1, last_skipped_at = now()
    `,
    [userId, trackId]
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

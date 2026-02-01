import { db } from './db.js';

export async function addPlay(userId: string, trackId: number) {
  await db().query('insert into play_history(user_id, track_id) values ($1, $2)', [userId, trackId]);
}

export async function listHistory(userId: string, limit: number, offset: number, allowedLibraries: number[] | null) {
  const where = allowedLibraries === null ? '' : `and t.library_id = any($4)`;
  const params = allowedLibraries === null ? [userId, limit, offset] : [userId, limit, offset, allowedLibraries];

  const r = await db().query(
    `
    select
      ph.track_id as id,
      t.path,
      t.ext,
      t.title,
      t.artist,
      t.album,
      t.duration_ms,
      ph.played_at
    from play_history ph
    join active_tracks t on t.id = ph.track_id
    where ph.user_id = $1
    ${where}
    order by ph.played_at desc
    limit $2 offset $3
    `,
    params as any
  );
  return r.rows;
}

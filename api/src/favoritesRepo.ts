import { db } from './db.js';

export async function addFavorite(userId: string, trackId: number) {
  await db().query(
    'insert into favorite_tracks(user_id, track_id) values ($1, $2) on conflict (user_id, track_id) do nothing',
    [userId, trackId]
  );
}

export async function removeFavorite(userId: string, trackId: number) {
  await db().query('delete from favorite_tracks where user_id=$1 and track_id=$2', [userId, trackId]);
}

export async function listFavorites(userId: string, limit: number, offset: number, allowedLibraries: number[] | null) {
  const where = allowedLibraries === null ? '' : `and t.library_id = any($4)`;
  const params = allowedLibraries === null ? [userId, limit, offset] : [userId, limit, offset, allowedLibraries];

  const r = await db().query(
    `select t.id, t.path, t.ext, t.title, t.artist, t.album, t.duration_ms, ft.added_at
     from favorite_tracks ft
     join active_tracks t on t.id = ft.track_id
     where ft.user_id=$1
     ${where}
     order by ft.added_at desc
     limit $2 offset $3`,
    params as any
  );
  return r.rows;
}

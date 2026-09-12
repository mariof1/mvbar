import { db } from './db.js';
import type { PoolClient } from 'pg';

// Serialize this user's mutations, including concurrent moves from other devices.
async function mutate<T>(userId: string, action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect();
  try {
    await client.query('begin');
    await client.query('select id from users where id=$1 for update', [userId]);
    const result = await action(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function addFavorite(userId: string, trackId: number) {
  await mutate(userId, client => client.query(
    'insert into favorite_tracks(user_id, track_id) values ($1, $2) on conflict (user_id, track_id) do nothing',
    [userId, trackId]
  ));
}

export async function addFavorites(userId: string, trackIds: number[]): Promise<number[]> {
  const uniqueTrackIds = [...new Set(trackIds.filter(id => Number.isSafeInteger(id) && id > 0))];
  if (uniqueTrackIds.length === 0) return [];

  return mutate(userId, async client => {
    const result = await client.query<{ track_id: string | number }>(
      `insert into favorite_tracks(user_id, track_id, added_at)
       select $1, track_id, statement_timestamp() - ((ordinality - 1) * interval '1 microsecond')
       from unnest($2::bigint[]) with ordinality as imported(track_id, ordinality)
       on conflict (user_id, track_id) do nothing
       returning track_id`,
      [userId, uniqueTrackIds],
    );
    return result.rows.map(row => Number(row.track_id));
  });
}

export async function removeFavorite(userId: string, trackId: number) {
  await mutate(userId, client => client.query('delete from favorite_tracks where user_id=$1 and track_id=$2', [userId, trackId]));
}

// Anchors support paginated clients without replacing or dropping unseen favorites.
export async function moveFavorite(userId: string, trackId: number, beforeTrackId: number | null) {
  return mutate(userId, async client => {
    const result = await client.query<{ track_id: number }>(
      'select track_id from favorite_tracks where user_id=$1 order by position asc nulls first, added_at desc, track_id desc',
      [userId]
    );
    const ids = result.rows.map(row => Number(row.track_id));
    if (!ids.includes(trackId) || (beforeTrackId !== null && !ids.includes(beforeTrackId))) return false;
    if (trackId === beforeTrackId) return true;
    ids.splice(ids.indexOf(trackId), 1);
    ids.splice(beforeTrackId === null ? ids.length : ids.indexOf(beforeTrackId), 0, trackId);
    await client.query(`update favorite_tracks f set position = ordered.ordinality - 1
      from unnest($2::bigint[]) with ordinality as ordered(track_id, ordinality)
      where f.user_id=$1 and f.track_id=ordered.track_id`, [userId, ids]);
    return true;
  });
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
     order by ft.position asc nulls first, ft.added_at desc, ft.track_id desc
     limit $2 offset $3`,
    params as any
  );
  return r.rows;
}

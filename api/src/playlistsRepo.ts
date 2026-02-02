import { db } from './db.js';

export type Playlist = { id: number; name: string; created_at: string };

export async function createPlaylist(userId: string, name: string) {
  const r = await db().query<Playlist>(
    'insert into playlists(user_id, name) values ($1, $2) returning id, name, created_at',
    [userId, name]
  );
  return r.rows[0]!;
}

export async function listPlaylists(userId: string) {
  const r = await db().query<Playlist>('select id, name, created_at from playlists where user_id=$1 order by id desc', [userId]);
  return r.rows;
}

export async function addItem(userId: string, playlistId: number, trackId: number, position?: number) {
  const owns = await db().query('select 1 from playlists where id=$1 and user_id=$2', [playlistId, userId]);
  if (owns.rowCount === 0) return null;

  const pos =
    typeof position === 'number'
      ? position
      : Number(
          (
            await db().query<{ p: number }>('select coalesce(max(position), -1) + 1 as p from playlist_items where playlist_id=$1', [
              playlistId
            ])
          ).rows[0]!.p
        );

  await db().query(
    'insert into playlist_items(playlist_id, track_id, position) values ($1, $2, $3) on conflict (playlist_id, track_id) do update set position=excluded.position',
    [playlistId, trackId, pos]
  );
  return { ok: true, position: pos };
}

export async function removeItem(userId: string, playlistId: number, trackId: number) {
  const owns = await db().query('select 1 from playlists where id=$1 and user_id=$2', [playlistId, userId]);
  if (owns.rowCount === 0) return null;
  await db().query('delete from playlist_items where playlist_id=$1 and track_id=$2', [playlistId, trackId]);
  return { ok: true };
}

export async function setPosition(userId: string, playlistId: number, trackId: number, position: number) {
  const owns = await db().query('select 1 from playlists where id=$1 and user_id=$2', [playlistId, userId]);
  if (owns.rowCount === 0) return null;

  await db().query('update playlist_items set position=$1 where playlist_id=$2 and track_id=$3', [position, playlistId, trackId]);
  return { ok: true };
}

export async function listItems(userId: string, playlistId: number) {
  const owns = await db().query('select 1 from playlists where id=$1 and user_id=$2', [playlistId, userId]);
  if (owns.rowCount === 0) return null;

  const r = await db().query<{
    id: number;
    track_id: number;
    position: number;
    title: string | null;
    artist: string | null;
    album: string | null;
    duration_ms: number | null;
  }>(
    `
    select
      t.id,
      pi.track_id,
      pi.position,
      t.title,
      t.artist,
      t.album,
      t.duration_ms
    from playlist_items pi
    join active_tracks t on t.id = pi.track_id
    where pi.playlist_id=$1
    order by pi.position asc, pi.track_id asc
  `,
    [playlistId]
  );

  return r.rows;
}

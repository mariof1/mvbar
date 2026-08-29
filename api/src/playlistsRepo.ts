import type { PoolClient } from 'pg';
import { db } from './db.js';

type Queryable = PoolClient | ReturnType<typeof db>;

export type PublicUser = {
  id: string;
  email: string;
  avatarPath: string | null;
};

export type Playlist = {
  id: number;
  name: string;
  created_at: string;
  item_count?: number;
  owner?: PublicUser;
  is_owner?: boolean;
  is_collaborative?: boolean;
  collaborator_count?: number;
};

type PublicUserRow = {
  id: string;
  email: string;
  avatar_path: string | null;
};

const playlistAccess = (playlistAlias: string, userParameter: string) => `(
  ${playlistAlias}.user_id=${userParameter}
  or exists (
    select 1
      from playlist_collaborators access_member
      join friendships access_friendship on access_friendship.id=access_member.friendship_id
     where access_member.playlist_id=${playlistAlias}.id
       and access_member.user_id=${userParameter}
       and access_friendship.status='accepted'
       and (
         (access_friendship.requester_id=${playlistAlias}.user_id and access_friendship.addressee_id=${userParameter})
         or (access_friendship.addressee_id=${playlistAlias}.user_id and access_friendship.requester_id=${userParameter})
       )
  )
)`;

function trackAccess(alias: string, allowedLibraries: number[] | null, params: unknown[]) {
  if (allowedLibraries === null) return 'true';
  params.push(allowedLibraries);
  return `${alias}.library_id=any($${params.length}::bigint[])`;
}

function toPublicUser(row: PublicUserRow): PublicUser {
  return { id: row.id, email: row.email, avatarPath: row.avatar_path };
}

export async function createPlaylist(userId: string, name: string) {
  const r = await db().query<Playlist>(
    'insert into playlists(user_id, name) values ($1, $2) returning id, name, created_at, 0::int as item_count',
    [userId, name]
  );
  return r.rows[0]!;
}

export async function listPlaylists(userId: string, allowedLibraries: number[] | null) {
  const params: unknown[] = [userId];
  const visibleTrack = trackAccess('track', allowedLibraries, params);
  const r = await db().query<Playlist>(
    `select
       p.id,
       p.name,
       p.created_at,
       coalesce((
         select count(*)::int
           from playlist_items item
           join active_tracks track on track.id=item.track_id
          where item.playlist_id=p.id and ${visibleTrack}
       ), 0)::int as item_count,
       json_build_object('id', owner.id, 'email', owner.email, 'avatarPath', owner.avatar_path) as owner,
       (p.user_id=$1) as is_owner,
       exists (
         select 1 from playlist_collaborators any_member where any_member.playlist_id=p.id
       ) as is_collaborative,
       coalesce((
         select count(*)::int
           from playlist_collaborators member
           join friendships friendship on friendship.id=member.friendship_id and friendship.status='accepted'
          where member.playlist_id=p.id
       ), 0)::int as collaborator_count
     from playlists p
     join users owner on owner.id=p.user_id
     where ${playlistAccess('p', '$1')}
     order by p.id desc`,
    params
  );
  return r.rows;
}

export async function playlistUserIds(playlistId: number) {
  const r = await db().query<{ user_id: string }>(
    `select p.user_id
       from playlists p
      where p.id=$1
     union
     select member.user_id
       from playlist_collaborators member
       join playlists p on p.id=member.playlist_id
       join friendships friendship on friendship.id=member.friendship_id
      where member.playlist_id=$1
        and friendship.status='accepted'
        and (
          (friendship.requester_id=p.user_id and friendship.addressee_id=member.user_id)
          or (friendship.addressee_id=p.user_id and friendship.requester_id=member.user_id)
        )`,
    [playlistId]
  );
  return r.rows.map((row) => row.user_id);
}

export async function addItem(
  userId: string,
  playlistId: number,
  trackId: number,
  allowedLibraries: number[] | null,
  position?: number
) {
  const client = await db().connect();
  try {
    await client.query('begin');
    const access = await client.query(
      `select p.id from playlists p where p.id=$1 and ${playlistAccess('p', '$2')} for update`,
      [playlistId, userId]
    );
    if (access.rowCount === 0) {
      await client.query('rollback');
      return null;
    }

    const trackParams: unknown[] = [trackId];
    const visibleTrack = trackAccess('track', allowedLibraries, trackParams);
    const track = await client.query(
      `select track.id from active_tracks track where track.id=$1 and ${visibleTrack}`,
      trackParams
    );
    if (track.rowCount === 0) {
      await client.query('rollback');
      return null;
    }

    const resolvedPosition = typeof position === 'number'
      ? position
      : Number((await client.query<{ position: number }>(
          'select coalesce(max(position), -1) + 1 as position from playlist_items where playlist_id=$1',
          [playlistId]
        )).rows[0]!.position);
    await client.query(
      `insert into playlist_items(playlist_id, track_id, position, added_by)
       values ($1, $2, $3, $4)
       on conflict (playlist_id, track_id) do update set
         position=excluded.position,
         added_by=coalesce(playlist_items.added_by, excluded.added_by)`,
      [playlistId, trackId, resolvedPosition, userId]
    );
    await client.query('commit');
    return { ok: true, position: resolvedPosition };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function removeItem(
  userId: string,
  playlistId: number,
  trackId: number,
  allowedLibraries: number[] | null
) {
  const params: unknown[] = [playlistId, trackId, userId];
  const visibleTrack = trackAccess('track', allowedLibraries, params);
  const r = await db().query(
    `delete from playlist_items item
      using playlists p, active_tracks track
      where item.playlist_id=$1
        and item.track_id=$2
        and p.id=item.playlist_id
        and track.id=item.track_id
        and ${playlistAccess('p', '$3')}
        and ${visibleTrack}
      returning item.track_id`,
    params
  );
  return r.rowCount ? { ok: true } : null;
}

export async function setPosition(
  userId: string,
  playlistId: number,
  trackId: number,
  position: number,
  allowedLibraries: number[] | null
) {
  const params: unknown[] = [position, playlistId, trackId, userId];
  const visibleTrack = trackAccess('track', allowedLibraries, params);
  const r = await db().query(
    `update playlist_items item set position=$1
       from playlists p, active_tracks track
      where item.playlist_id=$2
        and item.track_id=$3
        and p.id=item.playlist_id
        and track.id=item.track_id
        and ${playlistAccess('p', '$4')}
        and ${visibleTrack}
      returning item.track_id`,
    params
  );
  return r.rowCount ? { ok: true } : null;
}

export async function renamePlaylist(userId: string, playlistId: number, name: string) {
  const r = await db().query<Playlist>(
    `update playlists set name=$1 where id=$2 and user_id=$3
     returning id, name, created_at,
       (select coalesce(count(*),0)::int from playlist_items where playlist_id=playlists.id) as item_count`,
    [name, playlistId, userId]
  );
  return r.rows[0] ?? null;
}

export async function deletePlaylist(userId: string, playlistId: number) {
  const r = await db().query(
    'delete from playlists where id=$1 and user_id=$2 returning id',
    [playlistId, userId]
  );
  return r.rowCount! > 0;
}

export async function listItems(userId: string, playlistId: number, allowedLibraries: number[] | null) {
  const owns = await db().query(
    `select p.id from playlists p where p.id=$1 and ${playlistAccess('p', '$2')}`,
    [playlistId, userId]
  );
  if (owns.rowCount === 0) return null;

  const params: unknown[] = [playlistId, userId];
  const visibleTrack = trackAccess('t', allowedLibraries, params);
  const r = await db().query<{
    id: number;
    track_id: number;
    position: number;
    title: string | null;
    artist: string | null;
    album: string | null;
    duration_ms: number | null;
    added_at: string;
    added_by: PublicUser | null;
  }>(
    `select
       t.id,
       item.track_id,
       item.position,
       t.title,
       t.artist,
       t.album,
       t.duration_ms,
       item.added_at,
       case when contributor.id is null then null else
         json_build_object('id', contributor.id, 'email', contributor.email, 'avatarPath', contributor.avatar_path)
       end as added_by
     from playlist_items item
     join active_tracks t on t.id=item.track_id
     left join users contributor on contributor.id=item.added_by
     where item.playlist_id=$1
       and exists (
         select 1 from playlists p where p.id=$1 and ${playlistAccess('p', '$2')}
       )
       and ${visibleTrack}
     order by item.position asc, item.track_id asc`,
    params
  );

  return r.rows;
}

export async function getCollaboration(userId: string, playlistId: number) {
  const playlist = await db().query<PublicUserRow & { is_owner: boolean }>(
    `select owner.id, owner.email, owner.avatar_path, (p.user_id=$2) as is_owner
       from playlists p
       join users owner on owner.id=p.user_id
      where p.id=$1 and ${playlistAccess('p', '$2')}`,
    [playlistId, userId]
  );
  const row = playlist.rows[0];
  if (!row) return null;

  const collaborators = await db().query<PublicUserRow & { created_at: string }>(
    `select member_user.id, member_user.email, member_user.avatar_path, member.created_at
       from playlist_collaborators member
       join playlists p on p.id=member.playlist_id
       join friendships friendship on friendship.id=member.friendship_id and friendship.status='accepted'
       join users member_user on member_user.id=member.user_id
      where member.playlist_id=$1
        and (
          (friendship.requester_id=p.user_id and friendship.addressee_id=member.user_id)
          or (friendship.addressee_id=p.user_id and friendship.requester_id=member.user_id)
        )
      order by lower(member_user.email)`,
    [playlistId]
  );

  let eligibleFriends: PublicUser[] = [];
  if (row.is_owner) {
    const eligible = await db().query<PublicUserRow>(
      `select friend.id, friend.email, friend.avatar_path
         from friendships friendship
         join users friend on friend.id=case
           when friendship.requester_id=$1 then friendship.addressee_id else friendship.requester_id end
        where friendship.status='accepted'
          and (friendship.requester_id=$1 or friendship.addressee_id=$1)
          and coalesce(friend.approval_status, 'approved')='approved'
          and not exists (
            select 1 from playlist_collaborators member
             where member.playlist_id=$2 and member.user_id=friend.id
          )
        order by lower(friend.email)`,
      [userId, playlistId]
    );
    eligibleFriends = eligible.rows.map(toPublicUser);
  }

  return {
    owner: toPublicUser(row),
    isOwner: row.is_owner,
    collaborators: collaborators.rows.map((member) => ({
      user: toPublicUser(member),
      addedAt: member.created_at,
    })),
    eligibleFriends,
  };
}

export async function addCollaborator(ownerId: string, playlistId: number, userId: string) {
  const inserted = await db().query<{ created_at: string }>(
    `insert into playlist_collaborators(playlist_id, user_id, friendship_id, added_by)
     select p.id, friend.id, friendship.id, $1
       from playlists p
       join users friend on friend.id=$3 and coalesce(friend.approval_status, 'approved')='approved'
       join friendships friendship on friendship.status='accepted' and (
         (friendship.requester_id=$1 and friendship.addressee_id=friend.id)
         or (friendship.addressee_id=$1 and friendship.requester_id=friend.id)
       )
      where p.id=$2 and p.user_id=$1 and friend.id<>$1
     on conflict (playlist_id, user_id) do nothing
     returning created_at`,
    [ownerId, playlistId, userId]
  );
  if (!inserted.rows[0]) return null;
  const user = await db().query<PublicUserRow>('select id, email, avatar_path from users where id=$1', [userId]);
  return {
    user: toPublicUser(user.rows[0]!),
    addedAt: inserted.rows[0].created_at,
  };
}

export async function removeCollaborator(requesterId: string, playlistId: number, userId: string) {
  const removed = await db().query<{ owner_id: string; user_id: string }>(
    `delete from playlist_collaborators member
      using playlists p
      where member.playlist_id=$1
        and member.user_id=$2
        and p.id=member.playlist_id
        and (p.user_id=$3 or member.user_id=$3)
      returning p.user_id as owner_id, member.user_id`,
    [playlistId, userId, requesterId]
  );
  return removed.rows[0] ?? null;
}

export async function collaborationPlaylistIds(friendshipId: number, client: Queryable = db()) {
  const result = await client.query<{ playlist_id: string | number }>(
    'select playlist_id from playlist_collaborators where friendship_id=$1',
    [friendshipId]
  );
  return result.rows.map((row) => Number(row.playlist_id));
}

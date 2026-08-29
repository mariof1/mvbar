import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import type { PoolClient } from 'pg';
import { allowedLibrariesForUser, isLibraryAllowed } from './access.js';
import { audit, db } from './db.js';
import { broadcastToUser } from './websocket.js';

type PublicUserRow = {
  id: string;
  email: string;
  avatar_path: string | null;
};

type FriendshipRow = {
  id: string | number;
  requester_id: string;
  addressee_id: string;
  status: 'pending' | 'accepted';
  created_at: string;
  responded_at: string | null;
  user_id: string;
  email: string;
  avatar_path: string | null;
};

type ShareTrackRow = {
  id: string | number;
  track_id: string | number;
  title: string | null;
  artist: string | null;
  album: string | null;
  duration_ms: number | null;
  art_path: string | null;
  art_hash: string | null;
  sender_id: string;
  sender_email: string;
  sender_avatar_path: string | null;
  message: string | null;
  created_at: string;
  read_at: string | null;
};

function publicUser(row: PublicUserRow) {
  return { id: row.id, email: row.email, avatarPath: row.avatar_path };
}

export function normalizeSocialSearch(value: unknown) {
  return typeof value === 'string' ? value.trim().slice(0, 100) : '';
}

export function normalizeShareMessage(value: unknown) {
  if (typeof value !== 'string') return null;
  const message = value.trim().slice(0, 500);
  return message || null;
}

export function normalizeRecipientIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((id): id is string => typeof id === 'string' && id.length > 0))).slice(0, 20);
}

function friendshipPayload(row: FriendshipRow) {
  return {
    relationshipId: Number(row.id),
    user: publicUser({ id: row.user_id, email: row.email, avatar_path: row.avatar_path }),
    createdAt: row.created_at,
    respondedAt: row.responded_at,
  };
}

async function getOwnPublicUser(client: PoolClient | ReturnType<typeof db>, userId: string) {
  const result = await client.query<PublicUserRow>(
    'select id, email, avatar_path from users where id=$1',
    [userId],
  );
  return result.rows[0] ?? null;
}

async function findFriendship(client: PoolClient | ReturnType<typeof db>, userId: string, otherUserId: string) {
  const result = await client.query<{ id: string | number; requester_id: string; addressee_id: string; status: 'pending' | 'accepted' }>(
    `select id, requester_id, addressee_id, status
       from friendships
      where (requester_id=$1 and addressee_id=$2)
         or (requester_id=$2 and addressee_id=$1)
      limit 1`,
    [userId, otherUserId],
  );
  return result.rows[0] ?? null;
}

async function requireVisibleTrack(userId: string, role: 'admin' | 'user', trackId: number) {
  const result = await db().query<{
    id: string | number;
    library_id: string | number;
    title: string | null;
    artist: string | null;
    album: string | null;
  }>(
    'select id, library_id, title, artist, album from active_tracks where id=$1',
    [trackId],
  );
  const track = result.rows[0];
  if (!track) return null;
  const allowed = await allowedLibrariesForUser(userId, role);
  return isLibraryAllowed(Number(track.library_id), allowed) ? track : null;
}

async function shareTargets(userId: string, trackId: number) {
  const result = await db().query<PublicUserRow & { can_access: boolean }>(
    `select
       friend.id,
       friend.email,
       friend.avatar_path,
       (
         friend.role = 'admin'
         or exists (
           select 1 from user_libraries ul
            where ul.user_id = friend.id and ul.library_id = track.library_id
         )
       ) as can_access
     from friendships f
     join users friend on friend.id = case when f.requester_id=$1 then f.addressee_id else f.requester_id end
     join active_tracks track on track.id=$2
     where f.status='accepted' and (f.requester_id=$1 or f.addressee_id=$1)
     order by lower(friend.email)`,
    [userId, trackId],
  );
  return result.rows.map((row) => ({ ...publicUser(row), canAccess: row.can_access }));
}

export const socialPlugin: FastifyPluginAsync = fp(async (app) => {
  app.get('/api/social/summary', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });

    const relationships = await db().query<FriendshipRow>(
      `select
         f.id, f.requester_id, f.addressee_id, f.status, f.created_at, f.responded_at,
         friend.id as user_id, friend.email, friend.avatar_path
       from friendships f
       join users friend on friend.id = case when f.requester_id=$1 then f.addressee_id else f.requester_id end
       where f.requester_id=$1 or f.addressee_id=$1
       order by f.created_at desc`,
      [req.user.userId],
    );
    const allowed = await allowedLibrariesForUser(req.user.userId, req.user.role);
    const accessSql = allowed === null ? '' : 'and track.library_id = any($2::bigint[])';
    const accessParams = allowed === null ? [req.user.userId] : [req.user.userId, allowed];
    const unread = await db().query<{ count: number }>(
      `select count(*)::int as count
         from track_shares share
         join active_tracks track on track.id=share.track_id
        where share.recipient_id=$1 and share.read_at is null ${accessSql}`,
      accessParams,
    );

    const friends = relationships.rows
      .filter((row) => row.status === 'accepted')
      .map(friendshipPayload);
    const incoming = relationships.rows
      .filter((row) => row.status === 'pending' && row.addressee_id === req.user!.userId)
      .map(friendshipPayload);
    const outgoing = relationships.rows
      .filter((row) => row.status === 'pending' && row.requester_id === req.user!.userId)
      .map(friendshipPayload);

    return { ok: true, friends, incoming, outgoing, unreadShares: unread.rows[0]?.count ?? 0 };
  });

  app.get('/api/social/users', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const query = normalizeSocialSearch((req.query as { q?: string }).q);
    if (query.length < 2) return { ok: true, users: [] };
    const escaped = query.replace(/[\\%_]/g, '\\$&');
    const users = await db().query<PublicUserRow & {
      relationship_id: string | number | null;
      requester_id: string | null;
      relationship_status: 'pending' | 'accepted' | null;
    }>(
      `select
         candidate.id, candidate.email, candidate.avatar_path,
         friendship.id as relationship_id,
         friendship.requester_id,
         friendship.status as relationship_status
       from users candidate
       left join friendships friendship
         on (friendship.requester_id=$1 and friendship.addressee_id=candidate.id)
         or (friendship.addressee_id=$1 and friendship.requester_id=candidate.id)
       where candidate.id <> $1
         and coalesce(candidate.approval_status, 'approved')='approved'
         and candidate.email ilike $2 escape '\\'
       order by case when lower(candidate.email)=lower($3) then 0 else 1 end, lower(candidate.email)
       limit 20`,
      [req.user.userId, `%${escaped}%`, query],
    );
    return {
      ok: true,
      users: users.rows.map((row) => ({
        ...publicUser(row),
        relationshipId: row.relationship_id === null ? null : Number(row.relationship_id),
        relationship: row.relationship_status === 'accepted'
          ? 'friend'
          : row.relationship_status === 'pending'
            ? (row.requester_id === req.user!.userId ? 'outgoing' : 'incoming')
            : 'none',
      })),
    };
  });

  app.post('/api/social/friend-requests', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const userId = typeof (req.body as { userId?: unknown })?.userId === 'string'
      ? String((req.body as { userId: string }).userId)
      : '';
    if (!userId || userId === req.user.userId) {
      return reply.code(400).send({ ok: false, error: 'invalid_user' });
    }

    const target = await db().query<PublicUserRow>(
      "select id, email, avatar_path from users where id=$1 and coalesce(approval_status, 'approved')='approved'",
      [userId],
    );
    if (!target.rows[0]) return reply.code(404).send({ ok: false, error: 'user_not_found' });

    const existing = await findFriendship(db(), req.user.userId, userId);
    if (existing) {
      const error = existing.status === 'accepted'
        ? 'already_friends'
        : existing.requester_id === req.user.userId ? 'request_pending' : 'incoming_request';
      return reply.code(409).send({ ok: false, error, relationshipId: Number(existing.id) });
    }

    try {
      const inserted = await db().query<{ id: string | number; created_at: string }>(
        `insert into friendships(requester_id, addressee_id)
         values ($1,$2) returning id, created_at`,
        [req.user.userId, userId],
      );
      const sender = await getOwnPublicUser(db(), req.user.userId);
      const request = {
        relationshipId: Number(inserted.rows[0].id),
        user: sender ? publicUser(sender) : { id: req.user.userId, email: '', avatarPath: null },
        createdAt: inserted.rows[0].created_at,
        respondedAt: null,
      };
      broadcastToUser(userId, 'social:friend_request', request);
      await audit('friend_request_sent', { by: req.user.userId, to: userId, relationshipId: request.relationshipId });
      return reply.code(201).send({ ok: true, request });
    } catch (error: any) {
      if (error?.code === '23505') {
        return reply.code(409).send({ ok: false, error: 'request_exists' });
      }
      throw error;
    }
  });

  app.post('/api/social/friend-requests/:id/accept', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const relationshipId = Number((req.params as { id: string }).id);
    if (!Number.isInteger(relationshipId) || relationshipId <= 0) {
      return reply.code(400).send({ ok: false, error: 'invalid_request' });
    }
    const accepted = await db().query<{ requester_id: string }>(
      `update friendships set status='accepted', responded_at=now()
        where id=$1 and addressee_id=$2 and status='pending'
        returning requester_id`,
      [relationshipId, req.user.userId],
    );
    const requesterId = accepted.rows[0]?.requester_id;
    if (!requesterId) return reply.code(404).send({ ok: false, error: 'request_not_found' });
    const user = await getOwnPublicUser(db(), req.user.userId);
    broadcastToUser(requesterId, 'social:friend_accepted', {
      relationshipId,
      user: user ? publicUser(user) : { id: req.user.userId, email: '', avatarPath: null },
    });
    await audit('friend_request_accepted', { by: req.user.userId, from: requesterId, relationshipId });
    return { ok: true };
  });

  app.delete('/api/social/friend-requests/:id', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const relationshipId = Number((req.params as { id: string }).id);
    if (!Number.isInteger(relationshipId) || relationshipId <= 0) {
      return reply.code(400).send({ ok: false, error: 'invalid_request' });
    }
    const removed = await db().query<{ requester_id: string; addressee_id: string }>(
      `delete from friendships
        where id=$1 and status='pending' and (requester_id=$2 or addressee_id=$2)
        returning requester_id, addressee_id`,
      [relationshipId, req.user.userId],
    );
    const relationship = removed.rows[0];
    if (!relationship) return reply.code(404).send({ ok: false, error: 'request_not_found' });
    const otherUserId = relationship.requester_id === req.user.userId
      ? relationship.addressee_id
      : relationship.requester_id;
    broadcastToUser(otherUserId, 'social:friend_request_removed', { relationshipId });
    await audit('friend_request_removed', { by: req.user.userId, relationshipId });
    return { ok: true };
  });

  app.delete('/api/social/friends/:userId', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const otherUserId = String((req.params as { userId: string }).userId || '');
    if (!otherUserId || otherUserId === req.user.userId) {
      return reply.code(400).send({ ok: false, error: 'invalid_user' });
    }
    const removed = await db().query<{ id: string | number }>(
      `delete from friendships
        where status='accepted'
          and ((requester_id=$1 and addressee_id=$2) or (requester_id=$2 and addressee_id=$1))
        returning id`,
      [req.user.userId, otherUserId],
    );
    if (!removed.rows[0]) return reply.code(404).send({ ok: false, error: 'friend_not_found' });
    broadcastToUser(otherUserId, 'social:friend_removed', { userId: req.user.userId });
    await audit('friend_removed', { by: req.user.userId, otherUserId });
    return { ok: true };
  });

  app.get('/api/social/share-targets/:trackId', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const trackId = Number((req.params as { trackId: string }).trackId);
    if (!Number.isInteger(trackId) || trackId <= 0) {
      return reply.code(400).send({ ok: false, error: 'invalid_track' });
    }
    const track = await requireVisibleTrack(req.user.userId, req.user.role, trackId);
    if (!track) return reply.code(404).send({ ok: false, error: 'track_not_found' });
    return { ok: true, friends: await shareTargets(req.user.userId, trackId) };
  });

  app.post('/api/social/shares', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const body = req.body as { trackId?: unknown; recipientIds?: unknown; message?: unknown };
    const trackId = Number(body?.trackId);
    const recipientIds = normalizeRecipientIds(body?.recipientIds);
    const message = normalizeShareMessage(body?.message);
    if (!Number.isInteger(trackId) || trackId <= 0 || recipientIds.length === 0) {
      return reply.code(400).send({ ok: false, error: 'invalid_share' });
    }
    if (recipientIds.includes(req.user.userId)) {
      return reply.code(400).send({ ok: false, error: 'invalid_recipient' });
    }

    const track = await requireVisibleTrack(req.user.userId, req.user.role, trackId);
    if (!track) return reply.code(404).send({ ok: false, error: 'track_not_found' });
    const targets = await shareTargets(req.user.userId, trackId);
    const eligible = new Map(targets.filter((target) => target.canAccess).map((target) => [target.id, target]));
    const invalidRecipientIds = recipientIds.filter((id) => !eligible.has(id));
    if (invalidRecipientIds.length > 0) {
      return reply.code(409).send({ ok: false, error: 'recipient_unavailable', userIds: invalidRecipientIds });
    }

    const client = await db().connect();
    const shares: Array<{ id: number; recipientId: string }> = [];
    try {
      await client.query('begin');
      for (const recipientId of recipientIds) {
        const inserted = await client.query<{ id: string | number }>(
          `insert into track_shares(sender_id, recipient_id, track_id, message)
           select $1, recipient.id, track.id, $4
             from users recipient
             join active_tracks track on track.id=$3
            where recipient.id=$2
              and (
                recipient.role='admin'
                or exists (
                  select 1 from user_libraries ul
                   where ul.user_id=recipient.id and ul.library_id=track.library_id
                )
              )
              and exists (
                select 1 from friendships friendship
                 where friendship.status='accepted'
                   and (
                     (friendship.requester_id=$1 and friendship.addressee_id=recipient.id)
                     or (friendship.addressee_id=$1 and friendship.requester_id=recipient.id)
                   )
              )
           on conflict (sender_id, recipient_id, track_id) do update set
             message=excluded.message, created_at=now(), read_at=null
           returning id`,
          [req.user.userId, recipientId, trackId, message],
        );
        if (!inserted.rows[0]) {
          throw Object.assign(new Error('Recipient is no longer available'), { code: 'RECIPIENT_UNAVAILABLE' });
        }
        shares.push({ id: Number(inserted.rows[0].id), recipientId });
      }
      await client.query('commit');
    } catch (error: any) {
      await client.query('rollback');
      if (error?.code === 'RECIPIENT_UNAVAILABLE') {
        return reply.code(409).send({ ok: false, error: 'recipient_unavailable' });
      }
      throw error;
    } finally {
      client.release();
    }

    const sender = await getOwnPublicUser(db(), req.user.userId);
    for (const share of shares) {
      broadcastToUser(share.recipientId, 'social:track_shared', {
        shareId: share.id,
        sender: sender ? publicUser(sender) : { id: req.user.userId, email: '', avatarPath: null },
        track: {
          id: Number(track.id),
          title: track.title,
          artist: track.artist,
          album: track.album,
        },
        message,
      });
    }
    await audit('track_shared', { by: req.user.userId, trackId, recipientIds });
    return reply.code(201).send({ ok: true, shared: shares.length });
  });

  app.get('/api/social/shares', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const query = req.query as { limit?: string; offset?: string };
    const limit = Math.min(100, Math.max(1, Math.trunc(Number(query.limit) || 50)));
    const offset = Math.max(0, Math.trunc(Number(query.offset) || 0));
    const allowed = await allowedLibrariesForUser(req.user.userId, req.user.role);
    const accessSql = allowed === null ? '' : 'and track.library_id = any($4::bigint[])';
    const params = allowed === null
      ? [req.user.userId, limit, offset]
      : [req.user.userId, limit, offset, allowed];
    const result = await db().query<ShareTrackRow>(
      `select
         share.id, share.track_id, share.message, share.created_at, share.read_at,
         track.title, track.artist, track.album, track.duration_ms, track.art_path, track.art_hash,
         sender.id as sender_id, sender.email as sender_email, sender.avatar_path as sender_avatar_path
       from track_shares share
       join active_tracks track on track.id=share.track_id
       join users sender on sender.id=share.sender_id
       where share.recipient_id=$1 ${accessSql}
       order by share.created_at desc
       limit $2 offset $3`,
      params,
    );
    const countParams = allowed === null ? [req.user.userId] : [req.user.userId, allowed];
    const countAccessSql = allowed === null ? '' : 'and track.library_id = any($2::bigint[])';
    const counts = await db().query<{ total: number; unread: number }>(
      `select count(*)::int as total, count(*) filter (where share.read_at is null)::int as unread
       from track_shares share join active_tracks track on track.id=share.track_id
       where share.recipient_id=$1 ${countAccessSql}`,
      countParams,
    );
    return {
      ok: true,
      shares: result.rows.map((row) => ({
        id: Number(row.id),
        track: {
          id: Number(row.track_id),
          title: row.title,
          artist: row.artist,
          album: row.album,
          durationMs: row.duration_ms,
          artPath: row.art_path,
          artHash: row.art_hash,
        },
        sender: {
          id: row.sender_id,
          email: row.sender_email,
          avatarPath: row.sender_avatar_path,
        },
        message: row.message,
        createdAt: row.created_at,
        readAt: row.read_at,
      })),
      total: counts.rows[0]?.total ?? 0,
      unread: counts.rows[0]?.unread ?? 0,
      limit,
      offset,
    };
  });

  app.post('/api/social/shares/:id/read', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const shareId = Number((req.params as { id: string }).id);
    if (!Number.isInteger(shareId) || shareId <= 0) {
      return reply.code(400).send({ ok: false, error: 'invalid_share' });
    }
    const result = await db().query(
      'update track_shares set read_at=coalesce(read_at, now()) where id=$1 and recipient_id=$2 returning id',
      [shareId, req.user.userId],
    );
    if (!result.rows[0]) return reply.code(404).send({ ok: false, error: 'share_not_found' });
    broadcastToUser(req.user.userId, 'social:share_read', { shareId });
    return { ok: true };
  });

  app.post('/api/social/shares/read-all', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const result = await db().query(
      'update track_shares set read_at=now() where recipient_id=$1 and read_at is null',
      [req.user.userId],
    );
    broadcastToUser(req.user.userId, 'social:shares_read_all', {});
    return { ok: true, updated: result.rowCount ?? 0 };
  });

  app.delete('/api/social/shares/:id', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const shareId = Number((req.params as { id: string }).id);
    if (!Number.isInteger(shareId) || shareId <= 0) {
      return reply.code(400).send({ ok: false, error: 'invalid_share' });
    }
    const result = await db().query(
      'delete from track_shares where id=$1 and recipient_id=$2 returning id',
      [shareId, req.user.userId],
    );
    if (!result.rows[0]) return reply.code(404).send({ ok: false, error: 'share_not_found' });
    broadcastToUser(req.user.userId, 'social:share_removed', { shareId });
    return { ok: true };
  });
});

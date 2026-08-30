import type { FastifyRequest } from 'fastify';
import { clientInfoFromRequest } from './clientInfo.js';
import { db } from './db.js';

const MAX_CONTIGUOUS_DELTA_MS = 15 * 60_000;
const MAX_BUCKET_LISTENING_MS = 30 * 60_000;

export function boundedPosition(value: unknown, durationMs: number | null) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const position = Math.trunc(value);
  const upperBound = durationMs && durationMs > 0
    ? Math.min(durationMs, 2_147_483_647)
    : 2_147_483_647;
  return Math.min(position, upperBound);
}

export function continuousListeningDelta(previousMs: number | null, nextMs: number) {
  if (previousMs == null) return Math.min(nextMs, MAX_CONTIGUOUS_DELTA_MS);
  const delta = nextMs - previousMs;
  return delta > 0 && delta <= MAX_CONTIGUOUS_DELTA_MS ? delta : 0;
}

export async function recordMediaActivity(params: {
  req: FastifyRequest;
  mediaType: 'podcast' | 'audiobook';
  itemId: number;
  parentId?: number | null;
  positionMs: number;
  listenedMs: number;
  completed: boolean;
}) {
  if (params.listenedMs <= 0 && !params.completed) return;
  const client = clientInfoFromRequest(params.req);
  await db().query(
    `
    insert into media_activity (
      user_id, media_type, item_id, parent_id, event_type,
      position_ms, listened_ms, bucket_start, updated_at,
      ip, client_type, client_id
    )
    values (
      $1, $2, $3, $4, $5, $6, $7,
      date_bin('5 minutes', now(), timestamptz '2001-01-01'),
      now(), $8, $9, $10
    )
    on conflict (user_id, media_type, item_id, bucket_start) do update set
      parent_id = coalesce(excluded.parent_id, media_activity.parent_id),
      event_type = case
        when excluded.event_type = 'completed' then 'completed'
        else media_activity.event_type
      end,
      position_ms = excluded.position_ms,
      listened_ms = least(
        media_activity.listened_ms + excluded.listened_ms,
        $11::bigint
      ),
      updated_at = now(),
      ip = excluded.ip,
      client_type = excluded.client_type,
      client_id = excluded.client_id
    `,
    [
      params.req.user!.userId,
      params.mediaType,
      params.itemId,
      params.parentId ?? null,
      params.completed ? 'completed' : 'progress',
      params.positionMs,
      Math.max(0, Math.trunc(params.listenedMs)),
      params.req.ip,
      client.type,
      client.id,
      MAX_BUCKET_LISTENING_MS,
    ]
  );
}

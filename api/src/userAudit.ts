import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { db } from './db.js';
import type { Role } from './store.js';

type AuditSummaryRow = {
  id: string;
  email: string;
  role: Role;
  approval_status: string;
  avatar_path: string | null;
  created_at: Date | string;
  last_login_at: Date | string | null;
  last_login_ip: string | null;
  login_count: number | string;
  last_played_at: Date | string | null;
  total_plays: number | string;
  plays_7d: number | string;
  estimated_listening_ms: number | string;
  favorite_count: number | string;
  playlist_count: number | string;
};

export function boundedAuditPage(
  query: { limit?: string; offset?: string },
  defaults = { limit: 25, maxLimit: 100 }
) {
  const parsedLimit = Number(query.limit);
  const parsedOffset = Number(query.offset);
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(defaults.maxLimit, Math.max(1, Math.trunc(parsedLimit)))
    : defaults.limit;
  const offset = Number.isFinite(parsedOffset) ? Math.max(0, Math.trunc(parsedOffset)) : 0;
  return { limit, offset };
}

function normalizeSummary(row: AuditSummaryRow) {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    approvalStatus: row.approval_status,
    avatarPath: row.avatar_path,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    lastLoginIp: row.last_login_ip,
    loginCount: Number(row.login_count),
    lastPlayedAt: row.last_played_at,
    totalPlays: Number(row.total_plays),
    plays7d: Number(row.plays_7d),
    estimatedListeningMs: Number(row.estimated_listening_ms),
    favoriteCount: Number(row.favorite_count),
    playlistCount: Number(row.playlist_count),
  };
}

async function listSummaries(userId: string | null = null) {
  const result = await db().query<AuditSummaryRow>(
    `
    with login_stats as (
      select
        lower(meta->>'email') as email,
        max(ts) as last_login_at,
        (array_agg(meta->>'ip' order by ts desc))[1] as last_login_ip,
        count(*)::int as login_count
      from audit_events
      where event = 'login_ok' and meta ? 'email'
      group by lower(meta->>'email')
    ),
    play_stats as (
      select
        ph.user_id,
        max(ph.played_at) as last_played_at,
        count(*)::int as total_plays,
        count(*) filter (where ph.played_at >= now() - interval '7 days')::int as plays_7d,
        coalesce(sum(coalesce(t.duration_ms, 0)), 0)::float8 as estimated_listening_ms
      from play_history ph
      left join tracks t on t.id = ph.track_id
      group by ph.user_id
    ),
    favorite_stats as (
      select user_id, count(*)::int as favorite_count
      from favorite_tracks
      group by user_id
    ),
    playlist_stats as (
      select user_id, count(*)::int as playlist_count
      from playlists
      group by user_id
    )
    select
      u.id,
      u.email,
      u.role,
      u.approval_status,
      u.avatar_path,
      u.created_at,
      login_stats.last_login_at,
      login_stats.last_login_ip,
      coalesce(login_stats.login_count, 0) as login_count,
      play_stats.last_played_at,
      coalesce(play_stats.total_plays, 0) as total_plays,
      coalesce(play_stats.plays_7d, 0) as plays_7d,
      coalesce(play_stats.estimated_listening_ms, 0) as estimated_listening_ms,
      coalesce(favorite_stats.favorite_count, 0) as favorite_count,
      coalesce(playlist_stats.playlist_count, 0) as playlist_count
    from users u
    left join login_stats on login_stats.email = lower(u.email)
    left join play_stats on play_stats.user_id = u.id
    left join favorite_stats on favorite_stats.user_id = u.id
    left join playlist_stats on playlist_stats.user_id = u.id
    where ($1::text is null or u.id = $1)
    order by greatest(login_stats.last_login_at, play_stats.last_played_at) desc nulls last, u.created_at asc
    `,
    [userId]
  );
  return result.rows.map(normalizeSummary);
}

export const userAuditPlugin: FastifyPluginAsync = fp(async (app) => {
  app.get('/api/admin/user-audit', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ ok: false });

    const users = await listSummaries();
    return {
      ok: true,
      users,
      totals: {
        users: users.length,
        active7d: users.filter((user) => {
          const mostRecent = [user.lastLoginAt, user.lastPlayedAt]
            .filter((value): value is Date | string => Boolean(value))
            .map((value) => new Date(value).getTime())
            .sort((a, b) => b - a)[0];
          return Number.isFinite(mostRecent) && mostRecent >= Date.now() - 7 * 24 * 60 * 60 * 1000;
        }).length,
        plays7d: users.reduce((sum, user) => sum + user.plays7d, 0),
        estimatedListeningMs: users.reduce((sum, user) => sum + user.estimatedListeningMs, 0),
      },
    };
  });

  app.get('/api/admin/users/:id/audit', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ ok: false });

    const { id } = req.params as { id: string };
    const { limit, offset } = boundedAuditPage(req.query as { limit?: string; offset?: string });
    const summaries = await listSummaries(id);
    const user = summaries[0];
    if (!user) return reply.code(404).send({ ok: false });

    const [historyResult, countResult, signInResult, dailyResult] = await Promise.all([
      db().query<{
        history_id: number | string;
        track_id: number | string;
        title: string | null;
        artist: string | null;
        album: string | null;
        duration_ms: number | null;
        played_at: Date | string;
      }>(
        `
        select
          ph.id as history_id,
          ph.track_id,
          t.title,
          t.artist,
          t.album,
          t.duration_ms,
          ph.played_at
        from play_history ph
        join tracks t on t.id = ph.track_id
        where ph.user_id = $1
        order by ph.played_at desc
        limit $2 offset $3
        `,
        [id, limit, offset]
      ),
      db().query<{ count: number | string }>(
        'select count(*)::int as count from play_history where user_id = $1',
        [id]
      ),
      db().query<{ ts: Date | string; event: string; ip: string | null }>(
        `
        select ts, event, meta->>'ip' as ip
        from audit_events
        where event in ('login_ok', 'login_failed', 'login_locked')
          and lower(meta->>'email') = lower($1)
        order by ts desc
        limit 20
        `,
        [user.email]
      ),
      db().query<{ date: string; count: number | string }>(
        `
        with days as (
          select generate_series(current_date - 13, current_date, interval '1 day')::date as day
        ),
        plays as (
          select played_at::date as day, count(*)::int as count
          from play_history
          where user_id = $1 and played_at >= current_date - interval '13 days'
          group by played_at::date
        )
        select to_char(days.day, 'YYYY-MM-DD') as date, coalesce(plays.count, 0)::int as count
        from days
        left join plays on plays.day = days.day
        order by days.day
        `,
        [id]
      ),
    ]);

    return {
      ok: true,
      user,
      history: historyResult.rows.map((row) => ({
        historyId: Number(row.history_id),
        trackId: Number(row.track_id),
        title: row.title,
        artist: row.artist,
        album: row.album,
        durationMs: row.duration_ms,
        playedAt: row.played_at,
      })),
      historyTotal: Number(countResult.rows[0]?.count ?? 0),
      signIns: signInResult.rows.map((row) => ({ ts: row.ts, event: row.event, ip: row.ip })),
      dailyPlays: dailyResult.rows.map((row) => ({ date: row.date, count: Number(row.count) })),
      limit,
      offset,
    };
  });
});

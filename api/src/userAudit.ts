import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { db } from './db.js';
import type { Role } from './store.js';

type AuditSummaryRow = {
  id: string;
  email: string;
  role: Role;
  auth_provider: 'google' | 'google_password' | 'password';
  approval_status: string;
  avatar_path: string | null;
  created_at: Date | string;
  last_active_at: Date | string | null;
  last_active_ip: string | null;
  last_login_at: Date | string | null;
  last_login_ip: string | null;
  login_count: number | string;
  last_played_at: Date | string | null;
  last_podcast_at: Date | string | null;
  last_audiobook_at: Date | string | null;
  last_listened_at: Date | string | null;
  total_plays: number | string;
  plays_7d: number | string;
  podcast_episode_count: number | string;
  podcast_completed_count: number | string;
  podcasts_7d: number | string;
  audiobook_count: number | string;
  audiobook_completed_count: number | string;
  audiobooks_7d: number | string;
  activity_7d: number | string;
  music_listening_ms: number | string;
  podcast_listening_ms: number | string;
  audiobook_listening_ms: number | string;
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
    authProvider: row.auth_provider,
    approvalStatus: row.approval_status,
    avatarPath: row.avatar_path,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    lastActiveIp: row.last_active_ip,
    lastLoginAt: row.last_login_at,
    lastLoginIp: row.last_login_ip,
    loginCount: Number(row.login_count),
    lastPlayedAt: row.last_played_at,
    lastPodcastAt: row.last_podcast_at,
    lastAudiobookAt: row.last_audiobook_at,
    lastListenedAt: row.last_listened_at,
    totalPlays: Number(row.total_plays),
    plays7d: Number(row.plays_7d),
    podcastEpisodeCount: Number(row.podcast_episode_count),
    podcastCompletedCount: Number(row.podcast_completed_count),
    podcasts7d: Number(row.podcasts_7d),
    audiobookCount: Number(row.audiobook_count),
    audiobookCompletedCount: Number(row.audiobook_completed_count),
    audiobooks7d: Number(row.audiobooks_7d),
    activity7d: Number(row.activity_7d),
    musicListeningMs: Number(row.music_listening_ms),
    podcastListeningMs: Number(row.podcast_listening_ms),
    audiobookListeningMs: Number(row.audiobook_listening_ms),
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
        coalesce(sum(coalesce(t.duration_ms, 0)), 0)::float8 as music_listening_ms
      from play_history ph
      left join tracks t on t.id = ph.track_id
      group by ph.user_id
    ),
    podcast_stats as (
      select
        uep.user_id,
        max(uep.updated_at) filter (where uep.position_ms > 0 or uep.played) as last_podcast_at,
        (count(*) filter (where uep.position_ms > 0 or uep.played))::int as podcast_episode_count,
        (count(*) filter (where uep.played))::int as podcast_completed_count,
        (count(*) filter (
          where (uep.position_ms > 0 or uep.played)
            and uep.updated_at >= now() - interval '7 days'
        ))::int as podcasts_7d,
        coalesce(sum(
          case
            when pe.duration_ms is not null and pe.duration_ms > 0 then
              least(pe.duration_ms, greatest(uep.position_ms, case when uep.played then pe.duration_ms else 0 end))
            else greatest(uep.position_ms, 0)
          end
        ) filter (where uep.position_ms > 0 or uep.played), 0)::float8 as podcast_listening_ms
      from user_episode_progress uep
      join podcast_episodes pe on pe.id = uep.episode_id
      group by uep.user_id
    ),
    audiobook_progress_rows as (
      select
        uap.user_id,
        uap.updated_at,
        uap.finished,
        case
          when uap.finished and a.duration_ms > 0 then a.duration_ms
          when a.duration_ms > 0 then least(
            a.duration_ms,
            coalesce(previous.duration_ms, 0) + greatest(uap.position_ms, 0)
          )
          else coalesce(previous.duration_ms, 0) + greatest(uap.position_ms, 0)
        end as estimated_listening_ms
      from user_audiobook_progress uap
      join audiobooks a on a.id = uap.audiobook_id
      join audiobook_chapters current_chapter on current_chapter.id = uap.chapter_id
      left join lateral (
        select coalesce(sum(coalesce(chapter.duration_ms, 0)), 0)::bigint as duration_ms
        from audiobook_chapters chapter
        where chapter.audiobook_id = uap.audiobook_id
          and chapter.position < current_chapter.position
      ) previous on true
      where uap.position_ms > 0 or uap.finished or current_chapter.position > 0
    ),
    audiobook_stats as (
      select
        user_id,
        max(updated_at) as last_audiobook_at,
        count(*)::int as audiobook_count,
        (count(*) filter (where finished))::int as audiobook_completed_count,
        (count(*) filter (where updated_at >= now() - interval '7 days'))::int as audiobooks_7d,
        coalesce(sum(estimated_listening_ms), 0)::float8 as audiobook_listening_ms
      from audiobook_progress_rows
      group by user_id
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
      case
        when u.google_id is not null and u.password_hash is null then 'google'
        when u.google_id is not null then 'google_password'
        else 'password'
      end as auth_provider,
      u.approval_status,
      u.avatar_path,
      u.created_at,
      greatest(
        u.last_seen_at,
        login_stats.last_login_at,
        play_stats.last_played_at,
        podcast_stats.last_podcast_at,
        audiobook_stats.last_audiobook_at
      ) as last_active_at,
      coalesce(u.last_seen_ip, login_stats.last_login_ip) as last_active_ip,
      login_stats.last_login_at,
      login_stats.last_login_ip,
      coalesce(login_stats.login_count, 0) as login_count,
      play_stats.last_played_at,
      podcast_stats.last_podcast_at,
      audiobook_stats.last_audiobook_at,
      greatest(
        play_stats.last_played_at,
        podcast_stats.last_podcast_at,
        audiobook_stats.last_audiobook_at
      ) as last_listened_at,
      coalesce(play_stats.total_plays, 0) as total_plays,
      coalesce(play_stats.plays_7d, 0) as plays_7d,
      coalesce(podcast_stats.podcast_episode_count, 0) as podcast_episode_count,
      coalesce(podcast_stats.podcast_completed_count, 0) as podcast_completed_count,
      coalesce(podcast_stats.podcasts_7d, 0) as podcasts_7d,
      coalesce(audiobook_stats.audiobook_count, 0) as audiobook_count,
      coalesce(audiobook_stats.audiobook_completed_count, 0) as audiobook_completed_count,
      coalesce(audiobook_stats.audiobooks_7d, 0) as audiobooks_7d,
      coalesce(play_stats.plays_7d, 0)
        + coalesce(podcast_stats.podcasts_7d, 0)
        + coalesce(audiobook_stats.audiobooks_7d, 0) as activity_7d,
      coalesce(play_stats.music_listening_ms, 0) as music_listening_ms,
      coalesce(podcast_stats.podcast_listening_ms, 0) as podcast_listening_ms,
      coalesce(audiobook_stats.audiobook_listening_ms, 0) as audiobook_listening_ms,
      coalesce(play_stats.music_listening_ms, 0)
        + coalesce(podcast_stats.podcast_listening_ms, 0)
        + coalesce(audiobook_stats.audiobook_listening_ms, 0) as estimated_listening_ms,
      coalesce(favorite_stats.favorite_count, 0) as favorite_count,
      coalesce(playlist_stats.playlist_count, 0) as playlist_count
    from users u
    left join login_stats on login_stats.email = lower(u.email)
    left join play_stats on play_stats.user_id = u.id
    left join podcast_stats on podcast_stats.user_id = u.id
    left join audiobook_stats on audiobook_stats.user_id = u.id
    left join favorite_stats on favorite_stats.user_id = u.id
    left join playlist_stats on playlist_stats.user_id = u.id
    where ($1::text is null or u.id = $1)
    order by last_active_at desc nulls last, u.created_at asc
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
          const lastActive = user.lastActiveAt ? new Date(user.lastActiveAt).getTime() : Number.NaN;
          return Number.isFinite(lastActive) && lastActive >= Date.now() - 7 * 24 * 60 * 60 * 1000;
        }).length,
        activity7d: users.reduce((sum, user) => sum + user.activity7d, 0),
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

    const [
      historyResult,
      countResult,
      podcastResult,
      audiobookResult,
      signInResult,
      dailyResult,
    ] = await Promise.all([
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
      db().query<{
        episode_id: number | string;
        podcast_id: number | string;
        episode_title: string;
        podcast_title: string;
        duration_ms: number | null;
        position_ms: number;
        played: boolean;
        updated_at: Date | string;
      }>(
        `
        select
          uep.episode_id,
          pe.podcast_id,
          pe.title as episode_title,
          p.title as podcast_title,
          pe.duration_ms,
          uep.position_ms,
          uep.played,
          uep.updated_at
        from user_episode_progress uep
        join podcast_episodes pe on pe.id = uep.episode_id
        join podcasts p on p.id = pe.podcast_id
        where uep.user_id = $1
          and (uep.position_ms > 0 or uep.played)
        order by uep.updated_at desc
        limit 100
        `,
        [id]
      ),
      db().query<{
        audiobook_id: number | string;
        book_title: string;
        author: string | null;
        book_duration_ms: number | string;
        chapter_id: number | string;
        chapter_title: string;
        chapter_duration_ms: number | null;
        position_ms: number;
        finished: boolean;
        updated_at: Date | string;
      }>(
        `
        select
          uap.audiobook_id,
          a.title as book_title,
          a.author,
          a.duration_ms as book_duration_ms,
          uap.chapter_id,
          chapter.title as chapter_title,
          chapter.duration_ms as chapter_duration_ms,
          uap.position_ms,
          uap.finished,
          uap.updated_at
        from user_audiobook_progress uap
        join audiobooks a on a.id = uap.audiobook_id
        join audiobook_chapters chapter on chapter.id = uap.chapter_id
        where uap.user_id = $1
          and (uap.position_ms > 0 or uap.finished or chapter.position > 0)
        order by uap.updated_at desc
        limit 100
        `,
        [id]
      ),
      db().query<{
        ts: Date | string;
        event: string;
        ip: string | null;
        method: string | null;
        backfilled_from: string | null;
      }>(
        `
        select
          ts,
          event,
          meta->>'ip' as ip,
          meta->>'method' as method,
          meta->>'backfilledFrom' as backfilled_from
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
        activity as (
          select played_at::date as day
          from play_history
          where user_id = $1 and played_at >= current_date - interval '13 days'
          union all
          select updated_at::date as day
          from user_episode_progress
          where user_id = $1
            and updated_at >= current_date - interval '13 days'
            and (position_ms > 0 or played)
          union all
          select updated_at::date as day
          from user_audiobook_progress
          where user_id = $1
            and updated_at >= current_date - interval '13 days'
        ),
        activity_counts as (
          select day, count(*)::int as count
          from activity
          group by day
        )
        select to_char(days.day, 'YYYY-MM-DD') as date, coalesce(activity_counts.count, 0)::int as count
        from days
        left join activity_counts on activity_counts.day = days.day
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
      podcastHistory: podcastResult.rows.map((row) => ({
        episodeId: Number(row.episode_id),
        podcastId: Number(row.podcast_id),
        episodeTitle: row.episode_title,
        podcastTitle: row.podcast_title,
        durationMs: row.duration_ms,
        positionMs: row.position_ms,
        played: row.played,
        updatedAt: row.updated_at,
      })),
      audiobookHistory: audiobookResult.rows.map((row) => ({
        audiobookId: Number(row.audiobook_id),
        bookTitle: row.book_title,
        author: row.author,
        bookDurationMs: Number(row.book_duration_ms),
        chapterId: Number(row.chapter_id),
        chapterTitle: row.chapter_title,
        chapterDurationMs: row.chapter_duration_ms,
        positionMs: row.position_ms,
        finished: row.finished,
        updatedAt: row.updated_at,
      })),
      signIns: signInResult.rows.map((row) => ({
        ts: row.ts,
        event: row.event,
        ip: row.ip,
        method: row.method === 'google' || row.method === 'password' ? row.method : null,
        backfilledFrom: row.backfilled_from,
      })),
      dailyActivity: dailyResult.rows.map((row) => ({ date: row.date, count: Number(row.count) })),
      limit,
      offset,
    };
  });
});

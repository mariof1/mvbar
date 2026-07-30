'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  getAdminUserAudit,
  getAdminUserAuditDetail,
  type AdminUserAuditDetail,
  type AdminUserAuditOverview,
  type AdminUserAuditSummary,
} from './apiClient';

type ActivityFilter = 'all' | 'active' | 'no-plays';
type UserSort = 'recent' | 'listening' | 'name';
type ActivityView = 'music' | 'podcasts' | 'audiobooks' | 'sign-ins' | 'devices';

const emptyOverview: AdminUserAuditOverview = {
  ok: true,
  users: [],
  totals: { users: 0, active7d: 0, activity7d: 0, estimatedListeningMs: 0 },
};

function dateTime(value: string | null) {
  if (!value) return 'Never';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function relativeTime(value: string | null) {
  if (!value) return 'Never';
  const elapsed = new Date(value).getTime() - Date.now();
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (Math.abs(elapsed) < hour) return formatter.format(Math.round(elapsed / minute), 'minute');
  if (Math.abs(elapsed) < day) return formatter.format(Math.round(elapsed / hour), 'hour');
  return formatter.format(Math.round(elapsed / day), 'day');
}

function duration(value: number | null) {
  if (!value || value < 0) return '--';
  const seconds = Math.round(value / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function longDuration(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0m';
  const totalMinutes = Math.round(value / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function countLabel(value: number, singular: string, plural = `${singular}s`) {
  return `${value.toLocaleString()} ${value === 1 ? singular : plural}`;
}

function clientLabel(value: string | null) {
  if (!value) return 'Unknown client';
  if (value === 'android') return 'Android';
  if (value === 'wear') return 'Wear OS';
  if (value === 'web') return 'Web';
  return value.replace(/[-_]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function authLabel(value: AdminUserAuditSummary['authProvider']) {
  if (value === 'google') return 'Google';
  if (value === 'google_password') return 'Google + password';
  return 'Password';
}

function eventTime(value: string | null) {
  return value ? new Date(value).getTime() : 0;
}

function Avatar({ user, size = 'md' }: { user: AdminUserAuditSummary; size?: 'sm' | 'md' | 'lg' }) {
  const dimensions = size === 'lg' ? 'w-14 h-14 text-xl' : size === 'sm' ? 'w-9 h-9 text-sm' : 'w-11 h-11';
  if (user.avatarPath) {
    return (
      <img
        src={`/api/avatars/${encodeURIComponent(user.avatarPath)}`}
        alt=""
        className={`${dimensions} rounded-full object-cover shrink-0`}
      />
    );
  }
  return (
    <div
      className={`${dimensions} rounded-full shrink-0 flex items-center justify-center font-semibold ${
        user.role === 'admin' ? 'bg-amber-500/20 text-amber-300' : 'bg-cyan-500/15 text-cyan-300'
      }`}
    >
      {user.email.slice(0, 1).toUpperCase()}
    </div>
  );
}

function SummaryStat({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="min-w-0 px-4 py-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-xl font-semibold text-white mt-1 truncate">{value}</div>
      {detail && <div className="text-[11px] text-slate-500 mt-0.5 truncate">{detail}</div>}
    </div>
  );
}

function EmptyActivity({ children }: { children: string }) {
  return (
    <div className="h-36 flex items-center justify-center text-sm text-slate-500">
      {children}
    </div>
  );
}

export function AdminUserAudit({ token, clear }: { token: string; clear: () => void }) {
  const [overview, setOverview] = useState<AdminUserAuditOverview>(emptyOverview);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [detail, setDetail] = useState<AdminUserAuditDetail | null>(null);
  const [query, setQuery] = useState('');
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>('all');
  const [userSort, setUserSort] = useState<UserSort>('recent');
  const [activityView, setActivityView] = useState<ActivityView>('music');
  const [showAllAuditRows, setShowAllAuditRows] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [moreLoading, setMoreLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadOverview() {
    setLoading(true);
    setError(null);
    try {
      const result = await getAdminUserAudit(token);
      setOverview(result);
      setLastRefreshedAt(new Date());
      setSelectedUserId((current) => (
        result.users.some((user) => user.id === current) ? current : result.users[0]?.id ?? ''
      ));
    } catch (e: any) {
      if (e?.status === 401) clear();
      setError(e?.data?.error ?? e?.message ?? 'Unable to load user audit');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadOverview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    if (!selectedUserId) {
      setDetail(null);
      return;
    }
    let current = true;
    setDetail(null);
    setDetailLoading(true);
    setError(null);
    getAdminUserAuditDetail(token, selectedUserId)
      .then((result) => {
        if (current) setDetail(result);
      })
      .catch((e: any) => {
        if (!current) return;
        if (e?.status === 401) clear();
        setError(e?.data?.error ?? e?.message ?? 'Unable to load user activity');
      })
      .finally(() => {
        if (current) setDetailLoading(false);
      });
    return () => {
      current = false;
    };
  }, [selectedUserId, token, clear]);

  useEffect(() => {
    setShowAllAuditRows(false);
  }, [activityView, selectedUserId]);

  const filteredUsers = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return overview.users
      .filter((user) => {
        if (
          normalized
          && !user.email.toLowerCase().includes(normalized)
          && !user.role.toLowerCase().includes(normalized)
          && !authLabel(user.authProvider).toLowerCase().includes(normalized)
        ) return false;
        if (activityFilter === 'no-plays') {
          return user.totalPlays + user.podcastEpisodeCount + user.audiobookCount === 0;
        }
        if (activityFilter === 'active') {
          return eventTime(user.lastActiveAt) >= sevenDaysAgo;
        }
        return true;
      })
      .sort((left, right) => {
        if (userSort === 'name') return left.email.localeCompare(right.email);
        if (userSort === 'listening') return right.estimatedListeningMs - left.estimatedListeningMs;
        return eventTime(right.lastActiveAt) - eventTime(left.lastActiveAt);
      });
  }, [activityFilter, overview.users, query, userSort]);

  const selectedUser = overview.users.find((user) => user.id === selectedUserId) ?? null;
  const maxDailyActivity = Math.max(1, ...(detail?.dailyActivity.map((day) => day.count) ?? [0]));

  async function loadMoreHistory() {
    if (!detail || moreLoading || detail.history.length >= detail.historyTotal) return;
    setMoreLoading(true);
    try {
      const next = await getAdminUserAuditDetail(token, detail.user.id, detail.limit, detail.history.length);
      setDetail((current) => current ? {
        ...next,
        history: [...current.history, ...next.history],
      } : next);
    } catch (e: any) {
      if (e?.status === 401) clear();
      setError(e?.data?.error ?? e?.message ?? 'Unable to load more history');
    } finally {
      setMoreLoading(false);
    }
  }

  const activityTabs = detail ? [
    { id: 'music' as ActivityView, label: 'Music', count: detail.historyTotal },
    { id: 'podcasts' as ActivityView, label: 'Podcasts', count: detail.podcastHistoryTotal },
    { id: 'audiobooks' as ActivityView, label: 'Audiobooks', count: detail.audiobookHistoryTotal },
    { id: 'sign-ins' as ActivityView, label: 'Sign-ins', count: detail.user.loginCount },
    { id: 'devices' as ActivityView, label: 'Devices', count: detail.clients.length },
  ] : [];

  const visibleSignIns = detail
    ? (showAllAuditRows ? detail.signIns : detail.signIns.slice(0, 8))
    : [];
  const visibleClients = detail
    ? (showAllAuditRows ? detail.clients : detail.clients.slice(0, 8))
    : [];

  return (
    <div className="space-y-5" data-testid="admin-user-audit">
      {error && (
        <div className="px-4 py-3 bg-red-500/10 border border-red-500/25 rounded-lg text-sm text-red-300">
          {error}
        </div>
      )}

      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white">User activity</h2>
          <p className="text-sm text-slate-400 mt-1">
            Account access, listening, and device history
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {lastRefreshedAt && (
            <span className="hidden sm:block text-xs text-slate-500">
              Updated {relativeTime(lastRefreshedAt.toISOString())}
            </span>
          )}
          <button
            onClick={() => void loadOverview()}
            disabled={loading}
            className="w-10 h-10 inline-flex items-center justify-center rounded-lg border border-slate-700/60 text-slate-300 hover:bg-slate-800 disabled:opacity-50"
            title="Refresh user audit"
            aria-label="Refresh user audit"
          >
            <svg className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h5M20 20v-5h-5M5.6 15A7 7 0 0018 17m.4-8A7 7 0 006 7" />
            </svg>
          </button>
        </div>
      </header>

      <div className="grid grid-cols-2 lg:grid-cols-4 divide-x divide-y lg:divide-y-0 divide-slate-800 border-y border-slate-800">
        <SummaryStat label="Accounts" value={overview.totals.users.toLocaleString()} />
        <SummaryStat
          label="Active in 7 days"
          value={overview.totals.active7d.toLocaleString()}
          detail={`${overview.totals.users ? Math.round((overview.totals.active7d / overview.totals.users) * 100) : 0}% of accounts`}
        />
        <SummaryStat label="7-day activity" value={overview.totals.activity7d.toLocaleString()} detail="Listening events" />
        <SummaryStat
          label="Estimated listening"
          value={longDuration(overview.totals.estimatedListeningMs)}
          detail="Music, podcasts, and books"
        />
      </div>

      <section className="border border-slate-700/50 rounded-lg overflow-hidden bg-slate-950/20">
        <div className="p-3 border-b border-slate-800 flex flex-col lg:flex-row lg:items-center gap-3">
          <label className="relative block flex-1 min-w-0">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m21 21-4.35-4.35M19 11a8 8 0 11-16 0 8 8 0 0116 0z" />
            </svg>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search accounts"
              className="w-full h-10 pl-9 pr-3 bg-slate-950/60 border border-slate-700/60 rounded-lg text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-cyan-500"
            />
          </label>

          <div className="grid grid-cols-3 p-1 bg-slate-950/60 rounded-lg lg:w-[300px]" role="group" aria-label="Activity filter">
            {([
              ['all', 'All'],
              ['active', 'Active'],
              ['no-plays', 'No listening'],
            ] as Array<[ActivityFilter, string]>).map(([value, label]) => (
              <button
                key={value}
                onClick={() => setActivityFilter(value)}
                className={`h-8 px-2 rounded-md text-xs font-medium ${
                  activityFilter === value ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <label className="flex items-center gap-2 lg:w-[190px]">
            <span className="text-xs text-slate-500 shrink-0">Sort</span>
            <select
              value={userSort}
              onChange={(event) => setUserSort(event.target.value as UserSort)}
              className="h-10 min-w-0 flex-1 px-3 bg-slate-950/60 border border-slate-700/60 rounded-lg text-sm text-slate-200 focus:outline-none focus:border-cyan-500"
            >
              <option value="recent">Recent activity</option>
              <option value="listening">Listening time</option>
              <option value="name">Account name</option>
            </select>
          </label>

          <span className="text-xs text-slate-500 lg:w-16 lg:text-right">
            {filteredUsers.length} of {overview.users.length}
          </span>
        </div>

        <div className="hidden md:grid md:grid-cols-[minmax(230px,1.5fr)_minmax(120px,0.75fr)_minmax(120px,0.75fr)_90px_110px] gap-3 px-4 py-2 border-b border-slate-800 text-[11px] uppercase text-slate-500">
          <span>Account</span>
          <span>Last active</span>
          <span>Last listened</span>
          <span className="text-right">7 days</span>
          <span className="text-right">Listening</span>
        </div>

        <div className="max-h-[330px] overflow-y-auto divide-y divide-slate-800">
          {loading ? (
            <div className="h-36 flex items-center justify-center">
              <div className="w-7 h-7 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : filteredUsers.length === 0 ? (
            <EmptyActivity>No matching accounts</EmptyActivity>
          ) : filteredUsers.map((user) => {
            const selected = user.id === selectedUserId;
            return (
              <button
                key={user.id}
                data-testid={`audit-user-${user.id}`}
                onClick={() => setSelectedUserId(user.id)}
                aria-pressed={selected}
                className={`relative w-full px-4 py-3 text-left grid grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(230px,1.5fr)_minmax(120px,0.75fr)_minmax(120px,0.75fr)_90px_110px] gap-3 items-center ${
                  selected ? 'bg-cyan-500/10' : 'hover:bg-slate-800/40'
                }`}
              >
                {selected && <span className="absolute inset-y-0 left-0 w-0.5 bg-cyan-400" />}
                <div className="flex items-center gap-3 min-w-0">
                  <Avatar user={user} size="sm" />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-white truncate">{user.email}</div>
                    <div className="flex items-center gap-1.5 mt-1 min-w-0">
                      <span className={`text-[10px] ${user.role === 'admin' ? 'text-amber-300' : 'text-slate-500'}`}>
                        {user.role}
                      </span>
                      <span className="text-slate-700">/</span>
                      <span className="text-[10px] text-slate-500 truncate">{authLabel(user.authProvider)}</span>
                    </div>
                  </div>
                </div>

                <div className="md:hidden text-right">
                  <div className="text-xs text-slate-300">{relativeTime(user.lastActiveAt)}</div>
                  <div className="text-[10px] text-slate-500 mt-1">{user.activity7d} events</div>
                </div>

                <div className="hidden md:block min-w-0">
                  <div className="text-xs text-slate-300 truncate">{relativeTime(user.lastActiveAt)}</div>
                  <div className="text-[10px] text-slate-600 truncate mt-0.5">{dateTime(user.lastActiveAt)}</div>
                </div>
                <div className="hidden md:block min-w-0">
                  <div className="text-xs text-slate-300 truncate">{relativeTime(user.lastListenedAt)}</div>
                  <div className="text-[10px] text-slate-600 truncate mt-0.5">
                    {countLabel(user.totalPlays + user.podcastEpisodeCount + user.audiobookCount, 'item')}
                  </div>
                </div>
                <div className="hidden md:block text-right">
                  <div className="text-sm font-medium text-slate-200">{user.activity7d.toLocaleString()}</div>
                  <div className="text-[10px] text-slate-600">events</div>
                </div>
                <div className="hidden md:block text-right">
                  <div className="text-sm font-medium text-slate-200">{longDuration(user.estimatedListeningMs)}</div>
                  <div className="text-[10px] text-slate-600">estimated</div>
                </div>
              </button>
            );
          })}
        </div>
      </section>

      {!selectedUser ? (
        <section className="h-56 border-y border-slate-800 flex items-center justify-center text-sm text-slate-500">
          Select an account to inspect its activity
        </section>
      ) : detailLoading && !detail ? (
        <section className="h-56 border-y border-slate-800 flex items-center justify-center">
          <div className="w-8 h-8 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin" />
        </section>
      ) : detail ? (
        <section className="space-y-5" data-testid="audit-user-detail">
          <div className="flex flex-col lg:flex-row lg:items-center gap-4 py-1">
            <div className="flex items-center gap-4 min-w-0 flex-1">
              <Avatar user={detail.user} size="lg" />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-lg font-semibold text-white break-all">{detail.user.email}</h3>
                  <span className={`px-2 py-0.5 rounded text-xs ${
                    detail.user.role === 'admin' ? 'bg-amber-500/15 text-amber-300' : 'bg-slate-800 text-slate-300'
                  }`}>
                    {detail.user.role}
                  </span>
                  <span className="px-2 py-0.5 rounded text-xs bg-cyan-500/10 text-cyan-300">
                    {authLabel(detail.user.authProvider)}
                  </span>
                </div>
                <div className="text-xs text-slate-500 mt-1">
                  Joined {dateTime(detail.user.createdAt)}
                </div>
              </div>
            </div>

            <div className="grid sm:grid-cols-2 gap-x-8 gap-y-3 lg:text-right shrink-0">
              <div>
                <div className="text-[11px] uppercase text-slate-500">Last active</div>
                <div className="text-sm text-slate-200 mt-1">{relativeTime(detail.user.lastActiveAt)}</div>
                <div className="text-[10px] text-slate-600 mt-0.5">{dateTime(detail.user.lastActiveAt)}</div>
              </div>
              <div>
                <div className="text-[11px] uppercase text-slate-500">Last sign-in</div>
                <div className="text-sm text-slate-200 mt-1">{relativeTime(detail.user.lastLoginAt)}</div>
                <div className="text-[10px] font-mono text-slate-600 mt-0.5">
                  {detail.user.lastLoginIp || detail.user.lastActiveIp || 'No IP recorded'}
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 divide-x divide-y xl:divide-y-0 divide-slate-800 border-y border-slate-800">
            <SummaryStat label="Music" value={detail.user.totalPlays.toLocaleString()} detail="plays" />
            <SummaryStat
              label="Podcasts"
              value={detail.user.podcastEpisodeCount.toLocaleString()}
              detail={`${detail.user.podcastCompletedCount} completed`}
            />
            <SummaryStat
              label="Audiobooks"
              value={detail.user.audiobookCount.toLocaleString()}
              detail={`${detail.user.audiobookCompletedCount} completed`}
            />
            <SummaryStat label="Listening" value={longDuration(detail.user.estimatedListeningMs)} detail="estimated" />
            <SummaryStat label="Loved" value={detail.user.favoriteCount.toLocaleString()} detail="tracks" />
            <SummaryStat label="Playlists" value={detail.user.playlistCount.toLocaleString()} detail="saved lists" />
          </div>

          <section className="border border-slate-700/50 rounded-lg overflow-hidden bg-slate-950/20">
            <div className="px-4 sm:px-5 py-4 border-b border-slate-800">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h4 className="text-sm font-medium text-slate-200">Activity trend</h4>
                  <p className="text-xs text-slate-500 mt-0.5">Listening events over the last 14 days</p>
                </div>
                <div className="text-right">
                  <div className="text-sm font-medium text-white">{detail.user.activity7d.toLocaleString()}</div>
                  <div className="text-[10px] text-slate-500">last 7 days</div>
                </div>
              </div>

              <div className="h-24 flex items-end gap-1.5 mt-4">
                {detail.dailyActivity.map((day) => (
                  <div
                    key={day.date}
                    className="h-full flex-1 min-w-0 flex flex-col items-center justify-end gap-1"
                    title={`${day.date}: ${day.count} activities`}
                  >
                    <div
                      className={`w-full max-w-10 rounded-t-sm ${day.count > 0 ? 'bg-cyan-400/80' : 'bg-slate-800'}`}
                      style={{ height: `${Math.max(day.count > 0 ? 8 : 3, (day.count / maxDailyActivity) * 68)}px` }}
                    />
                    <span className="text-[9px] text-slate-600">
                      {new Intl.DateTimeFormat(undefined, { weekday: 'narrow' }).format(new Date(`${day.date}T12:00:00`))}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="p-2 sm:p-3 border-b border-slate-800">
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-1 p-1 bg-slate-950/60 rounded-lg" role="tablist" aria-label="User activity type">
                {activityTabs.map((tab) => (
                  <button
                    key={tab.id}
                    role="tab"
                    aria-selected={activityView === tab.id}
                    onClick={() => setActivityView(tab.id)}
                    className={`min-w-0 h-10 px-2 rounded-md text-xs font-medium truncate ${
                      activityView === tab.id ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
                    }`}
                  >
                    {tab.label}
                    <span className="ml-1 text-[10px] opacity-65">{tab.count.toLocaleString()}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="divide-y divide-slate-800" data-testid={`audit-activity-${activityView}`}>
              {activityView === 'music' && detail.history.map((item) => (
                <div key={item.historyId} className="px-4 sm:px-5 py-3 flex items-center gap-3">
                  <img
                    src={`/api/library/tracks/${item.trackId}/art`}
                    alt=""
                    className="w-11 h-11 rounded object-cover bg-slate-800 shrink-0"
                    onError={(event) => {
                      event.currentTarget.style.visibility = 'hidden';
                    }}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-white truncate">{item.title || 'Unknown track'}</div>
                    <div className="text-xs text-slate-500 truncate mt-0.5">
                      {[item.artist, item.album].filter(Boolean).join(' · ') || 'Unknown artist'}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-xs text-slate-300">{relativeTime(item.playedAt)}</div>
                    <div className="text-[10px] text-slate-600 mt-1">{dateTime(item.playedAt)} · {duration(item.durationMs)}</div>
                  </div>
                </div>
              ))}

              {activityView === 'podcasts' && detail.podcastHistory.map((item) => (
                <div key={item.activityId} className="px-4 sm:px-5 py-3 flex items-center gap-3">
                  <img
                    src={`/api/podcasts/episodes/${item.episodeId}/art`}
                    alt=""
                    className="w-11 h-11 rounded object-cover bg-slate-800 shrink-0"
                    onError={(event) => {
                      event.currentTarget.style.visibility = 'hidden';
                    }}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-white truncate">{item.episodeTitle}</div>
                    <div className="text-xs text-slate-500 truncate mt-0.5">{item.podcastTitle}</div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-xs text-slate-300">{relativeTime(item.updatedAt)}</div>
                    <div className={`text-[10px] mt-1 ${item.completed ? 'text-emerald-400' : 'text-slate-600'}`}>
                      {item.completed ? 'Completed' : `${duration(item.positionMs)} · listened ${duration(item.listenedMs)}`}
                    </div>
                  </div>
                </div>
              ))}

              {activityView === 'audiobooks' && detail.audiobookHistory.map((item) => (
                <div key={item.activityId} className="px-4 sm:px-5 py-3 flex items-center gap-3">
                  <img
                    src={`/api/audiobook-art/${item.audiobookId}`}
                    alt=""
                    className="w-11 h-11 rounded object-cover bg-slate-800 shrink-0"
                    onError={(event) => {
                      event.currentTarget.style.visibility = 'hidden';
                    }}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-white truncate">{item.bookTitle}</div>
                    <div className="text-xs text-slate-500 truncate mt-0.5">
                      {[item.author, item.chapterTitle].filter(Boolean).join(' · ') || 'Unknown author'}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-xs text-slate-300">{relativeTime(item.updatedAt)}</div>
                    <div className={`text-[10px] mt-1 ${item.completed ? 'text-emerald-400' : 'text-slate-600'}`}>
                      {item.completed ? 'Completed' : `${duration(item.positionMs)} · listened ${duration(item.listenedMs)}`}
                    </div>
                  </div>
                </div>
              ))}

              {activityView === 'sign-ins' && visibleSignIns.map((signIn, index) => {
                const successful = signIn.event === 'login_ok';
                const label = successful
                  ? signIn.method === 'google'
                    ? signIn.backfilledFrom === 'account_creation' ? 'First Google sign-in' : 'Signed in with Google'
                    : signIn.method === 'password' ? 'Signed in with password' : 'Signed in'
                  : signIn.event === 'login_locked' ? 'Locked attempt' : 'Failed attempt';
                return (
                  <div key={`${signIn.ts}-${index}`} className="px-4 sm:px-5 py-3 grid sm:grid-cols-[minmax(180px,0.8fr)_minmax(0,1.4fr)_minmax(120px,0.6fr)] gap-2 sm:gap-4 items-center">
                    <div className="flex items-center gap-3 min-w-0">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${successful ? 'bg-emerald-400' : 'bg-red-400'}`} />
                      <div className="text-sm text-slate-200 truncate">{label}</div>
                    </div>
                    <div className="text-xs text-slate-500 truncate">
                      {[
                        clientLabel(signIn.clientType),
                        signIn.appVersion,
                        signIn.deviceName,
                      ].filter(Boolean).join(' · ') || 'No client details'}
                    </div>
                    <div className="sm:text-right">
                      <div className="text-xs text-slate-300">{relativeTime(signIn.ts)}</div>
                      <div className="text-[10px] text-slate-600 mt-0.5">
                        {signIn.ip || 'No IP'} · {dateTime(signIn.ts)}
                      </div>
                    </div>
                  </div>
                );
              })}

              {activityView === 'devices' && visibleClients.map((client) => (
                <div key={client.clientId} className="px-4 sm:px-5 py-3 grid sm:grid-cols-[minmax(160px,0.7fr)_minmax(0,1.4fr)_minmax(120px,0.6fr)] gap-2 sm:gap-4 items-center">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="w-2 h-2 rounded-full shrink-0 bg-cyan-400" />
                    <div>
                      <div className="text-sm text-slate-200">{clientLabel(client.clientType)}</div>
                      <div className="text-[10px] text-slate-600 mt-0.5">{client.clientId}</div>
                    </div>
                  </div>
                  <div className="text-xs text-slate-500 truncate">
                    {[client.appVersion, client.deviceName, client.platform].filter(Boolean).join(' · ') || 'No device details'}
                  </div>
                  <div className="sm:text-right">
                    <div className="text-xs text-slate-300">Active {relativeTime(client.lastSeenAt)}</div>
                    <div className="text-[10px] font-mono text-slate-600 mt-0.5">{client.lastSeenIp || 'No IP'}</div>
                  </div>
                </div>
              ))}

              {activityView === 'music' && detail.history.length === 0 && <EmptyActivity>No music history</EmptyActivity>}
              {activityView === 'podcasts' && detail.podcastHistory.length === 0 && <EmptyActivity>No podcast activity</EmptyActivity>}
              {activityView === 'audiobooks' && detail.audiobookHistory.length === 0 && <EmptyActivity>No audiobook activity</EmptyActivity>}
              {activityView === 'sign-ins' && detail.signIns.length === 0 && <EmptyActivity>No sign-ins recorded</EmptyActivity>}
              {activityView === 'devices' && detail.clients.length === 0 && <EmptyActivity>No devices recorded</EmptyActivity>}
            </div>

            {activityView === 'music' && detail.history.length < detail.historyTotal && (
              <div className="p-3 border-t border-slate-800">
                <button
                  onClick={() => void loadMoreHistory()}
                  disabled={moreLoading}
                  className="w-full h-9 rounded-lg text-sm font-medium text-slate-300 bg-slate-800 hover:bg-slate-700 disabled:opacity-50"
                >
                  {moreLoading ? 'Loading' : `Load more (${detail.history.length} of ${detail.historyTotal})`}
                </button>
              </div>
            )}

            {activityView === 'podcasts' && detail.podcastHistory.length < detail.podcastHistoryTotal && (
              <div className="px-4 py-3 border-t border-slate-800 text-center text-xs text-slate-500">
                Showing the latest {detail.podcastHistory.length.toLocaleString()} of {detail.podcastHistoryTotal.toLocaleString()} records
              </div>
            )}

            {activityView === 'audiobooks' && detail.audiobookHistory.length < detail.audiobookHistoryTotal && (
              <div className="px-4 py-3 border-t border-slate-800 text-center text-xs text-slate-500">
                Showing the latest {detail.audiobookHistory.length.toLocaleString()} of {detail.audiobookHistoryTotal.toLocaleString()} records
              </div>
            )}

            {activityView === 'sign-ins' && detail.signIns.length > 8 && (
              <div className="p-3 border-t border-slate-800">
                <button
                  onClick={() => setShowAllAuditRows((current) => !current)}
                  className="w-full h-9 rounded-lg text-sm font-medium text-slate-300 hover:bg-slate-800"
                >
                  {showAllAuditRows ? 'Show recent sign-ins' : `Show all ${detail.signIns.length} sign-ins`}
                </button>
              </div>
            )}

            {activityView === 'devices' && detail.clients.length > 8 && (
              <div className="p-3 border-t border-slate-800">
                <button
                  onClick={() => setShowAllAuditRows((current) => !current)}
                  className="w-full h-9 rounded-lg text-sm font-medium text-slate-300 hover:bg-slate-800"
                >
                  {showAllAuditRows ? 'Show recent devices' : `Show all ${detail.clients.length} devices`}
                </button>
              </div>
            )}
          </section>
        </section>
      ) : null}
    </div>
  );
}

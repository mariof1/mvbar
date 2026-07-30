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
type MobilePane = 'users' | 'detail';

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

function Avatar({
  user,
  size = 'md',
}: {
  user: AdminUserAuditSummary;
  size?: 'sm' | 'md' | 'lg';
}) {
  const dimensions = size === 'lg' ? 'w-12 h-12 text-lg' : size === 'sm' ? 'w-9 h-9 text-sm' : 'w-10 h-10';
  const colors = user.role === 'admin'
    ? 'bg-amber-500/15 text-amber-300'
    : 'bg-cyan-500/10 text-cyan-300';

  return (
    <div className={`${dimensions} ${colors} relative rounded-full shrink-0 flex items-center justify-center font-semibold overflow-hidden`}>
      {user.email.slice(0, 1).toUpperCase()}
      {user.avatarPath && (
        <img
          src={`/api/avatars/${encodeURIComponent(user.avatarPath)}`}
          alt=""
          className="absolute inset-0 w-full h-full object-cover"
          onError={(event) => {
            event.currentTarget.style.display = 'none';
          }}
        />
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className="text-lg font-semibold text-white mt-0.5 truncate">{value}</div>
      {detail && <div className="text-[10px] text-slate-600 mt-0.5 truncate">{detail}</div>}
    </div>
  );
}

function EmptyActivity({ children }: { children: string }) {
  return (
    <div className="h-52 flex items-center justify-center text-sm text-slate-500">
      {children}
    </div>
  );
}

function MediaActivityRow({
  artworkUrl,
  title,
  subtitle,
  occurredAt,
  detail,
  completed = false,
}: {
  artworkUrl: string;
  title: string;
  subtitle: string;
  occurredAt: string;
  detail: string;
  completed?: boolean;
}) {
  return (
    <div className="px-4 py-3 flex items-center gap-3">
      <div className="relative w-10 h-10 rounded bg-slate-800 text-slate-500 shrink-0 overflow-hidden flex items-center justify-center text-sm font-semibold">
        {title.slice(0, 1).toUpperCase()}
        <img
          src={artworkUrl}
          alt=""
          className="absolute inset-0 w-full h-full object-cover"
          onError={(event) => {
            event.currentTarget.style.display = 'none';
          }}
        />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-slate-100 truncate">{title}</div>
        <div className="text-xs text-slate-500 truncate mt-0.5">{subtitle}</div>
      </div>
      <div className="text-right shrink-0 max-w-40" title={dateTime(occurredAt)}>
        <div className="text-xs text-slate-300">{relativeTime(occurredAt)}</div>
        <div className={`text-[10px] truncate mt-1 ${completed ? 'text-emerald-400' : 'text-slate-600'}`}>
          {detail}
        </div>
      </div>
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
  const [mobilePane, setMobilePane] = useState<MobilePane>('users');
  const [showTrend, setShowTrend] = useState(false);
  const [showAccountDetails, setShowAccountDetails] = useState(false);
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
    setShowTrend(false);
    setShowAccountDetails(false);
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

  function selectUser(userId: string) {
    setSelectedUserId(userId);
    setMobilePane('detail');
  }

  const activityTabs = detail ? [
    { id: 'music' as ActivityView, label: 'Music', count: detail.historyTotal },
    { id: 'podcasts' as ActivityView, label: 'Podcasts', count: detail.podcastHistoryTotal },
    { id: 'audiobooks' as ActivityView, label: 'Books', count: detail.audiobookHistoryTotal },
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
    <div className="space-y-4" data-testid="admin-user-audit">
      {error && (
        <div className="px-4 py-3 bg-red-500/10 border border-red-500/25 rounded-lg text-sm text-red-300">
          {error}
        </div>
      )}

      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold text-white">User audit</h2>
          <p className="text-sm text-slate-500 mt-1">
            {overview.totals.users.toLocaleString()} accounts
            <span className="mx-2 text-slate-700">/</span>
            {overview.totals.active7d.toLocaleString()} active this week
            <span className="mx-2 text-slate-700">/</span>
            {longDuration(overview.totals.estimatedListeningMs)} listening
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {lastRefreshedAt && (
            <span className="hidden md:block text-xs text-slate-600">
              Updated {relativeTime(lastRefreshedAt.toISOString())}
            </span>
          )}
          <button
            onClick={() => void loadOverview()}
            disabled={loading}
            className="w-9 h-9 inline-flex items-center justify-center rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 disabled:opacity-50"
            title="Refresh user audit"
            aria-label="Refresh user audit"
          >
            <svg className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h5M20 20v-5h-5M5.6 15A7 7 0 0018 17m.4-8A7 7 0 006 7" />
            </svg>
          </button>
        </div>
      </header>

      <section className="border border-slate-800 rounded-lg overflow-hidden bg-slate-950/20">
        <div className="grid lg:grid-cols-[290px_minmax(0,1fr)] min-h-[650px]">
          <aside className={`${mobilePane === 'detail' ? 'hidden lg:flex' : 'flex'} min-w-0 flex-col lg:border-r border-slate-800`}>
            <div className="p-3 space-y-2 border-b border-slate-800">
              <label className="relative block">
                <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m21 21-4.35-4.35M19 11a8 8 0 11-16 0 8 8 0 0116 0z" />
                </svg>
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Find an account"
                  className="w-full h-9 pl-9 pr-3 bg-slate-950/60 border border-slate-800 rounded-lg text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-cyan-500"
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <select
                  value={activityFilter}
                  onChange={(event) => setActivityFilter(event.target.value as ActivityFilter)}
                  aria-label="Filter accounts"
                  className="h-8 min-w-0 px-2 bg-slate-950/60 border border-slate-800 rounded-md text-xs text-slate-400 focus:outline-none focus:border-cyan-500"
                >
                  <option value="all">All accounts</option>
                  <option value="active">Active this week</option>
                  <option value="no-plays">No listening</option>
                </select>
                <select
                  value={userSort}
                  onChange={(event) => setUserSort(event.target.value as UserSort)}
                  aria-label="Sort accounts"
                  className="h-8 min-w-0 px-2 bg-slate-950/60 border border-slate-800 rounded-md text-xs text-slate-400 focus:outline-none focus:border-cyan-500"
                >
                  <option value="recent">Most recent</option>
                  <option value="listening">Most listening</option>
                  <option value="name">Account name</option>
                </select>
              </div>
            </div>

            <div className="px-4 py-2 text-[10px] uppercase text-slate-600 border-b border-slate-800">
              {filteredUsers.length} {filteredUsers.length === 1 ? 'account' : 'accounts'}
            </div>

            <div className="flex-1 lg:max-h-[690px] overflow-y-auto divide-y divide-slate-800/70">
              {loading ? (
                <div className="h-40 flex items-center justify-center">
                  <div className="w-6 h-6 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin" />
                </div>
              ) : filteredUsers.length === 0 ? (
                <EmptyActivity>No matching accounts</EmptyActivity>
              ) : filteredUsers.map((user) => {
                const selected = user.id === selectedUserId;
                return (
                  <button
                    key={user.id}
                    data-testid={`audit-user-${user.id}`}
                    onClick={() => selectUser(user.id)}
                    aria-pressed={selected}
                    className={`relative w-full px-3 py-3 text-left flex items-center gap-3 ${
                      selected ? 'bg-slate-800/80' : 'hover:bg-slate-900/70'
                    }`}
                  >
                    {selected && <span className="absolute inset-y-2 left-0 w-0.5 rounded bg-cyan-400" />}
                    <Avatar user={user} size="sm" />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-slate-100 truncate">{user.email}</div>
                      <div className="text-[11px] text-slate-500 truncate mt-1">
                        Active {relativeTime(user.lastActiveAt)}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-xs text-slate-300">{longDuration(user.estimatedListeningMs)}</div>
                      <div className="text-[10px] text-slate-600 mt-1">{user.activity7d} this week</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </aside>

          <main className={`${mobilePane === 'users' ? 'hidden lg:block' : 'block'} min-w-0`}>
            {!selectedUser ? (
              <div className="h-full min-h-[520px] flex items-center justify-center text-sm text-slate-500">
                Select an account to inspect its activity
              </div>
            ) : detailLoading && !detail ? (
              <div className="h-full min-h-[520px] flex items-center justify-center">
                <div className="w-7 h-7 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin" />
              </div>
            ) : detail ? (
              <div data-testid="audit-user-detail">
                <div className="px-4 sm:px-5 py-4 border-b border-slate-800">
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => setMobilePane('users')}
                      className="lg:hidden w-9 h-9 -ml-2 inline-flex items-center justify-center rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"
                      title="Back to accounts"
                      aria-label="Back to accounts"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m15 18-6-6 6-6" />
                      </svg>
                    </button>
                    <Avatar user={detail.user} size="lg" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <h3 className="text-base font-semibold text-white truncate">{detail.user.email}</h3>
                        {detail.user.role === 'admin' && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] bg-amber-500/15 text-amber-300 shrink-0">
                            Admin
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-slate-500 truncate mt-1">
                        {authLabel(detail.user.authProvider)}
                        <span className="mx-1.5 text-slate-700">/</span>
                        Active {relativeTime(detail.user.lastActiveAt)}
                      </div>
                    </div>
                    <button
                      onClick={() => setShowAccountDetails((current) => !current)}
                      aria-expanded={showAccountDetails}
                      className={`h-9 px-3 rounded-lg text-xs font-medium ${
                        showAccountDetails
                          ? 'bg-slate-700 text-white'
                          : 'text-slate-400 hover:text-white hover:bg-slate-800'
                      }`}
                    >
                      Details
                    </button>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-5 gap-y-4 mt-5">
                    <Metric label="Listening" value={longDuration(detail.user.estimatedListeningMs)} detail="estimated" />
                    <Metric label="Music" value={detail.user.totalPlays.toLocaleString()} detail="plays" />
                    <Metric label="Podcasts" value={detail.user.podcastEpisodeCount.toLocaleString()} detail={`${detail.user.podcastCompletedCount} completed`} />
                    <Metric label="Audiobooks" value={detail.user.audiobookCount.toLocaleString()} detail={`${detail.user.audiobookCompletedCount} completed`} />
                  </div>
                </div>

                {showAccountDetails && (
                  <div
                    className="px-4 sm:px-5 py-4 bg-slate-950/40 border-b border-slate-800 grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-4"
                    data-testid="audit-account-details"
                  >
                    <div>
                      <div className="text-[10px] uppercase text-slate-600">Last sign-in</div>
                      <div className="text-xs text-slate-300 mt-1">{dateTime(detail.user.lastLoginAt)}</div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase text-slate-600">Last IP</div>
                      <div className="text-xs font-mono text-slate-300 mt-1 truncate">
                        {detail.user.lastLoginIp || detail.user.lastActiveIp || 'Not recorded'}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase text-slate-600">Joined</div>
                      <div className="text-xs text-slate-300 mt-1">{dateTime(detail.user.createdAt)}</div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase text-slate-600">Access history</div>
                      <div className="text-xs text-slate-300 mt-1">
                        {detail.user.loginCount.toLocaleString()} sign-ins / {detail.clients.length.toLocaleString()} devices
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase text-slate-600">Saved music</div>
                      <div className="text-xs text-slate-300 mt-1">
                        {detail.user.favoriteCount.toLocaleString()} loved / {detail.user.playlistCount.toLocaleString()} playlists
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase text-slate-600">Approval</div>
                      <div className="text-xs text-slate-300 mt-1 capitalize">{detail.user.approvalStatus}</div>
                    </div>
                  </div>
                )}

                <div className="px-3 sm:px-4 pt-3 border-b border-slate-800 flex items-end gap-2">
                  <label className="sm:hidden flex-1 min-w-0 mb-1">
                    <span className="sr-only">Activity type</span>
                    <select
                      value={activityView}
                      onChange={(event) => setActivityView(event.target.value as ActivityView)}
                      aria-label="Activity type"
                      className="w-full h-9 px-3 bg-slate-950/60 border border-slate-800 rounded-lg text-xs text-slate-300 focus:outline-none focus:border-cyan-500"
                    >
                      {activityTabs.map((tab) => (
                        <option key={tab.id} value={tab.id}>
                          {tab.label} ({tab.count.toLocaleString()})
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="hidden sm:block flex-1 min-w-0 overflow-x-auto">
                    <div className="flex min-w-max" role="tablist" aria-label="User activity type">
                      {activityTabs.map((tab) => (
                        <button
                          key={tab.id}
                          role="tab"
                          aria-selected={activityView === tab.id}
                          onClick={() => setActivityView(tab.id)}
                          className={`h-10 px-3 border-b-2 text-xs font-medium ${
                            activityView === tab.id
                              ? 'border-cyan-400 text-white'
                              : 'border-transparent text-slate-500 hover:text-slate-300'
                          }`}
                        >
                          {tab.label}
                          <span className="ml-1.5 text-[10px] opacity-60">{tab.count.toLocaleString()}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                  <button
                    onClick={() => setShowTrend((current) => !current)}
                    aria-expanded={showTrend}
                    className={`h-9 mb-1 px-2.5 inline-flex items-center gap-2 rounded-lg text-xs font-medium shrink-0 ${
                      showTrend
                        ? 'bg-slate-700 text-white'
                        : 'text-slate-500 hover:text-white hover:bg-slate-800'
                    }`}
                    title="Show 14-day activity trend"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 19V9m5 10V5m5 14v-7m5 7V8" />
                    </svg>
                    <span className="hidden sm:inline">14 days</span>
                  </button>
                </div>

                {showTrend && (
                  <div className="px-4 sm:px-5 py-4 border-b border-slate-800 bg-slate-950/30" data-testid="audit-activity-trend">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-xs font-medium text-slate-300">Listening activity</div>
                        <div className="text-[10px] text-slate-600 mt-0.5">Last 14 days</div>
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-semibold text-white">{detail.user.activity7d.toLocaleString()}</div>
                        <div className="text-[10px] text-slate-600">events this week</div>
                      </div>
                    </div>
                    <div className="h-16 flex items-end gap-1.5 mt-3">
                      {detail.dailyActivity.map((day) => (
                        <div
                          key={day.date}
                          className="h-full flex-1 min-w-0 flex flex-col items-center justify-end gap-1"
                          title={`${day.date}: ${day.count} activities`}
                        >
                          <div
                            className={`w-full max-w-8 rounded-t-sm ${day.count > 0 ? 'bg-cyan-400/75' : 'bg-slate-800'}`}
                            style={{ height: `${Math.max(day.count > 0 ? 7 : 2, (day.count / maxDailyActivity) * 45)}px` }}
                          />
                          <span className="text-[8px] text-slate-700">
                            {new Intl.DateTimeFormat(undefined, { weekday: 'narrow' }).format(new Date(`${day.date}T12:00:00`))}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="lg:max-h-[490px] overflow-y-auto divide-y divide-slate-800/70" data-testid={`audit-activity-${activityView}`}>
                  {activityView === 'music' && detail.history.map((item) => (
                    <MediaActivityRow
                      key={item.historyId}
                      artworkUrl={`/api/library/tracks/${item.trackId}/art`}
                      title={item.title || 'Unknown track'}
                      subtitle={[item.artist, item.album].filter(Boolean).join(' / ') || 'Unknown artist'}
                      occurredAt={item.playedAt}
                      detail={duration(item.durationMs)}
                    />
                  ))}

                  {activityView === 'podcasts' && detail.podcastHistory.map((item) => (
                    <MediaActivityRow
                      key={item.activityId}
                      artworkUrl={`/api/podcasts/episodes/${item.episodeId}/art`}
                      title={item.episodeTitle}
                      subtitle={item.podcastTitle}
                      occurredAt={item.updatedAt}
                      completed={item.completed}
                      detail={item.completed ? 'Completed' : `${duration(item.positionMs)} played`}
                    />
                  ))}

                  {activityView === 'audiobooks' && detail.audiobookHistory.map((item) => (
                    <MediaActivityRow
                      key={item.activityId}
                      artworkUrl={`/api/audiobook-art/${item.audiobookId}`}
                      title={item.bookTitle}
                      subtitle={[item.author, item.chapterTitle].filter(Boolean).join(' / ') || 'Unknown author'}
                      occurredAt={item.updatedAt}
                      completed={item.completed}
                      detail={item.completed ? 'Completed' : `${duration(item.positionMs)} played`}
                    />
                  ))}

                  {activityView === 'sign-ins' && visibleSignIns.map((signIn, index) => {
                    const successful = signIn.event === 'login_ok';
                    const label = successful
                      ? signIn.method === 'google'
                        ? signIn.backfilledFrom === 'account_creation' ? 'First Google sign-in' : 'Google sign-in'
                        : signIn.method === 'password' ? 'Password sign-in' : 'Signed in'
                      : signIn.event === 'login_locked' ? 'Locked attempt' : 'Failed attempt';
                    const device = [clientLabel(signIn.clientType), signIn.appVersion, signIn.deviceName]
                      .filter(Boolean)
                      .join(' / ') || 'No client details';
                    return (
                      <div key={`${signIn.ts}-${index}`} className="px-4 py-3 flex items-center gap-3">
                        <span className={`w-2 h-2 rounded-full shrink-0 ${successful ? 'bg-emerald-400' : 'bg-red-400'}`} />
                        <div className="min-w-0 flex-1">
                          <div className="text-sm text-slate-200">{label}</div>
                          <div className="text-xs text-slate-500 truncate mt-0.5">{device}</div>
                        </div>
                        <div className="text-right shrink-0" title={dateTime(signIn.ts)}>
                          <div className="text-xs text-slate-300">{relativeTime(signIn.ts)}</div>
                          <div className="text-[10px] font-mono text-slate-600 mt-1">{signIn.ip || 'No IP'}</div>
                        </div>
                      </div>
                    );
                  })}

                  {activityView === 'devices' && visibleClients.map((client) => (
                    <div key={client.clientId} className="px-4 py-3 flex items-center gap-3">
                      <div className="w-9 h-9 rounded bg-slate-800/80 flex items-center justify-center text-xs font-semibold text-cyan-300 shrink-0">
                        {clientLabel(client.clientType).slice(0, 1)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-slate-200">{clientLabel(client.clientType)}</div>
                        <div className="text-xs text-slate-500 truncate mt-0.5">
                          {[client.deviceName, client.appVersion, client.platform].filter(Boolean).join(' / ') || 'No device details'}
                        </div>
                      </div>
                      <div className="text-right shrink-0" title={dateTime(client.lastSeenAt)}>
                        <div className="text-xs text-slate-300">{relativeTime(client.lastSeenAt)}</div>
                        <div className="text-[10px] font-mono text-slate-600 mt-1">{client.lastSeenIp || 'No IP'}</div>
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
                      className="w-full h-9 rounded-lg text-sm font-medium text-slate-400 hover:text-white hover:bg-slate-800 disabled:opacity-50"
                    >
                      {moreLoading ? 'Loading' : `Load more (${detail.history.length} of ${detail.historyTotal})`}
                    </button>
                  </div>
                )}

                {activityView === 'podcasts' && detail.podcastHistory.length < detail.podcastHistoryTotal && (
                  <div className="px-4 py-3 border-t border-slate-800 text-center text-xs text-slate-600">
                    Latest {detail.podcastHistory.length.toLocaleString()} of {detail.podcastHistoryTotal.toLocaleString()} records
                  </div>
                )}

                {activityView === 'audiobooks' && detail.audiobookHistory.length < detail.audiobookHistoryTotal && (
                  <div className="px-4 py-3 border-t border-slate-800 text-center text-xs text-slate-600">
                    Latest {detail.audiobookHistory.length.toLocaleString()} of {detail.audiobookHistoryTotal.toLocaleString()} records
                  </div>
                )}

                {activityView === 'sign-ins' && detail.signIns.length > 8 && (
                  <div className="p-3 border-t border-slate-800">
                    <button
                      onClick={() => setShowAllAuditRows((current) => !current)}
                      className="w-full h-9 rounded-lg text-sm font-medium text-slate-400 hover:text-white hover:bg-slate-800"
                    >
                      {showAllAuditRows ? 'Show recent sign-ins' : `Show all ${detail.signIns.length} sign-ins`}
                    </button>
                  </div>
                )}

                {activityView === 'devices' && detail.clients.length > 8 && (
                  <div className="p-3 border-t border-slate-800">
                    <button
                      onClick={() => setShowAllAuditRows((current) => !current)}
                      className="w-full h-9 rounded-lg text-sm font-medium text-slate-400 hover:text-white hover:bg-slate-800"
                    >
                      {showAllAuditRows ? 'Show recent devices' : `Show all ${detail.clients.length} devices`}
                    </button>
                  </div>
                )}
              </div>
            ) : null}
          </main>
        </div>
      </section>
    </div>
  );
}

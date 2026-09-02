'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  adminUnlockUserLogin,
  getAdminUserAudit,
  getAdminUserAuditDetail,
  type AdminUserAuditDetail,
  type AdminUserAuditOverview,
  type AdminUserAuditSummary,
} from './apiClient';

type ActivityFilter = 'all' | 'active' | 'blocked' | 'no-plays';
type UserSort = 'recent' | 'listening' | 'name';
type ActivityView = 'music' | 'podcasts' | 'audiobooks' | 'sign-ins' | 'devices';
type MobilePane = 'users' | 'detail';

const emptyOverview: AdminUserAuditOverview = {
  ok: true,
  users: [],
  totals: { users: 0, active7d: 0, activity7d: 0, estimatedListeningMs: 0 },
};

const activityDescriptions: Record<ActivityView, string> = {
  music: 'Recently played tracks',
  podcasts: 'Latest episode progress',
  audiobooks: 'Latest book progress',
  'sign-ins': 'Recent account access',
  devices: 'Browsers and apps seen by mvbar',
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

function isRecentlyActive(value: string | null) {
  return eventTime(value) >= Date.now() - 15 * 60 * 1000;
}

function Avatar({ user, large = false }: { user: AdminUserAuditSummary; large?: boolean }) {
  return (
    <div className={`${large ? 'h-14 w-14 text-xl' : 'h-11 w-11 text-base'} relative flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-slate-800 font-semibold text-slate-200 ring-1 ring-white/10`}>
      {user.email.slice(0, 1).toUpperCase()}
      {user.avatarPath && (
        <img
          src={`/api/avatars/${encodeURIComponent(user.avatarPath)}`}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
          onError={(event) => { event.currentTarget.style.display = 'none'; }}
        />
      )}
    </div>
  );
}

function OverviewStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 px-4 py-3.5 sm:px-5">
      <div className="truncate text-xs font-medium text-slate-500">{label}</div>
      <div className="mt-1 truncate text-lg font-semibold text-slate-100">{value}</div>
    </div>
  );
}

function QuickFact({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-white/[0.07] bg-white/[0.025] px-4 py-3.5" title={title}>
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className="mt-1.5 truncate text-sm font-semibold text-slate-200">{value}</div>
    </div>
  );
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex min-h-52 items-center justify-center px-6 py-12 text-center">
      <div>
        <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-slate-800/80 text-slate-500">
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M8 12h8m-4-4v8m9-4a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <div className="mt-3 text-sm font-medium text-slate-300">{title}</div>
        <div className="mt-1 text-sm text-slate-500">{description}</div>
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="space-y-1 p-3" aria-label="Loading activity">
      {[0, 1, 2, 3].map((item) => (
        <div key={item} className="flex animate-pulse items-center gap-3 rounded-xl px-2 py-3">
          <div className="h-11 w-11 shrink-0 rounded-lg bg-slate-800" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="h-3.5 w-2/5 rounded bg-slate-800" />
            <div className="h-3 w-3/5 rounded bg-slate-800/70" />
          </div>
        </div>
      ))}
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
    <div className="flex min-w-0 items-start gap-3 px-4 py-3.5 sm:items-center sm:px-5">
      <div className="relative flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-slate-800 text-sm font-semibold text-slate-500">
        {title.slice(0, 1).toUpperCase()}
        <img
          src={artworkUrl}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
          onError={(event) => { event.currentTarget.style.display = 'none'; }}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-slate-100">{title}</div>
        <div className="mt-1 truncate text-sm text-slate-500">{subtitle}</div>
        <div className="mt-1.5 flex items-center gap-2 text-xs sm:hidden">
          <span className="text-slate-500" title={dateTime(occurredAt)}>{relativeTime(occurredAt)}</span>
          <span className="text-slate-700">•</span>
          <span className={completed ? 'text-emerald-300' : 'text-slate-500'}>{detail}</span>
        </div>
      </div>
      <div className="hidden shrink-0 text-right sm:block" title={dateTime(occurredAt)}>
        <div className="text-sm text-slate-300">{relativeTime(occurredAt)}</div>
        <div className={`mt-1 text-xs ${completed ? 'text-emerald-300' : 'text-slate-500'}`}>{detail}</div>
      </div>
    </div>
  );
}

function AuditEventRow({
  markerClass,
  title,
  subtitle,
  occurredAt,
  trailing,
}: {
  markerClass: string;
  title: string;
  subtitle: string;
  occurredAt: string;
  trailing: string;
}) {
  return (
    <div className="flex min-w-0 items-start gap-3 px-4 py-3.5 sm:items-center sm:px-5">
      <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full sm:mt-0 ${markerClass}`} />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-slate-100">{title}</div>
        <div className="mt-1 truncate text-sm text-slate-500">{subtitle}</div>
        <div className="mt-1.5 flex items-center gap-2 text-xs text-slate-500 sm:hidden">
          <span title={dateTime(occurredAt)}>{relativeTime(occurredAt)}</span>
          <span className="text-slate-700">•</span>
          <span className="truncate font-mono">{trailing}</span>
        </div>
      </div>
      <div className="hidden shrink-0 text-right sm:block" title={dateTime(occurredAt)}>
        <div className="text-sm text-slate-300">{relativeTime(occurredAt)}</div>
        <div className="mt-1 max-w-44 truncate font-mono text-xs text-slate-500">{trailing}</div>
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
  const [trendDays, setTrendDays] = useState<7 | 14>(14);
  const [showAccountDetails, setShowAccountDetails] = useState(false);
  const [showAllAuditRows, setShowAllAuditRows] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [moreLoading, setMoreLoading] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
    } catch (reason: any) {
      if (reason?.status === 401) clear();
      setError(reason?.data?.error ?? reason?.message ?? 'Unable to load user audit');
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
      .then((result) => { if (current) setDetail(result); })
      .catch((reason: any) => {
        if (!current) return;
        if (reason?.status === 401) clear();
        setError(reason?.data?.error ?? reason?.message ?? 'Unable to load user activity');
      })
      .finally(() => { if (current) setDetailLoading(false); });
    return () => { current = false; };
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
        if (activityFilter === 'no-plays') return user.totalPlays + user.podcastEpisodeCount + user.audiobookCount === 0;
        if (activityFilter === 'active') return eventTime(user.lastActiveAt) >= sevenDaysAgo;
        if (activityFilter === 'blocked') return user.loginRestriction.blocked;
        return true;
      })
      .sort((left, right) => {
        if (userSort === 'name') return left.email.localeCompare(right.email);
        if (userSort === 'listening') return right.estimatedListeningMs - left.estimatedListeningMs;
        return eventTime(right.lastActiveAt) - eventTime(left.lastActiveAt);
      });
  }, [activityFilter, overview.users, query, userSort]);

  const selectedUser = overview.users.find((user) => user.id === selectedUserId) ?? null;
  const displayedDailyActivity = detail?.dailyActivity.slice(-trendDays) ?? [];
  const maxDailyActivity = Math.max(1, ...displayedDailyActivity.map((day) => day.count));

  async function loadMoreHistory() {
    if (!detail || moreLoading || detail.history.length >= detail.historyTotal) return;
    setMoreLoading(true);
    try {
      const next = await getAdminUserAuditDetail(token, detail.user.id, detail.limit, detail.history.length);
      setDetail((current) => current ? { ...next, history: [...current.history, ...next.history] } : next);
    } catch (reason: any) {
      if (reason?.status === 401) clear();
      setError(reason?.data?.error ?? reason?.message ?? 'Unable to load more history');
    } finally {
      setMoreLoading(false);
    }
  }

  async function unlockLogin() {
    if (!detail || unlocking) return;
    setUnlocking(true);
    setError(null);
    setNotice(null);
    try {
      const result = await adminUnlockUserLogin(token, detail.user.id);
      const updateUser = (user: AdminUserAuditSummary) => (
        user.id === detail.user.id ? { ...user, loginRestriction: result.loginRestriction } : user
      );
      setOverview((current) => ({ ...current, users: current.users.map(updateUser) }));
      setDetail((current) => current ? { ...current, user: updateUser(current.user) } : current);
      setNotice(`Login restrictions cleared for ${detail.user.email}.`);
    } catch (reason: any) {
      if (reason?.status === 401) clear();
      setError(reason?.data?.error ?? reason?.message ?? 'Unable to unlock account');
    } finally {
      setUnlocking(false);
    }
  }

  function resetUserFilters() {
    setQuery('');
    setActivityFilter('all');
    setUserSort('recent');
  }

  const activityTabs = detail ? [
    { id: 'music' as ActivityView, label: 'Music', count: detail.historyTotal },
    { id: 'podcasts' as ActivityView, label: 'Podcasts', count: detail.podcastHistoryTotal },
    { id: 'audiobooks' as ActivityView, label: 'Audiobooks', count: detail.audiobookHistoryTotal },
    { id: 'sign-ins' as ActivityView, label: 'Sign-ins', count: detail.user.loginCount },
    { id: 'devices' as ActivityView, label: 'Devices', count: detail.clients.length },
  ] : [];
  const currentActivity = activityTabs.find((tab) => tab.id === activityView);
  const visibleSignIns = detail ? (showAllAuditRows ? detail.signIns : detail.signIns.slice(0, 8)) : [];
  const visibleClients = detail ? (showAllAuditRows ? detail.clients : detail.clients.slice(0, 8)) : [];

  return (
    <div className="space-y-5" data-testid="admin-user-audit">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-2xl font-semibold text-white">User audit</h2>
          <p className="mt-1 text-sm text-slate-400">See how accounts access and use mvbar.</p>
        </div>
        <div className="flex items-center gap-3">
          {lastRefreshedAt && <span className="text-xs text-slate-500">Updated {relativeTime(lastRefreshedAt.toISOString())}</span>}
          <button
            onClick={() => void loadOverview()}
            disabled={loading}
            className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-700 px-3 text-sm font-medium text-slate-300 transition hover:border-slate-600 hover:bg-slate-800 hover:text-white disabled:opacity-50"
            aria-label="Refresh user audit"
          >
            <svg className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h5M20 20v-5h-5M5.6 15A7 7 0 0018 17m.4-8A7 7 0 006 7" />
            </svg>
            Refresh
          </button>
        </div>
      </header>

      {error && (
        <div className="flex items-start justify-between gap-3 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200" role="alert">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="shrink-0 text-red-300/70 hover:text-red-100" aria-label="Dismiss error">×</button>
        </div>
      )}

      {notice && (
        <div className="flex items-start justify-between gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100" role="status">
          <span>{notice}</span>
          <button onClick={() => setNotice(null)} className="shrink-0 text-emerald-200/70 hover:text-white" aria-label="Dismiss notification">×</button>
        </div>
      )}

      <div className="grid grid-cols-3 divide-x divide-slate-800 overflow-hidden rounded-xl border border-slate-800 bg-slate-900/35">
        <OverviewStat label="Accounts" value={overview.totals.users.toLocaleString()} />
        <OverviewStat label="Active in 7 days" value={overview.totals.active7d.toLocaleString()} />
        <OverviewStat label="Total listening" value={longDuration(overview.totals.estimatedListeningMs)} />
      </div>

      <section className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950/30">
        <div className="grid min-h-[660px] lg:grid-cols-[310px_minmax(0,1fr)]">
          <aside className={`${mobilePane === 'detail' ? 'hidden lg:flex' : 'flex'} min-w-0 flex-col border-slate-800 lg:border-r`} aria-label="Accounts">
            <div className="space-y-3 border-b border-slate-800 bg-slate-900/25 p-4">
              <label className="relative block">
                <span className="sr-only">Search accounts</span>
                <svg className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m21 21-4.35-4.35M19 11a8 8 0 11-16 0 8 8 0 0116 0z" />
                </svg>
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search accounts"
                  className="h-10 w-full rounded-lg border border-slate-700 bg-slate-950/70 pl-10 pr-9 text-sm text-white placeholder:text-slate-500 focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/10"
                />
                {query && (
                  <button onClick={() => setQuery('')} className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-slate-500 hover:bg-slate-800 hover:text-white" aria-label="Clear search" type="button">×</button>
                )}
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label>
                  <span className="sr-only">Filter accounts</span>
                  <select value={activityFilter} onChange={(event) => setActivityFilter(event.target.value as ActivityFilter)} className="h-9 w-full min-w-0 rounded-lg border border-slate-700 bg-slate-950/70 px-2 text-xs text-slate-300 focus:border-cyan-500 focus:outline-none">
                    <option value="all">All accounts</option>
                    <option value="active">Active this week</option>
                    <option value="blocked">Locked or rate limited</option>
                    <option value="no-plays">No activity</option>
                  </select>
                </label>
                <label>
                  <span className="sr-only">Sort accounts</span>
                  <select value={userSort} onChange={(event) => setUserSort(event.target.value as UserSort)} className="h-9 w-full min-w-0 rounded-lg border border-slate-700 bg-slate-950/70 px-2 text-xs text-slate-300 focus:border-cyan-500 focus:outline-none">
                    <option value="recent">Recent first</option>
                    <option value="listening">Most listening</option>
                    <option value="name">Name</option>
                  </select>
                </label>
              </div>
            </div>

            <div className="flex items-center justify-between border-b border-slate-800 px-4 py-2.5 text-xs text-slate-500">
              <span>{filteredUsers.length} {filteredUsers.length === 1 ? 'account' : 'accounts'}</span>
              {(query || activityFilter !== 'all' || userSort !== 'recent') && <button onClick={resetUserFilters} className="text-slate-400 hover:text-white">Reset</button>}
            </div>

            <div className="flex-1 divide-y divide-slate-800/70 overflow-y-auto lg:max-h-[690px]">
              {loading ? (
                <LoadingState />
              ) : filteredUsers.length === 0 ? (
                <div className="px-3">
                  <EmptyState title="No accounts found" description="Try another search or reset the filters." />
                  <button onClick={resetUserFilters} className="mx-auto -mt-8 mb-8 block text-sm font-medium text-cyan-300 hover:text-cyan-200">Reset filters</button>
                </div>
              ) : filteredUsers.map((user) => {
                const selected = user.id === selectedUserId;
                const online = isRecentlyActive(user.lastActiveAt);
                return (
                  <button
                    key={user.id}
                    data-testid={`audit-user-${user.id}`}
                    onClick={() => { setSelectedUserId(user.id); setMobilePane('detail'); }}
                    aria-current={selected ? 'true' : undefined}
                    className={`group flex w-full min-w-0 items-center gap-3 px-4 py-3.5 text-left transition ${selected ? 'bg-cyan-500/[0.08]' : 'hover:bg-white/[0.035]'}`}
                  >
                    <div className="relative">
                      <Avatar user={user} />
                      <span className={`absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-slate-950 ${online ? 'bg-emerald-400' : 'bg-slate-600'}`} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className={`truncate text-sm font-medium ${selected ? 'text-cyan-100' : 'text-slate-200'}`}>{user.email}</div>
                      <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-slate-500">
                        {user.loginRestriction.blocked ? (
                          <span className="shrink-0 rounded-full bg-red-500/10 px-1.5 py-0.5 font-medium text-red-300">Blocked</span>
                        ) : (
                          <span className="truncate" title={dateTime(user.lastActiveAt)}>{online ? 'Active now' : `Active ${relativeTime(user.lastActiveAt)}`}</span>
                        )}
                        {user.activity7d > 0 && <><span className="text-slate-700">•</span><span className="shrink-0">{user.activity7d} this week</span></>}
                      </div>
                    </div>
                    <svg className="h-4 w-4 shrink-0 text-slate-600 group-hover:text-slate-400 lg:hidden" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m9 18 6-6-6-6" />
                    </svg>
                  </button>
                );
              })}
            </div>
          </aside>

          <main className={`${mobilePane === 'users' ? 'hidden lg:block' : 'block'} min-w-0`}>
            {!selectedUser ? (
              <div className="flex h-full min-h-[520px] items-center justify-center px-6 text-center text-sm text-slate-500">Select an account to view its activity.</div>
            ) : detailLoading && !detail ? (
              <LoadingState />
            ) : detail ? (
              <div data-testid="audit-user-detail">
                <div className="border-b border-slate-800 px-4 py-5 sm:px-6">
                  <div className="flex min-w-0 items-center gap-3">
                    <button onClick={() => setMobilePane('users')} className="-ml-2 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-white lg:hidden" aria-label="Back to accounts">
                      <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m15 18-6-6 6-6" /></svg>
                    </button>
                    <Avatar user={detail.user} large />
                    <div className="min-w-0 flex-1">
                      <h3 className="truncate text-lg font-semibold text-white sm:text-xl" title={detail.user.email}>{detail.user.email}</h3>
                      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                        <span>{authLabel(detail.user.authProvider)}</span>
                        {detail.user.role === 'admin' && <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-amber-200">Admin</span>}
                        {detail.user.loginRestriction.blocked && <span className="rounded-full bg-red-500/10 px-2 py-0.5 font-medium text-red-300">Login blocked</span>}
                        <span className={`h-1.5 w-1.5 rounded-full ${isRecentlyActive(detail.user.lastActiveAt) ? 'bg-emerald-400' : 'bg-slate-600'}`} />
                        <span>{isRecentlyActive(detail.user.lastActiveAt) ? 'Active now' : `Active ${relativeTime(detail.user.lastActiveAt)}`}</span>
                      </div>
                    </div>
                  </div>

                  <div className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-3">
                    <QuickFact label="Last active" value={relativeTime(detail.user.lastActiveAt)} title={dateTime(detail.user.lastActiveAt)} />
                    <QuickFact label="Total listening" value={longDuration(detail.user.estimatedListeningMs)} />
                    <QuickFact label="Activity this week" value={`${detail.user.activity7d.toLocaleString()} events`} />
                  </div>

                  <div className="mt-4 flex flex-wrap gap-2">
                    <button onClick={() => setShowAccountDetails((current) => !current)} aria-expanded={showAccountDetails} className={`inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-xs font-medium transition ${showAccountDetails ? 'border-cyan-500/30 bg-cyan-500/10 text-cyan-100' : 'border-slate-700 text-slate-400 hover:bg-slate-800 hover:text-white'}`}>
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 17v-6m0-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                      Account info
                    </button>
                    <button onClick={() => setShowTrend((current) => !current)} aria-expanded={showTrend} className={`inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-xs font-medium transition ${showTrend ? 'border-cyan-500/30 bg-cyan-500/10 text-cyan-100' : 'border-slate-700 text-slate-400 hover:bg-slate-800 hover:text-white'}`}>
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 19V9m5 10V5m5 14v-7m5 7V8" /></svg>
                      Activity trend
                    </button>
                  </div>
                </div>

                {detail.user.loginRestriction.blocked && (
                  <div className="border-b border-red-500/20 bg-red-500/[0.07] px-4 py-4 sm:px-6" data-testid="audit-login-restriction">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-red-100">
                          {detail.user.loginRestriction.locked && detail.user.loginRestriction.rateLimited
                            ? 'Account lock and rate limit are active'
                            : detail.user.loginRestriction.locked ? 'Account is locked' : 'Login rate limit is active'}
                        </div>
                        <p className="mt-1 text-xs leading-5 text-red-200/70">
                          {detail.user.loginRestriction.failedAttempts.toLocaleString()} failed attempts
                          {detail.user.loginRestriction.ips.length > 0 ? ` from ${detail.user.loginRestriction.ips.join(', ')}` : ''}
                          {detail.user.loginRestriction.blockedUntil ? ` · expires ${dateTime(new Date(detail.user.loginRestriction.blockedUntil).toISOString())}` : ''}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void unlockLogin()}
                        disabled={unlocking}
                        className="inline-flex h-10 shrink-0 items-center justify-center rounded-lg bg-red-500 px-4 text-sm font-semibold text-white transition hover:bg-red-400 disabled:cursor-wait disabled:opacity-60"
                      >
                        {unlocking ? 'Unlocking…' : 'Unlock login'}
                      </button>
                    </div>
                  </div>
                )}

                {showAccountDetails && (
                  <div className="grid grid-cols-1 gap-x-8 gap-y-4 border-b border-slate-800 bg-slate-900/35 px-5 py-5 sm:grid-cols-2 xl:grid-cols-3" data-testid="audit-account-details">
                    {[
                      ['Last sign-in', dateTime(detail.user.lastLoginAt)],
                      ['Last IP', detail.user.lastLoginIp || detail.user.lastActiveIp || 'Not recorded'],
                      ['Joined', dateTime(detail.user.createdAt)],
                      ['Access', `${detail.user.loginCount.toLocaleString()} sign-ins · ${detail.clients.length.toLocaleString()} devices`],
                      ['Saved music', `${detail.user.favoriteCount.toLocaleString()} loved · ${detail.user.playlistCount.toLocaleString()} playlists`],
                      ['Approval', detail.user.approvalStatus],
                    ].map(([label, value]) => (
                      <div key={label} className="min-w-0">
                        <div className="text-xs font-medium text-slate-500">{label}</div>
                        <div className={`mt-1 truncate text-sm text-slate-200 ${label === 'Last IP' ? 'font-mono' : ''}`} title={value}>{value}</div>
                      </div>
                    ))}
                  </div>
                )}

                {showTrend && (
                  <div className="border-b border-slate-800 bg-slate-900/20 px-5 py-5 sm:px-6" data-testid="audit-activity-trend">
                    <div className="flex items-center justify-between gap-4">
                      <div><div className="text-sm font-medium text-slate-200">Daily activity</div><div className="mt-1 text-xs text-slate-500">All media events</div></div>
                      <div className="flex rounded-lg border border-slate-700 bg-slate-950/60 p-0.5">
                        {([7, 14] as const).map((days) => (
                          <button key={days} onClick={() => setTrendDays(days)} className={`h-7 rounded-md px-2.5 text-xs font-medium ${trendDays === days ? 'bg-slate-700 text-white' : 'text-slate-500 hover:text-slate-200'}`}>{days} days</button>
                        ))}
                      </div>
                    </div>
                    <div className="mt-5 flex h-24 items-end gap-1.5">
                      {displayedDailyActivity.map((day) => (
                        <div key={day.date} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1.5" title={`${day.date}: ${day.count} events`}>
                          <div className={`w-full max-w-8 rounded-t-sm ${day.count > 0 ? 'bg-cyan-500/70' : 'bg-slate-800'}`} style={{ height: `${Math.max(day.count > 0 ? 8 : 2, (day.count / maxDailyActivity) * 66)}px` }} />
                          <span className="text-[10px] text-slate-600">{new Intl.DateTimeFormat(undefined, { weekday: 'narrow' }).format(new Date(`${day.date}T12:00:00`))}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="border-b border-slate-800 px-4 py-4 sm:px-5">
                  <div className="flex items-end justify-between gap-3">
                    <div className="min-w-0"><h4 className="text-base font-semibold text-slate-100">Activity</h4><p className="mt-0.5 text-xs text-slate-500">{activityDescriptions[activityView]}</p></div>
                    {currentActivity && <span className="shrink-0 text-xs text-slate-500">{currentActivity.count.toLocaleString()} records</span>}
                  </div>
                  <label className="mt-3 block sm:hidden">
                    <span className="sr-only">Activity type</span>
                    <select value={activityView} onChange={(event) => setActivityView(event.target.value as ActivityView)} className="h-10 w-full rounded-lg border border-slate-700 bg-slate-950/70 px-3 text-sm text-slate-200 focus:border-cyan-500 focus:outline-none">
                      {activityTabs.map((tab) => <option key={tab.id} value={tab.id}>{tab.label} ({tab.count.toLocaleString()})</option>)}
                    </select>
                  </label>
                  <div className="no-scrollbar -mx-1 mt-3 hidden overflow-x-auto px-1 sm:block">
                    <div className="flex min-w-max gap-1" role="tablist" aria-label="User activity type">
                      {activityTabs.map((tab) => (
                        <button key={tab.id} role="tab" aria-selected={activityView === tab.id} onClick={() => setActivityView(tab.id)} className={`h-9 rounded-lg px-3 text-sm font-medium transition ${activityView === tab.id ? 'bg-slate-700 text-white' : 'text-slate-400 hover:bg-slate-800/70 hover:text-white'}`}>
                          {tab.label}<span className="ml-1.5 text-xs opacity-60">{tab.count.toLocaleString()}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="divide-y divide-slate-800/70 overflow-y-auto lg:max-h-[520px]" data-testid={`audit-activity-${activityView}`}>
                  {activityView === 'music' && detail.history.map((item) => (
                    <MediaActivityRow key={item.historyId} artworkUrl={`/api/library/tracks/${item.trackId}/art`} title={item.title || 'Unknown track'} subtitle={[item.artist, item.album].filter(Boolean).join(' · ') || 'Unknown artist'} occurredAt={item.playedAt} detail={duration(item.durationMs)} />
                  ))}
                  {activityView === 'podcasts' && detail.podcastHistory.map((item) => (
                    <MediaActivityRow key={item.activityId} artworkUrl={`/api/podcasts/episodes/${item.episodeId}/art`} title={item.episodeTitle} subtitle={item.podcastTitle} occurredAt={item.updatedAt} completed={item.completed} detail={item.completed ? 'Completed' : `${duration(item.positionMs)} played`} />
                  ))}
                  {activityView === 'audiobooks' && detail.audiobookHistory.map((item) => (
                    <MediaActivityRow key={item.activityId} artworkUrl={`/api/audiobook-art/${item.audiobookId}`} title={item.bookTitle} subtitle={[item.author, item.chapterTitle].filter(Boolean).join(' · ') || 'Unknown author'} occurredAt={item.updatedAt} completed={item.completed} detail={item.completed ? 'Completed' : `${duration(item.positionMs)} played`} />
                  ))}
                  {activityView === 'sign-ins' && visibleSignIns.map((signIn, index) => {
                    const successful = signIn.event === 'login_ok';
                    const label = successful
                      ? signIn.method === 'google'
                        ? signIn.backfilledFrom === 'account_creation' ? 'First Google sign-in' : 'Google sign-in'
                        : signIn.method === 'password' ? 'Password sign-in' : 'Signed in'
                      : signIn.event === 'login_locked' ? 'Locked attempt' : 'Failed attempt';
                    const device = [clientLabel(signIn.clientType), signIn.appVersion, signIn.deviceName, signIn.platform].filter(Boolean).join(' · ') || 'No client details';
                    return <AuditEventRow key={`${signIn.ts}-${index}`} markerClass={successful ? 'bg-emerald-400' : 'bg-red-400'} title={label} subtitle={device} occurredAt={signIn.ts} trailing={signIn.ip || 'No IP'} />;
                  })}
                  {activityView === 'devices' && visibleClients.map((client) => (
                    <AuditEventRow key={client.clientId} markerClass="bg-violet-400" title={clientLabel(client.clientType)} subtitle={[client.deviceName, client.appVersion, client.platform].filter(Boolean).join(' · ') || 'No device details'} occurredAt={client.lastSeenAt} trailing={client.lastSeenIp || 'No IP'} />
                  ))}

                  {activityView === 'music' && detail.history.length === 0 && <EmptyState title="No music history" description="Played tracks will appear here." />}
                  {activityView === 'podcasts' && detail.podcastHistory.length === 0 && <EmptyState title="No podcast activity" description="Episode progress will appear here." />}
                  {activityView === 'audiobooks' && detail.audiobookHistory.length === 0 && <EmptyState title="No audiobook activity" description="Book progress will appear here." />}
                  {activityView === 'sign-ins' && detail.signIns.length === 0 && <EmptyState title="No sign-ins recorded" description="Future account access will appear here." />}
                  {activityView === 'devices' && detail.clients.length === 0 && <EmptyState title="No devices recorded" description="Connected apps and browsers will appear here." />}
                </div>

                {activityView === 'music' && detail.history.length < detail.historyTotal && (
                  <div className="border-t border-slate-800 p-3"><button onClick={() => void loadMoreHistory()} disabled={moreLoading} className="h-10 w-full rounded-lg text-sm font-medium text-slate-400 hover:bg-slate-800 hover:text-white disabled:opacity-50">{moreLoading ? 'Loading…' : `Load more · ${detail.history.length} of ${detail.historyTotal}`}</button></div>
                )}
                {activityView === 'podcasts' && detail.podcastHistory.length < detail.podcastHistoryTotal && (
                  <div className="border-t border-slate-800 px-5 py-3 text-center text-xs text-slate-500">Showing the latest {detail.podcastHistory.length.toLocaleString()} of {detail.podcastHistoryTotal.toLocaleString()}</div>
                )}
                {activityView === 'audiobooks' && detail.audiobookHistory.length < detail.audiobookHistoryTotal && (
                  <div className="border-t border-slate-800 px-5 py-3 text-center text-xs text-slate-500">Showing the latest {detail.audiobookHistory.length.toLocaleString()} of {detail.audiobookHistoryTotal.toLocaleString()}</div>
                )}
                {activityView === 'sign-ins' && detail.signIns.length > 8 && (
                  <div className="border-t border-slate-800 p-3"><button onClick={() => setShowAllAuditRows((current) => !current)} className="h-10 w-full rounded-lg text-sm font-medium text-slate-400 hover:bg-slate-800 hover:text-white">{showAllAuditRows ? 'Show recent sign-ins' : `Show all ${detail.signIns.length} sign-ins`}</button></div>
                )}
                {activityView === 'devices' && detail.clients.length > 8 && (
                  <div className="border-t border-slate-800 p-3"><button onClick={() => setShowAllAuditRows((current) => !current)} className="h-10 w-full rounded-lg text-sm font-medium text-slate-400 hover:bg-slate-800 hover:text-white">{showAllAuditRows ? 'Show recent devices' : `Show all ${detail.clients.length} devices`}</button></div>
                )}
              </div>
            ) : null}
          </main>
        </div>
      </section>
    </div>
  );
}

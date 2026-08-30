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
type MetricTone = 'cyan' | 'rose' | 'emerald' | 'amber';

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

function activityTabClass(view: ActivityView, active: boolean) {
  if (!active) return 'border-transparent text-slate-400 hover:text-white hover:bg-slate-800/60';
  if (view === 'music') return 'border-rose-400 text-rose-100 bg-rose-500/10';
  if (view === 'podcasts') return 'border-emerald-400 text-emerald-100 bg-emerald-500/10';
  if (view === 'audiobooks') return 'border-amber-400 text-amber-100 bg-amber-500/10';
  if (view === 'sign-ins') return 'border-cyan-400 text-cyan-100 bg-cyan-500/10';
  return 'border-violet-400 text-violet-100 bg-violet-500/10';
}

function eventTime(value: string | null) {
  return value ? new Date(value).getTime() : 0;
}

function isRecentlyActive(value: string | null) {
  return eventTime(value) >= Date.now() - 15 * 60 * 1000;
}

function Avatar({
  user,
  size = 'md',
}: {
  user: AdminUserAuditSummary;
  size?: 'sm' | 'md' | 'lg';
}) {
  const dimensions = size === 'lg' ? 'w-14 h-14 text-xl' : size === 'sm' ? 'w-11 h-11 text-base' : 'w-12 h-12 text-lg';
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
  tone,
}: {
  label: string;
  value: string;
  detail?: string;
  tone: MetricTone;
}) {
  const tones: Record<MetricTone, { panel: string; icon: string; value: string }> = {
    cyan: {
      panel: 'border-cyan-500/25 bg-cyan-500/10',
      icon: 'bg-cyan-400/15 text-cyan-300',
      value: 'text-cyan-100',
    },
    rose: {
      panel: 'border-rose-500/25 bg-rose-500/10',
      icon: 'bg-rose-400/15 text-rose-300',
      value: 'text-rose-100',
    },
    emerald: {
      panel: 'border-emerald-500/25 bg-emerald-500/10',
      icon: 'bg-emerald-400/15 text-emerald-300',
      value: 'text-emerald-100',
    },
    amber: {
      panel: 'border-amber-500/25 bg-amber-500/10',
      icon: 'bg-amber-400/15 text-amber-300',
      value: 'text-amber-100',
    },
  };
  const style = tones[tone];

  return (
    <div className={`min-w-0 p-4 rounded-lg border ${style.panel}`}>
      <div className="flex items-center gap-2">
        <span className={`w-8 h-8 rounded-md flex items-center justify-center ${style.icon}`}>
          {tone === 'cyan' && (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6l4 2m5-2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          )}
          {tone === 'rose' && (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 18V5l10-2v13M9 9l10-2M6 20c1.66 0 3-1.12 3-2.5S7.66 15 6 15s-3 1.12-3 2.5S4.34 20 6 20zm10-2c1.66 0 3-1.12 3-2.5S17.66 13 16 13s-3 1.12-3 2.5 1.34 2.5 3 2.5z" />
            </svg>
          )}
          {tone === 'emerald' && (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 17V7a4 4 0 018 0v10M5 13v2a3 3 0 003 3m11-5v2a3 3 0 01-3 3M5 13H3v-3h2m14 3h2v-3h-2" />
            </svg>
          )}
          {tone === 'amber' && (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5.5A2.5 2.5 0 016.5 3H11v16H6.5A2.5 2.5 0 004 21V5.5zm16 0A2.5 2.5 0 0017.5 3H13v16h4.5A2.5 2.5 0 0120 21V5.5z" />
            </svg>
          )}
        </span>
        <div className="text-sm font-medium text-slate-300">{label}</div>
      </div>
      <div className={`text-2xl font-semibold mt-3 truncate ${style.value}`}>{value}</div>
      {detail && <div className="text-xs text-slate-400 mt-1 truncate">{detail}</div>}
    </div>
  );
}

function OverviewStat({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass: string;
}) {
  return (
    <div className="min-w-0 px-4 py-3">
      <div className="text-xs font-medium text-slate-400">{label}</div>
      <div className={`text-xl font-semibold mt-1 truncate ${valueClass}`}>{value}</div>
    </div>
  );
}

function EmptyActivity({ children }: { children: string }) {
  return (
    <div className="h-52 flex items-center justify-center text-base text-slate-400">
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
    <div className="px-5 py-4 flex items-center gap-4">
      <div className="relative w-12 h-12 rounded-md bg-slate-800 text-slate-400 shrink-0 overflow-hidden flex items-center justify-center text-base font-semibold">
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
        <div className="text-base font-semibold text-slate-100 truncate">{title}</div>
        <div className="text-sm text-slate-400 truncate mt-1">{subtitle}</div>
      </div>
      <div className="text-right shrink-0 max-w-40" title={dateTime(occurredAt)}>
        <div className="text-sm font-medium text-slate-200">{relativeTime(occurredAt)}</div>
        <div className={`text-xs truncate mt-1 ${completed ? 'text-emerald-300' : 'text-slate-500'}`}>
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
  const [trendDays, setTrendDays] = useState<7 | 14>(14);
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
  const displayedDailyActivity = detail?.dailyActivity.slice(-trendDays) ?? [];
  const maxDailyActivity = Math.max(1, ...(displayedDailyActivity.map((day) => day.count) ?? [0]));

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

      <header className="flex flex-col lg:flex-row lg:items-center justify-between gap-5">
        <div className="min-w-0">
          <h2 className="text-2xl font-semibold text-white">User audit</h2>
          <p className="text-base text-slate-400 mt-1.5">
            Review listening, account access, and connected devices
          </p>
        </div>
        <div className="flex items-center gap-3 w-full lg:w-auto">
          <div className="grid grid-cols-3 flex-1 lg:flex-none lg:w-[430px] divide-x divide-slate-700/70 border border-slate-700/70 rounded-lg bg-slate-900/55">
            <OverviewStat label="Accounts" value={overview.totals.users.toLocaleString()} valueClass="text-cyan-200" />
            <OverviewStat label="Active this week" value={overview.totals.active7d.toLocaleString()} valueClass="text-emerald-200" />
            <OverviewStat label="Total listening" value={longDuration(overview.totals.estimatedListeningMs)} valueClass="text-amber-200" />
          </div>
          {lastRefreshedAt && (
            <span className="hidden xl:block text-sm text-slate-500 shrink-0">
              Updated {relativeTime(lastRefreshedAt.toISOString())}
            </span>
          )}
          <button
            onClick={() => void loadOverview()}
            disabled={loading}
            className="w-11 h-11 inline-flex items-center justify-center rounded-lg border border-slate-700/70 text-slate-300 hover:text-white hover:bg-slate-800 disabled:opacity-50 shrink-0"
            title="Refresh user audit"
            aria-label="Refresh user audit"
          >
            <svg className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h5M20 20v-5h-5M5.6 15A7 7 0 0018 17m.4-8A7 7 0 006 7" />
            </svg>
          </button>
        </div>
      </header>

      <section className="border border-slate-700/70 rounded-lg overflow-hidden bg-slate-950/25">
        <div className="grid lg:grid-cols-[330px_minmax(0,1fr)] min-h-[720px]">
          <aside className={`${mobilePane === 'detail' ? 'hidden lg:flex' : 'flex'} min-w-0 flex-col lg:border-r border-slate-800`}>
            <div className="p-4 space-y-3 border-b border-slate-800 bg-slate-900/30">
              <label className="relative block">
                <svg className="absolute left-3.5 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m21 21-4.35-4.35M19 11a8 8 0 11-16 0 8 8 0 0116 0z" />
                </svg>
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Find an account"
                  className="w-full h-11 pl-11 pr-3 bg-slate-950/70 border border-slate-700 rounded-lg text-base text-white placeholder:text-slate-500 focus:outline-none focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/10"
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <select
                  value={activityFilter}
                  onChange={(event) => setActivityFilter(event.target.value as ActivityFilter)}
                  aria-label="Filter accounts"
                  className="h-10 min-w-0 px-3 bg-slate-950/70 border border-slate-700 rounded-lg text-sm text-slate-300 focus:outline-none focus:border-cyan-400"
                >
                  <option value="all">All accounts</option>
                  <option value="active">Active this week</option>
                  <option value="no-plays">No listening</option>
                </select>
                <select
                  value={userSort}
                  onChange={(event) => setUserSort(event.target.value as UserSort)}
                  aria-label="Sort accounts"
                  className="h-10 min-w-0 px-3 bg-slate-950/70 border border-slate-700 rounded-lg text-sm text-slate-300 focus:outline-none focus:border-cyan-400"
                >
                  <option value="recent">Most recent</option>
                  <option value="listening">Most listening</option>
                  <option value="name">Account name</option>
                </select>
              </div>
            </div>

            <div className="px-4 py-3 text-xs font-medium uppercase text-slate-500 border-b border-slate-800">
              {filteredUsers.length} {filteredUsers.length === 1 ? 'account' : 'accounts'}
            </div>

            <div className="flex-1 lg:max-h-[720px] overflow-y-auto divide-y divide-slate-800/70">
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
                    className={`relative w-full px-4 py-4 text-left flex items-center gap-3.5 ${
                      selected ? 'bg-cyan-500/10' : 'hover:bg-slate-900/80'
                    }`}
                  >
                    {selected && <span className="absolute inset-y-3 left-0 w-1 rounded-r bg-cyan-400" />}
                    <Avatar user={user} size="sm" />
                    <div className="min-w-0 flex-1">
                      <div className="text-[15px] font-semibold text-slate-100 truncate">{user.email}</div>
                      <div className="flex items-center gap-2 text-[13px] text-slate-400 truncate mt-1.5">
                        <span className={`w-2 h-2 rounded-full shrink-0 ${
                          isRecentlyActive(user.lastActiveAt) ? 'bg-emerald-400' : 'bg-slate-600'
                        }`} />
                        <span className="truncate">Active {relativeTime(user.lastActiveAt)}</span>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-sm font-semibold text-cyan-200">{longDuration(user.estimatedListeningMs)}</div>
                      <div className="text-xs text-slate-500 mt-1.5">{user.activity7d} this week</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </aside>

          <main className={`${mobilePane === 'users' ? 'hidden lg:block' : 'block'} min-w-0`}>
            {!selectedUser ? (
              <div className="h-full min-h-[560px] flex items-center justify-center text-base text-slate-400">
                Select an account to inspect its activity
              </div>
            ) : detailLoading && !detail ? (
              <div className="h-full min-h-[520px] flex items-center justify-center">
                <div className="w-7 h-7 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin" />
              </div>
            ) : detail ? (
              <div data-testid="audit-user-detail">
                <div className="px-5 sm:px-6 py-5 border-b border-slate-800">
                  <div className="flex items-center gap-3 sm:gap-4">
                    <button
                      onClick={() => setMobilePane('users')}
                      className="lg:hidden w-11 h-11 -ml-2 inline-flex items-center justify-center rounded-lg text-slate-300 hover:text-white hover:bg-slate-800"
                      title="Back to accounts"
                      aria-label="Back to accounts"
                    >
                      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m15 18-6-6 6-6" />
                      </svg>
                    </button>
                    <Avatar user={detail.user} size="lg" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <h3 className="text-lg sm:text-xl font-semibold leading-snug text-white break-all sm:truncate">
                          {detail.user.email}
                        </h3>
                        {detail.user.role === 'admin' && (
                          <span className="px-2 py-1 rounded text-xs font-medium bg-amber-500/15 text-amber-200 shrink-0">
                            Admin
                          </span>
                        )}
                      </div>
                      <div className="flex items-center flex-wrap gap-x-2 gap-y-1 text-sm text-slate-400 mt-1.5">
                        {authLabel(detail.user.authProvider)}
                        <span className="mx-1.5 text-slate-700">/</span>
                        <span className={`w-2 h-2 rounded-full shrink-0 ${
                          isRecentlyActive(detail.user.lastActiveAt) ? 'bg-emerald-400' : 'bg-slate-600'
                        }`} />
                        <span>Active {relativeTime(detail.user.lastActiveAt)}</span>
                      </div>
                    </div>
                    <button
                      onClick={() => setShowAccountDetails((current) => !current)}
                      aria-expanded={showAccountDetails}
                      aria-label="Details"
                      title="Account details"
                      className={`w-11 sm:w-auto h-11 sm:px-4 rounded-lg text-sm font-medium inline-flex items-center justify-center shrink-0 ${
                        showAccountDetails
                          ? 'bg-cyan-500/15 text-cyan-100 border border-cyan-500/30'
                          : 'text-slate-300 border border-slate-700 hover:text-white hover:bg-slate-800'
                      }`}
                    >
                      <svg className="sm:hidden w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 17v-6m0-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      <span className="hidden sm:inline">Details</span>
                    </button>
                  </div>

                  <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 mt-6">
                    <Metric tone="cyan" label="Listening" value={longDuration(detail.user.estimatedListeningMs)} detail="Estimated total" />
                    <Metric tone="rose" label="Music" value={detail.user.totalPlays.toLocaleString()} detail="Tracks played" />
                    <Metric tone="emerald" label="Podcasts" value={detail.user.podcastEpisodeCount.toLocaleString()} detail={`${detail.user.podcastCompletedCount} completed`} />
                    <Metric tone="amber" label="Audiobooks" value={detail.user.audiobookCount.toLocaleString()} detail={`${detail.user.audiobookCompletedCount} completed`} />
                  </div>
                </div>

                {showAccountDetails && (
                  <div
                    className="px-5 sm:px-6 py-5 bg-slate-900/45 border-b border-slate-800 grid grid-cols-2 md:grid-cols-3 gap-x-7 gap-y-5"
                    data-testid="audit-account-details"
                  >
                    <div>
                      <div className="text-xs font-medium uppercase text-slate-500">Last sign-in</div>
                      <div className="text-sm text-slate-200 mt-1.5">{dateTime(detail.user.lastLoginAt)}</div>
                    </div>
                    <div>
                      <div className="text-xs font-medium uppercase text-slate-500">Last IP</div>
                      <div className="text-sm font-mono text-slate-200 mt-1.5 truncate">
                        {detail.user.lastLoginIp || detail.user.lastActiveIp || 'Not recorded'}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs font-medium uppercase text-slate-500">Joined</div>
                      <div className="text-sm text-slate-200 mt-1.5">{dateTime(detail.user.createdAt)}</div>
                    </div>
                    <div>
                      <div className="text-xs font-medium uppercase text-slate-500">Access history</div>
                      <div className="text-sm text-slate-200 mt-1.5">
                        {detail.user.loginCount.toLocaleString()} sign-ins / {detail.clients.length.toLocaleString()} devices
                      </div>
                    </div>
                    <div>
                      <div className="text-xs font-medium uppercase text-slate-500">Saved music</div>
                      <div className="text-sm text-slate-200 mt-1.5">
                        {detail.user.favoriteCount.toLocaleString()} loved / {detail.user.playlistCount.toLocaleString()} playlists
                      </div>
                    </div>
                    <div>
                      <div className="text-xs font-medium uppercase text-slate-500">Approval</div>
                      <div className="text-sm text-emerald-300 mt-1.5 capitalize">{detail.user.approvalStatus}</div>
                    </div>
                  </div>
                )}

                <div className="px-4 sm:px-5 pt-4 border-b border-slate-800 flex items-end gap-3 bg-slate-900/20">
                  <label className="sm:hidden flex-1 min-w-0 mb-2">
                    <span className="sr-only">Activity type</span>
                    <select
                      value={activityView}
                      onChange={(event) => setActivityView(event.target.value as ActivityView)}
                      aria-label="Activity type"
                      className="w-full h-11 px-3 bg-slate-950/70 border border-slate-700 rounded-lg text-sm text-slate-200 focus:outline-none focus:border-cyan-400"
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
                          className={`h-12 px-4 border-b-[3px] text-sm font-medium transition-colors ${activityTabClass(
                            tab.id,
                            activityView === tab.id,
                          )}`}
                        >
                          {tab.label}
                          <span className="ml-2 px-1.5 py-0.5 rounded bg-white/10 text-xs opacity-80">{tab.count.toLocaleString()}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                  <button
                    onClick={() => setShowTrend((current) => !current)}
                    aria-expanded={showTrend}
                    className={`h-11 mb-1.5 px-3 inline-flex items-center gap-2 rounded-lg text-sm font-medium shrink-0 border ${
                      showTrend
                        ? 'bg-cyan-500/15 text-cyan-100 border-cyan-500/30'
                        : 'text-slate-300 border-slate-700 hover:text-white hover:bg-slate-800'
                    }`}
                    title="Show 14-day activity trend"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 19V9m5 10V5m5 14v-7m5 7V8" />
                    </svg>
                    <span className="hidden sm:inline">Trend</span>
                  </button>
                </div>

                {showTrend && (
                  <div className="px-5 sm:px-6 py-5 border-b border-slate-800 bg-cyan-500/5" data-testid="audit-activity-trend">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-base font-semibold text-slate-100">Listening activity</div>
                        <div className="text-sm text-slate-400 mt-1">Daily events across all media</div>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="grid grid-cols-2 p-1 bg-slate-950/70 border border-slate-700 rounded-lg">
                          {([7, 14] as const).map((days) => (
                            <button
                              key={days}
                              onClick={() => setTrendDays(days)}
                              className={`h-8 px-3 rounded-md text-xs font-medium ${
                                trendDays === days ? 'bg-cyan-500/20 text-cyan-100' : 'text-slate-400 hover:text-white'
                              }`}
                            >
                              {days} days
                            </button>
                          ))}
                        </div>
                        <div className="hidden sm:block text-right">
                          <div className="text-xl font-semibold text-cyan-100">{detail.user.activity7d.toLocaleString()}</div>
                          <div className="text-xs text-slate-400">events this week</div>
                        </div>
                      </div>
                    </div>
                    <div className="h-24 flex items-end gap-2 mt-5">
                      {displayedDailyActivity.map((day) => (
                        <div
                          key={day.date}
                          className="h-full flex-1 min-w-0 flex flex-col items-center justify-end gap-1"
                          title={`${day.date}: ${day.count} activities`}
                        >
                          <div
                            className={`w-full max-w-10 rounded-t ${day.count > 0 ? 'bg-cyan-400/80' : 'bg-slate-800'}`}
                            style={{ height: `${Math.max(day.count > 0 ? 10 : 3, (day.count / maxDailyActivity) * 65)}px` }}
                          />
                          <span className="text-xs text-slate-500">
                            {new Intl.DateTimeFormat(undefined, { weekday: 'narrow' }).format(new Date(`${day.date}T12:00:00`))}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="lg:max-h-[540px] overflow-y-auto divide-y divide-slate-800/70" data-testid={`audit-activity-${activityView}`}>
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
                      <div key={`${signIn.ts}-${index}`} className="px-5 py-4 flex items-center gap-4">
                        <span className={`w-3 h-3 rounded-full shrink-0 ${successful ? 'bg-emerald-400' : 'bg-red-400'}`} />
                        <div className="min-w-0 flex-1">
                          <div className="text-base font-medium text-slate-100">{label}</div>
                          <div className="text-sm text-slate-400 truncate mt-1">{device}</div>
                        </div>
                        <div className="text-right shrink-0" title={dateTime(signIn.ts)}>
                          <div className="text-sm font-medium text-slate-200">{relativeTime(signIn.ts)}</div>
                          <div className="text-xs font-mono text-slate-500 mt-1">{signIn.ip || 'No IP'}</div>
                        </div>
                      </div>
                    );
                  })}

                  {activityView === 'devices' && visibleClients.map((client) => (
                    <div key={client.clientId} className="px-5 py-4 flex items-center gap-4">
                      <div className="w-12 h-12 rounded-md bg-violet-500/15 flex items-center justify-center text-base font-semibold text-violet-200 shrink-0">
                        {clientLabel(client.clientType).slice(0, 1)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-base font-medium text-slate-100">{clientLabel(client.clientType)}</div>
                        <div className="text-sm text-slate-400 truncate mt-1">
                          {[client.deviceName, client.appVersion, client.platform].filter(Boolean).join(' / ') || 'No device details'}
                        </div>
                      </div>
                      <div className="text-right shrink-0" title={dateTime(client.lastSeenAt)}>
                        <div className="text-sm font-medium text-slate-200">{relativeTime(client.lastSeenAt)}</div>
                        <div className="text-xs font-mono text-slate-500 mt-1">{client.lastSeenIp || 'No IP'}</div>
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
                  <div className="p-4 border-t border-slate-800">
                    <button
                      onClick={() => void loadMoreHistory()}
                      disabled={moreLoading}
                      className="w-full h-11 rounded-lg text-base font-medium text-slate-300 hover:text-white hover:bg-slate-800 disabled:opacity-50"
                    >
                      {moreLoading ? 'Loading' : `Load more (${detail.history.length} of ${detail.historyTotal})`}
                    </button>
                  </div>
                )}

                {activityView === 'podcasts' && detail.podcastHistory.length < detail.podcastHistoryTotal && (
                  <div className="px-5 py-4 border-t border-slate-800 text-center text-sm text-slate-400">
                    Latest {detail.podcastHistory.length.toLocaleString()} of {detail.podcastHistoryTotal.toLocaleString()} records
                  </div>
                )}

                {activityView === 'audiobooks' && detail.audiobookHistory.length < detail.audiobookHistoryTotal && (
                  <div className="px-5 py-4 border-t border-slate-800 text-center text-sm text-slate-400">
                    Latest {detail.audiobookHistory.length.toLocaleString()} of {detail.audiobookHistoryTotal.toLocaleString()} records
                  </div>
                )}

                {activityView === 'sign-ins' && detail.signIns.length > 8 && (
                  <div className="p-4 border-t border-slate-800">
                    <button
                      onClick={() => setShowAllAuditRows((current) => !current)}
                      className="w-full h-11 rounded-lg text-base font-medium text-slate-300 hover:text-white hover:bg-slate-800"
                    >
                      {showAllAuditRows ? 'Show recent sign-ins' : `Show all ${detail.signIns.length} sign-ins`}
                    </button>
                  </div>
                )}

                {activityView === 'devices' && detail.clients.length > 8 && (
                  <div className="p-4 border-t border-slate-800">
                    <button
                      onClick={() => setShowAllAuditRows((current) => !current)}
                      className="w-full h-11 rounded-lg text-base font-medium text-slate-300 hover:text-white hover:bg-slate-800"
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

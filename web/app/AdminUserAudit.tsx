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

const emptyOverview: AdminUserAuditOverview = {
  ok: true,
  users: [],
  totals: { users: 0, active7d: 0, plays7d: 0, estimatedListeningMs: 0 },
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

function mostRecentActivity(user: AdminUserAuditSummary) {
  return user.lastActiveAt;
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

function Metric({
  label,
  value,
  accent,
  title,
}: {
  label: string;
  value: string;
  accent: string;
  title?: string;
}) {
  return (
    <div className="min-w-0 border border-slate-700/50 bg-slate-900/30 rounded-lg px-4 py-3" title={title}>
      <div className={`h-1 w-8 rounded-full ${accent} mb-3`} />
      <div className="text-2xl font-semibold text-white truncate">{value}</div>
      <div className="text-xs text-slate-400 mt-1">{label}</div>
    </div>
  );
}

export function AdminUserAudit({ token, clear }: { token: string; clear: () => void }) {
  const [overview, setOverview] = useState<AdminUserAuditOverview>(emptyOverview);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [detail, setDetail] = useState<AdminUserAuditDetail | null>(null);
  const [query, setQuery] = useState('');
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>('all');
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

  const filteredUsers = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return overview.users.filter((user) => {
      if (normalized && !user.email.toLowerCase().includes(normalized)) return false;
      if (activityFilter === 'no-plays') return user.totalPlays === 0;
      if (activityFilter === 'active') {
        const activity = mostRecentActivity(user);
        return activity ? new Date(activity).getTime() >= sevenDaysAgo : false;
      }
      return true;
    });
  }, [activityFilter, overview.users, query]);

  const selectedUser = overview.users.find((user) => user.id === selectedUserId) ?? null;
  const maxDailyPlays = Math.max(1, ...(detail?.dailyPlays.map((day) => day.count) ?? [0]));

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

  return (
    <div className="space-y-5" data-testid="admin-user-audit">
      {error && (
        <div className="px-4 py-3 bg-red-500/10 border border-red-500/25 rounded-lg text-red-300">
          {error}
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-white">User activity</h2>
          <div className="text-sm text-slate-400 mt-1">{overview.totals.users} accounts</div>
        </div>
        <button
          onClick={() => void loadOverview()}
          disabled={loading}
          className="w-10 h-10 shrink-0 inline-flex items-center justify-center rounded-lg border border-slate-700/60 text-slate-300 hover:bg-slate-800 disabled:opacity-50"
          title="Refresh user audit"
          aria-label="Refresh user audit"
        >
          <svg className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h5M20 20v-5h-5M5.6 15A7 7 0 0018 17m.4-8A7 7 0 006 7" />
          </svg>
        </button>
      </div>

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        <Metric label="Users" value={overview.totals.users.toLocaleString()} accent="bg-cyan-400" />
        <Metric label="Active in 7 days" value={overview.totals.active7d.toLocaleString()} accent="bg-emerald-400" />
        <Metric label="Plays in 7 days" value={overview.totals.plays7d.toLocaleString()} accent="bg-fuchsia-400" />
        <Metric
          label="Estimated listening"
          value={longDuration(overview.totals.estimatedListeningMs)}
          accent="bg-amber-400"
          title="Sum of full track durations represented in listening history"
        />
      </div>

      <div className="grid xl:grid-cols-[minmax(280px,0.72fr)_minmax(0,1.6fr)] gap-4 items-start">
        <section className="border border-slate-700/50 bg-slate-900/20 rounded-lg overflow-hidden">
          <div className="p-3 border-b border-slate-700/50 space-y-3">
            <label className="relative block">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m21 21-4.35-4.35M19 11a8 8 0 11-16 0 8 8 0 0116 0z" />
              </svg>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Find user"
                className="w-full h-10 pl-9 pr-3 bg-slate-950/50 border border-slate-700/60 rounded-lg text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-cyan-500"
              />
            </label>
            <div className="grid grid-cols-3 p-1 bg-slate-950/50 rounded-lg" role="group" aria-label="Activity filter">
              {([
                ['all', 'All'],
                ['active', 'Active'],
                ['no-plays', 'No plays'],
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
          </div>

          <div className="max-h-[620px] overflow-y-auto divide-y divide-slate-800">
            {loading ? (
              <div className="h-48 flex items-center justify-center">
                <div className="w-7 h-7 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin" />
              </div>
            ) : filteredUsers.length === 0 ? (
              <div className="py-12 text-center text-sm text-slate-500">No matching users</div>
            ) : filteredUsers.map((user) => {
              const recent = mostRecentActivity(user);
              return (
                <button
                  key={user.id}
                  data-testid={`audit-user-${user.id}`}
                  onClick={() => setSelectedUserId(user.id)}
                  className={`w-full p-3 text-left flex gap-3 items-center ${
                    user.id === selectedUserId ? 'bg-cyan-500/10' : 'hover:bg-slate-800/50'
                  }`}
                >
                  <Avatar user={user} size="sm" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-white truncate">{user.email}</span>
                      {user.role === 'admin' && (
                        <span className="px-1.5 py-0.5 text-[10px] uppercase bg-amber-500/15 text-amber-300 rounded">Admin</span>
                      )}
                    </div>
                    <div className="text-xs text-slate-500 mt-1 truncate">
                      {recent ? `Active ${relativeTime(recent)}` : 'No activity'}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-sm font-medium text-slate-200">{user.plays7d}</div>
                    <div className="text-[10px] text-slate-500">7d plays</div>
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        <section className="min-w-0 border border-slate-700/50 bg-slate-900/20 rounded-lg overflow-hidden">
          {!selectedUser ? (
            <div className="h-72 flex items-center justify-center text-slate-500">Select a user</div>
          ) : detailLoading && !detail ? (
            <div className="h-72 flex items-center justify-center">
              <div className="w-8 h-8 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : detail ? (
            <>
              <div className="p-4 sm:p-5 border-b border-slate-700/50 flex flex-col sm:flex-row sm:items-center gap-4">
                <Avatar user={detail.user} size="lg" />
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-lg font-semibold text-white break-all">{detail.user.email}</h3>
                    <span className={`px-2 py-0.5 rounded text-xs ${
                      detail.user.role === 'admin' ? 'bg-amber-500/15 text-amber-300' : 'bg-slate-700 text-slate-300'
                    }`}>
                      {detail.user.role}
                    </span>
                  </div>
                  <div className="text-xs text-slate-500 mt-1">Joined {dateTime(detail.user.createdAt)}</div>
                </div>
                <div className="sm:text-right">
                  <div className="text-xs uppercase text-slate-500">Last active</div>
                  <div className="text-sm text-slate-200 mt-1">{dateTime(detail.user.lastActiveAt)}</div>
                  {detail.user.lastActiveIp && <div className="text-xs font-mono text-slate-500 mt-1">{detail.user.lastActiveIp}</div>}
                  <div className="text-xs text-slate-500 mt-2">Signed in {dateTime(detail.user.lastLoginAt)}</div>
                </div>
              </div>

              <div className="grid grid-cols-2 lg:grid-cols-4 divide-x divide-y lg:divide-y-0 divide-slate-800 border-b border-slate-700/50">
                {[
                  ['Last listened', relativeTime(detail.user.lastPlayedAt)],
                  ['Total plays', detail.user.totalPlays.toLocaleString()],
                  ['Estimated time', longDuration(detail.user.estimatedListeningMs)],
                  ['Saved', `${detail.user.favoriteCount} loved / ${detail.user.playlistCount} lists`],
                ].map(([label, value]) => (
                  <div key={label} className="px-4 py-3 min-w-0">
                    <div className="text-xs text-slate-500">{label}</div>
                    <div className="text-sm font-medium text-white mt-1 truncate" title={label === 'Estimated time' ? 'Sum of full track durations represented in history' : undefined}>
                      {value}
                    </div>
                  </div>
                ))}
              </div>

              <div className="p-4 sm:p-5 border-b border-slate-700/50">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-sm font-medium text-slate-200">Listening activity</h4>
                  <span className="text-xs text-slate-500">14 days</span>
                </div>
                <div className="h-24 flex items-end gap-1.5">
                  {detail.dailyPlays.map((day) => (
                    <div key={day.date} className="h-full flex-1 min-w-0 flex flex-col items-center justify-end gap-1" title={`${day.date}: ${day.count} plays`}>
                      <div
                        className={`w-full max-w-7 rounded-t-sm ${day.count > 0 ? 'bg-cyan-400/80' : 'bg-slate-800'}`}
                        style={{ height: `${Math.max(day.count > 0 ? 8 : 3, (day.count / maxDailyPlays) * 70)}px` }}
                      />
                      <span className="text-[9px] text-slate-600">
                        {new Intl.DateTimeFormat(undefined, { weekday: 'narrow' }).format(new Date(`${day.date}T12:00:00`))}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="grid lg:grid-cols-[minmax(0,1.5fr)_minmax(220px,0.7fr)]">
                <div className="min-w-0 lg:border-r border-slate-700/50">
                  <div className="px-4 sm:px-5 py-3 border-b border-slate-800 flex items-center justify-between">
                    <h4 className="text-sm font-medium text-slate-200">Listening history</h4>
                    <span className="text-xs text-slate-500">{detail.historyTotal.toLocaleString()} plays</span>
                  </div>
                  <div className="divide-y divide-slate-800">
                    {detail.history.map((item) => (
                      <div key={item.historyId} className="px-4 sm:px-5 py-3 flex items-center gap-3">
                        <img
                          src={`/api/library/tracks/${item.trackId}/art`}
                          alt=""
                          className="w-10 h-10 rounded object-cover bg-slate-800 shrink-0"
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
                          <div className="text-xs text-slate-400">{relativeTime(item.playedAt)}</div>
                          <div className="text-[10px] text-slate-600 mt-1">{duration(item.durationMs)}</div>
                        </div>
                      </div>
                    ))}
                    {detail.history.length === 0 && (
                      <div className="py-10 text-center text-sm text-slate-500">No listening history</div>
                    )}
                  </div>
                  {detail.history.length < detail.historyTotal && (
                    <div className="p-3 border-t border-slate-800">
                      <button
                        onClick={() => void loadMoreHistory()}
                        disabled={moreLoading}
                        className="w-full h-9 rounded-lg text-sm font-medium text-slate-300 bg-slate-800 hover:bg-slate-700 disabled:opacity-50"
                      >
                        {moreLoading ? 'Loading' : 'Load more'}
                      </button>
                    </div>
                  )}
                </div>

                <div className="min-w-0 border-t lg:border-t-0 border-slate-700/50">
                  <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
                    <h4 className="text-sm font-medium text-slate-200">Sign-ins</h4>
                    <span className="text-xs text-slate-500">{detail.user.loginCount}</span>
                  </div>
                  <div className="divide-y divide-slate-800">
                    {detail.signIns.map((signIn, index) => {
                      const successful = signIn.event === 'login_ok';
                      return (
                        <div key={`${signIn.ts}-${index}`} className="px-4 py-3 flex items-start gap-2">
                          <span className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${successful ? 'bg-emerald-400' : 'bg-red-400'}`} />
                          <div className="min-w-0">
                            <div className="text-xs text-slate-300">{successful ? 'Signed in' : signIn.event === 'login_locked' ? 'Locked attempt' : 'Failed attempt'}</div>
                            <div className="text-[10px] text-slate-500 mt-1">{dateTime(signIn.ts)}</div>
                            {signIn.ip && <div className="text-[10px] font-mono text-slate-600 truncate mt-0.5">{signIn.ip}</div>}
                          </div>
                        </div>
                      );
                    })}
                    {detail.signIns.length === 0 && (
                      <div className="py-10 text-center text-sm text-slate-500">No sign-ins recorded</div>
                    )}
                  </div>
                </div>
              </div>
            </>
          ) : null}
        </section>
      </div>
    </div>
  );
}

'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  adminCreateUser,
  adminDeleteUser,
  adminForceLogout,
  adminResetPassword,
  adminSetUserRole,
  apiFetch,
  getLibraryActivity,
  getLibraryStats,
  getUserLibraries,
  listAdminUsers,
  listLibraries,
  setUserLibraries,
  getScanProgress,
  type ScanProgress,
} from './apiClient';
import { useAuth } from './store';
import { useScanProgress, useLibraryUpdates } from './useWebSocket';

type Tab = 'library' | 'users' | 'settings';

export function Admin() {
  const token = useAuth((s) => s.token);
  const user = useAuth((s) => s.user);
  const clear = useAuth((s) => s.clear);
  const isAdmin = user?.role === 'admin';

  const [activeTab, setActiveTab] = useState<Tab>('library');

  if (!token || !isAdmin) return null;

  return (
    <div className="space-y-6">
      {/* Tabs */}
      <div className="flex gap-2 border-b border-slate-700/50 pb-4">
        {[
          { id: 'library' as Tab, label: 'Library', icon: (
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
            </svg>
          )},
          { id: 'users' as Tab, label: 'Users', icon: (
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 11a4 4 0 100-8 4 4 0 000 8z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M22 21v-2a4 4 0 00-3-3.87" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 3.13a4 4 0 010 7.75" />
            </svg>
          )},
          { id: 'settings' as Tab, label: 'Settings', icon: (
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          )},
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-all ${
              activeTab === tab.id
                ? 'bg-cyan-500 text-white'
                : 'bg-slate-800/50 text-slate-300 hover:bg-slate-700/50'
            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {activeTab === 'library' && <LibraryTab token={token} clear={clear} />}
      {activeTab === 'users' && <UsersTab token={token} clear={clear} currentUserId={user?.id} />}
      {activeTab === 'settings' && <SettingsTab token={token} />}
    </div>
  );
}

// ============ Library Tab ============
function LibraryTab({ token, clear }: { token: string; clear: () => void }) {
  const [stats, setStats] = useState<any>(null);
  const [activity, setActivity] = useState<any[]>([]);
  const [libraries, setLibraries] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [scanTriggered, setScanTriggered] = useState(false);
  const [showForceConfirm, setShowForceConfirm] = useState(false);

  // Live updates from WebSocket
  const wsScanProgress = useScanProgress();
  const libraryLastUpdate = useLibraryUpdates((s) => s.lastUpdate);

  async function loadData() {
    setLoading(true);
    setError(null);
    try {
      const [statsRes, activityRes, libsRes, progressRes] = await Promise.all([
        getLibraryStats(token),
        getLibraryActivity(token, 30),
        listLibraries(token),
        getScanProgress(token),
      ]);
      setStats(statsRes.stats);
      setActivity(activityRes.activity);
      setLibraries(libsRes.libraries);
      setScanProgress(progressRes);
    } catch (e: any) {
      if (e?.status === 401) clear();
      setError(e?.message ?? 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }

  // Live updates: Update scan progress from WebSocket
  useEffect(() => {
    if (!wsScanProgress.phase) return;
    setScanProgress((prev) => ({
      ...prev,
      ok: true,
      status: wsScanProgress.scanning ? 'scanning' : 'idle',
      filesProcessed: wsScanProgress.current,
      filesFound: wsScanProgress.total,
    }));

    // Reset triggered flag when scan completes
    if (!wsScanProgress.scanning && (wsScanProgress.phase === 'done' || wsScanProgress.phase === 'complete')) {
      setScanTriggered(false);
    }
  }, [wsScanProgress]);

  // Live updates: Refresh stats and activity when library changes
  useEffect(() => {
    if (!libraryLastUpdate || !token) return;
    // Refresh stats
    getLibraryStats(token)
      .then((res) => setStats(res.stats))
      .catch(() => {});
    // Refresh activity
    getLibraryActivity(token, 30)
      .then((res) => setActivity(res.activity))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libraryLastUpdate]);

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-3 border-cyan-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400">
        {error}
      </div>
    );
  }

  const formatTimeAgo = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  const getActivityIcon = (action: string) => {
    switch (action) {
      case 'track_added':
        return <span className="text-green-400">+</span>;
      case 'track_updated':
        return <span className="text-blue-400">↻</span>;
      case 'track_removed':
        return <span className="text-red-400">−</span>;
      default:
        return <span className="text-slate-400">•</span>;
    }
  };

  const getActivityLabel = (action: string) => {
    switch (action) {
      case 'track_added': return 'Added';
      case 'track_updated': return 'Updated';
      case 'track_removed': return 'Removed';
      case 'scan_enqueued': return 'Scan started';
      case 'scan_finished': return 'Scan completed';
      default: return action;
    }
  };

  return (
    <div className="space-y-8">
      {/* Force Scan Confirmation Modal */}
      {showForceConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 max-w-md mx-4 shadow-2xl">
            <h3 className="text-lg font-semibold text-white mb-3">Force Full Scan?</h3>
            <p className="text-slate-400 mb-6">
              This will re-read metadata from all files in your library. This may take a while for large libraries.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setShowForceConfirm(false)}
                className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  setShowForceConfirm(false);
                  try {
                    setScanTriggered(true);
                    await apiFetch('/admin/library/rescan?force=true', { method: 'POST' }, token);
                  } catch (e: any) {
                    if (e?.status === 401) clear();
                    setScanTriggered(false);
                  }
                }}
                className="px-4 py-2 bg-orange-600 hover:bg-orange-500 text-white rounded-lg font-medium transition-colors"
              >
                Start Full Scan
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Scan Progress Banner */}
      {(scanTriggered || (scanProgress && scanProgress.status !== 'idle')) && (
        <div className="p-4 bg-gradient-to-r from-cyan-500/10 to-blue-500/10 border border-cyan-500/20 rounded-xl">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 bg-cyan-500/20 rounded-full flex items-center justify-center">
                {scanProgress?.status === 'scanning' || scanTriggered ? (
                  <svg className="w-5 h-5 text-cyan-400 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                ) : (
                  <svg className="w-5 h-5 text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />
                  </svg>
                )}
              </div>
              <div>
                <div className="font-medium text-white">
                  {scanTriggered && (!scanProgress || scanProgress.status === 'idle') 
                    ? 'Starting Scan...' 
                    : scanProgress?.status === 'scanning' 
                      ? 'Scanning Library...' 
                      : 'Indexing Search...'}
                </div>
                <div className="text-sm text-slate-400">
                  {scanTriggered && (!scanProgress || scanProgress.status === 'idle')
                    ? 'Waiting for worker to start...'
                    : <>
                        {scanProgress?.filesProcessed.toLocaleString()} / {scanProgress?.filesFound.toLocaleString()} files processed
                        {scanProgress?.queueSize && scanProgress.queueSize > 0 && (
                          <span className="ml-2 text-cyan-400">({scanProgress.queueSize} queued)</span>
                        )}
                      </>
                  }
                </div>
              </div>
            </div>
            {scanProgress && scanProgress.filesFound > 0 && (
              <div className="text-2xl font-bold text-cyan-400">
                {Math.round((scanProgress.filesProcessed / scanProgress.filesFound) * 100)}%
              </div>
            )}
          </div>
          {/* Progress Bar */}
          <div className="h-2 bg-slate-700/50 rounded-full overflow-hidden">
            <div 
              className="h-full bg-gradient-to-r from-cyan-500 to-blue-500 transition-all duration-300"
              style={{ width: `${scanProgress && scanProgress.filesFound > 0 ? (scanProgress.filesProcessed / scanProgress.filesFound) * 100 : 0}%` }}
            />
          </div>
          {scanProgress?.currentFile && (
            <div className="mt-2 text-xs text-slate-500 truncate">
              {scanProgress.currentFile}
            </div>
          )}
        </div>
      )}

      {/* Scan Controls */}
      <div className="p-4 bg-slate-800/30 border border-slate-700/30 rounded-xl">
        <h3 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
          <svg className="w-5 h-5 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          Library Scan
        </h3>
        <div className="flex flex-wrap gap-3">
          <button
            onClick={async () => {
              try {
                setScanTriggered(true);
                await apiFetch('/admin/library/rescan', { method: 'POST' }, token);
              } catch (e: any) {
                if (e?.status === 401) clear();
                setScanTriggered(false);
              }
            }}
            disabled={scanTriggered || scanProgress?.status === 'scanning' || scanProgress?.status === 'indexing'}
            className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-lg font-medium transition-colors flex items-center gap-2"
          >
            {scanTriggered && scanProgress?.status === 'idle' ? (
              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            )}
            Quick Scan
          </button>
          <button
            onClick={() => setShowForceConfirm(true)}
            disabled={scanTriggered || scanProgress?.status === 'scanning' || scanProgress?.status === 'indexing'}
            className="px-4 py-2 bg-orange-600 hover:bg-orange-500 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-lg font-medium transition-colors flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Force Full Scan
          </button>
        </div>
        <p className="mt-3 text-sm text-slate-400">
          <strong>Quick Scan:</strong> Only scans new or modified files. <strong>Force Full Scan:</strong> Re-reads all file metadata and updates creation dates.
        </p>
      </div>

      {/* Stats Overview */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
        {[
          { label: 'Tracks', value: stats?.tracks?.toLocaleString() ?? '0', icon: '🎵', gradient: 'from-cyan-500 to-blue-600' },
          { label: 'Artists', value: stats?.artists?.toLocaleString() ?? '0', icon: '🎤', gradient: 'from-purple-500 to-indigo-600' },
          { label: 'Albums', value: stats?.albums?.toLocaleString() ?? '0', icon: '💿', gradient: 'from-pink-500 to-rose-600' },
          { label: 'Genres', value: stats?.genres?.toLocaleString() ?? '0', icon: '🎭', gradient: 'from-orange-500 to-amber-600' },
          { label: 'Countries', value: stats?.countries?.toLocaleString() ?? '0', icon: '🌍', gradient: 'from-green-500 to-emerald-600' },
          { label: 'Languages', value: stats?.languages?.toLocaleString() ?? '0', icon: '🗣️', gradient: 'from-teal-500 to-cyan-600' },
          { label: 'Libraries', value: stats?.libraries?.toLocaleString() ?? '0', icon: '📚', gradient: 'from-violet-500 to-purple-600' },
          { label: 'Total Size', value: stats?.totalSize ?? '0 B', icon: '💾', gradient: 'from-slate-500 to-slate-600' },
        ].map((stat) => (
          <div
            key={stat.label}
            className="p-4 bg-slate-800/30 border border-slate-700/30 rounded-xl"
          >
            <div className="flex items-center gap-3">
              <div className={`w-10 h-10 bg-gradient-to-br ${stat.gradient} rounded-lg flex items-center justify-center text-lg`}>
                {stat.icon}
              </div>
              <div>
                <div className="text-2xl font-bold text-white">{stat.value}</div>
                <div className="text-sm text-slate-400">{stat.label}</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Two Column Layout */}
      <div className="grid lg:grid-cols-2 gap-6">
        {/* Top Genres */}
        <div className="space-y-4">
          <h3 className="text-lg font-semibold text-white flex items-center gap-2">
            <svg className="w-5 h-5 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01" />
            </svg>
            Top Genres
          </h3>
          <div className="space-y-2">
            {(stats?.topGenres ?? []).slice(0, 8).map((g: any, i: number) => (
              <div key={g.genre} className="flex items-center gap-3 p-3 bg-slate-800/30 rounded-lg">
                <span className="w-6 text-center text-slate-500 text-sm">{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-white truncate">{g.genre}</div>
                </div>
                <div className="text-sm text-slate-400">{g.track_count} tracks</div>
              </div>
            ))}
            {(stats?.topGenres ?? []).length === 0 && (
              <div className="text-slate-400 text-sm py-4">No genres found</div>
            )}
          </div>
        </div>

        {/* Top Countries */}
        <div className="space-y-4">
          <h3 className="text-lg font-semibold text-white flex items-center gap-2">
            <svg className="w-5 h-5 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Top Countries
          </h3>
          <div className="space-y-2">
            {(stats?.topCountries ?? []).slice(0, 8).map((c: any, i: number) => (
              <div key={c.country} className="flex items-center gap-3 p-3 bg-slate-800/30 rounded-lg">
                <span className="w-6 text-center text-slate-500 text-sm">{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-white truncate">{c.country}</div>
                </div>
                <div className="text-sm text-slate-400">{c.track_count} tracks</div>
              </div>
            ))}
            {(stats?.topCountries ?? []).length === 0 && (
              <div className="text-slate-400 text-sm py-4">No countries found</div>
            )}
          </div>
        </div>
      </div>

      {/* Library Paths */}
      <div className="space-y-4">
        <h3 className="text-lg font-semibold text-white flex items-center gap-2">
          <svg className="w-5 h-5 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
          </svg>
          Library Paths
          <span className="text-xs text-slate-500 font-normal">(read-only, managed by file watcher)</span>
        </h3>
        <div className="space-y-2">
          {libraries.map((lib) => (
            <div key={lib.id} className="flex items-center gap-3 p-3 bg-slate-800/30 rounded-lg">
              <div className="w-8 h-8 bg-slate-700/50 rounded-lg flex items-center justify-center">
                <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                </svg>
              </div>
              <code className="flex-1 text-sm text-slate-300 font-mono">{lib.mount_path}</code>
              <span className="text-xs text-slate-500">ID: {lib.id}</span>
            </div>
          ))}
          {libraries.length === 0 && (
            <div className="text-slate-400 text-sm py-4">No libraries configured</div>
          )}
        </div>
      </div>

      {/* Recent Activity */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-white flex items-center gap-2">
            <svg className="w-5 h-5 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Recent Activity
          </h3>
          <button
            onClick={loadData}
            className="p-2 hover:bg-slate-800/50 rounded-lg transition-colors text-slate-400 hover:text-white"
            title="Refresh"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>
        <div className="space-y-1 max-h-96 overflow-y-auto">
          {activity.map((item) => (
            <div key={item.id} className="flex items-center gap-3 p-3 hover:bg-slate-800/30 rounded-lg transition-colors">
              <div className="w-8 h-8 bg-slate-800/50 rounded-lg flex items-center justify-center font-bold text-lg">
                {getActivityIcon(item.action)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-medium text-white truncate">
                  {item.details?.title || item.details?.path || getActivityLabel(item.action)}
                </div>
                <div className="text-sm text-slate-400 truncate">
                  {item.details?.artist && <span>{item.details.artist} • </span>}
                  {getActivityLabel(item.action)}
                </div>
              </div>
              <div className="text-sm text-slate-500 whitespace-nowrap">
                {formatTimeAgo(item.created_at)}
              </div>
            </div>
          ))}
          {activity.length === 0 && (
            <div className="text-center py-8 text-slate-400">
              <p>No recent activity</p>
              <p className="text-sm mt-1">File changes will appear here</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ============ Users Tab ============
function UsersTab({ token, clear, currentUserId }: { token: string; clear: () => void; currentUserId?: string }) {
  const [users, setUsers] = useState<Array<{ id: string; email: string; role: string; avatar_path?: string }>>([]);
  const [pendingUsers, setPendingUsers] = useState<Array<{ id: string; email: string; created_at: string; avatar_path?: string }>>([]);
  const [libraries, setLibraries] = useState<Array<{ id: number; mount_path: string }>>([]);
  const [selectedUserId, setSelectedUserId] = useState<string>('');
  const [userLibraryIds, setUserLibraryIds] = useState<number[]>([]);
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newIsAdmin, setNewIsAdmin] = useState(false);
  const [resetPassword, setResetPasswordValue] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const selectedUser = useMemo(() => users.find((u) => u.id === selectedUserId) ?? null, [users, selectedUserId]);

  async function refresh() {
    setError(null);
    setNotice(null);
    try {
      const [usersRes, libsRes, pendingRes] = await Promise.all([
        listAdminUsers(token),
        listLibraries(token),
        apiFetch('/admin/users/pending', { method: 'GET' }, token).catch(() => ({ users: [] }))
      ]);
      setUsers(usersRes.users);
      setLibraries(libsRes.libraries);
      setPendingUsers(pendingRes.users || []);
      const first = selectedUserId || usersRes.users[0]?.id || '';
      setSelectedUserId(first);
      if (first) {
        const userLibs = await getUserLibraries(token, first);
        setUserLibraryIds(userLibs.libraryIds);
      }
    } catch (e: any) {
      if (e?.status === 401) clear();
      setError(e?.data?.error ?? e?.message ?? 'error');
    }
  }

  async function approveUser(userId: string) {
    try {
      await apiFetch(`/admin/users/${userId}/approve`, { method: 'POST' }, token);
      setNotice('User approved');
      refresh();
    } catch (e: any) {
      setError(e?.data?.error ?? e?.message ?? 'Failed to approve user');
    }
  }

  async function rejectUser(userId: string) {
    if (!confirm('Reject this user? They will not be able to access the app.')) return;
    try {
      await apiFetch(`/admin/users/${userId}/reject`, { method: 'POST' }, token);
      setNotice('User rejected');
      refresh();
    } catch (e: any) {
      setError(e?.data?.error ?? e?.message ?? 'Failed to reject user');
    }
  }

  // Load user's libraries when selection changes
  useEffect(() => {
    if (selectedUserId && token) {
      const targetUser = users.find(u => u.id === selectedUserId);
      // Admins have access to all libraries by design
      if (targetUser?.role === 'admin') {
        setUserLibraryIds(libraries.map(l => l.id));
        return;
      }
      getUserLibraries(token, selectedUserId)
        .then(r => setUserLibraryIds(r.libraryIds))
        .catch(() => setUserLibraryIds([]));
    }
  }, [selectedUserId, token, users, libraries]);

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function createUser() {
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const r = await adminCreateUser(token, { email: newEmail, password: newPassword, role: newIsAdmin ? 'admin' : 'user' });
      setNotice(`Created user: ${r.user.email}`);
      setNewEmail('');
      setNewPassword('');
      setNewIsAdmin(false);
      await refresh();
      setSelectedUserId(r.user.id);
    } catch (e: any) {
      if (e?.status === 401) clear();
      setError(e?.data?.error ?? e?.message ?? 'error');
    } finally {
      setLoading(false);
    }
  }

  async function setRole(role: 'admin' | 'user') {
    if (!selectedUser) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      await adminSetUserRole(token, selectedUser.id, role);
      setNotice(`Updated role: ${selectedUser.email} → ${role}`);
      await refresh();
    } catch (e: any) {
      if (e?.status === 401) clear();
      setError(e?.data?.error ?? e?.message ?? 'error');
    } finally {
      setLoading(false);
    }
  }

  async function doResetPassword() {
    if (!selectedUser) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      await adminResetPassword(token, selectedUser.id, resetPassword);
      setResetPasswordValue('');
      setNotice(`Password reset + user logged out: ${selectedUser.email}`);
    } catch (e: any) {
      if (e?.status === 401) clear();
      setError(e?.data?.error ?? e?.message ?? 'error');
    } finally {
      setLoading(false);
    }
  }

  async function forceLogout() {
    if (!selectedUser) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      await adminForceLogout(token, selectedUser.id);
      setNotice(`Forced logout: ${selectedUser.email}`);
    } catch (e: any) {
      if (e?.status === 401) clear();
      setError(e?.data?.error ?? e?.message ?? 'error');
    } finally {
      setLoading(false);
    }
  }

  async function deleteUser() {
    if (!selectedUser) return;
    const ok = confirm(`Delete user ${selectedUser.email}? This cannot be undone.`);
    if (!ok) return;

    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      await adminDeleteUser(token, selectedUser.id);
      setNotice(`Deleted user: ${selectedUser.email}`);
      setSelectedUserId('');
      await refresh();
    } catch (e: any) {
      if (e?.status === 401) clear();
      setError(e?.data?.error ?? e?.message ?? 'error');
    } finally {
      setLoading(false);
    }
  }

  async function toggleLibrary(libraryId: number) {
    if (!selectedUser) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const newIds = userLibraryIds.includes(libraryId)
        ? userLibraryIds.filter(id => id !== libraryId)
        : [...userLibraryIds, libraryId];
      await setUserLibraries(token, selectedUser.id, newIds);
      setUserLibraryIds(newIds);
      const lib = libraries.find(l => l.id === libraryId);
      const action = newIds.includes(libraryId) ? 'granted' : 'revoked';
      setNotice(`Library access ${action}: ${lib?.mount_path ?? libraryId}`);
    } catch (e: any) {
      if (e?.status === 401) clear();
      setError(e?.data?.error ?? e?.message ?? 'error');
    } finally {
      setLoading(false);
    }
  }

  async function grantAllLibraries() {
    if (!selectedUser) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const allIds = libraries.map(l => l.id);
      await setUserLibraries(token, selectedUser.id, allIds);
      setUserLibraryIds(allIds);
      setNotice(`Granted access to all ${allIds.length} libraries`);
    } catch (e: any) {
      if (e?.status === 401) clear();
      setError(e?.data?.error ?? e?.message ?? 'error');
    } finally {
      setLoading(false);
    }
  }

  async function revokeAllLibraries() {
    if (!selectedUser) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      await setUserLibraries(token, selectedUser.id, []);
      setUserLibraryIds([]);
      setNotice(`Revoked access to all libraries`);
    } catch (e: any) {
      if (e?.status === 401) clear();
      setError(e?.data?.error ?? e?.message ?? 'error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Notifications */}
      {notice && (
        <div className="p-4 bg-green-500/10 border border-green-500/20 rounded-xl text-green-400 flex items-center gap-2">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          {notice}
        </div>
      )}
      {error && (
        <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400">
          {error}
        </div>
      )}

      {/* Create User Card */}
      <div className="p-6 bg-slate-800/30 border border-slate-700/30 rounded-xl space-y-4">
        <h3 className="text-lg font-semibold text-white flex items-center gap-2">
          <svg className="w-5 h-5 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
          </svg>
          Create User
        </h3>
        <div className="grid sm:grid-cols-2 gap-4">
          <input
            placeholder="Email"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            className="px-4 py-3 bg-slate-900/50 border border-slate-700/50 rounded-xl text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
          />
          <input
            placeholder="Password (min 8 chars)"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="px-4 py-3 bg-slate-900/50 border border-slate-700/50 rounded-xl text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
          />
        </div>
        <div className="flex items-center justify-between flex-wrap gap-4">
          <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={newIsAdmin}
              onChange={(e) => setNewIsAdmin(e.target.checked)}
              className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-cyan-500 focus:ring-cyan-500/50"
            />
            Make admin
          </label>
          <div className="flex gap-2">
            <button
              onClick={createUser}
              disabled={loading || !newEmail.trim() || newPassword.length < 8}
              className="px-4 py-2 bg-cyan-500 hover:bg-cyan-400 disabled:bg-slate-700 disabled:text-slate-400 text-white rounded-lg font-medium transition-colors"
            >
              Create User
            </button>
            <button
              onClick={refresh}
              disabled={loading}
              className="p-2 hover:bg-slate-700/50 rounded-lg transition-colors text-slate-400 hover:text-white"
              title="Refresh"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Pending Users (Google OAuth) */}
      {pendingUsers.length > 0 && (
        <div className="p-6 bg-yellow-500/10 border border-yellow-500/30 rounded-xl space-y-4">
          <h3 className="text-lg font-semibold text-yellow-400 flex items-center gap-2">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Pending Approval ({pendingUsers.length})
          </h3>
          <div className="space-y-2">
            {pendingUsers.map((u) => (
              <div
                key={u.id}
                className="flex items-center justify-between p-4 bg-slate-800/50 rounded-xl"
              >
                <div className="flex items-center gap-3">
                  {u.avatar_path ? (
                    <img
                      src={`/api/avatars/${u.avatar_path}`}
                      alt=""
                      className="w-10 h-10 rounded-full object-cover"
                    />
                  ) : (
                    <div className="w-10 h-10 rounded-full bg-gradient-to-br from-slate-600 to-slate-700 flex items-center justify-center font-bold text-white">
                      {u.email[0].toUpperCase()}
                    </div>
                  )}
                  <div>
                    <div className="font-medium text-white">{u.email}</div>
                    <div className="text-xs text-slate-400">
                      Registered {new Date(u.created_at).toLocaleDateString()}
                    </div>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => approveUser(u.id)}
                    className="px-3 py-1.5 bg-green-500 hover:bg-green-400 text-white text-sm font-medium rounded-lg transition-colors"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => rejectUser(u.id)}
                    className="px-3 py-1.5 bg-red-500 hover:bg-red-400 text-white text-sm font-medium rounded-lg transition-colors"
                  >
                    Reject
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* User List and Details */}
      <div className="grid lg:grid-cols-2 gap-6">
        {/* User List */}
        <div className="space-y-4">
          <h3 className="text-lg font-semibold text-slate-300">Users ({users.length})</h3>
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {users.map((u) => (
              <button
                key={u.id}
                onClick={() => setSelectedUserId(u.id)}
                className={`w-full text-left p-4 rounded-xl border transition-all ${
                  selectedUserId === u.id
                    ? 'bg-cyan-500/20 border-cyan-500/50 ring-1 ring-cyan-500/30'
                    : 'bg-slate-800/30 border-slate-700/30 hover:bg-slate-800/50 hover:border-slate-600/50'
                }`}
              >
                <div className="flex items-center gap-3">
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold ${
                    u.role === 'admin' ? 'bg-gradient-to-br from-amber-500 to-orange-600' : 'bg-gradient-to-br from-slate-600 to-slate-700'
                  }`}>
                    {u.email[0].toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-white truncate">{u.email}</div>
                    <div className="text-sm text-slate-400 flex items-center gap-2">
                      <span className={`px-2 py-0.5 rounded text-xs ${
                        u.role === 'admin' ? 'bg-amber-500/20 text-amber-400' : 'bg-slate-700/50 text-slate-400'
                      }`}>
                        {u.role}
                      </span>
                    </div>
                  </div>
                </div>
              </button>
            ))}
            {users.length === 0 && (
              <div className="text-center py-8 text-slate-400">No users found</div>
            )}
          </div>
        </div>

        {/* User Details */}
        <div className="space-y-4">
          {selectedUser ? (
            <div className="p-6 bg-slate-800/30 border border-slate-700/30 rounded-xl space-y-6">
              {/* Header */}
              <div className="flex items-center gap-4">
                <div className={`w-14 h-14 rounded-full flex items-center justify-center text-xl font-bold ${
                  selectedUser.role === 'admin' ? 'bg-gradient-to-br from-amber-500 to-orange-600' : 'bg-gradient-to-br from-slate-600 to-slate-700'
                }`}>
                  {selectedUser.email[0].toUpperCase()}
                </div>
                <div>
                  <div className="text-xl font-bold text-white">{selectedUser.email}</div>
                  <div className="text-sm text-slate-400 font-mono">ID: {selectedUser.id}</div>
                </div>
              </div>

              {/* Role Actions */}
              <div className="space-y-2">
                <div className="text-sm font-medium text-slate-400">Role</div>
                <div className="flex gap-2">
                  <button
                    onClick={() => setRole('admin')}
                    disabled={loading || selectedUser.role === 'admin'}
                    className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                      selectedUser.role === 'admin'
                        ? 'bg-amber-500/20 text-amber-400 cursor-not-allowed'
                        : 'bg-slate-700/50 hover:bg-amber-500/20 text-slate-300 hover:text-amber-400'
                    }`}
                  >
                    Make Admin
                  </button>
                  <button
                    onClick={() => setRole('user')}
                    disabled={loading || selectedUser.role === 'user' || selectedUser.id === currentUserId}
                    className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                      selectedUser.role === 'user' || selectedUser.id === currentUserId
                        ? 'bg-slate-700/50 text-slate-400 cursor-not-allowed'
                        : 'bg-slate-700/50 hover:bg-slate-600/50 text-slate-300'
                    }`}
                  >
                    Remove Admin
                  </button>
                </div>
              </div>

              {/* Reset Password */}
              <div className="space-y-2">
                <div className="text-sm font-medium text-slate-400">Reset Password</div>
                <div className="flex gap-2">
                  <input
                    placeholder="New password (min 8 chars)"
                    type="password"
                    value={resetPassword}
                    onChange={(e) => setResetPasswordValue(e.target.value)}
                    className="flex-1 px-4 py-2 bg-slate-900/50 border border-slate-700/50 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                  />
                  <button
                    onClick={doResetPassword}
                    disabled={loading || !resetPassword}
                    className="px-4 py-2 bg-slate-700/50 hover:bg-slate-600/50 disabled:opacity-50 text-white rounded-lg font-medium transition-colors"
                  >
                    Reset
                  </button>
                </div>
                <div className="text-xs text-slate-500">This will also log the user out everywhere</div>
              </div>

              {/* Library Permissions */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-medium text-slate-400 flex items-center gap-2">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                    </svg>
                    Library Access ({userLibraryIds.length}/{libraries.length})
                  </div>
                  {selectedUser?.role !== 'admin' && (
                    <div className="flex gap-1">
                      <button
                        onClick={grantAllLibraries}
                        disabled={loading || userLibraryIds.length === libraries.length}
                        className="px-2 py-1 text-xs bg-green-500/10 hover:bg-green-500/20 text-green-400 rounded transition-colors disabled:opacity-50"
                        title="Grant all"
                      >
                        All
                      </button>
                      <button
                        onClick={revokeAllLibraries}
                        disabled={loading || userLibraryIds.length === 0}
                        className="px-2 py-1 text-xs bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded transition-colors disabled:opacity-50"
                        title="Revoke all"
                      >
                        None
                      </button>
                    </div>
                  )}
                </div>
                {selectedUser?.role === 'admin' ? (
                  <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/30 text-green-400 text-sm">
                    Admins have access to all libraries by default.
                  </div>
                ) : (
                  <div className="space-y-2 max-h-48 overflow-y-auto">
                    {libraries.map((lib) => {
                      const hasAccess = userLibraryIds.includes(lib.id);
                      return (
                        <button
                          key={lib.id}
                          onClick={() => toggleLibrary(lib.id)}
                          disabled={loading}
                          className={`w-full flex items-center gap-3 p-3 rounded-lg border transition-all text-left ${
                            hasAccess
                              ? 'bg-cyan-500/10 border-cyan-500/30 hover:bg-cyan-500/20'
                              : 'bg-slate-800/30 border-slate-700/30 hover:bg-slate-700/30'
                          }`}
                        >
                          <div className={`w-5 h-5 rounded flex items-center justify-center border-2 transition-colors ${
                            hasAccess
                              ? 'bg-cyan-500 border-cyan-500'
                              : 'border-slate-500'
                          }`}>
                            {hasAccess && (
                              <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                              </svg>
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className={`font-mono text-sm truncate ${hasAccess ? 'text-white' : 'text-slate-400'}`}>
                              {lib.mount_path}
                            </div>
                          </div>
                          <div className={`text-xs px-2 py-0.5 rounded ${
                            hasAccess ? 'bg-cyan-500/20 text-cyan-400' : 'bg-slate-700/50 text-slate-500'
                          }`}>
                            {hasAccess ? 'Access' : 'No Access'}
                          </div>
                        </button>
                      );
                    })}
                    {libraries.length === 0 && (
                      <div className="text-center py-4 text-slate-500 text-sm">
                        No libraries configured
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Danger Zone */}
              <div className="pt-4 border-t border-slate-700/50 space-y-2">
                <div className="text-sm font-medium text-slate-400">Actions</div>
                <div className="flex gap-2 flex-wrap">
                  <button
                    onClick={forceLogout}
                    disabled={loading}
                    className="px-4 py-2 bg-slate-700/50 hover:bg-slate-600/50 text-slate-300 rounded-lg font-medium transition-colors"
                  >
                    Force Logout
                  </button>
                  <button
                    onClick={deleteUser}
                    disabled={loading || selectedUser.id === currentUserId}
                    className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                      selectedUser.id === currentUserId
                        ? 'bg-slate-700/50 text-slate-400 cursor-not-allowed'
                        : 'bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 text-red-400'
                    }`}
                  >
                    Delete User
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-64 text-slate-400 bg-slate-800/20 rounded-xl border border-slate-700/20">
              <svg className="w-16 h-16 mb-4 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
              </svg>
              <p>Select a user to view details</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ============ Settings Tab ============
function SettingsTab({ token }: { token: string }) {
  const [bypassIPs, setBypassIPs] = useState<string[]>([]);
  const [myIP, setMyIP] = useState<string>('');
  const [newIP, setNewIP] = useState('');
  const [loading, setLoading] = useState(true);

  async function loadData() {
    setLoading(true);
    try {
      const [bypassRes, myIPRes] = await Promise.all([
        apiFetch('/admin/rate-limit/bypass', { method: 'GET' }, token).catch(() => ({ ips: [] })),
        apiFetch('/admin/rate-limit/my-ip', { method: 'GET' }, token).catch(() => ({ ip: '' })),
      ]);
      setBypassIPs(bypassRes.ips || []);
      setMyIP(myIPRes.ip || '');
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }

  async function addBypassIP(ip: string) {
    try {
      const res = await apiFetch('/admin/rate-limit/bypass', { method: 'POST', body: JSON.stringify({ ip }) }, token);
      setBypassIPs(res.ips || []);
      setNewIP('');
    } catch {
      // ignore
    }
  }

  async function removeBypassIP(ip: string) {
    try {
      const res = await apiFetch('/admin/rate-limit/bypass', { method: 'DELETE', body: JSON.stringify({ ip }) }, token);
      setBypassIPs(res.ips || []);
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-3 border-cyan-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Rate Limit Bypass */}
      <div className="p-6 bg-slate-800/30 border border-slate-700/30 rounded-xl">
        <h3 className="text-lg font-semibold text-white mb-3 flex items-center gap-2">
          <svg className="w-5 h-5 text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
          Rate Limit Bypass
        </h3>
        <p className="text-sm text-slate-400 mb-4">
          Add IP addresses that bypass login rate limiting. Useful for automated testing and development.
          {myIP && <span className="text-cyan-400 ml-1">(Your IP: {myIP})</span>}
        </p>
        <div className="space-y-2 sm:space-y-0 sm:flex sm:items-start sm:gap-2 mb-4">
          <div className="flex gap-2 sm:flex-1">
            <input
              type="text"
              value={newIP}
              onChange={(e) => setNewIP(e.target.value)}
              placeholder="Enter IP address"
              className="flex-1 min-w-0 px-3 py-2 bg-slate-900/50 border border-slate-600 rounded-lg text-white text-sm focus:border-cyan-500 focus:outline-none"
            />
            <button
              onClick={() => newIP && addBypassIP(newIP)}
              disabled={!newIP}
              className="w-24 whitespace-nowrap px-4 py-2 bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-lg font-medium transition-colors"
            >
              Add
            </button>
          </div>
          {myIP && !bypassIPs.includes(myIP) && (
            <button
              onClick={() => addBypassIP(myIP)}
              className="w-full sm:w-auto self-start whitespace-nowrap px-4 py-2 bg-green-600 hover:bg-green-500 text-white rounded-lg font-medium transition-colors"
            >
              Add My IP
            </button>
          )}
        </div>
        {bypassIPs.length > 0 ? (
          <div className="space-y-2">
            {bypassIPs.map((ip) => (
              <div key={ip} className="flex items-center justify-between p-3 bg-slate-900/30 rounded-lg">
                <span className="text-white font-mono text-sm">{ip}</span>
                <button
                  onClick={() => removeBypassIP(ip)}
                  className="px-3 py-1 text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded transition-colors text-sm"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-slate-500">No IPs whitelisted</p>
        )}
      </div>
    </div>
  );
}

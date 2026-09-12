'use client';

import { useState, useEffect, useRef, type ReactElement } from 'react';
import {
  apiFetch,
  logout,
  getListenBrainzSettings,
  connectListenBrainz,
  disconnectListenBrainz,
  getLastfmSettings,
  beginLastfmConnection,
  disconnectLastfm,
  syncLastfmLovedTracks,
  getSubsonicSettings,
  setSubsonicPassword,
  clearSubsonicPassword,
  clearAllRecommendationFeedback,
  getRecommendationFeedback,
} from './apiClient';
import { useAuth } from './store';
import { usePlayer } from './playerStore';
import { usePreferences } from './preferencesStore';
import { useFavorites } from './favoritesStore';
import { showConfirm } from './ConfirmModal';
import { PushNotificationSettings } from './PushNotificationSettings';
import { unsubscribeCurrentPushDevice } from './pushNotifications';
import { formatCalendarDate } from './format';

type Tab = 'account' | 'playback' | 'notifications' | 'integrations' | 'about';

interface UserProfile {
  id: string;
  email: string;
  role: string;
  avatar_path: string | null;
  auth_type: 'google' | 'local';
  created_at: string;
}

interface VersionInfo {
  version: string;
  commit: string;
  branch: string;
  buildDate: string;
}

export function Settings() {
  const token = useAuth((s) => s.token);
  const user = useAuth((s) => s.user);
  const setAuth = useAuth((s) => s.setAuth);
  const updateAvatar = useAuth((s) => s.updateAvatar);
  const clear = useAuth((s) => s.clear);
  const resetPlayer = usePlayer((s) => s.reset);
  const preferences = usePreferences((s) => s.preferences);
  const lastfmEnabled = usePreferences((s) => s.lastfmEnabled);
  const loadPreferences = usePreferences((s) => s.load);
  const updatePreferences = usePreferences((s) => s.update);
  const preferencesBusy = usePreferences((s) => s.loading || s.saving);
  const preferencesError = usePreferences((s) => s.error);
  const refreshFavorites = useFavorites((s) => s.refresh);

  const [activeTab, setActiveTab] = useState<Tab>('account');
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Password change state
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [recommendationTuningCount, setRecommendationTuningCount] = useState(0);
  const [resettingRecommendationTuning, setResettingRecommendationTuning] = useState(false);

  // Unlink Google state
  const [unlinkAction, setUnlinkAction] = useState<'convert' | 'delete' | null>(null);
  const [unlinkPassword, setUnlinkPassword] = useState('');

  // ListenBrainz settings
  const [lbConnected, setLbConnected] = useState(false);
  const [lbUsername, setLbUsername] = useState<string | null>(null);
  const [lbToken, setLbToken] = useState('');
  const [lbLoading, setLbLoading] = useState(false);
  const [lbError, setLbError] = useState<string | null>(null);

  // Personal Last.fm account
  const [lastfmAvailable, setLastfmAvailable] = useState(false);
  const [lastfmConnected, setLastfmConnected] = useState(false);
  const [lastfmUsername, setLastfmUsername] = useState<string | null>(null);
  const [lastfmLoading, setLastfmLoading] = useState(false);
  const [lastfmSyncing, setLastfmSyncing] = useState(false);
  const [lastfmError, setLastfmError] = useState<string | null>(null);
  const [lastfmSyncNotice, setLastfmSyncNotice] = useState<string | null>(null);

  // Subsonic/OpenSubsonic settings
  const [subsonicUsername, setSubsonicUsername] = useState('');
  const [subsonicConfigured, setSubsonicConfigured] = useState(false);
  const [subsonicPassword, setSubsonicPasswordValue] = useState('');
  const [subsonicLoading, setSubsonicLoading] = useState(false);
  const [subsonicError, setSubsonicError] = useState<string | null>(null);
  const [subsonicNotice, setSubsonicNotice] = useState<string | null>(null);

  // OpenRouter AI music settings
  const openrouterConfigured = usePreferences((s) => s.openrouterConfigured);
  const openrouterSource = usePreferences((s) => s.openrouterSource);
  const [orApiKey, setOrApiKey] = useState('');
  const [orLoading, setOrLoading] = useState(false);
  const [orError, setOrError] = useState<string | null>(null);

  useEffect(() => {
    const requestedTab = window.sessionStorage.getItem('mvbar_settings_tab');
    if (requestedTab === 'account' || requestedTab === 'playback' || requestedTab === 'notifications' || requestedTab === 'integrations' || requestedTab === 'about') {
      setActiveTab(requestedTab);
    }
    window.sessionStorage.removeItem('mvbar_settings_tab');

    const url = new URL(window.location.href);
    const lastfmResult = url.searchParams.get('lastfm');
    if (lastfmResult) {
      setActiveTab('integrations');
      if (lastfmResult === 'connected') setNotice('Last.fm account connected.');
      else setLastfmError('Last.fm could not complete the connection. Please try again.');
      url.searchParams.delete('lastfm');
      window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    }
  }, []);

  // Load profile
  const loadProfile = async () => {
    if (!token) return;
    try {
      const r = await apiFetch('/users/profile', { method: 'GET' }, token);
      setProfile(r);
      updateAvatar(r.avatar_path);
    } catch {}
  };

  // Load version info
  const loadVersion = async () => {
    try {
      const r = await fetch('/api/version');
      if (r.ok) {
        setVersionInfo(await r.json());
      }
    } catch {}
  };

  useEffect(() => {
    if (token) {
      loadProfile();
      loadPreferences(token, true);
      getListenBrainzSettings(token)
        .then(r => {
          setLbConnected(r.connected);
          setLbUsername(r.username);
        })
        .catch(() => {});
      getLastfmSettings(token)
        .then(r => {
          setLastfmAvailable(r.available);
          setLastfmConnected(r.connected);
          setLastfmUsername(r.username);
        })
        .catch(() => {});
      getSubsonicSettings(token)
        .then(r => {
          setSubsonicUsername(r.username);
          setSubsonicConfigured(r.configured);
        })
        .catch(() => {});
      getRecommendationFeedback(token)
        .then((result) => setRecommendationTuningCount(result.preferences.length))
        .catch(() => {});
    }
    loadVersion();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, loadPreferences]);

  const resetRecommendationTuning = async () => {
    if (!token || recommendationTuningCount === 0) return;
    const confirmed = await showConfirm({
      title: 'Reset recommendation tuning?',
      message: 'This restores hidden mixes and clears your “more like this”, “less from this artist”, and “not for me” choices. Your listening history and favourites are not changed.',
      confirmLabel: 'Reset tuning',
      danger: true,
    });
    if (!confirmed) return;

    setResettingRecommendationTuning(true);
    setError(null);
    try {
      await clearAllRecommendationFeedback(token);
      setRecommendationTuningCount(0);
      setNotice('Recommendation tuning reset');
    } catch (resetError: any) {
      if (resetError?.status === 401) clear();
      setError(resetError?.message || 'Failed to reset recommendation tuning');
    } finally {
      setResettingRecommendationTuning(false);
    }
  };

  // Avatar upload
  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const file = input.files?.[0];
    if (!file || !token) return;

    const formData = new FormData();
    formData.append('file', file);

    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/users/avatar', {
        method: 'POST',
        body: formData,
        credentials: 'include',
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Upload failed');
      }
      const result = await res.json() as { avatar_path: string };
      setProfile((current) => current ? { ...current, avatar_path: result.avatar_path } : current);
      updateAvatar(result.avatar_path);
      setNotice('Avatar updated');
    } catch (err: any) {
      setError(err.message || 'Failed to upload avatar');
    } finally {
      input.value = '';
      setLoading(false);
    }
  };

  // Delete avatar
  const handleDeleteAvatar = async () => {
    if (!token) return;
    setLoading(true);
    try {
      await apiFetch('/users/avatar', { method: 'DELETE' }, token);
      setProfile((current) => current ? { ...current, avatar_path: null } : current);
      updateAvatar(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      setNotice('Avatar removed');
    } catch (err: any) {
      setError(err.message || 'Failed to remove avatar');
    } finally {
      setLoading(false);
    }
  };

  // Unlink Google
  const handleUnlinkGoogle = async () => {
    if (!token || !unlinkAction) return;
    if (unlinkAction === 'convert' && unlinkPassword.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    if (unlinkAction === 'delete') {
      const ok = await showConfirm({ title: 'Delete Account', message: 'Are you sure you want to delete your account? This cannot be undone.', confirmLabel: 'Delete', danger: true });
      if (!ok) return;
    }

    setLoading(true);
    setError(null);
    try {
      await apiFetch('/users/unlink-google', {
        method: 'POST',
        body: JSON.stringify({ action: unlinkAction, password: unlinkPassword }),
      }, token);

      if (unlinkAction === 'delete') {
        clear();
      } else {
        setNotice('Account converted to local. You can now sign in with email and password.');
        setUnlinkAction(null);
        setUnlinkPassword('');
        loadProfile();
      }
    } catch (err: any) {
      setError(err.message || 'Failed to unlink Google account');
    } finally {
      setLoading(false);
    }
  };

  if (!token || !user) return null;

  async function changePassword() {
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      const r = (await apiFetch(
        '/auth/change-password',
        { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) },
        token
      )) as { ok: boolean; token?: string };

      if (!r.ok || !r.token) throw new Error('password change failed');
      setAuth(user);
      setCurrentPassword('');
      setNewPassword('');
      setNotice('Password updated successfully.');
    } catch (e: any) {
      if (e?.status === 401) clear();
      setError(e?.data?.error ?? e?.message ?? 'error');
    } finally {
      setLoading(false);
    }
  }

  async function handleConnectLB() {
    if (!lbToken.trim()) return;
    setLbLoading(true);
    setLbError(null);
    try {
      const r = await connectListenBrainz(token, lbToken.trim());
      if (r.ok && r.username) {
        setLbConnected(true);
        setLbUsername(r.username);
        setLbToken('');
      } else {
        setLbError(r.error || 'Failed to connect');
      }
    } catch (e: any) {
      setLbError(e?.data?.error ?? e?.message ?? 'Error connecting');
    } finally {
      setLbLoading(false);
    }
  }

  async function handleDisconnectLB() {
    setLbLoading(true);
    try {
      await disconnectListenBrainz(token);
      setLbConnected(false);
      setLbUsername(null);
    } catch {
    } finally {
      setLbLoading(false);
    }
  }

  async function handleConnectLastfm() {
    setLastfmLoading(true);
    setLastfmError(null);
    try {
      const result = await beginLastfmConnection(token);
      if (!result.authorizationUrl) throw new Error('Last.fm did not provide an authorization address.');
      window.location.assign(result.authorizationUrl);
    } catch (e: any) {
      setLastfmError(e?.data?.error ?? e?.message ?? 'Could not start the Last.fm connection.');
      setLastfmLoading(false);
    }
  }

  async function handleDisconnectLastfm() {
    setLastfmLoading(true);
    setLastfmError(null);
    try {
      await disconnectLastfm(token);
      setLastfmConnected(false);
      setLastfmUsername(null);
      setNotice('Last.fm account disconnected.');
    } catch (e: any) {
      setLastfmError(e?.data?.error ?? e?.message ?? 'Could not disconnect Last.fm.');
    } finally {
      setLastfmLoading(false);
    }
  }

  async function handleSyncLastfmLovedTracks() {
    setLastfmSyncing(true);
    setLastfmError(null);
    setLastfmSyncNotice(null);
    try {
      const result = await syncLastfmLovedTracks(token);
      await refreshFavorites(token);
      if (result.total === 0) {
        setLastfmSyncNotice('No loved tracks were found in this Last.fm account.');
      } else if (result.imported > 0) {
        setLastfmSyncNotice(
          `Added ${result.imported} ${result.imported === 1 ? 'track' : 'tracks'} to favourites. ${result.matched} of ${result.total} Last.fm loved tracks matched your libraries.${result.deferred > 0 ? ` Kept ${result.deferred} recent local unfavourite ${result.deferred === 1 ? 'change' : 'changes'} while Last.fm catches up.` : ''}${result.truncated ? ' The import reached the 20,000-track safety limit.' : ''}`,
        );
      } else if (result.deferred > 0) {
        setLastfmSyncNotice(
          `No new tracks were added. ${result.matched} of ${result.total} Last.fm loved tracks matched your libraries. Kept ${result.deferred} recent local unfavourite ${result.deferred === 1 ? 'change' : 'changes'} while Last.fm catches up.${result.unmatched > 0 ? ` ${result.unmatched} could not be matched in your libraries.` : ''}${result.truncated ? ' The import reached the 20,000-track safety limit.' : ''}`,
        );
      } else if (result.matched > 0) {
        setLastfmSyncNotice(
          `All ${result.matched} matching ${result.matched === 1 ? 'track is' : 'tracks are'} already in your favourites.${result.unmatched > 0 ? ` ${result.unmatched} could not be matched in your libraries.` : ''}${result.truncated ? ' The import reached the 20,000-track safety limit.' : ''}`,
        );
      } else {
        setLastfmSyncNotice(`None of the ${result.total} loved tracks matched music in your libraries.${result.truncated ? ' The import reached the 20,000-track safety limit.' : ''}`);
      }
    } catch (e: any) {
      setLastfmError(e?.data?.error ?? e?.message ?? 'Could not sync Last.fm loved tracks.');
    } finally {
      setLastfmSyncing(false);
    }
  }

  async function handleSetSubsonicPassword() {
    if (!subsonicPassword.trim() || subsonicPassword.length < 8) return;
    setSubsonicLoading(true);
    setSubsonicError(null);
    setSubsonicNotice(null);
    try {
      await setSubsonicPassword(token, subsonicPassword);
      setSubsonicPasswordValue('');
      setSubsonicConfigured(true);
      setSubsonicNotice('Subsonic password updated.');
    } catch (e: any) {
      setSubsonicError(e?.data?.error ?? e?.message ?? 'Failed to update Subsonic password');
    } finally {
      setSubsonicLoading(false);
    }
  }

  async function handleClearSubsonicPassword() {
    setSubsonicLoading(true);
    setSubsonicError(null);
    setSubsonicNotice(null);
    try {
      await clearSubsonicPassword(token);
      setSubsonicConfigured(false);
      setSubsonicPasswordValue('');
      setSubsonicNotice('Subsonic password cleared.');
    } catch (e: any) {
      setSubsonicError(e?.data?.error ?? e?.message ?? 'Failed to clear Subsonic password');
    } finally {
      setSubsonicLoading(false);
    }
  }

  const tabs: { id: Tab; label: string; icon: ReactElement }[] = [
    { 
      id: 'account', 
      label: 'Account',
      icon: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
    },
    { 
      id: 'playback', 
      label: 'Playback',
      icon: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
    },
    {
      id: 'notifications',
      label: 'Notifications',
      icon: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75V9a6 6 0 00-12 0v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" /></svg>
    },
    { 
      id: 'integrations', 
      label: 'Integrations',
      icon: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /></svg>
    },
    { 
      id: 'about', 
      label: 'About',
      icon: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
    },
  ];

  return (
    <div className="max-w-3xl mx-auto">
      <h1 className="text-2xl font-bold text-white mb-6">Settings</h1>

      {/* Tab Navigation */}
      <div className="flex gap-1 mb-6 bg-slate-800/50 p-1 rounded-xl overflow-x-auto" role="tablist" aria-label="Settings sections">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            role="tab"
            aria-selected={activeTab === tab.id}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
              activeTab === tab.id
                ? 'bg-cyan-600 text-white'
                : 'text-slate-400 hover:text-white hover:bg-slate-700/50'
            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="space-y-6">
        {activeTab === 'account' && (
          <>
            {/* Profile with Avatar */}
            <section className="bg-slate-800/50 rounded-xl p-6 space-y-4">
              <h2 className="text-lg font-semibold text-white">Profile</h2>
              
              <div className="flex items-start gap-6">
                {/* Avatar */}
                <div className="flex shrink-0 flex-col items-center gap-2">
                  <div className="group relative h-20 w-20 shrink-0 overflow-hidden rounded-full">
                    <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-cyan-500 to-blue-600 text-2xl font-bold text-white">
                      {user.email[0].toUpperCase()}
                    </div>
                    {profile?.avatar_path && (
                      <img
                        src={`/api/avatars/${encodeURIComponent(profile.avatar_path)}`}
                        alt="Avatar"
                        className="absolute inset-0 block h-full w-full object-cover"
                        onError={(event) => { event.currentTarget.style.display = 'none'; }}
                      />
                    )}
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className="absolute inset-0 bg-black/50 rounded-full opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
                      aria-label="Change profile picture"
                      title="Change profile picture"
                    >
                      <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                      </svg>
                    </button>
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/gif,image/webp"
                    onChange={handleAvatarUpload}
                    className="hidden"
                  />
                  {profile?.avatar_path && (
                    <button
                      onClick={handleDeleteAvatar}
                      className="text-xs text-slate-400 hover:text-red-400"
                    >
                      Remove
                    </button>
                  )}
                </div>

                {/* User Info */}
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="break-words text-lg font-medium text-white">{user.email}</div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="px-2 py-0.5 bg-slate-700 rounded text-xs text-slate-400">{user.role}</span>
                    {profile?.auth_type === 'google' && (
                      <span className="px-2 py-0.5 bg-blue-600/20 text-blue-400 rounded text-xs flex items-center gap-1">
                        <svg className="w-3 h-3" viewBox="0 0 24 24">
                          <path
                            fill="#4285F4"
                            d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                          />
                          <path
                            fill="#34A853"
                            d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                          />
                          <path
                            fill="#FBBC05"
                            d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                          />
                          <path
                            fill="#EA4335"
                            d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                          />
                        </svg>
                        Google
                      </span>
                    )}
                    {profile?.auth_type === 'local' && (
                      <span className="px-2 py-0.5 bg-slate-600/20 text-slate-400 rounded text-xs">Local</span>
                    )}
                  </div>
                  {profile?.created_at && (
                    <div className="text-xs text-slate-500">
                      Member since {formatCalendarDate(profile.created_at)}
                    </div>
                  )}
                </div>
              </div>
            </section>

            {/* Password Change - only for local accounts */}
            {profile?.auth_type === 'local' && (
              <section className="bg-slate-800/50 rounded-xl p-6 space-y-4">
                <h2 className="text-lg font-semibold text-white">Change Password</h2>
                <div className="space-y-3 max-w-md">
                  <input
                    aria-label="Current password"
                    name="current-password"
                    type="password"
                    autoComplete="current-password"
                    placeholder="Current password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    className="w-full px-4 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500"
                  />
                  <input
                    aria-label="New password"
                    name="new-password"
                    type="password"
                    autoComplete="new-password"
                    placeholder="New password (min 8 characters)"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="w-full px-4 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500"
                  />
                  <button
                    onClick={changePassword}
                    disabled={loading || !currentPassword || newPassword.length < 8}
                    className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-lg transition-colors"
                  >
                    {loading ? 'Saving…' : 'Update Password'}
                  </button>
                </div>
              </section>
            )}

            {/* Unlink Google Account */}
            {profile?.auth_type === 'google' && (
              <section className="bg-slate-800/50 rounded-xl p-6 space-y-4">
                <h2 className="text-lg font-semibold text-white">Google Account</h2>
                <p className="text-slate-400 text-sm">
                  Your account is linked to Google. You can convert it to a local account or delete it entirely.
                </p>

                {!unlinkAction ? (
                  <div className="flex gap-3">
                    <button
                      onClick={() => setUnlinkAction('convert')}
                      className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg transition-colors"
                    >
                      Convert to Local Account
                    </button>
                    <button
                      onClick={() => setUnlinkAction('delete')}
                      className="px-4 py-2 bg-red-600/20 hover:bg-red-600/30 text-red-400 rounded-lg transition-colors"
                    >
                      Delete Account
                    </button>
                  </div>
                ) : unlinkAction === 'convert' ? (
                  <div className="space-y-3 max-w-md">
                    <p className="text-slate-300 text-sm">
                      Set a password to sign in with email instead of Google:
                    </p>
                    <input
                      aria-label="New local account password"
                      name="local-account-password"
                      type="password"
                      autoComplete="new-password"
                      placeholder="New password (min 8 characters)"
                      value={unlinkPassword}
                      onChange={(e) => setUnlinkPassword(e.target.value)}
                      className="w-full px-4 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500"
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={handleUnlinkGoogle}
                        disabled={loading || unlinkPassword.length < 8}
                        className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-lg transition-colors"
                      >
                        {loading ? 'Converting…' : 'Convert Account'}
                      </button>
                      <button
                        onClick={() => { setUnlinkAction(null); setUnlinkPassword(''); }}
                        className="px-4 py-2 text-slate-400 hover:text-white"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <p className="text-red-400 text-sm">
                      This will permanently delete your account and all associated data.
                    </p>
                    <div className="flex gap-2">
                      <button
                        onClick={handleUnlinkGoogle}
                        disabled={loading}
                        className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-lg transition-colors"
                      >
                        {loading ? 'Deleting…' : 'Yes, Delete My Account'}
                      </button>
                      <button
                        onClick={() => setUnlinkAction(null)}
                        className="px-4 py-2 text-slate-400 hover:text-white"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </section>
            )}

            {/* Notices */}
            {notice && <div className="text-green-400 text-sm p-4 bg-green-500/10 rounded-lg">{notice}</div>}
            {error && <div className="text-red-400 text-sm p-4 bg-red-500/10 rounded-lg">{error}</div>}

            {/* Logout */}
            <section className="bg-slate-800/50 rounded-xl p-6">
              <button
                onClick={async () => {
                  try { await unsubscribeCurrentPushDevice(token); } catch {}
                  try { await logout(token); } catch {}
                  resetPlayer();
                  clear();
                }}
                className="px-4 py-2 bg-red-600/20 hover:bg-red-600/30 text-red-400 hover:text-red-300 rounded-lg transition-colors"
              >
                Sign Out
              </button>
            </section>
          </>
        )}

        {activeTab === 'playback' && (
          <>
            {preferencesError && <p role="alert" className="text-sm text-red-400">{preferencesError}</p>}
            {/* Adaptive Streaming */}
            <section className="bg-slate-800/50 rounded-xl p-6 space-y-4">
              <h2 className="text-lg font-semibold text-white">Streaming</h2>
              
              <ToggleSetting
                label="Adaptive Streaming (HLS)"
                description="When enabled, audio is transcoded on the server and streamed in small chunks. This uses more server resources but provides better compatibility with slow connections. When disabled, audio files are streamed directly in their original format."
                enabled={preferences.prefer_hls}
                onChange={(v) => updatePreferences(token, { prefer_hls: v })}
                disabled={preferencesBusy}
              />
            </section>

            {/* Auto Continue */}
            <section className="bg-slate-800/50 rounded-xl p-6 space-y-4">
              <h2 className="text-lg font-semibold text-white">Queue Behavior</h2>
              
              <ToggleSetting
                label="Continue Playback After Queue Ends"
                description={lastfmEnabled
                  ? "When the queue ends, automatically add similar tracks based on the last played song. Uses Last.fm to find related music from your library."
                  : "Requires the server Last.fm integration. An administrator can configure it in Admin settings."}
                enabled={preferences.auto_continue}
                onChange={(v) => updatePreferences(token, { auto_continue: v })}
                disabled={!lastfmEnabled || preferencesBusy}
              />
            </section>

            <section className="bg-slate-800/50 rounded-xl p-6 space-y-4">
              <div>
                <h2 className="text-lg font-semibold text-white">Recommendation tuning</h2>
                <p className="mt-1 text-sm text-slate-400">
                  Your feedback helps mvbar adjust future mixes. Listening history and favourites remain the main signals.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => void resetRecommendationTuning()}
                  disabled={resettingRecommendationTuning || recommendationTuningCount === 0}
                  className="rounded-lg bg-slate-700 px-4 py-2 text-sm text-white transition-colors hover:bg-slate-600 disabled:cursor-not-allowed disabled:text-slate-500"
                >
                  {resettingRecommendationTuning ? 'Resetting…' : 'Reset recommendation tuning'}
                </button>
                <span className="text-xs text-slate-500">
                  {recommendationTuningCount === 0
                    ? 'No manual tuning saved'
                    : `${recommendationTuningCount} saved ${recommendationTuningCount === 1 ? 'choice' : 'choices'}`}
                </span>
              </div>
            </section>
          </>
        )}

        {activeTab === 'notifications' && <PushNotificationSettings token={token} />}

        {activeTab === 'integrations' && (
          <>
            {/* Subsonic / OpenSubsonic */}
            <section className="bg-slate-800/50 rounded-xl p-6 space-y-4">
              <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                {subsonicConfigured ? (
                  <svg className="w-5 h-5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5 text-slate-500" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="10" />
                  </svg>
                )}
                Subsonic / OpenSubsonic
              </h2>

              <div className="space-y-3 max-w-md">
                <div className="text-sm text-slate-400">
                  Use <span className="text-white">{subsonicUsername || user.email}</span> as the username in clients such as DSub or Symfonium.
                </div>
                <input
                  aria-label="Subsonic password"
                  name="subsonic-password"
                  type="password"
                  autoComplete="new-password"
                  placeholder={subsonicConfigured ? 'New Subsonic password' : 'Subsonic password (min 8 characters)'}
                  value={subsonicPassword}
                  onChange={(e) => setSubsonicPasswordValue(e.target.value)}
                  className="w-full px-4 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500"
                />
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={handleSetSubsonicPassword}
                    disabled={subsonicLoading || subsonicPassword.length < 8}
                    className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-lg transition-colors"
                  >
                    {subsonicLoading ? 'Saving...' : subsonicConfigured ? 'Update Password' : 'Set Password'}
                  </button>
                  {subsonicConfigured && (
                    <button
                      onClick={handleClearSubsonicPassword}
                      disabled={subsonicLoading}
                      className="px-4 py-2 bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded-lg transition-colors"
                    >
                      Clear
                    </button>
                  )}
                </div>
                {profile?.auth_type === 'google' && (
                  <div className="text-xs text-slate-500">
                    Google sign-in cannot be sent to Subsonic clients, so this app password is required.
                  </div>
                )}
                {subsonicNotice && <div className="text-green-400 text-sm">{subsonicNotice}</div>}
                {subsonicError && <div className="text-red-400 text-sm">{subsonicError}</div>}
              </div>
            </section>

            {/* OpenRouter AI */}
            <section className="bg-slate-800/50 rounded-xl p-6 space-y-4">
              <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                {openrouterConfigured ? (
                  <svg className="w-5 h-5 text-emerald-400" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
                  </svg>
                ) : (
                  <span className="text-lg">✨</span>
                )}
                AI Mix
              </h2>

              <p className="text-sm text-slate-400">
                Describe the music you want in plain language, then preview, play or queue a mix from your own library. Only your prompt is sent to <a href="https://openrouter.ai" target="_blank" rel="noopener noreferrer" className="text-cyan-400 hover:underline">OpenRouter</a>; MVBar chooses tracks locally from your permitted libraries. “Similar” requests can also use the server&apos;s Last.fm artist-similarity service.
              </p>

              {openrouterConfigured ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-3 p-3 bg-green-500/10 border border-green-500/30 rounded-lg">
                    <svg className="w-5 h-5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    <div>
                      <div className="text-green-400 font-medium">
                        {openrouterSource === 'server' ? 'Available from this server' : 'Personal API key connected'}
                      </div>
                      <div className="text-sm text-slate-400">Choose AI Mix from Search, then describe a mood, genre, era or activity.</div>
                    </div>
                  </div>
                  {openrouterSource === 'personal' ? (
                    <button
                      onClick={async () => {
                        setOrLoading(true);
                        setOrError(null);
                        try {
                          const saved = await updatePreferences(token!, { openrouter_api_key: '' });
                          if (!saved) setOrError('Failed to remove API key');
                        } catch {
                          setOrError('Failed to remove API key');
                        }
                        setOrLoading(false);
                      }}
                      disabled={orLoading || preferencesBusy}
                      className="px-4 py-2 bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded-lg transition-colors"
                    >
                      {orLoading ? 'Disconnecting...' : 'Remove personal API key'}
                    </button>
                  ) : (
                    <p className="text-xs text-slate-500">
                      Your administrator supplies the OpenRouter access. The default model uses OpenRouter&apos;s free router.
                    </p>
                  )}
                </div>
              ) : (
                <div className="space-y-3 max-w-md">
                  <div className="text-sm text-slate-400">
                    Get an API key from <a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer" className="text-cyan-400 hover:underline">OpenRouter Keys</a>. MVBar uses the free model router by default, subject to OpenRouter&apos;s availability and limits.
                  </div>
                  <input
                    aria-label="OpenRouter API key"
                    name="openrouter-api-key"
                    type="password"
                    autoComplete="off"
                    placeholder="Paste your OpenRouter API key"
                    value={orApiKey}
                    onChange={(e) => setOrApiKey(e.target.value)}
                    maxLength={500}
                    className="w-full px-4 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500"
                  />
                  <button
                    onClick={async () => {
                      if (!orApiKey.trim()) return;
                      setOrLoading(true);
                      setOrError(null);
                      try {
                        const saved = await updatePreferences(token!, { openrouter_api_key: orApiKey.trim() });
                        if (saved) {
                          setOrApiKey('');
                        } else {
                          setOrError('Failed to save API key');
                        }
                      } catch {
                        setOrError('Failed to save API key');
                      }
                      setOrLoading(false);
                    }}
                    disabled={orLoading || preferencesBusy || !orApiKey.trim()}
                    className="px-4 py-2 bg-emerald-500 hover:bg-emerald-400 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-lg transition-colors"
                  >
                    {orLoading ? 'Saving...' : 'Connect OpenRouter'}
                  </button>
                </div>
              )}
              {orError && <div className="text-red-400 text-sm">{orError}</div>}
            </section>

            {/* ListenBrainz */}
            <section className="bg-slate-800/50 rounded-xl p-6 space-y-4">
              <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                {lbConnected ? (
                  <svg className="w-5 h-5 text-orange-400" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
                  </svg>
                ) : (
                  <svg className="w-5 h-5 text-slate-500" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="10" />
                  </svg>
                )}
                ListenBrainz
              </h2>

              <p className="text-sm text-slate-400">
                Connect to <a href="https://listenbrainz.org" target="_blank" rel="noopener noreferrer" className="text-cyan-400 hover:underline">ListenBrainz</a> to 
                scrobble your listening history and get personalized recommendations. ListenBrainz is a free, open-source music tracking service.
              </p>

              {lbConnected ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-3 p-3 bg-green-500/10 border border-green-500/30 rounded-lg">
                    <svg className="w-5 h-5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    <div>
                      <div className="text-green-400 font-medium">Connected</div>
                      <div className="text-sm text-slate-400">Scrobbling as <span className="text-white">{lbUsername}</span></div>
                    </div>
                  </div>
                  <button
                    onClick={handleDisconnectLB}
                    disabled={lbLoading}
                    className="px-4 py-2 bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded-lg transition-colors"
                  >
                    {lbLoading ? 'Disconnecting...' : 'Disconnect'}
                  </button>
                </div>
              ) : (
                <div className="space-y-3 max-w-md">
                  <div className="text-sm text-slate-400">
                    Get your user token from <a href="https://listenbrainz.org/settings/" target="_blank" rel="noopener noreferrer" className="text-cyan-400 hover:underline">ListenBrainz Settings</a>.
                  </div>
                  <input
                    aria-label="ListenBrainz user token"
                    name="listenbrainz-token"
                    type="password"
                    autoComplete="off"
                    placeholder="Paste your ListenBrainz user token"
                    value={lbToken}
                    onChange={(e) => setLbToken(e.target.value)}
                    className="w-full px-4 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500"
                  />
                  <button
                    onClick={handleConnectLB}
                    disabled={lbLoading || !lbToken.trim()}
                    className="px-4 py-2 bg-orange-500 hover:bg-orange-400 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-lg transition-colors"
                  >
                    {lbLoading ? 'Connecting...' : 'Connect to ListenBrainz'}
                  </button>
                  {lbError && <div className="text-red-400 text-sm">{lbError}</div>}
                </div>
              )}
            </section>

            {/* Personal Last.fm account */}
            <section className="bg-slate-800/50 rounded-xl p-6 space-y-4">
              <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                {lastfmConnected ? (
                  <svg className="w-5 h-5 text-red-400" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
                  </svg>
                ) : (
                  <svg className="w-5 h-5 text-slate-500" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="10" />
                  </svg>
                )}
                Last.fm
              </h2>

              <p className="text-sm text-slate-400">
                Connect your Last.fm account to scrobble listening, keep new favourite changes in sync, and import loved tracks that exist in your mvbar libraries.
              </p>

              {lastfmConnected ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-3 p-3 bg-green-500/10 border border-green-500/30 rounded-lg">
                    <svg className="w-5 h-5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    <div>
                      <div className="text-green-400 font-medium">Connected</div>
                      <div className="text-sm text-slate-400">
                        Scrobbling and syncing favourites as <span className="text-white">{lastfmUsername || 'your Last.fm account'}</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-3">
                    <button
                      onClick={handleSyncLastfmLovedTracks}
                      disabled={lastfmSyncing || lastfmLoading}
                      className="px-4 py-2 bg-red-600 hover:bg-red-500 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-lg transition-colors"
                    >
                      {lastfmSyncing ? 'Syncing loved tracks...' : 'Sync loved tracks'}
                    </button>
                    <button
                      onClick={handleDisconnectLastfm}
                      disabled={lastfmLoading || lastfmSyncing}
                      className="px-4 py-2 bg-red-500/10 hover:bg-red-500/20 disabled:opacity-50 text-red-400 rounded-lg transition-colors"
                    >
                      {lastfmLoading ? 'Disconnecting...' : 'Disconnect Last.fm'}
                    </button>
                  </div>
                  {lastfmSyncNotice && <div className="text-sm text-green-300">{lastfmSyncNotice}</div>}
                </div>
              ) : lastfmAvailable ? (
                <button
                  onClick={handleConnectLastfm}
                  disabled={lastfmLoading}
                  className="px-4 py-2 bg-red-600 hover:bg-red-500 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-lg transition-colors"
                >
                  {lastfmLoading ? 'Opening Last.fm...' : 'Connect Last.fm account'}
                </button>
              ) : (
                <div className="flex items-start gap-3 p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg">
                  <svg className="w-5 h-5 mt-0.5 text-amber-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M5.07 19h13.86a2 2 0 001.73-3L13.73 4a2 2 0 00-3.46 0L3.34 16a2 2 0 001.73 3z" />
                  </svg>
                  <div className="text-sm text-amber-200">
                    Last.fm account connections are not available yet. Ask an administrator to add the server API key and shared secret.
                  </div>
                </div>
              )}
              {lastfmError && <div className="text-red-400 text-sm">{lastfmError}</div>}
            </section>
          </>
        )}

        {activeTab === 'about' && (
          <section className="bg-slate-800/50 rounded-xl p-6 space-y-4">
            <h2 className="text-lg font-semibold text-white">About mvbar</h2>
            <div className="text-slate-400 space-y-2">
              <p>A self-hosted music player for your personal library.</p>
              <div className="grid grid-cols-2 gap-4 mt-4">
                <div>
                  <div className="text-xs text-slate-500 uppercase tracking-wide">Version</div>
                  <div className="text-white font-mono">
                    {versionInfo?.version && versionInfo.version !== '0.0.0-dev' 
                      ? versionInfo.version 
                      : versionInfo?.branch && versionInfo?.commit 
                        ? `${versionInfo.branch}-${versionInfo.commit.slice(0, 7)}`
                        : 'dev'}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-500 uppercase tracking-wide">License</div>
                  <div className="text-white">MIT</div>
                </div>
                {versionInfo?.commit && versionInfo.commit !== 'unknown' && (
                  <div>
                    <div className="text-xs text-slate-500 uppercase tracking-wide">Commit</div>
                    <div className="text-white font-mono text-sm">{versionInfo.commit.slice(0, 7)}</div>
                  </div>
                )}
                {versionInfo?.buildDate && versionInfo.buildDate !== 'unknown' && (
                  <div>
                    <div className="text-xs text-slate-500 uppercase tracking-wide">Build Date</div>
                    <div className="text-white text-sm">{formatCalendarDate(versionInfo.buildDate)}</div>
                  </div>
                )}
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

// Reusable toggle setting component
function ToggleSetting({ 
  label, 
  description, 
  enabled, 
  onChange,
  disabled,
}: { 
  label: string; 
  description: string; 
  enabled: boolean; 
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className={`flex items-start justify-between gap-4 ${disabled ? 'opacity-50' : ''}`}>
      <div className="flex-1">
        <div className="font-medium text-white">{label}</div>
        <p className="text-sm text-slate-400 mt-1">{description}</p>
      </div>
      <button
        type="button"
        onClick={() => !disabled && onChange(!enabled)}
        disabled={disabled}
        role="switch"
        aria-checked={enabled}
        aria-label={label}
        className={`relative w-11 h-6 rounded-full transition-colors flex-shrink-0 ${
          disabled ? 'cursor-not-allowed' : ''
        } ${
          enabled ? 'bg-cyan-600' : 'bg-slate-600'
        }`}
      >
        <span
          className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform ${
            enabled ? 'translate-x-5' : 'translate-x-0'
          }`}
        />
      </button>
    </div>
  );
}

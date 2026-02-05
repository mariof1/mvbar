'use client';

import { useState, useEffect, useRef, type ReactElement } from 'react';
import { apiFetch, logout, getListenBrainzSettings, connectListenBrainz, disconnectListenBrainz } from './apiClient';
import { useAuth } from './store';
import { usePlayer } from './playerStore';
import { usePreferences } from './preferencesStore';

type Tab = 'account' | 'playback' | 'integrations' | 'about';

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
  const clear = useAuth((s) => s.clear);
  const resetPlayer = usePlayer((s) => s.reset);
  const preferences = usePreferences((s) => s.preferences);
  const loadPreferences = usePreferences((s) => s.load);
  const updatePreferences = usePreferences((s) => s.update);

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

  // Unlink Google state
  const [unlinkAction, setUnlinkAction] = useState<'convert' | 'delete' | null>(null);
  const [unlinkPassword, setUnlinkPassword] = useState('');

  // ListenBrainz settings
  const [lbConnected, setLbConnected] = useState(false);
  const [lbUsername, setLbUsername] = useState<string | null>(null);
  const [lbToken, setLbToken] = useState('');
  const [lbLoading, setLbLoading] = useState(false);
  const [lbError, setLbError] = useState<string | null>(null);

  // Load profile
  const loadProfile = async () => {
    if (!token) return;
    try {
      const r = await apiFetch('/users/profile', { method: 'GET' }, token);
      setProfile(r);
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
      loadPreferences(token);
      getListenBrainzSettings(token)
        .then(r => {
          setLbConnected(r.connected);
          setLbUsername(r.username);
        })
        .catch(() => {});
    }
    loadVersion();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, loadPreferences]);

  // Avatar upload
  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
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
      setNotice('Avatar updated');
      loadProfile();
    } catch (err: any) {
      setError(err.message || 'Failed to upload avatar');
    } finally {
      setLoading(false);
    }
  };

  // Delete avatar
  const handleDeleteAvatar = async () => {
    if (!token) return;
    setLoading(true);
    try {
      await apiFetch('/users/avatar', { method: 'DELETE' }, token);
      setNotice('Avatar removed');
      loadProfile();
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
    if (unlinkAction === 'delete' && !confirm('Are you sure you want to delete your account? This cannot be undone.')) {
      return;
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
      <div className="flex gap-1 mb-6 bg-slate-800/50 p-1 rounded-xl overflow-x-auto">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
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
                <div className="flex flex-col items-center gap-2">
                  <div className="relative group">
                    {profile?.avatar_path ? (
                      <img
                        src={`/api/avatars/${profile.avatar_path}`}
                        alt="Avatar"
                        className="w-20 h-20 rounded-full object-cover"
                      />
                    ) : (
                      <div className="w-20 h-20 rounded-full bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center text-2xl font-bold text-white">
                        {user.email[0].toUpperCase()}
                      </div>
                    )}
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className="absolute inset-0 bg-black/50 rounded-full opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
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
                <div className="flex-1 space-y-2">
                  <div className="text-lg font-medium text-white">{user.email}</div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="px-2 py-0.5 bg-slate-700 rounded text-xs text-slate-400">{user.role}</span>
                    {profile?.auth_type === 'google' && (
                      <span className="px-2 py-0.5 bg-blue-600/20 text-blue-400 rounded text-xs flex items-center gap-1">
                        <svg className="w-3 h-3" viewBox="0 0 24 24">
                          <path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                          <path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
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
                      Member since {new Date(profile.created_at).toLocaleDateString()}
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
                    type="password"
                    placeholder="Current password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    className="w-full px-4 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500"
                  />
                  <input
                    type="password"
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
                      type="password"
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
            {/* Adaptive Streaming */}
            <section className="bg-slate-800/50 rounded-xl p-6 space-y-4">
              <h2 className="text-lg font-semibold text-white">Streaming</h2>
              
              <ToggleSetting
                label="Adaptive Streaming (HLS)"
                description="When enabled, audio is transcoded on the server and streamed in small chunks. This uses more server resources but provides better compatibility with slow connections. When disabled, audio files are streamed directly in their original format."
                enabled={preferences.prefer_hls}
                onChange={(v) => updatePreferences(token, { prefer_hls: v })}
              />
            </section>

            {/* Auto Continue */}
            <section className="bg-slate-800/50 rounded-xl p-6 space-y-4">
              <h2 className="text-lg font-semibold text-white">Queue Behavior</h2>
              
              <ToggleSetting
                label="Continue Playback After Queue Ends"
                description="When the queue ends, automatically add similar tracks based on the last played song. Uses Last.fm to find related music from your library."
                enabled={preferences.auto_continue}
                onChange={(v) => updatePreferences(token, { auto_continue: v })}
              />
            </section>
          </>
        )}

        {activeTab === 'integrations' && (
          <>
            {/* ListenBrainz */}
            <section className="bg-slate-800/50 rounded-xl p-6 space-y-4">
              <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                <svg className="w-5 h-5 text-orange-400" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
                </svg>
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
                    type="password"
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

            {/* Last.fm Info */}
            <section className="bg-slate-800/50 rounded-xl p-6 space-y-4">
              <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                <svg className="w-5 h-5 text-red-400" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/>
                </svg>
                Last.fm
              </h2>

              <p className="text-sm text-slate-400">
                Last.fm integration is used for discovering similar artists and tracks. This powers the &quot;Continue Playback&quot; feature and artist recommendations.
              </p>

              <div className="flex items-center gap-3 p-3 bg-slate-700/50 rounded-lg">
                <svg className="w-5 h-5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <div className="text-sm text-slate-400">
                  Last.fm is configured by your server administrator via the <code className="bg-slate-800 px-1 rounded">LASTFM_API_KEY</code> environment variable.
                </div>
              </div>
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
                    <div className="text-white text-sm">{new Date(versionInfo.buildDate).toLocaleDateString()}</div>
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
  onChange 
}: { 
  label: string; 
  description: string; 
  enabled: boolean; 
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex-1">
        <div className="font-medium text-white">{label}</div>
        <p className="text-sm text-slate-400 mt-1">{description}</p>
      </div>
      <button
        onClick={() => onChange(!enabled)}
        className={`relative w-11 h-6 rounded-full transition-colors flex-shrink-0 ${
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

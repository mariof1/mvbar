export const API_BASE = '/api';

export type LoginResponse = { ok: true; token: string; user: { id: string; email: string; role: string } };

export async function apiFetch(path: string, init: RequestInit = {}, token?: string) {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type') && init.body) headers.set('content-type', 'application/json');
  if (token && token !== 'cookie') headers.set('authorization', `Bearer ${token}`);
  headers.set('x-mvbar-client', 'web');
  headers.set('x-mvbar-version', '0.1.0');
  if (typeof window !== 'undefined') {
    let clientId = window.localStorage.getItem('mvbar_client_id');
    if (!clientId) {
      clientId = globalThis.crypto?.randomUUID?.() ?? `web_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      window.localStorage.setItem('mvbar_client_id', clientId);
    }
    headers.set('x-mvbar-client-id', clientId);
    headers.set('x-mvbar-platform', window.navigator.platform || 'browser');
  }
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers, cache: 'no-store', credentials: 'same-origin' });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) throw Object.assign(new Error('API error'), { status: res.status, data });
  return data;
}

export type RecentSearch = {
  itemType: 'track' | 'artist' | 'album' | 'playlist' | 'podcast' | 'podcast_episode';
  itemKey: string;
  title: string;
  subtitle: string | null;
  imageUrl: string | null;
  payload: Record<string, unknown>;
  accessedAt: string;
};

export type RecentSearchInput = Omit<RecentSearch, 'accessedAt'>;

export async function getRecentSearches(token: string, limit = 10) {
  const boundedLimit = Math.max(1, Math.min(20, Math.trunc(Number.isFinite(limit) ? limit : 10)));
  return (await apiFetch(`/search/recent?limit=${boundedLimit}`, { method: 'GET' }, token)) as {
    ok: true;
    searches: RecentSearch[];
  };
}

export async function saveRecentSearch(token: string, item: RecentSearchInput) {
  return (await apiFetch('/search/recent', {
    method: 'POST',
    body: JSON.stringify(item),
  }, token)) as { ok: true } & RecentSearch;
}

export async function removeRecentSearch(token: string, itemType: RecentSearch['itemType'], itemKey: string) {
  return (await apiFetch(`/search/recent?type=${encodeURIComponent(itemType)}&key=${encodeURIComponent(itemKey)}`, { method: 'DELETE' }, token)) as {
    ok: true;
    removed: number;
  };
}

export async function clearRecentSearches(token: string) {
  return (await apiFetch('/search/recent', { method: 'DELETE' }, token)) as {
    ok: true;
    removed: number;
  };
}

function adminTransferHeaders(token: string) {
  const headers = new Headers();
  if (token && token !== 'cookie') headers.set('authorization', `Bearer ${token}`);
  headers.set('x-mvbar-client', 'web');
  headers.set('x-mvbar-version', '0.1.0');
  return headers;
}

async function transferError(response: Response) {
  const text = await response.text();
  let data: any = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Keep the server's plain-text error.
  }
  const message = data?.error || data?.message || `Request failed (${response.status})`;
  throw Object.assign(new Error(message), { status: response.status, data });
}

export type AdminBackup = {
  name: string;
  size: number;
  createdAt: string;
  storedAt: string;
  includesCaches: boolean;
  cacheFiles: number;
  cacheBytes: number;
  appVersion: string;
  commit: string;
};

export type AdminBackupJob = {
  id: string;
  startedAt: string;
  includeCaches: boolean;
};

export async function listAdminBackups(token: string) {
  return (await apiFetch('/admin/backups', { method: 'GET' }, token)) as {
    ok: true;
    backups: AdminBackup[];
    creating: AdminBackupJob | null;
  };
}

export async function createAdminBackup(token: string, includeCaches = false) {
  return (await apiFetch('/admin/backups', {
    method: 'POST',
    body: JSON.stringify({ includeCaches }),
  }, token)) as { ok: true; job: AdminBackupJob };
}

export async function downloadAdminBackup(token: string, name: string) {
  const url = `${API_BASE}/admin/backups/${encodeURIComponent(name)}/download`;
  if (token === 'cookie') {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    return;
  }
  const response = await fetch(url, {
    method: 'GET',
    headers: adminTransferHeaders(token),
    cache: 'no-store',
    credentials: 'same-origin',
  });
  if (!response.ok) await transferError(response);
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function uploadAdminBackup(token: string, file: File) {
  const form = new FormData();
  form.append('backup', file, file.name);
  const response = await fetch(`${API_BASE}/admin/backups/upload`, {
    method: 'POST',
    headers: adminTransferHeaders(token),
    body: form,
    cache: 'no-store',
    credentials: 'same-origin',
  });
  if (!response.ok) await transferError(response);
  return (await response.json()) as { ok: true; backup: AdminBackup };
}

export type PluginPermissionInfo = {
  key: string;
  reason: string | null;
  detail: string | null;
  broad: boolean;
  supported: boolean;
};

export type PluginSchemaProperty = {
  type?: 'string' | 'integer' | 'number' | 'boolean';
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  format?: string;
};

export type AdminPluginAction = {
  id: string;
  name: string;
  description?: string;
  export: string;
  inputSchema?: {
    type?: 'object';
    properties?: Record<string, PluginSchemaProperty>;
    required?: string[];
  };
};

export type AdminPlugin = {
  id: string;
  filename: string;
  name: string;
  author: string;
  version: string;
  description: string | null;
  homepage: string | null;
  enabled: boolean;
  enabledInDatabase: boolean;
  present: boolean;
  packageSha256: string;
  permissionFingerprint: string;
  permissions: PluginPermissionInfo[];
  configSchema: {
    type?: 'object';
    properties?: Record<string, PluginSchemaProperty>;
    required?: string[];
    additionalProperties?: boolean;
  } | null;
  config: Record<string, unknown>;
  configuredSecrets: string[];
  actions: AdminPluginAction[];
  exports: string[];
  installedAt: string;
  updatedAt: string;
  lastLoadedAt: string | null;
  lastError: string | null;
};

export type AdminPluginRun = {
  id: number;
  export_name: string;
  ok: boolean;
  duration_ms: number;
  error: string | null;
  logs: Array<{ level: string; message: string }>;
  created_at: string;
};

export async function listAdminPlugins(token: string) {
  return (await apiFetch('/admin/plugins', { method: 'GET' }, token)) as {
    ok: true;
    executionEnabled: boolean;
    uploadLimitBytes: number;
    plugins: AdminPlugin[];
  };
}

export async function uploadAdminPlugin(token: string, file: File) {
  const form = new FormData();
  form.append('plugin', file, file.name);
  const response = await fetch(`${API_BASE}/admin/plugins/upload`, {
    method: 'POST',
    headers: adminTransferHeaders(token),
    body: form,
    cache: 'no-store',
    credentials: 'same-origin',
  });
  if (!response.ok) await transferError(response);
  return (await response.json()) as { ok: true; plugin: AdminPlugin };
}

export async function rescanAdminPlugins(token: string) {
  return (await apiFetch('/admin/plugins/rescan', { method: 'POST' }, token)) as {
    ok: true;
    found: number;
    installed: string[];
    updated: string[];
    errors: Array<{ filename: string; error: string }>;
  };
}

export async function configureAdminPlugin(token: string, id: string, config: Record<string, unknown>) {
  return (await apiFetch(`/admin/plugins/${encodeURIComponent(id)}/config`, {
    method: 'PUT',
    body: JSON.stringify({ config }),
  }, token)) as { ok: true; plugin: AdminPlugin };
}

export async function setAdminPluginEnabled(token: string, plugin: AdminPlugin, enabled: boolean) {
  return (await apiFetch(`/admin/plugins/${encodeURIComponent(plugin.id)}/enabled`, {
    method: 'PUT',
    body: JSON.stringify({ enabled, permissionFingerprint: plugin.permissionFingerprint }),
  }, token)) as { ok: true; plugin: AdminPlugin };
}

export async function testAdminPlugin(token: string, id: string) {
  return (await apiFetch(`/admin/plugins/${encodeURIComponent(id)}/test`, { method: 'POST' }, token)) as {
    ok: true;
    exports: string[];
    imports: string[];
    logs: Array<{ level: string; message: string }>;
  };
}

export async function listAdminPluginRuns(token: string, id: string) {
  return (await apiFetch(`/admin/plugins/${encodeURIComponent(id)}/runs`, { method: 'GET' }, token)) as {
    ok: true;
    runs: AdminPluginRun[];
  };
}

export async function runAdminPluginAction(token: string, id: string, actionId: string, input: Record<string, unknown>) {
  return (await apiFetch(`/admin/plugins/${encodeURIComponent(id)}/actions/${encodeURIComponent(actionId)}`, {
    method: 'POST',
    body: JSON.stringify({ input }),
  }, token)) as { ok: true; output: unknown };
}

export async function deleteAdminPlugin(token: string, id: string) {
  return (await apiFetch(`/admin/plugins/${encodeURIComponent(id)}`, { method: 'DELETE' }, token)) as { ok: true };
}

export async function deleteAdminBackup(token: string, name: string) {
  return (await apiFetch(`/admin/backups/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  }, token)) as { ok: true };
}

export async function restoreAdminBackup(
  token: string,
  name: string,
  restoreCaches = false,
  preserveSessions = false,
) {
  return (await apiFetch(
    `/admin/backups/${encodeURIComponent(name)}/restore?restoreCaches=${restoreCaches}&preserveSessions=${preserveSessions}`,
    { method: 'POST' },
    token,
  )) as {
    ok: true;
    tables: number;
    rows: number;
    librariesRemapped: number;
    cachesRestored: boolean;
    cacheFiles: number;
    avatarFilesRestored: number;
    reindexQueued: boolean;
    warning?: string;
    sessionsInvalidated: boolean;
    sessionsPreserved: boolean;
  };
}

export async function login(email: string, password: string) {
  return (await apiFetch('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password })
  })) as LoginResponse;
}

export async function me(token?: string) {
  return (await apiFetch('/auth/me', { method: 'GET' }, token)) as { ok: boolean; user?: { id: string; email: string; role: string } };
}

export async function logout(token?: string) {
  return (await apiFetch('/auth/logout', { method: 'POST' }, token)) as { ok: boolean };
}

export async function listTracks(token: string, limit = 50, offset = 0) {
  return (await apiFetch(`/library/tracks?limit=${limit}&offset=${offset}`, { method: 'GET' }, token)) as {
    ok: boolean;
    tracks: Array<{ id: number; path: string; ext: string; title: string | null; artist: string | null; album: string | null; duration_ms: number | null }>;
    limit: number;
    offset: number;
  };
}

export async function scanNow(token: string) {
  return (await apiFetch('/admin/library/scan', { method: 'POST' }, token)) as { ok: boolean; jobId: string };
}

export async function scanStatus(token: string) {
  return (await apiFetch('/admin/library/scan/status', { method: 'GET' }, token)) as { ok: boolean; job: any };
}

export async function adminLibraryWritable(token: string) {
  return (await apiFetch('/admin/library/writable', { method: 'GET' }, token)) as {
    ok: boolean;
    anyWritable: boolean;
    writableMounts: string[];
    libraries: Array<{ id: number; mount_path: string; media_type: 'music' | 'audiobook'; writable: boolean }>;
  };
}

export async function adminUpdateTrackMetadata(
  token: string,
  trackId: number,
  payload: {
    title?: string | null;
    artists?: string[] | null;
    album?: string | null;
    albumArtist?: string | null;
    trackNumber?: number | null;
    discNumber?: number | null;
    year?: number | null;
    genre?: string | null;
    country?: string | null;
    language?: string | null;
  }
) {
  return (await apiFetch(`/admin/tracks/${trackId}/metadata`, { method: 'POST', body: JSON.stringify(payload) }, token)) as { ok: boolean };
}

export async function listLibraries(token: string) {
  const r = (await apiFetch('/admin/libraries', { method: 'GET' }, token)) as {
    ok: boolean;
    libraries: Array<{
      id: number | string;
      mount_path: string;
      media_type: 'music' | 'audiobook';
      mounted?: boolean;
      writable?: boolean;
      read_only?: boolean;
    }>;
  };
  return { ok: r.ok, libraries: r.libraries.map((l) => ({ ...l, id: Number(l.id) })) };
}

export async function adminDeleteLibrary(token: string, libraryId: number, opts?: { force?: boolean }) {
  const qs = opts?.force ? '?force=true' : '';
  return (await apiFetch(`/admin/libraries/${libraryId}${qs}`, { method: 'DELETE' }, token)) as { ok: boolean };
}

export async function listAdminUsers(token: string) {
  return (await apiFetch('/admin/users', { method: 'GET' }, token)) as {
    ok: boolean;
    users: Array<{ id: string; email: string; role: string; avatar_path: string | null }>;
  };
}

export type AdminLoginRestriction = {
  blocked: boolean;
  locked: boolean;
  rateLimited: boolean;
  blockedUntil: number | null;
  failedAttempts: number;
  ips: string[];
};

export type AdminUserAuditSummary = {
  id: string;
  email: string;
  role: 'admin' | 'user';
  authProvider: 'google' | 'google_password' | 'password';
  approvalStatus: string;
  avatarPath: string | null;
  createdAt: string;
  lastActiveAt: string | null;
  lastActiveIp: string | null;
  lastLoginAt: string | null;
  lastLoginIp: string | null;
  lastLoginSource: string | null;
  loginCount: number;
  lastPlayedAt: string | null;
  lastPodcastAt: string | null;
  lastAudiobookAt: string | null;
  lastListenedAt: string | null;
  totalPlays: number;
  plays7d: number;
  podcastEpisodeCount: number;
  podcastCompletedCount: number;
  podcasts7d: number;
  audiobookCount: number;
  audiobookCompletedCount: number;
  audiobooks7d: number;
  activity7d: number;
  musicListeningMs: number;
  podcastListeningMs: number;
  audiobookListeningMs: number;
  estimatedListeningMs: number;
  favoriteCount: number;
  playlistCount: number;
  loginRestriction: AdminLoginRestriction;
};

export type AdminUserAuditOverview = {
  ok: boolean;
  users: AdminUserAuditSummary[];
  totals: {
    users: number;
    active7d: number;
    activity7d: number;
    estimatedListeningMs: number;
  };
};

export type AdminUserAuditDetail = {
  ok: boolean;
  user: AdminUserAuditSummary;
  history: Array<{
    historyId: number;
    trackId: number;
    title: string | null;
    artist: string | null;
    album: string | null;
    durationMs: number | null;
    playedAt: string;
  }>;
  historyTotal: number;
  podcastHistory: Array<{
    activityId: number;
    episodeId: number;
    podcastId: number;
    episodeTitle: string;
    podcastTitle: string;
    durationMs: number | null;
    positionMs: number;
    listenedMs: number;
    completed: boolean;
    clientType: string | null;
    updatedAt: string;
  }>;
  podcastHistoryTotal: number;
  audiobookHistory: Array<{
    activityId: number;
    audiobookId: number;
    bookTitle: string;
    author: string | null;
    bookDurationMs: number;
    chapterId: number | null;
    chapterTitle: string | null;
    chapterDurationMs: number | null;
    positionMs: number;
    listenedMs: number;
    completed: boolean;
    clientType: string | null;
    updatedAt: string;
  }>;
  audiobookHistoryTotal: number;
  signIns: Array<{
    ts: string;
    event: 'login_ok' | 'login_failed' | 'login_locked';
    ip: string | null;
    method: 'password' | 'google' | null;
    backfilledFrom: string | null;
    clientType: string | null;
    appVersion: string | null;
    deviceName: string | null;
    platform: string | null;
  }>;
  clients: Array<{
    clientId: string;
    clientType: string;
    appVersion: string | null;
    deviceName: string | null;
    platform: string | null;
    firstSeenAt: string;
    lastSeenAt: string;
    lastSeenIp: string | null;
  }>;
  dailyActivity: Array<{ date: string; count: number }>;
  limit: number;
  offset: number;
};

export async function getAdminUserAudit(token: string) {
  return (await apiFetch('/admin/user-audit', { method: 'GET' }, token)) as AdminUserAuditOverview;
}

export async function getAdminUserAuditDetail(token: string, userId: string, limit = 25, offset = 0) {
  return (await apiFetch(
    `/admin/users/${encodeURIComponent(userId)}/audit?limit=${limit}&offset=${offset}`,
    { method: 'GET' },
    token
  )) as AdminUserAuditDetail;
}

export async function adminUnlockUserLogin(token: string, userId: string) {
  return (await apiFetch(
    `/admin/users/${encodeURIComponent(userId)}/login-restrictions/unlock`,
    { method: 'POST' },
    token
  )) as { ok: boolean; loginRestriction: AdminLoginRestriction };
}

export async function adminCreateUser(token: string, params: { email: string; password: string; role: 'admin' | 'user' }) {
  return (await apiFetch('/admin/users', { method: 'POST', body: JSON.stringify(params) }, token)) as {
    ok: boolean;
    user: { id: string; email: string; role: string };
  };
}

export async function adminDeleteUser(token: string, userId: string) {
  return (await apiFetch(`/admin/users/${encodeURIComponent(userId)}`, { method: 'DELETE' }, token)) as { ok: boolean };
}

export async function adminSetUserRole(token: string, userId: string, role: 'admin' | 'user') {
  return (await apiFetch(`/admin/users/${encodeURIComponent(userId)}/role`, { method: 'PUT', body: JSON.stringify({ role }) }, token)) as { ok: boolean };
}

export async function adminResetPassword(token: string, userId: string, password: string) {
  return (await apiFetch(`/admin/users/${encodeURIComponent(userId)}/reset-password`, { method: 'POST', body: JSON.stringify({ password }) }, token)) as {
    ok: boolean;
  };
}

export async function adminForceLogout(token: string, userId: string) {
  return (await apiFetch(`/admin/users/${encodeURIComponent(userId)}/force-logout`, { method: 'POST' }, token)) as { ok: boolean };
}

export async function getUserLibraries(token: string, userId: string) {
  return (await apiFetch(`/admin/users/${encodeURIComponent(userId)}/libraries`, { method: 'GET' }, token)) as { ok: boolean; libraryIds: number[] };
}

export async function setUserLibraries(token: string, userId: string, libraryIds: number[]) {
  return (await apiFetch(`/admin/users/${encodeURIComponent(userId)}/libraries`, { method: 'PUT', body: JSON.stringify({ libraryIds }) }, token)) as {
    ok: boolean;
  };
}

export type Playlist = {
  id: string;
  name: string;
  created_at: string;
  shared_at: string | null;
  item_count: number;
  owner: SocialUser;
  is_owner: boolean;
  is_collaborative: boolean;
  collaborator_count: number;
};

export type PlaylistCollaborator = {
  user: SocialUser;
  addedAt: string;
};

export type PlaylistCollaboration = {
  ok: true;
  owner: SocialUser;
  isOwner: boolean;
  collaborators: PlaylistCollaborator[];
  eligibleFriends: SocialUser[];
};

export async function listPlaylists(token: string) {
  return (await apiFetch('/playlists', { method: 'GET' }, token)) as { ok: boolean; playlists: Playlist[] };
}

export async function createPlaylist(token: string, name: string) {
  return (await apiFetch('/playlists', { method: 'POST', body: JSON.stringify({ name }) }, token)) as {
    ok: boolean;
    playlist: { id: string; name: string; created_at: string; item_count: number };
  };
}

export async function getPlaylistItems(token: string, playlistId: string) {
  return (await apiFetch(`/playlists/${encodeURIComponent(playlistId)}/items`, { method: 'GET' }, token)) as { ok: boolean; items: any[] };
}

export async function addTrackToPlaylist(token: string, playlistId: string, trackId: number) {
  return (await apiFetch(`/playlists/${encodeURIComponent(playlistId)}/items`, { method: 'POST', body: JSON.stringify({ trackId }) }, token)) as {
    ok: boolean;
    position: number;
  };
}

export async function addTracksToPlaylist(token: string, playlistId: string, trackIds: number[]) {
  // API accepts one track at a time; send sequentially to preserve order.
  let count = 0;
  for (const id of trackIds) {
    await addTrackToPlaylist(token, playlistId, id);
    count++;
  }
  return { ok: true, count };
}

export async function browseArtistTracks(token: string, artistId: number) {
  return (await apiFetch(`/browse/artist/${artistId}/tracks`, { method: 'GET' }, token)) as {
    ok: boolean;
    tracks: Array<{
      id: number;
      title: string | null;
      artist: string | null;
      album: string | null;
      duration_ms: number | null;
      disc_number?: number | null;
      track_number?: number | null;
    }>;
  };
}

export async function removeTrackFromPlaylist(token: string, playlistId: string, trackId: number) {
  return (await apiFetch(`/playlists/${encodeURIComponent(playlistId)}/items/${trackId}`, { method: 'DELETE' }, token)) as { ok: boolean };
}

export async function setPlaylistItemPosition(token: string, playlistId: string, trackId: number, position: number) {
  return (await apiFetch(`/playlists/${encodeURIComponent(playlistId)}/items/${trackId}`, { method: 'PUT', body: JSON.stringify({ position }) }, token)) as {
    ok: boolean;
  };
}

export async function getPlaylistCollaborators(token: string, playlistId: string) {
  return (await apiFetch(
    `/playlists/${encodeURIComponent(playlistId)}/collaborators`,
    { method: 'GET' },
    token
  )) as PlaylistCollaboration;
}

export async function addPlaylistCollaborator(token: string, playlistId: string, userId: string) {
  return (await apiFetch(
    `/playlists/${encodeURIComponent(playlistId)}/collaborators`,
    { method: 'POST', body: JSON.stringify({ userId }) },
    token
  )) as { ok: true; collaborator: PlaylistCollaborator };
}

export async function removePlaylistCollaborator(token: string, playlistId: string, userId: string) {
  return (await apiFetch(
    `/playlists/${encodeURIComponent(playlistId)}/collaborators/${encodeURIComponent(userId)}`,
    { method: 'DELETE' },
    token
  )) as { ok: true };
}

export async function addFavorite(token: string, trackId: number) {
  return (await apiFetch(`/favorites/${trackId}`, { method: 'POST' }, token)) as { ok: boolean };
}

export async function removeFavorite(token: string, trackId: number) {
  return (await apiFetch(`/favorites/${trackId}`, { method: 'DELETE' }, token)) as { ok: boolean };
}

export async function listFavorites(token: string, limit = 100, offset = 0) {
  return (await apiFetch(`/favorites?limit=${limit}&offset=${offset}`, { method: 'GET' }, token)) as {
    ok: boolean;
    tracks: Array<{ id: number; path: string; ext: string; title: string | null; artist: string | null; album: string | null; duration_ms: number | null; added_at: string }>;
    limit: number;
    offset: number;
  };
}

export type SocialUser = {
  id: string;
  email: string;
  avatarPath: string | null;
};

export type SocialRelationship = {
  relationshipId: number;
  user: SocialUser;
  createdAt: string;
  respondedAt: string | null;
};

export type SocialSummary = {
  ok: true;
  friends: SocialRelationship[];
  incoming: SocialRelationship[];
  outgoing: SocialRelationship[];
  unreadShares: number;
};

export type TrackShare = {
  id: number;
  track: {
    id: number;
    title: string | null;
    artist: string | null;
    display_artist?: string | null;
    album: string | null;
    durationMs: number | null;
    artPath: string | null;
    artHash: string | null;
  };
  sender: SocialUser;
  message: string | null;
  createdAt: string;
  readAt: string | null;
};

export async function getSocialSummary(token: string) {
  return (await apiFetch('/social/summary', { method: 'GET' }, token)) as SocialSummary;
}

export async function searchSocialUsers(token: string, query: string) {
  return (await apiFetch(`/social/users?q=${encodeURIComponent(query)}`, { method: 'GET' }, token)) as {
    ok: true;
    users: Array<SocialUser & {
      relationshipId: number | null;
      relationship: 'none' | 'incoming' | 'outgoing' | 'friend';
    }>;
  };
}

export async function sendFriendRequest(token: string, userId: string) {
  return (await apiFetch('/social/friend-requests', {
    method: 'POST',
    body: JSON.stringify({ userId }),
  }, token)) as { ok: true; request: SocialRelationship };
}

export async function acceptFriendRequest(token: string, relationshipId: number) {
  return (await apiFetch(`/social/friend-requests/${relationshipId}/accept`, { method: 'POST' }, token)) as { ok: true };
}

export async function removeFriendRequest(token: string, relationshipId: number) {
  return (await apiFetch(`/social/friend-requests/${relationshipId}`, { method: 'DELETE' }, token)) as { ok: true };
}

export async function removeFriend(token: string, userId: string) {
  return (await apiFetch(`/social/friends/${encodeURIComponent(userId)}`, { method: 'DELETE' }, token)) as { ok: true };
}

export async function getShareTargets(token: string, trackId: number) {
  return (await apiFetch(`/social/share-targets/${trackId}`, { method: 'GET' }, token)) as {
    ok: true;
    friends: Array<SocialUser & { canAccess: boolean }>;
  };
}

export async function shareTrack(token: string, trackId: number, recipientIds: string[], message?: string) {
  return (await apiFetch('/social/shares', {
    method: 'POST',
    body: JSON.stringify({ trackId, recipientIds, message }),
  }, token)) as { ok: true; shared: number };
}

export async function listTrackShares(token: string, limit = 50, offset = 0) {
  return (await apiFetch(`/social/shares?limit=${limit}&offset=${offset}`, { method: 'GET' }, token)) as {
    ok: true;
    shares: TrackShare[];
    total: number;
    unread: number;
    limit: number;
    offset: number;
  };
}

export async function markTrackShareRead(token: string, shareId: number) {
  return (await apiFetch(`/social/shares/${shareId}/read`, { method: 'POST' }, token)) as { ok: true };
}

export async function markAllTrackSharesRead(token: string) {
  return (await apiFetch('/social/shares/read-all', { method: 'POST' }, token)) as { ok: true; updated: number };
}

export async function deleteTrackShare(token: string, shareId: number) {
  return (await apiFetch(`/social/shares/${shareId}`, { method: 'DELETE' }, token)) as { ok: true };
}

export async function browseArtists(token: string, limit = 50, offset = 0, sort: 'az' | 'tracks_desc' | 'albums_desc' = 'az', q?: string) {
  const url = `/browse/artists?limit=${limit}&offset=${offset}&sort=${sort}${q ? `&q=${encodeURIComponent(q)}` : ''}`;
  return (await apiFetch(url, { method: 'GET' }, token)) as {
    ok: boolean;
    artists: Array<{ id: number; name: string; track_count: number; album_count: number }>;
    total: number;
    limit: number;
    offset: number;
  };
}

export async function browseArtistById(token: string, id: number) {
  return (await apiFetch(`/browse/artist/${id}`, { method: 'GET' }, token)) as {
    ok: boolean;
    artist: { id: number; name: string; art_path: string | null; art_hash: string | null };
    albums: Array<{ album: string; display_artist: string; track_count: number; art_path: string | null; art_hash: string | null }>;
    appearsOn: Array<{ album: string; album_artist: string; track_count: number; art_path: string | null; art_hash: string | null }>;
  };
}

export async function browseArtist(token: string, name: string) {
  return (await apiFetch(`/browse/artist?name=${encodeURIComponent(name)}`, { method: 'GET' }, token)) as {
    ok: boolean;
    artist: string;
    albums: Array<{ album: string; track_count: number }>;
    appearsOn?: Array<{ album: string; track_count: number }>;
    tracks: Array<{ id: string; title: string | null; artist: string | null; album: string | null; duration_ms: number | null }>;
  };
}

export async function browseAlbums(token: string, limit = 50, offset = 0, sort: 'az' | 'tracks_desc' | 'recent' = 'az', artistId?: number, q?: string) {
  const url = `/browse/albums?limit=${limit}&offset=${offset}&sort=${sort}${artistId ? `&artistId=${artistId}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`;
  return (await apiFetch(url, { method: 'GET' }, token)) as {
    ok: boolean;
    albums: Array<{ display_artist: string; album: string; track_count: number; art_path: string | null; art_hash: string | null }>;
    total: number;
    limit: number;
    offset: number;
  };
}

export async function browseGenres(token: string, limit = 50, offset = 0, sort: 'az' | 'tracks_desc' = 'az', q?: string) {
  const url = `/browse/genres?limit=${limit}&offset=${offset}&sort=${sort}${q ? `&q=${encodeURIComponent(q)}` : ''}`;
  return (await apiFetch(url, { method: 'GET' }, token)) as {
    ok: boolean;
    genres: Array<{ genre: string; track_count: number; artist_count: number }>;
    total: number;
    limit: number;
    offset: number;
  };
}

export async function browseGenreTracks(token: string, genre: string, limit = 50, offset = 0) {
  return (await apiFetch(`/browse/genre/${encodeURIComponent(genre)}/tracks?limit=${limit}&offset=${offset}`, { method: 'GET' }, token)) as {
    ok: boolean;
    genre: string;
    tracks: Array<{
      id: number;
      title: string | null;
      artist: string | null;
      album_artist: string | null;
      album: string | null;
      duration_ms: number | null;
      art_path: string | null;
      artists: Array<{ id: number; name: string }>;
    }>;
    limit: number;
    offset: number;
  };
}

export async function browseCountries(token: string) {
  return (await apiFetch('/browse/countries', { method: 'GET' }, token)) as {
    ok: boolean;
    countries: Array<{ country: string; track_count: number; artist_count: number }>;
  };
}

export async function browseCountryTracks(token: string, country: string, limit = 50, offset = 0) {
  return (await apiFetch(`/browse/country/${encodeURIComponent(country)}/tracks?limit=${limit}&offset=${offset}`, { method: 'GET' }, token)) as {
    ok: boolean;
    country: string;
    tracks: Array<{
      id: number;
      title: string | null;
      artist: string | null;
      album_artist: string | null;
      album: string | null;
      duration_ms: number | null;
      art_path: string | null;
      artists: Array<{ id: number; name: string }>;
    }>;
    limit: number;
    offset: number;
  };
}

export async function browseLanguages(token: string) {
  return (await apiFetch('/browse/languages', { method: 'GET' }, token)) as {
    ok: boolean;
    languages: Array<{ language: string; track_count: number; artist_count: number }>;
  };
}

export async function browseLanguageTracks(token: string, language: string, limit = 50, offset = 0) {
  return (await apiFetch(`/browse/language/${encodeURIComponent(language)}/tracks?limit=${limit}&offset=${offset}`, { method: 'GET' }, token)) as {
    ok: boolean;
    language: string;
    tracks: Array<{
      id: number;
      title: string | null;
      artist: string | null;
      album_artist: string | null;
      album: string | null;
      duration_ms: number | null;
      art_path: string | null;
      artists: Array<{ id: number; name: string }>;
    }>;
    limit: number;
    offset: number;
  };
}

export async function listHistory(token: string, limit = 100, offset = 0) {
  return (await apiFetch(`/history?limit=${limit}&offset=${offset}`, { method: 'GET' }, token)) as {
    ok: boolean;
    tracks: Array<{ id: number; path: string; ext: string; title: string | null; artist: string | null; album: string | null; duration_ms: number | null; played_at: string }>;
    limit: number;
    offset: number;
  };
}

export type PlaybackSignal = {
  currentMs?: number;
  durationMs?: number;
  listenedMs?: number;
  completionPct?: number;
  slateId?: string;
  bucketKey?: string;
};

export async function recordPlay(token: string, trackId: number, signal?: PlaybackSignal) {
  return (await apiFetch(`/history/${trackId}`, {
    method: 'POST',
    body: signal ? JSON.stringify(signal) : undefined,
  }, token)) as { ok: boolean };
}

export async function recordSkip(token: string, trackId: number, pct: number, signal?: PlaybackSignal) {
  return (await apiFetch(`/stats/skip/${trackId}`, {
    method: 'POST',
    body: JSON.stringify({ pct, completionPct: pct, ...signal }),
  }, token)) as { ok: boolean };
}

export async function recordPartialListen(token: string, trackId: number, signal: PlaybackSignal) {
  return (await apiFetch(`/stats/listen/${trackId}`, {
    method: 'POST',
    body: JSON.stringify(signal),
  }, token)) as { ok: boolean };
}

export async function browseAlbum(token: string, artist: string | null | undefined, album: string, artistId?: number) {
  let url = `/browse/album?album=${encodeURIComponent(album)}`;
  if (artist) url += `&artist=${encodeURIComponent(artist)}`;
  if (artistId) url += `&artistId=${artistId}`;
  return (await apiFetch(url, { method: 'GET' }, token)) as {
    ok: boolean;
    album: {
      name: string;
      artist: string;
      art_path: string | null;
      art_hash: string | null;
      track_count: number;
      total_discs?: number;
    };
    tracks: Array<{
      id: number;
      title: string | null;
      artist: string | null;
      album_artist: string | null;
      album: string | null;
      duration_ms: number | null;
      art_path: string | null;
      path?: string;
      genre?: string | null;
      country?: string | null;
      language?: string | null;
      year?: number | null;
      artists: Array<{ id: number; name: string }>;
      discNumber?: number | null;
      trackNumber?: number | null;
    }>;
  };
}

export async function getRecommendations(token: string) {
  return (await apiFetch('/recommendations', { method: 'GET' }, token)) as {
    ok: boolean;
    generatedAt?: string;
    slateId?: string;
    _cached?: boolean;
    _stale?: boolean;
    _refreshing?: boolean;
    hiddenMixCount?: number;
    recommendationProfile?: 'new' | 'learning' | 'personalized';
    buckets: Array<{
      key: string;
      name: string;
      subtitle?: string;
      reason?: string;
      count: number;
      tracks: Array<{
        id: number;
        title: string;
        artist: string;
        album: string | null;
        art_path: string | null;
        art_hash: string | null;
        duration_ms: number | null;
      }>;
      art_paths: string[];
      art_hashes: string[];
    }>;
  };
}

export type RecommendationFeedbackAction =
  | 'more_like_this'
  | 'not_for_me'
  | 'less_like_artist'
  | 'hide_bucket';

export async function sendRecommendationFeedback(
  token: string,
  feedback: {
    action: RecommendationFeedbackAction;
    trackId?: number;
    artist?: string | null;
    bucketKey?: string;
  },
) {
  return (await apiFetch('/recommendations/feedback', {
    method: 'POST',
    body: JSON.stringify(feedback),
  }, token)) as {
    ok: boolean;
    action: RecommendationFeedbackAction;
    subjectType: 'track' | 'artist' | 'bucket';
    subjectKey: string;
    preference: number;
    hiddenMixCount?: number;
  };
}

export type RecommendationPreference = {
  subject_type: 'track' | 'artist' | 'bucket';
  subject_key: string;
  preference: number;
  updated_at: string;
};

export async function getRecommendationFeedback(token: string) {
  return (await apiFetch('/recommendations/feedback', { method: 'GET' }, token)) as {
    ok: boolean;
    preferences: RecommendationPreference[];
  };
}

export async function clearAllRecommendationFeedback(token: string) {
  return (await apiFetch('/recommendations/feedback/all', { method: 'DELETE' }, token)) as {
    ok: boolean;
    removed: number;
  };
}

export async function clearHiddenRecommendationBuckets(token: string) {
  return (await apiFetch('/recommendations/feedback/hidden-buckets', { method: 'DELETE' }, token)) as {
    ok: boolean;
    removed: number;
  };
}

export async function requestHlsTranscode(token: string, trackId: number) {
  return (await apiFetch(`/hls/${trackId}/request`, { method: 'POST' }, token)) as {
    ok: boolean;
    state: 'queued' | 'running' | 'done' | 'failed';
    jobId: string | number;
    ready: boolean;
    manifestUrl?: string | null;
  };
}

export async function getHlsStatus(token: string, trackId: number) {
  return (await apiFetch(`/hls/${trackId}/status`, { method: 'GET' }, token)) as {
    ok: boolean;
    state: 'missing' | 'queued' | 'running' | 'done' | 'failed';
    jobId?: string | number;
    ready: boolean;
    error?: string | null;
    manifestUrl?: string | null;
  };
}

export async function getLibraryStats(token: string) {
  return (await apiFetch('/admin/library/stats', { method: 'GET' }, token)) as {
    ok: boolean;
    stats: {
      tracks: number;
      artists: number;
      albums: number;
      genres: number;
      countries: number;
      languages: number;
      libraries: number;
      totalBytes: string;
      totalSize: string;
      topGenres: Array<{ genre: string; track_count: number }>;
      topCountries: Array<{ country: string; track_count: number }>;
    };
  };
}

export async function getLibraryActivity(token: string, limit = 50, offset = 0) {
  return (await apiFetch(`/admin/library/activity?limit=${limit}&offset=${offset}`, { method: 'GET' }, token)) as {
    ok: boolean;
    activity: Array<{
      id: number;
      action: string;
      details: any;
      created_at: string;
    }>;
    limit: number;
    offset: number;
  };
}

// Smart Playlists API
export type SmartPlaylist = {
  id: number;
  name: string;
  sort: string;
  filters: SmartFilters;
  created: string;
  updated: string;
  type: 'smart';
};

export type SmartFilters = {
  include: {
    artists: number[];
    artistsMode: 'any' | 'all';
    albums: string[];
    genres: string[];
    genresMode: 'any' | 'all';
    years: number[];
    countries: string[];
    languages: string[];
  };
  exclude: {
    artists: number[];
    albums: string[];
    genres: string[];
    years: number[];
    countries: string[];
    languages: string[];
  };
  duration: {
    min: number | null;
    max: number | null;
  };
  bpm: {
    min: number | null;
    max: number | null;
  };
  dateAdded: {
    from: string | null;
    to: string | null;
  };
  favoriteOnly: boolean;
  maxResults: number | null;
};

export async function listSmartPlaylists(token: string) {
  return (await apiFetch('/smart-playlists', { method: 'GET' }, token)) as {
    ok: boolean;
    items: SmartPlaylist[];
  };
}

export async function createSmartPlaylist(token: string, name: string, sort: string, filters: Partial<SmartFilters>) {
  return (await apiFetch('/smart-playlists', {
    method: 'POST',
    body: JSON.stringify({ name, sort, filters })
  }, token)) as SmartPlaylist & { ok: boolean };
}

export async function getSmartPlaylist(token: string, id: number, sort?: string, limit?: number) {
  const params = new URLSearchParams();
  if (sort) params.set('sort', sort);
  if (limit) params.set('limit', String(limit));
  const qs = params.toString() ? `?${params.toString()}` : '';
  return (await apiFetch(`/smart-playlists/${id}${qs}`, { method: 'GET' }, token)) as SmartPlaylist & {
    ok: boolean;
    trackCount: number;
    duration: number;
    truncated: boolean;
    tracks: Array<{
      id: number;
      title: string;
      artist: string;
      album: string;
      duration: number | null;
      art_path: string | null;
      art_hash: string | null;
    }>;
  };
}

export async function updateSmartPlaylist(token: string, id: number, name: string, sort: string, filters: Partial<SmartFilters>) {
  return (await apiFetch(`/smart-playlists/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ name, sort, filters })
  }, token)) as SmartPlaylist & { ok: boolean };
}

export async function deleteSmartPlaylist(token: string, id: number) {
  return (await apiFetch(`/smart-playlists/${id}`, { method: 'DELETE' }, token)) as { ok: boolean; deleted: number };
}

export async function convertSmartPlaylist(
  token: string,
  id: number,
  opts?: { name?: string; deleteSmart?: boolean }
) {
  return (await apiFetch(`/smart-playlists/${id}/convert`, {
    method: 'POST',
    body: JSON.stringify({ name: opts?.name, delete: opts?.deleteSmart === true })
  }, token)) as { ok: boolean; id: number; name: string; item_count: number; deleted_smart: number | null };
}

export async function deletePlaylist(token: string, id: number) {
  return (await apiFetch(`/playlists/${id}`, { method: 'DELETE' }, token)) as { ok: boolean; deleted: number };
}

export async function renamePlaylist(token: string, id: number, name: string) {
  return (await apiFetch(`/playlists/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name })
  }, token)) as { ok: boolean; playlist?: { id: number; name: string; item_count: number } };
}

export async function suggestSmartPlaylist(token: string, kind: string, q: string, ids?: number[]) {
  const params = new URLSearchParams({ kind, q });
  if (ids && ids.length > 0) params.set('ids', ids.join(','));
  return (await apiFetch(`/smart-playlists/suggest?${params.toString()}`, { method: 'GET' }, token)) as {
    items: Array<{ id?: number; name?: string } | string>;
  };
}

// ListenBrainz API
export async function getListenBrainzSettings(token: string) {
  return (await apiFetch('/listenbrainz/settings', { method: 'GET' }, token)) as {
    ok: boolean;
    connected: boolean;
    username: string | null;
  };
}

export async function connectListenBrainz(token: string, lbToken: string) {
  return (await apiFetch('/listenbrainz/connect', {
    method: 'POST',
    body: JSON.stringify({ token: lbToken })
  }, token)) as { ok: boolean; username?: string; error?: string };
}

export async function disconnectListenBrainz(token: string) {
  return (await apiFetch('/listenbrainz/disconnect', { method: 'POST' }, token)) as { ok: boolean };
}

// Subsonic/OpenSubsonic API credentials
export async function getSubsonicSettings(token: string) {
  return (await apiFetch('/subsonic/settings', { method: 'GET' }, token)) as {
    ok: boolean;
    username: string;
    configured: boolean;
    authType: 'google' | 'local';
  };
}

export async function setSubsonicPassword(token: string, password: string) {
  return (await apiFetch('/subsonic/password', {
    method: 'PUT',
    body: JSON.stringify({ password })
  }, token)) as { ok: boolean };
}

export async function clearSubsonicPassword(token: string) {
  return (await apiFetch('/subsonic/password', { method: 'DELETE' }, token)) as { ok: boolean };
}

export async function getListenBrainzRecommendations(token: string) {
  return (await apiFetch('/listenbrainz/recommendations', { method: 'GET' }, token)) as {
    ok: boolean;
    connected: boolean;
    username?: string;
    recommendations: Array<{
      mbid: string;
      title: string;
      artist: string;
      score: number;
      localTrack?: { id: number; title: string; artist: string; album: string | null };
    }>;
  };
}

export async function scrobbleToListenBrainz(token: string, trackId: number, listenedAt?: number) {
  return (await apiFetch('/listenbrainz/scrobble', {
    method: 'POST',
    body: JSON.stringify({ trackId, listenedAt })
  }, token)) as { ok: boolean; scrobbled: boolean; reason?: string };
}

export async function nowPlayingListenBrainz(token: string, trackId: number) {
  return (await apiFetch('/listenbrainz/now-playing', {
    method: 'POST',
    body: JSON.stringify({ trackId })
  }, token)) as { ok: boolean; submitted: boolean };
}

// Prefetch lyrics for a track (fire and forget)
export async function prefetchLyrics(token: string, trackId: number) {
  return (await apiFetch(`/library/tracks/${trackId}/lyrics/prefetch`, {
    method: 'POST'
  }, token)) as { ok: boolean };
}

// Scan progress
export type ScanProgress = {
  ok: boolean;
  status: 'idle' | 'scanning' | 'indexing' | 'error' | 'unknown';
  mountPath?: string;
  libraryIndex?: number;
  libraryTotal?: number;
  filesFound: number;
  filesProcessed: number;
  currentFile?: string;
  error?: string;
  failedFiles?: number;
  queueSize?: number;
  startedAt?: number;
};

export async function getScanProgress(token: string) {
  return (await apiFetch('/scan/progress', { method: 'GET' }, token)) as ScanProgress;
}

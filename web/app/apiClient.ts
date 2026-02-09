export const API_BASE = '/api';

export type LoginResponse = { ok: true; token: string; user: { id: string; email: string; role: string } };

export async function apiFetch(path: string, init: RequestInit = {}, token?: string) {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type') && init.body) headers.set('content-type', 'application/json');
  if (token && token !== 'cookie') headers.set('authorization', `Bearer ${token}`);
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
    libraries: Array<{ id: number; mount_path: string; writable: boolean }>;
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
    libraries: Array<{ id: number | string; mount_path: string; mounted?: boolean; writable?: boolean; read_only?: boolean }>;
  };
  return { ok: r.ok, libraries: r.libraries.map((l) => ({ ...l, id: Number(l.id) })) };
}

export async function adminDeleteLibrary(token: string, libraryId: number, opts?: { force?: boolean }) {
  const qs = opts?.force ? '?force=true' : '';
  return (await apiFetch(`/admin/libraries/${libraryId}${qs}`, { method: 'DELETE' }, token)) as { ok: boolean };
}

export async function listAdminUsers(token: string) {
  return (await apiFetch('/admin/users', { method: 'GET' }, token)) as { ok: boolean; users: Array<{ id: string; email: string; role: string }> };
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

export async function listPlaylists(token: string) {
  return (await apiFetch('/playlists', { method: 'GET' }, token)) as { ok: boolean; playlists: Array<{ id: string; name: string; created_at: string }> };
}

export async function createPlaylist(token: string, name: string) {
  return (await apiFetch('/playlists', { method: 'POST', body: JSON.stringify({ name }) }, token)) as {
    ok: boolean;
    playlist: { id: string; name: string; created_at: string };
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

export async function removeTrackFromPlaylist(token: string, playlistId: string, trackId: number) {
  return (await apiFetch(`/playlists/${encodeURIComponent(playlistId)}/items/${trackId}`, { method: 'DELETE' }, token)) as { ok: boolean };
}

export async function setPlaylistItemPosition(token: string, playlistId: string, trackId: number, position: number) {
  return (await apiFetch(`/playlists/${encodeURIComponent(playlistId)}/items/${trackId}`, { method: 'PUT', body: JSON.stringify({ position }) }, token)) as {
    ok: boolean;
  };
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

export async function recordPlay(token: string, trackId: number) {
  return (await apiFetch(`/history/${trackId}`, { method: 'POST' }, token)) as { ok: boolean };
}

export async function recordSkip(token: string, trackId: number, pct: number) {
  return (await apiFetch(`/stats/skip/${trackId}`, { method: 'POST', body: JSON.stringify({ pct }) }, token)) as { ok: boolean };
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
    buckets: Array<{
      name: string;
      count: number;
      tracks: Array<{ id: number; title: string; artist: string }>;
      art_paths: string[];
      art_hashes: string[];
    }>;
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
  };
  exclude: {
    artists: number[];
    albums: string[];
    genres: string[];
    years: number[];
    countries: string[];
  };
  duration: {
    min: number | null;
    max: number | null;
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
  status: 'idle' | 'scanning' | 'indexing' | 'unknown';
  mountPath?: string;
  libraryIndex?: number;
  libraryTotal?: number;
  filesFound: number;
  filesProcessed: number;
  currentFile?: string;
  queueSize?: number;
  startedAt?: number;
};

export async function getScanProgress(token: string) {
  return (await apiFetch('/scan/progress', { method: 'GET' }, token)) as ScanProgress;
}

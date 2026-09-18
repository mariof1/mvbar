'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  API_BASE,
  apiFetch,
  installBundledAdminPlugin,
  listAdminPlugins,
  setAdminPluginEnabled,
  type AdminPlugin,
  type BundledAdminPlugin,
} from './apiClient';
import { useAuth } from './store';
import { formatCount } from './format';
import { useToastStore } from './Toast';
import { useMissingMusicUpdates } from './useWebSocket';
import { showConfirm } from './ConfirmModal';

type Artist = {
  name: string;
  deezerId: string | null;
  deezerName?: string | null;
  musicBrainzId?: string | null;
  musicBrainzName?: string | null;
  matchSource?: 'saved' | null;
  albumCount: number;
  trackCount: number;
};

type ArtistMatch = {
  id: string;
  name: string;
  sortName: string | null;
  disambiguation: string | null;
  country: string | null;
  type: string | null;
  score: number | null;
  cover?: string | null;
  link?: string | null;
  source?: 'deezer';
};

type MissingMusicStatus = {
  enabled: boolean;
  providerConfigured: boolean;
  deezerConfigured: boolean;
  deezerConfigurationError?: string | null;
  deezerStagingDirectory: string | null;
  mode: 'provider' | 'wanted-list';
  requireAdminApproval: boolean;
  autoDownloadDeezer: boolean;
  localArtistCount: number;
  taggedArtistCount: number;
};

type ReleaseGroup = {
  id: string;
  title: string;
  primaryType: string | null;
  secondaryTypes: string[];
  firstReleaseDate: string | null;
  cover?: string | null;
  trackCount?: number;
  present: boolean;
  partial?: boolean;
  localAlbum?: string | null;
  localTrackCount?: number;
  missingTrackCount?: number | null;
  matchConfidence?: number;
};

type CatalogTrack = {
  id?: string;
  recordingId: string | null;
  title: string;
  discNumber: number;
  trackNumber: number | null;
  number: string | null;
  durationMs: number | null;
  isrc?: string | null;
  missing: boolean;
  matchConfidence?: number;
  matchReason?: string | null;
  localTrackId?: number | string | null;
};

type RequestItem = {
  id: string;
  userId: string;
  userEmail: string | null;
  itemType: 'album' | 'track';
  artist: string;
  title: string;
  album: string | null;
  musicBrainzArtistId: string | null;
  musicBrainzReleaseGroupId: string | null;
  musicBrainzReleaseId: string | null;
  musicBrainzRecordingId: string | null;
  deezerArtistId: string | null;
  deezerAlbumId: string | null;
  deezerTrackId: string | null;
  requestedIsrc: string | null;
  status: 'requested' | 'approved' | 'submitted' | 'completed' | 'failed' | 'rejected' | 'cancelled';
  providerRequestId: string | null;
  error: string | null;
  deezer: { state: string | null; filename: string | null; trackId: string | null; albumId: string | null; trackCount: number | null; completed: number | null; total: number | null; phase: string | null; usedLocalAlbumMetadata?: boolean } | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

type DeezerCandidate = {
  id: string;
  title: string;
  artist: string;
  album?: string;
  durationMs?: number | null;
  trackCount?: number;
  releaseDate?: string | null;
  cover?: string | null;
  link: string | null;
  score: number;
};

type PluginUpdate = {
  available: BundledAdminPlugin;
  installed: AdminPlugin;
};

type ExistingAlbumMetadata = { album: string; album_artist: string | null; year: number | null; genre: string | null; country: string | null; language: string | null };

function messageForError(error: unknown) {
  const value = error as { data?: { error?: string }; message?: string };
  return value?.data?.error || value?.message || 'Request failed';
}

function formatDuration(durationMs: number | null) {
  if (!durationMs) return '';
  const seconds = Math.round(durationMs / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function statusClasses(status: RequestItem['status']) {
  if (status === 'completed') return 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300';
  if (status === 'failed' || status === 'rejected') return 'border-red-400/30 bg-red-400/10 text-red-300';
  if (status === 'submitted') return 'border-cyan-400/30 bg-cyan-400/10 text-cyan-300';
  return 'border-amber-400/30 bg-amber-400/10 text-amber-300';
}

function statusLabel(status: RequestItem['status'], providerConfigured: boolean) {
  if (status === 'requested') return 'Waiting for approval';
  if (status === 'approved') return providerConfigured ? 'Ready for provider' : 'On wanted list';
  if (status === 'submitted') return 'With provider';
  if (status === 'completed') return 'Fulfilled';
  if (status === 'failed') return 'Needs attention';
  if (status === 'rejected') return 'Declined';
  return 'Cancelled';
}

function Spinner() {
  return <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/20 border-t-white/80" />;
}

export function MissingMusic({ initialArtist }: { initialArtist?: { id: string; name: string } }) {
  const token = useAuth((state) => state.token);
  const user = useAuth((state) => state.user);
  const isAdmin = user?.role === 'admin';
  const showToast = useToastStore((state) => state.show);
  const liveUpdate = useMissingMusicUpdates((state) => state.lastUpdate);
  const [view, setView] = useState<'discover' | 'requests'>('discover');
  const [query, setQuery] = useState('');
  const [artists, setArtists] = useState<Artist[]>([]);
  const [catalogArtists, setCatalogArtists] = useState<ArtistMatch[]>([]);
  const [catalogSearching, setCatalogSearching] = useState(false);
  const [catalogSearched, setCatalogSearched] = useState(false);
  const [artist, setArtist] = useState<Artist | null>(null);
  const [artistMatches, setArtistMatches] = useState<ArtistMatch[]>([]);
  const [catalog, setCatalog] = useState<ReleaseGroup[]>([]);
  const [catalogFilter, setCatalogFilter] = useState<'missing' | 'all' | 'present'>('missing');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [tracks, setTracks] = useState<Record<string, { releaseId: string; tracks: CatalogTrack[] }>>({});
  const [requests, setRequests] = useState<RequestItem[]>([]);
  const [requestsLoading, setRequestsLoading] = useState(true);
  const [requestFilter, setRequestFilter] = useState<'all' | 'action' | 'progress' | 'staged' | 'history'>('all');
  const [requestSearch, setRequestSearch] = useState('');
  const [deezerOpen, setDeezerOpen] = useState<string | null>(null);
  const [deezerCandidates, setDeezerCandidates] = useState<Record<string, DeezerCandidate[]>>({});
  const [localAlbumMetadata, setLocalAlbumMetadata] = useState<Record<string, ExistingAlbumMetadata | null>>({});
  const [reuseAlbumMetadata, setReuseAlbumMetadata] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [artistsLoading, setArtistsLoading] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState<MissingMusicStatus | null>(null);
  const [pluginUpdate, setPluginUpdate] = useState<PluginUpdate | null>(null);
  const [updatingPlugin, setUpdatingPlugin] = useState(false);
  const [updateNeedsReview, setUpdateNeedsReview] = useState(false);
  const catalogRequestId = useRef(0);
  const artistMatchRequestId = useRef(0);
  const artistSearchRequestId = useRef(0);
  const localSearchRequestId = useRef(0);
  const requestsRequestId = useRef(0);
  const deezerLookupId = useRef(0);

  const loadArtists = useCallback(async (search = '') => {
    if (!token) return;
    const requestId = ++localSearchRequestId.current;
    setArtistsLoading(true);
    setError('');
    try {
      const data = await apiFetch(`/plugins/missing-music/artists?q=${encodeURIComponent(search)}`, {}, token) as { artists: Artist[] };
      if (requestId === localSearchRequestId.current) setArtists(data.artists);
    } catch (cause) {
      if (requestId === localSearchRequestId.current) setError(messageForError(cause));
    } finally {
      if (requestId === localSearchRequestId.current) setArtistsLoading(false);
    }
  }, [token]);

  const loadRequests = useCallback(async () => {
    if (!token) return;
    const requestId = ++requestsRequestId.current;
    try {
      const data = await apiFetch('/plugins/missing-music/requests', {}, token) as { requests: RequestItem[] };
      if (requestId === requestsRequestId.current) setRequests(data.requests);
    } catch (cause) {
      if (requestId === requestsRequestId.current) setError(messageForError(cause));
    } finally {
      if (requestId === requestsRequestId.current) setRequestsLoading(false);
    }
  }, [token]);

  const loadStatus = useCallback(async () => {
    if (!token) return;
    try {
      setStatus(await apiFetch('/plugins/missing-music/status', {}, token) as MissingMusicStatus);
    } catch {
      setStatus(null);
    }
  }, [token]);

  const loadPluginUpdate = useCallback(async () => {
    if (!token || !isAdmin) {
      setPluginUpdate(null);
      return;
    }
    try {
      const result = await listAdminPlugins(token);
      const available = result.bundledPlugins.find((plugin) => plugin.id === 'mvbar.missing-music');
      const installed = result.plugins.find((plugin) => plugin.id === 'mvbar.missing-music');
      setPluginUpdate(available?.updateAvailable && installed ? { available, installed } : null);
    } catch {
      // Discovery remains usable when the optional public registry is offline.
      setPluginUpdate(null);
    }
  }, [isAdmin, token]);

  useEffect(() => {
    void loadArtists();
    void loadRequests();
    void loadStatus();
    void loadPluginUpdate();
  }, [loadArtists, loadPluginUpdate, loadRequests, loadStatus]);

  useEffect(() => {
    if (liveUpdate) void loadRequests();
  }, [liveUpdate, loadRequests]);

  const updatePlugin = async () => {
    if (!token || !pluginUpdate) return;
    const confirmed = await showConfirm({
      title: 'Update Missing Music?',
      message: `Install official version ${pluginUpdate.available.version} from the MVBar plugin registry? It will remain enabled automatically only when its permissions are unchanged.`,
      confirmLabel: 'Install update',
    });
    if (!confirmed) return;
    setUpdatingPlugin(true);
    setUpdateNeedsReview(false);
    try {
      const result = await installBundledAdminPlugin(token, pluginUpdate.available.key);
      let installed = result.plugin;
      if (
        result.state === 'updated'
        && pluginUpdate.installed.enabled
        && pluginUpdate.installed.permissionFingerprint === installed.permissionFingerprint
      ) {
        installed = (await setAdminPluginEnabled(token, installed, true)).plugin;
      }
      if (!installed.enabled) {
        setUpdateNeedsReview(true);
        showToast('Missing Music updated. Its permissions changed and must be reviewed before it can be enabled again.', 'queue', 'top-right');
      } else {
        showToast(`Missing Music updated to version ${installed.version}`, 'success', 'top-right');
      }
      await Promise.all([loadPluginUpdate(), loadStatus()]);
    } catch (cause) {
      showToast(messageForError(cause), 'error', 'top-right');
    } finally {
      setUpdatingPlugin(false);
    }
  };

  const loadCatalog = useCallback(async (selected: Artist, musicBrainzId: string) => {
    if (!token) return;
    const requestId = ++catalogRequestId.current;
    setCatalog([]);
    setTracks({});
    setExpanded(null);
    setCatalogFilter('missing');
    setLoading(true);
    setError('');
    try {
      const data = await apiFetch(
        `/plugins/missing-music/artists/${musicBrainzId}/catalog?localArtist=${encodeURIComponent(selected.name)}`,
        {},
        token,
      ) as { releaseGroups: ReleaseGroup[] };
      if (requestId === catalogRequestId.current) setCatalog(data.releaseGroups);
    } catch (cause) {
      if (requestId === catalogRequestId.current) setError(messageForError(cause));
    } finally {
      if (requestId === catalogRequestId.current) setLoading(false);
    }
  }, [token]);

  const selectArtist = useCallback(async (selected: Artist) => {
    if (!token) return;
    catalogRequestId.current++;
    const matchRequestId = ++artistMatchRequestId.current;
    setArtist(selected);
    setArtistMatches([]);
    setCatalog([]);
    setTracks({});
    setExpanded(null);
    setError('');
    setLoading(false);
    setBusyKey((current) => current === 'artist-match' ? null : current);
    if (selected.musicBrainzId) {
      await loadCatalog(selected, selected.musicBrainzId);
      return;
    }
    setBusyKey('artist-match');
    try {
      const data = await apiFetch(
        `/plugins/missing-music/artists/matches?q=${encodeURIComponent(selected.name)}`,
        {},
        token,
      ) as { matches: ArtistMatch[] };
      if (matchRequestId === artistMatchRequestId.current) setArtistMatches(data.matches);
    } catch (cause) {
      if (matchRequestId === artistMatchRequestId.current) setError(messageForError(cause));
    } finally {
      if (matchRequestId === artistMatchRequestId.current) setBusyKey((current) => current === 'artist-match' ? null : current);
    }
  }, [loadCatalog, token]);

  const chooseArtistMatch = async (match: ArtistMatch) => {
    if (!artist || !token) return;
    const selected = artist;
    const matchRequestId = artistMatchRequestId.current;
    setBusyKey('artist-match-save');
    setError('');
    try {
      await apiFetch('/plugins/missing-music/artists/match', {
        method: 'PUT',
        body: JSON.stringify({ localArtist: selected.name, musicBrainzId: match.id, musicBrainzName: match.name }),
      }, token);
      if (matchRequestId !== artistMatchRequestId.current) return;
      const matched: Artist = { ...selected, musicBrainzId: match.id, musicBrainzName: match.name, matchSource: 'saved' };
      setArtist(matched);
      setArtistMatches([]);
      setArtists((current) => current.map((item) => item.name === selected.name ? matched : item));
      await loadCatalog(matched, match.id);
    } catch (cause) {
      if (matchRequestId === artistMatchRequestId.current) setError(messageForError(cause));
    } finally {
      setBusyKey((current) => current === 'artist-match-save' ? null : current);
    }
  };

  const inspectTracks = async (group: ReleaseGroup) => {
    if (!token || !artist?.musicBrainzId) return;
    const catalogId = catalogRequestId.current;
    if (expanded === group.id) {
      setExpanded(null);
      return;
    }
    setExpanded(group.id);
    if (tracks[group.id]) return;
    setBusyKey(`tracks:${group.id}`);
    setError('');
    try {
      const data = await apiFetch(
        `/plugins/missing-music/release-groups/${group.id}/tracks?artistMbid=${artist.musicBrainzId}&album=${encodeURIComponent(group.title)}&localArtist=${encodeURIComponent(artist.name)}`,
        {},
        token,
      ) as { releaseId: string; tracks: CatalogTrack[] };
      if (catalogId === catalogRequestId.current) setTracks((current) => ({ ...current, [group.id]: data }));
    } catch (cause) {
      if (catalogId === catalogRequestId.current) {
        setError(messageForError(cause));
        setExpanded(null);
      }
    } finally {
      setBusyKey((current) => current === `tracks:${group.id}` ? null : current);
    }
  };

  const createRequest = async (body: Record<string, unknown>, key: string) => {
    if (!token) return;
    setBusyKey(key);
    setError('');
    try {
      await apiFetch('/plugins/missing-music/requests', { method: 'POST', body: JSON.stringify(body) }, token);
      await loadRequests();
    } catch (cause) {
      const message = messageForError(cause);
      setError(message);
      showToast(message, 'error', 'top-right');
    } finally {
      setBusyKey(null);
    }
  };

  const requestAlbum = (group: ReleaseGroup) => {
    if (!artist) return;
    return createRequest({
      itemType: 'album',
      artist: artist.musicBrainzName ?? artist.name,
      title: group.title,
      album: group.title,
      musicBrainzArtistId: artist.musicBrainzId,
      musicBrainzReleaseGroupId: group.id,
    }, `album:${group.id}`);
  };

  const requestTrack = (group: ReleaseGroup, track: CatalogTrack) => {
    if (!artist || !track.recordingId) return;
    return createRequest({
      itemType: 'track',
      artist: artist.musicBrainzName ?? artist.name,
      title: track.title,
      album: group.title,
      musicBrainzArtistId: artist.musicBrainzId,
      musicBrainzReleaseGroupId: group.id,
      musicBrainzReleaseId: tracks[group.id]?.releaseId,
      musicBrainzRecordingId: track.recordingId,
    }, `track:${track.recordingId}`);
  };

  const changeRequest = async (request: RequestItem, action: 'approve' | 'reject' | 'retry' | 'complete') => {
    if (!token) return;
    setBusyKey(`${action}:${request.id}`);
    try {
      await apiFetch(`/plugins/missing-music/requests/${request.id}`, {
        method: 'PUT',
        body: JSON.stringify({ action }),
      }, token);
      await loadRequests();
    } catch (cause) {
      showToast(messageForError(cause), 'error', 'top-right');
    } finally {
      setBusyKey(null);
    }
  };

  useEffect(() => {
    if (!initialArtist?.id || !initialArtist.name || !token) return;
    setView('discover');
    void selectArtist({ name: initialArtist.name, musicBrainzId: initialArtist.id, albumCount: 0, trackCount: 0 });
  }, [initialArtist?.id, initialArtist?.name, selectArtist, token]);

  const searchCatalogArtists = async (search: string) => {
    const requestId = ++artistSearchRequestId.current;
    setCatalogArtists([]);
    setCatalogSearched(false);
    if (!token || search.trim().length < 2) return;
    setCatalogSearching(true);
    try {
      const data = await apiFetch(`/plugins/missing-music/artists/matches?q=${encodeURIComponent(search.trim())}`, {}, token) as { matches: ArtistMatch[] };
      if (requestId === artistSearchRequestId.current) {
        setCatalogArtists(data.matches);
        setCatalogSearched(true);
      }
    } catch (cause) {
      if (requestId === artistSearchRequestId.current) setError(messageForError(cause));
    } finally {
      if (requestId === artistSearchRequestId.current) setCatalogSearching(false);
    }
  };

  const findDeezerCandidates = async (request: RequestItem) => {
    if (!token) return;
    if (deezerOpen === request.id) { deezerLookupId.current++; setDeezerOpen(null); return; }
    const lookupId = ++deezerLookupId.current;
    setDeezerOpen(request.id);
    setBusyKey(`deezer-search:${request.id}`);
    try {
      const data = await apiFetch(`/plugins/missing-music/requests/${request.id}/deezer-candidates`, {}, token) as { candidates: DeezerCandidate[]; localAlbumMetadata: ExistingAlbumMetadata | null };
      if (lookupId === deezerLookupId.current) {
        setDeezerCandidates((current) => ({ ...current, [request.id]: data.candidates }));
        setLocalAlbumMetadata((current) => ({ ...current, [request.id]: data.localAlbumMetadata }));
        setReuseAlbumMetadata((current) => ({ ...current, [request.id]: Boolean(data.localAlbumMetadata) }));
      }
    } catch (cause) {
      if (lookupId === deezerLookupId.current) {
        setDeezerOpen(null);
        showToast(messageForError(cause), 'error', 'top-right');
      }
    } finally {
      setBusyKey((current) => current === `deezer-search:${request.id}` ? null : current);
    }
  };

  const stageDeezerCandidate = async (request: RequestItem, candidate: DeezerCandidate) => {
    if (!token) return;
    setBusyKey(`deezer-stage:${request.id}`);
    try {
      await apiFetch(`/plugins/missing-music/requests/${request.id}/deezer-download`, {
        method: 'POST', body: JSON.stringify(request.itemType === 'album' ? { albumId: candidate.id } : { trackId: candidate.id, useLocalAlbumMetadata: Boolean(localAlbumMetadata[request.id] && reuseAlbumMetadata[request.id]) }),
      }, token);
      setDeezerOpen(null);
      await loadRequests();
    } catch (cause) {
      showToast(messageForError(cause), 'error', 'top-right');
    } finally {
      setBusyKey(null);
    }
  };

  const downloadStagedFile = async (request: RequestItem) => {
    if (!token || !request.deezer?.filename) return;
    const stagedName = request.deezer.filename.replace(/\.zip$/i, '').split('/').at(-1) || request.deezer.filename;
    const downloadName = request.itemType === 'album' ? `${stagedName}.zip` : stagedName;
    const fileUrl = `${API_BASE}/plugins/missing-music/requests/${request.id}/deezer-file`;
    if (token === 'cookie') {
      const anchor = document.createElement('a');
      anchor.href = fileUrl;
      anchor.download = downloadName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      return;
    }
    setBusyKey(`deezer-file:${request.id}`);
    try {
      const headers = new Headers();
      if (token !== 'cookie') headers.set('authorization', `Bearer ${token}`);
      const response = await fetch(fileUrl, {
        headers, credentials: 'same-origin', cache: 'no-store',
      });
      if (!response.ok) throw new Error('Staged file is no longer available');
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = downloadName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (cause) {
      showToast(messageForError(cause), 'error', 'top-right');
    } finally {
      setBusyKey(null);
    }
  };

  const reviewStagedAlbum = async (request: RequestItem) => {
    if (!token) return;
    setBusyKey(`deezer-review:${request.id}`);
    try {
      const result = await apiFetch(`/plugins/missing-music/requests/${request.id}/deezer-review-album`, {}, token) as { artist: string; album: string };
      window.location.hash = `#/browse/album/${encodeURIComponent(result.artist)}/${encodeURIComponent(result.album)}`;
    } catch (cause) {
      showToast(messageForError(cause), 'error', 'top-right');
    } finally {
      setBusyKey(null);
    }
  };

  const deleteRequest = async (request: RequestItem) => {
    if (!token) return;
    const confirmed = await showConfirm({
      title: 'Delete music request?',
      message: `Delete the request for ${request.artist} — ${request.title}?${request.deezer?.state === 'staged' ? ' The downloaded files will remain in the plugin library.' : ''}`,
      confirmLabel: 'Delete request',
      danger: true,
    });
    if (!confirmed) return;
    setBusyKey(`delete:${request.id}`);
    try {
      await apiFetch(`/plugins/missing-music/requests/${request.id}`, { method: 'DELETE' }, token);
      await loadRequests();
    } catch (cause) {
      showToast(messageForError(cause), 'error', 'top-right');
    } finally {
      setBusyKey(null);
    }
  };

  const missingCount = useMemo(() => catalog.filter((group) => !group.present).length, [catalog]);
  const visibleCatalog = useMemo(() => catalog.filter((group) => (
    catalogFilter === 'all' || (catalogFilter === 'missing' ? !group.present : group.present)
  )), [catalog, catalogFilter]);
  const requestByCatalogId = useMemo(() => {
    const map = new Map<string, RequestItem>();
    for (const request of requests) {
      if (['failed', 'rejected', 'cancelled'].includes(request.status)) continue;
      const id = request.itemType === 'album' ? request.musicBrainzReleaseGroupId : request.musicBrainzRecordingId;
      if (id && !map.has(`${request.itemType}:${id}`)) map.set(`${request.itemType}:${id}`, request);
    }
    return map;
  }, [requests]);
  const providerConfigured = status?.providerConfigured ?? false;
  const requestCounts = useMemo(() => ({
    action: requests.filter((request) => ['requested', 'approved', 'failed'].includes(request.status) || (request.status === 'submitted' && request.deezer?.state === 'missing')).length,
    progress: requests.filter((request) => request.deezer?.state === 'downloading' || (request.status === 'submitted' && !['staged', 'missing'].includes(request.deezer?.state ?? ''))).length,
    staged: requests.filter((request) => request.deezer?.state === 'staged' && request.status !== 'completed').length,
    history: requests.filter((request) => ['completed', 'rejected', 'cancelled'].includes(request.status)).length,
  }), [requests]);
  const visibleRequests = useMemo(() => requests.filter((request) => {
    const matchesFilter = requestFilter === 'all'
      || (requestFilter === 'action' && (['requested', 'approved', 'failed'].includes(request.status) || (request.status === 'submitted' && request.deezer?.state === 'missing')))
      || (requestFilter === 'progress' && (request.deezer?.state === 'downloading' || (request.status === 'submitted' && !['staged', 'missing'].includes(request.deezer?.state ?? ''))))
      || (requestFilter === 'staged' && request.deezer?.state === 'staged' && request.status !== 'completed')
      || (requestFilter === 'history' && ['completed', 'rejected', 'cancelled'].includes(request.status));
    const term = requestSearch.trim().toLocaleLowerCase();
    return matchesFilter && (!term || [request.artist, request.title, request.album, request.userEmail].some((value) => value?.toLocaleLowerCase().includes(term)));
  }), [requests, requestFilter, requestSearch]);

  return (
    <div className="min-w-0 max-w-full space-y-6">
      <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-xl font-semibold text-white">Missing Music</h3>
            <p className="mt-1 text-sm text-white/55">
              Explore artist catalogs, find albums missing from your library, and keep a server-side wanted list.
            </p>
            {status && (
              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                <span className="rounded-full border border-white/10 bg-black/20 px-2.5 py-1 text-white/55">{formatCount(status.localArtistCount, 'local artist')}</span>
                <span className="rounded-full border border-white/10 bg-black/20 px-2.5 py-1 text-white/55">{formatCount(status.taggedArtistCount, 'MusicBrainz-tagged artist')}</span>
                <span className={`rounded-full border px-2.5 py-1 ${providerConfigured ? 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300' : 'border-cyan-400/25 bg-cyan-400/10 text-cyan-200'}`}>
                  {providerConfigured ? 'Automatic provider hand-off' : 'Wanted-list mode'}
                </span>
              </div>
            )}
          </div>
          <div className="flex rounded-xl border border-white/10 bg-black/20 p-1">
            {(['discover', 'requests'] as const).map((item) => (
              <button
                key={item}
                onClick={() => setView(item)}
                className={`rounded-lg px-4 py-2 text-sm font-medium capitalize transition ${view === item ? 'bg-cyan-500 text-black' : 'text-white/60 hover:text-white'}`}
              >
                {item === 'requests' && isAdmin ? 'Request queue' : item}
              </button>
            ))}
          </div>
        </div>
      </div>

      {isAdmin && pluginUpdate && (
        <div className="flex flex-col gap-3 rounded-xl border border-amber-400/25 bg-amber-400/[0.08] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium text-amber-100">Missing Music {pluginUpdate.available.version} is available</p>
            <p className="mt-0.5 text-xs text-amber-100/60">
              {pluginUpdate.available.source === 'repository' ? 'Published in the official public plugin registry.' : 'Included with this MVBar build.'}
            </p>
          </div>
          <button
            onClick={() => void updatePlugin()}
            disabled={updatingPlugin}
            className="shrink-0 rounded-lg bg-amber-300 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-amber-200 disabled:opacity-50"
          >
            {updatingPlugin ? 'Updating…' : 'Update plugin'}
          </button>
        </div>
      )}

      {isAdmin && updateNeedsReview && (
        <div className="rounded-xl border border-amber-400/25 bg-amber-400/[0.08] px-4 py-3 text-sm text-amber-100">
          The update requested different permissions. Open <a href="#/admin" className="font-medium text-cyan-300 hover:text-cyan-200">Admin → Plugins</a> to review and enable it.
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-400/25 bg-red-400/10 px-4 py-3 text-sm text-red-200">{error}</div>
      )}

      {status && !providerConfigured && isAdmin && (
        <div className="rounded-xl border border-cyan-400/20 bg-cyan-400/[0.07] px-4 py-3 text-sm text-cyan-100">
          Missing Music is ready in wanted-list mode. {status.autoDownloadDeezer
            ? 'New requests are automatically matched against Deezer and staged when a confident match is available.'
            : status.deezerConfigured
              ? 'Administrators can stage matching Deezer songs and albums. They are scanned into a separate library automatically.'
              : 'Administrators can approve requests and mark them fulfilled after importing the music.'} An external provider can be configured in Admin → Plugins.
        </div>
      )}

      {view === 'discover' && (
        <div className="grid min-w-0 max-w-full gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
          <section className="min-w-0 rounded-2xl border border-white/10 bg-white/[0.04] p-4">
            <form
              className="flex gap-2"
              onSubmit={(event) => { event.preventDefault(); void loadArtists(query); void searchCatalogArtists(query); }}
            >
              <input
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  artistSearchRequestId.current++;
                  localSearchRequestId.current++;
                  setCatalogSearching(false);
                  setCatalogSearched(false);
                  setCatalogArtists([]);
                  setArtistsLoading(false);
                }}
                placeholder="Search artists"
                className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400/60"
              />
              <button className="rounded-lg bg-white/10 px-3 text-sm hover:bg-white/15" aria-label="Search artists">Search</button>
            </form>
            <div className="mt-4 max-h-[60vh] space-y-1 overflow-y-auto pr-1">
              {(catalogSearching || catalogSearched) && <p className="px-3 pb-1 text-xs font-medium uppercase tracking-wide text-white/40">MusicBrainz artists</p>}
              {catalogSearching && <p className="px-3 py-2 text-xs text-white/45">Searching the catalog…</p>}
              {catalogSearched && catalogArtists.length === 0 && <p className="px-3 py-2 text-xs text-white/45">No catalog artists found. Try the artist name.</p>}
              {catalogArtists.map((match) => (
                <button key={`catalog:${match.id}`} onClick={() => void selectArtist({ name: match.name, musicBrainzId: match.id, albumCount: 0, trackCount: 0 })}
                  className={`w-full rounded-xl px-3 py-2.5 text-left transition ${artist?.musicBrainzId === match.id ? 'bg-cyan-500/15 text-cyan-200' : 'hover:bg-white/[0.06]'}`}>
                  <span className="block truncate text-sm font-medium">{match.name}</span>
                  <span className="block truncate text-xs text-white/40">{[match.disambiguation, match.country].filter(Boolean).join(' · ') || 'Browse albums'}</span>
                </button>
              ))}
              <p className="px-3 pt-2 text-xs font-medium uppercase tracking-wide text-white/40">Local artists</p>
              {artistsLoading && <div className="flex justify-center py-8"><Spinner /></div>}
              {artists.map((item) => (
                <button
                  key={`${item.musicBrainzId}:${item.name}`}
                  onClick={() => void selectArtist(item)}
                  className={`w-full rounded-xl px-3 py-2.5 text-left transition ${artist?.name === item.name ? 'bg-cyan-500/15 text-cyan-200' : 'hover:bg-white/[0.06]'}`}
                >
                  <div className="truncate text-sm font-medium">{item.name}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-white/40">
                    <span>{formatCount(item.albumCount, 'album')} · {formatCount(item.trackCount, 'track')}</span>
                    {item.matchSource === 'saved' && <span className="rounded bg-emerald-400/10 px-1.5 py-0.5 text-emerald-200">Matched</span>}
                    {!item.musicBrainzId && <span className="rounded bg-amber-400/10 px-1.5 py-0.5 text-amber-200">Choose MusicBrainz match</span>}
                  </div>
                </button>
              ))}
              {!artistsLoading && artists.length === 0 && <p className="py-8 text-center text-sm text-white/40">No local artists found. Search an artist name to browse the MusicBrainz catalog.</p>}
            </div>
          </section>

          <section className="min-w-0 rounded-2xl border border-white/10 bg-white/[0.04] p-4 sm:p-5">
            {!artist && <p className="py-20 text-center text-white/45">Choose an artist to compare their releases.</p>}
            {artist && (
              <>
                <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <h4 className="text-lg font-semibold">{artist.name}</h4>
                    <p className="text-sm text-white/45">
                      {artist.musicBrainzId
                        ? `${catalog.length} releases · ${missingCount} album titles missing${artist.musicBrainzName && artist.musicBrainzName !== artist.name ? ` · matched to ${artist.musicBrainzName}` : ''}`
                        : 'This artist has no MusicBrainz tag. Choose the correct match once to compare the catalog.'}
                    </p>
                  </div>
                  {artist.musicBrainzId && (
                    <div className="flex items-center gap-3">
                      {artist.matchSource === 'saved' && (
                        <button
                          onClick={() => void selectArtist({ ...artist, musicBrainzId: null, musicBrainzName: null, matchSource: null })}
                          className="text-xs text-white/45 hover:text-white/70"
                        >
                          Change match
                        </button>
                      )}
                      <a
                        href={`https://musicbrainz.org/artist/${artist.musicBrainzId}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-cyan-300 hover:text-cyan-200"
                      >
                        Open in MusicBrainz ↗
                      </a>
                    </div>
                  )}
                </div>
                {!artist.musicBrainzId && (
                  <div className="rounded-xl border border-amber-400/20 bg-amber-400/[0.05] p-3 sm:p-4">
                    {busyKey === 'artist-match' ? (
                      <div className="flex items-center justify-center gap-3 py-12 text-sm text-white/55"><Spinner /> Finding MusicBrainz matches…</div>
                    ) : artistMatches.length > 0 ? (
                      <div className="space-y-2">
                        <p className="mb-3 text-sm text-white/60">Select the artist that represents <strong className="text-white">{artist.name}</strong>:</p>
                        {artistMatches.map((match) => (
                          <button
                            key={match.id}
                            onClick={() => void chooseArtistMatch(match)}
                            disabled={busyKey === 'artist-match-save'}
                            className="flex w-full items-center justify-between gap-3 rounded-lg border border-white/10 bg-black/20 px-3 py-2.5 text-left hover:border-cyan-400/35 hover:bg-cyan-400/[0.06] disabled:opacity-50"
                          >
                            <span className="min-w-0">
                              <span className="block truncate text-sm font-medium text-white">{match.name}</span>
                              <span className="mt-0.5 block truncate text-xs text-white/40">{[match.disambiguation, match.type, match.country].filter(Boolean).join(' · ') || 'No additional details'}</span>
                            </span>
                            {match.score !== null && <span className="shrink-0 text-xs text-white/35">{match.score}% match</span>}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="py-10 text-center text-sm text-white/45">MusicBrainz did not return a confident match. Check the artist name in your local tags and try again.</p>
                    )}
                  </div>
                )}

                {artist.musicBrainzId && loading && catalog.length === 0 && <div className="flex justify-center py-20"><Spinner /></div>}
                {artist.musicBrainzId && !loading && catalog.length > 0 && (
                  <div className="mb-4 flex flex-wrap gap-2">
                    {(['missing', 'all', 'present'] as const).map((filter) => (
                      <button
                        key={filter}
                        onClick={() => setCatalogFilter(filter)}
                        className={`rounded-lg border px-3 py-1.5 text-xs font-medium capitalize ${catalogFilter === filter ? 'border-cyan-400/40 bg-cyan-400/15 text-cyan-200' : 'border-white/10 text-white/50 hover:bg-white/[0.06]'}`}
                      >
                        {filter === 'missing' ? `Missing albums (${missingCount})` : filter === 'present' ? `Album found (${catalog.length - missingCount})` : `All (${catalog.length})`}
                      </button>
                    ))}
                    <p className="basis-full text-xs text-white/40">An album title in your library may still have missing tracks. Open it in Album found to check.</p>
                  </div>
                )}
                {artist.musicBrainzId && (
                  <div className="space-y-2">
                    {visibleCatalog.map((group) => {
                      const detail = tracks[group.id];
                      const incomplete = group.present && Boolean(detail?.tracks.some((track) => track.missing));
                      const checkedComplete = group.present && Boolean(detail?.tracks.length) && !incomplete;
                      const albumRequest = requestByCatalogId.get(`album:${group.id}`);
                      return (
                        <div key={group.id} className="overflow-hidden rounded-xl border border-white/10 bg-black/20">
                          <div className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center">
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="truncate font-medium text-white">{group.title}</span>
                                <span className={`rounded-full border px-2 py-0.5 text-[11px] ${incomplete ? 'border-amber-400/25 bg-amber-400/10 text-amber-300' : group.present ? 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300' : 'border-amber-400/25 bg-amber-400/10 text-amber-300'}`}>
                                  {incomplete ? `${detail?.tracks.filter((track) => track.missing).length} tracks missing` : checkedComplete ? 'Complete' : group.present ? 'Album found' : 'Missing'}
                                </span>
                              </div>
                              <div className="mt-1 text-xs text-white/40">
                                {[group.primaryType, ...group.secondaryTypes, group.firstReleaseDate?.slice(0, 4)].filter(Boolean).join(' · ')}
                              </div>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              <button
                                onClick={() => void inspectTracks(group)}
                                disabled={busyKey === `tracks:${group.id}`}
                                className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/70 hover:bg-white/10 disabled:opacity-50"
                              >
                                {busyKey === `tracks:${group.id}` ? 'Checking…' : expanded === group.id ? 'Hide tracks' : 'View tracks'}
                              </button>
                              {(!group.present || incomplete) && (
                                <button
                                  onClick={() => void requestAlbum(group)}
                                  disabled={Boolean(albumRequest) || busyKey === `album:${group.id}`}
                                  className="rounded-lg bg-cyan-500 px-3 py-1.5 text-xs font-semibold text-black hover:bg-cyan-400 disabled:opacity-50"
                                >
                                  {busyKey === `album:${group.id}` ? 'Requesting…' : albumRequest ? statusLabel(albumRequest.status, providerConfigured) : 'Request album'}
                                </button>
                              )}
                            </div>
                          </div>
                          {expanded === group.id && detail && (
                            <div className="border-t border-white/10 px-3 py-2">
                              {detail.tracks.map((track, index) => {
                                const trackRequest = track.recordingId ? requestByCatalogId.get(`track:${track.recordingId}`) : undefined;
                                return (
                                  <div key={`${track.recordingId ?? track.title}:${index}`} className="flex items-center gap-3 border-b border-white/[0.06] py-2 last:border-0">
                                    <span className="w-8 text-right text-xs text-white/35">{track.number ?? track.trackNumber ?? index + 1}</span>
                                    <span className="min-w-0 flex-1 truncate text-sm text-white/75">{track.title}</span>
                                    <span className="text-xs text-white/35">{formatDuration(track.durationMs)}</span>
                                    {track.missing ? (
                                      <button
                                        onClick={() => void requestTrack(group, track)}
                                        disabled={!track.recordingId || Boolean(trackRequest) || busyKey === `track:${track.recordingId}`}
                                        className="rounded-md bg-amber-400/15 px-2.5 py-1 text-xs text-amber-200 hover:bg-amber-400/25 disabled:opacity-40"
                                      >
                                        {busyKey === `track:${track.recordingId}` ? 'Requesting…' : trackRequest ? statusLabel(trackRequest.status, providerConfigured) : 'Request'}
                                      </button>
                                    ) : (
                                      <span className="px-2.5 text-xs text-emerald-300/70">Present</span>
                                    )}
                                  </div>
                                );
                              })}
                              {!detail.tracks.length && <p className="py-4 text-center text-sm text-white/40">No track list available.</p>}
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {!loading && visibleCatalog.length === 0 && (
                      <p className="py-16 text-center text-sm text-white/40">
                        {catalog.length === 0 ? 'MusicBrainz has no releases matching the configured types.' : `No ${catalogFilter === 'present' ? 'in-library' : catalogFilter} releases in this view.`}
                      </p>
                    )}
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      )}

      {view === 'requests' && (
        <section className="rounded-2xl border border-white/10 bg-white/[0.04] p-4 sm:p-5">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h4 className="font-semibold">{isAdmin ? 'All requests' : 'My requests'}</h4>
              <p className="mt-1 text-sm text-white/45">
                {providerConfigured
                  ? 'Approved requests are handed to the configured provider and update automatically.'
                  : 'This is a managed wanted list. Administrators can approve requests and mark them fulfilled manually.'}
              </p>
              {isAdmin && <p className="mt-1 text-xs text-white/40">
                {status?.deezerConfigured
                  ? `Deezer downloads in ${status.deezerStagingDirectory} are scanned into a separate plugin library automatically. Removing that folder removes only its tracks from browsing.`
                    : status?.deezerConfigurationError || 'To stage songs and albums from Deezer, set DEEZER_ARL and DEEZER_DOWNLOAD_DIR on the server.'}
              </p>}
            </div>
            <button onClick={() => void loadRequests()} className="rounded-lg border border-white/10 px-3 py-2 text-xs hover:bg-white/10">Refresh</button>
          </div>
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap gap-2" aria-label="Filter requests">
              {([
                ['all', 'All', requests.length],
                ['action', isAdmin ? 'Needs action' : 'Awaiting review', requestCounts.action],
                ['progress', 'In progress', requestCounts.progress],
                ['staged', 'Downloaded', requestCounts.staged],
                ['history', 'History', requestCounts.history],
              ] as const).map(([filter, label, count]) => (
                <button key={filter} onClick={() => setRequestFilter(filter)} aria-pressed={requestFilter === filter}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${requestFilter === filter ? 'border-cyan-400/40 bg-cyan-400/15 text-cyan-200' : 'border-white/10 text-white/50 hover:bg-white/[0.06]'}`}>
                  {label} ({count})
                </button>
              ))}
            </div>
            <input value={requestSearch} onChange={(event) => setRequestSearch(event.target.value)}
              aria-label="Search requests" placeholder="Search requests"
              className="min-w-0 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400/60 sm:w-56" />
          </div>
          <div className="space-y-2">
            {visibleRequests.map((request) => (
              <div key={request.id} className="rounded-xl border border-white/10 bg-black/20 p-3 sm:p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-medium">{request.title}</span>
                      <span className={`rounded-full border px-2 py-0.5 text-[11px] ${request.deezer?.state === 'missing' ? 'border-amber-400/30 bg-amber-400/10 text-amber-200' : statusClasses(request.status)}`}>{request.deezer?.state === 'downloading' ? request.deezer.phase === 'publishing' ? 'Finalizing album' : request.deezer.total ? `Downloading ${request.deezer.completed ?? 0}/${request.deezer.total} tracks` : `Downloading ${request.itemType} from Deezer` : request.deezer?.state === 'missing' ? 'Missing from staging' : request.deezer?.state === 'staged' && request.status !== 'completed' ? 'Downloaded to plugin library' : statusLabel(request.status, providerConfigured)}</span>
                      <span className="text-[11px] uppercase tracking-wide text-white/35">{request.itemType}</span>
                    </div>
                    <p className="mt-1 truncate text-sm text-white/50">{request.artist}{request.album && request.album !== request.title ? ` · ${request.album}` : ''}</p>
                    <p className="mt-1 text-xs text-white/35">
                      {isAdmin && request.userEmail ? `${request.userEmail} · ` : ''}{new Date(request.createdAt).toLocaleString()}
                      {request.providerRequestId ? ` · External ID ${request.providerRequestId}` : ''}
                    </p>
                    {request.error && <p className="mt-2 text-xs text-red-300">{request.error}</p>}
                    {request.deezer?.state === 'downloading' && Boolean(request.deezer.total) && (
                      <div className="mt-2 h-1.5 max-w-sm overflow-hidden rounded-full bg-white/10" role="progressbar"
                        aria-label={`Downloading ${request.title}`} aria-valuenow={request.deezer.completed ?? 0} aria-valuemin={0} aria-valuemax={request.deezer.total ?? 1}>
                        <div className="h-full rounded-full bg-cyan-400 transition-[width]" style={{ width: `${Math.min(100, 100 * (request.deezer.completed ?? 0) / (request.deezer.total ?? 1))}%` }} />
                      </div>
                    )}
                    {isAdmin && request.deezer?.state === 'staged' && request.deezer.filename && <p className="mt-2 truncate text-xs text-cyan-200">Staged: {request.deezer.filename}{request.deezer.trackCount ? ` · ${request.deezer.trackCount} tracks` : ''}{request.deezer.usedLocalAlbumMetadata ? ' · Existing album tags applied' : ''}</p>}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {isAdmin && request.status === 'requested' && (
                      <>
                        <button onClick={() => void changeRequest(request, 'approve')} disabled={busyKey === `approve:${request.id}`} className="rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-black disabled:opacity-50">Approve</button>
                        <button onClick={() => void changeRequest(request, 'reject')} disabled={busyKey === `reject:${request.id}`} className="rounded-lg bg-red-400/15 px-3 py-1.5 text-xs text-red-200 disabled:opacity-50">Reject</button>
                      </>
                    )}
                    {isAdmin && request.status === 'failed' && !request.deezer && (
                      <button onClick={() => void changeRequest(request, 'retry')} disabled={busyKey === `retry:${request.id}`} className="rounded-lg bg-cyan-500 px-3 py-1.5 text-xs font-semibold text-black disabled:opacity-50">Retry</button>
                    )}
                    {isAdmin && !providerConfigured && (['requested', 'approved', 'failed'].includes(request.status) || (request.status === 'submitted' && request.deezer?.state === 'missing')) && (
                      <button onClick={() => void findDeezerCandidates(request)} disabled={busyKey === `deezer-search:${request.id}`} className="rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-3 py-1.5 text-xs text-cyan-200 hover:bg-cyan-400/20 disabled:opacity-50">
                        {busyKey === `deezer-search:${request.id}` ? 'Searching…' : deezerOpen === request.id ? 'Hide Deezer matches' : request.deezer?.state === 'missing' ? 'Download again' : 'Find on Deezer'}
                      </button>
                    )}
                    {isAdmin && request.deezer?.state === 'staged' && <button onClick={() => void downloadStagedFile(request)} disabled={busyKey === `deezer-file:${request.id}`} className="rounded-lg border border-cyan-400/30 px-3 py-1.5 text-xs text-cyan-200 hover:bg-cyan-400/10 disabled:opacity-50">Download {request.itemType === 'album' ? 'album ZIP' : 'staged song'}</button>}
                    {isAdmin && request.deezer?.state === 'staged' && <button onClick={() => void reviewStagedAlbum(request)} disabled={busyKey === `deezer-review:${request.id}`} className="rounded-lg border border-cyan-400/30 px-3 py-1.5 text-xs text-cyan-200 hover:bg-cyan-400/10 disabled:opacity-50">Review metadata in album</button>}
                    {isAdmin && ['requested', 'approved', 'submitted', 'failed'].includes(request.status) && request.deezer?.state !== 'downloading' && (
                      <button onClick={() => void changeRequest(request, 'complete')} disabled={busyKey === `complete:${request.id}`} className="rounded-lg bg-emerald-400/15 px-3 py-1.5 text-xs text-emerald-200 hover:bg-emerald-400/25 disabled:opacity-50">Mark fulfilled</button>
                    )}
                    <button onClick={() => void deleteRequest(request)} disabled={busyKey === `delete:${request.id}` || request.deezer?.state === 'downloading'} className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/55 hover:bg-white/10 disabled:opacity-50">Delete</button>
                  </div>
                </div>
                {isAdmin && deezerOpen === request.id && (
                  <div className="mt-3 space-y-2 border-t border-white/10 pt-3">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-xs text-white/50">{request.itemType === 'album' ? 'Choose the matching release. Check its track count or open Deezer to distinguish versions.' : 'Select the exact recording. Album and duration help distinguish versions.'}</p>
                      <button onClick={() => void findDeezerCandidates(request)} className="shrink-0 text-xs text-cyan-300 hover:text-cyan-200">Hide</button>
                    </div>
                    {request.itemType === 'track' && localAlbumMetadata[request.id] && (
                      <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-emerald-400/20 bg-emerald-400/[0.06] p-3 text-xs text-emerald-100">
                        <input type="checkbox" checked={Boolean(reuseAlbumMetadata[request.id])} onChange={(event) => setReuseAlbumMetadata((current) => ({ ...current, [request.id]: event.target.checked }))} className="mt-0.5 accent-emerald-400" />
                        <span>Use tags from existing album <strong>{localAlbumMetadata[request.id].album}</strong>{localAlbumMetadata[request.id].year ? ` (${localAlbumMetadata[request.id].year})` : ''}. This copies album name, album artist, year and genre while keeping the selected song title and artist.</span>
                      </label>
                    )}
                    {(deezerCandidates[request.id] ?? []).map((candidate) => (
                      <div key={candidate.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-white/10 bg-white/[0.04] p-2.5">
                        {request.itemType === 'album' && candidate.cover && <img src={candidate.cover} alt="" className="h-12 w-12 rounded object-cover" />}
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm text-white/85">{candidate.title} · {candidate.artist}</p>
                          <p className="truncate text-xs text-white/45">{request.itemType === 'album'
                            ? `${candidate.trackCount ?? '?'} tracks${candidate.releaseDate ? ` · ${candidate.releaseDate.slice(0, 4)}` : ''}`
                            : `${candidate.album || 'Unknown album'}${candidate.durationMs ? ` · ${formatDuration(candidate.durationMs)}` : ''}`}</p>
                        </div>
                        {candidate.link && <a href={candidate.link} target="_blank" rel="noreferrer" className="text-xs text-white/50 hover:text-white">Deezer ↗</a>}
                        <button onClick={() => void stageDeezerCandidate(request, candidate)} disabled={!status?.deezerConfigured || Boolean(busyKey) || (request.itemType === 'album' && !candidate.trackCount)} title={!status?.deezerConfigured ? 'Configure Deezer staging on the server first' : undefined} className="rounded-lg bg-cyan-500 px-3 py-1.5 text-xs font-semibold text-black hover:bg-cyan-400 disabled:opacity-40">Stage {request.itemType === 'album' ? 'album' : 'song'}</button>
                      </div>
                    ))}
                    {busyKey === `deezer-search:${request.id}` && <p className="text-xs text-white/45">Searching Deezer…</p>}
                    {busyKey !== `deezer-search:${request.id}` && deezerCandidates[request.id]?.length === 0 && <p className="text-xs text-white/45">No close Deezer matches found for this {request.itemType}. Close and reopen to search again.</p>}
                  </div>
                )}
              </div>
            ))}
            {requestsLoading && <div className="flex justify-center py-12"><Spinner /></div>}
            {!requestsLoading && !visibleRequests.length && <p className="py-16 text-center text-sm text-white/40">{requests.length ? 'No requests match this filter.' : 'No requests yet.'}</p>}
          </div>
        </section>
      )}
    </div>
  );
}

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
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
  musicBrainzId: string | null;
  musicBrainzName?: string | null;
  matchSource?: 'tags' | 'saved' | null;
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
};

type MissingMusicStatus = {
  enabled: boolean;
  providerConfigured: boolean;
  mode: 'provider' | 'wanted-list';
  requireAdminApproval: boolean;
  localArtistCount: number;
  taggedArtistCount: number;
};

type ReleaseGroup = {
  id: string;
  title: string;
  primaryType: string | null;
  secondaryTypes: string[];
  firstReleaseDate: string | null;
  present: boolean;
};

type CatalogTrack = {
  recordingId: string | null;
  title: string;
  discNumber: number;
  trackNumber: number | null;
  number: string | null;
  durationMs: number | null;
  missing: boolean;
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
  status: 'requested' | 'approved' | 'submitted' | 'completed' | 'failed' | 'rejected' | 'cancelled';
  providerRequestId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

type PluginUpdate = {
  available: BundledAdminPlugin;
  installed: AdminPlugin;
};

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

export function MissingMusic() {
  const token = useAuth((state) => state.token);
  const user = useAuth((state) => state.user);
  const isAdmin = user?.role === 'admin';
  const showToast = useToastStore((state) => state.show);
  const liveUpdate = useMissingMusicUpdates((state) => state.lastUpdate);
  const [view, setView] = useState<'discover' | 'requests'>('discover');
  const [query, setQuery] = useState('');
  const [artists, setArtists] = useState<Artist[]>([]);
  const [artist, setArtist] = useState<Artist | null>(null);
  const [artistMatches, setArtistMatches] = useState<ArtistMatch[]>([]);
  const [catalog, setCatalog] = useState<ReleaseGroup[]>([]);
  const [catalogFilter, setCatalogFilter] = useState<'missing' | 'all' | 'present'>('missing');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [tracks, setTracks] = useState<Record<string, { releaseId: string; tracks: CatalogTrack[] }>>({});
  const [requests, setRequests] = useState<RequestItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState<MissingMusicStatus | null>(null);
  const [pluginUpdate, setPluginUpdate] = useState<PluginUpdate | null>(null);
  const [updatingPlugin, setUpdatingPlugin] = useState(false);
  const [updateNeedsReview, setUpdateNeedsReview] = useState(false);

  const loadArtists = useCallback(async (search = '') => {
    if (!token) return;
    setLoading(true);
    setError('');
    try {
      const data = await apiFetch(`/plugins/missing-music/artists?q=${encodeURIComponent(search)}`, {}, token) as { artists: Artist[] };
      setArtists(data.artists);
    } catch (cause) {
      setError(messageForError(cause));
    } finally {
      setLoading(false);
    }
  }, [token]);

  const loadRequests = useCallback(async () => {
    if (!token) return;
    try {
      const data = await apiFetch('/plugins/missing-music/requests', {}, token) as { requests: RequestItem[] };
      setRequests(data.requests);
    } catch (cause) {
      setError(messageForError(cause));
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

  const loadCatalog = async (selected: Artist, musicBrainzId: string) => {
    if (!token) return;
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
      setCatalog(data.releaseGroups);
    } catch (cause) {
      setError(messageForError(cause));
    } finally {
      setLoading(false);
    }
  };

  const selectArtist = async (selected: Artist) => {
    if (!token) return;
    setArtist(selected);
    setArtistMatches([]);
    setCatalog([]);
    setTracks({});
    setExpanded(null);
    setError('');
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
      setArtistMatches(data.matches);
    } catch (cause) {
      setError(messageForError(cause));
    } finally {
      setBusyKey(null);
    }
  };

  const chooseArtistMatch = async (match: ArtistMatch) => {
    if (!artist || !token) return;
    setBusyKey('artist-match-save');
    setError('');
    try {
      await apiFetch('/plugins/missing-music/artists/match', {
        method: 'PUT',
        body: JSON.stringify({ localArtist: artist.name, musicBrainzId: match.id, musicBrainzName: match.name }),
      }, token);
      const matched: Artist = { ...artist, musicBrainzId: match.id, musicBrainzName: match.name, matchSource: 'saved' };
      setArtist(matched);
      setArtistMatches([]);
      setArtists((current) => current.map((item) => item.name === artist.name ? matched : item));
      await loadCatalog(matched, match.id);
    } catch (cause) {
      setError(messageForError(cause));
    } finally {
      setBusyKey(null);
    }
  };

  const inspectTracks = async (group: ReleaseGroup) => {
    if (!token || !artist?.musicBrainzId) return;
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
      setTracks((current) => ({ ...current, [group.id]: data }));
    } catch (cause) {
      setError(messageForError(cause));
      setExpanded(null);
    } finally {
      setBusyKey(null);
    }
  };

  const createRequest = async (body: Record<string, unknown>, key: string) => {
    if (!token) return;
    setBusyKey(key);
    setError('');
    try {
      await apiFetch('/plugins/missing-music/requests', { method: 'POST', body: JSON.stringify(body) }, token);
      showToast('Request created successfully', 'success', 'top-right');
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

  const deleteRequest = async (request: RequestItem) => {
    if (!token) return;
    setBusyKey(`delete:${request.id}`);
    try {
      await apiFetch(`/plugins/missing-music/requests/${request.id}`, { method: 'DELETE' }, token);
      await loadRequests();
      showToast('Request deleted', 'success', 'top-right');
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

  return (
    <div className="min-w-0 max-w-full space-y-6">
      <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-xl font-semibold text-white">Missing Music</h3>
            <p className="mt-1 text-sm text-white/55">
              Compare local artists with MusicBrainz, find gaps, and keep a server-side wanted list.
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

      {!providerConfigured && isAdmin && (
        <div className="rounded-xl border border-cyan-400/20 bg-cyan-400/[0.07] px-4 py-3 text-sm text-cyan-100">
          Missing Music is ready in wanted-list mode. Administrators can approve and manually mark requests fulfilled. Configure an optional request-provider URL in Admin → Plugins only if you want automatic hand-off.
        </div>
      )}

      {view === 'discover' && (
        <div className="grid min-w-0 max-w-full gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
          <section className="min-w-0 rounded-2xl border border-white/10 bg-white/[0.04] p-4">
            <form
              className="flex gap-2"
              onSubmit={(event) => { event.preventDefault(); void loadArtists(query); }}
            >
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter local artists"
                className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400/60"
              />
              <button className="rounded-lg bg-white/10 px-3 text-sm hover:bg-white/15" aria-label="Search artists">Search</button>
            </form>
            <div className="mt-4 max-h-[60vh] space-y-1 overflow-y-auto pr-1">
              {loading && !artist && <div className="flex justify-center py-8"><Spinner /></div>}
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
              {!loading && artists.length === 0 && <p className="py-8 text-center text-sm text-white/40">No local artists found.</p>}
            </div>
          </section>

          <section className="min-w-0 rounded-2xl border border-white/10 bg-white/[0.04] p-4 sm:p-5">
            {!artist && <p className="py-20 text-center text-white/45">Choose a local artist to compare their releases.</p>}
            {artist && (
              <>
                <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <h4 className="text-lg font-semibold">{artist.name}</h4>
                    <p className="text-sm text-white/45">
                      {artist.musicBrainzId
                        ? `${catalog.length} releases · ${missingCount} missing${artist.musicBrainzName && artist.musicBrainzName !== artist.name ? ` · matched to ${artist.musicBrainzName}` : ''}`
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
                        {filter === 'missing' ? `Missing (${missingCount})` : filter === 'present' ? `In library (${catalog.length - missingCount})` : `All (${catalog.length})`}
                      </button>
                    ))}
                  </div>
                )}
                {artist.musicBrainzId && (
                  <div className="space-y-2">
                    {visibleCatalog.map((group) => {
                      const detail = tracks[group.id];
                      const albumRequest = requestByCatalogId.get(`album:${group.id}`);
                      return (
                        <div key={group.id} className="overflow-hidden rounded-xl border border-white/10 bg-black/20">
                          <div className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center">
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="truncate font-medium text-white">{group.title}</span>
                                <span className={`rounded-full border px-2 py-0.5 text-[11px] ${group.present ? 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300' : 'border-amber-400/25 bg-amber-400/10 text-amber-300'}`}>
                                  {group.present ? 'In library' : 'Missing'}
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
                              {!group.present && (
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
            </div>
            <button onClick={() => void loadRequests()} className="rounded-lg border border-white/10 px-3 py-2 text-xs hover:bg-white/10">Refresh</button>
          </div>
          <div className="space-y-2">
            {requests.map((request) => (
              <div key={request.id} className="rounded-xl border border-white/10 bg-black/20 p-3 sm:p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-medium">{request.title}</span>
                      <span className={`rounded-full border px-2 py-0.5 text-[11px] ${statusClasses(request.status)}`}>{statusLabel(request.status, providerConfigured)}</span>
                      <span className="text-[11px] uppercase tracking-wide text-white/35">{request.itemType}</span>
                    </div>
                    <p className="mt-1 truncate text-sm text-white/50">{request.artist}{request.album && request.album !== request.title ? ` · ${request.album}` : ''}</p>
                    <p className="mt-1 text-xs text-white/35">
                      {isAdmin && request.userEmail ? `${request.userEmail} · ` : ''}{new Date(request.createdAt).toLocaleString()}
                      {request.providerRequestId ? ` · External ID ${request.providerRequestId}` : ''}
                    </p>
                    {request.error && <p className="mt-2 text-xs text-red-300">{request.error}</p>}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {isAdmin && request.status === 'requested' && (
                      <>
                        <button onClick={() => void changeRequest(request, 'approve')} disabled={busyKey === `approve:${request.id}`} className="rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-black disabled:opacity-50">Approve</button>
                        <button onClick={() => void changeRequest(request, 'reject')} disabled={busyKey === `reject:${request.id}`} className="rounded-lg bg-red-400/15 px-3 py-1.5 text-xs text-red-200 disabled:opacity-50">Reject</button>
                      </>
                    )}
                    {isAdmin && request.status === 'failed' && (
                      <button onClick={() => void changeRequest(request, 'retry')} disabled={busyKey === `retry:${request.id}`} className="rounded-lg bg-cyan-500 px-3 py-1.5 text-xs font-semibold text-black disabled:opacity-50">Retry</button>
                    )}
                    {isAdmin && ['requested', 'approved', 'submitted', 'failed'].includes(request.status) && (
                      <button onClick={() => void changeRequest(request, 'complete')} disabled={busyKey === `complete:${request.id}`} className="rounded-lg bg-emerald-400/15 px-3 py-1.5 text-xs text-emerald-200 hover:bg-emerald-400/25 disabled:opacity-50">Mark fulfilled</button>
                    )}
                    <button onClick={() => void deleteRequest(request)} disabled={busyKey === `delete:${request.id}`} className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/55 hover:bg-white/10 disabled:opacity-50">Delete</button>
                  </div>
                </div>
              </div>
            ))}
            {!requests.length && <p className="py-16 text-center text-sm text-white/40">No requests yet.</p>}
          </div>
        </section>
      )}
    </div>
  );
}

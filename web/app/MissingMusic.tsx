'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from './apiClient';
import { useAuth } from './store';
import { formatCount } from './format';
import { useToastStore } from './Toast';
import { useMissingMusicUpdates } from './useWebSocket';

type Artist = {
  name: string;
  musicBrainzId: string;
  albumCount: number;
  trackCount: number;
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
  const [catalog, setCatalog] = useState<ReleaseGroup[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [tracks, setTracks] = useState<Record<string, { releaseId: string; tracks: CatalogTrack[] }>>({});
  const [requests, setRequests] = useState<RequestItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [providerConfigured, setProviderConfigured] = useState(true);

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

  useEffect(() => {
    void loadArtists();
    void loadRequests();
    if (token) {
      void apiFetch('/plugins/missing-music/status', {}, token)
        .then((status: any) => setProviderConfigured(Boolean(status.configured)))
        .catch(() => undefined);
    }
  }, [loadArtists, loadRequests, token]);

  useEffect(() => {
    if (liveUpdate) void loadRequests();
  }, [liveUpdate, loadRequests]);

  const selectArtist = async (selected: Artist) => {
    if (!token) return;
    setArtist(selected);
    setCatalog([]);
    setTracks({});
    setExpanded(null);
    setLoading(true);
    setError('');
    try {
      const data = await apiFetch(
        `/plugins/missing-music/artists/${selected.musicBrainzId}/catalog`,
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

  const inspectTracks = async (group: ReleaseGroup) => {
    if (!token || !artist) return;
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
        `/plugins/missing-music/release-groups/${group.id}/tracks?artistMbid=${artist.musicBrainzId}&album=${encodeURIComponent(group.title)}`,
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
      artist: artist.name,
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
      artist: artist.name,
      title: track.title,
      album: group.title,
      musicBrainzArtistId: artist.musicBrainzId,
      musicBrainzReleaseGroupId: group.id,
      musicBrainzReleaseId: tracks[group.id]?.releaseId,
      musicBrainzRecordingId: track.recordingId,
    }, `track:${track.recordingId}`);
  };

  const changeRequest = async (request: RequestItem, action: 'approve' | 'reject' | 'retry') => {
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

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-xl font-semibold text-white">Missing Music</h3>
            <p className="mt-1 text-sm text-white/55">
              Compare your library with MusicBrainz and send requests to the configured external service.
            </p>
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

      {error && (
        <div className="rounded-xl border border-red-400/25 bg-red-400/10 px-4 py-3 text-sm text-red-200">{error}</div>
      )}

      {!providerConfigured && isAdmin && (
        <div className="rounded-xl border border-amber-400/25 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
          Configure the external request-provider URL in Admin → Plugins. Approved requests will stay queued until then.
        </div>
      )}

      {view === 'discover' && (
        <div className="grid gap-5 lg:grid-cols-[280px_1fr]">
          <section className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
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
                  className={`w-full rounded-xl px-3 py-2.5 text-left transition ${artist?.musicBrainzId === item.musicBrainzId ? 'bg-cyan-500/15 text-cyan-200' : 'hover:bg-white/[0.06]'}`}
                >
                  <div className="truncate text-sm font-medium">{item.name}</div>
                  <div className="mt-0.5 text-xs text-white/40">{formatCount(item.albumCount, 'album')} · {formatCount(item.trackCount, 'track')}</div>
                </button>
              ))}
              {!loading && artists.length === 0 && <p className="py-8 text-center text-sm text-white/40">No tagged artists found.</p>}
            </div>
          </section>

          <section className="rounded-2xl border border-white/10 bg-white/[0.04] p-4 sm:p-5">
            {!artist && <p className="py-20 text-center text-white/45">Choose a local artist to compare their releases.</p>}
            {artist && (
              <>
                <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <h4 className="text-lg font-semibold">{artist.name}</h4>
                    <p className="text-sm text-white/45">{catalog.length} releases · {missingCount} missing</p>
                  </div>
                  <a
                    href={`https://musicbrainz.org/artist/${artist.musicBrainzId}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-cyan-300 hover:text-cyan-200"
                  >
                    Open in MusicBrainz ↗
                  </a>
                </div>
                {loading && catalog.length === 0 && <div className="flex justify-center py-20"><Spinner /></div>}
                <div className="space-y-2">
                  {catalog.map((group) => {
                    const detail = tracks[group.id];
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
                              {[group.primaryType, group.firstReleaseDate?.slice(0, 4)].filter(Boolean).join(' · ')}
                            </div>
                          </div>
                          <div className="flex gap-2">
                            {group.present && (
                              <button
                                onClick={() => void inspectTracks(group)}
                                disabled={busyKey === `tracks:${group.id}`}
                                className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/70 hover:bg-white/10 disabled:opacity-50"
                              >
                                {busyKey === `tracks:${group.id}` ? 'Checking…' : expanded === group.id ? 'Hide tracks' : 'Check tracks'}
                              </button>
                            )}
                            {!group.present && (
                              <button
                                onClick={() => void requestAlbum(group)}
                                disabled={busyKey === `album:${group.id}`}
                                className="rounded-lg bg-cyan-500 px-3 py-1.5 text-xs font-semibold text-black hover:bg-cyan-400 disabled:opacity-50"
                              >
                                {busyKey === `album:${group.id}` ? 'Requesting…' : 'Request album'}
                              </button>
                            )}
                          </div>
                        </div>
                        {expanded === group.id && detail && (
                          <div className="border-t border-white/10 px-3 py-2">
                            {detail.tracks.map((track, index) => (
                              <div key={`${track.recordingId ?? track.title}:${index}`} className="flex items-center gap-3 border-b border-white/[0.06] py-2 last:border-0">
                                <span className="w-8 text-right text-xs text-white/35">{track.number ?? track.trackNumber ?? index + 1}</span>
                                <span className="min-w-0 flex-1 truncate text-sm text-white/75">{track.title}</span>
                                <span className="text-xs text-white/35">{formatDuration(track.durationMs)}</span>
                                {track.missing ? (
                                  <button
                                    onClick={() => void requestTrack(group, track)}
                                    disabled={!track.recordingId || busyKey === `track:${track.recordingId}`}
                                    className="rounded-md bg-amber-400/15 px-2.5 py-1 text-xs text-amber-200 hover:bg-amber-400/25 disabled:opacity-40"
                                  >
                                    Request
                                  </button>
                                ) : (
                                  <span className="px-2.5 text-xs text-emerald-300/70">Present</span>
                                )}
                              </div>
                            ))}
                            {!detail.tracks.length && <p className="py-4 text-center text-sm text-white/40">No track list available.</p>}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
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
              <p className="mt-1 text-sm text-white/45">Downloads and delivery are handled entirely by the external service.</p>
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
                      <span className={`rounded-full border px-2 py-0.5 text-[11px] capitalize ${statusClasses(request.status)}`}>{request.status}</span>
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

'use client';

import { useEffect, useRef, useState } from 'react';
import { apiFetch } from './apiClient';
import { useAuth } from './store';
import { useToastStore } from './Toast';

type Song = {
  recordingId: string; title: string; artist: string; album: string | null;
  version?: string | null;
  musicBrainzArtistId: string; musicBrainzReleaseGroupId: string | null; musicBrainzReleaseId: string | null;
  present: boolean; requested: boolean;
};

export function MissingSongSearch({ query }: { query: string }) {
  const token = useAuth(state => state.token);
  const [enabled, setEnabled] = useState(false);
  const [songs, setSongs] = useState<Song[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const pendingIds = useRef(new Set<string>());
  const generation = useRef(0);
  const search = query.trim().replace(/\s+/g, ' ');
  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    setEnabled(false);
    void apiFetch('/plugins/missing-music/status', { signal: controller.signal }, token)
      .then(data => { if (!controller.signal.aborted) setEnabled(data.enabled === true); })
      .catch(() => {});
    return () => controller.abort();
  }, [token]);

  useEffect(() => {
    const current = ++generation.current;
    setSongs([]); setError(null); setLoading(false);
    if (!token || !enabled || search.length < 3 || search.length > 200) return;
    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      void apiFetch(`/plugins/missing-music/songs/search?q=${encodeURIComponent(search)}`, { signal: controller.signal }, token)
        .then(data => {
          if (controller.signal.aborted || current !== generation.current) return;
          if (data.enabled === false) setEnabled(false);
          setSongs(data.songs ?? []);
        }).catch(() => {
          if (!controller.signal.aborted && current === generation.current) setError('Could not check for missing songs.');
        }).finally(() => { if (!controller.signal.aborted && current === generation.current) setLoading(false); });
    }, 750);
    return () => { clearTimeout(timer); controller.abort(); generation.current = current + 1; };
  }, [token, enabled, search, retry]);

  async function requestSong(song: Song) {
    if (!token || pendingIds.current.has(song.recordingId)) return;
    const current = generation.current;
    pendingIds.current.add(song.recordingId); setPending(new Set(pendingIds.current));
    try {
      await apiFetch('/plugins/missing-music/requests', { method: 'POST', body: JSON.stringify({
        itemType: 'track', title: song.title, artist: song.artist, album: song.album,
        musicBrainzArtistId: song.musicBrainzArtistId, musicBrainzRecordingId: song.recordingId,
        musicBrainzReleaseGroupId: song.musicBrainzReleaseGroupId, musicBrainzReleaseId: song.musicBrainzReleaseId,
      }) }, token);
      if (current === generation.current) setSongs(items => items.map(item => item.recordingId === song.recordingId ? { ...item, requested: true } : item));
      useToastStore.getState().show(`Requested ${song.title}. Administrators have been notified.`, 'success');
    } catch (error: any) {
      if (error?.status === 409 && current === generation.current) {
        setSongs(items => items.map(item => item.recordingId === song.recordingId ? { ...item, present: error.data?.present === true, requested: error.data?.present !== true } : item));
      }
      useToastStore.getState().show(error?.data?.error || 'Could not request this song. Please try again.', 'error');
    } finally {
      pendingIds.current.delete(song.recordingId); setPending(new Set(pendingIds.current));
    }
  }

  if (!enabled || search.length < 3 || search.length > 200) return null;
  return <section aria-label="Missing songs" className="border-t border-white/10 px-5 py-4">
    <h3 className="text-sm font-semibold text-white">Missing songs</h3>
    <p className="mt-1 text-xs text-slate-400">MusicBrainz matches. Request a song for administrators to add to the library.</p>
    {loading ? <p role="status" className="py-3 text-sm text-slate-400">Checking song availability…</p> : error ?
      <div role="alert" className="py-3 text-sm text-slate-400">{error} <button type="button" onClick={() => setRetry(value => value + 1)} className="min-h-11 px-3 text-cyan-400">Retry</button></div> :
      songs.length === 0 ? <p className="py-3 text-sm text-slate-400">No catalog matches. Try the song title and artist.</p> :
      <ul className="mt-2 space-y-1">{songs.map(song => <li key={song.recordingId} className="flex items-center gap-3 rounded-lg bg-white/[0.03] p-3">
        <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium text-white" title={song.title}>{song.title}</p>
          <p className="truncate text-xs text-slate-400" title={`${song.artist}${song.album ? ` • ${song.album}` : ''}`}>{song.artist}{song.album ? ` • ${song.album}` : ''}</p>
          {song.version && <p className="mt-1 text-xs text-slate-400">{song.version}</p>}</div>
        {song.present ? <span className="shrink-0 text-xs text-emerald-400">In library</span> : song.requested ?
          <span className="shrink-0 text-xs text-cyan-400">Requested</span> :
          <button type="button" aria-label={`Request ${song.title} by ${song.artist}${song.version ? ` (${song.version})` : ''}`} disabled={pending.has(song.recordingId)}
            onClick={() => void requestSong(song)} className="min-h-11 shrink-0 rounded-lg bg-cyan-500/15 px-3 text-sm font-semibold text-cyan-300 hover:bg-cyan-500/25 disabled:opacity-50">
            {pending.has(song.recordingId) ? 'Requesting…' : 'Request song'}
          </button>}
      </li>)}</ul>}
  </section>;
}

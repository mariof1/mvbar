'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from './store';
import { usePlayer, type QueueTrack } from './playerStore';
import { listPlaylists, createPlaylist, addTracksToPlaylist } from './apiClient';
import { useToastStore } from './Toast';

export type AddMenuTrack = QueueTrack;

type Playlist = { id: string; name: string };

interface AddMenuProps {
  // Returns the tracks this menu acts upon. Async so we can lazily fetch
  // album/artist tracks only when the menu is opened.
  getTracks: () => Promise<AddMenuTrack[]> | AddMenuTrack[];
  // Used for toast wording, e.g. "album", "artist", "track".
  label?: string;
  // For grids: a smaller, more subtle trigger floating in the corner.
  variant?: 'default' | 'subtle';
  // Optional extra classes on the trigger button.
  className?: string;
  // Title for the trigger.
  title?: string;
  // Stop click propagation on trigger (used inside clickable cards/rows).
  stopPropagation?: boolean;
}

export function AddMenu({
  getTracks,
  label = 'tracks',
  variant = 'default',
  className,
  title = 'Add to...',
  stopPropagation = true,
}: AddMenuProps) {
  const token = useAuth((s) => s.token);
  const clear = useAuth((s) => s.clear);
  const player = usePlayer();
  const showToast = useToastStore((s) => s.show);

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [plistOpen, setPlistOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);

  const resolveTracks = useCallback(async (): Promise<AddMenuTrack[]> => {
    const r = getTracks();
    return r instanceof Promise ? await r : r;
  }, [getTracks]);

  const computeCoords = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const menuW = 224;
    const menuH = 200;
    let left = rect.right - menuW;
    let top = rect.bottom + 6;
    if (left < 8) left = 8;
    if (left + menuW > window.innerWidth - 8) left = window.innerWidth - menuW - 8;
    if (top + menuH > window.innerHeight - 8) top = rect.top - menuH - 6;
    setCoords({ top, left });
  }, []);

  useEffect(() => {
    if (!open) return;
    computeCoords();
    const onScroll = () => computeCoords();
    const onResize = () => computeCoords();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, computeCoords]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        setPlistOpen(false);
        setCreating(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const loadPlaylists = useCallback(async () => {
    if (!token) return;
    try {
      const r = await listPlaylists(token);
      setPlaylists((r.playlists ?? []).map((p) => ({ id: String(p.id), name: p.name })));
    } catch (e: any) {
      if (e?.status === 401) clear();
    }
  }, [token, clear]);

  const handleTrigger = (e: React.MouseEvent) => {
    if (stopPropagation) e.stopPropagation();
    e.preventDefault();
    setOpen((v) => !v);
  };

  const doPlayNext = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const tracks = await resolveTracks();
      if (tracks.length === 0) {
        showToast('No tracks to add', 'error');
      } else if (tracks.length === 1) {
        player.playNext(tracks[0]);
      } else {
        player.playNextMany(tracks);
      }
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  const doAddToQueue = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const tracks = await resolveTracks();
      if (tracks.length === 0) {
        showToast('No tracks to add', 'error');
      } else if (tracks.length === 1) {
        player.addToQueue(tracks[0]);
      } else {
        player.addManyToQueue(tracks);
      }
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  const openPlaylistSubmenu = async () => {
    setPlistOpen(true);
    await loadPlaylists();
  };

  const doAddToPlaylist = async (playlistId: string, playlistName: string) => {
    if (busy || !token) return;
    setBusy(true);
    try {
      const tracks = await resolveTracks();
      if (tracks.length === 0) {
        showToast('No tracks to add', 'error');
        return;
      }
      await addTracksToPlaylist(token, playlistId, tracks.map((t) => t.id));
      showToast(
        `Added ${tracks.length} ${tracks.length === 1 ? 'track' : 'tracks'} to "${playlistName}"`,
        'success'
      );
    } catch (e: any) {
      if (e?.status === 401) clear();
      showToast('Failed to add to playlist', 'error');
    } finally {
      setBusy(false);
      setOpen(false);
      setPlistOpen(false);
    }
  };

  const doCreateAndAdd = async () => {
    if (busy || !token) return;
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const tracks = await resolveTracks();
      if (tracks.length === 0) {
        showToast('No tracks to add', 'error');
        return;
      }
      const r = await createPlaylist(token, name);
      const id = String(r.playlist.id);
      await addTracksToPlaylist(token, id, tracks.map((t) => t.id));
      showToast(
        `Created "${name}" with ${tracks.length} ${tracks.length === 1 ? 'track' : 'tracks'}`,
        'success'
      );
    } catch (e: any) {
      if (e?.status === 401) clear();
      showToast('Failed to create playlist', 'error');
    } finally {
      setBusy(false);
      setOpen(false);
      setPlistOpen(false);
      setCreating(false);
      setNewName('');
    }
  };

  const triggerClass =
    variant === 'subtle'
      ? `w-7 h-7 rounded-full bg-black/60 hover:bg-black/80 backdrop-blur-sm flex items-center justify-center text-white shadow-md ${className ?? ''}`
      : `p-2 rounded-lg hover:bg-slate-700/50 text-slate-300 transition-colors ${className ?? ''}`;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={handleTrigger}
        className={triggerClass}
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <svg
          className={variant === 'subtle' ? 'w-4 h-4' : 'w-5 h-5'}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M12 6v12m6-6H6" />
        </svg>
      </button>

      {open && coords &&
        createPortal(
          <>
            <div
              className="fixed inset-0 z-[299]"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                setPlistOpen(false);
                setCreating(false);
              }}
              onMouseDown={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
            />
            <div
              ref={menuRef}
              role="menu"
              className="fixed z-[300] w-56 rounded-xl bg-slate-900/95 backdrop-blur-md border border-white/10 shadow-2xl shadow-black/60 py-1 text-sm text-white"
              style={{ top: coords.top, left: coords.left }}
              onClick={(e) => e.stopPropagation()}
            >
            {!plistOpen ? (
              <>
                <button
                  type="button"
                  onClick={doPlayNext}
                  disabled={busy}
                  className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-white/10 disabled:opacity-50 text-left"
                >
                  <svg className="w-4 h-4 text-cyan-400" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M4 5v14l8-7zM14 5h2v14h-2z" />
                  </svg>
                  Play next
                </button>
                <button
                  type="button"
                  onClick={doAddToQueue}
                  disabled={busy}
                  className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-white/10 disabled:opacity-50 text-left"
                >
                  <svg className="w-4 h-4 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7" />
                  </svg>
                  Add to queue
                </button>
                <div className="my-1 h-px bg-white/10" />
                <button
                  type="button"
                  onClick={openPlaylistSubmenu}
                  disabled={busy}
                  className="w-full flex items-center justify-between gap-2.5 px-3 py-2 hover:bg-white/10 disabled:opacity-50 text-left"
                >
                  <span className="flex items-center gap-2.5">
                    <svg className="w-4 h-4 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M9 13h6m-3-3v6m-9 1V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
                    </svg>
                    Add to playlist
                  </span>
                  <svg className="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2 px-3 py-2 border-b border-white/10">
                  <button
                    type="button"
                    onClick={() => { setPlistOpen(false); setCreating(false); }}
                    className="p-1 -ml-1 rounded hover:bg-white/10"
                    title="Back"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                  </button>
                  <span className="text-xs uppercase tracking-wider text-slate-400">Add to playlist</span>
                </div>
                <div className="max-h-56 overflow-y-auto py-1">
                  {playlists.length === 0 && (
                    <div className="px-3 py-2 text-slate-500 text-xs">No playlists yet</div>
                  )}
                  {playlists.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => doAddToPlaylist(p.id, p.name)}
                      disabled={busy}
                      className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-white/10 disabled:opacity-50 text-left"
                    >
                      <svg className="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                          d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2z" />
                      </svg>
                      <span className="truncate">{p.name}</span>
                    </button>
                  ))}
                </div>
                <div className="border-t border-white/10 p-2">
                  {!creating ? (
                    <button
                      type="button"
                      onClick={() => setCreating(true)}
                      className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded hover:bg-white/10 text-left text-cyan-400"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v12m6-6H6" />
                      </svg>
                      New playlist...
                    </button>
                  ) : (
                    <div className="flex items-center gap-2">
                      <input
                        autoFocus
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') doCreateAndAdd(); }}
                        placeholder="Playlist name"
                        className="flex-1 min-w-0 px-2 py-1.5 rounded bg-slate-800 border border-white/10 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                      />
                      <button
                        type="button"
                        onClick={doCreateAndAdd}
                        disabled={busy || !newName.trim()}
                        className="px-2 py-1.5 rounded bg-cyan-500 hover:bg-cyan-400 text-white text-xs font-medium disabled:opacity-50"
                      >
                        Create
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}
            </div>
          </>,
          document.body
        )}
    </>
  );
}

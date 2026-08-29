'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  addPlaylistCollaborator,
  addTrackToPlaylist,
  createPlaylist,
  deletePlaylist,
  getPlaylistCollaborators,
  getPlaylistItems,
  listPlaylists,
  removePlaylistCollaborator,
  removeTrackFromPlaylist,
  renamePlaylist,
  setPlaylistItemPosition,
  type Playlist,
  type PlaylistCollaboration,
  type SocialUser,
} from './apiClient';
import { useAuth } from './store';
import { SmartPlaylists } from './SmartPlaylists';
import { useRouter } from './router';
import { showConfirm } from './ConfirmModal';
import { usePlaylistUpdates, useLibraryUpdates } from './useWebSocket';
import { useToastStore } from './Toast';

type PlaylistTab = 'regular' | 'smart';

type PlaylistItem = {
  id: string;
  track_id: string;
  position: number;
  title: string | null;
  artist: string | null;
  album: string | null;
  duration_ms: number | null;
  added_at: string;
  added_by: SocialUser | null;
};

function Avatar({ user }: { user: SocialUser }) {
  if (user.avatarPath) {
    return <img src={`/api/avatars/${user.avatarPath}`} alt="" className="h-8 w-8 flex-none rounded-full object-cover" />;
  }
  return (
    <div className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-gradient-to-br from-cyan-500 to-blue-600 text-xs font-bold text-white">
      {user.email.charAt(0).toUpperCase()}
    </div>
  );
}

function swap<T>(arr: T[], i: number, j: number) {
  const next = arr.slice();
  const tmp = next[i];
  next[i] = next[j];
  next[j] = tmp;
  return next;
}

export function Playlists(props: {
  onPlayTrack?: (t: { id: number; title: string | null; artist: string | null }) => void;
  onPlayAll?: (tracks: Array<{ id: number; title: string | null; artist: string | null }>) => void;
}) {
  const token = useAuth((s) => s.token);
  const clear = useAuth((s) => s.clear);
  const showToast = useToastStore((s) => s.show);
  
  // Navigation using new router
  const route = useRouter((s) => s.route);
  const navigate = useRouter((s) => s.navigate);
  const back = useRouter((s) => s.back);
  
  // Derive state from route
  const tab = (route.type === 'playlists' && route.sub ? route.sub : 'regular') as PlaylistTab;
  const selectedId = route.type === 'playlist' ? route.playlistId : null;

  const [pls, setPls] = useState<Playlist[]>([]);
  const [items, setItems] = useState<PlaylistItem[]>([]);
  const [name, setName] = useState('');
  const [addTrackId, setAddTrackId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [playlistsLoaded, setPlaylistsLoaded] = useState(false);
  const [collaboration, setCollaboration] = useState<PlaylistCollaboration | null>(null);
  const [showCollaborators, setShowCollaborators] = useState(false);
  const [collaboratorBusy, setCollaboratorBusy] = useState<string | null>(null);

  // Live updates
  const playlistLastUpdate = usePlaylistUpdates((s) => s.lastUpdate);
  const playlistLastEvent = usePlaylistUpdates((s) => s.lastEvent);
  const lastLibraryUpdate = useLibraryUpdates((s) => s.lastUpdate);

  // Wrapper to select playlist with router
  const selectPlaylist = useCallback((id: string) => {
    navigate({ type: 'playlist', playlistId: id });
  }, [navigate]);

  // Wrapper to go back to list
  const goBackToList = useCallback(() => {
    back();
  }, [back]);

  // Switch tab with router
  const switchTab = useCallback((newTab: PlaylistTab) => {
    if (newTab === tab) return;
    navigate({ type: 'playlists', sub: newTab });
  }, [tab, navigate]);

  async function refreshPlaylists() {
    if (!token) return;
    try {
      const r = await listPlaylists(token);
      setPls(r.playlists ?? []);
    } catch (e: any) {
      if (e?.status === 401) clear();
      setError(e?.message ?? 'error');
    } finally {
      setPlaylistsLoaded(true);
    }
  }

  async function refreshItems(id: string) {
    if (!token) return;
    try {
      const r = await getPlaylistItems(token, id);
      setItems(r.items ?? []);
    } catch (e: any) {
      if (e?.status === 401) clear();
      setError(e?.message ?? 'error');
    }
  }

  async function refreshCollaboration(id: string) {
    if (!token) return;
    try {
      setCollaboration(await getPlaylistCollaborators(token, id));
    } catch (e: any) {
      if (e?.status === 401) clear();
      else if (e?.status === 404) setCollaboration(null);
    }
  }

  useEffect(() => {
    if (!token) return;
    refreshPlaylists();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    if (!selectedId) return;
    refreshItems(selectedId);
    refreshCollaboration(selectedId);
    setShowCollaborators(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, token]);

  useEffect(() => {
    if (!selectedId || !playlistsLoaded) return;
    if (!pls.some((playlist) => String(playlist.id) === selectedId)) {
      navigate({ type: 'playlists', sub: 'regular' }, true);
    }
  }, [selectedId, playlistsLoaded, pls, navigate]);

  // Live updates: refresh playlists list when a playlist is created
  useEffect(() => {
    if (!playlistLastUpdate || !token) return;
    refreshPlaylists();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playlistLastUpdate]);

  // Live updates: refresh items when current playlist is modified
  useEffect(() => {
    if (!playlistLastEvent || !selectedId || !token) return;
    const eventPlaylistId = playlistLastEvent.playlistId ?? playlistLastEvent.id;
    if (eventPlaylistId && String(eventPlaylistId) === selectedId) {
      refreshItems(selectedId);
      refreshCollaboration(selectedId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playlistLastEvent, selectedId]);

  // Live updates: refresh items when library changes (track metadata updates)
  useEffect(() => {
    if (!lastLibraryUpdate || !selectedId || !token) return;
    refreshItems(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastLibraryUpdate, selectedId]);

  async function handleCreate() {
    if (!token) return;
    setError(null);
    const n = name.trim();
    if (!n) return;
    try {
      await createPlaylist(token, n);
      setName('');
      await refreshPlaylists();
    } catch (e: any) {
      if (e?.status === 401) clear();
      setError(e?.data?.error ?? e?.message ?? 'error');
    }
  }

  async function handleDelete(id: string) {
    if (!token) return;
    const ok = await showConfirm({ title: 'Delete Playlist', message: 'Delete this playlist? This cannot be undone.', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      await deletePlaylist(token, Number(id));
      await refreshPlaylists();
    } catch (e: any) {
      if (e?.status === 401) clear();
    }
  }

  function startRename(p: Playlist) {
    setRenamingId(p.id);
    setRenameValue(p.name);
  }

  function cancelRename() {
    setRenamingId(null);
    setRenameValue('');
  }

  async function commitRename(id: string) {
    if (!token) return;
    const n = renameValue.trim();
    if (!n) { cancelRename(); return; }
    try {
      await renamePlaylist(token, Number(id), n);
      setRenamingId(null);
      setRenameValue('');
      await refreshPlaylists();
    } catch (e: any) {
      if (e?.status === 401) clear();
      setError(e?.data?.error ?? e?.message ?? 'error');
    }
  }

  async function handleAddTrack() {
    if (!token || !selectedId) return;
    setError(null);
    const tid = Number(addTrackId);
    if (!Number.isFinite(tid)) return;
    try {
      await addTrackToPlaylist(token, selectedId, tid);
      setAddTrackId('');
      await refreshItems(selectedId);
    } catch (e: any) {
      if (e?.status === 401) clear();
      setError(e?.data?.error ?? e?.message ?? 'error');
    }
  }

  async function handleRemove(trackId: number) {
    if (!token || !selectedId) return;
    setError(null);
    try {
      await removeTrackFromPlaylist(token, selectedId, trackId);
      await refreshItems(selectedId);
    } catch (e: any) {
      if (e?.status === 401) clear();
      setError(e?.data?.error ?? e?.message ?? 'error');
    }
  }

  async function handleMove(trackId: number, direction: -1 | 1) {
    if (!token || !selectedId) return;
    const idx = items.findIndex((it) => Number(it.track_id) === trackId);
    const j = idx + direction;
    if (idx < 0 || j < 0 || j >= items.length) return;

    // optimistic reorder
    const nextItems = swap(items, idx, j).map((it, k) => ({ ...it, position: k }));
    setItems(nextItems);

    try {
      // persist positions (two updates)
      await setPlaylistItemPosition(token, selectedId, Number(nextItems[idx].track_id), nextItems[idx].position);
      await setPlaylistItemPosition(token, selectedId, Number(nextItems[j].track_id), nextItems[j].position);
      await refreshItems(selectedId);
    } catch (e: any) {
      if (e?.status === 401) clear();
      setError(e?.data?.error ?? e?.message ?? 'error');
      await refreshItems(selectedId);
    }
  }

  async function handleAddCollaborator(user: SocialUser) {
    if (!token || !selectedId || collaboratorBusy) return;
    setCollaboratorBusy(user.id);
    try {
      await addPlaylistCollaborator(token, selectedId, user.id);
      showToast(`${user.email} can now contribute`, 'success');
      await Promise.all([refreshCollaboration(selectedId), refreshPlaylists()]);
    } catch (e: any) {
      if (e?.status === 401) clear();
      else showToast('Could not add that collaborator', 'error');
    } finally {
      setCollaboratorBusy(null);
    }
  }

  async function handleRemoveCollaborator(user: SocialUser) {
    if (!token || !selectedId || collaboratorBusy) return;
    const confirmed = await showConfirm({
      title: 'Remove collaborator',
      message: `Remove ${user.email} from this playlist?`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!confirmed) return;
    setCollaboratorBusy(user.id);
    try {
      await removePlaylistCollaborator(token, selectedId, user.id);
      showToast('Collaborator removed', 'success');
      await Promise.all([refreshCollaboration(selectedId), refreshPlaylists()]);
    } catch (e: any) {
      if (e?.status === 401) clear();
      else showToast('Could not remove that collaborator', 'error');
    } finally {
      setCollaboratorBusy(null);
    }
  }

  async function handleLeavePlaylist() {
    if (!token || !selectedId || !collaboration || collaboration.isOwner || collaboratorBusy) return;
    const confirmed = await showConfirm({
      title: 'Leave shared playlist',
      message: `Leave “${selectedPlaylist?.name ?? 'this playlist'}”?`,
      confirmLabel: 'Leave',
      danger: true,
    });
    if (!confirmed) return;
    setCollaboratorBusy('leave');
    try {
      const currentUserId = useAuth.getState().user?.id;
      if (!currentUserId) throw new Error('No current user');
      await removePlaylistCollaborator(token, selectedId, currentUserId);
      showToast('You left the shared playlist', 'success');
      navigate({ type: 'playlists', sub: 'regular' }, true);
      await refreshPlaylists();
    } catch (e: any) {
      if (e?.status === 401) clear();
      else showToast('Could not leave this playlist', 'error');
    } finally {
      setCollaboratorBusy(null);
    }
  }

  if (!token) return null;

  const selectedPlaylist = pls.find((playlist) => String(playlist.id) === selectedId);

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Tabs */}
      <div className="flex gap-2">
        <button
          onClick={() => switchTab('regular')}
          className={`px-4 py-2 rounded-lg font-medium transition-colors text-sm sm:text-base ${
            tab === 'regular'
              ? 'bg-cyan-500 text-white'
              : 'bg-slate-800/50 text-slate-400 hover:text-white hover:bg-slate-700/50'
          }`}
        >
          Playlists
        </button>
        <button
          onClick={() => switchTab('smart')}
          className={`px-4 py-2 rounded-lg font-medium transition-colors text-sm sm:text-base ${
            tab === 'smart'
              ? 'bg-purple-500 text-white'
              : 'bg-slate-800/50 text-slate-400 hover:text-white hover:bg-slate-700/50'
          }`}
        >
          Smart Playlists
        </button>
      </div>

      {tab === 'smart' ? (
        <SmartPlaylists onPlayTrack={props.onPlayTrack} onPlayAll={props.onPlayAll} />
      ) : selectedId && selectedPlaylist ? (
        /* Playlist Detail View */
        <div className="space-y-4">
          {/* Back button and header */}
          <div className="flex items-center gap-3">
            <button
              onClick={goBackToList}
              className="p-2 rounded-lg hover:bg-slate-800/50 text-slate-400 hover:text-white transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <div className="flex-1 min-w-0">
              <h2 className="text-xl font-bold text-white truncate">{selectedPlaylist.name}</h2>
              <p className="text-sm text-slate-400">{items.length} tracks</p>
            </div>
            <button
              onClick={() =>
                props.onPlayAll?.(
                  items.map((it) => ({ id: Number(it.track_id), title: it.title, artist: it.artist }))
                )
              }
              disabled={items.length === 0}
              className={`p-3 rounded-full transition-colors ${
                items.length > 0
                  ? 'bg-cyan-500 hover:bg-cyan-400 text-white'
                  : 'bg-slate-700 text-slate-500 cursor-not-allowed'
              }`}
            >
              <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
            </button>
          </div>

          {collaboration && (
            <div className="rounded-xl border border-white/10 bg-slate-900/40 p-3 sm:p-4">
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex -space-x-2">
                  <div className="relative z-10 rounded-full ring-2 ring-slate-900" title={`Owner: ${collaboration.owner.email}`}>
                    <Avatar user={collaboration.owner} />
                  </div>
                  {collaboration.collaborators.slice(0, 3).map((member) => (
                    <div key={member.user.id} className="rounded-full ring-2 ring-slate-900" title={member.user.email}>
                      <Avatar user={member.user} />
                    </div>
                  ))}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-white">
                    {collaboration.isOwner ? 'Your playlist' : `Shared by ${collaboration.owner.email}`}
                  </p>
                  <p className="text-xs text-slate-400">
                    {collaboration.collaborators.length === 0
                      ? 'Private — invite friends to build it together'
                      : `${collaboration.collaborators.length} ${collaboration.collaborators.length === 1 ? 'collaborator' : 'collaborators'} can add, remove and reorder songs`}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowCollaborators((shown) => !shown)}
                  className="rounded-lg bg-white/10 px-3 py-2 text-xs font-semibold text-slate-200 transition hover:bg-white/15"
                >
                  {showCollaborators ? 'Hide' : collaboration.isOwner ? 'Manage' : 'Members'}
                </button>
                {!collaboration.isOwner && (
                  <button
                    type="button"
                    onClick={handleLeavePlaylist}
                    disabled={collaboratorBusy !== null}
                    className="rounded-lg bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-300 transition hover:bg-red-500/20 disabled:opacity-50"
                  >
                    Leave
                  </button>
                )}
              </div>

              {showCollaborators && (
                <div className="mt-4 grid gap-4 border-t border-white/10 pt-4 lg:grid-cols-2">
                  <div>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">Members</h3>
                    <div className="space-y-2">
                      <div className="flex items-center gap-3 rounded-lg bg-white/[0.035] p-2.5">
                        <Avatar user={collaboration.owner} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm text-white">{collaboration.owner.email}</p>
                          <p className="text-xs text-cyan-400">Owner</p>
                        </div>
                      </div>
                      {collaboration.collaborators.map((member) => (
                        <div key={member.user.id} className="flex items-center gap-3 rounded-lg bg-white/[0.035] p-2.5">
                          <Avatar user={member.user} />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm text-white">{member.user.email}</p>
                            <p className="text-xs text-slate-500">Collaborator</p>
                          </div>
                          {collaboration.isOwner && (
                            <button
                              type="button"
                              onClick={() => handleRemoveCollaborator(member.user)}
                              disabled={collaboratorBusy !== null}
                              className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-red-300 transition hover:bg-red-500/10 disabled:opacity-50"
                            >
                              Remove
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>

                  {collaboration.isOwner && (
                    <div>
                      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">Invite friends</h3>
                      {collaboration.eligibleFriends.length > 0 ? (
                        <div className="max-h-52 space-y-2 overflow-y-auto">
                          {collaboration.eligibleFriends.map((friend) => (
                            <div key={friend.id} className="flex items-center gap-3 rounded-lg bg-white/[0.035] p-2.5">
                              <Avatar user={friend} />
                              <p className="min-w-0 flex-1 truncate text-sm text-white">{friend.email}</p>
                              <button
                                type="button"
                                onClick={() => handleAddCollaborator(friend)}
                                disabled={collaboratorBusy !== null}
                                className="rounded-lg bg-cyan-500 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-cyan-400 disabled:opacity-50"
                              >
                                {collaboratorBusy === friend.id ? 'Adding…' : 'Add'}
                              </button>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="rounded-lg bg-white/[0.025] p-3 text-sm text-slate-500">
                          All of your friends are already members, or you have no accepted friends yet.
                        </p>
                      )}
                    </div>
                  )}
                  <p className="text-xs text-slate-500 lg:col-span-2">
                    Each person only sees and contributes songs from music libraries they are allowed to access.
                  </p>
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-sm">
              {error}
            </div>
          )}

          {/* Track List */}
          <div className="space-y-1">
            {items.map((it, idx) => (
              <div
                key={it.track_id}
                className="group flex items-center gap-2 sm:gap-3 p-2 sm:p-3 rounded-lg hover:bg-slate-800/50 transition-colors"
              >
                {/* Play button - always visible on mobile */}
                <button
                  onClick={() => props.onPlayTrack?.({ id: Number(it.track_id), title: it.title, artist: it.artist })}
                  className="w-8 h-8 flex items-center justify-center flex-shrink-0 text-cyan-400"
                >
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </button>

                {/* Track Info */}
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-white truncate text-sm sm:text-base">{it.title ?? `Track #${it.track_id}`}</div>
                  <div className="text-xs sm:text-sm text-slate-400 truncate">
                    {[it.artist, it.album].filter(Boolean).join(' • ') || 'Unknown'}
                  </div>
                  {selectedPlaylist.is_collaborative && it.added_by && (
                    <div className="mt-0.5 truncate text-[11px] text-slate-500">Added by {it.added_by.email}</div>
                  )}
                </div>

                {/* Actions - always visible on mobile, hover on desktop */}
                <div className="flex items-center gap-0.5 sm:gap-1 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => handleMove(Number(it.track_id), -1)}
                    disabled={idx === 0}
                    className={`p-1.5 rounded-lg transition-colors ${
                      idx === 0 ? 'text-slate-600' : 'text-slate-400 hover:text-white hover:bg-slate-700/50'
                    }`}
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                    </svg>
                  </button>
                  <button
                    onClick={() => handleMove(Number(it.track_id), 1)}
                    disabled={idx === items.length - 1}
                    className={`p-1.5 rounded-lg transition-colors ${
                      idx === items.length - 1 ? 'text-slate-600' : 'text-slate-400 hover:text-white hover:bg-slate-700/50'
                    }`}
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                  <button
                    onClick={() => handleRemove(Number(it.track_id))}
                    className="p-1.5 rounded-lg text-slate-400 hover:text-red-400 hover:bg-red-500/20 transition-colors"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>
            ))}

            {items.length === 0 && (
              <div className="text-center py-12 text-slate-400">
                <svg className="w-12 h-12 mx-auto mb-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
                </svg>
                <p>Empty playlist</p>
                <p className="text-sm mt-1">Add tracks from search or browse</p>
              </div>
            )}
          </div>
        </div>
      ) : (
        /* Playlists List View */
        <div className="space-y-4">
          {error && (
            <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-sm">
              {error}
            </div>
          )}

          {/* Create Playlist - stacked on mobile */}
          <div className="flex flex-col sm:flex-row gap-2 sm:gap-3">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              placeholder="New playlist name..."
              className="flex-1 px-4 py-3 bg-slate-800/50 border border-slate-700/50 rounded-xl text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-transparent transition-all"
            />
            <button
              onClick={handleCreate}
              disabled={!name.trim()}
              className={`px-6 py-3 rounded-xl font-medium transition-colors flex items-center justify-center gap-2 ${
                name.trim()
                  ? 'bg-cyan-500 hover:bg-cyan-400 text-white'
                  : 'bg-slate-700 text-slate-400 cursor-not-allowed'
              }`}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
              </svg>
              Create
            </button>
          </div>

          {/* Playlists Grid */}
          {pls.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {pls.map((p) => (
                <div key={p.id} className="flex items-center gap-2 p-3 rounded-xl bg-slate-800/30 border border-slate-700/30 hover:bg-slate-800/50 hover:border-slate-600/50 transition-all">
                  {renamingId === p.id ? (
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <div className="w-10 h-10 bg-gradient-to-br from-cyan-500 to-blue-600 rounded-lg flex items-center justify-center flex-shrink-0">
                        <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
                        </svg>
                      </div>
                      <div className="min-w-0 flex-1">
                        <input
                          autoFocus
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); commitRename(p.id); }
                            else if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
                          }}
                          onBlur={() => commitRename(p.id)}
                          className="w-full bg-slate-900/60 border border-cyan-500/40 rounded px-2 py-1 text-white text-sm focus:outline-none focus:ring-1 focus:ring-cyan-400"
                        />
                        <div className="text-sm text-slate-400">
                          {new Date(p.created_at).toLocaleDateString()}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => selectPlaylist(p.id)}
                      className="flex items-center gap-3 flex-1 min-w-0 text-left"
                    >
                      <div className="w-10 h-10 bg-gradient-to-br from-cyan-500 to-blue-600 rounded-lg flex items-center justify-center flex-shrink-0">
                        <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
                        </svg>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <div className="truncate font-medium text-white">{p.name}</div>
                          {p.is_collaborative && (
                            <span className="flex-none rounded-full bg-cyan-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-cyan-300">
                              Collab
                            </span>
                          )}
                        </div>
                        <div className="truncate text-sm text-slate-400">
                          {p.is_owner ? `${p.item_count ?? 0} tracks` : `${p.owner?.email ?? 'Friend'} • ${p.item_count ?? 0} tracks`}
                        </div>
                      </div>
                    </button>
                  )}
                  {p.is_owner && (
                    <>
                      <button
                        onClick={(e) => { e.stopPropagation(); startRename(p); }}
                        className="p-2 text-slate-400 hover:text-cyan-400 hover:bg-cyan-500/10 rounded-lg transition-colors flex-shrink-0"
                        title="Rename playlist"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                      </button>
                      <button
                        onClick={() => handleDelete(p.id)}
                        className="p-2 text-slate-400 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors flex-shrink-0"
                        title="Delete playlist"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-16 text-slate-400">
              <svg className="w-16 h-16 mx-auto mb-4 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
              </svg>
              <p className="text-lg">No playlists yet</p>
              <p className="text-sm mt-1">Create your first playlist above</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

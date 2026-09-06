'use client';

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { getShareTargets, shareTrack, type SocialUser } from './apiClient';
import { useAuth } from './store';
import { useToastStore } from './Toast';
import { useRouter } from './router';
import { useSocialUpdates } from './socialStore';
import type { QueueTrack } from './playerStore';
import { useBodyScrollLock } from './useBodyScrollLock';
import { trackArtistLabel } from './artistDisplay';

function Avatar({ user }: { user: SocialUser }) {
  if (user.avatarPath) {
    return <img src={`/api/avatars/${user.avatarPath}`} alt="" className="h-10 w-10 rounded-full object-cover" />;
  }
  return (
    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-cyan-500 to-blue-600 text-sm font-bold text-white">
      {user.email.charAt(0).toUpperCase()}
    </div>
  );
}

export function ShareTrackDialog({ track, onClose }: { track: QueueTrack | null; onClose: () => void }) {
  const token = useAuth((state) => state.token);
  const clear = useAuth((state) => state.clear);
  const showToast = useToastStore((state) => state.show);
  const navigate = useRouter((state) => state.navigate);
  const refreshSocial = useSocialUpdates((state) => state.refresh);
  const [friends, setFriends] = useState<Array<SocialUser & { canAccess: boolean }>>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useBodyScrollLock(Boolean(track));

  useEffect(() => {
    if (!track || !token) return;
    let active = true;
    setLoading(true);
    setError(null);
    setSelected(new Set());
    setMessage('');
    getShareTargets(token, track.id)
      .then((response) => { if (active) setFriends(response.friends); })
      .catch((reason: any) => {
        if (!active) return;
        if (reason?.status === 401) clear();
        setError('Could not load your friends.');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [track, token, clear]);

  useEffect(() => {
    if (!track) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [track, onClose]);

  const availableCount = useMemo(() => friends.filter((friend) => friend.canAccess).length, [friends]);

  if (!track || typeof document === 'undefined') return null;

  const toggle = (userId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  const submit = async () => {
    if (!token || selected.size === 0 || sharing) return;
    setSharing(true);
    setError(null);
    try {
      const result = await shareTrack(token, track.id, Array.from(selected), message);
      showToast(`Shared with ${result.shared} ${result.shared === 1 ? 'friend' : 'friends'}`, 'success');
      await refreshSocial(token);
      onClose();
    } catch (reason: any) {
      if (reason?.status === 401) clear();
      setError(reason?.data?.error === 'recipient_unavailable'
        ? 'One of those friends can no longer access this song.'
        : 'Could not share this song. Please try again.');
    } finally {
      setSharing(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[320] flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-track-title"
        className="max-h-[90vh] w-full overflow-hidden rounded-t-2xl border border-white/10 bg-slate-900 shadow-2xl sm:max-w-md sm:rounded-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-white/10 p-4 sm:p-5">
          <div className="min-w-0 pr-4">
            <h2 id="share-track-title" className="text-lg font-bold text-white">Share song</h2>
            <p className="mt-1 truncate text-sm text-slate-300">{track.title || 'Unknown Track'}</p>
            <p className="truncate text-xs text-slate-500">{trackArtistLabel(track)}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-slate-400 hover:bg-white/10 hover:text-white" aria-label="Close">
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="max-h-[55vh] overflow-y-auto p-4 sm:p-5">
          {loading && <p className="py-8 text-center text-sm text-slate-400">Loading friends…</p>}
          {!loading && friends.length === 0 && (
            <div className="py-7 text-center">
              <p className="font-medium text-white">Add a friend first</p>
              <p className="mt-1 text-sm text-slate-400">Friends you add in mvbar will appear here.</p>
              <button
                type="button"
                onClick={() => { onClose(); navigate({ type: 'social', sub: 'friends' }); }}
                className="mt-4 rounded-full bg-cyan-500 px-4 py-2 text-sm font-bold text-white hover:bg-cyan-400"
              >
                Find friends
              </button>
            </div>
          )}
          {!loading && friends.length > 0 && (
            <div className="space-y-2">
              {friends.map((friend) => {
                const checked = selected.has(friend.id);
                return (
                  <button
                    key={friend.id}
                    type="button"
                    disabled={!friend.canAccess}
                    onClick={() => toggle(friend.id)}
                    className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition ${checked
                      ? 'border-cyan-400/70 bg-cyan-500/10'
                      : 'border-white/10 bg-white/[0.03] hover:bg-white/[0.07]'} disabled:cursor-not-allowed disabled:opacity-45`}
                  >
                    <Avatar user={friend} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-white">{friend.email}</p>
                      {!friend.canAccess && <p className="text-xs text-slate-500">No access to this library</p>}
                    </div>
                    <span className={`flex h-5 w-5 items-center justify-center rounded border ${checked ? 'border-cyan-400 bg-cyan-400 text-slate-950' : 'border-slate-500'}`}>
                      {checked && (
                        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {availableCount > 0 && (
            <label className="mt-4 block">
              <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">Message (optional)</span>
              <textarea
                value={message}
                onChange={(event) => setMessage(event.target.value.slice(0, 500))}
                rows={3}
                placeholder="Why do you think they’ll like it?"
                className="w-full resize-none rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white placeholder:text-slate-600 focus:border-cyan-500 focus:outline-none"
              />
              <span className="mt-1 block text-right text-[11px] text-slate-600">{message.length}/500</span>
            </label>
          )}
          {error && <p className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p>}
        </div>

        {friends.length > 0 && (
          <div className="flex items-center justify-end gap-3 border-t border-white/10 p-4">
            <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-slate-300 hover:bg-white/10">Cancel</button>
            <button
              type="button"
              disabled={selected.size === 0 || sharing}
              onClick={submit}
              className="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-bold text-white hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {sharing ? 'Sharing…' : `Share${selected.size > 0 ? ` (${selected.size})` : ''}`}
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

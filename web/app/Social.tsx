'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  acceptFriendRequest,
  deleteTrackShare,
  getSocialSummary,
  listTrackShares,
  markAllTrackSharesRead,
  markTrackShareRead,
  removeFriend,
  removeFriendRequest,
  searchSocialUsers,
  sendFriendRequest,
  type SocialRelationship,
  type SocialSummary,
  type SocialUser,
  type TrackShare,
} from './apiClient';
import { useAuth } from './store';
import { usePlayer } from './playerStore';
import { useToastStore } from './Toast';
import { showConfirm } from './ConfirmModal';
import { useSocialUpdates } from './socialStore';

type SearchResult = SocialUser & {
  relationshipId: number | null;
  relationship: 'none' | 'incoming' | 'outgoing' | 'friend';
};

function Avatar({ user, size = 'md' }: { user: SocialUser; size?: 'sm' | 'md' }) {
  const classes = size === 'sm' ? 'h-8 w-8 text-xs' : 'h-11 w-11 text-sm';
  if (user.avatarPath) {
    return <img src={`/api/avatars/${user.avatarPath}`} alt="" className={`${classes} flex-none rounded-full object-cover`} />;
  }
  return (
    <div className={`${classes} flex flex-none items-center justify-center rounded-full bg-gradient-to-br from-cyan-500 to-blue-600 font-bold text-white`}>
      {user.email.charAt(0).toUpperCase()}
    </div>
  );
}

function formatWhen(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '';
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (Math.abs(seconds) < 60) return relative.format(seconds, 'second');
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return relative.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relative.format(hours, 'hour');
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return relative.format(days, 'day');
  return new Date(timestamp).toLocaleDateString();
}

function RelationshipRow({
  relationship,
  actions,
}: {
  relationship: SocialRelationship;
  actions: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.035] p-3">
      <Avatar user={relationship.user} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-white">{relationship.user.email}</p>
        <p className="mt-0.5 text-xs text-slate-500">{formatWhen(relationship.createdAt)}</p>
      </div>
      <div className="flex flex-none items-center gap-2">{actions}</div>
    </div>
  );
}

function SmallButton({
  children,
  onClick,
  disabled,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'primary' | 'neutral' | 'danger';
}) {
  const tones = {
    primary: 'bg-cyan-500 text-white hover:bg-cyan-400',
    neutral: 'bg-white/10 text-slate-200 hover:bg-white/15',
    danger: 'bg-red-500/10 text-red-300 hover:bg-red-500/20',
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${tones[tone]}`}
    >
      {children}
    </button>
  );
}

export function Social() {
  const token = useAuth((state) => state.token);
  const clear = useAuth((state) => state.clear);
  const player = usePlayer();
  const showToast = useToastStore((state) => state.show);
  const socialLastUpdate = useSocialUpdates((state) => state.lastUpdate);
  const setSocialCounts = useSocialUpdates((state) => state.setCounts);
  const [tab, setTab] = useState<'shares' | 'friends'>('shares');
  const [summary, setSummary] = useState<SocialSummary | null>(null);
  const [shares, setShares] = useState<TrackShare[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchAttempted, setSearchAttempted] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const [nextSummary, shareResult] = await Promise.all([
        getSocialSummary(token),
        listTrackShares(token),
      ]);
      setSummary(nextSummary);
      setShares(shareResult.shares);
      setSocialCounts(nextSummary.unreadShares, nextSummary.incoming.length);
    } catch (error: any) {
      if (error?.status === 401) clear();
      else showToast('Could not load friends and shares', 'error');
    } finally {
      setLoading(false);
    }
  }, [token, clear, showToast, setSocialCounts]);

  useEffect(() => { void load(); }, [load, socialLastUpdate]);

  const run = async (key: string, action: () => Promise<unknown>, success?: string) => {
    if (busyKey) return false;
    setBusyKey(key);
    try {
      await action();
      if (success) showToast(success, 'success');
      await load();
      return true;
    } catch (error: any) {
      if (error?.status === 401) clear();
      else showToast('That action could not be completed', 'error');
      return false;
    } finally {
      setBusyKey(null);
    }
  };

  const markRead = async (share: TrackShare) => {
    if (!token || share.readAt) return;
    setShares((current) => current.map((item) => item.id === share.id ? { ...item, readAt: new Date().toISOString() } : item));
    setSocialCounts(Math.max(0, (summary?.unreadShares ?? 1) - 1), summary?.incoming.length ?? 0);
    setSummary((current) => current ? { ...current, unreadShares: Math.max(0, current.unreadShares - 1) } : current);
    try { await markTrackShareRead(token, share.id); } catch { void load(); }
  };

  const playShare = (share: TrackShare) => {
    void markRead(share);
    player.playTrackNow({
      id: share.track.id,
      title: share.track.title,
      artist: share.track.artist,
      album: share.track.album,
      art_path: share.track.artPath,
      art_hash: share.track.artHash,
      duration_ms: share.track.durationMs,
    });
  };

  const queueShare = (share: TrackShare) => {
    void markRead(share);
    player.addToQueue({
      id: share.track.id,
      title: share.track.title,
      artist: share.track.artist,
      album: share.track.album,
      art_path: share.track.artPath,
      art_hash: share.track.artHash,
      duration_ms: share.track.durationMs,
    });
  };

  const search = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!token || query.trim().length < 2 || searching) return;
    setSearching(true);
    setSearchAttempted(true);
    try {
      const result = await searchSocialUsers(token, query.trim());
      setSearchResults(result.users);
    } catch (error: any) {
      if (error?.status === 401) clear();
      else showToast('Could not search users', 'error');
    } finally {
      setSearching(false);
    }
  };

  const sendRequest = async (user: SearchResult) => {
    if (!token) return;
    const sent = await run(`request-${user.id}`, () => sendFriendRequest(token, user.id), 'Friend request sent');
    if (sent) {
      setSearchResults((current) => current.map((item) => item.id === user.id ? { ...item, relationship: 'outgoing' } : item));
    }
  };

  const removeFriendWithConfirmation = async (relationship: SocialRelationship) => {
    if (!token) return;
    const confirmed = await showConfirm({
      title: 'Remove friend',
      message: `Remove ${relationship.user.email} from your friends?`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (confirmed) await run(`friend-${relationship.user.id}`, () => removeFriend(token, relationship.user.id), 'Friend removed');
  };

  const dismissShare = async (share: TrackShare) => {
    if (!token) return;
    const confirmed = await showConfirm({
      title: 'Remove shared song',
      message: `Remove “${share.track.title || 'this song'}” from your shared songs?`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (confirmed) await run(`share-${share.id}`, () => deleteTrackShare(token, share.id));
  };

  if (!token) return null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Friends & sharing</h1>
          <p className="mt-1 text-sm text-slate-400">Share music with people who use this mvbar server.</p>
        </div>
        <div className="flex rounded-xl border border-white/10 bg-white/[0.04] p-1">
          <button
            type="button"
            onClick={() => setTab('shares')}
            className={`rounded-lg px-3 py-2 text-sm font-semibold transition ${tab === 'shares' ? 'bg-cyan-500 text-white' : 'text-slate-400 hover:text-white'}`}
          >
            Shared with you{summary?.unreadShares ? ` (${summary.unreadShares})` : ''}
          </button>
          <button
            type="button"
            onClick={() => setTab('friends')}
            className={`rounded-lg px-3 py-2 text-sm font-semibold transition ${tab === 'friends' ? 'bg-cyan-500 text-white' : 'text-slate-400 hover:text-white'}`}
          >
            Friends{summary?.incoming.length ? ` (${summary.incoming.length})` : ''}
          </button>
        </div>
      </div>

      {loading && <div className="py-16 text-center text-sm text-slate-400">Loading…</div>}

      {!loading && tab === 'shares' && (
        <div className="space-y-3">
          {summary && summary.unreadShares > 0 && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => run('read-all', () => markAllTrackSharesRead(token), 'All shared songs marked as read')}
                disabled={busyKey === 'read-all'}
                className="text-sm font-medium text-cyan-300 hover:text-cyan-200 disabled:opacity-50"
              >
                Mark all as read
              </button>
            </div>
          )}
          {shares.map((share) => (
            <article
              key={share.id}
              className={`relative flex gap-3 rounded-2xl border p-3 sm:gap-4 sm:p-4 ${share.readAt ? 'border-white/10 bg-white/[0.03]' : 'border-cyan-400/30 bg-cyan-500/[0.07]'}`}
            >
              {!share.readAt && <span className="absolute right-3 top-3 h-2.5 w-2.5 rounded-full bg-cyan-400" title="Unread" />}
              <button type="button" onClick={() => playShare(share)} className="group relative h-20 w-20 flex-none overflow-hidden rounded-xl bg-slate-800 sm:h-24 sm:w-24" aria-label={`Play ${share.track.title || 'shared song'}`}>
                <img src={`/api/art/${share.track.id}`} alt="" className="h-full w-full object-cover" />
                <span className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 transition group-hover:opacity-100">
                  <svg className="h-8 w-8 text-white" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
                </span>
              </button>
              <div className="min-w-0 flex-1 pr-4">
                <h2 className="truncate font-semibold text-white">{share.track.title || 'Unknown Track'}</h2>
                <p className="truncate text-sm text-slate-400">{[share.track.artist, share.track.album].filter(Boolean).join(' • ') || 'Unknown artist'}</p>
                <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
                  <Avatar user={share.sender} size="sm" />
                  <span className="min-w-0 truncate">Shared by {share.sender.email}</span>
                  <span className="flex-none">• {formatWhen(share.createdAt)}</span>
                </div>
                {share.message && <p className="mt-2 rounded-lg bg-black/20 px-3 py-2 text-sm italic text-slate-300">“{share.message}”</p>}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <SmallButton tone="primary" onClick={() => playShare(share)}>Play</SmallButton>
                  <SmallButton onClick={() => queueShare(share)}>Add to queue</SmallButton>
                  {!share.readAt && <SmallButton onClick={() => void markRead(share)}>Mark read</SmallButton>}
                  <SmallButton tone="danger" disabled={busyKey === `share-${share.id}`} onClick={() => void dismissShare(share)}>Remove</SmallButton>
                </div>
              </div>
            </article>
          ))}
          {shares.length === 0 && (
            <div className="rounded-2xl border border-dashed border-white/10 py-16 text-center">
              <svg className="mx-auto h-12 w-12 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 8h10M7 12h6m-7 8-4-4V5a2 2 0 012-2h16a2 2 0 012 2v11a2 2 0 01-2 2H8l-2 2z" />
              </svg>
              <p className="mt-3 font-medium text-white">No songs shared with you yet</p>
              <p className="mt-1 text-sm text-slate-500">Songs from friends will appear here.</p>
            </div>
          )}
        </div>
      )}

      {!loading && tab === 'friends' && summary && (
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-6">
            {summary.incoming.length > 0 && (
              <section>
                <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-cyan-300">Friend requests</h2>
                <div className="space-y-2">
                  {summary.incoming.map((relationship) => (
                    <RelationshipRow
                      key={relationship.relationshipId}
                      relationship={relationship}
                      actions={(
                        <>
                          <SmallButton tone="primary" disabled={busyKey === `accept-${relationship.relationshipId}`} onClick={() => run(`accept-${relationship.relationshipId}`, () => acceptFriendRequest(token, relationship.relationshipId), 'Friend added')}>Accept</SmallButton>
                          <SmallButton tone="danger" disabled={busyKey === `decline-${relationship.relationshipId}`} onClick={() => run(`decline-${relationship.relationshipId}`, () => removeFriendRequest(token, relationship.relationshipId))}>Decline</SmallButton>
                        </>
                      )}
                    />
                  ))}
                </div>
              </section>
            )}

            <section>
              <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-400">Your friends ({summary.friends.length})</h2>
              <div className="space-y-2">
                {summary.friends.map((relationship) => (
                  <RelationshipRow
                    key={relationship.relationshipId}
                    relationship={relationship}
                    actions={<SmallButton tone="danger" disabled={busyKey === `friend-${relationship.user.id}`} onClick={() => void removeFriendWithConfirmation(relationship)}>Remove</SmallButton>}
                  />
                ))}
                {summary.friends.length === 0 && (
                  <p className="rounded-xl border border-dashed border-white/10 p-6 text-center text-sm text-slate-500">You haven’t added any friends yet.</p>
                )}
              </div>
            </section>

            {summary.outgoing.length > 0 && (
              <section>
                <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-400">Sent requests</h2>
                <div className="space-y-2">
                  {summary.outgoing.map((relationship) => (
                    <RelationshipRow
                      key={relationship.relationshipId}
                      relationship={relationship}
                      actions={<SmallButton disabled={busyKey === `cancel-${relationship.relationshipId}`} onClick={() => run(`cancel-${relationship.relationshipId}`, () => removeFriendRequest(token, relationship.relationshipId))}>Cancel</SmallButton>}
                    />
                  ))}
                </div>
              </section>
            )}
          </div>

          <section className="h-fit rounded-2xl border border-white/10 bg-white/[0.035] p-4 sm:p-5">
            <h2 className="font-bold text-white">Find people</h2>
            <p className="mt-1 text-sm text-slate-400">Search by the email address they use for mvbar.</p>
            <form onSubmit={search} className="mt-4 flex gap-2">
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="friend@example.com"
                className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white placeholder:text-slate-600 focus:border-cyan-500 focus:outline-none"
              />
              <button type="submit" disabled={query.trim().length < 2 || searching} className="rounded-xl bg-cyan-500 px-4 py-2 text-sm font-bold text-white hover:bg-cyan-400 disabled:opacity-50">
                {searching ? 'Searching…' : 'Search'}
              </button>
            </form>
            <div className="mt-4 space-y-2">
              {searchResults.map((user) => (
                <div key={user.id} className="flex items-center gap-3 rounded-xl bg-black/20 p-3">
                  <Avatar user={user} />
                  <p className="min-w-0 flex-1 truncate text-sm font-medium text-white">{user.email}</p>
                  {user.relationship === 'none' && <SmallButton tone="primary" disabled={busyKey === `request-${user.id}`} onClick={() => void sendRequest(user)}>Add friend</SmallButton>}
                  {user.relationship === 'friend' && <span className="text-xs font-semibold text-green-400">Friends</span>}
                  {user.relationship === 'outgoing' && <span className="text-xs text-slate-400">Request sent</span>}
                  {user.relationship === 'incoming' && <span className="text-xs text-cyan-300">Requested you</span>}
                </div>
              ))}
              {searchAttempted && !searching && searchResults.length === 0 && (
                <p className="py-4 text-center text-sm text-slate-500">No approved user found.</p>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

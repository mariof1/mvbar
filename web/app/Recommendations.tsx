'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from './store';
import { usePlayer } from './playerStore';
import {
  clearHiddenRecommendationBuckets,
  getRecommendations,
  sendRecommendationFeedback,
} from './apiClient';
import { trackArtistLabel } from './artistDisplay';
import { useToastStore } from './Toast';
import { useBodyScrollLock } from './useBodyScrollLock';

type Track = {
  id: number;
  title: string;
  artist: string;
  display_artist?: string | null;
  album: string | null;
  art_path: string | null;
  art_hash: string | null;
  duration_ms: number | null;
};

type Bucket = {
  key: string;
  name: string;
  subtitle?: string;
  reason?: string;
  count: number;
  tracks: Track[];
  art_paths: string[];
  art_hashes: string[];
};

function useFlipAnimation(ref: React.RefObject<HTMLElement>, idsKey: string) {
  const prevRectsRef = useRef<Map<string, DOMRect> | null>(null);
  const hasMeasuredRef = useRef(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (typeof window !== 'undefined') {
      try {
        if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
          const m = new Map<string, DOMRect>();
          el.querySelectorAll<HTMLElement>('[data-flip-id]').forEach((n) => {
            const id = n.dataset.flipId;
            if (id) m.set(id, n.getBoundingClientRect());
          });
          prevRectsRef.current = m;
          hasMeasuredRef.current = true;
          return;
        }
      } catch {}
    }

    const nextRects = new Map<string, DOMRect>();
    const nodes = Array.from(el.querySelectorAll<HTMLElement>('[data-flip-id]'));
    for (const n of nodes) {
      const id = n.dataset.flipId;
      if (!id) continue;
      nextRects.set(id, n.getBoundingClientRect());
    }

    const prevRects = prevRectsRef.current;
    if (prevRects && hasMeasuredRef.current) {
      for (const n of nodes) {
        const id = n.dataset.flipId;
        if (!id) continue;
        const prev = prevRects.get(id);
        const next = nextRects.get(id);
        if (!next) continue;

        if (!prev) {
          n.animate(
            [{ opacity: 0, transform: 'scale(0.98)' }, { opacity: 1, transform: 'scale(1)' }],
            { duration: 180, easing: 'ease-out' }
          );
          continue;
        }

        const dx = prev.left - next.left;
        const dy = prev.top - next.top;
        if (dx === 0 && dy === 0) continue;

        n.animate(
          [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0px, 0px)' }],
          { duration: 260, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }
        );
      }
    }

    prevRectsRef.current = nextRects;
    hasMeasuredRef.current = true;
  }, [idsKey, ref]);
}

function ArtImage({ path, hash, className }: { path: string | null; hash: string | null; className?: string }) {
  const [error, setError] = useState(false);
  
  if (!path || error) {
    return (
      <div className={`bg-gradient-to-br from-slate-700 to-slate-800 flex items-center justify-center ${className}`}>
        <svg className="w-6 h-6 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
        </svg>
      </div>
    );
  }
  return (
    <img
      src={`/api/art/${encodeURIComponent(path)}${hash ? `?h=${hash}` : ''}`}
      alt=""
      className={`object-cover ${className}`}
      loading="lazy"
      onError={() => setError(true)}
    />
  );
}

// Grid of up to 4 album arts in a 2x2 layout
function ArtGrid({ paths, hashes }: { paths: string[]; hashes: string[] }) {
  const arts = paths.slice(0, 4);
  const hashList = hashes.slice(0, 4);
  
  if (arts.length === 0) {
    return (
      <div className="w-full aspect-square bg-gradient-to-br from-slate-700 to-slate-800 rounded-xl flex items-center justify-center">
        <svg className="w-12 h-12 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
        </svg>
      </div>
    );
  }

  if (arts.length === 1) {
    return (
      <div className="w-full aspect-square rounded-xl overflow-hidden">
        <ArtImage path={arts[0]} hash={hashList[0]} className="w-full h-full" />
      </div>
    );
  }

  return (
    <div className="w-full aspect-square rounded-xl overflow-hidden grid grid-cols-2 grid-rows-2 gap-0.5">
      {[0, 1, 2, 3].map((i) => (
        <ArtImage 
          key={i} 
          path={arts[i] ?? arts[0]} 
          hash={hashList[i] ?? hashList[0]} 
          className="w-full h-full"
        />
      ))}
    </div>
  );
}

// Bucket card with 2x2 art grid
function BucketCard({
  bucket,
  onClick,
  onDetails,
  flipId,
}: {
  bucket: Bucket;
  onClick?: () => void;
  onDetails?: () => void;
  flipId?: string;
}) {
  const disabled = bucket.tracks.length === 0;

  return (
    <div className="relative" data-flip-id={flipId}>
      <button
        type="button"
        className="group w-full text-left cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70 rounded-xl disabled:cursor-default disabled:opacity-60"
        onClick={onClick}
        disabled={disabled}
      >
        <div className="relative mb-3">
          <ArtGrid paths={bucket.art_paths} hashes={bucket.art_hashes} />
          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors rounded-xl flex items-center justify-center">
            <div className="w-12 h-12 bg-cyan-500 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 scale-90 group-hover:scale-100 transition-all shadow-xl">
              <svg className="w-5 h-5 text-white ml-0.5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
            </div>
          </div>
        </div>
        <div className="px-1 pr-7">
          <div className="font-semibold text-white text-sm">{bucket.name}</div>
          {bucket.subtitle && <div className="text-xs text-slate-400 truncate">{bucket.subtitle}</div>}
          {bucket.count > 0 && (
            <div className="text-xs text-slate-500">{bucket.count} songs</div>
          )}
        </div>
      </button>
      <button
        type="button"
        onClick={onDetails}
        className="absolute right-0 bottom-0 p-1.5 rounded-full text-slate-500 hover:text-white hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70"
        aria-label={`Why ${bucket.name} was recommended`}
        title="Why this mix?"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
        </svg>
      </button>
    </div>
  );
}

export function Recommendations() {
  const token = useAuth((s) => s.token);
  const clear = useAuth((s) => s.clear);
  const { setQueueAndPlay } = usePlayer();

  const [loading, setLoading] = useState(false);
  const [backgroundRefreshing, setBackgroundRefreshing] = useState(false);
  const [serverRefreshing, setServerRefreshing] = useState(false);
  const [restoringMixes, setRestoringMixes] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [slateId, setSlateId] = useState<string | undefined>();
  const [recommendationProfile, setRecommendationProfile] = useState<'new' | 'learning' | 'personalized'>('new');
  const [hiddenMixCount, setHiddenMixCount] = useState(0);
  const [detailsBucket, setDetailsBucket] = useState<Bucket | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useToastStore((state) => state.show);
  useBodyScrollLock(Boolean(detailsBucket));

  const bucketsRef = useRef<HTMLDivElement>(null);

  const bucketsIdsKey = useMemo(
    () => `buckets:${buckets.map((b) => `${b.key}:${b.count}:${b.tracks.slice(0, 5).map((t) => t.id).join('-')}`).join(',')}`,
    [buckets]
  );

  useFlipAnimation(bucketsRef, bucketsIdsKey);

  const playBucket = (bucket: Bucket) => {
    if (bucket.tracks.length > 0) {
      setQueueAndPlay(
        bucket.tracks.map((track, position) => ({
          ...track,
          artist: trackArtistLabel(track),
          recommendation_slate_id: slateId,
          recommendation_bucket_key: bucket.key,
          recommendation_position: position,
        })),
        0,
      );
    }
  };

  const loadRecommendations = (opts?: { silent?: boolean; staleRetries?: number }) => {
    if (!token) return;
    const silent = Boolean(opts?.silent);

    if (silent) setBackgroundRefreshing(true);
    else setLoading(true);

    setError(null);
    getRecommendations(token)
      .then((r) => {
        setBuckets(r.buckets ?? []);
        setSlateId(r.slateId);
        setRecommendationProfile(r.recommendationProfile ?? 'new');
        setHiddenMixCount(r.hiddenMixCount ?? 0);
        setServerRefreshing(Boolean(r._stale && r._refreshing));
        const staleRetries = opts?.staleRetries ?? 0;
        if (r._stale && staleRetries < 3) {
          if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
          retryTimerRef.current = setTimeout(() => {
            loadRecommendations({ silent: true, staleRetries: staleRetries + 1 });
          }, 5000);
        }
      })
      .catch((e: any) => {
        if (e?.status === 401) clear();
        setError(e?.message ?? 'error');
        setServerRefreshing(false);
      })
      .finally(() => {
        if (silent) setBackgroundRefreshing(false);
        else setLoading(false);
      });
  };

  useEffect(() => {
    loadRecommendations();
    return () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const hideBucket = async (bucket: Bucket) => {
    if (!token) return;
    try {
      const result = await sendRecommendationFeedback(token, { action: 'hide_bucket', bucketKey: bucket.key });
      setBuckets((current) => current.filter((item) => item.key !== bucket.key));
      setHiddenMixCount((current) => result.hiddenMixCount ?? current + 1);
      setDetailsBucket(null);
      showToast(`Hidden “${bucket.name}”`, 'success');
    } catch (feedbackError: any) {
      if (feedbackError?.status === 401) clear();
      showToast('Could not save recommendation feedback', 'error');
    }
  };

  const restoreHiddenMixes = async () => {
    if (!token || restoringMixes) return;
    setRestoringMixes(true);
    setError(null);
    try {
      await clearHiddenRecommendationBuckets(token);
      setHiddenMixCount(0);
      setServerRefreshing(true);
      loadRecommendations({ silent: true });
      showToast('Restoring your recommendation mixes', 'success');
    } catch (restoreError: any) {
      if (restoreError?.status === 401) clear();
      setError(restoreError?.message ?? 'Could not restore recommendation mixes');
      setServerRefreshing(false);
    } finally {
      setRestoringMixes(false);
    }
  };

  if (!token) return null;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-3 border-cyan-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400">
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Local Recommendations */}
      {buckets.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-lg font-semibold text-white">Made for you</h3>
              <p className="text-xs text-slate-500">A focused mix of favourites, rediscovery, and new finds</p>
            </div>
            {(backgroundRefreshing || serverRefreshing) && <div className="w-4 h-4 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" title="Refreshing recommendations" />}
          </div>
          <div ref={bucketsRef} className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {buckets.map((bucket) => (
              <BucketCard
                key={bucket.key}
                bucket={bucket}
                onClick={() => playBucket(bucket)}
                onDetails={() => setDetailsBucket(bucket)}
                flipId={`bucket:${bucket.key}`}
              />
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {buckets.length === 0 && hiddenMixCount > 0 && !serverRefreshing && (
        <div className="rounded-2xl border border-white/10 bg-slate-800/40 px-5 py-14 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-slate-800">
            <svg className="h-8 w-8 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18M9.75 9.75V6l10.5-3v10.5M9.75 18c0 1.243-1.511 2.25-3.375 2.25S3 19.243 3 18s1.511-2.25 3.375-2.25S9.75 16.757 9.75 18zm10.5-4.5c0 1.243-1.511 2.25-3.375 2.25" />
            </svg>
          </div>
          <h3 className="mb-2 text-lg font-semibold text-white">All recommendation mixes are hidden</h3>
          <p className="mx-auto mb-5 max-w-md text-sm text-slate-400">
            You hid {hiddenMixCount} {hiddenMixCount === 1 ? 'mix' : 'mixes'}. Restore them whenever you want mvbar to build a fresh selection.
          </p>
          <button
            type="button"
            onClick={() => void restoreHiddenMixes()}
            disabled={restoringMixes}
            className="rounded-xl bg-cyan-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-cyan-500 disabled:cursor-wait disabled:opacity-60"
          >
            {restoringMixes ? 'Restoring…' : 'Restore hidden mixes'}
          </button>
        </div>
      )}

      {buckets.length === 0 && serverRefreshing && (
        <div className="py-16 text-center">
          <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-3 border-cyan-500 border-t-transparent" />
          <h3 className="mb-2 text-lg font-semibold text-white">Building fresh mixes</h3>
          <p className="text-sm text-slate-400">This normally takes only a few seconds.</p>
        </div>
      )}

      {buckets.length === 0 && hiddenMixCount === 0 && !serverRefreshing && (
        <div className="text-center py-16">
          <div className="w-16 h-16 mx-auto mb-4 bg-slate-800 rounded-full flex items-center justify-center">
            <svg className="w-8 h-8 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
            </svg>
          </div>
          <h3 className="text-lg font-semibold text-white mb-2">
            {recommendationProfile === 'new' ? 'Start listening' : 'No mixes available yet'}
          </h3>
          <p className="text-slate-400 text-sm mb-4">
            {recommendationProfile === 'new'
              ? 'Play some music and your personalized recommendations will appear here.'
              : 'mvbar could not build a varied recommendation mix from the currently available music.'}
          </p>
          <p className="text-slate-500 text-xs">
            Tip: Connect to <a href="/settings" className="text-cyan-400 hover:underline">ListenBrainz</a> for even better recommendations!
          </p>
        </div>
      )}

      {detailsBucket && (
        <div
          className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
          role="presentation"
          onClick={() => setDetailsBucket(null)}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="recommendation-details-title"
            className="w-full max-w-md rounded-2xl border border-white/10 bg-zinc-900 p-5 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 id="recommendation-details-title" className="text-lg font-semibold text-white">{detailsBucket.name}</h3>
                <p className="mt-1 text-sm leading-6 text-white/60">
                  {detailsBucket.reason || detailsBucket.subtitle || 'Selected from your listening activity and music library.'}
                </p>
              </div>
              <button
                type="button"
                className="rounded-full p-2 text-white/50 hover:bg-white/10 hover:text-white"
                onClick={() => setDetailsBucket(null)}
                aria-label="Close"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                className="rounded-xl px-4 py-2 text-sm text-white/60 hover:bg-white/10 hover:text-white"
                onClick={() => setDetailsBucket(null)}
              >
                Keep this mix
              </button>
              <button
                type="button"
                className="rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-2 text-sm text-red-300 hover:bg-red-500/20"
                onClick={() => void hideBucket(detailsBucket)}
              >
                Hide this mix
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

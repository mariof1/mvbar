'use client';

import { useEffect, useState } from 'react';
import { useAuth } from './store';
import { usePlayer } from './playerStore';
import { getRecommendations, getListenBrainzRecommendations } from './apiClient';
import { useHistoryUpdates } from './useWebSocket';

type Track = {
  id: number;
  title: string;
  artist: string;
};

type Bucket = {
  name: string;
  count: number;
  tracks: Track[];
  art_paths: string[];
  art_hashes: string[];
};

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
function BucketCard({ bucket, onClick }: { bucket: Bucket; onClick?: () => void }) {
  return (
    <div 
      className="group cursor-pointer"
      onClick={onClick}
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
      <div className="px-1">
        <div className="font-semibold text-white text-sm">{bucket.name}</div>
        {bucket.count > 0 && (
          <div className="text-xs text-slate-400">{bucket.count} songs</div>
        )}
      </div>
    </div>
  );
}

type LBRecommendation = {
  mbid: string;
  title: string;
  artist: string;
  score: number;
  localTrack?: { id: number; title: string; artist: string; album: string | null };
};

export function Recommendations() {
  const token = useAuth((s) => s.token);
  const clear = useAuth((s) => s.clear);
  const { setQueueAndPlay, playTrackNow } = usePlayer();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [buckets, setBuckets] = useState<Bucket[]>([]);

  // ListenBrainz state
  const [lbConnected, setLbConnected] = useState(false);
  const [lbUsername, setLbUsername] = useState<string | null>(null);
  const [lbRecs, setLbRecs] = useState<LBRecommendation[]>([]);
  const [lbLoading, setLbLoading] = useState(false);

  // Live updates
  const historyLastUpdate = useHistoryUpdates((s) => s.lastUpdate);

  const playBucket = (bucket: Bucket) => {
    if (bucket.tracks.length > 0) {
      setQueueAndPlay(bucket.tracks, 0);
    }
  };

  const loadRecommendations = () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    getRecommendations(token)
      .then((r) => setBuckets(r.buckets ?? []))
      .catch((e: any) => {
        if (e?.status === 401) clear();
        setError(e?.message ?? 'error');
      })
      .finally(() => setLoading(false));

    // Also fetch ListenBrainz recommendations
    setLbLoading(true);
    getListenBrainzRecommendations(token)
      .then((r) => {
        setLbConnected(r.connected);
        setLbUsername(r.username ?? null);
        setLbRecs(r.recommendations ?? []);
      })
      .catch(() => {})
      .finally(() => setLbLoading(false));
  };

  useEffect(() => {
    loadRecommendations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Live updates: refresh recommendations when history changes (debounced)
  useEffect(() => {
    if (!historyLastUpdate || !token) return;
    // Use a timeout to debounce rapid updates
    const timeout = setTimeout(() => {
      loadRecommendations();
    }, 2000);
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyLastUpdate]);

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
          <h3 className="text-lg font-semibold text-white mb-4">Your Library</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {buckets.map((bucket) => (
              <BucketCard key={bucket.name} bucket={bucket} onClick={() => playBucket(bucket)} />
            ))}
          </div>
        </div>
      )}

      {/* ListenBrainz Recommendations */}
      {lbConnected && (
        <div>
          <div className="flex items-center gap-2 mb-4">
            <svg className="w-5 h-5 text-orange-400" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
            </svg>
            <h3 className="text-lg font-semibold text-white">ListenBrainz Recommendations</h3>
            {lbUsername && <span className="text-sm text-slate-400">for {lbUsername}</span>}
          </div>
          
          {lbLoading ? (
            <div className="flex items-center justify-center h-32">
              <div className="w-6 h-6 border-2 border-orange-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : lbRecs.length === 0 ? (
            <div className="p-4 bg-slate-800/50 rounded-xl text-slate-400 text-sm">
              No recommendations yet. Keep listening to build your profile!
            </div>
          ) : (
            <div className="grid gap-2">
              {lbRecs.map((rec) => (
                <div
                  key={rec.mbid}
                  className={`flex items-center gap-3 p-3 rounded-lg transition-colors ${
                    rec.localTrack 
                      ? 'bg-slate-800/50 hover:bg-slate-700/50 cursor-pointer' 
                      : 'bg-slate-800/30 opacity-60'
                  }`}
                  onClick={() => rec.localTrack && playTrackNow({ id: rec.localTrack.id, title: rec.localTrack.title, artist: rec.localTrack.artist })}
                >
                  <div className="w-10 h-10 rounded bg-gradient-to-br from-orange-500 to-orange-600 flex items-center justify-center flex-shrink-0">
                    <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
                    </svg>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-white truncate">{rec.title}</div>
                    <div className="text-sm text-slate-400 truncate">{rec.artist}</div>
                  </div>
                  {rec.localTrack ? (
                    <div className="text-xs text-green-400 px-2 py-1 bg-green-500/10 rounded">In Library</div>
                  ) : (
                    <div className="text-xs text-slate-500 px-2 py-1 bg-slate-700/50 rounded">Not in Library</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Empty state */}
      {buckets.length === 0 && !lbConnected && (
        <div className="text-center py-16">
          <div className="w-16 h-16 mx-auto mb-4 bg-slate-800 rounded-full flex items-center justify-center">
            <svg className="w-8 h-8 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
            </svg>
          </div>
          <h3 className="text-lg font-semibold text-white mb-2">Start listening</h3>
          <p className="text-slate-400 text-sm mb-4">Play some music and your personalized recommendations will appear here.</p>
          <p className="text-slate-500 text-xs">
            Tip: Connect to <a href="/settings" className="text-cyan-400 hover:underline">ListenBrainz</a> for even better recommendations!
          </p>
        </div>
      )}
    </div>
  );
}

'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useAuth } from './store';
import { useUi, PodcastEpisode } from './uiStore';
import { usePlayer } from './playerStore';
import { useRouter } from './router';
import { apiFetch } from './apiClient';
import { sendWebSocketMessage, usePodcastProgress, updateLocalPodcastProgress } from './useWebSocket';

// ============================================================================
// TYPES
// ============================================================================

interface Podcast {
  id: number;
  feed_url: string;
  title: string;
  author: string | null;
  description: string | null;
  image_url: string | null;
  image_path?: string | null;
  unplayed_count: number;
}

interface Episode {
  id: number;
  podcast_id: number;
  title: string;
  description: string | null;
  audio_url: string;
  duration_ms: number | null;
  image_url: string | null;
  image_path?: string | null;
  published_at: string | null;
  position_ms: number;
  played: boolean;
  downloaded: boolean;
  podcast_title?: string;
  podcast_image_url?: string | null;
  podcast_image_path?: string | null;
}

// ============================================================================
// SEARCH RESULT TYPE
// ============================================================================

interface SearchResult {
  id: number;
  title: string;
  author: string;
  imageUrl: string | null;
  feedUrl: string;
  genre: string | null;
  episodeCount: number | null;
}

// ============================================================================
// SUBSCRIBE MODAL
// ============================================================================

function SubscribeModal({ onClose, onSubscribed, subscribedFeedUrls }: { 
  onClose: () => void; 
  onSubscribed: () => void;
  subscribedFeedUrls: Set<string>;
}) {
  const token = useAuth((s) => s.token);
  const [tab, setTab] = useState<'search' | 'rss'>('search');
  const [feedUrl, setFeedUrl] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [subscribing, setSubscribing] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Search podcasts via iTunes API
  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim() || searchQuery.trim().length < 2) return;
    
    setLoading(true);
    setError(null);
    
    try {
      const res = await apiFetch(`/podcasts/search?q=${encodeURIComponent(searchQuery.trim())}`, {}, token!);
      setSearchResults(res.results || []);
    } catch (err: any) {
      setError(err?.error || 'Search failed');
    } finally {
      setLoading(false);
    }
  }, [searchQuery, token]);

  // Subscribe to a podcast from search results
  const subscribeToResult = async (result: SearchResult) => {
    setSubscribing(result.id);
    setError(null);
    
    try {
      await apiFetch('/podcasts/subscribe', { method: 'POST', body: JSON.stringify({ feedUrl: result.feedUrl }) }, token!);
      onSubscribed();
      onClose();
    } catch (err: any) {
      setError(err?.error || 'Failed to subscribe');
    } finally {
      setSubscribing(null);
    }
  };

  // Subscribe via direct RSS URL
  const handleRssSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!feedUrl.trim()) return;

    setLoading(true);
    setError(null);

    try {
      await apiFetch('/podcasts/subscribe', { method: 'POST', body: JSON.stringify({ feedUrl }) }, token!);
      onSubscribed();
      onClose();
    } catch (err: any) {
      setError(err?.error || err?.message || 'Failed to subscribe');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-slate-800 rounded-2xl p-6 w-full max-w-2xl max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-xl font-bold text-white mb-4">Add Podcast</h2>

        {/* Tabs */}
        <div className="flex gap-2 mb-4">
          <button
            onClick={() => setTab('search')}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              tab === 'search' ? 'bg-cyan-600 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
            }`}
          >
            🔍 Search
          </button>
          <button
            onClick={() => setTab('rss')}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              tab === 'rss' ? 'bg-cyan-600 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
            }`}
          >
            📡 RSS URL
          </button>
        </div>

        {error && <p className="text-red-400 text-sm mb-3">{error}</p>}

        {/* Search Tab */}
        {tab === 'search' && (
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="flex gap-2 mb-4">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                placeholder="Search for podcasts..."
                className="flex-1 min-w-0 px-4 py-3 rounded-lg bg-slate-700 text-white placeholder-slate-400 border border-slate-600 focus:border-cyan-500 focus:outline-none"
                autoFocus
              />
              <button
                onClick={handleSearch}
                disabled={loading || searchQuery.trim().length < 2}
                className="px-4 py-3 rounded-lg bg-cyan-600 text-white hover:bg-cyan-500 transition-colors disabled:opacity-50 flex-shrink-0"
              >
                {loading ? '...' : 'Search'}
              </button>
            </div>

            {/* Results */}
            <div className="flex-1 overflow-y-auto space-y-2">
              {searchResults.length === 0 && !loading && searchQuery && (
                <p className="text-slate-400 text-center py-8">No podcasts found. Try a different search term.</p>
              )}
              {searchResults.map((result) => {
                const isSubscribed = subscribedFeedUrls.has(result.feedUrl);
                return (
                  <div
                    key={result.id}
                    className="flex items-center gap-3 p-3 rounded-lg bg-slate-700/50 hover:bg-slate-700 transition-colors"
                  >
                    {result.imageUrl ? (
                      <img src={result.imageUrl} alt="" className="w-14 h-14 rounded-lg object-cover flex-shrink-0" />
                    ) : (
                      <div className="w-14 h-14 rounded-lg bg-slate-600 flex items-center justify-center flex-shrink-0">
                        <span className="text-2xl">🎙️</span>
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <h3 className="font-semibold text-white truncate">{result.title}</h3>
                      <p className="text-sm text-slate-400 truncate">{result.author}</p>
                      {result.genre && (
                        <p className="text-xs text-slate-500">{result.genre} • {result.episodeCount || '?'} episodes</p>
                      )}
                    </div>
                    {isSubscribed ? (
                      <span className="px-4 py-2 rounded-lg bg-slate-600 text-slate-400 text-sm font-medium flex-shrink-0">
                        Subscribed
                      </span>
                    ) : (
                      <button
                        onClick={() => subscribeToResult(result)}
                        disabled={subscribing === result.id}
                        className="px-4 py-2 rounded-lg bg-cyan-600 text-white text-sm font-medium hover:bg-cyan-500 transition-colors disabled:opacity-50 flex-shrink-0"
                      >
                        {subscribing === result.id ? '...' : 'Subscribe'}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* RSS Tab */}
        {tab === 'rss' && (
          <form onSubmit={handleRssSubmit}>
            <p className="text-slate-400 text-sm mb-3">
              Enter a podcast RSS feed URL directly if you cannot find it through search.
            </p>
            <input
              type="url"
              value={feedUrl}
              onChange={(e) => setFeedUrl(e.target.value)}
              placeholder="https://example.com/podcast/feed.xml"
              className="w-full px-4 py-3 rounded-lg bg-slate-700 text-white placeholder-slate-400 border border-slate-600 focus:border-cyan-500 focus:outline-none"
            />

            <div className="flex gap-3 mt-6">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 px-4 py-2 rounded-lg bg-slate-700 text-white hover:bg-slate-600 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading || !feedUrl.trim()}
                className="flex-1 px-4 py-2 rounded-lg bg-cyan-600 text-white hover:bg-cyan-500 transition-colors disabled:opacity-50"
              >
                {loading ? 'Subscribing...' : 'Subscribe'}
              </button>
            </div>
          </form>
        )}

        {/* Close button for search tab */}
        {tab === 'search' && (
          <div className="mt-4 pt-4 border-t border-slate-700">
            <button
              onClick={onClose}
              className="w-full px-4 py-2 rounded-lg bg-slate-700 text-white hover:bg-slate-600 transition-colors"
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// FORMAT HELPERS
// ============================================================================

function formatDuration(ms: number | null): string {
  if (!ms) return '';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes} min`;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
  return date.toLocaleDateString();
}

function stripHtml(html: string | null): string {
  if (!html) return '';
  // Remove HTML tags and decode entities
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

// ============================================================================
// EPISODE ROW
// ============================================================================

function EpisodeRow({
  episode,
  onPlay,
  onMarkPlayed,
  onDownload,
  onDeleteDownload,
}: {
  episode: Episode;
  onPlay: () => void;
  onMarkPlayed: (played: boolean) => void;
  onDownload: () => void;
  onDeleteDownload: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const progress = episode.duration_ms ? Math.round((episode.position_ms / episode.duration_ms) * 100) : 0;
  const imageUrl = episode.image_path
    ? `/api/podcast-art/${episode.image_path}`
    : episode.podcast_image_path
      ? `/api/podcast-art/${episode.podcast_image_path}`
      : `/api/podcasts/episodes/${episode.id}/art`;
  const cleanDescription = stripHtml(episode.description);

  const handleDownload = async () => {
    setDownloading(true);
    try {
      await onDownload();
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className={`group p-4 rounded-lg hover:bg-slate-800/50 transition-colors ${episode.played ? 'opacity-60' : ''}`}>
      <div className="flex items-start gap-4">
        {/* Episode artwork with play overlay */}
        <button
          onClick={onPlay}
          className="relative flex-shrink-0 w-16 h-16 rounded-lg overflow-hidden bg-slate-700 group/play"
        >
          {imageUrl ? (
            <img src={imageUrl} alt="" className="w-full h-full object-cover" loading="lazy" decoding="async" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-2xl">🎙️</div>
          )}
          <div className="absolute inset-0 bg-black/50 opacity-0 group-hover/play:opacity-100 flex items-center justify-center transition-opacity">
            <svg className="w-8 h-8 text-white" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        </button>

        {/* Episode info */}
        <div className="flex-1 min-w-0">
          <h4 className="font-semibold text-white truncate">{episode.title}</h4>
          {episode.podcast_title && (
            <p className="text-sm text-cyan-400 truncate">{episode.podcast_title}</p>
          )}
          <div className="flex items-center gap-3 mt-1 text-xs text-slate-400">
            <span>{formatDate(episode.published_at)}</span>
            {episode.duration_ms && <span>{formatDuration(episode.duration_ms)}</span>}
            {episode.position_ms > 0 && !episode.played && (
              <span className="text-cyan-400">{progress}% played</span>
            )}
          </div>

          {/* Description - collapsed/expanded */}
          {cleanDescription && (
            <div className="mt-2">
              <p className={`text-sm text-slate-400 ${expanded ? '' : 'line-clamp-2'}`}>
                {cleanDescription}
              </p>
              {cleanDescription.length > 150 && (
                <button
                  onClick={() => setExpanded(!expanded)}
                  className="text-xs text-cyan-400 hover:text-cyan-300 mt-1"
                >
                  {expanded ? 'Show less' : 'Show more'}
                </button>
              )}
            </div>
          )}

          {/* Progress bar */}
          {episode.position_ms > 0 && !episode.played && episode.duration_ms && (
            <div className="h-1 bg-slate-700 rounded-full mt-2 overflow-hidden">
              <div className="h-full bg-cyan-500 rounded-full" style={{ width: `${progress}%` }} />
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1">
          {/* Download button */}
          {episode.downloaded ? (
            <button
              onClick={onDeleteDownload}
              className="p-2 rounded-full hover:bg-slate-700 text-green-400 hover:text-red-400 transition-colors"
              title="Downloaded - click to remove"
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
              </svg>
            </button>
          ) : (
            <button
              onClick={handleDownload}
              disabled={downloading}
              className="p-2 rounded-full hover:bg-slate-700 text-slate-400 hover:text-white transition-colors disabled:opacity-50"
              title="Download for offline"
            >
              {downloading ? (
                <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              ) : (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
              )}
            </button>
          )}
          
          {/* Mark played button */}
          <button
            onClick={() => onMarkPlayed(!episode.played)}
            className="p-2 rounded-full hover:bg-slate-700 text-slate-400 hover:text-white transition-colors"
            title={episode.played ? 'Mark as unplayed' : 'Mark as played'}
          >
            {episode.played ? (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            ) : (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="9" strokeWidth={2} />
              </svg>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// PODCAST PLAYER
// ============================================================================

export function PodcastPlayer({
  episode,
  onClose,
  onProgressUpdate,
}: {
  episode: PodcastEpisode | null;
  onClose: () => void;
  onProgressUpdate?: (episodeId: number, positionMs: number, played: boolean) => void;
}) {
  const token = useAuth((s) => s.token);
  const { queue, index, isOpen } = usePlayer();
  const hasMusicPlayer = isOpen && queue[index];
  const [audio, setAudio] = useState<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [expanded, setExpanded] = useState(false);
  const lastBroadcastRef = useRef(0);
  
  // Listen for podcast progress updates from other devices
  const lastProgress = usePodcastProgress((s) => s.lastProgress);
  
  useEffect(() => {
    if (!lastProgress || !audio || !episode) return;
    // Only apply if it's for the current episode and from another device
    if (lastProgress.episodeId === episode.id) {
      const timeDiff = Math.abs(audio.currentTime * 1000 - lastProgress.position_ms);
      // Only seek if difference is significant (> 5 seconds)
      if (timeDiff > 5000) {
        audio.currentTime = lastProgress.position_ms / 1000;
      }
    }
  }, [lastProgress, audio, episode]);

  useEffect(() => {
    if (!episode) return;

    const audioEl = new Audio(`/api/podcasts/episodes/${episode.id}/stream`);
    audioEl.playbackRate = playbackRate;

    // Resume from saved position
    if (episode.position_ms > 0) {
      audioEl.currentTime = episode.position_ms / 1000;
    }

    // Event handlers - store references for cleanup
    const onTimeUpdate = () => setCurrentTime(audioEl.currentTime);
    const onLoadedMetadata = () => setDuration(audioEl.duration);
    const onEnded = () => {
      setPlaying(false);
      onProgressUpdate?.(episode.id, Math.floor(audioEl.currentTime * 1000), true);
      sendWebSocketMessage('podcast:progress', {
        episodeId: episode.id,
        position_ms: Math.floor(audioEl.currentTime * 1000),
        played: true,
      });
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);

    audioEl.addEventListener('timeupdate', onTimeUpdate);
    audioEl.addEventListener('loadedmetadata', onLoadedMetadata);
    audioEl.addEventListener('ended', onEnded);
    audioEl.addEventListener('play', onPlay);
    audioEl.addEventListener('pause', onPause);

    setAudio(audioEl);
    audioEl.play().then(() => setPlaying(true)).catch(() => {});

    // Save progress periodically and broadcast via WebSocket
    let lastApiSave = 0;
    const interval = setInterval(() => {
      if (audioEl.currentTime > 0) {
        const positionMs = Math.floor(audioEl.currentTime * 1000);
        const now = Date.now();
        
        // Update local progress store for UI sync (Continue Listening, etc.) - every 5s
        updateLocalPodcastProgress(episode.id, positionMs, false);
        
        // Save to API (throttle to every 15s)
        if (now - lastApiSave >= 15000) {
          lastApiSave = now;
          apiFetch(
            `/podcasts/episodes/${episode.id}/progress`,
            { method: 'POST', body: JSON.stringify({ positionMs }) },
            token!
          ).catch(() => {});
        }
        
        // Broadcast via WebSocket to other devices (throttle to every 15s)
        if (now - lastBroadcastRef.current >= 15000) {
          lastBroadcastRef.current = now;
          sendWebSocketMessage('podcast:progress', {
            episodeId: episode.id,
            position_ms: positionMs,
            played: false,
          });
        }
      }
    }, 5000);

    return () => {
      clearInterval(interval);
      // Remove all event listeners to prevent memory leaks
      audioEl.removeEventListener('timeupdate', onTimeUpdate);
      audioEl.removeEventListener('loadedmetadata', onLoadedMetadata);
      audioEl.removeEventListener('ended', onEnded);
      audioEl.removeEventListener('play', onPlay);
      audioEl.removeEventListener('pause', onPause);
      // Save final position
      if (audioEl.currentTime > 0) {
        onProgressUpdate?.(episode.id, Math.floor(audioEl.currentTime * 1000), false);
      }
      audioEl.pause();
      audioEl.src = '';
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [episode?.id]);
  
  // Media Session API integration
  useEffect(() => {
    if (!episode || !('mediaSession' in navigator)) return;
    
    const imageUrl = episode.image_path
      ? `/api/podcast-art/${episode.image_path}`
      : episode.podcast_image_path
        ? `/api/podcast-art/${episode.podcast_image_path}`
        : `/api/podcasts/episodes/${episode.id}/art`;
    
    navigator.mediaSession.metadata = new MediaMetadata({
      title: episode.title,
      artist: episode.podcast_title || 'Podcast',
      album: episode.podcast_title || 'Podcast',
      artwork: [{ src: imageUrl, sizes: '512x512', type: 'image/jpeg' }],
    });
    
    navigator.mediaSession.setActionHandler('play', () => {
      audio?.play();
    });
    
    navigator.mediaSession.setActionHandler('pause', () => {
      audio?.pause();
    });
    
    navigator.mediaSession.setActionHandler('seekbackward', () => {
      if (audio) audio.currentTime = Math.max(0, audio.currentTime - 15);
    });
    
    navigator.mediaSession.setActionHandler('seekforward', () => {
      if (audio) audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 15);
    });
    
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (audio && details.seekTime !== undefined) {
        audio.currentTime = details.seekTime;
      }
    });
    
    navigator.mediaSession.setActionHandler('stop', () => {
      onClose();
    });
    
    return () => {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.setActionHandler('play', null);
      navigator.mediaSession.setActionHandler('pause', null);
      navigator.mediaSession.setActionHandler('seekbackward', null);
      navigator.mediaSession.setActionHandler('seekforward', null);
      navigator.mediaSession.setActionHandler('seekto', null);
      navigator.mediaSession.setActionHandler('stop', null);
    };
  }, [episode, audio, onClose]);
  
  // Update Media Session playback state and position
  useEffect(() => {
    if (!('mediaSession' in navigator) || !audio) return;
    
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    
    if (duration > 0) {
      navigator.mediaSession.setPositionState({
        duration: duration,
        playbackRate: playbackRate,
        position: currentTime,
      });
    }
  }, [playing, currentTime, duration, playbackRate, audio]);

  useEffect(() => {
    if (audio) audio.playbackRate = playbackRate;
  }, [playbackRate, audio]);

  if (!episode) return null;

  const togglePlay = () => {
    if (!audio) return;
    if (playing) {
      audio.pause();
    } else {
      audio.play();
    }
    setPlaying(!playing);
  };

  const skip = (seconds: number) => {
    if (!audio) return;
    audio.currentTime = Math.max(0, Math.min(duration, audio.currentTime + seconds));
  };

  const seekTo = (pct: number) => {
    if (!audio || !duration) return;
    audio.currentTime = pct * duration;
  };

  const formatTime = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const imageUrl = episode.image_path
    ? `/api/podcast-art/${episode.image_path}`
    : episode.podcast_image_path
      ? `/api/podcast-art/${episode.podcast_image_path}`
      : `/api/podcasts/episodes/${episode.id}/art`;

  return (
    <>
      {/* Expanded Player Overlay - Mobile only */}
      {expanded && (
        <div 
          className="fixed inset-0 z-[100] bg-black/95 backdrop-blur-xl lg:hidden animate-fade-in"
          onClick={() => setExpanded(false)}
        >
          <div 
            className="h-full flex flex-col overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Close handle */}
            <div className="flex justify-center pt-4 pb-2">
              <button 
                onClick={() => setExpanded(false)}
                className="w-12 h-1.5 bg-white/30 rounded-full"
              />
            </div>

            {/* Artwork */}
            <div className="flex-shrink-0 px-8 pt-4 pb-6">
              {imageUrl ? (
                <img
                  src={imageUrl}
                  alt=""
                  className="w-full max-w-[280px] mx-auto aspect-square rounded-2xl object-cover shadow-2xl"
                  loading="lazy"
                  decoding="async"
                />
              ) : (
                <div className="w-full max-w-[280px] mx-auto aspect-square rounded-2xl bg-white/10 flex items-center justify-center">
                  <span className="text-6xl">🎙️</span>
                </div>
              )}
            </div>

            {/* Episode Info */}
            <div className="px-8 text-center mb-6">
              <h2 className="text-xl font-bold text-white line-clamp-2">
                {episode.title}
              </h2>
              {episode.podcast_title && (
                <p className="text-white/60 truncate mt-1">
                  {episode.podcast_title}
                </p>
              )}
            </div>

            {/* Progress bar */}
            <div className="px-8 mb-4">
              <div 
                className="h-1.5 bg-white/20 rounded-full cursor-pointer"
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const pct = (e.clientX - rect.left) / rect.width;
                  seekTo(pct);
                }}
              >
                <div 
                  className="h-full bg-orange-500 rounded-full transition-all duration-150"
                  style={{ width: `${duration ? (currentTime / duration) * 100 : 0}%` }}
                />
              </div>
              <div className="flex justify-between text-xs text-white/50 mt-1">
                <span>{formatTime(currentTime)}</span>
                <span>{formatTime(duration)}</span>
              </div>
            </div>

            {/* Main Controls */}
            <div className="flex items-center justify-center gap-6 mb-6">
              <button
                onClick={() => skip(-15)}
                className="p-3 rounded-full text-white/70 font-bold text-lg"
              >
                -15
              </button>
              <button
                onClick={togglePlay}
                className="p-5 rounded-full bg-white text-black shadow-lg"
              >
                {playing ? (
                  <svg className="w-8 h-8" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
                  </svg>
                ) : (
                  <svg className="w-8 h-8" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                )}
              </button>
              <button
                onClick={() => skip(15)}
                className="p-3 rounded-full text-white/70 font-bold text-lg"
              >
                +15
              </button>
            </div>

            {/* Speed Control */}
            <div className="flex justify-center gap-2 mb-6">
              {[0.75, 1, 1.25, 1.5, 1.75, 2].map((rate) => (
                <button
                  key={rate}
                  onClick={() => setPlaybackRate(rate)}
                  className={`px-3 py-1.5 rounded-full text-sm font-medium transition ${
                    playbackRate === rate 
                      ? 'bg-orange-500 text-white' 
                      : 'bg-white/10 text-white/70 hover:bg-white/20'
                  }`}
                >
                  {rate}x
                </button>
              ))}
            </div>

            {/* Close Button */}
            <div className="px-8 mt-auto pb-8">
              <button
                onClick={onClose}
                className="w-full py-3 rounded-full bg-white/10 text-white hover:bg-white/20 transition"
              >
                Close Player
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Mini Player Bar */}
      <div 
        className={`fixed left-0 right-0 lg:left-64 glass border-t border-white/10 z-40 h-[72px] ${hasMusicPlayer ? 'bottom-[72px]' : 'bottom-0'}`}
        onClick={() => setExpanded(true)}
      >
        {/* Progress bar at top of player */}
        <div 
          className="h-1 bg-white/10 cursor-pointer"
          onClick={(e) => {
            e.stopPropagation();
            const rect = e.currentTarget.getBoundingClientRect();
            const pct = (e.clientX - rect.left) / rect.width;
            seekTo(pct);
          }}
        >
          <div 
            className="h-full bg-orange-500 transition-all duration-150"
            style={{ width: `${duration ? (currentTime / duration) * 100 : 0}%` }}
          />
        </div>

        <div className="px-4 py-3">
          <div className="max-w-4xl mx-auto flex items-center gap-3">
            {/* Episode artwork */}
            {imageUrl ? (
              <img
                src={imageUrl}
                alt=""
                className="w-12 h-12 sm:w-14 sm:h-14 rounded-lg object-cover flex-shrink-0"
                loading="lazy"
                decoding="async"
              />
            ) : (
              <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-lg bg-white/10 flex items-center justify-center flex-shrink-0">
                <span className="text-xl">🎙️</span>
              </div>
            )}

            {/* Episode info */}
            <div className="flex-1 min-w-0">
              <div className="font-semibold text-white truncate text-sm sm:text-base">{episode.title}</div>
              {episode.podcast_title && (
                <div className="text-xs sm:text-sm text-white/60 truncate">{episode.podcast_title}</div>
              )}
            </div>

            {/* Mobile Controls */}
            <div className="flex sm:hidden items-center gap-1">
              <button
                onClick={(e) => { e.stopPropagation(); skip(-15); }}
                className="p-2 rounded-full text-white/70 font-bold text-xs"
              >
                -15
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); togglePlay(); }}
                className="p-2 rounded-full bg-white text-black"
              >
                {playing ? (
                  <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
                  </svg>
                ) : (
                  <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                )}
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); skip(15); }}
                className="p-2 rounded-full text-white/70 font-bold text-xs"
              >
                +15
              </button>
            </div>

            {/* Desktop Controls */}
            <div className="hidden sm:flex items-center gap-2">
              <button
                onClick={(e) => { e.stopPropagation(); skip(-15); }}
                className="p-2.5 rounded-full text-white/80 hover:text-white hover:bg-white/10 transition font-bold text-sm"
              >
                -15
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); togglePlay(); }}
                className="p-3 rounded-full bg-white text-black hover:bg-white/90 hover:scale-105 transition-all shadow-lg"
              >
                {playing ? (
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                )}
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); skip(15); }}
                className="p-2.5 rounded-full text-white/80 hover:text-white hover:bg-white/10 transition font-bold text-sm"
              >
                +15
              </button>
            </div>

            {/* Desktop Right Side */}
            <div className="hidden md:flex items-center gap-2">
              <select
                value={playbackRate}
                onChange={(e) => { e.stopPropagation(); setPlaybackRate(Number(e.target.value)); }}
                onClick={(e) => e.stopPropagation()}
                className="bg-slate-800 text-white text-sm px-2 py-1 rounded border border-white/20 hover:bg-slate-700 transition cursor-pointer"
              >
                <option value={0.75}>0.75x</option>
                <option value={1}>1x</option>
                <option value={1.25}>1.25x</option>
                <option value={1.5}>1.5x</option>
                <option value={1.75}>1.75x</option>
                <option value={2}>2x</option>
              </select>
              <span className="text-xs text-white/50 tabular-nums ml-2">
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>
              <button 
                onClick={(e) => { e.stopPropagation(); onClose(); }}
                className="p-2 rounded-full hover:bg-white/10 text-white/40 hover:text-white transition ml-2"
                title="Close"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function Podcasts() {
  const token = useAuth((s) => s.token);
  const clear = useAuth((s) => s.clear);
  const podcastEpisode = useUi((s) => s.podcastEpisode);
  const setPodcastEpisode = useUi((s) => s.setPodcastEpisode);
  const lastProgress = usePodcastProgress((s) => s.lastProgress);
  
  // Navigation using new router
  const route = useRouter((s) => s.route);
  const navigate = useRouter((s) => s.navigate);
  const back = useRouter((s) => s.back);
  
  // Derive state from route
  const view = (route.type === 'podcasts' && route.sub ? route.sub : 'new') as 'subscriptions' | 'new';
  const selectedPodcastId = route.type === 'podcast' ? route.podcastId : null;

  const [podcasts, setPodcasts] = useState<Podcast[]>([]);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [newEpisodes, setNewEpisodes] = useState<Episode[]>([]);
  const [showSubscribe, setShowSubscribe] = useState(false);
  const [loading, setLoading] = useState(true);
  
  // Derive selectedPodcast from podcasts list and route
  const selectedPodcast = selectedPodcastId ? podcasts.find(p => p.id === selectedPodcastId) || null : null;

  // Select podcast with router
  const selectPodcast = useCallback((podcast: Podcast) => {
    navigate({ type: 'podcast', podcastId: podcast.id });
  }, [navigate]);

  // Go back to list
  const goBackToList = useCallback(() => {
    back();
  }, [back]);

  // Switch view with router - also clear selected podcast to return to list
  const switchView = useCallback((newView: 'subscriptions' | 'new') => {
    // If we're in a podcast detail, go back first
    if (selectedPodcastId) {
      back();
    }
    setEpisodes([]);
    if (newView !== view) {
      navigate({ type: 'podcasts', sub: newView });
    }
  }, [view, navigate, selectedPodcastId, back]);

  // Update episode progress when WebSocket update arrives
  useEffect(() => {
    if (!lastProgress) return;
    const { episodeId, position_ms, played } = lastProgress;
    setEpisodes((prev) => prev.map((e) => 
      e.id === episodeId ? { ...e, position_ms, played } : e
    ));
    setNewEpisodes((prev) => {
      const exists = prev.some((e) => e.id === episodeId);
      if (exists) {
        // Update existing episode
        return prev.map((e) => 
          e.id === episodeId ? { ...e, position_ms, played } : e
        );
      }
      // If episode isn't in Continue Listening yet but has >30s progress,
      // add it from current playing episode (if it matches)
      if (position_ms > 30000 && !played && podcastEpisode && podcastEpisode.id === episodeId) {
        const newEp: Episode = { 
          ...podcastEpisode, 
          position_ms, 
          played: false,
          downloaded: false // Default to false, will be updated on next full refresh
        };
        return [newEp, ...prev];
      }
      return prev;
    });
  }, [lastProgress, podcastEpisode]);

  // Load podcasts
  const loadPodcasts = useCallback(async () => {
    if (!token) return;
    try {
      const r = await apiFetch('/podcasts', { method: 'GET' }, token);
      setPodcasts(r.podcasts || []);
    } catch (e: any) {
      if (e?.status === 401) clear();
    }
  }, [token, clear]);

  // Load new episodes
  const loadNewEpisodes = useCallback(async () => {
    if (!token) return;
    try {
      const r = await apiFetch('/podcasts/episodes/new', { method: 'GET' }, token);
      setNewEpisodes(r.episodes || []);
    } catch (e: any) {
      if (e?.status === 401) clear();
    }
  }, [token, clear]);

  // Load episodes for selected podcast
  const loadEpisodes = useCallback(async (podcastId: number) => {
    if (!token) return;
    try {
      const r = await apiFetch(`/podcasts/${podcastId}`, { method: 'GET' }, token);
      setEpisodes(r.episodes || []);
    } catch (e: any) {
      if (e?.status === 401) clear();
    }
  }, [token, clear]);

  useEffect(() => {
    setLoading(true);
    Promise.all([loadPodcasts(), loadNewEpisodes()]).finally(() => setLoading(false));
  }, [loadPodcasts, loadNewEpisodes]);

  useEffect(() => {
    if (selectedPodcast) {
      loadEpisodes(selectedPodcast.id);
    }
  }, [selectedPodcast, loadEpisodes]);

  const handleMarkPlayed = async (episodeId: number, played: boolean) => {
    if (!token) return;
    try {
      await apiFetch(`/podcasts/episodes/${episodeId}/played`, { method: 'POST', body: JSON.stringify({ played }) }, token);
      // Update local state
      setEpisodes((prev) => prev.map((e) => (e.id === episodeId ? { ...e, played } : e)));
      setNewEpisodes((prev) => prev.filter((e) => e.id !== episodeId || !played));
      loadPodcasts(); // Refresh unplayed counts
    } catch (e: any) {
      if (e?.status === 401) clear();
    }
  };

  const handleDownload = async (episodeId: number) => {
    if (!token) return;
    try {
      await apiFetch(`/podcasts/episodes/${episodeId}/download`, { method: 'POST' }, token);
      // Update local state
      setEpisodes((prev) => prev.map((e) => (e.id === episodeId ? { ...e, downloaded: true } : e)));
      setNewEpisodes((prev) => prev.map((e) => (e.id === episodeId ? { ...e, downloaded: true } : e)));
    } catch (e: any) {
      if (e?.status === 401) clear();
      else alert('Download failed: ' + (e?.message || 'Unknown error'));
    }
  };

  const handleDeleteDownload = async (episodeId: number) => {
    if (!token) return;
    try {
      await apiFetch(`/podcasts/episodes/${episodeId}/download`, { method: 'DELETE' }, token);
      // Update local state
      setEpisodes((prev) => prev.map((e) => (e.id === episodeId ? { ...e, downloaded: false } : e)));
      setNewEpisodes((prev) => prev.map((e) => (e.id === episodeId ? { ...e, downloaded: false } : e)));
    } catch (e: any) {
      if (e?.status === 401) clear();
    }
  };

  const handleUnsubscribe = async (podcastId: number) => {
    if (!token) return;
    if (!confirm('Unsubscribe from this podcast?')) return;
    try {
      await apiFetch(`/podcasts/${podcastId}/unsubscribe`, { method: 'DELETE' }, token);
      setPodcasts((prev) => prev.filter((p) => p.id !== podcastId));
      if (selectedPodcast?.id === podcastId) {
        navigate({ type: 'podcasts', sub: view });
        setEpisodes([]);
      }
    } catch (e: any) {
      if (e?.status === 401) clear();
    }
  };

  if (!token) {
    return (
      <div className="flex items-center justify-center h-64 text-slate-400">
        Please log in to access podcasts
      </div>
    );
  }

  return (
    <div className="min-h-screen pb-32">
      {/* Header */}
      <div className="bg-gradient-to-b from-orange-900/50 to-transparent p-6 sm:p-8">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl sm:text-3xl font-bold text-white">Podcasts</h1>
          <button
            onClick={() => setShowSubscribe(true)}
            className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded-full flex items-center gap-2 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
            </svg>
            Subscribe
          </button>
        </div>

        {/* View tabs */}
        <div className="flex gap-4">
          <button
            onClick={() => switchView('new')}
            className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
              view === 'new' && !selectedPodcast ? 'bg-white text-black' : 'bg-slate-700/50 text-white hover:bg-slate-700'
            }`}
          >
            Continue Listening
          </button>
          <button
            onClick={() => switchView('subscriptions')}
            className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
              view === 'subscriptions' && !selectedPodcast ? 'bg-white text-black' : 'bg-slate-700/50 text-white hover:bg-slate-700'
            }`}
          >
            Subscriptions
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="px-4 sm:px-6">
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-cyan-500" />
          </div>
        ) : selectedPodcast ? (
          // Podcast detail view
          <div>
            <button
              onClick={goBackToList}
              className="flex items-center gap-2 text-slate-400 hover:text-white mb-4 transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              Back
            </button>

            <div className="flex items-start gap-4 mb-6">
              <img
                src={selectedPodcast.image_path ? `/api/podcast-art/${selectedPodcast.image_path}` : `/api/podcasts/${selectedPodcast.id}/art`}
                alt={selectedPodcast.title}
                className="w-24 h-24 sm:w-32 sm:h-32 rounded-xl object-cover bg-slate-700"
                loading="lazy"
                decoding="async"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
              />
              <div className="flex-1">
                <h2 className="text-xl sm:text-2xl font-bold text-white">{selectedPodcast.title}</h2>
                {selectedPodcast.author && (
                  <p className="text-slate-400">{selectedPodcast.author}</p>
                )}
                <button
                  onClick={() => handleUnsubscribe(selectedPodcast.id)}
                  className="mt-2 text-sm text-red-400 hover:text-red-300"
                >
                  Unsubscribe
                </button>
              </div>
            </div>

            <div className="space-y-2">
              {episodes.map((ep) => (
                <EpisodeRow
                  key={ep.id}
                  episode={ep}
                  onPlay={() => setPodcastEpisode({ ...ep, podcast_title: selectedPodcast.title, podcast_image_url: selectedPodcast.image_url, podcast_image_path: (selectedPodcast as any).image_path })}
                  onMarkPlayed={(played) => handleMarkPlayed(ep.id, played)}
                  onDownload={() => handleDownload(ep.id)}
                  onDeleteDownload={() => handleDeleteDownload(ep.id)}
                />
              ))}
            </div>
          </div>
        ) : view === 'new' ? (
          // New episodes view
          <div>
            {newEpisodes.length === 0 ? (
              <div className="text-center py-12 text-slate-400">
                <p>No new episodes</p>
                <p className="text-sm mt-1">Subscribe to podcasts to see new episodes here</p>
              </div>
            ) : (
              <div className="space-y-2">
                {newEpisodes.map((ep) => (
                  <EpisodeRow
                    key={ep.id}
                    episode={ep}
                    onPlay={() => setPodcastEpisode(ep)}
                    onMarkPlayed={(played) => handleMarkPlayed(ep.id, played)}
                    onDownload={() => handleDownload(ep.id)}
                    onDeleteDownload={() => handleDeleteDownload(ep.id)}
                  />
                ))}
              </div>
            )}
          </div>
        ) : (
          // Subscriptions grid
          <div>
            {podcasts.length === 0 ? (
              <div className="text-center py-12 text-slate-400">
                <p>No subscriptions yet</p>
                <p className="text-sm mt-1">Click &quot;Subscribe&quot; to add a podcast</p>
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                {podcasts.map((p) => (
                  <div
                    key={p.id}
                    onClick={() => selectPodcast(p)}
                    className="group cursor-pointer"
                  >
                    <div className="relative aspect-square rounded-xl overflow-hidden bg-slate-700 mb-2">
                      <img 
                        src={p.image_path ? `/api/podcast-art/${p.image_path}` : `/api/podcasts/${p.id}/art`} 
                        alt={p.title} 
                        className="w-full h-full object-cover"
                        loading="lazy"
                        decoding="async"
                        onError={(e) => { 
                          (e.target as HTMLImageElement).style.display = 'none'; 
                          (e.target as HTMLImageElement).nextElementSibling?.classList.remove('hidden');
                        }}
                      />
                      <div className="w-full h-full flex items-center justify-center text-4xl absolute inset-0 hidden">🎙️</div>
                      {p.unplayed_count > 0 && (
                        <div className="absolute top-2 right-2 bg-cyan-600 text-white text-xs font-bold px-2 py-1 rounded-full">
                          {p.unplayed_count}
                        </div>
                      )}
                    </div>
                    <h3 className="font-semibold text-white text-sm truncate group-hover:text-cyan-400 transition-colors">
                      {p.title}
                    </h3>
                    {p.author && (
                      <p className="text-xs text-slate-400 truncate">{p.author}</p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Subscribe modal */}
      {showSubscribe && (
        <SubscribeModal
          onClose={() => setShowSubscribe(false)}
          onSubscribed={() => {
            loadPodcasts();
            loadNewEpisodes();
            switchView('subscriptions');
          }}
          subscribedFeedUrls={new Set(podcasts.map(p => p.feed_url))}
        />
      )}
    </div>
  );
}

'use client';

import { useEffect, useState, useCallback, useRef, useMemo, type ReactNode } from 'react';
import { useAuth } from './store';
import { useUi, PodcastEpisode } from './uiStore';
import { usePlayer } from './playerStore';
import { useRouter } from './router';
import { apiFetch } from './apiClient';
import { showConfirm, showAlert } from './ConfirmModal';
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
  language?: string | null;
  last_fetched_at?: string | null;
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

interface PodcastPreview {
  title: string;
  author: string | null;
  description: string | null;
  imageUrl: string | null;
  link: string | null;
  language: string | null;
  lastBuildDate: string | null;
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
  const [previewDialog, setPreviewDialog] = useState<{
    result: SearchResult;
    loading: boolean;
    preview?: PodcastPreview;
    error?: string;
  } | null>(null);

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

  const showSearchResultDetails = async (result: SearchResult) => {
    setPreviewDialog({ result, loading: true });
    try {
      const res = await apiFetch(`/podcasts/preview?feedUrl=${encodeURIComponent(result.feedUrl)}`, {}, token!);
      setPreviewDialog((current) => (
        current?.result.feedUrl === result.feedUrl
          ? { result, loading: false, preview: res.preview }
          : current
      ));
    } catch (err: any) {
      setPreviewDialog((current) => (
        current?.result.feedUrl === result.feedUrl
          ? {
              result,
              loading: false,
              error: err?.data?.error || err?.error || err?.message || 'Unable to load podcast details',
            }
          : current
      ));
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
        <div className="flex flex-wrap gap-2 mb-4">
          <ChipButton
            selected={tab === 'search'}
            onClick={() => setTab('search')}
          >
            <SearchGlyph />
            Search
          </ChipButton>
          <ChipButton
            selected={tab === 'rss'}
            onClick={() => setTab('rss')}
          >
            <RssGlyph />
            RSS URL
          </ChipButton>
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
                    className="flex items-start gap-3 p-3 rounded-lg bg-slate-700/50 hover:bg-slate-700 transition-colors"
                  >
                    <PodcastArtwork src={result.imageUrl} alt={result.title} className="w-14 h-14 flex-shrink-0 rounded-lg" />
                    <div className="flex-1 min-w-0">
                      <h3 className="font-semibold text-white truncate">{result.title}</h3>
                      <p className="text-sm text-slate-400 truncate">{result.author}</p>
                      {result.genre && (
                        <p className="text-xs text-slate-500">{result.genre} • {result.episodeCount || '?'} episodes</p>
                      )}
                    </div>
                    <div className="flex flex-shrink-0 flex-col gap-2 sm:flex-row">
                      <button
                        type="button"
                        onClick={() => showSearchResultDetails(result)}
                        className="rounded-full border border-white/10 px-4 py-2 text-sm font-bold text-slate-200 transition hover:bg-white/10 hover:text-white"
                      >
                        Details
                      </button>
                      {isSubscribed ? (
                        <span className="rounded-full bg-slate-600 px-4 py-2 text-sm font-bold text-slate-400">
                          Subscribed
                        </span>
                      ) : (
                        <button
                          onClick={() => subscribeToResult(result)}
                          disabled={subscribing === result.id}
                          className="rounded-full bg-cyan-600 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-cyan-500 disabled:opacity-50"
                        >
                          {subscribing === result.id ? '...' : 'Subscribe'}
                        </button>
                      )}
                    </div>
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

        {previewDialog && (
          <PodcastTextDialog
            label="Podcast details"
            title={previewDialog.preview?.title || previewDialog.result.title}
            subtitle={previewDialog.preview?.author || previewDialog.result.author}
            meta={[
              previewDialog.preview?.language?.trim() ? previewDialog.preview.language.trim().toUpperCase() : null,
              `${previewDialog.preview?.episodeCount ?? previewDialog.result.episodeCount ?? '?'} episodes`,
              previewDialog.result.genre,
            ].filter(Boolean).join(' - ')}
            description={
              previewDialog.loading
                ? 'Loading podcast description...'
                : previewDialog.error
                  ? previewDialog.error
                  : stripHtml(previewDialog.preview?.description || null)
            }
            onClose={() => setPreviewDialog(null)}
            footer={
              <>
                <ChipButton onClick={() => setPreviewDialog(null)}>
                  Close
                </ChipButton>
                {subscribedFeedUrls.has(previewDialog.result.feedUrl) ? (
                  <span className="inline-flex h-10 items-center rounded-full bg-slate-800 px-4 text-sm font-bold text-slate-400">
                    Subscribed
                  </span>
                ) : (
                  <ChipButton
                    tone="accent"
                    onClick={() => subscribeToResult(previewDialog.result)}
                    disabled={subscribing === previewDialog.result.id}
                  >
                    {subscribing === previewDialog.result.id ? 'Subscribing...' : 'Subscribe'}
                  </ChipButton>
                )}
              </>
            }
          />
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

type PodcastHomeView = 'new' | 'subscriptions';
type EpisodeFilter = 'all' | 'unplayed' | 'progress';

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

function PodcastGlyph({ className = 'w-6 h-6' }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5a7 7 0 017 7v3a7 7 0 01-14 0v-3a7 7 0 017-7z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12a3 3 0 116 0v3a3 3 0 11-6 0v-3zM12 18v3" />
    </svg>
  );
}

function PlayGlyph({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function PlusGlyph({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v14m7-7H5" />
    </svg>
  );
}

function SearchGlyph({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35m1.85-5.65a7.5 7.5 0 11-15 0 7.5 7.5 0 0115 0z" />
    </svg>
  );
}

function RssGlyph({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 19h.01M5 5a14 14 0 0114 14M5 12a7 7 0 017 7" />
    </svg>
  );
}

function BackGlyph({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
    </svg>
  );
}

function RefreshGlyph({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 11a8.1 8.1 0 00-15.5-2M4 5v4h4m-4 4a8.1 8.1 0 0015.5 2M20 19v-4h-4" />
    </svg>
  );
}

function DownloadGlyph({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
    </svg>
  );
}

function CheckGlyph({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
    </svg>
  );
}

function CircleGlyph({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8" strokeWidth={2} />
    </svg>
  );
}

function SpinnerGlyph({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={cx(className, 'animate-spin')} fill="none" viewBox="0 0 24 24" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.4 0 0 5.4 0 12h4z" />
    </svg>
  );
}

function ChipButton({
  selected = false,
  disabled = false,
  tone = 'default',
  className,
  children,
  onClick,
  title,
}: {
  selected?: boolean;
  disabled?: boolean;
  tone?: 'default' | 'accent' | 'danger';
  className?: string;
  children: ReactNode;
  onClick?: () => void;
  title?: string;
}) {
  const toneClasses = selected
    ? 'bg-white text-slate-950 border-white shadow-sm'
    : tone === 'accent'
      ? 'bg-cyan-600 text-white border-cyan-500 hover:bg-cyan-500'
      : tone === 'danger'
        ? 'bg-red-500/10 text-red-300 border-red-400/30 hover:bg-red-500/20'
        : 'bg-slate-800/80 text-slate-200 border-white/10 hover:bg-slate-700/80';

  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={cx(
        'inline-flex h-10 items-center justify-center gap-2 rounded-full border px-4 text-sm font-bold transition disabled:cursor-not-allowed disabled:opacity-50',
        toneClasses,
        className
      )}
    >
      {children}
    </button>
  );
}

function CountPill({ children, accent = false }: { children: ReactNode; accent?: boolean }) {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-full px-2.5 py-1 text-xs font-bold',
        accent ? 'bg-cyan-600 text-white' : 'bg-slate-800 text-slate-200'
      )}
    >
      {children}
    </span>
  );
}

function PodcastArtwork({ src, alt, className }: { src?: string | null; alt: string; className: string }) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  return (
    <div className={cx('relative overflow-hidden bg-slate-800 text-slate-500', className)}>
      {src && !failed ? (
        <img
          src={src}
          alt={alt}
          className="h-full w-full object-cover"
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <PodcastGlyph className="h-8 w-8" />
        </div>
      )}
    </div>
  );
}

function podcastArtUrl(podcast: Podcast): string {
  return podcast.image_path ? `/api/podcast-art/${podcast.image_path}` : `/api/podcasts/${podcast.id}/art`;
}

function episodeArtUrl(episode: Episode): string {
  return episode.image_path
    ? `/api/podcast-art/${episode.image_path}`
    : episode.podcast_image_path
      ? `/api/podcast-art/${episode.podcast_image_path}`
      : episode.image_url
        ? episode.image_url
        : episode.podcast_image_url
          ? episode.podcast_image_url
          : `/api/podcasts/episodes/${episode.id}/art`;
}

function episodeProgressPercent(episode: Episode): number {
  if (!episode.duration_ms || episode.duration_ms <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((episode.position_ms / episode.duration_ms) * 100)));
}

function episodeRemainingText(episode: Episode): string | null {
  if (!episode.duration_ms || episode.duration_ms <= 0 || episode.position_ms <= 0) return null;
  const remainingMs = Math.max(0, episode.duration_ms - episode.position_ms);
  const remainingMinutes = Math.max(1, Math.floor(remainingMs / 60000));
  return `${remainingMinutes} min left`;
}

function episodeMetaText(episode: Episode, includeProgress = true): string {
  const parts = [formatDate(episode.published_at), formatDuration(episode.duration_ms)].filter(Boolean);
  if (includeProgress && episode.position_ms > 0 && !episode.played) {
    parts.push(episodeRemainingText(episode) || `${episodeProgressPercent(episode)}% played`);
  }
  if (episode.played) parts.push('Played');
  if (episode.downloaded) parts.push('Downloaded');
  return parts.join(' - ');
}

function PodcastTextDialog({
  label,
  title,
  subtitle,
  meta,
  description,
  footer,
  onClose,
}: {
  label: string;
  title: string;
  subtitle?: string | null;
  meta?: string | null;
  description?: string | null;
  footer?: ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="max-h-[82vh] w-full max-w-2xl overflow-hidden rounded-lg border border-white/10 bg-slate-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <h2 className="text-lg font-bold text-white">{label}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-2 text-slate-400 transition hover:bg-white/10 hover:text-white"
            title="Close"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="max-h-[calc(82vh-68px)] overflow-y-auto px-5 py-4">
          <h3 className="text-xl font-bold text-white">{title}</h3>
          {subtitle && <p className="mt-1 text-sm font-medium text-cyan-300">{subtitle}</p>}
          {meta && <p className="mt-1 text-xs font-semibold text-slate-500">{meta}</p>}
          <p className="mt-5 whitespace-pre-line text-sm leading-6 text-slate-300">
            {description?.trim() || 'No description available.'}
          </p>
        </div>
        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-white/10 px-5 py-4">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
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
  featured = false,
  showPodcastTitle = true,
  showDescription = true,
}: {
  episode: Episode;
  onPlay: () => void;
  onMarkPlayed: (played: boolean) => void;
  onDownload: () => void;
  onDeleteDownload: () => void;
  featured?: boolean;
  showPodcastTitle?: boolean;
  showDescription?: boolean;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const progress = episodeProgressPercent(episode);
  const imageUrl = episodeArtUrl(episode);
  const cleanDescription = stripHtml(episode.description);
  const hasProgress = episode.position_ms > 0 && !episode.played;

  const handleDownload = async () => {
    setDownloading(true);
    try {
      await onDownload();
    } finally {
      setDownloading(false);
    }
  };

  return (
    <>
      {showDetails && (
        <PodcastTextDialog
          label="Episode details"
          title={episode.title}
          subtitle={episode.podcast_title}
          meta={episodeMetaText(episode, true)}
          description={cleanDescription}
          onClose={() => setShowDetails(false)}
        />
      )}

      <article
        className={cx(
          'group rounded-lg border border-white/10 bg-slate-900/55 transition hover:border-white/20 hover:bg-slate-900',
          featured && 'bg-slate-900/90 shadow-xl shadow-black/20',
          episode.played && 'opacity-60'
        )}
      >
        <div className={cx('flex items-start gap-3', featured ? 'p-4 sm:gap-5 sm:p-5' : 'p-3 sm:p-4')}>
          <button
            type="button"
            onClick={onPlay}
            className={cx(
              'group/play relative flex-shrink-0 overflow-hidden rounded-lg bg-slate-800',
              featured ? 'h-24 w-24 sm:h-28 sm:w-28' : 'h-16 w-16'
            )}
            title="Play episode"
          >
            <PodcastArtwork src={imageUrl} alt="" className="h-full w-full rounded-lg" />
            <span className="absolute inset-0 flex items-center justify-center bg-black/45 opacity-0 transition group-hover/play:opacity-100">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-white text-slate-950 shadow-lg">
                <PlayGlyph className="h-5 w-5" />
              </span>
            </span>
          </button>

          <div className="min-w-0 flex-1">
            {showPodcastTitle && episode.podcast_title && (
              <p className="truncate text-sm font-bold text-cyan-300">{episode.podcast_title}</p>
            )}
            <h3
              className={cx(
                'font-bold leading-snug text-white',
                featured ? 'line-clamp-2 text-lg sm:text-xl' : 'line-clamp-2 text-sm sm:text-base'
              )}
            >
              {episode.title}
            </h3>
            <p className="mt-1 truncate text-xs font-medium text-slate-500">
              {episodeMetaText(episode, true)}
            </p>

            {showDescription && cleanDescription && (
              <p className={cx('mt-2 text-sm leading-5 text-slate-400', featured ? 'line-clamp-3' : 'line-clamp-2')}>
                {cleanDescription}
              </p>
            )}

            {hasProgress && episode.duration_ms && (
              <div className="mt-3">
                <div className="h-1 overflow-hidden rounded-full bg-slate-700">
                  <div className="h-full rounded-full bg-orange-500" style={{ width: `${progress}%` }} />
                </div>
              </div>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-2">
              {hasProgress && (
                <span className="text-xs font-bold text-orange-300">
                  {episodeRemainingText(episode) || `${progress}% played`}
                </span>
              )}
              {cleanDescription && (
                <button
                  type="button"
                  onClick={() => setShowDetails(true)}
                  className="rounded-full border border-white/10 px-3 py-1 text-xs font-bold text-slate-300 transition hover:bg-white/10 hover:text-white"
                >
                  Details
                </button>
              )}
              {episode.downloaded && <CountPill>Downloaded</CountPill>}
            </div>
          </div>

          <div className="flex flex-shrink-0 flex-col items-center gap-1">
            {episode.downloaded ? (
              <button
                type="button"
                onClick={onDeleteDownload}
                className="rounded-full p-2 text-green-300 transition hover:bg-red-500/10 hover:text-red-300"
                title="Remove download"
              >
                <CheckGlyph className="h-5 w-5" />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleDownload}
                disabled={downloading}
                className="rounded-full p-2 text-slate-400 transition hover:bg-white/10 hover:text-white disabled:opacity-50"
                title="Download for offline"
              >
                {downloading ? <SpinnerGlyph className="h-5 w-5" /> : <DownloadGlyph className="h-5 w-5" />}
              </button>
            )}

            <button
              type="button"
              onClick={() => onMarkPlayed(!episode.played)}
              className={cx(
                'rounded-full p-2 transition hover:bg-white/10',
                episode.played ? 'text-orange-300' : 'text-slate-400 hover:text-white'
              )}
              title={episode.played ? 'Mark as unplayed' : 'Mark as played'}
            >
              {episode.played ? <CheckGlyph className="h-5 w-5" /> : <CircleGlyph className="h-5 w-5" />}
            </button>
          </div>
        </div>
      </article>
    </>
  );
}

function PodcastSwitcher({
  view,
  continueCount,
  subscriptionCount,
  onViewChange,
  onSubscribeClick,
}: {
  view: PodcastHomeView;
  continueCount: number;
  subscriptionCount: number;
  onViewChange: (view: PodcastHomeView) => void;
  onSubscribeClick: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ChipButton
        selected={view === 'new'}
        onClick={() => onViewChange('new')}
        className="min-w-[132px]"
      >
        Continue
        {continueCount > 0 && <span className="text-xs opacity-75">{Math.min(continueCount, 999)}</span>}
      </ChipButton>
      <ChipButton
        selected={view === 'subscriptions'}
        onClick={() => onViewChange('subscriptions')}
        className="min-w-[110px]"
      >
        Shows
        {subscriptionCount > 0 && <span className="text-xs opacity-75">{Math.min(subscriptionCount, 999)}</span>}
      </ChipButton>
      <ChipButton tone="accent" onClick={onSubscribeClick} title="Add podcast">
        <PlusGlyph />
        Add
      </ChipButton>
    </div>
  );
}

function EmptyPodcastState({
  title,
  body,
  actionLabel,
  onAction,
}: {
  title: string;
  body: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="flex min-h-[320px] items-center justify-center text-center">
      <div className="max-w-sm px-6">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-slate-800 text-cyan-300">
          <PodcastGlyph className="h-8 w-8" />
        </div>
        <h2 className="mt-4 text-lg font-bold text-white">{title}</h2>
        <p className="mt-1 text-sm text-slate-400">{body}</p>
        <ChipButton tone="accent" onClick={onAction} className="mt-5">
          {actionLabel}
        </ChipButton>
      </div>
    </div>
  );
}

function PodcastGridItem({ podcast, onClick }: { podcast: Podcast; onClick: () => void }) {
  const [showDetails, setShowDetails] = useState(false);
  const description = stripHtml(podcast.description);
  const meta = [
    podcast.unplayed_count > 0 ? `${podcast.unplayed_count} unplayed` : null,
    podcast.language?.trim() ? podcast.language.trim().toUpperCase() : null,
  ].filter(Boolean).join(' - ');

  return (
    <>
      {showDetails && (
        <PodcastTextDialog
          label="Podcast details"
          title={podcast.title}
          subtitle={podcast.author}
          meta={meta}
          description={description}
          onClose={() => setShowDetails(false)}
        />
      )}

      <article className="group min-w-0">
        <button type="button" onClick={onClick} className="block w-full text-left">
          <div className="relative">
            <PodcastArtwork src={podcastArtUrl(podcast)} alt={podcast.title} className="aspect-square w-full rounded-lg" />
            {podcast.unplayed_count > 0 && (
              <span className="absolute right-2 top-2 rounded-full bg-cyan-600 px-2 py-1 text-xs font-bold text-white shadow">
                {podcast.unplayed_count}
              </span>
            )}
          </div>
          <h3 className="mt-2 line-clamp-2 text-sm font-bold leading-snug text-white transition group-hover:text-cyan-300">
            {podcast.title}
          </h3>
          {podcast.author && <p className="mt-1 truncate text-xs text-slate-500">{podcast.author}</p>}
        </button>
        {description && (
          <button
            type="button"
            onClick={() => setShowDetails(true)}
            className="mt-2 rounded-full border border-white/10 px-3 py-1 text-xs font-bold text-slate-300 transition hover:bg-white/10 hover:text-white"
          >
            Details
          </button>
        )}
      </article>
    </>
  );
}

function ContinueListeningView({
  episodes,
  onEpisodePlay,
  onMarkPlayed,
  onDownload,
  onDeleteDownload,
  onSubscriptionsClick,
}: {
  episodes: Episode[];
  onEpisodePlay: (episode: Episode) => void;
  onMarkPlayed: (episodeId: number, played: boolean) => void;
  onDownload: (episodeId: number) => void;
  onDeleteDownload: (episodeId: number) => void;
  onSubscriptionsClick: () => void;
}) {
  if (episodes.length === 0) {
    return (
      <EmptyPodcastState
        title="Nothing in progress"
        body="New and unfinished episodes will appear here."
        actionLabel="Browse shows"
        onAction={onSubscriptionsClick}
      />
    );
  }

  const featured = episodes[0];
  const rest = episodes.slice(1);

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <EpisodeRow
        episode={featured}
        featured
        onPlay={() => onEpisodePlay(featured)}
        onMarkPlayed={(played) => onMarkPlayed(featured.id, played)}
        onDownload={() => onDownload(featured.id)}
        onDeleteDownload={() => onDeleteDownload(featured.id)}
      />

      {rest.length > 0 && (
        <section>
          <h2 className="mb-2 px-1 text-sm font-bold uppercase tracking-wide text-slate-500">Up next</h2>
          <div className="space-y-2">
            {rest.map((episode) => (
              <EpisodeRow
                key={episode.id}
                episode={episode}
                showDescription={false}
                onPlay={() => onEpisodePlay(episode)}
                onMarkPlayed={(played) => onMarkPlayed(episode.id, played)}
                onDownload={() => onDownload(episode.id)}
                onDeleteDownload={() => onDeleteDownload(episode.id)}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function EpisodeFilterBar({
  selected,
  totalCount,
  unplayedCount,
  progressCount,
  onSelected,
}: {
  selected: EpisodeFilter;
  totalCount: number;
  unplayedCount: number;
  progressCount: number;
  onSelected: (filter: EpisodeFilter) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2 py-4">
      <ChipButton selected={selected === 'all'} onClick={() => onSelected('all')}>
        All {totalCount}
      </ChipButton>
      <ChipButton selected={selected === 'unplayed'} onClick={() => onSelected('unplayed')}>
        Unplayed {unplayedCount}
      </ChipButton>
      <ChipButton selected={selected === 'progress'} onClick={() => onSelected('progress')}>
        In progress {progressCount}
      </ChipButton>
    </div>
  );
}

function PodcastDetailHeader({
  podcast,
  episodeCount,
  unplayedCount,
  continueEpisode,
  latestEpisode,
  refreshing,
  onBack,
  onPlayEpisode,
  onRefresh,
  onUnsubscribe,
}: {
  podcast: Podcast;
  episodeCount: number;
  unplayedCount: number;
  continueEpisode: Episode | null;
  latestEpisode: Episode | null;
  refreshing: boolean;
  onBack: () => void;
  onPlayEpisode: (episode: Episode) => void;
  onRefresh: () => void;
  onUnsubscribe: () => void;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const description = stripHtml(podcast.description);
  const primaryEpisode = continueEpisode || latestEpisode;
  const hasSeparateLatest = Boolean(continueEpisode && latestEpisode && continueEpisode.id !== latestEpisode.id);
  const meta = [
    `${episodeCount} episodes`,
    unplayedCount > 0 ? `${unplayedCount} unplayed` : null,
    podcast.language?.trim() ? podcast.language.trim().toUpperCase() : null,
  ].filter(Boolean).join(' - ');

  return (
    <>
      {showDetails && (
        <PodcastTextDialog
          label="Podcast details"
          title={podcast.title}
          subtitle={podcast.author}
          meta={meta}
          description={description}
          onClose={() => setShowDetails(false)}
        />
      )}

      <section className="border-b border-white/10 bg-gradient-to-b from-orange-950/30 to-transparent px-4 pb-5 pt-4 sm:px-6">
        <button
          type="button"
          onClick={onBack}
          className="mb-4 inline-flex items-center gap-2 rounded-full px-2 py-1 text-sm font-bold text-slate-400 transition hover:bg-white/10 hover:text-white"
        >
          <BackGlyph />
          Back
        </button>

        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <PodcastArtwork src={podcastArtUrl(podcast)} alt={podcast.title} className="h-32 w-32 flex-shrink-0 rounded-lg sm:h-36 sm:w-36" />

          <div className="min-w-0 flex-1">
            <h1 className="line-clamp-2 text-2xl font-black leading-tight text-white sm:text-3xl">
              {podcast.title}
            </h1>
            {podcast.author && <p className="mt-1 truncate text-sm font-medium text-slate-400">{podcast.author}</p>}

            <div className="mt-3 flex flex-wrap gap-2">
              <CountPill>{episodeCount} episodes</CountPill>
              {unplayedCount > 0 && <CountPill accent>{unplayedCount} unplayed</CountPill>}
              {podcast.last_fetched_at && <CountPill>Updated {formatDate(podcast.last_fetched_at)}</CountPill>}
            </div>

            {description && (
              <div className="mt-4">
                <p className="line-clamp-3 max-w-4xl text-sm leading-6 text-slate-400">{description}</p>
                <button
                  type="button"
                  onClick={() => setShowDetails(true)}
                  className="mt-2 text-sm font-bold text-cyan-300 transition hover:text-cyan-200"
                >
                  Details
                </button>
              </div>
            )}

            <div className="mt-5 flex flex-wrap gap-2">
              <ChipButton
                tone="accent"
                disabled={!primaryEpisode}
                onClick={() => primaryEpisode && onPlayEpisode(primaryEpisode)}
                className="min-w-[160px]"
              >
                <PlayGlyph />
                {continueEpisode ? 'Continue' : 'Play latest'}
              </ChipButton>

              {hasSeparateLatest && latestEpisode && (
                <ChipButton onClick={() => onPlayEpisode(latestEpisode)}>
                  Latest
                </ChipButton>
              )}

              <ChipButton onClick={onRefresh} disabled={refreshing}>
                {refreshing ? <SpinnerGlyph /> : <RefreshGlyph />}
                Refresh
              </ChipButton>

              <ChipButton tone="danger" onClick={onUnsubscribe}>
                Unsubscribe
              </ChipButton>
            </div>
          </div>
        </div>
      </section>
    </>
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
      const positionMs = Math.floor(audioEl.currentTime * 1000);
      onProgressUpdate?.(episode.id, positionMs, true);
      // Persist played=true to the API so it leaves "Continue Listening"
      apiFetch(
        `/podcasts/episodes/${episode.id}/progress`,
        { method: 'POST', body: JSON.stringify({ positionMs, played: true }) },
        token!
      ).catch(() => {});
      updateLocalPodcastProgress(episode.id, positionMs, true);
      sendWebSocketMessage('podcast:progress', {
        episodeId: episode.id,
        position_ms: positionMs,
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
  const view = (route.type === 'podcasts' && route.sub ? route.sub : 'new') as PodcastHomeView;
  const selectedPodcastId = route.type === 'podcast' ? route.podcastId : null;

  const [podcasts, setPodcasts] = useState<Podcast[]>([]);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [newEpisodes, setNewEpisodes] = useState<Episode[]>([]);
  const [showSubscribe, setShowSubscribe] = useState(false);
  const [episodeFilter, setEpisodeFilter] = useState<EpisodeFilter>('all');
  const [refreshingPodcastId, setRefreshingPodcastId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  
  // Derive selectedPodcast from podcasts list and route
  const selectedPodcast = selectedPodcastId ? podcasts.find(p => p.id === selectedPodcastId) || null : null;
  const unplayedEpisodeCount = useMemo(() => episodes.filter((e) => !e.played).length, [episodes]);
  const inProgressEpisodeCount = useMemo(() => episodes.filter((e) => e.position_ms > 0 && !e.played).length, [episodes]);
  const continueEpisode = useMemo(() => episodes.find((e) => e.position_ms > 0 && !e.played) || null, [episodes]);
  const latestEpisode = useMemo(() => episodes.find((e) => !e.played) || episodes[0] || null, [episodes]);
  const filteredEpisodes = useMemo(() => {
    if (episodeFilter === 'unplayed') return episodes.filter((e) => !e.played);
    if (episodeFilter === 'progress') return episodes.filter((e) => e.position_ms > 0 && !e.played);
    return episodes;
  }, [episodes, episodeFilter]);

  useEffect(() => {
    setEpisodeFilter('all');
  }, [selectedPodcastId]);

  // Select podcast with router
  const selectPodcast = useCallback((podcast: Podcast) => {
    navigate({ type: 'podcast', podcastId: podcast.id });
  }, [navigate]);

  // Go back to list
  const goBackToList = useCallback(() => {
    const wentBack = back();
    if (!wentBack) {
      navigate({ type: 'podcasts', sub: view }, true);
    }
  }, [back, navigate, view]);

  // Switch view with router - also clear selected podcast to return to list
  const switchView = useCallback((newView: PodcastHomeView) => {
    // If we're in a podcast detail, go back first
    if (selectedPodcastId) {
      back();
    }
    setEpisodes([]);
    if (newView !== view) {
      navigate({ type: 'podcasts', sub: newView });
    }
  }, [view, navigate, selectedPodcastId, back]);

  const playEpisode = useCallback((episode: Episode, podcast?: Podcast | null) => {
    setPodcastEpisode({
      ...episode,
      podcast_title: episode.podcast_title || podcast?.title,
      podcast_image_url: episode.podcast_image_url ?? podcast?.image_url ?? null,
      podcast_image_path: episode.podcast_image_path ?? podcast?.image_path ?? null,
    });
  }, [setPodcastEpisode]);

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
      else showAlert('Download Failed', e?.message || 'Unknown error');
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

  const handleRefreshPodcast = async (podcastId: number) => {
    if (!token) return;
    setRefreshingPodcastId(podcastId);
    try {
      await apiFetch(`/podcasts/${podcastId}/refresh`, { method: 'POST' }, token);
      await Promise.all([loadPodcasts(), loadNewEpisodes(), loadEpisodes(podcastId)]);
    } catch (e: any) {
      if (e?.status === 401) clear();
      else showAlert('Refresh Failed', e?.error || e?.message || 'Unable to refresh this podcast.');
    } finally {
      setRefreshingPodcastId(null);
    }
  };

  const handleUnsubscribe = async (podcastId: number) => {
    if (!token) return;
    const ok = await showConfirm({ title: 'Unsubscribe', message: 'Unsubscribe from this podcast?', confirmLabel: 'Unsubscribe', danger: true });
    if (!ok) return;
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
      {!selectedPodcast && (
        <header className="border-b border-white/10 bg-gradient-to-b from-orange-950/25 to-transparent px-4 py-5 sm:px-6">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
            <div>
              <h1 className="text-2xl font-black text-white sm:text-3xl">Podcasts</h1>
              <p className="mt-1 text-sm font-medium text-slate-500">
                {view === 'new' ? 'Continue listening' : `${podcasts.length} shows`}
              </p>
            </div>
            <PodcastSwitcher
              view={view}
              continueCount={newEpisodes.length}
              subscriptionCount={podcasts.length}
              onViewChange={switchView}
              onSubscribeClick={() => setShowSubscribe(true)}
            />
          </div>
        </header>
      )}

      {selectedPodcast && !loading && (
        <PodcastDetailHeader
          podcast={selectedPodcast}
          episodeCount={episodes.length}
          unplayedCount={unplayedEpisodeCount}
          continueEpisode={continueEpisode}
          latestEpisode={latestEpisode}
          refreshing={refreshingPodcastId === selectedPodcast.id}
          onBack={goBackToList}
          onPlayEpisode={(episode) => playEpisode(episode, selectedPodcast)}
          onRefresh={() => handleRefreshPodcast(selectedPodcast.id)}
          onUnsubscribe={() => handleUnsubscribe(selectedPodcast.id)}
        />
      )}

      <main className={cx('px-4 sm:px-6', selectedPodcast ? 'py-0' : 'py-5')}>
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-cyan-500" />
          </div>
        ) : selectedPodcast ? (
          episodes.length === 0 ? (
            <EmptyPodcastState
              title="No episodes"
              body="This show has no episodes saved yet."
              actionLabel="Refresh"
              onAction={() => handleRefreshPodcast(selectedPodcast.id)}
            />
          ) : (
            <div className="mx-auto max-w-5xl pb-8">
              <EpisodeFilterBar
                selected={episodeFilter}
                totalCount={episodes.length}
                unplayedCount={unplayedEpisodeCount}
                progressCount={inProgressEpisodeCount}
                onSelected={setEpisodeFilter}
              />
              {filteredEpisodes.length === 0 ? (
                <div className="py-12 text-center text-sm font-medium text-slate-500">Nothing here</div>
              ) : (
                <div className="space-y-2">
                  {filteredEpisodes.map((ep) => (
                    <EpisodeRow
                      key={ep.id}
                      episode={ep}
                      showPodcastTitle={false}
                      onPlay={() => playEpisode(ep, selectedPodcast)}
                      onMarkPlayed={(played) => handleMarkPlayed(ep.id, played)}
                      onDownload={() => handleDownload(ep.id)}
                      onDeleteDownload={() => handleDeleteDownload(ep.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          )
        ) : selectedPodcastId ? (
          <EmptyPodcastState
            title="Podcast not found"
            body="This podcast is not in your current subscriptions."
            actionLabel="Shows"
            onAction={() => navigate({ type: 'podcasts', sub: 'subscriptions' })}
          />
        ) : view === 'new' ? (
          <ContinueListeningView
            episodes={newEpisodes}
            onEpisodePlay={(episode) => playEpisode(episode)}
            onMarkPlayed={handleMarkPlayed}
            onDownload={handleDownload}
            onDeleteDownload={handleDeleteDownload}
            onSubscriptionsClick={() => switchView('subscriptions')}
          />
        ) : (
          <div className="mx-auto max-w-7xl">
            {podcasts.length === 0 ? (
              <EmptyPodcastState
                title="No shows yet"
                body="Subscribed podcasts will appear here."
                actionLabel="Add show"
                onAction={() => setShowSubscribe(true)}
              />
            ) : (
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6 2xl:grid-cols-7">
                {podcasts.map((p) => (
                  <PodcastGridItem key={p.id} podcast={p} onClick={() => selectPodcast(p)} />
                ))}
              </div>
            )}
          </div>
        )}
      </main>

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

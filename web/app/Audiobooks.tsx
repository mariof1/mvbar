'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useAuth } from './store';
import { useUi, AudiobookChapter as AudiobookPlayerChapter } from './uiStore';
import { usePlayer } from './playerStore';
import { apiFetch } from './apiClient';

// ============================================================================
// TYPES
// ============================================================================

interface Audiobook {
  id: number;
  title: string;
  author: string | null;
  narrator: string | null;
  cover_path: string | null;
  duration_ms: number;
  chapter_count: number;
  progress: {
    chapter_id: number;
    chapter_position: number;
    chapter_title: string;
    position_ms: number;
    finished: boolean;
    total_chapters: number;
    chapters_finished: number;
  } | null;
}

interface AudiobookChapter {
  id: number;
  audiobook_id: number;
  path: string;
  title: string;
  position: number;
  duration_ms: number | null;
  size_bytes: number | null;
}

interface AudiobookDetail extends Audiobook {
  description: string | null;
  chapters: AudiobookChapter[];
}

// Re-exported from uiStore as AudiobookPlayerChapter for external consumers
export type { AudiobookPlayerChapter };

// ============================================================================
// API HELPERS
// ============================================================================

async function fetchAudiobooks(token: string): Promise<Audiobook[]> {
  return apiFetch('/audiobooks', {}, token);
}

async function fetchAudiobook(id: number, token: string): Promise<AudiobookDetail> {
  const data = await apiFetch(`/audiobooks/${id}`, {}, token) as {
    audiobook: Omit<Audiobook, 'chapter_count' | 'progress'> & { description: string | null };
    chapters: AudiobookChapter[];
    progress: Audiobook['progress'];
  };
  return {
    ...data.audiobook,
    chapter_count: data.chapters.length,
    progress: data.progress,
    chapters: data.chapters,
  };
}

async function updateProgress(audiobookId: number, chapterId: number, positionMs: number, finished: boolean, token: string) {
  return apiFetch(`/audiobooks/${audiobookId}/progress`, {
    method: 'POST',
    body: JSON.stringify({ chapter_id: chapterId, position_ms: positionMs, finished }),
  }, token);
}

async function markFinished(audiobookId: number, token: string) {
  return apiFetch(`/audiobooks/${audiobookId}/mark-finished`, { method: 'POST' }, token);
}

// ============================================================================
// HELPERS
// ============================================================================

function formatDuration(ms: number | null): string {
  if (!ms) return '--:--';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatTime(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

// ============================================================================
// AUDIOBOOK PLAYER
// ============================================================================

export function AudiobookPlayer({
  chapter,
  onClose,
}: {
  chapter: AudiobookPlayerChapter;
  onClose: () => void;
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
  const chapterRef = useRef(chapter);
  chapterRef.current = chapter;

  useEffect(() => {
    const audioEl = new Audio(`/api/audiobook-stream/${chapter.audiobook_id}/chapters/${chapter.id}`);
    audioEl.playbackRate = playbackRate;

    if (chapter.position_ms > 0) {
      audioEl.currentTime = chapter.position_ms / 1000;
    }

    const onTimeUpdate = () => setCurrentTime(audioEl.currentTime);
    const onLoadedMetadata = () => setDuration(audioEl.duration);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = async () => {
      setPlaying(false);
      // Save progress for the finished chapter
      if (token) {
        await updateProgress(
          chapterRef.current.audiobook_id,
          chapterRef.current.id,
          Math.floor(audioEl.currentTime * 1000),
          false,
          token
        ).catch(() => {});
      }
      // Fetch audiobook details and auto-advance to next chapter
      if (token) {
        try {
          const detail = await fetchAudiobook(chapterRef.current.audiobook_id, token);
          const sorted = [...detail.chapters].sort((a, b) => a.position - b.position);
          const currentIdx = sorted.findIndex((c) => c.id === chapterRef.current.id);
          if (currentIdx >= 0 && currentIdx < sorted.length - 1) {
            const next = sorted[currentIdx + 1];
            useUi.getState().setAudiobookChapter({
              id: next.id,
              audiobook_id: detail.id,
              title: next.title,
              duration_ms: next.duration_ms,
              position_ms: 0,
              audiobook_title: detail.title,
              audiobook_cover_path: detail.cover_path,
              author: detail.author,
            });
          } else {
            // Last chapter — mark book as finished
            await markFinished(chapterRef.current.audiobook_id, token).catch(() => {});
            onClose();
          }
        } catch {
          onClose();
        }
      }
    };

    audioEl.addEventListener('timeupdate', onTimeUpdate);
    audioEl.addEventListener('loadedmetadata', onLoadedMetadata);
    audioEl.addEventListener('ended', onEnded);
    audioEl.addEventListener('play', onPlay);
    audioEl.addEventListener('pause', onPause);

    setAudio(audioEl);
    audioEl.play().then(() => setPlaying(true)).catch(() => {});

    // Auto-save progress every 10 seconds
    const interval = setInterval(() => {
      if (audioEl.currentTime > 0 && token) {
        updateProgress(
          chapterRef.current.audiobook_id,
          chapterRef.current.id,
          Math.floor(audioEl.currentTime * 1000),
          false,
          token
        ).catch(() => {});
      }
    }, 10000);

    return () => {
      clearInterval(interval);
      audioEl.removeEventListener('timeupdate', onTimeUpdate);
      audioEl.removeEventListener('loadedmetadata', onLoadedMetadata);
      audioEl.removeEventListener('ended', onEnded);
      audioEl.removeEventListener('play', onPlay);
      audioEl.removeEventListener('pause', onPause);
      // Save final position on unmount
      if (audioEl.currentTime > 0 && token) {
        updateProgress(
          chapterRef.current.audiobook_id,
          chapterRef.current.id,
          Math.floor(audioEl.currentTime * 1000),
          false,
          token
        ).catch(() => {});
      }
      audioEl.pause();
      audioEl.src = '';
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapter.id]);

  // Save progress on pause
  useEffect(() => {
    if (!playing && audio && audio.currentTime > 0 && token) {
      updateProgress(
        chapter.audiobook_id,
        chapter.id,
        Math.floor(audio.currentTime * 1000),
        false,
        token
      ).catch(() => {});
    }
  }, [playing, audio, chapter.audiobook_id, chapter.id, token]);

  // Media Session API
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;

    const imageUrl = chapter.audiobook_cover_path
      ? `/api/audiobook-art/${chapter.audiobook_id}`
      : undefined;

    navigator.mediaSession.metadata = new MediaMetadata({
      title: chapter.title,
      artist: chapter.author || 'Audiobook',
      album: chapter.audiobook_title,
      ...(imageUrl ? { artwork: [{ src: imageUrl, sizes: '512x512', type: 'image/jpeg' }] } : {}),
    });

    navigator.mediaSession.setActionHandler('play', () => audio?.play());
    navigator.mediaSession.setActionHandler('pause', () => audio?.pause());
    navigator.mediaSession.setActionHandler('seekbackward', () => {
      if (audio) audio.currentTime = Math.max(0, audio.currentTime - 15);
    });
    navigator.mediaSession.setActionHandler('seekforward', () => {
      if (audio) audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 15);
    });
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (audio && details.seekTime !== undefined) audio.currentTime = details.seekTime;
    });
    navigator.mediaSession.setActionHandler('stop', () => onClose());

    return () => {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.setActionHandler('play', null);
      navigator.mediaSession.setActionHandler('pause', null);
      navigator.mediaSession.setActionHandler('seekbackward', null);
      navigator.mediaSession.setActionHandler('seekforward', null);
      navigator.mediaSession.setActionHandler('seekto', null);
      navigator.mediaSession.setActionHandler('stop', null);
    };
  }, [chapter, audio, onClose]);

  // Update Media Session position state
  useEffect(() => {
    if (!('mediaSession' in navigator) || !audio) return;
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    if (duration > 0) {
      navigator.mediaSession.setPositionState({
        duration,
        playbackRate,
        position: currentTime,
      });
    }
  }, [playing, currentTime, duration, playbackRate, audio]);

  useEffect(() => {
    if (audio) audio.playbackRate = playbackRate;
  }, [playbackRate, audio]);

  const togglePlay = () => {
    if (!audio) return;
    if (playing) audio.pause();
    else audio.play();
  };

  const skip = (seconds: number) => {
    if (!audio) return;
    audio.currentTime = Math.max(0, Math.min(duration, audio.currentTime + seconds));
  };

  const seekTo = (pct: number) => {
    if (!audio || !duration) return;
    audio.currentTime = pct * duration;
  };

  const coverUrl = chapter.audiobook_cover_path
    ? `/api/audiobook-art/${chapter.audiobook_id}`
    : null;

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
              {coverUrl ? (
                <img
                  src={coverUrl}
                  alt=""
                  className="w-full max-w-[280px] mx-auto aspect-square rounded-2xl object-cover shadow-2xl"
                  loading="lazy"
                  decoding="async"
                />
              ) : (
                <div className="w-full max-w-[280px] mx-auto aspect-square rounded-2xl bg-white/10 flex items-center justify-center">
                  <span className="text-6xl">📖</span>
                </div>
              )}
            </div>

            {/* Chapter Info */}
            <div className="px-8 text-center mb-6">
              <h2 className="text-xl font-bold text-white line-clamp-2">{chapter.title}</h2>
              <p className="text-white/60 truncate mt-1">{chapter.audiobook_title}</p>
              {chapter.author && (
                <p className="text-white/40 text-sm truncate mt-0.5">{chapter.author}</p>
              )}
            </div>

            {/* Progress bar */}
            <div className="px-8 mb-4">
              <div
                className="h-1.5 bg-white/20 rounded-full cursor-pointer"
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  seekTo((e.clientX - rect.left) / rect.width);
                }}
              >
                <div
                  className="h-full bg-cyan-500 rounded-full transition-all duration-150"
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
              {[0.75, 1, 1.25, 1.5, 2].map((rate) => (
                <button
                  key={rate}
                  onClick={() => setPlaybackRate(rate)}
                  className={`px-3 py-1.5 rounded-full text-sm font-medium transition ${
                    playbackRate === rate
                      ? 'bg-cyan-500 text-white'
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
        {/* Progress bar at top */}
        <div
          className="h-1 bg-white/10 cursor-pointer"
          onClick={(e) => {
            e.stopPropagation();
            const rect = e.currentTarget.getBoundingClientRect();
            seekTo((e.clientX - rect.left) / rect.width);
          }}
        >
          <div
            className="h-full bg-cyan-500 transition-all duration-150"
            style={{ width: `${duration ? (currentTime / duration) * 100 : 0}%` }}
          />
        </div>

        <div className="px-4 py-3">
          <div className="max-w-4xl mx-auto flex items-center gap-3">
            {/* Cover art */}
            {coverUrl ? (
              <img
                src={coverUrl}
                alt=""
                className="w-12 h-12 sm:w-14 sm:h-14 rounded-lg object-cover flex-shrink-0"
                loading="lazy"
                decoding="async"
              />
            ) : (
              <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-lg bg-white/10 flex items-center justify-center flex-shrink-0">
                <span className="text-xl">📖</span>
              </div>
            )}

            {/* Chapter info */}
            <div className="flex-1 min-w-0">
              <div className="font-semibold text-white truncate text-sm sm:text-base">{chapter.title}</div>
              <div className="text-xs sm:text-sm text-white/60 truncate">{chapter.audiobook_title}</div>
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
// AUDIOBOOK DETAIL VIEW
// ============================================================================

function AudiobookDetailView({
  bookId,
  onBack,
}: {
  bookId: number;
  onBack: () => void;
}) {
  const token = useAuth((s) => s.token);
  const [book, setBook] = useState<AudiobookDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const data = await fetchAudiobook(bookId, token);
      setBook(data);
    } catch (err: any) {
      setError(err?.message || 'Failed to load audiobook');
    } finally {
      setLoading(false);
    }
  }, [bookId, token]);

  useEffect(() => { load(); }, [load]);

  const playChapter = (chapter: AudiobookChapter, positionMs = 0) => {
    if (!book) return;
    // Close music player when starting audiobook
    import('./playerStore').then(({ usePlayer }) => {
      usePlayer.getState().close();
    });
    useUi.getState().setAudiobookChapter({
      id: chapter.id,
      audiobook_id: book.id,
      title: chapter.title,
      duration_ms: chapter.duration_ms,
      position_ms: positionMs,
      audiobook_title: book.title,
      audiobook_cover_path: book.cover_path,
      author: book.author,
    });
  };

  const handleContinue = () => {
    if (!book) return;
    const sorted = [...book.chapters].sort((a, b) => a.position - b.position);
    if (book.progress) {
      const ch = sorted.find((c) => c.id === book.progress!.chapter_id);
      if (ch) {
        playChapter(ch, book.progress.position_ms);
        return;
      }
    }
    // No progress — start from the beginning
    if (sorted.length > 0) playChapter(sorted[0], 0);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-8 h-8 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error || !book) {
    return (
      <div className="text-center py-20">
        <p className="text-white/50 mb-4">{error || 'Audiobook not found'}</p>
        <button onClick={onBack} className="px-4 py-2 bg-white/10 hover:bg-white/15 rounded-lg text-white transition">
          ← Back
        </button>
      </div>
    );
  }

  const sorted = [...book.chapters].sort((a, b) => a.position - b.position);
  const coverUrl = book.cover_path ? `/api/audiobook-art/${book.id}` : null;
  const overallProgress = book.progress
    ? book.progress.finished
      ? 100
      : book.chapter_count > 0
        ? Math.round((book.progress.chapters_finished / book.chapter_count) * 100)
        : 0
    : 0;

  return (
    <div>
      {/* Back button */}
      <button
        onClick={onBack}
        className="flex items-center gap-2 text-white/70 hover:text-white mb-6 transition"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
        Back to Library
      </button>

      {/* Book Header */}
      <div className="flex flex-col sm:flex-row gap-6 mb-8">
        {/* Cover */}
        <div className="flex-shrink-0">
          {coverUrl ? (
            <img
              src={coverUrl}
              alt=""
              className="w-48 h-48 rounded-xl object-cover shadow-lg"
              loading="lazy"
              decoding="async"
            />
          ) : (
            <div className="w-48 h-48 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center">
              <span className="text-6xl">📖</span>
            </div>
          )}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-bold text-white mb-1">{book.title}</h1>
          {book.author && <p className="text-white/70 mb-0.5">by {book.author}</p>}
          {book.narrator && <p className="text-white/50 text-sm mb-3">Narrated by {book.narrator}</p>}

          <div className="flex flex-wrap items-center gap-3 text-sm text-white/50 mb-4">
            <span>{book.chapter_count} chapter{book.chapter_count !== 1 ? 's' : ''}</span>
            <span>•</span>
            <span>{formatDuration(book.duration_ms)}</span>
            {book.progress?.finished && (
              <>
                <span>•</span>
                <span className="text-emerald-400 flex items-center gap-1">
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                  </svg>
                  Finished
                </span>
              </>
            )}
          </div>

          {/* Overall progress bar */}
          <div className="mb-4">
            <div className="flex justify-between text-xs text-white/50 mb-1">
              <span>Progress</span>
              <span>{overallProgress}%</span>
            </div>
            <div className="h-2 bg-white/10 rounded-full">
              <div
                className="h-full bg-cyan-500 rounded-full transition-all"
                style={{ width: `${overallProgress}%` }}
              />
            </div>
          </div>

          {/* Continue / Play button */}
          <button
            onClick={handleContinue}
            className="inline-flex items-center gap-2 px-6 py-3 bg-cyan-500 hover:bg-cyan-400 text-white font-semibold rounded-full transition shadow-lg"
          >
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
            {book.progress && !book.progress.finished ? 'Continue Listening' : 'Play'}
          </button>

          {book.description && (
            <p className="text-white/50 text-sm mt-4 line-clamp-4">{book.description}</p>
          )}
        </div>
      </div>

      {/* Chapter List */}
      <h2 className="text-lg font-semibold text-white mb-3">Chapters</h2>
      <div className="space-y-1">
        {sorted.map((ch) => {
          const isCurrent = book.progress?.chapter_id === ch.id;
          return (
            <div
              key={ch.id}
              className={`flex items-center gap-3 px-4 py-3 rounded-lg transition cursor-pointer ${
                isCurrent
                  ? 'bg-cyan-500/15 border border-cyan-500/30'
                  : 'bg-white/5 hover:bg-white/10 border border-transparent'
              }`}
              onClick={() => playChapter(ch, isCurrent && book.progress ? book.progress.position_ms : 0)}
            >
              {/* Play button */}
              <button
                className="flex-shrink-0 w-9 h-9 flex items-center justify-center rounded-full bg-cyan-500 hover:bg-cyan-400 text-white transition"
                onClick={(e) => {
                  e.stopPropagation();
                  playChapter(ch, isCurrent && book.progress ? book.progress.position_ms : 0);
                }}
              >
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </button>

              {/* Chapter info */}
              <div className="flex-1 min-w-0">
                <div className={`font-medium truncate ${isCurrent ? 'text-cyan-400' : 'text-white'}`}>
                  {ch.title}
                </div>
                <div className="text-xs text-white/50">
                  Chapter {ch.position + 1}
                  {ch.duration_ms && ` • ${formatDuration(ch.duration_ms)}`}
                </div>
              </div>

              {/* Current indicator */}
              {isCurrent && (
                <span className="flex-shrink-0 text-xs text-cyan-400 font-medium">Playing</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function Audiobooks() {
  const token = useAuth((s) => s.token);
  const [books, setBooks] = useState<Audiobook[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedBookId, setSelectedBookId] = useState<number | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const data = await fetchAudiobooks(token);
      setBooks(data);
    } catch (err: any) {
      setError(err?.message || 'Failed to load audiobooks');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  // Detail view
  if (selectedBookId !== null) {
    return (
      <AudiobookDetailView
        bookId={selectedBookId}
        onBack={() => { setSelectedBookId(null); load(); }}
      />
    );
  }

  // Loading state
  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-8 h-8 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="text-center py-20">
        <p className="text-white/50 mb-4">{error}</p>
        <button onClick={load} className="px-4 py-2 bg-white/10 hover:bg-white/15 rounded-lg text-white transition">
          Retry
        </button>
      </div>
    );
  }

  // Empty state
  if (books.length === 0) {
    return (
      <div className="text-center py-20">
        <span className="text-5xl mb-4 block">📖</span>
        <h2 className="text-xl font-semibold text-white mb-2">No Audiobooks</h2>
        <p className="text-white/50">Add audiobooks to your library to see them here.</p>
      </div>
    );
  }

  // Grid view
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white">Audiobooks</h1>
        <span className="text-sm text-white/50">{books.length} book{books.length !== 1 ? 's' : ''}</span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
        {books.map((book) => {
          const coverUrl = book.cover_path ? `/api/audiobook-art/${book.id}` : null;
          const progress = book.progress;
          const chapterProgress = progress
            ? `Chapter ${progress.chapter_position + 1} of ${progress.total_chapters}`
            : `${book.chapter_count} chapter${book.chapter_count !== 1 ? 's' : ''}`;
          const progressPct = progress
            ? progress.finished
              ? 100
              : progress.total_chapters > 0
                ? Math.round((progress.chapters_finished / progress.total_chapters) * 100)
                : 0
            : 0;

          return (
            <div
              key={book.id}
              onClick={() => setSelectedBookId(book.id)}
              className="bg-white/5 hover:bg-white/10 rounded-xl border border-white/10 overflow-hidden cursor-pointer transition group"
            >
              {/* Cover */}
              <div className="relative aspect-square">
                {coverUrl ? (
                  <img
                    src={coverUrl}
                    alt=""
                    className="w-full h-full object-cover"
                    loading="lazy"
                    decoding="async"
                  />
                ) : (
                  <div className="w-full h-full bg-white/5 flex items-center justify-center">
                    <span className="text-4xl">📖</span>
                  </div>
                )}

                {/* Finished badge */}
                {progress?.finished && (
                  <div className="absolute top-2 right-2 w-7 h-7 bg-emerald-500 rounded-full flex items-center justify-center shadow-lg">
                    <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                    </svg>
                  </div>
                )}

                {/* Hover play overlay */}
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition flex items-center justify-center">
                  <div className="w-12 h-12 bg-cyan-500 rounded-full flex items-center justify-center shadow-lg">
                    <svg className="w-6 h-6 text-white" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  </div>
                </div>
              </div>

              {/* Info */}
              <div className="p-3">
                <h3 className="font-semibold text-white text-sm truncate">{book.title}</h3>
                {book.author && (
                  <p className="text-white/50 text-xs truncate mt-0.5">{book.author}</p>
                )}

                {/* Progress */}
                <div className="mt-2">
                  <p className="text-white/40 text-xs mb-1">{chapterProgress}</p>
                  {(progress && progressPct > 0) && (
                    <div className="h-1 bg-white/10 rounded-full">
                      <div
                        className="h-full bg-cyan-500 rounded-full transition-all"
                        style={{ width: `${progressPct}%` }}
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

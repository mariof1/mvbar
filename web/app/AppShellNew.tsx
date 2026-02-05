'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import Hls from 'hls.js';
import { AutoLogin } from './AutoLogin';
import { LoginForm } from './LoginForm';
import { ScanPanel } from './ScanPanel';
import { UserManagementPanel } from './UserManagementPanel';
import { LibraryManagementPanel } from './LibraryManagementPanel';
import { Admin } from './Admin';
import { Search } from './Search';
import { Tracks } from './Tracks';
import { Playlists } from './Playlists';
import { BrowseNew } from './BrowseNew';
import { Favorites } from './Favorites';
import { History } from './History';
import { Recommendations } from './Recommendations';
import { Podcasts, PodcastPlayer } from './Podcasts';
import { Settings } from './Settings';
import { RecentlyAdded } from './RecentlyAdded';
import { useAuth } from './store';
import { useFavorites } from './favoritesStore';
import { usePlayer, type QueueTrack } from './playerStore';
import { useUi } from './uiStore';
import { useRouter, useRoute, initRouter, getTabFromRoute, type Route } from './router';
import { NavigationHeader } from './NavigationHeader';
import { usePreferences } from './preferencesStore';
import { getHlsStatus, logout, recordPlay, recordSkip, requestHlsTranscode, scrobbleToListenBrainz, nowPlayingListenBrainz, prefetchLyrics, listPlaylists, addTrackToPlaylist, apiFetch } from './apiClient';
import { useWebSocket } from './useWebSocket';

// Icons as simple SVG components
const Icons = {
  Home: () => (
    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12l8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" />
    </svg>
  ),
  Search: () => (
    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
    </svg>
  ),
  Library: () => (
    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
    </svg>
  ),
  Browse: () => (
    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" />
    </svg>
  ),
  Heart: () => (
    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12z" />
    </svg>
  ),
  Clock: () => (
    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  ),
  Podcast: () => (
    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" />
    </svg>
  ),
  Playlist: () => (
    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 9l10.5-3m0 6.553v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 11-.99-3.467l2.31-.66a2.25 2.25 0 001.632-2.163zm0 0V2.25L9 5.25v10.303m0 0v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 01-.99-3.467l2.31-.66A2.25 2.25 0 009 15.553z" />
    </svg>
  ),
  Settings: () => (
    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  ),
  Play: () => (
    <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
      <path d="M8 5v14l11-7z" />
    </svg>
  ),
  Pause: () => (
    <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
      <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
    </svg>
  ),
  SkipBack: () => (
    <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
      <path d="M6 6h2v12H6V6zm3.5 6l8.5 6V6l-8.5 6z" />
    </svg>
  ),
  SkipForward: () => (
    <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
      <path d="M16 6h2v12h-2V6zm-1.5 6L6 18V6l8.5 6z" />
    </svg>
  ),
  Queue: () => (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 010 3.75H5.625a1.875 1.875 0 010-3.75z" />
    </svg>
  ),
  Volume: () => (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" />
    </svg>
  ),
  User: () => (
    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M17.982 18.725A7.488 7.488 0 0012 15.75a7.488 7.488 0 00-5.982 2.975m11.963 0a9 9 0 10-11.963 0m11.963 0A8.966 8.966 0 0112 21a8.966 8.966 0 01-5.982-2.275M15 9.75a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  ),
  Admin: () => (
    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
    </svg>
  ),
  HeartFilled: () => (
    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
      <path d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12z" />
    </svg>
  ),
  HeartOutline: () => (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12z" />
    </svg>
  ),
  Plus: () => (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
    </svg>
  ),
  Repeat: () => (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 12c0-1.232-.046-2.453-.138-3.662a4.006 4.006 0 00-3.7-3.7 48.678 48.678 0 00-7.324 0 4.006 4.006 0 00-3.7 3.7c-.017.22-.032.441-.046.662M19.5 12l3-3m-3 3l-3-3m-12 3c0 1.232.046 2.453.138 3.662a4.006 4.006 0 003.7 3.7 48.656 48.656 0 007.324 0 4.006 4.006 0 003.7-3.7c.017-.22.032-.441.046-.662M4.5 12l3 3m-3-3l-3 3" />
    </svg>
  ),
  RepeatOne: () => (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 12c0-1.232-.046-2.453-.138-3.662a4.006 4.006 0 00-3.7-3.7 48.678 48.678 0 00-7.324 0 4.006 4.006 0 00-3.7 3.7c-.017.22-.032.441-.046.662M19.5 12l3-3m-3 3l-3-3m-12 3c0 1.232.046 2.453.138 3.662a4.006 4.006 0 003.7 3.7 48.656 48.656 0 007.324 0 4.006 4.006 0 003.7-3.7c.017-.22.032-.441.046-.662M4.5 12l3 3m-3-3l-3 3" />
      <text x="12" y="13" textAnchor="middle" fontSize="6" fill="currentColor" fontWeight="bold">1</text>
    </svg>
  ),
  Shuffle: () => (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
    </svg>
  ),
  VolumeMute: () => (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 9.75L19.5 12m0 0l2.25 2.25M19.5 12l2.25-2.25M19.5 12l-2.25 2.25m-10.5-6l4.72-4.72a.75.75 0 011.28.531v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.506-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" />
    </svg>
  ),
  Lyrics: () => (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
    </svg>
  ),
  Close: () => (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
  ),
};

type PlayMode = 'normal' | 'repeat' | 'repeat-one' | 'shuffle';

// Parse LRC format lyrics into lines with timestamps
interface LyricLine {
  time: number; // seconds
  text: string;
}

function parseLrcLyrics(lrc: string): LyricLine[] | null {
  const lines: LyricLine[] = [];
  const lrcRegex = /^\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)$/;
  
  for (const line of lrc.split('\n')) {
    const match = line.match(lrcRegex);
    if (match) {
      const minutes = parseInt(match[1], 10);
      const seconds = parseInt(match[2], 10);
      const centiseconds = parseInt(match[3].padEnd(3, '0').slice(0, 3), 10);
      const time = minutes * 60 + seconds + centiseconds / 1000;
      const text = match[4].trim();
      if (text) {
        lines.push({ time, text });
      }
    }
  }
  
  return lines.length > 0 ? lines.sort((a, b) => a.time - b.time) : null;
}

// Lyrics overlay component with synced highlighting
function LyricsOverlay(props: { trackId: number; currentTime: number; onClose: () => void }) {
  const [loading, setLoading] = useState(true);
  const [parsedLines, setParsedLines] = useState<LyricLine[] | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const activeLineRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/lyrics/${props.trackId}`);
        if (cancelled) return;
        if (res.status === 204 || !res.ok) {
          setParsedLines(null);
        } else {
          const text = await res.text();
          setParsedLines(parseLrcLyrics(text));
        }
      } catch {
        if (!cancelled) {
          setParsedLines(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [props.trackId]);

  // Find current line index based on playback time
  const currentLineIndex = parsedLines
    ? parsedLines.findIndex((line, i) => {
        const nextLine = parsedLines[i + 1];
        return props.currentTime >= line.time && (!nextLine || props.currentTime < nextLine.time);
      })
    : -1;

  // Auto-scroll to active line
  useEffect(() => {
    if (activeLineRef.current && containerRef.current) {
      activeLineRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    }
  }, [currentLineIndex]);

  return (
    <div 
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={props.onClose}
    >
      <div 
        ref={containerRef}
        className="glass rounded-xl border border-white/10 p-6 w-full max-w-2xl max-h-[80vh] mx-4 overflow-y-auto scroll-smooth relative"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close button only - no title */}
        <button
          onClick={props.onClose}
          className="absolute top-4 right-4 p-2 rounded-full hover:bg-white/10 transition text-white/60 hover:text-white z-10"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="w-8 h-8 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : parsedLines ? (
          <div className="space-y-3 py-4">
            {parsedLines.map((line, i) => (
              <div
                key={i}
                ref={i === currentLineIndex ? activeLineRef : null}
                className={`text-center text-lg transition-all duration-300 ${
                  i === currentLineIndex
                    ? 'text-cyan-400 font-semibold scale-105'
                    : i < currentLineIndex
                    ? 'text-white/40'
                    : 'text-white/70'
                }`}
              >
                {line.text}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-white/60 text-center py-12">No synced lyrics available for this track.</p>
        )}
      </div>
    </div>
  );
}

// Global Podcast Player wrapper that uses the store
function GlobalPodcastPlayer() {
  const podcastEpisode = useUi((s) => s.podcastEpisode);
  const setPodcastEpisode = useUi((s) => s.setPodcastEpisode);
  
  if (!podcastEpisode) return null;
  
  return (
    <PodcastPlayer
      episode={podcastEpisode}
      onClose={() => setPodcastEpisode(null)}
    />
  );
}

function PlayerBar(props: {
  nowPlaying: QueueTrack;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: (p?: { currentTime: number; duration: number }) => void;
  onPlayed: (p: { currentTime: number; duration: number }) => void;
  onClose: () => void;
  onEnded: () => void;
  onPlayModeEnded: () => void;
  token: string | null;
  playMode: PlayMode;
  onPlayModeChange: (mode: PlayMode) => void;
  isFavorite: boolean;
  onToggleFavorite: () => void;
  onAddToPlaylist: () => void;
  showLyrics: boolean;
  onToggleLyrics: () => void;
  onTimeUpdate?: (time: number) => void;
  queue?: QueueTrack[];
  queueIndex?: number;
  onPlayQueueItem?: (index: number) => void;
  onRemoveFromQueue?: (index: number) => void;
  onReorderQueue?: (fromIdx: number, toIdx: number) => void;
  onClearQueue?: () => void;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [artOk, setArtOk] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [showVolume, setShowVolume] = useState(false);
  const [showQueue, setShowQueue] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [draggedIdx, setDraggedIdx] = useState<number | null>(null);
  const volumeRef = useRef<HTMLDivElement>(null);
  const queueRef = useRef<HTMLDivElement>(null);
  const activeQueueItemRef = useRef<HTMLDivElement>(null);
  const playedSentRef = useRef(false);
  const hlsRef = useRef<Hls | null>(null);
  const [preferHls, setPreferHls] = useState(true);

  useEffect(() => {
    setArtOk(true);
    playedSentRef.current = false;
  }, [props.nowPlaying.id]);

  // Close queue panel on click outside
  useEffect(() => {
    if (!showQueue) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (queueRef.current && !queueRef.current.contains(e.target as Node)) {
        setShowQueue(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showQueue]);

  // When opening the queue, scroll to the currently playing track.
  useEffect(() => {
    if (!showQueue) return;
    const el = activeQueueItemRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      try {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch {}
    });
  }, [showQueue, props.queueIndex]);

  // Auto-hide volume on scroll or click outside
  useEffect(() => {
    if (!showVolume) return;
    const handleHide = (e: Event) => {
      if (volumeRef.current && !volumeRef.current.contains(e.target as Node)) {
        setShowVolume(false);
      }
    };
    const handleScroll = () => setShowVolume(false);
    
    document.addEventListener('click', handleHide);
    document.addEventListener('scroll', handleScroll, true);
    document.addEventListener('touchstart', handleHide);
    
    return () => {
      document.removeEventListener('click', handleHide);
      document.removeEventListener('scroll', handleScroll, true);
      document.removeEventListener('touchstart', handleHide);
    };
  }, [showVolume]);

  useEffect(() => {
    try {
      const v = localStorage.getItem('mvbar_prefer_hls');
      if (v === null) return;
      setPreferHls(v !== '0');
      const vol = localStorage.getItem('mvbar_volume');
      if (vol) setVolume(parseFloat(vol));
    } catch {}
  }, []);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    let cancelled = false;

    const cleanupHls = () => {
      if (hlsRef.current) {
        try { hlsRef.current.destroy(); } catch {}
        hlsRef.current = null;
      }
    };

    const setStream = async () => {
      cleanupHls();
      a.src = `/api/stream/${props.nowPlaying.id}`;
      try { await a.play(); } catch {}
    };

    const setHls = async (seekTo?: number) => {
      const id = props.nowPlaying.id;
      const canNative = a.canPlayType('application/vnd.apple.mpegurl');
      if (canNative) {
        cleanupHls();
        a.src = `/api/hls/${id}`;
        if (typeof seekTo === 'number' && seekTo > 0) {
          a.addEventListener('loadedmetadata', () => { try { a.currentTime = seekTo; } catch {} }, { once: true });
        }
        try { await a.play(); } catch {}
        return true;
      }
      if (!Hls.isSupported()) { await setStream(); return false; }
      cleanupHls();
      const hls = new Hls({ enableWorker: true });
      hlsRef.current = hls;
      hls.on(Hls.Events.ERROR, (_evt, data) => { if (data?.fatal) setStream(); });
      hls.loadSource(`/api/hls/${id}`);
      hls.attachMedia(a);
      if (typeof seekTo === 'number' && seekTo > 0) {
        a.addEventListener('loadedmetadata', () => { try { a.currentTime = seekTo; } catch {} }, { once: true });
      }
      try { await a.play(); } catch {}
      return true;
    };

    (async () => {
      if (cancelled) return;
      await setStream();
      // Submit "now playing" to ListenBrainz and prefetch lyrics
      if (props.token) {
        nowPlayingListenBrainz(props.token, props.nowPlaying.id).catch(() => {});
        prefetchLyrics(props.token, props.nowPlaying.id).catch(() => {});
      }
      
      // Set Media Session metadata for OS media controls (lock screen, notification)
      if ('mediaSession' in navigator) {
        const artUrl = `${window.location.origin}/api/art/${props.nowPlaying.id}`;
        navigator.mediaSession.metadata = new MediaMetadata({
          title: props.nowPlaying.title || 'Unknown Track',
          artist: props.nowPlaying.artist || 'Unknown Artist',
          album: props.nowPlaying.album || '',
          artwork: [
            { src: artUrl, sizes: '96x96', type: 'image/jpeg' },
            { src: artUrl, sizes: '128x128', type: 'image/jpeg' },
            { src: artUrl, sizes: '192x192', type: 'image/jpeg' },
            { src: artUrl, sizes: '256x256', type: 'image/jpeg' },
            { src: artUrl, sizes: '384x384', type: 'image/jpeg' },
            { src: artUrl, sizes: '512x512', type: 'image/jpeg' },
          ],
        });
      }
      
      if (!props.token || !preferHls) return;
      try {
        await requestHlsTranscode(props.token, props.nowPlaying.id);
        for (let i = 0; i < 8 && !cancelled; i++) {
          const s = await getHlsStatus(props.token, props.nowPlaying.id);
          if (s?.ready) { const resume = a.currentTime || 0; await setHls(resume); break; }
          await new Promise((r) => setTimeout(r, 500));
        }
      } catch {}
    })();

    return () => { cancelled = true; cleanupHls(); };
  }, [props.nowPlaying.id, props.token, preferHls]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  // Media Session action handlers for OS media controls
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    
    const actionHandlers: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
      ['play', () => { audioRef.current?.play(); }],
      ['pause', () => { audioRef.current?.pause(); }],
      ['previoustrack', () => { props.onPrev(); }],
      ['nexttrack', () => { props.onNext(); }],
      ['seekbackward', (details) => {
        const a = audioRef.current;
        if (a) a.currentTime = Math.max(0, a.currentTime - (details.seekOffset || 10));
      }],
      ['seekforward', (details) => {
        const a = audioRef.current;
        if (a) a.currentTime = Math.min(a.duration || 0, a.currentTime + (details.seekOffset || 10));
      }],
      ['seekto', (details) => {
        const a = audioRef.current;
        if (a && details.seekTime !== undefined) a.currentTime = details.seekTime;
      }],
    ];

    for (const [action, handler] of actionHandlers) {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {}
    }

    return () => {
      for (const [action] of actionHandlers) {
        try { navigator.mediaSession.setActionHandler(action, null); } catch {}
      }
    };
  }, [props.onPrev, props.onNext]);

  const togglePlay = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) a.play();
    else a.pause();
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const a = audioRef.current;
    if (!a) return;
    const t = parseFloat(e.target.value);
    a.currentTime = t;
    setCurrentTime(t);
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    setVolume(v);
    try { localStorage.setItem('mvbar_volume', String(v)); } catch {}
  };

  // Update Media Session position state for lock screen seek bar
  const updateMediaSessionPosition = (position: number, dur: number) => {
    if ('mediaSession' in navigator && dur > 0) {
      try {
        navigator.mediaSession.setPositionState({
          duration: dur,
          playbackRate: 1,
          position: Math.min(position, dur),
        });
      } catch {}
    }
  };

  const formatTime = (s: number) => {
    if (!Number.isFinite(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const cyclePlayMode = () => {
    const modes: PlayMode[] = ['normal', 'repeat', 'repeat-one', 'shuffle'];
    const idx = modes.indexOf(props.playMode);
    props.onPlayModeChange(modes[(idx + 1) % modes.length]);
  };

  const getPlayModeIcon = () => {
    switch (props.playMode) {
      case 'repeat': return <Icons.Repeat />;
      case 'repeat-one': return <Icons.RepeatOne />;
      case 'shuffle': return <Icons.Shuffle />;
      default: return <Icons.Repeat />;
    }
  };

  const getPlayModeTitle = () => {
    switch (props.playMode) {
      case 'repeat': return 'Repeat All';
      case 'repeat-one': return 'Repeat One';
      case 'shuffle': return 'Shuffle';
      default: return 'Normal';
    }
  };

  return (
    <>
      {/* Expanded Player Overlay */}
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
              {artOk ? (
                <img
                  src={`/api/art/${props.nowPlaying.id}`}
                  alt=""
                  className="w-full max-w-[280px] mx-auto aspect-square rounded-2xl object-cover shadow-2xl"
                  onError={() => setArtOk(false)}
                />
              ) : (
                <div className="w-full max-w-[280px] mx-auto aspect-square rounded-2xl bg-white/10 flex items-center justify-center">
                  <Icons.Playlist />
                </div>
              )}
            </div>

            {/* Track Info */}
            <div className="px-8 text-center mb-6">
              <h2 className="text-xl font-bold text-white truncate">
                {props.nowPlaying.title ?? `Track #${props.nowPlaying.id}`}
              </h2>
              <p className="text-white/60 truncate mt-1">
                {props.nowPlaying.artist ?? 'Unknown Artist'}
              </p>
            </div>

            {/* Progress bar */}
            <div className="px-8 mb-4">
              <div 
                className="h-1.5 bg-white/20 rounded-full cursor-pointer"
                onClick={(e) => {
                  const a = audioRef.current;
                  if (!a || !duration) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const pct = (e.clientX - rect.left) / rect.width;
                  a.currentTime = pct * duration;
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
                onClick={cyclePlayMode}
                className={`p-3 rounded-full ${props.playMode !== 'normal' ? 'text-cyan-400' : 'text-white/50'}`}
              >
                {getPlayModeIcon()}
              </button>
              <button
                onClick={props.onPrev}
                disabled={!props.hasPrev && props.playMode === 'normal'}
                className="p-3 rounded-full text-white disabled:opacity-30"
              >
                <Icons.SkipBack />
              </button>
              <button
                onClick={togglePlay}
                className="p-5 rounded-full bg-white text-black shadow-lg"
              >
                {isPlaying ? <Icons.Pause /> : <Icons.Play />}
              </button>
              <button
                onClick={() => props.onNext({ currentTime, duration })}
                disabled={!props.hasNext && props.playMode === 'normal'}
                className="p-3 rounded-full text-white disabled:opacity-30"
              >
                <Icons.SkipForward />
              </button>
              <button
                onClick={props.onToggleLyrics}
                className={`p-3 rounded-full ${props.showLyrics ? 'text-cyan-400' : 'text-white/50'}`}
              >
                <Icons.Lyrics />
              </button>
            </div>

            {/* Secondary Controls */}
            <div className="flex items-center justify-center gap-4 mb-6 px-8">
              <button
                onClick={(e) => { e.stopPropagation(); props.onToggleFavorite(); }}
                className={`flex items-center gap-2 px-4 py-2 rounded-full border ${props.isFavorite ? 'border-pink-500 text-pink-500' : 'border-white/30 text-white/70'}`}
              >
                {props.isFavorite ? <Icons.HeartFilled /> : <Icons.HeartOutline />}
                <span className="text-sm">{props.isFavorite ? 'Liked' : 'Like'}</span>
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); props.onAddToPlaylist(); }}
                className="flex items-center gap-2 px-4 py-2 rounded-full border border-white/30 text-white/70"
              >
                <Icons.Plus />
                <span className="text-sm">Add to Playlist</span>
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); props.onClose(); }}
                className="flex items-center gap-2 px-4 py-2 rounded-full border border-red-500/50 text-red-400"
              >
                <Icons.Close />
                <span className="text-sm">Close</span>
              </button>
            </div>

            {/* Queue Section */}
            {props.queue && props.queue.length > 1 && (
              <div className="flex-1 px-4 pb-8">
                <h3 className="text-sm font-semibold text-white/70 uppercase tracking-wide px-4 mb-3">
                  Queue ({props.queue.length} tracks)
                </h3>
                <div className="space-y-1 max-h-[300px] overflow-y-auto">
                  {props.queue.map((track, idx) => (
                    <button
                      key={`${track.id}-${idx}`}
                      onClick={() => props.onPlayQueueItem?.(idx)}
                      className={`w-full flex items-center gap-3 p-3 rounded-lg transition ${
                        idx === props.queueIndex 
                          ? 'bg-cyan-500/20 text-cyan-400' 
                          : 'text-white/70 hover:bg-white/10'
                      }`}
                    >
                      <span className="w-6 text-center text-sm opacity-50">{idx + 1}</span>
                      <div className="flex-1 min-w-0 text-left">
                        <div className="truncate text-sm font-medium">{track.title ?? 'Untitled'}</div>
                        <div className="truncate text-xs opacity-60">{track.artist ?? 'Unknown'}</div>
                      </div>
                      {idx === props.queueIndex && (
                        <div className="w-4 h-4 flex items-center justify-center">
                          <div className="w-2 h-2 bg-cyan-400 rounded-full animate-pulse" />
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Mini Player Bar */}
      <div className="fixed bottom-0 left-0 right-0 lg:left-64 z-50 glass border-t border-white/10 animate-slide-up h-[72px]">
        {/* Progress bar - full width on top */}
        <div className="absolute top-0 left-0 right-0 h-1 bg-white/10 cursor-pointer"
          onClick={(e) => {
            const a = audioRef.current;
            if (!a || !duration) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const pct = (e.clientX - rect.left) / rect.width;
            a.currentTime = pct * duration;
          }}>
          <div 
            className="h-full bg-cyan-500 transition-all duration-150"
            style={{ width: `${duration ? (currentTime / duration) * 100 : 0}%` }}
          />
        </div>

        <div className="max-w-screen-2xl mx-auto px-3 sm:px-4 py-2 sm:py-3">
          <div className="flex items-center gap-3 sm:gap-4">
            {/* Track Info - tappable on mobile to expand */}
            <div 
              className="flex items-center gap-3 min-w-0 flex-1 cursor-pointer lg:cursor-default"
              onClick={() => { if (window.innerWidth < 1024) setExpanded(true); }}
            >
              {artOk ? (
                <img
                  src={`/api/art/${props.nowPlaying.id}`}
                  alt=""
                  className="w-12 h-12 sm:w-14 sm:h-14 rounded-lg object-cover shadow-lg flex-shrink-0"
                  onError={() => setArtOk(false)}
                />
              ) : (
                <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-lg bg-white/10 flex items-center justify-center flex-shrink-0">
                  <Icons.Playlist />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-white truncate text-sm sm:text-base">
                  {props.nowPlaying.title ?? `Track #${props.nowPlaying.id}`}
                </div>
                <div className="text-xs sm:text-sm text-white/60 truncate">
                  {props.nowPlaying.artist ?? 'Unknown Artist'}
                </div>
              </div>
            </div>

            {/* Mobile Controls - compact row */}
            <div className="flex sm:hidden items-center gap-1">
              <button
                onClick={(e) => { e.stopPropagation(); props.onToggleFavorite(); }}
                className={`p-2 rounded-full ${props.isFavorite ? 'text-pink-500' : 'text-white/50'}`}
              >
                {props.isFavorite ? <Icons.HeartFilled /> : <Icons.HeartOutline />}
              </button>
              <button
                onClick={props.onPrev}
                disabled={!props.hasPrev && props.playMode === 'normal'}
                className="p-2 rounded-full text-white/70 disabled:opacity-30"
              >
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M6 6h2v12H6V6zm3.5 6l8.5 6V6l-8.5 6z" />
                </svg>
              </button>
              <button
                onClick={togglePlay}
                className="p-2 rounded-full bg-white text-black"
              >
                {isPlaying ? (
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
                onClick={() => props.onNext({ currentTime, duration })}
                disabled={!props.hasNext && props.playMode === 'normal'}
                className="p-2 rounded-full text-white/70 disabled:opacity-30"
              >
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M16 6h2v12h-2V6zm-1.5 6L6 18V6l8.5 6z" />
                </svg>
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); props.onClose(); }}
                className="p-2 rounded-full text-white/40"
                title="Close player"
              >
                <Icons.Close />
              </button>
            </div>

            {/* Desktop Controls */}
            <div className="hidden sm:flex items-center gap-1">
              <button
                onClick={(e) => { e.stopPropagation(); props.onToggleFavorite(); }}
                className={`p-2 rounded-full hover:bg-white/10 transition ${props.isFavorite ? 'text-pink-500' : 'text-white/60 hover:text-white'}`}
                title={props.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
              >
                {props.isFavorite ? <Icons.HeartFilled /> : <Icons.HeartOutline />}
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); props.onAddToPlaylist(); }}
                className="p-2 rounded-full text-white/60 hover:text-white hover:bg-white/10 transition"
                title="Add to playlist"
              >
                <Icons.Plus />
              </button>
            </div>

            {/* Desktop Playback Controls */}
            <div className="hidden sm:flex items-center gap-2">
              <button
                onClick={props.onPrev}
                disabled={!props.hasPrev && props.playMode === 'normal'}
                className="p-2.5 rounded-full text-white/80 hover:text-white hover:bg-white/10 transition disabled:opacity-30"
              >
                <Icons.SkipBack />
              </button>
              <button
                onClick={togglePlay}
                className="p-3 rounded-full bg-white text-black hover:bg-white/90 hover:scale-105 transition-all shadow-lg"
              >
                {isPlaying ? <Icons.Pause /> : <Icons.Play />}
              </button>
              <button
                onClick={() => props.onNext({ currentTime, duration })}
                disabled={!props.hasNext && props.playMode === 'normal'}
                className="p-2.5 rounded-full text-white/80 hover:text-white hover:bg-white/10 transition disabled:opacity-30"
              >
                <Icons.SkipForward />
              </button>
            </div>

            {/* Desktop Right Side Controls */}
            <div className="hidden md:flex items-center gap-2">
              <button
                onClick={cyclePlayMode}
                className={`p-2 rounded-full hover:bg-white/10 transition ${props.playMode !== 'normal' ? 'text-cyan-400' : 'text-white/40 hover:text-white/70'}`}
                title={getPlayModeTitle()}
              >
                {getPlayModeIcon()}
              </button>
              <button
                onClick={props.onToggleLyrics}
                className={`p-2 rounded-full hover:bg-white/10 transition ${props.showLyrics ? 'text-cyan-400' : 'text-white/40 hover:text-white/70'}`}
                title="Lyrics"
              >
                <Icons.Lyrics />
              </button>
              <div className="relative" ref={queueRef}>
                <button
                  onClick={() => setShowQueue(!showQueue)}
                  className={`p-2 rounded-full hover:bg-white/10 transition ${showQueue ? 'text-cyan-400' : 'text-white/40 hover:text-white/70'}`}
                  title="Queue"
                >
                  <Icons.Queue />
                </button>
                {/* Queue Panel */}
                {showQueue && props.queue && props.queue.length > 0 && (
                  <div className="absolute bottom-full right-0 mb-2 w-80 max-h-96 glass rounded-xl border border-white/10 shadow-2xl overflow-hidden">
                    <div className="flex items-center justify-between p-3 border-b border-white/10">
                      <h3 className="text-sm font-semibold text-white">Queue ({props.queue.length})</h3>
                      {props.queue.length > 1 && (
                        <button
                          onClick={() => props.onClearQueue?.()}
                          className="text-xs text-white/50 hover:text-white transition"
                        >
                          Clear
                        </button>
                      )}
                    </div>
                    <div className="overflow-y-auto max-h-80">
                      {props.queue.map((track, idx) => (
                        <div
                          key={`${track.id}-${idx}`}
                          ref={idx === props.queueIndex ? activeQueueItemRef : null}
                          draggable
                          onDragStart={() => setDraggedIdx(idx)}
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={() => {
                            if (draggedIdx !== null && draggedIdx !== idx) {
                              props.onReorderQueue?.(draggedIdx, idx);
                            }
                            setDraggedIdx(null);
                          }}
                          onDragEnd={() => setDraggedIdx(null)}
                          className={`flex items-center gap-2 px-3 py-2 hover:bg-white/5 transition cursor-move group ${
                            idx === props.queueIndex ? 'bg-cyan-500/10' : ''
                          } ${draggedIdx === idx ? 'opacity-50' : ''}`}
                        >
                          <button
                            onClick={() => props.onPlayQueueItem?.(idx)}
                            className="flex-1 flex items-center gap-2 min-w-0 text-left"
                          >
                            <span className="w-5 text-center text-xs text-white/40">
                              {idx === props.queueIndex ? (
                                <span className="inline-block w-2 h-2 bg-cyan-400 rounded-full animate-pulse" />
                              ) : (
                                idx + 1
                              )}
                            </span>
                            <div className="flex-1 min-w-0">
                              <div className={`truncate text-sm ${idx === props.queueIndex ? 'text-cyan-400 font-medium' : 'text-white'}`}>
                                {track.title ?? 'Untitled'}
                              </div>
                              <div className="truncate text-xs text-white/50">{track.artist ?? 'Unknown'}</div>
                            </div>
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); props.onRemoveFromQueue?.(idx); }}
                            className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-white/10 text-white/40 hover:text-red-400 transition"
                            title="Remove from queue"
                          >
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <span className="text-xs text-white/50 tabular-nums ml-2">
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>
              <div ref={volumeRef} className="relative flex items-center">
                <button
                  onClick={(e) => { e.stopPropagation(); setShowVolume(!showVolume); }}
                  className="p-2 rounded-full hover:bg-white/10 transition text-white/40 hover:text-white/70"
                  title={`Volume: ${Math.round(volume * 100)}%`}
                >
                  {volume === 0 ? <Icons.VolumeMute /> : <Icons.Volume />}
                </button>
                {showVolume && (
                  <div 
                    className="absolute bottom-full right-1/2 translate-x-1/2 mb-2 p-3 glass rounded-lg border border-white/10 shadow-xl"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.01"
                      value={volume}
                      onChange={handleVolumeChange}
                      className="h-24 w-2 accent-cyan-500 cursor-pointer appearance-none bg-white/20 rounded-full [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-cyan-500"
                      style={{ writingMode: 'vertical-lr', direction: 'rtl' }}
                    />
                  </div>
                )}
              </div>
              {/* Close button */}
              <button
                onClick={props.onClose}
                className="p-2 rounded-full text-white/40 hover:text-white hover:bg-white/10 transition ml-1"
                title="Close player"
              >
                <Icons.Close />
              </button>
            </div>
          </div>
        </div>
      </div>

      <audio
        ref={audioRef}
        onPlay={() => {
          setIsPlaying(true);
          if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
        }}
        onPause={() => {
          setIsPlaying(false);
          if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
        }}
        onTimeUpdate={(e) => {
          const a = e.currentTarget;
          setCurrentTime(a.currentTime);
          props.onTimeUpdate?.(a.currentTime);
          updateMediaSessionPosition(a.currentTime, a.duration);
          if (!playedSentRef.current && a.duration > 0 && a.currentTime / a.duration >= 0.8) {
            playedSentRef.current = true;
            props.onPlayed({ currentTime: a.currentTime, duration: a.duration });
          }
        }}
        onLoadedMetadata={(e) => {
          const dur = e.currentTarget.duration;
          setDuration(dur);
          updateMediaSessionPosition(0, dur);
        }}
        onEnded={() => {
          // Handle repeat-one by replaying the same track
          if (props.playMode === 'repeat-one') {
            const a = audioRef.current;
            if (a) {
              a.currentTime = 0;
              a.play().catch(() => {});
            }
          } else {
            props.onEnded();
          }
        }}
      />
    </>
  );
}

function NavItem(props: { 
  icon: React.ReactNode; 
  label: string; 
  active: boolean; 
  onClick: () => void;
  mobile?: boolean;
}) {
  if (props.mobile) {
    return (
      <button
        onClick={props.onClick}
        className={`flex flex-col items-center gap-1 py-2 px-4 transition ${
          props.active ? 'text-white' : 'text-white/50 hover:text-white/80'
        }`}
      >
        <div className={props.active ? 'text-cyan-500' : ''}>{props.icon}</div>
        <span className="text-xs">{props.label}</span>
      </button>
    );
  }

  return (
    <button
      onClick={props.onClick}
      className={`flex items-center gap-3 w-full px-3 py-2.5 rounded-lg transition ${
        props.active 
          ? 'bg-white/10 text-white' 
          : 'text-white/60 hover:text-white hover:bg-white/5'
      }`}
    >
      <div className={props.active ? 'text-cyan-500' : ''}>{props.icon}</div>
      <span className="font-medium">{props.label}</span>
    </button>
  );
}

function MobileSidebar(props: { 
  tab: string; 
  setTab: (t: string) => void; 
  isAdmin: boolean; 
  user: { email: string; role: string; avatar_path?: string | null } | null; 
  onLogout: () => void;
  isOpen: boolean;
  onClose: () => void;
  hasMusicPlayer: boolean;
  hasPodcastPlayer: boolean;
}) {
  const sidebarRef = useRef<HTMLDivElement>(null);
  const touchStartedInsideRef = useRef(false);

  // Lock body scroll when sidebar is open
  useEffect(() => {
    if (props.isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [props.isOpen]);

  // Close on click/scroll outside or Escape key
  useEffect(() => {
    if (!props.isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (sidebarRef.current && !sidebarRef.current.contains(e.target as Node)) {
        props.onClose();
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        props.onClose();
      }
    };
    const handleTouchStart = (e: TouchEvent) => {
      touchStartedInsideRef.current = !!(sidebarRef.current && sidebarRef.current.contains(e.target as Node));
    };
    const handleTouchMove = () => {
      // Close if touch/scroll started outside sidebar
      if (!touchStartedInsideRef.current) {
        props.onClose();
      }
    };
    const handleWheel = (e: WheelEvent) => {
      // Close if wheel scroll is outside sidebar (desktop)
      if (sidebarRef.current && !sidebarRef.current.contains(e.target as Node)) {
        props.onClose();
      }
    };
    // Small delay to avoid immediate close when opening
    const timer = setTimeout(() => {
      document.addEventListener('click', handleClickOutside);
      document.addEventListener('touchstart', handleTouchStart, { passive: true });
      document.addEventListener('touchmove', handleTouchMove, { passive: true });
      document.addEventListener('wheel', handleWheel, { passive: true });
    }, 100);
    document.addEventListener('keydown', handleEscape);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('click', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
      document.removeEventListener('touchstart', handleTouchStart);
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('wheel', handleWheel);
    };
  }, [props.isOpen, props.onClose]);

  const handleNavClick = (t: string) => {
    props.setTab(t);
    props.onClose();
  };

  // Calculate bottom position based on player state
  // Music player bar: ~72px on mobile, ~80px on desktop
  // Use 72px as it needs to just clear the player bar
  const getBottomClass = () => {
    if (props.hasMusicPlayer && props.hasPodcastPlayer) {
      return 'bottom-36'; // 144px for both stacked
    } else if (props.hasMusicPlayer || props.hasPodcastPlayer) {
      return 'bottom-[72px]'; // Match player bar height
    }
    return 'bottom-0';
  };

  return (
    <>
      {/* Overlay */}
      <div 
        className={`lg:hidden fixed inset-0 bg-black/60 z-40 transition-opacity duration-300 ${props.isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        onClick={props.onClose}
      />
      
      {/* Sidebar */}
      <aside 
        ref={sidebarRef}
        className={`lg:hidden fixed left-0 top-0 ${getBottomClass()} w-64 bg-zinc-900/95 backdrop-blur-xl border-r border-white/10 z-50 transform transition-transform duration-300 ease-out ${props.isOpen ? 'translate-x-0' : '-translate-x-full'}`}
      >
        <div className="flex flex-col h-full p-3 overflow-y-auto overscroll-contain touch-pan-y">
          {/* Logo */}
          <div className="flex items-center gap-3 px-3 py-2 mb-2">
            <img src="/logo.png" alt="mvbar" className="h-8 w-auto" />
          </div>

          <nav className="flex flex-col gap-0.5">
            <NavItem icon={<Icons.Home />} label="For You" active={props.tab === 'for-you'} onClick={() => handleNavClick('for-you')} />
            <NavItem icon={<Icons.Search />} label="Search" active={props.tab === 'search'} onClick={() => handleNavClick('search')} />
            <NavItem icon={<Icons.Browse />} label="Browse" active={props.tab === 'browse'} onClick={() => handleNavClick('browse')} />
            {props.isAdmin && (
              <NavItem icon={<Icons.Admin />} label="Admin" active={props.tab === 'admin'} onClick={() => handleNavClick('admin')} />
            )}
          </nav>

          <div className="mt-4 mb-1 px-3">
            <h2 className="text-xs font-semibold text-white/40 uppercase tracking-wider">Library</h2>
          </div>
          <nav className="flex flex-col gap-0.5">
            <NavItem icon={<Icons.Library />} label="Recently Added" active={props.tab === 'library' || props.tab === 'recently-added'} onClick={() => handleNavClick('recently-added')} />
            <NavItem icon={<Icons.Playlist />} label="Playlists" active={props.tab === 'playlists'} onClick={() => handleNavClick('playlists')} />
            <NavItem icon={<Icons.Heart />} label="Favorites" active={props.tab === 'favorites'} onClick={() => handleNavClick('favorites')} />
            <NavItem icon={<Icons.Clock />} label="History" active={props.tab === 'history'} onClick={() => handleNavClick('history')} />
            <NavItem icon={<Icons.Podcast />} label="Podcasts" active={props.tab === 'podcasts'} onClick={() => handleNavClick('podcasts')} />
            <NavItem icon={<Icons.Settings />} label="Settings" active={props.tab === 'settings'} onClick={() => handleNavClick('settings')} />
          </nav>

          {/* User Info & Logout */}
          {props.user && (
            <div className="mt-3 pt-2 border-t border-white/10">
              <div className="flex items-center gap-2 px-3 py-1.5">
                {props.user.avatar_path ? (
                  <img src={`/api/avatars/${props.user.avatar_path}`} alt="" className="w-7 h-7 rounded-full object-cover" />
                ) : (
                  <div className="w-7 h-7 rounded-full bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center text-white text-xs font-medium">
                    {props.user.email.charAt(0).toUpperCase()}
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-white truncate">{props.user.email}</div>
                  <div className="text-xs text-white/50">{props.user.role}</div>
                </div>
              </div>
              <button
                onClick={props.onLogout}
                className="w-full mt-1 px-3 py-1.5 text-left text-sm text-red-400 hover:text-red-300 hover:bg-white/5 rounded-lg transition-colors flex items-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
                Sign Out
              </button>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

function Sidebar(props: { tab: string; setTab: (t: string) => void; isAdmin: boolean; user: { email: string; role: string; avatar_path?: string | null } | null; onLogout: () => void }) {
  return (
    <aside className="hidden lg:flex flex-col w-64 h-screen fixed left-0 top-0 bg-black/50 border-r border-white/10 p-4">
      {/* Logo */}
      <div className="flex items-center gap-3 px-3 py-4 mb-4">
        <img src="/logo.png" alt="mvbar" className="h-12 w-auto" />
      </div>

      <nav className="flex flex-col gap-1">
        <NavItem icon={<Icons.Home />} label="For You" active={props.tab === 'for-you'} onClick={() => props.setTab('for-you')} />
        <NavItem icon={<Icons.Search />} label="Search" active={props.tab === 'search'} onClick={() => props.setTab('search')} />
        <NavItem icon={<Icons.Browse />} label="Browse" active={props.tab === 'browse'} onClick={() => props.setTab('browse')} />
        {props.isAdmin && (
          <NavItem icon={<Icons.Admin />} label="Admin" active={props.tab === 'admin'} onClick={() => props.setTab('admin')} />
        )}
      </nav>

      <div className="mt-6 mb-2 px-3">
        <h2 className="text-xs font-semibold text-white/40 uppercase tracking-wider">Library</h2>
      </div>
      <nav className="flex flex-col gap-1">
        <NavItem icon={<Icons.Library />} label="Recently Added" active={props.tab === 'library' || props.tab === 'recently-added'} onClick={() => props.setTab('recently-added')} />
        <NavItem icon={<Icons.Playlist />} label="Playlists" active={props.tab === 'playlists'} onClick={() => props.setTab('playlists')} />
        <NavItem icon={<Icons.Heart />} label="Favorites" active={props.tab === 'favorites'} onClick={() => props.setTab('favorites')} />
        <NavItem icon={<Icons.Clock />} label="History" active={props.tab === 'history'} onClick={() => props.setTab('history')} />
        <NavItem icon={<Icons.Podcast />} label="Podcasts" active={props.tab === 'podcasts'} onClick={() => props.setTab('podcasts')} />
      </nav>

      <div className="mt-auto">
        <nav className="flex flex-col gap-1">
          <NavItem icon={<Icons.Settings />} label="Settings" active={props.tab === 'settings'} onClick={() => props.setTab('settings')} />
        </nav>
        
        {/* User Info & Logout */}
        {props.user && (
          <div className="mt-4 pt-4 border-t border-white/10">
            <div className="flex items-center gap-3 px-3 py-2">
              {props.user.avatar_path ? (
                <img src={`/api/avatars/${props.user.avatar_path}`} alt="" className="w-8 h-8 rounded-full object-cover" />
              ) : (
                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center text-white text-sm font-medium">
                  {props.user.email.charAt(0).toUpperCase()}
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-white truncate">{props.user.email}</div>
                <div className="text-xs text-white/50">{props.user.role}</div>
              </div>
            </div>
            <button
              onClick={props.onLogout}
              className="w-full mt-2 px-3 py-2 text-left text-sm text-red-400 hover:text-red-300 hover:bg-white/5 rounded-lg transition-colors flex items-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
              Sign Out
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}

export function AppShellNew() {
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const { queue, index, isOpen, playTrackNow, playIndex, addToQueue, removeFromQueue, reorderQueue, clearQueue, next, prev, close, setQueueAndPlay, reset: resetPlayer } = usePlayer();
  const nowPlaying = isOpen ? queue[index] ?? null : null;

  const token = useAuth((s) => s.token);
  const user = useAuth((s) => s.user);
  const clearAuth = useAuth((s) => s.clear);
  const isAdmin = user?.role === 'admin';

  // Podcast player state
  const podcastEpisode = useUi((s) => s.podcastEpisode);

  // User preferences
  const preferences = usePreferences((s) => s.preferences);
  const loadPreferences = usePreferences((s) => s.load);

  // Initialize WebSocket connection for live updates
  useWebSocket(isAdmin);

  // Load preferences on mount
  useEffect(() => {
    if (token) loadPreferences(token);
  }, [token, loadPreferences]);

  const handleSignOut = async () => {
    try { await logout(token ?? undefined); } catch {}
    finally { 
      resetPlayer();
      clearAuth(); 
    }
  };

  const lastRecordedRef = useRef<number | null>(null);
  
  // Use new router for navigation
  const route = useRoute();
  const navigate = useRouter((s) => s.navigate);
  const tab = getTabFromRoute(route);
  
  // Helper to set tab (for backward compatibility with sidebar)
  const setTab = useCallback((tabName: string) => {
    switch (tabName) {
      case 'for-you': navigate({ type: 'for-you' }); break;
      case 'search': navigate({ type: 'search' }); break;
      case 'recently-added':
      case 'library': navigate({ type: 'recently-added' }); break;
      case 'browse': navigate({ type: 'browse' }); break;
      case 'playlists': navigate({ type: 'playlists' }); break;
      case 'favorites': navigate({ type: 'favorites' }); break;
      case 'history': navigate({ type: 'history' }); break;
      case 'podcasts': navigate({ type: 'podcasts' }); break;
      case 'settings': navigate({ type: 'settings' }); break;
      case 'admin': navigate({ type: 'admin' }); break;
      default: navigate({ type: 'search' });
    }
  }, [navigate]);

  useEffect(() => { initRouter(); }, []);

  const PLAYED_THRESHOLD_PCT = 0.8;
  const SKIP_THRESHOLD_PCT = 0.25;

  // Play mode state (normal, repeat, repeat-one, shuffle)
  const [playMode, setPlayMode] = useState<PlayMode>('normal');
  const [shuffledIndices, setShuffledIndices] = useState<number[]>([]);
  const [shuffleIndex, setShuffleIndex] = useState(0);

  // Favorite state for current track - use store for WebSocket updates
  const favIds = useFavorites((s) => s.ids);
  const favLastChange = useFavorites((s) => s.lastChange); // Force re-render on favorite changes
  const toggleFav = useFavorites((s) => s.toggle);
  const refreshFavs = useFavorites((s) => s.refresh);
  // Ensure number comparison for favorites (API may return string IDs)
  const isFavorite = nowPlaying ? favIds.has(Number(nowPlaying.id)) : false;
  
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _favChange = favLastChange; // Use the variable to prevent tree-shaking
  
  const [showPlaylistModal, setShowPlaylistModal] = useState(false);
  const [playlists, setPlaylists] = useState<{ id: number; name: string }[]>([]);
  
  // Lyrics overlay state
  const [showLyrics, setShowLyrics] = useState(false);
  const [playerCurrentTime, setPlayerCurrentTime] = useState(0);

  // Load favorites on auth
  useEffect(() => {
    if (token) {
      refreshFavs(token).catch(() => {});
    }
  }, [token, refreshFavs]);

  // Generate shuffled indices when shuffle is activated
  useEffect(() => {
    if (playMode === 'shuffle' && queue.length > 0) {
      const indices = Array.from({ length: queue.length }, (_, i) => i);
      // Fisher-Yates shuffle
      for (let i = indices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]];
      }
      setShuffledIndices(indices);
      setShuffleIndex(0);
    }
  }, [playMode, queue.length]);

  const toggleFavorite = async () => {
    if (!token || !nowPlaying) return;
    try {
      await toggleFav(token, Number(nowPlaying.id));
    } catch {}
  };

  const openPlaylistModal = async () => {
    if (!token) return;
    try {
      const data = await listPlaylists(token);
      setPlaylists(data.playlists?.map(p => ({ id: parseInt(p.id), name: p.name })) ?? []);
      setShowPlaylistModal(true);
    } catch {}
  };

  const addToPlaylist = async (playlistId: number) => {
    if (!token || !nowPlaying) return;
    try {
      await addTrackToPlaylist(token, String(playlistId), nowPlaying.id);
      setShowPlaylistModal(false);
    } catch {}
  };

  const onNextWithStats = (p?: { currentTime: number; duration: number }) => {
    if (token && nowPlaying?.id && p?.duration && Number.isFinite(p.duration) && p.duration > 0) {
      const pct = Math.max(0, Math.min(1, (p.currentTime ?? 0) / p.duration));
      if (pct < SKIP_THRESHOLD_PCT) {
        recordSkip(token, nowPlaying.id, pct).catch((e: any) => { if (e?.status === 401) clearAuth(); });
      }
    }
    next();
  };

  // Fetch similar tracks for auto-continue
  const fetchingMoreRef = useRef(false);
  const fetchSimilarTracks = useCallback(async (trackId: number, currentQueue: QueueTrack[]) => {
    if (!token) return [];
    try {
      const excludeIds = currentQueue.map(t => t.id).join(',');
      const r = await apiFetch(`/similar-tracks/${trackId}?exclude=${excludeIds}`, { method: 'GET' }, token) as {
        ok: boolean;
        tracks: { id: number; title: string; artist: string }[];
      };
      if (r.ok && r.tracks) {
        return r.tracks.map(t => ({ id: t.id, title: t.title, artist: t.artist, album: null }));
      }
    } catch {}
    return [];
  }, [token]);

  // Auto-load more tracks when near end of queue (continuous playback)
  useEffect(() => {
    if (!preferences.auto_continue || !nowPlaying || fetchingMoreRef.current) return;
    
    const remainingTracks = queue.length - index - 1;
    // Load more when 2 or fewer tracks remain
    if (remainingTracks <= 2 && queue.length > 0) {
      fetchingMoreRef.current = true;
      const lastTrack = queue[queue.length - 1];
      fetchSimilarTracks(lastTrack.id, queue).then(similarTracks => {
        if (similarTracks.length > 0) {
          // Add to queue without changing current playback
          const newQueue = [...queue, ...similarTracks];
          // Use addToQueue for each track to avoid disrupting playback
          similarTracks.forEach(t => addToQueue(t));
        }
        fetchingMoreRef.current = false;
      }).catch(() => {
        fetchingMoreRef.current = false;
      });
    }
  }, [index, queue, preferences.auto_continue, nowPlaying, fetchSimilarTracks, addToQueue]);

  // Handle track ending based on play mode
  const handlePlayModeEnded = async () => {
    if (playMode === 'repeat-one') {
      // Replay the same track - done in PlayerBar by seeking to 0
      return;
    }
    if (playMode === 'repeat') {
      // If at end, loop back to beginning
      if (index + 1 >= queue.length) {
        setQueueAndPlay(queue, 0);
      } else {
        next();
      }
      return;
    }
    if (playMode === 'shuffle') {
      const nextShuffleIdx = shuffleIndex + 1;
      if (nextShuffleIdx >= shuffledIndices.length) {
        // Reshuffle and start over
        const indices = Array.from({ length: queue.length }, (_, i) => i);
        for (let i = indices.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [indices[i], indices[j]] = [indices[j], indices[i]];
        }
        setShuffledIndices(indices);
        setShuffleIndex(0);
        setQueueAndPlay(queue, indices[0]);
      } else {
        setShuffleIndex(nextShuffleIdx);
        setQueueAndPlay(queue, shuffledIndices[nextShuffleIdx]);
      }
      return;
    }
    // Normal mode - just go to next if available
    if (index + 1 < queue.length) {
      next();
    } else if (preferences.auto_continue && nowPlaying) {
      // Queue ended and auto-continue is enabled - fetch similar tracks
      const similarTracks = await fetchSimilarTracks(nowPlaying.id, queue);
      if (similarTracks.length > 0) {
        // Add similar tracks to queue and play the first one
        const newQueue = [...queue, ...similarTracks];
        setQueueAndPlay(newQueue, queue.length);
      }
    }
  };

  // Show login if not authenticated
  if (!token) {
    return (
      <main className="min-h-screen flex items-center justify-center p-4">
        <AutoLogin />
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <img src="/logo.png" alt="mvbar" className="h-32 mx-auto mb-4" />
            <p className="text-white/50">Your personal music streaming service</p>
          </div>
          <div className="bg-white/5 rounded-2xl p-6 border border-white/10">
            <LoginForm />
          </div>
        </div>
      </main>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-zinc-900 to-black overflow-x-hidden">
      <AutoLogin />
      
      {/* Sidebar - Desktop */}
      <Sidebar tab={tab} setTab={setTab} isAdmin={isAdmin} user={user} onLogout={handleSignOut} />
      
      {/* Mobile Sidebar */}
      <MobileSidebar 
        tab={tab} 
        setTab={setTab} 
        isAdmin={isAdmin} 
        user={user} 
        onLogout={handleSignOut}
        isOpen={mobileSidebarOpen}
        onClose={() => setMobileSidebarOpen(false)}
        hasMusicPlayer={!!(isOpen && nowPlaying)}
        hasPodcastPlayer={!!podcastEpisode}
      />

      {/* Sticky Mobile Header */}
      <header className="lg:hidden fixed top-0 left-0 right-0 z-30 bg-zinc-900/95 backdrop-blur-xl border-b border-white/10">
        <div className="flex items-center px-4 py-3">
          <button
            onClick={() => setMobileSidebarOpen(true)}
            className="p-2 -ml-2 mr-2 rounded-lg hover:bg-white/10 transition-colors"
            aria-label="Open menu"
          >
            <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <h2 className="text-xl font-bold flex-1">
            {tab === 'for-you' && 'For You'}
            {tab === 'search' && 'Search'}
            {tab === 'browse' && 'Browse'}
            {tab === 'library' && 'Recently Added'}
            {tab === 'playlists' && 'Playlists'}
            {tab === 'favorites' && 'Favorites'}
            {tab === 'history' && 'Recently Played'}
            {tab === 'podcasts' && 'Podcasts'}
            {tab === 'settings' && 'Settings'}
            {tab === 'admin' && 'Admin'}
          </h2>
        </div>
      </header>

      {/* Main Content */}
      <main className={`lg:ml-64 pt-16 lg:pt-0 pb-24 lg:pb-28 ${nowPlaying ? 'pb-28' : ''}`}>
        <div className="max-w-6xl mx-auto px-4 py-6">
          {/* Header - Desktop only with navigation controls */}
          <header className="hidden lg:flex items-center justify-between mb-8">
            <div className="flex items-center gap-4">
              <NavigationHeader />
              <h2 className="text-2xl font-bold">
                {tab === 'for-you' && 'For You'}
                {tab === 'search' && 'Search'}
                {tab === 'browse' && 'Browse'}
                {(tab === 'library' || tab === 'recently-added') && 'Recently Added'}
                {tab === 'playlists' && 'Playlists'}
                {tab === 'favorites' && 'Favorites'}
                {tab === 'history' && 'Recently Played'}
                {tab === 'podcasts' && 'Podcasts'}
                {tab === 'settings' && 'Settings'}
                {tab === 'admin' && 'Admin'}
              </h2>
            </div>
          </header>

          {/* Content Area */}
          <section className="animate-fade-in">
            {tab === 'search' && (
              <Search
                onPlay={(t) => playTrackNow({ id: t.id, title: t.title, artist: t.artist })}
                onAddToQueue={(t) => addToQueue({ id: t.id, title: t.title, artist: t.artist })}
              />
            )}

            {(tab === 'library' || tab === 'recently-added') && (
              <RecentlyAdded
                onPlay={(t) => playTrackNow({ id: t.id, title: t.title, artist: t.artist })}
                onAddToQueue={(t) => addToQueue({ id: t.id, title: t.title, artist: t.artist })}
              />
            )}

            {tab === 'browse' && (
              <BrowseNew
                onPlayTrack={(t) => playTrackNow({ id: t.id, title: t.title, artist: t.artist, album: t.album })}
                onAddToQueue={(t) => addToQueue({ id: t.id, title: t.title, artist: t.artist, album: t.album })}
                onPlayAll={(tracks) => setQueueAndPlay(tracks, 0)}
              />
            )}

            {tab === 'playlists' && (
              <Playlists
                onPlayTrack={(t) => playTrackNow({ id: t.id, title: t.title, artist: t.artist })}
                onPlayAll={(tracks) => setQueueAndPlay(tracks, 0)}
              />
            )}

            {tab === 'favorites' && (
              <Favorites
                onPlay={(t) => playTrackNow({ id: t.id, title: t.title, artist: t.artist })}
                onAddToQueue={(t) => addToQueue({ id: t.id, title: t.title, artist: t.artist })}
              />
            )}

            {tab === 'history' && (
              <History
                onPlay={(t) => playTrackNow({ id: t.id, title: t.title, artist: t.artist })}
                onAddToQueue={(t) => addToQueue({ id: t.id, title: t.title, artist: t.artist })}
              />
            )}

            {tab === 'podcasts' && <Podcasts />}

            {tab === 'for-you' && <Recommendations />}

            {tab === 'settings' && <Settings />}

            {tab === 'admin' && isAdmin && <Admin />}
          </section>
        </div>
      </main>

      {/* Player Bar */}
      {isOpen && nowPlaying && (
        <PlayerBar
          nowPlaying={nowPlaying}
          hasPrev={index > 0}
          hasNext={index + 1 < queue.length}
          onPrev={prev}
          onNext={onNextWithStats}
          token={token}
          playMode={playMode}
          onPlayModeChange={setPlayMode}
          isFavorite={isFavorite}
          onToggleFavorite={toggleFavorite}
          onAddToPlaylist={openPlaylistModal}
          showLyrics={showLyrics}
          onToggleLyrics={() => setShowLyrics((v) => !v)}
          onTimeUpdate={setPlayerCurrentTime}
          queue={queue}
          queueIndex={index}
          onPlayQueueItem={playIndex}
          onRemoveFromQueue={removeFromQueue}
          onReorderQueue={reorderQueue}
          onClearQueue={clearQueue}
          onPlayed={(p) => {
            if (!token) return;
            if (lastRecordedRef.current === nowPlaying.id) return;
            const pct = p.duration > 0 ? p.currentTime / p.duration : 0;
            if (pct < PLAYED_THRESHOLD_PCT) return;
            lastRecordedRef.current = nowPlaying.id;
            recordPlay(token, nowPlaying.id).catch((e: any) => { if (e?.status === 401) clearAuth(); });
            // Scrobble to ListenBrainz
            scrobbleToListenBrainz(token, nowPlaying.id).catch(() => {});
          }}
          onClose={close}
          onEnded={handlePlayModeEnded}
          onPlayModeEnded={handlePlayModeEnded}
        />
      )}

      {/* Add to Playlist Modal */}
      {showPlaylistModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60" onClick={() => setShowPlaylistModal(false)}>
          <div className="glass rounded-xl border border-white/10 p-6 w-full max-w-sm mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-white mb-4">Add to Playlist</h3>
            {playlists.length === 0 ? (
              <p className="text-white/60 text-sm">No playlists found. Create one first!</p>
            ) : (
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {playlists.map((pl) => (
                  <button
                    key={pl.id}
                    onClick={() => addToPlaylist(pl.id)}
                    className="w-full text-left px-4 py-3 rounded-lg hover:bg-white/10 transition text-white"
                  >
                    {pl.name}
                  </button>
                ))}
              </div>
            )}
            <button
              onClick={() => setShowPlaylistModal(false)}
              className="mt-4 w-full py-2 rounded-lg bg-white/10 text-white hover:bg-white/20 transition"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Lyrics Overlay */}
      {showLyrics && nowPlaying && (
        <LyricsOverlay 
          trackId={nowPlaying.id} 
          currentTime={playerCurrentTime}
          onClose={() => setShowLyrics(false)} 
        />
      )}

      {/* Global Podcast Player - persists across tab changes */}
      <GlobalPodcastPlayer />
    </div>
  );
}

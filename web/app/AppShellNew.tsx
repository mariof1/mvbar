'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import Hls from 'hls.js';
import { AutoLogin } from './AutoLogin';
import { LoginForm } from './LoginForm';
import { ScanPanel } from './ScanPanel';
import { UserManagementPanel } from './UserManagementPanel';
import { LibraryManagementPanel } from './LibraryManagementPanel';
import { Admin } from './Admin';
import { SearchModal } from './SearchModal';
import { ToastContainer, useToastStore } from './Toast';
import { ConfirmModal } from './ConfirmModal';
import { Tracks } from './Tracks';
import { Playlists } from './Playlists';
import { BrowseNew } from './BrowseNew';
import { Favorites } from './Favorites';
import { History } from './History';
import { Recommendations } from './Recommendations';
import { Podcasts, PodcastPlayer } from './Podcasts';
import { Audiobooks, AudiobookPlayer } from './Audiobooks';
import { Settings } from './Settings';
import { RecentlyAdded } from './RecentlyAdded';
import { Social } from './Social';
import { ShareTrackDialog } from './ShareTrackDialog';
import { MissingMusic } from './MissingMusic';
import { formatCount } from './format';
import { useAuth } from './store';
import { useFavorites } from './favoritesStore';
import { usePlayer, type QueueTrack } from './playerStore';
import {
  MUSIC_AUDIO_ELEMENT_ID,
  directMusicStreamUrl,
  getMusicAudioElement,
  reportMusicPlaybackFailure,
} from './musicAudio';
import { useUi } from './uiStore';
import { useRouter, useRoute, initRouter, getTabFromRoute, type Route } from './router';
import { NavigationHeader } from './NavigationHeader';
import { usePreferences } from './preferencesStore';
import {
  getHlsStatus,
  logout,
  recordPartialListen,
  recordPlay,
  recordSkip,
  requestHlsTranscode,
  scrobbleToListenBrainz,
  nowPlayingListenBrainz,
  prefetchLyrics,
  listPlaylists,
  addTrackToPlaylist,
  apiFetch,
  sendRecommendationFeedback,
  type RecommendationFeedbackAction,
} from './apiClient';
import { useWebSocket, useAdminPending, usePluginUpdates } from './useWebSocket';
import { useSocialUpdates } from './socialStore';
import { preparePushNotifications, unsubscribeCurrentPushDevice } from './pushNotifications';
import { useBodyScrollLock } from './useBodyScrollLock';
import { mediaSessionArtwork } from './mediaSessionArtwork';
import { SeekSlider } from './SeekSlider';

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
  Social: () => (
    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 003.742-.479 3 3 0 00-4.682-2.72m.94 3.198v.001c0 .732-.411 1.406-1.068 1.73A10.964 10.964 0 0112 21c-1.77 0-3.443-.417-4.925-1.158A1.928 1.928 0 016 18.12v-.002a4.5 4.5 0 018.5-2.063M15 7.5a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z" />
    </svg>
  ),
  Share: () => (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M7.217 10.907a2.25 2.25 0 100 2.186m0-2.186c.18.273.283.6.283.943s-.103.67-.283.943m0-1.886 9.566-5.064m-9.566 7.25 9.566 5.064m0-12.314a2.25 2.25 0 103.934-2.186 2.25 2.25 0 00-3.934 2.186zm0 12.314a2.25 2.25 0 103.934 2.186 2.25 2.25 0 00-3.934-2.186z" />
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
  Audiobook: () => (
    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
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
  ThumbsUp: () => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.7}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 10.5l3.2-6.4A1.5 1.5 0 0112.04 3h.21a1.5 1.5 0 011.5 1.5V9h4.65a2.1 2.1 0 012.03 2.64l-1.8 6.75A2.25 2.25 0 0116.46 20H7.5m0-9.5H4.75A1.75 1.75 0 003 12.25v5.5c0 .97.78 1.75 1.75 1.75H7.5v-9z" />
    </svg>
  ),
  ThumbsDown: () => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.7}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 13.5l3.2 6.4a1.5 1.5 0 001.34 1.1h.21a1.5 1.5 0 001.5-1.5V15h4.65a2.1 2.1 0 002.03-2.64l-1.8-6.75A2.25 2.25 0 0016.46 4H7.5m0 9.5H4.75A1.75 1.75 0 013 11.75v-5.5c0-.97.78-1.75 1.75-1.75H7.5v9z" />
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

// Lyrics overlay component with synced highlighting and plain text fallback
function LyricsOverlay(props: { trackId: number; currentTime: number; onClose: () => void }) {
  const [loading, setLoading] = useState(true);
  const [parsedLines, setParsedLines] = useState<LyricLine[] | null>(null);
  const [plainLyrics, setPlainLyrics] = useState<string | null>(null);
  const [lyricsType, setLyricsType] = useState<'synced' | 'unsynced' | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const activeLineRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(props.onClose);

  useEffect(() => {
    onCloseRef.current = props.onClose;
  }, [props.onClose]);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('keydown', handleKeyDown);
    closeButtonRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previouslyFocused?.focus();
    };
  }, []);
  useBodyScrollLock(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setParsedLines(null);
      setPlainLyrics(null);
      setLyricsType(null);
      try {
        const res = await fetch(`/api/lyrics/${props.trackId}`);
        if (cancelled) return;
        if (res.status === 204 || !res.ok) {
          // No lyrics
        } else {
          const contentType = res.headers.get('content-type') || '';
          if (contentType.includes('application/json')) {
            const data = await res.json() as { lyrics: string; type: 'synced' | 'unsynced' };
            if (data.type === 'synced') {
              setLyricsType('synced');
              setParsedLines(parseLrcLyrics(data.lyrics));
            } else {
              setLyricsType('unsynced');
              setPlainLyrics(data.lyrics);
            }
          } else {
            // Legacy: plain text (synced .lrc)
            const text = await res.text();
            const parsed = parseLrcLyrics(text);
            if (parsed) {
              setLyricsType('synced');
              setParsedLines(parsed);
            } else {
              setLyricsType('unsynced');
              setPlainLyrics(text);
            }
          }
        }
      } catch {
        if (!cancelled) {
          setParsedLines(null);
          setPlainLyrics(null);
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
        role="dialog"
        aria-modal="true"
        aria-labelledby="lyrics-dialog-title"
      >
        <h2 id="lyrics-dialog-title" className="sr-only">Lyrics</h2>
        <button
          ref={closeButtonRef}
          type="button"
          onClick={props.onClose}
          className="absolute top-4 right-4 p-2 rounded-full hover:bg-white/10 transition text-white/60 hover:text-white z-10"
          aria-label="Close lyrics"
          title="Close lyrics"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="w-8 h-8 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : parsedLines && lyricsType === 'synced' ? (
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
        ) : plainLyrics && lyricsType === 'unsynced' ? (
          <div className="py-4 space-y-2">
            {plainLyrics.split('\n').map((line, i) => (
              <p key={i} className={`text-center text-lg ${line.trim() ? 'text-white/80' : 'h-4'}`}>
                {line.trim() || '\u00A0'}
              </p>
            ))}
          </div>
        ) : (
          <p className="text-white/60 text-center py-12">No lyrics available for this track.</p>
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

// Global Audiobook Player wrapper that uses the store
function GlobalAudiobookPlayer() {
  const audiobookChapter = useUi((s) => s.audiobookChapter);
  const setAudiobookChapter = useUi((s) => s.setAudiobookChapter);
  
  if (!audiobookChapter) return null;
  
  return (
    <AudiobookPlayer
      chapter={audiobookChapter}
      onClose={() => setAudiobookChapter(null)}
    />
  );
}

function PlayerBar(props: {
  nowPlaying: QueueTrack;
  activeTab: string;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: (p?: { currentTime: number; duration: number }) => void;
  onPlayed: (p: { currentTime: number; duration: number; listenedMs: number }) => void;
  onPlaybackStopped: (p: {
    trackId: number;
    currentTime: number;
    duration: number;
    listenedMs: number;
    completed: boolean;
    slateId?: string;
    bucketKey?: string;
  }) => void;
  onClose: () => void;
  onEnded: () => void;
  onPlayModeEnded: () => void;
  token: string | null;
  playMode: PlayMode;
  onPlayModeChange: (mode: PlayMode) => void;
  isFavorite: boolean;
  onToggleFavorite: () => void;
  onAddToPlaylist: () => void;
  onShare: () => void;
  showLyrics: boolean;
  onToggleLyrics: () => void;
  onRecommendationFeedback?: (action: RecommendationFeedbackAction) => void;
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
  const [showRecommendationMenu, setShowRecommendationMenu] = useState(false);
  const [showExpandedOptions, setShowExpandedOptions] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useBodyScrollLock(expanded);
  const [draggedIdx, setDraggedIdx] = useState<number | null>(null);
  const [playerDragY, setPlayerDragY] = useState(0);
  const [isPlayerDragging, setIsPlayerDragging] = useState(false);
  const [touchDraggedIdx, setTouchDraggedIdx] = useState<number | null>(null);
  const volumeRef = useRef<HTMLDivElement>(null);
  const queueRef = useRef<HTMLDivElement>(null);
  const recommendationMenuRef = useRef<HTMLDivElement>(null);
  const expandedOptionsRef = useRef<HTMLDivElement>(null);
  const mobileQueueListRef = useRef<HTMLDivElement>(null);
  const activeQueueItemRef = useRef<HTMLDivElement>(null);
  const playerDragRef = useRef<{
    pointerId: number;
    startY: number;
    startedAt: number;
  } | null>(null);
  const playerDismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressPlayerHandleClickRef = useRef(false);
  const queueTouchGestureRef = useRef<{
    timer: number;
    active: boolean;
    fromIndex: number;
    currentIndex: number;
    startX: number;
    startY: number;
  } | null>(null);
  const suppressQueueClickUntilRef = useRef(0);
  const playedSentRef = useRef(false);
  const playbackMetricsRef = useRef({
    trackId: props.nowPlaying.id,
    currentTime: 0,
    duration: 0,
    lastPosition: 0,
    listenedSeconds: 0,
  });
  const lastNotifiedTrackRef = useRef<number | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [preferHls, setPreferHls] = useState(true);
  const showToast = useToastStore((s) => s.show);
  const mediaSessionActionsRef = useRef({
    onPrev: props.onPrev,
    onNext: props.onNext,
    onClose: props.onClose,
  });
  const playerEventPropsRef = useRef(props);
  playerEventPropsRef.current = props;
  mediaSessionActionsRef.current = {
    onPrev: props.onPrev,
    onNext: props.onNext,
    onClose: props.onClose,
  };

  const canGoPrevious = props.hasPrev || props.playMode !== 'normal';
  const canGoNext = props.hasNext || props.playMode !== 'normal';

  useEffect(() => {
    const trackId = props.nowPlaying.id;
    const stopped = props.onPlaybackStopped;
    setArtOk(true);
    setShowRecommendationMenu(false);
    setShowExpandedOptions(false);
    playedSentRef.current = false;
    playbackMetricsRef.current = {
      trackId,
      currentTime: 0,
      duration: 0,
      lastPosition: 0,
      listenedSeconds: 0,
    };

    return () => {
      const metrics = playbackMetricsRef.current;
      if (metrics.trackId !== trackId || metrics.listenedSeconds < 1) return;
      stopped({
        trackId,
        currentTime: metrics.currentTime,
        duration: metrics.duration,
        listenedMs: Math.round(metrics.listenedSeconds * 1000),
        completed: playedSentRef.current,
        slateId: props.nowPlaying.recommendation_slate_id,
        bucketKey: props.nowPlaying.recommendation_bucket_key,
      });
    };
    // Finalize only when this track leaves the player; callback identity may
    // change as the shell renders and must not split one listen into fragments.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.nowPlaying.id]);

  // Dialogs can navigate while the full player is open (for example, finding
  // friends from the share sheet). Reveal the destination when that happens.
  useEffect(() => {
    setExpanded(false);
    setPlayerDragY(0);
    setIsPlayerDragging(false);
    setShowExpandedOptions(false);
  }, [props.activeTab]);

  useEffect(() => {
    if (lastNotifiedTrackRef.current === props.nowPlaying.id) return;
    lastNotifiedTrackRef.current = props.nowPlaying.id;

    const title = props.nowPlaying.title || 'Unknown Track';
    const artist = props.nowPlaying.artist;
    showToast(`Now playing: ${title}${artist ? ` — ${artist}` : ''}`, 'playing');
  }, [props.nowPlaying.id, props.nowPlaying.title, props.nowPlaying.artist, showToast]);

  // Publish metadata independently from stream startup. This lets installed
  // desktop PWAs expose the current track even while playback is buffering.
  useEffect(() => {
    if (!('mediaSession' in navigator) || !('MediaMetadata' in window)) return;

    const metadata = new MediaMetadata({
      title: props.nowPlaying.title || 'Unknown Track',
      artist: props.nowPlaying.artist || 'Unknown Artist',
      album: props.nowPlaying.album || '',
      artwork: mediaSessionArtwork(`/api/art/${props.nowPlaying.id}`),
    });
    navigator.mediaSession.metadata = metadata;

    return () => {
      if (navigator.mediaSession.metadata === metadata) {
        navigator.mediaSession.metadata = null;
      }
    };
  }, [props.nowPlaying.id, props.nowPlaying.title, props.nowPlaying.artist, props.nowPlaying.album]);

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

  // Keep recommendation tuning menus transient, like the queue and volume controls.
  useEffect(() => {
    if (!showRecommendationMenu) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (recommendationMenuRef.current && !recommendationMenuRef.current.contains(event.target as Node)) {
        setShowRecommendationMenu(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowRecommendationMenu(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [showRecommendationMenu]);

  useEffect(() => {
    if (!showExpandedOptions) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (expandedOptionsRef.current && !expandedOptionsRef.current.contains(event.target as Node)) {
        setShowExpandedOptions(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowExpandedOptions(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [showExpandedOptions]);

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
    const resetQueueGesture = () => {
      const gesture = queueTouchGestureRef.current;
      if (gesture) window.clearTimeout(gesture.timer);
      queueTouchGestureRef.current = null;
      setTouchDraggedIdx(null);
    };

    const handleTouchMove = (event: TouchEvent) => {
      const gesture = queueTouchGestureRef.current;
      const touch = event.touches[0];
      if (!gesture || !touch) return;

      if (!gesture.active) {
        if (Math.hypot(touch.clientX - gesture.startX, touch.clientY - gesture.startY) > 10) {
          resetQueueGesture();
        }
        return;
      }

      event.preventDefault();
      const queueList = mobileQueueListRef.current;
      if (queueList) {
        const bounds = queueList.getBoundingClientRect();
        const edgeSize = 48;
        if (touch.clientY < bounds.top + edgeSize) queueList.scrollTop -= 12;
        if (touch.clientY > bounds.bottom - edgeSize) queueList.scrollTop += 12;
      }

      const target = document.elementFromPoint(touch.clientX, touch.clientY);
      const row = target instanceof Element
        ? target.closest<HTMLElement>('[data-mobile-queue-index]')
        : null;
      const nextIndex = Number(row?.dataset.mobileQueueIndex);
      if (!Number.isInteger(nextIndex) || nextIndex === gesture.currentIndex) return;

      gesture.currentIndex = nextIndex;
      setTouchDraggedIdx(nextIndex);
    };

    const handleTouchEnd = (event: TouchEvent) => {
      const gesture = queueTouchGestureRef.current;
      if (gesture?.active) {
        event.preventDefault();
        suppressQueueClickUntilRef.current = Date.now() + 500;
        if (gesture.fromIndex !== gesture.currentIndex) {
          playerEventPropsRef.current.onReorderQueue?.(gesture.fromIndex, gesture.currentIndex);
        }
      }
      resetQueueGesture();
    };

    document.addEventListener('touchmove', handleTouchMove, { passive: false });
    document.addEventListener('touchend', handleTouchEnd, { passive: false });
    document.addEventListener('touchcancel', handleTouchEnd, { passive: false });
    return () => {
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleTouchEnd);
      document.removeEventListener('touchcancel', handleTouchEnd);
      resetQueueGesture();
      if (playerDismissTimerRef.current) clearTimeout(playerDismissTimerRef.current);
    };
  }, []);

  useEffect(() => {
    try {
      const v = localStorage.getItem('mvbar_prefer_hls');
      if (v !== null) setPreferHls(v !== '0');
      const vol = localStorage.getItem('mvbar_volume');
      if (vol) setVolume(parseFloat(vol));
    } catch {}
  }, []);

  // The audio element lives at AppShell level so it already exists when a
  // mobile user taps a track. PlayerBar only binds its controls and events.
  useEffect(() => {
    const a = getMusicAudioElement();
    audioRef.current = a;
    if (!a) return;

    const onPlay = () => {
      a.dataset.mvbarPlaybackState = 'playing';
      delete a.dataset.mvbarPlaybackError;
      setIsPlaying(true);
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    };
    const onPause = () => {
      if (a.dataset.mvbarPlaybackState !== 'failed') {
        a.dataset.mvbarPlaybackState = 'paused';
      }
      setIsPlaying(false);
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
    };
    const onTimeUpdate = () => {
      setCurrentTime(a.currentTime);
      playerEventPropsRef.current.onTimeUpdate?.(a.currentTime);
      updateMediaSessionPosition(a.currentTime, a.duration);
      const metrics = playbackMetricsRef.current;
      if (metrics.trackId === playerEventPropsRef.current.nowPlaying.id) {
        const delta = a.currentTime - metrics.lastPosition;
        // Ignore seeks while counting actual media consumed. Normal browser
        // timeupdate intervals remain comfortably below ten seconds.
        if (!a.paused && delta > 0 && delta <= 10) metrics.listenedSeconds += delta;
        metrics.currentTime = a.currentTime;
        metrics.duration = Number.isFinite(a.duration) ? a.duration : metrics.duration;
        metrics.lastPosition = a.currentTime;
      }
      const meaningfulListenSeconds = Math.min(30, a.duration * 0.5);
      if (
        !playedSentRef.current
        && a.duration > 0
        && a.currentTime / a.duration >= 0.8
        && metrics.listenedSeconds >= meaningfulListenSeconds
      ) {
        playedSentRef.current = true;
        playerEventPropsRef.current.onPlayed({
          currentTime: a.currentTime,
          duration: a.duration,
          listenedMs: Math.round(metrics.listenedSeconds * 1000),
        });
      }
    };
    const onLoadedMetadata = () => {
      setDuration(a.duration);
      updateMediaSessionPosition(a.currentTime, a.duration);
      const metrics = playbackMetricsRef.current;
      metrics.duration = Number.isFinite(a.duration) ? a.duration : 0;
      metrics.currentTime = a.currentTime;
      metrics.lastPosition = a.currentTime;
    };
    const onDurationChange = () => {
      setDuration(a.duration);
      updateMediaSessionPosition(a.currentTime, a.duration);
    };
    const onRateChange = () => updateMediaSessionPosition(a.currentTime, a.duration);
    const onError = () => {
      a.dataset.mvbarPlaybackState = 'failed';
      a.dataset.mvbarPlaybackError = 'MediaError';
      reportMusicPlaybackFailure(a.error);
    };
    const onEnded = () => {
      const currentProps = playerEventPropsRef.current;
      const metrics = playbackMetricsRef.current;
      const meaningfulListenSeconds = a.duration > 0 ? Math.min(30, a.duration * 0.5) : 30;
      if (!playedSentRef.current && metrics.listenedSeconds >= meaningfulListenSeconds) {
        playedSentRef.current = true;
        currentProps.onPlayed({
          currentTime: Number.isFinite(a.duration) ? a.duration : a.currentTime,
          duration: a.duration,
          listenedMs: Math.round(metrics.listenedSeconds * 1000),
        });
      }
      if (currentProps.playMode === 'repeat-one') {
        a.currentTime = 0;
        a.play().catch(reportMusicPlaybackFailure);
      } else {
        currentProps.onEnded();
      }
    };

    a.addEventListener('play', onPlay);
    a.addEventListener('pause', onPause);
    a.addEventListener('timeupdate', onTimeUpdate);
    a.addEventListener('loadedmetadata', onLoadedMetadata);
    a.addEventListener('durationchange', onDurationChange);
    a.addEventListener('ratechange', onRateChange);
    a.addEventListener('error', onError);
    a.addEventListener('ended', onEnded);

    setIsPlaying(!a.paused);
    setCurrentTime(a.currentTime || 0);
    setDuration(Number.isFinite(a.duration) ? a.duration : 0);
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = a.paused ? 'paused' : 'playing';
    }

    return () => {
      a.removeEventListener('play', onPlay);
      a.removeEventListener('pause', onPause);
      a.removeEventListener('timeupdate', onTimeUpdate);
      a.removeEventListener('loadedmetadata', onLoadedMetadata);
      a.removeEventListener('durationchange', onDurationChange);
      a.removeEventListener('ratechange', onRateChange);
      a.removeEventListener('error', onError);
      a.removeEventListener('ended', onEnded);
      if (audioRef.current === a) audioRef.current = null;
    };
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

    const setStream = async (): Promise<boolean> => {
      cleanupHls();
      const streamUrl = directMusicStreamUrl(props.nowPlaying.id);
      const sourceChanged = a.getAttribute('src') !== streamUrl;
      if (sourceChanged) a.src = streamUrl;

      // The store normally starts this source synchronously from the tap. Do
      // not issue a second, asynchronous play() for that same source.
      if (!sourceChanged) return !a.paused;

      a.dataset.mvbarPlaybackState = 'pending';
      delete a.dataset.mvbarPlaybackError;
      try {
        await a.play();
        a.dataset.mvbarPlaybackState = 'playing';
        return true;
      } catch (error) {
        a.dataset.mvbarPlaybackState = 'failed';
        a.dataset.mvbarPlaybackError = error && typeof error === 'object' && 'name' in error
          ? String((error as { name?: unknown }).name || '')
          : 'PlaybackError';
        reportMusicPlaybackFailure(error);
        return false;
      }
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
        try {
          await a.play();
          return true;
        } catch (error) {
          reportMusicPlaybackFailure(error);
          return false;
        }
      }
      if (!Hls.isSupported()) { await setStream(); return false; }
      cleanupHls();
      const hls = new Hls({ enableWorker: true });
      hlsRef.current = hls;
      hls.on(Hls.Events.ERROR, (_evt, data) => { if (data?.fatal) void setStream(); });
      hls.loadSource(`/api/hls/${id}`);
      hls.attachMedia(a);
      if (typeof seekTo === 'number' && seekTo > 0) {
        a.addEventListener('loadedmetadata', () => { try { a.currentTime = seekTo; } catch {} }, { once: true });
      }
      try {
        await a.play();
        return true;
      } catch (error) {
        reportMusicPlaybackFailure(error);
        return false;
      }
    };

    (async () => {
      if (cancelled) return;
      await setStream();
      // Submit "now playing" to ListenBrainz and prefetch lyrics
      if (props.token) {
        nowPlayingListenBrainz(props.token, props.nowPlaying.id).catch(() => {});
        prefetchLyrics(props.token, props.nowPlaying.id).catch(() => {});
      }
      
      if (!props.token || !preferHls) return;
      try {
        await requestHlsTranscode(props.token, props.nowPlaying.id);
        for (let i = 0; i < 20 && !cancelled; i++) {
          const s = await getHlsStatus(props.token, props.nowPlaying.id);
          if (s?.ready) {
            // Never replace a direct stream that is already playing. A source
            // swap can pause mobile playback and its follow-up play() no longer
            // carries the original user gesture. HLS is only a media-error
            // fallback, not an in-flight upgrade.
            if (
              a.dataset.mvbarPlaybackState === 'failed' &&
              a.dataset.mvbarPlaybackError !== 'NotAllowedError'
            ) {
              const resume = a.currentTime || 0;
              await setHls(resume);
            }
            break;
          }
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

    const actionHandlers: Array<[MediaSessionAction, MediaSessionActionHandler | null]> = [
      ['play', () => { audioRef.current?.play().catch(reportMusicPlaybackFailure); }],
      ['pause', () => { audioRef.current?.pause(); }],
      ['stop', () => {
        const a = audioRef.current;
        if (a) {
          a.pause();
          a.currentTime = 0;
        }
        mediaSessionActionsRef.current.onClose();
      }],
      ['previoustrack', canGoPrevious ? () => { mediaSessionActionsRef.current.onPrev(); } : null],
      ['nexttrack', canGoNext ? () => {
        const a = audioRef.current;
        mediaSessionActionsRef.current.onNext({
          currentTime: a?.currentTime || 0,
          duration: a && Number.isFinite(a.duration) ? a.duration : 0,
        });
      } : null],
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
  }, [canGoPrevious, canGoNext]);

  // Do not leave stale track state in Windows after closing the player.
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    return () => {
      navigator.mediaSession.playbackState = 'none';
      try { navigator.mediaSession.setPositionState(); } catch {}
    };
  }, []);

  const togglePlay = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) a.play().catch(reportMusicPlaybackFailure);
    else a.pause();
  };

  const seekTo = (position: number) => {
    const a = audioRef.current;
    if (!a || !duration) return;
    const nextPosition = Math.max(0, Math.min(position, duration));
    a.currentTime = nextPosition;
    setCurrentTime(nextPosition);
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    setVolume(v);
    try { localStorage.setItem('mvbar_volume', String(v)); } catch {}
  };

  // Update Media Session position state for lock screen seek bar
  const updateMediaSessionPosition = (position: number, dur: number) => {
    if ('mediaSession' in navigator && Number.isFinite(dur) && dur > 0) {
      try {
        navigator.mediaSession.setPositionState({
          duration: dur,
          playbackRate: audioRef.current?.playbackRate || 1,
          position: Math.max(0, Math.min(Number.isFinite(position) ? position : 0, dur)),
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

  const resetExpandedPlayerDrag = () => {
    playerDragRef.current = null;
    setIsPlayerDragging(false);
    setPlayerDragY(0);
  };

  const minimizeExpandedPlayer = (animate = false) => {
    if (playerDismissTimerRef.current) clearTimeout(playerDismissTimerRef.current);
    playerDragRef.current = null;
    setIsPlayerDragging(false);
    setShowExpandedOptions(false);
    if (!animate) {
      setExpanded(false);
      setPlayerDragY(0);
      return;
    }
    setPlayerDragY(window.innerHeight);
    playerDismissTimerRef.current = setTimeout(() => {
      setExpanded(false);
      setPlayerDragY(0);
      playerDismissTimerRef.current = null;
    }, 180);
  };

  const submitPlayerRecommendationFeedback = (action: RecommendationFeedbackAction) => {
    setShowRecommendationMenu(false);
    setShowExpandedOptions(false);
    props.onRecommendationFeedback?.(action);
  };

  const handlePlayerDragStart = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (playerDismissTimerRef.current) clearTimeout(playerDismissTimerRef.current);
    playerDragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startedAt: performance.now(),
    };
    suppressPlayerHandleClickRef.current = false;
    setIsPlayerDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePlayerDragMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = playerDragRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const distance = Math.max(0, event.clientY - gesture.startY);
    if (distance > 6) suppressPlayerHandleClickRef.current = true;
    setPlayerDragY(distance);
  };

  const handlePlayerDragEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = playerDragRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const distance = Math.max(0, event.clientY - gesture.startY);
    const elapsed = Math.max(1, performance.now() - gesture.startedAt);
    const velocity = distance / elapsed;
    const shouldMinimize = distance >= Math.min(160, window.innerHeight * 0.2)
      || (distance >= 28 && velocity >= 0.65);
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch {}
    playerDragRef.current = null;
    setIsPlayerDragging(false);
    if (shouldMinimize) minimizeExpandedPlayer(true);
    else setPlayerDragY(0);
    if (suppressPlayerHandleClickRef.current) {
      setTimeout(() => { suppressPlayerHandleClickRef.current = false; }, 0);
    }
  };

  const handlePlayerDragCancel = (event: React.PointerEvent<HTMLDivElement>) => {
    if (playerDragRef.current?.pointerId !== event.pointerId) return;
    resetExpandedPlayerDrag();
  };

  const startQueueLongPress = (event: React.TouchEvent<HTMLButtonElement>, index: number) => {
    if (event.touches.length !== 1 || !props.onReorderQueue) return;
    const existing = queueTouchGestureRef.current;
    if (existing) window.clearTimeout(existing.timer);
    const touch = event.touches[0];
    const gesture = {
      timer: 0,
      active: false,
      fromIndex: index,
      currentIndex: index,
      startX: touch.clientX,
      startY: touch.clientY,
    };
    gesture.timer = window.setTimeout(() => {
      if (queueTouchGestureRef.current !== gesture) return;
      gesture.active = true;
      setTouchDraggedIdx(gesture.currentIndex);
      try { navigator.vibrate?.(15); } catch {}
    }, 400);
    queueTouchGestureRef.current = gesture;
  };

  return (
    <>
      {/* Expanded Player Overlay */}
      {expanded && (
        <div 
          className="fixed inset-0 z-[100] bg-black/95 backdrop-blur-xl lg:hidden animate-fade-in"
          onClick={() => minimizeExpandedPlayer()}
        >
          <div 
            className={`h-full flex flex-col overflow-y-auto ${
              isPlayerDragging ? '' : 'transition-[transform,opacity] duration-200 ease-out'
            }`}
            onClick={(e) => e.stopPropagation()}
            style={{
              transform: `translate3d(0, ${playerDragY}px, 0)`,
              opacity: 1 - Math.min(playerDragY / 600, 0.35),
              willChange: playerDragY > 0 ? 'transform, opacity' : undefined,
            }}
          >
            <div
              className={`shrink-0 touch-none select-none ${isPlayerDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
              onPointerDown={handlePlayerDragStart}
              onPointerMove={handlePlayerDragMove}
              onPointerUp={handlePlayerDragEnd}
              onPointerCancel={handlePlayerDragCancel}
            >
              {/* Close handle */}
              <div className="flex justify-center pt-4 pb-2">
                <button
                  type="button"
                  onClick={() => {
                    if (suppressPlayerHandleClickRef.current) return;
                    minimizeExpandedPlayer();
                  }}
                  className="h-6 w-16 rounded-full p-2.5"
                  aria-label="Minimize player"
                >
                  <span className="block h-1.5 w-full rounded-full bg-white/30" />
                </button>
              </div>

              {/* Artwork */}
              <div className="flex-shrink-0 px-8 pt-3 pb-4">
                {artOk ? (
                  <img
                    src={`/api/art/${props.nowPlaying.id}`}
                    alt=""
                    draggable={false}
                    className="mx-auto aspect-square w-[min(72vw,34vh,280px)] rounded-2xl object-cover shadow-2xl"
                    onError={() => setArtOk(false)}
                  />
                ) : (
                  <div className="mx-auto flex aspect-square w-[min(72vw,34vh,280px)] items-center justify-center rounded-2xl bg-white/10">
                    <Icons.Playlist />
                  </div>
                )}
              </div>
            </div>

            {/* Track Info */}
            <div className="mb-4 px-8 text-center">
              <h2 className="text-xl font-bold text-white truncate">
                {props.nowPlaying.title ?? `Track #${props.nowPlaying.id}`}
              </h2>
              <p className="text-white/60 truncate mt-1">
                {props.nowPlaying.artist ?? 'Unknown Artist'}
              </p>
            </div>

            {/* Progress bar */}
            <div className="mb-3 px-8">
              <SeekSlider
                currentTime={currentTime}
                duration={duration}
                onSeek={seekTo}
                accent="#06b6d4"
                label="Seek through track"
              />
              <div className="flex justify-between text-xs text-white/50 mt-1">
                <span>{formatTime(currentTime)}</span>
                <span>{formatTime(duration)}</span>
              </div>
            </div>

            {/* Main Controls */}
            <div className="mb-4 flex items-center justify-center gap-3 min-[380px]:gap-6">
              <button
                onClick={cyclePlayMode}
                className={`p-3 rounded-full ${props.playMode !== 'normal' ? 'text-cyan-400' : 'text-white/50'}`}
                aria-label={getPlayModeTitle()}
                title={getPlayModeTitle()}
              >
                {getPlayModeIcon()}
              </button>
              <button
                onClick={props.onPrev}
                disabled={!props.hasPrev && props.playMode === 'normal'}
                className="p-3 rounded-full text-white disabled:opacity-30"
                aria-label="Previous track"
                title="Previous track"
              >
                <Icons.SkipBack />
              </button>
              <button
                onClick={togglePlay}
                className="p-5 rounded-full bg-white text-black shadow-lg"
                aria-label={isPlaying ? 'Pause' : 'Play'}
                title={isPlaying ? 'Pause' : 'Play'}
              >
                {isPlaying ? <Icons.Pause /> : <Icons.Play />}
              </button>
              <button
                onClick={() => props.onNext({ currentTime, duration })}
                disabled={!props.hasNext && props.playMode === 'normal'}
                className="p-3 rounded-full text-white disabled:opacity-30"
                aria-label="Next track"
                title="Next track"
              >
                <Icons.SkipForward />
              </button>
              <button
                onClick={props.onToggleLyrics}
                className={`p-3 rounded-full ${props.showLyrics ? 'text-cyan-400' : 'text-white/50'}`}
                aria-label={props.showLyrics ? 'Hide lyrics' : 'Show lyrics'}
                title={props.showLyrics ? 'Hide lyrics' : 'Show lyrics'}
              >
                <Icons.Lyrics />
              </button>
            </div>

            {/* Compact action shelf — less common controls live under More. */}
            <div className="mx-auto mb-5 grid w-[calc(100%_-_2rem)] max-w-[330px] grid-cols-4 rounded-2xl border border-white/10 bg-white/[0.04] p-1.5">
              <button
                onClick={(e) => { e.stopPropagation(); props.onToggleFavorite(); }}
                className={`flex min-w-0 flex-col items-center gap-1 rounded-xl px-1 py-2 text-xs transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70 active:scale-95 ${props.isFavorite ? 'bg-pink-500/10 text-pink-400' : 'text-white/55 hover:bg-white/[0.06] hover:text-white/80'}`}
                aria-label={props.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
              >
                {props.isFavorite ? <Icons.HeartFilled /> : <Icons.HeartOutline />}
                <span>{props.isFavorite ? 'Liked' : 'Like'}</span>
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); props.onAddToPlaylist(); }}
                className="flex min-w-0 flex-col items-center gap-1 rounded-xl px-1 py-2 text-xs text-white/55 transition hover:bg-white/[0.06] hover:text-white/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70 active:scale-95"
                aria-label="Add to playlist"
              >
                <Icons.Plus />
                <span>Playlist</span>
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); props.onShare(); }}
                className="flex min-w-0 flex-col items-center gap-1 rounded-xl px-1 py-2 text-xs text-white/55 transition hover:bg-white/[0.06] hover:text-white/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70 active:scale-95"
                aria-label="Share with a friend"
              >
                <Icons.Share />
                <span>Share</span>
              </button>

              <div className="relative min-w-0" ref={expandedOptionsRef}>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    setShowExpandedOptions((open) => !open);
                  }}
                  className={`flex h-full w-full flex-col items-center gap-1 rounded-xl px-1 py-2 text-xs transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70 active:scale-95 ${showExpandedOptions ? 'bg-white/10 text-white' : 'text-white/55 hover:bg-white/[0.06] hover:text-white/80'}`}
                  aria-label="More player options"
                  aria-expanded={showExpandedOptions}
                  aria-haspopup="menu"
                >
                  <span className="flex h-5 items-center text-lg leading-none" aria-hidden="true">•••</span>
                  <span>More</span>
                </button>

                {showExpandedOptions && (
                  <div
                    role="menu"
                    className="absolute bottom-full right-0 z-30 mb-3 w-[min(16rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-white/10 bg-zinc-900/95 py-1.5 text-sm shadow-2xl backdrop-blur-xl"
                  >
                    {props.onRecommendationFeedback && (
                      <>
                        <div className="px-3 pb-1.5 pt-1 text-[11px] font-medium uppercase tracking-wider text-white/35">
                          Tune recommendations
                        </div>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={(event) => { event.stopPropagation(); submitPlayerRecommendationFeedback('more_like_this'); }}
                          className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-emerald-300 hover:bg-white/10"
                        >
                          <Icons.ThumbsUp />
                          <span>More like this</span>
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={(event) => { event.stopPropagation(); submitPlayerRecommendationFeedback('less_like_artist'); }}
                          className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-amber-200 hover:bg-white/10"
                        >
                          <span className="flex h-4 w-4 items-center justify-center text-lg" aria-hidden="true">−</span>
                          <span>Less from this artist</span>
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={(event) => { event.stopPropagation(); submitPlayerRecommendationFeedback('not_for_me'); }}
                          className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-red-300 hover:bg-white/10"
                        >
                          <Icons.ThumbsDown />
                          <span>Don’t recommend this track</span>
                        </button>
                        <div className="my-1 border-t border-white/10" />
                      </>
                    )}
                  <button
                    type="button"
                    role="menuitem"
                    onClick={(event) => {
                      event.stopPropagation();
                      setShowExpandedOptions(false);
                      props.onClose();
                    }}
                    className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-red-300 hover:bg-white/10"
                  >
                    <Icons.Close />
                    <span>Stop and close player</span>
                  </button>
                  </div>
                )}
              </div>
            </div>

            {/* Queue Section */}
            {props.queue && props.queue.length > 1 && (
              <div className="flex-1 px-4 pb-8">
                <div className="mb-3 flex items-center justify-between gap-3 px-4">
                  <h3 className="text-sm font-semibold uppercase tracking-wide text-white/70">
                    Queue <span className="text-white/40">{props.queue.length}</span>
                  </h3>
                  <span className="text-[11px] text-white/40">Hold to reorder</span>
                </div>
                <div ref={mobileQueueListRef} className="space-y-1 max-h-[300px] overflow-y-auto overscroll-contain">
                  {props.queue.map((track, idx) => (
                    <button
                      key={`${track.id}-${idx}`}
                      type="button"
                      data-mobile-queue-index={idx}
                      onTouchStart={(event) => startQueueLongPress(event, idx)}
                      onContextMenu={(event) => event.preventDefault()}
                      onClick={() => {
                        if (Date.now() < suppressQueueClickUntilRef.current) return;
                        props.onPlayQueueItem?.(idx);
                      }}
                      className={`relative w-full flex items-center gap-3 p-3 rounded-lg transition touch-pan-y select-none ${
                        idx === props.queueIndex 
                          ? 'bg-cyan-500/20 text-cyan-400' 
                          : 'text-white/70 hover:bg-white/10'
                      } ${touchDraggedIdx === idx ? 'z-10 scale-[1.02] bg-white/15 shadow-xl ring-1 ring-cyan-400/60' : ''}`}
                      style={{ WebkitTouchCallout: 'none' }}
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
        {/* Lightweight recommendation tuning for the mobile mini player. */}
        {props.onRecommendationFeedback && (
          <div className="absolute bottom-full right-3 z-20 mb-3 flex items-center gap-1 rounded-full border border-white/10 bg-black/45 p-1 text-white/55 shadow-lg backdrop-blur-md sm:hidden">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                submitPlayerRecommendationFeedback('more_like_this');
              }}
              className="rounded-full p-2 transition hover:bg-white/10 hover:text-emerald-300 active:scale-95"
              aria-label="More like this"
              title="More like this"
            >
              <Icons.ThumbsUp />
            </button>
            <span className="h-4 w-px bg-white/10" aria-hidden="true" />
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                submitPlayerRecommendationFeedback('not_for_me');
              }}
              className="rounded-full p-2 transition hover:bg-white/10 hover:text-red-300 active:scale-95"
              aria-label="Don't recommend this track"
              title="Don't recommend this track"
            >
              <Icons.ThumbsDown />
            </button>
          </div>
        )}

        {/* Progress bar - full width on top */}
        <div className="absolute -top-2 left-0 right-0 z-10">
          <SeekSlider
            currentTime={currentTime}
            duration={duration}
            onSeek={seekTo}
            accent="#06b6d4"
            label="Seek through track"
            compact
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
                aria-label={props.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                title={props.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
              >
                {props.isFavorite ? <Icons.HeartFilled /> : <Icons.HeartOutline />}
              </button>
              <button
                onClick={props.onPrev}
                disabled={!props.hasPrev && props.playMode === 'normal'}
                className="p-2 rounded-full text-white/70 disabled:opacity-30"
                aria-label="Previous track"
                title="Previous track"
              >
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M6 6h2v12H6V6zm3.5 6l8.5 6V6l-8.5 6z" />
                </svg>
              </button>
              <button
                onClick={togglePlay}
                className="p-2 rounded-full bg-white text-black"
                aria-label={isPlaying ? 'Pause' : 'Play'}
                title={isPlaying ? 'Pause' : 'Play'}
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
                aria-label="Next track"
                title="Next track"
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
              <button
                onClick={(e) => { e.stopPropagation(); props.onShare(); }}
                className="p-2 rounded-full text-white/60 hover:text-white hover:bg-white/10 transition"
                title="Share with a friend"
              >
                <Icons.Share />
              </button>
            </div>

            {/* Desktop Playback Controls */}
            <div className="hidden sm:flex items-center gap-2">
              <button
                onClick={props.onPrev}
                disabled={!props.hasPrev && props.playMode === 'normal'}
                className="p-2.5 rounded-full text-white/80 hover:text-white hover:bg-white/10 transition disabled:opacity-30"
                aria-label="Previous track"
                title="Previous track"
              >
                <Icons.SkipBack />
              </button>
              <button
                onClick={togglePlay}
                className="p-3 rounded-full bg-white text-black hover:bg-white/90 hover:scale-105 transition-all shadow-lg"
                aria-label={isPlaying ? 'Pause' : 'Play'}
                title={isPlaying ? 'Pause' : 'Play'}
              >
                {isPlaying ? <Icons.Pause /> : <Icons.Play />}
              </button>
              <button
                onClick={() => props.onNext({ currentTime, duration })}
                disabled={!props.hasNext && props.playMode === 'normal'}
                className="p-2.5 rounded-full text-white/80 hover:text-white hover:bg-white/10 transition disabled:opacity-30"
                aria-label="Next track"
                title="Next track"
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
              {props.onRecommendationFeedback && (
                <div className="relative" ref={recommendationMenuRef}>
                  <button
                    type="button"
                    onClick={() => setShowRecommendationMenu((open) => !open)}
                    className={`rounded-full px-2.5 py-1.5 text-lg leading-none transition hover:bg-white/10 hover:text-white ${showRecommendationMenu ? 'bg-white/10 text-white' : 'text-white/50'}`}
                    title="Tune recommendations"
                    aria-label="Tune recommendations"
                    aria-expanded={showRecommendationMenu}
                    aria-haspopup="menu"
                  >
                    ···
                  </button>
                  {showRecommendationMenu && (
                  <div role="menu" className="absolute bottom-full right-0 z-20 mb-2 w-52 overflow-hidden rounded-xl border border-white/10 bg-zinc-900 py-1 shadow-2xl">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => submitPlayerRecommendationFeedback('more_like_this')}
                      className="block w-full px-3 py-2 text-left text-sm text-emerald-300 hover:bg-white/10"
                    >
                      More like this
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => submitPlayerRecommendationFeedback('less_like_artist')}
                      className="block w-full px-3 py-2 text-left text-sm text-amber-200 hover:bg-white/10"
                    >
                      Less from this artist
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => submitPlayerRecommendationFeedback('not_for_me')}
                      className="block w-full px-3 py-2 text-left text-sm text-red-300 hover:bg-white/10"
                    >
                      Don’t recommend this track
                    </button>
                  </div>
                  )}
                </div>
              )}
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

    </>
  );
}

function NavItem(props: { 
  icon: React.ReactNode; 
  label: string; 
  active: boolean; 
  onClick: () => void;
  mobile?: boolean;
  badge?: number;
}) {
  if (props.mobile) {
    return (
      <button
        onClick={props.onClick}
        className={`flex flex-col items-center gap-1 py-2 px-4 transition ${
          props.active ? 'text-white' : 'text-white/50 hover:text-white/80'
        }`}
      >
        <div className={`relative ${props.active ? 'text-cyan-500' : ''}`}>
          {props.icon}
          {!!props.badge && <span className="absolute -right-2 -top-1 h-4 min-w-4 rounded-full bg-red-500 px-1 text-[9px] font-bold leading-4 text-white">{props.badge > 99 ? '99+' : props.badge}</span>}
        </div>
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
      <span className="flex-1 text-left font-medium">{props.label}</span>
      {!!props.badge && <span className="min-w-5 rounded-full bg-red-500 px-1.5 py-0.5 text-center text-[10px] font-bold text-white">{props.badge > 99 ? '99+' : props.badge}</span>}
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
  hasAudiobookPlayer: boolean;
  missingMusicEnabled: boolean;
  socialBadge: number;
}) {
  const sidebarRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const touchStartedInsideRef = useRef(false);
  useBodyScrollLock(props.isOpen);

  useEffect(() => {
    if (props.isOpen) closeButtonRef.current?.focus();
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.isOpen, props.onClose]);

  const handleNavClick = (t: string) => {
    props.setTab(t);
    props.onClose();
  };

  // Calculate bottom position based on player state
  // Music player bar: ~72px on mobile, ~80px on desktop
  // Use 72px as it needs to just clear the player bar
  const getBottomClass = () => {
    const playerCount = [props.hasMusicPlayer, props.hasPodcastPlayer, props.hasAudiobookPlayer].filter(Boolean).length;
    if (playerCount >= 2) {
      return 'bottom-36';
    } else if (playerCount === 1) {
      return 'bottom-[72px]';
    }
    return 'bottom-0';
  };

  return (
    <>
      {/* Overlay */}
      <div 
        className={`lg:hidden fixed inset-0 bg-black/60 z-40 transition-opacity duration-300 ${props.isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        onClick={props.onClose}
        aria-hidden="true"
      />
      
      {/* Sidebar */}
      <aside 
        id="mobile-navigation"
        ref={sidebarRef}
        className={`lg:hidden fixed left-0 top-0 ${getBottomClass()} w-64 bg-zinc-900/95 backdrop-blur-xl border-r border-white/10 z-50 transform transition-transform duration-300 ease-out ${props.isOpen ? 'translate-x-0' : '-translate-x-full'}`}
        aria-hidden={!props.isOpen}
        inert={!props.isOpen}
        role="dialog"
        aria-modal={props.isOpen ? 'true' : undefined}
        aria-label="Navigation menu"
      >
        <div className="flex flex-col h-full p-3 overflow-y-auto overscroll-contain touch-pan-y">
          {/* Logo */}
          <div className="flex items-center justify-between gap-3 px-3 py-2 mb-2">
            <img src="/logo.png" alt="mvbar" className="h-8 w-auto" />
            <button
              ref={closeButtonRef}
              type="button"
              onClick={props.onClose}
              className="rounded-lg p-2 text-white/60 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
              aria-label="Close menu"
              title="Close menu"
            >
              <Icons.Close />
            </button>
          </div>

          <nav className="flex flex-col gap-0.5">
            <NavItem icon={<Icons.Home />} label="For You" active={props.tab === 'for-you'} onClick={() => handleNavClick('for-you')} />
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
            <NavItem icon={<Icons.Social />} label="Friends & Sharing" active={props.tab === 'social'} onClick={() => handleNavClick('social')} badge={props.socialBadge} />
            <NavItem icon={<Icons.Clock />} label="History" active={props.tab === 'history'} onClick={() => handleNavClick('history')} />
            <NavItem icon={<Icons.Podcast />} label="Podcasts" active={props.tab === 'podcasts'} onClick={() => handleNavClick('podcasts')} />
            <NavItem icon={<Icons.Audiobook />} label="Audiobooks" active={props.tab === 'audiobooks'} onClick={() => handleNavClick('audiobooks')} />
            {props.missingMusicEnabled && <NavItem icon={<Icons.Search />} label="Missing Music" active={props.tab === 'missing-music'} onClick={() => handleNavClick('missing-music')} />}
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

function Sidebar(props: { tab: string; setTab: (t: string) => void; isAdmin: boolean; missingMusicEnabled: boolean; socialBadge: number; user: { email: string; role: string; avatar_path?: string | null } | null; onLogout: () => void }) {
  return (
    <aside className="hidden lg:flex flex-col w-64 h-screen fixed left-0 top-0 bg-black/50 border-r border-white/10 p-4">
      {/* Logo */}
      <div className="flex items-center gap-3 px-3 py-4 mb-4">
        <img src="/logo.png" alt="mvbar" className="h-12 w-auto" />
      </div>

      <nav className="flex flex-col gap-1">
        <NavItem icon={<Icons.Home />} label="For You" active={props.tab === 'for-you'} onClick={() => props.setTab('for-you')} />
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
        <NavItem icon={<Icons.Social />} label="Friends & Sharing" active={props.tab === 'social'} onClick={() => props.setTab('social')} badge={props.socialBadge} />
        <NavItem icon={<Icons.Clock />} label="History" active={props.tab === 'history'} onClick={() => props.setTab('history')} />
        <NavItem icon={<Icons.Podcast />} label="Podcasts" active={props.tab === 'podcasts'} onClick={() => props.setTab('podcasts')} />
        <NavItem icon={<Icons.Audiobook />} label="Audiobooks" active={props.tab === 'audiobooks'} onClick={() => props.setTab('audiobooks')} />
        {props.missingMusicEnabled && <NavItem icon={<Icons.Search />} label="Missing Music" active={props.tab === 'missing-music'} onClick={() => props.setTab('missing-music')} />}
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
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchShortcutLabel, setSearchShortcutLabel] = useState('Ctrl+K');
  const [trackToShare, setTrackToShare] = useState<QueueTrack | null>(null);
  const [missingMusicEnabled, setMissingMusicEnabled] = useState(false);
  const { queue, index, isOpen, playTrackNow, playIndex, addToQueue, addManyToQueue, removeFromQueue, reorderQueue, clearQueue, next, prev, close, setQueueAndPlay, reset: resetPlayer } = usePlayer();
  const nowPlaying = isOpen ? queue[index] ?? null : null;

  const token = useAuth((s) => s.token);
  const user = useAuth((s) => s.user);
  const clearAuth = useAuth((s) => s.clear);
  const showRecommendationToast = useToastStore((s) => s.show);
  const isAdmin = user?.role === 'admin';
  const pluginUpdate = usePluginUpdates((state) => state.lastUpdate);
  const unreadShares = useSocialUpdates((state) => state.unreadShares);
  const incomingRequests = useSocialUpdates((state) => state.incomingRequests);
  const refreshSocial = useSocialUpdates((state) => state.refresh);
  const socialBadge = unreadShares + incomingRequests;

  useEffect(() => {
    if (!token) {
      setMissingMusicEnabled(false);
      return;
    }
    void apiFetch('/plugins/missing-music/status', {}, token)
      .then((result: any) => setMissingMusicEnabled(Boolean(result.enabled)))
      .catch(() => setMissingMusicEnabled(false));
  }, [token, pluginUpdate]);

  // Podcast player state
  const podcastEpisode = useUi((s) => s.podcastEpisode);

  // Audiobook player state
  const audiobookChapter = useUi((s) => s.audiobookChapter);

  // User preferences
  const preferences = usePreferences((s) => s.preferences);
  const loadPreferences = usePreferences((s) => s.load);

  // Initialize WebSocket connection for live updates
  useWebSocket(isAdmin);

  // Admin: pending users badge
  const pendingCount = useAdminPending((s) => s.count);
  const refreshPending = useAdminPending((s) => s.refresh);
  const requestGotoUsers = useAdminPending((s) => s.requestGotoUsers);
  useEffect(() => {
    if (isAdmin && token) refreshPending(token);
  }, [isAdmin, token, refreshPending]);

  // Load preferences on mount
  useEffect(() => {
    if (token) loadPreferences(token);
  }, [token, loadPreferences]);

  useEffect(() => {
    void refreshSocial(token);
  }, [token, refreshSocial]);

  useEffect(() => {
    if (token) void preparePushNotifications(token).catch(() => undefined);
  }, [token]);

  const handleSignOut = async () => {
    try { await unsubscribeCurrentPushDevice(token); } catch {}
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
      case 'search': setSearchOpen(true); break;
      case 'recently-added':
      case 'library': navigate({ type: 'recently-added' }); break;
      case 'browse': navigate({ type: 'browse' }); break;
      case 'playlists': navigate({ type: 'playlists' }); break;
      case 'favorites': navigate({ type: 'favorites' }); break;
      case 'social': navigate({ type: 'social' }); break;
      case 'history': navigate({ type: 'history' }); break;
      case 'podcasts': navigate({ type: 'podcasts' }); break;
      case 'audiobooks': navigate({ type: 'audiobooks' }); break;
      case 'missing-music': navigate({ type: 'missing-music' }); break;
      case 'settings': navigate({ type: 'settings' }); break;
      case 'admin': navigate({ type: 'admin' }); break;
      default: navigate({ type: 'for-you' });
    }
  }, [navigate]);

  useEffect(() => { initRouter(); }, []);

  const handleBellClick = useCallback(() => {
    requestGotoUsers();
    navigate({ type: 'admin' });
  }, [navigate, requestGotoUsers]);

  // Global Ctrl+K / Cmd+K keyboard shortcut for search
  useEffect(() => {
    const isApplePlatform = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
    setSearchShortcutLabel(isApplePlatform ? '⌘K' : 'Ctrl+K');
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  // Handle legacy #/search route — open modal and redirect
  useEffect(() => {
    if (route.type === 'search') {
      setSearchOpen(true);
      navigate({ type: 'for-you' }, true);
    }
  }, [route.type, navigate]);

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
  
  // Keep favLastChange in scope to trigger re-renders on favorite changes
  void favLastChange;
  
  const [showPlaylistModal, setShowPlaylistModal] = useState(false);
  const [playlists, setPlaylists] = useState<{ id: number; name: string; ownerEmail?: string; isOwner: boolean }[]>([]);
  useBodyScrollLock(showPlaylistModal);
  
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
      setPlaylists(data.playlists?.map(p => ({
        id: parseInt(p.id),
        name: p.name,
        ownerEmail: p.owner?.email,
        isOwner: p.is_owner,
      })) ?? []);
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
    void p;
    next();
  };

  const handlePlaybackStopped = (playback: {
    trackId: number;
    currentTime: number;
    duration: number;
    listenedMs: number;
    completed: boolean;
    slateId?: string;
    bucketKey?: string;
  }) => {
    if (!token || playback.completed || playback.listenedMs < 1000) return;
    const completionPct = playback.duration > 0
      ? Math.max(0, Math.min(1, playback.currentTime / playback.duration))
      : 0;
    const signal = {
      currentMs: Math.round(playback.currentTime * 1000),
      durationMs: Math.round(playback.duration * 1000),
      listenedMs: playback.listenedMs,
      completionPct,
      slateId: playback.slateId,
      bucketKey: playback.bucketKey,
    };
    const request = completionPct < SKIP_THRESHOLD_PCT
      ? recordSkip(token, playback.trackId, completionPct, signal)
      : recordPartialListen(token, playback.trackId, signal);
    request.catch((e: any) => { if (e?.status === 401) clearAuth(); });
  };

  const submitRecommendationFeedback = async (action: RecommendationFeedbackAction) => {
    if (!token || !nowPlaying?.recommendation_bucket_key) return;
    try {
      await sendRecommendationFeedback(token, {
        action,
        trackId: nowPlaying.id,
        artist: nowPlaying.artist,
        bucketKey: nowPlaying.recommendation_bucket_key,
      });
      const messages: Record<RecommendationFeedbackAction, string> = {
        more_like_this: 'We’ll use more music like this',
        not_for_me: 'This track will not be recommended again',
        less_like_artist: `We’ll play less from ${nowPlaying.artist || 'this artist'}`,
        hide_bucket: 'This mix has been hidden',
      };
      showRecommendationToast(messages[action], 'success');
      if (action === 'not_for_me') next();
    } catch (feedbackError: any) {
      if (feedbackError?.status === 401) clearAuth();
      showRecommendationToast('Could not save recommendation feedback', 'error');
    }
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
          // Add the recommendations as one operation so the user gets one
          // compact summary notification instead of one toast per track.
          addManyToQueue(similarTracks);
        }
        fetchingMoreRef.current = false;
      }).catch(() => {
        fetchingMoreRef.current = false;
      });
    }
  }, [index, queue, preferences.auto_continue, nowPlaying, fetchSimilarTracks, addManyToQueue]);

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
      <audio
        id={MUSIC_AUDIO_ELEMENT_ID}
        preload="auto"
        aria-hidden="true"
      />
      
      {/* Sidebar - Desktop */}
      <Sidebar tab={tab} setTab={setTab} isAdmin={isAdmin} missingMusicEnabled={missingMusicEnabled} socialBadge={socialBadge} user={user} onLogout={handleSignOut} />
      
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
        hasAudiobookPlayer={!!audiobookChapter}
        missingMusicEnabled={missingMusicEnabled}
        socialBadge={socialBadge}
      />

      {/* Sticky Mobile Header */}
      <header className="lg:hidden fixed top-0 left-0 right-0 z-30 bg-zinc-900/95 backdrop-blur-xl border-b border-white/10">
        <div className="flex items-center px-4 py-3">
          <button
            onClick={() => setMobileSidebarOpen((open) => !open)}
            className="p-2 -ml-2 mr-2 rounded-lg hover:bg-white/10 transition-colors"
            aria-label={mobileSidebarOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={mobileSidebarOpen}
            aria-controls="mobile-navigation"
          >
            <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <h2 className="text-xl font-bold flex-1">
            {tab === 'for-you' && 'For You'}
            {tab === 'browse' && 'Browse'}
            {tab === 'library' && 'Recently Added'}
            {(tab === 'recently-added') && 'Recently Added'}
            {tab === 'playlists' && 'Playlists'}
            {tab === 'favorites' && 'Favorites'}
            {tab === 'social' && 'Friends & Sharing'}
            {tab === 'history' && 'Recently Played'}
            {tab === 'podcasts' && 'Podcasts'}
            {tab === 'audiobooks' && 'Audiobooks'}
            {tab === 'missing-music' && 'Missing Music'}
            {tab === 'settings' && 'Settings'}
            {tab === 'admin' && 'Admin'}
          </h2>
          <button
            onClick={() => setSearchOpen(true)}
            className="p-2 -mr-2 rounded-lg hover:bg-white/10 transition-colors"
            aria-label="Search"
          >
            <svg className="w-5 h-5 text-white/70" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </button>
          {isAdmin && (
            <button
              onClick={handleBellClick}
              className="relative p-2 rounded-lg hover:bg-white/10 transition-colors"
              aria-label={`Pending approvals${pendingCount ? ` (${pendingCount})` : ''}`}
              title={pendingCount ? `${pendingCount} user${pendingCount === 1 ? '' : 's'} pending approval` : 'No pending approvals'}
            >
              <svg className="w-5 h-5 text-white/70" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0a3 3 0 11-6 0" />
              </svg>
              {pendingCount > 0 && (
                <span className="absolute top-1 right-1 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">
                  {pendingCount > 99 ? '99+' : pendingCount}
                </span>
              )}
            </button>
          )}
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
                {tab === 'browse' && 'Browse'}
                {(tab === 'library' || tab === 'recently-added') && 'Recently Added'}
                {tab === 'playlists' && 'Playlists'}
                {tab === 'favorites' && 'Favorites'}
                {tab === 'social' && 'Friends & Sharing'}
                {tab === 'history' && 'Recently Played'}
                {tab === 'podcasts' && 'Podcasts'}
                {tab === 'audiobooks' && 'Audiobooks'}
                {tab === 'missing-music' && 'Missing Music'}
                {tab === 'settings' && 'Settings'}
                {tab === 'admin' && 'Admin'}
              </h2>
            </div>
            <div className="flex items-center gap-3">
              {isAdmin && (
                <button
                  onClick={handleBellClick}
                  className="relative p-2.5 bg-white/5 hover:bg-white/10 border border-white/10 hover:border-white/20 rounded-xl text-slate-400 hover:text-white transition-all"
                  aria-label={`Pending approvals${pendingCount ? ` (${pendingCount})` : ''}`}
                  title={pendingCount ? `${pendingCount} user${pendingCount === 1 ? '' : 's'} pending approval` : 'No pending approvals'}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0a3 3 0 11-6 0" />
                  </svg>
                  {pendingCount > 0 && (
                    <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center ring-2 ring-slate-900">
                      {pendingCount > 99 ? '99+' : pendingCount}
                    </span>
                  )}
                </button>
              )}
              <button
                onClick={() => setSearchOpen(true)}
                className="flex items-center gap-3 px-4 py-2.5 bg-white/5 hover:bg-white/10 border border-white/10 hover:border-white/20 rounded-xl text-slate-400 hover:text-white transition-all w-72 group"
              >
                <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <span className="flex-1 text-left text-sm">Search...</span>
                <kbd className="text-[11px] bg-white/10 group-hover:bg-white/15 px-1.5 py-0.5 rounded font-mono border border-white/10">{searchShortcutLabel}</kbd>
              </button>
            </div>
          </header>

          {/* Content Area */}
          <section className="animate-fade-in">
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
                onPlayTrack={(tracks, index) => setQueueAndPlay(tracks, index)}
                onPlayAll={(tracks) => setQueueAndPlay(tracks, 0)}
              />
            )}

            {tab === 'favorites' && (
              <Favorites
                onPlay={(t) => playTrackNow({ id: t.id, title: t.title, artist: t.artist })}
                onAddToQueue={(t) => addToQueue({ id: t.id, title: t.title, artist: t.artist })}
              />
            )}

            {tab === 'social' && <Social />}

            {tab === 'history' && (
              <History
                onPlay={(t) => playTrackNow({ id: t.id, title: t.title, artist: t.artist })}
                onAddToQueue={(t) => addToQueue({ id: t.id, title: t.title, artist: t.artist })}
              />
            )}

            {tab === 'podcasts' && <Podcasts />}

            {tab === 'audiobooks' && <Audiobooks />}

            {tab === 'missing-music' && missingMusicEnabled && <MissingMusic />}

            {tab === 'missing-music' && !missingMusicEnabled && (
              <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-8 text-center text-white/50">
                Missing Music is not installed and enabled.
              </div>
            )}

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
          activeTab={tab}
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
          onShare={() => setTrackToShare(nowPlaying)}
          showLyrics={showLyrics}
          onToggleLyrics={() => setShowLyrics((v) => !v)}
          onRecommendationFeedback={nowPlaying.recommendation_bucket_key ? submitRecommendationFeedback : undefined}
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
            recordPlay(token, nowPlaying.id, {
              currentMs: Math.round(p.currentTime * 1000),
              durationMs: Math.round(p.duration * 1000),
              listenedMs: p.listenedMs,
              completionPct: pct,
              slateId: nowPlaying.recommendation_slate_id,
              bucketKey: nowPlaying.recommendation_bucket_key,
            }).catch((e: any) => { if (e?.status === 401) clearAuth(); });
            // Scrobble to ListenBrainz
            scrobbleToListenBrainz(token, nowPlaying.id).catch(() => {});
          }}
          onPlaybackStopped={handlePlaybackStopped}
          onClose={close}
          onEnded={handlePlayModeEnded}
          onPlayModeEnded={handlePlayModeEnded}
        />
      )}

      <ShareTrackDialog track={trackToShare} onClose={() => setTrackToShare(null)} />

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
                    <span className="block truncate">{pl.name}</span>
                    {!pl.isOwner && <span className="block truncate text-xs text-white/45">Shared by {pl.ownerEmail || 'a friend'}</span>}
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

      {/* Search Modal */}
      <SearchModal
        isOpen={searchOpen}
        onClose={() => setSearchOpen(false)}
        onPlay={(t) => playTrackNow({ id: t.id, title: t.title, artist: t.artist })}
        onAddToQueue={(t) => addToQueue({ id: t.id, title: t.title, artist: t.artist })}
      />

      <ToastContainer />
      <ConfirmModal />

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

      {/* Global Audiobook Player - persists across tab changes */}
      <GlobalAudiobookPlayer />
    </div>
  );
}

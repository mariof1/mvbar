'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import Hls from 'hls.js';
import { AutoLogin } from './AutoLogin';
import { LoginForm } from './LoginForm';
import { SearchModal } from './SearchModal';
import { ToastContainer } from './Toast';
import { ConfirmModal } from './ConfirmModal';
import { Playlists } from './Playlists';
import { BrowseNew } from './BrowseNew';
import { Favorites } from './Favorites';
import { History } from './History';
import { Recommendations } from './Recommendations';
import { Podcasts, PodcastPlayer } from './Podcasts';
import { Audiobooks, AudiobookPlayer } from './Audiobooks';
import { Settings } from './Settings';
import { RecentlyAdded } from './RecentlyAdded';
import { Admin } from './Admin';
import { useAuth } from './store';
import { useFavorites } from './favoritesStore';
import { usePlayer, type QueueTrack } from './playerStore';
import { useUi } from './uiStore';
import { useRouter, useRoute, initRouter, getTabFromRoute } from './router';
import { usePreferences } from './preferencesStore';
import { getHlsStatus, logout, recordPlay, recordSkip, requestHlsTranscode, scrobbleToListenBrainz, nowPlayingListenBrainz, listPlaylists, addTrackToPlaylist, apiFetch } from './apiClient';
import { useWebSocket } from './useWebSocket';

type PlayMode = 'normal' | 'repeat' | 'repeat-one' | 'shuffle';

// ────────────────────────────────────────────────────────────
// Norton Commander Shell — authentic dual-panel retro layout
// ────────────────────────────────────────────────────────────

const NC_TABS = [
  { id: 'for-you', label: 'ForYou' },
  { id: 'browse', label: 'Browse' },
  { id: 'playlists', label: 'Plists' },
  { id: 'favorites', label: 'Favs' },
  { id: 'history', label: 'History' },
  { id: 'podcasts', label: 'Podcst' },
  { id: 'audiobooks', label: 'ABooks' },
  { id: 'settings', label: 'Setup' },
] as const;

const NC_ADMIN_TAB = { id: 'admin', label: 'Admin' };

function fmt(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

// ─── Right-panel Player ─────────────────────────────────────
function NCPlayer(props: {
  nowPlaying: QueueTrack | null;
  queue: QueueTrack[];
  queueIndex: number;
  token: string | null;
  playMode: PlayMode;
  onPlayModeChange: (m: PlayMode) => void;
  isFavorite: boolean;
  onToggleFavorite: () => void;
  onPrev: () => void;
  onNext: (p?: { currentTime: number; duration: number }) => void;
  onPlayed: (p: { currentTime: number; duration: number }) => void;
  onClose: () => void;
  onEnded: () => void;
  onPlayQueueItem: (i: number) => void;
  onRemoveFromQueue: (i: number) => void;
  onClearQueue: () => void;
  preferHls: boolean;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const playedSentRef = useRef(false);
  const PLAYED_PCT = 0.8;

  const { nowPlaying, token, preferHls } = props;

  // Reset on track change
  useEffect(() => {
    playedSentRef.current = false;
    setCurrentTime(0);
    setDuration(0);
  }, [nowPlaying?.id]);

  // Load audio source
  useEffect(() => {
    if (!nowPlaying || !token) return;
    const audio = audioRef.current;
    if (!audio) return;

    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }

    const tryHls = async () => {
      if (!preferHls) { loadDirect(); return; }
      try {
        const st = await getHlsStatus(token, nowPlaying.id);
        if (st.state === 'done' && st.manifestUrl) {
          loadHlsUrl(st.manifestUrl);
        } else if (st.state === 'missing') {
          requestHlsTranscode(token, nowPlaying.id).catch(() => {});
          loadDirect();
        } else {
          loadDirect();
        }
      } catch { loadDirect(); }
    };

    const loadDirect = () => {
      audio.src = `/api/stream/${nowPlaying.id}?token=${token}`;
      audio.load();
      audio.play().catch(() => {});
    };

    const loadHlsUrl = (url: string) => {
      if (Hls.isSupported()) {
        const hls = new Hls({ xhrSetup: (xhr) => { xhr.setRequestHeader('Authorization', `Bearer ${token}`); } });
        hls.loadSource(url);
        hls.attachMedia(audio);
        hls.on(Hls.Events.MANIFEST_PARSED, () => { audio.play().catch(() => {}); });
        hls.on(Hls.Events.ERROR, (_, data) => { if (data.fatal) { hls.destroy(); loadDirect(); } });
        hlsRef.current = hls;
      } else if (audio.canPlayType('application/vnd.apple.mpegurl')) {
        audio.src = url;
        audio.play().catch(() => {});
      } else { loadDirect(); }
    };

    tryHls();

    // Notify ListenBrainz
    nowPlayingListenBrainz(token, nowPlaying.id).catch(() => {});

    return () => { if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; } };
  }, [nowPlaying?.id, token, preferHls]);

  // Audio events
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onTime = () => {
      setCurrentTime(a.currentTime);
      setDuration(a.duration || 0);
      if (!playedSentRef.current && a.duration > 0 && a.currentTime / a.duration >= PLAYED_PCT) {
        playedSentRef.current = true;
        props.onPlayed({ currentTime: a.currentTime, duration: a.duration });
      }
    };
    const onEnded = () => props.onEnded();
    a.addEventListener('play', onPlay);
    a.addEventListener('pause', onPause);
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('ended', onEnded);
    return () => { a.removeEventListener('play', onPlay); a.removeEventListener('pause', onPause); a.removeEventListener('timeupdate', onTime); a.removeEventListener('ended', onEnded); };
  }, [props.onEnded, props.onPlayed]);

  const togglePlay = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) a.play().catch(() => {}); else a.pause();
  };

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const a = audioRef.current;
    if (!a || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    a.currentTime = pct * duration;
  };

  const cycleMode = () => {
    const modes: PlayMode[] = ['normal', 'repeat', 'repeat-one', 'shuffle'];
    const i = modes.indexOf(props.playMode);
    props.onPlayModeChange(modes[(i + 1) % modes.length]);
  };

  const modeLabel: Record<PlayMode, string> = { normal: '───', repeat: 'RPT', 'repeat-one': 'RP1', shuffle: 'SHF' };
  const pct = duration > 0 ? (currentTime / duration) * 100 : 0;
  const volPct = Math.round(volume * 100);

  // Expose togglePlay for parent F-key bar
  useEffect(() => {
    (window as any).__ncTogglePlay = togglePlay;
    (window as any).__ncIsPlaying = () => isPlaying;
    return () => { delete (window as any).__ncTogglePlay; delete (window as any).__ncIsPlaying; };
  });

  return (
    <div className="nc-right-panel flex flex-col h-full">
      <audio ref={audioRef} preload="auto" />

      {/* ── Now Playing ── */}
      {nowPlaying ? (
        <div className="nc-now-playing px-2 pt-2 pb-1">
          <div className="nc-panel-header text-center mb-1">
            ┤ Now Playing ├
          </div>
          <div className="flex items-center gap-2 mb-1">
            <img
              src={`/api/art/${nowPlaying.id}`}
              alt=""
              className="nc-art"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
            />
            <div className="flex-1 min-w-0">
              <div className="nc-track-title truncate">{nowPlaying.title || 'Unknown'}</div>
              <div className="nc-track-artist truncate">{nowPlaying.artist || 'Unknown'}</div>
              {nowPlaying.album && <div className="nc-track-album truncate">{nowPlaying.album}</div>}
            </div>
          </div>

          {/* Progress bar */}
          <div className="nc-progress-row">
            <span className="nc-time">{fmt(currentTime)}</span>
            <div className="nc-progress-bar flex-1 mx-1" onClick={seek}>
              <div className="nc-progress-fill" style={{ width: `${pct}%` }} />
              <div className="nc-progress-cursor" style={{ left: `${pct}%` }} />
            </div>
            <span className="nc-time">{fmt(duration)}</span>
          </div>

          {/* Transport controls */}
          <div className="nc-transport">
            <button onClick={props.onPrev} className="nc-btn" title="Previous">◄◄</button>
            <button onClick={togglePlay} className="nc-btn nc-btn-play" title={isPlaying ? 'Pause' : 'Play'}>
              {isPlaying ? '║║' : ' ► '}
            </button>
            <button onClick={() => props.onNext({ currentTime, duration })} className="nc-btn" title="Next">►►</button>
            <span className="nc-separator">│</span>
            <button onClick={cycleMode} className="nc-btn" title={`Mode: ${props.playMode}`}>{modeLabel[props.playMode]}</button>
            <button onClick={props.onToggleFavorite} className={`nc-btn ${props.isFavorite ? 'nc-active' : ''}`} title="Favorite">
              {props.isFavorite ? '♥' : '♡'}
            </button>
            <span className="nc-separator">│</span>
            <span className="nc-vol" title="Volume">
              Vol:
              <input
                type="range" min="0" max="100" value={volPct}
                onChange={(e) => { const v = Number(e.target.value) / 100; setVolume(v); if (audioRef.current) audioRef.current.volume = v; }}
                className="nc-vol-slider"
              />
              {volPct}%
            </span>
          </div>
        </div>
      ) : (
        <div className="nc-now-playing px-2 pt-2 pb-1">
          <div className="nc-panel-header text-center mb-1">┤ Now Playing ├</div>
          <div className="nc-empty-player">No track loaded. Select from left panel.</div>
        </div>
      )}

      {/* ── Queue ── */}
      <div className="nc-queue flex-1 min-h-0 flex flex-col px-2 pb-1">
        <div className="nc-panel-header flex items-center justify-between mb-1">
          <span>┤ Queue ({props.queue.length}) ├</span>
          {props.queue.length > 0 && (
            <button onClick={props.onClearQueue} className="nc-btn nc-btn-sm" title="Clear queue">CLR</button>
          )}
        </div>
        <div className="nc-queue-list flex-1 overflow-y-auto">
          {props.queue.length === 0 ? (
            <div className="nc-empty-queue">Queue is empty</div>
          ) : (
            props.queue.map((t, i) => (
              <div
                key={`${t.id}-${i}`}
                className={`nc-queue-item ${i === props.queueIndex ? 'nc-queue-active' : ''}`}
                onClick={() => props.onPlayQueueItem(i)}
              >
                <span className="nc-queue-num">{String(i + 1).padStart(2, ' ')}.</span>
                <span className="nc-queue-title truncate flex-1">{t.title || 'Unknown'}</span>
                <span className="nc-queue-artist truncate">{t.artist || ''}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); props.onRemoveFromQueue(i); }}
                  className="nc-btn nc-btn-sm nc-btn-danger"
                  title="Remove"
                >×</button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Global Podcast/Audiobook Player wrappers ───────────────
function NCGlobalPodcastPlayer() {
  const ep = useUi((s) => s.podcastEpisode);
  const setEp = useUi((s) => s.setPodcastEpisode);
  if (!ep) return null;
  return <PodcastPlayer episode={ep} onClose={() => setEp(null)} />;
}

function NCGlobalAudiobookPlayer() {
  const ch = useUi((s) => s.audiobookChapter);
  const setCh = useUi((s) => s.setAudiobookChapter);
  if (!ch) return null;
  return <AudiobookPlayer chapter={ch} onClose={() => setCh(null)} />;
}

// ─── Function Key Bar ───────────────────────────────────────
function FKeyBar(props: {
  onSearch: () => void;
  onToggleFavorite: () => void;
  onLogout: () => void;
  hasFavorite: boolean;
  isFavorite: boolean;
}) {
  const fkeys = [
    { key: 'F1', label: 'Help', action: () => {} },
    { key: 'F2', label: 'Search', action: props.onSearch },
    { key: 'F3', label: 'Play', action: () => { (window as any).__ncTogglePlay?.(); } },
    { key: 'F4', label: 'Mode', action: () => {} },
    { key: 'F5', label: props.isFavorite ? '♥Fav' : 'Fav', action: props.hasFavorite ? props.onToggleFavorite : () => {} },
    { key: 'F6', label: 'Queue', action: () => {} },
    { key: 'F7', label: 'Lyrics', action: () => {} },
    { key: 'F8', label: 'Delete', action: () => {} },
    { key: 'F9', label: 'Theme', action: () => {} },
    { key: 'F10', label: 'Quit', action: props.onLogout },
  ];

  return (
    <div className="nc-fkey-bar">
      {fkeys.map((f) => (
        <button key={f.key} onClick={f.action} className="nc-fkey">
          <span className="nc-fkey-num">{f.key}</span>
          <span className="nc-fkey-label">{f.label}</span>
        </button>
      ))}
    </div>
  );
}

// ─── Main Norton Commander Shell ────────────────────────────
export function NortonShell() {
  const [searchOpen, setSearchOpen] = useState(false);
  const { queue, index, isOpen, playTrackNow, playIndex, addToQueue, removeFromQueue, reorderQueue, clearQueue, next, prev, close, setQueueAndPlay, reset: resetPlayer } = usePlayer();
  const nowPlaying = isOpen ? queue[index] ?? null : null;

  const token = useAuth((s) => s.token);
  const user = useAuth((s) => s.user);
  const clearAuth = useAuth((s) => s.clear);
  const isAdmin = user?.role === 'admin';

  const podcastEpisode = useUi((s) => s.podcastEpisode);
  const audiobookChapter = useUi((s) => s.audiobookChapter);

  const preferences = usePreferences((s) => s.preferences);
  const loadPreferences = usePreferences((s) => s.load);

  useWebSocket(isAdmin);

  useEffect(() => { if (token) loadPreferences(token); }, [token, loadPreferences]);

  const handleSignOut = async () => {
    try { await logout(token ?? undefined); } catch {}
    finally { resetPlayer(); clearAuth(); }
  };

  const lastRecordedRef = useRef<number | null>(null);

  const route = useRoute();
  const navigate = useRouter((s) => s.navigate);
  const tab = getTabFromRoute(route);

  const setTab = useCallback((tabName: string) => {
    switch (tabName) {
      case 'for-you': navigate({ type: 'for-you' }); break;
      case 'search': setSearchOpen(true); break;
      case 'recently-added':
      case 'library': navigate({ type: 'recently-added' }); break;
      case 'browse': navigate({ type: 'browse' }); break;
      case 'playlists': navigate({ type: 'playlists' }); break;
      case 'favorites': navigate({ type: 'favorites' }); break;
      case 'history': navigate({ type: 'history' }); break;
      case 'podcasts': navigate({ type: 'podcasts' }); break;
      case 'audiobooks': navigate({ type: 'audiobooks' }); break;
      case 'settings': navigate({ type: 'settings' }); break;
      case 'admin': navigate({ type: 'admin' }); break;
      default: navigate({ type: 'for-you' });
    }
  }, [navigate]);

  useEffect(() => { initRouter(); }, []);

  // Ctrl+K search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); setSearchOpen((v) => !v); }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  // F-key keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      switch (e.key) {
        case 'F2': e.preventDefault(); setSearchOpen(true); break;
        case 'F3': e.preventDefault(); (window as any).__ncTogglePlay?.(); break;
        case 'F5': e.preventDefault(); if (nowPlaying) toggleFavorite(); break;
        case 'F10': e.preventDefault(); handleSignOut(); break;
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [nowPlaying]);

  // Handle legacy search route
  useEffect(() => {
    if (route.type === 'search') { setSearchOpen(true); navigate({ type: 'for-you' }, true); }
  }, [route.type, navigate]);

  // Play mode
  const [playMode, setPlayMode] = useState<PlayMode>('normal');
  const [shuffledIndices, setShuffledIndices] = useState<number[]>([]);
  const [shuffleIndex, setShuffleIndex] = useState(0);

  // Favorites
  const favIds = useFavorites((s) => s.ids);
  const toggleFav = useFavorites((s) => s.toggle);
  const refreshFavs = useFavorites((s) => s.refresh);
  const isFavorite = nowPlaying ? favIds.has(Number(nowPlaying.id)) : false;

  useEffect(() => { if (token) refreshFavs(token).catch(() => {}); }, [token, refreshFavs]);

  // Shuffle indices
  useEffect(() => {
    if (playMode === 'shuffle' && queue.length > 0) {
      const idx = Array.from({ length: queue.length }, (_, i) => i);
      for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
      setShuffledIndices(idx);
      setShuffleIndex(0);
    }
  }, [playMode, queue.length]);

  const toggleFavorite = async () => { if (token && nowPlaying) { try { await toggleFav(token, Number(nowPlaying.id)); } catch {} } };

  const PLAYED_THRESHOLD_PCT = 0.8;
  const SKIP_THRESHOLD_PCT = 0.25;

  const onNextWithStats = (p?: { currentTime: number; duration: number }) => {
    if (token && nowPlaying?.id && p?.duration && Number.isFinite(p.duration) && p.duration > 0) {
      const pct = Math.max(0, Math.min(1, (p.currentTime ?? 0) / p.duration));
      if (pct < SKIP_THRESHOLD_PCT) recordSkip(token, nowPlaying.id, pct).catch((e: any) => { if (e?.status === 401) clearAuth(); });
    }
    next();
  };

  // Auto-continue
  const fetchingMoreRef = useRef(false);
  const fetchSimilarTracks = useCallback(async (trackId: number, currentQueue: QueueTrack[]) => {
    if (!token) return [];
    try {
      const excludeIds = currentQueue.map(t => t.id).join(',');
      const r = await apiFetch(`/similar-tracks/${trackId}?exclude=${excludeIds}`, { method: 'GET' }, token) as { ok: boolean; tracks: { id: number; title: string; artist: string }[] };
      if (r.ok && r.tracks) return r.tracks.map(t => ({ id: t.id, title: t.title, artist: t.artist, album: null }));
    } catch {}
    return [];
  }, [token]);

  useEffect(() => {
    if (!preferences.auto_continue || !nowPlaying || fetchingMoreRef.current) return;
    const remaining = queue.length - index - 1;
    if (remaining <= 2 && queue.length > 0) {
      fetchingMoreRef.current = true;
      fetchSimilarTracks(queue[queue.length - 1].id, queue).then(tracks => {
        tracks.forEach(t => addToQueue(t));
        fetchingMoreRef.current = false;
      }).catch(() => { fetchingMoreRef.current = false; });
    }
  }, [index, queue, preferences.auto_continue, nowPlaying, fetchSimilarTracks, addToQueue]);

  const handlePlayModeEnded = async () => {
    if (playMode === 'repeat-one') return;
    if (playMode === 'repeat') {
      if (index + 1 >= queue.length) setQueueAndPlay(queue, 0); else next();
      return;
    }
    if (playMode === 'shuffle') {
      const ni = shuffleIndex + 1;
      if (ni >= shuffledIndices.length) {
        const idx = Array.from({ length: queue.length }, (_, i) => i);
        for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
        setShuffledIndices(idx);
        setShuffleIndex(0);
        setQueueAndPlay(queue, idx[0]);
      } else { setShuffleIndex(ni); setQueueAndPlay(queue, shuffledIndices[ni]); }
      return;
    }
    if (index + 1 < queue.length) { next(); }
    else if (preferences.auto_continue && nowPlaying) {
      const similar = await fetchSimilarTracks(nowPlaying.id, queue);
      if (similar.length > 0) setQueueAndPlay([...queue, ...similar], queue.length);
    }
  };

  // ── Login screen ──
  if (!token) {
    return (
      <div className="nc-shell">
        <AutoLogin />
        <div className="nc-login-wrapper">
          <pre className="nc-login-banner">{`
╔══════════════════════════════════════╗
║       M V B A R   C O M M A N D E R ║
║          Music · Video · Bar         ║
╚══════════════════════════════════════╝`}</pre>
          <div className="nc-login-box">
            <LoginForm />
          </div>
        </div>
      </div>
    );
  }

  // ── Main dual-panel layout ──
  const tabLabel = (id: string) => {
    switch (id) {
      case 'for-you': return 'For You';
      case 'browse': return 'Browse';
      case 'playlists': return 'Playlists';
      case 'favorites': return 'Favorites';
      case 'history': return 'History';
      case 'podcasts': return 'Podcasts';
      case 'audiobooks': return 'Audiobooks';
      case 'settings': return 'Settings';
      case 'admin': return 'Admin';
      default: return id;
    }
  };

  const tabs = isAdmin ? [...NC_TABS, NC_ADMIN_TAB] : [...NC_TABS];

  return (
    <div className="nc-shell">
      <AutoLogin />

      {/* ── Top Menu Bar ── */}
      <div className="nc-menubar">
        <span className="nc-menubar-logo">MVBAR</span>
        <span className="nc-menubar-sep">│</span>
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`nc-menu-item ${tab === t.id ? 'nc-menu-active' : ''}`}
          >
            {t.label}
          </button>
        ))}
        <span className="flex-1" />
        <button onClick={() => setSearchOpen(true)} className="nc-menu-item" title="Ctrl+K">🔍Srch</button>
        <span className="nc-menubar-sep">│</span>
        <span className="nc-menubar-user">{user?.email?.split('@')[0] || 'user'}</span>
      </div>

      {/* ── Dual Panels ── */}
      <div className="nc-panels">
        {/* Left Panel — Content Browser */}
        <div className="nc-panel nc-panel-left">
          <div className="nc-panel-titlebar">
            ┤ {tabLabel(tab)} ├
          </div>
          <div className="nc-panel-content">
            {(tab === 'library' || tab === 'recently-added' || tab === 'for-you') && (
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
            {tab === 'audiobooks' && <Audiobooks />}
            {tab === 'settings' && <Settings />}
            {tab === 'admin' && isAdmin && <Admin />}
          </div>
        </div>

        {/* Right Panel — Player & Queue */}
        <div className="nc-panel nc-panel-right">
          <NCPlayer
            nowPlaying={nowPlaying}
            queue={queue}
            queueIndex={index}
            token={token}
            playMode={playMode}
            onPlayModeChange={setPlayMode}
            isFavorite={isFavorite}
            onToggleFavorite={toggleFavorite}
            onPrev={prev}
            onNext={onNextWithStats}
            onPlayed={(p) => {
              if (!token || !nowPlaying) return;
              if (lastRecordedRef.current === nowPlaying.id) return;
              lastRecordedRef.current = nowPlaying.id;
              recordPlay(token, nowPlaying.id).catch((e: any) => { if (e?.status === 401) clearAuth(); });
              scrobbleToListenBrainz(token, nowPlaying.id).catch(() => {});
            }}
            onClose={close}
            onEnded={handlePlayModeEnded}
            onPlayQueueItem={playIndex}
            onRemoveFromQueue={removeFromQueue}
            onClearQueue={clearQueue}
            preferHls={preferences.prefer_hls}
          />
        </div>
      </div>

      {/* ── F-Key Bar ── */}
      <FKeyBar
        onSearch={() => setSearchOpen(true)}
        onToggleFavorite={toggleFavorite}
        onLogout={handleSignOut}
        hasFavorite={!!nowPlaying}
        isFavorite={isFavorite}
      />

      {/* ── Overlays ── */}
      <SearchModal
        isOpen={searchOpen}
        onClose={() => setSearchOpen(false)}
        onPlay={(t) => playTrackNow({ id: t.id, title: t.title, artist: t.artist })}
        onAddToQueue={(t) => addToQueue({ id: t.id, title: t.title, artist: t.artist })}
      />

      <ToastContainer />
      <ConfirmModal />
      <NCGlobalPodcastPlayer />
      <NCGlobalAudiobookPlayer />
    </div>
  );
}

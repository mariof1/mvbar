'use client';

import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { AutoLogin } from './AutoLogin';
import { LoginForm } from './LoginForm';
import { ScanPanel } from './ScanPanel';
import { UserManagementPanel } from './UserManagementPanel';
import { LibraryManagementPanel } from './LibraryManagementPanel';
import { Search } from './Search';
import { Tracks } from './Tracks';
import { Playlists } from './Playlists';
import { BrowseNew } from './BrowseNew';
import { Favorites } from './Favorites';
import { History } from './History';
import { Recommendations } from './Recommendations';
import { Settings } from './Settings';
import { useAuth } from './store';
import { usePlayer, type QueueTrack } from './playerStore';
import { initUiFromStorage, useUi, type Tab } from './uiStore';
import { getHlsStatus, logout, recordPlay, recordSkip, requestHlsTranscode } from './apiClient';

function PlayerBar(props: {
  nowPlaying: QueueTrack;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: (p?: { currentTime: number; duration: number }) => void;
  onPlayed: (p: { currentTime: number; duration: number }) => void;
  onClose: () => void;
  onEnded: () => void;
  token: string | null;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [artOk, setArtOk] = useState(true);
  const playedSentRef = useRef(false);
  const hlsRef = useRef<Hls | null>(null);

  const [preferHls, setPreferHls] = useState(true);
  const [hlsStatus, setHlsStatus] = useState<'off' | 'preparing' | 'ready' | 'error'>('off');

  useEffect(() => {
    setArtOk(true);
    playedSentRef.current = false;
  }, [props.nowPlaying.id]);

  useEffect(() => {
    try {
      const v = localStorage.getItem('mvbar_prefer_hls');
      if (v === null) return;
      setPreferHls(v !== '0');
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;

    let cancelled = false;

    const cleanupHls = () => {
      if (hlsRef.current) {
        try {
          hlsRef.current.destroy();
        } catch {
          // ignore
        }
        hlsRef.current = null;
      }
    };

    const setStream = async () => {
      cleanupHls();
      a.src = `/api/stream/${props.nowPlaying.id}`;
      try {
        await a.play();
      } catch {
        // autoplay may be blocked
      }
    };

    const setHls = async (seekTo?: number) => {
      const id = props.nowPlaying.id;
      const canNative = a.canPlayType('application/vnd.apple.mpegurl');
      if (canNative) {
        cleanupHls();
        a.src = `/api/hls/${id}`;
        if (typeof seekTo === 'number' && seekTo > 0) {
          a.addEventListener(
            'loadedmetadata',
            () => {
              try {
                a.currentTime = seekTo;
              } catch {
                // ignore
              }
            },
            { once: true }
          );
        }
        try {
          await a.play();
        } catch {
          // ignore
        }
        return true;
      }

      if (!Hls.isSupported()) {
        await setStream();
        return false;
      }

      cleanupHls();
      const hls = new Hls({ enableWorker: true });
      hlsRef.current = hls;
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (data?.fatal) {
          setHlsStatus('error');
          setStream();
        }
      });
      hls.loadSource(`/api/hls/${id}`);
      hls.attachMedia(a);
      if (typeof seekTo === 'number' && seekTo > 0) {
        a.addEventListener(
          'loadedmetadata',
          () => {
            try {
              a.currentTime = seekTo;
            } catch {
              // ignore
            }
          },
          { once: true }
        );
      }
      try {
        await a.play();
      } catch {
        // ignore
      }
      return true;
    };

    (async () => {
      if (cancelled) return;
      setHlsStatus(props.token && preferHls ? 'preparing' : 'off');
      await setStream();

      if (!props.token) return;
      if (!preferHls) return;

      try {
        await requestHlsTranscode(props.token, props.nowPlaying.id);

        // If the manifest becomes ready quickly, switch over to HLS.
        for (let i = 0; i < 8 && !cancelled; i++) {
          const s = await getHlsStatus(props.token, props.nowPlaying.id);
          if (s?.ready) {
            const resume = a.currentTime || 0;
            const ok = await setHls(resume);
            setHlsStatus(ok ? 'ready' : 'error');
            break;
          }
          await new Promise((r) => setTimeout(r, 500));
        }
      } catch {
        setHlsStatus('error');
      }
    })();

    return () => {
      cancelled = true;
      cleanupHls();
    };
  }, [props.nowPlaying.id, props.token, preferHls]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || (el as any)?.isContentEditable) return;

      const a = audioRef.current;
      if (!a) return;

      if (e.code === 'Space') {
        e.preventDefault();
        if (a.paused) a.play();
        else a.pause();
        return;
      }
      if (e.key === 'k' || e.key === 'K') {
        return props.onNext({ currentTime: a.currentTime || 0, duration: a.duration || 0 });
      }
      if (e.key === 'j' || e.key === 'J') return props.onPrev();

      if (e.key === 'ArrowLeft') {
        a.currentTime = Math.max(0, a.currentTime - 5);
      }
      if (e.key === 'ArrowRight') {
        a.currentTime = Math.min(a.duration || Infinity, a.currentTime + 5);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [props]);

  return (
    <div style={{ position: 'sticky', top: 0, zIndex: 10, padding: 12, border: '1px solid #333', borderRadius: 10, background: '#0d0d0d' }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', minWidth: 0 }}>
          {artOk ? (
            <img
              key={props.nowPlaying.id}
              src={`/api/art/${props.nowPlaying.id}`}
              alt=""
              width={48}
              height={48}
              onError={() => setArtOk(false)}
              style={{ borderRadius: 6, objectFit: 'cover', border: '1px solid #222' }}
            />
          ) : null}
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700 }}>Now playing</div>
            <div style={{ opacity: 0.85, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {props.nowPlaying.title ?? `Track #${props.nowPlaying.id}`}
              {props.nowPlaying.artist ? ` — ${props.nowPlaying.artist}` : ''}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, opacity: 0.85, userSelect: 'none' }}>
            <input
              type="checkbox"
              checked={preferHls}
              onChange={(e) => {
                const v = e.target.checked;
                setPreferHls(v);
                try {
                  localStorage.setItem('mvbar_prefer_hls', v ? '1' : '0');
                } catch {
                  // ignore
                }
              }}
            />
            Prefer HLS
          </label>
          <div style={{ fontSize: 12, opacity: 0.75 }}>
            {preferHls ? (hlsStatus === 'ready' ? 'HLS ready' : hlsStatus === 'preparing' ? 'HLS preparing…' : hlsStatus === 'error' ? 'HLS error' : '') : 'HLS off'}
          </div>
          <button onClick={props.onPrev} disabled={!props.hasPrev} style={{ padding: '6px 10px', opacity: props.hasPrev ? 1 : 0.5 }}>
            Prev
          </button>
          <button
            onClick={() => props.onNext({ currentTime: audioRef.current?.currentTime || 0, duration: audioRef.current?.duration || 0 })}
            disabled={!props.hasNext}
            style={{ padding: '6px 10px', opacity: props.hasNext ? 1 : 0.5 }}
          >
            Next
          </button>
          <button onClick={props.onClose} style={{ padding: '6px 10px', opacity: 0.85 }}>
            Close
          </button>
        </div>
      </div>
      <audio
        ref={audioRef}
        key={props.nowPlaying.id}
        controls
        autoPlay
        style={{ width: '100%', marginTop: 10 }}
        onTimeUpdate={() => {
          const a = audioRef.current;
          if (!a) return;
          if (playedSentRef.current) return;
          const d = a.duration || 0;
          if (!Number.isFinite(d) || d <= 0) return;
          const p = (a.currentTime || 0) / d;
          if (p >= 0.8) {
            playedSentRef.current = true;
            props.onPlayed({ currentTime: a.currentTime || 0, duration: d });
          }
        }}
        onEnded={props.onEnded}
      />
      <div style={{ opacity: 0.7, fontSize: 12, marginTop: 6 }}>
        Shortcuts: Space play/pause • J/K prev/next • ←/→ seek
      </div>
    </div>
  );
}

function LyricsPanel(props: { trackId: number }) {
  const token = useAuth((s) => s.token);
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    setText(null);
    fetch(`/api/lyrics/${props.trackId}`, { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) return null;
        return await r.text();
      })
      .then((t) => setText(t))
      .catch(() => setText(null));
  }, [props.trackId, token]);

  if (!token) return null;
  if (!text) return null;

  return (
    <details style={{ marginBottom: 14, padding: 10, border: '1px solid #333', borderRadius: 10, background: '#0d0d0d' }}>
      <summary style={{ cursor: 'pointer', fontWeight: 700 }}>Lyrics</summary>
      <pre style={{ whiteSpace: 'pre-wrap', margin: 0, marginTop: 10, fontSize: 13, opacity: 0.9 }}>{text}</pre>
    </details>
  );
}

function TabButton(props: { label: string; tab: Tab; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={props.onClick}
      style={{
        padding: '8px 10px',
        borderRadius: 10,
        border: '1px solid #333',
        background: props.active ? '#1a1a1a' : 'transparent',
        color: '#eee',
        opacity: props.active ? 1 : 0.85
      }}
    >
      {props.label}
    </button>
  );
}

export function AppShell() {
  const [refreshNonce, setRefreshNonce] = useState(0);
  const { queue, index, isOpen, playTrackNow, addToQueue, next, prev, close, setQueueAndPlay } = usePlayer();
  const nowPlaying = isOpen ? queue[index] ?? null : null;

  const token = useAuth((s) => s.token);
  const user = useAuth((s) => s.user);
  const clearAuth = useAuth((s) => s.clear);

  const handleSignOut = async () => {
    try {
      await logout(token ?? undefined);
    } catch {
      // ignore
    } finally {
      clearAuth();
    }
  };

  const lastRecordedRef = useRef<number | null>(null);

  const tab = useUi((s) => s.tab);
  const setTab = useUi((s) => s.setTab);

  useEffect(() => {
    initUiFromStorage();
  }, []);


  const isAdmin = user?.role === 'admin';

  const PLAYED_THRESHOLD_PCT = 0.8;
  const SKIP_THRESHOLD_PCT = 0.25;

  const onNextWithStats = (p?: { currentTime: number; duration: number }) => {
    if (token && nowPlaying?.id && p?.duration && Number.isFinite(p.duration) && p.duration > 0) {
      const pct = Math.max(0, Math.min(1, (p.currentTime ?? 0) / p.duration));
      if (pct < SKIP_THRESHOLD_PCT) {
        recordSkip(token, nowPlaying.id, pct).catch((e: any) => {
          if (e?.status === 401) clearAuth();
        });
      }
    }
    next();
  };

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui', color: '#eee', background: '#111', minHeight: '100vh' }}>
      <AutoLogin />

      <header style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ display: 'grid', gap: 2 }}>
          <h1 style={{ margin: 0 }}>mvbar</h1>
          <div style={{ opacity: 0.75, fontSize: 12 }}>Self-hosted music player</div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {token && user ? (
            <div style={{ opacity: 0.8, fontSize: 13, textAlign: 'right' }}>
              <div style={{ fontWeight: 700 }}>{user.email}</div>
              <div style={{ opacity: 0.75 }}>{user.role}</div>
            </div>
          ) : (
            <div style={{ opacity: 0.8, fontSize: 13 }}>Not signed in</div>
          )}
          {token ? (
            <button onClick={handleSignOut} style={{ padding: '8px 10px', opacity: 0.9 }}>
              Sign out
            </button>
          ) : null}
        </div>
      </header>

      {isOpen && nowPlaying ? (
        <PlayerBar
          nowPlaying={nowPlaying}
          hasPrev={index > 0}
          hasNext={index + 1 < queue.length}
          onPrev={prev}
          onNext={onNextWithStats}
          token={token}
          onPlayed={(p) => {
            if (!token) return;
            if (lastRecordedRef.current === nowPlaying.id) return;
            const pct = p.duration > 0 ? p.currentTime / p.duration : 0;
            if (pct < PLAYED_THRESHOLD_PCT) return;
            lastRecordedRef.current = nowPlaying.id;
            recordPlay(token, nowPlaying.id).catch((e: any) => {
              if (e?.status === 401) clearAuth();
            });
          }}
          onClose={close}
          onEnded={next}
        />
      ) : null}

      {!token ? (
        <div style={{ maxWidth: 520 }}>
          <LoginForm />
        </div>
      ) : (
        <>
          <nav style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14, marginBottom: 14 }}>
            <TabButton label="For You" tab="for-you" active={tab === 'for-you'} onClick={() => setTab('for-you')} />
            <TabButton label="Search" tab="search" active={tab === 'search'} onClick={() => setTab('search')} />
            <TabButton label="Library" tab="library" active={tab === 'library'} onClick={() => setTab('library')} />
            <TabButton label="Browse" tab="browse" active={tab === 'browse'} onClick={() => setTab('browse')} />
            <TabButton label="Playlists" tab="playlists" active={tab === 'playlists'} onClick={() => setTab('playlists')} />
            <TabButton label="Favorites" tab="favorites" active={tab === 'favorites'} onClick={() => setTab('favorites')} />
            <TabButton label="History" tab="history" active={tab === 'history'} onClick={() => setTab('history')} />
            <TabButton label="Settings" tab="settings" active={tab === 'settings'} onClick={() => setTab('settings')} />
            {isAdmin ? <TabButton label="Admin" tab="admin" active={tab === 'admin'} onClick={() => setTab('admin')} /> : null}
          </nav>

          <section style={{ maxWidth: 980 }}>
            {nowPlaying ? <LyricsPanel trackId={nowPlaying.id} /> : null}

            {tab === 'search' ? (
              <Search
                onPlay={(t) => playTrackNow({ id: t.id, title: t.title, artist: t.artist })}
                onAddToQueue={(t) => addToQueue({ id: t.id, title: t.title, artist: t.artist })}
              />
            ) : null}

            {tab === 'library' ? (
              <Tracks
                refreshNonce={refreshNonce}
                onPlay={(t) => playTrackNow({ id: t.id, title: t.title, artist: t.artist })}
                onAddToQueue={(t) => addToQueue({ id: t.id, title: t.title, artist: t.artist })}
              />
            ) : null}

            {tab === 'browse' ? (
              <BrowseNew
                onPlayTrack={(t) => playTrackNow({ id: t.id, title: t.title, artist: t.artist })}
                onAddToQueue={(t) => addToQueue({ id: t.id, title: t.title, artist: t.artist })}
                onPlayAll={(tracks) => setQueueAndPlay(tracks, 0)}
              />
            ) : null}

            {tab === 'playlists' ? (
              <Playlists
                onPlayTrack={(t) => playTrackNow({ id: t.id, title: t.title, artist: t.artist })}
                onPlayAll={(tracks) => setQueueAndPlay(tracks, 0)}
              />
            ) : null}

            {tab === 'favorites' ? (
              <Favorites
                onPlay={(t) => playTrackNow({ id: t.id, title: t.title, artist: t.artist })}
                onAddToQueue={(t) => addToQueue({ id: t.id, title: t.title, artist: t.artist })}
              />
            ) : null}

            {tab === 'history' ? (
              <History
                onPlay={(t) => playTrackNow({ id: t.id, title: t.title, artist: t.artist })}
                onAddToQueue={(t) => addToQueue({ id: t.id, title: t.title, artist: t.artist })}
              />
            ) : null}

            {tab === 'for-you' ? <Recommendations /> : null}

            {tab === 'settings' ? <Settings /> : null}

            {tab === 'admin' && isAdmin ? (
              <div style={{ display: 'grid', gap: 20 }}>
                <ScanPanel onScanFinished={() => setRefreshNonce((n) => n + 1)} />
                <UserManagementPanel />
                <LibraryManagementPanel />
              </div>
            ) : null}
          </section>
        </>
      )}
    </main>
  );
}

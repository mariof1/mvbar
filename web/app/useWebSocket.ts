'use client';

import { useEffect, useRef, useCallback } from 'react';
import { create } from 'zustand';
import { useFavorites } from './favoritesStore';
import { useToastStore } from './Toast';
import { useAuth } from './store';
import type { AdminBackup, AdminBackupJob } from './apiClient';

type LibraryUpdate = {
  type: 'library:update';
  data: {
    event: 'track_added' | 'track_updated' | 'track_removed' | 'scan:complete' | 'reconnected';
    path?: string;
    title?: string;
    artist?: string;
    album?: string;
    ts: number;
  };
};

type FavoriteUpdate = {
  type: 'favorite:added' | 'favorite:removed';
  data: {
    trackId: number;
  };
};

type PodcastProgressUpdate = {
  type: 'podcast:progress';
  data: {
    episodeId: number;
    position_ms: number;
    played: boolean;
  };
};

type PlaylistUpdate = {
  type: 'playlist:created' | 'playlist:updated' | 'playlist:item_added' | 'playlist:item_removed';
  data: {
    playlistId?: number;
    id?: number;
    name?: string;
    trackId?: number;
    position?: number;
  };
};

type HistoryUpdate = {
  type: 'history:added';
  data: {
    trackId: number;
    ts: number;
  };
};

type ScanProgressUpdate = {
  type: 'scan:progress';
  data: {
    // Worker sends these fields
    event?: string;
    status?: string;
    mountPath?: string;
    libraryIndex?: number;
    libraryTotal?: number;
    filesFound?: number;
    filesProcessed?: number;
    currentFile?: string;
    error?: string;
    failedFiles?: number;
    durationMs?: number;
    newFiles?: number;
    skipped?: number;
    ts?: number;
  };
};

type AdminUserPendingUpdate = {
  type: 'user:pending' | 'user:approval_changed';
  data: { email?: string; status?: string };
};

export type BackupUpdate =
  | { type: 'backup:started'; data: { job: AdminBackupJob } }
  | { type: 'backup:created'; data: { backup: AdminBackup; source: 'created' | 'uploaded' } }
  | { type: 'backup:deleted'; data: { name: string } }
  | { type: 'backup:error'; data: { operation: string; error: string } };

export type PluginUpdate =
  | { type: 'plugin:changed'; data: { event: string; id?: string; name?: string; at: string } }
  | { type: 'plugin:error'; data: { operation: string; id?: string; actionId?: string; error: string } };

export type MissingMusicUpdate = {
  type: 'missing-music:update';
  data: {
    event: string;
    requestId: string;
    userId: string;
    status: string;
    artist: string;
    title: string;
    message?: string;
    at: string;
  };
};

type WSMessage = LibraryUpdate | FavoriteUpdate | PodcastProgressUpdate | PlaylistUpdate | HistoryUpdate | ScanProgressUpdate | AdminUserPendingUpdate | BackupUpdate | PluginUpdate | MissingMusicUpdate | { type: 'connected' } | { type: 'ping' };

// Store for library update notifications
interface LibraryUpdateStore {
  lastUpdate: number;
  lastEvent: LibraryUpdate['data'] | null;
  triggerRefresh: () => void;
}

export const useLibraryUpdates = create<LibraryUpdateStore>((set) => ({
  lastUpdate: 0,
  lastEvent: null,
  triggerRefresh: () => set({ lastUpdate: Date.now() }),
}));

// Store for podcast progress updates from other devices
interface PodcastProgressStore {
  lastProgress: PodcastProgressUpdate['data'] | null;
  setProgress: (data: PodcastProgressUpdate['data']) => void;
}

export const usePodcastProgress = create<PodcastProgressStore>((set) => ({
  lastProgress: null,
  setProgress: (data) => set({ lastProgress: data }),
}));

// Helper to update podcast progress from local player (for UI sync)
export function updateLocalPodcastProgress(episodeId: number, position_ms: number, played: boolean) {
  usePodcastProgress.getState().setProgress({ episodeId, position_ms, played });
}

// Store for playlist update notifications
interface PlaylistUpdateStore {
  lastUpdate: number;
  lastEvent: PlaylistUpdate['data'] | null;
  triggerRefresh: () => void;
}

export const usePlaylistUpdates = create<PlaylistUpdateStore>((set) => ({
  lastUpdate: 0,
  lastEvent: null,
  triggerRefresh: () => set({ lastUpdate: Date.now() }),
}));

// Store for admin pending-user notifications
interface AdminPendingStore {
  count: number;
  lastEvent: number;
  gotoUsersRequested: number;
  setCount: (n: number) => void;
  requestGotoUsers: () => void;
  refresh: (token: string | null) => Promise<void>;
}

export const useAdminPending = create<AdminPendingStore>((set) => ({
  count: 0,
  lastEvent: 0,
  gotoUsersRequested: 0,
  setCount: (n) => set({ count: n }),
  requestGotoUsers: () => set({ gotoUsersRequested: Date.now() }),
  refresh: async (token) => {
    if (!token) return;
    try {
      const res = await fetch('/api/admin/users/pending', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const data = await res.json();
      set({ count: Array.isArray(data.users) ? data.users.length : 0 });
    } catch { /* ignore */ }
  },
}));

interface BackupUpdateStore {
  lastUpdate: number;
  lastEvent: BackupUpdate | null;
  setEvent: (event: BackupUpdate) => void;
}

export const useBackupUpdates = create<BackupUpdateStore>((set) => ({
  lastUpdate: 0,
  lastEvent: null,
  setEvent: (event) => set({ lastUpdate: Date.now(), lastEvent: event }),
}));

interface PluginUpdateStore {
  lastUpdate: number;
  lastEvent: PluginUpdate | null;
  setEvent: (event: PluginUpdate) => void;
}

export const usePluginUpdates = create<PluginUpdateStore>((set) => ({
  lastUpdate: 0,
  lastEvent: null,
  setEvent: (event) => set({ lastUpdate: Date.now(), lastEvent: event }),
}));

interface MissingMusicUpdateStore {
  lastUpdate: number;
  lastEvent: MissingMusicUpdate | null;
  setEvent: (event: MissingMusicUpdate) => void;
}

export const useMissingMusicUpdates = create<MissingMusicUpdateStore>((set) => ({
  lastUpdate: 0,
  lastEvent: null,
  setEvent: (event) => set({ lastUpdate: Date.now(), lastEvent: event }),
}));

// Store for history update notifications
interface HistoryUpdateStore {
  lastUpdate: number;
  lastTrackId: number | null;
  triggerRefresh: () => void;
}

export const useHistoryUpdates = create<HistoryUpdateStore>((set) => ({
  lastUpdate: 0,
  lastTrackId: null,
  triggerRefresh: () => set({ lastUpdate: Date.now() }),
}));

// Store for scan progress (admin)
interface ScanProgressStore {
  status: string;
  mountPath: string;
  libraryIndex: number;
  libraryTotal: number;
  filesFound: number;
  filesProcessed: number;
  currentFile: string;
  error: string;
  failedFiles: number;
  scanning: boolean;
  setProgress: (data: ScanProgressUpdate['data']) => void;
}

export const useScanProgress = create<ScanProgressStore>((set) => ({
  status: '',
  mountPath: '',
  libraryIndex: 0,
  libraryTotal: 0,
  filesFound: 0,
  filesProcessed: 0,
  currentFile: '',
  error: '',
  failedFiles: 0,
  scanning: false,
  setProgress: (data) => set({
    status: data.status ?? '',
    mountPath: data.mountPath ?? '',
    libraryIndex: data.libraryIndex ?? 0,
    libraryTotal: data.libraryTotal ?? 0,
    filesFound: data.filesFound ?? 0,
    filesProcessed: data.filesProcessed ?? 0,
    currentFile: data.currentFile ?? '',
    error: data.error ?? '',
    failedFiles: data.failedFiles ?? 0,
    scanning: data.status === 'scanning' || data.status === 'indexing',
  }),
}));

// Global WebSocket reference for sending messages
let globalWs: WebSocket | null = null;

export function sendWebSocketMessage(type: string, data: any): void {
  if (globalWs && globalWs.readyState === 1) {
    globalWs.send(JSON.stringify({ type, data }));
  }
}

// WebSocket connection hook
export function useWebSocket(isAdmin = false) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | undefined>(undefined);
  const reconnectAttempts = useRef(0);
  const activeRef = useRef(false);

  const connect = useCallback(() => {
    if (!activeRef.current) return;
    if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) return;

    // Determine WebSocket URL based on current location
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/api/ws`;

    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      globalWs = ws;

      ws.onopen = () => {
        reconnectAttempts.current = 0;
        useLibraryUpdates.setState({
          lastUpdate: Date.now(),
          lastEvent: { event: 'reconnected', ts: Date.now() },
        });
      };

      ws.onmessage = (event) => {
        try {
          const msg: WSMessage = JSON.parse(event.data);
          
          if (msg.type === 'ping') {
            // Respond to heartbeat
            ws.send(JSON.stringify({ type: 'pong' }));
          } else if (msg.type === 'library:update') {
            useLibraryUpdates.setState({
              lastUpdate: Date.now(),
              lastEvent: msg.data,
            });
          } else if (msg.type === 'favorite:added') {
            useFavorites.getState().addToSet(msg.data.trackId);
          } else if (msg.type === 'favorite:removed') {
            useFavorites.getState().removeFromSet(msg.data.trackId);
          } else if (msg.type === 'podcast:progress') {
            // Podcast progress update from another device
            usePodcastProgress.getState().setProgress(msg.data);
          } else if (msg.type === 'playlist:created' || msg.type === 'playlist:updated' || msg.type === 'playlist:item_added' || msg.type === 'playlist:item_removed') {
            // Playlist updates
            usePlaylistUpdates.setState({
              lastUpdate: Date.now(),
              lastEvent: msg.data,
            });
          } else if (msg.type === 'history:added') {
            // History update
            useHistoryUpdates.setState({
              lastUpdate: Date.now(),
              lastTrackId: msg.data.trackId,
            });
          } else if (msg.type === 'scan:progress') {
            // Scan progress update (admin)
            useScanProgress.getState().setProgress(msg.data);
          } else if (msg.type === 'user:pending') {
            if (useAuth.getState().user?.role === 'admin') {
              useAdminPending.setState((s) => ({ count: s.count + 1, lastEvent: Date.now() }));
              const email = msg.data?.email ? ` (${msg.data.email})` : '';
              useToastStore.getState().show(`New user pending approval${email}`, 'queue');
            }
          } else if (msg.type === 'user:approval_changed') {
            const auth = useAuth.getState();
            if (auth.user?.role === 'admin') {
              useAdminPending.getState().refresh(auth.token);
            }
          } else if (
            msg.type === 'backup:started'
            || msg.type === 'backup:created'
            || msg.type === 'backup:deleted'
            || msg.type === 'backup:error'
          ) {
            if (useAuth.getState().user?.role === 'admin') {
              useBackupUpdates.getState().setEvent(msg);
              if (msg.type === 'backup:created') {
                const action = msg.data.source === 'uploaded' ? 'uploaded' : 'created';
                useToastStore.getState().show(
                  `Backup ${action} successfully: ${msg.data.backup.name}`,
                  'success',
                  'top-right',
                );
              } else if (msg.type === 'backup:error') {
                useToastStore.getState().show(msg.data.error || 'Backup failed', 'error', 'top-right');
              }
            }
          } else if (msg.type === 'plugin:changed' || msg.type === 'plugin:error') {
            if (useAuth.getState().user?.role === 'admin') {
              usePluginUpdates.getState().setEvent(msg);
              if (msg.type === 'plugin:changed') {
                const subject = msg.data.name || msg.data.id || 'Plugin';
                useToastStore.getState().show(`${subject}: ${msg.data.event}`, 'success', 'top-right');
              } else {
                useToastStore.getState().show(msg.data.error || 'Plugin operation failed', 'error', 'top-right');
              }
            }
          } else if (msg.type === 'missing-music:update') {
            useMissingMusicUpdates.getState().setEvent(msg);
            const failed = msg.data.status === 'failed' || msg.data.status === 'rejected';
            useToastStore.getState().show(
              msg.data.message || `${msg.data.title}: ${msg.data.status}`,
              failed ? 'error' : 'success',
              'top-right',
            );
          }
        } catch {
          // Ignore malformed messages
        }
      };

      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null;
        if (globalWs === ws) globalWs = null;
        if (!activeRef.current) return;
        
        // Exponential backoff for reconnection
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 30000);
        reconnectAttempts.current++;
        
        reconnectTimeoutRef.current = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        // Error logged via onclose
      };
    } catch {
      // Connection failed, will retry via onclose
    }
  }, []);

  useEffect(() => {
    activeRef.current = true;
    connect();

    const reconnectNow = () => {
      if (!activeRef.current || document.visibilityState === 'hidden') return;
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = undefined;
      if (wsRef.current && wsRef.current.readyState !== WebSocket.OPEN) {
        wsRef.current.close();
        wsRef.current = null;
      }
      connect();
    };
    window.addEventListener('online', reconnectNow);
    document.addEventListener('visibilitychange', reconnectNow);

    return () => {
      activeRef.current = false;
      window.removeEventListener('online', reconnectNow);
      document.removeEventListener('visibilitychange', reconnectNow);
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
        if (globalWs === wsRef.current) globalWs = null;
        wsRef.current = null;
      }
    };
  }, [connect]);

  return wsRef;
}

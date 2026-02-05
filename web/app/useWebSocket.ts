'use client';

import { useEffect, useRef, useCallback } from 'react';
import { create } from 'zustand';
import { useFavorites } from './favoritesStore';

type LibraryUpdate = {
  type: 'library:update';
  data: {
    event: 'track_added' | 'track_updated' | 'track_removed';
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
    filesFound?: number;
    filesProcessed?: number;
    currentFile?: string;
    durationMs?: number;
    newFiles?: number;
    skipped?: number;
    ts?: number;
  };
};

type WSMessage = LibraryUpdate | FavoriteUpdate | PodcastProgressUpdate | PlaylistUpdate | HistoryUpdate | ScanProgressUpdate | { type: 'connected' } | { type: 'ping' };

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
  filesFound: number;
  filesProcessed: number;
  currentFile: string;
  scanning: boolean;
  setProgress: (data: ScanProgressUpdate['data']) => void;
}

export const useScanProgress = create<ScanProgressStore>((set) => ({
  status: '',
  filesFound: 0,
  filesProcessed: 0,
  currentFile: '',
  scanning: false,
  setProgress: (data) => set({
    status: data.status ?? '',
    filesFound: data.filesFound ?? 0,
    filesProcessed: data.filesProcessed ?? 0,
    currentFile: data.currentFile ?? '',
    scanning: data.status === 'scanning',
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

  const connect = useCallback(() => {
    // Determine WebSocket URL based on current location
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/api/ws`;

    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      globalWs = ws;

      ws.onopen = () => {
        reconnectAttempts.current = 0;
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
          }
        } catch {
          // Ignore malformed messages
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        globalWs = null;
        
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
    connect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
        globalWs = null;
      }
    };
  }, [connect]);

  return wsRef;
}

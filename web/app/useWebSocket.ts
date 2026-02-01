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

type WSMessage = LibraryUpdate | FavoriteUpdate | PodcastProgressUpdate | { type: 'connected' } | { type: 'ping' };

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
        console.log('[ws] Connected');
        reconnectAttempts.current = 0;
      };

      ws.onmessage = (event) => {
        try {
          const msg: WSMessage = JSON.parse(event.data);
          
          if (msg.type === 'ping') {
            // Respond to heartbeat
            ws.send(JSON.stringify({ type: 'pong' }));
          } else if (msg.type === 'library:update') {
            // Only log library updates for admin users
            if (isAdmin) {
              console.log('[ws] Library update:', msg.data);
            }
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
          }
        } catch (e) {
          console.error('[ws] Failed to parse message:', e);
        }
      };

      ws.onclose = () => {
        console.log('[ws] Disconnected');
        wsRef.current = null;
        globalWs = null;
        
        // Exponential backoff for reconnection
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 30000);
        reconnectAttempts.current++;
        
        reconnectTimeoutRef.current = setTimeout(connect, delay);
      };

      ws.onerror = (error) => {
        console.error('[ws] Error:', error);
      };
    } catch (e) {
      console.error('[ws] Failed to connect:', e);
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

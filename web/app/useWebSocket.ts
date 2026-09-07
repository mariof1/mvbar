'use client';

import { useEffect, useRef, useCallback } from 'react';
import { create } from 'zustand';
import { useFavorites } from './favoritesStore';
import { useToastStore } from './Toast';
import { useAuth } from './store';
import { apiFetch, getWebClientId, type AdminBackup, type AdminBackupJob } from './apiClient';
import { useSocialUpdates } from './socialStore';
import { systemSocialNotificationsEnabled } from './pushNotifications';
import { usePlayer } from './playerStore';

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
  type:
    | 'playlist:created'
    | 'playlist:updated'
    | 'playlist:item_added'
    | 'playlist:item_removed'
    | 'playlist:deleted'
    | 'playlist:collaborator_added'
    | 'playlist:collaborator_removed';
  data: {
    playlistId?: number;
    id?: number;
    name?: string;
    trackId?: number;
    position?: number;
    by?: string;
    userId?: string;
    user?: { id: string; email: string };
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

type SocialUpdate =
  | { type: 'social:friend_request'; data: { relationshipId: number; user: { id: string; email: string } } }
  | { type: 'social:friend_accepted'; data: { relationshipId: number; user: { id: string; email: string } } }
  | { type: 'social:friend_request_removed'; data: { relationshipId: number } }
  | { type: 'social:friend_removed'; data: { userId: string } }
  | { type: 'social:track_shared'; data: { shareId: number; sender: { id: string; email: string }; track: { id: number; title: string | null } } }
  | { type: 'social:playlist_shared'; data: { playlist: { id: number; name: string }; sender: { id: string; email: string }; sharedAt: string } }
  | { type: 'social:share_read'; data: { shareId: number } }
  | { type: 'social:shares_read_all'; data: Record<string, never> }
  | { type: 'social:share_removed'; data: { shareId: number } };

export type MvbarConnectTrack = {
  id: number;
  title: string | null;
  artist: string | null;
  album: string | null;
  artPath: string | null;
  durationMs: number | null;
};

export type MvbarConnectPlaybackState = {
  track: MvbarConnectTrack | null;
  queue: MvbarConnectTrack[];
  queueIndex: number;
  queueLength: number;
  isPlaying: boolean;
  positionMs: number;
  durationMs: number;
  volume: number | null;
  updatedAt: number;
};

export type MvbarConnectDevice = {
  id: string;
  name: string;
  type: string;
  appVersion: string | null;
  platform: string | null;
  capabilities: string[];
  state: MvbarConnectPlaybackState;
};

export type MvbarConnectCommand = {
  commandId: string;
  sourceDeviceId: string;
  command: string;
  payload: Record<string, unknown>;
};

type ConnectUpdate =
  | { type: 'connect:devices'; data: { devices: MvbarConnectDevice[] } }
  | { type: 'connect:registered'; data: { deviceId: string } }
  | { type: 'connect:replaced'; data: { deviceId: string } }
  | { type: 'connect:error'; data: { error: string } }
  | { type: 'connect:command'; data: MvbarConnectCommand }
  | { type: 'connect:command_ack'; data: { commandId: string; accepted: boolean; executed?: boolean; error?: string } }
  | { type: 'auth:session_invalid'; data: { error?: string } };

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

type WSMessage = LibraryUpdate | FavoriteUpdate | PodcastProgressUpdate | PlaylistUpdate | HistoryUpdate | ScanProgressUpdate | AdminUserPendingUpdate | BackupUpdate | PluginUpdate | MissingMusicUpdate | SocialUpdate | ConnectUpdate | { type: 'connected' } | { type: 'ping' };

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
      const data = await apiFetch('/admin/users/pending', { method: 'GET' }, token);
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

interface MvbarConnectStore {
  localDeviceId: string | null;
  selectedDeviceId: string | null;
  devices: MvbarConnectDevice[];
  connected: boolean;
  setLocalDeviceId: (id: string) => void;
  setDevices: (devices: MvbarConnectDevice[]) => void;
  selectDevice: (id: string) => void;
  setConnected: (connected: boolean) => void;
}

export const useMvbarConnect = create<MvbarConnectStore>((set, get) => ({
  localDeviceId: null,
  selectedDeviceId: null,
  devices: [],
  connected: false,
  setLocalDeviceId: (id) => set((state) => ({
    localDeviceId: id,
    selectedDeviceId: !state.selectedDeviceId || state.selectedDeviceId === state.localDeviceId ? id : state.selectedDeviceId,
  })),
  setDevices: (devices) => set((state) => {
    const available = new Set(devices.map((device) => device.id));
    const selectedDeviceId = state.selectedDeviceId && available.has(state.selectedDeviceId)
      ? state.selectedDeviceId
      : state.localDeviceId && available.has(state.localDeviceId)
        ? state.localDeviceId
        : devices.find((device) => device.state.isPlaying)?.id ?? devices[0]?.id ?? null;
    return { devices, selectedDeviceId, connected: true };
  }),
  selectDevice: (id) => {
    if (get().devices.some((device) => device.id === id)) set({ selectedDeviceId: id });
  },
  setConnected: (connected) => set((state) => connected
    ? { connected: true }
    : {
        connected: false,
        devices: [],
        selectedDeviceId: state.localDeviceId,
      }),
}));

type LocalConnectState = {
  track: MvbarConnectTrack | null;
  queue: MvbarConnectTrack[];
  queueIndex: number;
  isPlaying: boolean;
  positionMs: number;
  durationMs: number;
  volume: number | null;
};

let localConnectState: LocalConnectState = {
  track: null,
  queue: [],
  queueIndex: -1,
  isPlaying: false,
  positionMs: 0,
  durationMs: 0,
  volume: null,
};

const connectCommandHandlers = new Set<(command: MvbarConnectCommand) => boolean | void | Promise<boolean | void>>();
const CONNECT_DEVICE_NAME_KEY = 'mvbar_connect_device_name';

function connectSessionId(renew = false): string {
  const key = 'mvbar_connect_session_id';
  let id = window.sessionStorage.getItem(key);
  if (!id || renew) {
    id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    window.sessionStorage.setItem(key, id);
  }
  return id;
}

function localConnectDeviceId(): string {
  return `${getWebClientId()}:${connectSessionId()}`.slice(0, 128);
}

export function describeMvbarConnectBrowser(userAgent: string, navigatorPlatform: string, standalone: boolean) {
  // Chromium-based Edge uses Edg/, EdgA/, and EdgiOS/ on desktop, Android, and iOS.
  const browser = /Edg(?:A|iOS)?\//.test(userAgent) ? 'Edge'
    : /FxiOS\/|Firefox\//.test(userAgent) ? 'Firefox'
      : /CriOS\/|Chrome\//.test(userAgent) ? 'Chrome'
        : /Safari\//.test(userAgent) ? 'Safari'
          : 'Web player';
  const platform = /Android/i.test(userAgent) ? 'Android'
    : /iPhone|iPad|iPod/i.test(userAgent) ? 'iOS'
      : /Windows NT/i.test(userAgent) ? 'Windows'
        : /CrOS/i.test(userAgent) ? 'ChromeOS'
          : /Mac OS X/i.test(userAgent) ? 'macOS'
            : navigatorPlatform || 'this device';
  return {
    name: `${browser}${standalone ? ' PWA' : ''} on ${platform}`,
    platform,
    type: standalone ? 'pwa' : 'web',
  };
}

function registerMvbarConnect(ws: WebSocket): void {
  const deviceId = localConnectDeviceId();
  const identity = describeMvbarConnectBrowser(
    navigator.userAgent,
    navigator.platform,
    Boolean(window.matchMedia?.('(display-mode: standalone)').matches),
  );
  useMvbarConnect.getState().setLocalDeviceId(deviceId);
  ws.send(JSON.stringify({
    type: 'connect:register',
    data: {
      deviceId,
      name: window.localStorage.getItem(CONNECT_DEVICE_NAME_KEY)?.trim().slice(0, 120) || identity.name,
      type: identity.type,
      appVersion: '0.1.0',
      platform: identity.platform,
      capabilities: ['music', 'remote-control', 'transfer', 'command-results-v1', 'play-next'],
      state: localConnectState,
    },
  }));
}

export function renameLocalMvbarConnectDevice(name: string): void {
  const normalized = name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
  if (normalized) window.localStorage.setItem(CONNECT_DEVICE_NAME_KEY, normalized);
  else window.localStorage.removeItem(CONNECT_DEVICE_NAME_KEY);
  if (globalWs?.readyState === WebSocket.OPEN) registerMvbarConnect(globalWs);
}

export function publishMvbarConnectState(state: LocalConnectState): void {
  localConnectState = state;
  sendWebSocketMessage('connect:state', state);
}

export function sendMvbarConnectCommand(
  targetDeviceId: string,
  command: string,
  payload: Record<string, unknown> = {},
): string {
  const commandId = globalThis.crypto?.randomUUID?.() ?? `cmd_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  if (globalWs?.readyState !== WebSocket.OPEN) {
    useToastStore.getState().show('MVBar Connect is disconnected. Wait for it to reconnect and try again.', 'error', 'top-right');
    return '';
  }
  sendWebSocketMessage('connect:command', { targetDeviceId, commandId, command, payload });
  return commandId;
}

const pendingTransfers = new Map<string, (success: boolean) => void>();

export function transferMvbarPlayback(sourceDeviceId: string, targetDeviceId: string): Promise<boolean> {
  const commandId = globalThis.crypto?.randomUUID?.() ?? `transfer_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  if (globalWs?.readyState !== WebSocket.OPEN) {
    useToastStore.getState().show('MVBar Connect is disconnected. Wait for it to reconnect and try again.', 'error', 'top-right');
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      useToastStore.getState().show('Playback transfer was not confirmed. Please try again.', 'error', 'top-right');
      pendingTransfers.get(commandId)?.(false);
    }, 15000);
    pendingTransfers.set(commandId, (success) => {
      window.clearTimeout(timer);
      pendingTransfers.delete(commandId);
      resolve(success);
    });
    sendWebSocketMessage('connect:transfer', { sourceDeviceId, targetDeviceId, commandId });
  });
}

export function subscribeMvbarConnectCommands(
  handler: (command: MvbarConnectCommand) => boolean | void | Promise<boolean | void>,
): () => void {
  connectCommandHandlers.add(handler);
  return () => connectCommandHandlers.delete(handler);
}

// Global WebSocket reference for sending messages
let globalWs: WebSocket | null = null;

export function sendWebSocketMessage(type: string, data: any): void {
  if (globalWs && globalWs.readyState === 1) {
    globalWs.send(JSON.stringify({ type, data }));
  }
}

// WebSocket connection hook
export function useWebSocket(authIdentity: string | null) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | undefined>(undefined);
  const reconnectAttempts = useRef(0);
  const activeRef = useRef(false);

  const connect = useCallback(() => {
    if (!activeRef.current || !authIdentity) return;
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
        registerMvbarConnect(ws);
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
          } else if (
            msg.type === 'playlist:created'
            || msg.type === 'playlist:updated'
            || msg.type === 'playlist:item_added'
            || msg.type === 'playlist:item_removed'
            || msg.type === 'playlist:deleted'
            || msg.type === 'playlist:collaborator_added'
            || msg.type === 'playlist:collaborator_removed'
          ) {
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
          } else if (msg.type.startsWith('social:')) {
            const social = msg as SocialUpdate;
            const auth = useAuth.getState();
            if (social.type === 'social:playlist_shared') {
              usePlaylistUpdates.getState().triggerRefresh();
            } else {
              useSocialUpdates.getState().trigger();
              void useSocialUpdates.getState().refresh(auth.token);
            }
            if (systemSocialNotificationsEnabled()) {
              // The service worker displays these events as system notifications.
            } else if (social.type === 'social:friend_request') {
              useToastStore.getState().show(`${social.data.user.email} sent you a friend request`, 'queue');
            } else if (social.type === 'social:friend_accepted') {
              useToastStore.getState().show(`${social.data.user.email} accepted your friend request`, 'success');
            } else if (social.type === 'social:track_shared') {
              useToastStore.getState().show(
                `${social.data.sender.email} shared “${social.data.track.title || 'a song'}” with you`,
                'playing',
              );
            } else if (social.type === 'social:playlist_shared') {
              useToastStore.getState().show(
                `${social.data.sender.email || 'A friend'} shared playlist “${social.data.playlist.name || 'Untitled'}” with you`,
                'queue',
              );
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
          } else if (msg.type === 'connect:devices') {
            useMvbarConnect.getState().setDevices(Array.isArray(msg.data.devices) ? msg.data.devices : []);
          } else if (msg.type === 'connect:registered') {
            useMvbarConnect.getState().setConnected(true);
          } else if (msg.type === 'connect:replaced') {
            // Duplicated tabs inherit sessionStorage. Give this still-live tab
            // its own identity instead of leaving it unable to receive commands.
            connectSessionId(true);
            registerMvbarConnect(ws);
          } else if (msg.type === 'connect:error') {
            useToastStore.getState().show(msg.data.error || 'MVBar Connect error', 'error', 'top-right');
          } else if (msg.type === 'connect:command_ack') {
            pendingTransfers.get(msg.data.commandId)?.(msg.data.accepted);
            if (!msg.data.accepted) {
              useToastStore.getState().show(msg.data.error || 'The selected player is unavailable', 'error', 'top-right');
            }
          } else if (msg.type === 'connect:command') {
            const handlers = [...connectCommandHandlers];
            if (handlers.length === 0) {
              ws.send(JSON.stringify({
                type: 'connect:command_result',
                data: { commandId: msg.data.commandId, success: false, error: 'This player is not ready.' },
              }));
            } else {
              void Promise.all(handlers.map((handler) => handler(msg.data))).then((results) => {
                const success = results.every((result) => result !== false);
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({
                    type: 'connect:command_result',
                    data: {
                      commandId: msg.data.commandId,
                      success,
                      ...(success ? {} : { error: 'This player could not apply that command.' }),
                    },
                  }));
                }
              }).catch((error: unknown) => {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({
                    type: 'connect:command_result',
                    data: {
                      commandId: msg.data.commandId,
                      success: false,
                      error: error instanceof Error ? error.message.slice(0, 300) : 'Playback failed.',
                    },
                  }));
                }
              });
            }
          } else if (msg.type === 'auth:session_invalid') {
            useMvbarConnect.getState().setConnected(false);
            usePlayer.getState().reset();
            useAuth.getState().clear();
            ws.close(4001, 'Session invalidated');
          }
        } catch {
          // Ignore malformed messages
        }
      };

      ws.onclose = () => {
        if (wsRef.current !== ws) return;
        for (const finish of pendingTransfers.values()) finish(false);
        wsRef.current = null;
        if (globalWs === ws) globalWs = null;
        useMvbarConnect.getState().setConnected(false);
        if (!activeRef.current || !authIdentity) return;
        
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
  }, [authIdentity]);

  useEffect(() => {
    if (!authIdentity) {
      useMvbarConnect.getState().setConnected(false);
      localConnectState = {
        track: null,
        queue: [],
        queueIndex: -1,
        isPlaying: false,
        positionMs: 0,
        durationMs: 0,
        volume: null,
      };
      usePlayer.getState().reset();
      return;
    }
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
      for (const finish of pendingTransfers.values()) finish(false);
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
  }, [authIdentity, connect]);

  return wsRef;
}

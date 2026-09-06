export const CONNECT_COMMANDS = [
  'play',
  'pause',
  'toggle',
  'next',
  'previous',
  'seek',
  'stop',
  'play_tracks',
  'add_tracks',
  'play_index',
  'remove_index',
  'reorder',
  'clear_queue',
] as const;

export type ConnectCommandName = typeof CONNECT_COMMANDS[number];

export type ConnectTrack = {
  id: number;
  title: string | null;
  artist: string | null;
  album: string | null;
  artPath: string | null;
  durationMs: number | null;
};

export type ConnectPlaybackState = {
  track: ConnectTrack | null;
  queue: ConnectTrack[];
  queueIndex: number;
  isPlaying: boolean;
  positionMs: number;
  durationMs: number;
  volume: number | null;
  updatedAt: number;
};

export type ConnectDeviceRegistration = {
  deviceId: string;
  name: string;
  type: string;
  appVersion: string | null;
  platform: string | null;
  capabilities: string[];
  state: ConnectPlaybackState;
};

export type ConnectCommand = {
  targetDeviceId: string;
  commandId: string;
  command: ConnectCommandName;
  payload: Record<string, unknown>;
};

const commandSet = new Set<string>(CONNECT_COMMANDS);

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

function number(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

export function normalizeConnectTrack(value: unknown): ConnectTrack | null {
  const input = object(value);
  if (!input) return null;
  const rawId = typeof input.id === 'number' ? input.id : Number.NaN;
  if (!Number.isFinite(rawId) || rawId <= 0) return null;
  const id = Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(rawId));
  return {
    id,
    title: text(input.title, 300),
    artist: text(input.artist, 300),
    album: text(input.album, 300),
    artPath: text(input.artPath ?? input.art_path, 500),
    durationMs: input.durationMs == null && input.duration_ms == null
      ? null
      : Math.round(number(input.durationMs ?? input.duration_ms, 0, 0, 24 * 60 * 60 * 1000)),
  };
}

export function normalizeConnectState(value: unknown): ConnectPlaybackState {
  const input = object(value) ?? {};
  const queue = Array.isArray(input.queue)
    ? input.queue.slice(0, 500).map(normalizeConnectTrack).filter((track): track is ConnectTrack => track != null)
    : [];
  const explicitTrack = normalizeConnectTrack(input.track);
  const requestedIndex = Math.trunc(number(input.queueIndex, -1, -1, Math.max(-1, queue.length - 1)));
  const queueIndex = queue.length === 0 ? -1 : Math.max(0, Math.min(queue.length - 1, requestedIndex));
  return {
    track: explicitTrack ?? queue[queueIndex] ?? null,
    queue,
    queueIndex,
    isPlaying: input.isPlaying === true,
    positionMs: Math.round(number(input.positionMs, 0, 0, 24 * 60 * 60 * 1000)),
    durationMs: Math.round(number(input.durationMs, 0, 0, 24 * 60 * 60 * 1000)),
    volume: input.volume == null ? null : number(input.volume, 1, 0, 1),
    updatedAt: Date.now(),
  };
}

export function normalizeConnectRegistration(value: unknown): ConnectDeviceRegistration | null {
  const input = object(value);
  if (!input) return null;
  const deviceId = text(input.deviceId, 128);
  if (!deviceId) return null;
  const capabilities = Array.isArray(input.capabilities)
    ? [...new Set(input.capabilities.map((item) => text(item, 40)).filter((item): item is string => item != null))].slice(0, 20)
    : [];
  return {
    deviceId,
    name: text(input.name, 120) ?? 'MVBar player',
    type: text(input.type, 40)?.toLowerCase() ?? 'unknown',
    appVersion: text(input.appVersion, 80),
    platform: text(input.platform, 120),
    capabilities,
    state: normalizeConnectState(input.state),
  };
}

export function normalizeConnectCommand(value: unknown): ConnectCommand | null {
  const input = object(value);
  if (!input) return null;
  const targetDeviceId = text(input.targetDeviceId, 128);
  const commandId = text(input.commandId, 128);
  const command = text(input.command, 40);
  if (!targetDeviceId || !commandId || !command || !commandSet.has(command)) return null;
  return {
    targetDeviceId,
    commandId,
    command: command as ConnectCommandName,
    payload: object(input.payload) ?? {},
  };
}

export function normalizeConnectTransfer(value: unknown): { sourceDeviceId: string; targetDeviceId: string; commandId: string } | null {
  const input = object(value);
  if (!input) return null;
  const sourceDeviceId = text(input.sourceDeviceId, 128);
  const targetDeviceId = text(input.targetDeviceId, 128);
  const commandId = text(input.commandId, 128);
  return sourceDeviceId && targetDeviceId && commandId
    ? { sourceDeviceId, targetDeviceId, commandId }
    : null;
}

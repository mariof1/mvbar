import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import Redis from 'ioredis';
import logger from './logger.js';
import {
  normalizeConnectCommand,
  normalizeConnectCommandResult,
  normalizeConnectRegistration,
  normalizeConnectState,
  normalizeConnectTransfer,
  type ConnectDeviceRegistration,
} from './connectProtocol.js';
import * as users from './userRepo.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://redis:6379';

// Connected WebSocket clients with user info
interface ClientInfo {
  socket: WebSocket;
  userId?: string;
  isAdmin?: boolean;
  sessionVersion?: number;
  isAlive: boolean;
  connect?: ConnectDeviceRegistration;
}
const clients = new Map<WebSocket, ClientInfo>();

interface PendingConnectCommand {
  controllerSocket: WebSocket;
  targetSocket: WebSocket;
  userId: string;
  targetDeviceId: string;
  commandId: string;
  timeout: ReturnType<typeof setTimeout>;
  transferSourceSocket?: WebSocket;
  transferControllerDeviceId?: string;
}

const pendingConnectCommands = new Map<string, PendingConnectCommand>();
const CONNECT_COMMAND_TIMEOUT_MS = 12_000;
const WS_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

function send(socket: WebSocket, type: string, data?: unknown): void {
  if (socket.readyState !== 1) return;
  socket.send(JSON.stringify(data === undefined ? { type } : { type, data }));
}

function publicConnectDevice(device: ConnectDeviceRegistration) {
  return {
    id: device.deviceId,
    name: device.name,
    type: device.type,
    appVersion: device.appVersion,
    platform: device.platform,
    capabilities: device.capabilities,
    state: {
      track: device.state.track,
      queue: device.state.queue,
      queueIndex: device.state.queueIndex,
      queueLength: device.state.queue.length,
      isPlaying: device.state.isPlaying,
      positionMs: device.state.positionMs,
      durationMs: device.state.durationMs,
      volume: device.state.volume,
      updatedAt: device.state.updatedAt,
    },
  };
}

function pendingCommandKey(userId: string, targetDeviceId: string, commandId: string): string {
  return `${userId}\u0000${targetDeviceId}\u0000${commandId}`;
}

function finishPendingCommand(pending: PendingConnectCommand, success: boolean, error?: string): void {
  const key = pendingCommandKey(pending.userId, pending.targetDeviceId, pending.commandId);
  if (pendingConnectCommands.get(key) !== pending) return;
  pendingConnectCommands.delete(key);
  clearTimeout(pending.timeout);

  if (success && pending.transferSourceSocket && pending.transferSourceSocket !== pending.targetSocket) {
    send(pending.transferSourceSocket, 'connect:command', {
      commandId: `${pending.commandId}:pause`,
      sourceDeviceId: pending.transferControllerDeviceId,
      command: 'pause',
      payload: {},
    });
  }

  send(pending.controllerSocket, 'connect:command_ack', {
    commandId: pending.commandId,
    targetDeviceId: pending.targetDeviceId,
    accepted: success,
    executed: success,
    ...(success ? {} : { error: error || 'The player could not complete that command.' }),
  });
}

function beginPendingCommand(input: Omit<PendingConnectCommand, 'timeout'>): boolean {
  const key = pendingCommandKey(input.userId, input.targetDeviceId, input.commandId);
  if (pendingConnectCommands.has(key)) return false;
  const pending: PendingConnectCommand = {
    ...input,
    timeout: setTimeout(() => {
      finishPendingCommand(pending, false, 'The player did not confirm the command in time.');
    }, CONNECT_COMMAND_TIMEOUT_MS),
  };
  pendingConnectCommands.set(key, pending);
  return true;
}

function clearPendingCommandsForSocket(socket: WebSocket): void {
  for (const pending of [...pendingConnectCommands.values()]) {
    if (pending.controllerSocket === socket && !pending.transferSourceSocket) {
      pendingConnectCommands.delete(pendingCommandKey(pending.userId, pending.targetDeviceId, pending.commandId));
      clearTimeout(pending.timeout);
    } else if (pending.targetSocket === socket) {
      finishPendingCommand(pending, false, 'That player disconnected before completing the command.');
    }
  }
}

function closeClient(info: ClientInfo, reason: string): void {
  send(info.socket, 'auth:session_invalid', { error: reason });
  info.socket.close(4001, reason.slice(0, 120));
}

export function disconnectUserSockets(userId: string, reason = 'Session invalidated'): void {
  for (const info of clients.values()) {
    if (info.userId === userId) closeClient(info, reason);
  }
}

export function disconnectClientSockets(userId: string, clientId: string, reason = 'Signed out'): void {
  for (const info of clients.values()) {
    const deviceId = info.connect?.deviceId;
    if (info.userId === userId && deviceId && (deviceId === clientId || deviceId.startsWith(`${clientId}:`))) {
      closeClient(info, reason);
    }
  }
}

function connectDevicesForUser(userId: string) {
  return Array.from(clients.values())
    .filter((info) => info.userId === userId && info.connect != null && info.socket.readyState === 1)
    .map((info) => publicConnectDevice(info.connect!))
    .sort((a, b) => Number(b.state.isPlaying) - Number(a.state.isPlaying) || a.name.localeCompare(b.name));
}

function sendConnectDevices(userId: string): void {
  const devices = connectDevicesForUser(userId);
  for (const info of clients.values()) {
    if (info.userId === userId) send(info.socket, 'connect:devices', { devices });
  }
}

function connectClient(userId: string, deviceId: string): ClientInfo | undefined {
  return Array.from(clients.values()).find(
    (info) => info.userId === userId && info.connect?.deviceId === deviceId && info.socket.readyState === 1,
  );
}

function safeCommandPayload(command: string, payload: Record<string, unknown>) {
  if (command === 'play_tracks' || command === 'add_tracks' || command === 'play_next') {
    const state = normalizeConnectState({ queue: payload.tracks, queueIndex: payload.queueIndex });
    return {
      tracks: state.queue,
      queueIndex: Math.max(0, state.queueIndex),
      positionMs: Math.max(0, Math.min(24 * 60 * 60 * 1000, Math.round(Number(payload.positionMs) || 0))),
      isPlaying: payload.isPlaying !== false,
    };
  }
  if (command === 'seek') {
    return { positionMs: Math.max(0, Math.min(24 * 60 * 60 * 1000, Math.round(Number(payload.positionMs) || 0))) };
  }
  if (command === 'play_index' || command === 'remove_index') {
    return { index: Math.max(0, Math.min(499, Math.trunc(Number(payload.index) || 0))) };
  }
  if (command === 'reorder') {
    return {
      from: Math.max(0, Math.min(499, Math.trunc(Number(payload.from) || 0))),
      to: Math.max(0, Math.min(499, Math.trunc(Number(payload.to) || 0))),
    };
  }
  return {};
}

// Broadcast to all connected clients
export function broadcast(type: string, data: any): void {
  const payload = JSON.stringify({ type, data });
  for (const [socket] of clients) {
    if (socket.readyState === 1) { // WebSocket.OPEN
      socket.send(payload);
    }
  }
}

// Broadcast to a specific user
export function broadcastToUser(userId: string, type: string, data: any): void {
  const payload = JSON.stringify({ type, data });
  for (const [socket, info] of clients) {
    if (socket.readyState === 1 && info.userId === userId) {
      socket.send(payload);
    }
  }
}

// Broadcast to all admin users
export function broadcastToAdmins(type: string, data: any, exceptUserId?: string): void {
  const payload = JSON.stringify({ type, data });
  for (const [socket, info] of clients) {
    if (socket.readyState === 1 && info.isAdmin && info.userId !== exceptUserId) {
      socket.send(payload);
    }
  }
}

export const websocketPlugin: FastifyPluginAsync = fp(async (app) => {
  // Register WebSocket support
  await app.register(websocket, { options: { maxPayload: WS_MAX_PAYLOAD_BYTES } });

  // Subscribe to Redis for library updates from worker
  const subscriber = new Redis(REDIS_URL);
  app.addHook('onClose', async () => { subscriber.disconnect(); });
  
  subscriber.subscribe('library:updates', (err) => {
    if (err) {
      logger.error('ws', 'Failed to subscribe to Redis');
    } else {
      logger.success('ws', 'Subscribed to library:updates channel');
    }
  });

  subscriber.on('message', (channel, message) => {
    if (channel === 'library:updates') {
      try {
        const data = JSON.parse(message);
      // Scan progress is admin-only, but completion also invalidates library
      // views for every connected user. This provides one reliable refresh
      // after the burst of per-track events produced by a scan.
      if (data.event === 'scan:progress' || data.event === 'scan:complete') {
        broadcastToAdmins('scan:progress', data);
        if (data.event === 'scan:complete') {
          broadcast('library:update', data);
        }
      } else {
        // Broadcast regular library updates to all connected WebSocket clients
        broadcast('library:update', data);
      }
      } catch (e) {
        logger.error('ws', `Failed to parse Redis message: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  });

  registerWebsocketRoutes(app);
});

export function registerWebsocketRoutes(app: FastifyInstance): void {
  // WebSocket endpoint for clients
  app.get('/api/ws', { websocket: true }, (socket, req) => {
    // Get user ID from the request if authenticated
    const userId = req.user?.userId;
    const isAdmin = req.user?.role === 'admin';
    if (!userId) {
      send(socket, 'auth:session_invalid', { error: 'Authentication required' });
      socket.close(4001, 'Authentication required');
      return;
    }
    const info: ClientInfo = {
      socket,
      userId,
      isAdmin,
      sessionVersion: req.user?.sessionVersion,
      isAlive: true,
    };
    clients.set(socket, info);
    logger.info('ws', `Client connected (${clients.size} total)${userId ? ` user=${userId.substring(0, 8)}...` : ''}${isAdmin ? ' (admin)' : ''}`);

    // Send initial connection confirmation
    send(socket, 'connected');

    // Heartbeat to keep connection alive
    let validatingSession = false;
    const heartbeat = setInterval(() => {
      if (socket.readyState !== 1) return;
      if (!info.isAlive) {
        socket.terminate();
        return;
      }
      info.isAlive = false;
      send(socket, 'ping');
      if (userId && !validatingSession) {
        validatingSession = true;
        void users.getUserById(userId).then((user) => {
          if (!user || user.session_version !== info.sessionVersion) closeClient(info, 'Session invalidated');
        }).catch((error) => {
          logger.error('ws', `Session validation failed: ${error instanceof Error ? error.message : String(error)}`);
        }).finally(() => {
          validatingSession = false;
        });
      }
    }, 30000);

    socket.on('message', (msg: Buffer) => {
      info.isAlive = true;
      try {
        const data = JSON.parse(msg.toString());
        if (data.type === 'pong') {
          // The liveness flag was updated before parsing the message.
        } else if (data.type === 'podcast:progress' && userId) {
          // Broadcast podcast progress to other devices of the same user
          const payload = JSON.stringify({ type: 'podcast:progress', data: data.data });
          for (const [otherSocket, info] of clients) {
            if (otherSocket !== socket && otherSocket.readyState === 1 && info.userId === userId) {
              otherSocket.send(payload);
            }
          }
        } else if (data.type === 'connect:register' && userId) {
          const registration = normalizeConnectRegistration(data.data);
          if (!registration) {
            send(socket, 'connect:error', { error: 'Invalid device registration.' });
            return;
          }
          for (const otherInfo of clients.values()) {
            if (otherInfo !== clients.get(socket)
              && otherInfo.userId === userId
              && otherInfo.connect?.deviceId === registration.deviceId) {
              clearPendingCommandsForSocket(otherInfo.socket);
              otherInfo.connect = undefined;
              send(otherInfo.socket, 'connect:replaced', { deviceId: registration.deviceId });
            }
          }
          const info = clients.get(socket);
          if (!info) return;
          info.connect = registration;
          send(socket, 'connect:registered', { deviceId: registration.deviceId });
          sendConnectDevices(userId);
        } else if (data.type === 'connect:state' && userId) {
          const info = clients.get(socket);
          if (!info?.connect) return;
          info.connect.state = normalizeConnectState(data.data);
          sendConnectDevices(userId);
        } else if (data.type === 'connect:request_devices' && userId) {
          send(socket, 'connect:devices', { devices: connectDevicesForUser(userId) });
        } else if (data.type === 'connect:command' && userId) {
          const source = clients.get(socket);
          const command = normalizeConnectCommand(data.data);
          if (!source?.connect || !command) {
            send(socket, 'connect:command_ack', {
              commandId: typeof data.data?.commandId === 'string' ? data.data.commandId : '',
              accepted: false,
              error: 'Invalid MVBar Connect command.',
            });
            return;
          }
          const target = connectClient(userId, command.targetDeviceId);
          if (!target?.connect) {
            send(socket, 'connect:command_ack', {
              commandId: command.commandId,
              targetDeviceId: command.targetDeviceId,
              accepted: false,
              error: 'That player is no longer available.',
            });
            sendConnectDevices(userId);
            return;
          }
          if (!target.connect.capabilities.includes('remote-control')) {
            send(socket, 'connect:command_ack', {
              commandId: command.commandId,
              targetDeviceId: command.targetDeviceId,
              accepted: false,
              error: 'That player does not support remote control.',
            });
            return;
          }
          if (command.command === 'play_next' && !target.connect.capabilities.includes('play-next')) {
            send(socket, 'connect:command_ack', {
              commandId: command.commandId,
              targetDeviceId: command.targetDeviceId,
              accepted: false,
              error: 'Update that player before using Play next remotely.',
            });
            return;
          }
          const payload = safeCommandPayload(command.command, command.payload);
          if (command.command === 'play_index' || command.command === 'remove_index' || command.command === 'reorder') {
            const fields = command.command === 'reorder' ? ['from', 'to'] : ['index'];
            const indices = target.connect.state.queueIndices;
            if (fields.some((field) => !Number.isInteger(command.payload[field]) || indices[Number(command.payload[field])] == null)) {
              send(socket, 'connect:command_ack', { commandId: command.commandId, accepted: false, error: 'That queue item is no longer available.' });
              return;
            }
            for (const field of fields) (payload as Record<string, unknown>)[field] = indices[Number(command.payload[field])];
          }
          if ((command.command === 'add_tracks' || command.command === 'play_next') && Array.isArray(command.payload.tracks) && command.payload.tracks.length > 500) {
            send(socket, 'connect:command_ack', { commandId: command.commandId, accepted: false, error: 'Add up to 500 tracks at a time with MVBar Connect.' });
            return;
          }
          const confirmsCommands = target.connect.capabilities.includes('command-results-v1');
          if (confirmsCommands && !beginPendingCommand({
            controllerSocket: socket,
            targetSocket: target.socket,
            userId,
            targetDeviceId: command.targetDeviceId,
            commandId: command.commandId,
          })) {
            send(socket, 'connect:command_ack', {
              commandId: command.commandId,
              targetDeviceId: command.targetDeviceId,
              accepted: false,
              error: 'A command with that ID is already pending.',
            });
            return;
          }
          send(target.socket, 'connect:command', {
            commandId: command.commandId,
            sourceDeviceId: source.connect.deviceId,
            command: command.command,
            payload,
          });
          if (!confirmsCommands) {
            // Older clients can still be controlled, but cannot confirm execution.
            send(socket, 'connect:command_ack', {
              commandId: command.commandId,
              targetDeviceId: command.targetDeviceId,
              accepted: true,
            });
          }
        } else if (data.type === 'connect:command_result' && userId) {
          const target = clients.get(socket);
          const result = normalizeConnectCommandResult(data.data);
          if (!target?.connect || !result) return;
          const pending = pendingConnectCommands.get(
            pendingCommandKey(userId, target.connect.deviceId, result.commandId),
          );
          if (!pending || pending.targetSocket !== socket) return;
          finishPendingCommand(pending, result.success, result.error || undefined);
        } else if (data.type === 'connect:transfer' && userId) {
          const controller = clients.get(socket);
          const transfer = normalizeConnectTransfer(data.data);
          if (!controller?.connect || !transfer) return;
          const source = connectClient(userId, transfer.sourceDeviceId);
          const target = connectClient(userId, transfer.targetDeviceId);
          const state = source?.connect?.state;
          if (!source?.connect || !target?.connect || source.socket === target.socket || !state || state.queue.length === 0) {
            send(socket, 'connect:command_ack', {
              commandId: transfer.commandId,
              accepted: false,
              error: 'There is no transferable playback on that player.',
            });
            sendConnectDevices(userId);
            return;
          }
          if (!target.connect.capabilities.includes('remote-control') || !target.connect.capabilities.includes('transfer')) {
            send(socket, 'connect:command_ack', {
              commandId: transfer.commandId,
              targetDeviceId: transfer.targetDeviceId,
              accepted: false,
              error: 'That player does not support playback transfer.',
            });
            return;
          }
          const confirmsCommands = target.connect.capabilities.includes('command-results-v1');
          if (confirmsCommands && !beginPendingCommand({
            controllerSocket: socket,
            targetSocket: target.socket,
            userId,
            targetDeviceId: transfer.targetDeviceId,
            commandId: transfer.commandId,
            transferSourceSocket: source.socket,
            transferControllerDeviceId: controller.connect.deviceId,
          })) {
            send(socket, 'connect:command_ack', {
              commandId: transfer.commandId,
              targetDeviceId: transfer.targetDeviceId,
              accepted: false,
              error: 'A transfer with that ID is already pending.',
            });
            return;
          }
          send(target.socket, 'connect:command', {
            commandId: transfer.commandId,
            sourceDeviceId: controller.connect.deviceId,
            command: 'play_tracks',
            payload: {
              tracks: state.queue,
              queueIndex: state.queueIndex,
              positionMs: state.positionMs,
              isPlaying: state.isPlaying,
            },
          });
          if (!confirmsCommands) {
            // Preserve transfer compatibility with clients released before execution results.
            send(source.socket, 'connect:command', {
              commandId: `${transfer.commandId}:pause`,
              sourceDeviceId: controller.connect.deviceId,
              command: 'pause',
              payload: {},
            });
            send(socket, 'connect:command_ack', {
              commandId: transfer.commandId,
              targetDeviceId: transfer.targetDeviceId,
              accepted: true,
            });
          }
        }
      } catch {
        // Ignore invalid messages
      }
    });

    socket.on('close', () => {
      const userToNotify = clients.get(socket)?.connect ? userId : undefined;
      clearPendingCommandsForSocket(socket);
      clients.delete(socket);
      clearInterval(heartbeat);
      if (userToNotify) sendConnectDevices(userToNotify);
      logger.info('ws', `Client disconnected (${clients.size} total)`);
    });

    socket.on('error', (err: Error) => {
      const userToNotify = clients.get(socket)?.connect ? userId : undefined;
      logger.error('ws', `Socket error: ${err.message}`);
      clearPendingCommandsForSocket(socket);
      clients.delete(socket);
      clearInterval(heartbeat);
      if (userToNotify) sendConnectDevices(userToNotify);
    });
  });
}

// Export function to get client count (for health checks)
export function getConnectedClients(): number {
  return clients.size;
}

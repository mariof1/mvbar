import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import Redis from 'ioredis';
import logger from './logger.js';
import {
  normalizeConnectCommand,
  normalizeConnectRegistration,
  normalizeConnectState,
  normalizeConnectTrack,
  normalizeConnectTransfer,
  type ConnectDeviceRegistration,
} from './connectProtocol.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://redis:6379';

// Connected WebSocket clients with user info
interface ClientInfo {
  socket: WebSocket;
  userId?: string;
  isAdmin?: boolean;
  connect?: ConnectDeviceRegistration;
}
const clients = new Map<WebSocket, ClientInfo>();

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
  if (command === 'play_tracks' || command === 'add_tracks') {
    const queue = Array.isArray(payload.tracks)
      ? payload.tracks.slice(0, 500).map(normalizeConnectTrack).filter((track) => track != null)
      : [];
    return {
      tracks: queue,
      queueIndex: Math.max(0, Math.min(queue.length - 1, Math.trunc(Number(payload.queueIndex) || 0))),
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
  await app.register(websocket);

  // Subscribe to Redis for library updates from worker
  const subscriber = new Redis(REDIS_URL);
  
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

  // WebSocket endpoint for clients
  app.get('/api/ws', { websocket: true }, (socket, req) => {
    // Get user ID from the request if authenticated
    const userId = req.user?.userId;
    const isAdmin = req.user?.role === 'admin';
    clients.set(socket, { socket, userId, isAdmin });
    logger.info('ws', `Client connected (${clients.size} total)${userId ? ` user=${userId.substring(0, 8)}...` : ''}${isAdmin ? ' (admin)' : ''}`);

    // Send initial connection confirmation
    send(socket, 'connected');

    // Heartbeat to keep connection alive
    const heartbeat = setInterval(() => {
      if (socket.readyState === 1) {
        send(socket, 'ping');
      }
    }, 30000);

    socket.on('message', (msg: Buffer) => {
      // Handle pong or other client messages if needed
      try {
        const data = JSON.parse(msg.toString());
        if (data.type === 'pong') {
          // Client responded to ping
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
          send(target.socket, 'connect:command', {
            commandId: command.commandId,
            sourceDeviceId: source.connect.deviceId,
            command: command.command,
            payload: safeCommandPayload(command.command, command.payload),
          });
          send(socket, 'connect:command_ack', {
            commandId: command.commandId,
            targetDeviceId: command.targetDeviceId,
            accepted: true,
          });
        } else if (data.type === 'connect:transfer' && userId) {
          const controller = clients.get(socket);
          const transfer = normalizeConnectTransfer(data.data);
          if (!controller?.connect || !transfer) return;
          const source = connectClient(userId, transfer.sourceDeviceId);
          const target = connectClient(userId, transfer.targetDeviceId);
          const state = source?.connect?.state;
          if (!source?.connect || !target?.connect || !state || state.queue.length === 0) {
            send(socket, 'connect:command_ack', {
              commandId: transfer.commandId,
              accepted: false,
              error: 'There is no transferable playback on that player.',
            });
            sendConnectDevices(userId);
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
          if (source.socket !== target.socket) {
            send(source.socket, 'connect:command', {
              commandId: `${transfer.commandId}:pause`,
              sourceDeviceId: controller.connect.deviceId,
              command: 'pause',
              payload: {},
            });
          }
          send(socket, 'connect:command_ack', {
            commandId: transfer.commandId,
            targetDeviceId: transfer.targetDeviceId,
            accepted: true,
          });
        }
      } catch {
        // Ignore invalid messages
      }
    });

    socket.on('close', () => {
      const userToNotify = clients.get(socket)?.connect ? userId : undefined;
      clients.delete(socket);
      clearInterval(heartbeat);
      if (userToNotify) sendConnectDevices(userToNotify);
      logger.info('ws', `Client disconnected (${clients.size} total)`);
    });

    socket.on('error', (err: Error) => {
      const userToNotify = clients.get(socket)?.connect ? userId : undefined;
      logger.error('ws', `Socket error: ${err.message}`);
      clients.delete(socket);
      clearInterval(heartbeat);
      if (userToNotify) sendConnectDevices(userToNotify);
    });
  });
});

// Export function to get client count (for health checks)
export function getConnectedClients(): number {
  return clients.size;
}

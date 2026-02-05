import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import Redis from 'ioredis';
import logger from './logger.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://redis:6379';

// Connected WebSocket clients with user info
interface ClientInfo {
  socket: WebSocket;
  userId?: string;
}
const clients = new Map<WebSocket, ClientInfo>();

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
      // Broadcast to all connected WebSocket clients (silent - too noisy)
      broadcast('library:update', JSON.parse(message));
    }
  });

  // WebSocket endpoint for clients
  app.get('/api/ws', { websocket: true }, (socket, req) => {
    // Get user ID from the request if authenticated
    const userId = req.user?.userId;
    clients.set(socket, { socket, userId });
    logger.info('ws', `Client connected (${clients.size} total)${userId ? ` user=${userId.substring(0, 8)}...` : ''}`);

    // Send initial connection confirmation
    socket.send(JSON.stringify({ type: 'connected' }));

    // Heartbeat to keep connection alive
    const heartbeat = setInterval(() => {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify({ type: 'ping' }));
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
        }
      } catch {
        // Ignore invalid messages
      }
    });

    socket.on('close', () => {
      clients.delete(socket);
      clearInterval(heartbeat);
      logger.info('ws', `Client disconnected (${clients.size} total)`);
    });

    socket.on('error', (err: Error) => {
      logger.error('ws', `Socket error: ${err.message}`);
      clients.delete(socket);
      clearInterval(heartbeat);
    });
  });
});

// Export function to get client count (for health checks)
export function getConnectedClients(): number {
  return clients.size;
}

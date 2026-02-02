import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { config } from './config.js';
import { authPlugin } from './auth.js';

const trustProxy = config.trustProxy === 'true';
import { libraryPlugin } from './library.js';
import { smartSearchPlugin } from './smartSearch.js';
import { streamPlugin } from './stream.js';
import { artPlugin } from './art.js';
import { lyricsPlugin } from './lyrics.js';
import { playlistsPlugin } from './playlists.js';
import { browsePlugin } from './browse.js';
import { favoritesPlugin } from './favorites.js';
import { historyPlugin } from './history.js';
import { statsPlugin } from './stats.js';
import { recommendationsPlugin } from './recommendations.js';
import { hlsPlugin } from './hls.js';
import { websocketPlugin } from './websocket.js';
import { smartPlaylistsPlugin } from './smartPlaylists.js';
import { listenbrainzPlugin } from './listenbrainz.js';
import { subsonicPlugin } from './subsonic.js';
import { podcastsPlugin } from './podcasts.js';
import { preferencesPlugin } from './preferences.js';
import googleAuthPlugin, { startAvatarSyncScheduler } from './googleAuth.js';
import { initDb } from './db.js';
import logger from './logger.js';

// Use pino-pretty for human-readable logs
const app = Fastify({
  disableRequestLogging: true,
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        singleLine: true,
        translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
        ignore: 'pid,hostname',
      },
    },
  },
  trustProxy,
});

const ansi = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

function colorStatus(statusCode: number) {
  if (statusCode >= 500) return `${ansi.red}${statusCode}${ansi.reset}`;
  if (statusCode >= 400) return `${ansi.yellow}${statusCode}${ansi.reset}`;
  return `${ansi.green}${statusCode}${ansi.reset}`;
}

await initDb();
logger.success('api', `Server starting on port ${config.port}`);

// Register multipart for file uploads
await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024 } }); // 5MB max

app.addHook('onResponse', async (req, reply) => {
  const method = req.method;
  const url = req.url;
  const status = reply.statusCode;
  const ms = Number((reply.elapsedTime ?? 0).toFixed(1));
  // Keep healthcheck noise out of logs
  if (url === '/health' || url === '/api/health' || url === '/api/healthz') return;
  app.log.info(`${ansi.cyan}${method}${ansi.reset} ${url} -> ${colorStatus(status)} ${ansi.dim}${ms}ms${ansi.reset}`);
});

app.get('/health', async () => ({ ok: true }));
app.get('/api/health', async () => ({ ok: true }));
app.get('/api/healthz', async () => ({ ok: true }));

await app.register(authPlugin);
await app.register(googleAuthPlugin);
await app.register(libraryPlugin);
await app.register(smartSearchPlugin);
await app.register(streamPlugin);
await app.register(artPlugin);
await app.register(lyricsPlugin);
await app.register(playlistsPlugin);
await app.register(browsePlugin);
await app.register(favoritesPlugin);
await app.register(historyPlugin);
await app.register(statsPlugin);
await app.register(recommendationsPlugin);
await app.register(hlsPlugin);
await app.register(websocketPlugin);
await app.register(smartPlaylistsPlugin);
await app.register(listenbrainzPlugin);
await app.register(subsonicPlugin);
await app.register(podcastsPlugin);
await app.register(preferencesPlugin);

const host = '0.0.0.0';
await app.listen({ port: config.port, host });

// Start avatar sync scheduler for Google users
startAvatarSyncScheduler(app.log);

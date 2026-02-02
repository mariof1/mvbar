import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { audit, db } from './db.js';
import * as fav from './favoritesRepo.js';
import { allowedLibrariesForUser, isLibraryAllowed } from './access.js';
import { submitFeedback } from './listenbrainz.js';
import { broadcastToUser } from './websocket.js';

// Get user's ListenBrainz token
async function getUserLBToken(userId: string): Promise<string | null> {
  const r = await db().query<{ listenbrainz_token: string | null }>(
    'SELECT listenbrainz_token FROM users WHERE id = $1',
    [userId]
  );
  return r.rows[0]?.listenbrainz_token || null;
}

export const favoritesPlugin: FastifyPluginAsync = fp(async (app) => {
  app.post('/api/favorites/:trackId', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const trackId = Number((req.params as { trackId: string }).trackId);
    if (!Number.isFinite(trackId)) return reply.code(400).send({ ok: false });

    const r = await db().query<{ library_id: number; title: string; artist: string }>('select library_id, title, artist from active_tracks where id=$1', [trackId]);
    const row = r.rows[0];
    if (!row) return reply.code(404).send({ ok: false });
    const allowed = await allowedLibrariesForUser(req.user.userId, req.user.role);
    if (!isLibraryAllowed(Number(row.library_id), allowed)) return reply.code(404).send({ ok: false });

    await fav.addFavorite(req.user.userId, trackId);
    await audit('favorite_added', { by: req.user.userId, trackId });

    // Broadcast favorite change to all connected clients of this user
    broadcastToUser(req.user.userId, 'favorite:added', { trackId });

    // Submit love to ListenBrainz if connected (fire and forget)
    const lbToken = await getUserLBToken(req.user.userId);
    if (lbToken) {
      submitFeedback(lbToken, { title: row.title, artist: row.artist }, 1).catch(() => {});
    }

    return { ok: true };
  });

  app.delete('/api/favorites/:trackId', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const trackId = Number((req.params as { trackId: string }).trackId);
    if (!Number.isFinite(trackId)) return reply.code(400).send({ ok: false });

    // Get track info for ListenBrainz
    const trackRow = await db().query<{ title: string; artist: string }>('select title, artist from active_tracks where id=$1', [trackId]);

    await fav.removeFavorite(req.user.userId, trackId);
    await audit('favorite_removed', { by: req.user.userId, trackId });

    // Broadcast favorite change to all connected clients of this user
    broadcastToUser(req.user.userId, 'favorite:removed', { trackId });

    // Remove love from ListenBrainz if connected (fire and forget)
    const lbToken = await getUserLBToken(req.user.userId);
    if (lbToken && trackRow.rows[0]) {
      submitFeedback(lbToken, { title: trackRow.rows[0].title, artist: trackRow.rows[0].artist }, 0).catch(() => {});
    }

    return { ok: true };
  });

  app.get('/api/favorites', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const q = req.query as { limit?: string; offset?: string };
    const limit = Math.min(200, Math.max(1, Number(q.limit ?? 100)));
    const offset = Math.max(0, Number(q.offset ?? 0));

    const allowed = await allowedLibrariesForUser(req.user.userId, req.user.role);
    const tracks = await fav.listFavorites(req.user.userId, limit, offset, allowed);
    return { ok: true, tracks, limit, offset };
  });
});

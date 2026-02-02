import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { audit } from './db.js';
import * as playlists from './playlistsRepo.js';

export const playlistsPlugin: FastifyPluginAsync = fp(async (app) => {
  app.get('/api/playlists', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const rows = await playlists.listPlaylists(req.user.userId);
    return { ok: true, playlists: rows };
  });

  app.post('/api/playlists', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const body = req.body as { name?: string };
    const name = (body.name ?? '').trim();
    if (!name) return reply.code(400).send({ ok: false });

    try {
      const pl = await playlists.createPlaylist(req.user.userId, name);
      await audit('playlist_create', { by: req.user.userId, playlistId: pl.id, name });
      return { ok: true, playlist: pl };
    } catch {
      return reply.code(409).send({ ok: false, error: 'conflict' });
    }
  });

  app.get('/api/playlists/:id/items', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const id = Number((req.params as { id: string }).id);
    if (!Number.isFinite(id)) return reply.code(400).send({ ok: false });

    const items = await playlists.listItems(req.user.userId, id);
    if (!items) return reply.code(404).send({ ok: false });
    return { ok: true, items };
  });

  app.post('/api/playlists/:id/items', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const playlistId = Number((req.params as { id: string }).id);
    if (!Number.isFinite(playlistId)) return reply.code(400).send({ ok: false });

    const body = req.body as { trackId?: number; position?: number };
    const trackId = Number(body.trackId);
    if (!Number.isFinite(trackId)) return reply.code(400).send({ ok: false });

    const r = await playlists.addItem(req.user.userId, playlistId, trackId, body.position);
    if (!r) return reply.code(404).send({ ok: false });
    await audit('playlist_add_item', { by: req.user.userId, playlistId, trackId, position: r.position });
    return { ok: true, position: r.position };
  });

  app.delete('/api/playlists/:id/items/:trackId', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const playlistId = Number((req.params as { id: string }).id);
    const trackId = Number((req.params as { trackId: string }).trackId);
    if (!Number.isFinite(playlistId) || !Number.isFinite(trackId)) return reply.code(400).send({ ok: false });

    const r = await playlists.removeItem(req.user.userId, playlistId, trackId);
    if (!r) return reply.code(404).send({ ok: false });
    await audit('playlist_remove_item', { by: req.user.userId, playlistId, trackId });
    return { ok: true };
  });

  app.put('/api/playlists/:id/items/:trackId', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const playlistId = Number((req.params as { id: string }).id);
    const trackId = Number((req.params as { trackId: string }).trackId);
    if (!Number.isFinite(playlistId) || !Number.isFinite(trackId)) return reply.code(400).send({ ok: false });

    const body = req.body as { position?: number };
    const position = Number(body.position);
    if (!Number.isFinite(position)) return reply.code(400).send({ ok: false });

    const r = await playlists.setPosition(req.user.userId, playlistId, trackId, position);
    if (!r) return reply.code(404).send({ ok: false });
    await audit('playlist_set_position', { by: req.user.userId, playlistId, trackId, position });
    return { ok: true };
  });
});

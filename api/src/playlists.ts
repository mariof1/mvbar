import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { allowedLibrariesForUser } from './access.js';
import { audit, db } from './db.js';
import * as playlists from './playlistsRepo.js';
import { sendWebPushToUser } from './pushNotifications.js';
import { broadcastToUser } from './websocket.js';

async function broadcastPlaylist(playlistId: number, type: string, data: Record<string, unknown>, userIds?: string[]) {
  const recipients = userIds ?? await playlists.playlistUserIds(playlistId);
  for (const userId of new Set(recipients)) broadcastToUser(userId, type, data);
}

async function playlistName(playlistId: number) {
  const result = await db().query<{ name: string }>('select name from playlists where id=$1', [playlistId]);
  return result.rows[0]?.name ?? 'a playlist';
}

export const playlistsPlugin: FastifyPluginAsync = fp(async (app) => {
  app.get('/api/playlists', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const allowed = await allowedLibrariesForUser(req.user.userId, req.user.role);
    const rows = await playlists.listPlaylists(req.user.userId, allowed);
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
      broadcastToUser(req.user.userId, 'playlist:created', { id: pl.id, name });
      return { ok: true, playlist: pl };
    } catch {
      return reply.code(409).send({ ok: false, error: 'conflict' });
    }
  });

  app.get('/api/playlists/:id/items', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false });

    const allowed = await allowedLibrariesForUser(req.user.userId, req.user.role);
    const items = await playlists.listItems(req.user.userId, id, allowed);
    if (!items) return reply.code(404).send({ ok: false });
    return { ok: true, items };
  });

  app.post('/api/playlists/:id/items', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const playlistId = Number((req.params as { id: string }).id);
    if (!Number.isInteger(playlistId) || playlistId <= 0) return reply.code(400).send({ ok: false });

    const body = req.body as { trackId?: number; position?: number };
    const trackId = Number(body.trackId);
    const position = body.position === undefined ? undefined : Number(body.position);
    if (!Number.isInteger(trackId) || trackId <= 0 || (position !== undefined && (!Number.isInteger(position) || position < 0))) {
      return reply.code(400).send({ ok: false });
    }

    const allowed = await allowedLibrariesForUser(req.user.userId, req.user.role);
    const r = await playlists.addItem(req.user.userId, playlistId, trackId, allowed, position);
    if (!r) return reply.code(404).send({ ok: false });
    await audit('playlist_add_item', { by: req.user.userId, playlistId, trackId, position: r.position });
    await broadcastPlaylist(playlistId, 'playlist:item_added', {
      playlistId,
      trackId,
      position: r.position,
      by: req.user.userId,
    });
    return { ok: true, position: r.position };
  });

  app.delete('/api/playlists/:id/items/:trackId', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const playlistId = Number((req.params as { id: string }).id);
    const trackId = Number((req.params as { trackId: string }).trackId);
    if (!Number.isInteger(playlistId) || playlistId <= 0 || !Number.isInteger(trackId) || trackId <= 0) {
      return reply.code(400).send({ ok: false });
    }

    const allowed = await allowedLibrariesForUser(req.user.userId, req.user.role);
    const r = await playlists.removeItem(req.user.userId, playlistId, trackId, allowed);
    if (!r) return reply.code(404).send({ ok: false });
    await audit('playlist_remove_item', { by: req.user.userId, playlistId, trackId });
    await broadcastPlaylist(playlistId, 'playlist:item_removed', { playlistId, trackId, by: req.user.userId });
    return { ok: true };
  });

  app.put('/api/playlists/:id/items/:trackId', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const playlistId = Number((req.params as { id: string }).id);
    const trackId = Number((req.params as { trackId: string }).trackId);
    if (!Number.isInteger(playlistId) || playlistId <= 0 || !Number.isInteger(trackId) || trackId <= 0) {
      return reply.code(400).send({ ok: false });
    }

    const body = req.body as { position?: number };
    const position = Number(body.position);
    if (!Number.isInteger(position) || position < 0) return reply.code(400).send({ ok: false });

    const allowed = await allowedLibrariesForUser(req.user.userId, req.user.role);
    const r = await playlists.setPosition(req.user.userId, playlistId, trackId, position, allowed);
    if (!r) return reply.code(404).send({ ok: false });
    await audit('playlist_set_position', { by: req.user.userId, playlistId, trackId, position });
    await broadcastPlaylist(playlistId, 'playlist:updated', { playlistId, by: req.user.userId });
    return { ok: true };
  });

  app.patch('/api/playlists/:id', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false });

    const body = req.body as { name?: string };
    const name = (body.name ?? '').trim();
    if (!name) return reply.code(400).send({ ok: false, error: 'invalid_name' });

    try {
      const updated = await playlists.renamePlaylist(req.user.userId, id, name);
      if (!updated) return reply.code(404).send({ ok: false });
      await audit('playlist_rename', { by: req.user.userId, playlistId: id, name });
      await broadcastPlaylist(id, 'playlist:updated', { playlistId: id, name, by: req.user.userId });
      return { ok: true, playlist: updated };
    } catch {
      return reply.code(409).send({ ok: false, error: 'conflict' });
    }
  });

  app.delete('/api/playlists/:id', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false });

    const recipients = await playlists.playlistUserIds(id);
    const deleted = await playlists.deletePlaylist(req.user.userId, id);
    if (!deleted) return reply.code(404).send({ ok: false });
    await audit('playlist_delete', { by: req.user.userId, playlistId: id });
    await broadcastPlaylist(id, 'playlist:deleted', { id, by: req.user.userId }, recipients);
    return { ok: true, deleted: id };
  });

  app.get('/api/playlists/:id/collaborators', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const playlistId = Number((req.params as { id: string }).id);
    if (!Number.isInteger(playlistId) || playlistId <= 0) return reply.code(400).send({ ok: false });
    const collaboration = await playlists.getCollaboration(req.user.userId, playlistId);
    if (!collaboration) return reply.code(404).send({ ok: false });
    return { ok: true, ...collaboration };
  });

  app.post('/api/playlists/:id/collaborators', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const playlistId = Number((req.params as { id: string }).id);
    const userId = typeof (req.body as { userId?: unknown })?.userId === 'string'
      ? String((req.body as { userId: string }).userId)
      : '';
    if (!Number.isInteger(playlistId) || playlistId <= 0 || !userId || userId === req.user.userId) {
      return reply.code(400).send({ ok: false, error: 'invalid_collaborator' });
    }

    const collaborator = await playlists.addCollaborator(req.user.userId, playlistId, userId);
    if (!collaborator) return reply.code(409).send({ ok: false, error: 'friend_unavailable' });
    const name = await playlistName(playlistId);
    await audit('playlist_collaborator_added', { by: req.user.userId, playlistId, userId });
    await broadcastPlaylist(playlistId, 'playlist:collaborator_added', {
      playlistId,
      name,
      user: collaborator.user,
      by: req.user.userId,
    });
    void sendWebPushToUser(userId, {
      title: 'Playlist shared with you',
      body: `You can now add songs to “${name}”.`,
      tag: `playlist-collaboration-${playlistId}`,
      url: `/#/playlist/${playlistId}`,
    });
    return reply.code(201).send({ ok: true, collaborator });
  });

  app.delete('/api/playlists/:id/collaborators/:userId', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const playlistId = Number((req.params as { id: string }).id);
    const userId = String((req.params as { userId: string }).userId || '');
    if (!Number.isInteger(playlistId) || playlistId <= 0 || !userId) {
      return reply.code(400).send({ ok: false, error: 'invalid_collaborator' });
    }

    const recipients = await playlists.playlistUserIds(playlistId);
    const removed = await playlists.removeCollaborator(req.user.userId, playlistId, userId);
    if (!removed) return reply.code(404).send({ ok: false, error: 'collaborator_not_found' });
    await audit('playlist_collaborator_removed', { by: req.user.userId, playlistId, userId });
    await broadcastPlaylist(playlistId, 'playlist:collaborator_removed', {
      playlistId,
      userId,
      by: req.user.userId,
    }, [...recipients, userId]);
    return { ok: true };
  });
});

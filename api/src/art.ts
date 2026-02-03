import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { db } from './db.js';
import { allowedLibrariesForUser, isLibraryAllowed } from './access.js';

const ART_DIR = process.env.ART_DIR ?? '/data/cache/art';

function safeJoinArt(relPath: string) {
  const abs = path.resolve(ART_DIR, relPath);
  const base = path.resolve(ART_DIR);
  if (!abs.startsWith(base + path.sep)) throw new Error('invalid path');
  return abs;
}

export const artPlugin: FastifyPluginAsync = fp(async (app) => {
  // Direct art path endpoint (for album/artist art)
  app.get('/api/art/*', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });

    const artPath = (req.params as { '*': string })['*'];
    if (!artPath) return reply.code(400).send({ ok: false });

    try {
      const abs = safeJoinArt(artPath);
      const st = await stat(abs);

      // Determine MIME type from extension
      const ext = path.extname(artPath).toLowerCase();
      const mimeTypes: Record<string, string> = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.webp': 'image/webp',
        '.gif': 'image/gif',
      };
      const mime = mimeTypes[ext] || 'image/jpeg';

      // Use hash from path as ETag
      const hash = path.basename(artPath, ext);
      const etag = `"${hash}"`;
      const inm = req.headers['if-none-match'];
      if (inm === etag) return reply.code(304).send();

      reply
        .header('Content-Type', mime)
        .header('Content-Length', String(st.size))
        .header('Cache-Control', 'public, max-age=31536000, immutable')
        .header('ETag', etag);

      return reply.send(createReadStream(abs));
    } catch {
      return reply.code(404).send({ ok: false });
    }
  });

  app.get('/api/library/tracks/:id/art', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });

    const id = Number((req.params as { id: string }).id);
    if (!Number.isFinite(id)) return reply.code(400).send({ ok: false });

    const r = await db().query<{ library_id: number; art_path: string | null; art_mime: string | null; art_hash: string | null }>(
      'select library_id, art_path, art_mime, art_hash from active_tracks where id=$1',
      [id]
    );
    const row = r.rows[0];
    if (!row?.art_path || !row.art_mime) return reply.code(404).send({ ok: false });

    const allowed = await allowedLibrariesForUser(req.user.userId, req.user.role);
    if (!isLibraryAllowed(Number(row.library_id), allowed)) return reply.code(404).send({ ok: false });

    const etag = row.art_hash ? `"${row.art_hash}"` : undefined;
    const inm = req.headers['if-none-match'];
    if (etag && inm === etag) return reply.code(304).send();

    const abs = safeJoinArt(row.art_path);
    const st = await stat(abs);

    reply
      .header('Content-Type', row.art_mime)
      .header('Content-Length', String(st.size))
      .header('Cache-Control', 'private, max-age=3600')
      .header('ETag', etag ?? '');

    return reply.send(createReadStream(abs));
  });

  // Artist artwork endpoint
  app.get('/api/artists/:id/art', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });

    const id = Number((req.params as { id: string }).id);
    if (!Number.isFinite(id)) return reply.code(400).send({ ok: false });

    const r = await db().query<{ art_path: string | null; art_hash: string | null }>(
      'select art_path, art_hash from artists where id=$1',
      [id]
    );
    const row = r.rows[0];
    if (!row?.art_path) return reply.code(404).send({ ok: false });

    const etag = row.art_hash ? `"${row.art_hash}"` : undefined;
    const inm = req.headers['if-none-match'];
    if (etag && inm === etag) return reply.code(304).send();

    try {
      const abs = safeJoinArt(row.art_path);
      const st = await stat(abs);

      // Determine MIME type from extension
      const ext = path.extname(row.art_path).toLowerCase();
      const mimeTypes: Record<string, string> = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.webp': 'image/webp',
      };
      const mime = mimeTypes[ext] || 'image/jpeg';

      reply
        .header('Content-Type', mime)
        .header('Content-Length', String(st.size))
        .header('Cache-Control', 'public, max-age=31536000, immutable')
        .header('ETag', etag ?? '');

      return reply.send(createReadStream(abs));
    } catch {
      return reply.code(404).send({ ok: false });
    }
  });
});

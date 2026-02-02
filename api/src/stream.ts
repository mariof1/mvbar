import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { db } from './db.js';
import { allowedLibrariesForUser, isLibraryAllowed } from './access.js';

function safeJoinMount(mountPath: string, relPath: string) {
  const abs = path.resolve(mountPath, relPath);
  const base = path.resolve(mountPath);
  if (!abs.startsWith(base + path.sep)) throw new Error('invalid path');
  return abs;
}

export const streamPlugin: FastifyPluginAsync = fp(async (app) => {
  app.get('/api/library/tracks/:id/stream', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });

    const id = Number((req.params as { id: string }).id);
    if (!Number.isFinite(id)) return reply.code(400).send({ ok: false });

    const r = await db().query<{ path: string; ext: string; library_id: number; mount_path: string }>(
      'select t.path, t.ext, t.library_id, l.mount_path from active_tracks t join libraries l on l.id=t.library_id where t.id=$1',
      [id]
    );
    const row = r.rows[0];
    if (!row) return reply.code(404).send({ ok: false });

    const allowed = await allowedLibrariesForUser(req.user.userId, req.user.role);
    if (!isLibraryAllowed(Number(row.library_id), allowed)) return reply.code(404).send({ ok: false });

    const abs = safeJoinMount(row.mount_path, row.path);
    const st = await stat(abs);
    const range = req.headers.range;

    const contentType = row.ext === '.mp3' ? 'audio/mpeg' : 'application/octet-stream';

    if (range) {
      const m = /^bytes=(\d+)-(\d+)?$/.exec(range);
      if (!m) return reply.code(416).send();
      const start = Number(m[1]);
      const end = m[2] ? Number(m[2]) : st.size - 1;
      if (start >= st.size || end >= st.size || start > end) return reply.code(416).send();

      reply
        .code(206)
        .header('Content-Range', `bytes ${start}-${end}/${st.size}`)
        .header('Accept-Ranges', 'bytes')
        .header('Content-Length', String(end - start + 1))
        .header('Content-Type', contentType);

      return reply.send(createReadStream(abs, { start, end }));
    }

    reply.header('Content-Length', String(st.size)).header('Accept-Ranges', 'bytes').header('Content-Type', contentType);
    return reply.send(createReadStream(abs));
  });
});

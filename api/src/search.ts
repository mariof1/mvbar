import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { meili } from './meili.js';
import { db } from './db.js';
import { allowedLibrariesForUser } from './access.js';

// Normalize search query for deduplication
function normalizeQuery(q: string): string {
  return q.toLowerCase().trim().replace(/\s+/g, ' ').replace(/['"]/g, '');
}

export const searchPlugin: FastifyPluginAsync = fp(async (app) => {
  app.get('/api/search', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });

    const q = (req.query as { q?: string }).q ?? '';
    const limit = Math.min(50, Math.max(1, Number((req.query as { limit?: string }).limit ?? 20)));
    const offset = Math.max(0, Number((req.query as { offset?: string }).offset ?? 0));

    const index = meili().index('tracks');
    const allowed = await allowedLibrariesForUser(req.user.userId, req.user.role);
    const filter = allowed === null ? undefined : `library_id IN [${allowed.map((x) => String(Number(x))).join(', ')}]`;

    try {
      const res = await index.search(q, {
        limit,
        offset,
        filter,
        attributesToRetrieve: ['id', 'path', 'ext', 'title', 'artist', 'album', 'duration_ms', 'library_id']
      });

      // Log search for recommendations (only meaningful queries, not autocomplete fragments)
      const normalized = normalizeQuery(q);
      if (normalized.length >= 3 && offset === 0) {
        // Don't log if it's just a prefix of a recent search
        const recent = await db().query<{ query_normalized: string }>(
          `select query_normalized from search_logs 
           where user_id = $1 and created_at > now() - interval '5 minutes'
           order by created_at desc limit 5`,
          [req.user.userId]
        );
        const isPrefix = recent.rows.some(r => 
          r.query_normalized.startsWith(normalized) && r.query_normalized.length > normalized.length
        );
        
        if (!isPrefix) {
          await db().query(
            `insert into search_logs(user_id, query, query_normalized, result_count) values ($1, $2, $3, $4)`,
            [req.user.userId, q.trim(), normalized, res.estimatedTotalHits || 0]
          );
        }
      }

      return { ok: true, q, limit, offset, hits: res.hits, estimatedTotalHits: res.estimatedTotalHits };
    } catch (e) {
      // Fresh Meili with no scan yet: index may not exist.
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('Index `tracks` not found')) {
        return { ok: true, q, limit, offset, hits: [], estimatedTotalHits: 0 };
      }
      throw e;
    }
  });
});

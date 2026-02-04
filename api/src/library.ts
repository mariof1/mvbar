import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { audit, db, redis } from './db.js';
import * as scans from './scanRepo.js';
import { allowedLibrariesForUser } from './access.js';
import { store } from './store.js';
import { access, constants } from 'node:fs/promises';
import path from 'node:path';
import NodeID3 from 'node-id3';

function safeJoinMount(mountPath: string, relPath: string) {
  const abs = path.resolve(mountPath, relPath);
  const base = path.resolve(mountPath);
  if (!abs.startsWith(base + path.sep)) throw new Error('invalid path');
  return abs;
}

export const libraryPlugin: FastifyPluginAsync = fp(async (app) => {
  // Scan progress endpoint - available to all authenticated users
  app.get('/api/scan/progress', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    
    try {
      const progress = await redis().get('scan:progress');
      if (progress) {
        return { ok: true, ...JSON.parse(progress) };
      }
      return { ok: true, status: 'idle', filesFound: 0, filesProcessed: 0 };
    } catch {
      return { ok: true, status: 'unknown' };
    }
  });

  // Library stats endpoint
  app.get('/api/admin/library/stats', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ ok: false });

    const [tracksResult, artistsResult, albumsResult, sizeResult, librariesResult] = await Promise.all([
      db().query<{ count: number }>('select count(*)::int as count from active_tracks'),
      db().query<{ count: number }>('select count(distinct artist)::int as count from active_tracks where artist is not null'),
      db().query<{ count: number }>('select count(distinct album)::int as count from active_tracks where album is not null'),
      db().query<{ total_bytes: string }>('select coalesce(sum(size_bytes), 0)::text as total_bytes from active_tracks'),
      db().query<{ count: number }>('select count(*)::int as count from libraries'),
    ]);

    // Count unique genres from active_tracks table (split by semicolon)
    const genresResult = await db().query<{ count: number }>(
      `SELECT COUNT(DISTINCT trim(g))::int as count 
       from active_tracks, unnest(string_to_array(genre, ';')) as g 
       WHERE genre IS NOT NULL AND genre != ''`
    );

    // Count unique countries from active_tracks table (split by semicolon)
    const countriesResult = await db().query<{ count: number }>(
      `SELECT COUNT(DISTINCT trim(c))::int as count 
       from active_tracks, unnest(string_to_array(country, ';')) as c 
       WHERE country IS NOT NULL AND country != ''`
    );

    // Count unique languages from active_tracks table (split by semicolon)
    const languagesResult = await db().query<{ count: number }>(
      `SELECT COUNT(DISTINCT trim(l))::int as count 
       from active_tracks, unnest(string_to_array(language, ';')) as l 
       WHERE language IS NOT NULL AND language != ''`
    );

    // Top genres from active_tracks table
    const topGenres = await db().query<{ genre: string; track_count: number }>(
      `SELECT trim(g) as genre, COUNT(*)::int as track_count 
       from active_tracks, unnest(string_to_array(genre, ';')) as g 
       WHERE genre IS NOT NULL AND genre != ''
       GROUP BY trim(g)
       ORDER BY track_count DESC 
       LIMIT 10`
    );

    // Top countries from active_tracks table
    const topCountries = await db().query<{ country: string; track_count: number }>(
      `SELECT trim(c) as country, COUNT(*)::int as track_count 
       from active_tracks, unnest(string_to_array(country, ';')) as c 
       WHERE country IS NOT NULL AND country != ''
       GROUP BY trim(c)
       ORDER BY track_count DESC 
       LIMIT 10`
    );

    // Format size
    const totalBytes = BigInt(sizeResult.rows[0]?.total_bytes || '0');
    const formatSize = (bytes: bigint) => {
      if (bytes < 1024n) return `${bytes} B`;
      if (bytes < 1024n * 1024n) return `${(Number(bytes) / 1024).toFixed(1)} KB`;
      if (bytes < 1024n * 1024n * 1024n) return `${(Number(bytes) / (1024 * 1024)).toFixed(1)} MB`;
      return `${(Number(bytes) / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    };

    return {
      ok: true,
      stats: {
        tracks: tracksResult.rows[0]?.count || 0,
        artists: artistsResult.rows[0]?.count || 0,
        albums: albumsResult.rows[0]?.count || 0,
        genres: genresResult.rows[0]?.count || 0,
        countries: countriesResult.rows[0]?.count || 0,
        languages: languagesResult.rows[0]?.count || 0,
        libraries: librariesResult.rows[0]?.count || 0,
        totalBytes: totalBytes.toString(),
        totalSize: formatSize(totalBytes),
        topGenres: topGenres.rows,
        topCountries: topCountries.rows,
      },
    };
  });

  // Activity log endpoint - recent file changes from audit log
  app.get('/api/admin/library/activity', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ ok: false });

    const limit = Math.min(100, Math.max(1, Number((req.query as any).limit ?? 50)));
    const offset = Math.max(0, Number((req.query as any).offset ?? 0));

    // Get recent file activity from audit_events table
    const activity = await db().query<{ id: number; event: string; meta: any; ts: Date }>(
      `select id, event, meta, ts
       from audit_events 
       where event in ('track_added', 'track_updated', 'track_removed', 'scan_enqueued', 'scan_started', 'scan_finished')
       order by ts desc 
       limit $1 offset $2`,
      [limit, offset]
    );

    return {
      ok: true,
      activity: activity.rows.map(r => ({
        id: r.id,
        action: r.event,
        details: typeof r.meta === 'string' ? JSON.parse(r.meta) : r.meta,
        created_at: r.ts instanceof Date ? r.ts.toISOString() : r.ts
      })),
      limit,
      offset,
    };
  });

  app.post('/api/admin/library/scan', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ ok: false });
    const qs = req.query as { force?: string };
    const force = qs.force === 'true';
    const jobId = await scans.enqueueScan(req.user.userId, force);
    await audit('scan_enqueued', { jobId, by: req.user.userId, force });
    return { ok: true, jobId };
  });

  // Trigger immediate rescan via Redis pub/sub
  app.post('/api/admin/library/rescan', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ ok: false });
    const qs = req.query as { force?: string };
    const force = qs.force === 'true';
    await redis().publish('library:commands', JSON.stringify({ command: 'rescan', by: req.user.userId, force }));
    await audit('rescan_triggered', { by: req.user.userId, force });
    return { ok: true, message: force ? 'Force full scan triggered' : 'Rescan triggered' };
  });

  // Whether any mounted library is writable inside the container
  app.get('/api/admin/library/writable', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ ok: false });
    const r = await db().query<{ id: number; mount_path: string }>('select id, mount_path from libraries order by mount_path asc');

    const results = await Promise.all(
      r.rows.map(async (l) => {
        try {
          await access(l.mount_path, constants.W_OK);
          return { id: l.id, mount_path: l.mount_path, writable: true };
        } catch {
          return { id: l.id, mount_path: l.mount_path, writable: false };
        }
      })
    );

    const writable = results.filter((x) => x.writable).map((x) => x.mount_path);
    return { ok: true, anyWritable: writable.length > 0, writableMounts: writable, libraries: results };
  });

  // Edit track metadata (MP3 only) for writable libraries
  app.post('/api/admin/tracks/:id/metadata', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ ok: false });

    const id = Number((req.params as { id: string }).id);
    if (!Number.isFinite(id)) return reply.code(400).send({ ok: false, error: 'Invalid track id' });

    const body = (req.body ?? {}) as {
      title?: string | null;
      artists?: string[] | null;
      album?: string | null;
      albumArtist?: string | null;
      trackNumber?: number | null;
      discNumber?: number | null;
      year?: number | null;
      genre?: string | null;
      country?: string | null;
      language?: string | null;
    };

    const r = await db().query<{ path: string; ext: string; library_id: number; mount_path: string }>(
      'select t.path, t.ext, t.library_id, l.mount_path from active_tracks t join libraries l on l.id=t.library_id where t.id=$1',
      [id]
    );
    const row = r.rows[0];
    if (!row) return reply.code(404).send({ ok: false, error: 'Track not found' });

    if ((row.ext ?? '').toLowerCase() !== '.mp3') {
      return reply.code(400).send({ ok: false, error: 'Only .mp3 files are editable (v1)' });
    }

    // Must be writable
    try {
      await access(row.mount_path, constants.W_OK);
    } catch {
      return reply.code(400).send({ ok: false, error: `Library mount is not writable: ${row.mount_path}` });
    }

    const abs = safeJoinMount(row.mount_path, row.path);

    // Normalize inputs
    const normStr = (s: any) => {
      if (s === undefined) return undefined;
      if (s === null) return null;
      const v = String(s).trim();
      return v === '' ? null : v;
    };

    const normNum = (n: any) => {
      if (n === undefined) return undefined;
      if (n === null) return null;
      const v = Number(n);
      if (!Number.isFinite(v) || v <= 0) return null;
      return Math.floor(v);
    };

    const title = normStr(body.title);
    const album = normStr(body.album);
    const albumArtist = normStr(body.albumArtist);
    const genre = normStr(body.genre);
    const country = normStr(body.country);
    const language = normStr(body.language);
    const year = normNum(body.year);
    const trackNumber = normNum(body.trackNumber);
    const discNumber = normNum(body.discNumber);

    const artistsList = body.artists === undefined
      ? undefined
      : (body.artists ?? [])
          .map((x) => String(x ?? '').trim())
          .filter(Boolean);

    const tags: Record<string, any> = {};
    if (title !== undefined) tags.title = title ?? '';
    if (album !== undefined) tags.album = album ?? '';
    if (genre !== undefined) tags.genre = genre ?? '';

    if (country !== undefined || language !== undefined) {
      const txxx: Array<{ description: string; value: string }> = [];
      if (country !== undefined) txxx.push({ description: 'Country', value: country ?? '' });
      if (language !== undefined) txxx.push({ description: 'Language', value: language ?? '' });
      tags.TXXX = txxx;
    }

    if (year !== undefined) tags.year = year ?? '';
    if (trackNumber !== undefined) tags.trackNumber = trackNumber ?? '';
    if (discNumber !== undefined) tags.partOfSet = discNumber ?? '';

    if (artistsList !== undefined) {
      const joined = artistsList.join('; ');
      tags.artist = joined;
      tags.raw = { ...(tags.raw ?? {}), TPE1: joined };
    }

    if (albumArtist !== undefined) {
      tags.performerInfo = albumArtist ?? '';
      tags.raw = { ...(tags.raw ?? {}), TPE2: albumArtist ?? '' };
    }

    try {
      const ok = NodeID3.update(tags, abs);
      if (ok !== true) {
        return reply.code(500).send({ ok: false, error: ok instanceof Error ? ok.message : 'Failed to write tags' });
      }
    } catch (e: any) {
      return reply.code(500).send({ ok: false, error: e?.message ?? String(e) });
    }

    await audit('track_metadata_updated', { trackId: id, by: req.user.userId });

    // Force rescan so DB reflects new tags
    await redis().publish('library:commands', JSON.stringify({ command: 'rescan', by: req.user.userId, force: true }));

    return { ok: true };
  });

  app.get('/api/admin/library/scan/status', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ ok: false });
    const job = await scans.getLatestJob();
    return { ok: true, job };
  });

  app.get('/api/admin/libraries', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ ok: false });
    const r = await db().query<{ id: number; mount_path: string }>('select id, mount_path from libraries order by mount_path asc');
    return { ok: true, libraries: r.rows };
  });

  app.get('/api/library/tracks', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });

    const q = (req.query as { limit?: string; offset?: string }).limit;
    const limit = Math.min(200, Math.max(1, Number(q ?? 50)));
    const offset = Math.max(0, Number((req.query as { offset?: string }).offset ?? 0));

    const allowed = await allowedLibrariesForUser(req.user.userId, req.user.role);
    const where = allowed === null ? '' : `where library_id = any($3)`;
    const params = allowed === null ? [limit, offset] : [limit, offset, allowed];

    const r = await db().query(
      `select id, path, ext, title, artist, album, duration_ms, library_id from active_tracks ${where} order by artist nulls last, album nulls last, title nulls last, id asc limit $1 offset $2`,
      params as any
    );

    return { ok: true, tracks: r.rows, limit, offset };
  });

  // Rate limit bypass management
  app.get('/api/admin/rate-limit/bypass', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ ok: false });
    return { ok: true, ips: Array.from(store.rateLimitBypassIPs) };
  });

  app.post('/api/admin/rate-limit/bypass', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ ok: false });
    const { ip } = req.body as { ip?: string };
    if (!ip) return reply.code(400).send({ ok: false, error: 'IP required' });
    store.rateLimitBypassIPs.add(ip);
    await audit('rate_limit_bypass_added', { ip, by: req.user.userId });
    return { ok: true, ips: Array.from(store.rateLimitBypassIPs) };
  });

  app.delete('/api/admin/rate-limit/bypass', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ ok: false });
    const { ip } = req.body as { ip?: string };
    if (!ip) return reply.code(400).send({ ok: false, error: 'IP required' });
    store.rateLimitBypassIPs.delete(ip);
    await audit('rate_limit_bypass_removed', { ip, by: req.user.userId });
    return { ok: true, ips: Array.from(store.rateLimitBypassIPs) };
  });

  // Get current request IP (useful for adding your own IP)
  app.get('/api/admin/rate-limit/my-ip', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ ok: false });
    // Get the real client IP from X-Forwarded-For or X-Real-IP headers
    const xff = req.headers['x-forwarded-for'];
    const xRealIP = req.headers['x-real-ip'];
    const realIP = xff 
      ? (Array.isArray(xff) ? xff[0] : xff.split(',')[0].trim())
      : (xRealIP as string) || req.ip;
    return { ok: true, ip: realIP };
  });
});

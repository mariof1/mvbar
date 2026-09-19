import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { audit, db, redis } from './db.js';
import { allowedLibrariesForUser } from './access.js';
import { normalizeRateLimitBypassIP } from './store.js';
import {
  addRateLimitBypassIP,
  refreshRateLimitBypassIPs,
  removeRateLimitBypassIP,
} from './rateLimitBypass.js';
import { access, constants } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolveInside } from './pathSafety.js';
import { artistDisplay } from './artistDisplay.js';
import { deezerStagingConfig } from './pluginSystem/deezerStaging.js';
import { probeWritableDirectory } from './libraryWritability.js';
import path from 'node:path';

const LIBRARY_READ_ONLY = process.env.LIBRARY_READ_ONLY === '1';
const LIBRARY_PROBE_TIMEOUT_MS = 3000;
const AUDIO_METADATA_EDITOR = fileURLToPath(new URL('../scripts/edit_audio_metadata.py', import.meta.url));
const EDITABLE_AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.m4a', '.mp4', '.ogg', '.opus', '.wav']);
const METADATA_REFRESH_TIMEOUT_MS = 30_000;

type MetadataUpdate = {
  title?: string | null;
  artists?: string[] | null;
  album?: string | null;
  albumArtists?: string[] | null;
  genres?: string[] | null;
  countries?: string[] | null;
  languages?: string[] | null;
  trackNumber?: number | null;
  trackTotal?: number | null;
  discNumber?: number | null;
  discTotal?: number | null;
  releaseDate?: string | null;
  originalYear?: number | null;
  bpm?: number | null;
  initialKey?: string | null;
  composers?: string[] | null;
  conductors?: string[] | null;
  publisher?: string | null;
  copyright?: string | null;
  comment?: string | null;
  mood?: string | null;
  grouping?: string | null;
  isrc?: string | null;
  compilation?: boolean | null;
  titleSort?: string | null;
  artistSort?: string | null;
  albumSort?: string | null;
  albumArtistSort?: string | null;
  musicbrainzTrackId?: string | null;
  musicbrainzReleaseId?: string | null;
  musicbrainzArtistId?: string | null;
  musicbrainzAlbumArtistId?: string | null;
};

function isWritableStagingLibrary(library: { mount_path: string; source_plugin_id: string | null }) {
  const staging = deezerStagingConfig().directory;
  return library.source_plugin_id === 'mvbar.missing-music' && Boolean(staging) && path.resolve(library.mount_path) === staging;
}

function safeJoinMount(mountPath: string, relPath: string) {
  return resolveInside(mountPath, relPath);
}

async function probeAccess(target: string, mode?: number): Promise<boolean | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      access(target, mode)
        .then(() => true)
        .catch(() => false),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), LIBRARY_PROBE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function runAudioMetadataEditor(file: string, values: MetadataUpdate): Promise<void> {
  const python = process.env.METADATA_PYTHON?.trim() || deezerStagingConfig().python;
  return new Promise((resolve, reject) => {
    const child = spawn(python, [AUDIO_METADATA_EDITOR, file], {
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('Metadata update timed out'));
    }, 180_000);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    child.stderr.on('data', chunk => {
      stderr = (stderr + String(chunk)).slice(-1500);
    });
    child.stdin.on('error', error => finish(new Error(`Could not send metadata update: ${error.message}`)));
    child.on('error', error => finish(new Error(`Could not start metadata editor: ${error.message}`)));
    child.on('close', code => finish(code === 0 ? undefined : new Error(stderr.trim() || 'Metadata update failed')));
    child.stdin.end(JSON.stringify(values));
  });
}

async function waitForMetadataRefresh(requestId: string) {
  const key = `metadata:refresh:${requestId}`;
  const deadline = Date.now() + METADATA_REFRESH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const raw = await redis().get(key);
    if (raw) {
      await redis().del(key).catch(() => undefined);
      try {
        return JSON.parse(raw) as { ok: boolean; trackId?: number; error?: string };
      } catch {
        return { ok: false, error: 'Worker returned an invalid metadata refresh result' };
      }
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return { ok: false, error: 'Tags were written, but the library refresh timed out' };
}

function cleanString(value: unknown) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = String(value).trim();
  return text || null;
}

function cleanInteger(value: unknown, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > max) return null;
  return Math.floor(number);
}

function cleanStringList(value: unknown) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const input = Array.isArray(value) ? value : String(value).split(/(?:\u0000|\\n|\r?\n)+/);
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of input) {
    const text = String(item ?? '').trim();
    if (!text) continue;
    const key = text.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(text);
  }
  return output;
}

function cleanReleaseDate(value: unknown) {
  const text = cleanString(value);
  if (text == null || text === undefined) return text;
  if (!/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(text)) return null;
  return text;
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
      db().query<{ count: number }>('select count(*)::int as count from libraries where enabled = true'),
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
    const jobId = `scan-${Date.now()}`;
    const listeners = await redis().publish(
      'library:commands',
      JSON.stringify({ command: 'rescan', by: req.user.userId, force })
    );
    if (listeners === 0) {
      return reply.code(503).send({ ok: false, error: 'Library worker is unavailable' });
    }
    await audit('scan_enqueued', { jobId, by: req.user.userId, force });
    return { ok: true, jobId, message: force ? 'Force full scan triggered' : 'Rescan triggered' };
  });

  // Trigger immediate rescan via Redis pub/sub
  app.post('/api/admin/library/rescan', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ ok: false });
    const qs = req.query as { force?: string };
    const forceQs = qs.force === 'true';
    const forceBody = Boolean((req.body as any)?.force);
    const force = forceQs || forceBody;
    const listeners = await redis().publish(
      'library:commands',
      JSON.stringify({ command: 'rescan', by: req.user.userId, force })
    );
    if (listeners === 0) {
      return reply.code(503).send({ ok: false, error: 'Library worker is unavailable' });
    }
    await audit('rescan_triggered', { by: req.user.userId, force });
    return { ok: true, message: force ? 'Force full scan triggered' : 'Rescan triggered' };
  });

  // Request cancellation of an in-progress scan (best-effort)
  app.post('/api/admin/library/scan/cancel', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ ok: false });
    await redis().publish('library:commands', JSON.stringify({ command: 'cancel_scan', by: req.user.userId }));
    await audit('scan_cancel_requested', { by: req.user.userId });
    return { ok: true };
  });

  // Whether any mounted library is writable inside the container
  app.get('/api/admin/library/writable', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ ok: false });
    const r = await db().query<{ id: number; mount_path: string; media_type: string; source_plugin_id: string | null }>(
      'select id, mount_path, media_type, source_plugin_id from libraries where enabled = true order by media_type, mount_path asc'
    );
    const results = await Promise.all(
      r.rows.map(async (l) => {
        const writable = (!LIBRARY_READ_ONLY || isWritableStagingLibrary(l)) && await probeWritableDirectory(l.mount_path);
        return { id: l.id, mount_path: l.mount_path, media_type: l.media_type, writable };
      })
    );

    const writable = results.filter((x) => x.writable).map((x) => x.mount_path);
    return { ok: true, anyWritable: writable.length > 0, writableMounts: writable, libraries: results };
  });

  // Edit metadata on writable music files. The file update is atomic and
  // the request does not return success until the worker has re-read the exact
  // file, updated PostgreSQL relations, and refreshed the search index.
  app.post('/api/admin/tracks/:id/metadata', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ ok: false });

    const id = Number((req.params as { id: string }).id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return reply.code(400).send({ ok: false, error: 'Invalid track id' });
    }

    const body = (req.body ?? {}) as Record<string, unknown> & {
      albumArtist?: unknown; // backwards-compatible legacy field
      genre?: unknown;
      country?: unknown;
      language?: unknown;
      year?: unknown;
    };

    const result = await db().query<{
      path: string;
      ext: string;
      library_id: number;
      mount_path: string;
      source_plugin_id: string | null;
    }>(
      'select t.path, t.ext, t.library_id, l.mount_path, l.source_plugin_id from active_tracks t join libraries l on l.id=t.library_id where t.id=$1',
      [id]
    );
    const row = result.rows[0];
    if (!row) return reply.code(404).send({ ok: false, error: 'Track not found' });

    if (LIBRARY_READ_ONLY && !isWritableStagingLibrary(row)) {
      return reply.code(403).send({ ok: false, error: 'Library writes are disabled' });
    }

    const extension = (row.ext ?? path.extname(row.path)).toLowerCase();
    if (!EDITABLE_AUDIO_EXTENSIONS.has(extension)) {
      return reply.code(400).send({
        ok: false,
        error: `Metadata editing is not supported for ${extension || 'this format'} files`,
      });
    }

    if (!await probeWritableDirectory(row.mount_path)) {
      return reply.code(400).send({ ok: false, error: `Library mount is not writable: ${row.mount_path}` });
    }

    const abs = safeJoinMount(row.mount_path, row.path);
    if (await probeAccess(abs, constants.W_OK) !== true) {
      return reply.code(400).send({ ok: false, error: 'Track file is not writable' });
    }

    const values: MetadataUpdate = {};
    const setString = (field: keyof MetadataUpdate, source: unknown) => {
      if (source !== undefined) (values as Record<string, unknown>)[field] = cleanString(source);
    };
    const setList = (field: keyof MetadataUpdate, source: unknown) => {
      if (source !== undefined) (values as Record<string, unknown>)[field] = cleanStringList(source);
    };
    const setInt = (field: keyof MetadataUpdate, source: unknown, max?: number) => {
      if (source !== undefined) (values as Record<string, unknown>)[field] = cleanInteger(source, max);
    };

    setString('title', body.title);
    setList('artists', body.artists);
    setString('album', body.album);
    setList('albumArtists', body.albumArtists !== undefined ? body.albumArtists : body.albumArtist);
    setList('genres', body.genres !== undefined ? body.genres : body.genre);
    setList('countries', body.countries !== undefined ? body.countries : body.country);
    setList('languages', body.languages !== undefined ? body.languages : body.language);
    setInt('trackNumber', body.trackNumber, 9999);
    setInt('trackTotal', body.trackTotal, 9999);
    setInt('discNumber', body.discNumber, 999);
    setInt('discTotal', body.discTotal, 999);

    if (body.releaseDate !== undefined || body.year !== undefined) {
      const releaseDate = cleanReleaseDate(body.releaseDate !== undefined ? body.releaseDate : body.year);
      if (releaseDate === null && cleanString(body.releaseDate !== undefined ? body.releaseDate : body.year) !== null) {
        return reply.code(400).send({ ok: false, error: 'Release date must be YYYY, YYYY-MM or YYYY-MM-DD' });
      }
      values.releaseDate = releaseDate;
    }

    setInt('originalYear', body.originalYear, 9999);
    setInt('bpm', body.bpm, 1000);
    setString('initialKey', body.initialKey);
    setList('composers', body.composers);
    setList('conductors', body.conductors);
    setString('publisher', body.publisher);
    setString('copyright', body.copyright);
    setString('comment', body.comment);
    setString('mood', body.mood);
    setString('grouping', body.grouping);
    setString('isrc', body.isrc);
    if (body.compilation !== undefined) values.compilation = body.compilation === null ? null : Boolean(body.compilation);
    setString('titleSort', body.titleSort);
    setString('artistSort', body.artistSort);
    setString('albumSort', body.albumSort);
    setString('albumArtistSort', body.albumArtistSort);
    setString('musicbrainzTrackId', body.musicbrainzTrackId);
    setString('musicbrainzReleaseId', body.musicbrainzReleaseId);
    setString('musicbrainzArtistId', body.musicbrainzArtistId);
    setString('musicbrainzAlbumArtistId', body.musicbrainzAlbumArtistId);

    if (Object.keys(values).length === 0) {
      return reply.code(400).send({ ok: false, error: 'No metadata changes were supplied' });
    }

    try {
      await runAudioMetadataEditor(abs, values);
    } catch (error) {
      return reply.code(500).send({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const refreshRequestId = randomUUID();
    const refreshKey = `metadata:refresh:${refreshRequestId}`;
    await redis().del(refreshKey);
    await redis().publish('library:commands', JSON.stringify({
      command: 'refresh_track_metadata',
      requestId: refreshRequestId,
      by: req.user.userId,
      mountPath: row.mount_path,
      path: row.path,
      fields: Object.keys(values),
    }));

    const refreshed = await waitForMetadataRefresh(refreshRequestId);
    if (!refreshed.ok) {
      await audit('track_metadata_refresh_failed', {
        trackId: id,
        by: req.user.userId,
        extension,
        error: refreshed.error,
      });
      return reply.code(503).send({
        ok: false,
        tagsWritten: true,
        error: refreshed.error || 'Tags were written but MVBar could not refresh the library entry',
      });
    }

    const updated = (await db().query(
      `select id, title, artist, album_artist, album, genre, country, language, year,
              track_number, track_total, disc_number, disc_total, bpm, initial_key,
              composer, conductor, publisher, copyright, comment, mood, grouping,
              isrc, release_date, original_year, compilation,
              title_sort, artist_sort, album_sort, album_artist_sort,
              musicbrainz_track_id, musicbrainz_release_id, musicbrainz_artist_id,
              musicbrainz_album_artist_id, updated_at
         from active_tracks where id=$1`,
      [id]
    )).rows[0] ?? null;

    await audit('track_metadata_updated', {
      trackId: id,
      by: req.user.userId,
      extension,
      fields: Object.keys(values),
    });

    return { ok: true, track: updated };
  });

  app.get('/api/admin/library/scan/status', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ ok: false });
    const raw = await redis().get('scan:progress');
    if (!raw) return { ok: true, job: null };
    try {
      const progress = JSON.parse(raw);
      const state = progress.status === 'error'
        ? 'failed'
        : progress.status === 'scanning' || progress.status === 'indexing'
          ? 'running'
          : 'done';
      return { ok: true, job: { ...progress, state } };
    } catch {
      return { ok: true, job: null };
    }
  });

  app.get('/api/admin/libraries', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ ok: false });
    const r = await db().query<{ id: number; mount_path: string; media_type: string; source_plugin_id: string | null }>(
      'select id, mount_path, media_type, source_plugin_id from libraries where enabled = true order by media_type, mount_path asc'
    );

    const libraries = await Promise.all(
      r.rows.map(async (l) => {
        const mounted = await probeAccess(l.mount_path);

        let writable = false;
        if ((!LIBRARY_READ_ONLY || isWritableStagingLibrary(l)) && mounted === true) {
          writable = await probeWritableDirectory(l.mount_path);
        }

        return {
          id: l.id,
          mount_path: l.mount_path,
          media_type: l.media_type,
          mounted: mounted ?? undefined,
          writable,
          read_only: mounted === true ? !writable : undefined,
        };
      })
    );

    return { ok: true, libraries };
  });

  // Delete a library (admin-only). Intended for removing stale/unmounted mount paths.
  // Behavior: soft-delete all tracks for that library, then delete the library row.
  app.delete('/api/admin/libraries/:id', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ ok: false });

    const id = Number((req.params as { id: string }).id);
    if (!Number.isFinite(id)) return reply.code(400).send({ ok: false, error: 'Invalid library id' });

    const libR = await db().query<{ id: number; mount_path: string; source_plugin_id: string | null }>('select id, mount_path, source_plugin_id from libraries where id=$1', [id]);
    const lib = libR.rows[0];
    if (!lib) return reply.code(404).send({ ok: false, error: 'Library not found' });
    if (lib.source_plugin_id && process.env.DEEZER_DOWNLOAD_DIR?.trim() && lib.mount_path === path.resolve(process.env.DEEZER_DOWNLOAD_DIR.trim())) {
      return reply.code(409).send({ ok: false, error: 'Remove DEEZER_DOWNLOAD_DIR from the server configuration before deleting its managed library' });
    }

    const force = ((req.query as any)?.force ?? '') === 'true';
    const mounted = await probeAccess(lib.mount_path);
    if (mounted !== false && !force) {
      const error = mounted === true
        ? 'Library is mounted; pass ?force=true to delete anyway'
        : 'Library mount status could not be verified; pass ?force=true to delete anyway';
      return reply.code(400).send({ ok: false, error });
    }

    const cntR = await db().query<{ count: number }>('select count(*)::int as count from tracks where library_id=$1 and deleted_at is null', [id]);
    const activeTracks = cntR.rows[0]?.count ?? 0;

    await db().query('update tracks set deleted_at = coalesce(deleted_at, now()) where library_id=$1', [id]);
    await db().query('delete from libraries where id=$1', [id]);

    await audit('library_deleted', { id, mount_path: lib.mount_path, activeTracks, by: req.user.userId, force });
    return { ok: true, id, mount_path: lib.mount_path, activeTracks };
  });

  app.get('/api/library/tracks', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });

    const qs = req.query as { limit?: string; offset?: string; sort?: string; order?: string };
    const limit = Math.min(200, Math.max(1, Number(qs.limit ?? 50)));
    const offset = Math.max(0, Number(qs.offset ?? 0));

    const sortMap: Record<string, string> = {
      created_at: 'created_at',
      added: 'created_at',
      updated_at: 'updated_at',
      title: 'title',
      artist: 'artist',
      album: 'album',
      year: 'year',
      duration: 'duration_ms',
    };
    const sortCol = sortMap[(qs.sort ?? '').toLowerCase()] ?? null;
    const orderDir = (qs.order ?? '').toLowerCase() === 'asc' ? 'asc' : 'desc';
    const orderBy = sortCol
      ? `order by ${sortCol} ${orderDir} nulls last, id ${orderDir}`
      : `order by artist nulls last, album nulls last, title nulls last, id asc`;

    const allowed = await allowedLibrariesForUser(req.user.userId, req.user.role);
    const where = allowed === null ? '' : `where library_id = any($3)`;
    const params = allowed === null ? [limit, offset] : [limit, offset, allowed];

    const r = await db().query(
      `select id, path, ext, title, artist, album_artist, album, duration_ms,
              library_id, created_at, updated_at, art_path, art_hash,
              genre, country, language, year, bpm, track_number, disc_number, source_plugin_id
       from active_tracks ${where} ${orderBy} limit $1 offset $2`,
      params as any
    );

    const tracks = r.rows.map((track: any) => ({
      ...track,
      // Track surfaces always use performers; album ownership is exposed
      // separately for album headers/cards.
      display_artist: artistDisplay(track.artist, track.album_artist),
      display_album_artist: artistDisplay(track.album_artist, track.artist),
    }));

    return { ok: true, tracks, limit, offset };
  });

  // Rate limit bypass management
  app.get('/api/admin/rate-limit/bypass', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ ok: false });
    return { ok: true, ips: await refreshRateLimitBypassIPs() };
  });

  app.post('/api/admin/rate-limit/bypass', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ ok: false });
    const { ip } = (req.body ?? {}) as { ip?: string };
    const result = await addRateLimitBypassIP(ip ?? '', req.user.userId);
    if (!result) return reply.code(400).send({ ok: false, error: 'Valid IP address required' });
    await audit('rate_limit_bypass_added', { ip: result.ip, by: req.user.userId });
    return { ok: true, ips: result.ips };
  });

  app.delete('/api/admin/rate-limit/bypass', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ ok: false });
    const { ip } = (req.body ?? {}) as { ip?: string };
    const result = await removeRateLimitBypassIP(ip ?? '');
    if (!result) return reply.code(400).send({ ok: false, error: 'Valid IP address required' });
    await audit('rate_limit_bypass_removed', { ip: result.ip, by: req.user.userId });
    return { ok: true, ips: result.ips };
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
    return { ok: true, ip: normalizeRateLimitBypassIP(realIP) ?? realIP };
  });
});

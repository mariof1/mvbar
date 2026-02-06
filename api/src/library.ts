import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { audit, db, redis } from './db.js';
import * as scans from './scanRepo.js';
import { allowedLibrariesForUser } from './access.js';
import { store } from './store.js';
import { access, constants } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function safeJoinMount(mountPath: string, relPath: string) {
  const abs = path.resolve(mountPath, relPath);
  const base = path.resolve(mountPath);
  if (!abs.startsWith(base + path.sep)) throw new Error('invalid path');
  return abs;
}

type Id3Frame = { id: string; data: Buffer; flags: Buffer; txxxDescription?: string };

function decodeSyncSafeInt(buf: Buffer) {
  // 4 bytes, 7 bits each
  return ((buf[0] & 0x7f) << 21) | ((buf[1] & 0x7f) << 14) | ((buf[2] & 0x7f) << 7) | (buf[3] & 0x7f);
}

function encodeSyncSafeInt(n: number) {
  return Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
}

function encodeUtf16WithBom(s: string) {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]);
}

function decodeText(buf: Buffer, encodingByte: number) {
  if (!buf.length) return '';
  if (encodingByte === 0x01 || encodingByte === 0x02) {
    // UTF-16 with/without BOM (best-effort)
    if (buf.length >= 2) {
      const b0 = buf[0];
      const b1 = buf[1];
      if (b0 === 0xff && b1 === 0xfe) return buf.subarray(2).toString('utf16le');
      if (b0 === 0xfe && b1 === 0xff) {
        const swapped = Buffer.alloc(buf.length - 2);
        for (let i = 2; i + 1 < buf.length; i += 2) {
          swapped[i - 2] = buf[i + 1];
          swapped[i - 1] = buf[i];
        }
        return swapped.toString('utf16le');
      }
    }
    // Assume LE
    return buf.toString('utf16le');
  }
  if (encodingByte === 0x03) return buf.toString('utf8');
  return buf.toString('latin1');
}

function parseTxxxDescription(frameData: Buffer) {
  if (!frameData.length) return undefined;
  const enc = frameData[0] ?? 0x00;
  const charSize = enc === 0x01 || enc === 0x02 ? 2 : 1;
  let pos = 1;
  for (; pos + charSize - 1 < frameData.length; pos += charSize) {
    let isTerm = true;
    for (let j = 0; j < charSize; j++) if (frameData[pos + j] !== 0x00) isTerm = false;
    if (isTerm) break;
  }
  const descBuf = frameData.subarray(1, pos);
  return decodeText(descBuf, enc).replace(/\0/g, '').trim() || undefined;
}

function buildFrame(id: string, data: Buffer, version: 3 | 4, flags?: Buffer) {
  const header = Buffer.alloc(10);
  header.write(id, 0, 4, 'ascii');
  if (version === 4) encodeSyncSafeInt(data.length).copy(header, 4);
  else header.writeUInt32BE(data.length, 4);
  (flags ?? Buffer.from([0x00, 0x00])).copy(header, 8);
  return Buffer.concat([header, data]);
}

function buildTextFrame(id: string, values: string[], version: 3 | 4) {
  if (!values.length) return null;
  const joined = version === 4 ? values.join('\u0000') : values.join('/');
  const text = encodeUtf16WithBom(joined);
  const body = Buffer.concat([Buffer.from([0x01]), text]);
  return buildFrame(id, body, version);
}

function buildTxxxFrame(description: string, values: string[], version: 3 | 4) {
  if (!values.length) return null;
  const joined = version === 4 ? values.join('\u0000') : values.join('/');
  const desc = encodeUtf16WithBom(description);
  const val = encodeUtf16WithBom(joined);
  const body = Buffer.concat([Buffer.from([0x01]), desc, Buffer.from([0x00, 0x00]), val]);
  return buildFrame('TXXX', body, version);
}

function applyUnsync(buf: Buffer) {
  // Insert 0x00 after 0xFF if next byte is 0x00 or >= 0xE0 (prevents false MPEG syncs).
  const out: number[] = [];
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]!;
    out.push(b);
    if (b === 0xff) {
      const next = buf[i + 1];
      if (next === 0x00 || (next !== undefined && (next & 0xe0) === 0xe0)) out.push(0x00);
    }
  }
  return Buffer.from(out);
}

function parseId3Frames(file: Buffer): { frames: Id3Frame[]; audioOffset: number; version: 3 | 4; usesSyncsafeFrameSizes: boolean; headerFlags: number } {
  if (file.length < 10 || file.toString('ascii', 0, 3) !== 'ID3') return { frames: [], audioOffset: 0, version: 3, usesSyncsafeFrameSizes: false, headerFlags: 0 };

  const version = (file[3] === 4 ? 4 : 3) as 3 | 4;
  const flags = file[5] ?? 0;
  const tagSize = decodeSyncSafeInt(file.subarray(6, 10));
  const tagEnd = Math.min(file.length, 10 + tagSize);
  let body = file.subarray(10, tagEnd);

  // Skip extended header if present.
  const hasExtended = (flags & 0x40) !== 0;
  if (hasExtended && body.length >= 4) {
    // v2.3 extended headers are messy in the wild; if present we just skip a conservative amount.
    const extSize = version === 4 ? decodeSyncSafeInt(body.subarray(0, 4)) : body.readUInt32BE(0);
    const extTotal = version === 4 ? extSize : extSize + 4;
    if (extTotal > 0 && extTotal <= body.length) body = body.subarray(extTotal);
  }

  const frames: Id3Frame[] = [];
  let pos = 0;
  let usesSyncsafeFrameSizes = version === 4;

  while (pos + 10 <= body.length) {
    const id = body.toString('ascii', pos, pos + 4);
    if (!id || /^\0{4}$/.test(id) || id.trim() === '') break;

    const sizeBytes = body.subarray(pos + 4, pos + 8);
    let size = version === 4 ? decodeSyncSafeInt(sizeBytes) : sizeBytes.readUInt32BE(0);
    let end = pos + 10 + size;

    // Some files lie (v2.3 header but v2.4-style syncsafe frame sizes). If the v2.3 size is impossible,
    // fall back to syncsafe to avoid producing mixed/invalid tags on rewrite.
    if (version === 3 && (size < 0 || end > body.length)) {
      const alt = decodeSyncSafeInt(sizeBytes);
      const altEnd = pos + 10 + alt;
      if (alt >= 0 && altEnd <= body.length) {
        usesSyncsafeFrameSizes = true;
        size = alt;
        end = altEnd;
      } else {
        break;
      }
    }

    if (size < 0 || end > body.length) break;

    const flagsBuf = Buffer.from(body.subarray(pos + 8, pos + 10));
    const data = Buffer.from(body.subarray(pos + 10, end));
    const f: Id3Frame = { id, data, flags: flagsBuf };
    if (id === 'TXXX') f.txxxDescription = parseTxxxDescription(data);
    frames.push(f);
    pos = end;
  }

  return { frames, audioOffset: tagEnd, version, usesSyncsafeFrameSizes, headerFlags: flags };
}

function updateId3Tag(absPath: string, opts: {
  title?: string | null;
  album?: string | null;
  genre?: string[] | null;
  artists?: string[] | null;
  albumArtist?: string[] | null;
  year?: number | null;
  trackNumber?: number | null;
  discNumber?: number | null;
  country?: string[] | null;
  language?: string[] | null;
}) {
  const file = readFileSync(absPath);
  const parsed = parseId3Frames(file);
  // Always write ID3v2.4 so multi-value text frames use NUL separators (MP3Tag-compatible, avoids v2.3 '/').
  const targetVersion: 4 = 4;
  const needsUnsync = (parsed.headerFlags & 0x80) !== 0;

  const removeIds = new Set<string>();
  const removeTxxx = new Set<string>();

  if (opts.title !== undefined) removeIds.add('TIT2');
  if (opts.album !== undefined) removeIds.add('TALB');
  if (opts.genre !== undefined) removeIds.add('TCON');
  if (opts.artists !== undefined) {
    removeIds.add('TPE1');
    removeTxxx.add('artists');
  }
  if (opts.albumArtist !== undefined) removeIds.add('TPE2');
  if (opts.year !== undefined) {
    removeIds.add('TYER');
    removeIds.add('TDRC');
  }
  if (opts.trackNumber !== undefined) removeIds.add('TRCK');
  if (opts.discNumber !== undefined) removeIds.add('TPOS');
  if (opts.language !== undefined) {
    removeIds.add('TLAN');
    removeTxxx.add('language');
  }
  if (opts.country !== undefined) removeTxxx.add('country');

  const kept = parsed.frames.filter((f) => {
    if (removeIds.has(f.id)) return false;
    if (f.id === 'TXXX' && f.txxxDescription) {
      const key = f.txxxDescription.trim().toLowerCase();
      if (removeTxxx.has(key)) return false;
    }
    return true;
  });

  const added: Buffer[] = [];
  const addTextList = (id: string, parts: string[] | null | undefined) => {
    if (parts === undefined) return;
    const v = (parts ?? []).map((x) => String(x ?? '').trim()).filter(Boolean);
    const f = buildTextFrame(id, v, targetVersion);
    if (f) added.push(f);
  };
  const addTextOne = (id: string, v: string | null | undefined) => {
    if (v === undefined || v === null) return;
    const f = buildTextFrame(id, [String(v)], targetVersion);
    if (f) added.push(f);
  };
  const addTxxx = (desc: string, parts: string[] | null | undefined) => {
    if (parts === undefined) return;
    const v = (parts ?? []).map((x) => String(x ?? '').trim()).filter(Boolean);
    const f = buildTxxxFrame(desc, v, targetVersion);
    if (f) added.push(f);
  };

  if (opts.title !== undefined) addTextOne('TIT2', opts.title);
  if (opts.album !== undefined) addTextOne('TALB', opts.album);
  if (opts.genre !== undefined) addTextList('TCON', opts.genre);
  if (opts.artists !== undefined) {
    addTextList('TPE1', opts.artists);
  }
  if (opts.albumArtist !== undefined) addTextList('TPE2', opts.albumArtist);
  if (opts.year !== undefined && opts.year !== null) {
    if (targetVersion === 4) addTextOne('TDRC', String(opts.year));
    else addTextOne('TYER', String(opts.year));
  }
  if (opts.trackNumber !== undefined && opts.trackNumber !== null) addTextOne('TRCK', String(opts.trackNumber));
  if (opts.discNumber !== undefined && opts.discNumber !== null) addTextOne('TPOS', String(opts.discNumber));
  if (opts.country !== undefined) addTxxx('Country', opts.country);
  if (opts.language !== undefined) {
    addTextList('TLAN', opts.language);
  }

  // If we upgrade v2.3 -> v2.4 (syncsafe mismatch), drop per-frame flags to avoid writing invalid flags for the new version.
  if (needsUnsync) {
    for (let i = 0; i < added.length; i++) added[i] = applyUnsync(added[i]!);
  }

  const keptBuf = kept.map((f) => buildFrame(f.id, f.data, targetVersion, targetVersion === parsed.version ? f.flags : undefined));
  const framesBuf = Buffer.concat([...keptBuf, ...added]);
  if (framesBuf.length === 0) {
    // Remove ID3 tag entirely.
    writeFileSync(absPath, file.subarray(parsed.audioOffset));
    return;
  }

  const header = Buffer.alloc(10);
  header.write('ID3', 0, 3, 'ascii');
  header[3] = targetVersion;
  header[4] = 0x00;
  // Preserve original header flags when possible; we don't emit extended headers or footers.
  header[5] = parsed.headerFlags & ~0x50;
  encodeSyncSafeInt(framesBuf.length).copy(header, 6);

  const out = Buffer.concat([header, framesBuf, file.subarray(parsed.audioOffset)]);
  writeFileSync(absPath, out);
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
    const forceQs = qs.force === 'true';
    const forceBody = Boolean((req.body as any)?.force);
    const force = forceQs || forceBody;
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

    const multiParts = (s: string | null | undefined) => {
      if (s === undefined) return undefined;
      if (s === null) return null;
      return String(s)
        // Support both our preferred NUL-separated encoding and legacy/newline payloads.
        .split(/(?:\u0000|\\n|\r?\n)+/)
        .map((x) => x.trim())
        .filter(Boolean);
    };

    const genreParts = multiParts(genre);
    const countryParts = multiParts(country);
    const languageParts = multiParts(language);
    const year = normNum(body.year);
    const trackNumber = normNum(body.trackNumber);
    const discNumber = normNum(body.discNumber);

    const artistsList = body.artists === undefined
      ? undefined
      : (body.artists ?? [])
          .map((x) => String(x ?? '').trim())
          .filter(Boolean);

    const updateOpts: Parameters<typeof updateId3Tag>[1] = {};

    if (title !== undefined) updateOpts.title = title;
    if (album !== undefined) updateOpts.album = album;

    if (genre !== undefined) updateOpts.genre = genreParts === null ? null : (genreParts ?? []);

    if (artistsList !== undefined) updateOpts.artists = artistsList;

    if (albumArtist !== undefined) {
      const aaParts = multiParts(albumArtist);
      updateOpts.albumArtist = aaParts === null ? null : (aaParts ?? []);
    }

    if (year !== undefined) updateOpts.year = year;
    if (trackNumber !== undefined) updateOpts.trackNumber = trackNumber;
    if (discNumber !== undefined) updateOpts.discNumber = discNumber;

    if (country !== undefined) updateOpts.country = countryParts === null ? null : (countryParts ?? []);
    if (language !== undefined) updateOpts.language = languageParts === null ? null : (languageParts ?? []);

    try {
      updateId3Tag(abs, updateOpts);
    } catch (e: any) {
      return reply.code(500).send({ ok: false, error: e?.message ?? String(e) });
    }

    await audit('track_metadata_updated', { trackId: id, by: req.user.userId });

    // Trigger quick scan so DB reflects new tags without forcing a full reprocess
    await redis().publish('library:commands', JSON.stringify({ command: 'rescan', by: req.user.userId, force: false }));

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

    const libraries = await Promise.all(
      r.rows.map(async (l) => {
        let mounted = true;
        try {
          await access(l.mount_path);
        } catch {
          mounted = false;
        }

        let writable = false;
        try {
          await access(l.mount_path, constants.W_OK);
          writable = true;
        } catch {}

        return {
          id: l.id,
          mount_path: l.mount_path,
          mounted,
          writable,
          read_only: mounted && !writable,
        };
      })
    );

    return { ok: true, libraries };
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

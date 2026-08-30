import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { resolveInside } from './pathSafety.js';
import { db } from './db.js';
import { allowedLibrariesForUser } from './access.js';
import {
  boundedPosition,
  continuousListeningDelta,
  recordMediaActivity,
} from './mediaActivity.js';

const AUDIOBOOK_ART_DIR = process.env.AUDIOBOOK_ART_DIR ?? '/data/cache/audiobook-art';

// ============================================================================
// TYPES
// ============================================================================

interface Audiobook {
  id: number;
  library_id: number | null;
  path: string;
  title: string;
  author: string | null;
  narrator: string | null;
  description: string | null;
  language: string | null;
  cover_path: string | null;
  duration_ms: number;
  created_at: Date;
  updated_at: Date;
}

interface AudiobookChapter {
  id: number;
  audiobook_id: number;
  path: string;
  title: string;
  position: number;
  duration_ms: number | null;
  size_bytes: number | null;
  mtime_ms: number | null;
  created_at: Date;
}

interface AudiobookProgress {
  chapter_id: number;
  position_ms: number;
  finished: boolean;
  updated_at: Date;
}

// ============================================================================
// PLUGIN
// ============================================================================

export const audiobooksPlugin: FastifyPluginAsync = fp(async (app) => {

  // ========================================================================
  // LIST AUDIOBOOKS
  // ========================================================================

  app.get('/api/audiobooks', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const allowed = await allowedLibrariesForUser(req.user.userId, req.user.role);

    const r = await db().query<
      Audiobook & {
        chapter_count: number;
        progress_chapter_id: number | null;
        progress_chapter_position: number | null;
        progress_chapter_title: string | null;
        progress_position_ms: number | null;
        progress_finished: boolean | null;
        chapters_finished: number;
      }
    >(
      `SELECT a.id, a.title, a.author, a.narrator, a.language, a.cover_path, a.duration_ms,
              (SELECT COUNT(*)::int FROM audiobook_chapters WHERE audiobook_id = a.id) AS chapter_count,
              uap.chapter_id AS progress_chapter_id,
              pc.position AS progress_chapter_position,
              pc.title AS progress_chapter_title,
              uap.position_ms AS progress_position_ms,
              uap.finished AS progress_finished,
              CASE
                WHEN uap.finished = true THEN (SELECT COUNT(*)::int FROM audiobook_chapters WHERE audiobook_id = a.id)
                WHEN uap.chapter_id IS NOT NULL THEN (SELECT COUNT(*)::int FROM audiobook_chapters WHERE audiobook_id = a.id AND position < pc.position)
                ELSE 0
              END AS chapters_finished
       FROM active_audiobooks a
       LEFT JOIN user_audiobook_progress uap ON uap.audiobook_id = a.id AND uap.user_id = $1
       LEFT JOIN audiobook_chapters pc ON pc.id = uap.chapter_id
       WHERE ($2::bigint[] IS NULL OR a.library_id = ANY($2::bigint[]))
       ORDER BY a.title`,
      [req.user.userId, allowed]
    );

    const audiobooks = r.rows.map((row) => ({
      id: row.id,
      title: row.title,
      author: row.author,
      narrator: row.narrator,
      language: row.language,
      cover_path: row.cover_path,
      duration_ms: row.duration_ms,
      chapter_count: row.chapter_count,
      progress: row.progress_chapter_id
        ? {
            chapter_id: row.progress_chapter_id,
            chapter_position: row.progress_chapter_position,
            chapter_title: row.progress_chapter_title,
            position_ms: row.progress_position_ms,
            finished: row.progress_finished,
            total_chapters: row.chapter_count,
            chapters_finished: row.chapters_finished,
          }
        : null,
    }));

    return audiobooks;
  });

  // ========================================================================
  // GET AUDIOBOOK DETAILS
  // ========================================================================

  app.get('/api/audiobooks/:id', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });

    const id = Number((req.params as { id: string }).id);
    if (!Number.isFinite(id)) return reply.code(400).send({ ok: false });
    const allowed = await allowedLibrariesForUser(req.user.userId, req.user.role);

    const bookR = await db().query<Audiobook>(
      `SELECT id, library_id, path, title, author, narrator, description, language, cover_path, duration_ms, created_at, updated_at
       FROM active_audiobooks
       WHERE id = $1
         AND ($2::bigint[] IS NULL OR library_id = ANY($2::bigint[]))`,
      [id, allowed]
    );
    if (bookR.rows.length === 0) return reply.code(404).send({ ok: false });

    const chaptersR = await db().query<AudiobookChapter>(
      `SELECT id, audiobook_id, path, title, position, duration_ms, size_bytes, mtime_ms, created_at
       FROM audiobook_chapters WHERE audiobook_id = $1 ORDER BY position`,
      [id]
    );

    const progressR = await db().query<AudiobookProgress>(
      `SELECT chapter_id, position_ms, finished, updated_at
       FROM user_audiobook_progress WHERE user_id = $1 AND audiobook_id = $2`,
      [req.user.userId, id]
    );

    return {
      audiobook: bookR.rows[0],
      chapters: chaptersR.rows,
      progress: progressR.rows[0] ?? null,
    };
  });

  // ========================================================================
  // STREAM CHAPTER
  // ========================================================================

  app.get('/api/audiobooks/:id/chapters/:chapterId/stream', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });

    const id = Number((req.params as { id: string; chapterId: string }).id);
    const chapterId = Number((req.params as { id: string; chapterId: string }).chapterId);
    if (!Number.isFinite(id) || !Number.isFinite(chapterId))
      return reply.code(400).send({ ok: false });
    const allowed = await allowedLibrariesForUser(req.user.userId, req.user.role);

    const r = await db().query<{ chapter_path: string }>(
      `SELECT c.path AS chapter_path
       FROM audiobook_chapters c
       JOIN active_audiobooks a ON a.id = c.audiobook_id
       WHERE c.id = $1
         AND c.audiobook_id = $2
         AND ($3::bigint[] IS NULL OR a.library_id = ANY($3::bigint[]))`,
      [chapterId, id, allowed]
    );
    if (r.rows.length === 0) return reply.code(404).send({ ok: false });

    // Chapter path is absolute — use directly
    const abs = r.rows[0].chapter_path;

    let st;
    try {
      st = await stat(abs);
    } catch {
      return reply.code(404).send({ ok: false });
    }

    const ext = path.extname(abs).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.mp3': 'audio/mpeg',
      '.m4a': 'audio/mp4',
      '.m4b': 'audio/mp4',
      '.ogg': 'audio/ogg',
      '.opus': 'audio/opus',
      '.wav': 'audio/wav',
      '.aac': 'audio/aac',
      '.flac': 'audio/flac',
    };
    const contentType = mimeTypes[ext] || 'application/octet-stream';

    const range = req.headers.range;

    if (range) {
      const m = /^bytes=(\d+)-(\d+)?$/.exec(range);
      if (!m) return reply.code(416).send();
      const start = Number(m[1]);
      const end = m[2] ? Number(m[2]) : st.size - 1;
      if (start >= st.size || end >= st.size || start > end)
        return reply.code(416).send();

      reply
        .code(206)
        .header('Content-Range', `bytes ${start}-${end}/${st.size}`)
        .header('Accept-Ranges', 'bytes')
        .header('Content-Length', String(end - start + 1))
        .header('Content-Type', contentType);

      const stream = createReadStream(abs, { start, end });
      stream.on('error', () => { if (!reply.sent) reply.code(500).send(); });
      return reply.send(stream);
    }

    reply
      .header('Content-Length', String(st.size))
      .header('Accept-Ranges', 'bytes')
      .header('Content-Type', contentType);

    const stream = createReadStream(abs);
    stream.on('error', () => { if (!reply.sent) reply.code(500).send(); });
    return reply.send(stream);
  });

  // ========================================================================
  // UPDATE PROGRESS
  // ========================================================================

  app.post('/api/audiobooks/:id/progress', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });

    const id = Number((req.params as { id: string }).id);
    if (!Number.isFinite(id)) return reply.code(400).send({ ok: false });

    const { chapter_id, position_ms, finished } = (req.body ?? {}) as {
      chapter_id?: unknown;
      position_ms?: unknown;
      finished?: unknown;
    };
    if (typeof chapter_id !== 'number' || !Number.isInteger(chapter_id) || chapter_id <= 0)
      return reply.code(400).send({ ok: false, error: 'chapter_id and position_ms are required' });
    if (finished !== undefined && typeof finished !== 'boolean') {
      return reply.code(400).send({ ok: false, error: 'finished must be a boolean' });
    }
    const allowed = await allowedLibrariesForUser(req.user.userId, req.user.role);

    const checkR = await db().query<{
      chapter_duration_ms: number | null;
      chapter_position: number;
      previous_chapter_id: number | null;
      previous_position_ms: number | null;
      previous_finished: boolean | null;
      previous_chapter_position: number | null;
      previous_chapter_duration_ms: number | null;
    }>(
      `SELECT
         chapter.duration_ms as chapter_duration_ms,
         chapter.position as chapter_position,
         progress.chapter_id as previous_chapter_id,
         progress.position_ms as previous_position_ms,
         progress.finished as previous_finished,
         previous_chapter.position as previous_chapter_position,
         previous_chapter.duration_ms as previous_chapter_duration_ms
       FROM audiobook_chapters chapter
       JOIN active_audiobooks book ON book.id = chapter.audiobook_id
       LEFT JOIN user_audiobook_progress progress
         ON progress.audiobook_id = book.id AND progress.user_id = $3
       LEFT JOIN audiobook_chapters previous_chapter ON previous_chapter.id = progress.chapter_id
       WHERE chapter.id = $1
         AND chapter.audiobook_id = $2
         AND ($4::bigint[] IS NULL OR book.library_id = ANY($4::bigint[]))`,
      [chapter_id, id, req.user.userId, allowed]
    );
    if (checkR.rows.length === 0) return reply.code(404).send({ ok: false });
    const chapter = checkR.rows[0];
    const normalizedPosition = boundedPosition(position_ms, chapter.chapter_duration_ms);
    if (normalizedPosition == null) {
      return reply.code(400).send({ ok: false, error: 'position_ms must be a non-negative finite number' });
    }

    await db().query(
      `INSERT INTO user_audiobook_progress (user_id, audiobook_id, chapter_id, position_ms, finished, updated_at)
       VALUES ($1, $2, $3, $4, COALESCE($5, false), now())
       ON CONFLICT (user_id, audiobook_id) DO UPDATE SET
         chapter_id = $3,
         position_ms = $4,
         finished = COALESCE($5, user_audiobook_progress.finished),
         updated_at = now()`,
      [req.user.userId, id, chapter_id, normalizedPosition, finished ?? null]
    );

    let listenedMs = 0;
    if (chapter.previous_chapter_id == null) {
      listenedMs = continuousListeningDelta(null, normalizedPosition);
    } else if (Number(chapter.previous_chapter_id) === chapter_id) {
      listenedMs = continuousListeningDelta(chapter.previous_position_ms, normalizedPosition);
    } else if (
      chapter.previous_chapter_position != null
      && chapter.chapter_position > chapter.previous_chapter_position
    ) {
      const previousRemainder = chapter.previous_chapter_duration_ms == null
        ? 0
        : continuousListeningDelta(
            chapter.previous_position_ms,
            chapter.previous_chapter_duration_ms
          );
      listenedMs = previousRemainder + continuousListeningDelta(null, normalizedPosition);
    }
    await recordMediaActivity({
      req,
      mediaType: 'audiobook',
      itemId: id,
      parentId: chapter_id,
      positionMs: normalizedPosition,
      listenedMs,
      completed: finished === true && chapter.previous_finished !== true,
    });

    return { ok: true };
  });

  // ========================================================================
  // AUDIOBOOK ART
  // ========================================================================

  app.get('/api/audiobook-art/:id', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });

    const id = Number((req.params as { id: string }).id);
    if (!Number.isFinite(id)) return reply.code(400).send({ ok: false });
    const allowed = await allowedLibrariesForUser(req.user.userId, req.user.role);

    const r = await db().query<{ cover_path: string | null }>(
      `SELECT cover_path
       FROM active_audiobooks
       WHERE id = $1
         AND ($2::bigint[] IS NULL OR library_id = ANY($2::bigint[]))`,
      [id, allowed]
    );
    const row = r.rows[0];
    if (!row?.cover_path) return reply.code(404).send({ ok: false });

    let abs: string;
    try {
      abs = resolveInside(AUDIOBOOK_ART_DIR, row.cover_path);
    } catch {
      return reply.code(400).send({ ok: false });
    }

    let st;
    try {
      st = await stat(abs);
    } catch {
      return reply.code(404).send({ ok: false });
    }

    const ext = path.extname(abs).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
    };
    const mime = mimeTypes[ext] || 'image/jpeg';

    const hash = path.basename(row.cover_path, ext);
    const etag = `"${hash}"`;
    const inm = req.headers['if-none-match'];
    if (inm === etag) return reply.code(304).send();

    reply
      .header('Content-Type', mime)
      .header('Content-Length', String(st.size))
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .header('ETag', etag);

    return reply.send(createReadStream(abs));
  });

  // ========================================================================
  // MARK FINISHED
  // ========================================================================

  app.post('/api/audiobooks/:id/mark-finished', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });

    const id = Number((req.params as { id: string }).id);
    if (!Number.isFinite(id)) return reply.code(400).send({ ok: false });
    const allowed = await allowedLibrariesForUser(req.user.userId, req.user.role);

    const lastR = await db().query<{
      id: number | string;
      duration_ms: number | null;
      previous_chapter_id: number | string | null;
      previous_position_ms: number | null;
      previous_finished: boolean | null;
    }>(
      `SELECT
         chapter.id,
         chapter.duration_ms,
         progress.chapter_id as previous_chapter_id,
         progress.position_ms as previous_position_ms,
         progress.finished as previous_finished
       FROM active_audiobooks book
       JOIN audiobook_chapters chapter ON chapter.audiobook_id = book.id
       LEFT JOIN user_audiobook_progress progress
         ON progress.audiobook_id = book.id AND progress.user_id = $2
       WHERE book.id = $1
         AND ($3::bigint[] IS NULL OR book.library_id = ANY($3::bigint[]))
       ORDER BY chapter.position DESC
       LIMIT 1`,
      [id, req.user.userId, allowed]
    );
    if (lastR.rows.length === 0) return reply.code(404).send({ ok: false });

    const lastChapter = lastR.rows[0];
    const lastChapterId = Number(lastChapter.id);
    const finalPosition = lastChapter.duration_ms ?? 0;

    await db().query(
      `INSERT INTO user_audiobook_progress (user_id, audiobook_id, chapter_id, position_ms, finished, updated_at)
       VALUES ($1, $2, $3, $4, true, now())
       ON CONFLICT (user_id, audiobook_id) DO UPDATE SET
         chapter_id = $3,
         position_ms = $4,
         finished = true,
         updated_at = now()`,
      [req.user.userId, id, lastChapterId, finalPosition]
    );

    if (lastChapter.previous_finished !== true) {
      const listenedMs = Number(lastChapter.previous_chapter_id) === lastChapterId
        ? continuousListeningDelta(lastChapter.previous_position_ms, finalPosition)
        : 0;
      await recordMediaActivity({
        req,
        mediaType: 'audiobook',
        itemId: id,
        parentId: lastChapterId,
        positionMs: finalPosition,
        listenedMs,
        completed: true,
      });
    }

    return { ok: true };
  });

  // ========================================================================
  // ADMIN: EDIT AUDIOBOOK METADATA
  // ========================================================================

  app.post('/api/admin/audiobooks/:id/metadata', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ ok: false });

    const id = Number((req.params as { id: string }).id);
    if (!Number.isFinite(id)) return reply.code(400).send({ ok: false });

    const body = (req.body ?? {}) as {
      title?: string | null;
      author?: string | null;
      narrator?: string | null;
      description?: string | null;
      language?: string | null;
    };

    const sets: string[] = [];
    const vals: unknown[] = [];
    let idx = 1;

    const addField = (col: string, val: unknown) => {
      if (val !== undefined) {
        const v = typeof val === 'string' ? val.trim() || null : val;
        sets.push(`${col} = $${idx++}`);
        vals.push(v);
      }
    };

    addField('title', body.title);
    addField('author', body.author);
    addField('narrator', body.narrator);
    addField('description', body.description);
    addField('language', body.language);

    if (sets.length === 0) return reply.code(400).send({ ok: false, error: 'No fields to update' });

    sets.push(`metadata_locked = true`);
    sets.push(`updated_at = now()`);
    vals.push(id);

    const r = await db().query(
      `UPDATE audiobooks
       SET ${sets.join(', ')}
       WHERE id = $${idx}
         AND EXISTS (
           SELECT 1 FROM libraries
           WHERE libraries.id = audiobooks.library_id
             AND libraries.enabled = true
         )`,
      vals
    );
    if (r.rowCount === 0) return reply.code(404).send({ ok: false });

    return { ok: true };
  });

  // ========================================================================
  // ADMIN: EDIT CHAPTER METADATA
  // ========================================================================

  app.post('/api/admin/audiobooks/:id/chapters/:chapterId/metadata', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ ok: false });

    const id = Number((req.params as { id: string; chapterId: string }).id);
    const chapterId = Number((req.params as { id: string; chapterId: string }).chapterId);
    if (!Number.isFinite(id) || !Number.isFinite(chapterId))
      return reply.code(400).send({ ok: false });

    const body = (req.body ?? {}) as { title?: string | null };

    if (body.title === undefined) return reply.code(400).send({ ok: false, error: 'No fields to update' });

    const title = typeof body.title === 'string' ? body.title.trim() || null : null;

    const r = await db().query(
      `UPDATE audiobook_chapters
       SET title = $1, metadata_locked = true
       WHERE id = $2
         AND audiobook_id = $3
         AND EXISTS (SELECT 1 FROM active_audiobooks WHERE id = $3)`,
      [title, chapterId, id]
    );
    if (r.rowCount === 0) return reply.code(404).send({ ok: false });

    return { ok: true };
  });
});

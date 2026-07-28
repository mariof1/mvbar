import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Redis from 'ioredis';
import { db, audit } from './db.js';
import { readTags } from './metadata.js';
import { writeArt } from './art.js';
import { getTrackIndexStatus, indexAllTracks, indexChangedTracks, ensureTracksIndex } from './indexer.js';
import logger from './logger.js';
import { asciiFold } from './tagRules.js';
import { detectTempoBpm, type OnsetMethod } from './tempoDetector.js';
import { resolveInside } from './pathSafety.js';

const LYRICS_DIR = process.env.LYRICS_DIR ?? '/data/cache/lyrics';
const ART_DIR = process.env.ART_DIR ?? '/data/cache/art';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://redis:6379';
const AUDIO_EXTS = new Set(['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wav']);
const ARTIST_IMAGE_NAMES = ['artist.jpg', 'artist.jpeg', 'artist.png', 'band.jpg', 'band.jpeg', 'band.png', 'photo.jpg', 'photo.jpeg', 'photo.png'];

// Tuning parameters
const BATCH_SIZE = 100;  // DB batch insert size
function boundedInteger(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.trunc(parsed))) : fallback;
}

const CONCURRENCY = boundedInteger(process.env.SCAN_CONCURRENCY, 25, 1, 500);
const ARTIST_ART_CONCURRENCY = boundedInteger(process.env.ARTIST_ART_CONCURRENCY, 16, 1, 64);
const PROGRESS_INTERVAL = 3000;  // Progress log interval in ms
const METADATA_TIMEOUT_MS = boundedInteger(process.env.METADATA_TIMEOUT_MS, 300000, 1000, 600000);

function scanOrderKey(value: string) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

// Optional tempo detection (expensive: uses ffmpeg decode + DSP)
// TEMPO_DETECT + TEMPO_MODE=scan => run during scans
// TEMPO_DETECT + TEMPO_MODE=batch => handled by tempoBackfill job (not during scans)
const TEMPO_DETECT = process.env.TEMPO_DETECT === '1';
const TEMPO_MODE = process.env.TEMPO_MODE ?? 'batch';
const TEMPO_IN_SCAN = TEMPO_DETECT && TEMPO_MODE === 'scan';
const TEMPO_METHOD = (process.env.TEMPO_METHOD as OnsetMethod | undefined) ?? 'energy';
const TEMPO_MIN_CONF = Number(process.env.TEMPO_MIN_CONF ?? '0.35');
const TEMPO_CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.TEMPO_CONCURRENCY ?? '2')));

let tempoInFlight = 0;
const tempoWaiters: Array<() => void> = [];
async function withTempoSlot<T>(fn: () => Promise<T>): Promise<T> {
  while (tempoInFlight >= TEMPO_CONCURRENCY) {
    await new Promise<void>((resolve) => tempoWaiters.push(resolve));
  }
  tempoInFlight++;
  try {
    return await fn();
  } finally {
    tempoInFlight--;
    tempoWaiters.shift()?.();
  }
}

// Redis publisher for live updates
let publisher: Redis | null = null;
let lastRedisErrorLogAt = 0;
function logRedisError(error: unknown) {
  const now = Date.now();
  if (now - lastRedisErrorLogAt < 30_000) return;
  lastRedisErrorLogAt = now;
  logger.warn('scan', `Redis progress update failed: ${error instanceof Error ? error.message : String(error)}`);
}

function getPublisher() {
  if (!publisher) {
    publisher = new Redis(REDIS_URL);
    publisher.on('error', logRedisError);
  }
  return publisher;
}

// Publish library update event
function publishUpdate(event: string, data: Record<string, unknown>) {
  void getPublisher()
    .publish('library:updates', JSON.stringify({ event, ...data, ts: Date.now() }))
    .catch(logRedisError);
}

function storeProgress(data: Record<string, unknown>) {
  void getPublisher()
    .set('scan:progress', JSON.stringify(data))
    .catch(logRedisError);
}

interface TrackData {
  libraryId: number;
  path: string;
  mtimeMs: number;
  birthtimeMs: number;
  sizeBytes: number;
  ext: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  albumartist: string | null;
  genre: string | null;
  country: string | null;
  language: string | null;
  year: number | null;
  durationMs: number | null;
  artPath: string | null;
  artMime: string | null;
  artHash: string | null;
  lyricsPath: string | null;
  embeddedLyrics: string | null;
  embeddedLyricsSynced: boolean;
  artists: string[];       // Array of individual artist names
  albumartists: string[];  // Array of individual album artist names
  composers: string[];     // Array of composer names
  conductors: string[];    // Array of conductor names
  trackNumber: number | null;
  trackTotal: number | null;
  discNumber: number | null;
  discTotal: number | null;
  // Extended metadata
  bpm: number | null;
  initialKey: string | null;
  composer: string | null;
  conductor: string | null;
  publisher: string | null;
  copyright: string | null;
  comment: string | null;
  mood: string | null;
  grouping: string | null;
  isrc: string | null;
  releaseDate: string | null;
  originalYear: number | null;
  compilation: boolean;
  // Sort fields
  titleSort: string | null;
  artistSort: string | null;
  albumSort: string | null;
  albumArtistSort: string | null;
  // MusicBrainz IDs
  musicbrainzTrackId: string | null;
  musicbrainzReleaseId: string | null;
  musicbrainzArtistId: string | null;
  musicbrainzAlbumArtistId: string | null;
  isNew: boolean;
  isRestored: boolean;
}

interface FileInfo {
  fullPath: string;
  relPath: string;
  mtimeMs: number;
  birthtimeMs: number;
  sizeBytes: number;
  ext: string;
}

// Fast parallel directory walk
async function* walkDirectory(
  dir: string,
  rootDir: string,
  onError: (target: string, error: unknown) => void
): AsyncGenerator<FileInfo> {
  const dirQueue: string[] = [dir];
  
  while (dirQueue.length > 0) {
    // Process multiple directories in parallel
    const batch = dirQueue.splice(0, 20);
    const results = await Promise.all(batch.map(async (d) => {
      try {
        const entries = await readdir(d, { withFileTypes: true });
        const dirs: string[] = [];
        const files: FileInfo[] = [];
        
        for (const e of entries) {
          const full = path.join(d, e.name);
          if (e.isDirectory()) {
            dirs.push(full);
          } else if (e.isFile()) {
            const ext = path.extname(e.name).toLowerCase();
            if (AUDIO_EXTS.has(ext)) {
              try {
                const st = await stat(full);
                files.push({
                  fullPath: full,
                  relPath: path.relative(rootDir, full),
                  mtimeMs: Math.round(st.mtimeMs),
                  birthtimeMs: Math.round(st.birthtimeMs),
                  sizeBytes: st.size,
                  ext,
                });
              } catch (error) {
                onError(full, error);
              }
            }
          }
        }
        return { dirs, files };
      } catch (error) {
        onError(d, error);
        return { dirs: [], files: [] };
      }
    }));
    
    for (const r of results) {
      dirQueue.push(...r.dirs);
      for (const f of r.files) {
        yield f;
      }
    }
  }
}

async function readTagsWithTimeout(filePath: string) {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      readTags(filePath),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`metadata read timed out after ${METADATA_TIMEOUT_MS}ms`)),
          METADATA_TIMEOUT_MS
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

// Parallel file processor with concurrency limit
async function processFilesParallel<T, R>(
  items: T[],
  concurrency: number,
  processor: (item: T) => Promise<R | null>,
  onResult: (result: R | null) => Promise<void>,
  onProcessed?: (completed: number) => void
): Promise<void> {
  let index = 0;
  let completed = 0;
  let fatalError: unknown = null;
  let resultLock = Promise.resolve();

  const deliverResult = async (result: R | null) => {
    const previous = resultLock;
    let release: () => void = () => {};
    resultLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (fatalError) throw fatalError;
      await onResult(result);
    } catch (error) {
      fatalError ??= error;
      throw error;
    } finally {
      release();
    }
  };

  async function worker(): Promise<void> {
    while (index < items.length && !fatalError) {
      const i = index++;
      let result: R | null = null;
      try {
        result = await processor(items[i]);
      } catch {
        result = null;
      }
      await deliverResult(result);
      completed++;
      onProcessed?.(completed);
    }
  }
  
  const workers = Array(Math.min(concurrency, items.length))
    .fill(null)
    .map(() => worker());
  
  await Promise.all(workers);
}

// Batch upsert tracks
async function batchUpsertTracks(tracks: TrackData[]): Promise<void> {
  if (tracks.length === 0) return;
  
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    
    // Use unnest for bulk insert (much faster than individual inserts)
    const libraryIds = tracks.map(t => t.libraryId);
    const paths = tracks.map(t => t.path);
    const mtimeMss = tracks.map(t => t.mtimeMs);
    const birthtimeMss = tracks.map(t => t.birthtimeMs);
    const sizeBytes = tracks.map(t => t.sizeBytes);
    const exts = tracks.map(t => t.ext);
    const titles = tracks.map(t => t.title);
    const artists = tracks.map(t => t.artist);
    const albums = tracks.map(t => t.album);
    const albumArtists = tracks.map(t => t.albumartist);
    const genres = tracks.map(t => t.genre);
    const countries = tracks.map(t => t.country);
    const languages = tracks.map(t => t.language);
    const years = tracks.map(t => t.year);
    const durations = tracks.map(t => t.durationMs);
    const artPaths = tracks.map(t => t.artPath);
    const artMimes = tracks.map(t => t.artMime);
    const artHashes = tracks.map(t => t.artHash);
    const lyricsPaths = tracks.map(t => t.lyricsPath);
    const embeddedLyrics = tracks.map(t => t.embeddedLyrics);
    const embeddedLyricsSynced = tracks.map(t => t.embeddedLyricsSynced);
    const trackNumbers = tracks.map(t => t.trackNumber);
    const trackTotals = tracks.map(t => t.trackTotal);
    const discNumbers = tracks.map(t => t.discNumber);
    const discTotals = tracks.map(t => t.discTotal);
    // Extended metadata arrays
    const bpms = tracks.map(t => t.bpm);
    const initialKeys = tracks.map(t => t.initialKey);
    const composerStrs = tracks.map(t => t.composer);
    const conductorStrs = tracks.map(t => t.conductor);
    const publishers = tracks.map(t => t.publisher);
    const copyrights = tracks.map(t => t.copyright);
    const comments = tracks.map(t => t.comment);
    const moods = tracks.map(t => t.mood);
    const groupings = tracks.map(t => t.grouping);
    const isrcs = tracks.map(t => t.isrc);
    const releaseDates = tracks.map(t => t.releaseDate);
    const originalYears = tracks.map(t => t.originalYear);
    const compilations = tracks.map(t => t.compilation);
    // Sort fields
    const titleSorts = tracks.map(t => t.titleSort);
    const artistSorts = tracks.map(t => t.artistSort);
    const albumSorts = tracks.map(t => t.albumSort);
    const albumArtistSorts = tracks.map(t => t.albumArtistSort);
    // MusicBrainz IDs
    const mbTrackIds = tracks.map(t => t.musicbrainzTrackId);
    const mbReleaseIds = tracks.map(t => t.musicbrainzReleaseId);
    const mbArtistIds = tracks.map(t => t.musicbrainzArtistId);
    const mbAlbumArtistIds = tracks.map(t => t.musicbrainzAlbumArtistId);
    
    // Insert/update tracks and get their IDs
    const trackResult = await client.query<{ id: number | string; path: string }>(`
      INSERT INTO tracks (
        library_id, path, mtime_ms, size_bytes, ext, title, artist, album, album_artist, 
        genre, country, language, year, duration_ms, art_path, art_mime, art_hash, lyrics_path,
        embedded_lyrics, embedded_lyrics_synced,
        track_number, track_total, disc_number, disc_total, last_seen_job_id, updated_at, birthtime_ms, created_at,
        bpm, initial_key, composer, conductor, publisher, copyright, comment, mood, grouping,
        isrc, release_date, original_year, compilation,
        title_sort, artist_sort, album_sort, album_artist_sort,
        musicbrainz_track_id, musicbrainz_release_id, musicbrainz_artist_id, musicbrainz_album_artist_id
      )
      SELECT 
        u.library_id, u.path, u.mtime_ms, u.size_bytes, u.ext,
        u.title, u.artist, u.album, u.album_artist, u.genre,
        u.country, u.language, u.year, u.duration_ms, u.art_path,
        u.art_mime, u.art_hash, u.lyrics_path, u.embedded_lyrics, u.embedded_lyrics_synced,
        u.track_number, u.track_total,
        u.disc_number, u.disc_total, u.last_seen_job_id, u.updated_at,
        u.birthtime_ms,
        to_timestamp(u.birthtime_ms::double precision / 1000.0),
        u.bpm, u.initial_key, u.composer, u.conductor, u.publisher, u.copyright, u.comment, u.mood, u.grouping,
        u.isrc, u.release_date, u.original_year, u.compilation,
        u.title_sort, u.artist_sort, u.album_sort, u.album_artist_sort,
        u.mb_track_id, u.mb_release_id, u.mb_artist_id, u.mb_album_artist_id
      FROM unnest(
        $1::bigint[], $2::text[], $3::bigint[], $4::bigint[], $5::text[],
        $6::text[], $7::text[], $8::text[], $9::text[], $10::text[],
        $11::text[], $12::text[], $13::int[], $14::int[], $15::text[],
        $16::text[], $17::text[], $18::text[], $19::text[], $20::boolean[],
        $21::int[], $22::int[], $23::int[], $24::int[], $25::int[],
        $26::timestamptz[], $27::bigint[], $28::int[], $29::text[], $30::text[],
        $31::text[], $32::text[], $33::text[], $34::text[], $35::text[],
        $36::text[], $37::text[], $38::text[], $39::int[], $40::boolean[],
        $41::text[], $42::text[], $43::text[], $44::text[],
        $45::text[], $46::text[], $47::text[], $48::text[]
      ) AS u(
        library_id, path, mtime_ms, size_bytes, ext, title, artist, album, album_artist, genre,
        country, language, year, duration_ms, art_path, art_mime, art_hash, lyrics_path,
        embedded_lyrics, embedded_lyrics_synced, track_number, track_total,
        disc_number, disc_total, last_seen_job_id, updated_at, birthtime_ms,
        bpm, initial_key, composer, conductor, publisher, copyright, comment, mood, grouping,
        isrc, release_date, original_year, compilation,
        title_sort, artist_sort, album_sort, album_artist_sort,
        mb_track_id, mb_release_id, mb_artist_id, mb_album_artist_id
      )
      ON CONFLICT (library_id, path) DO UPDATE SET
        mtime_ms = EXCLUDED.mtime_ms,
        size_bytes = EXCLUDED.size_bytes,
        ext = EXCLUDED.ext,
        title = EXCLUDED.title,
        artist = EXCLUDED.artist,
        album = EXCLUDED.album,
        album_artist = EXCLUDED.album_artist,
        genre = EXCLUDED.genre,
        country = EXCLUDED.country,
        language = EXCLUDED.language,
        year = EXCLUDED.year,
        duration_ms = EXCLUDED.duration_ms,
        art_path = EXCLUDED.art_path,
        art_mime = EXCLUDED.art_mime,
        art_hash = EXCLUDED.art_hash,
        lyrics_path = EXCLUDED.lyrics_path,
        embedded_lyrics = EXCLUDED.embedded_lyrics,
        embedded_lyrics_synced = EXCLUDED.embedded_lyrics_synced,
        track_number = EXCLUDED.track_number,
        track_total = EXCLUDED.track_total,
        disc_number = EXCLUDED.disc_number,
        disc_total = EXCLUDED.disc_total,
        last_seen_job_id = EXCLUDED.last_seen_job_id,
        bpm = COALESCE(EXCLUDED.bpm, tracks.bpm),
        initial_key = EXCLUDED.initial_key,
        composer = EXCLUDED.composer,
        conductor = EXCLUDED.conductor,
        publisher = EXCLUDED.publisher,
        copyright = EXCLUDED.copyright,
        comment = EXCLUDED.comment,
        mood = EXCLUDED.mood,
        grouping = EXCLUDED.grouping,
        isrc = EXCLUDED.isrc,
        release_date = EXCLUDED.release_date,
        original_year = EXCLUDED.original_year,
        compilation = EXCLUDED.compilation,
        title_sort = EXCLUDED.title_sort,
        artist_sort = EXCLUDED.artist_sort,
        album_sort = EXCLUDED.album_sort,
        album_artist_sort = EXCLUDED.album_artist_sort,
        musicbrainz_track_id = EXCLUDED.musicbrainz_track_id,
        musicbrainz_release_id = EXCLUDED.musicbrainz_release_id,
        musicbrainz_artist_id = EXCLUDED.musicbrainz_artist_id,
        musicbrainz_album_artist_id = EXCLUDED.musicbrainz_album_artist_id,
        deleted_at = NULL,
        updated_at = now()
      RETURNING id, path
    `, [
      libraryIds, paths, mtimeMss, sizeBytes, exts,
      titles, artists, albums, albumArtists, genres,
      countries, languages, years, durations, artPaths,
      artMimes, artHashes, lyricsPaths, embeddedLyrics, embeddedLyricsSynced,
      trackNumbers, trackTotals,
      discNumbers, discTotals,
      tracks.map(() => 0),  // last_seen_job_id = 0 for fast scan
      tracks.map(() => new Date()),
      birthtimeMss,
      bpms, initialKeys, composerStrs, conductorStrs, publishers,
      copyrights, comments, moods, groupings,
      isrcs, releaseDates, originalYears, compilations,
      titleSorts, artistSorts, albumSorts, albumArtistSorts,
      mbTrackIds, mbReleaseIds, mbArtistIds, mbAlbumArtistIds
    ]);
    
    // Build path -> track mapping for artist updates
    const pathToTrackId = new Map<string, number>();
    for (const row of trackResult.rows) {
      pathToTrackId.set(row.path, Number(row.id));
    }

    const trackIds = [...pathToTrackId.values()];
    if (trackIds.length > 0) {
      await client.query('DELETE FROM track_artists WHERE track_id = ANY($1)', [trackIds]);
      await client.query('DELETE FROM track_genres WHERE track_id = ANY($1)', [trackIds]);
      await client.query('DELETE FROM track_credits WHERE track_id = ANY($1)', [trackIds]);
      await client.query('DELETE FROM track_countries WHERE track_id = ANY($1)', [trackIds]);
      await client.query('DELETE FROM track_languages WHERE track_id = ANY($1)', [trackIds]);
    }
    
    const artistRelations: Array<{ trackId: number; name: string; role: string; position: number }> = [];
    const creditRelations: Array<{ trackId: number; name: string; role: string; position: number }> = [];
    const genreRelations: Array<{ trackId: number; value: string }> = [];
    const countryRelations: Array<{ trackId: number; value: string }> = [];
    const languageRelations: Array<{ trackId: number; value: string }> = [];

    for (const track of tracks) {
      const trackId = pathToTrackId.get(track.path);
      if (!trackId) continue;

      let position = 0;
      for (const name of track.albumartists) {
        if (name?.trim()) artistRelations.push({ trackId, name: name.trim(), role: 'albumartist', position: position++ });
      }
      position = 0;
      for (const name of track.artists) {
        if (name?.trim()) artistRelations.push({ trackId, name: name.trim(), role: 'artist', position: position++ });
      }

      if (track.genre) {
        for (const value of track.genre.split(/[;,]/).map((item) => item.trim()).filter(Boolean)) {
          genreRelations.push({ trackId, value });
        }
      }

      position = 0;
      for (const name of track.composers) {
        if (name?.trim()) creditRelations.push({ trackId, name: name.trim(), role: 'composer', position: position++ });
      }
      position = 0;
      for (const name of track.conductors) {
        if (name?.trim()) creditRelations.push({ trackId, name: name.trim(), role: 'conductor', position: position++ });
      }

      if (track.country) {
        for (const value of track.country.split(/[;,]/).map((item) => item.trim()).filter(Boolean)) {
          countryRelations.push({ trackId, value });
        }
      }

      if (track.language) {
        for (const value of track.language.split(/[;,]/).map((item) => item.trim()).filter(Boolean)) {
          languageRelations.push({ trackId, value });
        }
      }
    }

    const artistNames = [...new Set([...artistRelations, ...creditRelations].map((relation) => relation.name))];
    const artistIdByName = new Map<string, number>();
    if (artistNames.length > 0) {
      const artistResult = await client.query<{ id: number | string; name: string }>(
        `INSERT INTO artists(name, ascii_name)
         SELECT name, ascii_name
         FROM unnest($1::text[], $2::text[]) AS incoming(name, ascii_name)
         ON CONFLICT (name) DO UPDATE
         SET ascii_name = EXCLUDED.ascii_name
         RETURNING id, name`,
        [artistNames, artistNames.map((name) => asciiFold(name) || null)]
      );
      for (const artist of artistResult.rows) artistIdByName.set(artist.name, Number(artist.id));
    }

    if (artistRelations.length > 0) {
      await client.query(
        `INSERT INTO track_artists(track_id, artist_id, role, position)
         SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::text[], $4::int[])
         ON CONFLICT DO NOTHING`,
        [
          artistRelations.map((relation) => relation.trackId),
          artistRelations.map((relation) => artistIdByName.get(relation.name)),
          artistRelations.map((relation) => relation.role),
          artistRelations.map((relation) => relation.position),
        ]
      );
    }

    if (creditRelations.length > 0) {
      await client.query(
        `INSERT INTO track_credits(track_id, artist_id, role, position)
         SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::text[], $4::int[])
         ON CONFLICT DO NOTHING`,
        [
          creditRelations.map((relation) => relation.trackId),
          creditRelations.map((relation) => artistIdByName.get(relation.name)),
          creditRelations.map((relation) => relation.role),
          creditRelations.map((relation) => relation.position),
        ]
      );
    }

    const insertTagRelations = async (table: string, column: string, relations: Array<{ trackId: number; value: string }>) => {
      if (relations.length === 0) return;
      await client.query(
        `INSERT INTO ${table}(track_id, ${column})
         SELECT * FROM unnest($1::bigint[], $2::text[])
         ON CONFLICT DO NOTHING`,
        [relations.map((relation) => relation.trackId), relations.map((relation) => relation.value)]
      );
    };
    await insertTagRelations('track_genres', 'genre', genreRelations);
    await insertTagRelations('track_countries', 'country', countryRelations);
    await insertTagRelations('track_languages', 'language', languageRelations);

    await client.query(
      `INSERT INTO audit_events(event, meta)
       SELECT * FROM unnest($1::text[], $2::jsonb[])`,
      [
        tracks.map((track) => track.isRestored ? 'track_restored' : track.isNew ? 'track_added' : 'track_updated'),
        tracks.map((track) => JSON.stringify({ path: track.path, title: track.title, artist: track.artist })),
      ]
    );
    
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Load existing tracks for comparison (only non-deleted ones for change detection)
async function loadExistingTracks(libraryId: number): Promise<Map<string, { mtimeMs: number; sizeBytes: number; birthtimeMs: number | null; bpm: number | null }>> {
  const result = await db().query<{ path: string; mtime_ms: string; size_bytes: string; birthtime_ms: string | null; bpm: number | null }>(
    'SELECT path, mtime_ms, size_bytes, birthtime_ms, bpm FROM tracks WHERE library_id = $1 AND deleted_at IS NULL',
    [libraryId]
  );
  const map = new Map<string, { mtimeMs: number; sizeBytes: number; birthtimeMs: number | null; bpm: number | null }>();
  for (const row of result.rows) {
    map.set(row.path, {
      mtimeMs: Number(row.mtime_ms),
      sizeBytes: Number(row.size_bytes),
      birthtimeMs: row.birthtime_ms == null ? null : Number(row.birthtime_ms),
      bpm: row.bpm == null ? null : Number(row.bpm),
    });
  }
  return map;
}

// Load soft-deleted tracks that can be restored
async function loadDeletedTracks(libraryId: number): Promise<Set<string>> {
  const result = await db().query<{ path: string }>(
    'SELECT path FROM tracks WHERE library_id = $1 AND deleted_at IS NOT NULL',
    [libraryId]
  );
  return new Set(result.rows.map(r => r.path));
}

// Get or create library
async function getOrCreateLibrary(mountPath: string): Promise<number> {
  const r = await db().query<{ id: number }>('SELECT id FROM libraries WHERE mount_path = $1', [mountPath]);
  if (r.rows.length > 0) return Number(r.rows[0].id);
  const ins = await db().query<{ id: number }>('INSERT INTO libraries(mount_path) VALUES ($1) RETURNING id', [mountPath]);
  return Number(ins.rows[0].id);
}

async function refreshArtistAsciiNames(): Promise<number> {
  const result = await db().query<{ id: number; name: string; ascii_name: string | null }>(
    'SELECT id, name, ascii_name FROM artists WHERE name IS NOT NULL'
  );
  const changed = result.rows
    .map((artist) => ({ id: artist.id, asciiName: asciiFold(artist.name) || null }))
    .filter((artist, index) => artist.asciiName !== result.rows[index].ascii_name);
  if (changed.length === 0) return 0;

  await db().query(
    `UPDATE artists AS artist
     SET ascii_name = incoming.ascii_name
     FROM unnest($1::bigint[], $2::text[]) AS incoming(id, ascii_name)
     WHERE artist.id = incoming.id`,
    [changed.map((artist) => artist.id), changed.map((artist) => artist.asciiName)]
  );
  return changed.length;
}

// Scan for artist artwork in library directories
// Looks for artist.jpg/png, band.jpg/png, photo.jpg/png in artist folders
async function scanArtistArtwork(musicDir: string): Promise<number> {
  logger.info('artist-art', 'Scanning for artist artwork...');

  const artistsResult = await db().query<{ id: number; name: string; art_path: string | null }>(
    'SELECT id, name, art_path FROM artists'
  );

  if (artistsResult.rows.length === 0) {
    logger.info('artist-art', 'No artists in database');
    return 0;
  }

  let rootEntries: Dirent[];
  try {
    rootEntries = await readdir(musicDir, { withFileTypes: true });
  } catch (error) {
    logger.warn(
      'artist-art',
      `Skipping artist artwork scan because the library root is unavailable: ${error instanceof Error ? error.message : String(error)}`
    );
    return 0;
  }
  const artistFolders = new Map<string, string>();
  for (const entry of rootEntries) {
    if (!entry.isDirectory()) continue;
    const key = entry.name.normalize('NFC').toLocaleLowerCase();
    if (!artistFolders.has(key)) artistFolders.set(key, entry.name);
  }

  let updated = 0;

  await processFilesParallel(
    artistsResult.rows,
    ARTIST_ART_CONCURRENCY,
    async (artist) => {
      if (artist.art_path) {
        try {
          await stat(path.join(ART_DIR, artist.art_path));
          return null;
        } catch {
          await db().query('UPDATE artists SET art_path = NULL, art_hash = NULL WHERE id = $1', [artist.id]);
        }
      }

      const folderName = artistFolders.get(artist.name.normalize('NFC').toLocaleLowerCase());
      if (!folderName) return null;

      try {
        const artistDir = resolveInside(musicDir, folderName);
        const files = await readdir(artistDir);
        const fileByLowerName = new Map(files.map((file) => [file.toLowerCase(), file]));
        const artFile = ARTIST_IMAGE_NAMES
          .map((imageName) => fileByLowerName.get(imageName))
          .find((file): file is string => Boolean(file));
        if (!artFile) return null;

        const data = await readFile(path.join(artistDir, artFile));
        const hash = createHash('sha1').update(data).digest('hex');
        const ext = path.extname(artFile).toLowerCase();
        const relPath = `artists/${hash.slice(0, 2)}/${hash}${ext}`;
        const absPath = path.join(ART_DIR, relPath);
        await mkdir(path.dirname(absPath), { recursive: true });
        await writeFile(absPath, data);
        await db().query(
          'UPDATE artists SET art_path = $1, art_hash = $2 WHERE id = $3',
          [relPath, hash, artist.id]
        );
        return artist.name;
      } catch {
        return null;
      }
    },
    async (artistName) => {
      if (!artistName) return;
      updated++;
      logger.success('artist-art', `Found artwork for ${artistName}`);
    }
  );

  logger.success('artist-art', `Updated ${updated} artist artworks`);
  return updated;
}

// Main fast scan function
export async function runFastScan(
  musicDir: string,
  forceFullScan: boolean = false,
  ctx?: { libraryIndex?: number; libraryTotal?: number; shouldCancel?: () => boolean }
): Promise<{ 
  totalFiles: number; 
  newFiles: number; 
  updatedFiles: number; 
  skippedFiles: number;
  failedFiles: number;
  durationMs: number;
}> {
  const startTime = Date.now();
  const libraryIndex = ctx?.libraryIndex;
  const libraryTotal = ctx?.libraryTotal;
  const shouldCancel = ctx?.shouldCancel ?? (() => false);

  class ScanCancelledError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'ScanCancelledError';
    }
  }

  const cancelNow = (where: string) => {
    if (!shouldCancel()) return;
    const durationMs = Date.now() - startTime;
    const progress: any = {
      status: 'idle',
      mountPath: musicDir,
      libraryIndex,
      libraryTotal,
      filesFound: 0,
      filesProcessed: 0,
      currentFile: `Cancelled (${where})`,
      durationMs,
      cancelled: true,
    };
    storeProgress(progress);
    publishUpdate('scan:progress', progress);
    throw new ScanCancelledError(`cancelled: ${where}`);
  };

  logger.info('scan', `Fast scan starting: ${musicDir}${forceFullScan ? ' (FORCE FULL)' : ''}`, {
    concurrency: CONCURRENCY,
    metadataTimeoutMs: METADATA_TIMEOUT_MS,
    uvThreadpoolSize: Number(process.env.UV_THREADPOOL_SIZE ?? 4),
  });
  if (TEMPO_IN_SCAN) {
    logger.info('tempo', 'Tempo detection enabled during scan (missing-tag backfill)', {
      method: TEMPO_METHOD,
      minConfidence: TEMPO_MIN_CONF,
      concurrency: TEMPO_CONCURRENCY,
    });
  }
  
  // Set initial scanning status
  const initialProgress = {
    status: 'scanning',
    mountPath: musicDir,
    libraryIndex,
    libraryTotal,
    filesFound: 0,
    filesProcessed: 0,
    currentFile: 'Initializing...',
  };
  storeProgress(initialProgress);
  publishUpdate('scan:progress', initialProgress);
  
  cancelNow('before_init');

  try {
    const root = await stat(musicDir);
    if (!root.isDirectory()) throw new Error('configured library path is not a directory');
    await readdir(musicDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const progress = {
      status: 'error',
      mountPath: musicDir,
      libraryIndex,
      libraryTotal,
      filesFound: 0,
      filesProcessed: 0,
      currentFile: 'Library unavailable',
      error: message,
    };
    storeProgress(progress);
    publishUpdate('scan:progress', progress);
    throw new Error(`Library is unavailable: ${musicDir}: ${message}`);
  }

  const libraryId = await getOrCreateLibrary(musicDir);
  
  // Phase 1: Load existing tracks for comparison (fast DB query)
  logger.info('scan', 'Loading existing tracks from database...');
  const existingTracks = await loadExistingTracks(libraryId);
  const deletedTracks = await loadDeletedTracks(libraryId);

  // Tracks which currently have invalid artist rows (e.g. "????") should be refreshed even if the file is unchanged.
  const badArtistPaths = new Set<string>();
  const missingDurationPaths = new Set<string>();
  if (!forceFullScan) {
    const bad = await db().query<{ path: string }>(
      `select distinct t.path
       from tracks t
       join track_artists ta on ta.track_id = t.id
       join artists a on a.id = ta.artist_id
       where t.library_id = $1 and t.deleted_at is null and a.name ~ '\\?{2,}'`,
      [libraryId]
    );
    for (const r of bad.rows) badArtistPaths.add(r.path);
    if (badArtistPaths.size > 0) {
      logger.info('scan', `Will refresh ${badArtistPaths.size} tracks with invalid artist tags`);
    }

    // OPUS durations may be missing when duration calc was disabled previously; refresh those too.
    const missDur = await db().query<{ path: string }>(
      `select t.path
       from tracks t
       where t.library_id = $1 and t.deleted_at is null and t.duration_ms is null`,
      [libraryId]
    );
    for (const r of missDur.rows) missingDurationPaths.add(r.path);
    if (missingDurationPaths.size > 0) {
      logger.info('scan', `Will refresh ${missingDurationPaths.size} tracks missing duration`);
    }
  }

  logger.info('scan', `Loaded ${existingTracks.size} existing tracks (${deletedTracks.size} soft-deleted)`);
  
  cancelNow('after_db_load');

  // Phase 2: Walk directory and collect files
  logger.info('scan', 'Scanning filesystem...');
  const allFiles: FileInfo[] = [];
  let filesystemErrors = 0;
  const filesystemErrorSamples: string[] = [];
  const onFilesystemError = (target: string, error: unknown) => {
    filesystemErrors++;
    if (filesystemErrorSamples.length < 10) {
      filesystemErrorSamples.push(`${target}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  for await (const file of walkDirectory(musicDir, musicDir, onFilesystemError)) {
    if (shouldCancel()) cancelNow('discovering_files');
    allFiles.push(file);
    if (allFiles.length % 1000 === 0) {
      logger.progress('scan', 'Discovering files', allFiles.length, allFiles.length);
      // Update progress during discovery
      const discoveryProgress = {
        status: 'scanning',
        mountPath: musicDir,
        libraryIndex,
        libraryTotal,
        filesFound: allFiles.length,
        filesProcessed: 0,
        currentFile: `Discovering files... (${allFiles.length.toLocaleString()} found)`,
      };
      storeProgress(discoveryProgress);
      publishUpdate('scan:progress', discoveryProgress);
    }
  }
  logger.success('scan', `Found ${allFiles.length} audio files`);
  if (filesystemErrors > 0) {
    logger.warn('scan', `Filesystem scan had ${filesystemErrors} read/stat errors; orphan cleanup will be skipped`, {
      samples: filesystemErrorSamples,
    });
  }
  
  // Phase 3: Filter to only new/changed files, and detect files to restore
  // Force full scan: process all files regardless of mtime/size
  const filesToProcess: FileInfo[] = [];
  const filesToRestore: string[] = [];
  let skippedFiles = 0;
  for (const file of allFiles) {
    if (shouldCancel()) cancelNow('filtering_files');
    const existing = existingTracks.get(file.relPath);
    if (forceFullScan) {
      // Force mode: process all files
      if (deletedTracks.has(file.relPath)) {
        filesToRestore.push(file.relPath);
      }
      filesToProcess.push(file);
    } else if (existing && existing.mtimeMs === file.mtimeMs && existing.sizeBytes === file.sizeBytes) {
      // If we're missing birthtime_ms in the DB (older rows), re-process unchanged files to backfill it.
      if (existing.birthtimeMs == null || badArtistPaths.has(file.relPath) || missingDurationPaths.has(file.relPath)) {
        filesToProcess.push(file);
      } else {
        skippedFiles++;
      }
    } else if (deletedTracks.has(file.relPath)) {
      // File was soft-deleted but now exists - restore it and reprocess
      filesToRestore.push(file.relPath);
      filesToProcess.push(file);
    } else {
      filesToProcess.push(file);
    }
  }
  
  // Restoration is performed atomically by the successful metadata upsert.
  // Leaving deleted_at intact until then prevents an unreadable file from
  // reactivating stale catalogue data.
  if (filesToRestore.length > 0) {
    logger.info('scan', `Will restore ${filesToRestore.length} previously deleted tracks after successful metadata reads`);
  }
  
  logger.info('scan', `${filesToProcess.length} files to process, ${skippedFiles} unchanged`);
  const processingQueue = filesToProcess
    .map((file) => ({ file, order: scanOrderKey(file.relPath) }))
    .sort((a, b) => a.order - b.order || a.file.relPath.localeCompare(b.file.relPath))
    .map(({ file }) => file);
  
  // Update Redis progress
  const updateProgress = (processed: number) => {
    const progress = {
      status: 'scanning',
      mountPath: musicDir,
      libraryIndex,
      libraryTotal,
      filesFound: allFiles.length,
      filesProcessed: skippedFiles + processed,
      newFiles: filesToProcess.length,
      skipped: skippedFiles,
      failedFiles,
      failureSamples: failedFileSamples,
      filesystemErrors,
    };
    storeProgress(progress);
    publishUpdate('scan:progress', progress);
  };
  
  // Phase 4: Process files in parallel batches
  let processed = 0;
  let newFiles = 0;
  let updatedFiles = 0;
  let failedFiles = 0;
  const failedFileSamples: string[] = [];
  let lastProgressTime = Date.now();
  const batch: TrackData[] = [];

  let tempoTried = 0;
  let tempoApplied = 0;
  let tempoLowConfidence = 0;
  let tempoFailed = 0;
  
  if (shouldCancel()) cancelNow('processing_files');
  await processFilesParallel(
      processingQueue,
      CONCURRENCY,
      async (file) => {
        try {
          if (shouldCancel()) return null;
          // Read metadata
          const tags = await readTagsWithTimeout(file.fullPath);

          const existing = existingTracks.get(file.relPath);

          // Optional: detect tempo and store in DB when missing from tags.
          // IMPORTANT: if the DB already has bpm for this track, skip detection (especially for FORCE FULL scans)
          // since it would otherwise re-run ffmpeg/DSP for every file without a BPM tag.
          let detectedBpm: number | null = null;
          if (
            TEMPO_IN_SCAN &&
            existing?.bpm == null &&
            (tags.bpm == null || !Number.isFinite(tags.bpm) || tags.bpm <= 0)
          ) {
            tempoTried++;
            try {
              const res = await withTempoSlot(() => detectTempoBpm(file.fullPath, { onsetMethod: TEMPO_METHOD }));
              if (res.confidence >= TEMPO_MIN_CONF && Number.isFinite(res.bpm) && res.bpm > 0) {
                detectedBpm = res.bpm;
                tempoApplied++;
              } else {
                tempoLowConfidence++;
              }
            } catch (e) {
              tempoFailed++;
              logger.debug('tempo', `Tempo detect failed: ${e instanceof Error ? e.message : String(e)}`);
            }
          }

          // Handle art
          let artPath: string | null = null;
          let artMime: string | null = null;
          let artHash: string | null = null;
          if (tags.artData && tags.artMime) {
            try {
              const w = await writeArt(ART_DIR, tags.artData, tags.artMime);
              artPath = w.relPath;
              artMime = w.mime;
              artHash = w.hash;
            } catch {}
          }

          // Check lyrics
          const baseNoExtRel = file.relPath.replace(/\.[^./\\]+$/, '');
          const lyricsRel = `${baseNoExtRel}.lrc`;
          const lyricsAbs = path.join(LYRICS_DIR, lyricsRel);
          let lyricsPath: string | null = null;
          try {
            const lst = await stat(lyricsAbs);
            if (lst.isFile()) lyricsPath = lyricsRel;
          } catch {
            const txtRel = `${baseNoExtRel}.txt`;
            const txtAbs = path.join(LYRICS_DIR, txtRel);
            try {
              const tst = await stat(txtAbs);
              if (tst.isFile()) lyricsPath = txtRel;
            } catch {
              // no lyrics sidecar files in the lyrics cache
            }
          }

          if (!lyricsPath) {
            const baseNoExtAbs = file.fullPath.replace(/\.[^./\\]+$/, '');
            for (const sidecarExt of ['.lrc', '.txt']) {
              try {
                const sst = await stat(baseNoExtAbs + sidecarExt);
                if (sst.isFile()) {
                  lyricsPath = `music:${path.relative(musicDir, baseNoExtAbs + sidecarExt)}`;
                  break;
                }
              } catch {
                // no music-dir sidecar for this extension
              }
            }
          }

          const isNew = !existing;
          return {
            libraryId,
            path: file.relPath,
            mtimeMs: file.mtimeMs,
            birthtimeMs: file.birthtimeMs,
            sizeBytes: file.sizeBytes,
            ext: file.ext,
            title: tags.title,
            artist: tags.artist,
            album: tags.album,
            albumartist: tags.albumartist,
            genre: tags.genre,
            country: tags.country,
            language: tags.language,
            year: tags.year,
            durationMs: tags.durationMs,
            artPath,
            artMime,
            artHash,
            lyricsPath,
            embeddedLyrics: tags.embeddedLyrics,
            embeddedLyricsSynced: tags.embeddedLyricsSynced,
            artists: tags.artists,
            albumartists: tags.albumartists,
            composers: tags.composers || [],
            conductors: tags.conductors || [],
            trackNumber: tags.trackNumber,
            trackTotal: tags.trackTotal,
            discNumber: tags.discNumber,
            discTotal: tags.discTotal,
            // Extended metadata
            bpm: tags.bpm ?? detectedBpm ?? null,
            initialKey: tags.initialKey ?? null,
            composer: tags.composer ?? null,
            conductor: tags.conductor ?? null,
            publisher: tags.publisher ?? null,
            copyright: tags.copyright ?? null,
            comment: tags.comment ?? null,
            mood: tags.mood ?? null,
            grouping: tags.grouping ?? null,
            isrc: tags.isrc ?? null,
            releaseDate: tags.releaseDate ?? null,
            originalYear: tags.originalYear ?? null,
            compilation: tags.compilation ?? false,
            // Sort fields
            titleSort: tags.titleSort ?? null,
            artistSort: tags.artistSort ?? null,
            albumSort: tags.albumSort ?? null,
            albumArtistSort: tags.albumArtistSort ?? null,
            // MusicBrainz IDs
            musicbrainzTrackId: tags.musicbrainzTrackId ?? null,
            musicbrainzReleaseId: tags.musicbrainzReleaseId ?? null,
            musicbrainzArtistId: tags.musicbrainzArtistId ?? null,
            musicbrainzAlbumArtistId: tags.musicbrainzAlbumArtistId ?? null,
            isNew,
            isRestored: deletedTracks.has(file.relPath),
          };
        } catch (error) {
          failedFiles++;
          if (failedFileSamples.length < 10) {
            const failure = `${file.relPath}: ${error instanceof Error ? error.message : String(error)}`;
            failedFileSamples.push(failure);
            logger.warn('scan', `Metadata read failed: ${failure}`);
          }
          return null;
        }
      },
      async (result) => {
        if (!result) return;
        batch.push(result);
        if (result.isNew) {
          newFiles++;
          publishUpdate('track_added', {
            path: result.path,
            title: result.title,
            artist: result.artist,
            album: result.album,
          });
        } else {
          updatedFiles++;
          publishUpdate('track_updated', {
            path: result.path,
            title: result.title,
            artist: result.artist,
            album: result.album,
          });
        }

        if (batch.length >= BATCH_SIZE) {
          await batchUpsertTracks(batch.splice(0, BATCH_SIZE));
        }
      },
      (totalProcessed) => {
        processed = totalProcessed;
        const now = Date.now();
        if (now - lastProgressTime > PROGRESS_INTERVAL) {
          lastProgressTime = now;
          logger.progress('scan', 'Processing files', totalProcessed, filesToProcess.length);
          updateProgress(totalProcessed);
        }
      }
    );
  updateProgress(processed);
  
  // Insert remaining batch
  if (batch.length > 0) {
    await batchUpsertTracks(batch);
  }
  if (failedFiles > 0) {
    logger.warn('scan', `Failed to read metadata for ${failedFiles} files`, { samples: failedFileSamples });
  }
  
  // Phase 5: Soft-delete orphan tracks (in DB but not on disk)
  // Using soft-delete preserves user data (history, favorites, playlists)
  const diskPaths = new Set(allFiles.map(f => f.relPath));
  const orphanPaths: string[] = [];
  for (const [dbPath] of existingTracks) {
    if (!diskPaths.has(dbPath)) {
      orphanPaths.push(dbPath);
    }
  }
  
  if (orphanPaths.length > 0 && filesystemErrors === 0) {
    logger.info('scan', `Soft-deleting ${orphanPaths.length} orphan tracks...`);
    
    // Soft-delete in batches (set deleted_at instead of DELETE)
    const ORPHAN_BATCH_SIZE = 100;
    for (let i = 0; i < orphanPaths.length; i += ORPHAN_BATCH_SIZE) {
      const pathBatch = orphanPaths.slice(i, i + ORPHAN_BATCH_SIZE);
      await db().query(
        'UPDATE tracks SET deleted_at = NOW() WHERE library_id = $1 AND path = ANY($2) AND deleted_at IS NULL',
        [libraryId, pathBatch]
      );
      
      // Emit audit events and live updates for deletions
      for (const p of pathBatch) {
        audit('track_removed', { path: p, actor: 'worker' });
        publishUpdate('track_removed', { path: p });
      }
    }
    
    logger.success('scan', `Soft-deleted ${orphanPaths.length} orphan tracks`);
  } else if (orphanPaths.length > 0) {
    logger.warn('scan', `Preserving ${orphanPaths.length} apparent orphan tracks because the filesystem scan was incomplete`);
    orphanPaths.length = 0;
  }
  
  if (shouldCancel()) cancelNow('before_indexing');

  // Phase 6: Update search index
  {
    const progress = {
      status: 'indexing',
      mountPath: musicDir,
      libraryIndex,
      libraryTotal,
      filesFound: allFiles.length,
      filesProcessed: allFiles.length,
      currentFile: 'Indexing search…',
    };
    storeProgress(progress);
    publishUpdate('scan:progress', progress);
  }
  const refreshedArtistNames = await refreshArtistAsciiNames();
  if (refreshedArtistNames > 0) {
    logger.info('scan', `Refreshed folded search names for ${refreshedArtistNames} artists`);
  }
  const hasChanges = filesToProcess.length > 0 || orphanPaths.length > 0 || filesToRestore.length > 0;
  await ensureTracksIndex();
  if (forceFullScan) {
    logger.info('search', 'Full search re-index...');
    await indexAllTracks();
    logger.success('search', 'Search index updated (full)');
  } else if (hasChanges) {
    // Incremental index: only re-index tracks that were processed
    const processedPaths = filesToProcess.map(f => f.relPath);
    const idResult = await db().query<{ id: number | string }>(
      'SELECT id FROM tracks WHERE library_id = $1 AND path = ANY($2) AND deleted_at IS NULL',
      [libraryId, processedPaths]
    );
    const changedIds = idResult.rows.map(r => Number(r.id));
    const orphanIdResult = orphanPaths.length > 0
      ? await db().query<{ id: number | string }>(
          'SELECT id FROM tracks WHERE library_id = $1 AND path = ANY($2)',
          [libraryId, orphanPaths]
        )
      : { rows: [] };
    const deletedIds = orphanIdResult.rows.map(r => Number(r.id));
    const result = await indexChangedTracks(changedIds, deletedIds);
    logger.success('search', `Search index updated (incremental: ${result.indexed} indexed, ${result.deleted} removed)`);
  } else {
    logger.info('search', 'No library changes detected');
  }

  let indexStatus = await getTrackIndexStatus();
  if (!indexStatus.consistent) {
    logger.warn(
      'search',
      `Search index mismatch (${indexStatus.index} indexed, ${indexStatus.database} active); rebuilding`
    );
    await indexAllTracks();
    indexStatus = await getTrackIndexStatus();
  }
  if (!indexStatus.consistent) {
    throw new Error(
      `Search index consistency check failed (${indexStatus.index} indexed, ${indexStatus.database} active)`
    );
  }
  logger.success('search', `Search index verified (${indexStatus.index} documents)`);
  
  if (shouldCancel()) cancelNow('before_artist_artwork');

  // Phase 7: Scan for artist artwork
  {
    const progress = {
      status: 'indexing',
      mountPath: musicDir,
      libraryIndex,
      libraryTotal,
      filesFound: allFiles.length,
      filesProcessed: allFiles.length,
      currentFile: 'Scanning artist artwork…',
    };
    storeProgress(progress);
    publishUpdate('scan:progress', progress);
  }
  await scanArtistArtwork(musicDir);
  
  const durationMs = Date.now() - startTime;
  const durationSec = Math.round(durationMs / 1000);
  const rate = Math.round(allFiles.length / (durationMs / 1000));
  
  if (TEMPO_IN_SCAN) {
    logger.info('tempo', 'Tempo detection stats (scan)', {
      tried: tempoTried,
      applied: tempoApplied,
      lowConfidence: tempoLowConfidence,
      failed: tempoFailed,
    });
  }

  logger.success('scan', `Scan complete in ${durationSec}s - ${allFiles.length} files (${rate} files/sec)`);
  
  // Final progress update
  const progress = {
    status: 'idle',
    mountPath: musicDir,
    libraryIndex,
    libraryTotal,
    filesFound: allFiles.length,
    filesProcessed: allFiles.length,
    failedFiles,
    failureSamples: failedFileSamples,
    filesystemErrors,
    durationMs,
  };
  storeProgress(progress);
  publishUpdate('scan:complete', progress);
  
  return {
    totalFiles: allFiles.length,
    newFiles,
    updatedFiles,
    skippedFiles,
    failedFiles,
    durationMs,
  };
}

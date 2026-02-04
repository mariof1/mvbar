import { readdir, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Redis from 'ioredis';
import { db, audit } from './db.js';
import { readTags } from './metadata.js';
import { writeArt } from './art.js';
import { indexAllTracks, ensureTracksIndex } from './indexer.js';
import logger from './logger.js';

const LYRICS_DIR = process.env.LYRICS_DIR ?? '/data/cache/lyrics';
const ART_DIR = process.env.ART_DIR ?? '/data/cache/art';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://redis:6379';
const AUDIO_EXTS = new Set(['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wav']);
const ARTIST_IMAGE_NAMES = ['artist.jpg', 'artist.jpeg', 'artist.png', 'band.jpg', 'band.jpeg', 'band.png', 'photo.jpg', 'photo.jpeg', 'photo.png'];

// Tuning parameters
const BATCH_SIZE = 100;  // DB batch insert size
const CONCURRENCY = 100;  // Parallel file reads (increased for network FS)
const PROGRESS_INTERVAL = 3000;  // Progress log interval in ms

// Redis publisher for live updates
let publisher: Redis | null = null;
function getPublisher() {
  if (!publisher) {
    publisher = new Redis(REDIS_URL);
  }
  return publisher;
}

// Publish library update event
function publishUpdate(event: string, data: Record<string, unknown>) {
  getPublisher().publish('library:updates', JSON.stringify({ event, ...data, ts: Date.now() }));
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
  artists: string[];       // Array of individual artist names
  albumartists: string[];  // Array of individual album artist names
  trackNumber: number | null;
  trackTotal: number | null;
  discNumber: number | null;
  discTotal: number | null;
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
async function* walkDirectory(dir: string, rootDir: string): AsyncGenerator<FileInfo> {
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
              } catch {
                // Skip files we can't stat
              }
            }
          }
        }
        return { dirs, files };
      } catch {
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

// Parallel file processor with concurrency limit
async function processFilesParallel<T, R>(
  items: T[],
  concurrency: number,
  processor: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let index = 0;
  
  async function worker(): Promise<void> {
    while (index < items.length) {
      const i = index++;
      try {
        results[i] = await processor(items[i]);
      } catch (e) {
        results[i] = null as any;
      }
    }
  }
  
  const workers = Array(Math.min(concurrency, items.length))
    .fill(null)
    .map(() => worker());
  
  await Promise.all(workers);
  return results;
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
    const trackNumbers = tracks.map(t => t.trackNumber);
    const trackTotals = tracks.map(t => t.trackTotal);
    const discNumbers = tracks.map(t => t.discNumber);
    const discTotals = tracks.map(t => t.discTotal);
    
    // Insert/update tracks and get their IDs
    const trackResult = await client.query<{ id: number; path: string }>(`
      INSERT INTO tracks (library_id, path, mtime_ms, size_bytes, ext, title, artist, album, album_artist, genre, country, language, year, duration_ms, art_path, art_mime, art_hash, lyrics_path, track_number, track_total, disc_number, disc_total, last_seen_job_id, updated_at, created_at)
      SELECT 
        u.library_id, u.path, u.mtime_ms, u.size_bytes, u.ext,
        u.title, u.artist, u.album, u.album_artist, u.genre,
        u.country, u.language, u.year, u.duration_ms, u.art_path,
        u.art_mime, u.art_hash, u.lyrics_path, u.track_number, u.track_total,
        u.disc_number, u.disc_total, u.last_seen_job_id, u.updated_at,
        to_timestamp(u.birthtime_ms::double precision / 1000.0)
      FROM unnest(
        $1::bigint[], $2::text[], $3::bigint[], $4::bigint[], $5::text[],
        $6::text[], $7::text[], $8::text[], $9::text[], $10::text[],
        $11::text[], $12::text[], $13::int[], $14::int[], $15::text[],
        $16::text[], $17::text[], $18::text[], $19::int[], $20::int[],
        $21::int[], $22::int[], $23::int[], $24::timestamptz[], $25::bigint[]
      ) AS u(library_id, path, mtime_ms, size_bytes, ext, title, artist, album, album_artist, genre, country, language, year, duration_ms, art_path, art_mime, art_hash, lyrics_path, track_number, track_total, disc_number, disc_total, last_seen_job_id, updated_at, birthtime_ms)
      ON CONFLICT (library_id, path) DO UPDATE SET
        mtime_ms = EXCLUDED.mtime_ms,
        size_bytes = EXCLUDED.size_bytes,
        ext = EXCLUDED.ext,
        title = EXCLUDED.title,
        artist = EXCLUDED.artist,
        album = EXCLUDED.album,
        album_artist = EXCLUDED.album_artist,
        genre = COALESCE(EXCLUDED.genre, tracks.genre),
        country = COALESCE(EXCLUDED.country, tracks.country),
        language = COALESCE(EXCLUDED.language, tracks.language),
        year = COALESCE(EXCLUDED.year, tracks.year),
        duration_ms = EXCLUDED.duration_ms,
        art_path = EXCLUDED.art_path,
        art_mime = EXCLUDED.art_mime,
        art_hash = EXCLUDED.art_hash,
        lyrics_path = EXCLUDED.lyrics_path,
        track_number = EXCLUDED.track_number,
        track_total = EXCLUDED.track_total,
        disc_number = EXCLUDED.disc_number,
        disc_total = EXCLUDED.disc_total,
        last_seen_job_id = EXCLUDED.last_seen_job_id,
        created_at = EXCLUDED.created_at,
        updated_at = now()
      RETURNING id, path
    `, [
      libraryIds, paths, mtimeMss, sizeBytes, exts,
      titles, artists, albums, albumArtists, genres,
      countries, languages, years, durations, artPaths,
      artMimes, artHashes, lyricsPaths, trackNumbers, trackTotals,
      discNumbers, discTotals,
      tracks.map(() => 0),  // last_seen_job_id = 0 for fast scan
      tracks.map(() => new Date()),
      birthtimeMss
    ]);
    
    // Build path -> track mapping for artist updates
    const pathToTrackId = new Map<string, number>();
    for (const row of trackResult.rows) {
      pathToTrackId.set(row.path, row.id);
    }
    
    // Update track_artists for each track
    for (const track of tracks) {
      const trackId = pathToTrackId.get(track.path);
      if (!trackId) continue;

      // Collect all artists to insert (sanitize + preserve order)
      const artistsToInsert: { name: string; role: string; position: number }[] = [];
      const sanitize = (s: string) => s.replace(/\0/g, '');
      const norm = (s: string) => sanitize(s).trim();
      const isAllQuestionMarks = (s: string) => /^[?\s]+$/.test(s);
      const folderArtistGuess = (() => {
        // Try to guess artist from folder name for files like "Мэвл/..." when tags decode to "????".
        const first = (track.path.split(/[\\/]/).filter(Boolean)[0] ?? '').trim();
        return first || null;
      })();

      const fixName = (v: string) => {
        const n = norm(v);
        if (!n) return null;
        if (isAllQuestionMarks(n)) return folderArtistGuess ? sanitize(folderArtistGuess) : null;
        return sanitize(n);
      };
      
      let i = 0;
      for (const name of track.albumartists) {
        const fixed = name ? fixName(name) : null;
        if (fixed) artistsToInsert.push({ name: fixed, role: 'albumartist', position: i++ });
      }
      
      i = 0;
      for (const name of track.artists) {
        const fixed = name ? fixName(name) : null;
        if (fixed) artistsToInsert.push({ name: fixed, role: 'artist', position: i++ });
      }
      
      if (artistsToInsert.length === 0) continue;
      
      // Delete existing relations
      await client.query('DELETE FROM track_artists WHERE track_id = $1', [trackId]);
      
      // Insert new artist relations
      for (const { name, role, position } of artistsToInsert) {
        const artistRes = await client.query<{ id: number }>(
          'INSERT INTO artists(name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id',
          [name]
        );
        await client.query(
          'INSERT INTO track_artists(track_id, artist_id, role, position) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
          [trackId, artistRes.rows[0].id, role, position]
        );
      }
      
      // Update track_genres
      if (track.genre) {
        await client.query('DELETE FROM track_genres WHERE track_id = $1', [trackId]);
        const genreList = track.genre.split(/[;,]/).map(g => g.trim()).filter(Boolean);
        for (const genre of genreList) {
          await client.query(
            'INSERT INTO track_genres(track_id, genre) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [trackId, genre]
          );
        }
      }
      
      // Update track_countries
      if (track.country) {
        await client.query('DELETE FROM track_countries WHERE track_id = $1', [trackId]);
        const countryList = track.country.split(/[;,]/).map(c => c.trim()).filter(Boolean);
        for (const country of countryList) {
          await client.query(
            'INSERT INTO track_countries(track_id, country) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [trackId, country]
          );
        }
      }
      
      // Update track_languages
      if (track.language) {
        await client.query('DELETE FROM track_languages WHERE track_id = $1', [trackId]);
        const langList = track.language.split(/[;,]/).map(l => l.trim()).filter(Boolean);
        for (const language of langList) {
          await client.query(
            'INSERT INTO track_languages(track_id, language) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [trackId, language]
          );
        }
      }
    }
    
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Load existing tracks for comparison (only non-deleted ones for change detection)
async function loadExistingTracks(libraryId: number): Promise<Map<string, { mtimeMs: number; sizeBytes: number }>> {
  const result = await db().query<{ path: string; mtime_ms: string; size_bytes: string }>(
    'SELECT path, mtime_ms, size_bytes FROM tracks WHERE library_id = $1 AND deleted_at IS NULL',
    [libraryId]
  );
  const map = new Map<string, { mtimeMs: number; sizeBytes: number }>();
  for (const row of result.rows) {
    map.set(row.path, { mtimeMs: Number(row.mtime_ms), sizeBytes: Number(row.size_bytes) });
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

// Scan for artist artwork in library directories
// Looks for artist.jpg/png, band.jpg/png, photo.jpg/png in artist folders
async function scanArtistArtwork(musicDir: string): Promise<number> {
  logger.info('artist-art', 'Scanning for artist artwork...');
  
  // Get all artists from DB
  const artistsResult = await db().query<{ id: number; name: string; art_path: string | null }>(
    'SELECT id, name, art_path FROM artists'
  );
  
  if (artistsResult.rows.length === 0) {
    logger.info('artist-art', 'No artists in database');
    return 0;
  }
  
  let updated = 0;
  
  // For each artist, try to find artwork in their folder
  for (const artist of artistsResult.rows) {
    // Skip if already has artwork and the cached file still exists
    if (artist.art_path) {
      try {
        await stat(path.join(ART_DIR, artist.art_path));
        continue;
      } catch {
        // Cache missing - fall through and try to rehydrate
        // Clear art_path so we can re-scan and re-create the cached file.
        await db().query('UPDATE artists SET art_path = NULL, art_hash = NULL WHERE id = $1', [artist.id]);
        artist.art_path = null;
      }
    }
    
    // Try to find artist folder (typically /music/ArtistName/)
    const artistDir = path.join(musicDir, artist.name);
    
    try {
      const dirStat = await stat(artistDir);
      if (!dirStat.isDirectory()) continue;
      
      // Look for artist image files
      const files = await readdir(artistDir);
      const lowerFiles = files.map(f => f.toLowerCase());
      
      let artFile: string | null = null;
      for (const imageName of ARTIST_IMAGE_NAMES) {
        const idx = lowerFiles.indexOf(imageName);
        if (idx >= 0) {
          artFile = files[idx]; // Use original case
          break;
        }
      }
      
      if (!artFile) continue;
      
      // Found artist image - read and hash it
      const artPath = path.join(artistDir, artFile);
      const data = await readFile(artPath);
      const hash = createHash('sha1').update(data).digest('hex');
      
      // Determine mime type
      const ext = path.extname(artFile).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
      
      // Store in art cache directory
      const relPath = `artists/${hash.slice(0, 2)}/${hash}${ext}`;
      const absPath = path.join(ART_DIR, relPath);
      const { mkdir, writeFile: writeF } = await import('node:fs/promises');
      await mkdir(path.dirname(absPath), { recursive: true });
      await writeF(absPath, data);
      
      // Update artist record
      await db().query(
        'UPDATE artists SET art_path = $1, art_hash = $2 WHERE id = $3',
        [relPath, hash, artist.id]
      );
      
      updated++;
      logger.success('artist-art', `Found artwork for ${artist.name}`);
    } catch {
      // Artist folder doesn't exist or can't be read - skip
    }
  }
  
  logger.success('artist-art', `Updated ${updated} artist artworks`);
  return updated;
}

// Main fast scan function
export async function runFastScan(musicDir: string, forceFullScan: boolean = false): Promise<{ 
  totalFiles: number; 
  newFiles: number; 
  updatedFiles: number; 
  skippedFiles: number;
  durationMs: number;
}> {
  const startTime = Date.now();
  logger.info('scan', `Fast scan starting: ${musicDir}${forceFullScan ? ' (FORCE FULL)' : ''}`);
  
  // Set initial scanning status
  const initialProgress = {
    status: 'scanning',
    filesFound: 0,
    filesProcessed: 0,
    currentFile: 'Initializing...',
  };
  getPublisher().set('scan:progress', JSON.stringify(initialProgress));
  publishUpdate('scan:progress', initialProgress);
  
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
       where t.library_id = $1 and t.deleted_at is null and a.name ~ '^[?[:space:]]+$'`,
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
       where t.library_id = $1 and t.deleted_at is null and t.duration_ms is null
         and lower(t.ext) in ('.opus','opus','.ogg','ogg')`,
      [libraryId]
    );
    for (const r of missDur.rows) missingDurationPaths.add(r.path);
    if (missingDurationPaths.size > 0) {
      logger.info('scan', `Will refresh ${missingDurationPaths.size} tracks missing duration (opus/ogg)`);
    }
  }

  logger.info('scan', `Loaded ${existingTracks.size} existing tracks (${deletedTracks.size} soft-deleted)`);
  
  // Phase 2: Walk directory and collect files
  logger.info('scan', 'Scanning filesystem...');
  const allFiles: FileInfo[] = [];
  for await (const file of walkDirectory(musicDir, musicDir)) {
    allFiles.push(file);
    if (allFiles.length % 1000 === 0) {
      logger.progress('scan', 'Discovering files', allFiles.length, allFiles.length);
      // Update progress during discovery
      const discoveryProgress = {
        status: 'scanning',
        filesFound: allFiles.length,
        filesProcessed: 0,
        currentFile: `Discovering files... (${allFiles.length.toLocaleString()} found)`,
      };
      getPublisher().set('scan:progress', JSON.stringify(discoveryProgress));
    }
  }
  logger.success('scan', `Found ${allFiles.length} audio files`);
  
  // Phase 3: Filter to only new/changed files, and detect files to restore
  // Force full scan: process all files regardless of mtime/size
  const filesToProcess: FileInfo[] = [];
  const filesToRestore: string[] = [];
  let skippedFiles = 0;
  for (const file of allFiles) {
    const existing = existingTracks.get(file.relPath);
    if (forceFullScan) {
      // Force mode: process all files
      if (deletedTracks.has(file.relPath)) {
        filesToRestore.push(file.relPath);
      }
      filesToProcess.push(file);
    } else if (existing && existing.mtimeMs === file.mtimeMs && existing.sizeBytes === file.sizeBytes) {
      if (badArtistPaths.has(file.relPath) || missingDurationPaths.has(file.relPath)) {
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
  
  // Restore soft-deleted tracks (clear deleted_at)
  if (filesToRestore.length > 0) {
    logger.info('scan', `Restoring ${filesToRestore.length} previously deleted tracks...`);
    await db().query(
      'UPDATE tracks SET deleted_at = NULL WHERE library_id = $1 AND path = ANY($2)',
      [libraryId, filesToRestore]
    );
    for (const p of filesToRestore) {
      audit('track_restored', { path: p, actor: 'worker' });
    }
  }
  
  logger.info('scan', `${filesToProcess.length} files to process, ${skippedFiles} unchanged`);
  
  // Update Redis progress
  const updateProgress = (processed: number) => {
    const progress = {
      status: 'scanning',
      filesFound: allFiles.length,
      filesProcessed: skippedFiles + processed,
      newFiles: filesToProcess.length,
      skipped: skippedFiles,
    };
    getPublisher().set('scan:progress', JSON.stringify(progress));
    publishUpdate('scan:progress', progress);
  };
  
  // Phase 4: Process files in parallel batches
  let processed = 0;
  let newFiles = 0;
  let updatedFiles = 0;
  let lastProgressTime = Date.now();
  const batch: TrackData[] = [];
  
  // Process in chunks
  for (let i = 0; i < filesToProcess.length; i += CONCURRENCY) {
    const chunk = filesToProcess.slice(i, i + CONCURRENCY);
    
    const results = await processFilesParallel(chunk, CONCURRENCY, async (file) => {
      try {
        // Read metadata
        const tags = await readTags(file.fullPath);
        
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
        } catch {}
        
        const isNew = !existingTracks.has(file.relPath);
        const folderArtistGuess = (file.relPath.split(/[\\/]/).filter(Boolean)[0] ?? '').trim() || null;
        const isAllQuestionMarks = (s: string | null) => !!s && /^\?+$/.test(s.trim());

        const fix = (v: string | null) => {
          if (!v) return v;
          if (isAllQuestionMarks(v) && folderArtistGuess) return folderArtistGuess;
          return v;
        };

        return {
          libraryId,
          path: file.relPath,
          mtimeMs: file.mtimeMs,
          birthtimeMs: file.birthtimeMs,
          sizeBytes: file.sizeBytes,
          ext: file.ext,
          title: tags.title,
          artist: fix(tags.artist),
          album: tags.album,
          albumartist: fix(tags.albumartist),
          genre: tags.genre,
          country: tags.country,
          language: tags.language,
          year: tags.year,
          durationMs: tags.durationMs,
          artPath,
          artMime,
          artHash,
          lyricsPath,
          artists: tags.artists.map(a => (isAllQuestionMarks(a) && folderArtistGuess ? folderArtistGuess : a)),
          albumartists: tags.albumartists.map(a => (isAllQuestionMarks(a) && folderArtistGuess ? folderArtistGuess : a)),
          trackNumber: tags.trackNumber,
          trackTotal: tags.trackTotal,
          discNumber: tags.discNumber,
          discTotal: tags.discTotal,
          isNew,
        };
      } catch {
        return null;
      }
    });
    
    // Collect valid results
    for (const r of results) {
      if (r) {
        batch.push(r);
        if (r.isNew) {
          newFiles++;
          // Emit audit event for new track
          await audit('track_added', { path: r.path, title: r.title, artist: r.artist });
        } else {
          updatedFiles++;
          // Emit audit event for updated track
          await audit('track_updated', { path: r.path, title: r.title, artist: r.artist });
        }
        
        // Batch insert
        if (batch.length >= BATCH_SIZE) {
          await batchUpsertTracks(batch);
          batch.length = 0;
        }
      }
    }
    
    processed += chunk.length;
    
    // Log progress
    const now = Date.now();
    if (now - lastProgressTime > PROGRESS_INTERVAL) {
      lastProgressTime = now;
      logger.progress('scan', 'Processing files', processed, filesToProcess.length);
      updateProgress(processed);
    }
  }
  
  // Insert remaining batch
  if (batch.length > 0) {
    await batchUpsertTracks(batch);
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
  
  if (orphanPaths.length > 0) {
    logger.info('scan', `Soft-deleting ${orphanPaths.length} orphan tracks...`);
    
    // Soft-delete in batches (set deleted_at instead of DELETE)
    const ORPHAN_BATCH_SIZE = 100;
    for (let i = 0; i < orphanPaths.length; i += ORPHAN_BATCH_SIZE) {
      const pathBatch = orphanPaths.slice(i, i + ORPHAN_BATCH_SIZE);
      await db().query(
        'UPDATE tracks SET deleted_at = NOW() WHERE library_id = $1 AND path = ANY($2) AND deleted_at IS NULL',
        [libraryId, pathBatch]
      );
      
      // Emit audit events for deletions
      for (const p of pathBatch) {
        audit('track_removed', { path: p, actor: 'worker' });
      }
    }
    
    logger.success('scan', `Soft-deleted ${orphanPaths.length} orphan tracks`);
  }
  
  // Phase 6: Update search index
  logger.info('search', 'Updating search index...');
  await ensureTracksIndex();
  await indexAllTracks();
  logger.success('search', 'Search index updated');
  
  // Phase 7: Scan for artist artwork
  await scanArtistArtwork(musicDir);
  
  const durationMs = Date.now() - startTime;
  const durationSec = Math.round(durationMs / 1000);
  const rate = Math.round(allFiles.length / (durationMs / 1000));
  
  logger.success('scan', `Scan complete in ${durationSec}s - ${allFiles.length} files (${rate} files/sec)`);
  
  // Final progress update
  const progress = {
    status: 'idle',
    filesFound: allFiles.length,
    filesProcessed: allFiles.length,
    durationMs,
  };
  getPublisher().set('scan:progress', JSON.stringify(progress));
  publishUpdate('scan:complete', progress);
  
  return {
    totalFiles: allFiles.length,
    newFiles,
    updatedFiles,
    skippedFiles,
    durationMs,
  };
}

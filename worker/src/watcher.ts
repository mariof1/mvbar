
import * as chokidar from 'chokidar';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import Redis from 'ioredis';
import { db, audit } from './db.js';
import { upsertTrack, markSeen, getTrackByPath } from './scanRepo.js';
import { readTags, readTagsAsync } from './metadata.js';
import { writeArt } from './art.js';
import { indexAllTracks, ensureTracksIndex } from './indexer.js';
import logger from './logger.js';

const LYRICS_DIR = process.env.LYRICS_DIR ?? '/data/cache/lyrics';
const ART_DIR = process.env.ART_DIR ?? '/data/cache/art';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://redis:6379';
const AUDIO_EXTS = new Set(['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wav']);

// Redis publisher for live updates
const publisher = new Redis(REDIS_URL);

// Publish library update event
function publishUpdate(event: string, data: Record<string, unknown>) {
  publisher.publish('library:updates', JSON.stringify({ event, ...data, ts: Date.now() }));
}

// Scan progress tracking
const scanProgress = {
  status: 'idle' as 'idle' | 'scanning' | 'indexing',
  filesFound: 0,
  filesProcessed: 0,
  currentFile: '',
  startedAt: 0,
  lastUpdate: 0,
};

// Progress logging (throttled to every 5 seconds)
let lastProgressLog = 0;
function logProgress() {
  const now = Date.now();
  if (now - lastProgressLog < 5000) return;
  lastProgressLog = now;
  
  const total = scanProgress.filesFound;
  const done = scanProgress.filesProcessed;
  if (total > 0) {
    logger.progress('scan', 'Scanning library', done, total);
  }
}

// Update scan progress in Redis (throttled to every 500ms)
let progressUpdateTimer: NodeJS.Timeout | null = null;
function updateScanProgress() {
  if (progressUpdateTimer) return;
  progressUpdateTimer = setTimeout(() => {
    progressUpdateTimer = null;
    const progress = {
      ...scanProgress,
      queueSize: processingQueue.length,
      activeProcessing,
    };
    publisher.set('scan:progress', JSON.stringify(progress));
    publishUpdate('scan:progress', progress);
    logProgress();
  }, 500);
}

// Debounce map for deleted files to handle "delete-then-replace" atomic writes
const pendingDeletes = new Map<string, NodeJS.Timeout>();
const DELETE_GRACE_MS = 3000;

// Concurrency limiter to prevent DB connection exhaustion
const MAX_CONCURRENT = parseInt(process.env.SCAN_CONCURRENCY ?? '25', 10);
const MAX_QUEUE_SIZE = parseInt(process.env.SCAN_MAX_QUEUE ?? '1000', 10);
let activeProcessing = 0;
const processingQueue: (() => Promise<void>)[] = [];

function processNextInQueue() {
  if (activeProcessing >= MAX_CONCURRENT || processingQueue.length === 0) return;
  const next = processingQueue.shift();
  if (next) {
    activeProcessing++;
    next().finally(() => {
      activeProcessing--;
      processNextInQueue();
    });
  }
}

async function runWithConcurrencyLimit(fn: () => Promise<void>) {
  if (activeProcessing >= MAX_CONCURRENT) {
    // Prevent unbounded queue growth - drop oldest tasks if queue is full
    if (processingQueue.length >= MAX_QUEUE_SIZE) {
      logger.warn('scan', `Queue overflow (${processingQueue.length}), dropping oldest task`);
      processingQueue.shift(); // Drop oldest
    }
    // Queue the task and wait for it to complete
    return new Promise<void>((resolve) => {
      processingQueue.push(async () => {
        try {
          await fn();
        } finally {
          resolve();
        }
      });
    });
  } else {
    activeProcessing++;
    try {
      await fn();
    } finally {
      activeProcessing--;
      processNextInQueue();
    }
  }
}

export class LibraryWatcher {
  private watcher: chokidar.FSWatcher | null = null;
  private root: string;
  private ready = false;
  private skipInitialScan: boolean;

  constructor(root: string, skipInitialScan = false) {
    this.root = root;
    this.skipInitialScan = skipInitialScan;
  }

  start() {
    if (this.skipInitialScan) {
      logger.info('scan', `Watching for changes: ${this.root} (initial scan skipped)`);
      // Set ready immediately when skipping initial scan
      this.ready = true;
    } else {
      logger.info('scan', `Starting library scan: ${this.root}`);
      scanProgress.status = 'scanning';
      scanProgress.filesFound = 0;
      scanProgress.filesProcessed = 0;
      scanProgress.startedAt = Date.now();
      updateScanProgress();
    }

    this.watcher = chokidar.watch(this.root, {
      persistent: true,
      ignoreInitial: this.skipInitialScan, // skip if fast scan already done
      usePolling: true, // required for network filesystems (NFS, SMB)
      interval: 5000, // poll every 5 seconds
      binaryInterval: 5000,
      depth: 99
    });

    this.watcher
      .on('add', (p: string) => this.onAdd(p))
      .on('change', (p: string) => this.onChange(p))
      .on('unlink', (p: string) => this.onUnlink(p))
      .on('ready', () => {
        this.ready = true;
        logger.success('scan', `Discovery complete - found ${scanProgress.filesFound} files`);
        scanProgress.status = 'indexing';
        updateScanProgress();
        this.syncIndex();
      })
      .on('error', (error: unknown) => logger.error('scan', `Watcher error: ${error}`));
  }

  private async onAdd(filePath: string) {
    const rel = path.relative(this.root, filePath);
    
    // Cancel any pending delete for this file (renaming/atomic write case)
    if (pendingDeletes.has(rel)) {
      clearTimeout(pendingDeletes.get(rel));
      pendingDeletes.delete(rel);
      logger.debug('scan', `Cancelled pending delete (file reappeared): ${rel}`);
      return; 
    }

    if (!this.isAudio(filePath)) return;

    // Track progress
    scanProgress.filesFound++;
    scanProgress.currentFile = rel;
    updateScanProgress();

    // Use concurrency limiter to prevent DB connection exhaustion
    runWithConcurrencyLimit(() => this.processFile(filePath, rel));
  }

  private async onChange(filePath: string) {
    if (!this.isAudio(filePath)) return;
    const rel = path.relative(this.root, filePath);
    logger.info('scan', `File changed: ${rel}`);
    
    // Queue the file for processing with a delay to allow NFS sync
    // Use setTimeout to break out of chokidar's event context
    setTimeout(() => {
      runWithConcurrencyLimit(() => this.processFile(filePath, rel));
    }, 500);
  }

  private async onUnlink(filePath: string) {
    if (!this.isAudio(filePath)) return;
    const rel = path.relative(this.root, filePath);
    
    logger.warn('scan', `File deleted: ${rel}`);
    
    // Set a grace period before actually removing from DB
    const timeout = setTimeout(async () => {
      await this.removeTrack(rel);
      pendingDeletes.delete(rel);
      // Trigger search index update after delete
      this.syncIndex();
    }, DELETE_GRACE_MS);
    
    pendingDeletes.set(rel, timeout);
  }

  private isAudio(filePath: string) {
    return AUDIO_EXTS.has(path.extname(filePath).toLowerCase());
  }

  private async processFile(filePath: string, relPath: string) {
    try {
      const st = await stat(filePath);
      
      // Check if file is already up to date in DB
      const existing = await getTrackByPath(this.root, relPath);
      
      // Note: PostgreSQL bigint comes back as string, so use == for comparison or convert
      const fileMtimeMs = Math.round(st.mtimeMs);
      const fileSizeBytes = st.size;
      const isUnchanged = existing && 
        Number(existing.mtime_ms) === fileMtimeMs && 
        Number(existing.size_bytes) === fileSizeBytes && 
        !process.env.SCAN_REFRESH_META;

      // Track processed count
      scanProgress.filesProcessed++;
      updateScanProgress();

      if (isUnchanged) {
        // No work needed
        return;
      }

      // Read Tags using worker thread (isolates file I/O from main event loop)
      let tags;
      try {
        tags = await readTagsAsync(filePath, 30000);
      } catch (e) {
        logger.warn('scan', `Failed to read tags: ${relPath}`, { error: e instanceof Error ? e.message : String(e) });
        return;
      }

      // Handle Art
      let art: { relPath: string; mime: string; hash: string } | null = null;
      if (tags.artData && tags.artMime) {
        try {
          const w = await writeArt(ART_DIR, tags.artData, tags.artMime);
          art = { relPath: w.relPath, mime: w.mime, hash: w.hash };
        } catch (e) {
          logger.warn('scan', `Failed to write art: ${relPath}`);
        }
      }

      // Check lyrics
      const baseNoExtRel = relPath.replace(/\.[^./\\]+$/, '');
      const lyricsRel = `${baseNoExtRel}.lrc`;
      const lyricsAbs = path.join(LYRICS_DIR, lyricsRel);
      let lyricsPath: string | null = null;
      try {
        const lst = await stat(lyricsAbs);
        if (lst.isFile()) lyricsPath = lyricsRel;
      } catch {}

      // Upsert to DB
      await upsertTrack({
        jobId: 0, // 0 = watcher
        mountPath: this.root,
        path: relPath,
        mtimeMs: Math.round(st.mtimeMs),
        sizeBytes: st.size,
        ext: path.extname(filePath).toLowerCase(),
        title: tags.title,
        artist: tags.artist,
        album: tags.album,
        albumartist: tags.albumartist,
        genre: tags.genre,
        country: tags.country,
        language: tags.language,
        year: tags.year,
        durationMs: tags.durationMs,
        artPath: art?.relPath ?? null,
        artMime: art?.mime ?? null,
        artHash: art?.hash ?? null,
        lyricsPath,
        artists: tags.artists,
        albumArtists: tags.albumartists
      });

      scanProgress.filesProcessed++;
      updateScanProgress();
      
      // Only log to audit after initial scan is complete (to avoid flood of events)
      if (this.ready) {
        const action = existing ? 'track_updated' : 'track_added';
        await audit(action, { path: relPath, title: tags.title, artist: tags.artist });
        this.debounceIndex();
        
        // Publish live update to connected clients
        publishUpdate(action, { 
          path: relPath, 
          title: tags.title, 
          artist: tags.artist,
          album: tags.album
        });
      }

    } catch (e) {
      logger.error('scan', `Error processing: ${relPath}`, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  private async removeTrack(relPath: string) {
    try {
      logger.info('scan', `Removing from database: ${relPath}`);
      
      // First get library id for this root
      const res = await db().query("SELECT id FROM libraries WHERE mount_path = $1", [this.root]);
      if (res.rows.length === 0) return;
      const libId = res.rows[0].id;
      
      await db().query("DELETE FROM tracks WHERE library_id = $1 AND path = $2", [libId, relPath]);
      
      // Log removal to audit
      await audit('track_removed', { path: relPath, library_id: libId });
      
      // Publish live update to connected clients
      publishUpdate('track_removed', { path: relPath, library_id: libId });
    } catch (e) {
      logger.error('scan', `Failed to remove: ${relPath}`);
    }
  }

  private indexTimer: NodeJS.Timeout | null = null;
  private debounceIndex() {
    if (this.indexTimer) clearTimeout(this.indexTimer);
    this.indexTimer = setTimeout(() => {
        this.syncIndex();
    }, 5000);
  }

  private async syncIndex() {
      try {
          scanProgress.status = 'indexing';
          updateScanProgress();
          logger.info('search', 'Updating search index...');
          await ensureTracksIndex();
          await indexAllTracks();
          logger.success('search', 'Search index updated');
      } catch (e) {
          logger.error('search', 'Search index update failed');
      } finally {
          scanProgress.status = 'idle';
          updateScanProgress();
      }
  }
}

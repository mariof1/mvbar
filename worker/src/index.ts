import 'dotenv/config';

import Redis from 'ioredis';
import { audit, db, initDb } from './db.js';
import * as transcodeJobs from './transcodeRepo.js';
import { transcodeTrackToHls } from './transcoder.js';
import { runFastScan } from './fastScan.js';
import {
  deactivateRemovedAudiobookLibraries,
  retireRemovedMusicLibraries,
} from './libraryReconciliation.js';
import { runTempoBackfillBatch } from './tempoBackfill.js';
import { refreshAllPodcasts, startPodcastRefresh } from './podcastRefresh.js';
import { scanAudiobooks } from './audiobookScanner.js';
import { ensureTracksIndex, getTrackIndexStatus, indexAllTracks } from './indexer.js';
import logger from './logger.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://redis:6379';

const musicDirs = (process.env.MUSIC_DIRS ?? process.env.MUSIC_DIR ?? '/music')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const audiobookDirs = (process.env.AUDIOBOOK_DIRS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const useFastScan = process.env.FAST_SCAN !== '0';
const rescanIntervalMs = parseInt(process.env.RESCAN_INTERVAL_MS ?? '300000', 10); // Default 5 minutes

const tempoDetectEnabled = process.env.TEMPO_DETECT === '1' && (process.env.TEMPO_MODE ?? 'batch') === 'batch';
const tempoBackfillIntervalMs = parseInt(process.env.TEMPO_BACKFILL_INTERVAL_MS ?? '1800000', 10); // Default 30 minutes

logger.success('worker', 'Started', { musicDirs, useFastScan, rescanIntervalMs });

await initDb();
const recoveredTranscodes = await transcodeJobs.recoverInterruptedTranscodeJobs();
if (recoveredTranscodes > 0) {
  logger.info('transcode', `Recovered ${recoveredTranscodes} interrupted job${recoveredTranscodes === 1 ? '' : 's'}`);
}

// Ensure libraries exist in DB so we can link tracks
for (const dir of musicDirs) {
  await db().query(
    `INSERT INTO libraries (mount_path, media_type, created_at)
     VALUES ($1, 'music', NOW())
     ON CONFLICT (mount_path) DO UPDATE
       SET media_type = 'music', enabled = TRUE`,
    [dir]
  );
}

const retiredMusicLibraries = await retireRemovedMusicLibraries(db(), musicDirs);
for (const library of retiredMusicLibraries) {
  logger.info(
    'scan',
    `Removed music library from the active catalog: ${library.mountPath} (${library.retiredTracks} active track${library.retiredTracks === 1 ? '' : 's'} retired)`
  );
  await audit('music_library_unconfigured', {
    libraryId: library.id,
    mountPath: library.mountPath,
    retiredTracks: library.retiredTracks,
    deactivated: library.deactivated,
  });
}

for (const dir of audiobookDirs) {
  const inserted = await db().query<{ id: number | string }>(
    `INSERT INTO libraries (mount_path, media_type, created_at)
     VALUES ($1, 'audiobook', NOW())
     ON CONFLICT (mount_path) DO NOTHING
     RETURNING id`,
    [dir]
  );
  if (inserted.rows[0]) {
    await db().query(
      `INSERT INTO user_libraries(user_id, library_id)
       SELECT id, $1 FROM users
       ON CONFLICT DO NOTHING`,
      [inserted.rows[0].id]
    );
  } else {
    await db().query(
      `UPDATE libraries
       SET media_type = 'audiobook', enabled = TRUE
       WHERE mount_path = $1`,
      [dir]
    );
  }
}

const deactivatedAudiobookLibraries =
  await deactivateRemovedAudiobookLibraries(db(), audiobookDirs);
for (const library of deactivatedAudiobookLibraries) {
  logger.info(
    'audiobook-scan',
    `Removed audiobook library from the active catalog: ${library.mountPath}`
  );
  await audit('audiobook_library_unconfigured', {
    libraryId: library.id,
    mountPath: library.mountPath,
  });
}

try {
  await ensureTracksIndex();
  let searchStatus = await getTrackIndexStatus();
  if (!searchStatus.consistent) {
    logger.info(
      'search',
      `Reconciling search index at startup (${searchStatus.index} indexed, ${searchStatus.database} active)`
    );
    await indexAllTracks();
    searchStatus = await getTrackIndexStatus();
  }
  if (!searchStatus.consistent) {
    throw new Error(
      `Search index startup check failed (${searchStatus.index} indexed, ${searchStatus.database} active)`
    );
  }
  logger.success('search', `Search index ready (${searchStatus.index} documents)`);
} catch (error) {
  logger.warn('search', `Startup search reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
}

// Periodic rescan function - more reliable than real-time watching on NFS
let scanInProgress = false;
let cancelRequested = false;
let pendingRescanForce: boolean | null = null;

// Listen for rescan/cancel commands from API (must be active during long scans)
const subscriber = new Redis(REDIS_URL);
subscriber.subscribe('library:commands', 'podcast:commands', (err) => {
  if (err) logger.error('worker', `Failed to subscribe to commands: ${err.message}`);
  else logger.info('worker', 'Listening for library and podcast commands');
});

subscriber.on('message', async (channel, message) => {
  try {
    const cmd = JSON.parse(message);
    if (channel === 'podcast:commands') {
      if (cmd.command === 'refresh') {
        logger.info('podcast', `Manual refresh triggered by ${cmd.by || 'unknown'}`);
        void refreshAllPodcasts();
      }
      return;
    }
    if (cmd.command === 'rescan') {
      const force = cmd.force === true;
      if (scanInProgress) {
        pendingRescanForce = pendingRescanForce === true || force;
        logger.info('scan', `Manual rescan queued by ${cmd.by || 'unknown'}${force ? ' (FORCE FULL)' : ''}`);
      } else {
        logger.info('scan', `Manual rescan triggered by ${cmd.by || 'unknown'}${force ? ' (FORCE FULL)' : ''}`);
        void periodicRescan(force);
      }
    } else if (cmd.command === 'cancel_scan') {
      cancelRequested = true;
      logger.info('scan', `Scan cancel requested by ${cmd.by || 'unknown'}`);
    }
  } catch {
    logger.warn('worker', `Invalid command message: ${message}`);
  }
});

async function periodicRescan(force: boolean = false) {
  if (!useFastScan) return;
  if (scanInProgress) {
    logger.info('scan', 'Scan already in progress, skipping');
    return;
  }
  if (cancelRequested) {
    logger.info('scan', 'Cancel already requested; not starting a new scan');
    cancelRequested = false;
    return;
  }
  scanInProgress = true;
  const publisher = new Redis(REDIS_URL);
  try {
    publisher.publish(
      'library:updates',
      JSON.stringify({ event: 'scan:started', force, ts: Date.now() })
    );
  } catch { /* ignore */ }
  try {
    for (const dir of musicDirs) {
      if (cancelRequested) break;
      try {
        await runFastScan(dir, force, {
          libraryIndex: musicDirs.indexOf(dir) + 1,
          libraryTotal: musicDirs.length,
          shouldCancel: () => cancelRequested,
        });
      } catch (e) {
        if (e instanceof Error && e.name === 'ScanCancelledError') {
          logger.info('scan', 'Scan cancelled');
          break;
        }
        throw e;
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error('scan', `Periodic scan failed: ${message}`);
    let previousProgress: Record<string, unknown> = {};
    try {
      const raw = await publisher.get('scan:progress');
      if (raw) previousProgress = JSON.parse(raw);
    } catch { /* ignore malformed or unavailable progress state */ }
    const progress = {
      ...previousProgress,
      status: 'error',
      currentFile: 'Scan failed',
      error: message,
    };
    try {
      await publisher.set('scan:progress', JSON.stringify(progress));
      await publisher.publish('library:updates', JSON.stringify({ event: 'scan:progress', ...progress, ts: Date.now() }));
    } catch { /* ignore reporting failures */ }
  } finally {
    const queuedForce = pendingRescanForce;
    pendingRescanForce = null;
    scanInProgress = false;
    cancelRequested = false;
    try { publisher.disconnect(); } catch { /* */ }
    if (queuedForce !== null) {
      setImmediate(() => void periodicRescan(queuedForce));
    }
  }
}

// Kick off an initial scan on startup
setTimeout(() => periodicRescan(false), 0);

// Schedule periodic rescans
logger.info('worker', `Scheduling periodic library scan every ${rescanIntervalMs / 1000}s`);
setInterval(periodicRescan, rescanIntervalMs);

// Schedule tempo backfill (independent batches throughout the day)
if (tempoDetectEnabled) {
  let tempoBackfillInProgress = false;
  const runIfIdle = async () => {
    if (tempoBackfillInProgress) return;
    if (scanInProgress) return;
    tempoBackfillInProgress = true;
    try {
      await runTempoBackfillBatch();
    } finally {
      tempoBackfillInProgress = false;
    }
  };

  logger.info('worker', `Scheduling tempo backfill every ${Math.round(tempoBackfillIntervalMs / 1000)}s`);
  setTimeout(runIfIdle, 60_000);
  setInterval(runIfIdle, tempoBackfillIntervalMs);
}

// Start automatic podcast refresh (every hour by default)
startPodcastRefresh();

// Audiobook scanning
const audiobookRescanIntervalMs = parseInt(process.env.AUDIOBOOK_RESCAN_INTERVAL_MS ?? '600000', 10); // Default 10 minutes

if (audiobookDirs.length > 0) {
  logger.info('worker', `Audiobook dirs: ${audiobookDirs.join(', ')}`);

  async function audiobookRescan() {
    try {
      await scanAudiobooks(audiobookDirs);
    } catch (e) {
      logger.error('audiobook-scan', `Scan failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Initial scan after a short delay
  setTimeout(audiobookRescan, 5000);
  // Periodic rescans
  logger.info('worker', `Scheduling audiobook scan every ${audiobookRescanIntervalMs / 1000}s`);
  setInterval(audiobookRescan, audiobookRescanIntervalMs);

  // Listen for manual audiobook rescan commands
  const abSubscriber = new Redis(REDIS_URL);
  abSubscriber.subscribe('audiobook:commands', (err) => {
    if (err) logger.error('worker', `Failed to subscribe to audiobook commands: ${err.message}`);
  });
  abSubscriber.on('message', async (_channel, message) => {
    try {
      const cmd = JSON.parse(message);
      if (cmd.command === 'rescan') {
        logger.info('audiobook-scan', `Manual rescan triggered by ${cmd.by || 'unknown'}`);
        audiobookRescan();
      }
    } catch {
      // ignore
    }
  });
}


// Graceful shutdown handler
let shouldShutdown = false;

async function gracefulShutdown(signal: string) {
  logger.info('worker', `Received ${signal}, shutting down...`);
  shouldShutdown = true;
  await subscriber.unsubscribe();
  await subscriber.quit();
  logger.info('worker', 'Worker stopped');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Main loop for Transcoding only (Scanning is now handled by periodic rescan)
while (!shouldShutdown) {
  const tj = await transcodeJobs.claimNextTranscodeJob();
  if (tj) {
    logger.info('transcode', `Processing track #${tj.track_id}`, { jobId: tj.id });
    try {
      const outDir = await transcodeTrackToHls(tj.track_id, tj.cache_key);
      await transcodeJobs.finishTranscodeJob(tj.id, 'done', outDir, null);
      logger.success('transcode', `Completed track #${tj.track_id}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await transcodeJobs.finishTranscodeJob(tj.id, 'failed', null, msg);
      logger.error('transcode', `Failed track #${tj.track_id}`, { error: msg });
    }
    continue;
  }
  
  // Sleep if no transcode work
  await new Promise((r) => setTimeout(r, 2000));
}

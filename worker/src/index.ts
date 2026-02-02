import 'dotenv/config';

import Redis from 'ioredis';
import { db, initDb } from './db.js';
import * as jobs from './scanRepo.js';
import { runScan } from './scanner.js';
import * as transcodeJobs from './transcodeRepo.js';
import { transcodeTrackToHls } from './transcoder.js';
import { runFastScan } from './fastScan.js';
import logger from './logger.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://redis:6379';

const musicDirs = (process.env.MUSIC_DIRS ?? process.env.MUSIC_DIR ?? '/music')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const useFastScan = process.env.FAST_SCAN !== '0';
const rescanIntervalMs = parseInt(process.env.RESCAN_INTERVAL_MS ?? '300000', 10); // Default 5 minutes

logger.success('worker', 'Started', { musicDirs, useFastScan, rescanIntervalMs });

await initDb();

// Initialize libraries and run initial scan
for (const dir of musicDirs) {
  // Ensure library exists in DB so we can link tracks
  await db().query(
    `INSERT INTO libraries (mount_path, created_at) 
     VALUES ($1, NOW()) 
     ON CONFLICT (mount_path) DO NOTHING`,
    [dir]
  );
  
  if (useFastScan) {
    // Run fast parallel scan on startup
    try {
      await runFastScan(dir);
    } catch (e) {
      logger.error('scan', `Fast scan failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

// Periodic rescan function - more reliable than real-time watching on NFS
let scanInProgress = false;
async function periodicRescan(force: boolean = false) {
  if (scanInProgress) {
    logger.info('scan', 'Scan already in progress, skipping');
    return;
  }
  scanInProgress = true;
  try {
    for (const dir of musicDirs) {
      await runFastScan(dir, force);
    }
  } catch (e) {
    logger.error('scan', `Periodic scan failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    scanInProgress = false;
  }
}

// Schedule periodic rescans
logger.info('worker', `Scheduling periodic library scan every ${rescanIntervalMs / 1000}s`);
setInterval(periodicRescan, rescanIntervalMs);

// Listen for rescan commands from API
const subscriber = new Redis(REDIS_URL);
subscriber.subscribe('library:commands', (err) => {
  if (err) logger.error('worker', `Failed to subscribe to commands: ${err.message}`);
  else logger.info('worker', 'Listening for rescan commands');
});

subscriber.on('message', async (channel, message) => {
  try {
    const cmd = JSON.parse(message);
    if (cmd.command === 'rescan') {
      logger.info('scan', `Manual rescan triggered by ${cmd.by || 'unknown'}${cmd.force ? ' (FORCE FULL)' : ''}`);
      periodicRescan(cmd.force === true);
    }
  } catch (e) {
    logger.warn('worker', `Invalid command message: ${message}`);
  }
});

// Main loop for Transcoding only (Scanning is now handled by periodic rescan)
while (true) {
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

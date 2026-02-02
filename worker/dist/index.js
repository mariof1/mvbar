import 'dotenv/config';
import { db, initDb } from './db.js';
import * as transcodeJobs from './transcodeRepo.js';
import { transcodeTrackToHls } from './transcoder.js';
import { LibraryWatcher } from './watcher.js';
import logger from './logger.js';
const musicDirs = (process.env.MUSIC_DIRS ?? process.env.MUSIC_DIR ?? '/music')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
logger.success('worker', 'Started', { musicDirs });
await initDb();
// Initialize watchers
const watchers = [];
for (const dir of musicDirs) {
    // Ensure library exists in DB so we can link tracks
    await db().query(`INSERT INTO libraries (mount_path, created_at) 
     VALUES ($1, NOW()) 
     ON CONFLICT (mount_path) DO NOTHING`, [dir]);
    const w = new LibraryWatcher(dir);
    w.start();
    watchers.push(w);
    logger.info('worker', `Watching library: ${dir}`);
}
// Main loop for Transcoding only (Scanning is now handled by Watcher)
while (true) {
    const tj = await transcodeJobs.claimNextTranscodeJob();
    if (tj) {
        logger.info('transcode', `Processing track #${tj.track_id}`, { jobId: tj.id });
        try {
            const outDir = await transcodeTrackToHls(tj.track_id, tj.cache_key);
            await transcodeJobs.finishTranscodeJob(tj.id, 'done', outDir, null);
            logger.success('transcode', `Completed track #${tj.track_id}`);
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            await transcodeJobs.finishTranscodeJob(tj.id, 'failed', null, msg);
            logger.error('transcode', `Failed track #${tj.track_id}`, { error: msg });
        }
        continue;
    }
    // Sleep if no transcode work
    await new Promise((r) => setTimeout(r, 2000));
}

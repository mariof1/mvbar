import { spawn } from 'node:child_process';
import { mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { db } from './db.js';

const HLS_DIR = process.env.HLS_DIR ?? '/hls';

function safeJoinMount(mountPath: string, relPath: string) {
  const abs = path.resolve(mountPath, relPath);
  const base = path.resolve(mountPath);
  if (!abs.startsWith(base + path.sep)) throw new Error('invalid path');
  return abs;
}

function run(cmd: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString('utf8')));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`${cmd} exited ${code}: ${err.slice(0, 4000)}`));
    });
  });
}

export async function transcodeTrackToHls(trackId: number, cacheKey: string) {
  const r = await db().query<{ path: string; mount_path: string }>(
    'select t.path, l.mount_path from tracks t join libraries l on l.id=t.library_id where t.id=$1',
    [trackId]
  );
  const row = r.rows[0];
  if (!row) throw new Error('track_not_found');

  const input = safeJoinMount(row.mount_path, row.path);

  const outDir = path.join(HLS_DIR, cacheKey);
  const tmpDir = path.join(HLS_DIR, `${cacheKey}.tmp_${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });

  const manifest = path.join(tmpDir, 'index.m3u8');
  const seg = path.join(tmpDir, 'seg_%05d.ts');

  // Simple VOD HLS audio (AAC). Works on iOS/Safari; web clients can later add hls.js.
  await run('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    input,
    '-vn',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-f',
    'hls',
    '-hls_time',
    '6',
    '-hls_playlist_type',
    'vod',
    '-hls_segment_filename',
    seg,
    manifest
  ]);

  // Atomic publish.
  try {
    await rename(tmpDir, outDir);
  } catch {
    // fallback: if dir already exists, just keep latest tmp (rare)
    await rename(tmpDir, outDir);
  }

  return cacheKey;
}

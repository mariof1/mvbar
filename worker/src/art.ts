import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

const FFMPEG_PATH = process.env.FFMPEG_PATH ?? 'ffmpeg';
export const MUSIC_ART_CACHE_VERSION = 'v2';
export const MUSIC_ART_MAX_DIMENSION = 800;
const MUSIC_ART_JPEG_QUALITY = 3;
export const MUSIC_ART_MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const MUSIC_ART_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

type ArtWriteResult = { hash: string; relPath: string; mime: string };
const musicArtWrites = new Map<string, Promise<ArtWriteResult>>();

export function pickBestPicture(pictures: Array<{ data: Uint8Array; format?: string }> | undefined) {
  const pics = pictures ?? [];
  if (pics.length === 0) return null;
  // prefer largest
  let best = pics[0];
  for (const p of pics) if (p.data.length > best.data.length) best = p;
  return best;
}

export function mimeFromFormat(format?: string) {
  const f = (format ?? '').toLowerCase();
  if (f.includes('png')) return 'image/png';
  if (f.includes('jpg') || f.includes('jpeg')) return 'image/jpeg';
  if (f.includes('webp')) return 'image/webp';
  return null;
}

export async function writeArt(artDir: string, data: Uint8Array, mime: string) {
  const hash = createHash('sha1').update(data).digest('hex');
  const ext = mime === 'image/png' ? '.png' : mime === 'image/webp' ? '.webp' : '.jpg';
  const rel = `${hash.slice(0, 2)}/${hash}${ext}`;
  const abs = path.join(artDir, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, data);
  return { hash, relPath: rel, mime };
}

export function isCurrentMusicArtPath(relativePath: string | null): boolean {
  if (!relativePath) return false;
  return relativePath.replaceAll('\\', '/').startsWith(`${MUSIC_ART_CACHE_VERSION}/`);
}

export function resizeMusicArtwork(input: Buffer): Promise<Buffer> {
  if (input.length > MUSIC_ART_MAX_SOURCE_BYTES) {
    return Promise.reject(new Error(`Source image is larger than ${MUSIC_ART_MAX_SOURCE_BYTES} bytes`));
  }

  return new Promise((resolve, reject) => {
    const filter = [
      `scale=w='min(${MUSIC_ART_MAX_DIMENSION},iw)'`,
      `h='min(${MUSIC_ART_MAX_DIMENSION},ih)'`,
      'force_original_aspect_ratio=decrease',
      'force_divisible_by=2',
    ].join(':');
    const child = spawn(FFMPEG_PATH, [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', 'pipe:0',
      '-vf', filter,
      '-frames:v', '1',
      '-an',
      '-sn',
      '-map_metadata', '-1',
      '-c:v', 'mjpeg',
      '-q:v', String(MUSIC_ART_JPEG_QUALITY),
      '-pix_fmt', 'yuvj420p',
      '-f', 'image2pipe',
      'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let outputSize = 0;
    let errorSize = 0;
    let rejectedForSize = false;
    child.stdout.on('data', (chunk: Buffer) => {
      outputSize += chunk.length;
      if (outputSize > MUSIC_ART_MAX_OUTPUT_BYTES) {
        rejectedForSize = true;
        child.kill('SIGKILL');
        return;
      }
      output.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (errorSize >= 8192) return;
      errors.push(chunk);
      errorSize += chunk.length;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (rejectedForSize) {
        reject(new Error(`Resized image exceeded ${MUSIC_ART_MAX_OUTPUT_BYTES} bytes`));
        return;
      }
      if (code !== 0 || outputSize === 0) {
        const detail = Buffer.concat(errors).toString('utf8').trim();
        reject(new Error(detail || `FFmpeg exited with code ${code}`));
        return;
      }
      resolve(Buffer.concat(output, outputSize));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

async function storeMusicArtwork(artDir: string, source: Buffer): Promise<ArtWriteResult> {
  const resized = await resizeMusicArtwork(source);
  const hash = createHash('sha1').update(resized).digest('hex');
  const relPath = `${MUSIC_ART_CACHE_VERSION}/${hash.slice(0, 2)}/${hash}.jpg`;
  const absPath = path.join(artDir, relPath);
  try {
    const imageStat = await stat(absPath);
    if (imageStat.isFile()) return { hash, relPath, mime: 'image/jpeg' };
  } catch {
    // Write the normalized image below.
  }
  await mkdir(path.dirname(absPath), { recursive: true });
  await writeFile(absPath, resized);
  return { hash, relPath, mime: 'image/jpeg' };
}

export async function writeMusicArt(artDir: string, data: Uint8Array): Promise<ArtWriteResult> {
  const source = Buffer.from(data);
  const sourceHash = createHash('sha1').update(source).digest('hex');
  let pending = musicArtWrites.get(sourceHash);
  if (!pending) {
    pending = storeMusicArtwork(artDir, source);
    musicArtWrites.set(sourceHash, pending);
  }
  try {
    return await pending;
  } catch (error) {
    if (musicArtWrites.get(sourceHash) === pending) musicArtWrites.delete(sourceHash);
    throw error;
  }
}

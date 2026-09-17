import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { copyFile, mkdir, rename, rm, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZipArchive } from 'archiver';

const DEEZER_ORIGIN = 'https://api.deezer.com';
const DOWNLOAD_SCRIPT = fileURLToPath(new URL('../../scripts/deezer_download.py', import.meta.url));

export type DeezerTrack = {
  id: string;
  title: string;
  artist: string;
  album: string;
  durationMs: number | null;
  isrc: string | null;
  link: string | null;
  score: number;
};

export type DeezerAlbum = {
  id: string;
  title: string;
  artist: string;
  trackCount: number;
  releaseDate: string | null;
  link: string | null;
  cover: string | null;
  score: number;
};

type DeezerAlbumTrack = DeezerTrack & { discNumber: number; trackNumber: number };
export type VerifiedDeezerAlbum = DeezerAlbum & { tracks: DeezerAlbumTrack[] };

type RawTrack = {
  id?: number;
  title?: string;
  title_short?: string;
  duration?: number;
  isrc?: string;
  link?: string;
  artist?: { name?: string };
  album?: { title?: string };
  disk_number?: number;
  track_position?: number;
};

type RawAlbum = {
  id?: number;
  title?: string;
  record_type?: string;
  nb_tracks?: number;
  release_date?: string;
  link?: string;
  cover_medium?: string;
  artist?: { name?: string };
};

function normalized(value: string) {
  return value.normalize('NFKD').toLowerCase().replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function scoreTrack(raw: RawTrack, artist: string, title: string, album?: string | null) {
  const wantArtist = normalized(artist);
  const wantTitle = normalized(title);
  const gotArtist = normalized(raw.artist?.name ?? '');
  const gotTitle = normalized(raw.title ?? raw.title_short ?? '');
  if (!wantArtist || !wantTitle || !gotArtist || gotTitle !== wantTitle) return 0;
  const artistScore = gotArtist === wantArtist ? 50 : gotArtist.includes(wantArtist) || wantArtist.includes(gotArtist) ? 30 : 0;
  const albumScore = album && normalized(raw.album?.title ?? '') === normalized(album) ? 10 : 0;
  return artistScore + 50 + albumScore;
}

function mapTrack(raw: RawTrack, artist: string, title: string, album?: string | null): DeezerTrack | null {
  if (!Number.isSafeInteger(raw.id) || !raw.id || !raw.title || !raw.artist?.name) return null;
  const score = scoreTrack(raw, artist, title, album);
  if (score < 75) return null;
  return {
    id: String(raw.id), title: raw.title, artist: raw.artist.name, album: raw.album?.title ?? '',
    durationMs: typeof raw.duration === 'number' ? raw.duration * 1000 : null,
    isrc: raw.isrc || null,
    link: typeof raw.link === 'string' && raw.link.startsWith('https://www.deezer.com/') ? raw.link : null,
    score,
  };
}

function mapAlbum(raw: RawAlbum, artist: string, title: string): DeezerAlbum | null {
  if (!Number.isSafeInteger(raw.id) || !raw.id || !raw.title || !raw.artist?.name) return null;
  if (raw.record_type && !['album', 'ep'].includes(raw.record_type.toLowerCase())) return null;
  if (normalized(raw.title) !== normalized(title)) return null;
  const wantedArtist = normalized(artist);
  const foundArtist = normalized(raw.artist.name);
  if (!wantedArtist || foundArtist !== wantedArtist) return null;
  return {
    id: String(raw.id), title: raw.title, artist: raw.artist.name,
    trackCount: Number.isSafeInteger(raw.nb_tracks) ? raw.nb_tracks! : 0,
    releaseDate: /^\d{4}-\d{2}-\d{2}$/.test(raw.release_date ?? '') ? raw.release_date! : null,
    link: typeof raw.link === 'string' && raw.link.startsWith('https://www.deezer.com/') ? raw.link : null,
    cover: typeof raw.cover_medium === 'string' && raw.cover_medium.startsWith('https://cdn-images.dzcdn.net/') ? raw.cover_medium : null,
    score: 110,
  };
}

async function deezerJson(url: URL): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(12_000), headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Deezer catalog returned ${response.status}`);
  const body = await response.text();
  if (body.length > 1_000_000) throw new Error('Deezer catalog response is too large');
  const json = JSON.parse(body) as { error?: { message?: string } };
  if (json.error) throw new Error(json.error.message || 'Deezer catalog rejected the request');
  return json;
}

export async function searchDeezerTracks(artist: string, title: string, album?: string | null): Promise<DeezerTrack[]> {
  const url = new URL('/search', DEEZER_ORIGIN);
  url.searchParams.set('q', `${artist} ${title}`);
  url.searchParams.set('limit', '40');
  const result = await deezerJson(url) as { data?: RawTrack[] };
  const seen = new Set<string>();
  return (Array.isArray(result.data) ? result.data : [])
    .map(raw => mapTrack(raw, artist, title, album))
    .filter((track): track is DeezerTrack => Boolean(track))
    .filter(track => { if (seen.has(track.id)) return false; seen.add(track.id); return true; })
    .sort((a, b) => b.score - a.score || Number(a.id) - Number(b.id))
    .slice(0, 12);
}

export async function searchDeezerAlbums(artist: string, title: string): Promise<DeezerAlbum[]> {
  const url = new URL('/search/album', DEEZER_ORIGIN);
  url.searchParams.set('q', `${artist} ${title}`);
  url.searchParams.set('limit', '40');
  const result = await deezerJson(url) as { data?: RawAlbum[] };
  const seen = new Set<string>();
  const candidates = (Array.isArray(result.data) ? result.data : [])
    .map(raw => mapAlbum(raw, artist, title))
    .filter((album): album is DeezerAlbum => Boolean(album))
    .filter(album => { if (seen.has(album.id)) return false; seen.add(album.id); return true; })
    .sort((a, b) => b.score - a.score || b.trackCount - a.trackCount)
    .slice(0, 12);
  // Album search omits release dates on Deezer. Fetch details for a few likely
  // editions so an administrator can tell them apart before staging.
  return Promise.all(candidates.map(async (candidate, index) => {
    if (index >= 6) return candidate;
    try {
      const detail = mapAlbum(await deezerJson(new URL(`/album/${candidate.id}`, DEEZER_ORIGIN)) as RawAlbum, artist, title);
      return detail?.id === candidate.id ? detail : candidate;
    } catch {
      return candidate;
    }
  }));
}

export async function verifiedDeezerAlbum(id: string, artist: string, title: string): Promise<VerifiedDeezerAlbum> {
  if (!/^\d{1,16}$/.test(id)) throw new Error('Invalid Deezer album id');
  const detail = await deezerJson(new URL(`/album/${id}`, DEEZER_ORIGIN)) as RawAlbum;
  const album = mapAlbum(detail, artist, title);
  if (!album || album.id !== id) throw new Error('This Deezer album does not match the requested album');
  if (album.trackCount < 1 || album.trackCount > 200) throw new Error('Album track count is unavailable or too large');
  const tracks: DeezerAlbumTrack[] = [];
  for (let index = 0; index < album.trackCount; index += 100) {
    const url = new URL(`/album/${id}/tracks`, DEEZER_ORIGIN);
    url.searchParams.set('limit', '100');
    url.searchParams.set('index', String(index));
    const page = await deezerJson(url) as { data?: RawTrack[]; total?: number };
    if (!Array.isArray(page.data) || page.data.length === 0 || (typeof page.total === 'number' && page.total !== album.trackCount)) {
      throw new Error('Deezer returned an incomplete album track list');
    }
    for (const raw of page.data) {
      if (!Number.isSafeInteger(raw.id) || !raw.id || !raw.title) throw new Error('Deezer returned an invalid album track');
      tracks.push({
        id: String(raw.id), title: raw.title, artist: raw.artist?.name || album.artist, album: album.title,
        durationMs: typeof raw.duration === 'number' ? raw.duration * 1000 : null,
        isrc: raw.isrc || null, link: null, score: 0,
        discNumber: Number.isSafeInteger(raw.disk_number) && raw.disk_number! > 0 ? raw.disk_number! : 1,
        trackNumber: Number.isSafeInteger(raw.track_position) && raw.track_position! > 0 ? raw.track_position! : tracks.length + 1,
      });
    }
  }
  if (tracks.length !== album.trackCount || new Set(tracks.map(track => track.id)).size !== tracks.length) {
    throw new Error('Deezer returned an incomplete or duplicate album track list');
  }
  return { ...album, tracks };
}

export async function verifiedDeezerTrack(id: string, artist: string, title: string, album?: string | null): Promise<DeezerTrack> {
  if (!/^\d{1,16}$/.test(id)) throw new Error('Invalid Deezer track id');
  const url = new URL(`/track/${id}`, DEEZER_ORIGIN);
  const track = mapTrack(await deezerJson(url) as RawTrack, artist, title, album);
  if (!track || track.id !== id) throw new Error('This Deezer track does not match the requested song');
  return track;
}

export function deezerStagingConfig() {
  const directory = process.env.DEEZER_DOWNLOAD_DIR?.trim() ?? '';
  const arl = process.env.DEEZER_ARL?.trim() ?? '';
  const quality = Number(process.env.DEEZER_QUALITY ?? 0);
  const resolved = directory ? path.resolve(directory) : '';
  const roots = (process.env.MUSIC_DIRS ?? process.env.MUSIC_DIR ?? '/music').split(',').map(root => root.trim()).filter(Boolean);
  const inside = (relative: string) => !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
  const overlapsMusic = Boolean(resolved && roots.some(root =>
    inside(path.relative(path.resolve(root), resolved)) || inside(path.relative(resolved, path.resolve(root)))));
  return {
    directory: resolved,
    arl,
    python: process.env.DEEZER_PYTHON?.trim() || (process.platform === 'win32' ? 'python' : 'python3'),
    quality: Number.isInteger(quality) && quality >= 0 && quality <= 2 ? quality : 0,
    configured: Boolean(directory && arl && !overlapsMusic),
    error: overlapsMusic ? 'DEEZER_DOWNLOAD_DIR must be separate from MUSIC_DIRS' : 'Set DEEZER_ARL and DEEZER_DOWNLOAD_DIR on the server first',
  };
}

function safeFilePart(value: string) {
  return value.replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/[. ]+$/g, '').replace(/\s+/g, ' ').trim().slice(0, 100) || 'Unknown';
}

type DownloadResult = { extension?: string; extensions?: string[] };
type AlbumProgress = (completed: number, total: number, phase: 'downloading' | 'packaging') => Promise<void> | void;

function runPython(python: string, input: object, arl: string, timeoutMs = 15 * 60_000, onProgress?: AlbumProgress): Promise<DownloadResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [DOWNLOAD_SCRIPT], {
      windowsHide: true,
      env: { ...process.env, DEEZER_ARL: arl, PYTHONUNBUFFERED: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let outputError: Error | null = null;
    let result: DownloadResult | null = null;
    let progress = Promise.resolve();
    const finish = (error?: Error, value?: DownloadResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value!);
    };
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    const parseLine = (line: string) => {
      try {
        const message = JSON.parse(line) as { progress?: { completed?: number; total?: number }; extension?: string; extensions?: string[] };
        if (message.progress && onProgress) {
          const { completed, total } = message.progress;
          if (Number.isSafeInteger(completed) && Number.isSafeInteger(total) && total! > 0 && completed! >= 0 && completed! <= total!) {
            progress = progress.then(() => onProgress(completed!, total!, 'downloading')).catch(() => undefined);
          }
        } else if (message.extension || message.extensions) {
          result = message;
        }
      } catch {
        outputError = new Error('Deezer downloader returned an invalid result');
      }
    };
    child.stdout.on('data', chunk => {
      stdout += String(chunk);
      if (stdout.length > 8192) {
        outputError = new Error('Deezer downloader returned too much output');
        child.kill();
        return;
      }
      let newline = stdout.indexOf('\n');
      while (newline !== -1) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (line) parseLine(line);
        newline = stdout.indexOf('\n');
      }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(0, 8192); });
    child.on('error', error => finish(new Error(`Could not start Deezer downloader: ${error.message}`)));
    child.on('close', async code => {
      if (stdout.trim()) parseLine(stdout.trim());
      await progress;
      if (timedOut) return finish(new Error('Deezer download timed out'));
      if (outputError) return finish(outputError);
      if (code !== 0) return finish(new Error((stderr.trim() || `Deezer downloader exited with code ${code}`).replaceAll(arl, '[redacted]').slice(0, 500)));
      if (!result) return finish(new Error('Deezer downloader returned an invalid result'));
      finish(undefined, result);
    });
    child.stdin.end(JSON.stringify(input));
  });
}

async function zipAlbum(working: string, album: VerifiedDeezerAlbum, extensions: string[]) {
  const archivePath = path.join(working, 'album.zip');
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(archivePath);
    const archive = new ZipArchive({ store: true });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.on('warning', reject);
    archive.pipe(output);
    const folder = `${safeFilePart(album.artist)} - ${safeFilePart(album.title)}`;
    album.tracks.forEach((track, index) => {
      const name = `${String(index + 1).padStart(3, '0')} - ${String(track.discNumber).padStart(2, '0')}-${String(track.trackNumber).padStart(2, '0')} - ${safeFilePart(track.title)}.${extensions[index]}`;
      archive.file(path.join(working, `track-${String(index + 1).padStart(3, '0')}.${extensions[index]}`), { name: `${folder}/${name}` });
    });
    void archive.finalize().catch(reject);
  });
  return archivePath;
}

export async function stageDeezerAlbum(album: VerifiedDeezerAlbum, onProgress?: AlbumProgress): Promise<string> {
  const config = deezerStagingConfig();
  if (!config.configured) throw new Error(config.error);
  if (album.tracks.length !== album.trackCount || album.trackCount < 1 || album.trackCount > 200) {
    throw new Error('Album track list is incomplete');
  }
  await mkdir(config.directory, { recursive: true, mode: 0o700 });
  const working = path.join(config.directory, `.incoming-${crypto.randomUUID()}`);
  await mkdir(working, { mode: 0o700 });
  try {
    await onProgress?.(0, album.trackCount, 'downloading');
    const timeout = Math.min(2 * 60 * 60_000, 15 * 60_000 + album.trackCount * 2 * 60_000);
    const result = await runPython(config.python, { directory: working, quality: config.quality, tracks: album.tracks, albumArtist: album.artist, releaseDate: album.releaseDate }, config.arl, timeout, onProgress);
    const extensions = result.extensions;
    if (!Array.isArray(extensions) || extensions.length !== album.trackCount || extensions.some(ext => !['mp3', 'flac'].includes(ext))) {
      throw new Error('Deezer returned an incomplete album download');
    }
    for (const [index, extension] of extensions.entries()) {
      const file = path.join(working, `track-${String(index + 1).padStart(3, '0')}.${extension}`);
      const details = await stat(file);
      if (!details.isFile() || details.size < 10_000) throw new Error('Deezer returned an incomplete album track');
    }
    await onProgress?.(album.trackCount, album.trackCount, 'packaging');
    const source = await zipAlbum(working, album, extensions);
    const details = await stat(source);
    if (!details.isFile() || details.size < 10_000) throw new Error('Album archive is incomplete');
    const base = `${safeFilePart(album.artist)} - ${safeFilePart(album.title)} [deezer-album-${album.id}]`;
    for (let attempt = 0; attempt < 20; attempt++) {
      const stem = `${base}${attempt ? `-${attempt + 1}` : ''}`;
      const filename = `${stem}.zip`;
      const albumDirectory = path.join(config.directory, stem);
      try {
        await stat(albumDirectory);
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      try {
        await copyFile(source, path.join(config.directory, filename), constants.COPYFILE_EXCL);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw error;
      }
      try {
        await unlink(source);
        for (const [index, track] of album.tracks.entries()) {
          const extension = extensions[index];
          await rename(
            path.join(working, `track-${String(index + 1).padStart(3, '0')}.${extension}`),
            path.join(working, `${String(index + 1).padStart(3, '0')} - ${safeFilePart(track.title)}.${extension}`)
          );
        }
        // Publishing the complete folder is atomic; the scanner ignores .incoming-*.
        await rename(working, albumDirectory);
        return filename;
      } catch (error) {
        await unlink(path.join(config.directory, filename)).catch(() => {});
        throw error;
      }
    }
    throw new Error('Too many duplicate staged albums');
  } finally {
    await rm(working, { recursive: true, force: true });
  }
}

export async function stageDeezerTrack(track: DeezerTrack): Promise<string> {
  const config = deezerStagingConfig();
  if (!config.configured) throw new Error(config.error);
  await mkdir(config.directory, { recursive: true, mode: 0o700 });
  const working = path.join(config.directory, `.incoming-${crypto.randomUUID()}`);
  await mkdir(working, { mode: 0o700 });
  try {
    const result = await runPython(config.python, { id: track.id, directory: working, quality: config.quality, track }, config.arl);
    if (result.extension !== 'mp3' && result.extension !== 'flac') throw new Error('Deezer returned an unsupported audio format');
    const source = path.join(working, `track.${result.extension}`);
    const details = await stat(source);
    if (!details.isFile() || details.size < 10_000) throw new Error('Deezer returned an empty or incomplete audio file');
    const base = `${safeFilePart(track.artist)} - ${safeFilePart(track.title)} [deezer-${track.id}]`;
    // The source and destination are on the same mount. Rename makes the audio
    // visible only once the downloader and tag writer have finished.
    const filename = `${base}-${crypto.randomUUID().slice(0, 12)}.${result.extension}`;
    await rename(source, path.join(config.directory, filename));
    return filename;
  } finally {
    await rm(working, { recursive: true, force: true });
  }
}

export function validStagedFilename(filename: unknown): filename is string {
  return typeof filename === 'string' && /^[^<>:"/\\|?*\x00-\x1f]{1,250}\.(mp3|flac|zip)$/.test(filename) && !filename.startsWith('.');
}

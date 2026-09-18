import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, link, mkdir, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
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
  discNumber?: number | null;
  trackNumber?: number | null;
  cover?: string | null;
};

export type DeezerAlbum = {
  id: string;
  title: string;
  artist: string;
  trackCount: number;
  releaseDate: string | null;
  link: string | null;
  cover: string | null;
  artwork: string | null;
  score: number;
};

type DeezerAlbumTrack = DeezerTrack & { discNumber: number; trackNumber: number };
export type VerifiedDeezerAlbum = DeezerAlbum & { tracks: DeezerAlbumTrack[] };
export type ExistingAlbumMetadata = { album: string; album_artist: string | null; year: number | null; genre: string | null; country: string | null; language: string | null };

type RawTrack = {
  id?: number;
  title?: string;
  title_short?: string;
  duration?: number;
  isrc?: string;
  link?: string;
  artist?: { name?: string };
  album?: { title?: string; cover_xl?: string; cover_big?: string; cover_medium?: string };
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
  cover_big?: string;
  cover_xl?: string;
  artist?: { name?: string };
};

function normalized(value: string) {
  return value.normalize('NFKD').toLowerCase().replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function deezerCover(...candidates: Array<string | undefined>) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      if (url.protocol === 'https:' && url.hostname === 'cdn-images.dzcdn.net' &&
          !url.username && !url.password && url.pathname.startsWith('/images/cover/')) return url.toString();
    } catch { /* Ignore malformed artwork URLs from catalog results. */ }
  }
  return null;
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
    discNumber: Number.isSafeInteger(raw.disk_number) && raw.disk_number! > 0 ? raw.disk_number! : null,
    trackNumber: Number.isSafeInteger(raw.track_position) && raw.track_position! > 0 ? raw.track_position! : null,
    cover: deezerCover(raw.album?.cover_xl, raw.album?.cover_big, raw.album?.cover_medium),
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
    cover: deezerCover(raw.cover_medium, raw.cover_big, raw.cover_xl),
    artwork: deezerCover(raw.cover_xl, raw.cover_big, raw.cover_medium),
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

function trackFileName(track: DeezerTrack, extension: string) {
  const disc = String(track.discNumber ?? 0).padStart(2, '0');
  const number = String(track.trackNumber ?? 0).padStart(2, '0');
  return `${disc}-${number} ${safeFilePart(track.title)}.${extension}`;
}

type DownloadResult = { extension?: string; extensions?: string[] };
type AlbumProgress = (completed: number, total: number, phase: 'downloading' | 'publishing') => Promise<void> | void;

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
    const result = await runPython(
      config.python,
      {
        directory: working,
        quality: config.quality,
        tracks: album.tracks,
        albumArtist: album.artist,
        releaseDate: album.releaseDate,
        coverUrl: album.artwork,
      },
      config.arl,
      timeout,
      onProgress,
    );
    const extensions = result.extensions;
    if (!Array.isArray(extensions) || extensions.length !== album.trackCount || extensions.some(ext => !['mp3', 'flac'].includes(ext))) {
      throw new Error('Deezer returned an incomplete album download');
    }
    for (const [index, extension] of extensions.entries()) {
      const file = path.join(working, `track-${String(index + 1).padStart(3, '0')}.${extension}`);
      const details = await stat(file);
      if (!details.isFile() || details.size < 10_000) throw new Error('Deezer returned an incomplete album track');
    }

    await onProgress?.(album.trackCount, album.trackCount, 'publishing');

    const names = new Set<string>();
    for (const [index, track] of album.tracks.entries()) {
      const extension = extensions[index];
      let name = trackFileName(track, extension);
      if (names.has(name.toLowerCase())) {
        name = name.replace(`.${extension}`, ` [deezer-${track.id}].${extension}`);
      }
      names.add(name.toLowerCase());
      await rename(
        path.join(working, `track-${String(index + 1).padStart(3, '0')}.${extension}`),
        path.join(working, name),
      );
    }

    const artist = safeFilePart(album.artist);
    const artistDirectory = path.join(config.directory, artist);
    await mkdir(artistDirectory, { recursive: true, mode: 0o700 });
    let base = safeFilePart(album.title);
    // A directory ending in .zip is ambiguous with the legacy archive identifier.
    if (base.toLowerCase().endsWith('.zip')) base = `${base} [deezer-album-${album.id}]`;

    for (let attempt = 0; attempt < 20; attempt++) {
      const stem = `${base}${attempt ? ` [deezer-album-${album.id}${attempt > 1 ? `-${attempt}` : ''}]` : ''}`;
      const relative = `${artist}/${stem}`;
      const albumDirectory = path.join(config.directory, relative);
      try {
        await stat(albumDirectory);
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }

      try {
        // Publishing the complete directory is atomic; the scanner ignores .incoming-*.
        await rename(working, albumDirectory);
        return relative;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EEXIST' || code === 'ENOTEMPTY') continue;
        throw error;
      }
    }
    throw new Error('Too many duplicate staged albums');
  } finally {
    await rm(working, { recursive: true, force: true });
  }
}

export async function publishStagedTrack(directory: string, source: string, track: DeezerTrack, extension: 'mp3' | 'flac'): Promise<string> {
    const artist = safeFilePart(track.artist);
    const album = safeFilePart(track.album || 'Unknown Album');
    const destination = path.join(directory, artist, album);
    await mkdir(destination, { recursive: true, mode: 0o700 });
    const base = trackFileName(track, extension);
    for (let attempt = 0; attempt < 20; attempt++) {
      const name = attempt ? base.replace(`.${extension}`, ` [deezer-${track.id}${attempt > 1 ? `-${attempt}` : ''}].${extension}`) : base;
      const target = path.join(destination, name);
      try {
        // Both paths share the staging mount. An exclusive hard link publishes
        // the complete file atomically and cannot replace a concurrent download.
        await link(source, target);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') continue;
        if (['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV'].includes(code ?? '')) {
          // Some SMB/NAS mounts do not permit hard links. A unique destination
          // keeps rename atomic without risking replacement of another track.
          const unique = base.replace(`.${extension}`, ` [deezer-${track.id}-${crypto.randomUUID().slice(0, 8)}].${extension}`);
          const pending = path.join(destination, `.incoming-${crypto.randomUUID()}`);
          try {
            await copyFile(source, pending, constants.COPYFILE_EXCL);
            await rename(pending, path.join(destination, unique));
          } finally {
            await rm(pending, { force: true });
          }
          return `${artist}/${album}/${unique}`;
        }
        throw error;
      }
      await unlink(source).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
      return `${artist}/${album}/${name}`;
    }
    throw new Error('Too many duplicate staged tracks');
}

export async function stageDeezerTrack(track: DeezerTrack, existingAlbum?: ExistingAlbumMetadata | null): Promise<string> {
  const config = deezerStagingConfig();
  if (!config.configured) throw new Error(config.error);
  await mkdir(config.directory, { recursive: true, mode: 0o700 });
  const working = path.join(config.directory, `.incoming-${crypto.randomUUID()}`);
  await mkdir(working, { mode: 0o700 });
  try {
    const stagedTrack = existingAlbum ? { ...track, album: existingAlbum.album } : track;
    const result = await runPython(config.python, {
      id: track.id, directory: working, quality: config.quality, track: stagedTrack,
      albumArtist: existingAlbum?.album_artist || undefined,
      releaseDate: existingAlbum?.year ? String(existingAlbum.year) : undefined,
      genre: existingAlbum?.genre?.split(';').map(part => part.trim()).filter(Boolean),
      coverUrl: track.cover,
    }, config.arl);
    if (result.extension !== 'mp3' && result.extension !== 'flac') throw new Error('Deezer returned an unsupported audio format');
    const source = path.join(working, `track.${result.extension}`);
    const details = await stat(source);
    if (!details.isFile() || details.size < 10_000) throw new Error('Deezer returned an empty or incomplete audio file');
    return await publishStagedTrack(config.directory, source, stagedTrack, result.extension);
  } finally {
    await rm(working, { recursive: true, force: true });
  }
}

function validStagedRelativePath(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 400
    && !path.isAbsolute(value)
    && value.split('/').every(part =>
      part.length > 0
      && part.length <= 160
      && !part.startsWith('.')
      && part !== '..'
      && !/[<>:"\\|?*\x00-\x1f]/.test(part)
    );
}

export function validStagedFilename(filename: unknown): filename is string {
  return validStagedRelativePath(filename) && /\.(mp3|flac|zip)$/i.test(filename);
}

export function validStagedAlbumIdentifier(filename: unknown): filename is string {
  return validStagedRelativePath(filename)
    && filename.split('/').length >= 2
    && !/\.(mp3|flac)$/i.test(filename);
}

export function stagedAlbumRelativePath(filename: string) {
  return filename.toLowerCase().endsWith('.zip') ? filename.slice(0, -4) : filename;
}

export async function listStagedAlbumFiles(filename: string): Promise<string[]> {
  if (!validStagedAlbumIdentifier(filename)) throw new Error('Invalid staged album');
  const directory = deezerStagingConfig().directory;
  const albumRelative = stagedAlbumRelativePath(filename);
  const albumDirectory = path.join(directory, albumRelative);
  return (await readdir(albumDirectory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && /\.(mp3|flac)$/i.test(entry.name))
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

export async function stagedAlbumComplete(filename: string, trackFiles?: string[], trackCount?: number): Promise<boolean> {
  try {
    const files = await listStagedAlbumFiles(filename);
    if (!files.length || (trackCount && files.length < trackCount)) return false;
    if (trackFiles === undefined) return true;
    if (!trackFiles.length || new Set(trackFiles).size !== trackFiles.length) return false;
    if (trackCount && trackFiles.length !== trackCount) return false;
    const present = new Set(files);
    return trackFiles.every(name => /^[^/\\]+\.(mp3|flac)$/i.test(name) && !name.startsWith('.') && present.has(name));
  } catch {
    return false;
  }
}

export async function createStagedAlbumArchive(filename: string, trackFiles?: string[], trackCount?: number) {
  if (!await stagedAlbumComplete(filename, trackFiles, trackCount)) throw new Error('Staged album is incomplete');
  const directory = deezerStagingConfig().directory;
  const albumRelative = stagedAlbumRelativePath(filename);
  const albumDirectory = path.join(directory, albumRelative);
  const files = trackFiles?.length ? trackFiles : await listStagedAlbumFiles(filename);
  if (!files.length) throw new Error('Staged album has no audio files');

  const archive = new ZipArchive({ store: true });
  for (const name of files) {
    archive.file(path.join(albumDirectory, name), { name: `${albumRelative}/${name}` });
  }
  void archive.finalize().catch(error => archive.destroy(error as Error));
  return archive;
}

export async function cleanupLegacyStagedAlbumArchives(): Promise<number> {
  const directory = deezerStagingConfig().directory;
  if (!directory) return 0;

  let artists;
  try {
    artists = await readdir(directory, { withFileTypes: true });
  } catch {
    return 0;
  }

  let removed = 0;
  for (const artist of artists) {
    if (!artist.isDirectory() || artist.name.startsWith('.')) continue;
    const artistDirectory = path.join(directory, artist.name);
    let entries;
    try {
      entries = await readdir(artistDirectory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.zip')) continue;
      const legacyIdentifier = `${artist.name}/${entry.name}`;
      try {
        const files = await listStagedAlbumFiles(legacyIdentifier);
        if (!files.length) continue;
        await unlink(path.join(directory, legacyIdentifier));
        removed += 1;
      } catch {
        // Keep orphaned/invalid archives; only remove archives backed by a valid album folder.
      }
    }
  }
  return removed;
}

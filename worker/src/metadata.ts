import { parseFile, type IAudioMetadata } from 'music-metadata';
import { exec, execFile } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { mimeFromFormat, pickBestPicture } from './art.js';
import { sanitize, splitAndClassifyTags, splitArtistValue } from './tagRules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function nativeValues(m: IAudioMetadata, names: string[]) {
  const want = new Set(names.map((n) => n.toLowerCase()));
  const out: string[] = [];
  for (const tagType of Object.keys(m.native ?? {})) {
    for (const t of m.native[tagType] ?? []) {
      const id = String((t as any).id ?? '').toLowerCase();
      const id2 = id.startsWith('txxx:') ? id.slice('txxx:'.length) : id;
      if (!want.has(id) && !want.has(id2)) continue;
      const val = (t as any).value;
      const pushVal = (x: unknown) => {
        if (typeof x === 'string') out.push(x);
        else if (typeof x === 'number') out.push(String(x));
      };
      if (Array.isArray(val)) val.forEach(pushVal);
      else pushVal(val);
    }
  }
  return out;
}

export type TagResult = {
  title: string | null;
  artist: string | null;
  album: string | null;
  albumartist: string | null;
  genre: string | null;
  country: string | null;
  language: string | null;
  year: number | null;
  durationMs: number | null;
  artMime: string | null;
  artData: Uint8Array | null;
  artists: string[];
  albumartists: string[];
  trackNumber: number | null;
  trackTotal: number | null;
  discNumber: number | null;
  discTotal: number | null;
};

function ffprobeDurationMs(filePath: string, timeoutMs = 15000): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', filePath],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null);
        const s = String(stdout ?? '').trim();
        const n = parseFloat(s);
        if (!Number.isFinite(n) || n <= 0) return resolve(null);
        resolve(Math.round(n * 1000));
      }
    );
  });
}

export async function readTags(filePath: string): Promise<TagResult> {
  // OPUS/OGG often requires full duration calculation; mp3/flac usually do not.
  const ext = path.extname(filePath).toLowerCase();
  const needDuration = ext === '.opus' || ext === '.ogg';
  const m = await parseFile(filePath, { duration: needDuration });

  const title = sanitize(m.common.title);
  const artist = sanitize(m.common.artist);
  const album = sanitize(m.common.album);
  const albumartist = sanitize(m.common.albumartist);
  let durationMs = m.format.duration ? Math.round(m.format.duration * 1000) : null;
  if (!durationMs && needDuration) durationMs = await ffprobeDurationMs(filePath);
  const year = m.common.year ?? null;
  
  // Track and disc numbers
  const trackNumber = m.common.track?.no ?? null;
  const trackTotal = m.common.track?.of ?? null;
  const discNumber = m.common.disk?.no ?? null;
  const discTotal = m.common.disk?.of ?? null;

  const commonAny = m.common as any;

  const classified = splitAndClassifyTags({
    genres: m.common.genre ?? [],
    countries: [
      ...(Array.isArray(commonAny.country) ? commonAny.country : commonAny.country ? [commonAny.country] : []),
      ...nativeValues(m, ['country', 'tXXX:country', 'tXXX:Country', 'TXXX:Country', 'TXXX:COUNTRY'])
    ],
    languages: [
      ...(Array.isArray(commonAny.language) ? commonAny.language : commonAny.language ? [commonAny.language] : []),
      ...nativeValues(m, ['language', 'lang', 'tlan', 'TLAN', 'tXXX:language', 'tXXX:Language', 'TXXX:Language', 'TXXX:LANGUAGE'])
    ]
  });

  const genre = classified.genres.length ? classified.genres.join('; ') : null;
  const country = classified.countries.length ? classified.countries.join('; ') : null;
  const language = classified.languages.length ? classified.languages.join('; ') : null;

  const pic = pickBestPicture(m.common.picture);
  const artMime = pic ? mimeFromFormat(pic.format) : null;
  const artData = pic && artMime ? pic.data : null;

  const dedupeCI = (items: string[]) => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const it of items) {
      const s = sanitize(it);
      if (!s) continue;
      const key = s.trim().toLowerCase();
      if (!key) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s.trim());
    }
    return out;
  };

  // Merge artists from *all* relevant sources (common + native), then split and dedupe.
  // This handles files with repeated artist frames (e.g. multiple TPE1 / TXXX:ARTISTS).
  const mainArtist = m.common.artist || '';
  const hasCommaInName = mainArtist.includes(',') && !mainArtist.includes(';');

  const candidates: string[] = [];
  if (mainArtist) candidates.push(mainArtist);

  // music-metadata may split comma-in-name artists into common.artists; avoid that specific corruption.
  if (m.common.artists && m.common.artists.length > 0) {
    const joined = m.common.artists.join(', ');
    if (!(hasCommaInName && joined === mainArtist)) candidates.push(...m.common.artists);
  }

  // Pull in repeated frames and custom tags (e.g. TXXX:ARTISTS).
  candidates.push(
    ...nativeValues(m, [
      'tpe1',
      'artist',
      'artists',
      'performer',
      'performers',
      'composer',
      'composers'
    ])
  );

  const artists = (() => {
    const out = dedupeCI(candidates.flatMap((v) => splitArtistValue(String(v ?? ''))));

    // music-metadata can expose both a full artist string (e.g. from ID3v2) and
    // a truncated legacy value (e.g. ID3v1 30-char limit) as separate entries.
    // If we keep both, we end up with duplicates like:
    //   "A, B, C" and "A, B, C..." which breaks artist merging.
    // Prefer the longer string when one is a strict prefix of another.
    return out.filter((a, i) => !out.some((b, j) => j !== i && b.startsWith(a) && b.length > a.length));
  })();

  const albumArtistCandidates: string[] = [];
  if (m.common.albumartist) albumArtistCandidates.push(m.common.albumartist);
  const commonAny2 = m.common as any;
  if (Array.isArray(commonAny2.albumartists)) albumArtistCandidates.push(...commonAny2.albumartists);

  albumArtistCandidates.push(
    ...nativeValues(m, ['tpe2', 'albumartist', 'album artist', 'album_artist', 'albumartists'])
  );

  const albumartists = (() => {
    const out = dedupeCI(albumArtistCandidates.flatMap((v) => splitArtistValue(String(v ?? ''))));
    return out.filter((a, i) => !out.some((b, j) => j !== i && b.startsWith(a) && b.length > a.length));
  })();

  return { title, artist, album, albumartist, genre, country, language, year, durationMs, artMime, artData, artists, albumartists, trackNumber, trackTotal, discNumber, discTotal };
}

/**
 * Read tags using a separate node process via exec.
 * This completely isolates from the main process event loop.
 */
export async function readTagsAsync(filePath: string, timeoutMs = 30000): Promise<TagResult> {
  return new Promise((resolve, reject) => {
    const childScriptPath = path.join(__dirname, 'metadataChild.js');
    // Use base64 encoding to safely pass file paths with special characters
    const encodedPath = Buffer.from(filePath).toString('base64');
    const cmd = `node ${childScriptPath} --base64 ${encodedPath}`;
    
    let settled = false;
    const child = exec(cmd, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (settled) return;
      settled = true;
      if (error) {
        console.error(`[readTagsAsync] Error: ${stderr || error.message}`);
        // Ensure child process is killed on error
        if (!child.killed) child.kill('SIGTERM');
        reject(new Error(stderr || error.message));
        return;
      }
      
      try {
        const result = JSON.parse(stdout);
        // Convert base64 art data back to Uint8Array
        const artData = result.artDataBase64 
          ? new Uint8Array(Buffer.from(result.artDataBase64, 'base64'))
          : null;
        resolve({
          ...result,
          artData,
          artDataBase64: undefined
        });
      } catch (e) {
        console.error(`[readTagsAsync] Parse error: ${e}`);
        if (!child.killed) child.kill('SIGTERM');
        reject(new Error(`Failed to parse child output: ${e}`));
      }
    });
    
    child.on('spawn', () => {
      console.error(`[readTagsAsync] Child spawned for: ${filePath}`);
    });

    // Cleanup on timeout (exec timeout fires error callback, but ensure kill)
    child.on('error', () => {
      if (!child.killed) child.kill('SIGTERM');
    });
  });
}

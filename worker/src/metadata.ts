import { parseFile, type IAudioMetadata } from 'music-metadata';
import { exec } from 'child_process';
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

export async function readTags(filePath: string): Promise<TagResult> {
  const m = await parseFile(filePath, { duration: false });

  const title = sanitize(m.common.title);
  const artist = sanitize(m.common.artist);
  const album = sanitize(m.common.album);
  const albumartist = sanitize(m.common.albumartist);
  const durationMs = m.format.duration ? Math.round(m.format.duration * 1000) : null;
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

  // Get artist list - prefer m.common.artist over m.common.artists when:
  // - m.common.artist contains a comma (indicates artist name with comma like "Tyler, The Creator")
  // - m.common.artists looks like a bad split of a comma-containing name
  let artistSource: string[];
  const mainArtist = m.common.artist || '';
  const hasCommaInName = mainArtist.includes(',') && !mainArtist.includes(';');
  
  if (hasCommaInName) {
    // Use the main artist field as the source, it preserves comma-in-name artists
    artistSource = [mainArtist];
  } else if (m.common.artists && m.common.artists.length > 0) {
    artistSource = m.common.artists;
  } else if (mainArtist) {
    artistSource = [mainArtist];
  } else {
    artistSource = [];
  }
  
  const artists = artistSource.flatMap((v) => splitArtistValue(String(v ?? ''))).map(sanitize).filter(Boolean) as string[];
  const albumartists = (m.common.albumartist ? [m.common.albumartist] : []).flatMap((v) => splitArtistValue(String(v ?? ''))).map(sanitize).filter(Boolean) as string[];

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
    
    const child = exec(cmd, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        console.error(`[readTagsAsync] Error: ${stderr || error.message}`);
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
        reject(new Error(`Failed to parse child output: ${e}`));
      }
    });
    
    child.on('spawn', () => {
      console.error(`[readTagsAsync] Child spawned for: ${filePath}`);
    });
  });
}

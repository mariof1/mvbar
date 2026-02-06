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

  // If ID3v2 is present, ignore ID3v1 native values to avoid inserting legacy "????" placeholders
  // (ID3v1 cannot represent many non-Latin scripts and is often lossy).
  const nativeKeys = Object.keys(m.native ?? {});
  const hasId3v2 = nativeKeys.some((k) => k.toLowerCase().startsWith('id3v2'));

  for (const tagType of nativeKeys) {
    if (hasId3v2 && tagType.toLowerCase() === 'id3v1') continue;
    for (const t of m.native?.[tagType] ?? []) {
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
  // Basic metadata
  title: string | null;
  artist: string | null;
  album: string | null;
  albumartist: string | null;
  genre: string | null;
  country: string | null;
  language: string | null;
  year: number | null;
  durationMs: number | null;
  
  // Artwork
  artMime: string | null;
  artData: Uint8Array | null;
  
  // Multi-value artist fields
  artists: string[];
  albumartists: string[];
  composers: string[];
  conductors: string[];
  
  // Track/disc numbers
  trackNumber: number | null;
  trackTotal: number | null;
  discNumber: number | null;
  discTotal: number | null;
  
  // Extended metadata
  bpm: number | null;
  initialKey: string | null;
  composer: string | null;
  conductor: string | null;
  publisher: string | null;
  copyright: string | null;
  comment: string | null;
  mood: string | null;
  grouping: string | null;
  isrc: string | null;
  releaseDate: string | null;
  originalYear: number | null;
  compilation: boolean;
  
  // Sort fields
  titleSort: string | null;
  artistSort: string | null;
  albumSort: string | null;
  albumArtistSort: string | null;
  
  // MusicBrainz IDs
  musicbrainzTrackId: string | null;
  musicbrainzReleaseId: string | null;
  musicbrainzArtistId: string | null;
  musicbrainzAlbumArtistId: string | null;
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

  // Helper to get first element if array
  const firstOf = <T>(v: T | T[] | undefined): T | undefined => Array.isArray(v) ? v[0] : v;

  const title = sanitize(m.common.title);
  const artist = sanitize(m.common.artist);
  const album = sanitize(m.common.album);
  let albumartist = sanitize(m.common.albumartist);
  let durationMs = m.format.duration ? Math.round(m.format.duration * 1000) : null;
  if (!durationMs && needDuration) durationMs = await ffprobeDurationMs(filePath);
  const year = m.common.year ?? null;
  
  // Track and disc numbers
  const trackNumber = m.common.track?.no ?? null;
  const trackTotal = m.common.track?.of ?? null;
  const discNumber = m.common.disk?.no ?? null;
  const discTotal = m.common.disk?.of ?? null;

  const commonAny = m.common as any;

  // === Extended metadata extraction ===
  
  // BPM
  const bpmRaw = commonAny.bpm ?? nativeValues(m, ['tbpm', 'TBPM', 'bpm', 'BPM'])[0];
  const bpm = bpmRaw ? Math.round(Number(bpmRaw)) : null;
  
  // Initial key (musical key)
  const initialKey = sanitize(nativeValues(m, ['tkey', 'TKEY', 'key', 'initialkey', 'INITIALKEY'])[0] ?? commonAny.key);
  
  // Composer
  const composerRaw = [
    ...(commonAny.composer ? (Array.isArray(commonAny.composer) ? commonAny.composer : [commonAny.composer]) : []),
    ...nativeValues(m, ['tcom', 'TCOM', 'composer', 'COMPOSER'])
  ];
  const composer = composerRaw.length ? sanitize(composerRaw.join('; ')) : null;
  
  // Conductor
  const conductorRaw = [
    ...(commonAny.conductor ? (Array.isArray(commonAny.conductor) ? commonAny.conductor : [commonAny.conductor]) : []),
    ...nativeValues(m, ['tpe3', 'TPE3', 'conductor', 'CONDUCTOR'])
  ];
  const conductor = conductorRaw.length ? sanitize(conductorRaw.join('; ')) : null;
  
  // Publisher/Label (may be array in music-metadata)
  const publisherRaw = firstOf(commonAny.label) ?? firstOf(commonAny.publisher) ?? 
    nativeValues(m, ['tpub', 'TPUB', 'label', 'LABEL', 'publisher', 'PUBLISHER'])[0];
  const publisher = sanitize(publisherRaw);
  
  // Copyright
  const copyright = sanitize(
    firstOf(commonAny.copyright) ?? nativeValues(m, ['tcop', 'TCOP', 'copyright', 'COPYRIGHT'])[0]
  );
  
  // Comment
  const commentRaw = firstOf(commonAny.comment) ?? nativeValues(m, ['comm', 'COMM', 'comment', 'COMMENT'])[0];
  const comment = sanitize(typeof commentRaw === 'object' && commentRaw?.text ? commentRaw.text : commentRaw);
  
  // Mood
  const mood = sanitize(
    nativeValues(m, ['tmoo', 'TMOO', 'mood', 'MOOD', 'TXXX:MOOD', 'TXXX:mood'])[0]
  );
  
  // Grouping
  const grouping = sanitize(
    firstOf(commonAny.grouping) ?? nativeValues(m, ['tit1', 'TIT1', 'grouping', 'GROUPING', 'contentgroup'])[0]
  );
  
  // ISRC (may be array in music-metadata)
  const isrc = sanitize(
    firstOf(commonAny.isrc) ?? nativeValues(m, ['tsrc', 'TSRC', 'isrc', 'ISRC'])[0]
  );
  
  // Release date (full date if available)
  const releaseDateRaw = nativeValues(m, ['tdrl', 'TDRL', 'releasedate', 'RELEASEDATE', 'TXXX:RELEASEDATE'])[0] 
    ?? commonAny.date;
  const releaseDate = sanitize(releaseDateRaw);
  
  // Original year
  const originalYearRaw = commonAny.originalyear ?? commonAny.originaldate 
    ?? nativeValues(m, ['tory', 'TORY', 'tdor', 'TDOR', 'originalyear', 'ORIGINALYEAR'])[0];
  const originalYear = originalYearRaw ? parseInt(String(originalYearRaw).slice(0, 4), 10) || null : null;
  
  // Compilation flag
  const compilationRaw = commonAny.compilation ?? nativeValues(m, ['tcmp', 'TCMP', 'compilation', 'COMPILATION'])[0];
  const compilation = compilationRaw === true || compilationRaw === 1 || compilationRaw === '1';
  
  // Sort fields
  const titleSort = sanitize(
    commonAny.titlesort ?? nativeValues(m, ['tsot', 'TSOT', 'titlesort', 'TITLESORT', 'TXXX:TITLESORT'])[0]
  );
  const artistSort = sanitize(
    commonAny.artistsort ?? nativeValues(m, ['tsop', 'TSOP', 'artistsort', 'ARTISTSORT', 'TXXX:ARTISTSORT'])[0]
  );
  const albumSort = sanitize(
    commonAny.albumsort ?? nativeValues(m, ['tsoa', 'TSOA', 'albumsort', 'ALBUMSORT', 'TXXX:ALBUMSORT'])[0]
  );
  const albumArtistSort = sanitize(
    commonAny.albumartistsort ?? nativeValues(m, ['tso2', 'TSO2', 'albumartistsort', 'ALBUMARTISTSORT', 'TXXX:ALBUMARTISTSORT'])[0]
  );
  
  // MusicBrainz IDs
  const musicbrainzTrackId = sanitize(
    commonAny.musicbrainz_trackid ?? commonAny.musicbrainz_recordingid 
    ?? nativeValues(m, ['TXXX:MUSICBRAINZ_TRACKID', 'TXXX:MusicBrainz Track Id', 'TXXX:MUSICBRAINZ_RECORDINGID'])[0]
  );
  const musicbrainzReleaseId = sanitize(
    commonAny.musicbrainz_albumid 
    ?? nativeValues(m, ['TXXX:MUSICBRAINZ_ALBUMID', 'TXXX:MusicBrainz Album Id'])[0]
  );
  const musicbrainzArtistId = sanitize(
    commonAny.musicbrainz_artistid?.[0] ?? commonAny.musicbrainz_artistid
    ?? nativeValues(m, ['TXXX:MUSICBRAINZ_ARTISTID', 'TXXX:MusicBrainz Artist Id'])[0]
  );
  const musicbrainzAlbumArtistId = sanitize(
    commonAny.musicbrainz_albumartistid?.[0] ?? commonAny.musicbrainz_albumartistid
    ?? nativeValues(m, ['TXXX:MUSICBRAINZ_ALBUMARTISTID', 'TXXX:MusicBrainz Album Artist Id'])[0]
  );

  // === Genre/Country/Language classification ===
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

  const foldKey = (v: string) => {
    const s = (sanitize(v) ?? '').trim().replace(/\s+/g, ' ');
    if (!s) return '';
    // Make dedupe accent-insensitive (prefer the diacritic form when variants exist).
    const nkfd = s.normalize('NFKD');
    let out = '';
    for (const ch of nkfd) {
      if (ch === 'ł' || ch === 'Ł') {
        out += 'l';
        continue;
      }
      if (/[\p{Mark}]/u.test(ch)) continue;
      out += ch;
    }
    return out.trim().replace(/\s+/g, ' ').toLowerCase();
  };

  const scoreVariant = (s: string) => {
    const nonAscii = [...s].filter((ch) => ch.charCodeAt(0) > 127).length;
    return [nonAscii, s.length] as const;
  };

  const dedupeFold = (items: string[]) => {
    const best = new Map<string, string>();
    for (const it of items) {
      const s = (sanitize(it) ?? '').trim().replace(/\s+/g, ' ');
      if (!s) continue;
      const k = foldKey(s);
      if (!k) continue;
      const cur = best.get(k);
      if (!cur) {
        best.set(k, s);
        continue;
      }
      const [na, la] = scoreVariant(s);
      const [nb, lb] = scoreVariant(cur);
      if (na > nb || (na === nb && la > lb)) best.set(k, s);
    }
    return [...best.values()];
  };

  // === Artist handling with priority: ALBUMARTIST > ARTIST > ARTISTS ===
  
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
      'performers'
    ])
  );

  let artists = (() => {
    const out = dedupeFold(candidates.flatMap((v) => splitArtistValue(String(v ?? ''))));

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

  let albumartists = (() => {
    const out = dedupeFold(albumArtistCandidates.flatMap((v) => splitArtistValue(String(v ?? ''))));
    return out.filter((a, i) => !out.some((b, j) => j !== i && b.startsWith(a) && b.length > a.length));
  })();

  // === Composer/Conductor arrays for track_credits ===
  const composers = dedupeFold(composerRaw.flatMap((v) => splitArtistValue(String(v ?? ''))));
  const conductors = dedupeFold(conductorRaw.flatMap((v) => splitArtistValue(String(v ?? ''))));

  // Canonicalize across artist+albumartist so accent-variants map to the same DB artist row.
  const canonByKey = new Map<string, string>();
  for (const v of [...artists, ...albumartists, ...composers, ...conductors]) {
    const k = foldKey(v);
    if (!k) continue;
    const cur = canonByKey.get(k);
    if (!cur) canonByKey.set(k, v);
    else {
      const [na, la] = scoreVariant(v);
      const [nb, lb] = scoreVariant(cur);
      if (na > nb || (na === nb && la > lb)) canonByKey.set(k, v);
    }
  }
  const canon = (v: string) => canonByKey.get(foldKey(v)) ?? v;
  artists = dedupeFold(artists.map(canon));
  albumartists = dedupeFold(albumartists.map(canon));

  // Standardize album artist string for display/filtering (e.g. handle "A\0\uFEFFB\0\uFEFFC")
  if (albumartists.length) albumartist = albumartists.join('; ');

  return {
    title, artist, album, albumartist, genre, country, language, year, durationMs, artMime, artData,
    artists, albumartists, composers, conductors,
    trackNumber, trackTotal, discNumber, discTotal,
    bpm, initialKey, composer, conductor, publisher, copyright, comment, mood, grouping,
    isrc, releaseDate, originalYear, compilation,
    titleSort, artistSort, albumSort, albumArtistSort,
    musicbrainzTrackId, musicbrainzReleaseId, musicbrainzArtistId, musicbrainzAlbumArtistId
  };
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

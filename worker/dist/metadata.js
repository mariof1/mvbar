import { parseFile } from 'music-metadata';
import { exec, execFile } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { mimeFromFormat, pickBestPicture } from './art.js';
import { sanitize, splitAndClassifyTags, splitArtistValue } from './tagRules.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
function nativeValues(m, names) {
    const want = new Set(names.map((n) => n.toLowerCase()));
    const out = [];
    for (const tagType of Object.keys(m.native ?? {})) {
        for (const t of m.native[tagType] ?? []) {
            const id = String(t.id ?? '').toLowerCase();
            const id2 = id.startsWith('txxx:') ? id.slice('txxx:'.length) : id;
            if (!want.has(id) && !want.has(id2))
                continue;
            const val = t.value;
            const pushVal = (x) => {
                if (typeof x === 'string')
                    out.push(x);
                else if (typeof x === 'number')
                    out.push(String(x));
            };
            if (Array.isArray(val))
                val.forEach(pushVal);
            else
                pushVal(val);
        }
    }
    return out;
}
function ffprobeDurationMs(filePath, timeoutMs = 15000) {
    return new Promise((resolve) => {
        execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', filePath], { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout) => {
            if (err)
                return resolve(null);
            const s = String(stdout ?? '').trim();
            const n = parseFloat(s);
            if (!Number.isFinite(n) || n <= 0)
                return resolve(null);
            resolve(Math.round(n * 1000));
        });
    });
}
export async function readTags(filePath) {
    // OPUS/OGG often requires full duration calculation; mp3/flac usually do not.
    const ext = path.extname(filePath).toLowerCase();
    const needDuration = ext === '.opus' || ext === '.ogg';
    const m = await parseFile(filePath, { duration: needDuration });
    const title = sanitize(m.common.title);
    const artist = sanitize(m.common.artist);
    const album = sanitize(m.common.album);
    let albumartist = sanitize(m.common.albumartist);
    let durationMs = m.format.duration ? Math.round(m.format.duration * 1000) : null;
    if (!durationMs && needDuration)
        durationMs = await ffprobeDurationMs(filePath);
    const year = m.common.year ?? null;
    // Track and disc numbers
    const trackNumber = m.common.track?.no ?? null;
    const trackTotal = m.common.track?.of ?? null;
    const discNumber = m.common.disk?.no ?? null;
    const discTotal = m.common.disk?.of ?? null;
    const commonAny = m.common;
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
    const foldKey = (v) => {
        const s = (sanitize(v) ?? '').trim().replace(/\s+/g, ' ');
        if (!s)
            return '';
        // Make dedupe accent-insensitive (prefer the diacritic form when variants exist).
        const nkfd = s.normalize('NFKD');
        let out = '';
        for (const ch of nkfd) {
            if (ch === 'ł' || ch === 'Ł') {
                out += 'l';
                continue;
            }
            if (/[\p{Mark}]/u.test(ch))
                continue;
            out += ch;
        }
        return out.trim().replace(/\s+/g, ' ').toLowerCase();
    };
    const scoreVariant = (s) => {
        const nonAscii = [...s].filter((ch) => ch.charCodeAt(0) > 127).length;
        return [nonAscii, s.length];
    };
    const dedupeFold = (items) => {
        const best = new Map();
        for (const it of items) {
            const s = (sanitize(it) ?? '').trim().replace(/\s+/g, ' ');
            if (!s)
                continue;
            const k = foldKey(s);
            if (!k)
                continue;
            const cur = best.get(k);
            if (!cur) {
                best.set(k, s);
                continue;
            }
            const [na, la] = scoreVariant(s);
            const [nb, lb] = scoreVariant(cur);
            if (na > nb || (na === nb && la > lb))
                best.set(k, s);
        }
        return [...best.values()];
    };
    // Merge artists from *all* relevant sources (common + native), then split and dedupe.
    // This handles files with repeated artist frames (e.g. multiple TPE1 / TXXX:ARTISTS).
    const mainArtist = m.common.artist || '';
    const hasCommaInName = mainArtist.includes(',') && !mainArtist.includes(';');
    const candidates = [];
    if (mainArtist)
        candidates.push(mainArtist);
    // music-metadata may split comma-in-name artists into common.artists; avoid that specific corruption.
    if (m.common.artists && m.common.artists.length > 0) {
        const joined = m.common.artists.join(', ');
        if (!(hasCommaInName && joined === mainArtist))
            candidates.push(...m.common.artists);
    }
    // Pull in repeated frames and custom tags (e.g. TXXX:ARTISTS).
    candidates.push(...nativeValues(m, [
        'tpe1',
        'artist',
        'artists',
        'performer',
        'performers',
        'composer',
        'composers'
    ]));
    let artists = (() => {
        const out = dedupeFold(candidates.flatMap((v) => splitArtistValue(String(v ?? ''))));
        // music-metadata can expose both a full artist string (e.g. from ID3v2) and
        // a truncated legacy value (e.g. ID3v1 30-char limit) as separate entries.
        // If we keep both, we end up with duplicates like:
        //   "A, B, C" and "A, B, C..." which breaks artist merging.
        // Prefer the longer string when one is a strict prefix of another.
        return out.filter((a, i) => !out.some((b, j) => j !== i && b.startsWith(a) && b.length > a.length));
    })();
    const albumArtistCandidates = [];
    if (m.common.albumartist)
        albumArtistCandidates.push(m.common.albumartist);
    const commonAny2 = m.common;
    if (Array.isArray(commonAny2.albumartists))
        albumArtistCandidates.push(...commonAny2.albumartists);
    albumArtistCandidates.push(...nativeValues(m, ['tpe2', 'albumartist', 'album artist', 'album_artist', 'albumartists']));
    let albumartists = (() => {
        const out = dedupeFold(albumArtistCandidates.flatMap((v) => splitArtistValue(String(v ?? ''))));
        return out.filter((a, i) => !out.some((b, j) => j !== i && b.startsWith(a) && b.length > a.length));
    })();
    // Canonicalize across artist+albumartist so accent-variants map to the same DB artist row.
    const canonByKey = new Map();
    for (const v of [...artists, ...albumartists]) {
        const k = foldKey(v);
        if (!k)
            continue;
        const cur = canonByKey.get(k);
        if (!cur)
            canonByKey.set(k, v);
        else {
            const [na, la] = scoreVariant(v);
            const [nb, lb] = scoreVariant(cur);
            if (na > nb || (na === nb && la > lb))
                canonByKey.set(k, v);
        }
    }
    const canon = (v) => canonByKey.get(foldKey(v)) ?? v;
    artists = dedupeFold(artists.map(canon));
    albumartists = dedupeFold(albumartists.map(canon));
    // Standardize album artist string for display/filtering (e.g. handle "A\0\uFEFFB\0\uFEFFC")
    if (albumartists.length)
        albumartist = albumartists.join('; ');
    return { title, artist, album, albumartist, genre, country, language, year, durationMs, artMime, artData, artists, albumartists, trackNumber, trackTotal, discNumber, discTotal };
}
/**
 * Read tags using a separate node process via exec.
 * This completely isolates from the main process event loop.
 */
export async function readTagsAsync(filePath, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        const childScriptPath = path.join(__dirname, 'metadataChild.js');
        // Use base64 encoding to safely pass file paths with special characters
        const encodedPath = Buffer.from(filePath).toString('base64');
        const cmd = `node ${childScriptPath} --base64 ${encodedPath}`;
        let settled = false;
        const child = exec(cmd, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (settled)
                return;
            settled = true;
            if (error) {
                console.error(`[readTagsAsync] Error: ${stderr || error.message}`);
                // Ensure child process is killed on error
                if (!child.killed)
                    child.kill('SIGTERM');
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
            }
            catch (e) {
                console.error(`[readTagsAsync] Parse error: ${e}`);
                if (!child.killed)
                    child.kill('SIGTERM');
                reject(new Error(`Failed to parse child output: ${e}`));
            }
        });
        child.on('spawn', () => {
            console.error(`[readTagsAsync] Child spawned for: ${filePath}`);
        });
        // Cleanup on timeout (exec timeout fires error callback, but ensure kill)
        child.on('error', () => {
            if (!child.killed)
                child.kill('SIGTERM');
        });
    });
}

import { parseFile } from 'music-metadata';
import { mimeFromFormat, pickBestPicture } from './art.js';
import { sanitize, splitAndClassifyTags, splitArtistValue } from './tagRules.js';
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
export async function readTags(filePath) {
    const m = await parseFile(filePath, { duration: false });
    const title = sanitize(m.common.title);
    const artist = sanitize(m.common.artist);
    const album = sanitize(m.common.album);
    const albumartist = sanitize(m.common.albumartist);
    const durationMs = m.format.duration ? Math.round(m.format.duration * 1000) : null;
    const year = m.common.year ?? null;
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
    const artists = (m.common.artists ?? (m.common.artist ? [m.common.artist] : [])).flatMap((v) => splitArtistValue(String(v ?? ''))).map(sanitize).filter(Boolean);
    const albumartists = (m.common.albumartist ? [m.common.albumartist] : []).flatMap((v) => splitArtistValue(String(v ?? ''))).map(sanitize).filter(Boolean);
    return { title, artist, album, albumartist, genre, country, language, year, durationMs, artMime, artData, artists, albumartists };
}

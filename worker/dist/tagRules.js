export function sanitize(str) {
    if (!str)
        return null;
    return str.replace(/\0/g, '');
}
function normalizeToken(s) {
    const v = sanitize(s) ?? '';
    return v
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/^\w/, (c) => c.toUpperCase());
}
export function splitArtistValue(v) {
    // Split on:
    // - Semicolon (;)
    // - Pipe (|)
    // - Null (\0)
    // - BOM (\uFEFF) - seen in some tags
    // - Slash surrounded by spaces ( / ) - but NOT single slash (AC/DC)
    // - Double slash (//)
    // - "feat", "feat.", "ft", "ft.", "featuring", "vs", "vs.", "with", "meets" (case insensitive)
    // - " x " (space x space) - case insensitive
    return v
        .split(/\s*;\s*|\s*\|\s*|\0|\uFEFF|\s+\/\s+|\s*\/\/\s*|\s+feat\.?\s+|\s+ft\.?\s+|\s+featuring\s+|\s+vs\.?\s+|\s+with\s+|\s+meets\s+|\s+x\s+/i)
        .map((x) => x.trim())
        .filter(Boolean);
}
function splitGenreValue(v) {
    // Aggressive split for genres/countries: semicolon, pipe, comma, slash (with/without spaces), BOM.
    return v
        .split(/\s*;\s*|\s*,\s*|\s*\|\s*|\s+\/\s+|\s*\/\s*|\0|\uFEFF/)
        .map((x) => x.trim())
        .filter(Boolean);
}
function splitTagValue(v) {
    return splitGenreValue(v);
}
function dedupe(items) {
    const out = [];
    const seen = new Set();
    for (const it of items) {
        const key = it.toLowerCase();
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(it);
    }
    return out;
}
const NATIONALITY_TO_COUNTRY = new Map([
    ['polish', 'Poland'],
    ['german', 'Germany'],
    ['romanian', 'Romania'],
    ['spanish', 'Spain'],
    ['brazilian', 'Brazil'],
    ['portuguese', 'Portugal'],
    ['french', 'France'],
    ['italian', 'Italy'],
    ['english', 'England'],
    ['irish', 'Ireland'],
    ['scottish', 'Scotland'],
    ['welsh', 'Wales'],
    ['ukrainian', 'Ukraine'],
    ['russian', 'Russia'],
    ['czech', 'Czech Republic'],
    ['slovak', 'Slovakia'],
    ['hungarian', 'Hungary'],
    ['swedish', 'Sweden'],
    ['norwegian', 'Norway'],
    ['danish', 'Denmark'],
    ['finnish', 'Finland'],
    ['dutch', 'Netherlands'],
    ['greek', 'Greece'],
    ['turkish', 'Turkey'],
    ['lithuanian', 'Lithuania']
]);
const LANGUAGE_ABBREV = new Map([
    ['eng', 'English'],
    ['en', 'English'],
    ['english', 'English'],
    ['pol', 'Polish'],
    ['pl', 'Polish'],
    ['de', 'German'],
    ['deu', 'German'],
    ['ger', 'German'],
    ['es', 'Spanish'],
    ['spa', 'Spanish'],
    ['fr', 'French'],
    ['fra', 'French'],
    ['fre', 'French'],
    ['it', 'Italian'],
    ['ita', 'Italian'],
    ['pt', 'Portuguese'],
    ['por', 'Portuguese'],
    ['ro', 'Romanian'],
    ['ron', 'Romanian'],
    ['rum', 'Romanian'],
    ['ru', 'Russian'],
    ['rus', 'Russian'],
    ['uk', 'Ukrainian'],
    ['ukr', 'Ukrainian'],
    ['lt', 'Lithuanian'],
    ['lit', 'Lithuanian'],
    ['lithuanian', 'Lithuanian']
]);
function normalizeCountryToken(s) {
    const t = normalizeToken(s);
    if (!t)
        return t;
    return NATIONALITY_TO_COUNTRY.get(t.toLowerCase()) ?? t;
}
function normalizeLanguageToken(s) {
    const v = sanitize(s) ?? '';
    const key = v.trim().replace(/\.+$/, '').toLowerCase();
    return LANGUAGE_ABBREV.get(key) ?? normalizeToken(v);
}
const SPLITTABLE_GENRE_SUFFIX = new Set(['rock', 'pop', 'metal', 'rap', 'hip hop', 'hip-hop', 'folk', 'jazz', 'classical', 'electronic', 'house', 'techno']);
export function splitAndClassifyTags(input) {
    const genreTokens = (input.genres ?? []).flatMap((g) => splitGenreValue(String(g ?? '')));
    const genres = [];
    const countriesFromGenres = [];
    for (const raw of genreTokens) {
        const t = normalizeToken(raw);
        if (!t)
            continue;
        const m = t.match(/^(.+?)\s+music$/i);
        if (m) {
            const c = normalizeCountryToken(m[1]);
            if (c)
                countriesFromGenres.push(c);
            continue;
        }
        const parts = t.split(/\s+/);
        if (parts.length >= 2) {
            const first = parts[0];
            const rest = parts.slice(1).join(' ');
            if (NATIONALITY_TO_COUNTRY.has(first.toLowerCase()) && SPLITTABLE_GENRE_SUFFIX.has(rest.toLowerCase())) {
                countriesFromGenres.push(normalizeCountryToken(first));
                genres.push(normalizeToken(rest));
                continue;
            }
        }
        if (NATIONALITY_TO_COUNTRY.has(t.toLowerCase())) {
            countriesFromGenres.push(normalizeCountryToken(t));
            continue;
        }
        genres.push(t);
    }
    const explicitCountries = (input.countries ?? [])
        .flatMap((x) => splitGenreValue(String(x ?? '')))
        .map(normalizeCountryToken)
        .filter(Boolean);
    const explicitLanguages = (input.languages ?? [])
        .flatMap((x) => splitGenreValue(String(x ?? '')))
        .map(normalizeLanguageToken)
        .filter(Boolean);
    return {
        genres: dedupe(genres),
        countries: dedupe([...explicitCountries, ...countriesFromGenres]),
        languages: dedupe(explicitLanguages)
    };
}

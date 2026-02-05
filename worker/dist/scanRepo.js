import { db } from './db.js';
const cleanStr = (s) => s.replace(/\0/g, '');
const cleanOpt = (s) => (s == null ? null : cleanStr(s));
// Retry wrapper for transient DB errors
async function withRetry(fn, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        }
        catch (e) {
            const isTransient = e?.message?.includes('timeout') ||
                e?.message?.includes('Connection terminated') ||
                e?.code === 'ECONNRESET';
            if (isTransient && attempt < maxRetries) {
                await new Promise(r => setTimeout(r, 100 * attempt));
                continue;
            }
            throw e;
        }
    }
    throw new Error('Max retries exceeded');
}
function isMissingScanJobsTable(e) {
    const msg = e instanceof Error ? e.message : String(e);
    return msg.includes('relation "scan_jobs" does not exist');
}
export async function claimNextJob() {
    try {
        const r = await db().query("update scan_jobs set state='running', started_at=now() where id = (select id from scan_jobs where state='queued' order by id asc limit 1 for update skip locked) returning id, state");
        return r.rows[0] ?? null;
    }
    catch (e) {
        if (isMissingScanJobsTable(e))
            return null;
        throw e;
    }
}
export async function getLibraryIdByMountPath(mountPath) {
    return withRetry(async () => {
        const r = await db().query('select id from libraries where mount_path=$1', [cleanStr(mountPath)]);
        if (r.rowCount)
            return Number(r.rows[0].id);
        const ins = await db().query('insert into libraries(mount_path) values ($1) returning id', [cleanStr(mountPath)]);
        return Number(ins.rows[0].id);
    });
}
export async function getTrackByPath(mountPath, trackPath) {
    return withRetry(async () => {
        const libraryId = await getLibraryIdByMountPath(mountPath);
        const r = await db().query('select mtime_ms, size_bytes, ext from tracks where library_id=$1 and path=$2', [libraryId, cleanStr(trackPath)]);
        return r.rows[0] ?? null;
    });
}
export async function markSeen(jobId, mountPath, trackPath, lyricsPath) {
    const libraryId = await getLibraryIdByMountPath(mountPath);
    await db().query('update tracks set last_seen_job_id=$1, lyrics_path=$2, updated_at=now() where library_id=$3 and path=$4', [
        jobId,
        cleanOpt(lyricsPath),
        libraryId,
        cleanStr(trackPath)
    ]);
}
export async function enqueueScan(requestedBy) {
    const r = await db().query("insert into scan_jobs(state, requested_by) values ('queued', $1) returning id", [requestedBy]);
    return r.rows[0].id;
}
export async function finishJob(id, state, stats, error) {
    await db().query('update scan_jobs set state=$2, finished_at=now(), stats=$3, error=$4 where id=$1', [
        id,
        state,
        stats ?? null,
        error ? cleanStr(error) : null
    ]);
}
export async function upsertTrack(params) {
    return withRetry(async () => {
        const client = await db().connect();
        try {
            const libraryId = await getLibraryIdByMountPath(params.mountPath);
            const refreshMeta = process.env.SCAN_REFRESH_META === '1';
            const trackPath = cleanStr(params.path);
            const ext = cleanStr(params.ext);
            const title = cleanOpt(params.title);
            const artist = cleanOpt(params.artist);
            const album = cleanOpt(params.album);
            const albumartist = cleanOpt(params.albumartist);
            const genre = cleanOpt(params.genre);
            const country = cleanOpt(params.country);
            const language = cleanOpt(params.language);
            const year = params.year ?? null;
            const artPath = cleanOpt(params.artPath);
            const artMime = cleanOpt(params.artMime);
            const artHash = cleanOpt(params.artHash);
            const lyricsPath = cleanOpt(params.lyricsPath);
            // Upsert track
            const trackRes = await client.query(refreshMeta
                ? `insert into tracks(library_id, path, mtime_ms, birthtime_ms, size_bytes, ext, title, artist, album, genre, country, language, year, duration_ms, last_seen_job_id, art_path, art_mime, art_hash, lyrics_path, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19, to_timestamp($4::double precision / 1000.0))
         on conflict (library_id, path) do update set
           mtime_ms=excluded.mtime_ms,
           birthtime_ms=excluded.birthtime_ms,
           size_bytes=excluded.size_bytes,
           ext=excluded.ext,
           title=excluded.title,
           artist=excluded.artist,
           album=excluded.album,
           genre=coalesce(excluded.genre, tracks.genre),
           country=coalesce(excluded.country, tracks.country),
           language=coalesce(excluded.language, tracks.language),
           year=coalesce(excluded.year, tracks.year),
           duration_ms=excluded.duration_ms,
           last_seen_job_id=excluded.last_seen_job_id,
           art_path=excluded.art_path,
           art_mime=excluded.art_mime,
           art_hash=excluded.art_hash,
           lyrics_path=excluded.lyrics_path,
           created_at=excluded.created_at,
           updated_at=now()
         returning id`
                : `insert into tracks(library_id, path, mtime_ms, birthtime_ms, size_bytes, ext, title, artist, album, genre, country, language, year, duration_ms, last_seen_job_id, art_path, art_mime, art_hash, lyrics_path, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19, to_timestamp($4::double precision / 1000.0))
         on conflict (library_id, path) do update set
           mtime_ms=excluded.mtime_ms,
           birthtime_ms=excluded.birthtime_ms,
           size_bytes=excluded.size_bytes,
           ext=excluded.ext,
           title=excluded.title,
           artist=excluded.artist,
           album=excluded.album,
           genre=excluded.genre,
           country=excluded.country,
           language=excluded.language,
           year=excluded.year,
           duration_ms=excluded.duration_ms,
           last_seen_job_id=excluded.last_seen_job_id,
           art_path=excluded.art_path,
           art_mime=excluded.art_mime,
           art_hash=excluded.art_hash,
           lyrics_path=excluded.lyrics_path,
           created_at=excluded.created_at,
           updated_at=now()
         returning id`, [
                libraryId,
                trackPath,
                params.mtimeMs,
                Math.round(params.birthtimeMs),
                params.sizeBytes,
                ext,
                title,
                artist,
                album,
                genre,
                country,
                language,
                year,
                params.durationMs ?? null,
                params.jobId,
                artPath,
                artMime,
                artHash,
                lyricsPath
            ]);
            const trackId = trackRes.rows[0].id;
            const sanitize = cleanStr;
            // Delete existing relations (faster than checking existence)
            await client.query('delete from track_artists where track_id = $1', [trackId]);
            await client.query('delete from track_genres where track_id = $1', [trackId]);
            await client.query('delete from track_countries where track_id = $1', [trackId]);
            await client.query('delete from track_languages where track_id = $1', [trackId]);
            // Batch insert artists
            const artistsToInsert = [];
            if (params.albumArtists?.length) {
                let i = 0;
                for (const name of params.albumArtists) {
                    if (name)
                        artistsToInsert.push({ name: sanitize(name), role: 'albumartist', position: i++ });
                }
            }
            else if (albumartist) {
                let i = 0;
                for (const name of albumartist.split(/\s*;\s*/).map(a => a.trim()).filter(Boolean)) {
                    artistsToInsert.push({ name: sanitize(name), role: 'albumartist', position: i++ });
                }
            }
            if (params.artists?.length) {
                let i = 0;
                for (const name of params.artists) {
                    if (name)
                        artistsToInsert.push({ name: sanitize(name), role: 'artist', position: i++ });
                }
            }
            else if (artist) {
                let i = 0;
                for (const name of artist.split(/\s*;\s*/).map(a => a.trim()).filter(Boolean)) {
                    artistsToInsert.push({ name: sanitize(name), role: 'artist', position: i++ });
                }
            }
            // Batch insert artists - first insert all artist names at once
            if (artistsToInsert.length > 0) {
                const uniqueNames = [...new Set(artistsToInsert.map(a => a.name))];
                // Batch upsert all artists and get their IDs
                const artistIdRes = await client.query(`insert into artists(name) 
           select unnest($1::text[]) 
           on conflict (name) do update set name=excluded.name 
           returning id, name`, [uniqueNames]);
                const nameToId = new Map(artistIdRes.rows.map(r => [r.name, r.id]));
                // Batch insert all track_artists relations
                const trackArtistValues = artistsToInsert.map(a => `(${trackId}, ${nameToId.get(a.name)}, '${a.role}', ${a.position})`).join(',');
                await client.query(`insert into track_artists(track_id, artist_id, role, position) values ${trackArtistValues} on conflict do nothing`);
            }
            // Batch insert genres
            if (genre) {
                const genres = genre.split(/\s*;\s*/).map(x => x.trim()).filter(Boolean);
                if (genres.length > 0) {
                    await client.query(`insert into track_genres(track_id, genre) select $1, unnest($2::text[]) on conflict do nothing`, [trackId, genres]);
                }
            }
            // Batch insert countries
            if (country) {
                const countries = country.split(/\s*;\s*/).map(x => x.trim()).filter(Boolean);
                if (countries.length > 0) {
                    await client.query(`insert into track_countries(track_id, country) select $1, unnest($2::text[]) on conflict do nothing`, [trackId, countries]);
                }
            }
            // Batch insert languages
            if (language) {
                const languages = language.split(/\s*;\s*/).map(x => x.trim()).filter(Boolean);
                if (languages.length > 0) {
                    await client.query(`insert into track_languages(track_id, language) select $1, unnest($2::text[]) on conflict do nothing`, [trackId, languages]);
                }
            }
        }
        finally {
            client.release();
        }
    });
}
export async function deleteMissingTracks(jobId) {
    const r = await db().query(`
    with to_del as (
      select id from tracks where last_seen_job_id is null or last_seen_job_id <> $1
    ),
    del_playlist_items as (
      delete from playlist_items where track_id in (select id from to_del) returning 1
    ),
    del_favorites as (
      delete from favorite_tracks where track_id in (select id from to_del) returning 1
    ),
    del_history as (
      delete from play_history where track_id in (select id from to_del) returning 1
    ),
    del_stats as (
      delete from user_track_stats where track_id in (select id from to_del) returning 1
    ),
    del_tracks as (
      delete from tracks where id in (select id from to_del) returning 1
    )
    select count(*)::int as c
    from del_tracks
    where (select count(*) from del_playlist_items) >= 0
      and (select count(*) from del_favorites) >= 0
      and (select count(*) from del_history) >= 0
      and (select count(*) from del_stats) >= 0
    `, [jobId]);
    return r.rows[0]?.c ?? 0;
}

import { db } from './db.js';

const cleanStr = (s: string) => s.replace(/\0/g, '');
const cleanOpt = (s?: string | null) => (s == null ? null : cleanStr(s));

// Retry wrapper for transient DB errors
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
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

export type ScanJob = {
  id: number;
  state: 'queued' | 'running' | 'done' | 'failed';
};

function isMissingScanJobsTable(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes('relation "scan_jobs" does not exist');
}

export async function claimNextJob() {
  try {
    const r = await db().query<ScanJob>(
      "update scan_jobs set state='running', started_at=now() where id = (select id from scan_jobs where state='queued' order by id asc limit 1 for update skip locked) returning id, state"
    );
    return r.rows[0] ?? null;
  } catch (e) {
    if (isMissingScanJobsTable(e)) return null;
    throw e;
  }
}

export async function getLibraryIdByMountPath(mountPath: string) {
  return withRetry(async () => {
    const r = await db().query<{ id: number }>('select id from libraries where mount_path=$1', [cleanStr(mountPath)]);
    if (r.rowCount) return Number(r.rows[0].id);
    const ins = await db().query<{ id: number }>('insert into libraries(mount_path) values ($1) returning id', [cleanStr(mountPath)]);
    return Number(ins.rows[0].id);
  });
}

export async function getTrackByPath(mountPath: string, trackPath: string) {
  return withRetry(async () => {
    const libraryId = await getLibraryIdByMountPath(mountPath);
    const r = await db().query<{ mtime_ms: number; size_bytes: number; ext: string }>(
      'select mtime_ms, size_bytes, ext from tracks where library_id=$1 and path=$2',
      [libraryId, cleanStr(trackPath)]
    );
    return r.rows[0] ?? null;
  });
}

export async function markSeen(jobId: number, mountPath: string, trackPath: string, lyricsPath: string | null) {
  const libraryId = await getLibraryIdByMountPath(mountPath);
  await db().query('update tracks set last_seen_job_id=$1, lyrics_path=$2, updated_at=now() where library_id=$3 and path=$4', [
    jobId,
    cleanOpt(lyricsPath),
    libraryId,
    cleanStr(trackPath)
  ]);
}

export async function enqueueScan(requestedBy: string | null) {
  const r = await db().query<{ id: number }>(
    "insert into scan_jobs(state, requested_by) values ('queued', $1) returning id",
    [requestedBy]
  );
  return r.rows[0].id;
}

export async function finishJob(id: number, state: 'done' | 'failed', stats: unknown, error: string | null) {
  await db().query('update scan_jobs set state=$2, finished_at=now(), stats=$3, error=$4 where id=$1', [
    id,
    state,
    stats ?? null,
    error ? cleanStr(error) : null
  ]);
}

export async function upsertTrack(params: {
  jobId: number;
  mountPath: string;
  path: string;
  mtimeMs: number;
  sizeBytes: number;
  ext: string;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  albumartist?: string | null;
  genre?: string | null;
  country?: string | null;
  language?: string | null;
  year?: number | null;
  durationMs?: number | null;
  artPath?: string | null;
  artMime?: string | null;
  artHash?: string | null;
  lyricsPath?: string | null;
  artists?: string[];
  albumArtists?: string[];
}) {
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
      const trackRes = await client.query<{ id: number }>(
        refreshMeta
          ? `insert into tracks(library_id, path, mtime_ms, size_bytes, ext, title, artist, album, genre, country, language, year, duration_ms, last_seen_job_id, art_path, art_mime, art_hash, lyrics_path)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         on conflict (library_id, path) do update set
           mtime_ms=excluded.mtime_ms,
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
           updated_at=now()
         returning id`
          : `insert into tracks(library_id, path, mtime_ms, size_bytes, ext, title, artist, album, genre, country, language, year, duration_ms, last_seen_job_id, art_path, art_mime, art_hash, lyrics_path)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         on conflict (library_id, path) do update set
           mtime_ms=excluded.mtime_ms,
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
           updated_at=now()
         returning id`,
        [
          libraryId,
          trackPath,
          params.mtimeMs,
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
        ]
      );

      const trackId = trackRes.rows[0].id;
      const sanitize = cleanStr;

      // Delete existing relations (faster than checking existence)
      await client.query('delete from track_artists where track_id = $1', [trackId]);
      await client.query('delete from track_genres where track_id = $1', [trackId]);
      await client.query('delete from track_countries where track_id = $1', [trackId]);
      await client.query('delete from track_languages where track_id = $1', [trackId]);

      // Batch insert artists
      const artistsToInsert: { name: string; role: string }[] = [];
      
      if (params.albumArtists?.length) {
        for (const name of params.albumArtists) {
          if (name) artistsToInsert.push({ name: sanitize(name), role: 'albumartist' });
        }
      } else if (albumartist) {
        for (const name of albumartist.split(/\s*;\s*/).map(a => a.trim()).filter(Boolean)) {
          artistsToInsert.push({ name: sanitize(name), role: 'albumartist' });
        }
      }
      
      if (params.artists?.length) {
        for (const name of params.artists) {
          if (name) artistsToInsert.push({ name: sanitize(name), role: 'artist' });
        }
      } else if (artist) {
        for (const name of artist.split(/\s*;\s*/).map(a => a.trim()).filter(Boolean)) {
          artistsToInsert.push({ name: sanitize(name), role: 'artist' });
        }
      }

      for (const { name, role } of artistsToInsert) {
        const artistRes = await client.query<{ id: number }>(
          'insert into artists(name) values ($1) on conflict (name) do update set name=excluded.name returning id',
          [name]
        );
        await client.query(
          'insert into track_artists(track_id, artist_id, role) values ($1, $2, $3) on conflict do nothing',
          [trackId, artistRes.rows[0].id, role]
        );
      }

      // Insert genres
      if (genre) {
        for (const g of genre.split(/\s*;\s*/).map(x => x.trim()).filter(Boolean)) {
          await client.query('insert into track_genres(track_id, genre) values ($1, $2) on conflict do nothing', [trackId, g]);
        }
      }

      // Insert countries
      if (country) {
        for (const c of country.split(/\s*;\s*/).map(x => x.trim()).filter(Boolean)) {
          await client.query('insert into track_countries(track_id, country) values ($1, $2) on conflict do nothing', [trackId, c]);
        }
      }

      // Insert languages
      if (language) {
        for (const l of language.split(/\s*;\s*/).map(x => x.trim()).filter(Boolean)) {
          await client.query('insert into track_languages(track_id, language) values ($1, $2) on conflict do nothing', [trackId, l]);
        }
      }
    } finally {
      client.release();
    }
  });
}

export async function deleteMissingTracks(jobId: number) {
  const r = await db().query<{ c: number }>(
    `
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
    `,
    [jobId]
  );
  return r.rows[0]?.c ?? 0;
}

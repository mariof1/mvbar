import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { db } from './db.js';
import { allowedLibrariesForUser } from './access.js';

// Valid sort modes
const SORT_MODES = new Set([
  'random',
  'most_played',
  'least_played',
  'recently_played',
  'newest_added',
  'oldest_added',
  'title_asc',
  'title_desc',
  'artist_asc',
  'album_asc',
]);

function coerceIntList(values: any): number[] {
  if (!values) return [];
  if (!Array.isArray(values)) values = [values];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const v of values) {
    try {
      const n = parseInt(String(v), 10);
      if (!isNaN(n) && !seen.has(n)) {
        seen.add(n);
        out.push(n);
      }
    } catch {}
  }
  return out;
}

function coerceStrList(values: any): string[] {
  if (!values) return [];
  if (!Array.isArray(values)) values = [values];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    const s = String(v || '').trim();
    if (s && !seen.has(s.toLowerCase())) {
      seen.add(s.toLowerCase());
      out.push(s);
    }
  }
  return out;
}

interface SmartFilters {
  include: {
    artists: number[];
    artistsMode: 'any' | 'all';
    albums: string[];
    genres: string[];
    genresMode: 'any' | 'all';
    years: number[];
    countries: string[];
  };
  exclude: {
    artists: number[];
    albums: string[];
    genres: string[];
    years: number[];
    countries: string[];
  };
  duration: {
    min: number | null;
    max: number | null;
  };
  favoriteOnly: boolean;
  maxResults: number | null;
}

function normalizeFilters(raw: any): SmartFilters {
  raw = raw || {};
  const inc = raw.include && typeof raw.include === 'object' ? raw.include : {};
  const exc = raw.exclude && typeof raw.exclude === 'object' ? raw.exclude : {};
  const dur = raw.duration && typeof raw.duration === 'object' ? raw.duration : {};

  let artistsMode = String(inc.artistsMode || inc.artists_mode || '').toLowerCase();
  let genresMode = String(inc.genresMode || inc.genres_mode || '').toLowerCase();
  if (artistsMode !== 'any' && artistsMode !== 'all') artistsMode = 'any';
  if (genresMode !== 'any' && genresMode !== 'all') genresMode = 'any';

  const filters: SmartFilters = {
    include: {
      artists: coerceIntList(inc.artists),
      artistsMode: artistsMode as 'any' | 'all',
      albums: coerceStrList(inc.albums),
      genres: coerceStrList(inc.genres),
      genresMode: genresMode as 'any' | 'all',
      years: coerceIntList(inc.years),
      countries: coerceStrList(inc.countries),
    },
    exclude: {
      artists: coerceIntList(exc.artists),
      albums: coerceStrList(exc.albums),
      genres: coerceStrList(exc.genres),
      years: coerceIntList(exc.years),
      countries: coerceStrList(exc.countries),
    },
    duration: {
      min: null,
      max: null,
    },
    favoriteOnly: Boolean(raw.favoriteOnly),
    maxResults: null,
  };

  try {
    if (dur.min != null && String(dur.min).trim() !== '') {
      filters.duration.min = Math.max(0, parseInt(String(dur.min), 10));
    }
  } catch {}
  try {
    if (dur.max != null && String(dur.max).trim() !== '') {
      filters.duration.max = Math.max(0, parseInt(String(dur.max), 10));
    }
  } catch {}
  try {
    if (raw.maxResults != null && String(raw.maxResults).trim() !== '') {
      filters.maxResults = Math.max(1, Math.min(2000, parseInt(String(raw.maxResults), 10)));
    }
  } catch {}

  return filters;
}

async function buildSmartPlaylistQuery(
  userId: string,
  filters: SmartFilters,
  sortMode: string,
  allowed: number[] | null
): Promise<{ sql: string; params: any[] }> {
  const conditions: string[] = [];
  const params: any[] = [];
  let paramIdx = 1;

  // Library access
  if (allowed !== null) {
    params.push(allowed);
    conditions.push(`t.library_id = any($${paramIdx++})`);
  }

  // Include albums (by album name)
  if (filters.include.albums.length > 0) {
    params.push(filters.include.albums);
    conditions.push(`t.album = any($${paramIdx++})`);
  }

  // Exclude albums (by album name)
  if (filters.exclude.albums.length > 0) {
    params.push(filters.exclude.albums);
    conditions.push(`(t.album is null or t.album != all($${paramIdx++}))`);
  }

  // Include artists (by artist_id via track_artists)
  if (filters.include.artists.length > 0) {
    params.push(filters.include.artists);
    if (filters.include.artistsMode === 'all' && filters.include.artists.length > 1) {
      conditions.push(`t.id in (
        select ta.track_id from track_artists ta
        where ta.artist_id = any($${paramIdx++})
        group by ta.track_id
        having count(distinct ta.artist_id) = ${filters.include.artists.length}
      )`);
    } else {
      conditions.push(`t.id in (select ta.track_id from track_artists ta where ta.artist_id = any($${paramIdx++}))`);
    }
  }

  // Exclude artists
  if (filters.exclude.artists.length > 0) {
    params.push(filters.exclude.artists);
    conditions.push(`t.id not in (select ta.track_id from track_artists ta where ta.artist_id = any($${paramIdx++}))`);
  }

  // Include genres
  if (filters.include.genres.length > 0) {
    params.push(filters.include.genres);
    if (filters.include.genresMode === 'all' && filters.include.genres.length > 1) {
      conditions.push(`t.id in (
        select tg.track_id from track_genres tg
        where tg.genre = any($${paramIdx++})
        group by tg.track_id
        having count(distinct tg.genre) = ${filters.include.genres.length}
      )`);
    } else {
      conditions.push(`t.id in (select tg.track_id from track_genres tg where tg.genre = any($${paramIdx++}))`);
    }
  }

  // Exclude genres
  if (filters.exclude.genres.length > 0) {
    params.push(filters.exclude.genres);
    conditions.push(`t.id not in (select tg.track_id from track_genres tg where tg.genre = any($${paramIdx++}))`);
  }

  // Include years
  if (filters.include.years.length > 0) {
    params.push(filters.include.years);
    conditions.push(`t.year = any($${paramIdx++})`);
  }

  // Exclude years
  if (filters.exclude.years.length > 0) {
    params.push(filters.exclude.years);
    conditions.push(`t.year != all($${paramIdx++})`);
  }

  // Include countries (using normalized track_countries table)
  if (filters.include.countries.length > 0) {
    params.push(filters.include.countries);
    conditions.push(`t.id in (select tc.track_id from track_countries tc where tc.country = any($${paramIdx++}))`);
  }

  // Exclude countries (using normalized track_countries table)
  if (filters.exclude.countries.length > 0) {
    params.push(filters.exclude.countries);
    conditions.push(`t.id not in (select tc.track_id from track_countries tc where tc.country = any($${paramIdx++}))`);
  }

  // Duration filters (in seconds, track has duration_ms)
  if (filters.duration.min != null) {
    params.push(filters.duration.min * 1000);
    conditions.push(`coalesce(t.duration_ms, 0) >= $${paramIdx++}`);
  }
  if (filters.duration.max != null) {
    params.push(filters.duration.max * 1000);
    conditions.push(`coalesce(t.duration_ms, 0) <= $${paramIdx++}`);
  }

  // Favorite only
  if (filters.favoriteOnly) {
    params.push(userId);
    conditions.push(`t.id in (select ft.track_id from favorite_tracks ft where ft.user_id = $${paramIdx++})`);
  }

  const whereClause = conditions.length > 0 ? `where ${conditions.join(' and ')}` : '';

  // Sorting
  let orderBy = 'order by random()';
  
  if (sortMode === 'most_played' || sortMode === 'least_played' || sortMode === 'recently_played') {
    params.push(userId);
    const statsJoin = `left join user_track_stats uts on uts.track_id = t.id and uts.user_id = $${paramIdx++}`;
    
    if (sortMode === 'most_played') {
      orderBy = `${statsJoin} order by coalesce(uts.play_count, 0) desc, t.title`;
    } else if (sortMode === 'least_played') {
      orderBy = `${statsJoin} order by coalesce(uts.play_count, 0) asc, t.title`;
    } else {
      orderBy = `${statsJoin} order by uts.last_played_at desc nulls last, t.title`;
    }
  } else if (sortMode === 'newest_added') {
    orderBy = 'order by t.birthtime_ms desc nulls last, t.id desc';
  } else if (sortMode === 'oldest_added') {
    orderBy = 'order by t.birthtime_ms asc nulls last, t.id asc';
  } else if (sortMode === 'title_asc') {
    orderBy = 'order by t.title asc, t.artist asc';
  } else if (sortMode === 'title_desc') {
    orderBy = 'order by t.title desc, t.artist asc';
  } else if (sortMode === 'artist_asc') {
    orderBy = 'order by t.artist asc, t.album asc, t.title asc';
  } else if (sortMode === 'album_asc') {
    orderBy = 'order by t.album asc, t.artist asc, t.title asc';
  }

  // Build the full query
  let sql: string;
  if (orderBy.includes('left join')) {
    // Stats-based sorting needs different structure
    const parts = orderBy.split(' order by ');
    sql = `select t.id, t.title, t.artist, t.album, t.duration_ms, t.art_path, t.art_hash
           from active_tracks t ${parts[0]}
           ${whereClause}
           order by ${parts[1]}`;
  } else {
    sql = `select t.id, t.title, t.artist, t.album, t.duration_ms, t.art_path, t.art_hash
           from active_tracks t
           ${whereClause}
           ${orderBy}`;
  }

  return { sql, params };
}

export const smartPlaylistsPlugin: FastifyPluginAsync = fp(async (app) => {
  // List smart playlists
  app.get('/api/smart-playlists', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });

    const r = await db().query(
      `select id, name, filters_json, sort_mode, created_at, updated_at
       from smart_playlists
       where user_id = $1
       order by updated_at desc nulls last, created_at desc`,
      [req.user.userId]
    );

    return {
      ok: true,
      items: r.rows.map((row: any) => ({
        id: Number(row.id),
        name: row.name,
        sort: row.sort_mode || 'random',
        filters: row.filters_json || {},
        created: row.created_at,
        updated: row.updated_at,
        type: 'smart',
      })),
    };
  });

  // Create smart playlist
  app.post('/api/smart-playlists', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });

    const body = req.body as any;
    let name = String(body?.name || '').trim();
    if (!name) return reply.code(400).send({ ok: false, error: 'Name is required' });
    if (name.length > 255) name = name.slice(0, 255);

    let sortMode = String(body?.sort || 'random').toLowerCase();
    if (!SORT_MODES.has(sortMode)) sortMode = 'random';

    const filters = normalizeFilters(body?.filters);

    const r = await db().query(
      `insert into smart_playlists (user_id, name, filters_json, sort_mode)
       values ($1, $2, $3, $4)
       returning id, name, filters_json, sort_mode, created_at, updated_at`,
      [req.user.userId, name, JSON.stringify(filters), sortMode]
    );

    const row = r.rows[0];
    return {
      ok: true,
      id: Number(row.id),
      name: row.name,
      sort: row.sort_mode,
      filters: row.filters_json,
      created: row.created_at,
      updated: row.updated_at,
      type: 'smart',
    };
  });

  // Get smart playlist with tracks
  app.get('/api/smart-playlists/:id', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });

    const id = parseInt((req.params as any).id, 10);
    if (isNaN(id)) return reply.code(400).send({ ok: false, error: 'Invalid ID' });

    const r = await db().query(
      `select id, name, filters_json, sort_mode, created_at, updated_at
       from smart_playlists
       where id = $1 and user_id = $2`,
      [id, req.user.userId]
    );

    if (r.rows.length === 0) return reply.code(404).send({ ok: false, error: 'Not found' });

    const row = r.rows[0];
    const filters = normalizeFilters(row.filters_json);
    let sortMode = String((req.query as any).sort || row.sort_mode || 'random').toLowerCase();
    if (!SORT_MODES.has(sortMode)) sortMode = 'random';

    let limit = parseInt((req.query as any).limit, 10) || 500;
    if (filters.maxResults) limit = Math.min(limit, filters.maxResults);
    limit = Math.max(1, Math.min(2000, limit));

    const allowed = await allowedLibrariesForUser(req.user.userId, req.user.role);
    const { sql, params } = await buildSmartPlaylistQuery(req.user.userId, filters, sortMode, allowed);

    const tracksR = await db().query(`${sql} limit $${params.length + 1}`, [...params, limit + 1]);
    const truncated = tracksR.rows.length > limit;
    const tracks = tracksR.rows.slice(0, limit);

    const totalDuration = tracks.reduce((sum: number, t: any) => sum + (t.duration_ms || 0), 0);

    return {
      ok: true,
      id: Number(row.id),
      name: row.name,
      sort: sortMode,
      filters: row.filters_json,
      created: row.created_at,
      updated: row.updated_at,
      type: 'smart',
      trackCount: tracks.length,
      duration: Math.round(totalDuration / 1000),
      truncated,
      tracks: tracks.map((t: any) => ({
        id: Number(t.id),
        title: t.title,
        artist: t.artist,
        album: t.album,
        duration: t.duration_ms ? Math.round(t.duration_ms / 1000) : null,
        art_path: t.art_path,
        art_hash: t.art_hash,
      })),
    };
  });

  // Update smart playlist
  app.put('/api/smart-playlists/:id', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });

    const id = parseInt((req.params as any).id, 10);
    if (isNaN(id)) return reply.code(400).send({ ok: false, error: 'Invalid ID' });

    // Check ownership
    const check = await db().query(
      'select id from smart_playlists where id = $1 and user_id = $2',
      [id, req.user.userId]
    );
    if (check.rows.length === 0) return reply.code(404).send({ ok: false, error: 'Not found' });

    const body = req.body as any;
    let name = String(body?.name || '').trim();
    if (!name) return reply.code(400).send({ ok: false, error: 'Name is required' });
    if (name.length > 255) name = name.slice(0, 255);

    let sortMode = String(body?.sort || 'random').toLowerCase();
    if (!SORT_MODES.has(sortMode)) sortMode = 'random';

    const filters = normalizeFilters(body?.filters);

    const r = await db().query(
      `update smart_playlists
       set name = $1, filters_json = $2, sort_mode = $3, updated_at = now()
       where id = $4 and user_id = $5
       returning id, name, filters_json, sort_mode, created_at, updated_at`,
      [name, JSON.stringify(filters), sortMode, id, req.user.userId]
    );

    const row = r.rows[0];
    return {
      ok: true,
      id: Number(row.id),
      name: row.name,
      sort: row.sort_mode,
      filters: row.filters_json,
      created: row.created_at,
      updated: row.updated_at,
      type: 'smart',
    };
  });

  // Delete smart playlist
  app.delete('/api/smart-playlists/:id', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });

    const id = parseInt((req.params as any).id, 10);
    if (isNaN(id)) return reply.code(400).send({ ok: false, error: 'Invalid ID' });

    const r = await db().query(
      'delete from smart_playlists where id = $1 and user_id = $2 returning id',
      [id, req.user.userId]
    );

    if (r.rows.length === 0) return reply.code(404).send({ ok: false, error: 'Not found' });

    return { ok: true, deleted: id };
  });

  // Suggest endpoint for autocomplete
  app.get('/api/smart-playlists/suggest', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });

    const kind = String((req.query as any).kind || '').toLowerCase();
    const q = String((req.query as any).q || '').trim();
    const idsRaw = String((req.query as any).ids || '').trim();
    const limit = Math.max(1, Math.min(50, parseInt((req.query as any).limit, 10) || 20));

    // Resolve IDs to names
    if (idsRaw) {
      const ids = idsRaw.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
      if (ids.length > 0) {
        if (kind === 'artist' || kind === 'artists') {
          const r = await db().query('select id, name from artists where id = any($1)', [ids]);
          const byId = new Map(r.rows.map((row: any) => [Number(row.id), row.name]));
          return { items: ids.filter((id) => byId.has(id)).map((id) => ({ id, name: byId.get(id) })) };
        }
      }
    }

    if (kind === 'artist' || kind === 'artists') {
      const r = await db().query(
        `select id, name from artists where name ilike $1 order by name limit $2`,
        [`%${q}%`, limit]
      );
      return { items: r.rows.map((row: any) => ({ id: Number(row.id), name: row.name })) };
    }

    if (kind === 'album' || kind === 'albums') {
      const r = await db().query(
        `select distinct album from active_tracks where album is not null and album != '' and album ilike $1 order by album limit $2`,
        [`%${q}%`, limit]
      );
      return { items: r.rows.map((row: any) => row.album).filter(Boolean) };
    }

    if (kind === 'genre' || kind === 'genres') {
      const r = await db().query(
        `select distinct genre from track_genres where genre ilike $1 order by genre limit $2`,
        [`%${q}%`, limit]
      );
      return { items: r.rows.map((row: any) => row.genre).filter(Boolean) };
    }

    if (kind === 'country' || kind === 'countries') {
      const r = await db().query(
        `select distinct country from track_countries where country ilike $1 order by country limit $2`,
        [`%${q}%`, limit]
      );
      return { items: r.rows.map((row: any) => row.country).filter(Boolean) };
    }

    if (kind === 'language' || kind === 'languages') {
      const r = await db().query(
        `select distinct language from track_languages where language ilike $1 order by language limit $2`,
        [`%${q}%`, limit]
      );
      return { items: r.rows.map((row: any) => row.language).filter(Boolean) };
    }

    if (kind === 'year' || kind === 'years') {
      // If query is provided, filter years that start with it
      const r = await db().query(
        q
          ? `select distinct year from active_tracks where year is not null and cast(year as text) like $1 order by year desc limit $2`
          : `select distinct year from active_tracks where year is not null order by year desc limit $1`,
        q ? [`${q}%`, limit] : [limit]
      );
      return { items: r.rows.map((row: any) => row.year).filter(Boolean) };
    }

    return { items: [] };
  });
});

import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { db } from './db.js';
import { allowedLibrariesForUser } from './access.js';

export const browsePlugin: FastifyPluginAsync = fp(async (app) => {
  // Paginated artists list with ID for routing
  app.get('/api/browse/artists', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const qs = req.query as { limit?: string; offset?: string; sort?: string; q?: string };
    const limit = Math.min(200, Math.max(1, Number(qs.limit ?? 50)));
    const offset = Math.max(0, Number(qs.offset ?? 0));
    const sort = qs.sort ?? 'az';
    const filter = qs.q?.trim().toLowerCase() || '';

    const orderBy =
      sort === 'tracks_desc'
        ? 'track_count desc, a.name asc'
        : sort === 'albums_desc'
          ? 'album_count desc, a.name asc'
          : 'a.name asc';

    const allowed = await allowedLibrariesForUser(req.user.userId, req.user.role);
    const libFilter = allowed === null ? '' : `and t.library_id = any($${filter ? 4 : 3})`;
    const nameFilter = filter ? `and lower(a.name) like $3` : '';
    const params = filter
      ? (allowed === null ? [limit, offset, `%${filter}%`] : [limit, offset, `%${filter}%`, allowed])
      : (allowed === null ? [limit, offset] : [limit, offset, allowed]);

    const r = await db().query(
      `
      select
        a.id::int,
        a.name,
        a.art_path,
        a.art_hash,
        count(distinct t.id)::int as track_count,
        count(distinct nullif(t.album, ''))::int as album_count
      from artists a
      join track_artists ta on ta.artist_id = a.id
      join active_tracks t on t.id = ta.track_id
      where a.name is not null and a.name <> ''
      ${nameFilter}
      ${libFilter}
      group by a.id, a.name, a.art_path, a.art_hash
      order by ${orderBy}
      limit $1 offset $2
    `,
      params as any
    );

    // Get total count for infinite scroll
    const countParams = filter
      ? (allowed === null ? [`%${filter}%`] : [`%${filter}%`, allowed])
      : (allowed === null ? [] : [allowed]);
    const countNameFilter = filter ? `and lower(a.name) like $1` : '';
    const countLibFilter = allowed === null ? '' : `and t.library_id = any($${filter ? 2 : 1})`;

    const countR = await db().query(
      `
      select count(distinct a.id)::int as total
      from artists a
      join track_artists ta on ta.artist_id = a.id
      join active_tracks t on t.id = ta.track_id
      where a.name is not null and a.name <> ''
      ${countNameFilter}
      ${countLibFilter}
    `,
      countParams
    );

    return { 
      ok: true, 
      artists: r.rows, 
      total: countR.rows[0]?.total ?? 0,
      limit, 
      offset 
    };
  });

  // Paginated albums list with artwork
  app.get('/api/browse/albums', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const qs = req.query as { limit?: string; offset?: string; sort?: string; artistId?: string; q?: string };
    const limit = Math.min(200, Math.max(1, Number(qs.limit ?? 50)));
    const offset = Math.max(0, Number(qs.offset ?? 0));
    const sort = qs.sort ?? 'az';
    const artistId = qs.artistId ? Number(qs.artistId) : null;
    const filter = qs.q?.trim().toLowerCase() || '';

    const allowed = await allowedLibrariesForUser(req.user.userId, req.user.role);

    // Build dynamic params array
    const params: any[] = [limit, offset];
    let paramIdx = 3;

    let artistFilter = '';
    if (artistId) {
      artistFilter = `and exists (select 1 from track_artists ta2 where ta2.track_id = t.id and ta2.artist_id = $${paramIdx})`;
      params.push(artistId);
      paramIdx++;
    }

    let nameFilter = '';
    if (filter) {
      nameFilter = `and (lower(t.album) like $${paramIdx} or lower(coalesce(t.album_artist, t.artist)) like $${paramIdx})`;
      params.push(`%${filter}%`);
      paramIdx++;
    }

    let libFilter = '';
    if (allowed !== null) {
      libFilter = `and t.library_id = any($${paramIdx})`;
      params.push(allowed);
      paramIdx++;
    }
    
    const orderBy = sort === 'tracks_desc' 
      ? 'track_count desc, display_artist asc, album asc' 
      : sort === 'recent'
        ? 'max_updated desc, display_artist asc'
        : sort === 'created'
          ? 'min_created desc, display_artist asc'
          : 'display_artist asc, album asc';

    // Use CTE to get unique albums, then get first album artist from track_artists table
    const r = await db().query(
      `
      with unique_albums as (
        select distinct on (t.album)
          t.album,
          t.id as first_track_id,
          t.art_path,
          t.art_hash,
          t.updated_at,
          t.mtime_ms
        from active_tracks t
        where t.album is not null and t.album <> ''
        ${artistFilter}
        ${nameFilter}
        ${libFilter}
        order by t.album, t.path
      ),
      album_counts as (
        select t.album, count(*)::int as track_count, max(t.updated_at) as max_updated, min(t.created_at) as min_created
        from active_tracks t
        where t.album is not null and t.album <> ''
        ${artistFilter}
        ${nameFilter}
        ${libFilter}
        group by t.album
      )
      select
        ua.album,
        coalesce(
          (select a.name from track_artists ta join artists a on a.id = ta.artist_id 
           where ta.track_id = ua.first_track_id and ta.role = 'albumartist' 
           order by a.name limit 1),
          (select a.name from track_artists ta join artists a on a.id = ta.artist_id 
           where ta.track_id = ua.first_track_id and ta.role = 'artist' 
           order by a.name limit 1)
        ) as display_artist,
        ac.track_count,
        ua.art_path,
        ua.art_hash,
        ac.max_updated,
        ac.min_created
      from unique_albums ua
      join album_counts ac on ac.album = ua.album
      order by ${orderBy}
      limit $1 offset $2
    `,
      params
    );

    // Get total count (unique albums)
    const countParams: any[] = [];
    let countParamIdx = 1;

    let countArtistFilter = '';
    if (artistId) {
      countArtistFilter = `and exists (select 1 from track_artists ta2 where ta2.track_id = t.id and ta2.artist_id = $${countParamIdx})`;
      countParams.push(artistId);
      countParamIdx++;
    }

    let countNameFilter = '';
    if (filter) {
      countNameFilter = `and (lower(t.album) like $${countParamIdx} or lower(coalesce(t.album_artist, t.artist)) like $${countParamIdx})`;
      countParams.push(`%${filter}%`);
      countParamIdx++;
    }

    let countLibFilter = '';
    if (allowed !== null) {
      countLibFilter = `and t.library_id = any($${countParamIdx})`;
      countParams.push(allowed);
    }

    const countR = await db().query(
      `
      select count(distinct t.album)::int as total
      from active_tracks t
      where t.album is not null and t.album <> ''
      ${countArtistFilter}
      ${countNameFilter}
      ${countLibFilter}
    `,
      countParams
    );

    return { 
      ok: true, 
      albums: r.rows,
      total: countR.rows[0]?.total ?? 0,
      limit, 
      offset 
    };
  });

  // Paginated genres list
  app.get('/api/browse/genres', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const qs = req.query as { limit?: string; offset?: string; sort?: string; q?: string };
    const limit = Math.min(200, Math.max(1, Number(qs.limit ?? 50)));
    const offset = Math.max(0, Number(qs.offset ?? 0));
    const sort = qs.sort ?? 'az';
    const filter = qs.q?.trim().toLowerCase() || '';

    const allowed = await allowedLibrariesForUser(req.user.userId, req.user.role);

    // Build dynamic params
    const params: any[] = [limit, offset];
    let paramIdx = 3;

    let nameFilter = '';
    if (filter) {
      nameFilter = `and lower(trim(g)) like $${paramIdx}`;
      params.push(`%${filter}%`);
      paramIdx++;
    }

    let libFilter = '';
    if (allowed !== null) {
      libFilter = `and t.library_id = any($${paramIdx})`;
      params.push(allowed);
    }

    const orderBy = sort === 'tracks_desc' 
      ? 'track_count desc, genre asc' 
      : 'genre asc';

    // Split genre column by semicolon and count
    const r = await db().query(
      `
      select 
        trim(g) as genre,
        count(distinct t.id)::int as track_count,
        count(distinct t.artist)::int as artist_count
      from active_tracks t, unnest(string_to_array(t.genre, ';')) as g
      where t.genre is not null and trim(g) <> ''
      ${nameFilter}
      ${libFilter}
      group by trim(g)
      order by ${orderBy}
      limit $1 offset $2
    `,
      params as any
    );

    // Get total count
    const countParams: any[] = [];
    let countParamIdx = 1;

    let countNameFilter = '';
    if (filter) {
      countNameFilter = `and lower(trim(g)) like $${countParamIdx}`;
      countParams.push(`%${filter}%`);
      countParamIdx++;
    }

    let countLibFilter = '';
    if (allowed !== null) {
      countLibFilter = `and t.library_id = any($${countParamIdx})`;
      countParams.push(allowed);
    }

    const countR = await db().query(
      `
      select count(distinct trim(g))::int as total
      from active_tracks t, unnest(string_to_array(t.genre, ';')) as g
      where t.genre is not null and trim(g) <> ''
      ${countNameFilter}
      ${countLibFilter}
    `,
      countParams
    );

    return { 
      ok: true, 
      genres: r.rows,
      total: countR.rows[0]?.total ?? 0,
      limit, 
      offset 
    };
  });

  // Browse countries
  app.get('/api/browse/countries', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const qs = req.query as { limit?: string; offset?: string; sort?: string; q?: string };
    const limit = Math.min(200, Math.max(1, Number(qs.limit ?? 50)));
    const offset = Math.max(0, Number(qs.offset ?? 0));
    const sort = qs.sort ?? 'az';
    const filter = qs.q?.trim().toLowerCase() || '';

    const allowed = await allowedLibrariesForUser(req.user.userId, req.user.role);

    const params: any[] = [limit, offset];
    let paramIdx = 3;

    let nameFilter = '';
    if (filter) {
      nameFilter = `and lower(trim(c)) like $${paramIdx}`;
      params.push(`%${filter}%`);
      paramIdx++;
    }

    let libFilter = '';
    if (allowed !== null) {
      libFilter = `and t.library_id = any($${paramIdx})`;
      params.push(allowed);
    }

    const orderBy = sort === 'tracks_desc' 
      ? 'track_count desc, country asc' 
      : 'country asc';

    const r = await db().query(
      `
      select 
        trim(c) as country,
        count(distinct t.id)::int as track_count,
        count(distinct t.artist)::int as artist_count
      from active_tracks t, unnest(string_to_array(t.country, ';')) as c
      where t.country is not null and trim(c) <> ''
      ${nameFilter}
      ${libFilter}
      group by trim(c)
      order by ${orderBy}
      limit $1 offset $2
    `,
      params as any
    );

    const countParams: any[] = [];
    let countParamIdx = 1;

    let countNameFilter = '';
    if (filter) {
      countNameFilter = `and lower(trim(c)) like $${countParamIdx}`;
      countParams.push(`%${filter}%`);
      countParamIdx++;
    }

    let countLibFilter = '';
    if (allowed !== null) {
      countLibFilter = `and t.library_id = any($${countParamIdx})`;
      countParams.push(allowed);
    }

    const countR = await db().query(
      `
      select count(distinct trim(c))::int as total
      from active_tracks t, unnest(string_to_array(t.country, ';')) as c
      where t.country is not null and trim(c) <> ''
      ${countNameFilter}
      ${countLibFilter}
    `,
      countParams
    );

    return { 
      ok: true, 
      countries: r.rows,
      total: countR.rows[0]?.total ?? 0,
      limit, 
      offset 
    };
  });

  // Browse languages
  app.get('/api/browse/languages', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const qs = req.query as { limit?: string; offset?: string; sort?: string; q?: string };
    const limit = Math.min(200, Math.max(1, Number(qs.limit ?? 50)));
    const offset = Math.max(0, Number(qs.offset ?? 0));
    const sort = qs.sort ?? 'az';
    const filter = qs.q?.trim().toLowerCase() || '';

    const allowed = await allowedLibrariesForUser(req.user.userId, req.user.role);

    const params: any[] = [limit, offset];
    let paramIdx = 3;

    let nameFilter = '';
    if (filter) {
      nameFilter = `and lower(trim(l)) like $${paramIdx}`;
      params.push(`%${filter}%`);
      paramIdx++;
    }

    let libFilter = '';
    if (allowed !== null) {
      libFilter = `and t.library_id = any($${paramIdx})`;
      params.push(allowed);
    }

    const orderBy = sort === 'tracks_desc' 
      ? 'track_count desc, language asc' 
      : 'language asc';

    const r = await db().query(
      `
      select 
        trim(l) as language,
        count(distinct t.id)::int as track_count,
        count(distinct t.artist)::int as artist_count
      from active_tracks t, unnest(string_to_array(t.language, ';')) as l
      where t.language is not null and trim(l) <> ''
      ${nameFilter}
      ${libFilter}
      group by trim(l)
      order by ${orderBy}
      limit $1 offset $2
    `,
      params as any
    );

    const countParams: any[] = [];
    let countParamIdx = 1;

    let countNameFilter = '';
    if (filter) {
      countNameFilter = `and lower(trim(l)) like $${countParamIdx}`;
      countParams.push(`%${filter}%`);
      countParamIdx++;
    }

    let countLibFilter = '';
    if (allowed !== null) {
      countLibFilter = `and t.library_id = any($${countParamIdx})`;
      countParams.push(allowed);
    }

    const countR = await db().query(
      `
      select count(distinct trim(l))::int as total
      from active_tracks t, unnest(string_to_array(t.language, ';')) as l
      where t.language is not null and trim(l) <> ''
      ${countNameFilter}
      ${countLibFilter}
    `,
      countParams
    );

    return { 
      ok: true, 
      languages: r.rows,
      total: countR.rows[0]?.total ?? 0,
      limit, 
      offset 
    };
  });

  // Tracks by country
  app.get('/api/browse/country/:name/tracks', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const { name } = req.params as { name: string };
    const qs = req.query as { limit?: string; offset?: string };
    const limit = Math.min(200, Math.max(1, Number(qs.limit ?? 50)));
    const offset = Math.max(0, Number(qs.offset ?? 0));

    const allowed = await allowedLibrariesForUser(req.user.userId, req.user.role);
    const libFilter = allowed === null ? '' : `and t.library_id = any($4)`;
    const params = allowed === null ? [name, limit, offset] : [name, limit, offset, allowed];

    const r = await db().query(
      `
      select t.id, t.title, t.artist, t.album_artist, t.album, t.duration_ms, t.art_path, t.art_hash
      from active_tracks t
      where t.country ilike '%' || $1 || '%'
      ${libFilter}
      order by t.artist, t.album, t.title
      limit $2 offset $3
    `,
      params as any
    );

    const trackIds = r.rows.map((t: any) => t.id);
    const artistsMap = await getTrackArtists(trackIds);
    const tracks = r.rows.map((t: any) => ({
      ...t,
      artists: artistsMap.get(Number(t.id)) ?? []
    }));

    return { ok: true, country: name, tracks, limit, offset };
  });

  // Tracks by language
  app.get('/api/browse/language/:name/tracks', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const { name } = req.params as { name: string };
    const qs = req.query as { limit?: string; offset?: string };
    const limit = Math.min(200, Math.max(1, Number(qs.limit ?? 50)));
    const offset = Math.max(0, Number(qs.offset ?? 0));

    const allowed = await allowedLibrariesForUser(req.user.userId, req.user.role);
    const libFilter = allowed === null ? '' : `and t.library_id = any($4)`;
    const params = allowed === null ? [name, limit, offset] : [name, limit, offset, allowed];

    const r = await db().query(
      `
      select t.id, t.title, t.artist, t.album_artist, t.album, t.duration_ms, t.art_path, t.art_hash
      from active_tracks t
      where t.language ilike '%' || $1 || '%'
      ${libFilter}
      order by t.artist, t.album, t.title
      limit $2 offset $3
    `,
      params as any
    );

    const trackIds = r.rows.map((t: any) => t.id);
    const artistsMap = await getTrackArtists(trackIds);
    const tracks = r.rows.map((t: any) => ({
      ...t,
      artists: artistsMap.get(Number(t.id)) ?? []
    }));

    return { ok: true, language: name, tracks, limit, offset };
  });

  // Tracks by genre
  app.get('/api/browse/genre/:name/tracks', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const { name } = req.params as { name: string };
    const qs = req.query as { limit?: string; offset?: string };
    const limit = Math.min(200, Math.max(1, Number(qs.limit ?? 50)));
    const offset = Math.max(0, Number(qs.offset ?? 0));

    const allowed = await allowedLibrariesForUser(req.user.userId, req.user.role);
    const libFilter = allowed === null ? '' : `and t.library_id = any($4)`;
    const params = allowed === null ? [name, limit, offset] : [name, limit, offset, allowed];

    const r = await db().query(
      `
      select t.id, t.title, t.artist, t.album_artist, t.album, t.duration_ms, t.art_path, t.art_hash
      from active_tracks t
      where t.genre ilike '%' || $1 || '%'
      ${libFilter}
      order by t.artist, t.album, t.title
      limit $2 offset $3
    `,
      params as any
    );

    // Fetch all artists for each track
    const trackIds = r.rows.map((t: any) => t.id);
    const artistsMap = await getTrackArtists(trackIds);
    const tracks = r.rows.map((t: any) => ({
      ...t,
      artists: artistsMap.get(Number(t.id)) ?? []
    }));

    return { ok: true, genre: name, tracks, limit, offset };
  });

  // Artist detail page - albums only
  app.get('/api/browse/artist/:id', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const { id } = req.params as { id: string };
    const artistId = Number(id);
    if (!artistId) return reply.code(400).send({ ok: false });

    const allowed = await allowedLibrariesForUser(req.user.userId, req.user.role);
    const libFilter = allowed === null ? '' : `and t.library_id = any($2)`;
    const params = allowed === null ? [artistId] : [artistId, allowed];

    // Get artist name and art
    const artistR = await db().query<{ name: string; art_path: string | null; art_hash: string | null }>(
      'select name, art_path, art_hash from artists where id = $1',
      [artistId]
    );
    if (!artistR.rows[0]) return reply.code(404).send({ ok: false, error: 'Artist not found' });
    const artist = artistR.rows[0];

    // Get albums where this artist is album artist - group by album only
    // First get first track per album, then look up album artist name
    const albumsR = await db().query(
      `
      with album_tracks as (
        select distinct on (t.album)
          t.album,
          t.id as first_track_id,
          t.art_path,
          t.art_hash
        from track_artists ta
        join active_tracks t on t.id = ta.track_id
        where ta.artist_id = $1
          and ta.role = 'albumartist'
          and t.album is not null and t.album <> ''
          ${libFilter}
        order by t.album, t.path
      ),
      album_counts as (
        select t.album, count(*)::int as track_count
        from track_artists ta
        join active_tracks t on t.id = ta.track_id
        where ta.artist_id = $1
          and ta.role = 'albumartist'
          and t.album is not null and t.album <> ''
          ${libFilter}
        group by t.album
      )
      select 
        at.album,
        (select a.name from track_artists ta2 join artists a on a.id = ta2.artist_id 
         where ta2.track_id = at.first_track_id and ta2.role = 'albumartist' 
         order by a.name limit 1) as display_artist,
        ac.track_count,
        at.art_path,
        at.art_hash
      from album_tracks at
      join album_counts ac on ac.album = at.album
      order by at.album
    `,
      params as any
    );

    // Get "appears on" albums (where artist but not album artist) - group by album only
    // Exclude albums where the artist is the album artist on ANY track in the album
    const appearsOnR = await db().query(
      `
      with own_albums as (
        -- Albums where this artist is album artist on at least one track
        select distinct t.album
        from track_artists ta
        join active_tracks t on t.id = ta.track_id
        where ta.artist_id = $1
          and ta.role = 'albumartist'
          and t.album is not null and t.album <> ''
          ${libFilter}
      ),
      album_tracks as (
        select distinct on (t.album)
          t.album,
          t.id as first_track_id,
          t.art_path,
          t.art_hash
        from track_artists ta
        join active_tracks t on t.id = ta.track_id
        where ta.artist_id = $1
          and ta.role = 'artist'
          and t.album is not null and t.album <> ''
          ${libFilter}
          and t.album not in (select album from own_albums)
        order by t.album, t.path
      ),
      album_counts as (
        select t.album, count(*)::int as track_count
        from track_artists ta
        join active_tracks t on t.id = ta.track_id
        where ta.artist_id = $1
          and ta.role = 'artist'
          and t.album is not null and t.album <> ''
          ${libFilter}
          and t.album not in (select album from own_albums)
        group by t.album
      )
      select 
        at.album,
        (select a.name from track_artists ta2 join artists a on a.id = ta2.artist_id 
         where ta2.track_id = at.first_track_id and ta2.role = 'albumartist' 
         order by a.name limit 1) as album_artist,
        ac.track_count,
        at.art_path,
        at.art_hash
      from album_tracks at
      join album_counts ac on ac.album = at.album
      order by at.album
    `,
      params as any
    );

    return { 
      ok: true, 
      artist: { id: artistId, name: artist.name, art_path: artist.art_path, art_hash: artist.art_hash },
      albums: albumsR.rows,
      appearsOn: appearsOnR.rows
    };
  });

  // Album detail page - tracks with all artists
  app.get('/api/browse/album', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const qs = req.query as { artist?: string; album?: string; artistId?: string };
    // Handle "null" and "undefined" strings from frontend as empty
    let artist = (qs.artist ?? '').trim();
    if (artist === 'null' || artist === 'undefined') artist = '';
    const artistId = qs.artistId && qs.artistId !== 'null' && qs.artistId !== 'undefined' 
      ? parseInt(qs.artistId, 10) : null;
    const album = (qs.album ?? '').trim();
    if (!album) return reply.code(400).send({ ok: false });

    const allowed = await allowedLibrariesForUser(req.user.userId, req.user.role);
    
    let params: any[];
    let libFilter: string;
    let r;
    
    if (artistId) {
      // Use track_artists table for accurate matching - get all tracks from this album
      // that are associated with this artist (either as artist or album artist)
      libFilter = allowed === null ? '' : `and t.library_id = any($3)`;
      params = allowed === null ? [artistId, album] : [artistId, album, allowed];
      
      r = await db().query(
        `
        select distinct on (t.id) t.id, t.title, t.artist, t.album_artist, t.album, t.duration_ms, t.art_path, t.art_hash, t.path,
               t.track_number, t.track_total, t.disc_number, t.disc_total
        from active_tracks t
        join track_artists ta on ta.track_id = t.id
        where ta.artist_id = $1
          and t.album = $2
          ${libFilter}
        order by t.id, coalesce(t.disc_number, 1), coalesce(t.track_number, 0), t.path, t.title
        `,
        params
      );
      // Re-sort by disc/track after DISTINCT ON
      r.rows.sort((a: any, b: any) => {
        const discA = a.disc_number ?? 1, discB = b.disc_number ?? 1;
        if (discA !== discB) return discA - discB;
        const trackA = a.track_number ?? 0, trackB = b.track_number ?? 0;
        if (trackA !== trackB) return trackA - trackB;
        return (a.path || '').localeCompare(b.path || '');
      });
    } else if (artist) {
      // Legacy: Match by album_artist or artist name
      libFilter = allowed === null ? '' : `and t.library_id = any($3)`;
      // Join with artists table to find artist id, then use track_artists
      const artistLookup = await db().query(
        `select id from artists where name = $1 limit 1`,
        [artist]
      );
      
      if (artistLookup.rows[0]) {
        const foundArtistId = artistLookup.rows[0].id;
        params = allowed === null ? [foundArtistId, album] : [foundArtistId, album, allowed];
        
        r = await db().query(
          `
          select distinct on (t.id) t.id, t.title, t.artist, t.album_artist, t.album, t.duration_ms, t.art_path, t.art_hash, t.path,
                 t.track_number, t.track_total, t.disc_number, t.disc_total
          from active_tracks t
          join track_artists ta on ta.track_id = t.id
          where ta.artist_id = $1
            and t.album = $2
            ${libFilter}
          order by t.id, coalesce(t.disc_number, 1), coalesce(t.track_number, 0), t.path, t.title
          `,
          params
        );
        // Re-sort by disc/track after DISTINCT ON
        r.rows.sort((a: any, b: any) => {
          const discA = a.disc_number ?? 1, discB = b.disc_number ?? 1;
          if (discA !== discB) return discA - discB;
          const trackA = a.track_number ?? 0, trackB = b.track_number ?? 0;
          if (trackA !== trackB) return trackA - trackB;
          return (a.path || '').localeCompare(b.path || '');
        });
      } else {
        // Fallback to old string matching if artist not found in artists table
        libFilter = allowed === null ? '' : `and t.library_id = any($3)`;
        params = allowed === null ? [artist, album] : [artist, album, allowed];
        r = await db().query(
          `
          select t.id, t.title, t.artist, t.album_artist, t.album, t.duration_ms, t.art_path, t.art_hash, t.path,
                 t.track_number, t.track_total, t.disc_number, t.disc_total
          from active_tracks t
          where t.album = $2 and (
            t.album_artist = $1 
            or t.artist = $1 
            or t.album_artist like $1 || ';%'
            or t.artist like $1 || ';%'
          )
          ${libFilter}
          order by coalesce(t.disc_number, 1), coalesce(t.track_number, 0), t.path, t.title
          `,
          params
        );
      }
    } else {
      libFilter = allowed === null ? '' : `and t.library_id = any($2)`;
      params = allowed === null ? [album] : [album, allowed];
      r = await db().query(
        `
        select t.id, t.title, t.artist, t.album_artist, t.album, t.duration_ms, t.art_path, t.art_hash, t.path,
               t.track_number, t.track_total, t.disc_number, t.disc_total
        from active_tracks t
        where t.album = $1
        ${libFilter}
        order by coalesce(t.disc_number, 1), coalesce(t.track_number, 0), t.path, t.title
        `,
        params
      );
    }

    if (!r.rows.length) return reply.code(404).send({ ok: false, error: 'Album not found' });

    // Fetch all artists for each track
    const trackIds = r.rows.map((t: any) => Number(t.id));
    const artistsMap = await getTrackArtists(trackIds);
    
    const tracks = r.rows.map((t: any) => {
      // Compute display_artist: album_artist first, fallback to first artist
      const albumArtist = t.album_artist?.split(/[;|]/)[0]?.trim();
      const firstArtist = t.artist?.split(/[;|]/)[0]?.trim();
      const displayArtist = albumArtist || firstArtist || 'Unknown Artist';
      
      return {
        ...t,
        id: Number(t.id),
        trackNumber: t.track_number,
        trackTotal: t.track_total,
        discNumber: t.disc_number,
        discTotal: t.disc_total,
        artists: artistsMap.get(Number(t.id)) ?? [],
        display_artist: displayArtist
      };
    });

    // Get album artist from track_artists table (first album artist of first track)
    const firstTrack = r.rows[0];
    const albumArtistR = await db().query(
      `select a.name from track_artists ta
       join artists a on a.id = ta.artist_id
       where ta.track_id = $1 and ta.role = 'albumartist'
       order by a.name limit 1`,
      [Number(firstTrack.id)]
    );
    const displayArtist = albumArtistR.rows[0]?.name 
      || artistsMap.get(Number(firstTrack.id))?.[0]?.name 
      || firstTrack.artist?.split(';')[0]?.trim() 
      || 'Unknown Artist';

    // Calculate total discs
    const discNumbers = r.rows.map((t: any) => t.disc_number).filter(Boolean) as number[];
    const totalDiscs = discNumbers.length > 0 ? Math.max(...discNumbers) : 1;

    return { 
      ok: true, 
      album: {
        name: album,
        artist: displayArtist,
        art_path: firstTrack.art_path,
        art_hash: firstTrack.art_hash,
        track_count: tracks.length,
        total_discs: totalDiscs
      },
      tracks 
    };
  });

  // Legacy endpoints for backward compatibility
  app.get('/api/browse/artist', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const qs = req.query as { name?: string };
    const name = (qs.name ?? '').trim();
    if (!name) return reply.code(400).send({ ok: false });

    // Find artist ID and redirect to new endpoint
    const r = await db().query<{ id: number }>('select id from artists where name = $1', [name]);
    if (r.rows[0]) {
      // Use the new endpoint logic
      const artistId = r.rows[0].id;
      const allowed = await allowedLibrariesForUser(req.user.userId, req.user.role);
      const libFilter = allowed === null ? '' : `and t.library_id = any($2)`;
      const params = allowed === null ? [artistId] : [artistId, allowed];

      const albumsR = await db().query(
        `
        select t.album, count(*)::int as track_count
        from track_artists ta
        join active_tracks t on t.id = ta.track_id
        where ta.artist_id = $1 and t.album is not null and t.album <> ''
        ${libFilter}
        group by t.album
        order by t.album
      `,
        params as any
      );

      const tracksR = await db().query(
        `
        select distinct t.id, t.title, t.artist, t.album, t.duration_ms
        from track_artists ta
        join active_tracks t on t.id = ta.track_id
        where ta.artist_id = $1
        ${libFilter}
        order by t.title, t.id
        limit 50
      `,
        params as any
      );

      return { ok: true, artist: name, albums: albumsR.rows, appearsOn: [], tracks: tracksR.rows };
    }

    // Fallback to legacy query
    const allowed = await allowedLibrariesForUser(req.user.userId, req.user.role);
    const legacyFilter = allowed === null ? '' : `and library_id = any($2)`;
    const legacyParams = allowed === null ? [name] : [name, allowed];

    const albums = await db().query(
      `select album, count(*)::int as track_count from active_tracks where artist=$1 and album is not null ${legacyFilter} group by album order by album`,
      legacyParams as any
    );
    const tracks = await db().query(
      `select id, title, artist, album, duration_ms from active_tracks where artist=$1 ${legacyFilter} order by title limit 50`,
      legacyParams as any
    );

    return { ok: true, artist: name, albums: albums.rows, appearsOn: [], tracks: tracks.rows };
  });
});

// Helper to get all artists for a list of track IDs
async function getTrackArtists(trackIds: number[]): Promise<Map<number, Array<{ id: number; name: string }>>> {
  if (!trackIds.length) return new Map();
  
  const r = await db().query<{ track_id: string; artist_id: string; name: string }>(
    `
    select ta.track_id, a.id as artist_id, a.name
    from track_artists ta
    join artists a on a.id = ta.artist_id
    where ta.track_id = any($1) and ta.role = 'artist'
    order by ta.track_id, a.name
  `,
    [trackIds]
  );

  const map = new Map<number, Array<{ id: number; name: string }>>();
  for (const row of r.rows) {
    const trackId = Number(row.track_id);
    const list = map.get(trackId) ?? [];
    list.push({ id: Number(row.artist_id), name: row.name });
    map.set(trackId, list);
  }
  return map;
}

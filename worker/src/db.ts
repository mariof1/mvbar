import { Pool } from 'pg';
import logger from './logger.js';

let pool: Pool | null = null;

export function db() {
  if (!pool) throw new Error('DB not initialized');
  return pool;
}

export async function initDb() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const poolSize = parseInt(process.env.DB_POOL_SIZE ?? '30', 10);
  pool = new Pool({
    connectionString: url,
    max: poolSize,              // Match scan concurrency
    idleTimeoutMillis: 30000,   // Close idle connections after 30s
    connectionTimeoutMillis: 10000, // Fail fast if can't connect in 10s
  });
  await pool.query('select 1');
  logger.success('db', `Connected (pool: ${poolSize} connections)`);

  // Best-effort schema ensures (worker may start before API migrations)
  try {
    await pool.query('alter table libraries add column if not exists enabled boolean not null default true');
    await pool.query('alter table tracks add column if not exists genre text');
    await pool.query('alter table tracks add column if not exists country text');
    await pool.query('alter table tracks add column if not exists language text');
    await pool.query('alter table tracks add column if not exists year integer');
    
    // Track genres table (normalized)
    await pool.query(`
      create table if not exists track_genres (
        track_id bigint not null references tracks(id) on delete cascade,
        genre text not null,
        primary key (track_id, genre)
      );
    `);
    await pool.query('create index if not exists track_genres_genre_idx on track_genres(genre)');

    // Track countries table (normalized)
    await pool.query(`
      create table if not exists track_countries (
        track_id bigint not null references tracks(id) on delete cascade,
        country text not null,
        primary key (track_id, country)
      );
    `);
    await pool.query('create index if not exists track_countries_country_idx on track_countries(country)');

    // Track languages table (normalized)
    await pool.query(`
      create table if not exists track_languages (
        track_id bigint not null references tracks(id) on delete cascade,
        language text not null,
        primary key (track_id, language)
      );
    `);
    await pool.query('create index if not exists track_languages_language_idx on track_languages(language)');

    // The API normally performs this backfill too, but the worker may be the
    // first service to start. Keep scalar artist fields canonical before the
    // search index is reconciled.
    await pool.query(`
      with canonical_artists as (
        select
          ta.track_id,
          string_agg(a.name, '; ' order by ta.position, a.name)
            filter (where ta.role = 'artist') as artist,
          string_agg(a.name, '; ' order by ta.position, a.name)
            filter (where ta.role = 'albumartist') as album_artist
        from track_artists ta
        join artists a on a.id = ta.artist_id
        group by ta.track_id
      )
      update tracks t
         set artist = coalesce(c.artist, t.artist),
             album_artist = coalesce(c.album_artist, t.album_artist)
        from canonical_artists c
       where t.id = c.track_id
         and (
           (c.artist is not null and t.artist is distinct from c.artist)
           or (c.album_artist is not null and t.album_artist is distinct from c.album_artist)
         )
    `);
  } catch {
    // ignore
  }
}

export async function audit(action: string, details: unknown) {
  try {
    await db().query(
      'INSERT INTO audit_events(event, meta) VALUES($1, $2)',
      [action, JSON.stringify(details)]
    );
  } catch (e) {
    console.error('[audit] Failed to log:', action, e);
  }
}

import { Pool } from 'pg';
import Redis from 'ioredis';
import { asciiFold } from './asciiFold.js';

let pool: Pool | null = null;
let redisClient: Redis | null = null;

export function db() {
  if (!pool) throw new Error('DB not initialized');
  return pool;
}

export function redis() {
  if (!redisClient) {
    const url = process.env.REDIS_URL ?? 'redis://redis:6379';
    redisClient = new Redis(url);
  }
  return redisClient;
}

export async function initDb() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');

  pool = new Pool({ connectionString: url });
  await pool.query('select 1');
  await pool.query('create extension if not exists pg_trgm');

  await pool.query(`
    create table if not exists users (
      id text primary key,
      email text not null unique,
      password_hash text,
      role text not null check (role in ('admin','user')),
      session_version integer not null default 0,
      created_at timestamptz not null default now(),
      google_id text unique,
      avatar_path text,
      last_seen_at timestamptz,
      last_seen_ip text,
      approval_status text not null default 'approved' check (approval_status in ('approved','pending','rejected'))
    );
  `);

  // Add new columns to existing users table if they don't exist
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id text UNIQUE;
    EXCEPTION WHEN others THEN NULL;
    END $$;
  `);
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_path text;
    EXCEPTION WHEN others THEN NULL;
    END $$;
  `);
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE users ADD COLUMN IF NOT EXISTS approval_status text DEFAULT 'approved';
    EXCEPTION WHEN others THEN NULL;
    END $$;
  `);
  await pool.query('alter table users add column if not exists last_seen_at timestamptz');
  await pool.query('alter table users add column if not exists last_seen_ip text');
  await pool.query('create index if not exists users_last_seen_at_idx on users(last_seen_at desc)');
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE users ADD COLUMN IF NOT EXISTS google_refresh_token text;
    EXCEPTION WHEN others THEN NULL;
    END $$;
  `);
  // Make password_hash nullable for Google-only accounts
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
    EXCEPTION WHEN others THEN NULL;
    END $$;
  `);

  await pool.query(`
    create table if not exists audit_events (
      id bigserial primary key,
      ts timestamptz not null default now(),
      event text not null,
      meta jsonb
    );
  `);
  await pool.query('create index if not exists audit_events_event_ts_idx on audit_events(event, ts desc)');
  await pool.query(`
    create index if not exists audit_events_login_email_ts_idx
    on audit_events ((lower(meta->>'email')), ts desc)
    where event in ('login_ok', 'login_failed', 'login_locked')
  `);
  await pool.query(`
    create unique index if not exists audit_events_login_session_idx
    on audit_events ((lower(meta->>'email')), (meta->>'sessionIat'))
    where event = 'login_ok' and meta ? 'sessionIat'
  `);

  await pool.query(`
    create table if not exists rate_limit_bypass_ips (
      ip inet primary key,
      created_at timestamptz not null default now(),
      created_by text references users(id) on delete set null,
      check (masklen(ip) = case family(ip) when 4 then 32 else 128 end)
    );
  `);
  await pool.query(`
    insert into audit_events(ts, event, meta)
    select
      u.created_at,
      'login_ok',
      jsonb_build_object(
        'email', u.email,
        'method', 'google',
        'sessionIat', floor(extract(epoch from u.created_at))::bigint,
        'backfilledFrom', 'account_creation'
      )
    from users u
    where u.google_id is not null
      and not exists (
        select 1
        from audit_events ae
        where ae.event = 'login_ok'
          and lower(ae.meta->>'email') = lower(u.email)
      )
    on conflict do nothing
  `);

  await pool.query(`
    create table if not exists scan_jobs (
      id bigserial primary key,
      state text not null check (state in ('queued','running','done','failed')),
      requested_by text,
      requested_at timestamptz not null default now(),
      started_at timestamptz,
      finished_at timestamptz,
      stats jsonb,
      error text
    );
  `);

  await pool.query(`
    create table if not exists tracks (
      id bigserial primary key,
      library_id bigint,
      path text not null,
      mtime_ms bigint not null,
      size_bytes bigint not null,
      ext text not null,
      title text,
      artist text,
      album text,
      duration_ms integer,
      last_seen_job_id bigint,
      updated_at timestamptz not null default now()
    );
  `);

  await pool.query(`
    create table if not exists transcode_jobs (
      id bigserial primary key,
      track_id bigint not null references tracks(id) on delete cascade,
      cache_key text not null,
      state text not null check (state in ('queued','running','done','failed')),
      requested_by text,
      requested_at timestamptz not null default now(),
      started_at timestamptz,
      finished_at timestamptz,
      out_dir text,
      error text
    );
  `);

  await pool.query('create index if not exists transcode_jobs_state_id_idx on transcode_jobs(state, id)');
  await pool.query('create index if not exists transcode_jobs_track_cache_idx on transcode_jobs(track_id, cache_key, id desc)');

  await pool.query(`
    create table if not exists playlists (
      id bigserial primary key,
      user_id text not null references users(id),
      name text not null,
      created_at timestamptz not null default now(),
      unique(user_id, name)
    );
  `);

  await pool.query(`
    create table if not exists playlist_items (
      playlist_id bigint not null references playlists(id) on delete cascade,
      track_id bigint not null references tracks(id) on delete cascade,
      position integer not null,
      added_by text references users(id) on delete set null,
      added_at timestamptz not null default now(),
      primary key (playlist_id, track_id)
    );
  `);
  await pool.query('alter table playlist_items add column if not exists added_by text');
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE playlist_items
        ADD CONSTRAINT playlist_items_added_by_fkey
        FOREIGN KEY (added_by) REFERENCES users(id) ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);

  await pool.query(`
    create table if not exists favorite_tracks (
      user_id text not null references users(id) on delete cascade,
      track_id bigint not null references tracks(id) on delete cascade,
      added_at timestamptz not null default now(),
      primary key (user_id, track_id)
    );
  `);

  await pool.query(`
    create table if not exists play_history (
      id bigserial primary key,
      user_id text not null references users(id) on delete cascade,
      track_id bigint not null references tracks(id) on delete cascade,
      played_at timestamptz not null default now()
    );
  `);

  await pool.query('create index if not exists play_history_user_played_at_idx on play_history(user_id, played_at desc)');
  await pool.query('create index if not exists play_history_played_at_idx on play_history(played_at desc)');

  await pool.query(`
    create table if not exists subsonic_bookmarks (
      user_id text not null references users(id) on delete cascade,
      item_id text not null,
      item_type text not null default 'track',
      position_ms integer not null default 0,
      comment text,
      created_at timestamptz not null default now(),
      changed_at timestamptz not null default now(),
      primary key (user_id, item_id)
    );
  `);

  await pool.query(`
    create table if not exists user_track_stats (
      user_id text not null references users(id) on delete cascade,
      track_id bigint not null references tracks(id) on delete cascade,
      play_count integer not null default 0,
      skip_count integer not null default 0,
      last_played_at timestamptz,
      last_skipped_at timestamptz,
      primary key (user_id, track_id)
    );
  `);

  await pool.query('create index if not exists user_track_stats_user_play_count_idx on user_track_stats(user_id, play_count desc)');
  await pool.query('alter table user_track_stats add column if not exists total_listened_ms bigint not null default 0');
  await pool.query('alter table user_track_stats add column if not exists completion_count integer not null default 0');
  await pool.query('alter table user_track_stats add column if not exists early_skip_count integer not null default 0');
  await pool.query('alter table user_track_stats add column if not exists last_completion_pct double precision');

  await pool.query(`
    create table if not exists recommendation_preferences (
      user_id text not null references users(id) on delete cascade,
      subject_type text not null check (subject_type in ('track', 'artist', 'bucket')),
      subject_key text not null,
      preference smallint not null check (preference between -2 and 2 and preference != 0),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      primary key (user_id, subject_type, subject_key)
    );
  `);
  await pool.query('create index if not exists recommendation_preferences_user_idx on recommendation_preferences(user_id, updated_at desc)');

  await pool.query(`
    create table if not exists recommendation_impressions (
      user_id text not null references users(id) on delete cascade,
      slate_id text not null,
      bucket_key text not null,
      track_id bigint not null references tracks(id) on delete cascade,
      position integer not null,
      served_at timestamptz not null default now(),
      played_at timestamptz,
      completed_at timestamptz,
      skipped_at timestamptz,
      listened_ms bigint not null default 0,
      completion_pct double precision,
      primary key (user_id, slate_id, bucket_key, track_id)
    );
  `);
  await pool.query('create index if not exists recommendation_impressions_user_served_idx on recommendation_impressions(user_id, served_at desc)');
  await pool.query('create index if not exists recommendation_impressions_track_idx on recommendation_impressions(user_id, track_id, served_at desc)');
  await pool.query('create index if not exists recommendation_impressions_served_idx on recommendation_impressions(served_at)');

  await pool.query(`
    create table if not exists libraries (
      id bigserial primary key,
      mount_path text not null unique,
      media_type text not null default 'music',
      created_at timestamptz not null default now()
    );
  `);
  await pool.query("alter table libraries add column if not exists media_type text not null default 'music'");
  await pool.query('alter table libraries add column if not exists enabled boolean not null default true');
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE libraries ADD CONSTRAINT libraries_media_type_check
        CHECK (media_type in ('music', 'audiobook'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);

  await pool.query(`
    create table if not exists user_libraries (
      user_id text not null references users(id) on delete cascade,
      library_id bigint not null references libraries(id) on delete cascade,
      created_at timestamptz not null default now(),
      primary key (user_id, library_id)
    );
  `);

  // incremental schema updates for existing DBs
  await pool.query('alter table tracks add column if not exists library_id bigint');
  await pool.query('alter table tracks add column if not exists last_seen_job_id bigint');
  await pool.query('alter table tracks add column if not exists art_path text');
  await pool.query('alter table tracks add column if not exists art_mime text');
  await pool.query('alter table tracks add column if not exists art_hash text');
  await pool.query('alter table tracks add column if not exists lyrics_path text');
  await pool.query('alter table tracks add column if not exists embedded_lyrics text');
  await pool.query('alter table tracks add column if not exists embedded_lyrics_synced boolean default false');
  await pool.query('alter table tracks add column if not exists album_artist text');
  await pool.query('alter table tracks add column if not exists genre text');
  await pool.query('alter table tracks add column if not exists country text');
  await pool.query('alter table tracks add column if not exists language text');
  await pool.query('alter table tracks add column if not exists year integer');

  // Extended metadata columns (Phase 1 - Scanner Polish)
  await pool.query('alter table tracks add column if not exists bpm integer');
  await pool.query('alter table tracks add column if not exists initial_key text');
  await pool.query('alter table tracks add column if not exists composer text');
  await pool.query('alter table tracks add column if not exists conductor text');
  await pool.query('alter table tracks add column if not exists publisher text');
  await pool.query('alter table tracks add column if not exists copyright text');
  await pool.query('alter table tracks add column if not exists comment text');
  await pool.query('alter table tracks add column if not exists mood text');
  await pool.query('alter table tracks add column if not exists grouping text');
  await pool.query('alter table tracks add column if not exists isrc text');
  await pool.query('alter table tracks add column if not exists release_date text');
  await pool.query('alter table tracks add column if not exists original_year integer');
  await pool.query('alter table tracks add column if not exists compilation boolean');
  // Sort fields
  await pool.query('alter table tracks add column if not exists title_sort text');
  await pool.query('alter table tracks add column if not exists artist_sort text');
  await pool.query('alter table tracks add column if not exists album_sort text');
  await pool.query('alter table tracks add column if not exists album_artist_sort text');
  // MusicBrainz IDs
  await pool.query('alter table tracks add column if not exists musicbrainz_track_id text');
  await pool.query('alter table tracks add column if not exists musicbrainz_release_id text');
  await pool.query('alter table tracks add column if not exists musicbrainz_artist_id text');
  await pool.query('alter table tracks add column if not exists musicbrainz_album_artist_id text');

  await pool.query(`
    create table if not exists artists (
      id bigserial primary key,
      name text not null unique,
      art_path text,
      art_hash text
    );
  `);

  // Add art columns to existing artists table
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE artists ADD COLUMN IF NOT EXISTS art_path text;
    EXCEPTION WHEN others THEN NULL;
    END $$;
  `);
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE artists ADD COLUMN IF NOT EXISTS art_hash text;
    EXCEPTION WHEN others THEN NULL;
    END $$;
  `);
  // Artist sort and ASCII name columns for search
  await pool.query('alter table artists add column if not exists sort_name text');
  await pool.query('alter table artists add column if not exists ascii_name text');
  await pool.query('alter table artists add column if not exists musicbrainz_id text');
  await pool.query('create index if not exists artists_ascii_name_idx on artists(ascii_name)');
  await pool.query(`
    create index if not exists artists_search_trgm_idx on artists using gin (
      (lower(coalesce(nullif(ascii_name, ''), translate(coalesce(name, ''), 'ĄĆĘŁŃÓŚŹŻąćęłńóśźż', 'ACELNOSZZacelnoszz')))) gin_trgm_ops
    )
  `);

  await pool.query(`
    create index if not exists tracks_album_search_trgm_idx on tracks using gin (
      (lower(translate(coalesce(album, ''), 'ĄĆĘŁŃÓŚŹŻąćęłńóśźż', 'ACELNOSZZacelnoszz'))) gin_trgm_ops
    )
  `);
  await pool.query(`
    create index if not exists tracks_album_artist_search_trgm_idx on tracks using gin (
      (lower(translate(coalesce(album_artist, artist, ''), 'ĄĆĘŁŃÓŚŹŻąćęłńóśźż', 'ACELNOSZZacelnoszz'))) gin_trgm_ops
    )
  `);

  await pool.query(`
    create table if not exists track_artists (
      track_id bigint not null references tracks(id) on delete cascade,
      artist_id bigint not null references artists(id) on delete cascade,
      role text not null check (role in ('artist','albumartist')),
      position integer not null,
      primary key (track_id, artist_id, role)
    );
  `);

  // Add ordering column for existing DBs
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE track_artists ADD COLUMN IF NOT EXISTS position integer;
    EXCEPTION WHEN others THEN NULL;
    END $$;
  `);
  await pool.query(`
    DO $$ BEGIN
      UPDATE track_artists SET position = 0 WHERE position IS NULL;
    EXCEPTION WHEN others THEN NULL;
    END $$;
  `);
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE track_artists ALTER COLUMN position SET NOT NULL;
    EXCEPTION WHEN others THEN NULL;
    END $$;
  `);

  await pool.query('create index if not exists track_artists_artist_role_idx on track_artists(artist_id, role)');
  await pool.query('create index if not exists track_artists_track_role_idx on track_artists(track_id, role)');
  await pool.query('create index if not exists track_artists_track_role_pos_idx on track_artists(track_id, role, position)');

  // Keep the legacy scalar columns aligned with the normalized artist
  // relations. This backfills existing libraries and makes every API surface,
  // including older endpoints, return the same complete ordered credits.
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

  // Track credits table for composer, conductor, etc.
  await pool.query(`
    create table if not exists track_credits (
      track_id bigint not null references tracks(id) on delete cascade,
      artist_id bigint not null references artists(id) on delete cascade,
      role text not null check (role in ('composer','conductor','lyricist','producer','remixer','performer')),
      position integer not null default 0,
      primary key (track_id, artist_id, role)
    );
  `);
  await pool.query('create index if not exists track_credits_artist_role_idx on track_credits(artist_id, role)');
  await pool.query('create index if not exists track_credits_track_role_idx on track_credits(track_id, role)');

  // Track genres table for smart playlists
  await pool.query(`
    create table if not exists track_genres (
      track_id bigint not null references tracks(id) on delete cascade,
      genre text not null,
      primary key (track_id, genre)
    );
  `);
  await pool.query('create index if not exists track_genres_genre_idx on track_genres(genre)');
  await pool.query('create index if not exists track_genres_genre_lower_idx on track_genres(lower(genre))');

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

  // Smart playlists
  await pool.query(`
    create table if not exists smart_playlists (
      id bigserial primary key,
      user_id text not null references users(id) on delete cascade,
      name text not null,
      filters_json jsonb not null default '{}',
      sort_mode text not null default 'random',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  await pool.query('create index if not exists smart_playlists_user_idx on smart_playlists(user_id)');

  // Ensure deleting a track cleans up playlists.
  await pool.query(`do $$
  begin
    begin
      alter table playlist_items drop constraint if exists playlist_items_track_id_fkey;
    exception when undefined_object then
      null;
    end;

    begin
      alter table playlist_items
        add constraint playlist_items_track_id_fkey
        foreign key (track_id) references tracks(id) on delete cascade;
    exception when duplicate_object then
      null;
    end;
  end $$;`);

  // Migrate to mount-based libraries using the first configured music root.
  const defaultLibraryMount = (process.env.MUSIC_DIRS ?? process.env.MUSIC_DIR ?? '/music')
    .split(',')
    .map((value) => value.trim())
    .find(Boolean) ?? '/music';
  await pool.query(
    `insert into libraries(mount_path, media_type, enabled)
     values ($1, 'music', true)
     on conflict (mount_path) do update
       set media_type = 'music', enabled = true`,
    [defaultLibraryMount]
  );
  await pool.query(
    'update tracks set library_id = (select id from libraries where mount_path=$1) where library_id is null',
    [defaultLibraryMount]
  );

  await pool.query(`do $$
  begin
    begin
      alter table tracks drop constraint if exists tracks_path_key;
    exception when undefined_object then
      null;
    end;
    if not exists (select 1 from pg_indexes where schemaname=current_schema() and indexname='tracks_library_path_uq') then
      execute 'create unique index tracks_library_path_uq on tracks(library_id, path)';
    end if;
    begin
      alter table tracks alter column library_id set not null;
    exception when others then
      null;
    end;
  end $$;`);

  // Ensure existing non-admin users have access to the configured default library.
  await pool.query(
    `insert into user_libraries(user_id, library_id)
     select u.id, (select id from libraries where mount_path=$1)
     from users u
     where u.role='user'
     on conflict do nothing`,
    [defaultLibraryMount]
  );

  // Add missing track columns used by views/queries
  await pool.query('alter table tracks add column if not exists deleted_at timestamptz');
  await pool.query('alter table tracks add column if not exists track_number integer');
  await pool.query('alter table tracks add column if not exists track_total integer');
  await pool.query('alter table tracks add column if not exists disc_number integer');
  await pool.query('alter table tracks add column if not exists disc_total integer');

  // Add ListenBrainz + Subsonic columns
  await pool.query(`
    alter table users add column if not exists listenbrainz_token text;
    alter table users add column if not exists listenbrainz_username text;
    alter table users add column if not exists subsonic_password text;
  `);

  // Search logs for search-based recommendation buckets
  await pool.query(`
    create table if not exists search_logs (
      id bigserial primary key,
      user_id text not null references users(id) on delete cascade,
      query text not null,
      query_normalized text not null,
      result_count integer not null default 0,
      created_at timestamptz not null default now()
    );
  `);
  await pool.query('create index if not exists search_logs_user_created_idx on search_logs(user_id, created_at desc)');
  await pool.query('create index if not exists search_logs_user_query_idx on search_logs(user_id, query_normalized)');

  // User-facing search history is intentionally separate from search_logs.
  // search_logs captures autocomplete traffic for recommendation signals,
  // while this table stores the entities a user actually selected.
  await pool.query(`
    create table if not exists user_recent_search_items (
      user_id text not null references users(id) on delete cascade,
      item_type text not null check (item_type in ('track', 'artist', 'album', 'playlist', 'podcast', 'podcast_episode')),
      item_key text not null,
      title text not null,
      subtitle text,
      image_url text,
      payload jsonb not null default '{}'::jsonb,
      accessed_at timestamptz not null default now(),
      primary key (user_id, item_type, item_key)
    );
  `);
  await pool.query('create index if not exists user_recent_search_items_user_date_idx on user_recent_search_items(user_id, accessed_at desc)');

  // Track tempo/bpm for tempo-based recommendations
  await pool.query('alter table tracks add column if not exists bpm real');
  // Migrate legacy integer bpm column to real so fractional averages can be queried.
  // The active_tracks view references bpm so we drop+recreate it (view is recreated below).
  await pool.query(`do $$
    begin
      if exists (
        select 1 from information_schema.columns
        where table_name='tracks' and column_name='bpm' and data_type='integer'
      ) then
        drop view if exists active_tracks;
        alter table tracks alter column bpm type real using bpm::real;
      end if;
    end$$`);
  await pool.query('create index if not exists tracks_bpm_idx on tracks(bpm) where bpm is not null');

  // Add birthtime_ms (on-disk creation time) + created_at (derived for convenience)
  await pool.query('alter table tracks add column if not exists birthtime_ms bigint');

  // Add created_at to tracks for sorting by date added
  await pool.query('alter table tracks add column if not exists created_at timestamptz not null default now()');
  await pool.query('create index if not exists tracks_created_at_idx on tracks(created_at desc)');

  // Recreate active_tracks view; only append columns to avoid breaking CREATE OR REPLACE VIEW
  await pool.query(`
    create or replace view active_tracks as
    select id, library_id, path, mtime_ms, size_bytes, ext, title, artist, album, duration_ms,
           last_seen_job_id, updated_at, art_path, art_mime, art_hash, lyrics_path, album_artist,
           genre, country, language, year, bpm, deleted_at, track_number, track_total, 
           disc_number, disc_total, created_at, birthtime_ms,
           initial_key, composer, conductor, publisher, copyright, comment, mood, grouping,
           isrc, release_date, original_year, compilation,
           title_sort, artist_sort, album_sort, album_artist_sort,
           musicbrainz_track_id, musicbrainz_release_id, musicbrainz_artist_id, musicbrainz_album_artist_id,
           embedded_lyrics, embedded_lyrics_synced
    from tracks
    where tracks.deleted_at is null
      and exists (
        select 1
        from libraries
        where libraries.id = tracks.library_id and libraries.enabled = true
      )
  `);

  // Last.fm cache for similar artists
  await pool.query(`
    create table if not exists lastfm_cache (
      cache_key text primary key,
      data jsonb not null,
      fetched_at timestamptz not null default now()
    );
  `);

  // Add force_full to scan_jobs for full re-scan
  await pool.query('alter table scan_jobs add column if not exists force_full boolean not null default false');

  // ========================================================================
  // PERFORMANCE INDEXES (added for query optimization)
  // ========================================================================
  // Index for user email lookups (subsonic auth, etc.)
  await pool.query('create index if not exists idx_users_email on users(email)');
  // Index for artist_id lookups in track_artists (used in artist filtering)
  await pool.query('create index if not exists idx_track_artists_artist_id on track_artists(artist_id)');
  // Index for tracks by album and art_path (album art queries)
  await pool.query('create index if not exists idx_tracks_album_art on tracks(album, art_path) where art_path is not null');
  // Index for tracks artist/title search (subsonic search, case-insensitive)
  await pool.query('create index if not exists idx_tracks_artist_lower on tracks(lower(artist))');
  await pool.query('create index if not exists idx_tracks_title_lower on tracks(lower(title))');
  // Index for favorite_tracks lookups by track_id (batch operations)
  await pool.query('create index if not exists idx_favorite_tracks_track_id on favorite_tracks(track_id)');

  // ========================================================================
  // PODCASTS
  // ========================================================================

  // Podcasts (RSS feeds)
  await pool.query(`
    create table if not exists podcasts (
      id bigserial primary key,
      feed_url text not null unique,
      title text not null,
      author text,
      description text,
      image_url text,
      image_path text,
      link text,
      language text,
      last_fetched_at timestamptz,
      last_build_date timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);

  // Podcast episodes
  await pool.query(`
    create table if not exists podcast_episodes (
      id bigserial primary key,
      podcast_id bigint not null references podcasts(id) on delete cascade,
      guid text not null,
      title text not null,
      description text,
      audio_url text not null,
      audio_type text,
      duration_ms integer,
      file_size_bytes bigint,
      image_url text,
      image_path text,
      link text,
      published_at timestamptz,
      downloaded_path text,
      downloaded_at timestamptz,
      created_at timestamptz not null default now(),
      unique(podcast_id, guid)
    );
  `);
  await pool.query('create index if not exists podcast_episodes_podcast_idx on podcast_episodes(podcast_id, published_at desc)');
  // Migration: add image_path if missing
  await pool.query('ALTER TABLE podcast_episodes ADD COLUMN IF NOT EXISTS image_path text');

  // User podcast subscriptions
  await pool.query(`
    create table if not exists user_podcast_subscriptions (
      user_id text not null references users(id) on delete cascade,
      podcast_id bigint not null references podcasts(id) on delete cascade,
      subscribed_at timestamptz not null default now(),
      primary key (user_id, podcast_id)
    );
  `);
  await pool.query('create index if not exists user_podcast_subs_user_idx on user_podcast_subscriptions(user_id)');

  // User episode progress (playback position, played status)
  await pool.query(`
    create table if not exists user_episode_progress (
      user_id text not null references users(id) on delete cascade,
      episode_id bigint not null references podcast_episodes(id) on delete cascade,
      position_ms integer not null default 0,
      played boolean not null default false,
      updated_at timestamptz not null default now(),
      primary key (user_id, episode_id)
    );
  `);
  await pool.query('create index if not exists user_episode_progress_user_idx on user_episode_progress(user_id)');

  // ========================================================================
  // AUDIOBOOKS
  // ========================================================================

  await pool.query(`
    create table if not exists audiobooks (
      id bigserial primary key,
      library_id bigint references libraries(id) on delete set null,
      path text not null unique,
      title text not null,
      author text,
      narrator text,
      description text,
      language text,
      cover_path text,
      duration_ms bigint not null default 0,
      metadata_locked boolean not null default false,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  await pool.query(`ALTER TABLE audiobooks ADD COLUMN IF NOT EXISTS metadata_locked boolean NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE audiobooks ADD COLUMN IF NOT EXISTS language text`);
  await pool.query(`
    create or replace view active_audiobooks as
    select
      audiobook.id,
      audiobook.library_id,
      audiobook.path,
      audiobook.title,
      audiobook.author,
      audiobook.narrator,
      audiobook.description,
      audiobook.language,
      audiobook.cover_path,
      audiobook.duration_ms,
      audiobook.metadata_locked,
      audiobook.created_at,
      audiobook.updated_at
    from audiobooks as audiobook
    join libraries as library on library.id = audiobook.library_id
    where library.enabled = true
  `);

  await pool.query(`
    create table if not exists audiobook_chapters (
      id bigserial primary key,
      audiobook_id bigint not null references audiobooks(id) on delete cascade,
      path text not null,
      title text not null,
      position integer not null,
      duration_ms integer,
      size_bytes bigint,
      mtime_ms bigint,
      metadata_locked boolean not null default false,
      created_at timestamptz not null default now(),
      unique(audiobook_id, path)
    );
  `);
  await pool.query(`ALTER TABLE audiobook_chapters ADD COLUMN IF NOT EXISTS metadata_locked boolean NOT NULL DEFAULT false`);
  await pool.query('create index if not exists audiobook_chapters_book_idx on audiobook_chapters(audiobook_id, position)');

  await pool.query(`
    create table if not exists user_audiobook_progress (
      user_id text not null references users(id) on delete cascade,
      audiobook_id bigint not null references audiobooks(id) on delete cascade,
      chapter_id bigint not null references audiobook_chapters(id) on delete cascade,
      position_ms integer not null default 0,
      finished boolean not null default false,
      updated_at timestamptz not null default now(),
      primary key (user_id, audiobook_id)
    );
  `);
  await pool.query('create index if not exists user_audiobook_progress_user_idx on user_audiobook_progress(user_id)');

  await pool.query(`
    create table if not exists media_activity (
      id bigserial primary key,
      user_id text not null references users(id) on delete cascade,
      media_type text not null check (media_type in ('podcast', 'audiobook')),
      item_id bigint not null,
      parent_id bigint,
      event_type text not null check (event_type in ('progress', 'completed')),
      position_ms bigint not null default 0,
      listened_ms bigint not null default 0,
      bucket_start timestamptz not null,
      updated_at timestamptz not null default now(),
      ip text,
      client_type text,
      client_id text,
      unique(user_id, media_type, item_id, bucket_start)
    );
  `);
  await pool.query(
    'create index if not exists media_activity_user_updated_idx on media_activity(user_id, updated_at desc)'
  );
  await pool.query(
    'create index if not exists media_activity_type_item_idx on media_activity(media_type, item_id, updated_at desc)'
  );
  await pool.query(`
    insert into media_activity (
      user_id, media_type, item_id, parent_id, event_type,
      position_ms, listened_ms, bucket_start, updated_at
    )
    select
      uep.user_id,
      'podcast',
      uep.episode_id,
      pe.podcast_id,
      case when uep.played then 'completed' else 'progress' end,
      greatest(uep.position_ms, 0),
      case
        when pe.duration_ms is not null and pe.duration_ms > 0 then
          least(pe.duration_ms, greatest(uep.position_ms, case when uep.played then pe.duration_ms else 0 end))
        else greatest(uep.position_ms, 0)
      end,
      date_bin('5 minutes', uep.updated_at, timestamptz '2001-01-01'),
      uep.updated_at
    from user_episode_progress uep
    join podcast_episodes pe on pe.id = uep.episode_id
    where uep.position_ms > 0 or uep.played
    on conflict do nothing
  `);
  await pool.query(`
    insert into media_activity (
      user_id, media_type, item_id, parent_id, event_type,
      position_ms, listened_ms, bucket_start, updated_at
    )
    select
      uap.user_id,
      'audiobook',
      uap.audiobook_id,
      uap.chapter_id,
      case when uap.finished then 'completed' else 'progress' end,
      greatest(uap.position_ms, 0),
      case
        when uap.finished and a.duration_ms > 0 then a.duration_ms
        else greatest(uap.position_ms, 0)
      end,
      date_bin('5 minutes', uap.updated_at, timestamptz '2001-01-01'),
      uap.updated_at
    from user_audiobook_progress uap
    join audiobooks a on a.id = uap.audiobook_id
    where uap.position_ms > 0 or uap.finished
    on conflict do nothing
  `);

  await pool.query(`
    create table if not exists user_client_activity (
      user_id text not null references users(id) on delete cascade,
      client_id text not null,
      client_type text not null,
      app_version text,
      device_name text,
      platform text,
      user_agent text,
      first_seen_at timestamptz not null default now(),
      last_seen_at timestamptz not null default now(),
      last_seen_ip text,
      primary key (user_id, client_id)
    );
  `);
  await pool.query(
    'create index if not exists user_client_activity_user_seen_idx on user_client_activity(user_id, last_seen_at desc)'
  );

  // ========================================================================
  // FRIENDS AND TRACK SHARING
  // ========================================================================

  await pool.query(`
    create table if not exists friendships (
      id bigserial primary key,
      requester_id text not null references users(id) on delete cascade,
      addressee_id text not null references users(id) on delete cascade,
      status text not null default 'pending' check (status in ('pending', 'accepted')),
      created_at timestamptz not null default now(),
      responded_at timestamptz,
      check (requester_id <> addressee_id),
      unique (requester_id, addressee_id)
    );
  `);
  await pool.query(`
    create unique index if not exists friendships_unique_pair_idx
    on friendships (least(requester_id, addressee_id), greatest(requester_id, addressee_id))
  `);
  await pool.query(
    "create index if not exists friendships_addressee_pending_idx on friendships(addressee_id, created_at desc) where status = 'pending'"
  );
  await pool.query(`
    create index if not exists friendships_members_accepted_idx
    on friendships(requester_id, addressee_id) where status = 'accepted'
  `);

  await pool.query(`
    create table if not exists playlist_collaborators (
      playlist_id bigint not null references playlists(id) on delete cascade,
      user_id text not null references users(id) on delete cascade,
      friendship_id bigint not null references friendships(id) on delete cascade,
      added_by text references users(id) on delete set null,
      created_at timestamptz not null default now(),
      primary key (playlist_id, user_id)
    );
  `);
  await pool.query(
    'create index if not exists playlist_collaborators_user_idx on playlist_collaborators(user_id, created_at desc)'
  );

  await pool.query(`
    create table if not exists track_shares (
      id bigserial primary key,
      sender_id text not null references users(id) on delete cascade,
      recipient_id text not null references users(id) on delete cascade,
      track_id bigint not null references tracks(id) on delete cascade,
      message text,
      created_at timestamptz not null default now(),
      read_at timestamptz,
      check (sender_id <> recipient_id),
      check (message is null or char_length(message) <= 500),
      unique (sender_id, recipient_id, track_id)
    );
  `);
  await pool.query(
    'create index if not exists track_shares_recipient_created_idx on track_shares(recipient_id, created_at desc)'
  );
  await pool.query(
    'create index if not exists track_shares_recipient_unread_idx on track_shares(recipient_id, created_at desc) where read_at is null'
  );

  await pool.query(`
    create table if not exists web_push_subscriptions (
      id bigserial primary key,
      user_id text not null references users(id) on delete cascade,
      session_version integer not null default 0,
      endpoint text not null unique,
      p256dh text not null,
      auth text not null,
      expiration_time bigint,
      user_agent text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      last_success_at timestamptz,
      last_failure_at timestamptz,
      failure_count integer not null default 0
    );
  `);
  await pool.query(
    'alter table web_push_subscriptions add column if not exists session_version integer not null default 0'
  );
  await pool.query(
    'create index if not exists web_push_subscriptions_user_idx on web_push_subscriptions(user_id, updated_at desc)'
  );

  await pool.query(`
    create table if not exists web_push_configuration (
      singleton boolean primary key default true check (singleton),
      public_key text not null,
      private_key text not null,
      subject text not null,
      created_at timestamptz not null default now()
    );
  `);

  // ========================================================================
  // SANDBOXED PLUGINS
  // ========================================================================

  await pool.query(`
    create table if not exists plugins (
      id text primary key,
      filename text not null,
      name text not null,
      author text not null,
      version text not null,
      description text,
      homepage text,
      manifest jsonb not null,
      config jsonb not null default '{}'::jsonb,
      enabled boolean not null default false,
      package_sha256 text not null,
      permission_fingerprint text not null,
      installed_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      last_loaded_at timestamptz,
      last_error text
    );
  `);
  await pool.query('create unique index if not exists plugins_filename_idx on plugins(filename)');
  await pool.query('create index if not exists plugins_enabled_idx on plugins(enabled) where enabled = true');

  await pool.query(`
    create table if not exists plugin_kv (
      plugin_id text not null references plugins(id) on delete cascade,
      key text not null,
      value bytea not null,
      expires_at timestamptz,
      updated_at timestamptz not null default now(),
      primary key (plugin_id, key)
    );
  `);
  await pool.query('create index if not exists plugin_kv_expiry_idx on plugin_kv(expires_at) where expires_at is not null');

  await pool.query(`
    create table if not exists plugin_runs (
      id bigserial primary key,
      plugin_id text not null references plugins(id) on delete cascade,
      export_name text not null,
      ok boolean not null,
      duration_ms integer not null,
      error text,
      logs jsonb not null default '[]'::jsonb,
      created_at timestamptz not null default now()
    );
  `);
  await pool.query('create index if not exists plugin_runs_plugin_created_idx on plugin_runs(plugin_id, created_at desc)');

  await pool.query(`
    create table if not exists plugin_media_requests (
      id text primary key,
      plugin_id text not null references plugins(id) on delete cascade,
      user_id text not null references users(id) on delete cascade,
      item_type text not null check (item_type in ('album', 'track')),
      artist text not null,
      title text not null,
      album text,
      musicbrainz_artist_id text,
      musicbrainz_release_group_id text,
      musicbrainz_release_id text,
      musicbrainz_recording_id text,
      status text not null check (status in (
        'requested', 'approved', 'submitted', 'completed', 'failed', 'rejected', 'cancelled'
      )),
      provider_request_id text,
      provider_error text,
      metadata jsonb not null default '{}'::jsonb,
      approved_by text references users(id) on delete set null,
      approved_at timestamptz,
      submitted_at timestamptz,
      completed_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  await pool.query(
    'create index if not exists plugin_media_requests_plugin_status_idx on plugin_media_requests(plugin_id, status, updated_at)'
  );
  await pool.query(
    'create index if not exists plugin_media_requests_user_created_idx on plugin_media_requests(user_id, created_at desc)'
  );

  // ========================================================================
  // USER PREFERENCES
  // ========================================================================

  await pool.query(`
    create table if not exists user_preferences (
      user_id text primary key references users(id) on delete cascade,
      auto_continue boolean not null default false,
      prefer_hls boolean not null default false,
      updated_at timestamptz not null default now()
    );
  `);

  // ========================================================================
  // POPULATE ASCII NAMES FOR ARTISTS (one-time migration - runs in background)
  // ========================================================================
  // Run asynchronously to not block server startup
  const dbPool = pool;  // Capture reference for closure
  setImmediate(async () => {
    try {
      let totalUpdated = 0;
      while (true) {
        const artistsToUpdate = await dbPool.query<{ id: number | string; name: string }>(
          `SELECT id, name FROM artists WHERE ascii_name IS NULL AND name IS NOT NULL LIMIT 500`
        );
        if (artistsToUpdate.rows.length === 0) break;
        if (totalUpdated === 0) {
          console.log(`[db] Populating ascii_name for artists (background)...`);
        }
        await dbPool.query(
          `UPDATE artists AS artist
              SET ascii_name = incoming.ascii_name
             FROM unnest($1::bigint[], $2::text[]) AS incoming(id, ascii_name)
            WHERE artist.id = incoming.id`,
          [
            artistsToUpdate.rows.map((artist) => artist.id),
            artistsToUpdate.rows.map((artist) => asciiFold(artist.name)),
          ]
        );
        totalUpdated += artistsToUpdate.rows.length;
      }
      if (totalUpdated > 0) {
        console.log(`[db] Updated ascii_name for ${totalUpdated} artists`);
      }
    } catch (e) {
      console.error('[db] Error populating ascii_name:', e);
    }
  });
}

export async function audit(event: string, meta?: Record<string, unknown>) {
  await db().query('insert into audit_events(event, meta) values ($1, $2)', [event, meta ?? null]);
}

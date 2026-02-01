import { Pool } from 'pg';
import Redis from 'ioredis';

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
      added_at timestamptz not null default now(),
      primary key (playlist_id, track_id)
    );
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

  await pool.query(`
    create table if not exists libraries (
      id bigserial primary key,
      mount_path text not null unique,
      created_at timestamptz not null default now()
    );
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
  await pool.query('alter table tracks add column if not exists album_artist text');
  await pool.query('alter table tracks add column if not exists genre text');
  await pool.query('alter table tracks add column if not exists country text');
  await pool.query('alter table tracks add column if not exists language text');
  await pool.query('alter table tracks add column if not exists year integer');

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

  await pool.query(`
    create table if not exists track_artists (
      track_id bigint not null references tracks(id) on delete cascade,
      artist_id bigint not null references artists(id) on delete cascade,
      role text not null check (role in ('artist','albumartist')),
      primary key (track_id, artist_id, role)
    );
  `);

  await pool.query('create index if not exists track_artists_artist_role_idx on track_artists(artist_id, role)');
  await pool.query('create index if not exists track_artists_track_role_idx on track_artists(track_id, role)');

  // Track genres table for smart playlists
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

  // Migrate to mount-based libraries (default: /music)
  await pool.query("insert into libraries(mount_path) values ('/music') on conflict (mount_path) do nothing");
  await pool.query("update tracks set library_id = (select id from libraries where mount_path='/music') where library_id is null");

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

  // Ensure existing non-admin users have access to default library
  await pool.query(
    "insert into user_libraries(user_id, library_id) select u.id, (select id from libraries where mount_path='/music') from users u where u.role='user' on conflict do nothing"
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

  // Search logs for "Because you searched" recommendations
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

  // Track tempo/bpm for tempo-based recommendations
  await pool.query('alter table tracks add column if not exists bpm real');
  await pool.query('create index if not exists tracks_bpm_idx on tracks(bpm) where bpm is not null');

  // Add created_at to tracks for sorting by date added
  await pool.query('alter table tracks add column if not exists created_at timestamptz not null default now()');
  await pool.query('create index if not exists tracks_created_at_idx on tracks(created_at desc)');

  // Recreate active_tracks view to include created_at
  await pool.query(`
    create or replace view active_tracks as
    select id, library_id, path, mtime_ms, size_bytes, ext, title, artist, album, duration_ms,
           last_seen_job_id, updated_at, art_path, art_mime, art_hash, lyrics_path, album_artist,
           genre, country, language, year, bpm, deleted_at, track_number, track_total, 
           disc_number, disc_total, created_at
    from tracks where deleted_at is null
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
      link text,
      published_at timestamptz,
      downloaded_path text,
      downloaded_at timestamptz,
      created_at timestamptz not null default now(),
      unique(podcast_id, guid)
    );
  `);
  await pool.query('create index if not exists podcast_episodes_podcast_idx on podcast_episodes(podcast_id, published_at desc)');

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
}

export async function audit(event: string, meta?: Record<string, unknown>) {
  await db().query('insert into audit_events(event, meta) values ($1, $2)', [event, meta ?? null]);
}

#!/usr/bin/env sh
set -e

mkdir -p /data/redis /meili_data /data/caddy /config/caddy \
  /lyrics /art /hls /podcasts /avatars /run/postgresql
chown -R postgres:postgres /run/postgresql || true

# If redis persistence from an older/newer redis version is incompatible, move it aside.
if ls /data/redis/*.rdb /data/redis/appendonly* >/dev/null 2>&1; then
  TS="$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "/data/redis/incompatible-$TS"
  mv /data/redis/*.rdb /data/redis/appendonly* "/data/redis/incompatible-$TS/" 2>/dev/null || true
fi

# Some older images/volumes ended up with a nested layout: /var/lib/postgresql/data/data/*.
# If we detect that, migrate it up one level so Postgres uses the expected PGDATA.
if [ ! -s /var/lib/postgresql/data/PG_VERSION ] && [ -s /var/lib/postgresql/data/data/PG_VERSION ]; then
  echo "Detected nested Postgres data dir; migrating to /var/lib/postgresql/data" >&2
  (cd /var/lib/postgresql/data/data && for f in * .*; do
    [ "$f" = "." ] || [ "$f" = ".." ] || mv "$f" .. 2>/dev/null || true
  done)
  rmdir /var/lib/postgresql/data/data 2>/dev/null || true
fi

# If the only thing in the directory is an empty nested 'data' folder, remove it.
if [ ! -s /var/lib/postgresql/data/PG_VERSION ] && [ -d /var/lib/postgresql/data/data ] && [ -z "$(ls -A /var/lib/postgresql/data/data 2>/dev/null || true)" ]; then
  rmdir /var/lib/postgresql/data/data 2>/dev/null || true
fi

if [ ! -s /var/lib/postgresql/data/PG_VERSION ]; then
  mkdir -p /var/lib/postgresql/data
  chown -R postgres:postgres /var/lib/postgresql/data
  su-exec postgres initdb -D /var/lib/postgresql/data --auth-host=scram-sha-256 --auth-local=trust >/dev/null

  su-exec postgres postgres -D /var/lib/postgresql/data -p 5432 -k /tmp &
  PID=$!

  for i in $(seq 1 60); do
    if su-exec postgres pg_isready -h /tmp -p 5432 >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done

  # Create role if needed
  su-exec postgres psql -h /tmp -p 5432 -v ON_ERROR_STOP=1 postgres <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mvbar') THEN
    CREATE ROLE mvbar LOGIN PASSWORD 'mvbar';
  END IF;
END$$;
SQL

  # CREATE DATABASE cannot run inside a DO block.
  if ! su-exec postgres psql -h /tmp -p 5432 -tAc "SELECT 1 FROM pg_database WHERE datname='mvbar'" postgres | grep -q 1; then
    su-exec postgres createdb -h /tmp -p 5432 -O mvbar mvbar
  fi

  kill "$PID"
  wait "$PID" || true
fi

chown -R postgres:postgres /var/lib/postgresql/data

exec "$@"

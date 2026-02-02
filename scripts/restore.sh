#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

BACKUP_DIR="${1:-}"
if [[ -z "$BACKUP_DIR" || ! -d "$BACKUP_DIR" ]]; then
  echo "usage: $0 <backup-dir>" >&2
  exit 2
fi

for f in postgres.sql.gz meili_data.tgz redis_data.tgz media_aux.tgz caddy_data.tgz; do
  if [[ ! -f "$BACKUP_DIR/$f" ]]; then
    echo "missing $BACKUP_DIR/$f" >&2
    exit 2
  fi
done

echo "[restore] stopping app services"
docker compose stop app >/dev/null || true

echo "[restore] starting data services"
docker compose up -d app >/dev/null

# Postgres restore (drop all objects by resetting schema)
zcat "$BACKUP_DIR/postgres.sql.gz" | docker compose exec -T app psql -U mvbar -d mvbar -v ON_ERROR_STOP=1 -c 'drop schema if exists public cascade; create schema public;' >/dev/null
zcat "$BACKUP_DIR/postgres.sql.gz" | docker compose exec -T app psql -U mvbar -d mvbar -v ON_ERROR_STOP=1 >/dev/null

# Volumes restore (destructive)
cat "$BACKUP_DIR/meili_data.tgz" | docker compose exec -T app sh -lc 'rm -rf /meili_data/* && tar -xzf - -C /' >/dev/null
cat "$BACKUP_DIR/redis_data.tgz" | docker compose exec -T app sh -lc 'rm -rf /data/* && tar -xzf - -C /' >/dev/null
cat "$BACKUP_DIR/media_aux.tgz" | docker compose exec -T app sh -lc 'rm -rf /lyrics/* /art/* && tar -xzf - -C /' >/dev/null
cat "$BACKUP_DIR/caddy_data.tgz" | docker compose exec -T app sh -lc 'rm -rf /data/* /config/* && tar -xzf - -C /' >/dev/null

echo "[restore] starting full stack"
docker compose up -d >/dev/null

echo "[restore] done"

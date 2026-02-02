#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${1:-./backups/$TS}"
mkdir -p "$OUT_DIR"

echo "[backup] writing to $OUT_DIR"

docker compose exec -T app pg_dump -U mvbar -d mvbar | gzip -9 >"$OUT_DIR/postgres.sql.gz"

docker compose exec -T app sh -lc 'tar -czf - -C / meili_data' >"$OUT_DIR/meili_data.tgz"
docker compose exec -T app sh -lc 'tar -czf - -C / data' >"$OUT_DIR/redis_data.tgz"
docker compose exec -T app sh -lc 'tar -czf - -C / lyrics art' >"$OUT_DIR/media_aux.tgz"
docker compose exec -T app sh -lc 'tar -czf - -C / data config' >"$OUT_DIR/caddy_data.tgz"

cp -f docker-compose.yml "$OUT_DIR/docker-compose.yml"
cp -f infra/caddy/Caddyfile "$OUT_DIR/Caddyfile"

echo "[backup] done"

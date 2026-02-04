# Copilot instructions (mvbar)

## Build / run commands

### Docker (single-container, recommended)
- Create env:
  - `cp .env.example .env` (set `JWT_SECRET`, `MEILI_MASTER_KEY`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`)
- Build image locally:
  - `docker compose build`
- Run:
  - `docker compose up -d`
- Logs / health:
  - `docker compose logs -f app`
  - `curl -fsS http://localhost/health`
  - `curl -fsS http://localhost/api/health`

### CI-equivalent builds (per package)
> CI runs Node **22** and builds each package independently.
- API:
  - `cd api && npm ci && npm run build`
- Worker:
  - `cd worker && npm ci && npm run build`
- Web:
  - `cd web && npm ci && npm run build`

### Dev scripts (per package)
- API: `cd api && npm ci && npm run dev`
- Worker: `cd worker && npm ci && npm run dev`
- Web: `cd web && npm ci && npm run dev` (Next on `:3000`)

## High-level architecture

### “All-in-one” container runtime
- The shipped image runs **everything in one container** (see `Dockerfile`, `infra/supervisord.conf`):
  - Caddy (front door) + Next.js web
  - Fastify API
  - Worker process
  - Postgres + Redis + Meilisearch
  - `ffmpeg` for transcoding
- `infra/entrypoint.sh` bootstraps Postgres data dir and creates the `mvbar` role/db if missing.

### Request routing (Caddy + Next route proxies)
- Caddy is the public entrypoint (see `infra/caddy/Caddyfile`). Key routes:
  - `/api/*` -> API (Fastify)
  - `/rest/*` -> API (Subsonic-style endpoints)
  - **Streaming / HLS go through Next** so the browser uses the auth cookie:
    - `/api/stream/*` -> Next route -> API
    - `/api/hls/*` -> Next route -> API (except `/api/hls/:id/(request|status)` goes directly to API)
- Next route handlers live in `web/app/api/**/route.ts` and forward the `mvbar_token` cookie as a `Bearer` header to the API.

### Data flow (scan -> DB -> search -> UI)
- **Postgres is the source of truth** for users, libraries, tracks, playlists, history, etc. Schema/migrations are “ensure-on-start” SQL in `api/src/db.ts`.
- **Worker responsibilities** (`worker/src/index.ts`):
  - Library scanning (default: periodic fast scan; can be triggered via Redis pub/sub)
  - Tag extraction + optional artwork/lyrics caching
  - Meilisearch indexing (`worker/src/indexer.ts`)
  - Background HLS transcode job processing (`worker/src/transcoder.ts`)
- **Redis** is used for:
  - Pub/sub commands: `library:commands` (API -> worker rescan)
  - Pub/sub updates: `library:updates` (worker -> live UI updates)
  - Scan progress key: `scan:progress`
- **Web UI** (Next + Zustand) consumes REST-ish JSON endpoints under `/api/*` and uses a websocket at `/api/ws` for live updates (`web/app/useWebSocket.ts`).

### HLS transcoding
- API (`api/src/hls.ts`) enqueues `transcode_jobs` keyed by a cache key derived from track id + mtime + size.
- Worker runs `ffmpeg` to produce `index.m3u8` + `seg_*.ts` under `HLS_DIR` (default `/hls`) and publishes atomically.

## Key conventions (repo-specific)

### Environment variables / paths
- Required secrets are documented in `.env.example`.
- Runtime defaults and important vars:
  - API: `PORT` (container uses `API_PORT=3001`), `JWT_SECRET`, `COOKIE_NAME` (default `mvbar_token`), `COOKIE_SECURE`, `TRUST_PROXY`
  - DB/Search: `DATABASE_URL`, `REDIS_URL`, `MEILI_HOST`, `MEILI_MASTER_KEY`
  - Worker: `MUSIC_DIRS` (comma-separated; defaults to `/music`), `RESCAN_INTERVAL_MS`, `FAST_SCAN`
  - Caches/outputs: `ART_DIR` (`/data/cache/art`), `LYRICS_DIR` (`/data/cache/lyrics`), `HLS_DIR` (`/hls`), podcasts under `/podcasts`
  - Web -> API internal calls from Next route handlers: `API_INTERNAL_BASE` (compose sets `http://127.0.0.1:3001`)

### Track paths are stored relative to a mount
- Libraries are modeled as mount points (`libraries.mount_path`). Track rows store `path` **relative to that mount**.
- When accessing files on disk, use the existing `safeJoin` / `safeJoinMount` helpers (path traversal protection) instead of naïve `path.join`.

### Auth expectations
- API accepts auth via `Authorization: Bearer <token>` or via the `mvbar_token` cookie.
- Many endpoints are under `/api/...`; admin-only endpoints are under `/api/admin/...`.

### Search index
- Meilisearch index name is `tracks`.
- Settings for searchable/filterable/sortable attributes are centralized in `worker/src/indexer.ts`.

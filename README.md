<p align="center">
  <img src="mvbar-logo.png" alt="mvbar" width="520" />
</p>

# mvbar

**mvbar** is a self‑hosted, local‑first music player for your own library — a fast “Spotify‑like” web UI that runs entirely on your server.

It’s designed to be simple to deploy: **one Docker container** includes the web UI, API, background worker, and all required services (Postgres, Redis, Meilisearch, and Caddy).

## Highlights
- Fast library search and browsing (Meilisearch)
- Background scanning/indexing (worker)
- Single-container deployment (easy backups + portability)

## Deployment (Docker Compose)

### Prerequisites
- Docker + Docker Compose (`docker compose`)

### 1) Create your `.env`

```bash
cp .env.example .env
# edit .env and set strong values
```

Minimum recommended secrets:
- `JWT_SECRET` (long random string)
- `MEILI_MASTER_KEY` (**>= 16 characters**)
- `ADMIN_EMAIL`, `ADMIN_PASSWORD` (first admin bootstrap)

### 2) Create `docker-compose.yml`

Use `mars148/mvbar:latest` for stable (default branch builds) or `mars148/mvbar:dev` for the development branch.

```yaml
name: mvbar

services:
  app:
    image: mars148/mvbar:latest
    restart: unless-stopped
    ports:
      - "80:80"      # HTTP
      - "443:443"    # HTTPS (optional)

    environment:
      TZ: Europe/London

      # Internal (single-container) connection strings
      DATABASE_URL: postgresql://mvbar:mvbar@127.0.0.1:5432/mvbar
      REDIS_URL: redis://127.0.0.1:6379
      MEILI_HOST: http://127.0.0.1:7700
      MEILI_MASTER_KEY: ${MEILI_MASTER_KEY}

      # App config
      JWT_SECRET: ${JWT_SECRET}
      ADMIN_EMAIL: ${ADMIN_EMAIL}
      ADMIN_PASSWORD: ${ADMIN_PASSWORD}
      TRUST_PROXY: ${TRUST_PROXY:-true}
      COOKIE_SECURE: ${COOKIE_SECURE:-auto}
      COOKIE_NAME: ${COOKIE_NAME:-mvbar_token}
      APP_DOMAIN: ${APP_DOMAIN:-}

      # Optional integrations
      LASTFM_API_KEY: ${LASTFM_API_KEY:-}
      GOOGLE_CLIENT_ID: ${GOOGLE_CLIENT_ID:-}
      GOOGLE_CLIENT_SECRET: ${GOOGLE_CLIENT_SECRET:-}
      GOOGLE_CALLBACK_URL: ${GOOGLE_CALLBACK_URL:-}

      # Worker
      # Mount your music below and list the container paths here.
      MUSIC_DIRS: /music,/music2

      # Web -> API internal calls
      API_INTERNAL_BASE: http://127.0.0.1:3001

    volumes:
      # Mount your music (edit these)
      - /path/to/music:/music:ro
      - /path/to/music2:/music2:ro

      # Persistent app data
      - pg:/var/lib/postgresql/data
      - redis:/data/redis
      - meili:/meili_data
      - caddy_data:/data/caddy
      - caddy_config:/config/caddy
      - cache:/data/cache
      - hls:/hls
      - podcasts:/podcasts

    healthcheck:
      test: ["CMD-SHELL", "curl -fsS http://localhost/health >/dev/null"]
      interval: 10s
      timeout: 5s
      retries: 15

volumes:
  pg:
  redis:
  meili:
  caddy_data:
  caddy_config:
  cache:
  hls:
  podcasts:
```

### 3) Start

```bash
docker compose up -d
```

Open:
- http://localhost

### First login
- Email: `ADMIN_EMAIL` from `.env`
- Password: `ADMIN_PASSWORD` from `.env`

Note: `ADMIN_PASSWORD` is only used to bootstrap the very first admin user when the database is empty. After first run, manage users/passwords in the UI.

## Operations

### Update

```bash
docker compose pull
docker compose up -d
```

### Logs & health

```bash
docker compose logs -f app
curl -fsS http://localhost/health
curl -fsS http://localhost/api/health
```

### Backup / restore

```bash
./scripts/backup.sh
./scripts/restore.sh ./backups/<timestamp>
```

## Reverse proxy notes (optional)

If you run behind an external reverse proxy / TLS terminator, set:
- `TRUST_PROXY=true`
- `COOKIE_SECURE=auto` (default)

## Development (short)

Repo layout:
- `api/` – backend
- `web/` – frontend
- `worker/` – background jobs
- `infra/` – container runtime (Caddy + supervisord)

Build the image locally:

```bash
docker compose build
```

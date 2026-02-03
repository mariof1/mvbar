# mvbar (all-in-one)

mvbar is a self-hosted, local-first music player for your own library with a fast “Spotify-like” web UI.

This image is **all-in-one**: web UI + API + worker + Postgres + Redis + Meilisearch + Caddy in a single container.

## Quick start (Docker Compose)

1) Create `.env`:

```bash
cp .env.example .env
# edit .env and set strong values
```

2) `docker-compose.yml`:

```yaml
name: mvbar

services:
  app:
    image: mars148/mvbar:latest
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"    # optional

    environment:
      TZ: Europe/London

      DATABASE_URL: postgresql://mvbar:mvbar@127.0.0.1:5432/mvbar
      REDIS_URL: redis://127.0.0.1:6379
      MEILI_HOST: http://127.0.0.1:7700
      MEILI_MASTER_KEY: ${MEILI_MASTER_KEY}

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

      MUSIC_DIRS: /music,/music2
      API_INTERNAL_BASE: http://127.0.0.1:3001

    volumes:
      - /path/to/music:/music:ro
      - /path/to/music2:/music2:ro

      - pg:/var/lib/postgresql/data
      - redis:/data/redis
      - meili:/meili_data
      - caddy_data:/data/caddy
      - caddy_config:/config/caddy
      - cache:/data/cache
      - hls:/hls
      - podcasts:/podcasts

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

3) Start:

```bash
docker compose up -d
```

Open: `http://localhost`

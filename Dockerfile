# Single-container image: web + api + worker + caddy + postgres + redis + meilisearch

# Build args for version info
ARG APP_VERSION=0.0.0-dev
ARG GIT_COMMIT=unknown
ARG GIT_BRANCH=unknown
ARG BUILD_DATE=unknown

FROM node:22-alpine AS api_builder
WORKDIR /src/api
COPY api/package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY api/ .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS worker_builder
WORKDIR /src/worker
RUN apk add --no-cache ffmpeg
COPY worker/package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY worker/ .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS web_builder
WORKDIR /src/web
# Avoid QEMU SIGILL when building multi-arch images in CI (use portable SWC/WASM)
# Cache bust: 2026-02-05-v2
ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_DISABLE_SWC_BINARY=1
COPY web/package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY web/ .
RUN npm run build

FROM alpine:3.20

# Re-declare args to use in final stage
ARG APP_VERSION
ARG GIT_COMMIT
ARG GIT_BRANCH
ARG BUILD_DATE

RUN apk add --no-cache \
    nodejs \
    npm \
    caddy \
    postgresql16 postgresql16-contrib \
    redis \
    meilisearch \
    curl \
    supervisor \
    bash \
    su-exec \
    tzdata \
    ffmpeg \
    ca-certificates

ENV NODE_ENV=production \
    TZ=Europe/London \
    API_PORT=3001 \
    WEB_PORT=3000 \
    MEILI_PORT=7700 \
    REDIS_PORT=6379 \
    POSTGRES_PORT=5432 \
    APP_VERSION=${APP_VERSION} \
    GIT_COMMIT=${GIT_COMMIT} \
    GIT_BRANCH=${GIT_BRANCH} \
    BUILD_DATE=${BUILD_DATE}

WORKDIR /app

COPY --from=api_builder /src/api/package.json /app/api/package.json
COPY --from=api_builder /src/api/node_modules /app/api/node_modules
COPY --from=api_builder /src/api/dist /app/api/dist

COPY --from=worker_builder /src/worker/package.json /app/worker/package.json
COPY --from=worker_builder /src/worker/node_modules /app/worker/node_modules
COPY --from=worker_builder /src/worker/dist /app/worker/dist

COPY --from=web_builder /src/web/package.json /app/web/package.json
COPY --from=web_builder /src/web/node_modules /app/web/node_modules
COPY --from=web_builder /src/web/.next /app/web/.next
COPY --from=web_builder /src/web/public /app/web/public

COPY infra/caddy/Caddyfile /etc/caddy/Caddyfile
COPY infra/supervisord.conf /etc/supervisord.conf
COPY infra/entrypoint.sh /entrypoint.sh
COPY infra/wait-for-http.sh /app/infra/wait-for-http.sh
RUN chmod +x /entrypoint.sh /app/infra/wait-for-http.sh

VOLUME ["/var/lib/postgresql/data", "/data/redis", "/meili_data", "/data/caddy", "/config/caddy", "/data/cache", "/hls", "/podcasts"]

EXPOSE 80 443

ENTRYPOINT ["/entrypoint.sh"]
CMD ["/usr/bin/supervisord","-c","/etc/supervisord.conf"]

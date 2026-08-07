#!/bin/sh
set -eu

if [ -z "${MVBAR_HOME:-}" ] || [ -z "${MVBAR_APP_ROOT:-}" ]; then
  printf '%s\n' "MVBar: this controller must be started through the standalone executable" >&2
  exit 1
fi

APP_ROOT=$MVBAR_APP_ROOT
BUILD_ID=${MVBAR_BUILD_ID:-unknown}
HOME_ROOT=$MVBAR_HOME
USER_HOME=${HOME:-$HOME_ROOT}
DATA_ROOT=$HOME_ROOT/data
LOG_ROOT=$HOME_ROOT/logs
RUN_ROOT=$HOME_ROOT/run
CONFIG_PATH=$HOME_ROOT/config.env
CREDENTIALS_PATH=$HOME_ROOT/credentials.txt
PID_PATH=$RUN_ROOT/supervisor.pid
READY_PATH=$RUN_ROOT/ready
ERROR_PATH=$RUN_ROOT/error
URL_PATH=$HOME_ROOT/runtime.url

NODE=$APP_ROOT/runtime/node/node
PG_BIN=$APP_ROOT/runtime/postgres/bin
REDIS_SERVER=$APP_ROOT/runtime/redis/redis-server
MEILISEARCH=$APP_ROOT/runtime/meili/meilisearch
FFMPEG_BIN=$APP_ROOT/runtime/ffmpeg
RUNTIME_LIB=$APP_ROOT/runtime/lib:$APP_ROOT/runtime/postgres/lib
HELPER=$APP_ROOT/app/helper.cjs

PID_POSTGRES=
PID_REDIS=
PID_MEILI=
PID_API=
PID_WORKER=
PID_WEB=
PID_PROXY=

say() {
  printf '%s\n' "$*"
}

fail() {
  printf 'MVBar: %s\n' "$*" >&2
  exit 1
}

runtime() {
  LD_LIBRARY_PATH=$RUNTIME_LIB "$@"
}

config_get() {
  awk -v wanted="$1" '
    /^[[:space:]]*#/ { next }
    {
      separator = index($0, "=")
      if (separator < 2) next
      key = substr($0, 1, separator - 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", key)
      if (key == wanted) {
        print substr($0, separator + 1)
        exit
      }
    }
  ' "$CONFIG_PATH"
}

random_hex() {
  od -An -N "$1" -tx1 /dev/urandom | tr -d ' \n'
}

create_config() {
  [ -f "$CONFIG_PATH" ] && return

  mkdir -p "$USER_HOME/Music"
  admin_password=$(random_hex 14)
  database_password=$(random_hex 18)
  jwt_secret=$(random_hex 48)
  meili_key=$(random_hex 32)

  umask 077
  {
    say "# MVBar Standalone settings"
    say "# Multiple media folders are comma separated. Restart after editing."
    say "ADMIN_EMAIL=admin@local"
    say "ADMIN_PASSWORD=$admin_password"
    say "DATABASE_PASSWORD=$database_password"
    say "JWT_SECRET=$jwt_secret"
    say "MEILI_MASTER_KEY=$meili_key"
    say "MUSIC_DIRS=$USER_HOME/Music"
    say "AUDIOBOOK_DIRS="
    say "LISTEN_HOST=127.0.0.1"
    say "PORT=8080"
  } > "$CONFIG_PATH"

  {
    say "MVBar Standalone administrator"
    say "Email: admin@local"
    say "Password: $admin_password"
  } > "$CREDENTIALS_PATH"
  chmod 600 "$CONFIG_PATH" "$CREDENTIALS_PATH"
}

load_config() {
  create_config
  ADMIN_EMAIL=$(config_get ADMIN_EMAIL)
  ADMIN_PASSWORD=$(config_get ADMIN_PASSWORD)
  DATABASE_PASSWORD=$(config_get DATABASE_PASSWORD)
  JWT_SECRET=$(config_get JWT_SECRET)
  MEILI_MASTER_KEY=$(config_get MEILI_MASTER_KEY)
  MUSIC_DIRS=$(config_get MUSIC_DIRS)
  AUDIOBOOK_DIRS=$(config_get AUDIOBOOK_DIRS)
  LISTEN_HOST=$(config_get LISTEN_HOST)
  CONFIGURED_PORT=$(config_get PORT)

  [ -n "$ADMIN_EMAIL" ] || fail "ADMIN_EMAIL is empty in $CONFIG_PATH"
  [ -n "$ADMIN_PASSWORD" ] || fail "ADMIN_PASSWORD is empty in $CONFIG_PATH"
  [ -n "$DATABASE_PASSWORD" ] || fail "DATABASE_PASSWORD is empty in $CONFIG_PATH"
  [ -n "$JWT_SECRET" ] || fail "JWT_SECRET is empty in $CONFIG_PATH"
  [ -n "$MEILI_MASTER_KEY" ] || fail "MEILI_MASTER_KEY is empty in $CONFIG_PATH"
  [ -n "$MUSIC_DIRS" ] || fail "MUSIC_DIRS is empty in $CONFIG_PATH"
  [ -n "$LISTEN_HOST" ] || LISTEN_HOST=127.0.0.1
  case "$CONFIGURED_PORT" in
    ''|*[!0-9]*) fail "PORT must be an integer in $CONFIG_PATH" ;;
  esac
  if [ "$CONFIGURED_PORT" -lt 1 ] || [ "$CONFIGURED_PORT" -gt 65535 ]; then
    fail "PORT must be between 1 and 65535 in $CONFIG_PATH"
  fi
}

create_directories() {
  umask 077
  mkdir -p \
    "$DATA_ROOT/postgres" \
    "$DATA_ROOT/redis" \
    "$DATA_ROOT/meili" \
    "$DATA_ROOT/cache/lyrics" \
    "$DATA_ROOT/cache/art" \
    "$DATA_ROOT/cache/avatars" \
    "$DATA_ROOT/cache/podcast-art" \
    "$DATA_ROOT/cache/audiobook-art" \
    "$DATA_ROOT/hls" \
    "$DATA_ROOT/podcasts" \
    "$DATA_ROOT/device-logs" \
    "$LOG_ROOT" \
    "$RUN_ROOT" \
    "$RUN_ROOT/postgres"
}

pid_is_running() {
  [ -f "$PID_PATH" ] || return 1
  running_pid=$(cat "$PID_PATH" 2>/dev/null || true)
  case "$running_pid" in
    ''|*[!0-9]*) return 1 ;;
  esac
  kill -0 "$running_pid" 2>/dev/null || return 1
  [ -r "/proc/$running_pid/cmdline" ] || return 1
  running_command=$(tr '\000' ' ' < "/proc/$running_pid/cmdline")
  case "$running_command" in
    *"$HOME_ROOT/app/"*"/app/mvbar.sh"*) return 0 ;;
    *) return 1 ;;
  esac
}

find_port() {
  runtime "$NODE" "$HELPER" find-port "$1" 60
}

wait_tcp() {
  runtime "$NODE" "$HELPER" tcp 127.0.0.1 "$1" "$2"
}

wait_http() {
  runtime "$NODE" "$HELPER" http "$1" "$2"
}

initialize_postgres() {
  if [ -s "$DATA_ROOT/postgres/PG_VERSION" ]; then
    return
  fi
  say "Initializing PostgreSQL..."
  chmod 700 "$DATA_ROOT/postgres"
  runtime "$PG_BIN/initdb" \
    --pgdata "$DATA_ROOT/postgres" \
    --username postgres \
    --auth trust \
    --encoding UTF8 \
    --locale C >> "$LOG_ROOT/postgres-init.log" 2>&1
}

prepare_database() {
  role_exists=$(runtime "$PG_BIN/psql" \
    -h 127.0.0.1 -p "$PG_PORT" -U postgres -d postgres \
    -tAc "SELECT 1 FROM pg_roles WHERE rolname='mvbar'" | tr -d '[:space:]')
  if [ "$role_exists" != "1" ]; then
    runtime "$PG_BIN/createuser" \
      -h 127.0.0.1 -p "$PG_PORT" -U postgres --login mvbar
  fi

  runtime "$PG_BIN/psql" \
    -h 127.0.0.1 -p "$PG_PORT" -U postgres -d postgres \
    -v ON_ERROR_STOP=1 \
    -c "ALTER ROLE mvbar PASSWORD '$DATABASE_PASSWORD';" >/dev/null

  database_exists=$(runtime "$PG_BIN/psql" \
    -h 127.0.0.1 -p "$PG_PORT" -U postgres -d postgres \
    -tAc "SELECT 1 FROM pg_database WHERE datname='mvbar'" | tr -d '[:space:]')
  if [ "$database_exists" != "1" ]; then
    runtime "$PG_BIN/createdb" \
      -h 127.0.0.1 -p "$PG_PORT" -U postgres --owner mvbar mvbar
  fi
}

export_application_environment() {
  export DATABASE_URL="postgresql://mvbar:$DATABASE_PASSWORD@127.0.0.1:$PG_PORT/mvbar"
  export REDIS_URL="redis://127.0.0.1:$REDIS_PORT"
  export MEILI_HOST="http://127.0.0.1:$MEILI_PORT"
  export MEILI_MASTER_KEY JWT_SECRET ADMIN_EMAIL ADMIN_PASSWORD MUSIC_DIRS AUDIOBOOK_DIRS
  export LYRICS_DIR="$DATA_ROOT/cache/lyrics"
  export ART_DIR="$DATA_ROOT/cache/art"
  export AVATARS_DIR="$DATA_ROOT/cache/avatars"
  export HLS_DIR="$DATA_ROOT/hls"
  export PODCAST_DIR="$DATA_ROOT/podcasts"
  export PODCAST_ART_DIR="$DATA_ROOT/cache/podcast-art"
  export AUDIOBOOK_ART_DIR="$DATA_ROOT/cache/audiobook-art"
  export DEVICE_LOG_DIR="$DATA_ROOT/device-logs"
  export COOKIE_SECURE=false
  export TRUST_PROXY=true
  export LIBRARY_READ_ONLY=1
  export FAST_SCAN=1
  export UV_THREADPOOL_SIZE=16
  export SCAN_CONCURRENCY=8
  export METADATA_TIMEOUT_MS=300000
  export RESCAN_INTERVAL_MS=3600000
  export TEMPO_DETECT=0
  export LOG_LEVEL=info
  export NODE_ENV=production
  export APP_VERSION="standalone-$BUILD_ID"
  export GIT_COMMIT="$BUILD_ID"
  export GIT_BRANCH=linux-standalone
  BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  export BUILD_DATE
  export PATH="$FFMPEG_BIN:$PG_BIN:$PATH"
}

start_services() {
  initialize_postgres

  say "Starting PostgreSQL..."
  env LD_LIBRARY_PATH="$RUNTIME_LIB" "$PG_BIN/postgres" \
    -D "$DATA_ROOT/postgres" \
    -p "$PG_PORT" \
    -h 127.0.0.1 \
    -k "$RUN_ROOT/postgres" > "$LOG_ROOT/postgres.log" 2>&1 &
  PID_POSTGRES=$!
  wait_tcp "$PG_PORT" 60
  prepare_database

  say "Starting Redis..."
  env LD_LIBRARY_PATH="$RUNTIME_LIB" "$REDIS_SERVER" \
    --bind 127.0.0.1 \
    --port "$REDIS_PORT" \
    --dir "$DATA_ROOT/redis" \
    --appendonly yes \
    --protected-mode yes \
    --daemonize no > "$LOG_ROOT/redis.log" 2>&1 &
  PID_REDIS=$!
  wait_tcp "$REDIS_PORT" 60

  say "Starting Meilisearch..."
  env \
    LD_LIBRARY_PATH="$RUNTIME_LIB" \
    MEILI_MASTER_KEY="$MEILI_MASTER_KEY" \
    MEILI_HTTP_ADDR="127.0.0.1:$MEILI_PORT" \
    MEILI_DB_PATH="$DATA_ROOT/meili" \
    MEILI_ENV=production \
    MEILI_NO_ANALYTICS=true \
    "$MEILISEARCH" > "$LOG_ROOT/meilisearch.log" 2>&1 &
  PID_MEILI=$!
  wait_http "http://127.0.0.1:$MEILI_PORT/health" 120

  export_application_environment

  say "Starting MVBar API..."
  (
    cd "$APP_ROOT/app/api"
    exec env LD_LIBRARY_PATH="$RUNTIME_LIB" PORT="$API_PORT" HOST=127.0.0.1 \
      "$NODE" dist/index.js
  ) > "$LOG_ROOT/api.log" 2>&1 &
  PID_API=$!
  wait_http "http://127.0.0.1:$API_PORT/health" 180

  say "Starting the library worker..."
  (
    cd "$APP_ROOT/app/worker"
    exec env LD_LIBRARY_PATH="$RUNTIME_LIB" "$NODE" dist/index.js
  ) > "$LOG_ROOT/worker.log" 2>&1 &
  PID_WORKER=$!
  sleep 2
  kill -0 "$PID_WORKER" 2>/dev/null || fail "The library worker stopped during startup"

  say "Starting the MVBar web interface..."
  (
    cd "$APP_ROOT/app/web"
    exec env LD_LIBRARY_PATH="$RUNTIME_LIB" \
      PORT="$WEB_PORT" HOSTNAME=127.0.0.1 \
      API_INTERNAL_BASE="http://127.0.0.1:$API_PORT" \
      "$NODE" server.js
  ) > "$LOG_ROOT/web.log" 2>&1 &
  PID_WEB=$!
  wait_http "http://127.0.0.1:$WEB_PORT/" 180

  say "Starting the local gateway..."
  (
    cd "$APP_ROOT"
    exec env LD_LIBRARY_PATH="$RUNTIME_LIB" \
      MVBAR_PROXY_HOST="$LISTEN_HOST" \
      MVBAR_PROXY_PORT="$PUBLIC_PORT" \
      MVBAR_API_PORT="$API_PORT" \
      MVBAR_WEB_PORT="$WEB_PORT" \
      "$NODE" app/proxy.js
  ) > "$LOG_ROOT/proxy.log" 2>&1 &
  PID_PROXY=$!
  wait_http "http://127.0.0.1:$PUBLIC_PORT/health" 60
}

stop_one() {
  service_pid=$1
  [ -n "$service_pid" ] || return 0
  kill -TERM "$service_pid" 2>/dev/null || true
}

cleanup() {
  trap '' HUP INT TERM EXIT
  rm -f "$READY_PATH"
  stop_one "$PID_PROXY"
  stop_one "$PID_WEB"
  stop_one "$PID_WORKER"
  stop_one "$PID_API"
  stop_one "$PID_MEILI"
  stop_one "$PID_REDIS"
  stop_one "$PID_POSTGRES"

  deadline=$(( $(date +%s) + 20 ))
  for service_pid in "$PID_PROXY" "$PID_WEB" "$PID_WORKER" "$PID_API" "$PID_MEILI" "$PID_REDIS" "$PID_POSTGRES"; do
    [ -n "$service_pid" ] || continue
    while kill -0 "$service_pid" 2>/dev/null && [ "$(date +%s)" -lt "$deadline" ]; do
      sleep 1
    done
    if kill -0 "$service_pid" 2>/dev/null; then
      kill -KILL "$service_pid" 2>/dev/null || true
    fi
    wait "$service_pid" 2>/dev/null || true
  done

  if [ -f "$PID_PATH" ] && [ "$(cat "$PID_PATH" 2>/dev/null || true)" = "$$" ]; then
    rm -f "$PID_PATH"
  fi
  say "MVBar services stopped."
}

monitor_services() {
  while :; do
    sleep 2
    for service in \
      "$PID_POSTGRES:postgres" \
      "$PID_REDIS:redis" \
      "$PID_MEILI:meilisearch" \
      "$PID_API:api" \
      "$PID_WORKER:worker" \
      "$PID_WEB:web" \
      "$PID_PROXY:proxy"; do
      service_pid=${service%%:*}
      service_name=${service#*:}
      if ! kill -0 "$service_pid" 2>/dev/null; then
        say "Service stopped unexpectedly: $service_name" >&2
        say "$service_name stopped unexpectedly; see $LOG_ROOT/$service_name.log" > "$ERROR_PATH"
        return 1
      fi
    done
  done
}

supervise() {
  create_directories
  load_config
  if pid_is_running && [ "$(cat "$PID_PATH")" != "$$" ]; then
    fail "MVBar is already running with PID $(cat "$PID_PATH")"
  fi

  say "$$" > "$PID_PATH"
  rm -f "$READY_PATH" "$ERROR_PATH"
  trap 'exit 0' HUP INT TERM
  trap cleanup EXIT

  PG_PORT=$(find_port 55432)
  REDIS_PORT=$(find_port 56379)
  MEILI_PORT=$(find_port 57700)
  API_PORT=$(find_port 53001)
  WEB_PORT=$(find_port 53000)
  PUBLIC_PORT=$(find_port "$CONFIGURED_PORT")
  while [ "$PUBLIC_PORT" = "$PG_PORT" ] ||
        [ "$PUBLIC_PORT" = "$REDIS_PORT" ] ||
        [ "$PUBLIC_PORT" = "$MEILI_PORT" ] ||
        [ "$PUBLIC_PORT" = "$API_PORT" ] ||
        [ "$PUBLIC_PORT" = "$WEB_PORT" ]; do
    PUBLIC_PORT=$(find_port $((PUBLIC_PORT + 1)))
  done

  start_services

  runtime_url="http://127.0.0.1:$PUBLIC_PORT/"
  say "$runtime_url" > "$URL_PATH"
  say "$runtime_url" > "$READY_PATH"
  say "MVBar is ready: $runtime_url"
  say "Administrator credentials: $CREDENTIALS_PATH"
  monitor_services
}

start_background() {
  create_directories
  create_config
  if pid_is_running; then
    say "MVBar is already running (PID $(cat "$PID_PATH"))."
    status
    return
  fi

  rm -f "$READY_PATH" "$ERROR_PATH"
  nohup "$0" supervise >> "$LOG_ROOT/launcher.log" 2>&1 </dev/null &
  launched_pid=$!

  say "Starting MVBar (PID $launched_pid)..."
  attempts=0
  while [ "$attempts" -lt 300 ]; do
    if [ -s "$READY_PATH" ]; then
      say "MVBar is ready: $(cat "$READY_PATH")"
      say "Credentials: $CREDENTIALS_PATH"
      return
    fi
    if [ -s "$ERROR_PATH" ]; then
      fail "$(cat "$ERROR_PATH")"
    fi
    if ! kill -0 "$launched_pid" 2>/dev/null; then
      fail "Startup failed. See $LOG_ROOT/launcher.log"
    fi
    attempts=$((attempts + 1))
    sleep 1
  done
  fail "Startup timed out. See $LOG_ROOT/launcher.log"
}

stop_background() {
  if ! pid_is_running; then
    rm -f "$PID_PATH" "$READY_PATH"
    say "MVBar is not running."
    return
  fi

  running_pid=$(cat "$PID_PATH")
  say "Stopping MVBar (PID $running_pid)..."
  kill -TERM "$running_pid"
  attempts=0
  while kill -0 "$running_pid" 2>/dev/null && [ "$attempts" -lt 40 ]; do
    attempts=$((attempts + 1))
    sleep 1
  done
  if kill -0 "$running_pid" 2>/dev/null; then
    fail "MVBar did not stop cleanly; inspect $LOG_ROOT/launcher.log"
  fi
  rm -f "$PID_PATH" "$READY_PATH"
  say "MVBar stopped."
}

status() {
  if pid_is_running; then
    say "MVBar is running (PID $(cat "$PID_PATH"))."
    if [ -s "$URL_PATH" ]; then say "URL: $(cat "$URL_PATH")"; fi
    say "Build: $BUILD_ID"
    say "Data: $DATA_ROOT"
    say "Logs: $LOG_ROOT"
    return 0
  fi
  say "MVBar is stopped."
  say "Build: $BUILD_ID"
  return 1
}

show_logs() {
  service=${1:-launcher}
  case "$service" in
    launcher|postgres|redis|meilisearch|api|worker|web|proxy) ;;
    *) fail "Unknown log '$service'" ;;
  esac
  log_path=$LOG_ROOT/$service.log
  [ -f "$log_path" ] || fail "Log does not exist yet: $log_path"
  exec tail -n 100 -f "$log_path"
}

show_help() {
  say "MVBar Standalone for Linux"
  say ""
  say "Usage: mvbar [command]"
  say ""
  say "  start                 Start MVBar in the background (default)"
  say "  foreground            Run under a service manager"
  say "  stop                   Stop all MVBar services"
  say "  restart                Restart MVBar"
  say "  status                 Show status, URL, data, and log locations"
  say "  logs [service]         Follow launcher or component logs"
  say "  credentials            Print the administrator credentials"
  say "  config-path            Print the settings file path"
  say "  data-path              Print the persistent data directory"
  say "  url                    Print the active local URL"
  say "  version                Print the bundled build identifier"
  say "  help                   Show this help"
}

command=${1:-start}
case "$command" in
  start) start_background ;;
  foreground|supervise) supervise ;;
  stop) stop_background ;;
  restart)
    stop_background
    start_background
    ;;
  status) status ;;
  logs) show_logs "${2:-launcher}" ;;
  credentials)
    create_config
    cat "$CREDENTIALS_PATH"
    ;;
  config-path)
    create_config
    say "$CONFIG_PATH"
    ;;
  data-path) say "$DATA_ROOT" ;;
  url)
    [ -s "$URL_PATH" ] || fail "MVBar has not written a runtime URL yet"
    cat "$URL_PATH"
    ;;
  version) say "$BUILD_ID" ;;
  help|-h|--help) show_help ;;
  *)
    show_help >&2
    exit 2
    ;;
esac

#!/usr/bin/env bash
set -euo pipefail

SCRIPT_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_ROOT/../.." && pwd)
OUTPUT_DIRECTORY=$SCRIPT_ROOT/out
SKIP_APP_BUILD=0
NODE_PATH=${NODE_PATH:-}
MEILISEARCH_PATH=${MEILISEARCH_PATH:-}
CADDY_PATH=${CADDY_PATH:-}

usage() {
  cat <<'EOF'
Usage: ./linux/standalone/build-standalone.sh [options]

Options:
  --skip-app-build       Reuse existing successful API, worker, and web builds
  --output-dir PATH      Write the executable and checksum under PATH
  --node PATH            Bundle this Node.js executable
  --meilisearch PATH     Bundle this Meilisearch executable
  --caddy PATH           Bundle this Caddy executable
  -h, --help             Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-app-build)
      SKIP_APP_BUILD=1
      shift
      ;;
    --output-dir)
      [[ $# -ge 2 ]] || { echo "--output-dir requires a path" >&2; exit 2; }
      OUTPUT_DIRECTORY=$2
      shift 2
      ;;
    --node)
      [[ $# -ge 2 ]] || { echo "--node requires a path" >&2; exit 2; }
      NODE_PATH=$2
      shift 2
      ;;
    --meilisearch)
      [[ $# -ge 2 ]] || { echo "--meilisearch requires a path" >&2; exit 2; }
      MEILISEARCH_PATH=$2
      shift 2
      ;;
    --caddy)
      [[ $# -ge 2 ]] || { echo "--caddy requires a path" >&2; exit 2; }
      CADDY_PATH=$2
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[[ $(uname -s) == Linux ]] || { echo "This build must run on Linux." >&2; exit 1; }
[[ $(uname -m) == x86_64 ]] || { echo "This build currently targets Linux x86-64." >&2; exit 1; }

for command in bash gcc git gzip ldd npm node pg_config python3 sha256sum tar; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "Required build command was not found: $command" >&2
    exit 1
  }
done

if [[ -z $NODE_PATH ]]; then NODE_PATH=$(command -v node); fi
if [[ -z $MEILISEARCH_PATH ]]; then MEILISEARCH_PATH=$(command -v meilisearch || true); fi
if [[ -z $CADDY_PATH ]]; then CADDY_PATH=$(command -v caddy || true); fi
[[ -x $NODE_PATH ]] || { echo "Node.js executable was not found: $NODE_PATH" >&2; exit 1; }
[[ -n $MEILISEARCH_PATH && -x $MEILISEARCH_PATH ]] || {
  echo "Meilisearch was not found. Pass --meilisearch PATH." >&2
  exit 1
}
[[ -n $CADDY_PATH && -x $CADDY_PATH ]] || {
  echo "Caddy was not found. Install it or pass --caddy PATH." >&2
  exit 1
}

NODE_PATH=$(readlink -f "$NODE_PATH")
MEILISEARCH_PATH=$(readlink -f "$MEILISEARCH_PATH")
CADDY_PATH=$(readlink -f "$CADDY_PATH")
NPM_PATH=$(command -v npm)
PG_BIN=$(pg_config --bindir)
PG_SHARE=$(pg_config --sharedir)
PG_LIB=$(pg_config --pkglibdir)
PG_BIN_REL=${PG_BIN#/}
PG_SHARE_REL=${PG_SHARE#/}
PG_LIB_REL=${PG_LIB#/}
REDIS_PATH=$(command -v redis-server || true)
FFMPEG_PATH=$(command -v ffmpeg || true)
FFPROBE_PATH=$(command -v ffprobe || true)

for required in \
  "$PG_BIN/postgres" \
  "$PG_BIN/initdb" \
  "$PG_BIN/psql" \
  "$PG_BIN/createuser" \
  "$PG_BIN/createdb" \
  "$REDIS_PATH" \
  "$FFMPEG_PATH" \
  "$FFPROBE_PATH"; do
  [[ -n $required && -x $required ]] || {
    echo "Required runtime executable was not found: $required" >&2
    exit 1
  }
done
[[ -d $PG_SHARE && -d $PG_LIB ]] || { echo "PostgreSQL runtime directories are incomplete." >&2; exit 1; }

STAGING_ROOT=$SCRIPT_ROOT/staging
GENERATED_ROOT=$SCRIPT_ROOT/generated
OUTPUT_DIRECTORY=$(realpath -m "$OUTPUT_DIRECTORY")

reset_build_directory() {
  local path
  path=$(realpath -m "$1")
  case "$path" in
    "$SCRIPT_ROOT"/*) ;;
    *) echo "Refusing to reset a path outside $SCRIPT_ROOT: $path" >&2; exit 1 ;;
  esac
  rm -rf -- "$path"
  mkdir -p "$path"
}

copy_tree() {
  local source=$1
  local destination=$2
  [[ -d $source ]] || { echo "Source directory was not found: $source" >&2; exit 1; }
  mkdir -p "$destination"
  cp -a "$source"/. "$destination"/
}

build_project() {
  local project=$1
  echo "Installing and building $project..."
  (
    cd "$REPO_ROOT/$project"
    "$NPM_PATH" ci --no-audit --no-fund
    "$NPM_PATH" run build
  )
}

stage_node_project() {
  local project=$1
  local source=$REPO_ROOT/$project
  local destination=$STAGING_ROOT/app/$project
  mkdir -p "$destination"
  cp "$source/package.json" "$source/package-lock.json" "$destination/"
  (
    cd "$destination"
    echo "Installing production dependencies for $project..."
    "$NPM_PATH" ci --omit=dev --ignore-scripts --no-audit --no-fund
  )
  copy_tree "$source/dist" "$destination/dist"
}

copy_elf_dependencies() {
  local search_root=$1
  local destination=$2
  local candidate output library
  mkdir -p "$destination"

  while IFS= read -r -d '' candidate; do
    if ! file -b "$candidate" 2>/dev/null | grep -q 'ELF'; then
      continue
    fi
    output=$(ldd "$candidate" 2>&1 || true)
    if grep -q 'not found' <<< "$output"; then
      echo "Unresolved shared library for $candidate:" >&2
      echo "$output" >&2
      exit 1
    fi
    while IFS= read -r library; do
      [[ -n $library && -f $library ]] || continue
      cp -L "$library" "$destination/$(basename "$library")"
    done < <(
      awk '
        /=> \/.* \(/ { print $3 }
        /^\/[[:graph:]]+ \(/ { print $1 }
      ' <<< "$output" | sort -u
    )
  done < <(find "$search_root" -path "$destination" -prune -o -type f -print0)
}

if [[ $SKIP_APP_BUILD -eq 0 ]]; then
  build_project api
  build_project worker
  build_project web
fi

[[ -f $REPO_ROOT/api/dist/index.js ]] || { echo "API build output is missing." >&2; exit 1; }
[[ -f $REPO_ROOT/worker/dist/index.js ]] || { echo "Worker build output is missing." >&2; exit 1; }
[[ -f $REPO_ROOT/web/.next/standalone/server.js ]] || { echo "Web standalone build output is missing." >&2; exit 1; }

reset_build_directory "$STAGING_ROOT"
reset_build_directory "$GENERATED_ROOT"
mkdir -p "$OUTPUT_DIRECTORY"

echo "Staging Linux runtimes..."
mkdir -p \
  "$STAGING_ROOT/runtime/node" \
  "$STAGING_ROOT/runtime/postgres/$PG_BIN_REL" \
  "$STAGING_ROOT/runtime/postgres/$PG_LIB_REL" \
  "$STAGING_ROOT/runtime/postgres/$PG_SHARE_REL" \
  "$STAGING_ROOT/runtime/redis" \
  "$STAGING_ROOT/runtime/meili" \
  "$STAGING_ROOT/runtime/caddy" \
  "$STAGING_ROOT/runtime/ffmpeg" \
  "$STAGING_ROOT/runtime/lib"

cp "$NODE_PATH" "$STAGING_ROOT/runtime/node/node"
copy_tree "$PG_BIN" "$STAGING_ROOT/runtime/postgres/$PG_BIN_REL"
copy_tree "$PG_LIB" "$STAGING_ROOT/runtime/postgres/$PG_LIB_REL"
copy_tree "$PG_SHARE" "$STAGING_ROOT/runtime/postgres/$PG_SHARE_REL"
ln -s "$PG_BIN_REL" "$STAGING_ROOT/runtime/postgres/bin"
ln -s "$PG_LIB_REL" "$STAGING_ROOT/runtime/postgres/lib"
ln -s "$PG_SHARE_REL" "$STAGING_ROOT/runtime/postgres/share"
cp -L "$REDIS_PATH" "$STAGING_ROOT/runtime/redis/redis-server"
cp "$MEILISEARCH_PATH" "$STAGING_ROOT/runtime/meili/meilisearch"
cp "$CADDY_PATH" "$STAGING_ROOT/runtime/caddy/caddy"
cp -L "$FFMPEG_PATH" "$STAGING_ROOT/runtime/ffmpeg/ffmpeg"
cp -L "$FFPROBE_PATH" "$STAGING_ROOT/runtime/ffmpeg/ffprobe"

chmod +x \
  "$STAGING_ROOT/runtime/node/node" \
  "$STAGING_ROOT/runtime/redis/redis-server" \
  "$STAGING_ROOT/runtime/meili/meilisearch" \
  "$STAGING_ROOT/runtime/caddy/caddy" \
  "$STAGING_ROOT/runtime/ffmpeg/ffmpeg" \
  "$STAGING_ROOT/runtime/ffmpeg/ffprobe"

copy_elf_dependencies "$STAGING_ROOT/runtime" "$STAGING_ROOT/runtime/lib"

stage_node_project api
stage_node_project worker

copy_tree "$REPO_ROOT/web/.next/standalone" "$STAGING_ROOT/app/web"
copy_tree "$REPO_ROOT/web/.next/static" "$STAGING_ROOT/app/web/.next/static"
if [[ -d $REPO_ROOT/web/public ]]; then
  copy_tree "$REPO_ROOT/web/public" "$STAGING_ROOT/app/web/public"
fi

cp "$SCRIPT_ROOT/mvbar.sh" "$STAGING_ROOT/app/mvbar.sh"
cp "$SCRIPT_ROOT/helper.cjs" "$STAGING_ROOT/app/helper.cjs"
cp "$SCRIPT_ROOT/mvbar@.service" "$STAGING_ROOT/app/mvbar@.service"
cp "$SCRIPT_ROOT/Caddyfile" "$STAGING_ROOT/app/Caddyfile"
chmod +x "$STAGING_ROOT/app/mvbar.sh"

mkdir -p "$STAGING_ROOT/licenses"
cp "$REPO_ROOT/LICENSE" "$STAGING_ROOT/licenses/MVBar-LICENSE.txt"
cp "$SCRIPT_ROOT/THIRD-PARTY-NOTICES.txt" "$STAGING_ROOT/licenses/"

NODE_ROOT=$(cd "$(dirname "$NODE_PATH")/.." && pwd)
if [[ -f $NODE_ROOT/LICENSE ]]; then
  cp "$NODE_ROOT/LICENSE" "$STAGING_ROOT/licenses/Node.js-LICENSE.txt"
elif [[ -f /usr/share/doc/nodejs/copyright ]]; then
  cp /usr/share/doc/nodejs/copyright "$STAGING_ROOT/licenses/Node.js-LICENSE.txt"
fi
for license in \
  /usr/share/doc/postgresql-15/copyright \
  /usr/share/doc/redis-server/copyright \
  /usr/share/doc/caddy/copyright \
  /usr/share/doc/ffmpeg/copyright; do
  if [[ -f $license ]]; then
    cp "$license" "$STAGING_ROOT/licenses/$(basename "$(dirname "$license")")-copyright.txt"
  fi
done

GIT_COMMIT=$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)
BUILD_STAMP=$(date -u +%Y%m%d-%H%M)
BUILD_ID=$(printf '%s-%s' "$GIT_COMMIT" "$BUILD_STAMP" | tr -c 'A-Za-z0-9._-' '-')
cat > "$STAGING_ROOT/BUILD-INFO.txt" <<EOF
MVBar standalone build: $BUILD_ID
Git commit: $GIT_COMMIT
Built at: $(date -u +%Y-%m-%dT%H:%M:%SZ)
Node.js: $("$NODE_PATH" --version)
PostgreSQL: $("$PG_BIN/postgres" --version)
Redis: $("$REDIS_PATH" --version | head -n 1)
Meilisearch: $("$MEILISEARCH_PATH" --version)
Caddy: $("$CADDY_PATH" version)
FFmpeg: $("$FFMPEG_PATH" -version | head -n 1)
EOF

echo "Compiling the Linux launcher..."
BUILD_ID_DEFINE=-DBUILD_ID=\"$BUILD_ID\"
gcc \
  -O2 \
  -s \
  -Wall \
  -Wextra \
  "$BUILD_ID_DEFINE" \
  "$SCRIPT_ROOT/launcher.c" \
  -o "$GENERATED_ROOT/mvbar-launcher"

echo "Compressing the application payload..."
tar -C "$STAGING_ROOT" -czf "$GENERATED_ROOT/payload.tar.gz" .

OUTPUT_NAME=MVBar-Standalone-$BUILD_ID-linux-x64
OUTPUT_PATH=$OUTPUT_DIRECTORY/$OUTPUT_NAME
cp "$GENERATED_ROOT/mvbar-launcher" "$OUTPUT_PATH"
cat "$GENERATED_ROOT/payload.tar.gz" >> "$OUTPUT_PATH"

python3 - "$OUTPUT_PATH" "$GENERATED_ROOT/payload.tar.gz" <<'PY'
import os
import struct
import sys

output_path, payload_path = sys.argv[1:]
with open(output_path, "ab") as output:
    output.write(struct.pack("<Q", os.path.getsize(payload_path)))
    output.write(b"MVBARLNX1")
PY

chmod +x "$OUTPUT_PATH"
(
  cd "$OUTPUT_DIRECTORY"
  sha256sum "$OUTPUT_NAME" > "$OUTPUT_NAME.sha256"
)

SIZE_BYTES=$(stat -c '%s' "$OUTPUT_PATH")
SIZE=$(awk -v bytes="$SIZE_BYTES" 'BEGIN { printf "%.1f MiB", bytes / 1048576 }')
HASH=$(cut -d ' ' -f 1 "$OUTPUT_PATH.sha256")
echo
echo "MVBar standalone build complete."
echo "Binary: $OUTPUT_PATH"
echo "Size:   $SIZE"
echo "SHA256: $HASH"

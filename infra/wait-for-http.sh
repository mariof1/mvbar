#!/usr/bin/env sh
set -e

URL="$1"
TIMEOUT_S="${2:-60}"

END=$(( $(date +%s) + TIMEOUT_S ))
while [ "$(date +%s)" -lt "$END" ]; do
  if curl -fsS "$URL" >/dev/null 2>&1; then
    exit 0
  fi
  sleep 1
done

echo "timeout waiting for $URL" >&2
exit 1

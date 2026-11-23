#!/bin/bash
# Runs the backend alone on a fixed port for Chrome, with its own state folder
# (app/.dev-state/), so it never shares state with the app. Extra flags, such
# as --fake, are passed on. Stop it with Ctrl-C.
set -euo pipefail
app="$(cd "$(dirname "$0")" && pwd)"
port="${SYNOPIA_DEV_PORT:-4717}"

if [ ! -d "$app/backend/node_modules" ]; then
  echo "Run 'npm ci' in $app/backend first." >&2
  exit 1
fi

node --experimental-strip-types --disable-warning=ExperimentalWarning \
  "$app/backend/src/main.ts" --no-parent --port "$port" --state-dir "$app/.dev-state" "$@" |
  while IFS= read -r line; do
    token="$(printf '%s' "$line" | sed -n 's/.*"token":"\([0-9a-f]*\)".*/\1/p')"
    if [ -n "$token" ]; then
      echo "Open in Chrome: http://127.0.0.1:$port/?token=$token"
    else
      printf '%s\n' "$line"
    fi
  done

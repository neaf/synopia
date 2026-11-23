#!/bin/bash
# Runs the backend alone on a fixed port for Chrome, with its own state folder
# (app/.dev-state/, or $SYNOPIA_DEV_STATE), so it never shares state with the app.
# Extra flags are passed on. --fake plays the fake driver's script over the backend
# fixture tree (app/backend/test/fixtures/claude), unless --claude-dir is given.
# Stop it with Ctrl-C.
set -euo pipefail
app="$(cd "$(dirname "$0")" && pwd)"
port="${SYNOPIA_DEV_PORT:-4717}"
state="${SYNOPIA_DEV_STATE:-$app/.dev-state}"

if [ ! -d "$app/backend/node_modules" ]; then
  echo "Run 'npm ci' in $app/backend first." >&2
  exit 1
fi

extra=()
fake=0; dir=0
for a in "$@"; do
  [ "$a" = "--fake" ] && fake=1
  [ "$a" = "--claude-dir" ] && dir=1
done
if [ "$fake" = 1 ] && [ "$dir" = 0 ]; then extra=(--claude-dir "$app/backend/test/fixtures/claude"); fi

node --experimental-strip-types --disable-warning=ExperimentalWarning \
  "$app/backend/src/main.ts" --no-parent --port "$port" --state-dir "$state" ${extra[@]+"${extra[@]}"} "$@" |
  while IFS= read -r line; do
    token="$(printf '%s' "$line" | sed -n 's/.*"token":"\([0-9a-f]*\)".*/\1/p')"
    if [ -n "$token" ]; then
      echo "Open in Chrome: http://127.0.0.1:$port/?token=$token"
    else
      printf '%s\n' "$line"
    fi
  done

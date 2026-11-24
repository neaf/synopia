#!/bin/bash
# Runs the backend alone on a fixed port for Chrome, with its own state folder
# (app/.dev-state/, or $SYNOPIA_DEV_STATE), so it never shares state with the app.
# Extra flags are passed on. --script runs the scripted SDK (no model calls) over a copy of a
# fixture tree in the state folder: app/backend/test/fixtures/claude, or the --claude-dir given.
# Stop it with Ctrl-C.
set -euo pipefail
app="$(cd "$(dirname "$0")" && pwd)"
port="${SYNOPIA_DEV_PORT:-4717}"
state="${SYNOPIA_DEV_STATE:-$app/.dev-state}"

if [ ! -d "$app/backend/node_modules" ]; then
  echo "Run 'npm ci' in $app/backend first." >&2
  exit 1
fi

script=0; tree="$app/backend/test/fixtures/claude"; args=()
for a in "$@"; do [ "$a" = "--script" ] && script=1; done
while [ $# -gt 0 ]; do
  case "$1" in
    --script) ;;
    --claude-dir) tree="$2"; [ "$script" = 1 ] || args+=("$1" "$2"); shift ;;
    *) args+=("$1") ;;
  esac
  shift
done
if [ "$script" = 1 ]; then
  # the script appends to the transcripts as a CLI would: to a copy, made once per state folder
  mkdir -p "$state"
  [ -d "$state/claude" ] || cp -R "$tree" "$state/claude"
  args=(--claude-dir "$state/claude" --sdk-script "$state/claude/sdk-script.json" ${args[@]+"${args[@]}"})
fi

node --experimental-strip-types --disable-warning=ExperimentalWarning \
  "$app/backend/src/main.ts" --no-parent --port "$port" --state-dir "$state" ${args[@]+"${args[@]}"} |
  while IFS= read -r line; do
    token="$(printf '%s' "$line" | sed -n 's/.*"token":"\([0-9a-f]*\)".*/\1/p')"
    if [ -n "$token" ]; then
      echo "Open in Chrome: http://127.0.0.1:$port/?token=$token"
    else
      printf '%s\n' "$line"
    fi
  done

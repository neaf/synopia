#!/bin/bash
# Runs a page check over CDP against the fake driver, in a fresh state folder.
#   app/web/dev/cdp/run.sh dnd     drop rules (R4.5), then a backend restart and the restored layout
#   app/web/dev/cdp/run.sh keys    keys and modes (R9)
#   app/web/dev/cdp/run.sh menu    slash menu and model picker (R5.14, R3.7)
# Starts headless Chrome on 9334 if it isn't up. Prints "N/M pass" and the failures.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
fix="$(cd "$here/../../../backend/test/fixtures/claude" && pwd)"
state="$(mktemp -d "${TMPDIR:-/tmp}/synopia-cdp-state.XXXXXX")"
port="${SYNOPIA_CDP_PORT:-4791}"
curl -s http://127.0.0.1:9334/json >/dev/null || { "$here/chrome.sh"; sleep 2; }
start() { "$here/backend.sh" "$port" "$state" --fake --claude-dir "$fix" >/dev/null; }
stop() { local p; p="$(cat "$state/pid")"; kill "$p" 2>/dev/null; for _ in $(seq 50); do kill -0 "$p" 2>/dev/null || break; sleep 0.1; done; }
start
node "$here/$1.mjs" "$(cat "$state/url")" "$state"; [ "$1" = menu ] && echo "picker shot: $state/menu-picker.png"
if [ "$1" = dnd ]; then stop; start; node "$here/dnd.mjs" "$(cat "$state/url")" "$state" after-restart; fi
stop

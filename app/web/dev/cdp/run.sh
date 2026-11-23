#!/bin/bash
# Runs a page check over CDP against the fake driver, in a fresh state folder.
#   app/web/dev/cdp/run.sh dnd     drop rules (R4.5), then a backend restart and the restored layout
#   app/web/dev/cdp/run.sh keys    keys and modes (R9)
#   app/web/dev/cdp/run.sh menu    slash menu and model picker (R5.14, R3.7)
#   app/web/dev/cdp/run.sh states  session states of status.ts (R8.2) on the states fixture, with shots
#   app/web/dev/cdp/run.sh earlier loading earlier items, on a long transcript generated into the temp state
#   app/web/dev/cdp/run.sh csp     the page under its CSP, the H1 payload, an injected handler blocked
#   app/web/dev/cdp/run.sh files   files changed with a Bash command's edits (R5.9), with a shot
#   app/web/dev/cdp/run.sh steps   a tool step expanded to its command and result, show all, a live update (R5.6), with a shot
#   app/web/dev/cdp/run.sh extcard a question and a plan asked in another process: needs you, the read-only card, then answered (R6.8), with shots
#   app/web/dev/cdp/run.sh motion motion rules and reduced motion (R8.1, R8.5), square marks, marks on the box and gutter (R8.6)
# Starts headless Chrome on $SYNOPIA_CHROME_PORT (9334) if it isn't up, the backend on $SYNOPIA_CDP_PORT (4791). Prints "N/M pass" and the failures.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
fix="$(cd "$here/../../../backend/test/fixtures/claude" && pwd)"
[ "$1" = states ] && fix="$fix-states"
state="$(mktemp -d "${TMPDIR:-/tmp}/synopia-cdp-state.XXXXXX")"
port="${SYNOPIA_CDP_PORT:-4791}"
if [ "$1" = earlier ]; then fix="$state/claude"; node "$here/earlier.mjs" make "$fix" || exit 1; fi
if [ "$1" = extcard ]; then node "$here/extcard.mjs" make "$fix-ext" "$state/claude" || exit 1; fix="$state/claude"; fi
curl -s http://127.0.0.1:"${SYNOPIA_CHROME_PORT:-9334}"/json >/dev/null || { "$here/chrome.sh"; sleep 2; }
start() { "$here/backend.sh" "$port" "$state" --fake --claude-dir "$fix" >/dev/null; }
stop() { local p; p="$(cat "$state/pid")"; kill "$p" 2>/dev/null; for _ in $(seq 50); do kill -0 "$p" 2>/dev/null || break; sleep 0.1; done; }
start
node "$here/$1.mjs" "$(cat "$state/url")" "$state" "$fix"; [ "$1" = menu ] && echo "picker shot: $state/menu-picker.png"; [ "$1" = earlier ] && echo "link shot: $state/earlier-link.png"; [ "$1" = states ] && echo "shots: $state/states-*.png"; [ "$1" = files ] && echo "shot: $state/files-changed.png"; [ "$1" = steps ] && echo "shot: $state/steps.png"; [ "$1" = extcard ] && echo "shots: $state/extcard-*.png"
if [ "$1" = dnd ]; then stop; start; node "$here/dnd.mjs" "$(cat "$state/url")" "$state" after-restart; fi
stop

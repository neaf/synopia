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
#   app/web/dev/cdp/run.sh preview the file preview (R5.9) on a generated session pointing at a repo file, a binary and HTML, with --dry-open
#   app/web/dev/cdp/run.sh tween   sidebar sub-lines: height then fade, fade then height, no jump, guides aligned, instant with reduced motion (R8.1, R4.3)
#   app/web/dev/cdp/run.sh images  image thumbnails, the viewer and pasted images (R5.13), on made-up images generated into the temp state, with shots
#   app/web/dev/cdp/run.sh rail    the background panel's tree on the rail fixture: a subagent's own shells and monitors under it, guides, Stop row (R7.1), with shots
#   app/web/dev/cdp/run.sh motion  running marks always move (R8.1), the sub-line tween, reduced motion (R8.5), square marks, marks on the box and gutter (R8.6)
#   app/web/dev/cdp/run.sh extcard a question and a plan asked in another process: needs you, the read-only card, then answered (R6.8), with shots
#   app/web/dev/cdp/run.sh restore the exact UI state after a page reload and two backend restarts on the same state folder (R3.9)
#   app/web/dev/cdp/run.sh motion motion rules and reduced motion (R8.1, R8.5), square marks, marks on the box and gutter (R8.6)
# Starts headless Chrome on $SYNOPIA_CHROME_PORT (9334) if it isn't up, the backend on $SYNOPIA_CDP_PORT (4791). Prints "N/M pass" and the failures.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
fix="$(cd "$here/../../../backend/test/fixtures/claude" && pwd)"
[ "$1" = states ] && fix="$fix-states"
[ "$1" = rail ] && fix="$fix-rail"
state="$(mktemp -d "${TMPDIR:-/tmp}/synopia-cdp-state.XXXXXX")"
port="${SYNOPIA_CDP_PORT:-4791}"
if [ "$1" = earlier ] || [ "$1" = images ]; then fix="$state/claude"; node "$here/$1.mjs" make "$fix" || exit 1; fi
dry=(); if [ "$1" = preview ]; then fix="$state/claude"; dry=(--dry-open); node "$here/preview.mjs" make "$fix" || exit 1; fi
if [ "$1" = extcard ]; then node "$here/extcard.mjs" make "$fix-ext" "$state/claude" || exit 1; fix="$state/claude"; fi
curl -s http://127.0.0.1:"${SYNOPIA_CHROME_PORT:-9334}"/json >/dev/null || { "$here/chrome.sh"; sleep 2; }
start() { "$here/backend.sh" "$port" "$state" --fake --claude-dir "$fix" ${dry[@]+"${dry[@]}"} >/dev/null; }
stop() { local p; p="$(cat "$state/pid")"; kill "$p" 2>/dev/null; for _ in $(seq 50); do kill -0 "$p" 2>/dev/null || break; sleep 0.1; done; }
start
node "$here/$1.mjs" "$(cat "$state/url")" "$state" "$fix"; [ "$1" = menu ] && echo "picker shot: $state/menu-picker.png"; [ "$1" = earlier ] && echo "link shot: $state/earlier-link.png"; [ "$1" = states ] && echo "shots: $state/states-*.png"; [ "$1" = files ] && echo "shot: $state/files-changed.png"; [ "$1" = steps ] && echo "shot: $state/steps.png"; [ "$1" = extcard ] && echo "shots: $state/extcard-*.png"; [ "$1" = preview ] && echo "shots: $state/preview-*.png"; [ "$1" = images ] && echo "shots: $state/images-*.png"
node "$here/$1.mjs" "$(cat "$state/url")" "$state" "$fix"; [ "$1" = menu ] && echo "picker shot: $state/menu-picker.png"; [ "$1" = earlier ] && echo "link shot: $state/earlier-link.png"; [ "$1" = states ] && echo "shots: $state/states-*.png"; [ "$1" = files ] && echo "shot: $state/files-changed.png"; [ "$1" = steps ] && echo "shot: $state/steps.png"; [ "$1" = rail ] && echo "shots: $state/rail-*.png"; [ "$1" = preview ] && echo "shots: $state/preview-*.png"
if [ "$1" = dnd ]; then stop; start; node "$here/dnd.mjs" "$(cat "$state/url")" "$state" after-restart; fi
stop

#!/bin/sh
# Screenshots of the prototype and the port in the same states, for comparing by eye.
# Usage: app/web/dev/compare.sh [out-dir]   (default /tmp/synopia-compare)
# The port runs on `app/dev.sh --fake` (the backend fixture tree and its fake script) with a temp state folder.
# The prototype gets the same data as transcripts.js and menu.js, built by build-proto-fixture.ts in a temp folder.
# It never reads or writes prototype/transcripts.js.
set -eu
DEV=$(cd "$(dirname "$0")" && pwd)
WEB=$(dirname "$DEV")
APP=$(dirname "$WEB")
ROOT=$(dirname "$APP")
OUT=${1:-/tmp/synopia-compare}
PORT=${SYNOPIA_COMPARE_PORT:-4718}
CHROME=$("$DEV/chrome-bin.sh") || exit 1
FIXTURE="$APP/backend/test/fixtures/claude"

rm -rf "$OUT"
mkdir -p "$OUT/proto" "$OUT/shots" "$OUT/state"
cp "$ROOT/prototype/app.html" "$OUT/proto/app.html"
cp -R "$ROOT/prototype/icon" "$OUT/proto/icon"
node --experimental-strip-types --disable-warning=ExperimentalWarning "$DEV/build-proto-fixture.ts" "$FIXTURE" "$OUT/proto" >/dev/null

SYNOPIA_DEV_PORT=$PORT SYNOPIA_DEV_STATE="$OUT/state" "$APP/dev.sh" --fake >"$OUT/backend.out" 2>&1 &
trap 'pkill -f -- "--state-dir $OUT/state" 2>/dev/null || true' EXIT
i=0
until grep -q "Open in Chrome" "$OUT/backend.out" 2>/dev/null; do
  i=$((i + 1)); [ $i -gt 100 ] && { echo "compare: the backend did not start" >&2; cat "$OUT/backend.out" >&2; exit 1; }
  sleep 0.1
done
URL=$(sed -n 's/^Open in Chrome: //p' "$OUT/backend.out")
sleep 1 # the fake script's last step is at 600 ms

shot() { # name url
  prof=$(mktemp -d)
  "$CHROME" --headless --disable-gpu --hide-scrollbars --force-prefers-reduced-motion \
    --virtual-time-budget=3000 --window-size=1280,820 --user-data-dir="$prof" \
    --screenshot="$OUT/shots/$1" "$2" >/dev/null 2>&1
  rm -rf "$prof"
}

# name | query | hash: a question card, a permission card, a plan card, working with a subagent wave, an open diff, a subagent view
for s in "waiting||22222222" "permission||33333333" "plan||55555555" "busy||44444444" "diff|open=1|11111111" "agent|agent=aaaa0002|44444444"; do
  name=${s%%|*}; rest=${s#*|}; q=${rest%%|*}; h=${rest#*|}
  shot "$name-proto.png" "file://$OUT/proto/app.html${q:+?$q}#$h"
  shot "$name-port.png" "$URL${q:+&$q}#$h"
done
echo "compare: $(ls "$OUT/shots" | wc -l | tr -d ' ') screenshots in $OUT/shots"

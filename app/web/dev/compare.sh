#!/bin/sh
# Screenshots of the prototype and the port on the same fixture, for comparing by eye.
# Usage: app/web/dev/compare.sh [out-dir]   (default /tmp/synopia-compare)
# Copies prototype/app.html and the port to temp folders with the fixture as transcripts.js and menu.js.
# It never reads or writes prototype/transcripts.js.
set -eu
DEV=$(cd "$(dirname "$0")" && pwd)
WEB=$(dirname "$DEV")
ROOT=$(dirname "$(dirname "$WEB")")
OUT=${1:-/tmp/synopia-compare}
CHROME=${CHROME:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}

rm -rf "$OUT"
mkdir -p "$OUT/proto" "$OUT/port" "$OUT/shots"
cp "$ROOT/prototype/app.html" "$OUT/proto/app.html"
cp -R "$ROOT/prototype/icon" "$OUT/proto/icon"
cp -R "$WEB/index.html" "$WEB/css" "$WEB/js" "$WEB/icon" "$OUT/port/"
for d in proto port; do
  cp "$DEV/fixture-transcripts.js" "$OUT/$d/transcripts.js"
  cp "$DEV/fixture-menu.js" "$OUT/$d/menu.js"
done

shot() { # name page query+hash
  prof=$(mktemp -d)
  "$CHROME" --headless --disable-gpu --hide-scrollbars --force-prefers-reduced-motion \
    --virtual-time-budget=3000 --window-size=1280,820 --user-data-dir="$prof" \
    --screenshot="$OUT/shots/$1" "file://$2$3" >/dev/null 2>&1
  rm -rf "$prof"
}

# name | query and hash: needs you with the card, working with the rail, an open diff, a subagent view
for s in "waiting|#a7c3e1f0" "busy|#b84d2a91" "diff|?open=1#c1e94b07" "agent|?agent=fa02c0de0002#b84d2a91"; do
  name=${s%%|*}; q=${s#*|}
  shot "$name-proto.png" "$OUT/proto/app.html" "$q"
  shot "$name-port.png" "$OUT/port/index.html" "$q"
done
echo "compare: $(ls "$OUT/shots" | wc -l | tr -d ' ') screenshots in $OUT/shots"

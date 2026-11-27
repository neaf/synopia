#!/bin/bash
# Builds build/Synopia.app from app/shell with swiftc. The app runs the backend
# from this checkout with the node found now, so rebuild after a Node upgrade.
# It builds into a temp bundle next to build/Synopia.app, checks it (Info.plist lint,
# an executable binary, config.json naming a node, a backend and a harness plugin that exist), and only
# then replaces the old bundle, so a failed build leaves the old app as it was and a
# running app loses its bundle for no longer than one rename.
set -euo pipefail
app="$(cd "$(dirname "$0")" && pwd)"
root="$(dirname "$app")"
bundle="$root/build/Synopia.app"

node="$(asdf which node 2>/dev/null || command -v node || true)"
[ -n "$node" ] || { echo "build: fail (no node found)"; exit 1; }

icon="$app/web/icon/icon-1024.png"
if [ ! -f "$icon" ]; then
  icon="$(ls -S "$app"/web/icon/*.png 2>/dev/null | head -1 || true)"
  [ -n "$icon" ] || { echo "build: fail (no PNG in app/web/icon)"; exit 1; }
fi

# The agent-harness plugin the sessions load (R3.17). The gitignored app/.harness-live, one line holding
# the path of your agent-harness checkout, names that checkout and nothing is copied; else the pinned
# copy app/harness/bundle/ (app/harness/pin.sh) goes into Contents/Resources/harness/. Either must hold
# .claude-plugin/plugin.json and the rendered build/agents/ (install.py --plugin).
harness_ok() {
  [ -f "$1/.claude-plugin/plugin.json" ] || { echo "build: fail ($2 has no .claude-plugin/plugin.json)"; exit 1; }
  [ -d "$1/build/agents" ] || { echo "build: fail ($2 has no build/agents/: run install.py --plugin there)"; exit 1; }
}
live=""
if [ -f "$app/.harness-live" ]; then
  live="$(head -1 "$app/.harness-live")"
  case "$live" in "~") live="$HOME" ;; "~/"*) live="$HOME/${live#\~/}" ;; esac
  [ -n "$live" ] || { echo "build: fail (app/.harness-live is empty)"; exit 1; }
  [ -d "$live" ] || { echo "build: fail (app/.harness-live names $live, not a folder)"; exit 1; }
  live="$(cd "$live" && pwd)"
  harness_ok "$live" "$live"
else
  harness_ok "$app/harness/bundle" "app/harness/bundle"
fi

mkdir -p "$root/build"
work="$(mktemp -d "$root/build/.Synopia.XXXXXX")"
trap 'rm -rf "$work"' EXIT
new="$work/Synopia.app"
fail() { echo "build: fail ($1)"; exit 1; }

mkdir -p "$new/Contents/MacOS" "$new/Contents/Resources"
cp "$app/shell/Info.plist" "$new/Contents/Info.plist"
plutil -lint -s "$new/Contents/Info.plist" || fail "Info.plist does not lint"
swiftc -O "$app"/shell/*.swift -o "$new/Contents/MacOS/Synopia" -framework Cocoa -framework WebKit || fail "swiftc"
[ -x "$new/Contents/MacOS/Synopia" ] || fail "no executable"

iconset="$work/Synopia.iconset"
mkdir -p "$iconset"
for s in 16 32 128 256 512; do
  sips -z $s $s "$icon" --out "$iconset/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) "$icon" --out "$iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o "$new/Contents/Resources/Synopia.icns"

if [ -n "$live" ]; then
  harness="$live"
else
  cp -R "$app/harness/bundle" "$new/Contents/Resources/harness"
  harness="$bundle/Contents/Resources/harness" # where it is once the new bundle is swapped in
fi

config="$new/Contents/Resources/config.json"
node="$node" backend="$app/backend/src/main.ts" harness="$harness" "$node" -e \
  'process.stdout.write(JSON.stringify({ node: process.env.node, backend: process.env.backend, harness: process.env.harness }, null, 2) + "\n")' \
  >"$config"
"$node" -e '
  const fs = require("node:fs");
  const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  fs.accessSync(c.node, fs.constants.X_OK);
  fs.accessSync(c.backend, fs.constants.R_OK);
' "$config" 2>/dev/null || fail "config.json names a missing node or backend"
[ -n "$live" ] || harness_ok "$new/Contents/Resources/harness" "the copied harness"

# the swap: the old bundle aside, the new one in, the old one gone
old="$work/Synopia.app.old"
[ -e "$bundle" ] && mv "$bundle" "$old"
mv "$new" "$bundle"

echo "build: pass ($bundle)"

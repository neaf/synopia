#!/bin/bash
# Builds build/Synopia.app from app/shell with swiftc. The app runs the backend
# from this checkout with the node found now, so rebuild after a Node upgrade.
# It builds into a temp bundle next to build/Synopia.app, checks it (Info.plist lint,
# an executable binary, config.json naming a node and a backend that exist), and only
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

config="$new/Contents/Resources/config.json"
node="$node" backend="$app/backend/src/main.ts" "$node" -e \
  'process.stdout.write(JSON.stringify({ node: process.env.node, backend: process.env.backend }, null, 2) + "\n")' \
  >"$config"
"$node" -e '
  const fs = require("node:fs");
  const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  fs.accessSync(c.node, fs.constants.X_OK);
  fs.accessSync(c.backend, fs.constants.R_OK);
' "$config" 2>/dev/null || fail "config.json names a missing node or backend"

# the swap: the old bundle aside, the new one in, the old one gone
old="$work/Synopia.app.old"
[ -e "$bundle" ] && mv "$bundle" "$old"
mv "$new" "$bundle"

echo "build: pass ($bundle)"

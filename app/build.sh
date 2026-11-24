#!/bin/bash
# Builds build/Synopia.app from app/shell with swiftc. The app runs the backend
# from this checkout with the node found now, so rebuild after a Node upgrade.
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

rm -rf "$bundle"
mkdir -p "$bundle/Contents/MacOS" "$bundle/Contents/Resources"
cp "$app/shell/Info.plist" "$bundle/Contents/Info.plist"
swiftc -O "$app"/shell/*.swift -o "$bundle/Contents/MacOS/Synopia" -framework Cocoa -framework WebKit

iconset="$(mktemp -d "${TMPDIR:-/tmp}/synopia-icon.XXXXXX")/Synopia.iconset"
mkdir -p "$iconset"
for s in 16 32 128 256 512; do
  sips -z $s $s "$icon" --out "$iconset/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) "$icon" --out "$iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o "$bundle/Contents/Resources/Synopia.icns"
rm -rf "$(dirname "$iconset")"

node="$node" backend="$app/backend/src/main.ts" "$node" -e \
  'process.stdout.write(JSON.stringify({ node: process.env.node, backend: process.env.backend }, null, 2) + "\n")' \
  >"$bundle/Contents/Resources/config.json"

echo "build: pass ($bundle)"

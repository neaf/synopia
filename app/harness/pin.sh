#!/bin/bash
# Pins agent-harness into app/harness/bundle/, the copy app/build.sh puts into the app (requirements
# R3.17, FR-HAR-01). The plugin's agents are rendered files agent-harness keeps out of git, so the pin
# is an export of one commit plus one `install.py --plugin` run inside that export, never in the checkout.
#   app/harness/pin.sh <agent-harness checkout> [<commit>]    (commit default: main)
# Replaces app/harness/bundle/ (.claude-plugin/, skills/ without tests/, build/agents/,
# instructions/global.md) and writes app/harness/PIN (the commit and its date). Prints one summary line.
set -euo pipefail
[ $# -ge 1 ] && [ $# -le 2 ] || { echo "usage: app/harness/pin.sh <agent-harness checkout> [<commit>]" >&2; exit 2; }
here="$(cd "$(dirname "$0")" && pwd)"
src="$1"
ref="${2:-main}"
fail() { echo "pin: fail ($1)"; exit 1; }

[ -f "$src/install.py" ] || fail "$src has no install.py"
sha="$(git -C "$src" rev-parse --verify --quiet "$ref^{commit}")" || fail "no commit $ref in $src"
date="$(git -C "$src" show -s --format=%cI "$sha")"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/synopia-pin.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
export_dir="$tmp/export"
mkdir "$export_dir"
git -C "$src" archive "$sha" | tar -x -C "$export_dir"
# -I: no user site or script folder on sys.path; -B: no __pycache__ in the bundle
(cd "$export_dir" && /usr/bin/python3 -I -B install.py --plugin >"$tmp/install.out" 2>&1) \
  || { sed 's/^/  /' "$tmp/install.out"; fail "install.py --plugin"; }

new="$tmp/bundle"
mkdir -p "$new/build" "$new/instructions"
cp -R "$export_dir/.claude-plugin" "$new/.claude-plugin"
cp -R "$export_dir/skills" "$new/skills"
cp -R "$export_dir/build/agents" "$new/build/agents"
cp "$export_dir/instructions/global.md" "$new/instructions/global.md"
find "$new/skills" -depth -type d \( -name tests -o -name __pycache__ \) -exec rm -rf {} +

# Every agent plugin.json names must be in the bundle.
missing="$(cd "$new" && /usr/bin/python3 -I -c '
import json, os
for p in json.load(open(".claude-plugin/plugin.json")).get("agents", []):
    if not os.path.isfile(p): print(p)
')"
[ -z "$missing" ] || fail "plugin.json names agents the render did not write: $missing"

rm -rf "$here/bundle"
mv "$new" "$here/bundle"
printf 'commit %s\ndate %s\n' "$sha" "$date" >"$here/PIN"

skills="$(find "$here/bundle/skills" -mindepth 2 -maxdepth 2 -name SKILL.md | wc -l | tr -d ' ')"
agents="$(find "$here/bundle/build/agents" -maxdepth 1 -name '*.md' | wc -l | tr -d ' ')"
echo "pin: ${sha:0:7}, $skills skills, $agents agents"

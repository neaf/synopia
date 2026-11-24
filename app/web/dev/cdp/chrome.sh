#!/bin/bash
# usage: chrome.sh <profile-dir>; starts headless Chrome with its own profile and a remote-debugging port
# Chrome picks itself (port 0), waits until it answers, writes <profile-dir>/pid and prints the port.
# ../chrome-bin.sh picks the binary: chrome-headless-shell when installed, so no window takes focus.
dir=$1; mkdir -p "$dir"; rm -f "$dir/DevToolsActivePort"
bin="$("$(dirname "$0")/../chrome-bin.sh")" || exit 1
"$bin" --remote-debugging-port=0 --user-data-dir="$dir" \
  --window-size=1280,820 --no-first-run --no-default-browser-check --disable-background-timer-throttling \
  --disable-backgrounding-occluded-windows --disable-renderer-backgrounding \
  about:blank > "$dir/out" 2>&1 &
echo $! > "$dir/pid"
for _ in $(seq 150); do
  port=$(head -1 "$dir/DevToolsActivePort" 2>/dev/null)
  [ -n "$port" ] && curl -sf "http://127.0.0.1:$port/json/version" >/dev/null && { echo "$port"; exit 0; }
  kill -0 "$(cat "$dir/pid")" 2>/dev/null || break
  sleep 0.1
done
echo "chrome.sh: Chrome did not start (see $dir/out)" >&2; exit 1

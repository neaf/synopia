#!/bin/bash
# usage: backend.sh <port|0> <state-dir> [extra flags]; port 0 lets the backend pick a free one. The checks pass
# --claude-dir <tree> --sdk-script <tree>/sdk-script.json: the scripted SDK seeds a fresh state folder.
# Waits for its {"port","token"} line, writes <state-dir>/pid and <state-dir>/url and prints the url.
W="$(cd "$(dirname "$0")/../../../.." && pwd)"
port=$1; state=$2; shift 2
mkdir -p "$state"; : > "$state/out"
node --experimental-strip-types --disable-warning=ExperimentalWarning "$W"/app/backend/src/main.ts --no-parent --port "$port" --state-dir "$state" "$@" > "$state/out" 2>&1 &
pid=$!; echo $pid > "$state/pid"
for _ in $(seq 150); do
  line=$(grep -m1 '"token"' "$state/out")
  if [ -n "$line" ]; then
    t=$(sed -n 's/.*"token":"\([0-9a-f]*\)".*/\1/p' <<<"$line"); p=$(sed -n 's/.*"port":\([0-9]*\).*/\1/p' <<<"$line")
    echo "http://127.0.0.1:$p/?token=$t" > "$state/url"; cat "$state/url"; exit 0
  fi
  kill -0 $pid 2>/dev/null || break
  sleep 0.1
done
echo "backend.sh: the backend did not start (see $state/out)" >&2; exit 1

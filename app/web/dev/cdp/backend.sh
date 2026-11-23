#!/bin/bash
# usage: backend.sh <port> <state-dir> [extra flags]; writes <state-dir>/url
W="$(cd "$(dirname "$0")/../../../.." && pwd)"
port=$1; state=$2; shift 2
mkdir -p "$state"
node --experimental-strip-types --disable-warning=ExperimentalWarning "$W"/app/backend/src/main.ts --no-parent --port "$port" --state-dir "$state" "$@" > "$state/out" 2>&1 &
echo $! > "$state/pid"
for i in $(seq 50); do t=$(sed -n 's/.*"token":"\([0-9a-f]*\)".*/\1/p' "$state/out"); [ -n "$t" ] && break; sleep 0.2; done
echo "http://127.0.0.1:$port/?token=$t" > "$state/url"; cat "$state/url"

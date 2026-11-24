#!/bin/bash
# Runs every check: the backend unit tests, a type check of the shell and its DaemonFilesTest, and a
# check of the page scripts (classic and modules). Prints one pass or fail line per part, plus
# the names of failing tests, and exits nonzero if any part fails.
#   app/check.sh          the fast parts, no Chrome
#   app/check.sh --page   then every headless page check (app/web/dev/cdp/run.sh all)
set -uo pipefail
page=0
case "${1:-}" in --page) page=1 ;; "") ;; *) echo "usage: app/check.sh [--page]" >&2; exit 2 ;; esac
app="$(cd "$(dirname "$0")" && pwd)"
failed=0
out="$(mktemp "${TMPDIR:-/tmp}/synopia-check.XXXXXX")"
trap 'rm -f "$out"' EXIT

# Backend
if node --experimental-strip-types --disable-warning=ExperimentalWarning \
    --test --test-reporter=tap "$app"/backend/test/*.test.ts >"$out" 2>&1; then
  echo "backend: pass ($(sed -n 's/^# pass //p' "$out" | tail -1) tests)"
else
  failed=1
  echo "backend: fail ($(sed -n 's/^# fail //p' "$out" | tail -1) failing)"
  grep -E '^ *not ok ' "$out" | sed -E 's/^( *)not ok [0-9]+ - /\1  /'
fi

# Shell
shopt -s nullglob
swift=("$app"/shell/*.swift)
if [ ${#swift[@]} -eq 0 ]; then
  echo "shell: skip (no app/shell yet)"
elif ! swiftc -typecheck "${swift[@]}" >"$out" 2>&1; then
  failed=1
  echo "shell: fail (typecheck)"
  grep -E 'error:' "$out" | head -20
else
  # DaemonFilesTest: DaemonFiles.swift on the goldens, as a plain binary (no window)
  bin="$(mktemp -d "${TMPDIR:-/tmp}/synopia-shelltest.XXXXXX")"
  if ! swiftc "$app"/shell/DaemonFiles.swift "$app"/shell/test/DaemonFilesTest.swift -o "$bin/t" >"$out" 2>&1; then
    failed=1
    echo "shell: fail (DaemonFilesTest build)"
    grep -E 'error:' "$out" | head -20
  elif "$bin/t" "$app/shell/test/golden" >"$out" 2>&1; then
    echo "shell: pass (typecheck, $(sed -n 's/.*pass (\(.*\))/\1/p' "$out") in DaemonFilesTest)"
  else
    failed=1
    echo "shell: fail (DaemonFilesTest)"
    sed '1d' "$out" | head -20
  fi
  rm -rf "$bin"
fi

# Page scripts: each parses as index.html loads it (classic or module), and module imports resolve
if node "$app"/web/dev/check-web.mjs >"$out" 2>&1; then
  read -r n c m < <(tail -1 "$out")
  echo "web: pass ($n files: $c classic, $m modules)"
else
  failed=1
  echo "web: fail"
  sed '$d' "$out" | sed 's/^/  /' | head -20
fi

# Page checks: headless Chrome against the scripted SDK, each in its own Chrome and backend
if [ $page -eq 1 ]; then
  if "$app"/web/dev/cdp/run.sh all >"$out" 2>&1; then
    echo "page: pass ($(grep -c '^[a-z]* *pass ' "$out") checks)"
  else
    failed=1
    echo "page: fail"
    sed -n '2,$p' "$out" | grep -v ' pass [0-9]*/[0-9]*$'
  fi
fi

exit $failed

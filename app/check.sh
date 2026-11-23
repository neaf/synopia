#!/bin/bash
# Runs every check: the backend unit tests, a type check of the shell, and a
# syntax check of the page scripts. Prints one pass or fail line per part, plus
# the names of failing tests, and exits nonzero if any part fails.
set -uo pipefail
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
elif swiftc -typecheck "${swift[@]}" >"$out" 2>&1; then
  echo "shell: pass"
else
  failed=1
  echo "shell: fail"
  grep -E 'error:' "$out" | head -20
fi

# Page scripts
js=("$app"/web/js/*.js)
if [ ${#js[@]} -eq 0 ]; then
  echo "web: skip (no app/web/js yet)"
else
  bad=()
  for f in "${js[@]}"; do
    node --check "$f" >/dev/null 2>&1 || bad+=("$(basename "$f")")
  done
  if [ ${#bad[@]} -eq 0 ]; then
    echo "web: pass (${#js[@]} files)"
  else
    failed=1
    echo "web: fail (${bad[*]})"
  fi
fi

exit $failed

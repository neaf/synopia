#!/bin/bash
# Runs a page check over CDP against the scripted SDK (app/backend/dev/scripted-sdk.ts), in a fresh state folder.
#   app/web/dev/cdp/run.sh all     every check below, one after the other: a table of check and result, the failures under it
#   app/web/dev/cdp/run.sh dnd     drop rules (R4.5), then a backend restart and the restored layout
#   app/web/dev/cdp/run.sh keys    keys and modes (R9)
#   app/web/dev/cdp/run.sh menu    slash menu and model picker (R5.14, R3.7)
#   app/web/dev/cdp/run.sh states  session states of status.ts (R8.2) on the states fixture, with shots
#   app/web/dev/cdp/run.sh earlier loading earlier items, on a long transcript generated into the temp state
#   app/web/dev/cdp/run.sh csp     the page under its CSP, the H1 payload, an injected handler blocked
#   app/web/dev/cdp/run.sh files   files changed with a Bash command's edits (R5.9), with a shot
#   app/web/dev/cdp/run.sh steps   a tool step expanded to its command and result, show all, a live update, a running step from the live line and its own line (R5.6), with shots
#   app/web/dev/cdp/run.sh preview the file preview (R5.9) on a generated session pointing at a repo file, a binary and HTML, with --dry-run
#   app/web/dev/cdp/run.sh tween   sidebar sub-lines: height then fade, fade then height, no jump, guides aligned, instant with reduced motion (R8.1, R4.3)
#   app/web/dev/cdp/run.sh images  image thumbnails, the viewer and pasted images (R5.13), on made-up images generated into the temp state, with shots
#   app/web/dev/cdp/run.sh rail    the background panel's tree on the rail fixture: a subagent's own shells and monitors under it, guides, Stop row (R7.1), with shots
#   app/web/dev/cdp/run.sh motion  running marks always move (R8.1), the sub-line tween, reduced motion (R8.5), square marks, marks on the box and gutter (R8.6)
#   app/web/dev/cdp/run.sh extcard a question and a plan asked in another process: needs you, the read-only card, then answered (R6.8), with shots
#   app/web/dev/cdp/run.sh restore the exact UI state after a page reload and two backend restarts on the same state folder (R3.9)
#   app/web/dev/cdp/run.sh background  b, b sends foreground steps to the background (R9): the highlight, the prompt, cancel, send, not driven, with a shot
#   app/web/dev/cdp/run.sh dark    dark mode (section 11): follows the system live, the switch stored and kept over a reload, no light background left, with shots
#   app/web/dev/cdp/run.sh titles  title changes in the transcript (R5.12c): two Retitled lines in place, kept over a reload and a backend restart, with a shot
#   app/web/dev/cdp/run.sh queued  messages sent during a turn show pending (R5.5): in order above the live line, one lands in place, an interrupt puts the other back in the box, with shots
#   app/web/dev/cdp/run.sh bang    bash mode (R5.13): ! enters it, Backspace leaves it, a command's output, stderr and exit, Show all, one at a time, Esc, Esc ends a sleep, with shots
#   app/web/dev/cdp/run.sh close  x, x closes the session (R3.6, R9): the prompt and what will stop, cancel by a key, a click or a switch, close, back from the Open list in its group, with a shot
#   app/web/dev/cdp/run.sh viewswitch  back from a subagent the view renders once (R3.9): one view message, one reset, no other range first, on the earlier transcript
# SYNOPIA_CDP_THEME=dark run.sh <name|all> runs any check with the system appearance dark (the page follows it).
# Each run starts its own headless Chrome (its own profile, a debugging port Chrome picks) and its own backend
# (a port it picks), so runs in parallel and the app you have open never meet; both stop on exit, Ctrl-C
# included. Prints "N/M pass" and the failures; exits nonzero on a failure.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
SUITES=(dnd keys menu states earlier csp files steps preview tween images rail motion extcard restore background dark close titles queued bang viewswitch)
name="${1:-}"

if [ "$name" = all ]; then
  logs="$(mktemp -d "${TMPDIR:-/tmp}/synopia-cdp-all.XXXXXX")"
  failed=0; fails=""
  printf '%-10s %s\n' check result
  for s in "${SUITES[@]}"; do
    "$here/run.sh" "$s" > "$logs/$s.log" 2>&1; code=$?
    pass=0; total=0
    while read -r a b; do pass=$((pass + a)); total=$((total + b)); done < <(sed -n 's/^\([0-9]*\)\/\([0-9]*\) pass$/\1 \2/p' "$logs/$s.log")
    if [ $code -eq 0 ] && [ "$total" -gt 0 ] && [ "$pass" -eq "$total" ]; then r="pass $pass/$total"
    else
      failed=1; r="FAIL $pass/$total"; [ $code -ne 0 ] && [ "$pass" -eq "$total" ] && r="$r (exit $code)"
      f="$(grep -E '^FAIL|Error|error:' "$logs/$s.log" | head -8)"; [ -n "$f" ] || f="$(tail -5 "$logs/$s.log")"
      fails="$fails$s:"$'\n'"$(sed 's/^/  /' <<<"$f")"$'\n'
    fi
    printf '%-10s %s\n' "$s" "$r"
  done
  [ -n "$fails" ] && printf '\n%s' "$fails"
  echo "logs: $logs"
  exit $failed
fi
case " ${SUITES[*]} " in *" $name "*) ;; *) echo "usage: run.sh all|${SUITES[*]// /|}" >&2; exit 2 ;; esac

fix="$(cd "$here/../../../backend/test/fixtures/claude" && pwd)"
[ "$name" = states ] && fix="$fix-states"
[ "$name" = rail ] && fix="$fix-rail"
state="$(mktemp -d "${TMPDIR:-/tmp}/synopia-cdp-state.XXXXXX")"
profile="$(mktemp -d "${TMPDIR:-/tmp}/synopia-cdp-chrome.XXXXXX")"

# teardown: only this run's backend (its latest pid, after restarts) and this run's Chrome and its helpers
stopPid() { local p=$1; [ -n "$p" ] || return 0; kill "$p" 2>/dev/null || return 0; for _ in $(seq 50); do kill -0 "$p" 2>/dev/null || return 0; sleep 0.1; done; kill -9 "$p" 2>/dev/null; }
check=""
cleanup() {
  stopPid "$check"
  stopPid "$(cat "$state/pid" 2>/dev/null)"
  stopPid "$(cat "$profile/pid" 2>/dev/null)"
  pkill -9 -f -- "--user-data-dir=$profile" 2>/dev/null
  rm -rf "$profile"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

if [ "$name" = viewswitch ]; then fix="$state/claude"; node "$here/earlier.mjs" make "$fix" || exit 1; fi
if [ "$name" = earlier ] || [ "$name" = images ] || [ "$name" = background ] || [ "$name" = close ] || [ "$name" = titles ] || [ "$name" = queued ] || [ "$name" = bang ]; then fix="$state/claude"; node "$here/$name.mjs" make "$fix" || exit 1; fi
dry=(); if [ "$name" = preview ]; then fix="$state/claude"; dry=(--dry-run); node "$here/preview.mjs" make "$fix" || exit 1; fi
if [ "$name" = extcard ]; then node "$here/extcard.mjs" make "$fix-ext" "$state/claude" || exit 1; fix="$state/claude"; fi
if [ "$name" = steps ]; then node "$here/steps.mjs" make "$fix" "$state/claude" || exit 1; fix="$state/claude"; fi
# the scripted SDK writes to the transcripts as a CLI would: never to a tracked fixture tree
if [ "$fix" != "$state/claude" ]; then cp -R "$fix" "$state/claude" || exit 1; fix="$state/claude"; fi

SYNOPIA_CHROME_PORT="$("$here/chrome.sh" "$profile")" || exit 1
export SYNOPIA_CHROME_PORT
port=0 # the backend picks a free port; a restart reuses it
start() { "$here/backend.sh" "$port" "$state" --claude-dir "$fix" --sdk-script "$fix/sdk-script.json" ${dry[@]+"${dry[@]}"} >/dev/null || exit 1; port="$(sed -n 's/^http:\/\/127.0.0.1:\([0-9]*\)\/.*/\1/p' "$state/url")"; }
stop() { stopPid "$(cat "$state/pid")"; }
start
# the check runs as a waited child, so a signal runs the teardown at once (and stops the check too)
runCheck() { node "$@" & check=$!; wait $check; local c=$?; check=""; return $c; }
runCheck "$here/$name.mjs" "$(cat "$state/url")" "$state" "$fix"; code=$?
case $name in
  menu) echo "picker shot: $state/menu-picker.png" ;; earlier) echo "link shot: $state/earlier-link.png" ;;
  states) echo "shots: $state/states-*.png" ;; files) echo "shot: $state/files-changed.png" ;; steps) echo "shots: $state/steps*.png" ;;
  extcard|preview|images|rail|background|dark|close|titles|queued|bang) echo "shots: $state/$name-*.png" ;;
esac
if [ "$name" = dnd ]; then stop; start; runCheck "$here/dnd.mjs" "$(cat "$state/url")" "$state" after-restart || code=1; fi
exit $code

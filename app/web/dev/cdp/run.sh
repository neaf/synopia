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
#   app/web/dev/cdp/run.sh steps   Claude's Bash steps, foreground and background, and its Monitor folded into one line and expanded in place, no run row; the background shell's and monitor's cards opening the shell view with its crumb, a Past line for one over at once; a running Bash expanded in place, no card, its live line opening its shell view, K and J back, its result landing in the open view, other steps expanded with show all and a live update, a single step folded, every step line one line at a wide and a narrow window, the gutter marks (no selection, no click, the row's time on hover) (R5.6, R7.1, R7.2), with shots
#   app/web/dev/cdp/run.sh preview the file preview (R5.9) on a generated session pointing at a repo file, a binary and HTML, with --dry-run
#   app/web/dev/cdp/run.sh tween   sidebar sub-lines: height then fade, fade then height, no jump, guides aligned, instant with reduced motion (R8.1, R4.3)
#   app/web/dev/cdp/run.sh images  image thumbnails, the viewer and pasted images (R5.13), on made-up images generated into the temp state, with shots
#   app/web/dev/cdp/run.sh rail    the background panel's tree on the rail fixture: a subagent's own shells and monitors under it, guides, no Stop row (R7.1), a shell or monitor opened in the pane with its output (R7.2), a To review card jumping to its report (R7.1), with shots
#   app/web/dev/cdp/run.sh motion  running marks always move (R8.1), the sub-line tween, reduced motion (R8.5), square marks, marks on the box and gutter (R8.6)
#   app/web/dev/cdp/run.sh extcard a question and a plan asked in another process: needs you, the read-only card, then answered (R6.8), with shots
#   app/web/dev/cdp/run.sh restore the exact UI state after a page reload and two backend restarts on the same state folder (R3.9)
#   app/web/dev/cdp/run.sh background  b, b sends foreground steps to the background (R9): the highlight, the prompt, cancel, send, not driven, with a shot
#   app/web/dev/cdp/run.sh dark    dark mode (section 11): follows the system live, the switch stored and kept over a reload, no light background left, with shots
#   app/web/dev/cdp/run.sh titles  title changes in the transcript (R5.12c): two Retitled lines in place, kept over a reload and a backend restart, with a shot
#   app/web/dev/cdp/run.sh queued  the pane as one panel and messages sent during a turn (R5, R5.5): the box as the last row under its line, the band edge whole and edge to edge, clock bands below the live line, pinned when scrolled up, the box counts them, they land with nothing moving, a send scrolls to the end only from the end, an interrupt puts one back in the box, long tokens wrap, with shots
#   app/web/dev/cdp/run.sh bang    bash mode (R5.13) and its run row (R7.1, 2026-11-26): ! enters it, Backspace leaves it, output, stderr and exit in a 3-line row with no field, the row opens the shell view, no card for an instant command and one after 3 s, Esc, Esc stops a sleep in its shell view only, a command that waits for Enter is needs you (row, red card, sidebar) and takes the Enter in the shell view's ! band, with shots
#   app/web/dev/cdp/run.sh close  x, x closes the session (R3.6, R9): the prompt and what will stop, cancel by a key, a click or a switch, close, back from the Open list in its group, with a shot
#   app/web/dev/cdp/run.sh folders  New session and Open session in any folder (R3.3, R3.11-R3.14, R9.7): n and o, the folder list, Tab, the create row, gone folders and continue as a fork, the matcher in four lists, no open session, with shots
#   app/web/dev/cdp/run.sh viewswitch  back from a subagent the view renders once (R3.9): one view message, one reset, no other range first, on the earlier transcript
#   app/web/dev/cdp/run.sh scroll  what you last saw stays put, with a "New since" line above what came (R3.9, R5.12d): away on another session, in a subagent and a shell view, the window hidden, a reload; the line between the last seen and the first unseen item, nothing moves, it stays until you leave; it follows the bottom while you look, with shots
#   app/web/dev/cdp/run.sh tables  markdown tables in a reply 1000px and 640px wide (R5.10): short cells on one line, numbers right, stated alignment, 11px, rules between rows, inside the reply or scrolling in their box, prose still wraps a long token, with shots
#   app/web/dev/cdp/run.sh stream  a long reply with three tables streamed in small deltas while the view resizes, scrolls and switches: no long task over 200 ms, the page answers within 500 ms, then a reload (R5.10)
#   app/web/dev/cdp/run.sh sendnow  f, f sends the queued messages now (R9.8): the prompt and the marked queued bands, keep them queued, one sendNow with the draft, the bands land, insert types f, silent with nothing to send; the background route's row reads "in the background", the interrupt route's struck-through "set aside" line (2026-11-26), with shots
#   app/web/dev/cdp/run.sh agenttools  Synopia's tools for agents (R3.15): a scripted session calls start_session, the permission card, the new session under the caller in its group or a new group, shown only when you look at the caller, Always allow, the step's link, with shots (also in /tmp/synopia-start-session/)
#   app/web/dev/cdp/run.sh mcp     /mcp opens the MCP panel (R5.15): statuses with their marks, Sign in waits for the browser then Connected, Sign out, Reconnect, Disable and Enable, a failed sign-in's sentence, Esc, the / menu, a terminal's session; /unknowncmd works only in a terminal (R5.16), with shots (also in /tmp/synopia-mcp/shots/)
#   app/web/dev/cdp/run.sh creds   retried requests and the credential refresh (R8.2): the retry's attempt, sentence and countdown, needs you with the sign-in expired, the guessed command, Save runs it in a pseudo-terminal shared by the folder, its output live, a typed line, exit 0 clears, a later expiry runs it by itself, a failure's editable line, with shots
#   app/web/dev/cdp/run.sh find    find in the transcript (R5.12e, R9.9) on a generated long transcript: ⌘F in both modes, the count, Enter and Shift+Enter, ⌘G, a match in an earlier page, one in a collapsed group, Esc keeps the place, a subagent's own transcript, no long task over 200 ms, with a shot (also in /tmp/synopia-find/)
# SYNOPIA_CDP_THEME=dark run.sh <name|all> runs any check with the system appearance dark (the page follows it).
# Each run starts its own headless Chrome (its own profile, a debugging port Chrome picks) and its own backend
# (a port it picks), so runs in parallel and the app you have open never meet; both stop on exit, Ctrl-C
# included. Prints "N/M pass" and the failures; exits nonzero on a failure.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
SUITES=(dnd keys menu states earlier csp files steps preview tween images rail motion extcard restore background dark close titles queued bang viewswitch folders tables scroll stream agenttools sendnow mcp creds find)
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
if [ "$name" = earlier ] || [ "$name" = images ] || [ "$name" = background ] || [ "$name" = close ] || [ "$name" = titles ] || [ "$name" = queued ] || [ "$name" = bang ] || [ "$name" = folders ] || [ "$name" = scroll ] || [ "$name" = stream ] || [ "$name" = agenttools ] || [ "$name" = sendnow ] || [ "$name" = mcp ] || [ "$name" = creds ] || [ "$name" = find ]; then fix="$state/claude"; node "$here/$name.mjs" make "$fix" || exit 1; fi
dry=(); if [ "$name" = preview ]; then fix="$state/claude"; dry=(--dry-run); node "$here/preview.mjs" make "$fix" || exit 1; fi
if [ "$name" = extcard ]; then node "$here/extcard.mjs" make "$fix-ext" "$state/claude" || exit 1; fix="$state/claude"; fi
if [ "$name" = steps ]; then node "$here/steps.mjs" make "$fix" "$state/claude" || exit 1; fix="$state/claude"; fi
# the scripted SDK writes to the transcripts as a CLI would: never to a tracked fixture tree
if [ "$fix" != "$state/claude" ]; then cp -R "$fix" "$state/claude" || exit 1; fix="$state/claude"; fi
# the rail check's shells write their output under this run's state folder (made up, R7.2)
if [ "$name" = rail ]; then node "$here/rail.mjs" make "$fix" "$state/tasks" || exit 1; fi

# the made-up sessions' sandbox folders under /tmp exist, as a real session's folder does (a missing one reads
# "Folder gone", R3.11); the folders check keeps its gone one gone
[ "$name" = folders ] || node "$here/sandboxes.mjs" "$fix" || exit 1
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
  extcard|preview|images|rail|background|dark|close|titles|queued|bang|folders|tables|scroll|agenttools|sendnow|mcp|creds|find) echo "shots: $state/$name-*.png" ;;
esac
if [ "$name" = dnd ]; then stop; start; runCheck "$here/dnd.mjs" "$(cat "$state/url")" "$state" after-restart || code=1; fi
exit $code

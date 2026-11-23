# Synopia app: handover for the technical plan

Written 2026-11-23 at the end of the prototyping session.

## Where things are

- `docs/requirements.md`: what to build. Every decision from the prototyping session, plus what was rejected.
- `prototype/app.html`: the UI reference. Run `python3 -I export_transcripts.py` first, then open it in Chrome. `?demo=ask6#d0d0d0d0` and similar show the "needs you" cards.
- `spike/FINDINGS.md`: what the Claude Agent SDK can do, checked with real runs (resume, fork, images, `canUseTool`, AskUserQuestion, skills, subagent events, interrupt, status). Its gotchas section matters for the design.
- `export_transcripts.py`: how to read sessions, subagents, patches, questions and background work from Claude Code's files today. Useful as a reference parser.

## The next step

Write the technical plan in a fresh session. **Milestone 1 = what the prototype already does, running for real in the native app**:
- Live open sessions, without the export loop.
- Transcripts, subagents and background work.
- Files and diffs.
- The needs-you cards, answering for real through the SDK.
- Keys and modes.
- Drag-and-drop groups.

No badges or notifications yet. Inputs: `docs/requirements.md`, `spike/FINDINGS.md`, and `prototype/app.html` for the look. Open points it needs to settle:

1. **Shell. Decided starting point (2026-11-23):** a small native Swift shell (AppKit window, menus, shortcuts) hosting the prototype's web UI in WKWebView, plus a Node backend that runs the Agent SDK.
   - A locally built Swift app launched fine on this machine under Jamf Protect (experiment A, `swiftc`, nothing downloaded). Chrome's `--app` window works too, as a fallback.
   - Electron is out for now: it needs a ~150 MB downloaded runtime that Jamf may block, and adds a second browser engine.
   - Fully native SwiftUI is out: there's no Swift Agent SDK, and the custom UI would be a rewrite.
   - The shell talks to the page through WKScriptMessageHandler / evaluateJavaScript. Native extras (Dock badge, notifications) come later; when they do, the shell should read state from the backend, not the page.
2. **Session ownership.**
   - Adopting a live CLI session needs that process closed first, since there's one writer per session.
   - How Synopia finds open sessions: `~/.claude/sessions` and its own SDK sessions.
   - What the "closed" state means and where it's stored.
3. **Status.**
   - Live state comes from SDK events (undocumented env flag) for Synopia's own sessions, and from the session files for others.
   - "Needs you" is derived from the pending step, not only from the status.
4. **Claude-written content.** Titles, the "Now" line, drift detection, the closing note and grouping suggestions: which model, when they're regenerated, the cost.
5. **Persistence.** The user's layout (groups, order), "reviewed" marks, notes, and per-session model choice.
6. **Answering.** Questions, permissions and plans through `canUseTool`, including notes (`annotations.notes`), "always allow" rules, and `permissionMode: 'default'` despite the user's `auto` setting.
7. **Rendering.** The CLI-like transcript from SDK messages, not from re-reading JSONL, and the diffs from `structuredPatch`.

The user's global rules (from `~/dev/agent-harness`) apply:
- Delegate self-contained work to background subagents and name the fitting skill.
- Mark deliverables for review with `For review:`.

## Technical plan (2026-11-23)

- Draft for review: `docs/technical-plan.md`. Decisions, digests and critic reviews: `.attack-plan/synopia-m1/` (ledger.md holds the author's answers Q1-Q11).
- Big changes from this handover: Synopia is unaware of the terminal (no pid files, no take-over); transcripts come from JSONL tailing for every session; sessions keep the user's `auto` mode; SDK and CLI used through their documented surface only.

## Build status

- S1-1 (branch `s1-1`): `app/backend` with pinned `@anthropic-ai/claude-agent-sdk` 0.3.330 and `ws` 8.23.0; `npm ci` installs cleanly on this machine and brings the `claude-agent-sdk-darwin-arm64` package with its `claude` binary (about 364 MB). `main.ts`, `server.ts` (Host/Origin at the upgrade, auth frame, 32 MB maxPayload, `hello`, `/api/quit-check`), `lock.ts` (pid file, stale lock taken over), `log.ts`, `store.ts` (defaults, debounced atomic write, `reconcileLayout`), placeholder `app/web/index.html`, `app/dev.sh`, `app/check.sh`. `hello` carries `menu: {}` until `menu.ts`; `sessions` and `pending` are empty. Close code 4001 means a failed auth.
- S1-3 (branch s1-3): the page is split into `app/web/` (index.html, css/app.css, js/*.js as classic scripts, icon/), still fed by `transcripts.js` and `menu.js`. Headless screenshots on the hand-written fixture (`app/web/dev/compare.sh`) match the prototype in 4 states; the only difference is the dropped "N open sessions" footer. Line map and drops in `app/web/dev/PORT.md`. `.slash` CSS kept: the slash menu uses it.
- S1-4 (core): `app/backend/src/tail.ts` (Tailer: offset tailing, partial-line buffer, reset on shrink, inode change or same-size rewrite; SubagentWatcher) and `src/transcript.ts` (Transcript reducer, `findTranscript`, `sessionDirOf`), fixtures under `test/fixtures/claude/projects/-tmp-fixture/`, 25 tests pass. A synthetic 50 MB file parses in well under 2 s (about 50-300 ms). On Node 22.13 `node --test test/` fails (a directory isn't accepted): run `node --experimental-strip-types --test` from `app/backend`, or pass `'test/*.test.ts'`. `view`/`items` wiring and `fake-driver.ts` still to do.
- S1-5 (branch `s1-5`, with the rest of S1-4): `src/views.ts` (tailer and reducer per open session and subagent; `session`, `agents`, `background` to every page; `items` reset with the last 160 plus `total` on `view`, then upserts of changed ids within the page's window; status, `pending`, `stream`, `toast` set by a driver) and `src/fake-driver.ts` (`--fake` needs `--claude-dir`; every `projects/*/*.jsonl` is open; steps from `<claude-dir>/fake-script.json`; an `answer` clears its request). `main.ts` also stores `layout` (via `reconcileLayout`) and `reviewed`; other page messages are logged and ignored. Page: `store.js` + `bridge.js` on the protocol, nothing in localStorage; `renderConv` mounts the view once and `renderHeader`/`renderLog`/`renderCard`/`renderRail` draw panels; the log is keyed blocks (`patchChildren`), so unchanged blocks, open `<details>` and open diffs stay. Cards come from `pending` through `askOf`/`withPending` in `card.js`; the session status is from the transcript ("idle", `statusAt` = last record) until a driver sets it. `hello.sessions[]` carries `agents`, `background` and `stream` for every session (the sidebar needs them); `session` has no `bg`/`toReview` counts, the page derives them. `compare.sh` shots match the prototype in 6 states; a CDP check (appends, a tool going to done, draft and focus kept, answer clearing a card, subagent view) passed 15 of 15.
- S1-6 (branch `s1-6`): `src/driver.ts` (one `query()` per active session over an `InputQueue`; options per section 6; canUseTool denies with "Synopia can't answer this yet. Ask in plain text instead." and toasts; stderr tail of 20 lines in memory), `src/sessions.ts` (placeholder `new-<uuid>`, not stored until `system/init`; id swap on init and on `conversation_reset` with an alias map; `open[]`, layout, models, rules, status move with the id; resume on the first message after a restart; 30 min idle end; `StreamPreview` keyed by message id and block, cleared when a record of that message and block type lands, and on `result`), `src/status.ts` (busy, waiting, idle, stopped, failed; fallback from send to `result` without the state flag; `status` stored in state.json). `views.ts` gained `rekey`, `facts`, a 1 s look for a file that doesn't exist yet, and `onAssistant`. `settings.model` (optional) is the model for new sessions. The shell passes `SYNOPIA_STATE_DIR` as `--state-dir` (`open --env SYNOPIA_STATE_DIR=… build/Synopia.app`). Live check on haiku in `/tmp/synopia-scratch/s1-6`: three turns (one with a PNG) went busy then idle, `stream` and `items` arrived, the placeholder swapped once; after a backend restart a fourth message resumed the same id (the resume used the transcript's `requestedModel`, a full model id). Settled: the JSONL appears about 1 s after init. Quitting a backend left no CLI process.
- S2-1 (branch `s2`): `Sessions.listRecent` (SDK `listSessions()` with no limit, sorted by `lastModified`, open ids and sessions without `cwd` left out, filter on title or folder server-side, 50 at most; title `customTitle`, else `summary`, else `firstPrompt`, first line) and `openSession` (adds or un-closes the `open[]` entry, keeps its layout place, status age from `lastModified`). `recent` echoes the `filter` so the page drops stale replies. Page: `open-list.js` (over the main area; ↑↓ always move, j/k only while the filter is empty), the footer's "Open session" line. Settled: `listSessions()` honours `CLAUDE_CONFIG_DIR` (page checks run a real backend on a fixture copy that way, never on `~/.claude`); it took 87 ms over this machine's sessions. Live check: a `claude -p --model haiku` session from `/tmp/synopia-scratch/s2-cli` was listed, opened with its 2 items, and a message resumed the same id in the same JSONL (it grew, no swap).
- S2-2 (branch `s2`): `SessionProcess.interrupt()` reads `capabilities` from `system/init`; with `interrupt_cancel_queued_v1` it calls `interrupt({cancelQueued: true})` (cast: the typed signature takes no argument), maps the receipt's `cancelled` uuids to the texts it pushed (last 100 kept) and sends `restore`; otherwise the plain `interrupt()`, and a toast when `still_queued` lists our messages. `SessionStatus.interrupted()` makes the turn's result "stopped" whatever its subtype. `views.restore` added (one method, no rendering). Page: Esc in normal mode during a running turn puts "Interrupt? Esc again to stop. Any other key to keep working." in the message box (the typed text stays underneath); a second Esc sends `interrupt`, any other key or a click dismisses; `restore` puts the texts before what you typed. Settled on CLI 2.1.330 (haiku, `/tmp/synopia-scratch/s2`): init advertises `interrupt_cancel_queued_v1`; `interrupt({cancelQueued: true})` is honoured (the queued message came back in `cancelled`, never ran); the status went stopped; a background `sleep 90` kept running (its `background` item stayed running); a "[Request interrupted by user" prompt item landed.
- S2-3 (branch `s2`): `Sessions.close` (ends the process now, `closedAt` set, `removed`; a placeholder is just dropped), `quitCheck` (running turns, and `subagent`/`shell`/`monitor` work of sessions with a live process, from `views.facts().runningWork`), `--idle-ms` (test-only idle end). Page: "Close session" asks with `confirm()` when a turn or background work runs; the sidebar keeps closed ids in the layout and only hides them (`shown()`), so a reopened session is back in its group. Shell: `runJavaScriptConfirmPanel` as an NSAlert sheet ("Close session" / "Cancel"); ⌘Q fetches `/api/quit-check` and asks with "Quit Synopia? 1 session is working and 1 background shell will stop."; SIGTERM quits without asking. Live check on haiku: quit-check listed the running turn; close gave `removed`, the id stayed in group "Scratch", stayed gone after a backend restart, was in the Open list and the page put it back under "Scratch"; with `--idle-ms 5000` the process ended after about 7 s (`driver.idleEnd`, exit ended=true, no toast) and the next message resumed it. The quit NSAlert and the close sheet are not checked (no UI scripting here).

## Facts to check

- Streaming preview: whether every streamed content block (thinking included) lands as its own assistant record with the message's `message.id` (the preview clears a block when a record of that message and block type lands; `result` clears the rest).

- `system` record with `subtype: "turn_duration"`: the name of the duration field (code reads `durationMs`, a number).
- `permission-mode` record: the name of the mode field (code reads `permissionMode`).
- S1-2 (branch `s1-2`): `app/shell` (main, AppDelegate, Backend, WebView, Menus, Info.plist) and `app/build.sh` into `build/Synopia.app`. Checked: node runs as the shell's child, the port answers 200, the page authenticates (`ws.authed`), SIGTERM (handled like ⌘Q) and `kill -9` of the shell both end the backend (`backend.stop reason=stdin`), a killed backend leaves the shell up. `NSWindow.allowsAutomaticWindowTabbing = false` keeps ⌘⇧[ off the Window menu. `confirmQuitIfWorking` in AppDelegate.swift is the S2-3 stub. Agents must not use `screencapture` or `osascript`/System Events (they need permissions the author may not grant). For a screenshot use `open --env SYNOPIA_SNAPSHOT=/tmp/x.png build/Synopia.app`: the shell writes a `WKWebView.takeSnapshot` PNG 1.5 s after the first page load. Quit with `pkill -TERM -x Synopia`.
- ExitPlanMode `canUseTool` input: whether the plan text is in `input.plan` (the typings don't list it; the page's plan card reads `request.input.plan`).

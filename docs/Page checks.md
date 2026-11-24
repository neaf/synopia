# Page checks

How Synopia's automated checks run, and the browser and test-runner facts they depend on. The automated checks are the contract: no manual checklist exists. Sources: code in `app/check.sh`, `app/web/dev/`, and the commits named below.

## Commands

| Command | Runs |
|---|---|
| `app/check.sh` | backend unit tests, `swiftc -typecheck` of the shell, `node --check` of every page script; one pass or fail line each |
| `app/check.sh --page` | the above, then `run.sh all` (22 suites); four pass lines |
| `app/web/dev/cdp/run.sh <suite>` | one page suite; the list and what each covers is at the top of `run.sh` |
| `app/web/dev/cdp/run.sh all` | every suite one after the other, a table of suite and result, failures under it; each suite's full output stays in the folder it prints |
| `SYNOPIA_CDP_THEME=dark app/web/dev/cdp/run.sh <suite>` | the suite with the system appearance dark |
| `app/dev.sh --script` | the backend on the scripted SDK over a copy of the fixture tree below (`--claude-dir <tree>` for another), for looking at the page by hand; prints the URL to open |
| `app/web/dev/compare.sh` | screenshots of `prototype/app.html` and the port side by side in `/tmp/synopia-compare/shots/` |

- Each `run.sh` run starts its own headless browser (a temp `--user-data-dir`, `--remote-debugging-port=0`, the port read from `DevToolsActivePort`) and its own backend (`--port 0`, the port read from the ready line) on a fresh state folder. A `trap` stops both on exit, Ctrl-C too, and only its own pids. So two runs, other agents' runs and an open app never share anything.
- A run prints `N/M pass`, the failures and where its shots are. Its exit code is the result: 0 only when every check passed and at least one ran.
- The backend under the suites runs the real Sessions, status, writer and menu code on the scripted SDK (below), over a copy of `app/backend/test/fixtures/claude/` in the run's state folder with its `sdk-script.json`: a multi-select question (`#22222222`), a permission with an "Always allow" suggestion (`#33333333`), a plan (`#55555555`), a working session with subagents and a stream preview (`#44444444`), an idle session with diffs whose process gives the menu (`#11111111`). `run.sh` passes `--claude-dir <tree> --sdk-script <tree>/sdk-script.json`, and `--dry-run` for `preview`.
- `states` and `rail` use copies of the trees `claude-states` and `claude-rail`. `earlier`, `viewswitch` (through `earlier.mjs make`), `images`, `background`, `close`, `titles`, `queued`, `bang`, `preview`, `extcard` and `steps` write their own tree and script into the run's state folder first (`node <suite>.mjs make …`, called by `run.sh`; `helpers.mjs` `writeScript`, `running`, `terminal`).
- Page hooks: `?agent=<id>` opens a subagent, `&open=1` expands the last diff. `rail.mjs` and `restore.mjs` use them.

## The scripted SDK

`app/backend/dev/scripted-sdk.ts`, loaded by `main.ts` only with `--sdk-script <file>` (which needs `--claude-dir`). The SDK facts it reproduces are in docs/Agent SDK.md, "The scripted SDK". The script is `<tree>/sdk-script.json`; a missing file is an empty script.

| Field | Meaning |
|---|---|
| `home` | `~` in paths shown (the fixtures use `/Users/fixture`) |
| `menu` | `{commands, models}` in the SDK's `SlashCommand` and `ModelInfo` shapes: what a process and the menu probe answer |
| `writer` | `{title, now}`: the writer's reply; without it every writer call fails and nothing is written |
| `onSend` | steps for a message that starts a turn, in sessions with no `onSend` of their own |
| `sessions.<id>.state` | seeded into a fresh state folder: `status` and `ago` (ms), `cwd` (the open entry's folder, else the records'), `endedAgo` (Synopia's last process for it ended then: a tool or ask it left reads as stopped) |
| `sessions.<id>.start` | its process starts at load, with no message (`Sessions.startIdle`, test-only, no folder check), as a resumed session waiting for input |
| `sessions.<id>.steps` | played once, when its first process starts in this daemon |
| `sessions.<id>.onSend` | played on each message that starts a turn |

A step has one or more of: `message` (an SDK message the query yields; `session_id` and `uuid` filled in), `ask` (a `canUseTool` call: `tool`, `input`, `id` the request id, `toolUseId`, `suggestions`, `agentId`; the next step waits for its answer), `append` (records written to the transcript), `send` (a message you send, through `Sessions.send`), plus `after` (ms after the step before) and `ago` (ms: the step plays in the past).
- The clock: while a step with `ago` plays, Sessions' clock reads that much earlier, so a status, a card's `since` or a stale timer starts in the past. Steps play one at a time across sessions, each handled before the clock moves back.
- Seeding: a state folder whose `state.json` has no `open` list gets every `projects/*/<id>.jsonl` of the tree in id order, each with the script's status, else "your turn" since its last record. Fields already there stay (titles.mjs writes `written` first). A restart on the same folder seeds nothing and plays the steps again.
- Terminals: every `<tree>/sessions/<pid>.json` is a live Claude Code in a terminal that isn't Synopia's (`helpers.mjs` `terminal`); its process is never asked. A take-over's signal is logged as `scripted.kill` and the pretend CLI exits. Nothing real is signalled and no login shell runs.
- What reads as whose: a session with its own process is `driven`; one a terminal holds, or whose turn or question the transcript alone shows (no process of Synopia's), is not (`status.ts` `detail.external`). A transcript turn left open with recent records reads as another process's: a "driven, idle" session of a check has `start: true`.
- The script writes to the tree's transcripts as a CLI would, so `run.sh`, `dev.sh --script` and the backend tests run on a copy.

## Comparing with the prototype

`compare.sh` starts `dev.sh --script` on a temp state folder, builds `transcripts.js` and `menu.js` for a temp copy of `prototype/app.html` from the same fixtures (`build-proto-fixture.ts`: the backend's Views and Sessions on the scripted SDK in one process, and the page's `card.js`), and screenshots both at 1280 by 820 with reduced motion. States: waiting (question card), permission, plan, busy (subagent wave), diff, agent (subagent view). It never touches `prototype/transcripts.js`.

Expected differences, all deliberate:
- no "N open sessions" footer;
- no "Tab “…”" clause in the header (Synopia knows no terminal tabs);
- "… N earlier items not shown" and "diff cut at 400 lines" without "in this prototype", so a cut diff is a little narrower;
- the subagent view's placeholder says "Message <session title>", not "… about this subagent".

## Focus rule: chrome-headless-shell only

- Symptom: a check run activates a browser, shows it in the Dock and takes keyboard focus from the desktop.
- Cause: Google Chrome.app run with `--headless` still registers as a macOS app.
- Workaround: `chrome-bin.sh` picks `$CHROME`, else the newest Playwright `chrome-headless-shell` under `~/Library/Caches/ms-playwright/chromium_headless_shell-*/`, a plain binary with no app bundle. Install it with `npx playwright install chromium-headless-shell`. With neither, `chrome-bin.sh` exits 1 with that hint and `chrome.sh` and `compare.sh` stop; there is no fallback to a browser app (NFR-04). `chrome.sh` passes no `--headless` flag: the shell is headless already.
- Never launch Google Chrome.app, Chrome for Testing.app or `build/Synopia.app` from a check, and use no osascript, UI scripting or screencapture.
- Code: `app/web/dev/chrome-bin.sh`, `cdp/chrome.sh`. Commit c4374af.

## Browser quirks the harness handles

### Quirk: first key after a load is dropped

- Symptom: the first key a check sends after navigation has no effect.
- Cause: headless Chrome can drop the first key event after a load. Cause unknown beyond that.
- Workaround: before the first key on each document, `c.key()` sends no-op Shift keys (up to 20, with `Page.bringToFront`) until a capture-phase `keydown` listener fires. Checks need no workaround of their own.
- Code: `cdp.mjs` `raw`, `prime` and `key` (67-87).

### Quirk: hidden or unfocused pages get no frames

- Symptom: animations and `requestAnimationFrame` stall; each CDP mouse event waits about 5 s.
- Cause: a page that reports hidden or unfocused (display asleep, a settings tab the browser opens itself) gets no animation frames.
- Workaround: `Emulation.setFocusEmulationEnabled {enabled: true}` and `Page.bringToFront` at connect and before each load; the ready signal requires `visibilityState === 'visible'` and `document.hasFocus()`. `chrome.sh` also passes `--disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding`.
- Code: `cdp.mjs` 42-45 and `load`; `chrome.sh`.

### Injected scripts are outside the page's CSP

A script added with `Page.addScriptToEvaluateOnNewDocument` is not subject to the page's CSP and runs before the page's own scripts. The harness wraps `WebSocket` there to count socket messages by type (`__synSeen`): a listener added in the constructor runs before the `onmessage` the page sets later. `csp.mjs` relies on the same fact to plant a handler and check the page blocks its own inline copy. Code: `cdp.mjs` `SEEN` (7-10); `csp.mjs` 15.

### Web-font swap

- Symptom: a block moves about 52 px between a measurement and a click.
- Cause: fonts load with `display=swap`; the swap rewraps text after first paint.
- Workaround: checks that measure position wait for `document.fonts.ready`.
- Code: `earlier.mjs` 57-59. Commit 844aba1.

### One browser at a time for animation suites

Two `run.sh all` at once pass, but `tween` and `motion` sample animation frames, so they are steadier with one browser running. Source: runs on the baseline machine, 2026-11-24.

## Writing a check

- `connect()` from `cdp.mjs` needs `SYNOPIA_CHROME_PORT`, which `run.sh` sets. Each check times out after 180 s.
- `await c.load(url, extra)` navigates and waits for ready: the first `hello`, the sidebar rendered, the message box, the current view's first `items`, no UI restore in flight, the window visible and focused, plus `extra`. The page's half is `__synopia.ready()`; on a timeout the failure prints `__synopia.readiness()`. Do not navigate and sleep.
- A check reads the page through the test API below and the DOM only, never through page globals.
- `c.ev(expr)` returns the expression's value and throws on a page exception (a `PageError` naming the expression). A throw anywhere ends the check with `FAIL the check threw: …` after the checks counted so far, and exit 1.
- `c.check(name, ok)` passes only when `ok === true`. A truthy string, number or object fails, with what it got. Compare explicitly or use `!!`.
- `c.print()` prints `N/M pass` and the failures and sets exit code 1 on a failure. A check that recorded nothing prints `FAIL no checks ran`. Never `process.exit(0)` after it.
- Wait with `c.until(expr, ms)` (default 5000; `until` in `helpers.mjs`), never a fixed sleep. It polls until the value is `=== true`; a throw counts as not yet, and a throw on the last try is rethrown. A suite has no `until` of its own.
- `helpers.mjs` holds the shared pieces: `until`, `sleep`, `PageError`, `keyTable(c.key)` (letters, Shift letters, `esc`, `enter`, `tab`, `space`, `backspace`, `slash`, arrows, `next`/`prev` for Cmd-Shift-]/[, `cmdF`), `shot(c, file, clip)`, the test API wrappers `page(c)`, `spySent(c)` and `inject(c, msg)`, `serverSend(url, ...msgs)` (frames to the backend from a socket of its own, for state the page must find at load, such as a layout), and the record builders `line`, `fresh` and `records(cwd, ts)` with `rec`, `you`, `said` and `tool`. It imports nothing from `cdp.mjs`, so `make` modes use it without a browser.
- When two page actions must both happen before a server reply, do them in one `ev`.
- `crc32` from `node:zlib` (Node 22.2+) builds the PNG fixtures in `images.mjs` 11.
- A new suite goes in `SUITES` and the header list in `run.sh`; a fixture it writes goes through the `make` branch there.

## Test API: `window.__synopia`

`app/web/js/test-api.js` defines it; `index.html` loads it before `bridge.js`. Page modules may change freely behind it. A getter returns a copy (`structuredClone`), so a check cannot change the page through it. Write `__synopia.cur()` inside a page expression; `page(c).cur()` from the suite.

| Member | Returns |
|---|---|
| `ready()` | `true` once the first `hello` is applied, the sidebar has a row, the message box exists, the current view is mounted and no UI restore is in flight |
| `readiness()` | the parts of `ready()`: `{connected, uiLoaded, restoring, rows, box, current, mounted}` |
| `current()` | the shown session's id, or null |
| `view()` | the subagent id shown, null for the main conversation |
| `mode()` | `"normal"` or `"insert"` |
| `mounted()` | `"<sid>\|<agent>"` of the view on screen, or null |
| `restoring()` | `true` while a restored view still waits for its items |
| `cur()` | the shown session: `{id, title, status, driven, items, total, agents, background, outbox, …}` |
| `data()` | every session, in the server's order (only the viewed one holds items) |
| `pending(sid)` | that session's requests (question, permission, plan), oldest first |
| `layout()` | the sidebar's groups, closed sessions' ids included |
| `spy()` | starts recording, dropping what an earlier `spy()` recorded |
| `sent(...types)` | frames the page sent since `spy()`, of those types (all with none) |
| `received(...types)` | frames from the server since `spy()`, before the page applied them |
| `inject(msg)` | hands `msg` to the page's message handler, as if the server sent it |
| `anchor()` | the log's scroll anchor: `{id, off}` (an item block's key and the pixels into it) or `{bottom: true}` |
| `from(sid, agent)` | the oldest item id that view had loaded (sent with `view`), or null |
| `attachments()` | the message box's pasted images: `{id, n, mediaType, url, data}`, `data` null until read |
| `prompt()` | the prompt above the box: `"interrupt"` (Esc), `"background"` (b), `"close"` (x) or null |
| `card(sid)` | the cursor and picks of that session's card (`{qi, oi, picks, own, notes, target, …}`; the shown session without `sid`), or null |
| `cards()` | every card's state, keyed `"<sid>:<request id>"` |
| `preview()` | the file preview: `{shown, path}` |
| `openList()` | the Open list: `{shown, filter}` |
| `marks()` | every mark kind in the marks table |
| `mark(kind, size)` | a mark's markup, `size` in px |
| `render(...parts)` | re-renders `"side"`, `"conv"`, `"header"`, `"log"`, `"card"` or `"rail"`, as a server message does |
| `redraw()` | re-renders the transcript with every block replaced |
| `resetTweens()` | the sidebar forgets its sub-line tweens, so the next render is a fresh one |

- Nothing is recorded until `spy()`; in use the API costs a null check per frame. `bridge.js` calls `testSent` in `send` and `testGot` before `onMessage`.
- No suite reads a page global. State goes in by `inject` (a server message) or `serverSend` (stored before a load), actions by the DOM: a click, a key, a `pagehide` event (`ui.js` flushes the UI state on it).
- Switch views the way a user does: click `#conv [data-agent="<id>"]` for a subagent, `#conv [data-back]` for the main conversation, a `#groups .row` for a session.
- Open things as a user does: `#open` for the Open list, `#theme` for the theme (Alt-click follows the system), a clicked `a[data-path]` for the file preview and a clicked `.thumb[data-full-src]` for the image viewer. Both are document-level click handlers (`transcript.js`, `images.js`), so a link or thumbnail the check adds works too.
- The protocol has no message that drops a background entry or a subagent. `tween` and `motion` inject a `session` message with the shorter list; `applySession` copies every field it gets (`store.js`).

## Backend tests

- `node --test test/` fails on a directory in Node 22.13; pass a glob: `node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/*.test.ts`. Code: `check.sh` 16-17, `backend/package.json` 8.
- `daemon.test.ts` spawns the real `main.ts` with `--experimental-strip-types`. The restart test leaves a detached successor that the test must kill (232-268).
- The contract tests run a real daemon through `test/daemon-harness.ts` (`startDaemon`, `connectPage`, `api`, `fixtureCopy`): `protocol-golden.test.ts` (the server's frames on the fixture tree against `test/golden/*.json`; `SYNOPIA_GOLDEN=update` rewrites them, then read the diff), `router.test.ts` (page frames and what they change), `shell-contract.test.ts` (what `Backend.swift` and `AppDelegate.swift` decode) and `handover.test.ts`.
- `handover.test.ts` runs on a copy of `app/backend` whose `main.ts` each case replaces, and takes about 35 s: the 20 s successor timeout and two 10 s code-hash reads (`daemon.ts` `startSuccessor`, `UPDATE_READ_MS`) are fixed in the code. Its three cases run concurrently.
- The handover test makes work start on cue with `send` frames: under the main fixture's script a message that starts a turn is worked on for 3 s (`sdk-script.json` `onSend`).

## Date-relative fixtures

Status depends on age: `STALE_MS` 15 min, `QUIET_MS` 30 min, `ASK_STALE_MS` 12 h (`status.ts` 57, 60, 63). A fixture record with a fixed date flips status once it ages past a threshold.
- Date such records at run time, or touch the fixture file's mtime.
- `badge.test.ts` 18-21 sets a tracked fixture file's mtime to now; 126-127 dates an appended record now. Commit 3c6f8c2.

## Real data

Fixtures, storyboards and captured menus hold invented data only. Never copy from `~/.claude/projects` or `~/.claude/sessions`, never read `~/.claude/sessions/*.key`, and never commit `prototype/transcripts.js` or `spike/logs/`.

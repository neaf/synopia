# Page checks

How Synopia's automated checks run, and the browser and test-runner facts they depend on. The automated checks are the contract: no manual checklist exists. Sources: code in `app/check.sh`, `app/web/dev/`, and the commits named below.

## Commands

| Command | Runs |
|---|---|
| `app/check.sh` | backend unit tests, `swiftc -typecheck` of the shell, `node --check` of every page script and the page unit tests (`node --test app/web/test/*.test.js`); one pass or fail line each |
| `app/check.sh --page` | the above, then `run.sh all` (29 suites); four pass lines |
| `app/web/dev/cdp/run.sh <suite>` | one page suite; the list and what each covers is at the top of `run.sh` |
| `app/web/dev/cdp/run.sh all` | every suite one after the other, a table of suite and result, failures under it; each suite's full output stays in the folder it prints |
| `SYNOPIA_CDP_THEME=dark app/web/dev/cdp/run.sh <suite>` | the suite with the system appearance dark |
| `app/dev.sh --script` | the backend on the scripted SDK over a copy of the fixture tree below (`--claude-dir <tree>` for another), for looking at the page by hand; prints the URL to open |
| `app/web/dev/compare.sh` | screenshots of `prototype/app.html` and the port side by side in `/tmp/synopia-compare/shots/` |

- Each `run.sh` run starts its own headless browser (a temp `--user-data-dir`, `--remote-debugging-port=0`, the port read from `DevToolsActivePort`) and its own backend (`--port 0`, the port read from the ready line) on a fresh state folder. A `trap` stops both on exit, Ctrl-C too, and only its own pids. So two runs, other agents' runs and an open app never share anything.
- A run prints `N/M pass`, the failures and where its shots are. Its exit code is the result: 0 only when every check passed and at least one ran.
- The backend under the suites runs the real Sessions, status, writer and menu code on the scripted SDK (below), over a copy of `app/backend/test/fixtures/claude/` in the run's state folder with its `sdk-script.json`: a multi-select question (`#22222222`), a permission with an "Always allow" suggestion (`#33333333`), a plan (`#55555555`), a working session with subagents and a stream preview (`#44444444`), an idle session with diffs whose process gives the menu (`#11111111`). `run.sh` passes `--claude-dir <tree> --sdk-script <tree>/sdk-script.json`, and `--dry-run` for `preview`.
- `states` and `rail` use copies of the trees `claude-states` and `claude-rail`. `earlier`, `viewswitch` (through `earlier.mjs make`), `images`, `background`, `close`, `titles`, `queued`, `bang`, `folders`, `preview`, `extcard`, `steps`, `scroll`, `agenttools`, `sendnow` and `mcp` write their own tree and script into the run's state folder first (`node <suite>.mjs make …`, called by `run.sh`; `helpers.mjs` `writeScript`, `running`, `terminal`).
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
| `mcp` | `{servers: [{name, status, kind, scope}], loginMs, pendingMs, failLogin}`: the MCP servers every query reports, and the pretend `claude mcp login` (R5.15; docs/Agent SDK.md, "MCP servers: status, sign-in") |
| `mcp` | `{servers: [{name, status, kind, scope}], loginMs, pendingMs, failLogin}`: the MCP servers every query reports, and the pretend `claude mcp login` (R5.15; docs/Agent SDK.md, "MCP servers: status, sign-in") |

A step has one or more of: `call` (a call of one of Synopia's own tools, `{tool, input, toolUseId}`: the records the CLI writes, `canUseTool`, then the tool itself; the next step waits for it), `message` (an SDK message the query yields; `session_id` and `uuid` filled in), `ask` (a `canUseTool` call: `tool`, `input`, `id` the request id, `toolUseId`, `suggestions`, `agentId`; the next step waits for its answer), `append` (records written to the transcript), `send` (a message you send, through `Sessions.send`), plus `after` (ms after the step before) and `ago` (ms: the step plays in the past).
- The clock: while a step with `ago` plays, Sessions' clock reads that much earlier, so a status, a card's `since` or a stale timer starts in the past. Steps play one at a time across sessions, each handled before the clock moves back.
- A check that injects a `session` frame to change a status sends the whole `state` the backend would (`background.mjs`, `tween.mjs`): the page derives nothing from `status`.
- Seeding: a state folder whose `state.json` has no `open` list gets every `projects/*/<id>.jsonl` of the tree in id order, each with the script's status, else "your turn" since its last record. Fields already there stay (titles.mjs writes `written` first). A restart on the same folder seeds nothing and plays the steps again.
- Terminals: every `<tree>/sessions/<pid>.json` is a live Claude Code in a terminal that isn't Synopia's (`helpers.mjs` `terminal`); its process is never asked. A take-over's signal is logged as `scripted.kill` and the pretend CLI exits. Nothing real is signalled and no login shell runs.
- What reads as whose: a session with its own process is `driven` (`state.driven`); one a terminal holds, or whose turn or question the transcript alone shows (no process of Synopia's), is not (`status.ts` `detail.external`). A transcript turn left open with recent records reads as another process's: a "driven, idle" session of a check has `start: true`.
- Folders (R3.11): a session whose folder is missing reads "Folder gone" and has no message field. Folders under the script's `home` count as there without a stat (`Scripted.pretendFolder`, through `Sessions` `pretendFolder`), and `run.sh` makes the `/tmp/…` folders the tree's records name (`sandboxes.mjs`) for every suite but `folders`, which keeps its gone folder (`/tmp/synopia-folders/dev/demo-app.billing`) missing. `folders.mjs make` also writes the run's `state.json` with one open session, so the other three are past sessions for the Open list.
- Forks: a query with `resume` and `forkSession` gets a new id and a copy of the old transcript under the new cwd's project folder; a process that took only `shouldQuery: false` context still sends `system/init`.
- The script writes to the tree's transcripts as a CLI would, so `run.sh`, `dev.sh --script` and the backend tests run on a copy.

## Comparing with the prototype

`compare.sh` starts `dev.sh --script` on a temp state folder, builds `transcripts.js` and `menu.js` for a temp copy of `prototype/app.html` from the same fixtures (`build-proto-fixture.ts`: the backend's Transcripts, Publisher and Sessions on the scripted SDK in one process, one page viewing each conversation, and the page's `card.js`), and screenshots both at 1280 by 820 with reduced motion. States: waiting (question card), permission, plan, busy (subagent wave), diff, agent (subagent view). It never touches `prototype/transcripts.js`.

Expected differences, all deliberate:
- no "N open sessions" footer;
- no "Tab “…”" clause in the header (Synopia knows no terminal tabs);
- "… N earlier items not shown" and "diff cut at 400 lines" without "in this prototype", so a cut diff is a little narrower.

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
- Cause: a font face loads only when text first needs it, and text set before it arrives rewraps when it does. The bundled faces (`app/web/fonts`, `app.css` `@font-face`, `font-display: block`) are local, so this is rare, but a weight first used by a later render still loads then.
- Workaround: checks that measure position wait for `document.fonts.ready`. `csp.mjs` checks that both families load from the bundle and nothing comes from another host.
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
- `helpers.mjs` holds the shared pieces: `until`, `sleep`, `PageError`, `keyTable(c.key)` (letters, Shift letters, `esc`, `enter`, `tab`, `space`, `backspace`, `slash`, arrows, `next`/`prev` for Cmd-Shift-]/[, `cmdF`), `shot(c, file, clip)`, the test API wrappers `page(c)`, `spySent(c)` and `inject(c, msg)`, `serverSend(url, ...msgs)` (frames to the backend from a socket of its own, for state the page must find at load, such as a group made with `newGroup` and `moveSession`), and the record builders `line`, `fresh` and `records(cwd, ts)` with `rec`, `you`, `said` and `tool`. It imports nothing from `cdp.mjs`, so `make` modes use it without a browser.
- When two page actions must both happen before a server reply, do them in one `ev`.
- `crc32` from `node:zlib` (Node 22.2+) builds the PNG fixtures in `images.mjs` 11.
- A new suite goes in `SUITES` and the header list in `run.sh`; a fixture it writes goes through the `make` branch there.

## Test API: `window.__synopia`

`app/web/js/test-api.js` defines it, an ES module that `main.js` installs before it connects. Page modules may change freely behind it. A getter returns a copy (`structuredClone`), so a check cannot change the page through it. Write `__synopia.cur()` inside a page expression; `page(c).cur()` from the suite.

| Member | Returns |
|---|---|
| `ready()` | `true` once the first `hello` is applied, the sidebar has a row, the message box exists, the current view is mounted and no UI restore is in flight |
| `readiness()` | the parts of `ready()`: `{connected, uiLoaded, restoring, rows, box, current, mounted}` |
| `current()` | the shown session's id, or null |
| `view()` | the subagent id shown, null for the main conversation |
| `mode()` | `"normal"` or `"insert"` |
| `mounted()` | `"<sid>\|<agent>"` of the view on screen, or null |
| `restoring()` | `true` while a restored view still waits for its items |
| `cur()` | the shown session: `{id, title, state, items, total, agents, background, outbox, …}`; `state` is the backend's (`status.ts` `sessionState`: `status`, `since`, `detail`, `light`, `tone`, `word`, `mark`, `stopped`, `needsYou`, `review`, `driven`) |
| `data()` | every session, in the server's order (only the viewed one holds items) |
| `pending(sid)` | that session's requests (question, permission, plan), oldest first |
| `layout()` | the sidebar's groups as the backend sent them, closed sessions' ids included |
| `acting()` | actions sent and not acked yet; 0 once every intent's result (its `layout` frame comes first) is in |
| `spy()` | starts recording, dropping what an earlier `spy()` recorded |
| `sent(...types)` | frames the page sent since `spy()`, of those types (all with none) |
| `received(...types)` | frames from the server since `spy()`, before the page applied them |
| `inject(msg)` | hands `msg` to the page's message handler, as if the server sent it, past the schema check and the version check of `connection.js` |
| `anchor()` | the log's scroll anchor: `{id, off}` (an item block's key and the pixels into it); at the end `{bottom: true, id, off}` with the last block on screen; `{bottom: true}` alone with no block |
| `from(sid, agent)` | the oldest item id that view had loaded (sent with `view`), or null |
| `attachments()` | the message box's pasted images: `{id, n, mediaType, url, data}`, `data` null until read |
| `prompt()` | the prompt above the box: `"interrupt"` (Esc), `"background"` (b), `"close"` (x) or null |
| `card(sid)` | the cursor and picks of that session's card (`{qi, oi, picks, own, notes, target, …}`; the shown session without `sid`), or null |
| `cards()` | every card's state, keyed `"<sid>:<request id>"` |
| `preview()` | the file preview: `{shown, path}` |
| `openList()` | the Open list: `{shown, filter}` |
| `mcp()` | the MCP panel: `{shown, sid, servers, error, note, sel, action}` |
| `marks()` | every mark kind in the marks table |
| `mark(kind, size)` | a mark's markup, `size` in px |
| `render(...parts)` | re-renders `"side"`, `"conv"`, `"header"`, `"log"`, `"card"` or `"rail"`, as a server message does |
| `redraw()` | re-renders the transcript with every block replaced |
| `resetTweens()` | the sidebar forgets its sub-line tweens, so the next render is a fresh one |

- Nothing is recorded until `spy()`; in use the API costs a null check per frame. While spying, `connection.js` hands each frame to `tap.sent` in `send` and to `tap.got` before the schema check, so `received("ack")` holds the acks. An action is recorded with its `id` (`connection.js` `act`); one refused while the socket is down is not sent, so not recorded.
- No suite reads a page global. State goes in by `inject` (a server message) or `serverSend` (stored before a load), actions by the DOM: a click, a key, a `pagehide` event (`ui-state.js` flushes the UI state on it).
- Switch views the way a user does: click `#conv [data-agent="<id>"]` for a subagent, `#conv [data-back]` for the main conversation, a `#groups .row` for a session.
- Open things as a user does: `#open` for the Open list, `#theme` for the theme (Alt-click follows the system), a clicked `a[data-path]` for the file preview and a clicked `.thumb[data-full-src]` for the image viewer. Both are document-level click handlers (`transcript.js`, `images.js`), so a link or thumbnail the check adds works too.
- The protocol has no message that drops a background entry or a subagent. `tween` and `motion` inject a `session` message with the shorter list: `inject` skips the schema check, and `applySession` copies every field it gets (`state.js`).

## Page unit tests

`app/web/test/*.test.js` run the page modules' pure parts in Node: `format.test.js` (escaping, durations, clocks, the model label), `md.test.js` (markdown, answer text), `escape.test.js` (every HTML builder with hostile text), `preview.test.js` (find offsets), `transcript.test.js` (block signatures, how a turn ends), `connection.test.js` (a daemon of another protocol version, with stand-ins for the socket and the page globals), `contrast.test.js` (dark mode text keeps 4.5:1). `app/check.sh` runs them in its `web` line.
- `format.js` and `md.js` touch no browser global and import directly. A module that adds listeners or reads `#conv` when it loads needs `import "./stub-dom.js"` first: inert stand-ins of `document`, `window`, `location` (`?token=t`) and the rest. Static imports run in order, so the stub comes before the modules.
- `stub-dom.js` also stands in for `matchMedia` and `localStorage` (`theme-switch.js` reads both on load). `build-proto-fixture.ts` imports `card.js` the same way, with dynamic imports after the backend's modules have loaded, so those see no `window`.
- `dev/check-web.mjs` (the `web` line) also fails on an import cycle between page modules and on a module other than `test-api.js` that writes `window`. A module that would need one the other way gets a hook that `main.js` wires (`ui-state.js` `useLog`, `useBox`, `useCards`; `sidebar.js` `onPick`; `theme-switch.js` `onThemeChange`; `tween.js` `onGraceEnd`).

## Backend tests

- `node --test test/` fails on a directory in Node 22.13; pass a glob: `node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/*.test.ts`. Code: `check.sh` 16-17, `backend/package.json` 8.
- `daemon.test.ts` spawns the real `main.ts` with `--experimental-strip-types`. The restart test leaves a detached successor that the test must kill.
- The contract tests run a real daemon through `test/daemon-harness.ts` (`startDaemon`, `shellDaemon`, `connectPage`, `api`, `fixtureCopy`, `backendCopy`, `watchDaemonJson`): `protocol-golden.test.ts` (the server's frames on the fixture tree against `test/golden/*.json`; `SYNOPIA_GOLDEN=update` rewrites them, then read the diff), `router.test.ts` (page frames and what they change), `shell-contract.test.ts` (what `DaemonFiles.swift`, `Backend.swift` and `AppDelegate.swift` decode, a handover's `daemon.json` too) and `handover.test.ts`.
- `handover.test.ts` runs on a copy of `app/backend` (`backendCopy`) whose `main.ts` each case replaces, and takes under 5 s: the test-only flags `--update-read-ms` and `--successor-ms` cut the 10 s code reading and the 20 s successor wait. Its three cases run concurrently.
- The handover test makes work start on cue with `send` frames: it shortens its copy of the script so a message that starts a turn is worked on for 400 ms (`sdk-script.json` `onSend`, 3 s in the fixture).

## Date-relative fixtures

Status depends on age: `STALE_MS` 15 min, `QUIET_MS` 30 min, `ASK_STALE_MS` 12 h (`status.ts` constants). A fixture record with a fixed date flips status once it ages past a threshold.
- Date such records at run time, or touch the fixture file's mtime.
- `status.test.ts` sets a tracked fixture file's mtime to now (`fs.utimesSync` in the "badge: …" case) and dates an appended answer at run time. Commit 3c6f8c2.

## Real data

Fixtures, storyboards and captured menus hold invented data only. Never copy from `~/.claude/projects` or `~/.claude/sessions`, never read `~/.claude/sessions/*.key`, and never commit `prototype/transcripts.js` or `spike/logs/`.

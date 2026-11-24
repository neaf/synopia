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
| `app/dev.sh --fake` | the backend on the fixture tree below, for looking at the page by hand; prints the URL to open |
| `app/web/dev/compare.sh` | screenshots of `prototype/app.html` and the port side by side in `/tmp/synopia-compare/shots/` |

- Each `run.sh` run starts its own headless browser (a temp `--user-data-dir`, `--remote-debugging-port=0`, the port read from `DevToolsActivePort`) and its own backend (`--port 0`, the port read from the ready line) on a fresh state folder. A `trap` stops both on exit, Ctrl-C too, and only its own pids. So two runs, other agents' runs and an open app never share anything.
- A run prints `N/M pass`, the failures and where its shots are. Its exit code is the result: 0 only when every check passed and at least one ran.
- The backend under the suites is `--fake` over `app/backend/test/fixtures/claude/` and its `fake-script.json`: a multi-select question (`#22222222`), a permission with an "Always allow" suggestion (`#33333333`), a plan (`#55555555`), a working session with subagents and a stream preview (`#44444444`), a session with diffs (`#11111111`), and the menu (models and slash commands). `--claude-dir <dir>` points it at another tree with its own `fake-script.json`.
- `states` and `rail` use the trees `claude-states` and `claude-rail`. `earlier`, `viewswitch` (through `earlier.mjs make`), `images`, `background`, `close`, `titles`, `queued`, `bang`, `preview`, `extcard` and `steps` write their own tree into the run's state folder first (`node <suite>.mjs make …`, called by `run.sh`).
- Page hooks: `?agent=<id>` opens a subagent, `&open=1` expands the last diff. `rail.mjs` and `restore.mjs` use them.

## Comparing with the prototype

`compare.sh` starts `dev.sh --fake` on a temp state folder, builds `transcripts.js` and `menu.js` for a temp copy of `prototype/app.html` from the same fixtures (`build-proto-fixture.ts`, through the backend's reader and the page's `card.js`), and screenshots both at 1280 by 820 with reduced motion. States: waiting (question card), permission, plan, busy (subagent wave), diff, agent (subagent view). It never touches `prototype/transcripts.js`.

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
- `await c.load(url, extra)` navigates and waits for ready: the first `hello`, the sidebar rendered, the message box, the current view's first `items`, no UI restore in flight, the window visible and focused, plus `extra`. Do not navigate and sleep.
- `c.ev(expr)` returns the expression's value and throws on a page exception (a `PageError` naming the expression). A throw anywhere ends the check with `FAIL the check threw: …` after the checks counted so far, and exit 1.
- `c.check(name, ok)` passes only when `ok === true`. A truthy string, number or object fails, with what it got. Compare explicitly or use `!!`.
- `c.print()` prints `N/M pass` and the failures and sets exit code 1 on a failure. A check that recorded nothing prints `FAIL no checks ran`. Never `process.exit(0)` after it.
- Wait with `c.until(expr, ms)` (default 5000; `until` in `helpers.mjs`), never a fixed sleep. It polls until the value is `=== true`; a throw counts as not yet, and a throw on the last try is rethrown. A suite has no `until` of its own.
- `helpers.mjs` holds the shared pieces: `until`, `sleep`, `PageError`, `keyTable(c.key)` (letters, Shift letters, `esc`, `enter`, `tab`, `space`, `backspace`, `slash`, arrows, `next`/`prev` for Cmd-Shift-]/[, `cmdF`), `shot(c, file, clip)`, and the record builders `line`, `fresh` and `records(cwd, ts)` with `rec`, `you`, `said` and `tool`. It imports nothing from `cdp.mjs`, so `make` modes use it without a browser.
- When two page actions must both happen before a server reply, do them in one `ev`.
- `crc32` from `node:zlib` (Node 22.2+) builds the PNG fixtures in `images.mjs` 11.
- A new suite goes in `SUITES` and the header list in `run.sh`; a fixture it writes goes through the `make` branch there.

## Backend tests

- `node --test test/` fails on a directory in Node 22.13; pass a glob: `node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/*.test.ts`. Code: `check.sh` 16-17, `backend/package.json` 8.
- `daemon.test.ts` spawns the real `main.ts` with `--experimental-strip-types`. The restart test leaves a detached successor that the test must kill (232-268).

## Date-relative fixtures

Status depends on age: `STALE_MS` 15 min, `QUIET_MS` 30 min, `ASK_STALE_MS` 12 h (`status.ts` 57, 60, 63). A fixture record with a fixed date flips status once it ages past a threshold.
- Date such records at run time, or touch the fixture file's mtime.
- `badge.test.ts` 18-21 sets a tracked fixture file's mtime to now; 126-127 dates an appended record now. Commit 3c6f8c2.

## Real data

Fixtures, storyboards and captured menus hold invented data only. Never copy from `~/.claude/projects` or `~/.claude/sessions`, never read `~/.claude/sessions/*.key`, and never commit `prototype/transcripts.js` or `spike/logs/`.

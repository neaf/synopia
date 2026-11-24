# Page checks

How Synopia's automated checks run, and the browser and test-runner facts they depend on. The automated checks are the contract: no manual checklist exists. Sources: code in `app/check.sh`, `app/web/dev/`, and the commits named below.

## Commands

| Command | Runs |
|---|---|
| `app/check.sh` | backend unit tests, `swiftc -typecheck` of the shell, `node --check` of every page script; one pass or fail line each |
| `app/check.sh --page` | the above, then `run.sh all`; four pass lines |
| `app/web/dev/cdp/run.sh <suite>` | one page suite; the list and what each covers is at the top of `run.sh` |
| `app/web/dev/cdp/run.sh all` | every suite one after the other, a table of suite and result, failures under it |
| `SYNOPIA_CDP_THEME=dark app/web/dev/cdp/run.sh <suite>` | the suite with the system appearance dark |
| `app/web/dev/compare.sh` | screenshots of `prototype/app.html` and the port side by side in `/tmp/synopia-compare/shots/` |

- Each `run.sh` run starts its own headless browser (a temp `--user-data-dir`, `--remote-debugging-port=0`, the port read from `DevToolsActivePort`) and its own backend (`--port 0`, the port read from the ready line) on a fresh state folder. A `trap` stops both on exit, Ctrl-C too, and only its own pids. So two runs, other agents' runs and an open app never share anything.
- A run prints `N/M pass`, the failures and where its shots are.
- The backend under the suites is `--fake` over `app/backend/test/fixtures/claude/` and its `fake-script.json`: a multi-select question, a permission with an "Always allow" suggestion, a plan, a working session with subagents and a stream preview, a session with diffs, and the menu.
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
- Workaround: `chrome-bin.sh` picks `$CHROME`, else the newest Playwright `chrome-headless-shell` under `~/Library/Caches/ms-playwright/chromium_headless_shell-*/`, a plain binary with no app bundle. Install it with `npx playwright install chromium-headless-shell`. `chrome-bin.sh` still falls back to Google Chrome.app with a warning; that path must never run (NFR-04).
- Never launch Google Chrome.app, Chrome for Testing.app or `build/Synopia.app` from a check, and use no osascript, UI scripting or screencapture.
- Code: `app/web/dev/chrome-bin.sh`, `cdp/chrome.sh`. Commit c4374af.

## Browser quirks the harness handles

### Quirk: first key after a load is dropped

- Symptom: the first key a check sends after navigation has no effect.
- Cause: headless Chrome can drop the first key event after a load. Cause unknown beyond that.
- Workaround: before the first key on each document, `c.key()` sends no-op Shift keys (up to 20, with `Page.bringToFront`) until a capture-phase `keydown` listener fires. Checks need no workaround of their own.
- Code: `cdp.mjs` `prime` (50-70).

### Quirk: hidden or unfocused pages get no frames

- Symptom: animations and `requestAnimationFrame` stall; each CDP mouse event waits about 5 s.
- Cause: a page that reports hidden or unfocused (display asleep, a settings tab the browser opens itself) gets no animation frames.
- Workaround: `Emulation.setFocusEmulationEnabled {enabled: true}` and `Page.bringToFront` at connect and before each load; the ready signal requires `visibilityState === 'visible'` and `document.hasFocus()`. `chrome.sh` also passes `--disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding`.
- Code: `cdp.mjs` 34-37; `chrome.sh`.

### Injected scripts are outside the page's CSP

A script added with `Page.addScriptToEvaluateOnNewDocument` is not subject to the page's CSP and runs before the page's own scripts. The harness wraps `WebSocket` there to count socket messages by type (`__synSeen`): a listener added in the constructor runs before the `onmessage` the page sets later. `csp.mjs` relies on the same fact to plant a handler and check the page blocks its own inline copy. Code: `cdp.mjs` 6-9; `csp.mjs` 15.

### Web-font swap

- Symptom: a block moves about 52 px between a measurement and a click.
- Cause: fonts load with `display=swap`; the swap rewraps text after first paint.
- Workaround: checks that measure position wait for `document.fonts.ready`.
- Code: `earlier.mjs` 59-60. Commit 844aba1.

### One browser at a time for animation suites

Two `run.sh all` at once pass, but `tween` and `motion` sample animation frames, so they are steadier with one browser running. Source: app/web/dev/README.md.

## Writing a check

- `connect()` from `cdp.mjs` needs `SYNOPIA_CHROME_PORT`, which `run.sh` sets. Each check times out after 180 s.
- `await c.load(url, extra)` navigates and waits for ready: the first `hello`, the sidebar rendered, the message box, the current view's first `items`, no UI restore in flight, the window visible and focused, plus `extra`. Do not navigate and sleep.
- Wait with `c.until(expr, ms)`, never a fixed sleep.
- When two page actions must both happen before a server reply, do them in one `ev`.
- `crc32` from `node:zlib` (Node 22.2+) builds the PNG fixtures in `images.mjs` 10.

## Backend tests

- `node --test test/` fails on a directory in Node 22.13; pass a glob: `node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/*.test.ts`. Code: `check.sh` 16-17, `backend/package.json` 8.
- `daemon.test.ts` spawns the real `main.ts` with `--experimental-strip-types`. The restart test leaves a detached successor that the test must kill (232-268).

## Date-relative fixtures

Status depends on age: `STALE_MS` 15 min, `QUIET_MS` 30 min, `ASK_STALE_MS` 12 h (`status.ts` 57, 60, 63). A fixture record with a fixed date flips status once it ages past a threshold.
- Date such records at run time, or touch the fixture file's mtime.
- `badge.test.ts` 18-21 sets a tracked fixture file's mtime to now; 126-127 dates an appended record now. Commit 3c6f8c2.

## Real data

Fixtures, storyboards and captured menus hold invented data only. Never copy from `~/.claude/projects` or `~/.claude/sessions`, never read `~/.claude/sessions/*.key`, and never commit `prototype/transcripts.js` or `spike/logs/`.

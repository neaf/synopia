# Synopia app

A Swift shell (`shell/`) hosting the page (`web/`) in a WKWebView, and a Node backend (`backend/`) that runs the sessions through the Claude Agent SDK.

## Run it

```sh
(cd app/backend && npm ci)        # once: the pinned SDK and ws
app/build.sh                      # builds build/Synopia.app with swiftc
open build/Synopia.app            # state in ~/Library/Application Support/Synopia
```

Without the shell, for Chrome:

```sh
app/dev.sh                        # real sessions, state in app/.dev-state; prints the URL to open
app/dev.sh --script               # the scripted SDK over a copy of the fixture tree, no model calls
```

## Check it

```sh
app/check.sh                      # backend tests, shell type check and DaemonFilesTest, page script syntax: one line per part (no Chrome)
app/check.sh --page               # the same, then every page check (run.sh all)
app/web/dev/cdp/run.sh all        # every page check over headless Chrome on the scripted SDK: a table, failures under it
app/web/dev/cdp/run.sh keys       # one page check (the list is at the top of run.sh)
app/web/dev/compare.sh            # screenshots of the page next to the prototype
```

A test app on its own state, with a PNG of the web view 1.5 s after the first load (`WKWebView.takeSnapshot`: page content only, no title bar, traffic lights or drag strip; no Screen Recording permission):

```sh
open --env SYNOPIA_STATE_DIR=/tmp/s --env SYNOPIA_SNAPSHOT=/tmp/s.png build/Synopia.app
pkill -TERM -x Synopia            # quits the app only; the daemon and its work go on
```

The backend is a daemon (plan section 2): the app finds it through `<state-dir>/daemon.json` or starts it detached, with its output in `<state-dir>/daemon.log`. ⌘Q quits only the app; "Stop All Work…" (⌥⌘Q) ends the daemon, after a confirm with `GET /api/quit-check`'s `summary` when anything runs (or when the check fails). From a script, stop a test daemon with `kill -TERM <pid from daemon.json>`, or `POST /api/stop?token=…`. `--env SYNOPIA_EXIT_IDLE_MS=3000` shortens its idle exit (30 min with no page and nothing running) for a check.

Backend changes take effect without a relaunch: the daemon hashes `backend/src/**/*.ts` and `package-lock.json` at start (`code` in daemon.json and `/api/ping`), rereads the checkout every 10 s, and once the new hash holds and nothing runs it hands over to a new daemon on the same state folder (`backend.log`: `update.pending`, `handover.start`, `backend.stop reason=update`). The page shows "Reconnecting…" for about 2 s and comes back as it was; while work runs, the sidebar footer says "Update ready: restarts when idle". "Restart Backend Now…" in the App menu (or `POST /api/restart?token=…`) hands over at once. Page changes (`web/`) are served as they are on disk, but the app has no reload command: they show after "Restart Backend Now…" (the app loads the page again from the new daemon) or a relaunch. In Chrome, reload the tab. `app/dev.sh` has no updates: restart it for backend changes.

Add `--env SYNOPIA_SDK_SCRIPT=/tmp/claude` (after `cp -R app/backend/test/fixtures/claude /tmp/claude`) to run the scripted SDK over that copy (no model calls; it writes to the transcripts). The shell prints `Synopia shell: daemon found|started|slow|lost pid N` and `Synopia shell: badge N` (polled from `GET /api/badge` every 2 s) on stderr (run `build/Synopia.app/Contents/MacOS/Synopia` directly to see it).

Notes, facts settled and what is left: `.ai-notes/app/README.md`.

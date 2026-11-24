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
app/dev.sh --fake                 # the fake driver over the fixture tree, no model calls
```

## Check it

```sh
app/check.sh                      # backend tests, shell type check, page script syntax: one line per part (no Chrome)
app/check.sh --page               # the same, then every page check (run.sh all)
app/web/dev/cdp/run.sh all        # every page check over headless Chrome on the fake driver: a table, failures under it
app/web/dev/cdp/run.sh keys       # one page check (the list is at the top of run.sh)
app/web/dev/compare.sh            # screenshots of the page next to the prototype
```

A test app on its own state, with a screenshot of the window 1.5 s after load:

```sh
open --env SYNOPIA_STATE_DIR=/tmp/s --env SYNOPIA_SNAPSHOT=/tmp/s.png build/Synopia.app
pkill -TERM -x Synopia            # quits the app only; the daemon and its work go on
```

The backend is a daemon (plan section 2): the app finds it through `<state-dir>/daemon.json` or starts it detached, with its output in `<state-dir>/daemon.log`. ⌘Q quits only the app; "Stop All Work…" (⌥⌘Q) ends the daemon. From a script, stop a test daemon with `kill -TERM <pid from daemon.json>`, or `POST /api/stop?token=…`. `--env SYNOPIA_EXIT_IDLE_MS=3000` shortens its idle exit (30 min with no page and nothing running) for a check.

Add `--env SYNOPIA_FAKE=$PWD/app/backend/test/fixtures/claude` to play the fake driver over the fixtures (no model calls). The shell prints `Synopia shell: daemon found|started|lost pid N` and `Synopia shell: badge N` (polled from `GET /api/badge` every 2 s) on stderr (run `build/Synopia.app/Contents/MacOS/Synopia` directly to see it).

Notes, facts settled and what is left: `.ai-notes/app/README.md`.

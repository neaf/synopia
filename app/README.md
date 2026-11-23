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
app/check.sh                      # backend tests, shell type check, page script syntax: one line per part
app/web/dev/cdp/run.sh keys       # page checks over headless Chrome on the fake driver (also dnd, menu)
app/web/dev/compare.sh            # screenshots of the page next to the prototype
```

A test app on its own state, with a screenshot of the window 1.5 s after load:

```sh
open --env SYNOPIA_STATE_DIR=/tmp/s --env SYNOPIA_SNAPSHOT=/tmp/s.png build/Synopia.app
pkill -TERM -x Synopia            # quits without asking, backend and CLI processes included
```

Add `--env SYNOPIA_FAKE=$PWD/app/backend/test/fixtures/claude` to play the fake driver over the fixtures (no model calls). The shell prints `Synopia shell: badge N` on stderr for each Dock badge change (run `build/Synopia.app/Contents/MacOS/Synopia` directly to see it).

Notes, facts settled and what is left: `.ai-notes/app/README.md`.

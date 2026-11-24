# Synopia

A macOS app for running several Claude Code sessions side by side: one window that shows every open session, says which one needs you, and lets you chat in any of them.

It is a thin Swift shell (`app/shell/`) hosting a web page (`app/web/`) in a WKWebView, and a Node daemon (`app/backend/`) that runs the sessions through the Claude Agent SDK and outlives the app. The page also runs in a browser.

## Requirements

- macOS 26 and the Xcode command line tools (`xcode-select --install`): the shell is built locally with `swiftc`, so nothing needs signing.
- Node 22.13 or later on PATH.
- [Claude Code](https://docs.claude.com/en/docs/claude-code), installed and logged in. Synopia drives sessions through the Claude Agent SDK with your Claude Code login and settings, so turns cost what they cost in the CLI, and sessions keep your permission mode.
- Optional: [bat](https://github.com/sharkdp/bat) for highlighted file previews.

## Install

```sh
git clone https://github.com/neaf/synopia.git
cd synopia
(cd app/backend && npm ci)        # the pinned SDK and ws
app/build.sh                      # builds build/Synopia.app with swiftc; bakes in the node path
open build/Synopia.app            # state in ~/Library/Application Support/Synopia
```

To update, `git pull`: the running daemon hands over to the new code once nothing runs. Rerun `app/build.sh` and relaunch when the shell (`app/shell/`) changed, or after a Node upgrade.

## Run

Without the shell, for a browser:

```sh
app/dev.sh                        # real sessions, state in app/.dev-state; prints the URL to open
app/dev.sh --script               # the scripted SDK over a copy of the fixture tree, no model calls
```

The daemon is found through `<state-dir>/daemon.json` or started detached, with its output in `<state-dir>/daemon.log` ([Daemon files](docs/Daemon%20files.md)). ⌘Q quits only the app; "Stop All Work…" (⌥⌘Q) ends the daemon, after a confirm when anything runs. Backend changes take effect without a relaunch: the daemon hashes its code every 10 s and hands over to a new daemon once nothing runs ("Restart Backend Now…" in the App menu does it at once). Page changes show after "Restart Backend Now…" or a relaunch; in a browser, reload the tab. `app/dev.sh` does not update: restart it.

A test app on its own state, with a PNG of the web view 1.5 s after the first load (page content only; no Screen Recording permission), and the scripted SDK over a fixture copy:

```sh
cp -R app/backend/test/fixtures/claude /tmp/claude
open --env SYNOPIA_STATE_DIR=/tmp/s --env SYNOPIA_SNAPSHOT=/tmp/s.png --env SYNOPIA_SDK_SCRIPT=/tmp/claude build/Synopia.app
pkill -TERM -x Synopia            # quits the app only; stop the daemon with kill -TERM <pid in /tmp/s/daemon.json>
```

`--env SYNOPIA_EXIT_IDLE_MS=3000` shortens the daemon's idle exit (30 min with no page and nothing running). Run `build/Synopia.app/Contents/MacOS/Synopia` directly to see the shell's `Synopia shell: …` lines on stderr.

## Check

```sh
app/check.sh                      # backend tests, shell typecheck and DaemonFilesTest, page scripts and unit tests: one line each
app/check.sh --page               # the same, then every page check; must print four pass lines
app/web/dev/cdp/run.sh keys       # one page check over chrome-headless-shell (the list is at the top of run.sh)
app/web/dev/compare.sh            # screenshots of the page next to the prototype
app/backend/test/upgrade.sh       # opt-in: a daemon from tag rearch-base hands over to this tree
```

Page checks run on Playwright's chrome-headless-shell only, so no window takes focus ([Page checks](docs/Page%20checks.md)).

## Viewing the prototype

`prototype/app.html` is the UI reference. It reads `transcripts.js` and `menu.js` beside it; `app/web/dev/compare.sh` builds both from the invented test fixtures into a copy of the page:

```sh
app/web/dev/compare.sh
open /tmp/synopia-compare/proto/prototype/app.html
```

Test states for the "needs you" card: add `?demo=ask`, `ask6`, `multi`, `permission` or `plan` before the `#<session-id>`, for example `app.html?demo=ask6#22222222`.

## Docs

| Path | What it is |
|---|---|
| [docs/requirements.md](docs/requirements.md) | The author's behaviour spec (R-numbers), with the choices that were rejected and why |
| [docs/functional-requirements.md](docs/functional-requirements.md) | The same behaviour as FR ids, the rearchitecture decisions, and the known gaps |
| [docs/architecture.md](docs/architecture.md) | Modules, data flow, threading, protocol, files, state.json, ownership, FR-to-module map |
| [docs/Claude Code transcripts.md](docs/Claude%20Code%20transcripts.md) | The JSONL transcript format as Synopia reads it |
| [docs/Claude Code terminals.md](docs/Claude%20Code%20terminals.md) | Pid files, terminal-held sessions and the take-over |
| [docs/Agent SDK.md](docs/Agent%20SDK.md) | How Synopia drives the SDK, its quirks, the scripted SDK |
| [docs/Daemon files.md](docs/Daemon%20files.md) | daemon.json, lock, exit codes, log, lifecycle, handover |
| [docs/macOS.md](docs/macOS.md) | PATH, login shell, `ps`, `fs.watch`, `open`, bat, file locks |
| [docs/WKWebView and AppKit.md](docs/WKWebView%20and%20AppKit.md) | Title bar, keys, links, CSP and WebKit features |
| [docs/Page checks.md](docs/Page%20checks.md) | The headless page checks, the `__synopia` test API, fixtures |
| `prototype/app.html` | The UI reference |
| `prototype/*-storyboard.html` | Design storyboards for status marks, kind marks and the "needs you" card (design history; `docs/requirements.md` wins) |
| `app/web/icon/` | App icon and favicon ("Paper"); the build and the prototype read it |
| [AGENTS.md](AGENTS.md) | Rules for working on the code |
| `.ai-notes/` | Handover notes between sessions |

## License

[MIT](LICENSE). The bundled fonts in `app/web/fonts/` keep their own SIL Open Font License files.

Fixtures, storyboards and prototype data are invented. Never commit `prototype/transcripts.js` or anything from `~/.claude/` (see [AGENTS.md](AGENTS.md)).

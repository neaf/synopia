# Architecture

How Synopia is built: modules, data flow, threading, interfaces and who owns what. Behaviour is in [requirements.md](requirements.md) (R-numbers) and [functional-requirements.md](functional-requirements.md) (FR ids, decisions Q1-Q11, known gaps). External systems have one topic doc each (table under "External-system adapters").

## Overview

```
 macOS app (Swift, thin)                         Node daemon (one event loop)                          Claude Code
 +--------------------------+  daemon.json   +--------------------------------------------------+
 | AppDelegate  Menus       |<---------------| daemon-files  (daemon.json, lock, log, handover) |
 | TitleBar     WebView     |  HTTP /api/*   | daemon (lifecycle, idle exit, update, handover)  |
 | Backend  DaemonFiles     |--------------->| server (HTTP, WS, auth, CSP, backpressure)       |
 +------------+-------------+                |   router (page->server, validated, acks)         |
              | WKWebView                    |   publisher (server->page, one flush)            |
 +------------v-------------+   /ws JSON     |                                                  |
 | page (ES modules)        |<-------------->| sessions / session / cards / bang  --- sdk -------+--> query() CLI children
 | connection  state        |  protocol.js   | status (the one derivation, badge)               |
 | ui-state  render modules |  (shared)      | transcripts -> transcript <- claude-jsonl <- tail-+--> ~/.claude/projects/*.jsonl
 +--------------------------+                | cli-terminals <- macos (ps, signals, tty) -------+--> ~/.claude/sessions/<pid>.json
                                             | menu  writer  (through sdk)                      |
                                             | store (state.json)  ui-state  layout             |
                                             | open  preview(bat)  login-env  paths  log        |
                                             +--------------------------------------------------+
```

Rules the design keeps:
- Each external system's quirks sit in one adapter module named after it, mapped to one topic doc (table under "External-system adapters").
- Pure logic (claude-jsonl, ledger, transcript, status, layout, cards mapping, bang format, md, format, protocol) has no I/O and is tested without a CLI, browser or app.
- One owner per piece of state (table under "State ownership").
- Nothing blocks the Node loop: no synchronous child process anywhere; file reads stay sliced at 4 MB per turn.
- The page stays plain JavaScript served by the backend, no build step: native ES modules plus one classic head script (`theme.js`, first paint). No import cycles; only `test-api.js` writes `window` (`check-web.mjs` fails otherwise).
- The Swift shell does window, menus, title bar, web view, and finding or starting the daemon. No product logic, no log scraping, no product words.

## Modules

### Backend (`app/backend/src`, TypeScript run with `--experimental-strip-types`)

| Module | One responsibility |
|---|---|
| `main.ts` | Composition root: parse flags, build modules, wire callbacks, start. No message handling, no state. |
| `daemon.ts` | Daemon lifecycle as one `startDaemon()` with explicit states (starting, ready, stopping): idle exit, update check, handover orchestration, shutdown order, crash handler that flushes state. Pure units `IdleExit`, `UpdateCheck`; async `CodeHasher`. |
| `daemon-files.ts` | Adapter for Synopia's own on-disk daemon contract: `daemon.json` (incl. the `handover` field), `backend.lock` (an `O_EXLOCK` kernel lock), `daemon.log` rotation, exit codes. Swift's `DaemonFiles.swift` is the only other reader. |
| `server.ts` | HTTP and WebSocket transport: 127.0.0.1, token, Host/Origin, CSP, static files, 32 MB cap, per-client backpressure (drop `stream` first), error handlers. No routing logic. |
| `router.ts` | Page-to-server dispatch table keyed by `t`: validates each frame against `protocol.js`, resolves id aliases once, calls one module, answers `ack {id, ok, error}`; one try/catch per frame. |
| `publisher.ts` | Server-to-page, the only frame sender: per-client subscriptions, meta diffs, `items` reset/upsert/prepend, `agents` (`review` while the subagent's review item is open), `background`, `openItems` (each session's `open-items.ts` view, whole, to every page when it changed; synced on each flush), `pending`, `stream` (viewer only), `layout`, `restore`/`toast` to the acting client; one re-entrancy-guarded flush with a fixed frame order. |
| `store.ts` | `state.json`: load, validate every entry (the `items` section through `open-items.ts` `cleanItems`), cap growing maps, atomic write at most 1/s, retry after a failed write, sync flush on any exit, `.bad-<ms>` on corrupt. |
| `ui-state.ts` | UI state (R3.9): patch, caps, drafts as files, prune on close and at start, rekey on id swap; never clears `current`/`view` on an empty entry. |
| `layout.ts` | The one layout owner: applies page intents (move, new group, rename group), reconciles with the open list, renames on id swap, keeps closed ids in place. Pure functions plus the `Layouts` owner. |
| `sessions.ts` | The set of open sessions: open list, new (in a folder, made first on request)/open/close/continue (fork into another folder), `listRecent` (the matcher over every past session, with totals), `listFolders`, id aliases, one `rekey` that moves the whole per-session record. |
| `folders.ts` | Folders on disk, the only module that touches them for the folder list (R3.13, NFR-13): the known-folders list from Synopia's open list and `listSessions()` (no read), `~` expansion, one-folder completion (one `readdir`, injectable for the test that counts reads), gone checks of named paths with the protected-folder rule, and the one write, `mkdir -p` of a typed path. |
| `session.ts` | One open session as a state machine (idle, starting, running, ending, yielded, takingOver) over one `sdk` process: input queue, held-behind-card, after-exit queue, outbox (queued messages), yield and take-over, idle end, model/effort apply, interrupt, background, send-now (f, f: `nowRoute`). |
| `agent-tools.ts` | Synopia's tools for agents (R3.15), the one owner: the tool list (name, description, zod input, card words, step line, run), the server per process (through `sdk.ts` `toolServer`), the `Host` it needs from `sessions.ts`, `start_session` and its result text. A tool is one entry of `TOOLS`. |
| `cards.ts` | Needs-you requests: park `canUseTool` FIFO per session, abort cleanup, answer mapping (questions, permission, plan), "always allow" session rules that clear on close (Q6). |
| `bang.ts` | `!` commands: run in one pty (`pty.ts`, 2026-11-26) as their own process group, a typed line in (`input`), stopped from its shell view (`kill`, `session.ts` `stopBang`), `waiting`/`quiet`/`waitedAt` from `pty.ts` `InputWatch` and `cardAt` from `runs.ts` (2026-11-26), plain text capped by code point, kill timers cleared on finish, CLI `<bash-input>`/`<bash-stdout>` format both ways. `session.ts` owns the runs: the shown one (`bang`), the last 10 for the panel (`bangs`, no output) and their output for the shell view (`bangOutput`, sent by `publisher.ts` as `output` resets). The page only reshapes `bangs` into panel shells (`state.js` `ownBg`). |
| `sdk.ts` | Adapter for the Claude Agent SDK, the only value import of `@anthropic-ai/claude-agent-sdk`: start options, the state-events env flag, `interrupt({cancelQueued})`, `setModel`/`applyFlagSettings`, plan `setMode`, idle menu probe with timeout, writer one-shot options, the in-process tool server (`toolServer`), `listSessions`, command filters (`__*`, `workflow-launch-exec`, HTML unescape), user content with `[Image #N]` tags, image limits. Takes an injectable `query`/`listSessions` pair. |
| `menu.ts` | Slash commands and model list per folder: cache, persisted models, backoff after a failed fill, one send per folder per connection. |
| `mcp.ts` | `/mcp` (R5.15): per session, its MCP servers' rows, the action running on each and the last error, sent whole as `mcp` to every page. Status and control calls from the session's process (`Session.mcpControl`), else an idle probe in its folder (`sdk.ts` `mcpProbe`, closed 3 min after the last ask); a fresh source's empty first answer and `pending` rows are read again every 0.5 s. Sign-in and sign-out run the bundled CLI (`sdk.ts` `bundledCli`) as `claude mcp login <name>` or `logout` in the session's folder, no TTY, 5 min for a sign-in, then `reconnectMcpServer`. The runner and the probe are injected (tests; the scripted SDK's pretend CLI). |
| `find.ts` | Find in the transcript (R5.12e, 2026-11-26), the one owner of what ⌘F searches: an item's search text (`itemText`, what the page renders for it), case-ignoring matches with offsets in the text, every match of a view in order, capped at 10,000. The view's source comes from `publisher.ts` `findSource` (its items, or a shell's last 4 MB of output, a monitor's events, a `!` run's output); `router.ts` answers `find` with `found`. |
| `creds.ts` | Credential refresh (R8.2, 2026-11-26), the one owner: each folder's refresh command (`state.json` `refresh`, keyed by the git root), one run per folder for an expiry shared by its sessions, the `creds` frame (phase, command or guess, live output, failure sentence) to every page, `credsSave`/`credsInput`/`credsCancel`. The guess: `sdk.ts` `awsAuthRefreshOf`, then an executable `bin/aws-login`. The pty runner is injected (tests). |
| `pty.ts` | A command in one pseudo-terminal for its whole run (`script(1)` behind a `cat` pipe), its output to a callback only (stderr apart on request), a line typed into it, its exit code; killed as the command's group, whose id the pty reports. `plainText`: the one place the pty's CRLF and escape sequences go. `InputWatch` and `looksLikePrompt` (2026-11-26, live run IN-1 in docs/Claude Code terminals.md): the one rule for "waits for input" (a prompt-shaped last line, 1 s quiet) and the 10 s "may wait" hint. Used by `creds.ts` and `bang.ts`. |
| `runs.ts` | When your `!` run or the credential refresh gets its panel card (R7.1, 2026-11-26): `cardAt` (3 s after the start, or when it first waited; none for a run over sooner). `bang.ts` and `creds.ts` send it; the page shows a card once its clock passes it. Claude's background shells and monitors carry none: their card shows from their start (`rail.js`). |
| `writer.ts` | Claude-written title and Now line: 20 s debounce, one call at a time, distinct log for error results. |
| `claude-jsonl.ts` | Adapter for Claude Code transcript records: turns raw JSON lines into one typed, classified record union (prompt, interrupt marker with `forToolUse`, queued command, task notification, turn end, tool use/result, bash edit diff, title, PR link, mode, meta). Every CLI text prefix and record-shape quirk lives here. Pure. |
| `ledger.ts` | Adapter for the open-items ledger, `.ai-notes/<area>/open-items.md` (FR-ITEM-01, FR-ITEM-04): `parse` of the version 1 line shapes into open items, closed lines and the lines it can't read (one bad line never fails the file), `blockOf` (an item's own lines), `nextId`, `fromOf`, `optionsOf`, `stampTime` (local time, date-only stamps), the path rule `isLedgerPath` (with `ledgerPathOf` for a tool's path and `ledgerPathIn` for a Bash command), a brief's `Open items:` line (`ownedIds`) and `ownerOf` (the brief first, the `subagent` field by name second). Pure. |
| `open-items.ts` | Open items (R3.16, FR-ITEM-01 to -04, -06), the one owner and writer of every list: one list per ledger (by its absolute path, `session:<sid>` while the session named none), the session's list from `transcripts.ts` `ledgerOf` (a shared ledger counts under the session that named it last). Reads the ledger through `ledger.ts` on a new tool result for it and on a size or mtime change (looked at every 2 s), async, one read per file at a time; not over 256 KB nor in a protected folder (`folders.ts` `isProtected`), with the note why. Merges each read by the items' own lines as last read (`blockOf`): new ids adopted (Synopia's item on that number renumbered), a changed item wins, an unchanged one keeps Synopia's state, a gone one dropped. Opens `Review: <name>` for finished `For review: ` subagents, ties a ledger review item to its subagent by the `subagent` field, `markReviewed`. Derives `view` (the open Y items, the A items, Closed this turn, unread count, note; `with` from `ledger.ts` `ownerOf`) and `counts` (review, waiting, due). `state.json` `items` (`cleanItems` validates on load and carries the old `reviewed` marks). |
| `transcript.ts` | Pure reducer: classified records to items, agents, background work, turn state, pending ask, titles. Tracks tool uses per `message.id` across records (one block per record). The main conversation's open-items facts (FR-ITEM-01, FR-ITEM-04): `ledger`, the last ledger a Read, Write or Edit `file_path` or a Bash command named (relative to the record's `cwd`), with the count of its tool results; `ownsOf`, the ids an Agent brief's `Open items:` line names (the prompt is not kept); a ledger's patches flagged `ledger` (R5.9). Rebuilt by construction on reset. No I/O. |
| `tail.ts` | File tailing by byte offset and the subagent folder watcher: 4 MB slices, `fs.watch` plus the 1 s poll, reset on shrink, inode change or content rewrite (not on a bare touch). |
| `transcripts.ts` | The reading set: one Tailer + Transcript per open session and subagent, the new-session finder, the one 1 s poll, facts for other modules (`facts`, `turns`, `ledgerOf`, `ownsOf`), async rereads for `toolOutput` and `/api/image`. |
| `task-output.ts` | A shown shell's output file read by byte window (whole lines, whole UTF-8 characters) and a monitor's events cut the same way (R7.2); the publisher sends them as `output`. |
| `status.ts` | The one status derivation: SDK events, transcript facts, pending cards and terminal state to a `SessionState` (status, since, detail, light, tone, word, mark, stopped, needsYou, review, waiting, due, driven; the three counts from `open-items.ts` `counts`). Keeps the badge count incrementally (`BadgeCounter`) and words the quit check (`quitSummary`). Pure apart from a clock. |
| `cli-terminals.ts` | Adapter for terminal-run Claude Code CLIs: pid files, liveness, procStart match, ours-vs-theirs, take-over signals (SIGTERM, SIGINT, never SIGKILL), tty note, transcript stable wait; logs a live pid whose procStart mismatches. |
| `macos.ts` | Process probes, all async: `ps -o lstart=` under `LC_ALL=C TZ=UTC`, `ps -o tty=`, liveness, process-group signals, ancestry. Transient failures are not cached. |
| `open.ts` | `/usr/bin/open` via argv: allow-list, reveal otherwise, http/https URLs only. |
| `preview.ts` | File preview: plan (text vs open), caps, ANSI to escaped HTML, and the bat call (the bat adapter: flags, themes, language list). |
| `file-refs.ts` | Paths named in replies (R5.9, 2026-11-25): `resolvePaths` against the session's folder and home, one stat each (there or not, file or folder; protected folders skipped as in `folders.ts`); the viewer's image of a file it answered for that session (`/api/image` ref `file:<abs>`: image name and bytes, 20 MB at most). Opening goes through `preview` and `open`. |
| `login-env.ts` | Login shell environment merge once at start, allow-list, fallback PATH. |
| `paths.ts` | Display paths (`~`, `/tmp`) with left boundaries; also the absolute path used as cache key (display strings are never keys); `isDir`. |
| `log.ts` | `backend.log` event lines with quoted, capped values. |

Dev and test only (not loaded in production):
- `app/backend/dev/scripted-sdk.ts`: the scripted SDK (Q5). Implements the `query()` and `listSessions()` surface `sdk.ts` consumes: plays per-session scripts of SDK messages and `canUseTool` calls, appends the CLI's JSONL records to the fixture transcript like a CLI would, answers control calls (`supportedCommands`, `supportedModels`, `interrupt`, `setModel`, `backgroundTasks`). Loaded by `main.ts` only with `--sdk-script <file>`; it also seeds state.json for a fixture tree.
- `app/backend/test/`: `node --test` files, `daemon-harness.ts` (real daemons on temp state), fixtures (invented data), goldens for the protocol; `upgrade.sh` with `upgrade.ts` (opt-in: a `rearch-base` daemon hands over to this tree, FR-TOOL-08).
- `app/backend/perf/*.mjs`: opt-in measurement batch (Q10), outside `check.sh`.

### Page (`app/web`, served by the backend; `app/web/package.json` is `{"type":"module"}`)

`index.html` loads two scripts: `theme.js` (classic, in `<head>`) and `main.js` (module), which imports the rest.

| Module | One responsibility |
|---|---|
| `js/protocol.js` | The shared message schema: protocol version, every message type and its fields, the validator, action types that need an ack, the image limits. Imported by the page and by `router.ts`/`publisher.ts`/`sdk.ts`. DOM-free. |
| `js/connection.js` | The WebSocket: auth, reconnect backoff, version check (another version: "Updating…", reload once for a newer one, else wait), frame validation, `send()` that returns false when down, actions with ids awaiting `ack`, `request()` for read frames, refusal toast while disconnected (Q9). |
| `js/state.js` | The one page store: applies server messages (the `creds` frames too, and each session's `openItems`, `applyOpenItems`), holds current session and view (`select`, `selectView` are the only writers), the ticker's `nowish`, exposes server-derived fields only. `bgAll`: a session's runs for the panel and the shell view, as one shape (Claude's background entries, its foreground Bash steps `stepBg`, your `!` runs `ownBg`, the refresh `credsBg`). |
| `js/ui-state.js` | Restore of exactly what was on screen (R3.9): collect, debounce, patch, apply hello, scroll anchors; hooks `useLog`, `useBox`, `useCards` so it imports no view module. |
| `js/main.js` | Entry: wires modules and hooks, the message dispatch, the 1 s ticker, start. |
| `js/test-api.js` | `window.__synopia`: read-only state getters, ready signal, sent-frame spy, message injection. The page checks use only this plus the DOM. |
| `js/format.js` | Time and duration formatters, the ticking spans, model label, `still`. Pure. |
| `js/md.js` | Markdown as the CLI renders it, and the kind and stated alignment of each table column. Pure. |
| `js/table-fit.js` | Fits a markdown table in the log to its reply (only the long text wraps, then the first column, then it scrolls in its box), again when the log resizes or a fold opens. |
| `js/marks.js` | Mark drawing per mark key and the animation phase pin (CON-WK-05). |
| `js/tween.js` | Layout tweens and the 5 s grace for finished lines. |
| `js/sidebar.js` | Rows (their sub-lines, "○ N waiting on you, N due" from the state's `waiting` and `due` among them), groups tree, rename field; sends layout intents. |
| `js/dnd.js` | Pointer-event drag and drop, drop-zone geometry, intent on drop. |
| `js/rail.js` | Background work panel: agents (an owned item under its running subagent, `open-items.js`), To review and the open-items groups (`open-items.js`) between the tree and Past, shown with background work or open items; Claude's background shells and monitors as cards from their start, your runs and the refresh once due (`cardAt`), no card for Claude's foreground Bash; who started each by its sign, the waiting card. |
| `js/runs.js` | Runs (R5.13, R7.1, 2026-11-26): your `!` command and the refresh in one shape (`ownRowHTML` on the `!` band in the transcript, `credsRunHTML` in the dock), their state line; `bgState` and the who sign for the panel; draws only what the backend sent. Claude's Bash and Monitor steps are steps (`transcript.js`). |
| `js/bg-view.js` | A run's shell view (R7.2): its header, and `titleWithCrumb`, the title line with "‹ <session title>" that every view but Main conversation uses (R5.1), its output as a terminal run, earlier output; holds the `output` the page has. Every run opens here (2026-11-26): Claude's background shells and monitors (from their card or Past line), its foreground Bash (from the live line), your `!` runs, the refresh; the `!` band in the box's place that types into yours or the refresh (`runDockHTML`). |
 `js/transcript.js` | The conversation panel (header, log, the box as its last row) and the keyed log: blocks, steps (Claude's Bash and Monitor among them, foreground and background, folded and expanded in place), files changed, earlier link, live line, the sticky queue of queued prompts. |
| `js/images.js` | Thumbnails and the image viewer. |
| `js/preview.js` | File preview pane and find (`findIn`, the page's one matcher). |
| `js/find.js` | Find in the transcript (R5.12e, R9.9): the ⌘F bar, `find`/`found`, each match's Range from the rendered blocks (an item's block by key, a step's `data-item`), going to a match through `ui-state.js` `jumpTo`, the marks (CSS Custom Highlights `tf-find`, `tf-cur`). |
| `js/path-links.js` | Paths in replies (R5.9, 2026-11-25): asks `resolvePaths` for the new `data-pc` code spans once per render, cached per session; ⌘ held (`cmd-held`, cleared on blur) and ⌘-click to the preview, the image viewer or `open`. |
| `js/composer.js` | Message box, slash menu, `!` mode, image paste, the one in-box prompt (Esc, b, x), giving a refused send back; `writeLine` (an open item's button: its line on a new line of the draft, insert mode, nothing sent). |
| `js/open-items.js` | Open items in the panel (R7.1, FR-ITEM-03 to -05): draws the session's `openItems` as HTML for `rail.js`: To review from the review items (a handed-over one only focuses), Waiting on you, Claude will check, Closed this turn, the unread line and the note, the items a running subagent owns; the buttons carry their line (`data-write`) and `transcript.js` hands it to `composer.js` `writeLine`; the focused item (one per page, not stored). Imports only state.js, format.js and marks.js (composer.js would make a cycle through sidebar.js). |
| `js/card.js` | Needs-you card and the status line; keeps picks until the answer is acked. |
| `js/keys.js` | The one keyboard dispatcher (window capture): layers in a fixed order (preview, image viewer, Open list, folder list, sidebar drag), then the session keys (n, o among them); `renderAll`. |
| `js/mode.js` | Normal and insert mode (`setMode`, `paintMode`); the box is the only indicator. |
| `js/toast.js` | The toast line. |
| `js/mark-time.js` | The marks in the transcript's bullet column: no click, and on hover the tip with the time their row appeared (`data-at`). |
| `js/fuzzy.js` | The one matcher (R3.14): a port of nota's `FuzzyMatch` and `SearchIndex.search` (fzf v2), ranking and the highlight markup. DOM-free; the backend imports it for the Open list. |
| `js/open-list.js` | Open session list: totals, highlights, gone rows on screen. |
| `js/creds-line.js` | The dock's credential line (R8.2): renders the backend's `creds` frame for the session (kept in `state.js`): one line over the run's preview, which opens its shell view (2026-11-26), or the editable command with Save. |
| `js/mcp-panel.js` | The MCP panel (R5.15), a layer in `keys.js` drawn like the Open list: renders the backend's `mcp` frame, chooses a server and an action, sends `mcpAction`. |
| `js/folder-list.js` | The folder list (New session and "Continue in a folder"): known folders, path completion on Tab, the create row, gone rows, the fixed list with no open session. |
| `js/theme-switch.js` | The theme choice: footer switch, system listener, UI state `theme`, the localStorage copy for first paint. |
| `js/theme.js` | Classic head script: theme before first paint from the localStorage copy; no globals. |
| `css/app.css`, `css/dark.css`, `css/preview.css`, `fonts/` | Look; fonts bundled (Q8, OFL), no Google Fonts. |

Page unit tests: `app/web/test/*.test.js` (`node --test`; `stub-dom.js` gives inert browser globals), run in the `web` line of `check.sh` with `app/web/dev/check-web.mjs` (syntax, imports resolve, no cycles, no stray `window` writes, no unloaded file).

### Shell (`app/shell`, Swift, built with swiftc)

| Module | One responsibility |
|---|---|
| `main.swift` | Start AppKit on the main actor. |
| `AppDelegate.swift` | Window, quit vs Stop All Work vs Restart Backend flows, one sheet at a time, error view. Shows the backend's `summary` sentence in the confirm; never names work kinds. |
| `Menus.swift` | Menu bar; no ⌘⇧[ ]. |
| `TitleBar.swift` | Integrated title bar, drag strip, double-click action. |
| `WebView.swift` | WKWebView, chrome injection (`in-app`, `fullscreen`, `--titlebar`, `SYNOPIA_CLOCK24`), navigation policy, snapshot hook. No `confirm()` bridge. |
| `DaemonFiles.swift` | The Swift reader of `daemon.json` (incl. `handover`), the HTTP reply types (ping, badge, quit-check) and the `daemon.log` tail for the error view. |
| `Backend.swift` | Find or start the daemon (posix_spawn), async HTTP with timeouts (ping, badge, quit-check, stop, restart), slow vs gone, loss handling with the handover field. |

Shell test: `app/shell/test/DaemonFilesTest.swift` decodes the goldens in `app/shell/test/golden` through `DaemonFiles.swift`; `shell-contract.test.ts` checks a real daemon's files and replies against the same goldens.

### Tooling

`app/build.sh` (builds `build/Synopia.app` in a temp bundle, checks it, swaps it in), `app/check.sh [--page]`, `app/dev.sh [--script]`, `app/web/dev/cdp/` (run.sh, cdp.mjs, helpers.mjs, chrome.sh, backend.sh, 32 suites), `app/web/dev/chrome-bin.sh` (fails without chrome-headless-shell), `app/web/dev/compare.sh` with `build-proto-fixture.ts`. See [Page checks](Page%20checks.md).

## Data flow

1. Page action: DOM event -> `keys`/`composer`/`card`/`sidebar` -> `connection.send(action)` with an id. Disconnected: refused with a toast, local state untouched (Q9).
2. `server` -> `router`: validate against `protocol.js`, resolve aliases, call `sessions`/`session`/`cards`/`layout`/`ui-state`/`open`/`preview`; reply `ack`. A thrown handler becomes `ack {ok:false}` plus a log line.
3. `session` drives one `sdk` process. SDK messages flow `sdk` -> `session` (control state) -> `status` (derived state) and `cards` (requests) -> `publisher`.
4. The CLI writes JSONL. `tail` -> `claude-jsonl` (classify) -> `transcript` (reduce) inside `transcripts` -> `status` (transcript facts) and `publisher` (items). The SDK stream carries only control and live state (R12); the stream preview is cleared when its record lands.
5. `cli-terminals` watches pid files -> `session` yields or takes over; `macos` gives process facts.
6. `publisher` flushes once per change batch: `open-items` syncs the session (its ledger, its review items), then `session` meta (with `state` from `status`), then `agents`/`background`, then `openItems` when the view changed, then `items`. A ledger read that changes a list flushes every session using it. Every module that changes visible state tells the publisher; nobody else sends frames.
7. `store` persists open list, layout, models, rules, answers, plans, status, ended, written titles, open items (`open-items.ts` owns the `items` section: the lists, each item's lines as last read, the carried marks), settings and UI state.
8. Folders: the page asks `listFolders` when the folder list opens (no disk read: the open list and `listSessions()`), `completeFolder` on Tab (one `readdir`), `checkFolders` for the rows on screen once per opening and for a typed path when typing stops; `newSession`/`continueSession` with `create` make the folder first. A continue starts the session's process with `resume`, `forkSession` and the new `cwd`; its `system/init` id goes through `rekey` ('moved'), which also moves the open entry to the new folder. `layout` and `ui-state` own their sections; `store` owns the file.
9. Shell: `Backend` polls `/api/badge` (cached count from `status`, O(1)) every 2 s on an async session; on loss reads `daemon.json` `handover` to wait for the successor.

## Threading and timing model

- Backend: one Node event loop owns all state. No worker threads. No synchronous child process (`ps`, the code hash and `procStart` are async; the hash skips files whose size, mtime, ctime and inode are unchanged). Child processes: one CLI per active session, transient menu probes and writer calls, `!` shells, bat, open, ps, the login shell once, a successor daemon during handover.
- Timers: stream throttle 50 ms, publisher recheck 60 s, transcript poll 1 s, pid-file poll 2 s, store write 1 s, writer debounce 20 s, update tick 1 s (hash every 10 s), idle exit check up to 60 s, session idle end 30 min. All `unref` where they must not hold the process.
- Re-entrancy: `publisher.flush` sets a guard; a change during a flush marks dirty and re-runs after, so frame order is fixed.
- Page: one main thread. Rendering per panel; the log patches by key; marks pin `startTime` inside re-rendered containers only (no document-wide observer walking all animations). No blocking calls.
- Shell: AppKit main actor for UI and callbacks; `URLSession` async with 2 s timeouts for polls (3 s for stop and restart), so a hung daemon never blocks stop or restart; one serial queue only for spawn and `ps`; one waitpid thread per spawned daemon.
- Real-time paths: marks move linearly forever (CSS, compositor); nothing on the backend loop may block longer than one 4 MB slice parse (NFR-06, NFR-09).

## Interfaces

### WebSocket protocol (`app/web/js/protocol.js` is the source, `VERSION` 4)

- Transport: `/ws`, `auth` first within 10 s, 32 MB cap, close 4001 on auth failure, 1009 on oversize.
- `hello` carries `v` (protocol version) and `code` (daemon code hash). A page of another version shows "Updating…", sends nothing and waits; it reloads once for a newer daemon.
- Server to page: `started` (a session started another, R3.15: a page viewing `from` shows `sid`), `hello`, `session` (meta plus `state` from `status` and `gone`; `replaces` and `layout` once on an id swap), `layout`, `removed`, `items`, `agents` (with `review`, true while the subagent has an open review item), `background`, `openItems {sid, items, checks, closed, unread, note}` (R3.16, FR-ITEM-05, to every page, whole on each change and in each `hello` session: `items` the open Y items, review items among them with `kind: "review"` and the subagent's `agent` id, `checks` the open A items, `closed` the items closed this turn, `unread` the ledger lines Synopia can't read, `note` why nothing could be read; an item is `{id, kind, text, source, at, minute, state?, options?, recommended?, trigger?, goesAhead?, watch?, subagent?, raisedBy?, answer?, agent?, with?: {agent, name}}`, a closed one `{id, kind, text, how, at, note, by}`; open-items.ts `view`), `pending`, `stream` (subscribed viewer only), `menu`, `toast`, `toolOutput`, `found {sid, view, q, seq, hits: [{id, at: [[from, to]]}], total, more}` (⌘F, R5.12e, 2026-11-26: the matches of `find` in transcript order, `id` an item's or, in a shell's view, the view's, `at` offsets in that item's search text, find.ts `itemText`), `output` (a shown shell's or monitor's output part: reset, prepend or append), `recent` (rows plus `total`, `folders`, `matched`), `folders` (the known folders), `completion` (one folder's child folders), `folderState` (gone or not, per path asked), `mcp` (R5.15, to every page: `{sid, servers: [{name, status, kind, scope, signIn, reconnect, busy}], error, note, reading}`, whole each time), `preview` (also for non-text files: `{opened:true}`), `pathState {sid, states: [{p, path, kind}]}` (2026-11-25), `restore` (texts and images, acting client only), `update`, `ack`.
- Page to server: actions with `id` and an `ack`: `send`, `bang`, `bangInput {sid, text}` (a line typed into the running `!` command, 2026-11-26), `bangStop {sid, bg}` and `stopTask {sid, bg}` (Esc, Esc in a run's shell view: your `!` command, or Claude's background shell or monitor through the SDK's `stopTask`, 2026-11-26), `answer`, `interrupt`, `background`, `sendNow {sid, draft?}` (f, f, R9.8: `session.ts` `nowRoute` picks how the turn changes, from what runs and what is queued; `draft` is the box's `{text, images, uuid}`, sent as a `send` would be), `close`, `newSession {cwd, create?}`, `openSession {sid}`, `continueSession {sid, cwd, create?}`, `cancelTakeover`, `setModel`, `item {sid, item, act}` (FR-ITEM-03: `act: "reviewed"` is Mark reviewed on a review item; refused for an item no open session's list holds; protocol 4 replaced the `reviewed` action), `moveSession`, `newGroup`, `renameGroup`, `mcpAction {sid, name, action}` (R5.15: `login`, `logout`, `reconnect`, `enable`, `disable`; acked once it ran, its outcome and error in the next `mcp`; refused while that server is busy or a terminal holds the session). Requests answered by data: `mcp {sid}` (the MCP panel opened: read now), `view {sid, agent, from, bg?}` (`bg`: a shell's or monitor's tool use id), `earlier`, `earlierOutput {sid, bg, before}`, `toolOutput`, `find {sid, view, q, seq}` (⌘F, R5.12e, 2026-11-26: the whole view searched by find.ts; `view` a subagent's, shell's or monitor's id, null for the main conversation), `listRecent`, `listFolders`, `completeFolder {path}`, `checkFolders {paths, chosen?}`, `preview`, `open`, `resolvePaths {sid, paths}` (R5.9, 2026-11-25: the inline-code paths of a render). State sync: `ui {patch}` (resent on reconnect).
- At run time a field more is ignored both ways; a frame that doesn't fit is dropped with a log line or console warning.
- Contract tests: golden frames in `app/backend/test/golden/`, checked strictly against the schema by `protocol-golden.test.ts`.

### HTTP (token in query)

| Endpoint | Reply |
|---|---|
| GET `/api/ping` | `{ok, pid, code, v}` |
| GET `/api/badge` | `{badge}` from the cached count |
| GET `/api/quit-check` | `{running, background: [{sid, kind}], counts: {<kind>: n}, summary}`; `summary` is the sentence after the alert's question, empty when nothing runs; `background` stays a list for the shells before `summary` |
| POST `/api/stop`, `/api/restart` | 200 |
| GET `/api/image` | image bytes (transcript ref or `draft:<id>`) |

### Files

| File | Owner | Readers |
|---|---|---|
| `<state>/daemon.json` `{pid, procStart, port, token, version, code, v, handover?: {reason, successor}}`, 0600, atomic | `daemon-files.ts` | `DaemonFiles.swift`, tests |
| `<state>/backend.lock` (kernel lock, never removed) | `daemon-files.ts` | |
| `<state>/daemon.log` (+`.1`) | daemon stdout/stderr | `DaemonFiles.swift` (last line for the error view only) |
| `<state>/state.json`, `drafts/` | `store.ts` (sections by `layout`, `ui-state`, `sessions`, `cards`, `writer`) | |
| `<state>/menu-cache.json` | `menu.ts` | |
| `<state>/backend.log` | `log.ts` | page checks (preview, open) |
| `~/.claude/projects/**` | Claude Code | `tail.ts` / `claude-jsonl.ts` |
| `~/.claude/sessions/<pid>.json` | Claude Code | `cli-terminals.ts` (never `*.key`) |
| `<folder>/.ai-notes/<area>/open-items.md` | the agent and the open-items skill | `open-items.ts` through `ledger.ts` (the format) |
| Your folders | you | `folders.ts`: one `readdir` on Tab, stats of named paths, `mkdir -p` of a typed path on its create row; `session.ts` stats its own folder |

`<state>` is `~/Library/Application Support/Synopia/` for the app, `app/.dev-state/` for `dev.sh`, a temp folder per page-check run. The daemon's files are in [Daemon files](Daemon%20files.md).

Handover: once the successor reports `loaded`, the old daemon rewrites its `daemon.json` with `handover: {reason, successor: <pid>}` and exits without removing it; the successor overwrites `daemon.json` when it listens. The shell treats "daemon gone, `daemon.json` has `handover`" (or names another pid) as a handover. No log text is a signal.

### state.json

Written atomically (temp file, then rename), 0600, at most once per second, only by the daemon that holds the lock (`store.ts` `State`):

```json
{
  "version": 1,
  "open":     [{"id": "…", "cwd": "…", "openedAt": 0, "closedAt": null}],
  "layout":   {"groups": [{"id": "g…", "name": "…", "ids": ["…"]}], "others": ["…"]},
  "items":    {"lists": {"<ledger path>|session:<sid>": {"top": {"Y": 0, "A": 0}, "items": [{"id": "Y1", "kind": "review", "text": "Review: …", "fields": {"subagent": "…"}, "source": "agent|synopia", "block": "<its lines as last read>", "agent": "<agentId>", "at": 0, "closed": {"how": "done", "at": 0, "note": "marked reviewed", "by": "agent|synopia"}}]}}, "carried": ["<agentId>"]},
  "models":   {"<sid>": {"model": "…", "effort": "…"}},
  "rules":    {"<sid>": ["Bash(npm run test:*)"]},
  "answers":  {"<toolUseId>": "Allow once"},
  "plans":    {"<toolUseId>": "<plan text the card showed>"},
  "status":   {"<sid>": {"status": "idle", "at": 0}},
  "ended":    {"<sid>": 0},
  "endedFailed": {"<sid>": true},
  "written":  {"<sid>": {"title": "…", "now": "…", "at": 0, "history": [{"title": "…", "at": 0}]}},
  "settings": {"writerModel": "haiku", "model": "…"},
  "ui": {
    "current": "<sid>", "view": "<agentId>|null", "mode": "normal|insert", "theme": "light|dark|null",
    "openList": {"filter": "…"}, "folderList": {"filter": "…", "sid": "<sid continued>|null"}, "preview": {"path": "…", "scroll": 0, "find": "…"},
    "viewer": {"srcs": ["/api/image?sid=…&ref=…"], "froms": ["…"], "i": 0},
    "sessions": {"<sid>": {
      "scroll":  {"<view>": {"id": "<block key>", "off": 0, "seen": "<block key>[@<output end>]"}, "<view>": {"bottom": true, "id": "<last block on screen>", "off": -300}},
      "earlier": {"<view>": "<oldest item id loaded>"},
      "steps": ["<view>|<item id>"], "diffs": ["<view>|<diff id>"], "folds": ["<view>|<block key>#<n>"],
      "draft": {"text": "…", "cursor": [0, 0], "images": [{"id": "…", "mediaType": "image/png", "size": 0, "n": 1}]},
      "cards": {"<requestId>": {}}
    }}
  }
}
```

- Caps: `items` keeps closed items with an agent id and the `carried` marks the newest 1000 together, other closed items the newest 30 per list (`open-items.ts`); `answers` 2000, `plans` 100 (`store.ts`), trimmed on write and on load. `written.history` keeps 50 titles. Every map entry is validated on load; a wrong one is dropped.
- `ui` (R3.9, `ui-state.ts`; page side `ui-state.js`): `<view>` is `""` for the main conversation, else the agent id. The page sends `ui {patch}` with the fields that changed, 300 ms after the last change (2 s at most) and at once on `visibilitychange` (hidden), `pagehide` and a send. A top-level field replaces the stored one; `sessions` merges per session and per field, `null` removing it. Unknown fields and malformed values are dropped. It is never broadcast: the last writer wins. `hello` returns it.
- The page applies `ui` before its first render. The scroll waits for the view's reset items, re-requests earlier items up to the stored oldest id, then goes to the anchor (the first block whose bottom is below the top of the log, and the pixels into it; at the end, the last block on screen, so what came since is below it), loading up to 5 more pages of earlier items to find it. A missing anchor block goes to the bottom. A view follows its end only while the window is visible. `seen` is the furthest block whose first line was on screen 1 s in a row with the window focused (`run@<offset>` for a line of a shell's or monitor's output, `bg-view.js` `outEnds`), `seenAt` when you last had it on screen, and `newAt` `{id, at}` the block the "New since" line sits above: placed when you come back to the view or the window is shown again, kept over a reload (`watchSeen`, `placeNew`, `drawNew`; 2026-11-25).
- Draft images: the page sends an image's base64 once, with the first patch that lists it; the backend writes `<state>/drafts/<sid>/<id>.png|jpg` (5 MB each, 20 MB per session; past that a toast and it isn't kept) and keeps only `{id, mediaType, size, n}`. A patch that no longer lists an image removes its file; a send clears the draft. After a restore the page loads them from `GET /api/image?sid&ref=draft:<id>`.
- A card's state is dropped once its request is gone. `close` prunes the session's data and its drafts folder; the start drops entries of sessions that are not open; an id swap moves both.
- Layout: the backend owns it (`layout.ts`). New and reopened sessions with no place go last under "Not in a group"; closed ids stay in their group, hidden, so a reopened session keeps its place; an id that changes keeps its place; a group goes only when it has no ids at all, hidden ones included.
- Nothing is in localStorage except the theme's first-paint copy. Never stored: transcript text beyond the written title and Now line, environment values, credentials.

### CLI flags and env

`--claude-dir`, `--state-dir`, `--port`, `--no-parent`, `--sdk-script <file>` (dev and checks: the scripted SDK over `--claude-dir`), `--dry-run` (`open` and a take-over's signal log and act on nothing), `--after <pid>` (set by the daemon this one replaces). Test-only: `--idle-ms`, `--exit-idle-ms`, `--update-read-ms`, `--successor-ms`. Accepted for the one update from a `rearch-base` daemon: `--fake` (the scripted SDK with no script) and `--dry-open` (as `--dry-run`). An unknown flag exits 2.

Env read by the shell: `SYNOPIA_STATE_DIR`, `SYNOPIA_SDK_SCRIPT` (a fixture tree: `--claude-dir <tree> --sdk-script <tree>/sdk-script.json`), `SYNOPIA_EXIT_IDLE_MS`, `SYNOPIA_SNAPSHOT`, `SYNOPIA_DEBUG_DRAG`.

### Page check contract

Suites use `window.__synopia` (state getters, `ready()`, `spy()`/`sent()`, `inject(msg)`, `acting()`) and DOM ids and classes. Page modules may change freely behind it; DOM ids and classes the suites select stay stable or move with the suite. `cdp.mjs` `check()` passes only on `=== true` or an explicit comparison; `ev()` throws on a page exception. Details in [Page checks](Page%20checks.md).

## State ownership

| State | Owner | Others hold |
|---|---|---|
| Session status, word, light, mark, needs-you, stopped, review count, badge | `status.ts` | page renders `session.state`; badge reads the counter |
| "Interrupted" vs "turned down" | `claude-jsonl.ts` classification | none |
| A subagent running, waiting, stopped or resumed after its end | `transcript.ts` `agentRunning` (the main conversation's Transcript) | page renders `agents[]`; status.ts reads its runs' ends (`runEnds`) |
| Pending cards, session rules, answer labels, answered plans | `cards.ts` | page shows `pending`; half-answers in UI state |
| Held, queued (outbox), after-exit messages | `session.ts` | page shows `session.outbox` |
| Layout | `layout.ts` | page renders the server layout, sends intents |
| Open list | `sessions.ts` | |
| MCP panel: servers, running action, last error | `mcp.ts` | page renders `mcp` |
| Credential refresh: each folder's command, its run, the dock line's phase and output, whether it waits | `creds.ts` (`state.json` `refresh`) | page renders `creds` |
| A run waits for input; when a run's card shows | `pty.ts` `InputWatch`; `runs.ts` `cardAt` (your runs and the refresh) | `bang.ts`, `creds.ts` send them; the page compares `cardAt` with its clock |
| UI state | `ui-state.ts` (backend) | page `ui-state.js` collects and applies |
| Theme | backend `ui.theme` | localStorage first-paint copy |
| Open items: the lists, ids, Synopia's state per item, review items, Mark reviewed | `open-items.ts` (`state.json` `items`; Mark reviewed through router `item`, only an item an open session's list holds; closed review items carried over a session's close); the ledger file is the agent's, an input | page renders `openItems` and `agents[].review`; status.ts takes `counts` |
| Model and effort choice | `session.ts` resolver (one), used for header and process | |
| Token and port | `daemon-files.ts` | page URL |

## Error handling

- Router: each frame in try/catch; a failure logs `router.failed t=<t>` and acks `{ok:false, error}`; the daemon keeps running (NFR-07). The server wraps `onMessage` and the HTTP handler as a last guard.
- Session process: a throw while handling one SDK message is logged `session.messageFailed` and the stream reads on.
- Process: `uncaughtException` and `unhandledRejection` log, flush `state.json` synchronously, remove `daemon.json`, exit 1; the shell restarts once (FR-PLAT-10).
- Shutdown: the router stops first and acks in-flight actions `{ok:false, error:"Synopia is restarting…"}`; after that the pages get no frames; then the teardown.
- Store: a failed write keeps the dirty flag and retries on the next tick; logs once per error code.
- Page: an action refused while disconnected toasts and keeps local state; an action not acked when the socket drops toasts that it may not have happened; a send refused or lost comes back to the box; card picks are deleted only on an `ok` ack.
- Shell: a failed quit-check shows a confirm with "Synopia could not tell what is running" instead of stopping unasked; one sheet at a time; stop re-checks `procStart` before SIGTERM.

## External-system adapters

| Adapter module | Topic doc |
|---|---|
| `claude-jsonl.ts`, `tail.ts` | [Claude Code transcripts](Claude%20Code%20transcripts.md) |
| `cli-terminals.ts` | [Claude Code terminals](Claude%20Code%20terminals.md) |
| `ledger.ts` | [Open items](Open%20items.md) |
| `sdk.ts`, `dev/scripted-sdk.ts`, `mcp.ts` (control calls) | [Agent SDK](Agent%20SDK.md) |
| `mcp.ts` (`claude mcp login`, `logout`) | [Claude Code terminals](Claude%20Code%20terminals.md) |
| `daemon-files.ts`, `DaemonFiles.swift` | [Daemon files](Daemon%20files.md) |
| `macos.ts`, `open.ts`, `login-env.ts`, `preview.ts` (bat) | [macOS](macOS.md) |
| `WebView.swift`, `TitleBar.swift`, `AppDelegate.swift`, page `marks.js`/`dnd.js` platform quirks | [WKWebView and AppKit](WKWebView%20and%20AppKit.md) |
| `app/web/dev/cdp/*`, `chrome-bin.sh` | [Page checks](Page%20checks.md) |

Synopia drives sessions only through the SDK's typed API (`query`, its options, `canUseTool`, the `Query` methods, the typed messages, `listSessions`). Four dependencies are outside it, each in one module with fixtures and a safe failure:

| Dependency | Module | Why | If it changes |
|---|---|---|---|
| The JSONL transcript records | `claude-jsonl.ts`, `tail.ts` | the only source of diffs (`structuredPatch`), subagent files and full history | the fixtures for each record shape fail first; unknown records are skipped, never fatal |
| `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS` | `sdk.ts` (flag), `status.ts` (events) | live running, needs you and idle | status falls back to `send` and `result` |
| The CLI's pid files `~/.claude/sessions/<pid>.json` | `cli-terminals.ts` | which sessions a terminal holds: yield, take-over, one writer | a file of another shape counts as no terminal, logged once |
| `cancelQueued` on interrupt | `sdk.ts` | so messages queued at an interrupt come back | used only when `system/init` advertises `interrupt_cancel_queued_v1`; else the typed `interrupt()` |

Facts the documented surface leaves open are settled by one scripted check and recorded in the topic doc as shapes, never values.

## Risks

- Memory per SDK process: each active session is a CLI process, 256 MB just after a turn, 100 to 175 MB within two minutes idle (five haiku sessions, 2026-11-23), so ten active sessions use 1.5 to 2.6 GB of 16 GB. The 30 min idle end frees them. Not measured: folders whose settings start MCP servers, growth over a long session.
- Large transcripts: the 15 largest sessions on the author's machine (309 MB of files, the largest 96.9 MB) open at once: first view in 15 to 515 ms, fully parsed within 654 ms, backend under 200 MB RSS with 42 MB of heap, 0.7 % CPU idle. Not measured: transcripts several times larger, many more than 15 open sessions.
- Undocumented dependencies change with any CLI update; each fails visibly in one module.
- The same session open in a terminal and in Synopia: two writers on one transcript can interleave records; the take-over keeps one writer only for sessions Synopia holds (CON-CC-12).

## Ruled out

- Electron: a downloaded runtime of about 150 MB that Jamf may block, and a second browser engine.
- Native SwiftUI: there is no Swift Agent SDK, and the custom UI would be a rewrite.
- Listing terminal sessions in the sidebar: only sessions open in Synopia show.
- Rendering from SDK messages: two paths that must render identically, and the SDK's history readers carry no diffs.
- A stdio relay through the shell: secure without a port, but more Swift, and the page couldn't run in Chrome for checks.
- `permissionMode: 'default'`: every edit and command would stop for you, unlike the terminal.
- The SDK's `bridge` and `browser` exports: both need claude.ai Remote Control endpoints, not local sessions.

## FR to module traceability

| FR | Modules |
|---|---|
| FR-PLAT-01 | AppDelegate.swift, WebView.swift |
| FR-PLAT-02 | sdk.ts |
| FR-PLAT-03 | sdk.ts, log.ts |
| FR-PLAT-04 | daemon-files.ts, Backend.swift, DaemonFiles.swift |
| FR-PLAT-05 | daemon-files.ts |
| FR-PLAT-06 | AppDelegate.swift, server.ts (quit-check), status.ts (`quitSummary`) |
| FR-PLAT-07 | daemon.ts |
| FR-PLAT-08 | daemon.ts, daemon-files.ts |
| FR-PLAT-09 | daemon.ts, AppDelegate.swift |
| FR-PLAT-10 | connection.js, Backend.swift, daemon-files.ts, daemon.ts |
| FR-PLAT-11 | status.ts, server.ts, Backend.swift |
| FR-PLAT-12 | TitleBar.swift, app.css |
| FR-PLAT-13 | WebView.swift |
| FR-PLAT-14 | WebView.swift, transcript.js, open.ts |
| FR-PLAT-15 | server.ts, router.ts, protocol.js, connection.js |
| FR-PLAT-16 | daemon.ts, dev.sh |
| FR-PLAT-17 | login-env.ts |
| FR-PLAT-18 | build.sh, app/web/icon |
| FR-PLAT-19 | daemon-files.ts, log.ts, daemon.ts |
| FR-SES-01 | sessions.ts, store.ts |
| FR-SES-02 | sessions.ts, folders.ts, folder-list.js, fuzzy.js |
| FR-SES-03 | sessions.ts, sdk.ts, fuzzy.js, open-list.js |
| FR-SES-04 | sessions.ts, session.ts, cards.ts, ui-state.ts |
| FR-SES-05 | writer.ts, sdk.ts |
| FR-SES-06 | transcript.ts, claude-jsonl.ts, publisher.ts |
| FR-SES-07 | session.ts, sdk.ts, menu.ts, composer.js |
| FR-SES-08 | cli-terminals.ts, macos.ts |
| FR-SES-09 | session.ts, cli-terminals.ts |
| FR-SES-10 | session.ts, cli-terminals.ts |
| FR-SES-11 | session.ts, cli-terminals.ts |
| FR-SES-12 | session.ts, sdk.ts |
| FR-SES-13 | sdk.ts |
| FR-SES-14 | session.ts, sdk.ts, protocol.js, composer.js |
| FR-SES-15 | none (future) |
| FR-SES-16 | session.ts, sessions.ts, folders.ts, sdk.ts (`forkSession`), claude-jsonl.ts (the context line), publisher.ts, composer.js, folder-list.js |
| FR-SES-17 | folder-list.js, transcript.js |
| FR-SES-18 | fuzzy.js, sessions.ts, open-list.js, folder-list.js, composer.js |
| FR-SES-19 | folders.ts, sessions.ts, folder-list.js |
| FR-SES-20 | agent-tools.ts, sdk.ts (`toolServer`), sessions.ts (`toolHost`), layout.ts (`placeUnder`), cards.ts, transcript.ts, publisher.ts (`started`), card.js, transcript.js, main.js |
| FR-STATE-01 | ui-state.ts, ui-state.js |
| FR-STATE-02 | store.ts, daemon.ts |
| FR-SIDE-01 | app.css, sidebar.js |
| FR-SIDE-02 | sidebar.js, tween.js |
| FR-SIDE-03 | sidebar.js |
| FR-SIDE-04 | dnd.js, layout.ts |
| FR-SIDE-05 | layout.ts, router.ts, sidebar.js |
| FR-SIDE-06 | none (future) |
| FR-VIEW-01 | transcript.js, publisher.ts |
| FR-VIEW-02 | transcript.js, app.css, fonts |
| FR-VIEW-03 | transcript.ts, transcript.js |
| FR-VIEW-04 | session.ts (outbox), publisher.ts, transcript.js, composer.js, marks.js |
| FR-VIEW-05 | transcript.ts, publisher.ts, transcript.js |
| FR-VIEW-06 | transcript.ts, transcript.js |
| FR-VIEW-07 | transcript.ts, transcript.js |
| FR-VIEW-08 | transcript.ts, claude-jsonl.ts, ledger.ts (`isLedgerPath`), transcript.js, open.ts |
| FR-VIEW-09 | preview.ts, preview.js |
| FR-VIEW-10 | open.ts |
| FR-VIEW-10a | md.js, path-links.js, file-refs.ts |
| FR-VIEW-11 | md.js, table-fit.js |
| FR-VIEW-12 | transcript.ts, cards.ts |
| FR-VIEW-13 | transcript.js, publisher.ts, state.js |
| FR-VIEW-14 | publisher.ts, transcripts.ts, transcript.js |
| FR-VIEW-15 | transcript.ts, transcripts.ts, images.js |
| FR-VIEW-16 | images.js |
| FR-VIEW-17 | session.ts, publisher.ts |
| FR-VIEW-18 | tail.ts, transcripts.ts |
| FR-VIEW-19 | claude-jsonl.ts, transcript.ts |
| FR-VIEW-20 | paths.ts |
| FR-VIEW-22 | find.ts, publisher.ts, router.ts, find.js, keys.js, ui-state.js, transcript.js |
| FR-BOX-01 | composer.js |
| FR-BOX-02 | composer.js, protocol.js, sdk.ts (content) |
| FR-BOX-03 | bang.ts, session.ts, composer.js |
| FR-BOX-04 | menu.ts, sdk.ts, composer.js |
| FR-BOX-05 | mcp.ts, sdk.ts, session.ts, router.ts, mcp-panel.js, composer.js, keys.js |
| FR-BOX-06 | composer.js, md.js, transcript.js |
| FR-NEED-01 | marks.js, app.css, card.js, status.ts |
| FR-NEED-02 | transcript.js |
| FR-NEED-03 | card.js |
| FR-NEED-04 | card.js, keys.js, cards.ts |
| FR-NEED-05 | cards.ts, card.js |
| FR-NEED-06 | cards.ts, sdk.ts |
| FR-NEED-07 | cards.ts |
| FR-NEED-08 | transcript.ts, status.ts, card.js |
| FR-NEED-09 | status.ts, transcript.js |
| FR-BG-01 | runs.ts, publisher.ts, rail.js, state.js, tween.js |
| FR-BG-02 | transcript.ts, rail.js |
| FR-BG-03 | rail.js |
| FR-BG-04 | rail.js, app.css |
| FR-BG-05 | publisher.ts, bg-view.js, rail.js |
| FR-BG-06 | session.ts, sdk.ts, router.ts, composer.js, bg-view.js |
| FR-BG-07 | transcript.ts, claude-jsonl.ts, session.ts, publisher.ts |
| FR-STAT-01 | marks.js, tween.js, app.css |
| FR-STAT-02 | status.ts, claude-jsonl.ts, transcript.ts (`runEnds`), publisher.ts (`blocked`), bang.ts, pty.ts |
| FR-STAT-03 | marks.js |
| FR-STAT-04 | app.css, dark.css |
| FR-STAT-05 | status.ts |
| FR-STAT-06 | none (future; would read `state.status` `signedout`) |
| FR-KEY-01 | keys.js, mode.js |
| FR-KEY-02 | mode.js, composer.js, app.css |
| FR-KEY-03 | Menus.swift, AppDelegate.swift |
| FR-KEY-04 | composer.js, session.ts, sdk.ts |
| FR-KEY-05 | composer.js, session.ts |
| FR-KEY-06 | composer.js, keys.js |
| FR-KEY-07 | keys.js, folder-list.js, open-list.js |
| FR-REV-01 | replaced by FR-ITEM-03 |
| FR-ITEM-01 | ledger.ts (the format, the path rule), transcript.ts (`ledger`), transcripts.ts (`ledgerOf`), open-items.ts (the reads) |
| FR-ITEM-02 | open-items.ts, ledger.ts, store.ts |
| FR-ITEM-03 | open-items.ts (review items, `markReviewed`, the carried marks), router.ts (`item`), publisher.ts (`agents[].review`), status.ts (`review`), protocol.js, state.js (`applyOpenItems`), transcript.js (Mark reviewed by the item's id), open-items.js and rail.js (To review from the review items) |
| FR-ITEM-04 | ledger.ts (`ownedIds`, `ownerOf`), transcript.ts (`ownsOf`), transcripts.ts (`ownsOf`), open-items.ts (`with`), open-items.js and rail.js (under the subagent's card) |
| FR-ITEM-05 | publisher.ts, protocol.js (`openItems`), state.js (`applyOpenItems`), open-items.js, rail.js, transcript.js (the clicks), composer.js (`writeLine`), app.css, dark.css |
| FR-ITEM-06 | open-items.ts (`counts`), status.ts (`waiting`, `due`), publisher.ts, sidebar.js (`waitingLine`), tween.js, marks.js (`open`) |
| FR-ITEM-07 | none yet (planned: open-items.ts, keys.js, ui-state.js, rail.js) |
| FR-LOOK-01 | app.css, fonts |
| FR-LOOK-02 | theme.js, theme-switch.js, dark.css, ui-state.ts |
| FR-LOOK-03 | all page modules, prototype/app.html |
| FR-TOOL-01 | check.sh, run.sh, cdp.mjs, check-web.mjs, app/web/test, DaemonFilesTest.swift |
| FR-TOOL-02 | run.sh, chrome.sh, chrome-bin.sh, backend.sh |
| FR-TOOL-03 | dev/scripted-sdk.ts, dev.sh |
| FR-TOOL-04 | test-api.js, connection.js (`?agent`, `?open`), Backend.swift, WebView.swift |
| FR-TOOL-05 | compare.sh, build-proto-fixture.ts |
| FR-TOOL-06 | perf/*.mjs |
| FR-TOOL-07 | none (dropped, Q10) |
| FR-TOOL-08 | test/upgrade.sh, test/upgrade.ts |

NFRs: NFR-01 the adapters table above; NFR-02 `sdk.ts` and the topic docs; NFR-03 the page modules and the `motion` suite; NFR-04 `chrome-bin.sh` and the cdp harness; NFR-05 `check.sh`; NFR-06 `macos.ts`, `daemon.ts` (async hash), `transcripts.ts` (async rereads); NFR-07 `router.ts`, `server.ts`, `daemon.ts`, `session.ts`; NFR-08 `server.ts`, `open.ts`, `log.ts`, `WebView.swift`; NFR-09 `tail.ts` (perf test in `tail.test.ts`), `session.ts` idle end; NFR-10 `build.sh`, `app/web/fonts`; NFR-11 fixtures with invented data, `cli-terminals.ts` (never `*.key`); NFR-12 `store.ts`; NFR-13 `folders.ts` (`folders.test.ts` counts the reads).

# Daemon files

The files the Node daemon and the Swift shell share, and the rules each side follows. The state folder is `~/Library/Application Support/Synopia` (`--state-dir`, or `SYNOPIA_STATE_DIR` passed by the shell). Each file has one reader per side: `daemon-files.ts` in Node, `DaemonFiles.swift` in the shell. The lifecycle that uses them is `daemon.ts`. Sources: code, `daemon-files.test.ts`, `daemon.test.ts`, `handover.test.ts`, `shell-contract.test.ts`.

## State folder

- Mode 0700, set with `mkdirSync` and then `chmodSync`: `daemon.json` holds the token. Code: `main.ts` (`chmodSync(stateDir, 0o700)`); `Backend.swift` `spawnDaemon`.
- `writeFileSync`'s `mode` is masked by the umask; every file that must be 0600 gets an explicit `chmodSync`. Code: `daemon-files.ts` `writeDaemonInfo`, `store.ts` `write`.

| File | Writer | Reader | Holds |
|---|---|---|---|
| `daemon.json` | daemon | shell, daemon | where the running daemon listens; `handover` while it hands over |
| `backend.lock` | daemon | daemon | the flock that makes one daemon per folder; the owner's pid as text |
| `daemon.log`, `daemon.log.1` | daemon stdout and stderr (opened by the shell or the old daemon) | shell | errors, crash traces and stop lines, for people and the error view |
| `backend.log` | daemon (`--state-dir` given; else `~/Library/Logs/Synopia/backend.log`) | people | the event log, no secrets |
| `state.json` | daemon | daemon | open sessions, layout, UI state |
| `menu-cache.json` | daemon | daemon | each folder's commands and models |
| `drafts/<sid>/` | daemon | daemon | pasted images of a message box draft |
| `writer/` | writer queries | none | the writer's private cwd |

## daemon.json

`{pid, procStart, port, token, version, code, v, handover?}`, one line, mode 0600.

| Field | Type | Check |
|---|---|---|
| `pid` | integer > 0 | process alive (`kill(pid, 0)`, EPERM counts alive) |
| `procStart` | string | equals `ps -o lstart=` now, in `LC_ALL=C TZ=UTC` |
| `port` | integer 1-65535 | |
| `token` | 64 hex digits | `GET /api/ping?token=` answers 200 with the same `pid` (shell) |
| `version` | string | `package.json` version |
| `code` | string | first 16 hex digits of the code hash (Node side only) |
| `v` | integer | the protocol version, `app/web/js/protocol.js` `VERSION` (Node side only; also in `/api/ping`) |
| `handover` | `{reason, successor}`, optional | present only in the file of a daemon that handed over: `reason` is `update` or `restart`, `successor` the new daemon's pid |

- Written to `daemon.json.<pid>.tmp` (0600) and renamed into place once the server listens, so a reader never sees half of it.
- At start, with the lock held, a file left there is stale and removed, unless its `handover.successor` is this daemon: the shell reads that file until this daemon writes its own.
- At a stop or a crash the daemon removes the file, only while it still names its pid. At a handover it rewrites it with `handover` instead and leaves it.
- A missing or malformed file means no daemon. A file whose pid is gone means: a handover when it has `handover`, else a stale file.
- The shell decodes `pid`, `procStart`, `port`, `token`, `version` and `handover`; it ignores the rest.
- Code: `daemon-files.ts` `parseDaemonInfo`, `writeDaemonInfo`, `removeDaemonInfo`, `clearStaleDaemonInfo`, `markHandover`, `isLive` (async); `DaemonFiles.swift` `info`, `handedOver`; `Backend.swift` `probe`. Test: `daemon-files.test.ts`, `shell-contract.test.ts`, `app/shell/test/DaemonFilesTest.swift` (the goldens in `app/shell/test/golden`).

### Quirk: process start strings

- Symptom: a reused pid passes for the daemon, or a live daemon reads stale.
- Cause: `ps -o lstart=` output depends on locale and zone, and pads a single-digit day with spaces (`Nov  4`).
- Workaround: both sides run `/bin/ps -o lstart= -p <pid>` with env `LC_ALL=C TZ=UTC` and compare strings. Format: `^\w{3} \w{3} +\d+ \d\d:\d\d:\d\d \d{4}$`.
- Code: `macos.ts` `procStart` (as printed, not squashed), `daemon-files.ts` `ownStart` (asks up to three times; `''` when `ps` never answers, and the app then reads the file as stale), `Backend.swift` `procStart`. Test: `daemon-files.test.ts` "a stale daemon.json is not live", `macos.test.ts`.

## Lock

- The daemon opens `backend.lock` (0600, created if missing) with an exclusive, non-blocking flock (`O_EXLOCK | O_NONBLOCK`, see [macOS](macOS.md#file-locks)) and keeps the descriptor open for its life. A second opener gets `EAGAIN`: the folder is held.
- The kernel drops the flock when the process ends, however it ends (SIGKILL too). A dead daemon leaves no lock to take over, so two starters at the same moment can't both win.
- The owner writes its pid into the file, for the refusal message only; a release empties it. A crash leaves its pid there, which means nothing: the flock decides.
- The file is never removed. A removed lock file would let a second starter create and lock a new file while the first still holds the old one.
- Code: `daemon-files.ts` `acquireLock`, `lockOwner`. Test: `daemon-files.test.ts` (eight starters racing for a crashed daemon's lock, SIGKILL).

## Exit codes

| Code | Meaning | Shell reaction |
|---|---|---|
| 0 | a stop: "Stop All Work", SIGTERM, SIGINT, the idle exit, or a handover | a handover: waits for the successor; else starts one on the next need |
| 1 | an uncaught error: state.json written first, daemon.json removed, the trace on stderr | restarts it once; a second loss within 60 s shows the error view |
| 2 | bad arguments (an unknown flag or a missing value, `--port`, `--sdk-script` without `--claude-dir`) | error view with daemon.log's last line |
| 3 | another daemon holds the lock; daemon.json left alone | waits for the other daemon's daemon.json |
| 4 | cannot listen on 127.0.0.1 | error view |

Code: `daemon-files.ts` `EXIT`; `daemon.ts` `startDaemon` (3, 1), `cannotListen` (4); `main.ts` (2). Test: `daemon-files.test.ts` "a second backend…", `daemon.test.ts` "an uncaught error…".

### Quirk: `waitpid` gives a raw status

- Symptom: the shell never sees exit 3.
- Cause: the status from `waitpid` is the raw wait status, the exit code shifted left 8 bits.
- Workaround: compare with `3 << 8`.
- Code: `Backend.swift` `findOrStart`.

## Starting the daemon from the shell

- `posix_spawn` of the baked-in node path (`config.json` in the app bundle, written by `app/build.sh`) with `--disable-warning=ExperimentalWarning --experimental-strip-types <backend>/src/main.ts`, plus `--state-dir`, `--claude-dir <dir> --sdk-script <dir>/sdk-script.json` or `--exit-idle-ms` from `SYNOPIA_STATE_DIR`, `SYNOPIA_SDK_SCRIPT`, `SYNOPIA_EXIT_IDLE_MS`.
- stdin `/dev/null`; stdout `daemon.log` opened `O_WRONLY | O_CREAT | O_APPEND` 0600; stderr dup'd to stdout.
- Flags `POSIX_SPAWN_SETSID` (its own session, so the app's end never reaches it), `POSIX_SPAWN_CLOEXEC_DEFAULT` (none of the app's descriptors), `POSIX_SPAWN_SETSIGDEF` with every signal but SIGKILL and SIGSTOP, and `POSIX_SPAWN_SETSIGMASK` with an empty mask. The app ignores SIGTERM (it quits through a dispatch source), and ignored signals are inherited, so SETSIGDEF is required for the daemon to honour SIGTERM.
- While the app runs it reaps the child on a thread, so a zombie never passes for alive.
- The shell waits up to 20 s for a live daemon.json; a child that exits other than 3 ends the wait 1 s later.
- A daemon.json whose process runs with the recorded `procStart` but whose ping gets no answer within 2 s is a slow daemon, not a missing one: the shell keeps asking for up to 20 s and starts none (a second daemon would only exit 3). Still silent after that, the error view says it runs but doesn't answer.
- All HTTP from the shell is async with a timeout (2 s for ping, badge and quit-check, 3 s for stop and restart); one badge poll at a time. A badge poll with no answer from a process that still has the recorded `procStart` is a slow daemon; one whose pid is gone or has another start time is a lost one.
- Code: `Backend.swift` `spawnDaemon`, `findOrStart`, `probe`, `poll`; `AppDelegate.swift`.

## Stop All Work and Restart Backend Now

- Both ask `GET /api/quit-check` first. Its `summary` is the confirm's sentence after the question (`Stop all work?`, `Restart the backend?`), empty when nothing runs; `counts` counts the work per kind, and `background` lists it, one `{sid, kind}` each. The backend names the kinds (`status.ts` `quitSummary`); the shell shows `summary` as it is.
- `background` stays a list because the shells built before `summary` decode `{running: [String], background: [{kind}]}` and, when that fails, stop without asking. Such a shell can still be open when its daemon updates itself to this code.
- An empty `summary` acts at once. A check with no answer, or a reply without `summary` (an older daemon), asks with "Synopia could not tell what is running." One check or sheet at a time.
- Stop: `POST /api/stop`, then the shell waits 15 s for the pid to go, checking each second that the pid still has the recorded `procStart`. Only the same process gets SIGTERM, then 3 s more; a reused pid counts as gone.
- Code: `AppDelegate.swift` `confirmIfRunning`; `Backend.swift` `stopDaemon`, `waitGone`, `same`; `status.ts` `quitSummary`. Test: `status.test.ts` "quitSummary…", `shell-contract.test.ts`, `DaemonFilesTest.swift`.

## daemon.log

- The shell (or the old daemon, for a successor) opens it for append and hands it over as stdout and stderr, so the daemon can't rename it. Rotation is copytruncate at 5 MB (`daemon.log.1`), checked at ready and with each idle-exit check; every writer has `O_APPEND`, so truncation is safe. Code: `daemon-files.ts` `rotateLog`.
- The shell reads only its last 4 KB and takes the last non-empty line as the reason for an error view. Code: `DaemonFiles.swift` `lastLogLine`.
- At every stop the daemon writes `<ISO time> Synopia backend: stop (<reason>)` to stderr, and at a crash `<ISO time> Synopia backend: <uncaughtException|unhandledRejection>: <stack>`. These lines are for people: no reader acts on their text. Code: `daemon.ts` `stop`, `crash`.

## Lifecycle

| State | Entered | What runs |
|---|---|---|
| starting | `startDaemon`: the code hash read (under the app with the page files it serves), a handover's old pid gone, the lock taken, a stale daemon.json removed, the exit and crash handlers set | the modules are wired, the server starts |
| ready | `ready`: daemon.json written | the idle exit (30 min, checked each minute) and the update check (a reading every 10 s, a busy check each second); neither under `--no-parent` |
| stopping | `stop(reason)` | the shutdown order below, then exit 0 |

Shutdown order: the router refuses frames and acks running actions `{ok: false}` "Synopia is restarting…"; then the pages get no more frames (a card cleared on the way out would flash away before "Reconnecting…"); daemon.json is removed, or marked with `handover`; every module stops (sessions end their processes); state.json is written; each page's socket closes; the lock is released; exit 0.

An uncaught exception or unhandled rejection writes state.json synchronously, removes daemon.json (unless it is a handover's) and exits 1.

Code: `daemon.ts` `startDaemon`; `main.ts` (the module list for `Parts`). Test: `daemon.test.ts` "a stopping daemon sends the pages nothing…", "an uncaught error…".

## Handover

An update (the checkout's code hash changed, read twice the same, nothing running; the hash covers `app/backend/src/**/*.ts`, `package-lock.json` and the page files: `app/web/**` but `dev/`, `test/` and dot files, `protocol.js` among them, which the backend imports too) or "Restart Backend Now…" (`POST /api/restart`) replaces the daemon without the shell starting one.

| Step | Old daemon | New daemon | Shell |
|---|---|---|---|
| 1 | spawns node with its own `execArgv` and `argv` plus `--after <pid>`, detached, stdout and stderr on daemon.log, an `ipc` slot | | |
| 2 | | loads every module, sends `{t: 'loaded'}` over IPC, disconnects | |
| 3 | no `loaded` within 20 s, or an exit: kills it, stays, toasts "The new backend didn't start…" (`handover.failed`); an update hash that failed is not tried again | | |
| 4 | work started meanwhile (update only): aborts the successor (`handover.deferred`) and tries again after the next code reading, once nothing runs | | |
| 5 | rewrites its daemon.json with `handover: {reason, successor}`, stops (state.json written), exits 0, leaving the file | waits (at most 20 s) for the old pid to go, then takes the lock, keeps the marked daemon.json, and writes its own once it listens | the badge poll sees the daemon gone; daemon.json has `handover` (or already names the successor), so it waits up to 20 s for a live daemon.json and reloads the page from it, not counting a crash |

- The successor inherits the merged login environment (`SYNOPIA_LOGIN_ENV=1`) and does not ask the login shell again.
- An action sent while the old daemon stops is acked `{ok: false}`; the page keeps it and says so.
- A successor that loads but fails later is a lost daemon: the shell starts one after its 20 s wait.
- Under the app the daemon serves the page files it read at start with its code hash, so a reload while an old daemon waits for its work to end gets the old page, not a newer one it can't talk to; a page edit alone is an update. Under `--no-parent` it reads `app/web` (with `dev/`) on each request, so page edits show on reload. Code: `daemon.ts` `CodeHasher.snapshot`, `server.ts` `page`. Test: `daemon.test.ts` "under the app a daemon serves the page it started with…". A page whose protocol version differs from its daemon's (`hello.v`, or no `v` at all) shows "Updating…" in place of "Reconnecting…", retries with the reconnect backoff, and reloads once a daemon of its own version answers; a newer daemon reloads it at once, once per version. The version is checked before the schema, which may differ too. Code: `connection.js` `receive`, `otherVersion`. Test: `app/web/test/connection.test.js`.
- The 10 s reading and the 20 s wait have test-only flags, `--update-read-ms` and `--successor-ms`; a successor inherits them.
- Code: `daemon.ts` `successorArgs`, `startSuccessor`, `awaitHandover`, `UpdateCheck.defer`, `startDaemon` (`handOver`, `stop`); `daemon-files.ts` `markHandover`, `clearStaleDaemonInfo`; `DaemonFiles.swift` `handedOver`; `Backend.swift` `lost`. Test: `handover.test.ts` (a new daemon that exits, one that stays silent, the deferred update), `daemon.test.ts` and `shell-contract.test.ts` (a restart's `handover`).

### The one update from a daemon before these files

The daemons before this format (git tag `rearch-base`) lock with a pid file, write daemon.json without `v` or `handover`, hash only `src/**/*.ts` and `package-lock.json`, and take `--fake` and `--dry-open`. Such a daemon still updates itself to this code, once:

- It starts the new `main.ts` with its own command line plus `--after <pid>`. The new daemon accepts `--fake` (the scripted SDK with no script, so a check's daemon makes no model call) and `--dry-open` (as `--dry-run`); without them its flag parse would exit and the old daemon would stay.
- `{t: 'loaded'}` over IPC is the same message. The old daemon removes daemon.json and its `backend.lock`, and exits; the new one waits for its pid, then takes the kernel lock on the same file. A pid file never blocks the kernel lock, so nothing may start a second daemon meanwhile, and nothing does: the old shell waits for the successor, the new shell adopts the old daemon.json while it is live.
- An old shell tells this handover from a crash by daemon.log's last line, `… stop (update)`. The new daemon writes nothing to stderr while it starts, so that line stays last.
- An old shell decodes the quit check as `{running: [String], background: [{kind}]}`; `background` keeps that shape (see Stop All Work).
- A new shell with an old daemon: the old daemon.json decodes (`v` and `code` are optional), the page gets an old `hello` and shows "Updating…" until the update. When that daemon hands over, its daemon.json is gone with no `handover`, so the shell may count a crash and start a daemon; that one or the successor gets exit 3, and one daemon remains.
- Code: `main.ts` (`OPTIONS`, the old flags). Test: `app/backend/test/upgrade.sh` (opt-in, about 25 s, not in `check.sh`): a `rearch-base` daemon on a temp state folder in its fake mode, its checkout replaced by this tree's code; one daemon after, the new daemon.json fields, `/api/ping`, the quit check's list, state.json kept, daemon.log's last line.

## Connection checks

| Check | Failure |
|---|---|
| upgrade path `/ws`, exact `Host`, exact `Origin` | HTTP 403, no upgrade (an upgrade with no Origin too) |
| first frame `{t: 'auth', token}` within the auth timeout | close 4001 `auth` |
| a frame over `MAX_PAYLOAD` (32 MB), before auth too | close 1009 |
| HTTP: `Host` exact; `/api/*` needs `?token=` | 403 |

Code: `server.ts` `startServer` (`serve` for HTTP, the `upgrade` and `connection` handlers for the socket). Test: `server.test.ts`.

# Daemon files

The files the Node daemon and the Swift shell share, and the rules each side follows. The state folder is `~/Library/Application Support/Synopia` (`--state-dir`, or `SYNOPIA_STATE_DIR` passed by the shell). Each file has one reader per side: `daemon.ts` in Node, `Backend.swift` in the shell. Sources: code and `daemon.test.ts`.

## State folder

- Mode 0700, set with `mkdirSync` and then `chmodSync`: `daemon.json` holds the token. Code: `main.ts` 74-75; `Backend.swift` `spawnDaemon` (189-190).
- `writeFileSync`'s `mode` is masked by the umask; every file that must be 0600 gets an explicit `chmodSync`. Code: `daemon.ts` `writeDaemonInfo` (50).

| File | Writer | Reader | Holds |
|---|---|---|---|
| `daemon.json` | daemon | shell, daemon | where the running daemon listens |
| `backend.lock` | daemon | daemon | the pid of the daemon that owns the folder |
| `daemon.log`, `daemon.log.1` | daemon stdout and stderr (opened by the shell or the old daemon) | shell | errors and the stop reason line |
| `backend.log` | daemon (`--state-dir` given; else `~/Library/Logs/Synopia/backend.log`) | people | the event log, no secrets |
| `state.json` | daemon | daemon | open sessions, layout, UI state |
| `menu-cache.json` | daemon | daemon | each folder's commands and models |
| `drafts/<sid>/` | daemon | daemon | pasted images of a message box draft |
| `writer/` | writer queries | none | the writer's private cwd |

## daemon.json

`{pid, procStart, port, token, version, code}`, one line, mode 0600.

| Field | Type | Check |
|---|---|---|
| `pid` | integer > 0 | process alive (`kill(pid, 0)`, EPERM counts alive) |
| `procStart` | string | equals `ps -o lstart=` now, in `LC_ALL=C TZ=UTC` |
| `port` | integer 1-65535 | |
| `token` | 64 hex digits | `GET /api/ping?token=` answers 200 with the same `pid` (shell) |
| `version` | string | `package.json` version |
| `code` | string | first 16 hex digits of the code hash (Node side only) |

- Written to `daemon.json.<pid>.tmp` (0600) and renamed into place once the server listens, so a reader never sees half of it. Removed at start (the lock is ours, so a file left there is stale) and at stop, only while it still names this pid.
- A missing, malformed or stale file means no daemon.
- Code: `daemon.ts` `parseDaemonInfo`, `writeDaemonInfo`, `removeDaemonInfo`, `isLive` (async); `Backend.swift` `live` (146-155).

### Quirk: process start strings

- Symptom: a reused pid passes for the daemon, or a live daemon reads stale.
- Cause: `ps -o lstart=` output depends on locale and zone, and pads a single-digit day with spaces (`Nov  4`).
- Workaround: both sides run `/bin/ps -o lstart= -p <pid>` with env `LC_ALL=C TZ=UTC` and compare strings. Format: `^\w{3} \w{3} +\d+ \d\d:\d\d:\d\d \d{4}$`.
- Code: `macos.ts` `procStart` (as printed, not squashed), `daemon.ts` `ownStart` (asks up to three times; `''` when `ps` never answers, and the app then reads the file as stale), `Backend.swift` `procStart` (172-185). Test: `daemon.test.ts` "a stale daemon.json is not live", `macos.test.ts`.

## Lock

- `backend.lock` holds the owner's pid. The daemon writes its pid to `backend.lock.<pid>` (0600) and hard-links it to `backend.lock`: the link is atomic and EEXIST means held, so the lock never exists empty.
- A held lock whose pid is dead is stale: unlinked and taken (two attempts).
- Code: `lock.ts` `acquireLock`, `take`.

## Exit codes

| Code | Meaning | Shell reaction |
|---|---|---|
| 2 | bad arguments (`--port`, `--fake` without `--claude-dir`) | error view with daemon.log's last line |
| 3 | another daemon holds the lock; daemon.json left alone | waits for the other daemon's daemon.json |
| 4 | cannot listen on 127.0.0.1 | error view |

Code: `main.ts` 64-72, 86-93, 286-289. Test: `daemon.test.ts` 184-185, 195-196.

### Quirk: `waitpid` gives a raw status

- Symptom: the shell never sees exit 3.
- Cause: the status from `waitpid` is the raw wait status, the exit code shifted left 8 bits.
- Workaround: compare with `3 << 8`.
- Code: `Backend.swift` 138.

## Starting the daemon from the shell

- `posix_spawn` of the baked-in node path (`config.json` in the app bundle, written by `app/build.sh`) with `--disable-warning=ExperimentalWarning --experimental-strip-types <backend>/src/main.ts`, plus `--state-dir`, `--fake --claude-dir` or `--exit-idle-ms` from `SYNOPIA_STATE_DIR`, `SYNOPIA_FAKE`, `SYNOPIA_EXIT_IDLE_MS`.
- stdin `/dev/null`; stdout `daemon.log` opened `O_WRONLY | O_CREAT | O_APPEND` 0600; stderr dup'd to stdout.
- Flags `POSIX_SPAWN_SETSID` (its own session, so the app's end never reaches it), `POSIX_SPAWN_CLOEXEC_DEFAULT` (none of the app's descriptors), `POSIX_SPAWN_SETSIGDEF` with every signal but SIGKILL and SIGSTOP, and `POSIX_SPAWN_SETSIGMASK` with an empty mask. The app ignores SIGTERM (it quits through a dispatch source), and ignored signals are inherited, so SETSIGDEF is required for the daemon to honour SIGTERM.
- While the app runs it reaps the child on a thread, so a zombie never passes for alive.
- The shell waits up to 20 s for a live daemon.json; a child that exits other than 3 ends the wait 1 s later.
- Code: `Backend.swift` `spawnDaemon` (188-235), 127-142; `AppDelegate.swift` 14-21.

## daemon.log

- The shell (or the old daemon, for a successor) opens it for append and hands it over as stdout and stderr, so the daemon can't rename it. Rotation is copytruncate at 5 MB (`daemon.log.1`); every writer has `O_APPEND`, so truncation is safe. Code: `daemon.ts` `rotateLog` (97-108).
- The shell reads only its last 4 KB and takes the last non-empty line as the reason for an error view. Code: `Backend.swift` `lastLogLine` (318-325).
- At every stop the daemon writes `<ISO time> Synopia backend: stop (<reason>)` to stderr. Code: `main.ts` `shutdown` (295-301).

## Handover

An update (the checkout's code hash changed, read twice the same, nothing running) or "Restart Backend Now…" (`POST /api/restart`) replaces the daemon without the shell starting one.

| Step | Old daemon | New daemon | Shell |
|---|---|---|---|
| 1 | spawns node with its own `execArgv` and `argv` plus `--after <pid>`, detached, stdout and stderr on daemon.log, an `ipc` slot | | |
| 2 | | loads every module, sends `{t: 'loaded'}` over IPC, disconnects | |
| 3 | no `loaded` within 20 s, or an exit: kills it, stays, toasts "The new backend didn't start…" (`handover.failed`); an update hash that failed is not tried again | | |
| 4 | work started meanwhile (update only): aborts the successor (`handover.deferred`) | | |
| 5 | writes state.json, removes daemon.json, writes `stop (update)` or `stop (restart)`, exits | waits (at most 20 s) for the old pid to go, then takes the lock and writes daemon.json | the badge poll sees the daemon gone; the last log line ends `stop (update)` or `stop (restart)`, so it waits for the new daemon.json and reloads the page from it |

- The successor inherits the merged login environment (`SYNOPIA_LOGIN_ENV=1`) and does not ask the login shell again.
- A message sent in the few milliseconds of the handover is dropped: a stopping daemon handles nothing.
- A successor that loads but fails later is a lost daemon: the shell starts one after 20 s.
- Code: `daemon.ts` `successorArgs`, `startSuccessor`, `awaitHandover` (180-237); `main.ts` `handOver` (364-391), `shutdown`; `Backend.swift` `handover` (288-291). Test: `daemon.test.ts` 232-268 (the restart test leaves a detached successor that the test kills), 262.

## Connection checks

| Check | Failure |
|---|---|
| upgrade path `/ws`, exact `Host`, exact `Origin` | HTTP 403, no upgrade (an upgrade with no Origin too) |
| first frame `{t: 'auth', token}` within the auth timeout | close 4001 `auth` |
| a frame over `MAX_PAYLOAD` (32 MB), before auth too | close 1009 |
| HTTP: `Host` exact; `/api/*` needs `?token=` | 403 |

Code: `server.ts` 119-126, 177-216. Test: `server.test.ts` 145, 148-196.

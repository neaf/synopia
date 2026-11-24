# Claude Code terminals

How Synopia sees a Claude Code CLI running in a terminal, and how it takes a session over. The pid files are undocumented; `registry.ts` is the only module that reads them, and it fails safe: a file it can't make sense of counts as no terminal (logged once as `registry.format`). Facts hold for CLI 2.1.325 to 2.1.330. Sources: code, `registry.test.ts`, the take-over live run (CLI 2.1.325 in a pty under `expect`, recorded in `.ai-notes/app/README.md` "Settled by the take-over live run").

Transcript files are in [Claude Code transcripts](Claude%20Code%20transcripts.md).

## Pid files

`~/.claude/sessions/<pid>.json`, one per running CLI process.

| Field | Value | Used |
|---|---|---|
| `pid` | the CLI's pid; equals the file name | yes |
| `sessionId` | the session it holds | yes |
| `procStart` | process start, UTC, as `LC_ALL=C TZ=UTC ps -o lstart=` prints it | yes |
| `kind` | `interactive` for a terminal and for an SDK child | yes |
| `entrypoint` | `cli` for a terminal; `sdk-ts` for an SDK child | yes |
| `cwd` | the session's folder | yes |
| `status` | `busy`, `idle`, `waiting`, `shell` (a `!` command) | yes |
| `statusUpdatedAt` | ms epoch | yes |
| `spare`, `isSpare` | true for a pre-started spare | skipped when true |
| `startedAt`, `version`, `peerProtocol`, `name`, `nameSource`, `updatedAt`, `waitingFor`, `messagingSocketPath` | seen, not read | no |

- `<pid>.key` files sit beside them. They hold secrets. Synopia never reads them: only names matching `^\d+\.json$` are opened. Code: `registry.ts` `NAME` (25), scan (163-164).
- A file counts as a terminal when its pid is alive, `procStart` equals the process's start time, `kind` is `interactive`, `entrypoint` is `cli`, it is not spare, and the pid is not a descendant of Synopia (8 parents walked). Code: `registry.ts` 173-205.
- `status` comes from the CLI: idle, busy (also while it retries the API), idle. The `shell` value comes from strings in the CLI binary (constraints review B2), against the no-internals rule; it is `unverified` live. Any value other than `idle` makes a take-over wait, so the unknown value is safe.
- Whether the CLI deletes its pid file on exit is `unverified`. The registry checks liveness and start time on every scan, so a leftover file never counts.

### Quirk: `procStart` is UTC

- Symptom: a plain `ps -o lstart=` differs from `procStart` by the zone offset (1 h here), so every terminal reads as a reused pid.
- Cause: the CLI writes the start time in UTC.
- Workaround: run `/bin/ps -o lstart= -p <pid>` with env `LC_ALL=C TZ=UTC`, and compare with runs of spaces squashed.
- Code: `registry.ts` `ps` (35-43), `counts` (194-205). Test: `registry.test.ts` 53. Source: confirmed live (take-over run); first found with `strings` on the CLI binary (round-1 constraints review B1).

### Quirk: SDK children write pid files too

- Symptom: Synopia's own sessions would show as terminals.
- Cause: a CLI started by the SDK writes a pid file with `kind: interactive`, `entrypoint: sdk-ts`, the same keys as a terminal's.
- Workaround: only `entrypoint: cli` counts, and pids under Synopia's own process are skipped.
- Code: `registry.ts` 178, `ours` (207-214). Test: `registry.test.ts` 89-90.

### Quirk: inherited Claude Code variables suppress the file

- Symptom: a CLI started from a shell inside another Claude Code session is invisible to Synopia.
- Cause: a CLI started with `CLAUDE_CODE_SESSION_ID`, `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT` (or other `CLAUDE_CODE_*` variables) in its environment writes no pid file.
- Workaround: none in code. A normal terminal tab carries none of them. Scripted checks clear them with `env -u`.
- Code: none. Source: take-over live run.

### Timing

- The pid file appears 1 to 3 s after the CLI starts, before the first prompt.
- SIGTERM ends an idle interactive CLI in about 1 s; no SIGINT is needed.
- The registry polls every 2 s (`POLL_MS`) and also watches the folder; see [macOS](macOS.md#fswatch-merges-and-drops-events).

## Two writers on one transcript

Nothing in the CLI stops two processes from writing one session's JSONL: their records interleave. Source: spike/FINDINGS.md "Gotchas". Synopia guards itself: before it resumes a session it checks the pid files, and it yields a session a terminal takes.

## Take-over

| Step | What Synopia does | Code |
|---|---|---|
| a terminal opens a session Synopia holds | yields at once: interrupt, end its process, show the session read-only (`terminal.took`), about 2 s after the CLI starts | `sessions.ts`, `registry.ts` scan |
| the terminal's CLI exits | the session is Synopia's again (`terminal.gone`), no process started | `sessions.ts` |
| you send in Synopia on a terminal-held session | waits until the CLI's `status` is `idle`, then ends it | `registry.ts` `endTerminal` (278-307) |
| ending the CLI | SIGTERM; SIGINT after 5 s (`SIGINT_MS`); gives up at 10 s (`EXIT_MS`); never SIGKILL | `registry.ts` 278-307 |
| the note | `Synopia took over this session at HH:MM. To continue here instead: claude --resume <sid>` written to the CLI's tty after it exited, so its last redraw doesn't cover it | `registry.ts` `takeoverNote`, `endTerminal` |
| resume | after the transcript is unchanged for 500 ms (`STABLE_MS`), at most 5 s | `registry.ts` `waitStable` (310-320) |

### Quirk: tty names

- Symptom: none if handled; a wrong device would write the note elsewhere.
- Cause: `ps -o tty=` gives `ttysNNN` on macOS (`pts/N` elsewhere) and `??` when there is no terminal.
- Workaround: read the tty before sending the signal (after the exit `ps` has nothing), accept only `ttys?\d+` or `pts/\d+`, open `/dev/<tty>` with `O_WRONLY | O_NOCTTY | O_NONBLOCK`. No tty: log `registry.noTty` once and skip the note.
- Code: `registry.ts` `ttyDevice` (273-276), `realEnd.write`. Test: `registry.test.ts` 151, 181.

## Permission mode at start

A folder's `permissions.defaultMode` (`.claude/settings.json`) is read when the CLI process starts. Changing it under a running process changes nothing until the next start. Source: live run M1-final.

# Claude Code terminals

How Synopia sees a Claude Code CLI running in a terminal, and how it takes a session over. The pid files are undocumented; `cli-terminals.ts` is the only module that reads them, and it fails safe: a file it can't make sense of counts as no terminal (logged once as `terminals.format`). Process facts (`ps`, liveness, signals) come from `macos.ts`; see [macOS](macOS.md#ps). Facts hold for CLI 2.1.325 to 2.1.330. Sources: code, `cli-terminals.test.ts`, the take-over live run (CLI 2.1.325 in a pty under `expect`, recorded in `.ai-notes/app/README.md` at tag `rearch-base` "Settled by the take-over live run").

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

- `<pid>.key` files sit beside them. They hold secrets. Synopia never reads them: only names matching `^\d+\.json$` are opened. Code: `cli-terminals.ts` `NAME`, `files`. Test: `cli-terminals.test.ts` "a .key file is never read".
- A file counts as a terminal when its pid is alive, `procStart` equals the process's start time, `kind` is `interactive`, `entrypoint` is `cli`, it is not spare, and the pid is not a descendant of Synopia (8 parents walked). Code: `cli-terminals.ts` `files`, `verify`; `macos.ts` `descendsFrom`.
- The verification is kept per pid and `procStart` while the pid lives; liveness is checked on every scan. A `ps` that fails (timeout, spawn error) leaves the file unknown: not stored, asked again on the next scan. Code: `cli-terminals.ts` `verify`. Test: `cli-terminals.test.ts` "a failed ps leaves the terminal unknown".
- A live pid whose start time differs from `procStart` (a reused pid, or a changed time format) is logged once as `terminals.startMismatch`. Test: `cli-terminals.test.ts` "a live pid whose start differs".
- `status` comes from the CLI: idle, busy (also while it retries the API), idle. The `shell` value comes from strings in the CLI binary (constraints review B2), against the no-internals rule; it is `unverified` live. Any value other than `idle` makes a take-over wait, so the unknown value is safe.
- Whether the CLI deletes its pid file on exit is `unverified`. Liveness and start time are checked on every scan, so a leftover file never counts.

### Quirk: `procStart` is UTC

- Symptom: a plain `ps -o lstart=` differs from `procStart` by the zone offset (1 h here), so every terminal reads as a reused pid.
- Cause: the CLI writes the start time in UTC.
- Workaround: run `/bin/ps -o lstart= -p <pid>` with env `LC_ALL=C TZ=UTC`, and compare with runs of spaces squashed.
- Code: `macos.ts` `ps`, `procStart`, `sameStart`; `cli-terminals.ts` `verify`. Test: `cli-terminals.test.ts` "a dead pid or another start time", `macos.test.ts`. Source: confirmed live (take-over run); first found with `strings` on the CLI binary (round-1 constraints review B1).

### Quirk: SDK children write pid files too

- Symptom: Synopia's own sessions would show as terminals.
- Cause: a CLI started by the SDK writes a pid file with `kind: interactive`, `entrypoint: sdk-ts`, the same keys as a terminal's.
- Workaround: only `entrypoint: cli` counts, and pids under Synopia's own process are skipped.
- Code: `cli-terminals.ts` `files`, `verify` (`descendsFrom`). Test: `cli-terminals.test.ts` "only interactive cli processes count", "Synopia's own children".

### Quirk: inherited Claude Code variables suppress the file

- Symptom: a CLI started from a shell inside another Claude Code session is invisible to Synopia.
- Cause: a CLI started with `CLAUDE_CODE_SESSION_ID`, `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT` (or other `CLAUDE_CODE_*` variables) in its environment writes no pid file.
- Workaround: none in code. A normal terminal tab carries none of them. Scripted checks clear them with `env -u`.
- Code: none. Source: take-over live run.

### Timing

- The pid file appears 1 to 3 s after the CLI starts, before the first prompt.
- SIGTERM ends an idle interactive CLI in about 1 s; no SIGINT is needed.
- The folder is scanned every 2 s (`POLL_MS`) and on each change `fs.watch` reports; see [macOS](macOS.md#fswatch-merges-and-drops-events). One scan runs at a time.

## Two writers on one transcript

Nothing in the CLI stops two processes from writing one session's JSONL: their records interleave. Source: SDK spike, "Gotchas" (removed from the repo). Synopia guards itself: right before it starts a process on a session it reads that session's pid files again (`recheck`), and it yields a session a terminal takes. At `recheck` a live CLI not yet verified counts as holding the session; the next scan corrects that. A start then waits for `confirm`, which verifies every live pid of that session afresh (start time and ancestry from `ps` now), so a pid file left by a CLI that died, whose pid another process reuses, holds nothing; a `ps` that fails counts as holding. Messages sent meanwhile wait (`starting`); a terminal found there sends them back to the box. Code: `cli-terminals.ts` `recheck`, `confirm`; `session.ts` `start`. Test: `cli-terminals.test.ts` "recheck reads the files now", "confirm"; `session.test.ts` "the start check".

## Take-over

| Step | What Synopia does | Code |
|---|---|---|
| a terminal opens a session Synopia holds | yields at once: interrupt, end its process, show the session read-only (`terminal.took`), about 2 s after the CLI starts | `session.ts` `yieldTo`, `cli-terminals.ts` `scan` |
| the terminal's CLI exits | the session is Synopia's again (`terminal.gone`), no process started | `session.ts` `terminalChanged` |
| you send in Synopia on a terminal-held session | waits until the CLI's `status` is `idle`, then ends it | `session.ts` `runTakeover`, `cli-terminals.ts` `end` |
| before the signal | the pid's start time is read afresh: a pid that is no longer that CLI gets no signal (the take-over goes on); a `ps` that fails sends none and the message stays (`terminals.unverified`) | `cli-terminals.ts` `end` |
| ending the CLI | SIGTERM; SIGINT after 5 s (`SIGINT_MS`); gives up at 10 s (`EXIT_MS`); never SIGKILL | `cli-terminals.ts` `endTerminal` |
| the note | `Synopia took over this session at HH:MM. To continue here instead: claude --resume <sid>` written to the CLI's tty after it exited, so its last redraw doesn't cover it | `cli-terminals.ts` `takeoverNote`, `endTerminal` |
| resume | after the transcript is unchanged for 500 ms (`STABLE_MS`), at most 5 s | `cli-terminals.ts` `waitStable` |

### Quirk: tty names

- Symptom: none if handled; a wrong device would write the note elsewhere.
- Cause: `ps -o tty=` gives `ttysNNN` on macOS (`pts/N` elsewhere) and `??` when there is no terminal.
- Workaround: read the tty before sending the signal (after the exit `ps` has nothing), accept only `ttys?\d+` or `pts/\d+`, open `/dev/<tty>` with `O_WRONLY | O_NOCTTY | O_NONBLOCK`. No tty: log `terminals.noTty` once and skip the note.
- Code: `cli-terminals.ts` `ttyDevice`, `realEnd.write`; `macos.ts` `ttyOf`. Test: `cli-terminals.test.ts` "takeoverNote and ttyDevice", "no tty or a failed write".

## Permission mode at start

A folder's `permissions.defaultMode` (`.claude/settings.json`) is read when the CLI process starts. Changing it under a running process changes nothing until the next start. Source: live run M1-final.

## claude mcp login and logout

`mcp.ts` runs the CLI the SDK bundles (`sdk.ts` `bundledCli`: the `claude` of `@anthropic-ai/claude-agent-sdk-<platform>-<arch>`, the one session processes run) as `claude mcp login <name>` and `claude mcp logout <name>`, in the session's folder, as server config can be project-scoped. Its output stays in memory for the error sentence and is never logged.

From `--help` (CLI 2.1.330):
- `mcp login [--no-browser] <name>`: "Authenticate with an MCP server (HTTP, SSE, or claude.ai connector)". `--no-browser` "Print[s] the authorization URL instead of opening a browser … paste the redirect URL back when prompted".
- `mcp logout <name>`: "Clear stored OAuth credentials for an MCP server".
- `mcp list` and `mcp get <name>` health-check the servers they show; `.mcp.json` servers not yet approved show as "Pending approval".

Seen in live run MC-1 (2026-11-25):
- An unknown name: exit 1, nothing on stdout, one stderr line `No MCP server named "<name>". Run \`claude mcp add\` to add one.`, in about 0.12 s; the same for login and logout.
- `mcp add` under an enterprise policy that forbids it: exit 1, `Cannot add MCP server "<name>": not allowed by enterprise policy`.

Seen in live run MC-2 (2026-11-25, the same CLI; one script `check.mjs` in `/tmp/synopia-mcp-login/`, outside the repo; one of the user's HTTP servers, local scope, only to pass the TTY check; killed while it waited, no sign-in completed; output read for its shape only, URLs redacted):
- `mcp login` needs a TTY. With none (stdin `/dev/null`, stdout and stderr pipes) it prints `Starting authentication for "<name>"…`, then `Couldn't complete authentication for "<name>": this isn't an interactive terminal. Re-run in one — e.g. \`ssh -t\` — and paste the redirect URL when prompted.`, exit 1, in about 0.5 s. An unknown name fails before the TTY check, as in MC-1.
- Under a pseudo-terminal from macOS's `script(1)` (`script -q /dev/null <cli> mcp login <name>`, documented in `man script`) it is interactive: it prints `Starting authentication…`, `If the browser didn't open, visit:` with the authorization URL, `Waiting for authorization… (^C to cancel)` and `Or paste the redirect URL here:`, and keeps waiting (15 s in the check). So it opens the browser itself and takes the OAuth callback, and `--no-browser` (print and paste) isn't needed.
- `script` needs a stdin it can `tcgetattr`: a Node pipe is a socket and `script` exits 1 at once with `script: tcgetattr/ioctl: Operation not supported on socket`. With stdin `/dev/null` it runs; at that stdin's end it echoes `^D` to the pty, which the waiting CLI ignores.
- `script` exits with the child's code (`man script`: "The child command exit status is always the exit status of script"); seen: an unknown name gives 1 through it. SIGTERM to `script` ends the CLI too (no `mcp login` process left 1 s later).

Unverified: the exit code and output of a sign-in that completes, or that the browser flow refuses, since the check stopped before the browser step. Synopia counts exit 0 as signed in and shows the last line's first sentence on anything else.

What Synopia does: `mcp.ts` `cliRunner` runs `mcp login` under `/usr/bin/script -q /dev/null` with stdin `/dev/null` and `mcp logout` with no TTY, without `--no-browser`. The output stays in memory; the error sentence drops URLs, control characters and the echoed `^D`. It kills the run on Cancel or after 5 min (`LOGIN_TIMEOUT_MS`). Code: `mcp.ts` `cliRunner`, `sentence`. Test: `mcp.test.ts` (the injected runner gets `pty: true` for login only).

## A command in a pseudo-terminal

`pty.ts` runs a command that may need a terminal for its whole run, with a line typed into it now and then: the credential refresh (`creds.ts`, 2026-11-26) and `!` commands (`bang.ts`, 2026-11-26, `$SHELL -c` with TERM=dumb and PAGER=cat), such as a sign-in that prints a code, opens the browser and waits for Enter. No dependency: macOS's `script(1)` gives the pty, as for `claude mcp login` above.
- `script` takes no Node pipe as stdin (a socket, MC-2). `/bin/sh -c 'cat 3>&- 4>&- | { /usr/bin/script -q /dev/null /bin/sh -c "$0" "$1" "$2" "$3" "$4"; echo "end $?" >&3; }' <inner> <shell> <-c|-lc> <command> <0|1>` puts a real pipe between them. `cat` copies Node's pipe into it. `script` accepts it (tcgetattr there fails with ENOTTY, which it allows) and writes what comes to the pty. The child sees a TTY on stdin (`[ -t 0 ]`), and the pty's echo shows the typed line in the output.
- Inside the pty a small `/bin/sh` (2026-11-26) is the session leader, so its pid is the command's process group. It writes `pid N` to fd 3, runs `shell -c|-lc command` as its child with `&` and the terminal as stdin (a `&` list's stdin is `/dev/null` unless redirected, so the pty is saved on fd 6 first), and writes `exit N` to fd 3; script's own code follows as `end N`, then Node ends `cat`'s input. A kill goes to that group (one sent before `pid` arrives waits for it). The sh traps TERM with a handler, which the command doesn't inherit, and passes it on to its child, so a TERM reads as 143 even when it came while the command was being started (seen: with `exec` and no `&`, a TERM 5-50 ms after `pid` was lost and only the SIGKILL ended it). A SIGKILL takes the sh too: no `exit` line, and script's code is the signal's number (9), read as 137. With `onErr` the command's stderr goes to fd 4, a pipe, so stdin and stdout are TTYs and stderr is not. The sh's own stderr ("Terminated: 15") goes to /dev/null. A child left holding the pipes (`sleep 30 &`) holds the run 0.5 s at most after `end`.
- The pty's output has CRLF line ends and the program's escape sequences; `pty.ts` `plainText` is the one place that turns it into plain text with LF (creds.ts and bang.ts use it). Test: `bang.test.ts` ("runs in a terminal", "Esc, Esc ends a command that waits for Enter", "plainText").
- Checked 2026-11-26 with a made-up script that prints a code, reads a line and exits 3: the output, the typed line and the code came back in about 25 ms. A command that leaves a `sleep 30 &` still ended at once. Test: `creds.test.ts` ("pty: …").
- The output goes only to the page (16 KB at most, escape sequences and carriage returns dropped), never to `backend.log` or `state.json`. The command runs as `zsh -lc <command>` in the folder, so PATH and the AWS profile setup match a terminal. The page checks use `sh -lc`, which reads no profile of yours.

mcp.ts could use it for `claude mcp login`; it still runs with stdin `/dev/null`.

### Waits for input (live run IN-1, 2026-11-26)

Whether a command in the pty waits for you. No signal says so: Synopia reads only the pty's output. Seen in live run IN-1 (2026-11-26, macOS 26.6, Node 22.13; one scripted batch, `in1.ts` in `/tmp/synopia-in1/`, outside the repo, made-up commands and scripts only): 27 commands run at once under `pty.ts` `shellPty` as bang.ts runs them (`zsh -c`, TERM=dumb, PAGER=cat), each killed after 26 s, every output chunk timed. 11 wait for input: a `printf` prompt and `read`, a prompt line ending in a newline then `read`, `Continue? [y/N]`, `Username:` then a hidden `Password:`, an MFA prompt after 2 s of output, a Node readline question, Python `input()` and `getpass`, zsh `read "x?Your name: "`, `ssh-keygen`'s passphrase, `cat` with no prompt. 16 don't: `sleep 20`, Node and Python busy loops (20 s), `printf "Building… "` then 14 s of `sleep` and then 14 s of CPU, `\r` progress bars every 3 s and every 0.3 s, a test suite quiet 16 s in the middle, a Node timer of 18 s, `ping` every 3 s, `git log` (PAGER=cat), `git --no-pager log`, `git diff --stat`, `du`, a silent `find`, `curl` to an unroutable host (15 s).

- `ps` (`stat`, `wchan`) at 5 s: the same `S+` and `-` for a command blocked in `read` as for `sleep`, `curl` or a Node timer; `R+` only for one using the CPU. So the process state can't tell waiting from sleeping.
- "No output for N s while running": every wait was caught, N s after its last output, but most commands that don't wait were false positives: 14 of 16 at N = 1 s, 11 at 3 s, 10 at 5 s, 9 at 10 s, 6 at 15 s (silent builds, slow specs, timers, downloads, `sleep`). The storyboard's proposal (1 s with the last line open, or 10 s): 11 of 16. Adding "no CPU in the last second": still 8. Not reliable at any N.
- The prompt's shape: after 1 s with no output, the last line written ends open in `:`, `?` or `>` (with spaces after it), or names Enter, Return, any key or a yes/no choice (`(y/n)`, `[y/N]`). 0 of 16 false positives at 0.5, 1 and 2 s; it fired 0.6 to 2.1 s after the prompt. 2 of 11 missed: `cat` with no prompt (nothing says it waits), and Python's `input()`, which writes its prompt to stderr (a pipe under `onErr`) while the batch joined both streams in arrival order; reading the stream written last finds it (`bang.test.ts` pins that case).
- What Synopia does (`pty.ts` `InputWatch`, `looksLikePrompt`): a run waits for input after `PROMPT_QUIET_MS` (1 s) with no output and a prompt-shaped last line on the stream written last; output clears it. That is needs you (R8.2). A run quiet for `QUIET_HINT_MS` (10 s) without such a line only may wait: the row and the shell view say "may wait for input", nothing else changes. bang.ts and creds.ts use it. Test: `bang.test.ts` ("waits for input: …").
- Known misses: a prompt with none of those shapes, and a silent command whose last line happens to end in `:` with no newline (a log line such as `Fetching:` before a quiet download) reads as waiting until its next output.

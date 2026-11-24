# macOS

Facts about macOS itself that Synopia's daemon, shell and tools depend on. AppKit and WKWebView are in [WKWebView and AppKit](WKWebView%20and%20AppKit.md); `ps` start strings for the daemon are in [Daemon files](Daemon%20files.md#quirk-process-start-strings). Sources: code, tests, and live runs recorded in `.ai-notes/app/README.md`.

## PATH for apps and daemons

### Quirk: Finder-launched apps lack the shell's PATH

- Symptom: the app can't find `node` (asdf); a daemon started from the Dock can't find `gh`, `brew`, asdf shims or `bat`.
- Cause: GUI launches get launchd's short PATH, not the login shell's.
- Workaround, shell: `app/build.sh` bakes the absolute node path into the bundle's `config.json`. Rebuild after a Node upgrade. Code: `build.sh` 3, 9, 32; `Backend.swift` `BackendConfig` (16-26).
- Workaround, daemon: at start (not under `--sdk-script`, not in a successor) `login-env.ts` runs `$SHELL -l -i -c 'printf <marker>\0; /usr/bin/env -0'` with a 5 s limit (process group killed on timeout) and merges an allow-list into `process.env`: `PATH`, `MANPATH`, `ASDF_DIR`, `ASDF_DATA_DIR`, `HOMEBREW_PREFIX`, `HOMEBREW_CELLAR`, `HOMEBREW_REPOSITORY`, `LANG`, `LC_*`, `SSH_AUTH_SOCK`, `GOPATH`, `JAVA_HOME`, `PYENV_ROOT`, `NVM_DIR`. Login PATH first, then current folders it lacks. When the shell fails: `/opt/homebrew/bin`, `/usr/local/bin`, the asdf shims and node's own folder are prepended. It sets `SYNOPIA_LOGIN_ENV=1` so a successor doesn't ask again. Logged as `env.login how=login|fallback vars=N`, never values. Code: `login-env.ts`; `main.ts` (the `loadLoginEnv` call). Live: a daemon started with `env -i` and launchd's PATH captured it in about 0.2 s.
- Workaround, preview: `findBat` searches PATH, then `/opt/homebrew/bin` and `/usr/local/bin`. Code: `preview.ts` `findBat` (196-207).

### Quirk: login shell noise

- Symptom: the first variables parsed are garbage.
- Cause: an interactive login shell (`-l -i`) can print anything before the command runs (motd, prompts, rc output).
- Workaround: print a marker plus NUL first and parse `env -0` output only after it.
- Code: `login-env.ts` `MARK`, `parseEnv0` (23-38). Test: `login-env.test.ts`.

## Environment for a GUI app

A test can pass variables to an app it launches only through `open --env NAME=value <app>` (`SYNOPIA_STATE_DIR`, `SYNOPIA_SNAPSHOT`). Source: app/README.md 30-33. Page checks never launch the app; see [Page checks](Page%20checks.md).

## `ps`

Every `ps` call is `/bin/ps -o <field>= -p <pid>` with env `LC_ALL=C TZ=UTC`, run async with a 2 s timeout, so it never blocks the event loop. Code: `macos.ts` `ps`. Test: `macos.test.ts`.

| Outcome | `ps` does | `macos.ts` gives |
|---|---|---|
| the process exists | exit 0, the field on stdout | the text, trimmed |
| no such process | exit 1, nothing on stdout | `''` (`parentOf`: 0) |
| timeout, spawn error, any other exit | killed, or no output | `null`: unknown, ask again later |

- `ps -o tty=` gives `ttysNNN`, `??` when the process has no terminal. Code: `macos.ts` `ttyOf`; `cli-terminals.ts` `ttyDevice`. Test: `cli-terminals.test.ts` "takeoverNote and ttyDevice".
- `ps -o lstart=` depends on locale and zone and pads single-digit days (`Wed Nov  4 …`); run it with `LC_ALL=C TZ=UTC`. `procStart` keeps the text as printed; `sameStart` compares two with runs of spaces squashed. See [Daemon files](Daemon%20files.md#quirk-process-start-strings). Test: `macos.test.ts` "a single-digit day padded".
- Liveness is `kill(pid, 0)`: alive when it succeeds or fails with `EPERM` (another user's process). Code: `macos.ts` `alive`.
- A child spawned `detached` leads its own process group; `signalGroup` signals the whole group (`kill(-pid)`), so grandchildren end too. Code: `macos.ts` `signalGroup`; users `bang.ts`, `login-env.ts`.

## Real paths

- Symptom: a folder under `/tmp` shows as `/private/tmp/…`; a home folder reached through a link shows its target.
- Cause: on macOS `/tmp` is a link to `/private/tmp`, and the CLI and `listSessions()` give real paths.
- Workaround: `paths.ts` maps the real path of `/tmp` back to `/tmp` and the real path of home back to home, then home to `~`. Inside a text it maps only where a path starts (the start, or after a space, quote, bracket or shell operator), so `https://host/Users/x` and `/mnt/private/tmp` stay. Other links (a project folder reached through a symlink) show their real path.
- Code: `paths.ts` `rules`, `displayPath`, `displayIn`. Test: `paths.test.ts`.

## fs.watch merges and drops events

- Symptom: an appended line or a new subagent file is missed.
- Cause: on macOS `fs.watch` (FSEvents) can merge or drop events, and it arms asynchronously, so a change right after `watch()` can be lost.
- Workaround: every watcher has a poll beside it (tailer, subagent watcher, pid-file scan every 2 s).
- Code: `tail.ts` 1-3; `cli-terminals.ts` `watchDir`, `POLL_MS`. Test: `tail.test.ts` 110-112.

## Opening files: `/usr/bin/open`

- Files and URLs open through `execFile('/usr/bin/open', …)`, never a shell. Paths must be absolute and exist; URLs must be http or https.
- An allow-list of extensions (`OPEN_EXT`: documents, media, source code), on a regular file without an execute bit, checked by its own name and its real path's, opens with the default app. Everything else, folders and bundles too, is revealed with `open -R`.
- Why an allow-list: `.py` opens in the Python Launcher, which runs it; `.fileloc`, `.jar`, `.webloc`, `.mobileconfig` and `.prefPane` can run or install something. Shell and AppleScript files and names without an extension are left out too.
- Code: `open.ts` 1-20. Test: `open.test.ts` 42-62.

## bat

- Called as `bat --no-config --color=always --theme=<theme> --style=plain --paging=never --wrap=never [--line-range=:5000] --file-name=<base> -` with the text on stdin; languages from `bat --no-config --list-languages --color=never` once at start. Code: `preview.ts` `batArgs`, `loadBat` (227, 239-242). Test: `preview.test.ts` 124-135.
- `COLORTERM=truecolor` always, so the output is 24-bit whatever the daemon's environment. Code: `preview.ts` `batEnv` (185-187).

### Quirk: no GitHub Dark theme

- Symptom: the dark preview would not match the GitHub-like palette.
- Cause: bat ships `GitHub` but no GitHub Dark (`bat --list-themes`).
- Workaround: `Coldark-Dark` for the dark theme: GitHub Dark's blues and purples, and the only bundled theme whose every colour keeps about 4.3:1 contrast on the dark panel.
- Code: `preview.ts` `BAT_THEME` (92-94).

## File modes

`writeFileSync`'s `mode` is masked by the umask, so files that must be 0600 get an explicit `chmodSync`. See [Daemon files](Daemon%20files.md#state-folder).

## File locks

- `open(2)` on macOS takes `O_EXLOCK` (an exclusive `flock` taken atomically with the open) and `O_NONBLOCK` (fail with `EAGAIN` instead of waiting while another open file holds it). The lock belongs to the open file description and goes when the last descriptor closes, so a process that ends, by SIGKILL too, holds nothing. Source: `man 2 open`, `man 2 flock`.
- Node's `fs.constants` lists `O_NONBLOCK` (4) but not `O_EXLOCK`; Node passes a numeric flags value to `open(2)` as given (Node docs, File system flags), so `O_EXLOCK` is the header value `0x20` (`<sys/fcntl.h>`). Checked once on this machine: eight processes opening one file at the same moment, one got it, seven `EAGAIN`; it was free again after the holder's SIGKILL.
- Two opens in one process conflict too: the lock is per open, not per process.
- Code: `daemon-files.ts` `acquireLock`, `O_EXLOCK`. Test: `daemon-files.test.ts`.

## Jamf Protect

A locally `swiftc`-built app, with only the linker's ad-hoc signature, launched under Jamf Protect without being blocked (one author run, 2026-11-23, `spike/native-shell` at tag `rearch-base`). `unverified` beyond that run: there is no codesign step in `build.sh`, and nothing is downloaded at build time that Jamf could block.

## Platform floor

`Info.plist` sets `LSMinimumSystemVersion` 26. The real minimum macOS is `unverified`; see [WKWebView and AppKit](WKWebView%20and%20AppKit.md#webkit-features-used). Node 22.13+ (`--experimental-strip-types`, no build step) and Swift from the command line tools.

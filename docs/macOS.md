# macOS

Facts about macOS itself that Synopia's daemon, shell and tools depend on. AppKit and WKWebView are in [WKWebView and AppKit](WKWebView%20and%20AppKit.md); `ps` start strings for the daemon are in [Daemon files](Daemon%20files.md#quirk-process-start-strings). Sources: code, tests, and live runs recorded in `.ai-notes/app/README.md`.

## PATH for apps and daemons

### Quirk: Finder-launched apps lack the shell's PATH

- Symptom: the app can't find `node` (asdf); a daemon started from the Dock can't find `gh`, `brew`, asdf shims or `bat`.
- Cause: GUI launches get launchd's short PATH, not the login shell's.
- Workaround, shell: `app/build.sh` bakes the absolute node path into the bundle's `config.json`. Rebuild after a Node upgrade. Code: `build.sh` 3, 9, 32; `Backend.swift` `BackendConfig` (16-26).
- Workaround, daemon: at start (not under `--fake`, not in a successor) `login-env.ts` runs `$SHELL -l -i -c 'printf <marker>\0; /usr/bin/env -0'` with a 5 s limit (process group killed on timeout) and merges an allow-list into `process.env`: `PATH`, `MANPATH`, `ASDF_DIR`, `ASDF_DATA_DIR`, `HOMEBREW_PREFIX`, `HOMEBREW_CELLAR`, `HOMEBREW_REPOSITORY`, `LANG`, `LC_*`, `SSH_AUTH_SOCK`, `GOPATH`, `JAVA_HOME`, `PYENV_ROOT`, `NVM_DIR`. Login PATH first, then current folders it lacks. When the shell fails: `/opt/homebrew/bin`, `/usr/local/bin`, the asdf shims and node's own folder are prepended. It sets `SYNOPIA_LOGIN_ENV=1` so a successor doesn't ask again. Logged as `env.login how=login|fallback vars=N`, never values. Code: `login-env.ts`; `main.ts` 98-101. Live: a daemon started with `env -i` and launchd's PATH captured it in about 0.2 s.
- Workaround, preview: `findBat` searches PATH, then `/opt/homebrew/bin` and `/usr/local/bin`. Code: `preview.ts` `findBat` (196-207).

### Quirk: login shell noise

- Symptom: the first variables parsed are garbage.
- Cause: an interactive login shell (`-l -i`) can print anything before the command runs (motd, prompts, rc output).
- Workaround: print a marker plus NUL first and parse `env -0` output only after it.
- Code: `login-env.ts` `MARK`, `parseEnv0` (23-38). Test: `login-env.test.ts`.

## Environment for a GUI app

A test can pass variables to an app it launches only through `open --env NAME=value <app>` (`SYNOPIA_STATE_DIR`, `SYNOPIA_SNAPSHOT`). Source: app/README.md 30-33. Page checks never launch the app; see [Page checks](Page%20checks.md).

## `ps`

- `ps -o tty=` gives `ttysNNN`, `??` when the process has no terminal. Code: `registry.ts` `ttyDevice` (273-276). Test: `registry.test.ts` 151, 181.
- `ps -o lstart=` depends on locale and zone and pads single-digit days; run it with `LC_ALL=C TZ=UTC`. See [Daemon files](Daemon%20files.md#quirk-process-start-strings).
- `execFileSync('/bin/ps')` blocks the event loop up to its 2 s timeout per call. Code: `registry.ts` `ps` (35-43), `daemon.ts` `procStart`.

## Real paths

- Symptom: a folder under `/tmp` shows as `/private/tmp/…`; a home folder reached through a link shows its target.
- Cause: on macOS `/tmp` is a link to `/private/tmp`, and the CLI and `listSessions()` give real paths.
- Workaround: `paths.ts` maps the real path of `/tmp` back to `/tmp` and the real path of home back to home, then home to `~`. Other links (a project folder reached through a symlink) show their real path.
- Code: `paths.ts` 1-25. Test: `paths.test.ts`.

## fs.watch merges and drops events

- Symptom: an appended line or a new subagent file is missed.
- Cause: on macOS `fs.watch` (FSEvents) can merge or drop events, and it arms asynchronously, so a change right after `watch()` can be lost.
- Workaround: every watcher has a poll beside it (tailer, subagent watcher, pid-file registry every 2 s).
- Code: `tail.ts` 1-3; `registry.ts` `watchDir`, `POLL_MS`. Test: `tail.test.ts` 110-112.

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

## Jamf Protect

A locally `swiftc`-built app, with only the linker's ad-hoc signature, launched under Jamf Protect without being blocked (one author run, 2026-11-23, `spike/native-shell` at tag `rearch-base`). `unverified` beyond that run: there is no codesign step in `build.sh`, and nothing is downloaded at build time that Jamf could block.

## Platform floor

`Info.plist` sets `LSMinimumSystemVersion` 26. The real minimum macOS is `unverified`; see [WKWebView and AppKit](WKWebView%20and%20AppKit.md#webkit-features-used). Node 22.13+ (`--experimental-strip-types`, no build step) and Swift from the command line tools.

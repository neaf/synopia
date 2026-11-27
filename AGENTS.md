# Working on Synopia

Read first:
- `docs/requirements.md`: the source of truth for behaviour (R-numbers). `prototype/app.html` is the source of truth for the look: match it, don't redesign it.
- `docs/functional-requirements.md`: the same behaviour as FR ids, the decisions (Q1-Q11) and the known gaps.
- `docs/architecture.md`: modules, data flow, protocol, state ownership. Keep one owner per piece of state.
- The topic doc of the external system you touch: `docs/Claude Code transcripts.md`, `docs/Claude Code terminals.md`, `docs/Agent SDK.md`, `docs/Daemon files.md`, `docs/macOS.md`, `docs/WKWebView and AppKit.md`.
- `docs/Page checks.md` before you write or change a page check.

Commands (Node 22.13+ on PATH; `(cd app/backend && npm ci)` once):
- `app/check.sh --page`: must print four pass lines before any change is done. `app/check.sh` alone skips the page checks.
- While you work, run `app/check.sh` and only the page suites your change touches (`app/web/dev/cdp/run.sh <suite>`). Run the full `--page` once, before the merge; after a rebase, again only when the incoming commits touch the files you changed.
- `app/web/dev/cdp/run.sh <suite>`: one page check. `app/build.sh`: the app. `app/dev.sh [--script]`: the backend for a browser.

Rules for every change:
- Page checks run on chrome-headless-shell only. Never launch Google Chrome.app, Chrome for Testing or `build/Synopia.app` from a check, and use no macOS permissions (osascript, UI scripting, screencapture). Kill any browser you start.
- Each undocumented format or flag (transcript JSONL, pid files, the state-events flag, `daemon.json`) lives in one module, with its quirks in that module's topic doc and a test that pins it. A workaround is deleted only after its fact is in the topic doc.
- The Agent SDK and the Claude Code CLI are used through their documented surface only (docs, typings, `--help`). Don't read minified or binary internals; settle what the docs leave open with one scripted check and record the shape, never values.
- The page stays plain ES modules with no build step, no import cycles, and no `window` writes outside `test-api.js`. Page checks act through `window.__synopia` and the DOM.
- Visual rules that are easy to break: running things always move (linear, infinite, no pulse or fade on a running mark; other motion such as layout tweens is fine); one way to do each thing; light theme with a dark sidebar by default, and a dark mode (`css/dark.css`) where the sidebar stays the darkest surface; 1px lines; no ALL CAPS; shape carries meaning, not only colour.

Privacy:
- Never commit `prototype/transcripts.js`, `spike/logs/` or anything from `~/.claude/sessions/` or `~/.claude/projects/`: they are real work transcripts. Fixtures and examples hold invented data only. Never read `~/.claude/sessions/*.key`.
- Don't resume, fork or message a session that a live Claude Code process has open (check `~/.claude/sessions/<pid>.json`).

Use the `frontend-design` skill for UI work, and keep handover notes in `.ai-notes/`.

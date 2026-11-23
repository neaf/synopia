# Synopia app: handover for the technical plan

Written 2026-11-23 at the end of the prototyping session.

## Where things are

- `docs/requirements.md`: what to build. Every decision from the prototyping session, plus what was rejected.
- `prototype/app.html`: the UI reference. Run `python3 -I export_transcripts.py` first, then open it in Chrome. `?demo=ask6#d0d0d0d0` and similar show the "needs you" cards.
- `spike/FINDINGS.md`: what the Claude Agent SDK can do, checked with real runs (resume, fork, images, `canUseTool`, AskUserQuestion, skills, subagent events, interrupt, status). Its gotchas section matters for the design.
- `export_transcripts.py`: how to read sessions, subagents, patches, questions and background work from Claude Code's files today. Useful as a reference parser.

## The next step

Write the technical plan in a fresh session. **Milestone 1 = what the prototype already does, running for real in the native app**:
- Live open sessions, without the export loop.
- Transcripts, subagents and background work.
- Files and diffs.
- The needs-you cards, answering for real through the SDK.
- Keys and modes.
- Drag-and-drop groups.

No badges or notifications yet. Inputs: `docs/requirements.md`, `spike/FINDINGS.md`, and `prototype/app.html` for the look. Open points it needs to settle:

1. **Shell. Decided starting point (2026-11-23):** a small native Swift shell (AppKit window, menus, shortcuts) hosting the prototype's web UI in WKWebView, plus a Node backend that runs the Agent SDK.
   - A locally built Swift app launched fine on this machine under Jamf Protect (experiment A, `swiftc`, nothing downloaded). Chrome's `--app` window works too, as a fallback.
   - Electron is out for now: it needs a ~150 MB downloaded runtime that Jamf may block, and adds a second browser engine.
   - Fully native SwiftUI is out: there's no Swift Agent SDK, and the custom UI would be a rewrite.
   - The shell talks to the page through WKScriptMessageHandler / evaluateJavaScript. Native extras (Dock badge, notifications) come later; when they do, the shell should read state from the backend, not the page.
2. **Session ownership.**
   - Adopting a live CLI session needs that process closed first, since there's one writer per session.
   - How Synopia finds open sessions: `~/.claude/sessions` and its own SDK sessions.
   - What the "closed" state means and where it's stored.
3. **Status.**
   - Live state comes from SDK events (undocumented env flag) for Synopia's own sessions, and from the session files for others.
   - "Needs you" is derived from the pending step, not only from the status.
4. **Claude-written content.** Titles, the "Now" line, drift detection, the closing note and grouping suggestions: which model, when they're regenerated, the cost.
5. **Persistence.** The user's layout (groups, order), "reviewed" marks, notes, and per-session model choice.
6. **Answering.** Questions, permissions and plans through `canUseTool`, including notes (`annotations.notes`), "always allow" rules, and `permissionMode: 'default'` despite the user's `auto` setting.
7. **Rendering.** The CLI-like transcript from SDK messages, not from re-reading JSONL, and the diffs from `structuredPatch`.

The user's global rules (from `~/dev/agent-harness`) apply:
- Delegate self-contained work to background subagents and name the fitting skill.
- Mark deliverables for review with `For review:`.

## Technical plan (2026-11-23)

- Draft for review: `docs/technical-plan.md`. Decisions, digests and critic reviews: `.attack-plan/synopia-m1/` (ledger.md holds the author's answers Q1-Q11).
- Big changes from this handover: Synopia is unaware of the terminal (no pid files, no take-over); transcripts come from JSONL tailing for every session; sessions keep the user's `auto` mode; SDK and CLI used through their documented surface only.

## Build status

- S1-1 (branch `s1-1`): `app/backend` with pinned `@anthropic-ai/claude-agent-sdk` 0.3.330 and `ws` 8.23.0; `npm ci` installs cleanly on this machine and brings the `claude-agent-sdk-darwin-arm64` package with its `claude` binary (about 364 MB). `main.ts`, `server.ts` (Host/Origin at the upgrade, auth frame, 32 MB maxPayload, `hello`, `/api/quit-check`), `lock.ts` (pid file, stale lock taken over), `log.ts`, `store.ts` (defaults, debounced atomic write, `reconcileLayout`), placeholder `app/web/index.html`, `app/dev.sh`, `app/check.sh`. `hello` carries `menu: {}` until `menu.ts`; `sessions` and `pending` are empty. Close code 4001 means a failed auth.

# Synopia app: handover for the technical plan

Written 2026-11-23 at the end of the prototyping session.

## Where things are

- `docs/requirements.md`: what to build. Every decision from the prototyping session, plus what was rejected.
- `prototype/app.html`: the UI reference. Run `python3 -I export_transcripts.py` first, then open it in Chrome. `?demo=ask6#d0d0d0d0` and similar show the "needs you" cards.
- `spike/FINDINGS.md`: what the Claude Agent SDK can do, checked with real runs (resume, fork, images, `canUseTool`, AskUserQuestion, skills, subagent events, interrupt, status). Its gotchas section matters for the design.
- `export_transcripts.py`: how to read sessions, subagents, patches, questions and background work from Claude Code's files today. Useful as a reference parser.

## The next step

Write the technical plan in a fresh session. Inputs: `docs/requirements.md`, `spike/FINDINGS.md`, and `prototype/app.html` for the look. Open points it needs to settle:

1. **Shell.** Electron was the working assumption: the Agent SDK is Node and spawns its own Claude Code process. Tauri would need a Node sidecar. The app must run in its own window (R2.1).
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

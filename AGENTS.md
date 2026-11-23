# Working on Synopia

- Read `docs/requirements.md` first. It is the source of truth for behaviour. `prototype/app.html` is the source of truth for the look: match it, don't redesign it.
- Visual rules that are easy to break: running things always move (linear, infinite, no pulse or fade on a running mark; other motion such as layout tweens is fine); one way to do each thing; light theme with a dark sidebar; 1px lines; no ALL CAPS; shape carries meaning, not only colour.
- Never commit `prototype/transcripts.js`, `spike/logs/` or anything from `~/.claude/sessions/` or `~/.claude/projects/`: they are real work transcripts. Never read `~/.claude/sessions/*.key`.
- Don't resume, fork or message a session that a live Claude Code process has open (check `~/.claude/sessions/<pid>.json`).
- Use the `frontend-design` skill for UI work, and keep handover notes in `.ai-notes/`.

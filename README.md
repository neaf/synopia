# Synopia

A desktop app for running several Claude Code sessions side by side: one window that shows every open session, says which one needs you, and lets you chat in any of them.

Status: requirements and a polished UI prototype. The real app comes next.

| Path | What it is |
|---|---|
| `docs/requirements.md` | What the app must do and look like, with the choices that were rejected |
| `prototype/app.html` | The UI reference, rendered from your real open sessions |
| `prototype/*-storyboard.html` | Design storyboards for status marks, kind marks and the "needs you" card |
| `prototype/icon/` | App icon and favicon (option B, "Paper") |
| `export_transcripts.py` | Exports the open sessions into `prototype/transcripts.js` for the prototype |
| `group_sessions.py` | Experiment: groups sessions by shared references |
| `spike/` | Agent SDK spike; results in `spike/FINDINGS.md` |
| `.ai-notes/` | Handover notes between sessions |

## Viewing the prototype

The prototype reads `prototype/transcripts.js`, which isn't committed because it holds real session transcripts. Generate it, then open the page:

```sh
python3 -I export_transcripts.py
open -a "Google Chrome" prototype/app.html
```

Test states for the "needs you" card: add `?demo=ask`, `ask6`, `multi`, `permission` or `plan` before the `#<session-id>`, for example `prototype/app.html?demo=ask6#d0d0d0d0`.

## Before publishing

The storyboards embed screenshots and text from real work sessions (PR numbers, ticket names). Scrub them before pushing this repository anywhere public.

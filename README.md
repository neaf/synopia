# Synopia

A desktop app for running several Claude Code sessions side by side: one window that shows every open session, says which one needs you, and lets you chat in any of them.

Status: requirements and a polished UI prototype. The real app comes next.

| Path | What it is |
|---|---|
| `docs/requirements.md` | What the app must do and look like, with the choices that were rejected |
| `prototype/app.html` | The UI reference |
| `prototype/*-storyboard.html` | Design storyboards for status marks, kind marks and the "needs you" card (design history; `docs/requirements.md` wins) |
| `app/web/icon/` | App icon and favicon (option B, "Paper"); the build and the prototype read it |
| `.ai-notes/` | Handover notes between sessions |

## Viewing the prototype

The prototype reads `transcripts.js` and `menu.js` beside it. `app/web/dev/compare.sh` builds both from the invented test fixtures into a copy of the page, then screenshots it:

```sh
app/web/dev/compare.sh
open /tmp/synopia-compare/proto/prototype/app.html
```

Test states for the "needs you" card: add `?demo=ask`, `ask6`, `multi`, `permission` or `plan` before the `#<session-id>`, for example `app.html?demo=ask6#22222222`.

## Before publishing

The tree holds invented data only. Commits up to tag `rearch-base` hold real work data (PR numbers, ticket ids, branch names, a session screenshot): scrub the history before pushing this repository anywhere.

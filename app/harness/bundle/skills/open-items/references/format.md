# The ledger format, version 1

`.ai-notes/<area>/open-items.md` is markdown a person reads at a glance, with fixed line shapes so code reads it with no model: `scripts/ledger.py` here, and Synopia's reader. `ledger.py check` says whether a file fits. The tests pin this page's example.

## The example

```markdown
# Open items: checkout-m2

<!-- open-items v1. Kept by AI: the open-items skill, and Synopia when it runs the session. Don't edit by hand; say it in the session instead. -->

## Waiting on you

- [ ] Y1 · decision · Run `bin/schema-lint --fix` now, or look at the 14 warnings first?
  - options: Run it | Look first
  - recommended: Look first
  - from: Claude, "Ship checkout M2", 2026-11-26 14:02, "Should I run `bin/schema-lint --fix`"
- [ ] Y2 · your task · Answer the 2 review threads from Mira on #812.
  - from: Claude, "Ship checkout M2", 2026-11-26 14:02
- [ ] Y4 · default · Mark #812 to #815 ready in this order: #812, #814, #813, #815.
  - goes ahead: when CI is green on all four, unless you object
  - from: Claude, "Ship checkout M2", 2026-11-26 14:02
- [ ] Y5 · decision · Can I remove the worktrees ~/dev/shop-wt-cart and ~/dev/shop-wt-tax?
  - options: Remove both | Keep them
  - from: Synopia, "Ship checkout M2", 2026-11-26 14:02, "Can I remove these two worktrees"

## Claude will check

- [ ] A1 · follow-up · Re-check #820, which GitHub shows as conflicting.
  - trigger: after the M2 stack merges
  - watch: feedback-watch pr 812 813 814 815
  - from: Claude, "Ship checkout M2", 2026-11-26 14:02

## Closed

- [x] Y3 · answered 2026-11-26 14:05 · "Run it" · done: 14 entries added to the todo file
- [-] Y6 · dropped 2026-11-26 15:10 · #818 was closed
- [>] Y7 · superseded by Y5 · 2026-11-26 15:12
```

## The rules

| Part | Shape |
|---|---|
| Title | `# Open items: <area>`, the first line |
| Version | `<!-- open-items v1. ... -->` under the title |
| Sections | `## Waiting on you`, `## Claude will check`, `## Closed`, each once, in this order, even when empty |
| Open item | `- [ ] <id> · <kind> · <text>`, the separator a space, a middle dot (U+00B7) and a space. The text never wraps onto a second line. |
| Ids | `Y<n>` under Waiting on you, `A<n>` under Claude will check. Numbers count up per ledger and are never reused: `ledger.py next` gives the next one. |
| Kinds | `Y`: `decision`, `your task`, `default`, `review`. `A`: `follow-up`. |
| Fields | `  - <key>: <value>` under an open item, in this order when present: `state`, `options`, `recommended`, `trigger`, `goes ahead`, `watch`, `subagent`, `raised by`, `answer`, `from`. `from` is required. |
| `state` | `answered`, `due` or `later`; no field means plain open |
| `options` | the set answers, split by ` \| ` |
| `subagent` | the subagent working on the item, or, for a review, the one whose result waits |
| `raised by` | the subagent whose report asked it |
| `answer` | your answer, quoted, while the state is `answered` |
| `from` | who recorded it (Claude, Synopia, you), the session's title in quotes, `YYYY-MM-DD HH:MM`, then the quote it came from when there is one |
| Closed, done | `- [x] <id> · answered\|done\|went ahead <YYYY-MM-DD HH:MM> · ...`: the answer in quotes, then what was done |
| Closed, dropped | `- [-] <id> · dropped <YYYY-MM-DD HH:MM> · <why>` |
| Closed, superseded | `- [>] <id> · superseded by <id> · <YYYY-MM-DD HH:MM>` |
| Closed lines kept | the newest 30, and the line of the highest id of each prefix; `ledger.py prune` drops the rest |

A line that fits no shape is a problem `ledger.py check` names; it is never guessed from. A tool that reads the ledger shows such a line as it is.

## Items tied to subagents

```markdown
- [ ] Y7 · decision · The 2027 reduced rate is 12% on main and 15% in the #820 fixture: which is right?
  - options: 12% | 15%
  - raised by: Rebase #820 on main
  - from: Claude, "Ship checkout M2", 2026-11-26 16:52, "which 2027 reduced rate is right"
- [ ] Y8 · review · Review: Receipt email copy
  - subagent: Receipt email copy
  - from: Claude, "Ship checkout M2", 2026-11-26 16:58
```

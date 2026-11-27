# Work folder formats

```
.attack-plan/<slug>/
  STATE.md                 stage, inputs, constraints, scope, SHA, page URLs, models, next step
  gates.json               one gate per section, written only by scripts/gate.py
  ledger.md                facts, gaps, contradictions, questions and answers
  sources/<family>.md      one digest per source family
  draft/attack-plan.md
  draft/technical-solution.md
  draft/evidence.md
  draft/design-proposal.md the Designer's proposed steps, input to the overview
  draft/alternatives.md    ruled-out designs with why; internal, never published
  audit/claims.md          numbered claims, audit/claims-<topic>.md verdicts
  audit/scope.md           scope items, audit/scope-verdicts.md
  audit/plan-walk.md       the Plan walker's findings
  audit/outside-<team>.md  each Outside reviewer's findings
  audit/cold-read.md       the Cold reader's answers
```

Shared rules for the resume file and private state: [harness-common state.md](../../harness-common/references/state.md).

## STATE.md

```markdown
# <Project> attack plan

Need: <one line>
Stage: 4 (technical solution), breaker round 2
Pinned SHA: <sha> (origin/<default branch>, <date>)
Pages: attack plan <url>, technical solution <url>, evidence <url>

## Inputs
- Product doc: <url>
- Designs: <paths>
- Earlier attack plans or explorations: <urls>
- PRs of this project: <numbers>; reference PRs: <numbers>

## Hard constraints
- <constraint>, from <who>, <date>

## Scope
<five lines: who, what changes for them, what is in, what is out, what it depends on>

## Models for this run

Confirmed by the user on <date> in <tool>.

| Tier | Model |
|---|---|
| fast | `<value>` |
| strong | `<value>` |

## Next
Stage 4, section step-2, loop step 4: ask question 3 of 5.
```

Gate status lives in `gates.json`, not in STATE: run `/usr/bin/python3 -I <skill>/scripts/gate.py status <work folder>`. Never edit `gates.json` by hand. A gate opened without a file and heading has no hash, so no drift check covers it: its approval stands until it is reopened. A `gates.json` from an older `gate.py` (one `file` and `heading` per gate, no `version`) still loads; the next command that writes it moves it to the current format and keeps every approval.

## Section ids

`intake`, `scope`, then `glossary`, `product-rules`, `page-<name>`, `out-of-scope`, `delivery`, `open-questions`, then `ready-for-review`, then `overview`, `step-<n>`, `data-and-rollout`, `verification`, then `milestones`, `tasks-m<n>`, then `audit`, `publish`. Each `--heading` is the section's heading text as written in the draft, without the `#` marks. A section that lives in two places gets one `--file`, `--heading` pair per place: `tasks-m<n>` takes `--file draft/technical-solution.md --heading "M<n> task detail" --file draft/attack-plan.md --heading "M<n> tasks"`.

## ledger.md

```markdown
## Facts
- F12 · DESIGN · The week widget shows at most 3 tasks, most urgent due date first · sources/design-1.md · 2026-11-20

## Questions
- Q3 · product · open · Count overdue tasks from earlier weeks? · default: yes, shown as a red count
- Q4 · engineering · answered · Reuse the tasks index query? · yes, author in chat 2026-11-20
```

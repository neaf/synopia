# .rearch/ file formats

All files are Markdown, committed on the `rearch/<date>` branch. They meet the resume-file minimum in [harness-common state.md](../../harness-common/references/state.md).

```
.rearch/
  STATE.md           current stage, phase, progress, decisions, next prompt
  baseline.md        commands, results, manual checks, models for this run
  inventory.md       every file -> kind, lines, aspects
  audit/<aspect>.md  one report per aspect, plus seams.md and final-<module>.md
  requirements.md    consolidated functional requirements
  architecture.md    target design
  docs-plan.md       target docs and fate of every current doc
  phases.md          ordered phase plan
  deviations.md      plan changes and "not verified" items found during execution
```

## STATE.md

````markdown
# Rearchitect state

Project: <one line>
Branch: rearch/2026-10-29
Base tag: rearch-base (<hash>)
Stage: 5 (phase execution)
Phase: 3 of 9 (storage layer), in flight

## Progress
- Audits: api, storage, ui done; build-and-tooling pending
- Phase in flight: 3 (storage layer), base 1a2b3c4, attempt 1

## Done
- Stage 0 setup, <hash>
- Phase 2 test harness, <hash>

## Decisions
- 2026-10-29: drop the CSV export experiment (FR candidate EXP-07), user call.

## Next prompt
```
Use the rearchitect skill. Continue from .rearch/STATE.md.
Next: Phase 3 (storage layer).
```
````

- Progress holds only work in flight: the aspects of Stage 2 not yet audited, or the phase running with the commit it started from. Write `none` when nothing is in flight.
- STATE changes land in the commit of the stage or phase they record.

## baseline.md

Sections:

- Build, Tests, Lint: one table each, `| Check | Command | Result |`. Commands run from the repo root and leave no untracked files.
- Manual checks: the count the user chose. `none` for zero, else `M1..Mn`, one line each with what to look for.
- `Models for this run`: the table from [harness-common state.md](../../harness-common/references/state.md) "Models for this run". The first backticked value in the Model cell is the exact value the tool takes, so `opencode.py apply-tiers --state .rearch/baseline.md` can read it. An Agents column is allowed:

```markdown
## Models for this run

Confirmed by the user on 2026-10-29 in opencode.

| Tier | Agents | Model |
|---|---|---|
| fast | rearch-auditor | `<provider>/<model>` |
| default | rearch-phase | `<provider>/<model>` |
| strong | rearch-architect | `<provider>/<model>` |
```

## inventory.md

| File | Kind | Lines | Aspects |
|---|---|---|---|
| src/storage/db.py | source | 412 | storage |
| docs/api-notes.md | doc | 230 | api, ui |

Totals per aspect at the bottom.

## requirements.md

```markdown
# Functional requirements

## <Area>
- FR-STORE-01: Every write is in a transaction that commits or rolls back as a whole.
  Evidence: src/storage/db.py:88, audit/storage.md F3
  Status: kept

## Non-functional
- NFR-01: A request returns within 200 ms at the 95th percentile.

## Constraints from external systems
- CON-PAY-01: The payment API rejects a retry with the same key after 24 hours. See docs/Payment API.md.

## Dropped
- EXP-07 CSV export experiment, dropped 2026-10-29.

## Refuted audit findings
- audit/storage.md B2: the cache is invalidated at src/storage/cache.py:40, so no stale read.

## Open questions
- Q1: ... [option A / option B], recommended: A.
```

- Every FR carries evidence and a status: `kept`, `open` or `dropped`. A dropped one moves to Dropped.
- Evidence names audit items as text (`audit/<aspect>.md F3`). Report items are bullets, not headings, so no anchor exists.
- Every open question lists its options and a recommended default.

## architecture.md

Sections: overview diagram (ASCII), modules with one responsibility each, data flow, concurrency model (and the real-time model when the project has real-time paths), interfaces between modules, error handling, external-system adapters (one per topic doc), FR to module traceability table, old to new file mapping, what gets deleted.

## docs-plan.md

| Current doc | Fate | Target |
|---|---|---|
| notes/api-reverse.md | fold facts, delete | docs/Payment API.md |
| TODO-old.md | delete | |

Plus the list of target docs with a one-line scope each.

## phases.md

```markdown
## Phase 3: Storage layer
Goal: one Store module replaces storage/db.py and storage/legacy_sync.py.
Covers: FR-STORE-01..06, NFR-01
Touches: src/storage/*, src/api/handlers.py
Deletes: src/storage/legacy_sync.py
Verify: build, unit tests (M2 when the run has manual checks)
Exit: all listed FRs pass, no references to legacy_sync remain.
```

An extra phase from Stage 6 is appended in the same format.

## deviations.md

One section per phase, `## Phase N (<date>)`, with numbered items: what the plan got wrong and what changed, including later phases edited. Then `## Not verified in Phase N`: what automated checks could not cover. The orchestrator adds its live-check results under the phase.

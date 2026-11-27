---
name: rearchitect
description: Full rearchitecture of a working but patched-together project. Inventories every file, runs parallel per-aspect audits on a cheap model, consolidates functional requirements, plans a new architecture on a strong model, then executes the refactor in committed phases with one fresh subagent per phase. Use when the user says the project works and wants a complete refactor, rearchitecture, cleanup of exploratory docs, or "rearchitect"; also use to continue one ("continue from .rearch/STATE.md").
---

# Rearchitect

Turns an exploratory codebase (reverse engineering notes, proofs of concept, workarounds, stale docs) into a clean architecture plus fact-only topic docs. One main session orchestrates the whole run and spawns subagents for the heavy work, so its own context stays small. All state lives in `.rearch/` in the target repo and is committed, so a new session in Claude Code or opencode can resume after a crash, a rate limit or a stop.

## Start of every session

1. Read `.rearch/STATE.md` if it exists. It names the current stage and the next step. Resume there (see "Resuming").
2. No `.rearch/` means a new run: start at Stage 0.
3. Read `references/state.md` (next to this file) for the file formats.
4. Before the first tool call of each stage or phase, tell the user the plan in 3 to 8 lines. Name the steps, the commands that will run, the files that will be created, changed or deleted, the subagents that will be spawned, and the commit that ends it. Then proceed without waiting, unless the step is a gate.
5. Before any later action outside that plan (a deletion, a branch or tag operation, an extra subagent, a fix to a failing build), say what it is and why in one or two lines first. Reading files and running read-only commands need no announcement.

## Spawns

| Spawn | Tier | Used for |
|---|---|---|
| `rearch-auditor` | `fast` | one audit per aspect, the seams audit, amendment audits, the Stage 6 per-module audits |
| `rearch-architect` | `strong` | requirements, architecture and phase plan, amendments |
| `rearch-phase` | `default` | one phase, fresh each time |

- Models: run the tier gate in [model-tiers.md](../harness-common/references/model-tiers.md) at Stage 0 and on resume. The table goes into `.rearch/baseline.md` under `Models for this run`, in the format of [state.md](../harness-common/references/state.md): the backticked cell is the exact value the tool takes. Every spawn passes the model of its tier. On opencode run `/usr/bin/python3 -I <harness-common>/scripts/opencode.py apply-tiers --state .rearch/baseline.md --general default` after the gate and on every resume. `<harness-common>` is the [harness-common](../harness-common/SKILL.md) skill folder, a sibling of this one.
- Briefs follow [subagents.md](../harness-common/references/subagents.md). An installed agent carries [preamble.md](../harness-common/references/preamble.md) already. A missing agent: follow "Missing agent" there.
- Only this session spawns. Subagents never spawn subagents, so Stage 6 runs here.

## Gates

A gate stops for the user's answer. Every gate lists each decision with a recommended default. The user answers item by item or accepts all defaults. Log each answer in STATE Decisions.

## Stage 0: Setup

1. Clean tree. Run `git status --porcelain`, with caches the baseline creates ignored. A dirty tree is a gate: ask the user to commit or stash, for example `! git stash push -u -m "before rearchitect"`.
2. Branch and tag, exact commands:
   - `git switch -c rearch/<YYYY-MM-DD>`
   - `git tag -a rearch-base -m "rearchitect base"`. Always annotated: a global `tag.gpgSign` makes a plain `git tag` fail ([git topic](../harness-common/topics/git.md) "Tags").
   The tag keeps every old doc and experiment reachable after deletion.
3. Existing branch or tag is a gate. Branch with a `.rearch/`: resume that run (default), or start over on `rearch/<YYYY-MM-DD>-2`. Branch without one: use `rearch/<YYYY-MM-DD>-2` (default). Tag `rearch-base` on the current commit: keep it (default). On another commit: tag `rearch-base-<YYYY-MM-DD>` (default), or move it with the user's OK. Record the names in STATE.
4. Detect build, test, lint and run commands. Run them so they leave no untracked files: switch off caches the tools write into the tree (for Python, `PYTHONDONTWRITEBYTECODE=1`, and parse checks with `compile()`, since `py_compile` writes `__pycache__/` anyway). Record exact commands and results in `.rearch/baseline.md`.
5. Gates, asked together in one message, each with its default:
   - Models: list the tool's models, propose one per tier, the user confirms or overrides (model-tiers.md "The gate"). Record the table in `baseline.md`.
   - Manual checks: how many checks only the user can run (devices, accounts, live services, look and feel). Default: zero. With zero, every phase and Stage 6 verify by automated means only (build, tests, throwaway installs, fixtures, grep tests) and report the rest as "not verified", which never blocks. Otherwise record the checks as `M1..Mn` in `baseline.md`.
6. Write `.rearch/STATE.md`. Commit `rearch: setup` with STATE in it. Continue to Stage 1 in the same session.

## Stage 1: Inventory

1. List every file: `git ls-files` plus untracked files that are not ignored. Record line counts.
2. Classify each file: source, test, doc, config, build, asset, generated, vendored. Generated and vendored files get one line each and no audit, unless the project patched them.
3. Propose aspects: one per functional subsystem (UI, domain logic, storage, API layer), one per external system with quirks (a vendor API, a device, a host application), plus `build-and-tooling`. Docs join every aspect they discuss.
4. Budget: an aspect over about 8,000 lines of source plus docs gets split. Auditors must read every line, and a larger aspect overflows a cheap model's context.
5. Write `.rearch/inventory.md`: every file, its kind, line count and aspect(s). A file with no aspect is an error.
6. Gate: show the aspect list with file and line counts. The user confirms, merges or splits (default: the list as proposed). Update STATE, commit `rearch: inventory` with it.

## Stage 2: Audit

1. Spawn one `rearch-auditor` per aspect, all in one batch. Brief: aspect name, its file list from `inventory.md`, the output path `.rearch/audit/<aspect>.md`, the project one-liner.
2. Each auditor returns a 150-word summary. Do not read full reports in this session; context goes to the architect. Mark each aspect done in STATE Progress as its reply arrives.
3. Check coverage with a grep, not by reading: every file in `inventory.md` appears in a Coverage table row with `yes`. Re-spawn an auditor for any gap.
4. Spawn one more `rearch-auditor` for the `seams` aspect. Brief: the paths of every report (it reads their Interfaces sections) and the boundary files they name. It audits contracts between aspects: concurrency, ownership, data formats, duplicated logic, circular dependencies.
5. Update STATE, commit `rearch: audits` with it. Continue to Stage 3.

## Stage 3: Requirements

1. Spawn `rearch-architect` in requirements mode. It reads every audit and writes `.rearch/requirements.md` (format in `references/state.md`).
2. Gate: present the Open questions and every feature marked `experimental` or `unclear`, each with the recommended answer. The user decides keep or drop for each. Write answers into `requirements.md` and log them in STATE Decisions. Experiments the user drops are deleted in the refactor.
3. Update STATE, commit `rearch: requirements` with it. Continue to Stage 4.

## Stage 4: Architecture and phase plan

1. Spawn `rearch-architect` in architecture mode. It writes `.rearch/architecture.md`, `.rearch/docs-plan.md` and `.rearch/phases.md`.
2. Phase rules the architect follows:
   - Every phase leaves the build green and every kept requirement working.
   - Phase 1 writes the topic reference docs from the audits' External facts sections. Quirk knowledge lives in comments and old docs, and later phases delete both.
   - Phase 2 adds the test harness the new architecture needs (characterization tests on current behavior where practical).
   - One phase fits one subagent context: one module or one seam, roughly 15 files touched at most.
   - Removal of old code happens in the phase that replaces it. No dual implementations survive past their phase.
   - `phases.md` ends with the last code phase. Stage 6 does the cleanup and the traceability audit.
3. Gate: the user reviews the architecture and plan, with the architect's questions and their defaults. Apply changes. Update STATE, commit `rearch: architecture` with it. Continue to Stage 5.

## Amendments

A component added to the run after Stage 2 (a new skill, module or service) gets:

1. An amendment audit: one `rearch-auditor` on its files, output `.rearch/audit/<component>.md`. Add its files to `inventory.md`.
2. An architect amendment: `rearch-architect` in amendment mode folds the audit into `requirements.md`, `architecture.md` and the phases not yet done.
3. Gate on its open questions, then commit `rearch: amend <component>` with STATE.

## Stage 5: Phase execution (one subagent per phase)

Loop over the phases in `phases.md`, one at a time:

1. Tell the user the phase number, title and goal in 2 lines. Write the phase in flight and its base commit (`git rev-parse HEAD`) into STATE Progress.
2. Spawn a new `rearch-phase`. Brief: phase number, this skill's directory, any user answers from a blocked attempt. Never reuse a previous phase's subagent.
3. Blocked reply: show the questions to the user with defaults, record answers in STATE Decisions, and spawn a new `rearch-phase` for the same phase with the answers.
4. Done reply: show the user the summary. Run `git status` and the baseline commands to confirm the subagent's results.
5. Live check: subagents can't run live calls against external services, so this session does. When the phase changed code that calls an external API and a read-only call is safe, run one such call here and add the result to `deviations.md`. Never run a write call without the user's OK.
6. Manual checks, only when `baseline.md` has any: list the `M` items the subagent named, with what to look for. Wait for the user's result. A failure goes back to a new `rearch-phase` with the failure description. With zero manual checks, the subagent's "not verified" list goes into `deviations.md`, and the loop goes on.
7. Deviations recorded: tell the user which later phases changed.
8. Commit `rearch(phase N): <title>` with the requirement IDs in the body. Update STATE first (phase done, Progress cleared, next phase, Next prompt), so it lands in the same commit.
9. Continue with the next phase.

This session never reads source files or full audits during Stage 5. It works from subagent replies, `git diff --stat` and STATE. This keeps its context near constant across phases.

## Stage 6: Final cleanup

1. Read `.rearch/baseline.md` first: the commands, the manual checks and the models table. Everything below needs them.
2. Spawn one `rearch-auditor` per new module in final mode, all in one batch. Brief: module name, its files, the requirement IDs `architecture.md` maps to it, the path of `requirements.md`, output `.rearch/audit/final-<module>.md`. Each reports every FR it cannot find in code, leftovers, stale comments and dead code.
3. Findings that need code changes: append an extra phase to `phases.md` and run it as in Stage 5.
4. Move `requirements.md` and `architecture.md` into `docs/`. On the way, apply every item of `deviations.md` that changed a requirement, an interface or a CLI, drop the open questions, answers and run history, and write both as current design in present tense. Remove every model name and id: the repo rules hold for `docs/` too. Delete every exploratory doc that `docs-plan.md` marks for deletion. Git history and the base tag keep them.
5. Update `README.md` and `CLAUDE.md` or `AGENTS.md` to point at the new docs.
6. Run the full baseline, and the manual checks when there are any. List what stays "not verified".
7. On opencode, run `/usr/bin/python3 -I <harness-common>/scripts/opencode.py clear-tiers` from the project.
8. Delete `.rearch/` last. Commit `rearch: complete`.
9. Ask before merging the branch or deleting the tag (default: leave both).

## Resuming

- Run the tier gate again when `baseline.md` has no `Models for this run` table or it was confirmed in another tool. On opencode, run `apply-tiers` again.
- STATE Progress names a phase in flight and the tree is dirty: the phase agent died. Show `git diff --stat <base commit>` and `git status --short`. Gate: keep the changes and spawn a new `rearch-phase` that continues from them (default), or discard them with `git restore` and `git clean` on the listed files and rerun the phase.
- STATE Progress lists aspects not yet audited: spawn auditors for those only.

## Stopping

The run continues in one session until it finishes. Stop when the user asks, when a rate limit or error ends progress, or when the context window is past about 70%. On a stop, update STATE, then print a fenced block the user pastes into a new session:

```
Use the rearchitect skill. Continue from .rearch/STATE.md.
Next: <stage or phase number and title>.
```

Keep the same block current in STATE under "Next prompt" after every stage and phase. A stop that leaves uncommitted work says so, for example: run `! git status --short` to see it, and the next session decides.

## Rules

- Before every commit, run `git log --oneline -5` and `git status --short`. A commit since the last run commit that this run did not make means another session works in this repo, and it may have swept in this run's uncommitted files. Stop and show the user. Gate: split the history so each commit holds only its own files (default), or keep it as is.
- Read every line of every file assigned to a step. Large files get read in chunks. A skim breaks the method: stale claims hide in the middle of files.
- Requirements come from current working behavior and user decisions. Old docs count as evidence only where code confirms them.
- The existing structure places no constraint on the new architecture.
- Facts about external systems need evidence: a code workaround, a capture, a test or a vendor doc. Unverified claims get marked `unverified` and land in Open questions.
- Never delete a workaround until its fact is in a topic doc.
- Commit at the end of every stage and phase, with STATE in the commit. Never push or merge without asking.

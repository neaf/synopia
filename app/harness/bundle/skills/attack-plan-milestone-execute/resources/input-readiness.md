# Is the milestone ready to build?

This skill gets its results from its input. A milestone with an approved product solution, a technical solution and precise tasks turns into PRs a reviewer accepts. A one-sentence ticket turns into guesses, rework and review threads. Grade the input before any code.

`<create>` below is the `attack-plan-create` skill folder, next to this skill's folder (`<skill>/../attack-plan-create`).

## Blocking gaps

Any of these stops the run:

1. **No product solution.** Nothing says who gets what: the rules per role, what each screen shows, what is out of scope. A ticket title is not a product solution.
2. **No technical solution for this milestone.** Nothing says which parts of the code change, in which order, what must not change (shared frameworks, code of other teams, generated files), and how it is released (flag, who it targets).
3. **Task blocks that cannot become PRs.** Each task of the milestone has a block in the technical solution, in the shape of create's [task block schema](../../attack-plan-create/references/executable-plan.md) ("Task block schema"). A block is ready when an implementer could open its PR without asking the author.
4. **Open questions that block this milestone,** with no answer and no assumed default written down.
5. **Unmerged prerequisites** (an earlier milestone, shared plumbing) with no plan for stacking on them.

## Gaps to fix during the audit

These do not stop the run. Add them to the audit of Step 3:

- the reason behind each choice a reviewer will challenge, when the block's "Reviewer-facing rationale" misses one;
- open PRs of other developers on the same files;
- QA personas and the data a review app needs;
- the commands to run after switching branches;
- a tracker ticket that disagrees with its task block: the ticket wins, and the block is updated (Step 4).

## How to grade

1. **Plan written with `attack-plan-create`** (its work folder `.attack-plan/<slug>/` holds `gates.json`): run `/usr/bin/python3 -I <create>/scripts/gate.py verify <work folder>` and `… gate.py status <work folder>`.
   - Items 1, 2 and 4 pass when every gate of the `intake` to `milestones` stages, plus this milestone's `tasks-m<n>`, is `approved`, and `verify` prints `OK`. Other milestones' `tasks-m<k>` gates do not count.
   - A gate still `drafting` or `grilled`, `stale`, or `CHANGED SINCE APPROVAL` is a blocking gap: the author finishes or re-approves it in `attack-plan-create`.
   - A gate `not reviewed` (the author skipped its review) is not blocking. Record it in the notes `README.md` as an accepted gap.
2. **Any other plan:** grade items 1, 2, 4 and 5 yourself against the documents.
3. **Item 3, in both cases:** run `/usr/bin/python3 -I <create>/scripts/check_draft.py --tasks <technical solution file> --milestone <n>`. Each `FAIL` line is a blocking gap of item 3; a `WARN` goes to the audit. When the task detail lives only in a document tool, fetch the milestone's task detail into a file outside the repository (for example `/tmp/<slug>-m<n>-tasks.md`) and check that file.
4. Item 5 is always graded by hand: list the prerequisites and whether each is merged.
5. With tracker tickets, grade them against their blocks with read-only subagents (`Spawns` in the skill: `general`, tier `fast`), about six tickets each. Each returns one line per ticket: matches its block, or what differs.
6. Show the result as a table: item, verdict, what is missing, who can fill it (product, the author, another team).

## When the input is not ready

- Stop and say what is missing, in plain words. Suggest filling it with the `attack-plan-create` skill, or by asking the person who owns each gap.
- When the user still wants to go on, write the accepted gaps in the notes `README.md`. Each accepted gap becomes a question of the audit in Step 3, answered before the PR it affects is briefed.

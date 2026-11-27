---
name: qa-session
description: Builds, reworks and checks the QA session page for a feature milestone: the script a team walks through live on a deployed test environment with seeded users and data, one person driving and the others watching. Use when preparing, reworking, verifying or editing during a live session a QA script, walk-through or test-session page, or when a feature milestone needs a QA session before it merges.
---

# QA session

Before a milestone merges, the team walks through it together on a test environment (review app or staging) with seeded users and data. One person drives; the others watch. The page is the script, in three parts: the setup for the lead developer, collapsed; numbered scenarios, each with the persona, where to start, the steps and the expected results; and an empty Findings section. The driver reads it with the app open, so every step must work without help.

[writing-craft](../writing-craft/SKILL.md) is mandatory before drafting and before any review of the page. This skill adds what is specific to QA pages and the process around them. It does not repeat the craft rules.

`<skill>` below is the folder holding this file. Run scripts with `/usr/bin/python3 -I`.

## Inputs

The page is derived from sources, never from the conversation. Each input is needed unless marked optional. Ask for a missing one, one question at a time, with its default.

1. **Spec or plan** of the milestone: what changes, for whom, what stays the same. Required.
2. **Code under test:** the branch or pull request, read at a recorded commit, with the permission and display code the checks depend on. Required.
3. **Seed:** the script or task that creates users, roles and data, and its printed output. Required: without it no check can be verified.
4. **Environment:** URL, deployed build, feature switch (its UI label and how to set it), how each seeded user signs in. Required.
5. **Personas and order.** Default: the most powerful persona first, then the new role, its edge cases, the roles that must see no change, and the feature switch off.
6. **Open product decisions.** Each scenario whose result depends on one says so in its Context line. Default: none.
7. **Publishing target** (optional). Default: a markdown file at `docs/qa/<slug>/session.md` in the feature's repository. See "Publishing" below.

## Modes

Pick the mode from the state, then say which one runs in one line.

- **Create:** no page yet. Full derivation, verification, publish.
- **Rework:** the page exists and no session is running. The whole script is re-derived in fresh subagents that never see the previous page. Then the carry-over and a change report.
- **Live edit:** a session is running and the driver is on the page. Small targeted edits only, state preserved. No rebuild.

Never rebuild a page that has ticks or findings without asking the user first.

## Session folder

`.ai-notes/qa-<slug>/`, following the ai-notes skill (its README, its writing rules, one fact in one place):

- `README.md`: goal, links (test environment, feature, publishing target), files, to-do, open questions, lessons.
- `sources.md`: each source with its path, the code's commit, the seed command, the environment build, the publishing target and its page location, and "Tool notes".
- `decisions.md`: each decision the user made about the page, with the date and their reason. The rework reads it first; a decision in it survives every rework unless the user changes it.
- `rework-log.md`: one dated section per rework: what changed, and the source or decision behind each change.
- `derivation.md`: the Builder's source for each check. The Verifier never reads it.

The page never holds this history. The README's "State (start here)" section holds the `Models for this run` table and the `Next:` line ([state.md](../harness-common/references/state.md)).

## Create

1. Check the required inputs. Stop and ask for any that is missing.
2. Record `sources.md`: commit SHAs, seed command, environment build, feature switch, publishing target.
3. Run the **Builder** brief (`references/briefs.md`) with the sources and `decisions.md`. It writes the page and a derivation file: each check and the source that settles it.
4. Run `/usr/bin/python3 -I <skill>/scripts/check_page.py <page> -v` and fix every FAIL.
5. Run the **Verifier** brief: a fresh reader, given only the page and the sources, checks every fact and does a cold read as the driver. Fix each wrong check. Label each unverifiable check on the page `unverified`, with the check that would settle it.
6. Show the user the shape of the page (scenarios, checks, unverified checks) and the Verifier's counts. Publish after the user's go-ahead ("Publishing" below).

The setup comes from `references/setup-checklist.md`. The page's shape and the writing of scenarios and checks come from `references/page-template.md`.

## Rework

1. Read `decisions.md`, `sources.md` and the last entry of `rework-log.md`.
2. Copy the current page, read from its publishing target, to `.ai-notes/.qa-previous/<slug>.md`. It sits outside the session folder, so no subagent pointed at the notes reads it. It is kept for steps 5 and 6 only. Never give its path to a subagent.
3. Run the **Builder** brief again with the sources, the decisions and the current version of this skill's references. Its page goes to a new working file, not over the current page.
4. Run `check_page.py` and the **Verifier** brief on the new page, as in Create.
5. Carry over the live state (`references/briefs.md` "Carry-over"). Ticks and findings are matched by scenario title and check text. A tick carries over only when the check still means the same thing; otherwise it is removed and the reply says why. Findings the user asked to keep are copied under Findings with their original wording, and `check_page.py` then runs with `--live`. Nothing else moves.
6. Compare the new page with the previous copy and write the change report in `rework-log.md`: scenarios added, removed or reordered; checks changed, with old and new wording and the source or decision behind each; ticks removed. Show the user the report in one table.
7. Ask for review. Publish after the go-ahead. Then delete `.ai-notes/.qa-previous/<slug>.md`: the change report and the published page keep what it held.

## Live edit

- Change only what the team asked for, or a check the session proved wrong. One edit per finding.
- Keep every tick and finding. When a check changes meaning, untick it and say in one line what changed and why.
- Record a decision the user makes in `decisions.md` with the date.
- Run `check_page.py <page> --live` after the edit. No rebuild, no rework until the session is over. If a new fact is needed, verify it in one narrow fact check.

## Page rules

The shape and the writing rules are in `references/page-template.md`. The rules a reviewer checks first:

- Three parts, in order: the setup for the lead developer, collapsed (`<details>` in Markdown, a toggle in a document tool); the numbered scenarios; `## Findings`, empty, with no table.
- Each scenario carries all the context its driver needs: the persona line, where to start, the context, then numbered steps with the expected results as checkboxes under the step that shows them.
- Every expected result is derived from the code and the seed, verified before it is written. An unverified check is labeled `unverified`, never written as a plain check.
- The seed makes every scenario possible. A seed gap is fixed in the seed, with a test.
- Every value the driver needs is resolved on the page before the session: real URLs, real ids, real emails.
- Every on-screen word is the exact label that scenario's persona sees, in their UI language, traced to the code that renders it. Prose is US English.
- No internal reference ids, no bare "today" or "now", no history from earlier sessions.

`check_page.py` checks the mechanical part of these rules: emoji, internal ids, `<…>` and `[…]` placeholders, unfinished markers (TODO, TBD, FIXME, XXX), bare "today" and "now", "(cont.)", the collapsed setup, scenario headings and their order, the persona line, scenarios without checks, and an empty Findings section. Fenced code is skipped, and so is backticked text for the id and "today" checks. With `--live` Findings may hold entries. It decides nothing about facts.

## Publishing

Follow [publishing.md](../harness-common/references/publishing.md). What is specific to this skill:

- Source of truth: the published page. `sources.md` records the target, the page URL and its id, and "Tool notes" for tool quirks.
- Markdown: links are relative to the file or absolute to the test environment. Findings are written into the same file during the session.
- A published page with ticks or findings is never overwritten from a fresh build: the Rework carry-over decides what moves.
- No personal details on the page beyond the seeded emails.

## Spawns

| Spawn | Tier | Used for |
|---|---|---|
| `general` | `strong` | the page Builder |
| `general` | `strong` | the page Verifier |

- Models: before the first spawn of a run, run the tier gate in [model-tiers.md](../harness-common/references/model-tiers.md) and write the table into the session README's "State (start here)". On opencode, `apply-tiers` takes `--general strong`.
- Each prompt is the filled brief from `references/briefs.md`, and nothing else: never the conversation, a previous page, or the orchestrator's conclusions. Briefs follow [subagents.md](../harness-common/references/subagents.md).
- Without subagents, run each brief yourself, say so in `README.md`, and keep the two passes separate: derive the page first, then check it as if you had not written it.

## Stopping and resuming

Stop when the user asks, when a required input is missing, or when a tool keeps failing. Write the state in the session README's "State (start here)" section, then print:

```
Use the qa-session skill. Continue from .ai-notes/qa-<slug>/README.md.
Next: <mode, step>.
```

## Rules

- **Sources decide, the user decides.** Facts come from code, seed and environment. Choices come from the user and are recorded in `decisions.md`.
- **Fresh eyes are the point.** A rework starts from the sources, not from the previous page.
- **Test environments only.** Writes go to the test environment. Shared or production data is read-only, and read only when the user allows it.
- **Nothing is removed silently.** Old pages and notes are kept and marked as superseded. The one file deleted is the Rework's copy of the previous page, after its change report is written.
- **A failed tool call is retried or reported,** never replaced by a guess.

# Subagent briefs

A brief is the subagent's whole prompt and follows [subagents.md](../../harness-common/references/subagents.md) "Brief minimum". The installed agent already holds the preamble and its role rules: read at the pinned commit, cite, read only. A `general` fallback gets them through subagents.md "Missing agent". The briefs below carry only the task.

Start every brief with the context line, then the role's brief. Replace the `<…>` values. `<work>` is the work folder's absolute path. Give paths, not pasted content, when the subagent can read the file.

## Context line

> Attack plan for `<project one-liner>`. Work folder: `<work>`. Repository: `<repo>`, pinned commit `<SHA>`.

## Reader (`attack-plan-reader`, one per source family)

> Source family: `<family>`. Sources: `<links or paths>`. Hard constraints: `<constraints>`. Write `<work>/sources/<family>.md`: (1) facts, one per line, `PRODUCT | DESIGN | CODE | DECISION | CONSTRAINT · fact · source · date`; (2) rules and states, for designs one line per callout and per screen state; (3) decisions already taken, with who and where; (4) contradictions with both sources; (5) questions this family could not answer, with who owns each; (6) new links worth reading. Reply in at most 200 words: counts per section and the three facts most likely to change the plan.

Family names: `product`, `design-<n>`, `plans`, `prs`, `code-<area>`, `chat`. The briefs below read them by these prefixes.

For designs, add: "Read each image yourself. List the screen, every visible state (empty, loading, error, long text, many items, hover), every callout as a rule, and every difference between localized variants that is more than a translation."

For pull requests, add: "For each PR, give its state, base, what it ships, and what its review threads settled. Then search the open PRs that touch `<paths>` and list them with their owner."

## Section challenger (`attack-plan-critic`, a fresh one every round)

> Section under review: "`<heading>`" in `<work>/<draft file>`. Approved sections you may rely on: `<headings>`. Read the section, `<work>/ledger.md` and the digests it draws on. Find what is wrong or missing in this section: a claim no source supports, a gap a reader would hit, a contradiction with an approved section or a source, a decision stated as settled that nobody settled, an assumption with no check. For each finding: blocking or minor, the line, the evidence, and the question that would settle it. Output: your reply, no file. Reply in at most 300 words.

Use the Product challenger for product sections, the Breakers for technical sections, the Plan walker and the Outside reviewers for milestone sections, and this brief for the rest (intake, scope, audit, publish).

## Product challenger (`attack-plan-critic`, a fresh one every round)

> Section under review: "`<heading>`" in `<work>/draft/attack-plan.md`. Approved product sections: `<headings>`. Read the section and `<work>/sources/design-*.md` and `<work>/sources/product.md`. Find: design states or callouts with no rule; rules that contradict a callout, the product doc or an approved section; a role or persona whose view is not described; an empty, loading, error, long or many-items state left out; a sentence a CEO could not follow (code terms, jargon); a question already answered by a source. One item per finding: blocking or minor, the line, the source and the question that would settle it. Output: your reply, no file. Reply in at most 300 words.

## Product reviewer (`attack-plan-critic`)

> Read only the product part of `<work>/draft/attack-plan.md`: the scope, the summary, the product solution and the open questions. Read it as the product manager who owns this project and must sign it off. Return: what you cannot follow; each rule you would challenge, and why; each user situation the page does not answer (name a persona and a case); what a designer would still have to draw; whether each delivery slice is worth releasing alone and the order serves users; each open question whose options or recommendation you would dispute. End with one line: ready for product review, or not, and why. Output: your reply, no file. Reply in at most 300 words.

## Designer (`attack-plan-designer`)

> Read the approved product solution in `<work>/draft/attack-plan.md`, `<work>/ledger.md` and `<work>/sources/code-*.md`. Hard constraints: `<constraints>`. Reference PRs: `<numbers>`. Write `<work>/draft/design-proposal.md` and `<work>/draft/alternatives.md`. Reply in at most 300 words.

## Breaker (`attack-plan-critic`, one per lens, a fresh one every round)

> Lens: `<lens>`. Section under review: "`<heading>`" in `<work>/draft/technical-solution.md`. Read it, the approved sections it builds on, the product solution, and the code at the pinned commit. Find how this section fails under your lens. For each finding: blocking or minor, the scenario (input or state, then the wrong result), the evidence, and the smallest change that would remove it. When you find nothing, say what you checked. Output: your reply, no file. Reply in at most 400 words.

Lenses:

- **Constraints:** each hard constraint in STATE against each step. Does any step need a change the constraints forbid?
- **Access and security:** does any change open access to someone who does not have it today? Follow every new grant, scope, rule or flag to every path it reaches: exports, calendars, other pages that share the model, API clients, background jobs. Is the flag-off path closed? Is a missing branch closed by default?
- **Data and sharding:** where each read and write runs, cross-database queries, shard context in jobs and tasks, nil parents, data already written in the old shape.
- **Edge cases:** per endpoint and per screen, the nil, empty, hidden, confidential, out-of-scope and many-items cases. Which one returns 500, leaks, or shows nothing?
- **Module boundaries:** which modules or packages each step touches, the dependencies and public interfaces it needs, and whether a step reaches into another team's private code.
- **Rollout:** the feature flag, who it targets (a company, an account, a user), the flag-off path of every step, and the kill switch. Can the flag be turned off without a data fix?
- **Scope coverage:** if every task is done as written, is each scope item and product rule delivered? One verdict per item.
- **Drift and collisions:** commits on the remote default branch since the pinned commit in the touched paths, and open pull requests from others on the same files. What breaks or conflicts?
- **Reviewer's eye:** read the plan as the permissions, sharding or frontend reviewer would. Which decision would you challenge, and does the plan answer it?

Add a lens when the project has a risk area not listed (performance on a hot path, a third-party API, a migration on a large table).

## Plan walker (`attack-plan-reader`)

> Read the task blocks of milestone `<n>` in `<work>/draft/technical-solution.md`. Walk the tasks in merge order as the implementer, on the code at the pinned commit. For each task, list where you would have to guess (a file, a name, a rule's extent, a test case, a base branch), where CI would go red after the merge, and where a flag-off or missing-branch path would stay open. Write `<work>/audit/plan-walk.md`, one line per finding with the task title. Reply in at most 200 words: the finding count per task and the three that block.

## Outside reviewer (`attack-plan-critic`, one per owning team the milestone touches)

> You are a reviewer from `<team>`, owner of `<paths>`. You have not read the plan. Read only the task blocks of milestone `<n>` in `<work>/draft/technical-solution.md` that touch your paths, and the code at the pinned commit. For each task: could you review its pull request alone, from its context lines and its diff? Flag a task that mixes your code with another team's, carries more than one concern, needs a later pull request to be safe, or leaves a decision in your area unexplained. Say what you would ask in the review, and how to split or reword the task so you would not need to ask. Write `<work>/audit/outside-<team>.md`, one line per finding with the task title. Reply in at most 200 words: the blocking findings.

## Claim auditor (`attack-plan-reader`, one per topic)

> Claims: `<work>/audit/claims.md` items `<n>` to `<m>`. For each, read the code at the pinned commit and give a verdict: confirmed, partial, wrong or unverifiable, with `path:line` and the correction. Then a "Missed" list: what the drafts should say about this topic and do not. Write `<work>/audit/claims-<topic>.md`. Reply in at most 200 words: verdict counts and every wrong claim.

## Scope auditor (`attack-plan-reader`)

> Read `<work>/audit/scope.md` and the task tables in `<work>/draft/attack-plan.md`. For each scope item and product rule: delivered, partly delivered, or gap, with the tasks that deliver it. Write `<work>/audit/scope-verdicts.md`. Reply in at most 150 words: the counts and every gap.

## Cold reader (`attack-plan-critic`, reads only the drafts)

> Read only `<work>/draft/attack-plan.md` and `<work>/draft/technical-solution.md`. Answer from the pages alone: who gains and what it unlocks; what changes for each role; why this design over its main alternative; what a designer must draw; how anyone will know it works; what is open and who decides; the biggest risk. For each answer you cannot give, say which section should have given it. Write `<work>/audit/cold-read.md`. Reply in at most 200 words: the answers you could not give.

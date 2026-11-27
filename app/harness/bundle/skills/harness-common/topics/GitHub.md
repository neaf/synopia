# GitHub

Facts about GitHub (`gh`, REST, GraphQL, Actions) that the skills depend on. Vendor docs were read on 2026-11-25: [GraphQL schema](https://docs.github.com/public/fpt/schema.docs.graphql), [GraphQL limits](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api), [REST pulls](https://docs.github.com/en/rest/pulls/pulls), [REST workflow jobs](https://docs.github.com/en/rest/actions/workflow-jobs), [Events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows). Read-only `gh` runs against `cli/cli` checked the snapshot query (`watch.py pr 15111 15157 --repo cli/cli --once`) and the thread listing with its bot or human split (`review_threads.py list --pr 15111 --repo cli/cli`). The mutations (`resolveReviewThread`, `addPullRequestReviewThreadReply`) and `node(id:)` were not run against GitHub.

Adapter: `skills/harness-common/scripts/github.py` (`run`, `Gh`, `GhError`). It is the only code that runs `gh`. `skills/feedback-watch/scripts/watch.py` reads its snapshots.

## gh

| Fact | Source |
|---|---|
| `gh api graphql -f key=value` sends a string variable. `-F key=value` converts `true`, `false`, `null` and integers, and reads the value from a file when it starts with `@`. Every field other than `query` and `operationName` is a GraphQL variable. | `gh api --help`, gh 2.103.3 |
| A failed call exits non-zero with the cause on stderr. Whether a GraphQL error answer always exits non-zero, or can print `errors` with exit 0, is `unverified`. | `unverified` |
| `gh repo view --json nameWithOwner` names the repository of the current folder. | `gh repo view --help` |

Code: `github.py` `run` (first stderr line as the error, 60 s timeout, stdin closed), `Gh.graphql` (strings as `-f`, so a value starting with `@` is never read as a file; an `errors` list raises `GhError` either way), `Gh.repo`. Tests: `skills/harness-common/tests/test_github.py` `RunTest`, `RepoAndResolveTest`.

## Pull request snapshot

| Fact | Source |
|---|---|
| `PullRequest.state` is `OPEN`, `CLOSED` or `MERGED`. `headRefOid` is the head commit. | GraphQL schema, `enum PullRequestState`, `type PullRequest` |
| `PullRequest.commits(last: 1)` gives the newest commit; its `statusCheckRollup` is null until a check or status registers. | GraphQL schema, `type Commit` (nullable field) |
| `PullRequest.reviews` is nullable; `reviewThreads` is not. | GraphQL schema, `type PullRequest` |

Code: `github.py` `snapshot_query`, `Gh.pr_snapshot`, `Gh.connection`. A head that changes between page calls raises `GhError`, so the round is skipped. Tests: `test_github.py` `SnapshotTest`.

## Check rollup

| Fact | Source |
|---|---|
| `statusCheckRollup.contexts` items are a union of `CheckRun` and `StatusContext`; `__typename` tells them apart. | GraphQL schema, `union StatusCheckRollupContext` |
| `CheckRun` has `name`, `status`, `conclusion` and `startedAt`. `startedAt` and `conclusion` can be null. Its workflow name is `checkSuite.workflowRun.workflow.name`; `workflowRun` is null for a check run outside Actions. | GraphQL schema, `type CheckRun`, `type CheckSuite` |
| `StatusContext` has `context`, `state` and `createdAt`. | GraphQL schema, `type StatusContext` |
| `CheckRun` statuses: `COMPLETED`, `IN_PROGRESS`, `PENDING`, `QUEUED`, `REQUESTED`, `WAITING`. | GraphQL schema, `enum CheckStatusState` |
| `CheckRun` conclusions: `ACTION_REQUIRED`, `CANCELLED`, `FAILURE`, `NEUTRAL`, `SKIPPED`, `STALE`, `STARTUP_FAILURE`, `SUCCESS`, `TIMED_OUT`. | GraphQL schema, `enum CheckConclusionState` |
| `StatusContext` states: `ERROR`, `EXPECTED`, `FAILURE`, `PENDING`, `SUCCESS`. | GraphQL schema, `enum StatusState` |

Code: `github.py` `check_item` (one dict shape per kind), `watch.py` `FAILING_CONCLUSIONS`, `FAILING_STATES`, `PENDING_STATES`, `checks`. Tests: `skills/feedback-watch/tests/test_watch.py` `ChecksTest`.

### Quirk: reruns stay in the rollup

- Symptom: a rerun workflow leaves the old failed run next to the new one, so the PR reads as failing after a green rerun.
- Cause: the rollup lists every run, not only the latest.
- Workaround: per (workflow, check name), keep only the newest item by `startedAt` (`CheckRun`) or `createdAt` (`StatusContext`).
- Code: `watch.py` `latest_checks`, `stamp`. Tests: `test_watch.py` `test_newest_rerun_replaces_an_older_failure`, `test_pending_rerun_hides_an_older_failure_from_the_failing_list`.

### Quirk: cancelled runs

- Symptom: a run cancelled by a workflow's concurrency group shows as `CANCELLED` beside the run that replaced it.
- Cause: concurrency cancels the older run.
- Workaround: a cancelled run loses to any other run of the same check. A check whose only run is cancelled is failing, labelled `<name> (cancelled)`.
- Code: `watch.py` `latest_checks`, `checks`. Tests: `test_watch.py` `test_cancelled_run_beside_another_run_is_superseded`, `test_FR_FW_03_a_sole_cancelled_run_is_failing`.

### Quirk: a queued run has no start time

- Symptom: a queued rerun may sort as older than the run it replaces, so the old failure shows instead of `CI running`.
- Cause: `CheckRun.startedAt` is nullable (schema). Whether GitHub sends null or a zero date (`0001-01-01T00:00:00Z`) for a queued run is `unverified`.
- Workaround: a null, empty or zero `startedAt` sorts as the newest.
- Code: `watch.py` `stamp`. Test: `test_watch.py` `test_queued_rerun_without_a_start_time_is_the_newest`.

### Quirk: empty or partial rollup right after a push

- Symptom: right after a push the rollup is empty, or holds only the checks that registered first, which reads as done.
- Cause: checks appear a few seconds after the push, one workflow at a time.
- Workaround: an empty rollup counts as pending, unless `--allow-no-checks` is given. Done needs two rounds in a row with the same state, one `--interval` apart.
- Code: `watch.py` `pr_state`, `run_pr`. Tests: `test_watch.py` `test_empty_rollup_is_pending_until_allowed`, `test_FR_FW_04_one_done_round_is_not_enough`.

## Reviews and threads

| Fact | Source |
|---|---|
| `PullRequestReview` has `author` (nullable `Actor`), `state` and `commit`, the commit the review covers. | GraphQL schema, `type PullRequestReview` |
| Review states: `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED`, `PENDING`. | GraphQL schema, `enum PullRequestReviewState` |
| `Actor` is an interface; `__typename` is `Bot` for an app account. | GraphQL schema, `type PullRequestReviewComment` |
| `PullRequestReviewThread` has `id`, `isResolved`, `path`, `line` (nullable) and `comments`. The thread has no author or URL of its own; the first comment's author started it. | GraphQL schema |
| A deleted account's `author` is null; GitHub shows it as `ghost`. | Schema (nullable); the name is `unverified` |
| The mutation `resolveReviewThread(input: {threadId})` resolves a thread. | GraphQL schema |
| The mutation `addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId, body})` posts a reply in a thread as the authenticated user and returns the new `comment { url }`. | GraphQL schema; not run against GitHub (`unverified`) |
| `node(id:)` with `... on PullRequestReviewThread` reads one thread by the id the snapshot gives: `isResolved`, `path`, `line`, `pullRequest { number }`, its first comment's `body` and author. | GraphQL schema; not run against GitHub (`unverified`) |

Code: `github.py` `REVIEWS`, `THREADS`, `THREAD`, `actor`, `review_item`, `thread_item`, `Gh.thread`, `Gh.reply_to_thread`, `Gh.resolve_thread`; `watch.py` `REVIEWED_STATES`, `pr_state`; `skills/attack-plan-milestone-execute/scripts/review_threads.py` (replies to and resolves bot threads only). Tests: `test_github.py` `test_one_call_reads_state_head_rollup_reviews_and_threads`, `test_deleted_author_is_ghost_and_not_a_bot`; `test_watch.py` `test_changes_requested_counts_as_reviewed_dismissed_does_not`.

### Quirk: bot logins differ between REST and GraphQL

- Symptom: a reviewer given as `claude[bot]` never counts as having reviewed.
- Cause: REST names a bot `claude[bot]`, GraphQL names it `claude`. Users copy the `[bot]` form into `--reviewer`.
- Workaround: compare logins lowercased, with a trailing `[bot]` stripped.
- Code: `watch.py` `normalize_login`. Tests: `test_watch.py` `test_reviewer_match_ignores_the_bot_suffix`, `test_reviewer_match_ignores_case`.

### Quirk: lists stop at 100

- Symptom: on a PR with more than 100 checks, reviews or threads, the extra ones are not seen, and done can be read early or never.
- Cause: a GraphQL connection takes `first` or `last` between 1 and 100 (GraphQL limits doc).
- Workaround: read `pageInfo { hasNextPage endCursor }` and ask again with `after:` for the connections that have more; the others are left out of the page query.
- Code: `github.py` `PAGE`, `snapshot_query`, `Gh.pr_snapshot`. Test: `test_github.py` `test_every_page_is_read_and_only_unfinished_connections_are_asked_again`.

## Pull request order

| Fact | Source |
|---|---|
| REST lists pull requests by `created`, newest first, unless `sort` and `direction` say otherwise. | REST pulls doc, "List pull requests" |
| The search `is:pr label:<label> sort:created-asc` lists the oldest first. | `skills/attack-plan-milestone-execute/SKILL.md` Step 4, `unverified` |

Workaround in use: open a milestone's PRs in number order, so newest-first reads as one sequence. Code: `skills/attack-plan-milestone-execute/SKILL.md` Step 4, `skills/attack-plan-create/references/executable-plan.md` "Split for review in isolation".

## Stacked branches and CI

| Fact | Source |
|---|---|
| A `pull_request` workflow runs on the merge ref `refs/pull/<n>/merge`. | Events doc, `pull_request` |
| `pull_request` workflows do not run while the PR has a merge conflict; `pull_request_target` workflows do. | Events doc |
| `gh stack` is an optional `gh` extension. Without it each PR targets the branch below. | `skills/attack-plan-milestone-execute/SKILL.md` "Context" |

### Quirk: a stack behind the default branch goes red together

- Symptom: every PR of a stack fails at once, in jobs its code does not touch (a change detector firing on files only the default branch changed, a missing task, a tool version mismatch).
- Cause: the branches are behind the default branch. The skill text says CI runs the default branch's workflows against the old branch files. For `pull_request` the docs say the run uses the PR's merge ref; the exact mechanism is `unverified`.
- Workaround: merge the default branch into the bottom of each stack and merge up.
- Code: `skills/attack-plan-milestone-execute/SKILL.md` Step 7, `skills/feedback-watch/SKILL.md` "Reading a failure".

## Job logs and failures

| Fact | Source |
|---|---|
| `GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs` returns a redirect to the job's plain-text log. The link expires after one minute. | REST workflow jobs doc |
| A finished job's log can be fetched while the rest of the run is still going. | `skills/feedback-watch/SKILL.md` "Reading a failure", `unverified` |
| `gh run view --log` waits for the whole run. | `skills/feedback-watch/SKILL.md` "Reading a failure", `unverified` |
| A failed check with no failed step and an annotation such as "runner lost communication" is an infrastructure failure. | `skills/feedback-watch/SKILL.md` "Reading a failure", `unverified` |

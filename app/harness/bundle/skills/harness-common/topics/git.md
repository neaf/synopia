# git

Facts about git that the skills depend on. Checked on 2026-11-25 with git 2.56.0, in throwaway repositories under `mktemp -d` with no user or system config (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`).

Adapter: `skills/harness-common/scripts/git.py` (`Git`, `GitError`, `Conflict`). Used by `skills/attack-plan-milestone-execute/scripts/build_integration_branch.py`. Tests: `skills/harness-common/tests/test_git.py`, `skills/attack-plan-milestone-execute/tests/test_build_integration_branch.py`. Both run git with `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, and `gc.auto=0`, `maintenance.auto=false` through `GIT_CONFIG_COUNT`: an automatic gc left running after a fetch or push removed `maintenance.lock` while the test deleted its folder (seen once).

## `merge-tree --write-tree`

| Fact | Source |
|---|---|
| `git merge-tree --write-tree <a> <b>` computes the merge tree without touching the work tree or the index. | `man git-merge-tree` (git 2.56.0) |
| The mode arrived in git 2.38. | [git 2.38.0 release notes](https://github.com/git/git/blob/master/Documentation/RelNotes/2.38.0.adoc) |
| Exit 0 is a clean merge, 1 a merge with conflicts, anything else an error with unspecified output. | `man git-merge-tree` "EXIT STATUS" (git 2.56.0) |
| With `--name-only`, a conflict prints the tree, then one conflicted path per line, a blank line, then the messages (`CONFLICT (content): ...`). | `man git-merge-tree` "OUTPUT"; `test_git.py` `test_real_conflict` |
| A merge can conflict with no conflicted file (some directory renames), so the path list can be empty. | `man git-merge-tree` "MISTAKES TO AVOID" |
| Two commits with no common history exit 128 with `fatal: refusing to merge unrelated histories`. | `test_build_integration_branch.py` `test_FR_APE_08_a_git_failure_that_is_no_conflict_is_not_reported_as_one` |
| `--name-only` exists in git 2.38. | `unverified`, only 2.56.0 was run |
| Merging a head already contained in the base still succeeds with the base's tree, and `commit-tree` makes an empty two-parent commit from it. `merge-base --is-ancestor <head> <base>` (exit 0 yes, 1 no) tells it first. | `test_FR_APE_08_merging_a_head_already_in_the_target_adds_no_commit` |

### Quirk: old git reports a conflict

- Symptom: on git older than 2.38 a script that reads every non-zero exit of `merge-tree` as a conflict prints `CONFLICT merging <head>`.
- Cause: the option is unknown there, so `merge-tree` fails.
- Workaround: check `git --version` first and stop with `needs git 2.38 or later, found <version>`. Read only exit 1 as a conflict.
- Code: `git.py` `Git.require`, `Git.merge_tree`; `build_integration_branch.py` `MIN_GIT`. Test: `test_FR_APE_08_an_old_git_stops_before_any_fetch`.

## `commit-tree` does not sign

- Symptom: merge commits built with `git commit-tree` show as unsigned on GitHub ("Commits must have verified signatures" blocks the merge), although `commit.gpgsign` is true.
- Cause: `commit-tree` never reads `commit.gpgsign`; only `git commit` and `git merge` do.
- Fix: pass `-S` when `git config --bool commit.gpgsign` is true. `Git.commit_tree` does this.

## A re-signed copy needs you as committer

- Symptom: after re-signing history, GitHub still marks some copies as unverified with reason `unknown_key`, although `git log --format=%G?` shows `G` locally.
- Cause: GitHub verifies a signature against the committer's account. Copies that kept a foreign committer, such as `GitHub <noreply@github.com>` on an "Update branch" merge or a colleague's commit, carry your signature under someone else's name.
- Fix: when copying a commit whose committer email is not `git config user.email`, set `GIT_COMMITTER_NAME` and `GIT_COMMITTER_EMAIL` to yours. Keep the author and the dates.
- Also: a branch merged from a local copy that still holds the old commits brings them back. After a forced rewrite, every clone resets to the new remote heads before working again.

## `commit-tree` needs an identity

- Symptom: `git commit-tree` fails with `Author identity unknown`.
- Cause: no `user.name` and `user.email` are configured. Checked: a repo with no config fails this way.
- Workaround: check `git var GIT_AUTHOR_IDENT` and `git var GIT_COMMITTER_IDENT` before the first commit, and stop with `no git identity: set user.name and user.email (git config)`.
- Code: `git.py` `Git.require_identity`, called by `build_integration_branch.py` `merge` before its first commit. Test: `test_FR_APE_08_a_missing_identity_is_named`.

## Fetch and remote branches

| Fact | Source |
|---|---|
| A default clone has the fetch refspec `+refs/heads/*:refs/remotes/origin/*`, so `git fetch origin <branch>` updates `origin/<branch>`. | Scripted check, full clone |
| A `--single-branch` clone has the refspec `+refs/heads/<branch>:refs/remotes/origin/<branch>` only. | Scripted check |
| `git ls-remote --heads origin <branch>` finds a remote branch whatever the refspec. | Scripted check |
| A failed `ls-remote` or `fetch` (unreachable remote) is not the same as a missing branch: read the exit code, never infer absence from a failure. | `test_FR_APE_08_a_failed_target_lookup_is_not_read_as_absent` |

### Quirk: fetch does not update the remote-tracking ref in a single-branch clone

- Symptom: after `git fetch origin other` in a single-branch clone, `origin/other` does not exist. Only `FETCH_HEAD` is set.
- Cause: the fetch refspec does not cover `other`.
- Workaround: fetch with an explicit refspec, `git fetch origin +refs/heads/<b>:refs/remotes/origin/<b>`, and test existence with `ls-remote` apart from the fetch.
- Code: `git.py` `Git.fetch` (one refspec per branch), `Git.remote_has`. Tests: `test_git.py` `test_fetch_creates_the_tracking_ref_in_a_single_branch_clone`, `test_FR_APE_08_a_single_branch_clone_fetches_every_head`.

## Tags

- Symptom: `git tag <name>` fails and asks for a tag message.
- Cause: a global config with `tag.gpgSign=true` makes every tag an annotated, signed tag.
- Workaround: `git tag -a <name> -m "<message>"`.
- Code: rearchitect Stage 0 tags the base (`skills/rearchitect/SKILL.md`). Source: observed when a rearchitect run tagged `rearch-base` on a machine with `tag.gpgSign=true`.

## `.git/info/exclude` and worktrees

| Fact | Source |
|---|---|
| `info/exclude` lives in the common git dir. A linked worktree resolves `git rev-parse --git-path info/exclude` to the main checkout's `.git/info/exclude`. | Scripted check, `git worktree add` |
| So one exclude file covers every worktree of a repository, and it is never committed. | follows from the row above |

Code: `skills/harness-common/references/state.md` "Private state", cited by `skills/ai-notes/SKILL.md` and `references/publishing.md`.

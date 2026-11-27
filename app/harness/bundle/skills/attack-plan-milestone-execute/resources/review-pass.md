# Review pass

One pass handles every open review thread of the project's PRs at once, in stack order. Run it once CI is green: review comments arrive after CI.

`review_threads.py` below is `/usr/bin/python3 -I <skill>/scripts/review_threads.py`, run from the repository root.

## 1. Collect

List the unresolved threads of every PR with the project label, the integration PR included:

```
review_threads.py list --pr <n> <n> ...
```

It prints one line per thread, `#<pr> <thread id> bot|human <login> <path>:<line> <url> | <first line>`, then `<n> unresolved: <b> bot, <h> human`. `bot` means a bot account started the thread; a deleted account counts as `human`. Read the full comment at its URL when the first line is not enough.

## 2. Check each finding against the code

Read the cited lines on the PR head, not on the default branch. Reviewers, human or review bot, are often right and sometimes not: a component may already hide the button it says is visible, a prop it says is missing may never be read. Decide with evidence, file and line.

## 3. Decide

Write `.ai-notes/<area>/review-pass-<YYYY-MM-DD>.md`:

```markdown
# Review pass, <date>

FIX = change the PR that owns the code. REPLY = no change, a reply with the evidence: this session posts it on a bot thread, the user on a human thread.

| # | PR | thread | by | finding | decision |
|---|---|---|---|---|---|
| 1 | #123 [XX M1-2] | <thread id>, <url> | bot | <one line> | FIX: <what to change> |
| 2 | #124 [XX M1-3] | <thread id>, <url> | human | <one line> | REPLY |

Reply texts:
- 2: "<short answer with the evidence, file:line>"

## Status
- <date>: row 1 fixed in <sha>, merged up to <branches>, thread resolved.
```

- FIX goes to the PR that owns the file, even when the comment was posted on another PR (for example the integration PR). Find the owner with `gh pr diff <n> --name-only` on the stack.
- REPLY texts are short and factual: what is true, with the file and line that shows it. No thanks, no apology. They follow the [writing-craft](../../writing-craft/SKILL.md) skill.
- A finding you are unsure about goes to the user with your recommendation, not to a FIX.

## 4. Apply

1. Launch one fresh subagent per PR that has FIX rows, from the bottom of each stack (`Spawns` in the skill: `general`, tier `default`). Its brief: `subagent-rules.md`, the FIX rows for its PR, the branch. It pushes a new commit and does not resolve threads.
2. Check each fix: it does what the row says and nothing more. Drop extra changes, such as a second guard for a case already covered.
3. Merge each fixed branch up its stack before fixing the next PR (Step 8 of the skill).
4. Once a fix is pushed, resolve its threads if a bot started them: `review_threads.py resolve --thread <id> <id> ...`. It prints `RESOLVED <id>` per thread and refuses a human thread with `REFUSED: <id> human thread (<login>), the user resolves it`, exit 1. Threads a human started stay open for the user, FIX or REPLY: list them in the notes `README.md` pending items with the fix commit.
5. A bot thread decided REPLY: write its text to a file and post it, which also resolves the thread: `review_threads.py reply --thread <id> --body-file <file>`. It prints `REPLIED <id> <url>` and `RESOLVED <id>`. It refuses a human thread (`REFUSED: <id> human thread (<login>), the user replies`) and a resolved one, so a text is never posted twice. After `FAIL <id>: replied, not resolved`, run `resolve` for that thread, not `reply`.
6. Rebuild the integration branch if there is one.
7. Fill the "Status" section, and list the reply texts for human threads in the notes `README.md` pending items for the user. The user posts them: never reply to or resolve a thread a person started.
8. Run `review_threads.py list` again. The pass is done when every line left is `human`.

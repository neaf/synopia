# Open items

The open-items ledger, `.ai-notes/<area>/open-items.md`, as Synopia reads it. The agent and the agent-harness `open-items` skill write it; the skill owns the format (`references/format.md`, checked by `scripts/ledger.py check`). Synopia reads version 1 (FR-ITEM-01) and does not write the file yet. Sources: the skill's format page, `ledger.py` and its tests, read 2026-11-26.

The one reader is `app/backend/src/ledger.ts`. It is pure: the caller reads the file. Test: `app/backend/test/ledger.test.ts`, on `app/backend/test/fixtures/ledger/` (invented ledgers; `checkout-m2.md` and `subagent.md` are the two examples of `format.md`, copied as they are).

## Where a ledger is

`isLedgerPath(abs)`: an absolute path, after `path.normalize`, ending in `/.ai-notes/<area>/open-items.md`, where `<area>` is one folder. `.ai-notes/open-items.md` and `.ai-notes/a/b/open-items.md` are not ledgers. A path a tool names goes through `ledgerPathOf(p, cwd, home)` (relative to the record's `cwd`, `~/` to home); a Bash command through `ledgerPathIn(command, cwd, home)`, which tries each word ending in `open-items.md` (cut at spaces, quotes, `=` and shell operators) and keeps the last ledger. `transcript.ts` uses these for the session's ledger (FR-ITEM-01): the last one the main conversation's Read, Write or Edit or Bash named; a subagent's steps don't count. A ledger edited only by a Bash command that doesn't name it (a heredoc into a variable) is found only once something names it (test: "a ledger a tool names: …"). It is the only path rule: `transcript.ts` uses it to flag a ledger's patches (`ledger: true`), which Files changed leaves out (R5.9; test: `transcript.test.ts` "the open-items ledger: its patches carry `ledger`…", page check `files`).

## The grammar

`parse(text)` returns `{area, version, items, closed, unread}`. Lines split on `\n`, `\r\n` or `\r`; blank and whitespace-only lines are skipped anywhere, also between an item and its fields.

| Line | Shape | Read as |
|---|---|---|
| Title | `# Open items: <area>`, the first non-blank line | `area`; `null` when the first line is something else (that line is unread) |
| Version | `<!-- open-items v<n>. ...` | `version`; `null` when the file has none |
| Section | `## Waiting on you`, `## Claude will check`, `## Closed` | sets where the next items go |
| Open item | `- [ ] <id> · <kind> · <text>` (` · ` is space, U+00B7, space) | an item: `id`, `prefix`, `n`, `kind`, `text`, `box: ' '` |
| Field | `  - <key>: <value>`, two spaces, under an open item | `fields[key]`, in file order |
| Closed, done | `- [x] <id> · answered\|done\|went ahead <stamp> · ...` | `how`, `when`, `notes` (the ` · ` parts after the head) |
| Closed, dropped | `- [-] <id> · dropped <stamp> · <why> ...` | `how: 'dropped'`, `when`, `notes` |
| Closed, superseded | `- [>] <id> · superseded by <id> · <stamp>` | `how: 'superseded'`, `by`, `when` |

- Ids: `Y<n>` only under Waiting on you, `A<n>` only under Claude will check. The id is `prefix` plus the number, so `Y01` reads as `Y1`. `nextId(led, prefix)` is the highest number among open and closed lines, plus one.
- Kinds: `Y` is `decision`, `your task`, `default` or `review`; `A` is `follow-up`.
- Fields, in this order when present: `state` (`answered`, `due`, `later`), `options` (split by ` | `, `optionsOf`), `recommended`, `trigger`, `goes ahead`, `watch`, `subagent`, `raised by`, `answer`, `from`.
- `from`: `<who>, "<session title>", <stamp>[, "<quote>"]`. `fromOf(item)` gives `{who, title, at, quote}`, or `null` for another shape (the item is still read).
- A stamp is `YYYY-MM-DD HH:MM` or `YYYY-MM-DD`. `when` and `at` keep it as written.

### A line Synopia can't read

A line that breaks a rule goes to `unread` as `{line, text, why}`, with its 1-based number, and is never guessed from. The rest of the file is read.

| The line | What else |
|---|---|
| fits no shape (an item's text wrapped onto a second line) | the field lines after it are unread too |
| an item line in the wrong section, or before any section | its field lines are unread too |
| an open item of an unknown kind | its field lines are unread too |
| an id used twice, open or closed | the first line of the id wins; the later one and its fields are unread |
| a field with an unknown key, twice, out of order, or a `state` with another value | the item is read without that field |
| a field under no open item (under a closed line, or after a heading) | |
| a closed line whose head fits no closed shape, a dropped line with no reason, a superseded line with no stamp | |
| a section heading that is unknown, comes twice or is out of order | items under an unknown heading are unread; under a repeated or out-of-order one they are read, as in `ledger.py` |
| a comment that is not the version comment | |

Test: `ledger.test.ts` "two bad lines are listed with their numbers, and the rest is read", "a line that breaks the grammar is never guessed from".

## An item's block

`blockOf(item)` is the item's own lines as written: the item line and its field lines (unread fields included), or the one closed line. Blank lines and moves to another place in the file don't change it. `open-items.ts` keeps each item's last block: a changed block is the agent's record, an unchanged one is not (FR-ITEM-02). Test: "blockOf: the same block for an untouched item, another for a changed one".

## The brief's `Open items:` line

A subagent brief names the ids the subagent owns, with their text: `Open items: Y5 (keep main's Norway rates, answered "Main's"), A2 (re-run the tax specs on #818)`. The skill also sets each owned item's `subagent` field to the subagent's name.

- `ownedIds(prompt)` reads every line that starts with `Open items:` (after spaces, a `- ` or `* ` bullet and `**` bold). An id is a `Y<n>` or `A<n>` token that starts the list, follows `), `, or follows a bare id and `, ` (`Open items: Y2, Y3`). The text in parentheses may hold commas and parentheses. `Open items: none` gives no ids.
- `ownerOf(item, agents)`, over the session's subagents with a brief: the one whose brief names the item's id, while it runs. An item no brief names falls back to the running subagent whose name equals its `subagent` field. Else none (FR-ITEM-04). The brief comes first because it names one agent id, and a name can repeat.

- `transcript.ts` reads the line once, when the Agent (or Task) tool use lands in the main conversation, and keeps only the ids (`ownsOf(toolUseId)`), never the prompt.

Test: "ownedIds: ...", "ownerOf: ..."; `transcript.test.ts` "open items: the last ledger the main conversation named, and the ids each Agent brief owns".

## Quirks

### Quirk: stamps have no zone, and some have no time

- Symptom: an item's age is off by hours, or reads as "since midnight".
- Cause: the skill writes stamps in the writer's local time with no zone, and some real ledgers hold a date with no time (`2026-11-18`). `format.md` asks for `YYYY-MM-DD HH:MM`, and `ledger.py` accepts both.
- Workaround: `stampTime(text)` reads the first stamp in the text as local time and returns `{ms, minute}`. A date-only stamp is that day's local midnight with `minute: false`, so its age reads in days.
- Code: `ledger.ts` `stampTime`. Test: "stamps with no time: read as local midnight, good to the day" (`date-only.md`).

### Quirk: `ledger.py` refuses the whole file for one bad line

- Symptom: `ledger.py check` prints `FAIL` and `ledger.py block` prints nothing for a ledger with one wrapped line.
- Cause: the skill's script is a checker; it fails on any problem.
- Workaround: Synopia lists the bad lines in `unread` and reads the rest. A file `ledger.py check` accepts gives the same open ids (checked by hand on every fixture, 2026-11-26).
- Code: `ledger.ts` `parse`. Test: "two bad lines are listed with their numbers, and the rest is read" (`two-bad-lines.md`).

### Quirk: problems that are not a line

- Symptom: `ledger.py check` fails a file that Synopia shows with no unread line.
- Cause: some of `ledger.py`'s problems belong to no line: a missing section, an empty file, an open item with no `from` field.
- Workaround: Synopia reads such a file as it is: a missing section holds nothing, an item with no `from` has no age (`fromOf` gives `null`).
- Code: `ledger.ts` `parse`. Test: "what ledger.py refuses for the whole file, and Synopia still reads".

### Quirk: a ledger with no version comment

- Symptom: a hand-made ledger has items but no `<!-- open-items v1. ...` line.
- Cause: `ledger.py` checks a comment only when there is one, so a file without it passes.
- Workaround: `parse` reads it as version 1 and returns `version: null`, so a later writer can tell it from a file the skill made (plan question 5: Synopia writes only files with the v1 comment).
- Code: `ledger.ts` `parse`. Test: "another version: the version and no items; no comment reads as version 1".

### Newer versions

A version comment with another number (`<!-- open-items v2. ...`) gives `version` and no items, closed lines or unread lines: Synopia shows "Synopia can't read this ledger's version" and guesses nothing. Test: the same test (`v2.md`).

## Differences from `ledger.py`, on purpose

- Python's `splitlines` also breaks lines at form feed, U+2028 and other separators; `parse` breaks only at `\n`, `\r\n` and `\r`. Python's `\d` matches any Unicode digit; `ledger.ts` matches ASCII digits only. Neither occurs in a ledger the skill writes.

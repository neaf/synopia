# Open items

The open-items ledger, `.ai-notes/<area>/open-items.md`, as Synopia reads it. The agent and the agent-harness `open-items` skill write it; the skill owns the format (`references/format.md`, checked by `scripts/ledger.py check`). Synopia reads version 1 (FR-ITEM-01) and, between turns, writes it back (FR-ITEM-11, "Writing the ledger"). Sources: the skill's format page, `ledger.py` and its tests, read 2026-11-26.

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

## Writing the ledger

`serialize(doc)` writes the whole file from a list (FR-ITEM-11); it is the only code that writes the shapes. The caller (`open-items.ts`, the write-back) passes the area, the file's own version comment line, the open items in list order and the closed items with the time each closed.

- The title, a blank line, the version comment as the file had it (`COMMENT`, the skill's own line, when it had none that fits), then `## Waiting on you` (the `Y` items), `## Claude will check` (the `A` items) and `## Closed`, each always there, as `ledger.py check` wants.
- An item Synopia didn't change is written as its lines were read (`lines`), so the agent's wording and any field Synopia can't read stay. A changed or new one is written in the v1 shape: one line, then its fields in the format's order; a `state` that isn't `answered`, `due` or `later` is left out; every value is one line.
- A closed line: `[x] <id> · answered|done|went ahead <stamp> · <notes>`, `[-] <id> · dropped <stamp> · <why>` (`no longer needed` when there is none), `[>] <id> · superseded by <id> · <stamp>`. A ` · ` inside a note becomes ` - `, so the line splits as written.
- Closed lines kept: the newest 30 by close time and the closed line of the highest id of each prefix, as `ledger.py prune` keeps them, oldest first. Synopia's own list keeps more (FR-ITEM-02); a number Synopia retired without a line in the file is not in the file, so `ledger.py next` may give it again; Synopia renumbers its own item on such a clash (FR-ITEM-02).
- An item Synopia found has `from: Synopia, "<session title>", <local stamp>, "<quote>"` (`open-items.ts` `fromField`; a `"` in the title or quote becomes `'`, so the `from` shape still reads). A `from: Synopia` item adopted from a file is "found by Synopia" (a dashed box), review items aside.

Test: `ledger.test.ts` "serialize: …": a fixture read and written unchanged keeps every block and is stable; Synopia's items and closes; the 30-line rule; and, when the skill's `ledger.py` is on the Mac (`~/dev/agent-harness/…`, or `LEDGER_PY`), every text the tests wrote passes `ledger.py check` (a dev check: `check.sh` doesn't depend on it, and skips it elsewhere).

### When Synopia writes it

`open-items.ts` `writeBack` (FR-ITEM-11): only a ledger whose list Synopia changed (a keeper op, `d`, Undo, Mark reviewed, a review item it opened); only when no session using it has a turn running (Synopia's process working, or the transcript's open turn for a terminal's session); after reading and merging the file again, so the agent's changes come first; only a file whose version 1 comment is there (plan question 5: only the skill and `ledger.py init` write it; a file without it, or another version, is never written) and that has no line Synopia can't read (a rewrite would lose it); and not when the file's size or mtime changed since that read (a terminal's turn wrote it: the next look reads it and tries again). The write is a temporary file beside it renamed over it, with the file's mode. Test: `open-items.test.ts` "the write-back: …", "the write-back leaves alone …".

## The keeper's batch

`app/backend/perf/keeper-batch.ts` (opt-in, outside `check.sh`; one model call per case and model): the real `keeper.ts` prompt and `checkOps` on the 59 invented exchanges of `perf/keeper-cases.json` (12 of your messages, 34 turns, 8 with subagent reports, 5 reopen or supersede cases; 21 expect no op; a case's `work` lines go in the prompt's `<work>`, in `transcripts.ts` `work`'s shape), scored against the expected ops. An op matches by `op` plus the kind (open) or the id with its `as` or `state`. It prints numbers only: cases exact (every expected op and nothing more), recall, precision, extra ops, no-op cases left alone, ops the checks dropped, failures, median time. `-v` adds the missed cases as op shapes and ids.

Run 2026-11-27 (SDK 0.3.330, its bundled CLI), twice: before and after one prompt change.

| Run | Model | Exact | Recall | Precision | No-op cases | Dropped by the checks | Median |
|---|---|---|---|---|---|---|---|
| first prompt | sonnet | 43/50 | 35/42 (83%) | 35/39 (90%) | 16/17 | 2 | 2.6 s |
| first prompt | haiku | 43/50 | 35/42 (83%) | 35/38 (92%) | 16/17 | 4 | 2.9 s |
| after the change | sonnet | 43/50 | 37/42 (88%) | 37/40 (93%) | 16/17 | 4 | 2.8 s |
| after the change | haiku | 45/50 | 39/42 (93%) | 39/42 (93%) | 15/17 | 2 | 2.9 s |

- The change, from the misses of the first run: "go" or "do it" after proposals closes those defaults as went ahead; "remind me to" is a follow-up; an answered item closes as done once the reply shows Claude acted; a report may close its own default as went ahead (also allowed by `checkOps` from then on). No case was changed to fit a model.
- Misses both models share after the change: an answer that fits two decisions read as one (the rule says ask, not guess); an answered item the reply acted on left open; superseded read as dropped. Each costs a stale item or a wrong close you can Undo.
- The gap between the two models is within the run-to-run change (a model's score moved by up to 2 cases between runs). The keeper stays on `sonnet` as decided (design question 3); `settings.keeperModel` takes `haiku`.

The table above is the 50-case batch with the first rules. 2026-11-27, the noise rule (R3.16 "What the list holds"): the prompt now opens a follow-up only when nothing else brings it back, never for the next step of work in motion, one for work in motion that died (stuck), and never closes a review item as done from Claude's reply (also refused by `checkOps`). Nine cases pin it (c51 to c59: a subagent launched with "I'll merge it when green", a CI watcher, a scheduled wakeup and reports still to come open nothing; a follow-up that only tracked a running subagent drops; a review subagent killed before it delivered opens one stuck follow-up; a stopped subagent's review item drops; an outside event no watcher covers and a step left at a handoff open a follow-up). Their first run, with the rules before and after the change, is still to do: on 2026-11-27 every call failed on expired model credentials, so no scores are recorded for the 59 cases yet.

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

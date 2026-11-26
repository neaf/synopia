# Open items: what waits on you, kept by AI

Design proposal, 2026-11-26. Nothing here is built or decided. The storyboard beside it, `prototype/open-items-storyboard.html`, draws the same design. Examples are invented.

## The problem

A long session is a running exchange of loose ends on both sides. A typical reply ends with a "Done" list, then a "Waiting on you" list that mixes four kinds of thing:

- a decision Claude needs ("run `bin/schema-lint --fix` now, or look at the 14 warnings first?");
- a task only you can do ("answer the 2 review threads from Mira on #812");
- something Claude will check again later ("#820 shows conflicting; I'll re-check after the M2 stack merges");
- a proposal that goes ahead unless you object ("I'll mark them ready in this order; tell me if you want another").

You answer one by quoting it and writing "Run it". The next reply rewrites the list by hand, and items fall out: a follow-up nobody re-checks, a proposal that never went ahead, a decision asked twice.

What you asked for (2026-11-26): the base runs on AI alone, so it works in any harness; Synopia adds to it. You never maintain the list. AI finds the items in the conversation, yours and Claude's, and closes them when they are answered or done, from plain prose.

## The design in short

- **An open item** is one loose end with an owner: waiting on you (Y1, Y2…) or on Claude (A1, A2…). It has a kind, a state, a trigger for follow-ups and the quote it came from.
- **The base is a skill, `open-items` (in agent-harness: `skills/open-items/SKILL.md`), and one file per area: `.ai-notes/<area>/open-items.md`.** Every turn the session's own agent reads the file, closes what your message answered, opens what its reply leaves open, re-checks due follow-ups, and writes the reply's "Waiting on you" block from the file. This works in the Claude Code CLI with no Synopia.
- **Synopia adds a second reader, the keeper.** After each of your messages and each turn, a one-shot model call, like the one that writes titles today (`app/backend/src/writer.ts`), reads the exchange and the list and returns typed changes. It catches what the agent forgot and keeps a list for sessions that never loaded the skill.
- **Synopia keeps one list per ledger, in its own state, and is its only writer.** Your actions, the agent's records and the keeper's changes are inputs to that list, applied by fixed rules. Synopia writes the ledger file back, so the CLI and a handoff see everything.
- **You answer in prose.** "Run it" under a quoted line closes that item. Ids are a shortcut ("Y1 run it, Y3 later"), never a requirement. Synopia's chips only write that prose into the message box.
- **Synopia shows it** in the background panel ("Waiting on you", "Claude will check"), as a sidebar line under each session ("○ 4 waiting on you"), and in one list across sessions, opened with `w`.

## 1. The model

### An item

| Field | What it holds | Example |
|---|---|---|
| id | `Y` + number when it waits on you, `A` + number when it waits on Claude. Numbers count up per ledger and are never reused. | `Y3`, `A1` |
| kind | decision, your task, follow-up, default | decision |
| text | one sentence, the thing itself, as you would say it | Run `bin/schema-lint --fix` now, or look at the 14 warnings first? |
| options | for a decision with set answers | Run it, Look first |
| recommended | the option Claude would pick | Look first |
| trigger | for a follow-up: when to check again; for a default: when it goes ahead | after the M2 stack merges; when CI is green on #812 to #815 |
| state | open, answered, due, later, done, went ahead, dropped, superseded | open |
| source | who recorded it (Claude, the keeper, you), the session, the time, and a quote of the words it came from | Claude, "Ship checkout M2", 14:02, "Should I run…" |

Four kinds, by who acts and whether anything blocks:

| Kind | Who acts | Blocks Claude? | Closes when |
|---|---|---|---|
| decision | you choose, Claude acts | the part it covers | you answer |
| your task | you | no | you say it's done, or the work shows it (threads resolved, PR approved) |
| follow-up | Claude, on a trigger | no | Claude checked and acted |
| default | Claude, unless you object | no | it went ahead, or you objected |

A decision, your task and a default are `Y` items: each needs your eyes. A follow-up is an `A` item: it needs nothing from you, and you see it only so that nothing is silently forgotten.

### Ids

Ids exist so a reply can list items and you can point at one. Two prefixes, not one per kind: you only need to know whether it waits on you. The number is per ledger, so two sessions sharing an area share one series, and "Y3" means the same item in the CLI, in Synopia and after a handoff. A closed id is never given again.

### Lifecycle

```
            ┌──────────── answered ──── done
opened ─────┤                         (Claude acted on your answer)
 (open)     ├──── later  (you deferred it; it returns at its trigger or the next session)
            ├──── due    (a follow-up's trigger fired; Claude checks it this turn)
            ├──── went ahead  (a default whose trigger came with no objection)
            ├──── dropped     (no longer needed: the PR closed, the plan changed; with why)
            └──── superseded by Yn  (replaced by a better-worded or merged item)
```

- **Opened** by Claude's reply (a question, a proposal with "tell me if…", "I'll check after…"), by your message ("I'll review it tonight" opens a task of yours, "remind me to…" a follow-up), or by the work (a review thread from a person arrives).
- **Answered** when your message settles it. The item stays visible as "answered" until Claude has acted, so you see it was heard.
- **Done** when the work shows it: the command ran, the threads are resolved.
- **Dropped** with a reason, never silently. **Superseded** names its successor.
- Closed items stay in the file's "Closed" section, the newest 30, so a wrong close can be undone and a new session can see what was settled.

### Answering

Plain prose works, and that is the main path. Ids are a shortcut.

| You write | What closes |
|---|---|
| A quote of one line, then "Run it" | the quoted item, answered with "Run it" |
| "Run it" with one decision open whose options include it | that decision |
| "Y1 run it, Y3 later" | Y1 answered "run it"; Y3 set to later |
| "done with the review threads" | the your-task item about the review threads |
| "skip the worktrees" | the worktree decision, dropped, "you said skip" |
| "go" after a list of three proposals | all three defaults go ahead |
| "Run it" with two decisions open that both fit | nothing yet: Claude asks in one line which one |

The last row is the rule for doubt: an ambiguous answer is asked about, never guessed. A wrong close costs more than one short question.

## 2. Who keeps the list

You never curate it. Two AI readers keep it, and one piece of code owns it.

### Reader 1: the session's agent, through the skill

Each turn the agent sees your whole message and does the work, so it knows best what was answered and what it left open. It forgets when the skill isn't loaded, after a long compaction, or in a session that started without it.

### Reader 2: Synopia's keeper

A one-shot call per event, built like the title writer (no tools, no MCP servers, no hooks, a fixed system prompt, its own scratch folder). It reads:

- the current list (ids, kinds, texts, states);
- the new exchange: your message, or Claude's reply with a one-line summary of each tool step and its result;
- the `<work>` block the writer already gets: running shells and monitors, cards waiting.

It returns JSON only, never prose for code to read:

```json
{"ops": [
  {"op": "open", "kind": "decision", "owner": "you", "text": "Can I remove the two worktrees?",
   "options": ["Yes", "Keep them"], "quote": "Can I remove these two worktrees"},
  {"op": "close", "id": "Y1", "as": "answered", "answer": "Run it", "quote": "Run it"},
  {"op": "close", "id": "Y2", "as": "done", "quote": "unresolved threads: 0"}
]}
```

Synopia's code checks every op before it applies it:

- the `quote` must be a verbatim substring of the exchange it was given: no quote, no op, so the keeper can't invent an item from nothing;
- the id must exist and be open; the kind, owner and `as` must be known values; the text is cut as titles are;
- at most 8 ops per call;
- anything that fails is dropped and logged, never repaired.

It runs twice per exchange: right after you send (to mark answers at once) and after the turn ends (to open, close and catch what the agent missed). Model calls are free on this machine (R3.4). Each call reads the list and one exchange, cut to 12,000 characters as the writer cuts its turns: about 4,000 tokens in and 300 out. It runs in its own queue, so titles don't wait behind it.

### Ownership options

| Option | How | Verdict |
|---|---|---|
| **A. Synopia owns one list per ledger; the file is its projection.** | The list lives in `state.json`, keyed by the ledger's path (or by session when there is no file yet). One module (`items.ts`) is its only writer. Your actions, the agent's records and the keeper's ops are its inputs. Synopia writes the file back after each change. | **Recommended.** One owner, one id allocator, and the CLI, a handoff and a new session read one file that holds everything, the keeper's finds too. |
| B. The file owns; the agent and the keeper both write it | The keeper's ops are applied to the markdown file. | Two writers on one file race when a turn edits it while the keeper writes, and Synopia's own facts (inferred, undone, dismissed) have nowhere to live but in your repo. |
| C. Two lists, shown side by side | The agent's file, and the keeper's own list. | The same item shows twice, the two drift, and you become the one who merges them. |

### The rules of option A

1. **One writer.** Only `items.ts` changes the list. Every change is an op with a source: you, the agent or the keeper.
2. **Ids come from the list.** The agent gets an id from the `open_items` tool when Synopia runs it. In a session a terminal holds, the agent picks the next number in the file; Synopia adopts it. If the keeper took that number in the same window, the agent's item keeps it (it is the one in the reply you read) and the keeper's item moves to the next free number.
3. **Newer evidence wins; on the same exchange, the order is you, then the agent, then the keeper.** The agent's records are its tool calls, or the lines it changed in the file during the turn. A line it left as it was is not a record: an item the keeper closed stays closed even though the agent's file still says open.
4. **The keeper marks what it did.** An item the keeper opened, or closed, carries "found by Synopia" or "closed by Synopia" until the agent or you touch it. Shape carries it: a dashed id box, against Claude's solid one.
5. **The file is written only between turns.** Synopia writes `open-items.md` when no turn of any session holding that ledger runs, after it has read and applied the file's own changes. A turn that starts first wins the file; Synopia writes after it ends.
6. **No ledger file, no file write.** For a session that never used the skill, the list lives only in Synopia's state, keyed by the session. It gets a file the first time the agent names one (a tool call, or a `Write` or `Edit` of an `open-items.md` in the transcript).

### Wrong guesses

| Wrong | You see | It's fixed by |
|---|---|---|
| A false item (a rhetorical question taken as a decision) | a new item with the dashed id box | `d` on it in the panel ("Not an item"), or the next reconcile, when the keeper sees the agent ignored it and the conversation moved on. A dismissed text is never opened again in that ledger. |
| A missed item | nothing in the list | the second reader: when the agent misses it, the keeper sees the reply; when the keeper misses it, the agent's next reply lists it. You can also just say "you forgot the deploy check": that sentence opens it. |
| A wrong close | a line under "Closed this turn" with Undo, for one turn | Undo, or saying so ("Y2 isn't done"), which reopens it |
| A wrong answer match ("Run it" closed Y3, you meant Y1) | the closed line names what it read: "Y3, you said Run it" | Undo on it, or "I meant Y1" |

You never add, edit or reorder items by hand. The only keys are `d` (not an item) and Undo (for one turn after a close), and both are corrections, not curation.

## 3. The base: the `open-items` skill

### Where the ledger lives

`.ai-notes/<area>/open-items.md`, in the area the work already uses. A session with no area creates one the first time a reply ends with an item still open, named after the work, with the README the ai-notes skill requires. One ledger per area. Sessions that share an area share its ledger.

### The format

Markdown a person reads at a glance, with a fixed line shape so code can read it with no model. Version 1:

```markdown
# Open items: checkout-m2

<!-- open-items v1. Kept by AI: the open-items skill, and Synopia when it runs the session. Don't edit by hand; say it in the session instead. -->

## Waiting on you

- [ ] Y1 · decision · Run `bin/schema-lint --fix` now, or look at the 14 warnings first?
  - options: Run it | Look first
  - recommended: Look first
  - from: Claude, "Ship checkout M2", 2026-11-26 14:02, "Should I run `bin/schema-lint --fix`"
- [ ] Y2 · your task · Answer the 2 review threads from Mira on #812.
  - from: Claude, "Ship checkout M2", 2026-11-26 14:02
- [ ] Y4 · default · Mark #812 to #815 ready in this order: #812, #814, #813, #815.
  - goes ahead: when CI is green on all four, unless you object
  - from: Claude, "Ship checkout M2", 2026-11-26 14:02
- [ ] Y5 · decision · Can I remove the worktrees ~/dev/shop-wt-cart and ~/dev/shop-wt-tax?
  - options: Remove both | Keep them
  - from: Synopia, "Ship checkout M2", 2026-11-26 14:02, "Can I remove these two worktrees"

## Claude will check

- [ ] A1 · follow-up · Re-check #820, which GitHub shows as conflicting.
  - trigger: after the M2 stack merges
  - watch: feedback-watch pr 812 813 814 815
  - from: Claude, "Ship checkout M2", 2026-11-26 14:02

## Closed

- [x] Y3 · answered 2026-11-26 14:05 · "Run it" · done: 14 entries added to the todo file
- [-] Y6 · dropped 2026-11-26 15:10 · #818 was closed
- [>] Y7 · superseded by Y9 · 2026-11-26 15:12
```

- Box marks: `[ ]` open (with `- state: answered`, `due` or `later` as a field when it isn't plain open), `[x]` answered, done or went ahead, `[-]` dropped, `[>]` superseded.
- One item is one line plus indented `- key: value` fields. The text never wraps onto a second line.
- A line that doesn't fit the shape is shown as it is and left alone: Synopia lists it as "1 line Synopia can't read" and never guesses from it.
- The format is pinned by a test, and its rules and any quirks go in one topic doc (`docs/Open items.md`), as for every format Synopia reads.

### Every turn

At the start of the turn:

1. Read the ledger (it is short; the skill keeps it under about 2,000 tokens with the newest 30 closed lines).
2. Read your message for answers, asks and promises. Close what it answers, by id, by quote or by plain reference. Open what it asks for or promises: "I'll do X" is your task, "remind me" or "later" is a follow-up or a later. Ask in one line when an answer could mean two items.
3. Check the follow-ups whose trigger can be checked now (a PR's state, a CI run, a file). A fired trigger makes the item due: act on it in this turn.

During the turn:

4. When a trigger can be watched, arm a watcher for it (feedback-watch for pull requests, a monitor for a command or a file) and name it in the item's `watch` field. Its line starts the next turn.

At the end of the turn:

5. Open what the reply leaves open: each question you ask, each proposal you'll act on unless told otherwise, each "I'll check after…".
6. Close what the turn did: a decision you acted on, a follow-up you checked, a default that went ahead.
7. Write the ledger, then write the reply's last block from it.

### The reply's block, written from the ledger

The reply ends with one block, always in this shape, generated from the ledger after it is written, never retyped from memory:

```markdown
**Waiting on you** (4)
- **Y1** decision: Run `bin/schema-lint --fix` now, or look at the 14 warnings first? (I'd look first)
- **Y2** your task: Answer the 2 review threads from Mira on #812.
- **Y4** goes ahead when CI is green: mark #812 to #815 ready, #812 first. Say if you want another order.
- **Y5** decision: Can I remove ~/dev/shop-wt-cart and ~/dev/shop-wt-tax? (new)

**Claude will check** (1)
- **A1** after the M2 stack merges: re-check #820's conflict.

Closed this turn: Y3 (you said "Run it": 14 entries added).
```

- Every open `Y` item is listed, in id order, every turn, so nothing drops out of sight. New ones say "(new)".
- `A` items are listed only when one is new, due, or changed, so the block stays short.
- With nothing open, the block is one line: "Nothing waits on you."

### A new session and a handoff

- **A new session** in the area reads `open-items.md` with the area README. Its first reply that touches the work ends with the block.
- **A handoff** (the ai-notes skill's "Handing off to a new session") lists `open-items.md` first under "Where to read". The old session's last reply says "Handed off: Y1, Y2, Y4, Y5 and A1 are in <new session's title>". The ids stay as they are.

### Tasks and TodoWrite

Claude Code's task tools (`TaskCreate`, `TaskUpdate`, `TaskList`, `TaskGet`, and `TodoWrite` in place of them when `CLAUDE_CODE_ENABLE_TASKS=0`) are the agent's working list for the job in front of it: steps it plans, works through and ticks. The ledger is the contract with you across turns and sessions.

- They don't overlap: a task is a step Claude takes; an item is something that waits on someone. A task that waits on you becomes a `Y` item; a ticked task is not an item.
- The ledger can't be built on them. As of Claude Code v2.1.268 the docs say the task tools are on by default only on Opus 4.7, Sonnet 4.6, Haiku 4.5 and earlier models, and off on newer ones unless you opt in. A shared list (`CLAUDE_CODE_TASK_LIST_ID`) lives in `~/.claude/tasks/`, outside the repository, and only Claude Code reads it.

### Its own skill, or a section of ai-notes

| Option | Verdict |
|---|---|
| **Its own skill, `open-items`, with ai-notes pointing at it** | **Recommended.** The every-turn rules apply in sessions with no notes area, its body stays small enough to survive compaction (Claude Code re-attaches the first 5,000 tokens of an invoked skill), and other skills (attack-plan-milestone-execute, qa-session) can point at it for their pending items. |
| A section of the ai-notes skill | ai-notes loads when notes matter, not every turn, and is already long; the per-turn rules would be one more section to forget. |

What changes in ai-notes when this is adopted: its "State (start here)" stops listing "the pending items split between the user and the agent" and links `open-items.md` instead; its "To do" keeps only work with no one waiting (cleanups, ideas); "Open questions" keeps unverified facts, and a question for you becomes a `Y` item. One fact in one place.

### Where the skill lives: agent-harness

Your skills have one source, the agent-harness repository, installed as symlinks into Claude Code and opencode by its `install.py`. The base lands there, in one commit, under that repo's rules: a behaviour change updates its requirements and architecture in the same commit; no model name or id anywhere in it; it works in both Claude Code and opencode; facts about each tool go in its topic docs, with evidence or marked unverified; scripts run on `/usr/bin/python3 -I` with the standard library only. Nothing is written there until you decide.

| Path in `~/dev/agent-harness/` | What it gets |
|---|---|
| `skills/open-items/SKILL.md` | New. The model, the every-turn rules, the reply's block, handoff, the relation to task tools. Under 5,000 tokens. |
| `skills/open-items/references/format.md` | New. The version 1 grammar of `open-items.md`, with one example. |
| `skills/open-items/scripts/ledger.py` | New. `check <file>` (the file fits the grammar), `next <file> Y` (the next free id), `block <file>` (prints the reply's "Waiting on you" block). With `block`, the reply's list is printed from the file by code, not retyped. |
| `skills/open-items/tests/` | New. Pins the grammar and the block, on invented ledgers. |
| `skills/ai-notes/SKILL.md` | "State (start here)" links `open-items.md` instead of listing pending items; "To do" and "Open questions" as above; the handoff lists `open-items.md` first under "Where to read". |
| `skills/attack-plan-milestone-execute/SKILL.md`, `skills/qa-session/SKILL.md` | Their "pending items split between the user and the agent" point at the skill. |
| `instructions/global.md` | The one always-loaded line (below). `install.py` copies it to `~/.claude/CLAUDE.md` and `~/.config/opencode/AGENTS.md`. |
| `docs/requirements.md` | A new section, "Open items (OI, skill open-items)", one id per rule. |
| `docs/architecture.md` | The skill and `ledger.py` as modules, the ledger as data, the requirement-to-module rows. |
| `skills/harness-common/topics/Claude Code.md`, `opencode.md` | The facts the skill relies on: task tools and their availability, hooks, skill loading and compaction; for opencode, the same facts or `unverified`. |
| `README.md` | One row in the skills table. |

The ledger file itself lives in each project's `.ai-notes/`, not in agent-harness.

### Making it run every turn

A skill's body loads only when it is invoked; until then the agent sees only its description. So:

- One line in the global rules (`instructions/global.md` in agent-harness), which both tools always load: "When a reply leaves anything waiting on the user or on you, follow the open-items skill."
- Optional, Claude Code only: a `SessionStart` hook (on `startup`, `resume` and `compact`) that prints `ledger.py block` for the folder's ledgers as context, and a `Stop` hook that checks with `ledger.py` that the reply's last block names every open `Y` id in the ledger, and blocks once with the missing ids. Both are deterministic. Neither is needed for the base to work. Whether opencode has an equivalent is unverified; its topic doc gets the answer before anything depends on it.

## 4. The Synopia layer

Each layer is optional and works without the next.

### 4.1 Synopia reads the ledger

`items.ts` reads `open-items.md` for each open session's area (the area is the folder of an `open-items.md` the session read or wrote, from the transcript's tool steps), parses it by the version 1 grammar, and holds the list. This alone gives the panel and the sidebar their data, with no model and no tool.

### 4.2 The keeper

As in section 2. It turns on for every session Synopia shows, the ones with no skill too. Its output is ops, checked by code; Synopia never reads items out of prose with code.

### 4.3 The `open_items` tool

A second tool beside `start_session` (R3.15, `app/backend/src/agent-tools.ts`), so the agent records items as typed calls instead of file edits:

| Call | Input | Returns |
|---|---|---|
| `open` | kind, text, owner, options?, recommended?, trigger?, quote | the new id |
| `update` | id, state (answered, due, later), answer?, text? | the item |
| `close` | id, as (done, went ahead, dropped, superseded), why?, by? | the item |
| `list` | none | the open items and the newest 10 closed, as text |

- No permission card: unlike `start_session`, it changes nothing outside Synopia's list and its file. Its steps show in the transcript as `Open items(Y5: Can I remove the worktrees?)`.
- With the tool present, the skill tells the agent to use it instead of editing the file; Synopia writes the file. Without the tool (the CLI, a terminal holding the session), the agent edits the file and Synopia reads it.

### 4.4 In the session: the background panel

Two groups in the right panel, under "To review" and above "Past", in the panel's existing type and lines:

- **Waiting on you** (count): one block per `Y` item. Its id in a 1px box (solid when Claude recorded it, dashed when Synopia found it), the kind word, the text in up to two lines, and its age. A decision shows its options as small buttons, the recommended one marked; your task shows "Done"; a default shows when it goes ahead and "Object".
- **Claude will check** (count): one line per `A` item, its trigger, and the watcher's mark when one runs.
- **Closed this turn**: one dim line per item closed in the latest exchange, like a Past line, with what closed it ("you said Run it") and Undo.

A button writes prose into the message box and never sends: an option writes `Y1 Run it`, "Done" writes `Y2 done`, "Object" writes `Y4 wait: `, each on a new line of the draft, in insert mode. You add more or send with Enter. The box stays the one way to answer.

A click on an item's text scrolls the transcript to the reply it came from and marks it as To review does. `d` on a focused item says "Not an item"; the item goes to Closed this turn with Undo.

The panel shows when the session has background work or open items.

### 4.5 Status and the sidebar

- **The session stays "Your turn".** Open items don't make it "Needs you": in a long session something nearly always waits on you, and red would stop meaning "blocked". Needs you stays for the cards of R6.
- **A sidebar line under the session:** "○ 4 waiting on you", with the hollow circle the card uses for "not answered", like "2 to review". With a due follow-up it adds "1 due". A click opens the session with the panel's first item focused.
- **The writer's Now line** may name the oldest decision ("Your turn: Y1, run the lint fix or look first"), since it already reads the cards waiting.

### 4.6 Across sessions: the Waiting on you list

`w` in normal mode, or a click on the "○ 7 waiting on you" button in the sidebar's head, opens a list over the main area, built like the Open list: every open `Y` item of every open session, grouped by session in sidebar order, each row with its id, kind, text and age. `j`/`k` move, Enter opens that session with the item's answer started in its box (`Y1 `), Esc closes. Typing filters, as in the Open list.

## 5. Options where the choice is real

| Question | Options | Recommended |
|---|---|---|
| Who owns the list | A. Synopia's one list, file as projection; B. the file, two writers; C. two lists | A: one owner, one id series, and the file still carries everything |
| Where it shows in a session | A. groups in the background panel; B. a card above the message box; C. live in the transcript's replies | A: the panel already holds what runs beside the conversation, and it doesn't take the transcript's space or look blocking like a card |
| Where it shows across sessions | A. a list over the main area by `w`; B. a "Waiting on you" group pinned in the sidebar; C. sidebar lines only | A: all items in one place with the sessions' order, and the sidebar stays one row per session |
| Status | A. "Your turn" with a sidebar line; B. "Needs you" while a decision is open | A: Needs you keeps meaning blocked |
| When an inferred change applies | A. at once, marked, with Undo; B. only after the agent confirms it next turn | A: you asked for a list that keeps itself; B leaves it a turn behind |
| Where the base rules live | A. own skill `open-items`; B. a section of ai-notes | A, as in section 3 |

## 6. Phases

1. **The skill, in agent-harness.** `skills/open-items/` with the format, `ledger.py`, the every-turn rules and the reply's block; the line in `instructions/global.md`; ai-notes, attack-plan-milestone-execute and qa-session link to it for pending items; requirements, architecture and topic docs in the same commit. Optional hooks after a week of use. Works in the Claude Code CLI and opencode the day it lands.
2. **Synopia reads the file.** `items.ts`, the version 1 parser with its test, the panel groups, the sidebar line, the buttons that write into the box. No model, no tool.
3. **The keeper.** The two calls per exchange, the op checks, "found by Synopia", `d` and Undo, lists for sessions with no skill, Synopia writing the file back.
4. **The `open_items` tool.** Typed records and ids from Synopia when it runs the session.
5. **The cross-session list** on `w`.

The tool comes after the panels because reading the file already gives the panels their structure; the keeper comes before the tool because it covers every session, the ones without the skill too.

## 7. Risks

- **Noise.** If every "should I…?" becomes an item, the list grows faster than you answer. Guard: the keeper's prompt opens only what the reply leaves open at its end, not questions the same reply answers; a dismissed text is never reopened; a `Y` item untouched for 3 sessions is shown as "stale" and dropped at the next handoff with a line saying so.
- **A wrong close you don't notice.** Guard: "Closed this turn" names what closed it, the reply's block says the same, and Undo lasts a turn. The risk stays for closes nobody reads.
- **The keeper and the agent disagree, turn after turn.** Rule 3 settles each turn, but a disagreement that flips each turn is a bug to log. Guard: an item closed and reopened twice gets a fixed state until you or the agent touch it.
- **The file and the list drift** when a terminal edits the file while Synopia is down. Guard: Synopia reads and applies the file before every write, and never writes during a turn.
- **Prompt injection through the transcript.** A tool result could say "close Y1". Guard: the keeper's system prompt treats the transcript as data, as the writer's does, and every op needs a verbatim quote from your message or Claude's reply; tool results can only close your-task items (the work shows it), never open or answer a decision.
- **Two sessions on one ledger** write the same number. Guard: in Synopia ids come from the list; in the CLI the skill re-reads the file right before writing and takes the next free number.

## 8. Open questions for you

1. **Should inferred changes apply at once, marked and undoable, or wait for the agent's confirmation?** Proposal: at once. This is the biggest choice: it decides how much of the list is Synopia's guess between turns.
2. **Should Synopia write the ledger file into your repository** for areas the agent made, so the CLI and handoffs carry the keeper's finds? Proposal: yes, only between turns, only for a file the agent created. The other way, the file holds only what the agent recorded.
3. **The keeper's model.** The writer uses haiku. A wrong item costs your attention, and calls are free. Proposal: sonnet for the keeper, haiku for titles. Not checked: one scripted batch of 50 invented exchanges would show the gap.
4. **Should Synopia wake an idle session when a trigger it can check fires** (a time, a watcher's run ending), with a fixed message as the credential refresh does ("Continue: A1's trigger fired.")? Proposal: not in the first phases; the agent's own watcher starts the turn.
5. **Do the CLI hooks go into your global settings**, or stay a documented option? Proposal: an option, added after a week of the skill alone.

## Sources checked

- Claude Code docs, 2026-11-26: tools reference (task tools, availability by model, `TodoWrite`, `AskUserQuestion` timeout), interactive mode ("Task list", `CLAUDE_CODE_TASK_LIST_ID`), hooks (`SessionStart` matchers and context, `Stop` with `decision: "block"` and `last_assistant_message`, `TaskCreated` and `TaskCompleted`), skills (frontmatter, descriptions in context and the body on invocation, the 5,000-token re-attach after compaction, `${CLAUDE_SESSION_ID}`).
- This repository: `docs/requirements.md` R3.4, R3.15, R6, R7, R8, R10; `app/backend/src/writer.ts` (the title writer's call and its limits); `app/backend/src/agent-tools.ts` (`start_session`).
- The skills ai-notes (State, To do, Open questions, handoff), feedback-watch, attack-plan-milestone-execute and qa-session, for how pending items are kept today.
- agent-harness `AGENTS.md` and `README.md`: skills live in `skills/<name>/`, installed as symlinks by `install.py`; requirements and architecture change with a behaviour; no model names; Claude Code and opencode both.

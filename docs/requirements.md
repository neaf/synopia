# Synopia requirements

Synopia is a desktop app for one person who runs several Claude Code sessions at the same time. It replaces "Claude in iTerm tabs" with one window that shows every open session at a glance, says which one needs the user, and lets the user chat in any of them.

These requirements come from a day of prototyping against the user's real sessions (2026-11-23). The prototype in `prototype/app.html` is the UI reference: when a requirement and the prototype disagree on look, the prototype wins; when they disagree on behaviour, this document wins. Each section ends with what was tried and rejected, so it doesn't come back.

## 1. Who it's for and the job

- One user, one machine, usually one repository (`~/dev/demo-project`) with several worktrees, many parallel sessions, each using subagents, forks, background shells and monitors heavily.
- The problems it solves:
  - Switching between iTerm tabs named by hyphenated slugs.
  - Asking every session "how are we doing" and "so what, what's next".
  - Missing the one session that is blocked on the user.
  - Sessions being abandoned instead of closed.
- Design stance: cockpit. Everything important must be readable at a glance, without reading. The user's daily reference is iTerm with the Claude Code CLI.

## 2. Platform

- R2.1 Synopia runs in its own app window, not a browser tab, so keyboard shortcuts such as ⌘⇧[ and ⌘⇧] reach the app. The user does not want it in Brave. The app is a native Swift shell with a WKWebView, and a Node backend that runs the sessions. It is built locally, with nothing downloaded that Jamf could block. No Electron.
- R2.2 It drives sessions through the Claude Agent SDK. No Claude Desktop, no terminal UI: the terminal was rejected because its layout options are too limited.
- R2.3 Auth is whatever the user's Claude Code settings use. Today that's Amazon Bedrock through `~/.claude/settings.json` `env`, with an AWS SSO refresh. Synopia never prints or stores credentials.
- R2.4 The user's skills, slash commands, `CLAUDE.md`, hooks and subagent definitions load as they do in the CLI.
- R2.5 The app has an icon and a favicon (section 13).
- R2.6 The Dock icon shows a badge with the number of things waiting on the user (decided 2026-11-23):
  - each open session that needs you (a pending question, permission or plan: the red "Needs you" of R6.1)
  - each deliverable waiting for review (a finished `For review: ` subagent not yet marked reviewed, R10.1; the same count as "N to review" in the sidebar)
  - Closed sessions don't count. At 0 there is no badge. No notifications: they were rejected (2026-11-23).
- R2.7 The window has an integrated title bar, the unified look of Slack and Linear (decided 2026-11-24):
  - no visible title bar: the traffic lights sit over the dark sidebar's top-left, in a strip of the sidebar colour. The window keeps the title "Synopia" for Mission Control and the Window menu.
  - a drag on the sidebar's top strip, beside the traffic lights, moves the window, and a double-click on it does what the system setting "Double-click a window's title bar to" says (zoom, minimise or nothing). Nothing interactive sits under the strip, and a drag anywhere else (sidebar drag and drop) never moves the window.
  - the sidebar's "Synopia" heading sits below the traffic lights.
  - the main area has no strip (decided 2026-11-24): the session header starts at the canvas's 9 px gap from the window top, as in Slack and Linear, and everything in it is a normal click. Dragging by the header isn't needed.
  - in fullscreen there is no strip and no inset. In a browser the page looks as before.
- R2.8 Running work survives the app (decided 2026-11-24): the app is only UI and may crash or quit at any time.
  - The sessions run in a background Synopia process (the daemon) that the app starts and finds again on its next launch. No launchd agent.
  - ⌘Q quits only the app, without asking. "Stop All Work…" (⌥⌘Q) asks first when anything runs ("Stop all work? 2 sessions are working and 1 background shell will stop."), then ends every session's work and quits.
  - The daemon ends by itself after 30 minutes with no window open and nothing running (no turn, subagent, background shell or monitor, and no pending card).
  - Backend updates (decided 2026-11-24): when the checkout's backend code changes, the daemon restarts by itself as soon as nothing runs, and the window comes back as it was after at most a brief "Reconnecting…". While work runs, the sidebar footer says "Update ready: restarts when idle"; running work is never interrupted for an update. "Restart Backend Now…" in the App menu restarts it at once, asking first as "Stop All Work…" does when anything runs (that work stops).
  - If it goes away while the app runs, the page shows a quiet "Reconnecting…", and the app starts it again and reloads.

## 3. Sessions

- R3.1 Synopia shows only the sessions it holds open, not the whole history. Those are the new sessions started in it and the past sessions opened from its "Open session" list. A session that isn't open in Synopia doesn't appear, even when a terminal runs it; the "Open session" list marks those (R3.2).
- R3.2 Synopia sees the terminal and takes over in both directions, so one session never has two writers (decided 2026-11-24, reversing "Synopia is unaware of the terminal": the user typed in Synopia on a session a terminal still held, and both processes wrote the same transcript).
  - It reads Claude Code's pid files in `~/.claude/sessions/<pid>.json` (never the `*.key` files): a file counts when its pid is alive with the same start time (`procStart`), it is an interactive `cli` process, and it isn't one of Synopia's own. If the format changes, Synopia stops seeing terminals and logs it once.
  - A terminal takes a session Synopia holds (the user types there, or runs `claude --resume <id>`): Synopia yields at once. It interrupts its turn if one runs and ends its process. The session shows read-only, the transcript still live, and the message box holds one line: "Open in a terminal (pid 54166). Type there, or send here to bring it back." When that CLI exits, the session is Synopia's again, quietly.
  - Synopia takes a session a terminal holds (the user sends here): when the CLI is idle (nothing running or waiting in it), Synopia checks again right before, writes a note to the CLI's terminal, ends it (SIGTERM, then SIGINT, never SIGKILL; if it won't exit within 10 s the message stays in the box with a toast), waits for the transcript to settle, resumes the session and sends. The message stays in the box until then. When the CLI is busy or waiting, the box keeps it, marked "Waiting for the terminal to finish…", and the take-over runs once the CLI is idle; any edit or Esc cancels the wait.
  - The note, written to the CLI's own terminal after it exits: "Synopia took over this session at 12:04. To continue here instead: claude --resume <id>". Without a terminal to write to, it is skipped.
  - "Open session" lists past sessions from the SDK's `listSessions()`, newest first; one a terminal holds says "Open in a terminal" in its row and opens read-only. Opening one resumes it by id on the first message.
- R3.3 New session: "New session" opens an empty session in `~/dev/demo-project` (a config value). There's no dialog and no new worktree yet. The first prompt sets the tone, and Claude names the session from there.
- R3.4 Titles and the "Now" line are written by Claude live from the transcript and kept current; they went stale within minutes when written once. Model calls are free on this machine. The CLI slug (tab name) is still shown, small, so the user can recognise it.
- R3.5 No drift detection. The user keeps one session per topic (see Rejected).
- R3.6 Close, don't abandon: Synopia's sessions stay open across restarts until the user closes them. x, x in normal mode (R9.6) marks the session closed and hides it; it keeps its place in its group. Reopening it from the "Open session" list puts it back there. Claude's closing note, with what was done and the loose ends to triage, comes later.
- R3.7 Model per session: the header shows the model; clicking it, or typing `/model`, opens the model picker (list from the SDK). Effort levels come from the same list.
- R3.8 Rejected:
  - Listing every terminal session in the sidebar: only the sessions open in Synopia show (R3.1).
  - Drift detection ("Topic changed: …") and "Split into a new session": the user keeps one session per topic.
- R3.9 Exact state after a reload, a crash or a quit: reopening Synopia shows exactly what was on screen. The page is only UI; this state lives in the backend, so it survives page reloads, app crashes and quits. Restored:
  - the current session, and the subagent view if one was open;
  - each session's scroll position, on the same item and the same pixels into it (so it lands on the same content when the window size changed or new items arrived), or at the bottom, pinned there, if it was within 40 px of the end. An item that is gone (a rewritten file) lands at the bottom;
  - each session's message box draft: its text, its cursor, its pasted images (kept as files, at most 5 MB each and 20 MB per session, removed on send), and normal or insert mode;
  - expanded steps, open diffs, unfolded runs, the expanded background card, and the earlier items loaded (asked for again);
  - a half-answered card: the picks, notes, typed answers and the cursor, as long as the request still waits;
  - the Open list (open, with its filter), the file preview (its file, scroll and find query) and the image viewer.
  - A closed session's state is dropped; a `/clear` or a new session's real id carries it over. There's no live sharing between two pages: the last one to write wins.
- R3.10 One writer, always: before any Synopia process starts on a session, Synopia checks for a live terminal that holds it. If one does and the take-over conditions of R3.2 aren't met, it doesn't start, and the message is kept.

## 4. Sidebar

- R4.1 The sidebar is dark (`#22272E`), the only dark area. The open session's row is a light cut-out in the canvas colour that runs into the main area, like a tab. It has rounded corners on the left and curves into the canvas on the right.
- R4.2 Rows are flat. Each row shows, in this order:
  - the status mark, in a small rounded 1px box, on the title line
  - the title
  - the state word with its age ("Your turn, 12 min")
  - the "Now" line
  - sub-lines for running background work and "N to review"
  - a sub-line whose work finishes (done, failed, stopped, timed out) stays where it was for 5 s, with the status mark beside the still kind mark and the final duration, then leaves with the tween (R8.1). A session switch or a redraw doesn't restart or cut the 5 s; with reduced motion the 5 s stay and only the tween is instant.
- R4.3 Groups render as a tree: a bold heading (just the name, no count, no state mark), sessions indented under it with 1px guides (a vertical line, a tick into each session's mark box, a corner on the last). "Not in a group" is a heading at the same level, with the same indent and no guides.
- R4.4 Sub-lines under a session use a drawn 1px L corner with equal 7px legs.
- R4.5 The user arranges groups by drag and drop. There is one way to do each thing:
  - Dropping near the top or bottom edge of a row inserts there; a blue line with a dot shows the spot.
  - Dropping on the middle of a session that's not in a group makes a new group of the two ("+ New group"); the name field opens.
  - Dropping on the middle of a session in a group inserts next to it.
  - When "Not in a group" is empty, a dashed placeholder is the only drop target there.
  - Group headings are not drop targets.
- R4.6 The dragged copy follows the pointer at 50% opacity, offset 14px to the right, so the target stays visible.
- R4.7 Double-click a group name to rename it. Empty groups disappear. Rows keep the user's order, with no automatic sorting by state.
- R4.8 Claude may suggest the first grouping, from shared rare references: the same Notion attack plan, Linear project, GitHub label or worktree. A worktree is a signal, not the rule. From then on the user's layout is authoritative and persists.
- R4.9 Rejected:
  - "Why grouped" explanations: magic must be dependable or adjustable, not explained.
  - Folding.
  - Group summary lines.
  - The combined-state chip or count on a group heading.
  - Hairlines between sessions.
  - Cards.
  - The dark boxed group header.
  - Sorting by state.
  - ⌥1-9 shortcuts.
  - Light sidebar.
  - White mark chips on the dark sidebar.

## 5. Session view

### 5.1 Header panel
- R5.1 It shows:
  - the title
  - "Now: …"
  - the folder, the PRs and the tab name
  - a model button (no Close button: x, x closes, R9.6)
  - the same height and line positions in the main conversation and a subagent view
- R5.2 No "Change group" button: dragging in the sidebar does that.

### 5.2 Transcript panel (reads like the Claude Code CLI)
- R5.3 Monospace JetBrains Mono NL, ligatures off, 12px. Flat text, no cards. A two-character gutter of marks:
  - `●` Claude's text
  - green `●` tools
  - kind marks for subagents
  - `⎿` results
- R5.4 Your prompts sit on a full-width band starting with `❯`, which is the clear break between turns.
- R5.5 Each turn ends with the still agent mark and "Worked for 5s, done 02:24 PM". While a turn runs, the transcript ends with the moving agent mark and "Working Bash(…)". There's no status line in the message panel for working. A message you send while the turn runs shows as itself, pending: your prompt's ❯ band, dimmed, with no fill and a quiet "Queued, goes to Claude at its next step" line with the moving queued mark, below the live line, since what is working began before it (where it will land; the CLI shows it under its spinner, but there it would jump up when it lands). Several show in the order sent. When Claude takes it in (its prompt record lands in the transcript) it becomes the normal prompt in the same place, with no duplicate. If an interrupt cancels it, it disappears and its text goes back to the message box (R9.4).
- R5.6 Tool runs collapse to one line ("3 Bash commands, read 2 files"); click to expand. A step reads as in the Claude Code CLI: the tool's name and its description or target, such as `Bash(Merge master into the M1 backend stack)` or `Read(~/dev/demo/notes.md)`; a single step shows inline. A click on a step, inline or inside an expanded run, expands it to its command (or its input) and its result under the drawn guide, truncated to the first 20 lines with "Show all N lines" for the full result; a second click closes it. For an edit, the diff in Files changed stays the way to see the change.
- R5.7 Subagents:
  - A single launch is one line: kind mark, name (click opens its transcript) and live time.
  - Several launched together get one heading, "3 subagents in parallel", with a row each: mark, name, and time. No duration bars: a row is its mark, its name and its live or final time. A subagent whose turn ended while its own background shell or monitor still runs counts as running: it resumes when that work reports.
  - No duplicate labels, tags or "running" words.
- R5.8 Subagent reports: "Report from <name>, 8m", folded, click to read, plus "Open its transcript".
- R5.9 Files changed:
  - Each turn ends with a list of the files changed, grouped by repo or worktree, with aligned `+add −del` counts. Files changed by shell commands count too.
  - Clicking the path of a text or source file opens a read-only, syntax-highlighted preview over the main area, not an external app. It has the path, the language and the line count, an "Open in app" button that opens the file with its default app, and Close. It always opens at the top. Lines the turn changed get quiet gutter marks only: a green bar beside added lines and a red mark where lines were removed; the diff is where the change shows. Keys while it is shown: Esc closes it (before any other Esc), j/k scroll a line, g/G go to the top and bottom, ⌘F or `/` finds, Enter or n go to the next match. A click outside closes it.
  - HTML files keep opening in the browser, because the user often opens HTML artifacts. Alt-click on an HTML path shows its source in the preview.
  - Images, PDFs, binaries and other files open as before: with their default app, or revealed in Finder.
  - Clicking the counts opens the diff, with line numbers from the stored patch, red and green rows.
- R5.10 Markdown renders as the CLI does:
  - bold
  - inline code in blue
  - `- ` lists
  - tables as tables
  - code blocks
  - bare URLs and markdown links are clickable and open in the browser
- R5.11 Claude's questions and your answers render in the transcript. Answered questions appear as your turn.
- R5.12 Opening a subagent shows its own transcript in the same pane, with a breadcrumb back to the session. Its message box writes to the main conversation: the user asks the main session to orchestrate its subagents, and it messages them itself. Messaging a subagent directly is rejected (2026-11-23).
- R5.12a A long transcript shows its last 160 items under a quiet link, "Show 160 earlier (N more)". Clicking it, or `g` at the top, loads the 160 before them without moving what you're reading; subagent transcripts too (2026-11-23).
- R5.12b Images show as thumbnails, Slack-style: a row below the text that wraps when there are many (2026-11-24).
  - Under your prompt in the `❯` band, the images it sent. Under a tool step whose result holds images (a Read of an image, a screenshot), its images, visible without expanding the step. A collapsed run of steps ("Edited 9 files, read 8 files, …") has one row for all its steps' images, below the run's line (2026-11-24).
  - A thumbnail is at most 3 transcript lines high (about 52 px at 12 px), and its width follows the image's aspect ratio (a 400×100 image shows 4 times as wide as high). Smaller images aren't scaled up. The width stops at 320 px, cropped to the centre, for panoramas. Rounded corners and a 1px line, the same size in the message box and the transcript. The shape is right from the start: the size comes from the image's header (by its bytes, whatever type the record names), and when that's unknown the thumbnail takes the image's own shape as soon as the browser has read it, never a square placeholder.
  - An image no longer in the transcript file (gone or rewritten) is a quiet "Image gone" tile.
  - A click on any thumbnail opens it full size, clear of the title bar (2026-11-24):
    - It opens fit to the window, never scaled up. A click on the image, `z` or `0` switches between fit and 100% (one image pixel to one CSS pixel, as the thumbnails and the browser count it; on a 2x screen a Retina screenshot shows twice its on-screen size), keeping the clicked point under the pointer.
    - At 100%, an image larger than the window pans by dragging (the cursor a hand), by trackpad or wheel scroll and by the arrow keys (Shift for a whole window).
    - ← → (at fit) and `j` `k` (in both modes) step through the row the thumbnail is in: a prompt's images, a step's, or a whole run's. It stops at the ends. The footer says "3 of 7", the image's source (the file path for a Read, the step otherwise, "your message" for a prompt) and the keys for the mode it's in.
    - Esc or a click outside the image closes it. While it shows, no other key acts.
- R5.12c A change of the shown title is a quiet line in place, styled like a day separator: “Retitled “…””, plus “by you” for your rename. Its sources are the CLI's title records and Synopia's written titles (by time); none for the first title, before your first prompt, or for a title equal to the one before (case and spaces aside) (2026-11-24).

### 5.3 Message box
- R5.13 At least three lines tall, `❯` on the first line, the field growing for long messages; a click anywhere in the box focuses the field. There's no Send button and no hint row. Enter sends, Shift+Enter makes a new line, ⌘V pastes images. The placeholder says "/ for commands".
  - Pasted images show as thumbnails below the text (R5.12b sizes), each with a small ✕ on hover that removes it. Enter sends them with the text, as base64 PNG or JPEG of at most 5 MB each. The thumbnails come from the pasted image itself, never the server (2026-11-24).
  - As in the Claude Code CLI, a paste puts an `[Image #N]` tag at the caret, with a space between it and any text it touches. N counts up through the session, as the CLI's does: one more than any tag in the session's prompts or the draft, never reused. The ✕ removes the image and its tag; the other tags keep their numbers. Deleting a tag's text leaves its thumbnail in the row, dimmed with a dashed line, and that image isn't sent (typing the tag back brings it back). The message goes as the CLI sends one: a text block with the tags in it, then the images in the order of their tags. Your prompts, sent from Synopia or from the CLI, show the tags in place as plain dim text, with the thumbnails below. A draft keeps its tags and images over a restart (R3.9) (2026-11-24).
- R5.14 `/` opens an autocomplete of the session's real commands and skills, with argument hints and descriptions aligned. ↑↓ moves, Tab or Enter fills, Esc closes.

### 5.4 Rejected
- Separate "who" labels.
- A status bar for working.
- The "Change group" button.
- The Send button.
- The mode label.
- The glyph-cycling asterisk.
- `*` lines.
- The person icon.
- "Started a subagent" headings for single launches.
- Kind tags plus marks plus "running" on one line.

## 6. Needs you: questions, permissions, plans

- R6.1 A session that is blocked on the user shows "Needs you" everywhere:
  - the red seesawing stripes in the sidebar
  - the red tint on the Main conversation row
  - a red header on the card
- R6.2 The transcript ends with Files changed, then one line: "Waiting for you: 2 questions from Claude, in the message panel" (or "permission to run …", or "your approval of the plan above"). It doesn't repeat the question, and no "Worked for" line follows it.
- R6.3 The card sits in the message panel above the message box:
  - a red header: "Needs you", the reason, "for 4 min", and "k of N answered"
  - one line per question (accordion): ✓, ● or ○, the header, and the answer or "Not answered"
  - only the current question is open, showing its text and option rows: cursor `›`, radio or checkbox, label, "Recommended" under it in green, description
  - the last row is always "type your own"
  - a footer with generic key hints and Send
- R6.4 Keys, in normal mode, while a card waits:
  - j/k move the cursor through every option of every question as one list; moving past the last row opens the next question.
  - Space selects only: radio for single choice, toggle for multiple choice. It never advances.
  - i types in place, on the row:
    - On an option: it selects it and adds a note. The note goes back as `annotations.notes`.
    - On the last row: it types your own answer instead.
    - Enter saves, Esc cancels.
  - Enter sends once every question is answered; otherwise it jumps to the first unanswered question.
  - No number keys, no h/l, no Tab.
  - J/K still switch sessions.
- R6.5 Permission prompt: sessions keep the user's permission mode (`auto`), so a permission card appears only when `auto` would ask. A session in plan mode stays in plan mode. The card shows the exact command in a code block, the folder, and Claude's reason. Rows: "Allow once", "Always allow" (says exactly what is remembered and for how long) and "Deny" (type a reason in place, optional).
- R6.6 Plan approval: the plan sits in the transcript as Claude's reply. The card holds only the decision: "Approve" or "Ask for changes" (typed in place).
- R6.7 Answers appear in the transcript as your turn ("Allow once", "Denied: …", "Changes: …").
- R6.8 Detection: a session needs you while it has a pending `canUseTool` request: a question, a permission or a plan.
  - It also needs you, with no Synopia process, while its transcript ends a thread (the main conversation or a subagent) on a question or plan (AskUserQuestion or ExitPlanMode) that has no result yet: another Claude Code process asks it, typically a terminal that took the session (R3.2). A message sent then waits ("Waiting for the terminal to finish…"): the take-over doesn't end a CLI that waits on you. This beats working, the Dock badge counts it, its age counts from the question, and it clears when the answer lands.
  - The message panel then shows the card read-only: the red "Needs you" header with the reason and "for N min", every question open with its options (Recommended, descriptions, checkboxes for a multi-select), or the plan's two decisions under the plan in the transcript. It has no cursor, selection or keys, and its footer is one quiet line: "Asked in another Claude Code process. Answer it there." The transcript line says "Waiting for you: …, asked in another process". Once answered, the card goes and the answer shows as your turn.
  - A session Synopia drives keeps the interactive card. A question its own process left without a request (after a crash) stays "Not answered (Synopia quit)".
- R6.9 Rejected:
  - showing all questions at once
  - horizontal tabs
  - number keys
  - Space advancing
  - typing your own answer in the message box
  - per-card key hint wording
  - boxed options with red pills

## 7. Background work panel

- R7.1 A panel to the right of the transcript (under it below 990 px). From the top:
  - "Main conversation", a card like the running ones, tinted by the session's state (green while working, red when it needs you, grey otherwise). Its mark on the left, its state word on the right, and under its name a quiet count: "2 running in the background", or "Nothing running in the background". No separate "Running" heading.
  - Under it, inset as its children: a card per running item, ordered forks, subagents, shells, monitors, then oldest first. Each card has the kind mark, name, kind word in the kind colour, start time and a live timer. The sidebar's 1px tree guides join them (R4.3): a vertical line down from the main card's mark, a tick into each card at its mark's height, a corner on the last. The line runs past an expanded card's Stop row to the last child.
  - A card that comes or goes tweens like a sidebar sub-line (R8.1): coming, the height opens, then the card fades in; going, the card fades out, then the height closes. The guides follow the height on every frame. A card whose item finishes stays in its place for 5 s, as in R4.2 (the status and still kind marks, the final duration), then leaves and its line appears in "Past".
  - A subagent's own shells and monitors (in its own transcript) hang under its card, one level deeper, with the same guides. They show only here: not under Main conversation, not in the sidebar's count, not in the main transcript. With no notification they run while their subagent runs; after it, they read as stopped, ended with their subagent. In "Past" they name it: "Resize the images in Build image thumbnails".
  - "To review": items waiting for review (section 10).
  - "Past": one dim line per finished item, newest first, fading out at the bottom edge. Each line shows the status mark, the still kind mark, the name and the duration; failed and timed out are named.
  - The item you're viewing shows it one way, whatever its kind (Main conversation, a subagent or fork card, a Past line): its 1px edge turns ink, and that is its only edge, over any state tint. A Past line gets the edge as a frame on the cards' edges, with its name in ink. Nothing moves or resizes when the selection moves. Hover only shades; keyboard focus is the blue ring.
- R7.2 Clicking a subagent or fork opens its transcript. Clicking a shell or monitor expands its command and summary. Each running card has a Stop row that stops only that item.
- R7.3 Covers forks, subagents (including the `Explore` and `general-purpose` types), background shells (`Bash` with `run_in_background`) and monitors (`Monitor`).
- R7.4 Rejected:
  - reversed order (running at the bottom)
  - sections per kind
  - green running cards
  - pink monitors

## 8. Status and kind vocabulary

- R8.1 Running things always move: their motion is linear, infinite, with no pause, ease, fade, pulse, ping or blink. A scanning eye never waits. Spinners and moving shapes, never opacity changes, on a running mark.
  - Layout transitions are other motion and allowed: a sidebar sub-line or a background panel card that appears tweens the row's height open, then fades in; one that leaves fades out, then the height closes. About 150 ms a step, instant with reduced motion. A line whose text alone changes (a timer, a count) doesn't animate. Every moving mark turns at the same speed (one cycle per 2 s); a monitor, which only watches, sweeps at 3 s.
- R8.2 Session status marks:
  - working: agent mark turning. Also while the main turn is over but background subagents or forks still run, in every open session. Also while another process (a terminal) runs the session's main turn, read from its transcript: a tool waiting for its result, or a turn opened by a prompt and not yet ended. A turn that changed nothing for 30 minutes, with no tool waiting, is your turn.
  - working with a message queued: the same mark with a blue centre, "Working, 1 message queued". The message was sent during the turn and Claude hasn't read it yet.
  - compacting: green rings shrinking inward, "Compacting context".
  - rate limited: amber dashes turning backwards, "Rate limited, retrying in 38s", with the attempt in the transcript. Claude Code retries a throttled request on its own.
  - no updates: the working arc frozen and grey, "No updates for 16 min". A turn runs but nothing came for 15 minutes; the session may be gone.
  - signed out: red lock, "Signed out". The sign-in expired (for Bedrock, `aws sso login`); it clears when the next turn starts or a reply gets through.
  - needs you: two red pause stripes seesawing. It wins over every other status.
  - your turn: still grey square ("stopped, waiting for you"), only when nothing of Claude's runs except shells and monitors. Its age counts from when the last subagent finished.
  - stopped by you: grey square. Only when the latest turn ended on "[Request interrupted by user]" and Claude wrote nothing after it. "… for tool use" is a tool call you turned down, not a stop.
  - done: grey check
  - failed: red square
  - timed out: amber 1px outlined square
  - ready for review: blue check badge
  - Squares are drawn so they stay square at every size.
- R8.3 Kind marks, shape plus colour:

  | Kind | Shape | Colour |
  |---|---|---|
  | Agent (main conversation) | ring with a core and a turning arc | green |
  | Subagent | one dot orbiting a ring, no core | all green, same family as the agent |
  | Fork | two dots parting on a ring | purple `#8250DF` |
  | Shell | `>_` with the underscore stretching left and right | bluish teal `#0B7A82` |
  | Monitor | radar sweep | tealish blue `#0E6BA8` |

  - Shell and monitor sit either side of clean blue in hue.
  - Each kind has a still version for finished work.
  - Subagents are more prominent than shells and monitors.
- R8.4 The marks take their colours from variables, with a light set and a brighter dark set for the sidebar. The open row uses the light set.
- R8.5 Every animation has a reduced-motion fallback that keeps the shape.
- R8.6 Marks align exactly: centred in their boxes, on the guide ticks, and on the `●` gutter column.
- R8.7 Rejected:
  - pulsing dots
  - the turning red square for needs you (now the seesaw)
  - the amber dot, and the amber dot with a circling satellite, for your turn
  - the slate subagent
  - person and eye glyphs
  - kind tags as the main kind signal
- Storyboards: `prototype/status-storyboard.html` and `prototype/kind-storyboard.html`. The app's current choices override them where they differ.

## 9. Keyboard and modes

- R9.1 Vim-like modes:
  - Normal mode is the default:
    - J/K: next or previous session.
    - Ctrl+J/Ctrl+K: next or previous conversation inside the session: Main conversation, then the subagents and forks as the background panel shows them, top to bottom; after the last one, back to Main conversation.
    - j/k: scroll the transcript, or move the card cursor while a card waits.
    - g/G: top or bottom of the transcript; g at the top loads earlier items (R5.12a).
    - i/a: insert.
    - `/`: insert with the command menu open.
  - Insert mode: typing goes to the message box, or to a field in the card. Esc returns to normal; the first Esc closes the command menu.
  - Clicking the message box enters insert mode.
- R9.2 The only mode indicator is the message box: grey in normal mode, blue ring in insert mode.
- R9.3 ⌘⇧[ and ⌘⇧] also switch sessions, as in iTerm.
- R9.4 Interrupt: Esc in normal mode while a turn runs turns the message box into "Interrupt?". A second Esc interrupts. Any other key or click dismisses it. An open in-place field on a card takes Esc first (R6.4).
  - The interrupt stops only the foreground turn. Background subagents, shells and monitors keep running, as in the CLI; each is stopped with its own Stop row (R7.2).
  - Messages still queued at the interrupt go back to the message box.
- R9.5 Send to background, as Ctrl+B in the CLI: b in normal mode, in a session Synopia drives whose turn runs a foreground Bash command or subagent, marks each such step in the transcript (a 1px blue ring on the selection tint) and turns the message box into "Send to background? b again. Any other key to keep it in front." A second b sends them all to the background. Any other key, a click or the turn ending dismisses it.
  - With nothing that can go, or in a session another process runs, b does nothing.
  - One prompt at a time: Esc under this prompt asks "Interrupt?" instead, and b under "Interrupt?" asks this.
  - The steps then show as background work in the right panel (R7) and end there with their notification. A toast says so only when nothing could go.
- R9.6 Close, in place of a Close button: x in normal mode, on any open session, turns the message box into "Close this session? x again. Any other key to keep it." When something runs it adds what will stop, for example "Claude's turn, 2 subagents and 1 shell will stop." A second x closes the session (R3.6). Any other key, a click or switching sessions dismisses it. The prompt is the only confirm: no dialog.
  - For a session another process runs, it asks "Remove it from Synopia? x again. Its other process keeps running.", and closing only removes it from Synopia.
  - One prompt at a time: Esc or b under it asks theirs instead, and x under theirs asks this.
  - In insert mode x types.

## 10. Deliverables for review

- R10.1 A subagent whose description starts with `For review: ` (the user's global rule in `agent-harness`) is a deliverable. When it finishes it shows:
  - a blue badge
  - a "To review" group in Background work
  - "N to review" under the session in the sidebar
- R10.2 It stays until the user clicks "Mark reviewed". Opening it doesn't count. No custom per-type handling yet: a review item might be a PR, a file or anything else.

## 11. Visual system

- Light theme, with visible panels: header, transcript, message box, background work. The canvas is `#EDEFF2` and the panels are white.
- UI font: Atkinson Hyperlegible Next. Transcript: JetBrains Mono NL.
- Sizes are 81% of the first draft (two 90% steps); the transcript is 12px.
- Colours: GitHub-like on light.
  - red `#CF222E`: needs you only
  - amber `#9A6700` / `#D4A72C`
  - green `#1A7F37`
  - link and selection blue `#0550AE`
  - diff backgrounds `#DAFBE1` / `#FFEBE9`
- No ALL CAPS labels. Plain sentence-case copy from the user's point of view.
- Lines and guides are 1px.
- Dark mode. The light theme is the default look; a dark theme is also available.
  - By default the page follows the system appearance (macOS Light or Dark, `prefers-color-scheme`), live.
  - The switch is a shaded icon at the left of the sidebar footer, before "Open session" and "New session": a moon in light mode ("Dark mode"), a sun in dark mode ("Light mode"), with no border and no background. A click picks the other theme and keeps it with the UI state (R3.9), whatever the system does after. Alt-click follows the system again.
  - The layout reads the same: the sidebar (`#22272E`) stays the darkest surface, the canvas (`#2A3038`) and the panels (`#333A44`) a step lighter each. Lines stay 1px and visible, text keeps WCAG AA contrast, the marks use the sidebar's bright dark set (R8.4), and red stays for needs you.
  - Everything has a dark variant, so no light patch is left: diffs and their gutters, code, tables, the needs-you cards, the Open list, the slash menu and model picker, toasts, the image viewer, the background panel's tree and the Main conversation card's tints, and the message box's mode ring. The file preview asks `bat` for its dark theme (Coldark-Dark, as bat has no GitHub Dark).
  - The switch is instant, with no transition.

## 12. Data the app relies on

Verified in the spike (`spike/FINDINGS.md`) and the prototype export (`export_transcripts.py`):
- Open sessions: Synopia's own list of the sessions it holds open, kept across restarts. Past sessions for the "Open session" list come from the SDK's `listSessions()`. Terminals come from `~/.claude/sessions/<pid>.json` (undocumented, read by one module, R3.2).
- Transcripts: `~/.claude/projects/<encoded-cwd>/<id>.jsonl`.
  - Subagents: `<id>/subagents/agent-<aid>.jsonl` plus `.meta.json` (agentType, isFork, description, toolUseId, spawnDepth, finished).
  - Edits: `toolUseResult.structuredPatch` holds the diff hunks with line numbers.
  - Answers: AskUserQuestion results read `"question"="answer"`.
  - Background work: task notifications in user messages carry the tool-use id, status and summary.
  - Reports: subagent reports arrive as `isMeta` user messages from `agent-message from="<aid>"`.
- SDK:
  - It lists, resumes and forks sessions.
  - It takes images, `canUseTool` (permissions, AskUserQuestion with `updatedInput.answers`), `supportedCommands()`, `supportedModels()`, `setModel()`, `interrupt()`, `stopTask()` and streaming input.
  - The transcript is read from the JSONL; the SDK stream carries control and live state.
  - Subagent task events are available.
  - Session state events need `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`, which is undocumented.
- Gotchas:
  - The user's settings use `defaultMode: auto`, so `canUseTool` fires only when `auto` would ask. Synopia keeps it that way (R6.5).
  - `interrupt()` doesn't drop queued messages.
  - Resuming or forking re-sends the whole history, which costs real money on big sessions.
  - Nothing in the CLI stops two writers on one transcript. Synopia guards against it itself (R3.2, R3.10).
  - Read-only Bash and `Agent` don't reach `canUseTool`.

## 13. Icon and favicon

- Option B, "Paper": a light paper tile with the agent mark (pale green orbit, dark green arc on top, solid core).
  - Files: `prototype/icon/icon.svg`, `icon-small.svg` (16 to 64px, with more contrast) and `favicon.svg`.
  - Icons are still, since motion means running.
- The `.icns` file is built locally from the icon, with the tools that ship with macOS.

## 14. Not decided yet

- The sidebar banner for signed out ("2 sessions are blocked. Run aws sso login") from the status storyboard: the row and the status line show it, the banner isn't built.
- Plan rate limits (five-hour and weekly): the SDK documents them as unavailable on Bedrock, so only retries on throttling show.

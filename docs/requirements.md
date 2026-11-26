# Synopia requirements

Synopia is a desktop app for one person who runs several Claude Code sessions at the same time. It replaces "Claude in iTerm tabs" with one window that shows every open session at a glance, says which one needs the user, and lets the user chat in any of them.

These requirements come from a day of prototyping against the user's real sessions (2026-11-23). The prototype in `prototype/app.html` is the UI reference: when a requirement and the prototype disagree on look, the prototype wins; when they disagree on behaviour, this document wins. Each section ends with what was tried and rejected, so it doesn't come back. [functional-requirements.md](functional-requirements.md) restates this behaviour as numbered FRs (FR-PLAT-01 and so on) with what is still open; [architecture.md](architecture.md) maps each FR to its modules.

## 1. Who it's for and the job

- One user, one machine, usually one repository with several worktrees, many parallel sessions, each using subagents, forks, background shells and monitors heavily.
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
  - "Open session" (o in normal mode, R9.7) lists past sessions from the SDK's `listSessions()`, newest first; one a terminal holds says "Open in a terminal" in its row and opens read-only. Opening one resumes it by id on the first message. Since 2026-11-25:
    - The header gives the totals ("812 past sessions in 43 folders, newest first."), and the last line says typing reaches all of them ("Newest 50 of 812. Type to search all of them.", or "3 sessions match.").
    - Typing matches every past session, not only the 50 shown, with the one fuzzy matcher (R3.14), on the title and the folder; matched letters are highlighted.
    - A row whose folder is gone says "Folder gone" and its folder is struck through (R3.11). Ages over 60 days read in months ("9 mo ago").
- R3.3 New session asks where (decided 2026-11-25, replacing the stored new-session folder of 2026-11-24). "New session", or n in normal mode (R9.7), opens the folder list over the main area, drawn like the Open list. The session it starts is empty, with no new worktree; the first prompt sets the tone, and Claude names the session from there.
  - The list holds the folders Synopia already knows: where its own sessions ran and the folders of `listSessions()`, newest first, each with its number of sessions and when it was last used, and `~` ("home folder"). Nothing else is read to find folders (R3.13).
  - The folder of the session on screen is selected, so n, Enter starts there. With no session on screen the newest folder is; with none known, `~`.
  - Typing filters the folders fuzzily (R3.14). Text that starts with `~` or `/` is a path: Tab reads that one folder (the path up to its last `/`) and lists its direct children, which typing then filters with no new read. Tab on a row fills the filter with its path, so the next Tab goes one folder deeper.
  - A typed path that doesn't exist shows one row, "Create folder <path> and start there". Enter makes that one folder (`mkdir -p`) and starts there. It is Synopia's only write to your folders.
  - Enter starts an empty session in the selected folder, with the message box in insert mode. Esc closes the list.
- R3.4 Titles and the "Now" line are written by Claude live from the transcript and kept current; they went stale within minutes when written once. Model calls are free on this machine. The CLI slug (tab name) is still shown, small, so the user can recognise it, but only while a terminal (another process) holds the session: a session Synopia runs has no tab (2026-11-25).
- R3.5 No drift detection. The user keeps one session per topic (see Rejected).
- R3.6 Close, don't abandon: Synopia's sessions stay open across restarts until the user closes them. x, x in normal mode (R9.6) marks the session closed and hides it; it keeps its place in its group. Reopening it from the "Open session" list puts it back there. Claude's closing note, with what was done and the loose ends to triage, comes later.
- R3.7 Model per session: the header shows the model; clicking it, or typing `/model`, opens the model picker (list from the SDK). Typing after `/model ` filters it fuzzily (R3.14). Effort levels come from the same list.
- R3.8 Rejected:
  - Listing every terminal session in the sidebar: only the sessions open in Synopia show (R3.1).
  - Drift detection ("Topic changed: …") and "Split into a new session": the user keeps one session per topic.
  - ⌘N and ⌘O, and a File menu with New Session and Open Session (2026-11-25): Synopia's keys stay single letters in normal mode (R9.7), with no new menu items.
  - A "Choose in Finder…" row in the folder list: a second way to a folder never used; the typed path with Tab covers it.
  - Worktree rows from `git worktree list`, and a "New worktree…" row: the author starts in the repo and lets agents manage worktrees.
  - Guessing where a moved repo went (the same git remote).
  - A stored new-session folder (`settings.newSessionCwd`): the folder list asks every time, with the folder on screen selected.
  - Hiding sessions whose folder is gone, and failing the send in a gone folder with only a toast.
- R3.9 Exact state after a reload, a crash or a quit: reopening Synopia shows exactly what was on screen. The page is only UI; this state lives in the backend, so it survives page reloads, app crashes and quits. Restored:
  - the current session, and the subagent view if one was open;
  - each session's scroll position, per view (the main conversation, each subagent, shell and monitor view), on the same item and the same pixels into it, so it lands on the same content when the window size changed or new items arrived. If it was within 40 px of the end, the last item you saw stays where it was on screen, with what came since below it: you don't land on the new end (2026-11-25). What you had seen and the "New since" line come back with it (R5.12d, 2026-11-25). An item that is gone (a rewritten file) lands at the bottom;
  - each session's message box draft: its text, its cursor, its pasted images (kept as files, at most 5 MB each and 20 MB per session, removed on send), and normal or insert mode;
  - expanded steps, open diffs, unfolded runs, the expanded background card, and the earlier items loaded (asked for again);
  - a half-answered card: the picks, notes, typed answers and the cursor, as long as the request still waits;
  - the Open list (open, with its filter), the file preview (its file, scroll and find query) and the image viewer.
  - A closed session's state is dropped; a `/clear` or a new session's real id carries it over. There's no live sharing between two pages: the last one to write wins.
- R3.10 One writer, always: before any Synopia process starts on a session, Synopia checks for a live terminal that holds it. If one does and the take-over conditions of R3.2 aren't met, it doesn't start, and the message is kept.
- R3.11 Gone folders (decided 2026-11-25). A session whose folder no longer exists (a deleted worktree, a moved repo) is named, not hidden:
  - In the Open list its row says "Folder gone". Opened, it shows its whole transcript read-only, the header says "folder gone", and the message box holds one line instead of the field: "This folder no longer exists. Enter picks a folder to continue in."
  - Enter (or a click on the line) opens the folder list titled "Continue in a folder", filtered on the repo's name (a worktree folder's name up to its first dot). Gone folders show dimmed and can't be picked; a typed path can be created as in R3.3.
  - Enter forks the session into the folder picked: a new session id with the whole history, and Claude gets one quiet line of context saying the folder changed. The transcript marks the move with a quiet line in place, styled like "Retitled": "Continued in ~/dev/demo-app". The sidebar row keeps its place and title. The old session stays in the Open list as history, still "Folder gone". A plain resume in another folder would keep the id but write into the old folder's transcript, which keeps naming the gone folder ([Agent SDK](Agent%20SDK.md#sessions-list-resume-fork)).
  - Synopia doesn't guess where a moved repo went.
  - A session already in the sidebar whose folder goes shows the line once Synopia checks its folder: when you show it or send to it.
- R3.12 With no open session, the main area shows the folder list (R3.3) and keeps it: Esc leaves its filter, n comes back to it, o opens the Open list. On a first launch with no history it holds only `~` and says "No other folders yet. Type a path; Tab lists what is in it."
- R3.13 Never scan the disk (decided 2026-11-25):
  - Never list the home folder or walk folders, on the first start or later: listing `~` sets off a run of macOS privacy prompts (Desktop, Documents, Downloads, Pictures, Music, other apps' data).
  - The folder list comes only from the folders of known sessions (Synopia's and `listSessions()`).
  - Path completion is one read of the folder typed so far, on Tab, never recursive, never as you type.
  - "Folder gone" checks only the rows on screen, once per opening of a list, and the row you choose. A row inside a protected folder (Desktop, Documents, Downloads, Pictures, Music, Movies, Library, other volumes) is checked only when you choose it. A typed path gets one check of exactly that path, when you stop typing.
  - A prompt you cause by typing a path into a protected folder is fine: you asked to look there.
- R3.14 One fuzzy matcher for every list (decided 2026-11-25): the folder list, the Open list, the `/` command menu and the model picker match with one matcher, a port of nota's (fzf's v2 algorithm). A word's letters must appear in order, case and accents aside; a space splits the query and every word must match, in any order. Each matched letter scores 16; a word start earns a bonus (after a space 10, after `/ , : ; |` 9, after other punctuation 8, a capital or digit after a lowercase letter 7, double for the first letter); letters in a run keep at least 4 each; a gap costs 3, then 1 a letter. Higher scores first; ties keep the list's own order. In the Open list a tie goes to the row with more of the match in its title. Matched letters are bold in the link blue, and also underlined on the selected row.
- R3.15 Synopia's tools for agents (decided 2026-11-25). Synopia gives every session it runs tools of its own, so Claude can act on Synopia itself. The first is `start_session`, for handing work over to a fresh session (a handoff skill writes a handoff file, then calls it):
  - It takes a prompt and an optional title. It starts a new session in the caller's folder with that prompt as its first message, as New session does (R3.3), titled as asked, else by the prompt's first words. The title asked for is only the first title (2026-11-25): it shows until Claude writes the session's own title after a turn, then Claude's titles replace it as for any session. It is no rename.
  - The new session goes right under the caller in the caller's group. A caller in no group gets a new group, named after the caller's title, holding the two. The caller stays open.
  - The page switches to the new session only if you are looking at the caller then; otherwise it only appears in the sidebar.
  - Each call asks on the normal permission card (R6.5): "Start a new session in ~/dev/x with: <first line of the prompt>", with Allow once, Always allow and Deny. Always allow lasts until the caller closes, as other "Always allow" rules do.
  - In the transcript the step reads `Start session(<title>)`; once done, its result line links to the new session.
  - It refuses, with a clear result Claude reads, an empty prompt, a folder that is gone, and a session that isn't one Synopia runs.
  - The writer's calls get no tools.

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
- R4.8 Claude may suggest the first grouping, from shared rare references: the same Notion plan doc, Linear project, GitHub label or worktree. A worktree is a signal, not the rule. From then on the user's layout is authoritative and persists. Experimental, not built; the rationale is in Design notes (section 16).
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

The conversation pane is one panel from the title down (2026-11-25, prototype/composer-storyboard.html v3 A): the header, the transcript and the message box are its rows, with no separate rounded rectangles. A 1px line (`--line-2`) sits under the header and just above the message box, in every state. The background work panel stays its own panel beside it (R7.1).

### 5.1 Header
- R5.1 It shows:
  - the title
  - "Now: …"
  - the folder, the PRs and the tab name
  - a model button (no Close button: x, x closes, R9.6)
  - the same height and line positions in the main conversation, a subagent view and a shell or monitor view (R7.2)
- R5.2 No "Change group" button: dragging in the sidebar does that.

### 5.2 Transcript (reads like the Claude Code CLI)
- R5.3 Monospace JetBrains Mono NL, ligatures off, 12px. Flat text, no cards. A two-character gutter of marks:
  - `●` Claude's text
  - green `●` tools
  - kind marks for subagents
  - `⎿` results
- R5.4 Your prompts sit on a full-width band starting with `❯`, which is the clear break between turns. The band's fill runs from the panel's inner left edge, where its 2.5px blue edge shows whole, to its inner right edge at any window width; its text keeps the transcript's 150ch measure. A line that is one long token (a path, a list of tool names) wraps anywhere inside the panel.
- R5.5 Each turn ends with the still agent mark and "Worked for 5s, done 02:24 PM". While a turn runs, the transcript ends with the moving agent mark and "Working Bash(…)": the turn's own step while it runs, an ordinary tool by its CLI name, a subagent or fork by the panel's kind tag and its name ("Working", the `subagent` tag, "Draft the notes"), and just "Working" while Claude thinks or writes. Background work is never named while the main turn runs; the panel shows it. Once the main turn has ended and only background work runs, the line names that with the kind's moving mark: "Working", its kind tag and name, or "N running in the background" when several run (2026-11-25). The line is drawn on a 1px rule that runs edge to edge across the panel through the line's middle: the mark and the words sit on it and break it. The rule takes no space, so nothing moves when the line shows or goes, and it divides Claude's work above it from what waits below (2026-11-25). There's no status line in the message box's place for working. A message you send while the turn runs shows as itself, queued: your posted prompt's band (its fill and blue edge, its text, the thumbnails of its pasted images, which open the viewer) with a still clock in your blue in place of `❯` and its text in the lighter grey (`--ink-3`), below the live line, since what is working began before it, as the CLI shows it under its spinner. The clock is still: a queued message waits, it doesn't run. Several show in the order sent. There is no veil (2026-11-25). A waiting band is at half opacity as a whole, so it reads as not yet taken. The queue is the transcript's end and scrolls with it like any message; it is not pinned over the box (2026-11-25). The sidebar says "Working, N messages queued", and the empty message box says "N waiting for Claude's next step". When Claude takes one in (its prompt record lands in the transcript) it becomes the normal prompt, with no duplicate, above the live line, on Claude's side of it: the band and the live line swap places, and nothing else moves (2026-11-25). If an interrupt cancels it, it disappears and its text goes back to the message box (R9.4). f, f sends the queue now (R9.8). A message you send shows at once: sent while idle as your normal prompt, the start of the new turn; sent during a turn as queued below the live line. Either is replaced in place when its record lands. On Enter the box empties at once. If the log was at its end when you sent, it scrolls smoothly to the end, so your band and the Working line below it are in view (with reduced motion it jumps); if you had scrolled up to read, it stays where you are. Nothing moves from the box to the band (2026-11-25).
- R5.6 Tool runs collapse to one line ("3 Bash commands, read 2 files"); click to expand. A step reads as in the Claude Code CLI: the tool's name and its description or target, such as `Bash(Merge master into the M1 backend stack)` or `Read(~/dev/demo/notes.md)`; a single step shows inline. A click on a step, inline or inside an expanded run, expands it to its command (or its input), in ink, and its result under the drawn guide in its own subtle panel (the `--sub` fill, a 1px `--line-2` line, rounded, as a code block in Claude's text; stderr stays beside it, red with its 1px rule). The same panel holds all shell output: a `!` command's (R5.13) and a shell's or monitor's view (R7.2) (2026-11-25). The result is truncated to the first 20 lines with "Show all N lines" for the full result; a second click closes it. An Edit, MultiEdit or Write that went through expands to its diff instead, in the same diff view a Files changed row opens (R5.9), cut at 20 lines with "Show all N lines", and its line shows `+N −M` in the Files changed colours once done; an edit rebuilt from a subagent's tool input has no line numbers, as in Files changed; a failed or denied edit shows its error and no diff (2026-11-25). A running step expands too, from its own line or from the live line "Working Bash(…)" that names it: its command or input at once, then a quiet "Running, 42s" with a live timer. The step's line and the live line are one step, so opening either opens both, and it stays open through redraws and restarts. The Agent SDK reports only a running tool's elapsed time, not its output, so in a session Synopia drives it adds "Output shows when it finishes"; a session Synopia doesn't drive reads "Running". When the result lands, the open step turns into the finished view in place.
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
  - A file path Claude writes as inline code in a reply (main or subagent transcript) opens with ⌘-click, as a Files changed row does: a text or source file in the preview, HTML in the browser, an image in the image viewer, anything else or a folder with its default app or in Finder. A path counts when it is absolute, starts with `~/`, or is relative with a `/` or a file extension; URLs, flags and code don't. A relative path is read from the session's folder and nothing else is guessed, so a bare name not in that folder stays plain; only a path that is there opens. With ⌘ held it shows the link look and a pointer; without ⌘ it reads as now, and a plain click selects text as before (2026-11-25).
  - Clicking the counts opens the diff, with line numbers from the stored patch, red and green rows. An expanded edit step shows the same diff view (R5.6, 2026-11-25).
- R5.10 Markdown renders as the CLI does:
  - bold
  - inline code in blue
  - `- ` lists
  - tables as tables, at 11px with a 1px rule between rows (2026-11-25): number cells and short cells (`~44 ms`, `418k + 386k`) stay on one line, the long text column wraps first, then the first column, and a table that still does not fit scrolls sideways in its own box, never past the panel. A column whose every cell is a number with an optional unit aligns right in tabular figures; one cell of text makes it a text column. Alignment written in the separator row (`:---:`, `---:`) wins.
  - code blocks
  - bare URLs and markdown links are clickable and open in the browser
- R5.11 Claude's questions and your answers render in the transcript. Answered questions appear as your turn.
- R5.12 Opening a subagent shows its own transcript in the same pane, with a breadcrumb back to the session. A subagent's view has no message box; to steer a subagent, ask the main session from Main conversation (2026-11-25; the SDK has no route to message a subagent, see docs/Agent SDK.md 'Messaging a running subagent').
- R5.12a A long transcript shows its last 160 items under a quiet link, "Show 160 earlier (N more)". Clicking it, or `g` at the top, loads the 160 before them without moving what you're reading; subagent transcripts too (2026-11-23).
- R5.12d What you last saw stays put (2026-11-25). While you look at a view at its end (within 40 px), it follows the end as it grows. A view you aren't looking at never scrolls: another session or view on screen, or the window in the background (the page hidden). Coming back, after a reload too, you are where you were (R3.9). G goes to the end. There is no "N new below" button (removed 2026-11-25).
  - Seen (2026-11-25): an item is seen once its first line has been on screen for 1 s in a row while the Synopia window is focused and that view is shown; everything above the furthest seen item is seen too. In a shell or monitor view the same goes for each line of its output. Flicking through sessions sees nothing.
  - Coming back to a session or view that got items you haven't seen (after another session or view was shown, or the window was hidden), a 1px link-blue line sits between the last item you saw and the first you didn't, labelled "New since 2:14 PM" in sentence case: the local time of the first unseen item (in a shell or monitor view, between two lines of output, with the time you last had it on screen). It takes no space, so nothing moves when it comes or goes. It stays while you read and scroll, G too, until you leave that view; coming back with nothing new, it is gone. Items that arrive while you watch get no line. A reload is not a coming back: the line stays where it was (R3.9).
  - No unread mark anywhere else: no sidebar dot, no bold title, nothing in the background panel, no new key, and the Dock badge doesn't count it. "Needs you" and "to review" say when your input is needed (2026-11-25).
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
- R5.13 The panel's last row, under its 1px line, drawn as a `❯` band being written: `❯` where a posted band's sits, so the draft sits where it will land. At least three lines tall, `❯` on the first line, the field growing for long messages; a click anywhere in the box focuses the field. There's no Send button and no hint row. Enter sends, Shift+Enter makes a new line, ⌘V pastes images. The placeholder says "/ for commands".
  - Pasted images show as thumbnails below the text (R5.12b sizes), each with a small ✕ on hover that removes it. Enter sends them with the text, as base64 PNG or JPEG of at most 5 MB each and 20 MB together (the socket caps a frame at 32 MB); more is refused with a toast. The thumbnails come from the pasted image itself, never the server (2026-11-24).
  - As in the Claude Code CLI, a paste puts an `[Image #N]` tag at the caret, with a space between it and any text before it, and a space after it unless one follows already, so typing goes on as a new word. N counts up through the session, as the CLI's does: one more than any tag in the session's prompts or the draft, never reused. The ✕ removes the image and its tag; the other tags keep their numbers. Deleting a tag's text leaves its thumbnail in the row, dimmed with a dashed line, and that image isn't sent (typing the tag back brings it back). The message goes as the CLI sends one: a text block with the tags in it, then the images in the order of their tags. Your prompts, sent from Synopia or from the CLI, show the tags in place as plain dim text, with the thumbnails below. A draft keeps its tags and images over a restart (R3.9) (2026-11-24).
  - Bash mode, as `!` in the Claude Code CLI (2026-11-24): a `!` typed as the first character turns the box's `❯` into a `!` in the CLI's bash pink (Synopia's `--bash`, light and dark), the `!` leaves the text, and the placeholder reads "Run a shell command in <folder>". Backspace on the empty box leaves the mode. There's no slash menu in it. Enter runs the command in the session's folder with your login shell (`$SHELL -c`, the login environment) and its output streams into the transcript, cut at 30,000 characters as the Bash tool's is. One command at a time per session: a second one stays in the box with a toast. Esc, Esc ends a running one (R9.4). The command and its output then go to Claude as context in the CLI's format (`<bash-input>`, `<bash-stdout>`, `<bash-stderr>`), without starting a turn, so Claude sees them with your next message. The transcript shows the command on your prompt's band with `!` for `❯`, its output under the drawn guide in the output panel of R5.6 (2026-11-25), cut at 20 lines with "Show all N lines", stderr apart (red, with a 1px rule at its edge), and a non-zero exit or "Stopped" noted, the same for a command run in the CLI. A session Synopia doesn't drive, or one a terminal holds, has no bash mode: the `!` is text, and the box shows its existing line.
- R5.14 `/` opens an autocomplete of the session's real commands and skills, with argument hints and descriptions aligned, matched fuzzily on the name with the letters highlighted (R3.14). ↑↓ moves, Tab or Enter fills, Esc closes.
- R5.15 `/mcp` is Synopia's own command (2026-11-25): typed in the box and sent, or chosen from the `/` menu (where it is listed), it opens the MCP panel for that session instead of sending a message, over the main area like the Open list. The panel lists the session's MCP servers, Synopia's own too, each with its status as a mark and a word: Connected (a still ring), Needs sign-in (the lock), Failed (a red square), Connecting (the turning mark), Disabled (a grey ring with a bar). ↑↓ or j k move between servers, ← → choose an action, Enter does it, Esc closes. The actions: Sign in (an HTTP, SSE or claude.ai server: your browser opens, the row reads "Waiting for the browser…" with the turning mark until the sign-in ends, then the server reconnects in the running session with no restart; while it waits, the row's one action is Cancel, which stops the sign-in with no error), Sign out, Reconnect, Disable and Enable. An action that fails says why in the panel, in one sentence. In a session a terminal holds, the panel says to type `/mcp` in that terminal.
- R5.16 A `/command` that the session can't run is not sent (2026-11-25): one that isn't in the session's command list (the `/` menu's) and isn't Synopia's own stays in the box, with the toast "/<name> works only in a terminal". A path such as `/Users/…` is a message; with no command list read yet, nothing is refused. A tool's output shows its web links as links that open in the browser (an MCP server's sign-in link, for one).

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
- R6.3 The card sits at the transcript's end, above the message box's line, between its own 1px lines (the storyboard's v3 frames); with the box it stays at the panel's bottom when the transcript scrolls:
  - a red header: "Needs you", the reason, "for 4 min", and "k of N answered"
  - one line per question (accordion): ✓, ● or ○, the header, and the answer or "Not answered"
  - only the current question is open, showing its text and option rows: cursor `›`, radio or checkbox, label, "Recommended" under it in green, description
  - the last row is always "type your own"
  - a footer with generic key hints and Send
- R6.4 Keys, in normal mode, while a card waits:
  - j/k (or ↓/↑) move the cursor through every option of every question as one list; moving past the last row opens the next question.
  - Space selects only: radio for single choice, toggle for multiple choice. It never advances.
  - i types in place, on the row:
    - On an option: it selects it and adds a note. The note goes back as `annotations.notes`.
    - On the last row: it types your own answer instead.
    - Enter saves, Esc cancels.
  - Enter on an option of a single-choice question selects it first, replacing an earlier pick. On multiple choice it selects nothing. On the last row it opens the in-place field, as i does, and the cursor stays there.
  - Enter then sends once every question is answered; otherwise it jumps to the first unanswered question.
  - No number keys, no h/l, no Tab.
  - Ctrl+J/K still switch sessions.
- R6.5 Permission prompt: sessions keep the user's permission mode (`auto`), so a permission card appears only when `auto` would ask. A session in plan mode stays in plan mode. The card shows the exact command in a code block, the folder, and Claude's reason. Rows: "Allow once", "Always allow" (says exactly what is remembered and for how long) and "Deny" (type a reason in place, optional). Enter on "Allow once" or "Always allow" sends it (R6.4); Enter on "Deny" sends a deny, with the reason if one is typed.
  - An "Always allow" rule for this session lasts until the session closes. Closing it (R3.6) clears its rules, so reopening asks again (2026-11-24).
- R6.6 Plan approval: the plan sits in the transcript as Claude's reply. The card holds only the decision: "Approve" or "Ask for changes" (typed in place). Enter on "Approve" sends it; Enter on "Ask for changes" opens its field (R6.4).
- R6.7 Answers appear in the transcript as your turn ("Allow once", "Denied: …", "Changes: …").
- R6.8 Detection: a session needs you while it has a pending `canUseTool` request: a question, a permission or a plan.
  - It also needs you, with no Synopia process, while its transcript ends a thread (the main conversation or a subagent) on a question or plan (AskUserQuestion or ExitPlanMode) that has no result yet: another Claude Code process asks it, typically a terminal that took the session (R3.2). A message sent then waits ("Waiting for the terminal to finish…"): the take-over doesn't end a CLI that waits on you. This beats working, the Dock badge counts it, its age counts from the question, and it clears when the answer lands.
  - The card above the message box then shows read-only: the red "Needs you" header with the reason and "for N min", every question open with its options (Recommended, descriptions, checkboxes for a multi-select), or the plan's two decisions under the plan in the transcript. It has no cursor, selection or keys, and its footer is one quiet line: "Asked in another Claude Code process. Answer it there." The transcript line says "Waiting for you: …, asked in another process". Once answered, the card goes and the answer shows as your turn.
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
  - Under it, inset as its children: a card per running item, ordered forks, subagents, shells, monitors, then oldest first. Each card has the kind mark, name, kind word in the kind colour, start time and a live timer. The sidebar's 1px tree guides join them (R4.3): a vertical line down from the main card's mark, a tick into each card at its mark's height, a corner on the last. The line runs past an expanded card to the last child.
  - A card that comes or goes tweens like a sidebar sub-line (R8.1): coming, the height opens, then the card fades in; going, the card fades out, then the height closes. The guides follow the height on every frame. A card whose item finishes stays in its place for 5 s, as in R4.2 (the status and still kind marks, the final duration), then leaves and its line appears in "Past".
  - A subagent's own shells and monitors (in its own transcript) hang under its card, one level deeper, with the same guides. They show only here: not under Main conversation, not in the sidebar's count, not in the main transcript. With no notification they run while their subagent runs; after it, they read as stopped, ended with their subagent. In "Past" they name it: "Resize the images in Build image thumbnails".
  - "To review": items waiting for review (section 10). A click anywhere on a card but "Mark reviewed" (or Enter on it) shows Main conversation with that subagent's "Report from" block near the top of the log, loading earlier items until it is there, and marks it briefly with the selection tint and the 1px blue ring of b, b, then fades; it is a scroll of yours, so the reading position and "New since" follow. With no report in this transcript it opens the subagent's own view, with no error. It marks nothing reviewed; a Past line still opens its item (R7.2) (2026-11-25).
  - "Past": one dim line per finished item, newest first, fading out at the bottom edge. Each line shows the status mark, the still kind mark, the name and the duration; failed and timed out are named.
  - The item you're viewing shows it one way, whatever its kind (Main conversation, a subagent, fork, shell or monitor card, a Past line): its 1px edge turns ink, and that is its only edge, over any state tint. A Past line gets the edge as a frame on the cards' edges, with its name in ink. Nothing moves or resizes when the selection moves. Hover only shades; keyboard focus is the blue ring.
- R7.2 Every row is a link that opens its item in the main pane, with nothing expanding in the panel (2026-11-25). A subagent or fork opens its transcript (R5.12). A shell or monitor opens its output as a terminal run:
  - The header has its description (or its command), "Running, 42s" or how it ended ("Finished", "Failed", "Stopped", "Timed out") with its time, the kind and its start, and whose it is with a link back to the main conversation (and to its subagent, for a subagent's own); the same height and lines as a subagent's header (R5.1).
  - The log is monospace: the tool line (`Bash(Serve the demo)` or `Monitor(…)`), the command in ink, then its whole output under the drawn guide in the output panel of R5.6, a monitor's events too (2026-11-25), as plain text (escape sequences taken out, a line a carriage return rewrote shown as it ended). A long output shows its last 64 KB in whole lines under "Show earlier output (48 KB more)", which, like `g` at the top, loads the part before without moving what you read (R5.12a). A monitor's output is its events, one per line, 500 at a time.
  - While it runs, what it prints appends live and the log ends with the moving kind mark and "Running 42s". When it ends, the log ends with the still status mark and "Failed after 3m, 02:03 PM." and its summary.
  - An output file the system already cleared reads "Its output file is gone"; a shell whose transcript names no output file says so.
  - Back to the main conversation works as from a subagent: the header's link, Main conversation in the panel, J/K. There is no message box, as in a subagent view (R5.12). The view comes back after a reload or restart (R3.9).
  A running card has no Stop row: stopping one background item waits for a key design (section 15, Q11).
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
  - retrying (2026-11-26): amber dashes turning backwards, "Retrying, attempt 4 of 10, in 3s". Every request Claude Code retries on its own shows, not only a throttled one; the live line adds the CLI's sentence and the countdown ("The security token included in the request is expired · retrying in 3s"). When the retries run out the turn fails, and the dock shows "Failed" with the sentence.
  - no updates: the working arc frozen and grey, "No updates for 16 min". A turn runs but nothing came for 15 minutes; the session may be gone.
  - sign-in expired (2026-11-26): needs you, "Needs you, sign-in expired". A retried request or a reply failed on the model's sign-in or credentials (an authentication or credential error, HTTP 401 or 403, or failing that the CLI's sentence). Synopia runs the folder's credential refresh command itself (the folder is the session's git root, else its folder), once per expiry and once for every session of that folder, in a pseudo-terminal: "Refreshing credentials…" with the working mark, the command's output live in the dock as a shell's output, one field that types a line into it (Enter), and Cancel. When it exits 0 the session goes back to working and Claude's next retry takes the new credentials, with nothing to send again. With no command saved, or when the command fails, the dock line reads "Run to refresh credentials: [command] Save", with why. Save stores the command for the folder and runs it now, and saved empty it is cleared. The field is prefilled with the folder's `awsAuthRefresh` setting, else an executable `bin/aws-login` there, else nothing. The command's output is shown only, never logged or stored. It clears when the next turn starts, a reply gets through, or the refresh succeeds.
  - needs you: two red pause stripes seesawing. It wins over every other status. Also after a turn that ended with a step auto mode blocked or a permission you denied, which Claude didn't redo: "Needs you, blocked" until you send a message. The step reads "Blocked by auto mode" or "Denied", not "Failed".
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
    - J/K: next or previous conversation inside the session: Main conversation, then the background panel's rows top to bottom (subagents, forks, shells and monitors, R7.2); after the last one, back to Main conversation.
    - j/k: scroll the transcript, or move the card cursor while a card waits.
    - g/G: top or bottom of the transcript; g at the top loads earlier items (R5.12a).
    - i/a: insert.
    - `/`: insert with the command menu open.
    - n: New session (the folder list, R3.3); o: Open session (R3.2). See R9.7.
  - Insert mode: typing goes to the message box, or to a field in the card. Esc returns to normal; the first Esc closes the command menu. A `!` first in the empty box is bash mode (R5.13), inside insert mode: the same keys, Enter runs the command, Backspace on the empty box leaves it, and the box keeps it when Esc goes to normal.
  - Clicking the message box enters insert mode.
  - In both modes, Ctrl+J/Ctrl+K: next or previous session. In a text field they replace the field's own Ctrl+K (delete to the end of the line) (2026-11-25).
- R9.2 The only mode indicator is the message box (2026-11-25, storyboard v3 A). In normal mode its `❯` and text are at half strength, its 1px line and the panel at full, with no fill or edge. In insert mode it is the band your message becomes: the band's fill and blue left edge (bash mode's pink edge with its `!`), at full strength. A prompt in the box (Interrupt?, Send to background?, Close this session?, Send all now?), the gone-folder line and a take-over's state keep it at full strength in normal mode, and so does a card above it. There is no ring and no whole-box opacity.
- R9.3 ⌘⇧[ and ⌘⇧] also switch sessions, as in iTerm.
- R9.4 Interrupt: Esc in normal mode while a turn runs turns the message box into "Interrupt?". A second Esc interrupts. Any other key or click dismisses it. An open in-place field on a card takes Esc first (R6.4).
  - The interrupt stops only the foreground turn. Background subagents, shells and monitors keep running, as in the CLI (R7.2).
  - Messages still queued at the interrupt go back to the message box.
  - A running `!` command (R5.13) is asked about the same way, and goes first: the second Esc sends SIGTERM to its own process group, then SIGKILL after 3 s, and it shows "Stopped". With a turn also running, the next Esc, Esc stops the turn (2026-11-24).
- R9.5 Send to background, as Ctrl+B in the CLI: b in normal mode, in a session Synopia drives whose turn runs a foreground Bash command or subagent, marks each such step in the transcript (a 1px blue ring on the selection tint) once: on the live line when the live line names it, else where the step is shown (its line, its group row, or its row in an expanded group), and turns the message box into "Send to background? b again. Any other key to keep it in front." A second b sends them all to the background. Any other key, a click or the turn ending dismisses it.
  - With nothing that can go, or in a session another process runs, b does nothing.
  - One prompt at a time: Esc under this prompt asks "Interrupt?" instead, and b under "Interrupt?" asks this.
  - The steps then show as background work in the right panel (R7) and end there with their notification. A toast says so only when nothing could go.
- R9.6 Close, in place of a Close button: x in normal mode, on any open session, turns the message box into "Close this session? x again. Any other key to keep it." When something runs it adds what will stop, for example "Claude's turn, 2 subagents and 1 shell will stop." A second x closes the session (R3.6). Any other key, a click or switching sessions dismisses it. The prompt is the only confirm: no dialog.
  - For a session another process runs, it asks "Remove it from Synopia? x again. Its other process keeps running.", and closing only removes it from Synopia.
  - One prompt at a time: Esc or b under it asks theirs instead, and x under theirs asks this.
  - In insert mode x types.
- R9.7 New session and Open session by key (decided 2026-11-25): n opens the folder list and o the Open list, in normal mode; in insert mode Esc comes first, as for every normal-mode key. No ⌘N or ⌘O and no menu items. In the folder list: typing filters, ↑↓ move (j/k too while the filter is empty), Tab completes a path or fills in the selected row's path, Enter starts, Esc closes.
- R9.8 Send queued messages now, as Ctrl+Enter in the CLI (decided 2026-11-25): f in normal mode, in a session Synopia drives whose main turn runs, while messages are queued (R5.5) or a draft is in the box, marks the queued bands (the 1px blue ring on the selection tint, as b, b marks steps) and turns the message box into "Send all now? f again. Any other key to keep them queued." A second f sends them now: the queued messages go first, in order, and the draft, with its pasted images, after them as your next message, queued or sent as any message is.
  - What changes in the turn is Claude Code's rule: a foreground Bash command or subagent of the main conversation goes to the background and Claude reads your messages in the same turn; when Claude is only writing, or runs something that can't move, the turn is interrupted and your messages run next. That end is not a Stop, and nothing comes back to the box. With nothing queued, the draft goes at once the same way (docs/Agent SDK.md, "Sending queued messages now").
  - Meanwhile the queued bands keep their look, then land as usual. When nothing can be done any more (nothing queued, or the step couldn't move), a toast says so.
  - With nothing queued and no draft, while a card waits (it comes first), or in a session another process runs, f does nothing, silently. In insert mode f types.
  - One prompt at a time: Esc, b or x under it asks theirs instead, and f under theirs asks this.

## 10. Deliverables for review

- R10.1 A subagent whose description starts with `For review: ` (the user's global rule in `agent-harness`) is a deliverable. When it finishes it shows:
  - a blue badge
  - a "To review" group in Background work
  - "N to review" under the session in the sidebar
- R10.2 It stays until the user clicks "Mark reviewed". Opening it doesn't count. The backend stores the marks (the last 1000; an older one goes, decided 2026-11-24). No custom per-type handling yet: a review item might be a PR, a file or anything else.

## 11. Visual system

- Light theme, with visible panels: the conversation (header, transcript and message box as one panel, R5) and background work. The canvas is `#EDEFF2` and the panels are white.
- UI font: Atkinson Hyperlegible Next. Transcript: JetBrains Mono NL.
  - Both fonts ship with the app in `app/web/fonts` (both OFL, license beside each). The page loads no font from the network, so offline and blocked runs keep the transcript grid (2026-11-24).
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
  - Everything has a dark variant, so no light patch is left: diffs and their gutters, code, tables, the needs-you cards, the Open list, the slash menu and model picker, toasts, the image viewer, the background panel's tree and the Main conversation card's tints, and the message box's insert band. The file preview asks `bat` for its dark theme (Coldark-Dark, as bat has no GitHub Dark).
  - The switch is instant, with no transition.

## 12. Data the app relies on

Verified in the spike and in live scripted runs. Details, sources and quirks: [Claude Code transcripts](Claude%20Code%20transcripts.md), [Claude Code terminals](Claude%20Code%20terminals.md), [Agent SDK](Agent%20SDK.md).
- Open sessions: Synopia's own list of the sessions it holds open, kept across restarts. Past sessions for the "Open session" list come from the SDK's `listSessions()`. Terminals come from `~/.claude/sessions/<pid>.json` (undocumented, read by one module, R3.2).
- Transcripts: `~/.claude/projects/<encoded-cwd>/<id>.jsonl`.
  - Subagents: `<id>/subagents/agent-<aid>.jsonl` plus `.meta.json` (agentType, isFork, description, toolUseId, spawnDepth, finished).
  - Edits: `toolUseResult.structuredPatch` holds the diff hunks with line numbers.
  - Answers: AskUserQuestion results read `"question"="answer"`.
  - Background work: task notifications in user messages carry the tool-use id, status and summary.
  - Reports: subagent reports arrive as `isMeta` user messages from `agent-message from="<aid>"`.
- SDK:
  - It lists, resumes and forks sessions. A fork can start in another folder: a new id with the whole history, filed under the new folder (R3.11).
  - It takes images, `canUseTool` (permissions, AskUserQuestion with `updatedInput.answers`), `supportedCommands()`, `supportedModels()`, `setModel()`, `interrupt()` and streaming input.
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
  - Files: `app/web/icon/icon.svg`, `icon-small.svg` (16 to 64px, with more contrast) and `favicon.svg`. `app/web/icon` is the only icon folder; the build and `prototype/app.html` read it.
  - Icons are still, since motion means running.
- The `.icns` file is built locally from the icon, with the tools that ship with macOS.

## 14. Not decided yet

- The sidebar banner for signed out ("2 sessions are blocked. Run aws sso login") from the status storyboard: the row and the status line show it, the banner isn't built.
- Plan rate limits (five-hour and weekly): the SDK documents them as unavailable on Bedrock, so only retries on throttling show.

## 15. Decisions

The author's answers to the design questions (chat, 2026-11-23 and 2026-11-24), numbered as asked. A later answer supersedes an earlier one where it says so.

- Q2 Open and closed: Synopia keeps its list of open session ids across restarts and shows their transcripts; the session's process starts on the first message. Close marks a session closed and hides it (R3.6).
- Q3 Claude-written content: model calls are free (work machine). Titles and the Now line are Claude-written and kept current. No drift detection and no "Split into a new session" (R3.8). The first-grouping suggestion (R4.8) is deferred.
- Q4 Transcript source: one reader tails every open session's JSONL and subagent files by byte offset, for terminal-held and Synopia-held sessions alike. The SDK stream carries only control and live state (pending `canUseTool`, `session_state_changed`, partial text).
- Q5 Transport: the backend listens on 127.0.0.1 on a random port and checks a per-start token, Host and Origin; the shell loads `http://127.0.0.1:<port>/?token=…` in a WKWebView over one WebSocket. The shell keeps the window, menus, keys, opening files and links, and the backend's lifetime. The page also runs in a browser for checks.
- Q6 Permission mode: keep the user's settings (`auto`), so a permission card appears only when `auto` would ask. Questions and plans come through `canUseTool`. Plan-mode sessions stay in plan mode (R6.5).
- Q7 New session: a clean, empty session, no worktree; the first prompt sets the tone and Claude names it. Its folder comes from the folder list (R3.3; 2026-11-25, superseding the stored setting of 2026-11-24).
- Q8 Stopping a turn: Esc, Esc in normal mode; messages still queued at the interrupt go back to the message box (R9.4).
- Q11 Interrupt and background work: as in the CLI, Esc, Esc stops only the foreground turn; background subagents, shells and monitors keep running (`perTaskStopAffordance: true`). The per-item Stop row is dropped until a key is designed (2026-11-24), so Synopia sends no `stopTask`.
- Q12 Terminal take-over, automatic both ways (supersedes Q1, Q9 and Q10): a terminal that opens a session Synopia holds takes it, and Synopia shows it read-only until the CLI exits. A send in Synopia on a terminal-held session waits until the CLI is idle, leaves a note on its terminal, ends it (SIGTERM, SIGINT at most, never SIGKILL) and resumes; while busy or waiting the box keeps the message ("Waiting for the terminal to finish…") and any edit or Esc cancels. One writer always (R3.2, R3.10).

Sessions in any folder (2026-11-25), from `prototype/folders-storyboard.html`:
- Keys n and o in normal mode; no ⌘N, ⌘O or menu items (R9.7).
- One fuzzy matcher, the nota port, for the folder list, the Open list, the `/` menu and the model picker (R3.14).
- Never scan the disk (R3.13): the folder list comes from known session folders only; completion is one read on Tab; "Folder gone" checks only rows on screen or the row chosen.
- A typed path that doesn't exist offers "Create folder <path> and start there", Synopia's only write (R3.3).
- No worktree creation and no worktree rows.
- No guessing where a moved repo went.
- No "Choose in Finder…" row.
- Continuing a session whose folder is gone forks it into the folder picked, settled by one scripted check (R3.11, [Agent SDK](Agent%20SDK.md#sessions-list-resume-fork)).

Rearchitecture decisions (2026-11-24):
- Real work data stays out of the tree: fixtures, storyboards and captured menus hold invented data only.
- The storyboards stay as design history; this document wins where they differ (R6.4, R8.3).
- Shell edits come only from `bashEditDiff` (flag setting plus a git repo); outside a git repo no shell-edit rows show, with no git-status fallback.
- "Always allow" rules for a session clear when it closes (R6.5).
- One window and one page per daemon; `restore` and toasts go to the page that acted.
- The fonts are bundled (R11).
- An action taken while disconnected (answer, a layout change, reviewed, close, interrupt) is refused with a toast and local state stays as it was; UI state is sent again on reconnect. The layout is the backend's: the page sends intents and draws the layout it gets.
- Future, out of the rearchitecture's scope and not to be blocked by it: the closing note (R3.6, FR-SES-15), the first-grouping suggestion (R4.8, FR-SIDE-06) and the signed-out banner (section 14, FR-STAT-06). FR ids are in [functional-requirements.md](functional-requirements.md).

## 16. Design notes

Why the rejected options lost, so they don't come back. The storyboards (`prototype/kind-storyboard.html`, `status-storyboard.html`, `needs-you-storyboard.html`) hold the full mock-ups; marks were judged at the sizes the app uses (64, 40, 30, 11 and 9 px; needs-you frames at 1440 by 1000 px). The storyboards load their fonts from Google Fonts when opened, so offline they show fallback type.

Status marks (R8.2, R8.7):
- Needs you is the seesaw: two stripes shrink and grow from the middle in turn, so the outline changes and you notice it at 12 px, while the middle stays put and still reads as a pause sign. It is the only up-and-down motion. Rejected: a level meter (reads as audio playing, the opposite of paused); escalator stripes (at 12 px each stripe is 3 px wide and the motion turns into shimmer); sliding stripes (a 1 px move is too small to catch from the corner of the eye); a turning pause sign (turning means working, and on its side it reads as an equals sign); the turning red square (turning means working).
- One needs-you mark for questions, permissions and plans: a dot for a question disappears into the stripes at 12 px, and a second or third animation is too close to the seesaw at real size; the row's words say which kind it is.
- Working is one arc for thinking and tools: two arcs for tools look the same at 12 px and swapping would flicker; speed alone is hard to judge in passing.
- Queued message: an arc with a dot beside it is twice as wide and shifts the title; a plain arc lets you forget a message waits.
- Compacting: a plain arc makes a long compaction look like a stuck tool.
- Rate limited: a turning hourglass reads as a blob at 12 px and its turning looks like the arc; a countdown ring jumps back when it starts over, which breaks the always-moving rule.
- Signed out: stripes on five blocked sessions look like five questions you would open one by one; a lock names the cause, and one banner says what to run (the banner is not built, section 14).
- Your turn: a prompt caret reads as an arrow or a link at 12 px; an amber ring is close to the closed ring; a dot with a small arc is twice as wide and the arc says working.
- For review: a blue flag blurs into a blob at 12 px and flags often mean a problem; a blue ring with a check is close to Done from a distance.
- Done: a check in a ring reads as a button.
- Stopped by you: a grey outline square is taken by Timed out.
- Failed: a marching outline draws the eye, but motion means busy or waiting, and failed is neither; it is too loud for a past row.
- Stale: a grey dashed ring is too close to the rate-limited dashes.
- Closed: no mark makes the row look like it is still loading.
- Starting: a grey arc differs from Working by colour only, which breaks the shape rule.
- Background marks: a slow arc for monitors differs from a subagent by speed only; keeping the arc for a stuck subagent hides that it needs you; no mark on past rows leaves failures to colour alone; an amber filled square for timed out differs from Failed and Stopped by colour only.

Kind marks (R8.3, R8.7):
- Subagent: a person glyph is gone at 9 px (a small spark becomes a dot); a bubble head can't hold its dots at 9 px.
- Fork: a two-arc spinner says nothing about forking, only its colour does; two dots parting are just two dots on a ring when still.
- Shell: chevrons marching look like fast forward; scrolling output lines merge into a grey patch at 9 px; a turning bar alone reads like a generic spinner. Nothing blinks: the cursor moves instead of switching on and off.
- Monitor: an eye's pupil moves by a pixel at 9 px, and the eye shape thins out; the radar sweep stays.

Needs-you card (R6.4, R6.9), from the problems the first card had:
- The question was shown twice: the transcript repeated it, then the card showed it again with other numbers.
- The turn looked finished: "Files changed" and "Worked for …, done" came after the open question.
- The status said nothing specific: it hid that there were two questions and how many were answered.
- Six bordered boxes of equal weight made the card about 560 px tall, with every question open at once.
- Numbers like "2.1" suggested a chord, but number keys reached only the first question.

Sessions in any folder (R3.3, R3.8, R9.7), from `prototype/folders-storyboard.html`:
- ⌘N and ⌘O in a File menu: the Mac convention, and they work in both modes, but every other Synopia key is a single letter in normal mode (i, x, b), and the author wants no new menu items. Both sets at once would be two ways to do each thing.
- A "Choose in Finder…" row: familiar with a mouse, but it knows nothing about your folders, is slow by key, and is a second way to what the typed path with Tab already does.
- Worktree rows (`git worktree list` in known repos): they would list a fresh worktree before its first session, but each opening runs git in the folders on screen, and the author starts in the repo and lets agents manage worktrees. A "New worktree…" row brings its own questions (branch, base, naming).
- Guessing where a moved repo went (the same git remote): a wrong guess continues a session in the wrong place; a few typed letters find the right one.
- The stored new-session folder (`settings.newSessionCwd`, default the most recent session's folder): no dialog, but a wrong folder showed only in small type and can't change after the first message. n, Enter costs one key more and shows the folder first.
- Starting at once and changing the folder in the header until the first message, or two commands (here, or ask): the first fixes the folder too late, the second is two ways to one thing.
- Listing folders on disk to fill the list: reading `~` and below sets off macOS privacy prompts, on every opening.
- Folder first, then sessions, in the Open list: two steps every time, for a case typing covers.
- Hiding sessions whose folder is gone: the history is still on disk and worth reading.

Session list (R3.8, R4.9): the first prototype showed one dark card per session with "Your move", "Mark as handled", "Copy resume" and a drift prompt ("Topic changed to …, Move it there"). Cards and drift detection were rejected: the sidebar list replaces the cards, and the user keeps one session per topic.

First grouping (R4.8), from the grouping experiment:
- References come only from what the user typed (user records, not tool results or meta records): document links (Notion, Linear), ticket ids, PR numbers, GitHub labels, notes folders, worktree folders (`repo.worktree-name`), and hand-offs from another session's subagent.
- Each kind has a weight: a hand-off 3.0, a worktree 1.2, a document link or label 1.0, a Linear issue or notes folder 0.8, a PR 0.6, a ticket id 0.5.
- Rarity decides: a reference counts by `log(n / sessions citing it)`, and one cited by more than max(3, a quarter of the sessions), such as `main` or a PR everyone cites, counts zero.
- Two sessions join when their shared references score at least 4.0 (weight × rarity × `log(1 + fewer mentions)`); a hand-off always joins the receiving session to the subagent's parent. Groups are transitive.
- A group is offered only with two or more sessions, one of them touched in the last 14 days.
- The experiment listed the strongest shared references as the reason for each group; the UI shows no "why grouped" (R4.9).

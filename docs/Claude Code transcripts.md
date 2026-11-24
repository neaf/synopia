# Claude Code transcripts

How Claude Code writes a session to disk, as Synopia reads it. The format is undocumented. Facts hold for CLI 2.1.325 to 2.1.330 (the SDK 0.3.330 bundles 2.1.330; the installed CLI was 2.1.325 for the terminal and shell-edit runs). Sources: code, tests, and shape-only scans (record kinds, field names, value types and counts, no values) recorded in `.ai-notes/app/README.md` at tag `rearch-base` "Facts settled" (2026-11-23 and 2026-11-24).

Pid files under `~/.claude/sessions/` are in [Claude Code terminals](Claude%20Code%20terminals.md). What the SDK stream says live is in [Agent SDK](Agent%20SDK.md).

## Files

| Path | Holds |
|---|---|
| `~/.claude/projects/<folder>/<sid>.jsonl` | the main conversation, one JSON record per line |
| `~/.claude/projects/<folder>/<sid>/subagents/agent-<aid>.jsonl` | one subagent's conversation |
| `~/.claude/projects/<folder>/<sid>/subagents/agent-<aid>.meta.json` | the subagent's facts: `agentType`, `isFork`, `description`, `toolUseId`, `spawnDepth`, `finished` |
| `~/.claude/plans/<slug>.md` | the plan text the CLI writes before ExitPlanMode asks |

- `<folder>` is the realpath of the session's cwd with every non-alphanumeric character replaced by `-` (`/tmp/x` gives `-private-tmp-x`). Synopia never builds it: it globs `projects/*/<sid>.jsonl` and takes the first match in name order. Code: `transcript.ts` `findTranscript` (also used by `cli-terminals.ts` `end`). Source: SDK spike row 1 (`spike/FINDINGS.md` at tag `rearch-base`).
- `CLAUDE_CONFIG_DIR` moves the whole tree; the backend's `--claude-dir` follows it.
- Records are single lines, usually under 60 KB; one record can be many MB (images, long tool results). The largest session seen is 55 MB in 4,200 lines (96.9 MB in a later scan). Test: `tail.test.ts` 139-170 parses 50 MB in under 2 s.
- The JSONL appears about 1 s after the SDK's `system/init` for a new session. Code: `transcripts.ts` `poll` looks again each second for a file that doesn't exist yet. Source: live run S1-6.

### Quirk: subagent meta lags or is half-written

- Symptom: `agent-<aid>.jsonl` exists with no `.meta.json`, or the meta fails to parse, or it lacks `finished` (5 of 162 seen).
- Cause: the CLI writes the two files separately and rewrites the meta in place.
- Workaround: the subagent watcher reports each `agent-<id>.jsonl` once and each meta whenever its size and mtime change; a meta that fails to parse is skipped and read again at the next change. A missing `finished` is not an end.
- Code: `tail.ts` `SubagentWatcher`.

### Quirk: plan approval rewrites the file

- Symptom: after an ExitPlanMode approval the JSONL shrinks or changes inode; offsets past the old end read garbage.
- Cause: the CLI rewrites the session file on plan approval.
- Workaround: the tailer resets (reads from 0, rebuilds state) on a shrink, an inode change or a rewrite in place. A same-size file with a new mtime whose first and last 4 KB are unchanged is a bare touch: nothing is read again. A file that grew is an append while the first 4 KB and the 4 KB before the old end are unchanged, else a rewrite. A rewrite in place that changes only the middle is missed.
- Code: `tail.ts` `step`, `sigOf`, `resetState`; `transcript.ts` `reset` (a new `ReadState`). Test: `tail.test.ts` "a bare touch …", "a rewrite in place that grows resets …". Source: live run S3.

## Record types

Every record has `type`. Most carry the common fields `parentUuid`, `isSidechain`, `userType`, `entrypoint` (`cli` for a terminal, `sdk-cli` for an SDK-driven CLI), `cwd`, `sessionId`, `version`, `gitBranch`, `uuid`, `timestamp`.

| `type` (subtype) | Meaning | Read by Synopia |
|---|---|---|
| `user` | your prompt, a slash command, tool results, meta notes | yes |
| `assistant` | one content block of Claude's response | yes |
| `attachment` with `attachment.type: queued_command` | a message or notification that arrived during a turn | yes |
| `system` `turn_duration` | turn end: `durationMs`, `messageCount`, `pendingBackgroundAgentCount`, `isMeta` | yes |
| `system` `stop_hook_summary` | turn end: `hookCount`, `hookInfos[{command, durationMs}]`, `hookErrors`, `preventedContinuation`, `stopReason`, `toolUseID` | yes |
| `permission-mode` | `{permissionMode, sessionId}` | yes |
| `custom-title` | `customTitle`, your rename; an empty one removes it | yes |
| `ai-title` | `aiTitle`, Claude's title | yes |
| `pr-link` | `prNumber` | no |
| `mode` | `{mode, sessionId}`, beside each `permission-mode` | no |
| `queue-operation` | `{operation, content, commandUuid, deliveryId, reason}` | no |
| `last-prompt`, `atis-latch`, `file-history-snapshot`, `api-request*`, `tools-used`, `system` `away_summary` | bookkeeping | no, skipped silently |

Code: `claude-jsonl.ts` `classify`. Source: formats audit X17; shape scan 2026-11-24.

## Assistant records: one block per record

- Each assistant record holds exactly one content block (841 of 841 in one session, 5,803 of 5,803 in its 94 subagents), with `apiBlockIndex`.
- The records of one response share `message.id` (1 to 9 records per id). Two records of one id with the same block type are common (two `tool_use`).
- A thinking block arrives as its own record before the text of the same id.
- Live, every `stream_event` `message_start` id equals the assistant records' `message.id` (7 of 7), so the stream preview is keyed by message id and block and cleared when a record of that id and block type lands. Code: `session.ts` `StreamPreview`.
- An API-error turn writes an assistant record with `isApiErrorMessage`, `error` (string), `failedResponseHadNoToolCall`, `streamCutCause`, `truncatedAfterOutput` and a text block.
- Synopia keys the latest response by `message.id` (by the record when it has none) and gathers its tool uses over all its records: a question in one record followed by another tool use in the next still waits, and a running Bash followed by a text block still runs. Code: `transcript.ts` `assistant`, `waiting`. Test: `transcript.test.ts` "a pending ask followed by a later block of its message still waits".

Source: `.ai-notes/app/README.md` at tag `rearch-base` "Facts (branch facts)" Streaming.

## User records and text prefixes

| Text starts with | Meaning |
|---|---|
| `<command-name>` then `<command-args>` | a slash command you typed |
| `<task-notification>` | a background task or subagent ended (see Background work) |
| `Another Claude session sent a message` (an `isMeta` record holding `<agent-message from="<aid>">`, report after `The report follows:`) | a subagent's report |
| `[Request interrupted by user]` | you stopped the turn |
| `[Request interrupted by user for tool use]` | you turned a tool down; Claude carries on |
| `[Tool call interrupted` | a tool result the CLI writes on resume for a question a quit left open |
| `[Image: source: <tmp path>]` (isMeta) | the CLI's own note after a pasted image; skipped |
| `<bash-input>`, `<bash-stdout>`, `<bash-stderr>` | a `!` command and its output (tag names `unverified` on a real CLI record) |
| any other `<` | system reminders, local command output, hooks; skipped unless it holds an image |

- `isMeta` records are skipped except the report form above.
- A user record whose content is only `tool_result` blocks is not a prompt.
- An AskUserQuestion result reads `The user answered: "<question>"="<pick>" notes: <note>. …`; multi-select picks join with `, `.
- Tool results: Edit and Write carry `toolUseResult.structuredPatch` (hunks with `oldStart`, `oldLines`, `newStart`, `newLines`, `lines`); a Write that creates a file has `type: "create"` and `content` instead.

Code: `claude-jsonl.ts` `bodyOf`, `userOf`. Test: `claude-jsonl.test.ts`. Source: `export_transcripts.py` (tag `rearch-base`), live runs S3 and M1-final.

### Images and image tags

- Image blocks in tool results are `{type: 'image', source: {type: 'base64', media_type, data}}`. All 725 seen came from Read; no MCP image result appears in any transcript seen, and the code reads one like a Read image.
- A Read of an image repeats the bytes in `toolUseResult.file` `{base64, type, originalSize, dimensions}` (614 of 614). Synopia reads only the block. Test: `images.test.ts` 112-114.
- A pasted image: one text block holding `[Image #N]` tags, then the image blocks in tag order, never interleaved. The counter spans the session (#3, #4, then #5 in the next prompt). Records carry `imagePasteIds`. A Synopia-sent message gets the same shape and the CLI adds `imagePasteIds` with its own counter. Whether the CLI renumbers after a removal is `unverified`.
- Image size comes from the header bytes: PNG IHDR; GIF `GIF89a` width and height little-endian at 6-9; WebP VP8 start code `9d 01 2a`, VP8L signature `0x2f` with 14-bit width-1 and height-1, VP8X 24-bit width-1 and height-1; JPEG SOF gives height before width, APP segments are skipped (scan the first 64 KB). Test: `images.test.ts` 34-56. Code: `transcript.ts` `imageSize`.

#### Quirk: mislabelled image type

- Symptom: a thumbnail has no size or the wrong shape.
- Cause: a record can label JPEG bytes `image/png`; browsers go by the bytes.
- Workaround: `imageSize` tries the declared type first, then the other served types.
- Code: `transcript.ts` `imageSize`.

## Messages sent during a turn

- A message sent while a turn runs lands as an `attachment` record, `attachment.type: queued_command`, text in `attachment.prompt`, `commandMode: 'prompt'`, with its own uuid. There is no user record for it.
- `prompt` is a string, or an array of text and image blocks (a message with a pasted image). Test: `images.test.ts` 122-137.
- Task notifications and subagent hand-backs queued during a turn use the same record with another `commandMode`.
- Other fields seen: `delivery_id`, `humanTurn`, `imagePasteIds`, `isMeta`, `origin`, `runId`, `source_uuid`, `usage`, `toolsUsedDelta`.
- A `shouldQuery: false` message (bash mode) is written as a `queue-operation` record, then a plain `user` record with string content and `queueTranscriptOnly`, `promptId`, `promptSource`, `turnAttributionKey`, `permissionMode`.

Code: `claude-jsonl.ts` `classify` (attachment), `session.ts` `settleOutbox`. Source: live runs S3 and `bang`.

## Turn ends

A turn opens with a prompt you typed (user record, slash command or `queued_command`) and closes with `turn_duration`, `stop_hook_summary` or an interrupt marker.

| Writer | Writes at a normal turn end |
|---|---|
| interactive CLI (`entrypoint: cli`) | `stop_hook_summary`, then `turn_duration` (1,464 of 1,466) |
| SDK-driven CLI (`entrypoint: sdk-cli`) | `stop_hook_summary`; `turn_duration` rarely (2 of 19, 0 in scratch runs) |
| either, interrupted or `error_max_turns` | neither |
| interactive CLI, API-error turn | `turn_duration` only (5 of 5) |

- An interrupt marker is followed by neither record in 28 of 32 cases; the marker itself closes the turn.

### Quirk: SDK-driven turns have no duration

- Symptom: "worked for" missing on sessions Synopia drives.
- Cause: the SDK-driven CLI rarely writes `turn_duration`.
- Workaround: a main-thread `stop_hook_summary` sets `workedMs` from your prompt's time; a later `turn_duration` wins.
- Code: `transcript.ts` `turnEnd`. Test: `transcript.test.ts` "worked for: an SDK-driven turn ends with stop_hook_summary only".

### Quirk: a failed turn read from the file alone looks running

- Symptom: a session another process drives through the SDK reads working after its turn failed or was interrupted.
- Cause: such turns write no turn-end record.
- Workaround: a turn running by the transcript alone ends after `QUIET_MS` (30 min) without a change; the publisher flushes every session each 60 s to notice.
- Code: `status.ts` `QUIET_MS`, `publisher.ts` `RECHECK_MS`.

## Interrupts

- An Esc interrupt during tools writes an error `tool_result` for each cut-short tool, then the user record `[Request interrupted by user` (or `… for tool use]`).
- `[Request interrupted by user for tool use]` means a tool was turned down; Claude carries on after it.
- Synopia reads the first marker as a stop (item `interrupted`) and the second as a turned-down tool (item `turnedDown`). Either closes the turn until Claude writes again; the error results just before the marker read as stopped. A turned-down marker isn't a prompt: the turn's time still counts from yours.
- Code: `claude-jsonl.ts` `CUT_SHORT`, `bodyOf`; `transcript.ts` `user`. Test: `transcript.test.ts` "a turned-down tool is not a stop …", `transcripts.test.ts` "turns".

## Background work

| Kind | Where its task id comes from |
|---|---|
| Bash with `run_in_background` | `toolUseResult.backgroundTaskId` |
| foreground Bash moved to background (Ctrl+B, a timeout, a message during it) | `toolUseResult.backgroundTaskId` too (17 seen), some with `backgroundedToDeliverMessage` |
| Monitor | `toolUseResult.taskId` |
| Agent launched async | `toolUseResult.status: 'async_launched'` and `agentId`; the launch result is not the end |
| TaskStop | `{task_id, task_type, command, message}` |

- Explore agents launch async even without `run_in_background`.
- A task ends with a `<task-notification>` holding `<task-id>`, `<tool-use-id>`, `<status>` (`completed`, `failed`, `killed` for a stopped shell) and `<summary>`.
- A subagent woken again after its first end notifies with `<task-id>` only; the code maps the agent id back to its tool use.
- A monitor's event notification has no `<tool-use-id>` and does not end the monitor.
- A foreground subagent's shells are stopped by the CLI when that subagent ends.
- The CLI writes a stop notification to the JSONL only when a turn runs; see [Agent SDK](Agent%20SDK.md#task-notifications).

Code: `claude-jsonl.ts` `userOf` (`toolUseResult`), `taskNotes`; `transcript.ts` `note`. Source: live run S4, shape scan 2026-11-24.

### Quirk: subagent shells have no task id in SDK sessions

- Symptom: a subagent's shell in a Synopia-driven session has no id to stop it by.
- Cause: an SDK-driven CLI writes no `toolUseResult` in a subagent's records (scratch runs 1 to 3). `unverified` beyond those runs: the live check is cited in code and notes only.
- Workaround: the id comes from the SDK's `system/task_started` (`task_id`, `tool_use_id`, `task_type: local_bash`, `owned_by_subagent`, `is_backgrounded`), kept over a rewrite. A foreground Bash gets `task_started` about 2 s after it starts; a foreground Agent at once.
- Code: `session.ts` `onMessage` (`task_started`), `transcript.ts` `taskStarted`, `refreshTool` (`fg`).

## Shell edits (`bashEditDiff`)

- A Bash result's `toolUseResult` is `{stdout, stderr, interrupted, isImage, noOutputExpected, staleReadFileStateHint?, bashEditDiff?}`.
- `bashEditDiff` is `{files: [{filePath, hunks, created}], moreFiles, changedFiles}`, or `{files: [], moreFiles, unavailable: true}` when the CLI can't diff (a folder made a git repo after the process started). Hunk lines start with `+`, `-` or a space.
- The CLI writes it only with both the flag setting `bashEditDiffEnabled: true` and a folder in a git repo. Without the setting nothing comes, in a git repo too. With both, `sed -i`, a `python3` write and an `echo >>` were each recorded.
- Outside a git repo Synopia shows no shell-edit rows (decision Q3, 2026-11-24).
- `staleReadFileStateHint` (string) flags a command that changed a file Claude had Read; only `sed -i` was recognised.

Code: `sdk.ts` `buildOptions`, `claude-jsonl.ts` `bashEditOf`, `transcript.ts` `bashPatchesOf`. Source: `.ai-notes/app/README.md` at tag `rearch-base` "Bash edits" (branch `bash-edits`, CLI 2.1.330).

## Plans

- ExitPlanMode's `tool_use` input in the JSONL can hold an older plan revision than `canUseTool`'s `input.plan`: the CLI reads the plan file when it asks, and a revision changed it. The page shows the request's plan while pending. Code: `transcript.ts` `toolUse` (`planOf`).
- The mode before plan mode falls back to `auto` when the transcript has no non-plan `permission-mode` record, even in a folder whose settings say `default`.
- During plan mode the transcript's `requestedModel` can differ from the session's model.

## Fixture rules

- Fixtures under `app/backend/test/fixtures/` are invented, never copied from `~/.claude/projects`.
- Assistant records in fixtures hold one content block each, as the CLI writes them; the records of one response share `message.id`, and block 2 onward of a response has the uuid `<uuid>-b<n>`. `claude-ext/e1e1…` holds a pending AskUserQuestion followed by a later block of the same response.
- Records whose status depends on age are dated at test time; see [Page checks](Page%20checks.md#date-relative-fixtures).

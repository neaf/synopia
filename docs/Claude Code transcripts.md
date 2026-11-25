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

- `<folder>` is the realpath of the session's cwd with every non-alphanumeric character replaced by `-` (`/tmp/x` gives `-private-tmp-x`). Synopia never builds it: it globs `projects/*/<sid>.jsonl` and takes the first match in name order. Code: `transcript.ts` `findTranscript` (also used by `cli-terminals.ts` `end`). Source: SDK spike row 1 (removed from the repo).
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
| `<bash-input>`, `<bash-stdout>`, `<bash-stderr>` | a `!` command and its output; one record can hold several, and text after them (see Bash mode records) |
| any other `<` | system reminders, local command output, hooks; skipped unless it holds an image |

- `isMeta` records are skipped except the report form above.
- A user record whose content is only `tool_result` blocks is not a prompt.
- An AskUserQuestion result reads `The user answered: "<question>"="<pick>" notes: <note>. …`; multi-select picks join with `, `.
- Tool results: Edit and Write carry `toolUseResult.structuredPatch` (hunks with `oldStart`, `oldLines`, `newStart`, `newLines`, `lines`); a Write that creates a file has `type: "create"` and `content` instead.

Code: `claude-jsonl.ts` `bodyOf`, `userOf`. Test: `claude-jsonl.test.ts`. Source: the old reference parser (removed from the repo), live runs S3 and M1-final.

### Quirk: a subagent's edits have no structuredPatch

- Symptom: in a subagent's transcript, Edit and Write steps had no `+N −M` and no Files changed block, though the files changed.
- Cause: in an SDK-driven session (`entrypoint: "sdk-ts"`), a subagent's successful Edit or Write result record has no `toolUseResult` at all; it carries `permissionDecision` and `serverClassifierContext` instead. Only an error result has one, a string. The main conversation's records of the same session have the full `{filePath, oldString, newString, originalFile, structuredPatch, userModified, replaceAll, contentNotInModelContext?}` (Edit) and `{type, filePath, content, structuredPatch, originalFile, userModified}` (Write). Same cause as the subagent shells' missing task id below. Seen in two subagents of one live session (2026-11-25, 20 Edits and 2 Writes, keys only).
- Workaround: a result with no patch takes the change from its `tool_use` input. An Edit is `old_string` against `new_string`, their common first and last lines as context, with no line numbers, because the place in the file isn't in the record. `replace_all` shows the one replacement. A Write is its `content` as added lines from line 1, never marked new, because whether it made or replaced the file isn't recorded. An error result gets no patch.
- Code: `claude-jsonl.ts` `inputEditOf`, `transcript.ts` `inputEdits`; the page leaves the number column empty for an `unnumbered` patch (`transcript.js` `diffHTML`). Test: `claude-jsonl.test.ts` "inputEditOf", `transcript.test.ts` "a subagent's edit with no toolUseResult", page check `files`.

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
- A `shouldQuery: false` message (bash mode) is written as a `queue-operation` record, then a plain `user` record with string content and `queueTranscriptOnly`, `promptId`, `promptSource`, `turnAttributionKey`, `permissionMode`; the ones held together go in one record (see Bash mode records).

Code: `claude-jsonl.ts` `classify` (attachment), `session.ts` `settleOutbox`. Source: live runs S3 and `bang`.

## Bash mode records

Synopia shares a `!` command as two `shouldQuery: false` messages (`bang.ts`): `<bash-input>CMD</bash-input>`, then `<bash-stdout>OUT</bash-stdout><bash-stderr>ERR</bash-stderr>`. The CLI does not write them as two records.

- Idle: one `user` record with string content, the two texts joined with one `\n`: `<bash-input>CMD</bash-input>\n<bash-stdout>…</bash-stdout><bash-stderr>…</bash-stderr>`. Fields: `queueTranscriptOnly: true`, `mergedSendUuids` (one uuid for the two sends; not the record's own), `promptSource: 'sdk'`, `promptId`, `permissionMode`, `turnAttributionKey`. Before it: `queue-operation` enqueue, then one dequeue per send. It is written when the command is shared, at its own time, not with the next prompt (2 of 2, a live SDK-driven session, 2026-11-25).
- During a turn: two `attachment` records, `attachment.type: queued_command`, `commandMode: 'prompt'`, string `prompt` (the input, then the output), with `source_uuid`, `delivery_id`, `timestamp` (the enqueue time), and `rendered`, `renderedRole` on the record. They are written when the turn takes them in, after the tool result that was running; `queue-operation` `remove` records (`commandUuid`, `deliveryId`, `reason`) sit between them (2 of 2, same session).
- Whether the record's `uuid` is the first send's uuid is `unverified`; Synopia also matches by command and time. Whether the CLI ever joins held context into the next prompt's record is `unverified` (not seen); Synopia reads that shape too.

### Quirk: a `!` row stuck at the end of the log

- Symptom: after a `!` command, its row stays below later messages, just above the live line.
- Cause: the parser took a `<bash-input>` record only when it held nothing else, so the joined record made no item. The run Synopia showed was never matched and stayed as the pending row at the end. During a turn, the two `queued_command` records starting with `<` were skipped the same way.
- Workaround: `bang.ts` `splitBash` reads every leading command with its output and keeps the text after them. `transcript.ts` makes one bang item per command, in place: the record's uuid goes to its only command, or to the prompt after them (the commands get `<uuid>:bang<n>`), and that prompt keeps only its own text. `claude-jsonl.ts` `classify` keeps `queued_command` records whose prompt starts with `<bash-input>` or `<bash-stdout>`; they make one bang item and no queued prompt. The scripted SDK writes both shapes.
- Code: `bang.ts` `splitBash`, `claude-jsonl.ts` `bodyOf` and `classify`, `transcript.ts` `user`, `session.ts` `settleBang`, `dev/scripted-sdk.ts` `flushHeld`. Test: `bang.test.ts` "splitBash", "in one record", "two commands in a row", "two queued_command attachments", "the one record the CLI joins it into"; `scripted-sdk.test.ts`; page check `bang.mjs`.

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

## Denied tool calls

A tool call a permission check said no to never runs. The CLI writes its `tool_result` with `is_error: true` and a string `content`, in a `user` record that also carries `toolDenialKind` and, for most, `permissionDecision`. `toolUseResult` is the string `"Error: "` plus the content.

| `toolDenialKind` | Who said no | `content` starts with |
|---|---|---|
| `automode-blocked` | auto mode's classifier; `permissionDecision` is `{decision: "reject", source: "config", reasonType: "classifier", reasonCode: "classifier:auto-mode", classifierCategory}` | `Permission for this action was denied by the Claude Code auto mode classifier` |
| `user-rejected` | you, at the terminal's permission prompt; a `[Request interrupted by user for tool use]` record follows | `The user doesn't want to proceed with this tool use` |
| `permission-rule` | a PreToolUse hook or a rule | `<tool_use_error>PreToolUse` |

- Allowed calls carry `permissionDecision` with `decision: "accept"` and no `toolDenialKind`.
- Synopia reads `automode-blocked` (or the content prefix alone) and `user-rejected` as the tool state `denied`, with `denied: "auto"` or `"you"`. The row reads "Blocked by auto mode" or "Denied", not "Failed". A hook or rule block stays failed: Claude reads its reason and carries on.
- After the turn ends, a denied step that no later step of the same tool and input redid makes the session "Needs you, blocked" (R8.2).
- Code: `claude-jsonl.ts` `Denial`, `toolResultOf`; `transcript.ts` `refreshTool`; `status.ts` `blockedLast`. Test: `claude-jsonl.test.ts` "a call auto mode blocked …", `transcript.test.ts` "a step auto mode blocked …", `status.test.ts` "blockedLast …". Source: shape scan of local transcripts 2026-11-25 (13 auto-mode blocks, 10 terminal denials, 52 hook or rule blocks).

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

### Background output

A shell's or monitor's view (R7.2) shows what it printed. Where that is:

| Kind | Source | Shape |
|---|---|---|
| shell (any of the three Bash kinds above) | its output file, named in its `tool_result` text: `… Output is being written to: <path> …` (the sentence before it differs: "Command running in background with ID: …", "Command was moved to the background (ID: …) …", "Command was manually backgrounded by user …", "Command did not complete within its 600s timeout …") and again as `<output-file>` in its end notification | `<tmpdir>/claude-<uid>/<project slug>/<session id>/tasks/<task id>.output`, plain bytes the command wrote, escape sequences included. Synopia never builds the path: it takes the one named. |
| monitor | its event notifications: `<task-notification>` with `<task-id>`, `<summary>Monitor event: "<description>"</summary>` and `<event>` (one or more output lines), no `<tool-use-id>`; the end notification can carry a last `<event>` | a user record whose content is that text; a subagent's monitor can be notified in its own file or the main one |

- The files sit in the system's temporary folder, which macOS clears: in a shape scan (2026-11-25) 52 of 79 named shell files were gone. A gone file reads "Its output file is gone".
- A monitor's `Monitor started (task …)` result names no file.
- The SDK typings also declare a `get_task_output` control request (the last 8 KiB only), but `Query` has no method for it, so Synopia doesn't use it; `task_notification.output_file` was empty for a shell in live runs.

Code: `claude-jsonl.ts` `OUTPUT_FILE`, `taskNotes` (`event`, `outputFile`); `transcript.ts` `outputOf`; `task-output.ts` (the byte windows). Test: `claude-jsonl.test.ts` "background output", `task-output.test.ts`, `publisher.test.ts` "a shell's and a monitor's view". Source: shape scan 2026-11-25 (key and tag names only).

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

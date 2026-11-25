# Agent SDK

How Synopia drives sessions through `@anthropic-ai/claude-agent-sdk` 0.3.330 (bundled CLI 2.1.330), and what the SDK does beyond its typings. Only the documented surface is used: the typings (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`), the docs and live scripted checks. `sdk.ts` is the only module that imports a value from the SDK: session processes, the menu probe, the writer's one-shot call and `listSessions()` all go through it, and it takes `query` and `listSessions` as one injectable pair (tests use `test/support/fake-query.ts`). Auth is the user's Bedrock setup from `~/.claude/settings.json` (AWS SSO). Sources: code, tests, the SDK spike (2026-11-23; since removed from the repo), and the live runs recorded in `.ai-notes/app/README.md` at tag `rearch-base` "Facts settled" (haiku, scratch folders under `/tmp/synopia-scratch/`, shapes only).

What the CLI writes to disk is in [Claude Code transcripts](Claude%20Code%20transcripts.md).

## Options Synopia passes

| Option | Value | Why |
|---|---|---|
| `prompt` | an `InputQueue` (AsyncIterable) | control calls need streaming input |
| `canUseTool` | the session's handler | questions, permissions, plans |
| `includePartialMessages` | true | the stream preview |
| `perTaskStopAffordance` | true | an interrupt spares background tasks |
| `settings` | `{bashEditDiffEnabled: true}` | shell edits in the transcript |
| `env` | `{...process.env, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1'}` | state events; `env` replaces |
| `permissionMode` | unset, `plan` for a plan session | the user's `auto` applies |
| `resume`, `model`, `effort`, `allowedTools` | per session | |

Code: `sdk.ts` `buildOptions`. Test: `sdk.test.ts`.

### Quirk: `options.env` replaces the environment

- Symptom: a session's tools lose PATH and everything else.
- Cause: `env` is the child's whole environment, not an overlay.
- Workaround: always spread `process.env` first.
- Code: `sdk.ts` `buildOptions`. Test: `sdk.test.ts`. Source: typings; SDK spike (removed from the repo).

## State events need an undocumented flag

- Symptom: no `system/session_state_changed` messages.
- Cause: the CLI emits them only with `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`. The typings list the message type but not the flag.
- Workaround: `sdk.ts` sets the flag; `status.ts` falls back to send-to-`result` when no state event comes.
- Values: `running`, `requires_action` (waiting on `canUseTool`), `idle`.
- Code: `sdk.ts` `STATE_FLAG`, `buildOptions`; `session.ts` `onMessage`. Source: SDK spike row 11 (removed from the repo).

## Streaming input and control calls

- `interrupt`, `supportedCommands`, `supportedModels`, `setModel`, `setPermissionMode`, `backgroundTasks` and `applyFlagSettings` work only when `prompt` is an AsyncIterable. Code: `sdk.ts` `QueryLike`, `InputQueue`.
- `system/init` comes again at the start of every turn, with `session_id`, `capabilities` and the slash commands. Synopia starts a turn in status from it and reads `capabilities`. Code: `session.ts` `onMessage`.
- A process started only with `shouldQuery: false` messages emits `system/init` but no turn and no `result`. Code: `session.ts` `onMessage` (`contextOnly`).
- `shouldQuery: false` user messages join the transcript without a turn and merge into the next user message that queries (sdk.d.ts 7033). Code: `sdk.ts` `SessionProcess.pushQuiet`.
- A message pushed during a running tool is queued, then folded into the same turn. Its uuid appears in `user_message_uuids` on the next `system/status` and on the `result`, not on any `assistant` or `stream_event`.

### Quirk: `interrupt()` takes no argument in the typings

- Symptom: a plain `interrupt()` leaves queued messages; they run after the abort as their own turn (spike row 10, `still_queued: [uuid]`).
- Cause: `Query.interrupt()` is typed without arguments; only the wire field `cancel_queued` shows (sdk.d.ts 5090).
- Workaround: when `system/init` `capabilities` lists `interrupt_cancel_queued_v1`, call `interrupt({cancelQueued: true})` through a cast. The receipt's `cancelled` uuids map to the texts and pasted images Synopia pushed (last 100 kept) and go back to the message box (`restore` with `images`), an image-only message too. Without the capability: the plain call, and a toast when `still_queued` lists Synopia's messages.
- Code: `sdk.ts` `QueryLike`, `realSdk` (the one cast), `CANCEL_QUEUED`, `SessionProcess.interrupt`. Test: `sdk.test.ts`. Source: live run S2-2 (CLI 2.1.330).
- An interrupted turn ends `result/error_during_execution` with `terminal_reason` `aborted_streaming` or `aborted_tools`. The subtype is not a reliable "stopped", so `SessionStatus.interrupted()` forces the turn's result to stopped. Code: `session.ts` `interrupt`, `status.ts`.

### `perTaskStopAffordance`

With `perTaskStopAffordance: true` an interrupt stops only the foreground turn; background subagents and shells keep running (a background `sleep 90` survived, live run S2-2). Without it an interrupt kills them. Source: sdk.d.ts 1929-1948. Code: `sdk.ts` `buildOptions`.

## Permissions under `auto`

- With `permissionMode` unset the user's `defaultMode` (`auto`) applies. Code: `sdk.ts` `buildOptions`.
- Under `auto`, `canUseTool` fires only when auto would ask. AskUserQuestion and ExitPlanMode always reach it. Bash (curl, `rm -rf` in /tmp), Edit, Write and Read outside the folder were auto-approved. Read-only Bash and `Agent` never reach it.
- Under `auto`, Bash and Edit reach `canUseTool` only through a `permissions.ask` rule, and then with no `suggestions` (no "Always allow" row).
- With `defaultMode: default` (folder settings or `permissionMode: 'default'`) they ask with suggestions.
- AskUserQuestion is a deferred tool: the model calls `ToolSearch select:AskUserQuestion` first, an extra round trip.

Source: live run S3-1 (CLI 2.1.330). No test pins the `auto` behaviour.

### `canUseTool` shapes

| Tool | `input` |
|---|---|
| AskUserQuestion | `{questions: [{question, header, options: [{label, description}], multiSelect}]}` |
| Bash | `{command, description}` |
| Edit | `{file_path, old_string, new_string, replace_all}` |
| Write | `{file_path, content}` |
| Read | `{file_path, offset, limit}` |
| ExitPlanMode | `{plan, planFilePath}`; the plan text is `input.plan` |

- `options`: `suggestions?`, `blockedPath?`, `decisionReason?`, `decisionReasonType?` (untyped), `serverPolicyAskOnly?` (untyped), `title?`, `displayName`, `description?`, `defaultToNo?`, `suppressAlwaysAllowRule?`, `toolUseID`, `agentID?`, `requestId`, `matchedAskRule?` `{source, toolName}`, `requiresUserInteraction` (untyped; AskUserQuestion and ExitPlanMode), `signal`.
- `suggestions` in default mode: Bash `[{type: 'addRules', rules: [{toolName: 'Bash', ruleContent: <command>}], behavior: 'allow', destination: 'localSettings'}]`; Edit and Write `[{type: 'setMode', mode: 'acceptEdits', destination: 'session'}]`; Read outside the folder `[{type: 'addRules', rules: [{toolName: 'Read', ruleContent: '//<dir>/**'}], behavior: 'allow', destination: 'session'}]`.
- Answer a question with `{behavior: 'allow', updatedInput: {...input, answers: {"<question>": "<label>"}}}`; multi-select picks join with `, `; notes go in `annotations.notes`.
- Deny gives `tool_result is_error=true` with the message and lists the call in `result.permission_denials`.

Code: `cards.ts`. Test: `cards.test.ts` (partly). Source: live run S3-1, spike rows 6-7.

### Quirk: plan approval needs an explicit mode

- Symptom: after an approval the session may land in `default` mode.
- Cause: approving ExitPlanMode does not restore the mode before plan mode.
- Workaround: the allow result carries `updatedPermissions: [{type: 'setMode', mode: <mode before plan, else auto>, destination: 'session'}]`. A `system/status` with that `permissionMode` follows at once, with no `conversation_reset`.
- Code: `sdk.ts` `planApproval`, called by `cards.ts` `settle`. Test: `sdk.test.ts`. Source: round-1 SDK edge review B6, typings, live run S3-1.

- A new session started with `permissionMode: 'plan'` reports `permissionMode: 'plan'` in `system/init`. Claude calls `EnterPlanMode` itself when asked (no card under `auto`).
- On resume the CLI answers a question a quit left open with a `[Tool call interrupted: …]` tool result.

## Menu: commands and models

- `supportedCommands()` and `supportedModels()` need a running `query()`. For a folder with no running process, `sdk.ts` `probeMenu` starts one idle query whose prompt never yields: the process starts, answers the control calls and makes no model call. It took 5.6 s and gave 57 commands and 11 models. It runs SessionStart hooks. Timeout 30 s; closed once read. After a failed probe `menu.ts` waits 1 min before the next, doubled per failure in a row up to 30 min, so views don't re-run the hooks each time. A running process's menu calls time out after 10 s, then the probe or the cache answers. Code: `sdk.ts` `probeMenu`, `readMenu`, `PROBE_TIMEOUT_MS`; `menu.ts` `RETRY_MS`, `PROCESS_TIMEOUT_MS`. Test: `menu.test.ts`.
- `commands_changed` replaces the commands.

### Quirk: command descriptions come HTML-escaped

- Symptom: descriptions read `&lt;file&gt;`.
- Cause: the SDK returns them escaped.
- Workaround: `unescapeHtml` on descriptions and argument hints.
- Code: `sdk.ts` `unescapeHtml`. Source: capture (a spike script, removed from the repo).

### Command and model list shapes

- Names starting `__` are internal (`__remote-workflow`); the backend drops them, so the page's menu never has them. Code: `sdk.ts` `toCommands`.
- `workflow-launch-exec` appears in the list but runs server-side only, so it does nothing in a session Synopia drives; `sdk.ts` `toCommands` drops it. Whether the live list still carries it is `unverified` (seen in the capture).
- One name can appear twice; the `builtin` row wins, as `/name` runs that one.
- Description suffixes: skills end with `(user)`, plugin skills start with `(<plugin-name>)`, workflows end with `(dynamic workflow)`, a removed built-in reads `(removed)`.
- Models: effort lists differ per model (one has none, some lack `xhigh`). `default` carries its own description naming the current default. Two models have `(Default)` in the display name. `resolvedModel` lets a transcript's full model id match an alias row.
- Model ids are Bedrock inference-profile ids: a region prefix (`eu.anthropic.`), an optional date and an optional `-v1:0`. `modelLabel` in `format.js` strips them (tested in `app/web/test/format.test.js`).

Source: capture by a spike script (removed from the repo; `prototype/menu.js` keeps its shape with invented user skills), live run S5-3.

## Live messages

| Message | Meaning | Code |
|---|---|---|
| `system/init` | turn start; `session_id`, `capabilities` | `session.ts` `onMessage` |
| `system/session_state_changed` | `running`, `requires_action`, `idle` (flag needed) | `session.ts` `onMessage` |
| `system/status` | `permissionMode` after an approval; `status: 'compacting' \| 'requesting' \| null` | `session.ts` `onMessage`, `status.ts` |
| `system/compact_boundary` | compaction done | `status.ts` |
| `system/api_retry` | `error_status: number \| null`, `error`; `rate_limit` or 429 is throttling | `status.ts` 17 |
| `system/task_started` | `task_id`, `tool_use_id`, `task_type` (`local_bash`, `local_agent`), `is_backgrounded`, `parent_task_id`, `owned_by_subagent`, `run_id` | `session.ts` `onMessage` |
| `system/task_updated` | a task's status changed | |
| `system/task_notification` | a task ended: `status`, `tool_use_id`, `summary`, `output_file`, `usage` | `session.ts` `onMessage` |
| `system/background_tasks_changed` | the list of background tasks | `session.ts` `onMessage` |
| `tool_progress` | elapsed seconds of a running tool, no output | `publisher.ts` `toolProgress` |
| `stream_event` | partial text; `message_start` id equals the assistant `message.id` | `session.ts` `StreamPreview` |
| `result` | turn end: `subtype`, `terminal_reason`, `permission_denials`, `user_message_uuids` | `status.ts` |

- Subagent messages carry `parent_tool_use_id` and `agent_id`. Subagent text isn't streamed unless `forwardSubagentText` is set.
- `tool_progress` (sdk.d.ts `SDKToolProgressMessage`) gives no output, so a tool's start is now minus the elapsed seconds, kept once per tool. When the first one comes for a foreground Bash, and whether subagent tools get them, is `unverified`.

### `backgroundTasks()` and the 2 s gap

- A foreground Bash gets `task_started` (`is_backgrounded: false`) about 2 s after it starts; a foreground Agent at once.
- `backgroundTasks()` before that returns true and moves nothing, so "send to background" waits for `task_started`.
- After `backgroundTasks()`: `background_tasks_changed` (one entry), `task_updated`, then the tool's result with `backgroundTaskId` and `backgroundedByUser` (Bash) or `agentId, canContinueAgent, isAsync, outputFile, status, …` (Agent). At the end: `task_updated`, `task_notification`, `background_tasks_changed` with no entries.

Code: `transcript.ts` `refreshTool` (`fg`). Source: background live run (CLI 2.1.330).

### Task notifications

- `stopTask(taskId)` emits `system/task_notification` with `status: 'stopped'` and the task's `tool_use_id` at once, also between turns.
- The JSONL gets its `<status>killed</status>` notification only when a turn runs next. A task ended between turns is kept in memory only; the JSONL's notification or the process-end mark covers a restart.
- A resumed process emits `stopped` notifications for the shells the previous process left behind.
- `stopTask` with a subagent shell's `task_started` id stopped it (2 then 0 processes by `pgrep`). Monitors were not run.
- Synopia has no Stop row and does not call `stopTask` (decision Q4, 2026-11-24); the facts above stay for when a key is designed.

Code: `session.ts` `onMessage` (`task_notification`). Source: live runs S4 and M1-final.

### Messaging a running subagent

The client has no direct route to a subagent; the main agent's `SendMessage` is the only one that works (R5.12).

- Documented surface: `SDKUserMessage.parent_tool_use_id` is documented only on output ("non-null when the message was produced inside a subagent"). The `priority` docs cover only when main reads a message. No `Query` method or control request addresses a subagent. The CLI docs say "Claude uses the `SendMessage` tool with the agent's ID or name as the `to` field". Typing into a subagent's transcript is an interactive-terminal feature ("With a fork's or subagent's transcript open, follow-up messages … go to that agent"), with no SDK counterpart.
- `parent_tool_use_id` set to the running Agent call's `tool_use` id, with the default priority, foreground or background: it doesn't work. The message goes to main: it appears in main's JSONL as `queue-operation` plus a `user` record, and main answers it. The subagent's sidechain never holds it, and its report says it heard nothing. There's no error or system message.
- The same with `priority: 'now'` and `origin: {kind: 'human'}`: on a background subagent, the same as above. On a foreground subagent, it stops the subagent (its `task_notification` comes with `status: 'stopped'`), main's turn ends with `result/success` and no reply, all within 0.1 s, in three runs. In the one run that kept reading, the stream ended there too.
- `SendMessage` through main: it works on a running background subagent. The user sends main a message asking it to `SendMessage` with `to` = the subagent's id (`task_started.task_id`). The call returns `{success, message, pin}`, the text arrives in the subagent's sidechain as an `attachment` record mid-run, and the subagent repeats it in its report. It costs one main turn, and main sees the text.

Source: live run SM-1 (2026-11-25; haiku; scratch folder `/tmp/synopia-subagent-msg/work`, five routes, shapes only; SDK 0.3.330 with its bundled CLI, `claude --version` 2.1.326). The script is outside the repo. No code depends on this.

## Sending queued messages now

f, f sends every queued message at once, like the CLI's Ctrl+Enter. Nothing in the code uses this yet.

### Documented surface

- CLI, [When Claude Code sends what you queued](https://code.claude.com/docs/en/interactive-mode#when-claude-code-sends-what-you-queued): "Your queued messages go out right away, with your draft queued behind them if you had typed one." What happens to the turn then depends on what Claude is doing:
  - "Running shell commands, subagents, or other work that can move to the background: that work moves to the background and keeps running, and Claude reads your messages in the same turn"
  - "Only writing a response, or running something that can't move to the background: Claude Code interrupts the turn and sends your messages next."
  - "If you queued a `!` shell command ahead of your messages, the key interrupts the turn."
- SDK, [`SDKUserMessage`](https://code.claude.com/docs/en/agent-sdk/typescript#sdkusermessage), `priority`:
  - "`'next'`, or no `priority` field: Claude reads the message in the same turn, as soon as the tool calls it is running finish. If the turn ends first, the message starts the next turn."
  - "`'later'`: Claude Code holds the message until the turn ends and sends it as a new turn."
  - "`'now'` with `origin: { kind: "human" }`: on Claude Code v2.1.286 or later, work that can continue in the background moves there, and Claude reads the message in the same turn. … When Claude is only writing a response, or the work it is running can't move, Claude Code interrupts the turn instead and Claude reads the message next."
  - "`'now'` without that origin: Claude Code interrupts the turn and Claude reads the message next."
- The docs say nothing about messages already queued when a `'now'` message arrives, and no public `Query` method changes the priority of a pushed message or drops one. `cancel_async_message` exists only as a wire request type in sdk.d.ts.
- `backgroundTasks()` with no id "backgrounds all foreground tasks (Ctrl+B semantics)" (sdk.d.ts `SDKControlBackgroundTasksRequest`).

### Observed, one fresh session per phase

The main agent ran a foreground `sleep 20` (or wrote a long reply, or ran a foreground subagent that runs `sleep 20`). Pushes came 5 s after the Bash `tool_use`, or 1.5 s after the first text delta.

| Phase | What happened |
|---|---|
| Default priority | Waited for the sleep. The message folded into the same turn at the tool boundary (`attachment` record, `queue-operation:remove`); its uuid is on that turn's `result`. |
| `'next'` | The same as the default. |
| `'later'` | The turn ended with `DONE`, then the message ran as its own turn (`queue-operation:dequeue`, `user` record). |
| `'now'` + human, Bash | Within 0.1 s: `background_tasks_changed` (1 task), then the Bash `tool_result` with `backgroundTaskId` and `backgroundedToDeliverMessage`. Claude read the message in the same turn (`result/success`, `completed`). When the sleep finished, a `task_notification` started a turn (`result.origin.kind` `task-notification`). |
| `'now'` without origin, Bash | No faster than the default: the sleep ran to its end. Then the turn ended (`result/success`, `terminal_reason` `aborted_tools`) and the message ran as a new turn. |
| `'now'` + human, text reply | The reply stopped at once: its partial `assistant` message came, then `result/success` with `aborted_streaming`, then a new turn with the message (`result.origin.kind` `human`). |
| Two at default, then one `'now'` + human | The sleep moved to the background and the turn ended with `aborted_tools`. The `'now'` message ran first as its own turn, then the two earlier messages ran together as the next turn. The order was 3, 1, 2. A later `'now'` overtakes the queue and does not take the earlier messages with it. |
| Two at default, then `interrupt({cancelQueued: true})`, then the two texts again as one `'now'` + human message | The receipt was `{still_queued: [], cancelled: [both uuids]}`. The interrupt killed the foreground sleep (`task_notification` `stopped`, an error `tool_result`, `result/error_during_execution`, `aborted_tools`). The re-pushed message then ran as a new turn with both texts in order. The state was sane, but the running work was lost. |
| Two at default, then `backgroundTasks()` (returned `true`), then a third at default | The Bash `tool_result` came 0.4 s later with `backgroundTaskId` and `backgroundedByUser`. All three folded into the same turn, in order, and the sleep kept running. |
| Long reply, two at default, then a plain `interrupt()`, then a third | The receipt listed both under `still_queued`. The turn ended `result/error_during_execution`, `aborted_streaming`. The two ran next as one turn, in order, then the third as its own turn. |
| Foreground subagent, `'now'` + human (`parent_tool_use_id: null`) | Only the subagent moved to the background (`background_tasks_changed` with 1 task). The Agent `tool_result` came with `isAsync, status, agentId, …`, main read the message in the same turn, and the subagent's own sleep ran on. Its report came later as its own turn (`result.origin.kind` `peer`). |
| Foreground subagent, two at default, then `backgroundTasks()` | The subagent and its own foreground sleep both moved (`background_tasks_changed` with 2 tasks). Both messages folded into main's turn in order. The subagent got its sleep's `tool_result` early and went on to other tool calls, so its work changed course. |

Harm: no message was lost and no stream ended, in any phase. Plain `'now'` with a foreground subagent did not stop it. Only `'now'` together with `parent_tool_use_id` stops one (see "Messaging a running subagent"). The losses were the running sleep after `interrupt({cancelQueued: true})`, and the subagent's sleep that `backgroundTasks()` moved.

### Recommendation for f, f

Leave the queued messages where they are, in the CLI's queue, and change the turn so the queue drains now:

1. Nothing queued: push the draft with `priority: 'now'` and `origin: {kind: 'human'}`. The CLI then applies its own rule: it moves the work to the background or interrupts the reply.
2. Messages queued and a foreground main-thread tool running (Synopia has its `task_started` with `is_backgrounded: false` and no result yet): call `backgroundTasks(toolUseId)` with that tool's `tool_use` id, so a foreground subagent's own shells stay where they are. Then push the draft at the default priority. Everything folds into the same turn in order. Before `task_started` (the 2 s gap for Bash) the call moves nothing, so wait for `task_started` or the tool's result, as "send to background" does.
3. Messages queued and Claude only writing, or running a tool that can't move: call the plain `interrupt()`, without `cancelQueued`, then push the draft at the default priority. The queued messages run next as one turn, in order, and the draft runs after them. This turn's end is not a Stop: don't force the status to stopped, and don't give the queued texts back to the message box.

Don't push `'now'` while anything is queued, because it overtakes the queue. Don't cancel and re-push as `'now'` either, because the interrupt kills the running tool. The `'now'` + `parent_tool_use_id` route stays forbidden. Not checked: a pending permission prompt, a queued `!` command (the CLI interrupts then), and WebFetch or WebSearch, which `'now'` detaches with `{detachedToolCall: true}` but `backgroundTasks()` may not move. Phase 2 passes `toolUseId`, which the check didn't run: it called `backgroundTasks()` with no id.

Source: live run PR-1, 2026-11-25 (haiku; scratch folder `/tmp/synopia-priority/work`, eleven phases, shapes and timings only; SDK 0.3.330 with its bundled CLI, `claude --version` 2.1.326). The script is outside the repo, at `/tmp/synopia-priority/check.mjs`.

## Sessions: list, resume, fork

- `listSessions()` gives `sessionId`, `cwd` (the realpath), `summary`, `customTitle`, `firstPrompt`, `gitBranch`, `lastModified`, `fileSize`. It honours `CLAUDE_CONFIG_DIR` (page checks rely on it). It took 87 ms over this machine's sessions. Code: `sdk.ts` `realSdk.listSessions`, `sessions.ts` `listRecent`. Source: live run S2-1.
- Map sessions with `listSessions().cwd`; don't build project paths.
- `options.resume=<id>` appends to the same file with the same id. `forkSession: true` gives a new id in the current cwd's project folder.
- Resume and fork re-send the whole history: one haiku fork of a large session cost $0.25. `unverified` as a general cost model (one spike run). Source: SDK spike row 3 (removed from the repo).
- A CLI can resume an SDK-made session and the other way round (CLI 2.1.323 read a 2.1.330 transcript).

### Resume and fork in another folder

Settled by one scripted check (`app/backend/perf/fork-cwd.mjs`, 2026-11-25, SDK 0.3.330, one haiku call): a session made in folder A, then A deleted, then two queries with `cwd` B that send only a `shouldQuery: false` message.

| Query | `system/init` | Where the new records go | `listSessions()` |
|---|---|---|---|
| `resume: <id>` | the same id, `cwd` B | appended to the old file in A's project folder | the session under A, `cwd` A |
| `resume: <id>, forkSession: true` | a new id, `cwd` B | a new file in B's project folder, with the whole history | the fork under B, `cwd` B |

- Both work with A gone; neither errors, and neither makes a model call (the turn's `result` is `success` with no assistant message).
- So a plain resume would leave a session that still names the gone folder. Synopia continues a gone-folder session as a fork (R3.11): `sdk.ts` `buildOptions` sets `forkSession` with `resume` and the new `cwd`, and `session.ts` `continueIn` sends the one context line.
- The typings' `forkSession()` function copies a transcript within a project folder (`dir`), so it can't move a session to another folder; Synopia doesn't use it.
- Code: `sdk.ts` `buildOptions`, `session.ts` `continueIn`, `sessions.ts` `continueSession`. Test: `sessions.test.ts` (continue), `scripted-sdk.test.ts` (fork). Source: the check above; the throwaway session's files were deleted after it.

## The writer's isolated call

Titles and the Now line come from a one-turn query that can't act and writes nothing:
`maxTurns: 1`, `tools: []`, `mcpServers: {}`, `strictMcpConfig: true`, `permissionMode: 'dontAsk'`, `settings: {disableAllHooks: true}`, `verbatimPrompts: true`, `persistSession: false`, cwd `<state>/writer`.
- `persistSession: false` and the private cwd keep the call out of `~/.claude/projects`.
- Whether `disableAllHooks` in flag settings is honoured for managed hooks is `unverified`; `includeHookEvents: true` logs any hook that still runs (`writer.done hooks=`).
- A result other than `success`, or a `success` with `is_error`, is a failed call: `writer.failed` logs the subtype and the last `assistant.error`, apart from `writer.done ok:false` (a reply that isn't the JSON asked for).

Code: `sdk.ts` `writerOptions`, `oneShot`; `writer.ts` `write`. Test: `sdk.test.ts`, `writer.test.ts`.

## Errors and Bedrock

- `assistant.error` and `api_retry.error` carry `SDKAssistantMessageError` (13 values, including `authentication_failed`, `cloud_credential_error`). Synopia reads `authentication_failed` and `cloud_credential_error` as signed out. Code: `status.ts` `AUTH_ERRORS` (67).
- Which value an expired Bedrock SSO login gives is `unverified`; the mapping is typings-based. Throttling and compaction shapes are typings-based too, never seen live. One live run failed every call with expired AWS credentials (the image-tag run).
- Plan rate limits (five-hour, weekly) are documented as unavailable on Bedrock.

## Process cost

- An idle `claude` child is 256 MB just after its turn, 140 to 175 MB at 25 to 80 s, 100 to 155 MB after 90 s (macOS compresses idle pages). Each writer call adds one more `claude` (245 to 290 MB) for a few seconds.
- Idle session processes end after 30 min.
- The backend stays under 200 MB RSS with the 15 largest sessions open (309 MB of JSONL); first view under 0.7 s.

Source: `app/backend/perf/transcripts.mjs`, `processes.mjs` (2026-11-23, 16 GB machine).

## The scripted SDK

`app/backend/dev/scripted-sdk.ts` implements the `Sdk` pair (`query`, `listSessions`) that `sdk.ts` consumes, from a script instead of a CLI. `main.ts --sdk-script <file>` passes it to `Sessions`, `Menus` and `Writer`; the page checks and `dev.sh --script` run on it, so they reach the real Sessions, status, writer and menu code with no model call. It reproduces these SDK facts:
- A query is told apart by its options: `canUseTool` set is a session's process, `persistSession: false` the writer's call, neither the idle menu probe.
- A turn starts with `system/init` (with `capabilities: ["interrupt_cancel_queued_v1"]`) and `session_state_changed: running`, and ends with `result`, then `session_state_changed: idle` ("State events need an undocumented flag").
- A user message sent during a turn is queued. `interrupt({cancelQueued: true})` lists under `cancelled` the queued uuids not yet in the transcript, and the turn ends `result/error_during_execution` with `terminal_reason: aborted_streaming`.
- A `shouldQuery: false` message joins the transcript and starts no turn ("Streaming input and control calls"). A message that starts a turn is written to the transcript as the CLI writes a prompt.
- `supportedCommands` and `supportedModels` return the script's `menu` in the SDK's shapes, HTML-escaped hints included ("Command and model list shapes").
- `resume` with `forkSession: true` gives a new id and copies the transcript into the new cwd's project folder with the new id and folder ("Resume and fork in another folder"); a process that took only `shouldQuery: false` context sends `system/init` and no turn.
- `listSessions()` gives one `SDKSessionInfo` per fixture transcript: `cwd` and `firstPrompt` from its records, `customTitle` and `summary` from its `custom-title` and `ai-title` records, `lastModified` from its mtime.

The script format and what it seeds are in docs/Page checks.md, "The scripted SDK". Test: `app/backend/test/scripted-sdk.test.ts`.

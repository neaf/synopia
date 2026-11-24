# Agent SDK

How Synopia drives sessions through `@anthropic-ai/claude-agent-sdk` 0.3.330 (bundled CLI 2.1.330), and what the SDK does beyond its typings. Only the documented surface is used: the typings (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`), the docs and live scripted checks. `sdk.ts` is the only module that imports a value from the SDK: session processes, the menu probe, the writer's one-shot call and `listSessions()` all go through it, and it takes `query` and `listSessions` as one injectable pair (tests use `test/support/fake-query.ts`). Auth is the user's Bedrock setup from `~/.claude/settings.json` (AWS SSO). Sources: code, tests, the SDK spike (2026-11-23; `spike/FINDINGS.md` at tag `rearch-base`), and the live runs recorded in `.ai-notes/app/README.md` "Facts settled" (haiku, scratch folders under `/tmp/synopia-scratch/`, shapes only).

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
- Code: `sdk.ts` `buildOptions`. Test: `sdk.test.ts`. Source: typings; SDK spike (`spike/FINDINGS.md` at tag `rearch-base`).

## State events need an undocumented flag

- Symptom: no `system/session_state_changed` messages.
- Cause: the CLI emits them only with `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`. The typings list the message type but not the flag.
- Workaround: `sdk.ts` sets the flag; `status.ts` falls back to send-to-`result` when no state event comes.
- Values: `running`, `requires_action` (waiting on `canUseTool`), `idle`.
- Code: `sdk.ts` `STATE_FLAG`, `buildOptions`; `sessions.ts` `onMessage`. Source: SDK spike row 11 (`spike/FINDINGS.md` at tag `rearch-base`).

## Streaming input and control calls

- `interrupt`, `supportedCommands`, `supportedModels`, `setModel`, `setPermissionMode`, `backgroundTasks` and `applyFlagSettings` work only when `prompt` is an AsyncIterable. Code: `sdk.ts` `QueryLike`, `InputQueue`.
- `system/init` comes again at the start of every turn, with `session_id`, `capabilities` and the slash commands. Synopia starts a turn in status from it and reads `capabilities`. Code: `sessions.ts` `onMessage`.
- A process started only with `shouldQuery: false` messages emits `system/init` but no turn and no `result`. Code: `sessions.ts` `onMessage` (`quietOnly`).
- `shouldQuery: false` user messages join the transcript without a turn and merge into the next user message that queries (sdk.d.ts 7033). Code: `sdk.ts` `SessionProcess.pushQuiet`.
- A message pushed during a running tool is queued, then folded into the same turn. Its uuid appears in `user_message_uuids` on the next `system/status` and on the `result`, not on any `assistant` or `stream_event`.

### Quirk: `interrupt()` takes no argument in the typings

- Symptom: a plain `interrupt()` leaves queued messages; they run after the abort as their own turn (spike row 10, `still_queued: [uuid]`).
- Cause: `Query.interrupt()` is typed without arguments; only the wire field `cancel_queued` shows (sdk.d.ts 5090).
- Workaround: when `system/init` `capabilities` lists `interrupt_cancel_queued_v1`, call `interrupt({cancelQueued: true})` through a cast. The receipt's `cancelled` uuids map to the texts Synopia pushed (last 100 kept) and go back to the message box. Without the capability: the plain call, and a toast when `still_queued` lists Synopia's messages.
- Code: `sdk.ts` `QueryLike`, `realSdk` (the one cast), `CANCEL_QUEUED`, `SessionProcess.interrupt`. Test: `sdk.test.ts`. Source: live run S2-2 (CLI 2.1.330).
- An interrupted turn ends `result/error_during_execution` with `terminal_reason` `aborted_streaming` or `aborted_tools`. The subtype is not a reliable "stopped", so `SessionStatus.interrupted()` forces the turn's result to stopped. Code: `sessions.ts` (`interrupted()`), `status.ts`.

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

Code: `answers.ts`. Test: `answers.test.ts` (partly). Source: live run S3-1, spike rows 6-7.

### Quirk: plan approval needs an explicit mode

- Symptom: after an approval the session may land in `default` mode.
- Cause: approving ExitPlanMode does not restore the mode before plan mode.
- Workaround: the allow result carries `updatedPermissions: [{type: 'setMode', mode: <mode before plan, else auto>, destination: 'session'}]`. A `system/status` with that `permissionMode` follows at once, with no `conversation_reset`.
- Code: `sdk.ts` `planApproval`, called by `answers.ts` `settle`. Test: `sdk.test.ts`. Source: round-1 SDK edge review B6, typings, live run S3-1.

- A new session started with `permissionMode: 'plan'` reports `permissionMode: 'plan'` in `system/init`. Claude calls `EnterPlanMode` itself when asked (no card under `auto`).
- On resume the CLI answers a question a quit left open with a `[Tool call interrupted: …]` tool result.

## Menu: commands and models

- `supportedCommands()` and `supportedModels()` need a running `query()`. For a folder with no running process, `sdk.ts` `probeMenu` starts one idle query whose prompt never yields: the process starts, answers the control calls and makes no model call. It took 5.6 s and gave 57 commands and 11 models. It runs SessionStart hooks. Timeout 30 s; closed once read. After a failed probe `menu.ts` waits 1 min before the next, doubled per failure in a row up to 30 min, so views don't re-run the hooks each time. A running process's menu calls time out after 10 s, then the probe or the cache answers. Code: `sdk.ts` `probeMenu`, `readMenu`, `PROBE_TIMEOUT_MS`; `menu.ts` `RETRY_MS`, `PROCESS_TIMEOUT_MS`. Test: `menu.test.ts`.
- `commands_changed` replaces the commands.

### Quirk: command descriptions come HTML-escaped

- Symptom: descriptions read `&lt;file&gt;`.
- Cause: the SDK returns them escaped.
- Workaround: `unescapeHtml` on descriptions and argument hints.
- Code: `sdk.ts` `unescapeHtml`. Source: capture (`spike/dump_menu.mjs` at tag `rearch-base`).

### Command and model list shapes

- Names starting `__` are internal (`__remote-workflow`); both the backend and the page drop them. Code: `sdk.ts` `toCommands`, `composer.js` 8.
- `workflow-launch-exec` appears in the list but runs server-side only, so it does nothing in a session Synopia drives; `sdk.ts` `toCommands` drops it. Whether the live list still carries it is `unverified` (seen in the capture).
- One name can appear twice; the `builtin` row wins, as `/name` runs that one.
- Description suffixes: skills end with `(user)`, plugin skills start with `(<plugin-name>)`, workflows end with `(dynamic workflow)`, a removed built-in reads `(removed)`.
- Models: effort lists differ per model (one has none, some lack `xhigh`). `default` carries its own description naming the current default. Two models have `(Default)` in the display name. `resolvedModel` lets a transcript's full model id match an alias row.
- Model ids are Bedrock inference-profile ids: a region prefix (`eu.anthropic.`), an optional date and an optional `-v1:0`. `modelLabel` in `md.js` 13-27 strips them.

Source: capture by `spike/dump_menu.mjs` (tag `rearch-base`; `prototype/menu.js` keeps its shape with invented user skills), live run S5-3.

## Live messages

| Message | Meaning | Code |
|---|---|---|
| `system/init` | turn start; `session_id`, `capabilities` | `sessions.ts` 869 |
| `system/session_state_changed` | `running`, `requires_action`, `idle` (flag needed) | `sessions.ts` 872 |
| `system/status` | `permissionMode` after an approval; `status: 'compacting' \| 'requesting' \| null` | `sessions.ts` 874, `status.ts` |
| `system/compact_boundary` | compaction done | `status.ts` |
| `system/api_retry` | `error_status: number \| null`, `error`; `rate_limit` or 429 is throttling | `status.ts` 17 |
| `system/task_started` | `task_id`, `tool_use_id`, `task_type` (`local_bash`, `local_agent`), `is_backgrounded`, `parent_task_id`, `owned_by_subagent`, `run_id` | `sessions.ts` 882 |
| `system/task_updated` | a task's status changed | |
| `system/task_notification` | a task ended: `status`, `tool_use_id`, `summary`, `output_file`, `usage` | `sessions.ts` 876 |
| `system/background_tasks_changed` | the list of background tasks | `sessions.ts` 885 |
| `tool_progress` | elapsed seconds of a running tool, no output | `views.ts` 566-570 |
| `stream_event` | partial text; `message_start` id equals the assistant `message.id` | `sessions.ts` `StreamPreview` |
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

Code: `sessions.ts` `onMessage` (`task_notification`). Source: live runs S4 and M1-final.

## Sessions: list, resume, fork

- `listSessions()` gives `sessionId`, `cwd` (the realpath), `summary`, `customTitle`, `firstPrompt`, `gitBranch`, `lastModified`, `fileSize`. It honours `CLAUDE_CONFIG_DIR` (page checks rely on it). It took 87 ms over this machine's sessions. Code: `sdk.ts` `realSdk.listSessions`, `sessions.ts` `listRecent`. Source: live run S2-1.
- Map sessions with `listSessions().cwd`; don't build project paths.
- `options.resume=<id>` appends to the same file with the same id. `forkSession: true` gives a new id in the current cwd's project folder.
- Resume and fork re-send the whole history: one haiku fork of a large session cost $0.25. `unverified` as a general cost model (one spike run). Source: SDK spike row 3 (`spike/FINDINGS.md` at tag `rearch-base`).
- A CLI can resume an SDK-made session and the other way round (CLI 2.1.323 read a 2.1.330 transcript).

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

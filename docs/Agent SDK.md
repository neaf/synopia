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
| `mcpServers` | `{synopia: <a fresh in-process server>}` | Synopia's tools for agents (below) |
| `title` | unset (2026-11-25) | the CLI writes it as a `custom-title` record, which Claude's titles never replace; a started session's title is seeded as its written title instead (`writer.ts` `seedTitle`) |

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
| `system/api_retry` | a request the CLI retries: `attempt`, `max_retries`, `retry_delay_ms`, `error_status: number \| null`, `error` (`SDKAssistantMessageError`), optional `no_response`; no sentence (see "Retried requests") | `status.ts` |
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
- Synopia calls `stopTask` from Esc, Esc in a background shell's or monitor's shell view (2026-11-26, R9.4), with the task id the transcript or `task_started` gave (`sdk.ts` `SessionProcess.stopTask`, `session.ts` `stopTask`); the `task_notification` that follows ends it. There is still no Stop row (decision Q4, 2026-11-24).

Code: `session.ts` `onMessage` (`task_notification`). Source: live runs S4 and M1-final.

### Messaging a running subagent

The client has no direct route to a subagent; the main agent's `SendMessage` is the only one that works (R5.12).

- Documented surface: `SDKUserMessage.parent_tool_use_id` is documented only on output ("non-null when the message was produced inside a subagent"). The `priority` docs cover only when main reads a message. No `Query` method or control request addresses a subagent. The CLI docs say "Claude uses the `SendMessage` tool with the agent's ID or name as the `to` field". Typing into a subagent's transcript is an interactive-terminal feature ("With a fork's or subagent's transcript open, follow-up messages … go to that agent"), with no SDK counterpart.
- `parent_tool_use_id` set to the running Agent call's `tool_use` id, with the default priority, foreground or background: it doesn't work. The message goes to main: it appears in main's JSONL as `queue-operation` plus a `user` record, and main answers it. The subagent's sidechain never holds it, and its report says it heard nothing. There's no error or system message.
- The same with `priority: 'now'` and `origin: {kind: 'human'}`: on a background subagent, the same as above. On a foreground subagent, it stops the subagent (its `task_notification` comes with `status: 'stopped'`), main's turn ends with `result/success` and no reply, all within 0.1 s, in three runs. In the one run that kept reading, the stream ended there too.
- `SendMessage` through main: it works on a running background subagent. The user sends main a message asking it to `SendMessage` with `to` = the subagent's id (`task_started.task_id`). The call returns `{success, message, pin}`, the text arrives in the subagent's sidechain as an `attachment` record mid-run, and the subagent repeats it in its report. It costs one main turn, and main sees the text.

Source: live run SM-1 (2026-11-25; haiku; scratch folder `/tmp/synopia-subagent-msg/work`, five routes, shapes only; SDK 0.3.330 with its bundled CLI, `claude --version` 2.1.326). The script is outside the repo. No code depends on this.

## Sending queued messages now

f, f sends every queued message at once, like the CLI's Ctrl+Enter (R9.8). `session.ts` `nowRoute` picks the route below, `sendNow` runs it.

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

### Live run PR-2: `backgroundTasks(toolUseId)`, a pending permission, bash mode's context

The same script with five more phases, one fresh session each, the same setup (pushes 5 s after the Bash `tool_use`).

| Phase | What happened |
|---|---|
| Foreground Bash, two at default, `backgroundTasks('toolu_…')` with an id no tool has, then with the Bash's id, then a third at default | The wrong id returned `false` and moved nothing. The Bash's id returned `true`: `background_tasks_changed` (1 task), then the Bash `tool_result` with `backgroundTaskId` and `backgroundedByUser` 0.7 s later. All three messages folded into the same turn, in order (one `status` listing the three uuids, three `queued_command` attachments in order). The sleep ran on; its `task_notification` started a turn later. |
| Foreground subagent running its own foreground sleep, two at default, `backgroundTasks(<Agent tool_use id>)` | `true`; `background_tasks_changed` with 1 task: only the subagent moved. The Agent `tool_result` came at once (`isAsync, status, agentId, …`), both messages folded into main's turn in order, and the subagent's own sleep ran to its end before its next step: unlike `backgroundTasks()` with no id, its work did not change course. |
| Foreground Bash, one at default 0.3 s after the `tool_use`, then `backgroundTasks(id)` before `task_started` and again after it | Before `task_started` (4 to 4.6 s after the `tool_use` in this run): `false`, nothing moved. After it: `true`, and the message folded into the same turn. With an id the call says when it moved nothing; with no id it returns `true` either way (see "`backgroundTasks()` and the 2 s gap"). |
| A Bash waiting on `canUseTool` (`permissionMode: 'default'`, `settingSources: []`, a command that writes), one at default, then `backgroundTasks(id)` and `backgroundTasks()` | With the id: `false`. With none: `true`, but nothing moved. Once allowed, the Bash ran in the foreground to its end, and the message folded in after its `tool_result`. A pending permission blocks the route: nothing can move until it is answered. |
| Foreground Bash, two `shouldQuery: false` context messages (bash mode's), two at default, `backgroundTasks(id)` | `true`; the Bash moved and all four folded into the same turn, in order (the `status` listed the context uuids first). Bash mode's context doesn't change the route. |

Harm: none. No message was lost or reordered, and no stream ended. `sleep` alone didn't reach `canUseTool` even in `default` mode (a read-only command needs no permission), hence the writing command in the permission phase.

### What f, f does (R9.8)

| Situation | Route |
|---|---|
| A card waits (Synopia holds messages behind it, so the CLI's queue is empty anyway) | Nothing: the card comes first. The page doesn't offer f; the backend refuses with a toast. |
| Nothing queued, a draft | The draft with `priority: 'now'` and `origin: {kind: 'human'}`. |
| Messages queued, main-thread foreground Bash or Agent steps with their `task_started` | `backgroundTasks(id)` for each, then the draft at the default priority. |
| The same, but a step's `task_started` hasn't come (the 2 s gap) | Wait for it, up to 8 s, then the above. Still not there: nothing changes, a toast. |
| Messages queued, Claude writing or running a tool that can't move | The plain `interrupt()`, then the draft at the default priority. The aborted result is not a Stop (`status.ts` `hurried`), and nothing goes back to the box. |
| A `!` command running | No change: it runs in Synopia, outside the turn; its context goes when it ends, and PR-2 shows that context doesn't change the route. |

Still unchecked: WebFetch and WebSearch, which `'now'` detaches (`{detachedToolCall: true}`). Synopia doesn't count them as movable, so with a queue they take the interrupt route.

Code: `session.ts` `nowRoute`, `sendNow`; `sdk.ts` `SessionProcess.push` (`now`), `interruptKeepingQueue`, `backgroundTasks(toolUseId)`; `transcript.ts` `foreground`. Test: `send-now.test.ts`.

Source: live run PR-2, 2026-11-25 (haiku; scratch folder `/tmp/synopia-priority/work`; SDK 0.3.330 with its bundled CLI; shapes and timings only; each phase's session files deleted after it). The phases are `bg-id-bash`, `bg-id-agent`, `bg-id-early`, `perm-bg` and `bang-ctx` in `/tmp/synopia-priority/check.mjs`.

## Synopia's tools for agents

Synopia gives the sessions it runs its own tools, through one in-process MCP server (R3.15). `agent-tools.ts` defines them; `sdk.ts` `toolServer` builds the server with the SDK's `createSdkMcpServer` and `tool()`, and `buildOptions` passes it as `mcpServers: {synopia: …}`, a fresh one for each process. The writer's call keeps `mcpServers: {}` and `strictMcpConfig`; the menu probe gets none.

### Documented surface

- [Give Claude custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools): `tool(name, description, zodShape, handler, {annotations})` in `createSdkMcpServer({name, version, tools})`, passed in `mcpServers`; the handler returns `{content: [{type: 'text', text}], isError?}`. TypeScript schemas are Zod (a peer dependency; `zod` is in `package.json`).
- The name is `mcp__<server key>__<tool>` ([MCP, tool naming](https://code.claude.com/docs/en/agent-sdk/mcp#tool-naming-convention)).
- `permission_policy: 'always_ask'` on the config's `tools` list (SDK 0.3.301+, CLI 2.1.301+) makes each call reach `canUseTool` even where an allow rule or `allowedTools` covers it. In `auto` mode the classifier may still approve a call unless the tool sets `destructiveHint: true`; for `always_ask` calls an unset hint counts as false ([TypeScript reference, permission modes that can approve an always_ask call](https://code.claude.com/docs/en/agent-sdk/typescript#permission-modes-that-can-approve-an-always_ask-call)).
- `alwaysLoad: true` on the server keeps its tools out of tool search, at full schema from the first turn.
- The docs name no streaming-input requirement for in-process servers; Synopia's prompt is an AsyncIterable anyway.
- `Options.title`: "Custom title for a new session"; a resumed session keeps its stored title.

### Live run TL-1

One scripted check, 2026-11-25 (haiku; scratch folder `/tmp/synopia-tools/work`; SDK 0.3.330 with its bundled CLI, `claude --version` 2.1.326; the user's `defaultMode: auto`; shapes only). The script is outside the repo, at `/tmp/synopia-tools/check.mjs`; its two throwaway sessions were deleted after it.

| Phase | What happened |
|---|---|
| Server, no policy, `destructiveHint: true`, `alwaysLoad` | `system/init` lists `mcp__synopia__start_session` in `tools` and `{name: 'synopia', status: 'connected'}` in `mcp_servers`. Four calls ran; `canUseTool` was never called: auto mode's classifier approved every one. |
| `always_ask` policy and `destructiveHint: true` | `canUseTool` was called for every call, also after an allow that passed `updatedPermissions`. `toolName` is the full name; `input` `{prompt, title}`; `suggestions` is empty (no "Always allow" from the CLI), `decisionReasonType: 'rule'`, `displayName: 'Start Session'`, no `title` or `description`; option keys `agentID, blockedPath, decisionReason, decisionReasonType, defaultToNo, description, displayName, mcpServer, requestId, serverPolicyAskOnly, suggestions, suppressAlwaysAllowRule, title, toolUseID`. A deny gave an `is_error` result and the call in `result.permission_denials`. |
| Resumed (`resume` of the first session, a new server) | The tool was listed and ran the same. |
| The writer's options, in the same process | `result/success`, no MCP server and no `mcp__` tool in `system/init`, no new project folder. |
| `Options.title` on a new session | The JSONL got one `custom-title` record (`{type, customTitle, sessionId}`) with the title. |

Transcript records:
- `tool_use`: an `assistant` record whose block is `{type: 'tool_use', id, name: 'mcp__synopia__start_session', input: {prompt, title}}`.
- `tool_result` of a call that ran: a `user` record, block `{type: 'tool_result', content: [{type: 'text', text}]}`, `toolUseResult` the same array; record keys besides the usual: `mcpCallNotReadOnly`, `permissionDecision`, `promptId`, `serverClassifierContext` (not always), `sourceToolAssistantUUID`.
- A handler's `isError: true` and a denial: `is_error: true`, `content` and `toolUseResult` a plain string; a denial adds `toolDenialKind` and `holdsPersonsWords`.

### Live run MC-2

One scripted check, 2026-11-25 (same SDK and CLI; `/tmp/synopia-mcp-login/check.mjs`, outside the repo; details in [Claude Code terminals](Claude%20Code%20terminals.md#claude-mcp-login-and-logout)). The user's Sign in on an HTTP server had failed with "this isn't an interactive terminal".
- `claude mcp login <name>` refuses to run with no TTY (exit 1, that sentence). Under `script -q /dev/null` (a pseudo-terminal) it opens the browser itself and waits for the OAuth callback. The `--no-browser` paste flow and an "Open in Terminal" fallback weren't needed.
- Still unverified: whether `reconnectMcpServer(name)` after a completed login connects the running session with no restart. The check stopped before the browser step, as no harmless OAuth server could be signed in to here (the MC-1 policy refuses test servers). Synopia still reconnects after both login and logout.

### What Synopia does with it

- Every tool is `always_ask` with `destructiveHint: true` (`sdk.ts` `toolServer`), so each call reaches the card under `auto` too.
- The CLI suggests no rule, so Synopia makes the "Always allow" row itself: an `addRules` session suggestion for the tool's name, stored in `state.json` `rules` as a card's rule is, and a later call it covers is allowed without a card (`cards.ts` `park`). The CLI's own copy of the rule changes nothing, as `always_ask` overrides it. It goes when the session closes (Q6).
- The transcript names the new session through the result's text (`agent-tools.ts` `startedText`, `startedFrom`); a refused call's string content has no id.
- Code: `agent-tools.ts`, `sdk.ts` `toolServer`, `buildOptions`; `cards.ts` `park`; `transcript.ts` `toolLine`. Test: `agent-tools.test.ts`, `scripted-sdk.test.ts`.

## MCP servers: status, sign-in

`/mcp` is the CLI's interactive screen; a CLI the SDK drives takes the prompt and answers nothing. Synopia's `/mcp` (R5.15) is a panel instead, over the documented control calls and the CLI's `claude mcp login|logout` ([Claude Code terminals](Claude%20Code%20terminals.md#claude-mcp-login-and-logout)).

### Documented surface

- `Query.mcpServerStatus(): McpServerStatus[]`: `name`, `status` (`connected | failed | needs-auth | pending | disabled`), `serverInfo?`, `error?` (when failed), `config?` (`McpServerStatusConfig`: the process-transport configs with `type` `stdio` (optional) `| sse | http | sdk`, or `{type: 'claudeai-proxy', url, id}`), `scope?` ("project, user, local, claudeai, managed"), `source?` (`sdk | plugin |` a config scope, an open set), `tools?`.
- `reconnectMcpServer(name)` and `toggleMcpServer(name, enabled)`: "Throws on failure".
- Nothing in the typings says whether a server uses OAuth. Synopia offers Sign in for the kinds `claude mcp login` names: `http`, `sse`, `claudeai-proxy`.
- `Options.onElicitation`: a `url` mode request carries `url` and `elicitationId`; without the callback "elicitation requests that aren't handled by hooks will be declined automatically". `system/elicitation_complete` names the server and the id.

### Live run MC-1

One scripted check, 2026-11-25 (SDK 0.3.330 with its bundled CLI, `claude --version` 2.1.330; haiku for the one model turn; scratch folder `/tmp/synopia-mcp/`, scripts `check.mjs`, `dyn.mjs`, `sdksrv.mjs`, `elicit.mjs` and a throwaway OAuth MCP server `server.mjs` outside the repo; shapes only; the throwaway sessions were deleted after it).

| Phase | What happened |
|---|---|
| The user's own config, read only (an idle query in a scratch folder) | `mcpServerStatus()` gave `[]` at once and 8 s later: this machine has no CLI-configured MCP server (`claude mcp list`: none, in the scratch folder and the repo). |
| `claude mcp add` / `add-json` of a 127.0.0.1 test server (temp `CLAUDE_CONFIG_DIR`) | refused: `Cannot add MCP server "<name>": not allowed by enterprise policy`, exit 1. A project `.mcp.json` with it is not listed (`get`: "No MCP server named"). |
| `Options.mcpServers` with `http`, `sse` and `stdio` servers | under the same policy none is listed by `mcpServerStatus()` and each control call throws `Server not found: <name>`: the policy drops them silently. |
| An in-process server (`createSdkMcpServer`) | the first `mcpServerStatus()` right after `query()` gave `[]`, the next one (at once) the server. Entry keys: `name, scope, serverInfo {name, version}, source, status, tools [{name, annotations}], transport` (`transport` is not in the typings); `status: connected, scope: dynamic, source: sdk`, no `config`. `reconnectMcpServer` threw "SDK servers should be handled in print.ts". `toggleMcpServer(false)` gave `disabled`, `true` `connected` again; reconnecting a disabled server threw "… is disabled — enable it (mcp_toggle) before reconnecting". Unknown names throw `Server not found: <name>`. |
| An in-process server's tool returns a text with a sign-in URL (one haiku turn) | the result is a `tool_result` with `content: [{type: 'text', text}]`, `toolUseResult` the same array, in the stream and the JSONL: the URL is plain text. |
| The same server asks a URL-mode elicitation (`server.elicitInput({mode: 'url', …})`), with and without `onElicitation` | `onElicitation` was never called; the server got "Client does not support url elicitation." in both runs. |

Unverified, as nothing could be signed in to here (the policy refuses every test server, and the user's machine has no OAuth server to sign out of and back in to in one script):
- whether `mcpServerStatus()` of a CLI-dialed HTTP server reads `needs-auth` before a sign-in, and its `config` and `scope` values;
- whether `reconnectMcpServer(name)` after `claude mcp login <name>` connects the running session with no restart, and whether a running session's status changes after `claude mcp logout` without a reconnect. Synopia reconnects after both;
- whether a CLI-dialed server's URL elicitation reaches `onElicitation`. Synopia passes no `onElicitation`, so such a request is declined; a portal's sign-in link that comes back as a tool's text shows as a link (R5.16).
- whether `toggleMcpServer` on an idle probe lasts to the session's next process.

### What Synopia does with it

- `mcp.ts` reads the status of the session's process (`SessionProcess.mcpControl`), or of an idle probe in the session's folder while no process runs (`sdk.ts` `mcpProbe`, closed 3 min after the panel last asked). A fresh source's empty answer and a `pending` server are read again every 0.5 s, 20 times at most.
- No Reconnect on an `sdk` server or a disabled one; Enable/Disable on all.
- Sign in runs `claude mcp login` under a pseudo-terminal (MC-2). While it waits the row reads "Waiting for the browser…" and has one action, Cancel, which kills the run; a cancelled sign-in shows no error and doesn't reconnect.
- Sign in and Sign out reconnect the server afterwards; a failed reconnect after a sign-in is its own sentence. Error sentences carry no URL.
- Code: `mcp.ts`, `sdk.ts` `mcpControlOf`, `mcpProbe`, `bundledCli`. Test: `mcp.test.ts`, `scripted-sdk.test.ts`.

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

## Plugins and an appended system prompt

Not used by Synopia yet: the facts the bundled agent-harness plugin will rest on (`.ai-notes/harness-and-open-items/`). The plugin format itself is in agent-harness `skills/harness-common/topics/Claude Code.md`, "Plugins".

### Documented surface

- `Options.plugins: SdkPluginConfig[]`, each `{type: 'local', path, skipMcpDiscovery?}`; a relative path resolves from `cwd`, `~` is not expanded, a missing path is skipped silently. `pluginDelivery: 'argv'` (default, one `--plugin-dir` per plugin) or `'initialize'` ([Plugins in the SDK](https://code.claude.com/docs/en/agent-sdk/plugins); typings).
- `system/init` lists `plugins` (`name`, `path`, `source`), `plugin_errors` only when a plugin or a component failed, and the namespaced `skills`, `slash_commands` and `agents`. `Query.reloadPlugins({addPlugins})` adds plugins to a running process.
- Plugin skills run as `/<plugin>:<skill>`, plugin agents spawn as `<plugin>:<agent>`. A personal skill of the same name loads too, and bare `/<name>` runs it ([Skills](https://code.claude.com/docs/en/skills), "Resolve skills that share a name").
- `Options.skills`: `'all'` or a list of names (`plugin:skill` for plugin skills) that the model may see and the Skill tool may run; omitted leaves the CLI's defaults.
- `Options.systemPrompt: {type: 'preset', preset: 'claude_code', append?, excludeDynamicSections?, snapshot?}` keeps Claude Code's prompt and adds `append` to it.

### Live run PL-1

One scripted check, 2026-11-26 (SDK 0.3.330 with its bundled CLI 2.1.330; haiku; scratch folder `/tmp/synopia-pl1/`, scripts `check.mjs` and `step4.mjs` outside the repo; a throwaway `CLAUDE_CONFIG_DIR`; shapes only). An invented plugin `pl1kit` with skill `greet`, a skill with `user-invocable: false` and agent `helper`; a personal skill `greet` in the throwaway config's `skills/`; each skill only replies with its own marker word. The `append` asked for a random code word.

Auth: with a throwaway HOME too, the menu calls answered but every model turn failed with `cloud_credential_error` ("Could not load AWS credentials") after an `awsAuthRefresh` from a settings source outside the throwaway config failed. The model turns ran with the real HOME and the throwaway `CLAUDE_CONFIG_DIR`, as MC-1 did. Four plugins enabled by the machine's managed policy loaded in every run, beside the one passed.

| Question | What happened |
|---|---|
| Do the plugin's skill and agent appear? | Yes. `init.plugins` has `{name: 'pl1kit', path, source}`, no `plugin_errors`. `skills` and `slash_commands` hold `greet` and `pl1kit:greet`; `agents` and `supportedAgents()` hold `pl1kit:helper` (`{name, description}`). `supportedCommands()` gives both `greet` rows with no `builtin`: the personal one's description ends `(user)`, the plugin's starts `(pl1kit)`. The `user-invocable: false` skill is in none of these lists. |
| Does `systemPrompt.append` reach the model? | Yes: asked for the code word, the reply was the word the append held. |
| Personal and plugin skill with one name | Both load. `/greet` ran the personal skill, `/pl1kit:greet` the plugin's. Asked to use the Skill tool with `greet`, the model called `Skill({skill: 'greet'})` and got the personal one. So a bundled skill never wins a bare name; it answers to its prefixed name only. |
| The hidden skill typed by the user | `/<name>` and `/pl1kit:<name>` both ended at once with "This skill can only be invoked by Claude, not directly by users. Ask Claude to use the "…" skill for you." (`result/success`, no model call). Whether the model can still load it through the Skill tool: `unverified` live. |
| Spawning the plugin agent | `Agent({subagent_type: 'pl1kit:helper', …})` was accepted and started (in the background). |
| Synopia's command filters (`sdk.ts` `toCommands`) | Keep both `greet` rows and all plugin rows: they drop only `__` names and `workflow-launch-exec`, and dedupe by exact name, so `greet` and `pl1kit:greet` stay two rows. The hidden skill never reaches the filter. |

The agent-harness checkout loaded the same way (branch `plugin-manifest`, after `install.py --plugin`; throwaway HOME, no model call): `init.plugins` row `agent-harness` with `source: 'agent-harness@inline'`, no `plugin_errors`; nine skills `agent-harness:<skill>` in `skills`, `slash_commands` and `supportedCommands()` (descriptions start `(agent-harness)`), all nine kept by `toCommands`; `harness-common` in none of them; six agents `agent-harness:<agent>` in `init.agents` and `supportedAgents()`.

What it means for Synopia's build: on a machine where `install.py` also installed the harness, every harness skill shows twice in the menu (`handoff` and `agent-harness:handoff`) and a bare name runs the installed copy. The skills spawn agents by bare names (`rearch-auditor`), which a plugin-only session doesn't have.

## Errors and Bedrock

- `assistant.error` and `api_retry.error` carry `SDKAssistantMessageError` (13 values, including `authentication_failed`, `cloud_credential_error`). Synopia reads `authentication_failed` and `cloud_credential_error`, and on a retry also HTTP 401 or 403, as the sign-in expired. Code: `status.ts` `AUTH_ERRORS`, `isAuthFailure`.
- Credentials that don't load give `cloud_credential_error` with no HTTP status (live run AR-1). An expired Bedrock token was reported by the user as "The security token included in the request is expired · retrying in 3s · attempt 4/10"; its `error` value is `unverified`, its 403 covers it either way. Throttling and compaction shapes are typings-based too, never seen live. One live run failed every call with expired AWS credentials (the image-tag run).
- Plan rate limits (five-hour, weekly) are documented as unavailable on Bedrock.

## Retried requests

Documented shape (sdk.d.ts `SDKAPIRetryMessage`): `attempt`, `max_retries`, `retry_delay_ms`, `error_status` (null for a connection error with no HTTP response), `error` (one of the 13 `SDKAssistantMessageError` values), `no_response` only for the first-byte timeout. It has no error text. The CLI's sentence ("The security token included in the request is expired") is in the transcript's `system/api_error` record, written just before (docs/Claude Code transcripts.md, "Retried requests"). A turn whose retries ran out ends with an `assistant` message carrying `error` and a `result` with `is_error: true` whose `result` string is the failure's sentence.

What Synopia does (2026-11-26): every `api_retry` is "Retrying, attempt N of M" with the sentence and the countdown, not only throttling. The sentence comes from the transcript, else from `error` and `error_status` (`status.ts` `retrySentence`). One function decides whether it is an authentication failure (`status.ts` `isAuthFailure`). It checks `authentication_failed` or `cloud_credential_error`, then HTTP 401 or 403, then the record's `isCloudCredentialError`, and the sentence only when the error is `unknown` with no status. Such a retry makes the session "Needs you, sign-in expired", and `creds.ts` runs the folder's saved refresh command. A failed result shows its `result` sentence. Code: `status.ts`, `creds.ts`, `pty.ts`. Test: `status.test.ts`, `session.test.ts`, `creds.test.ts`, page check `creds`.

### Live run AR-1

One scripted check, 2026-11-26 (same SDK and CLI; `/tmp/synopia-ar1b/check.mjs`, outside the repo). A throwaway `query()` on Bedrock with invented AWS credentials, a throwaway HOME, `CLAUDE_CONFIG_DIR` and AWS config files, `settingSources: ['project']`, and a `settings` file whose `awsAuthRefresh` was a script that only appends to a marker file. Shapes only:
- The credentials didn't load: two `api_retry` with `error: 'cloud_credential_error'`, `error_status: null`, `max_retries: 2` (a credential error has a short budget, about 1 s apart), then an `assistant` with `error: 'cloud_credential_error'` and `result/success` with `is_error: true`.
- The transcript had one `system/api_error` per retry: `error.message` and `error.formatted` (different strings), `isCloudCredentialError: true`, `retryAttempt`, `maxRetries`, `retryInMs`. The final assistant record had `isApiErrorMessage: true`, and its text equals the result's `result`.
- `awsAuthRefresh` didn't run: no marker. The SDK-run CLI didn't run it for credentials that don't load. Whether it runs for an expired SSO token under the SDK is `unverified`. The user reports it is unreliable in the terminal CLI too. So Synopia doesn't depend on it, and doesn't turn it off. It reads it only to prefill its own per-folder command (`sdk.ts` `awsAuthRefreshOf`, through the documented `resolveSettings()` over the user, project and local sources).

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
- For f, f ("Sending queued messages now"): `backgroundTasks(id)` (f, f's call) sends `background_tasks_changed` with that step's task, then takes the queued messages into the running turn as `queued_command` attachments, in order (`backgroundTasks()`, b, b's call, takes them in but moves no step, so `background.mjs` keeps its steps in the foreground); an interrupt while `stream_event` steps were writing a reply appends that reply's partial `assistant` record first, as the CLI does (2026-11-26); a plain `interrupt()` ends the turn the same way, then runs them next as one turn; a message with `priority: 'now'` during a turn is taken in at once.
- A `shouldQuery: false` message joins the transcript and starts no turn ("Streaming input and control calls"). A message that starts a turn is written to the transcript as the CLI writes a prompt.
- `supportedCommands` and `supportedModels` return the script's `menu` in the SDK's shapes, HTML-escaped hints included ("Command and model list shapes").
- `resume` with `forkSession: true` gives a new id and copies the transcript into the new cwd's project folder with the new id and folder ("Resume and fork in another folder"); a process that took only `shouldQuery: false` context sends `system/init` and no turn.
- A `call` step calls one of Synopia's own tools as the CLI does ("Synopia's tools for agents"): the `tool_use` record, `canUseTool` with no suggestions, the tool from the session's `mcpServers` (`agent-tools.ts` `callServed`), then the `tool_result` record, text blocks when it ran, a string with `is_error` when it refused or was denied. A new session's `Options.title` becomes a `custom-title` record with its first prompt.
- MCP: every query answers `mcpServerStatus`, `reconnectMcpServer` and `toggleMcpServer` from the script's `mcp.servers`, a session's own `mcpServers` as `source: sdk` (no reconnect, as MC-1), a disabled one refusing a reconnect; `Scripted.mcpRunner` is a pretend `claude mcp login|logout`: a sign-in takes `mcp.loginMs`, and the next reconnect connects; a login asked with no pty fails as the CLI's does (MC-2), and an abort (Cancel) ends it ("MCP servers: status, sign-in").
- A `retry` step reports a retried request as the CLI does ("Retried requests"): the transcript's `system/api_error` record with the sentence, then `system/api_retry`. Under the script the credential refresh runs its command with `sh -lc`, guesses no `awsAuthRefresh`, and runs again after 1.5 s instead of 60 s (`main.ts`).
- `listSessions()` gives one `SDKSessionInfo` per fixture transcript: `cwd` and `firstPrompt` from its records, `customTitle` and `summary` from its `custom-title` and `ai-title` records, `lastModified` from its mtime.

The script format and what it seeds are in docs/Page checks.md, "The scripted SDK". Test: `app/backend/test/scripted-sdk.test.ts`.

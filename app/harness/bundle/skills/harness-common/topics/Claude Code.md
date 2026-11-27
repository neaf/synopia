# Claude Code

Facts about Claude Code that the installer and the skills depend on. Vendor docs were read on 2026-11-25: [Subagents](https://code.claude.com/docs/en/sub-agents), [Tools reference](https://code.claude.com/docs/en/tools-reference), [Skills](https://code.claude.com/docs/en/skills), [Memory](https://code.claude.com/docs/en/memory).

Adapter: `skills/harness-common/scripts/claude_code.py`, called by `install.py`.

## Agent files

| Fact | Source |
|---|---|
| User agents live in `~/.claude/agents/`, project agents in `.claude/agents/`. Both are scanned recursively. Identity comes from `name`, not the file name. | Subagents doc, "Choose the subagent scope" |
| Several project `.claude/agents/` folders between the working directory and the repo root: the definition closest to the working directory wins for one `name`. | Subagents doc |
| Required keys: `name` and `description`. `name` cannot contain `:` or start with `-`. | Subagents doc, "Frontmatter reference" |
| `tools` is a comma-separated string or a YAML list. It restricts the agent to those tools. Without `tools` the agent inherits every tool available to subagents. `disallowedTools` removes tools. | Subagents doc |
| `model` takes a family alias, a full model id, or `inherit`. The doc lists the current aliases; the repo names none (FR-AGT-08). | Subagents doc, "Choose a model" |
| Claude Code watches `~/.claude/agents/` and `.claude/agents/`. A changed file is used by the next spawn, with no restart. | Subagents doc |
| The body after the closing `---` is the agent's system prompt. | Subagents doc |

Code: `claude_code.py:19-26` writes `name`, `description` and `tools`, then the preamble and the body. It writes no `model` line (FR-AGT-02). `install.py:48-70` rejects an agent source whose `tools` lists `Agent` or `Task`.

### Quirk: unquoted `: ` in a description

- Symptom: a description such as `Audits one aspect of a project for the rearchitect skill: reads every assigned file` is not valid YAML as a plain scalar. The docs say a file whose YAML does not parse is skipped, with the error in the `--debug` log. Yet an installed `rearch-auditor` agent with this description, unquoted, loaded and ran a full set of audits.
- Cause: unknown. The loader may be more lenient than strict YAML. `unverified`.
- Workaround: write every description as a double-quoted YAML string (FR-INST-11).
- Code: `claude_code.py:24` (`json.dumps`, a JSON string is a valid double-quoted YAML scalar).

## Model per spawn

| Fact | Source |
|---|---|
| The model of a spawn is the first of: the Agent tool's per-call `model` parameter, the agent file's `model`, `CLAUDE_CODE_SUBAGENT_MODEL`, the parent conversation's model. | Subagents doc, "Choose a model" |
| The Agent tool's `model` parameter takes an alias only, not a full model id and not `inherit`. | Subagents doc |
| The allowed values of `model` are listed in the Agent tool's definition in the session. The orchestrator reads them there. | Observed: a rearchitect run whose every spawn passed `model` from its `Models for this run` table |
| A resumed subagent keeps the alias it started with. | Subagents doc |

Code: `skills/harness-common/references/model-tiers.md` "The gate" and "Every spawn passes its tier's model".

## Nested spawns

| Fact | Source |
|---|---|
| By default a subagent can spawn its own subagents, up to three layers below the main conversation. `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` changes the limit; `1` turns nesting off. | Subagents doc, "Let subagents spawn their own subagents" |
| An agent without `Agent` in `tools`, or with `Agent` in `disallowedTools`, cannot spawn. | Subagents doc |
| At most 20 subagents run at once; the next spawn fails with `Concurrent subagent limit reached`. | Subagents doc, "Concurrent subagent limit" |

### Quirk: general-purpose subagents can spawn

- Symptom: a `general-purpose` subagent has the Agent tool and can start a third layer. The harness allows two layers at most (NFR-13).
- Cause: nesting is on by default, up to three layers.
- Workaround: every harness agent lists `tools` without `Agent`, and install rejects an agent that lists `Agent` or `Task`. The preamble says "You never spawn subagents". A brief for a `general-purpose` spawn carries the preamble rule "never spawn a subagent". The harness does not change the user's `settings.json`.
- Code: `agents/*.md` `tools` lines; `claude_code.py:11` (`SPAWN_TOOLS`), checked in `install.py:62-64`; `skills/harness-common/references/preamble.md`; `skills/harness-common/references/subagents.md` "Two layers" and "Brief minimum".

## Subagent environment

| Fact | Source |
|---|---|
| A subagent starts in the main conversation's working directory. `cd` does not persist between Bash calls. | Subagents doc |
| A background subagent keeps Read, Grep, Glob, Bash, Edit, Write, WebFetch, WebSearch, Skill, Monitor, TaskStop, SendMessage and the MCP tools, and loses most other built-in tools. | Subagents doc, "Available tools" |

## Monitor tool

| Fact | Source |
|---|---|
| Monitor runs a command in the background and turns each stdout line into an event for the session. | Tools reference, "Monitor tool" |
| Every watch has a deadline, `timeout_ms`: 5 minutes by default, 30 minutes (`1800000`) at most, 10 minutes in a `-p` run. At the deadline the watch ends and the session gets one notice. | Tools reference |
| Stopping a subagent stops the monitors it started. | Tools reference |
| Monitor commands follow the Bash permission rules. | Tools reference |

Code: `skills/feedback-watch/SKILL.md` "Arming it" arms `watch.py` with `timeout_ms` 1800000.

## Skills and global instructions

| Fact | Source |
|---|---|
| Personal skills live in `~/.claude/skills/<name>/SKILL.md`. The folder can be a symlink; Claude Code reads `SKILL.md` from the target. | Skills doc, "Choose where skills load" |
| A personal skill wins over a project skill of the same name. | Skills doc |
| Edits to `SKILL.md` text are picked up live. | Skills doc, "Live change detection" |
| A personal skill runs as `/<name>`, where `<name>` is the frontmatter `name` or the folder name. Custom commands (`~/.claude/commands/<name>.md`) have been merged into skills and keep working, so a command and a skill with one name give two sources for one `/<name>`. | Skills doc, intro note and "How a skill gets its command name" (read 2026-11-26) |
| `$ARGUMENTS` in a skill body is replaced with the full argument string as typed after `/<name>`. When the body holds no placeholder, Claude Code appends `ARGUMENTS: <value>` instead. `$N` and the named `arguments` frontmatter give positional access. | Skills doc, "Available string substitutions" and "Pass arguments to skills" (read 2026-11-26) |
| `argument-hint` is a Claude Code extension; claude.ai uploads and the Skills API reject it as an unexpected key. The harness skills leave it out. | Skills doc, "Using skill frontmatter outside Claude Code" |
| `~/.claude/CLAUDE.md` holds the user's instructions for every project. | Memory doc |
| A `CLAUDE.md` line `@path` imports that file. Relative paths resolve from the importing file. Imports nest four hops deep. An `@path` inside backticks or a code block is not imported. | Memory doc, "Import additional files" |

Code: `skills/handoff/SKILL.md` (`$ARGUMENTS`). `install.py:98-106` copies `instructions/global.md` to `~/.claude/CLAUDE.md` and links every skill folder into `~/.claude/skills/`; paths in `claude_code.py:14-16`.

## Task tools

| Fact | Source |
|---|---|
| The task tools (`TaskCreate`, `TaskUpdate`, `TaskList`, `TaskGet`) are the agent's working list; with `CLAUDE_CODE_ENABLE_TASKS=0` the older `TodoWrite` takes their place. | Tools reference (read 2026-11-26 for the open-items design) |
| They are on by default only for some models, and off for newer ones unless the user opts in. The doc names the models; the repo names none (FR-AGT-08). | Tools reference, as of CLI v2.1.268 |
| A shared task list (`CLAUDE_CODE_TASK_LIST_ID`) lives in `~/.claude/tasks/`, outside the repository, and only Claude Code reads it. | [Interactive mode](https://code.claude.com/docs/en/interactive-mode), "Task list" |
| A skill's description is in context every turn; its body loads only when the skill is invoked. After a compaction, the first 5,000 tokens of each invoked skill are attached again. | Skills doc (read 2026-11-26) |

Code: `skills/open-items/SKILL.md` "Task tools are not the ledger" (the ledger is a file in the repository, not a task list), and its size kept under 5,000 tokens; the always-loaded line in `instructions/global.md` makes the skill load when a reply leaves anything open (FR-OI-01).

## Shell commands from the prompt

| Fact | Source |
|---|---|
| A prompt that starts with `!` runs the rest as a shell command in the session, and its output joins the conversation. | [Interactive mode](https://code.claude.com/docs/en/interactive-mode), "Quick commands"; used by the maintainer (FR-GLB-12). |

Code: `instructions/global.md` (the `!` prefix rule), `skills/rearchitect/SKILL.md` (commands suggested to the user).

## Plugins

Docs read on 2026-11-26: [Plugin manifest reference](https://code.claude.com/docs/en/plugins-reference), [Add components to a plugin](https://code.claude.com/docs/en/plugins/components), [Plugins in the SDK](https://code.claude.com/docs/en/agent-sdk/plugins), [Skills](https://code.claude.com/docs/en/skills), [Subagents](https://code.claude.com/docs/en/sub-agents); Agent SDK typings 0.3.330 (`sdk.d.ts` `Options.plugins`, `SdkPluginConfig`, `Options.skills`, `Options.systemPrompt`, `SDKSystemMessage`). Live: Synopia `docs/Agent SDK.md`, "Live run PL-1" (CLI 2.1.330).

| Fact | Source |
|---|---|
| The manifest is `.claude-plugin/plugin.json` under the plugin root, and it is optional. Without it the components in the standard layout load, named after the directory. Every other file sits at the plugin root, not in `.claude-plugin/`. | Manifest reference, "Manifest file" |
| `name` is the only required key: kebab-case, no spaces, `@` or `:`. Every component is namespaced under it. Names starting `claude-`, `anthropic-` or `cc-plugin-` are reserved. Unknown top-level keys are stripped with a validate warning. | Manifest reference, "Fields", "`name`" |
| Default folders: `skills/<name>/SKILL.md`, `commands/*.md` (older format), `agents/*.md` (subfolders join the name with `:`), `hooks/hooks.json`, `.mcp.json`, `bin/`. A `CLAUDE.md` at the plugin root is not loaded; `claude plugin validate` warns. | Manifest reference, "Standard layout" |
| `skills` adds folders to the `skills/` scan. `agents` and `commands` replace their default scan. `agents` takes `.md` file paths only, never a folder. Every path starts with `./`, stays inside the root and must exist, else that component does not load. | Manifest reference, "How each key combines with its default location", "Path rules" |
| A plugin skill runs as `/<plugin>:<skill>`; a frontmatter `name` replaces only the last segment. A plugin agent is `<plugin>:<name>` (`@agent-<plugin>:<name>`), and is the subagent type to spawn. | Components doc, "Skills", "Agents" |
| Plugin agents ignore `permissionMode`, `hooks`, `mcpServers` and `initialPrompt`. | Components doc, "Frontmatter fields in plugin agents"; Subagents doc |
| `${CLAUDE_PLUGIN_ROOT}` is substituted in skill, command and agent bodies; it is not in the Bash tool's environment. | Manifest reference, "Environment variables" |
| Name clashes: a plugin skill and a personal or project skill of one name both load, as the plugin one is namespaced. Bare `/<name>` runs the personal one. For agents the plugin is the lowest scope, but its names carry the prefix too. | Skills doc, "Resolve skills that share a name"; Subagents doc, scopes table |
| `user-invocable: false` hides a skill from the `/` menu, and typing `/<name>` is refused; Claude can still load it. `disable-model-invocation: true` is the reverse. | Skills doc, "Control who invokes a skill" |
| The SDK loads a plugin with `plugins: [{type: 'local', path}]` (absolute, or relative to `cwd`; no `~`). A missing path is skipped silently. `system/init` lists `plugins` (`name`, `path`, `source`), `plugin_errors` when any, the namespaced `skills` and `slash_commands`, and `agents`. `Options.skills` (`'all'` or names, `plugin:skill` for plugin skills) filters what the model sees. | SDK plugins doc; typings |
| `claude plugin validate <dir>` checks a plugin; it warns on a missing `version` or `author`, and lists what the plugin provides. | Manifest reference, "Validate the manifest"; run on this repo 2026-11-26 |

Observed in PL-1 (an invented plugin with skill `greet`, a user-invocable-false skill and agent `helper`, plus a personal skill `greet`):
- Both `greet` rows appear in `skills`, `slash_commands` and `supportedCommands()`, with no `builtin` flag. The personal row's description ends `(user)`; the plugin row's starts `(<plugin>)`. The hidden skill is in none of the three lists. The agent is in `init.agents` and `supportedAgents()` as `<plugin>:helper`.
- `/greet` and a Skill tool call with `greet` ran the personal skill. `/<plugin>:greet` ran the plugin skill. Typing the hidden skill's name gave a local refusal ("can only be invoked by Claude"), with no model call.
- Whether the model can load a `user-invocable: false` plugin skill through the Skill tool: `unverified` live (docs say yes).

Code: `.claude-plugin/plugin.json`; `install.py` `plan_plugin` renders the `agents` files (FR-PLG-03). Test: `tests/test_repo_rules.py`, `tests/test_install.py`.

### Quirk: plugin agents are namespaced

- Symptom: loaded as a plugin, the harness agents are `harness:rearch-auditor` and so on. A skill that spawns `rearch-auditor` finds no such agent unless `install.py` also put it in `~/.claude/agents/`.
- Cause: every plugin component is namespaced under the plugin name.
- Workaround: skills keep bare names; the orchestrator spawns the name the session lists, `harness:rearch-auditor` when only that is listed (FR-PLG-04). The general-purpose fallback (FR-AGT-05) is only for an agent listed under neither name.
- Code: Spawns tables in `skills/*/SKILL.md`; `references/subagents.md` "Agent names".

### Other plugins

| Fact | Source |
|---|---|
| `frontend-design` is a Claude Code plugin skill under `~/.claude/plugins/cache/claude-plugins-official/frontend-design`. | Directory listing, 2026-11-25 |
| This repo neither ships nor installs it. Skills name it "when available" and work without it. | `skills/storyboard/SKILL.md:10`, CON-CC-04 |
| Whether opencode can load it: `unverified`. | none |

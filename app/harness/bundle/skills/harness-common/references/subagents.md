# Subagents

How a harness skill delegates. The skill names its spawns in a `Spawns` table and passes each one its tier's model ([model-tiers.md](model-tiers.md)).

## Two layers

- Only the orchestrator session spawns subagents. A subagent never spawns one.
- A skill that uses another skill runs it in the orchestrator, never inside a subagent.
- Installed agents cannot spawn: their `tools` hold no spawn tool, and opencode's `subagent` action is denied.
- A Claude Code `general-purpose` subagent can spawn, up to three layers by default (`../topics/Claude Code.md` "Nested spawns"). Its brief starts with [preamble.md](preamble.md), which says "You never spawn subagents".

## Brief minimum

A brief is the subagent's whole prompt. It holds:

1. For a `general` spawn, the text of [preamble.md](preamble.md) first, and on opencode the `SANDBOX_LINE` text from [../scripts/opencode.py](../scripts/opencode.py) after it. An installed agent has both already.
2. The task, in one or two sentences.
3. Every input as an absolute path: files, skill folders, the work folder.
4. The output path, absolute, when the subagent writes a file.
5. The return cap: "Reply in at most N words."
6. When the subagent works on open items ([open-items](../../open-items/SKILL.md)), the ids it owns with their text, as `Open items: Y5 (...), A2 (...)`, and the report lines it returns: `Closed: <id> (<what showed it done>)` for each id it closed, and its questions for the user. It never edits the ledger; the orchestrator records what the report says.

Never add the conversation, a draft the subagent is to check, or the orchestrator's conclusions.

## Fresh per unit

- One fresh subagent per unit of work: an aspect, a phase, a review round, a pull request, a page build.
- A new round is a new spawn. Never reuse a subagent that has seen an earlier unit.
- Independent units go out in one batch, so they run in parallel.

## Word caps

- The return is a summary for the orchestrator. Detail goes into the output file.
- Caps: 150 words for a status report, 300 for findings the orchestrator acts on. A skill may set its own cap per brief.
- The orchestrator reads the summary, and opens an output file only for the part it needs next.

## Agent names

Spawns tables and skills name harness agents by bare name, such as `rearch-auditor`. Loaded as a plugin, the same agent is listed as `harness:rearch-auditor`. Before a spawn, look up the name in the agents the session lists:

1. The bare name is listed: spawn it.
2. Only `harness:<name>` is listed: spawn `harness:<name>`.
3. Neither is listed: follow "Missing agent". Never spawn general-purpose in its place without saying so.

## Missing agent

When neither name is listed, or a spawn fails because the agent is not installed:

1. Find the harness checkout: `dirname "$(dirname "$(realpath <harness-common>)")"`, where `<harness-common>` is this skill's installed folder (`~/.claude/skills/harness-common` or `~/.config/opencode/skills/harness-common`).
2. Read `<checkout>/agents/<name>.md`. Its `tier` line gives the model; the text after the closing `---` is the role.
3. Spawn the host's general subagent with the model of that tier. Its prompt is [preamble.md](preamble.md), then on opencode the `SANDBOX_LINE`, then the role text, then the brief.
4. Tell the user to run `<checkout>/install.py`.

On opencode after `apply-tiers`, every `general` spawn runs on the `--general` tier's model, whatever the agent's tier.

Without any subagent tool, run each brief yourself, one at a time, and say so in the resume file.

# Model tiers

Every tiered spawn of a harness skill goes through this procedure. The repo names no model: the user confirms a model per tier once per tool, and later runs reuse that choice.

## Tiers

| Tier | For | Proposed model |
|---|---|---|
| `fast` | Reading, auditing, checking claims | The cheapest model that does the job well |
| `default` | Implementation, most work | The session's model |
| `strong` | Design, critique, pages a human reviews | The most capable model |

Each agent in `agents/` declares its tier. A spawn of the host's general subagent takes the tier its skill gives it.

## Spawns table

Every `SKILL.md` that delegates lists each spawn under a `## Spawns` heading:

| Spawn | Tier | Used for |
|---|---|---|
| `rearch-auditor` | `fast` | one audit per aspect |
| `general` | `strong` | the page Builder |

- Spawn: an agent from `agents/`, or `general` for the host's general subagent (`general-purpose` in Claude Code, `general` in opencode).
- Tier: the agent's own tier. `tests/test_repo_rules.py` checks that each named agent exists and that the tier matches its file.

## The gate

Run it when a run starts, and on resume when the resume file has no `Models for this run` table or the table was confirmed in another tool. It asks the user only the first time in a tool, or when that tool's model list changed (the user, 2026-11-27: ask once per tool, then reuse the choice).

1. List the models the current tool offers. When `~/.config/agent-harness/models-<tool>.md` (`claude-code` or `opencode`) holds a table whose models are all still in that list, use it without asking: say in one line which table the run uses, and go to step 3.
   - Claude Code: the allowed values of the Agent tool's `model` parameter, read from the tool definition in this session (`../topics/Claude Code.md` "Model per spawn").
   - opencode: `/usr/bin/python3 -I <harness-common>/scripts/opencode.py models`. It prints one model id per line, or one line naming the problem and exit 1.
2. Propose one model per tier from that list, using the table above. Ask the user to confirm. This is a gate: no tiered spawn runs before the answer. The user may change any tier, or put every tier on one model.
3. Write the confirmed table into the run's resume file (`state.md` "Models for this run"), and, after a confirmation, into `~/.config/agent-harness/models-<tool>.md` for later runs.
4. opencode only: apply the table (below).

## Every spawn passes its tier's model

- Claude Code: pass the tier's value as the Agent tool's `model` parameter, for named agents and `general-purpose` alike. The parameter takes an alias only.
- opencode: the `subagent` tool takes no model (`../topics/opencode.md` "Model per spawn"). The model comes from run-scoped agent files instead:
  1. After the gate, and on every resume, run `/usr/bin/python3 -I <harness-common>/scripts/opencode.py apply-tiers --state <resume file> --general <tier>` from the project. `--general` is the tier of the skill's `general` spawns. When they differ, give the highest, because one file sets the model of every `general` spawn.
  2. It writes a copy of each installed agent with its tier's `model` line, plus `general.md`, into `.opencode/agents/` at the project root. It lists them in `.git/info/exclude` and runs `opencode reload`. A file there that it did not write stops it before any write.
  3. On `reload failed`, or when a spawn still runs on the session model, tell the user: restart opencode, then resume.
  4. When the run ends, run `opencode.py clear-tiers` from the project. It removes only the files it wrote and their exclude lines.

One model for every tier needs no override files on opencode: every agent without a `model` line runs on the session model. Skip `apply-tiers` when that model is the session's.

Nothing but `opencode.py` runs the opencode CLI.

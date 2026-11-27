# Run state

What every long-running harness skill keeps so a new session can resume. The layout stays per skill. This is the minimum each one holds.

| Skill | Resume file |
|---|---|
| rearchitect | `.rearch/STATE.md` (models table in `.rearch/baseline.md`) |
| attack-plan-create | `.attack-plan/<slug>/STATE.md` |
| attack-plan-milestone-execute, qa-session, any ai-notes area | `.ai-notes/<area>/README.md`, section "State (start here)" |
| storyboard | none (below) |

## Minimum

1. A `Next:` line, or a fenced `Next prompt` block, that a new session can act on alone.
2. A `Models for this run` table when the skill spawns subagents.
3. Facts and decisions the next session needs, each written once.

## Models for this run

A heading named `Models for this run`, one line with the tool and the date the user confirmed it, then the table:

```markdown
## Models for this run

Confirmed by the user on <date> in <tool>.

| Tier | Model |
|---|---|
| fast | `<value>` |
| default | `<value>` |
| strong | `<value>` |
```

- `<value>` is what the tool takes: on Claude Code an alias from the Agent tool's `model` parameter, on opencode a `provider/model` id from `opencode.py models`. A label may stand outside the backticks.
- More columns, such as the agents per tier, are allowed. `opencode.py apply-tiers` reads the Tier and Model columns.
- A resume in another tool runs the gate again ([model-tiers.md](model-tiers.md)).

## Private state

State is committed by default. To keep it out of the repository, add its folder to `.git/info/exclude`, never to the repo's `.gitignore` or the global gitignore. The exclude file covers every worktree of the repo and is never shared (`../topics/git.md` "`.git/info/exclude` and worktrees"). A gitignore change needs the user's OK.

## Single-spawn skills

A skill with one spawn per use and no resume file of its own (storyboard):

- When the work has an ai-notes area, the `Models for this run` table and the `Next:` line go in its "State (start here)" section.
- Otherwise the tier gate runs in the session, and the hand-over ends with a fenced resume prompt that names the output path.

## Stopping

Stop near 70% of the context window, and whenever the user asks. Write the resume file first, then print the `Next prompt`.

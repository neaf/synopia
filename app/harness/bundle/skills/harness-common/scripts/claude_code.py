"""Claude Code adapter: install paths and agent rendering.

Facts: skills/harness-common/topics/Claude Code.md.
"""
import json
from pathlib import Path

BINARY = "claude"
# Tools an agent source may list. Agent and Task are spawn tools and never allowed (NFR-13).
TOOLS = ("Read", "Glob", "Grep", "Edit", "Write", "Bash", "WebFetch", "WebSearch", "Skill")
SPAWN_TOOLS = ("Agent", "Task")


def paths(home):
    base = Path(home) / ".claude"
    return {"base": base, "agents": base / "agents", "skills": base / "skills", "instructions": base / "CLAUDE.md"}


def render_agent(meta, body, preamble):
    """Frontmatter `name`, `description` (double-quoted, Claude Code.md "Quirk: unquoted `: `"), `tools`.

    No `model` line: the tier is resolved per run (FR-AGT-02).
    """
    head = [f"name: {meta['name']}", f"description: {json.dumps(meta['description'])}",
            f"tools: {', '.join(meta['tools'])}"]
    return "---\n" + "\n".join(head) + "\n---\n\n" + preamble.strip() + "\n\n" + body

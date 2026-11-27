#!/usr/bin/python3
"""opencode adapter: install paths, agent rendering, model listing and run-scoped tier overrides.

Facts: skills/harness-common/topics/opencode.md. Procedure: skills/harness-common/references/model-tiers.md.
Usage: opencode.py models
       opencode.py apply-tiers --state FILE [--general TIER] [--project DIR]
       opencode.py clear-tiers [--project DIR]
Exit: 0 done, 1 failed: one line names the cause (stderr; stdout for a failed reload after the files changed).
"""
import argparse, json, re, shutil, subprocess, sys
from pathlib import Path

BINARY = "opencode"
# The harness checkout: this file is <checkout>/skills/harness-common/scripts/opencode.py.
CHECKOUT = Path(__file__).resolve().parents[3]
# Claude Code tool name -> opencode permission action (opencode.md "Permissions").
ACTIONS = {
    "Read": "read", "Glob": "glob", "Grep": "grep", "Edit": "edit", "Write": "edit",
    "Bash": "shell", "WebFetch": "webfetch", "WebSearch": "websearch", "Skill": "skill",
}
SPAWN_ACTION = "subagent"
# opencode only: Code Mode cannot reach the filesystem (opencode.md "`execute` (Code Mode)").
SANDBOX_LINE = ("Use the file, search and shell tools directly. "
                "The `execute` sandbox supports no `import`, `require` or filesystem access.")
# Run-scoped overrides (opencode.md "Model per spawn"): project agents, recorded in info/exclude.
OVERRIDES = Path(".opencode") / "agents"
GENERAL = "general"
GENERAL_DESCRIPTION = "General-purpose subagent for harness briefs. The prompt is the whole task."
BEGIN = "# agent-harness tiers: opencode.py clear-tiers removes these files and this block"
END = "# end agent-harness tiers"
MODEL_ID = re.compile(r"[A-Za-z0-9][\w.-]*/\S+")  # provider/model, optionally #variant (opencode.md "Agent files")


class Failed(Exception):
    """An expected failure. The message is the one line the CLI prints."""


def paths(home):
    base = Path(home) / ".config" / "opencode"
    return {"base": base, "agents": base / "agents", "skills": base / "skills", "instructions": base / "AGENTS.md"}


def permissions(tools):
    """Deny rules for every mapped action the agent's `tools` do not cover, then the spawn deny.

    Only denies: allowed actions keep the defaults and the user's global rules (opencode.md "Permissions").
    """
    allowed = set()
    for tool in tools:
        if tool not in ACTIONS:
            raise ValueError(f"no opencode action for tool {tool}")
        allowed.add(ACTIONS[tool])
    denied = sorted(set(ACTIONS.values()) - allowed) + [SPAWN_ACTION]
    return [{"action": action, "resource": "*", "effect": "deny"} for action in denied]


def _render(description, rules, model, parts):
    head = [f"description: {json.dumps(description)}", "mode: subagent"]
    if model is not None:
        head.append(f"model: {json.dumps(model)}")
    head.append("permissions:")
    head += [f'  - {{action: {r["action"]}, resource: "{r["resource"]}", effect: {r["effect"]}}}' for r in rules]
    return "---\n" + "\n".join(head) + "\n---\n\n" + "\n\n".join(parts)


def render_agent(meta, body, preamble, model=None):
    """V2 frontmatter `description`, `mode: subagent`, `permissions`. Never `tools` or `permission`.

    A file with `permissions` is read as V2 and its V1 keys are dropped (opencode.md "Quirk: V1 and V2
    frontmatter"). install.py passes no `model`: a subagent without one runs on the session model
    (FR-AGT-02). apply-tiers passes the model of the agent's tier.
    """
    return _render(meta["description"], permissions(meta["tools"]), model,
                   [preamble.strip(), SANDBOX_LINE, body])


def render_general(preamble, model):
    """Override of the built-in `general` agent: one model for every `general` spawn, spawn denied."""
    rules = [{"action": SPAWN_ACTION, "resource": "*", "effect": "deny"}]
    return _render(GENERAL_DESCRIPTION, rules, model, [preamble.strip(), SANDBOX_LINE + "\n"])


def run(args, cwd=None, timeout=60):
    """stdout of `opencode <args>`. Failed when opencode is missing, fails or times out."""
    if not shutil.which(BINARY):
        raise Failed("opencode not found on PATH")
    try:
        done = subprocess.run([BINARY, *args], cwd=cwd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise Failed(f"opencode {' '.join(args)} timed out after {timeout} s") from None
    if done.returncode:
        last = (done.stderr.strip().splitlines() or [f"exit {done.returncode}"])[-1]
        raise Failed(f"opencode {' '.join(args)} failed: {last}")
    return done.stdout


def list_models(runner=run):
    """Model ids `opencode models` prints, one per line. The output format is unverified (opencode.md)."""
    models = [line.strip() for line in runner(["models"]).splitlines() if line.strip()]
    if not models:
        raise Failed("opencode models listed no model")
    return models


def tier_models(text, tiers):
    """{tier: model} from the `Models for this run` table of a resume file (state.md).

    The table has a Tier and a Model column, other columns are ignored. The model is the first
    backticked value in its cell, else the whole cell, and must be a `provider/model` id.
    """
    lines = text.splitlines()
    start = next((i for i, l in enumerate(lines)
                  if l.lstrip().startswith("#") and "models for this run" in l.lower()), None)
    if start is None:
        raise Failed("no 'Models for this run' heading")
    rows = []
    for line in lines[start + 1:]:
        s = line.strip()
        if s.startswith("#") or (rows and not s.startswith("|")):
            break
        if s.startswith("|"):
            rows.append([c.strip() for c in s.strip("|").split("|")])
    if not rows:
        raise Failed("no table under 'Models for this run'")
    header = [c.lower() for c in rows[0]]
    if "tier" not in header or "model" not in header:
        raise Failed("the models table needs a Tier and a Model column")
    t, m = header.index("tier"), header.index("model")
    models = {}
    for row in rows[1:]:
        if all(set(c) <= set(":- ") for c in row):
            continue
        if len(row) <= max(t, m):
            raise Failed(f"models table row has too few cells: {' | '.join(row)}")
        tier = row[t].strip("` ")
        span = re.search(r"`([^`]+)`", row[m])
        model = (span.group(1) if span else row[m]).strip()
        if tier not in tiers:
            raise Failed(f"models table: unknown tier {tier!r} (allowed: {', '.join(tiers)})")
        if tier in models:
            raise Failed(f"models table: tier {tier} given twice")
        if not MODEL_ID.fullmatch(model):
            raise Failed(f"models table: {tier} model {model!r} is not a provider/model id (opencode.py models)")
        models[tier] = model
    if not models:
        raise Failed("the models table has no rows")
    return models


def overrides(models, agents, preamble, general_tier):
    """({file name: (model, text)}, [skip lines]) for every agent whose tier has a model, plus `general.md`."""
    files, skipped = {}, []
    for meta, body in agents:
        if meta["tier"] in models:
            model = models[meta["tier"]]
            files[f"{meta['name']}.md"] = (model, render_agent(meta, body, preamble, model))
        else:
            skipped.append(f"skip    {meta['name']}: no model for tier {meta['tier']}")
    if general_tier in models:
        model = models[general_tier]
        files[f"{GENERAL}.md"] = (model, render_general(preamble, model))
    else:
        skipped.append(f"skip    {GENERAL}: no model for tier {general_tier}")
    return files, skipped


def git_paths(project):
    """(top-level folder, info/exclude path) of the git repository holding `project`."""
    def git(*args):
        done = subprocess.run(["git", "-C", str(project), *args], capture_output=True, text=True)
        if done.returncode:
            raise Failed(f"{project}: not a git repository (the overrides are recorded in .git/info/exclude)")
        return done.stdout.strip()
    top = Path(git("rev-parse", "--show-toplevel"))
    # --git-path resolves to the common git dir in a linked worktree (git.md "`.git/info/exclude`").
    return top, Path(project) / git("rev-parse", "--git-path", "info/exclude")


def split_block(text):
    """(entries in the harness block, exclude text without the block)."""
    lines, entries, kept, inside = text.splitlines(), [], [], False
    for line in lines:
        if line == BEGIN:
            inside = True
        elif line == END and inside:
            inside = False
        elif inside:
            entries.append(line)
        else:
            kept.append(line)
    return entries, "".join(l + "\n" for l in kept)


def entry(name):
    return "/" + (OVERRIDES / name).as_posix()


def apply_tiers(project, models, agents, preamble, general_tier, runner=run):
    """Write the overrides, record them in info/exclude, run `opencode reload`. Returns (lines, ok)."""
    top, exclude = git_paths(project)
    text = exclude.read_text() if exclude.is_file() else ""
    owned, rest = split_block(text)
    files, out = overrides(models, agents, preamble, general_tier)
    folder = top / OVERRIDES
    for name in files:
        if (folder / name).exists() and entry(name) not in owned:
            raise Failed(f"{OVERRIDES / name} exists and was not written by apply-tiers; move it, then rerun")
    folder.mkdir(parents=True, exist_ok=True)
    for old in owned:
        name = Path(old).name
        if name not in files and (folder / name).is_file():
            (folder / name).unlink()
            out.append(f"remove  {OVERRIDES / name}")
    for name, (model, content) in files.items():
        (folder / name).write_text(content)
        out.append(f"write   {OVERRIDES / name} ({model})")
    block = [BEGIN] + [entry(name) for name in files] + [END]
    exclude.parent.mkdir(parents=True, exist_ok=True)
    exclude.write_text(rest + "\n".join(block) + "\n")
    out.append(f"exclude {len(files)} file(s) in {exclude}")
    line, ok = reload(top, runner)
    return out + [line], ok


def clear_tiers(project, runner=run):
    """Remove the overrides recorded in info/exclude and the record, then reload. Returns (lines, ok)."""
    top, exclude = git_paths(project)
    text = exclude.read_text() if exclude.is_file() else ""
    owned, rest = split_block(text)
    if text == rest:
        return ["no tier overrides"], True
    out = []
    for old in owned:
        path = top / OVERRIDES / Path(old).name
        if old == entry(path.name) and path.is_file():
            path.unlink()
            out.append(f"remove  {OVERRIDES / path.name}")
    exclude.write_text(rest)
    for folder in (top / OVERRIDES, top / OVERRIDES.parent):
        if folder.is_dir() and not any(folder.iterdir()):
            folder.rmdir()
    line, ok = reload(top, runner)
    return out + [line], ok


def reload(top, runner):
    """(line, ok) after `opencode reload` in the project (opencode.md "Model per spawn")."""
    try:
        runner(["reload"], cwd=str(top))
    except Failed as e:
        return f"reload failed: {e}. Restart opencode, then resume", False
    return "reloaded", True


def load_sources():
    """(agents as (meta, body), preamble text, tiers) from the checkout, through install.py's validation."""
    sys.path.insert(0, str(CHECKOUT))
    import install
    try:
        agents, _, preamble, _ = install.sources()
    except install.InvalidSource as e:
        raise Failed(f"invalid agent sources: {str(e).splitlines()[0]}") from None
    return [(meta, body) for _, meta, body in agents], preamble, install.TIERS


def main(argv=None, runner=run):
    ap = argparse.ArgumentParser(prog="opencode.py", description="opencode models and per-run tier overrides.")
    sub = ap.add_subparsers(dest="command", required=True)
    sub.add_parser("models", help="list the models opencode offers, one per line")
    a_apply = sub.add_parser("apply-tiers", help="write project agent overrides with the model of each tier")
    a_apply.add_argument("--state", required=True, type=Path, help="resume file with a 'Models for this run' table")
    a_apply.add_argument("--general", default="default", help="tier for every `general` spawn (default: default)")
    a_apply.add_argument("--project", default=".", type=Path, help="folder in the project's git repository")
    a_clear = sub.add_parser("clear-tiers", help="remove the overrides apply-tiers wrote")
    a_clear.add_argument("--project", default=".", type=Path, help="folder in the project's git repository")
    a = ap.parse_args(argv)
    try:
        if a.command == "models":
            lines, ok = list_models(runner), True
        elif a.command == "apply-tiers":
            agents, preamble, tiers = load_sources()
            if a.general not in tiers:
                raise Failed(f"--general: unknown tier {a.general!r} (allowed: {', '.join(tiers)})")
            if not a.state.is_file():
                raise Failed(f"{a.state}: no such file")
            models = tier_models(a.state.read_text(), tiers)
            lines, ok = apply_tiers(a.project, models, agents, preamble, a.general, runner)
        else:
            lines, ok = clear_tiers(a.project, runner)
    except Failed as e:
        print(f"opencode.py: {e}", file=sys.stderr)
        return 1
    for line in lines:
        print(line)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/python3
"""Records where each section of an attack plan stands.

Usage:
  gate.py open <work folder> <stage> <section> [--file F [--heading H]]...
  gate.py grilled <work folder> <section> --rounds N --open-findings N
  gate.py approve <work folder> <section> --by NAME
  gate.py skip <work folder> <section>
  gate.py reopen <work folder> <section> --reason TEXT
  gate.py status <work folder>
  gate.py verify <work folder>

Each --heading belongs to the --file before it. A --file without a --heading stands for the whole file.
Exit 0 done, 1 refused (REFUSED: <reason> on stderr) or verify found problems, 2 bad command line.
"""
import json, sys
from datetime import datetime, timezone
from pathlib import Path

# -I drops the script's folder from sys.path; resolve() follows the skill link (topics/macOS Python.md).
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "harness-common" / "scripts"))
import markdown  # noqa: E402

STAGES = ["intake", "sources", "product", "product-review", "technical", "milestones", "audit", "publish"]
PASSED = ("approved", "not reviewed")
OPENABLE = ("drafting", "stale", "not reviewed")
DRAFT_STAGES = {
    "technical-solution.md": "technical",
    "design-proposal.md": "technical",
    "alternatives.md": "technical",
}
# gates.json format. 1 (no "version" key): one "file" and "heading" per gate, hashes from the old
# fence-blind slicing. 2: "pairs", hashes from markdown.digest.
VERSION = 2
# Command: (positionals after the work folder, options it takes).
COMMANDS = {
    "open": (("stage", "section"), ("file", "heading")),
    "grilled": (("section",), ("rounds", "open-findings")),
    "approve": (("section",), ("by",)),
    "skip": (("section",), ()),
    "reopen": (("section",), ("reason",)),
    "status": ((), ()),
    "verify": ((), ()),
}


class Refused(Exception):
    pass


class Usage(Exception):
    pass


class Gate:
    def __init__(self, folder):
        self.folder = Path(folder)
        self.path = self.folder / "gates.json"
        data = json.loads(self.path.read_text()) if self.path.exists() else {"version": VERSION, "gates": []}
        self.version = data.get("version", 1)
        self.gates = data["gates"]
        for gate in self.gates:
            if "pairs" not in gate:
                gate["pairs"] = [{"file": gate["file"], "heading": gate.get("heading")}] if gate.get("file") else []
                gate.pop("file", None)
                gate.pop("heading", None)

    def open(self, stage, gate_id, pairs=()):
        if stage not in STAGES:
            raise Refused(f"unknown stage {stage}, use one of: {', '.join(STAGES)}")
        existing = self.find(gate_id)
        if existing and existing["status"] not in OPENABLE:
            raise Refused(f"{gate_id} is {existing['status']}: reopen it first")
        blocking = self.blockers(stage, gate_id)
        if blocking:
            raise Refused(f"{gate_id} comes after sections in progress, approve or skip them first: {', '.join(blocking)}")
        gate = existing or {"id": gate_id, "pairs": []}
        gate.update(stage=stage, status="drafting")
        if pairs:
            gate["pairs"] = [{"file": file, "heading": heading} for file, heading in pairs]
        if not existing:
            self.gates.append(gate)
        self.save()
        return f"opened {gate_id} ({stage})"

    def grilled(self, gate_id, rounds, open_findings):
        gate = self.fetch(gate_id)
        if gate["status"] != "drafting":
            raise Refused(f"{gate_id} is {gate['status']}, not drafting")
        if rounds < 1:
            raise Refused(f"{gate_id} needs at least one challenge round")
        if open_findings > 0:
            raise Refused(f"{gate_id} still has {open_findings} open findings: settle them or ask the author")
        gate.update(status="grilled", rounds=rounds)
        self.save()
        return f"{gate_id} grilled in {rounds} round(s)"

    def approve(self, gate_id, by):
        gate = self.fetch(gate_id)
        if gate["status"] != "grilled":
            raise Refused(f"{gate_id} is {gate['status']}: it must be grilled before approval")
        if not (by or "").strip():
            raise Refused("approval needs --by with the name of the person who approved")
        try:
            digest = self.digest(gate) if gate["pairs"] else None
        except markdown.Missing as missing:
            raise Refused(f"{gate_id}: {missing}")
        gate.update(status="approved", approved_by=by,
                    approved_at=datetime.now(timezone.utc).isoformat(timespec="seconds"), hash=digest)
        self.save()
        return f"{gate_id} approved by {by}"

    def skip(self, gate_id):
        gate = self.fetch(gate_id)
        if gate["status"] == "approved":
            raise Refused(f"{gate_id} is approved")
        gate["status"] = "not reviewed"
        self.save()
        return f"{gate_id} not reviewed, moving on"

    def reopen(self, gate_id, reason):
        gate = self.fetch(gate_id)
        if not (reason or "").strip():
            raise Refused("reopen needs --reason")
        index = self.gates.index(gate)
        gate.update(status="drafting", reopened_because=reason)
        # Later means later in gates.json, the order the sections were first opened, not stage order.
        stale = [later for later in self.gates[index + 1:] if later["status"] == "approved"]
        for later in stale:
            later["status"] = "stale"
        self.save()
        return "\n".join([f"reopened {gate_id}"] + [f"{later['id']} is now stale" for later in stale])

    def status(self):
        if not self.gates:
            return "no gates yet"
        lines = []
        for gate in self.gates:
            by = f" by {gate['approved_by']}" if gate.get("approved_by") and gate["status"] == "approved" else ""
            changed = ", CHANGED SINCE APPROVAL" if self.changed_since_approval(gate) else ""
            lines.append(f"{gate['stage']} / {gate['id']}: {gate['status']}{by}{changed}")
        return "\n".join(lines)

    def problems(self):
        found = [f"{g['id']} changed after its approval: reopen it" for g in self.gates if self.changed_since_approval(g)]
        for name, stage in DRAFT_STAGES.items():
            if (self.folder / "draft" / name).exists() and not any(g["stage"] == stage for g in self.gates):
                found.append(f"draft/{name} exists before the {stage} stage was opened")
        found += [f"{g['id']} is stale: re-review it" for g in self.gates if g["status"] == "stale"]
        return found

    def blockers(self, stage, gate_id):
        """Gates of this or an earlier stage still in progress. A stale gate after `gate_id` waits for
        `gate_id` itself (reopening it made them stale), so it does not block it."""
        limit = STAGES.index(stage)
        existing = self.find(gate_id)
        position = self.gates.index(existing) if existing else len(self.gates)
        return [g["id"] for index, g in enumerate(self.gates)
                if STAGES.index(g["stage"]) <= limit and g["id"] != gate_id and g["status"] not in PASSED
                and not (g["status"] == "stale" and index > position)]

    def find(self, gate_id):
        return next((g for g in self.gates if g["id"] == gate_id), None)

    def fetch(self, gate_id):
        gate = self.find(gate_id)
        if gate is None:
            raise Refused(f"no gate {gate_id}")
        return gate

    def digest(self, gate):
        return markdown.digest([(self.folder / p["file"], p.get("heading")) for p in gate["pairs"]])

    def current_hash(self, gate):
        try:
            return self.digest(gate)
        except markdown.Missing:
            return None

    def legacy_match(self, gate):
        """A version-1 hash that still matches the old slicing: the section is unchanged since approval."""
        if self.version >= VERSION or len(gate["pairs"]) != 1:
            return False
        pair = gate["pairs"][0]
        return markdown.legacy_digest(self.folder / pair["file"], pair.get("heading")) == gate["hash"]

    def changed_since_approval(self, gate):
        if gate["status"] != "approved" or not gate.get("hash") or not gate["pairs"]:
            return False
        return self.current_hash(gate) != gate["hash"] and not self.legacy_match(gate)

    def upgrade(self):
        """Store version-2 hashes for approved version-1 gates whose old hash still matches."""
        if self.version >= VERSION:
            return
        for gate in self.gates:
            if gate["status"] == "approved" and gate.get("hash") and gate["pairs"] and self.legacy_match(gate):
                gate["hash"] = self.current_hash(gate) or gate["hash"]
        self.version = VERSION

    def save(self):
        self.upgrade()
        self.path.write_text(json.dumps({"version": VERSION, "gates": self.gates}, indent=2) + "\n")


def parse(argv):
    """(command, folder, positionals, options, pairs), or Usage naming the problem."""
    if not argv:
        raise Usage("no command")
    command, rest = argv[0], list(argv[1:])
    if command not in COMMANDS:
        raise Usage(f"unknown command {command!r}, use one of: {', '.join(COMMANDS)}")
    wanted, allowed = COMMANDS[command]
    positional, options, pairs, pending = [], {}, [], None
    while rest:
        arg = rest.pop(0)
        if not arg.startswith("--"):
            positional.append(arg)
            continue
        name = arg[2:]
        if name not in allowed:
            takes = ", ".join("--" + a for a in allowed) or "no option"
            raise Usage(f"{command} takes {takes}, not --{name}")
        if not rest or rest[0].startswith("--"):
            raise Usage(f"--{name} needs a value")
        value = rest.pop(0)
        if name == "file":
            pairs.append([value, pending])
            pending = None
        elif name == "heading":
            if pairs and pairs[-1][1] is None and pending is None:
                pairs[-1][1] = value
            elif not pairs and pending is None:
                pending = value  # --heading before the first --file, as the old command line allowed
            else:
                raise Usage(f"--heading {value!r} has no --file of its own: give each heading its own --file")
        else:
            options[name] = value
    if pending is not None:
        raise Usage("--heading needs a --file")
    if len(positional) != len(wanted) + 1:
        names = " ".join(f"<{n}>" for n in ("work folder",) + wanted)
        raise Usage(f"{command} needs {names}, got {len(positional)} argument(s)")
    for name in ("rounds", "open-findings"):
        if name in options:
            try:
                options[name] = int(options[name])
            except ValueError:
                raise Usage(f"--{name} needs a whole number, got {options[name]!r}")
    return command, positional[0], positional[1:], options, [(f, h or None) for f, h in pairs]


def main(argv):
    if argv and argv[0] in ("-h", "--help", "help"):
        print(__doc__.strip())
        return 0
    try:
        command, folder, positional, options, pairs = parse(argv)
        if not Path(folder).is_dir():
            raise Usage(f"no work folder {folder}")
        gate = Gate(folder)
    except Usage as error:
        print(f"gate.py: {error}. Run gate.py --help for the usage.", file=sys.stderr)
        return 2
    except (ValueError, KeyError) as error:
        print(f"gate.py: {Path(folder) / 'gates.json'} is not a gates file: {error}", file=sys.stderr)
        return 1
    try:
        if command == "open":
            print(gate.open(positional[0], positional[1], pairs))
        elif command == "grilled":
            print(gate.grilled(positional[0], options.get("rounds", 0), options.get("open-findings", 0)))
        elif command == "approve":
            print(gate.approve(positional[0], options.get("by")))
        elif command == "skip":
            print(gate.skip(positional[0]))
        elif command == "reopen":
            print(gate.reopen(positional[0], options.get("reason")))
        elif command == "status":
            print(gate.status())
        else:
            found = gate.problems()
            print("\n".join(found) if found else "OK")
            return 1 if found else 0
    except Refused as error:
        print(f"REFUSED: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

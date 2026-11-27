#!/usr/bin/python3
"""Reads and checks an open-items ledger, `.ai-notes/<area>/open-items.md` (format: references/format.md).

Usage:
  ledger.py check <file> [-v]          the file fits the version 1 grammar
  ledger.py next <file> Y|A            the next free id of that prefix
  ledger.py block <file> [--since T] [--show ID,...]
                                       prints the reply's "Waiting on you" block
  ledger.py prune <file> [--keep 30]   keeps the newest closed lines, rewrites the file
  ledger.py init <file> [--area NAME]  writes an empty ledger; refuses an existing file

check prints one line, `ok: <n> open (<ids>), <n> closed` or `FAIL: <n> problems in <file>`;
-v adds one `line N: <problem>` line per problem. T is `YYYY-MM-DD HH:MM`, the time stamped on this
turn's changes: items opened and lines closed at or after it are "new" and "Closed this turn".
Exit 0 on success, 1 when the file breaks the grammar (check, block, prune), 2 for a bad command line
or a missing file. Nothing here reads prose: every value comes from the fixed line shapes.
"""
import argparse, re, sys
from pathlib import Path

VERSION_MARK = "<!-- open-items v1."
COMMENT = ("<!-- open-items v1. Kept by AI: the open-items skill, and Synopia when it runs the session. "
           "Don't edit by hand; say it in the session instead. -->")
WAITING, CHECKS, CLOSED = "Waiting on you", "Claude will check", "Closed"
SECTIONS = [WAITING, CHECKS, CLOSED]
Y_KINDS = ["decision", "your task", "default", "review"]
A_KINDS = ["follow-up"]
FIELDS = ["state", "options", "recommended", "trigger", "goes ahead", "watch", "subagent", "raised by", "answer", "from"]
STATES = ["answered", "due", "later"]
SEP = " · "
DATE = r"\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?"
TITLE = re.compile(r"# Open items: \S.*")
HEADING = re.compile(r"## (.+)")
OPEN = re.compile(r"- \[ \] ([YA])(\d+)" + re.escape(SEP) + r"([a-z][a-z -]*?)" + re.escape(SEP) + r"(\S.*)")
CLOSED_LINE = re.compile(r"- \[([x>-])\] ([YA])(\d+)" + re.escape(SEP) + r"(.+)")
FIELD = re.compile(r"  - ([a-z ]+): (\S.*)")
CLOSE_HEAD = {"x": re.compile(r"(answered|done|went ahead) (" + DATE + ")"),
              "-": re.compile(r"(dropped) (" + DATE + ")"),
              ">": re.compile(r"(superseded) by ([YA]\d+)")}
STAMP = re.compile(DATE)
DEFAULT_KEEP = 30


class Ledger:
    def __init__(self):
        self.title, self.items, self.closed, self.problems, self.lines = None, [], [], [], []

    def ids(self, prefix):
        return [n for p, n in ((i["prefix"], i["n"]) for i in self.items + self.closed) if p == prefix]


def stamp(text):
    """The first `YYYY-MM-DD[ HH:MM]` in text, as `YYYY-MM-DD HH:MM`, or ''."""
    m = STAMP.search(text or "")
    return "" if not m else (m.group(0) if len(m.group(0)) > 10 else m.group(0) + " 00:00")


def parse(text):
    """A Ledger. Problems are (line number, message); the file is never repaired."""
    led, section, seen, current, seen_sections = Ledger(), None, {}, None, []
    led.lines = text.splitlines()
    bad = led.problems.append
    for number, line in enumerate(led.lines, 1):
        if not line.strip():
            continue
        if led.title is None:
            if TITLE.fullmatch(line):
                led.title = line[len("# Open items: "):]
            else:
                bad((number, "the first line must be '# Open items: <area>'"))
                led.title = ""
            continue
        if line.startswith("<!--"):
            if not line.startswith(VERSION_MARK):
                bad((number, "unknown version comment: want '<!-- open-items v1. ...'"))
            continue
        h = HEADING.fullmatch(line)
        if h:
            name = h.group(1)
            if name not in SECTIONS:
                bad((number, f"unknown section '{name}'"))
            elif name in seen_sections:
                bad((number, f"section '{name}' twice"))
            elif seen_sections and SECTIONS.index(name) < SECTIONS.index(seen_sections[-1]):
                bad((number, f"section '{name}' out of order: {', '.join(SECTIONS)}"))
            seen_sections.append(name)
            section, current = name, None
            continue
        f = FIELD.fullmatch(line)
        if f:
            if current is None:
                bad((number, "a field with no open item above it"))
                continue
            key, value = f.groups()
            if key not in FIELDS:
                bad((number, f"unknown field '{key}'"))
            elif key in current["fields"]:
                bad((number, f"field '{key}' twice"))
            elif current["fields"] and FIELDS.index(key) < FIELDS.index(list(current["fields"])[-1]):
                bad((number, f"field '{key}' out of order: {', '.join(FIELDS)}"))
            elif key == "state" and value not in STATES:
                bad((number, f"state '{value}': want {', '.join(STATES)}"))
            else:
                current["fields"][key] = value
            continue
        current = None
        o, c = OPEN.fullmatch(line), CLOSED_LINE.fullmatch(line)
        if o and section in (WAITING, CHECKS):
            prefix, n, kind, body = o.group(1), int(o.group(2)), o.group(3), o.group(4)
            kinds = Y_KINDS if prefix == "Y" else A_KINDS
            if (prefix == "Y") != (section == WAITING):
                bad((number, f"{prefix}{n} in '{section}': Y items go under '{WAITING}', A items under '{CHECKS}'"))
            elif kind not in kinds:
                bad((number, f"kind '{kind}' for a {prefix} item: want {', '.join(kinds)}"))
            item = {"line": number, "prefix": prefix, "n": n, "kind": kind, "text": body, "fields": {}}
            led.items.append(item)
            current = item
        elif c and section == CLOSED:
            box, prefix, n, rest = c.group(1), c.group(2), int(c.group(3)), c.group(4)
            parts = rest.split(SEP)
            head = CLOSE_HEAD[box].fullmatch(parts[0])
            item = {"line": number, "prefix": prefix, "n": n, "box": box, "parts": parts, "raw": line}
            if not head:
                want = {"x": "'answered|done|went ahead <date>'", "-": "'dropped <date>'", ">": "'superseded by <id>'"}[box]
                bad((number, f"[{box}] {prefix}{n}: want {want} after the id"))
            elif box == "-" and len(parts) < 2:
                bad((number, f"{prefix}{n}: a dropped line says why"))
            elif box == ">" and (len(parts) < 2 or not STAMP.fullmatch(parts[1])):
                bad((number, f"{prefix}{n}: want 'superseded by <id> · <date>'"))
            item["how"] = head.group(1) if head else ""
            item["when"] = stamp(parts[0] if box != ">" else (parts[1] if len(parts) > 1 else ""))
            led.closed.append(item)
        elif o or c:
            bad((number, f"an item line in the wrong section ('{section or 'none'}')"))
        else:
            bad((number, "a line that fits no shape (an item's text never wraps)"))
            continue
        key = (item["prefix"], item["n"])
        if key in seen:
            bad((number, f"{item['prefix']}{item['n']} is used twice (line {seen[key]})"))
        else:
            seen[key] = number
    if led.title is None:
        bad((0, "the file is empty"))
    for name in SECTIONS:
        if name not in seen_sections and led.title is not None:
            bad((0, f"no '## {name}' section"))
    for item in led.items:
        if "from" not in item["fields"]:
            bad((item["line"], f"{item['prefix']}{item['n']} has no 'from' field"))
    return led


def label(item):
    return f"{item['prefix']}{item['n']}"


def next_id(led, prefix):
    return f"{prefix}{max(led.ids(prefix), default=0) + 1}"


def recommended(value):
    """'Look first' -> "I'd look first": the option as Claude would say it."""
    return "I'd " + (value[0].lower() + value[1:] if value[:1].isupper() and value[1:2].islower() else value)


def y_line(item, new):
    f, text = item["fields"], item["text"]
    if item["kind"] == "review" and text.startswith("Review: "):
        text = text[len("Review: "):]
    kind = item["kind"] + (f", from {f['raised by']}" if "raised by" in f else "")
    notes = []
    if f.get("state") == "answered":
        notes.append(f"answered {f['answer']}" if "answer" in f else "answered")
    elif f.get("state") == "later":
        notes.append("later")
    if "recommended" in f and f.get("state") != "answered":
        notes.append(recommended(f["recommended"]))
    if "goes ahead" in f:
        notes.append(f"goes ahead {f['goes ahead']}")
    if "subagent" in f and item["kind"] != "review":
        notes.append(f"with {f['subagent']}")
    tail = (f" ({'; '.join(notes)})" if notes else "") + (" (new)" if new else "")
    return f"- **{label(item)}** {kind}: {text}{tail}"


def a_line(item, new):
    f = item["fields"]
    when = f.get("trigger", "no trigger")
    head = f"due, {when}" if f.get("state") == "due" else when
    extra = [f"with {f['subagent']}"] if "subagent" in f else []
    tail = (f" ({'; '.join(extra)})" if extra else "") + (" (new)" if new else "")
    return f"- **{label(item)}** {head}: {item['text']}{tail}"


def closed_note(item):
    parts = item["parts"]
    if item["box"] == ">":
        return f"{label(item)} (superseded by {parts[0].split(' by ', 1)[1]})"
    rest = [item["how"]] + parts[1:]
    if item["box"] == "-":
        return f"{label(item)} (dropped: {'; '.join(parts[1:])})"
    first = rest[0] + (f" {rest[1]}" if len(rest) > 1 and rest[1].startswith('"') else "")
    more = rest[2:] if len(rest) > 1 and rest[1].startswith('"') else rest[1:]
    return f"{label(item)} ({'; '.join([first] + more)})"


def block(led, since="", show=()):
    """The reply's last block, as lines: every open Y item, A items only when new, due or shown."""
    since = stamp(since) if since else ""
    is_new = lambda i: bool(since) and stamp(i["fields"].get("from", "")) >= since
    ys = sorted((i for i in led.items if i["prefix"] == "Y"), key=lambda i: i["n"])
    a_all = sorted((i for i in led.items if i["prefix"] == "A"), key=lambda i: i["n"])
    a_shown = [i for i in a_all if is_new(i) or i["fields"].get("state") == "due" or label(i) in show]
    out = []
    if ys:
        out.append(f"**{WAITING}** ({len(ys)})")
        out += [y_line(i, is_new(i)) for i in ys]
    else:
        out.append("Nothing waits on you.")
    if a_shown:
        out += ["", f"**{CHECKS}** ({len(a_all)})"] + [a_line(i, is_new(i)) for i in a_shown]
        hidden = len(a_all) - len(a_shown)
        if hidden:
            out.append(f"- {hidden} more, waiting on {'its trigger' if hidden == 1 else 'their triggers'}.")
    done = [i for i in led.closed if since and i["when"] and i["when"] >= since]
    if done:
        out += ["", "Closed this turn: " + "; ".join(closed_note(i) for i in done) + "."]
    return out


def prune(led, keep):
    """Line numbers of the closed lines to drop: all but the newest `keep`, never the highest id of a prefix."""
    order = sorted(led.closed, key=lambda i: (i["when"], i["line"]), reverse=True)
    top = {p: max(led.ids(p), default=0) for p in "YA"}
    return sorted(i["line"] for i in order[keep:] if i["n"] != top[i["prefix"]])


def read(path):
    p = Path(path)
    if not p.is_file():
        print(f"ledger.py: no such file: {path}", file=sys.stderr)
        sys.exit(2)
    return parse(p.read_text(encoding="utf-8"))


def fail(led, path, verbose):
    print(f"FAIL: {len(led.problems)} problem{'s' if len(led.problems) != 1 else ''} in {path}")
    if verbose:
        for number, message in led.problems:
            print(f"line {number}: {message}")
    return 1


def main(argv=None):
    ap = argparse.ArgumentParser(prog="ledger.py", description="Reads and checks an open-items ledger.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("check"); c.add_argument("file"); c.add_argument("-v", action="store_true")
    n = sub.add_parser("next"); n.add_argument("file"); n.add_argument("prefix", choices=["Y", "A"])
    b = sub.add_parser("block"); b.add_argument("file"); b.add_argument("--since", default="")
    b.add_argument("--show", default=""); b.add_argument("-v", action="store_true")
    p = sub.add_parser("prune"); p.add_argument("file"); p.add_argument("--keep", type=int, default=DEFAULT_KEEP)
    p.add_argument("-v", action="store_true")
    i = sub.add_parser("init"); i.add_argument("file"); i.add_argument("--area", default="")
    a = ap.parse_args(argv)

    if a.cmd == "init":
        path = Path(a.file)
        if path.exists():
            print(f"ledger.py: {a.file} exists; init writes only a new file", file=sys.stderr)
            return 2
        area = a.area or path.parent.name or "notes"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"# Open items: {area}\n\n{COMMENT}\n\n## {WAITING}\n\n## {CHECKS}\n\n## {CLOSED}\n", encoding="utf-8")
        print(f"created {a.file}")
        return 0
    if a.cmd == "next":
        p_ = Path(a.file)
        print(next_id(parse(p_.read_text(encoding="utf-8")) if p_.is_file() else Ledger(), a.prefix))
        return 0
    if a.cmd == "block" and a.since and not STAMP.fullmatch(a.since):
        print("ledger.py: --since wants YYYY-MM-DD HH:MM", file=sys.stderr)
        return 2
    led = read(a.file)
    if led.problems:
        return fail(led, a.file, a.v)
    if a.cmd == "check":
        ids = " ".join(label(i) for i in sorted(led.items, key=lambda i: (i["prefix"] != "Y", i["n"])))
        print(f"ok: {len(led.items)} open{f' ({ids})' if ids else ''}, {len(led.closed)} closed")
    elif a.cmd == "block":
        print("\n".join(block(led, a.since, {s.strip() for s in a.show.split(",") if s.strip()})))
    elif a.cmd == "prune":
        drop = set(prune(led, a.keep))
        if not drop:
            print(f"nothing to prune: {len(led.closed)} closed")
            return 0
        kept = [line for number, line in enumerate(led.lines, 1) if number not in drop]
        Path(a.file).write_text("\n".join(kept) + "\n", encoding="utf-8")
        print(f"pruned {len(drop)} closed line{'s' if len(drop) != 1 else ''}, {len(led.closed) - len(drop)} kept")
    return 0


if __name__ == "__main__":
    sys.exit(main())

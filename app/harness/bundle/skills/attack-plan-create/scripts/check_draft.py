#!/usr/bin/python3
"""Checks the drafts of an attack plan against the writing rules, or task blocks against their schema.

Usage:
  check_draft.py <draft folder> [--product]
  check_draft.py --tasks <file> [--milestone N]

Prints PASS, WARN or FAIL lines as `LEVEL file: message`. Exit 0 without a FAIL, 1 with one or on
a bad command line (`check_draft.py: <cause>` on stderr).
"""
import re, sys
from pathlib import Path

# -I drops the script's folder from sys.path; resolve() follows the skill link (topics/macOS Python.md).
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "harness-common" / "scripts"))
import markdown  # noqa: E402

# The plan's top sections, by the start of their heading after an optional "<n>. " (document-template.md).
REQUIRED_SECTIONS = {
    "summary": r"summary\b",
    "product": r"product solution\b",
    "questions": r"open questions\b",
    "technical": r"technical solution\b",
    "milestones": r"milestones\b",
    "risks": r"risks\b",
}
NUMBERED = re.compile(r"\d+\.\s+")
PRODUCT_STAGE_SECTIONS = ("summary", "product", "questions")
LATER_SECTIONS = ("technical", "milestones")
EFFORT_PATTERNS = [
    r"\b(engineer|dev|developer|man|person)[- ]?(days?|weeks?|months?)\b",
    r"\bstory[- ]points?\b",
    r"\bt-shirt siz",
]
# A table header cell that names an effort estimate. "Estimated rows" in a data table is not one.
ESTIMATE_HEADER = re.compile(r"estimates?|estimation|estimated (effort|time|days|size)|effort|story points|t-shirt size")
CROSS_REFERENCE_PATTERNS = [
    r"\bsee (section |§ ?)?\d+(\.\d+)*\b",
    r"§ ?\d",
    r"\bas (mentioned|described|said) above\b",
    r"\b(risk|question) \d+\b",
]
LABEL_REFERENCE = re.compile(r"\bP\d+\b")
PROPOSED = re.compile(r"\bproposed\b", re.IGNORECASE)
PRODUCT_CODE_TERMS = r"\b(controller|endpoint|serializer|migration|orm|sql)\b"
QUESTION_START = re.compile(r"(?=^\s*[-*]?\s*\*\*Q\d+\.)", re.MULTILINE)
QUESTION_TITLE = re.compile(r"\s*[-*]?\s*\*\*Q(\d+)\.\s*(.+?)\*\*")
QUESTION_PARTS = ("Context", "Question", "Recommendation")
MAIN_FILES = ("attack-plan.md", "technical-solution.md", "evidence.md")

# Task blocks (executable-plan.md "Task block schema"): a heading `[<code> M<n>-<k>] <title>`, then
# these headings one level below it, in this order. Required ones need text under them.
TASK_TITLE = re.compile(r"\[([A-Za-z][A-Za-z0-9-]*) M(\d+)-(\d+)\]\s+\S.*")
TASK_HEADINGS = (
    ("Base", True),
    ("Files", True),
    ("Rule applied everywhere", True),
    ("Invariants and tests", True),
    ("Edge cases", True),
    ("Ordering", True),
    ("Reviewers", True),
    ("Context for an outside reviewer", True),
    ("Reviewer-facing rationale", True),
    ("QA", True),
    ("Depends on", True),
    ("Tracker ticket", False),
)


class CheckDraft:
    def __init__(self, folder, stage="full"):
        self.folder = Path(folder)
        self.stage = stage
        self.results = []

    def run(self):
        plan_path = self.folder / "attack-plan.md"
        if not plan_path.exists():
            self.add("FAIL", "attack-plan.md", "missing")
            return self.results
        plan = markdown.split(plan_path.read_text())
        self.sections = plan_sections(plan)
        self.check_sections()
        if self.stage == "product":
            self.check_product_stage(plan)
        self.check_product_section(plan)
        self.check_questions(plan)
        for name in MAIN_FILES:
            path = self.folder / name
            if path.exists():
                self.check_text(name, markdown.split(path.read_text()))
        if not any(level == "FAIL" for level, _, _ in self.results):
            self.add("PASS", "all", "no blocking issue")
        return self.results

    def check_sections(self):
        keys = PRODUCT_STAGE_SECTIONS if self.stage == "product" else REQUIRED_SECTIONS
        for key in keys:
            if key not in self.sections:
                self.add("FAIL", "attack-plan.md", f"no {key} section")
        found = [self.sections.get(k) for k in ("product", "questions", "technical")]
        if None not in found and not found[0] < found[1] < found[2]:
            self.add("FAIL", "attack-plan.md",
                     "Open questions must sit after Product solution and before Technical solution")

    def text_of(self, plan, key):
        span = self.sections.get(key)
        return "".join(plan[span[0] + 1:span[1]]) if span else None

    def check_product_stage(self, plan):
        if (self.folder / "technical-solution.md").exists():
            self.add("FAIL", "technical-solution.md", "exists before the product solution is approved")
        for key in LATER_SECTIONS:
            text = self.text_of(plan, key)
            if text and text.strip():
                self.add("FAIL", "attack-plan.md", f"the {key} section has content before the product solution is approved")

    def check_product_section(self, plan):
        text = self.text_of(plan, "product")
        if not text:
            return
        if re.search(r"`[^`]+`", text):
            self.add("WARN", "attack-plan.md", "inline code in the product solution")
        for term in dict.fromkeys(re.findall(PRODUCT_CODE_TERMS, text.lower())):
            self.add("WARN", "attack-plan.md", f"code term \"{term}\" in the product solution")

    def check_questions(self, plan):
        text = self.text_of(plan, "questions")
        if not text:
            return
        blocks = [b for b in QUESTION_START.split(text) if QUESTION_TITLE.match(b)]
        numbers = [int(QUESTION_TITLE.match(b).group(1)) for b in blocks]
        if numbers != list(range(1, len(numbers) + 1)):
            self.add("FAIL", "attack-plan.md",
                     f"questions are not numbered 1 to {len(numbers)} in order: {', '.join(map(str, numbers))}")
        for block in blocks:
            number, title = QUESTION_TITLE.match(block).groups()
            if title.strip().endswith("."):
                self.add("WARN", "attack-plan.md", f"Q{number} title ends with a period")
            missing = [part for part in QUESTION_PARTS if f"**{part}" not in block]
            if missing:
                self.add("FAIL", "attack-plan.md", f"Q{number} has no {', '.join(missing)}")

    def check_text(self, name, lines):
        mask = markdown.fence_mask(lines)
        prose = [(line, number) for number, (line, fenced) in enumerate(zip(lines, mask), 1) if not fenced]
        for line, number in prose:
            lowered = line.lower()
            for pattern in EFFORT_PATTERNS:
                match = re.search(pattern, lowered)
                if match:
                    self.add("FAIL", name, f"line {number}: effort estimate \"{match.group(0)}\"")
            for pattern in CROSS_REFERENCE_PATTERNS:
                match = re.search(pattern, lowered)
                if match:
                    self.add("WARN", name, f"line {number}: inline cross-reference \"{match.group(0)}\"")
            match = LABEL_REFERENCE.search(line)
            if match:
                self.add("WARN", name, f"line {number}: inline cross-reference \"{match.group(0)}\"")
            if name == "attack-plan.md" and PROPOSED.search(line):
                self.add("WARN", name, f"line {number}: \"Proposed\": write the rule as decided, or as an open question")
            if re.search(r"\bOption [A-D]\b", line):
                self.add("FAIL", name, f"line {number}: \"Option A/B\" belongs in the alternatives")
            if line.count("`") % 2:
                self.add("FAIL", name, f"line {number}: odd number of backticks")
        if any(estimate_header(cells) for cells in header_rows(lines, mask)):
            self.add("FAIL", name, "a task table has an estimate column")
        if any("decision log" in title.lower() for _, _, title in markdown.headings(lines)):
            self.add("FAIL", name, "a decision log section")

    def add(self, level, file, message):
        self.results.append((level, file, message))


def plan_sections(lines):
    """Key -> (start, end) of each top section of the plan.

    Top sections sit at the level of the shallowest heading that names one. When any of them is
    numbered ("4. Milestones and verification"), only numbered headings count, so a product page
    called "Milestones overview" is never taken for the milestones section.
    """
    found = markdown.headings(lines)

    def key_of(title):
        bare = NUMBERED.sub("", title, count=1) if NUMBERED.match(title) else title
        return next((k for k, p in REQUIRED_SECTIONS.items() if re.match(p, bare, re.IGNORECASE)), None)

    named = [(i, level, title) for i, level, title in found if key_of(title)]
    if not named:
        return {}
    top = min(level for _, level, _ in named)
    named = [h for h in named if h[1] == top]
    if any(NUMBERED.match(title) for _, _, title in named):
        named = [h for h in named if NUMBERED.match(h[2])]
    sections = {}
    for index, _, title in named:
        key = key_of(title)
        if key in sections:
            continue
        end = next((i for i, lvl, _ in found if i > index and lvl <= top), len(lines))
        sections[key] = (index, end)
    return sections


def header_rows(lines, mask):
    """The header cells of every table outside fences: Markdown pipe tables (the first row of a run
    of `|` lines) and HTML tables (the first `<tr>`)."""
    rows, previous = [], False
    for line, fenced in zip(lines, mask):
        piped = not fenced and line.strip().startswith("|")
        if piped and not previous:
            rows.append([cell.strip() for cell in line.strip().strip("|").split("|")])
        previous = piped
    prose = "".join(line for line, fenced in zip(lines, mask) if not fenced)
    for table in re.findall(r"<table\b.*?</table>", prose, re.IGNORECASE | re.DOTALL):
        first = re.search(r"<tr\b.*?</tr>", table, re.IGNORECASE | re.DOTALL)
        if first:
            rows.append([re.sub(r"<[^>]+>", "", cell).strip()
                         for cell in re.findall(r"<t[dh]\b[^>]*>(.*?)</t[dh]>", first.group(0), re.IGNORECASE | re.DOTALL)])
    return rows


def estimate_header(cells):
    return any(ESTIMATE_HEADER.fullmatch(re.sub(r"[*_`]", "", cell).strip().lower()) for cell in cells)


def check_tasks(path, milestone=None):
    """Results for the task blocks in one file, `milestone` (a number) limiting them to M<n>."""
    path = Path(path)
    name = str(path)
    lines = markdown.split(path.read_text())
    found = markdown.headings(lines)
    results = []
    tasks = [(position, index, level, title) for position, (index, level, title) in enumerate(found)
             if TASK_TITLE.fullmatch(title)]
    if milestone is not None:
        tasks = [t for t in tasks if int(TASK_TITLE.fullmatch(t[3]).group(2)) == milestone]
    if not tasks:
        scope = f" for M{milestone}" if milestone is not None else ""
        return [("FAIL", name, f"no task block{scope}: a task heading reads [<code> M<n>-<k>] <title>")]
    codes = {TASK_TITLE.fullmatch(t[3]).group(1) for t in tasks}
    if len(codes) > 1:
        results.append(("FAIL", name, f"task titles use more than one project code: {', '.join(sorted(codes))}"))
    order = {}
    for position, index, level, title in tasks:
        _, number, k = TASK_TITLE.fullmatch(title).groups()
        task_id = f"M{number}-{k}"
        order.setdefault(int(number), []).append(int(k))
        end = next((i for i, lvl, _ in found[position + 1:] if lvl <= level), len(lines))
        subs = [(i, lvl, t) for i, lvl, t in found[position + 1:] if i < end]
        children = [(i, t) for i, lvl, t in subs if lvl == level + 1]
        known = {h.lower(): h for h, _ in TASK_HEADINGS}
        for i, t in children:
            if t.lower() not in known:
                results.append(("WARN", name, f"line {i + 1}: {task_id}: heading \"{t}\" is not in the task block schema"))
        present = [known[t.lower()] for _, t in children if t.lower() in known]
        missing = [h for h, required in TASK_HEADINGS if required and h not in present]
        if missing:
            results.append(("FAIL", name, f"{task_id}: no {', '.join(missing)}"))
        ranks = [next(n for n, (h, _) in enumerate(TASK_HEADINGS) if h == p) for p in present]
        if ranks != sorted(ranks) or len(set(present)) != len(present):
            results.append(("FAIL", name, f"{task_id}: headings out of the schema order"))
        bounds = [i for i, _ in children] + [end]
        for (i, t), stop in zip(children, bounds[1:]):
            heading = known.get(t.lower())
            required = dict(TASK_HEADINGS).get(heading)
            if required and not "".join(lines[i + 1:stop]).strip():
                results.append(("FAIL", name, f"{task_id}: {heading} is empty (write \"None\" and why)"))
    for number, ks in sorted(order.items()):
        if ks != list(range(1, len(ks) + 1)):
            results.append(("FAIL", name, f"M{number} tasks are not numbered 1 to {len(ks)} in order: "
                                          + ", ".join(f"M{number}-{k}" for k in ks)))
    if not any(level == "FAIL" for level, _, _ in results):
        results.append(("PASS", name, f"{len(tasks)} task block(s)"))
    return results


class Usage(Exception):
    pass


def parse(argv):
    """("plan", folder, stage) or ("tasks", file, milestone), or Usage naming the problem."""
    args = list(argv)
    if "--tasks" in args:
        at = args.index("--tasks")
        if at + 1 >= len(args) or args[at + 1].startswith("--"):
            raise Usage("--tasks needs a file")
        file = args[at + 1]
        del args[at:at + 2]
        milestone = None
        if "--milestone" in args:
            at = args.index("--milestone")
            value = args[at + 1] if at + 1 < len(args) else ""
            if not re.fullmatch(r"M?\d+", value, re.IGNORECASE):
                raise Usage(f"--milestone needs a milestone number such as 1 or M1, got {value!r}")
            milestone = int(value.lstrip("Mm"))
            del args[at:at + 2]
        if args:
            raise Usage(f"--tasks takes only --milestone, not {' '.join(args)}")
        if not Path(file).is_file():
            raise Usage(f"no file {file}")
        return "tasks", file, milestone
    unknown = [a for a in args if a.startswith("--") and a != "--product"]
    if unknown:
        raise Usage(f"unknown option {unknown[0]}")
    folders = [a for a in args if not a.startswith("--")]
    if len(folders) != 1:
        raise Usage(f"give one draft folder, got {len(folders)}")
    if not Path(folders[0]).is_dir():
        raise Usage(f"no draft folder {folders[0]}")
    return "plan", folders[0], "product" if "--product" in args else "full"


def main(argv):
    if argv and argv[0] in ("-h", "--help"):
        print(__doc__.strip())
        return 0
    try:
        mode, target, extra = parse(argv)
    except Usage as error:
        print(f"check_draft.py: {error}. Run check_draft.py --help for the usage.", file=sys.stderr)
        return 1
    results = check_tasks(target, extra) if mode == "tasks" else CheckDraft(target, extra).run()
    for level, file, message in results:
        print(f"{level} {file}: {message}")
    return 1 if any(level == "FAIL" for level, _, _ in results) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

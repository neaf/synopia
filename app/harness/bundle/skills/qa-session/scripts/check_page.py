#!/usr/bin/python3
"""Checks a QA session page against the rules a script can decide.

Usage: check_page.py <page.md> [-v] [--live]
Prints one summary line. -v lists every finding with its line number.
--live: the session has started, so Findings may hold the team's bullets. Without it Findings must be empty.
Exits 1 on a FAIL. Facts (is a value right, does a control exist) are the Verifier's job, not this script's.
The page shape is references/page-template.md. Headings and code fences come from harness-common's markdown.py.
"""
import argparse, re, sys
from pathlib import Path

# -I drops the script's folder from sys.path; resolve() follows the skill link (topics/macOS Python.md).
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "harness-common" / "scripts"))
import markdown  # noqa: E402

EMOJI = re.compile("[\U0001F000-\U0001FAFF☀-➿⬀-⯿]")
INTERNAL_ID = re.compile(r"\b(?:R|D|Q|S|DEC|ADR)[- ]?\d{1,3}\b")
ANGLE_PLACEHOLDER = re.compile(r"<(?!/?(?:br|b|i|em|strong|code|sub|sup|u|kbd|details|summary)\b)[A-Za-z][A-Za-z _-]{0,40}>")
# [text] that is not a checkbox, a link or a reference: the template's own placeholders.
BRACKET_PLACEHOLDER = re.compile(r"(?<![\]!])\[(?![ xX]\])[^\[\]\n]+\](?![(\[:])")
UNFINISHED = re.compile(r"\b(?:TODO|TBD|FIXME|XXX)\b")
BARE_TIME = re.compile(r"\b(today|now)\b", re.IGNORECASE)
CODE_SPAN = re.compile(r"(`+)(?!`).*?(?<!`)\1(?!`)")
SCENARIO = re.compile(r"(\d+)\. \S.*")
NUMBERED = re.compile(r"\d")
PERSONA = re.compile(r"As \S.*? \(`[^`]+`\):")
CHECK = re.compile(r"\s*[-*+] \[([ xX])\] \S")
FINDING = re.compile(r"(?:[-*+]|\d+\.) \S")
SETUP = re.compile(r"\s*<details\b", re.IGNORECASE)
FINDINGS = "Findings"


def scan(lines, live=False):
    """(findings, counts). Findings are (line number or 0 for the page, FAIL or WARN, message)."""
    findings = []
    fenced = markdown.fence_mask(lines)
    heads = {index: (level, title) for index, level, title in markdown.headings(lines)}
    scenarios, current = [], None
    checks = ticked = 0
    setup_line = first_scenario = None

    for index, line in enumerate(lines):
        number = index + 1
        if fenced[index]:
            continue
        if index in heads:
            level, title = heads[index]
            current = None
            if level == 3 and SCENARIO.fullmatch(title):
                current = {"line": number, "number": int(SCENARIO.match(title).group(1)), "first": True, "checks": 0}
                scenarios.append(current)
                first_scenario = first_scenario or number
            elif level == 3 and NUMBERED.match(title):
                findings.append((number, "FAIL", f"scenario heading '{title}': write '### N. Title'"))
        elif SETUP.match(line) and setup_line is None:
            setup_line = number

        prose = CODE_SPAN.sub("", line)
        if EMOJI.search(line):
            findings.append((number, "FAIL", "emoji"))
        for match in INTERNAL_ID.finditer(prose):
            findings.append((number, "FAIL", f"internal id '{match.group(0)}': name the case, or backtick an exact label"))
        if ANGLE_PLACEHOLDER.search(line) or BRACKET_PLACEHOLDER.search(line):
            findings.append((number, "FAIL", "placeholder: put the value in the page before the session"))
        if UNFINISHED.search(line):
            findings.append((number, "FAIL", "unfinished marker"))
        for match in BARE_TIME.finditer(prose):
            findings.append((number, "WARN", f"bare '{match.group(1).lower()}': say 'on production' or 'in this test environment'"))
        if "(cont.)" in line:
            findings.append((number, "WARN", "patched label '(cont.)': rewrite the block"))

        check = CHECK.match(line)
        if check:
            checks += 1
            ticked += check.group(1) in "xX"
        if current is None or index in heads or not line.strip():
            continue
        if current["first"]:
            current["first"] = False
            if not PERSONA.fullmatch(line.strip()):
                findings.append((number, "FAIL", "first line of the scenario is not its persona line 'As <persona> (`<email>`):'"))
        if check:
            current["checks"] += 1

    numbers = [s["number"] for s in scenarios]
    if numbers != list(range(1, len(numbers) + 1)):
        findings.append((0, "FAIL", f"scenario numbers are {numbers}, expected 1 to {len(numbers)} in order"))
    for scenario in scenarios:
        if scenario["checks"] == 0:
            findings.append((scenario["line"], "WARN", "scenario without checkboxes"))
    if setup_line is None or (first_scenario and setup_line > first_scenario):
        findings.append((0, "FAIL", "no collapsed setup: put it in a <details> block before the scenarios"))

    entries = 0
    span = next(((index, level) for index, (level, title) in sorted(heads.items()) if title == FINDINGS), None)
    if span is None:
        findings.append((0, "FAIL", f"no '{FINDINGS}' section"))
    else:
        start, level = span
        end = next((index for index, (lvl, _) in sorted(heads.items()) if index > start and lvl <= level), len(lines))
        body = [(index + 1, lines[index]) for index in range(start + 1, end) if lines[index].strip()]
        entries = sum(1 for index, line in body if not fenced[index - 1] and FINDING.match(line))
        if body and not live:
            findings.append((body[0][0], "FAIL", "Findings is not empty: it starts empty, with no table (use --live during a session)"))

    return findings, {"scenarios": len(scenarios), "checks": checks, "ticked": ticked, "findings": entries}


def main():
    parser = argparse.ArgumentParser(description="Check a QA session page.")
    parser.add_argument("page", type=Path)
    parser.add_argument("-v", "--verbose", action="store_true")
    parser.add_argument("--live", action="store_true", help="the session has started: Findings may hold entries")
    args = parser.parse_args()

    lines = args.page.read_text(encoding="utf-8").splitlines()
    findings, counts = scan(lines, live=args.live)
    fails = sum(1 for _, level, _ in findings if level == "FAIL")
    warns = sum(1 for _, level, _ in findings if level == "WARN")
    print(
        f"qa page: {counts['scenarios']} scenarios, {counts['checks']} checks, "
        f"{counts['ticked']} ticked, {counts['findings']} findings, {fails} FAIL, {warns} WARN"
    )
    if args.verbose:
        for number, level, message in findings:
            where = f"line {number}" if number else "page"
            print(f"{level} {where}: {message}")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())

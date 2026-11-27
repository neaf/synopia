"""Markdown structure shared by the harness scripts: fences, ATX headings, sections, section hashes.

Library only, no CLI. Pure functions over lists of lines (with or without line ends).
Used by attack-plan-create's gate.py and check_draft.py, and qa-session's check_page.py.

Rules, a subset of CommonMark:
- A fence opens on a line of 3 or more backticks or tildes, after any indentation. It closes on a
  line of the same character, at least as long, with nothing after it. An unclosed fence runs to
  the end of the text. Fence lines and the lines between them are code.
- A heading is an ATX heading outside a fence: up to 3 spaces, 1 to 6 `#`, then a space, a tab or
  the line end. An optional closing run of `#` is dropped from the title.
- A section runs from its heading to the next heading of the same or a higher level.
"""
import hashlib, re
from pathlib import Path

FENCE = re.compile(r"[ \t]*(`{3,}|~{3,})(.*)")
HEADING = re.compile(r" {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*")
# gate.py before the shared parser: no fences, any number of `#`. Only for hashes it stored then.
LEGACY_HEADING = re.compile(r"(#+)\s+(.*)")
PART_SEPARATOR = "\n\0\n"


class Missing(LookupError):
    """A file or a section that a digest needs is not there. The message names it."""


def split(text):
    return text.splitlines(keepends=True)


def fence_mask(lines):
    """One bool per line: True when the line is a fence line or inside a fence."""
    mask, fence = [], None
    for line in lines:
        match = FENCE.fullmatch(line.rstrip("\r\n"))
        if fence is None:
            if match and not (match.group(1)[0] == "`" and "`" in match.group(2)):
                fence = match.group(1)
            mask.append(fence is not None)
            continue
        mask.append(True)
        if match and match.group(1)[0] == fence[0] and len(match.group(1)) >= len(fence) and not match.group(2).strip():
            fence = None
    return mask


def headings(lines):
    """Every heading outside a fence: (line index, level, title), the title stripped."""
    found = []
    for index, (line, fenced) in enumerate(zip(lines, fence_mask(lines))):
        if fenced:
            continue
        match = HEADING.fullmatch(line.rstrip("\r\n"))
        if match:
            found.append((index, len(match.group(1)), (match.group(2) or "").strip()))
    return found


def section(lines, title):
    """(start, end) line indexes of the first section whose title equals `title`, case and outer
    spaces ignored. `end` is exclusive. None when no heading has that title."""
    wanted = title.strip().lower()
    found = headings(lines)
    for position, (start, level, text) in enumerate(found):
        if text.lower() == wanted:
            end = next((index for index, lvl, _ in found[position + 1:] if lvl <= level), len(lines))
            return start, end
    return None


def part(path, heading=None):
    """The text one (file, heading) pair stands for: the section, or the whole file without a heading."""
    path = Path(path)
    if not path.is_file():
        raise Missing(f"file {path.name} not found")
    lines = split(path.read_text())
    if not heading:
        return "".join(lines)
    span = section(lines, heading)
    if span is None:
        raise Missing(f'section "{heading}" not found in {path.name}')
    return "".join(lines[span[0]:span[1]])


def digest(pairs):
    """SHA-256 hex over one or more (path, heading or None) pairs, in order.

    Each part is stripped of outer whitespace. One pair hashes its part alone, so a single-section
    hash equals sha256(section.strip()). Raises Missing naming the first absent file or section.
    """
    parts = [part(path, heading).strip() for path, heading in pairs]
    if not parts:
        raise Missing("no file to hash")
    return hashlib.sha256(PART_SEPARATOR.join(parts).encode()).hexdigest()


def legacy_digest(path, heading=None):
    """The hash gate.py stored before the shared parser, for one pair, or None when absent.

    It read `#` lines inside fences as headings. A gate approved then keeps its hash until the next
    write upgrades it (gate.py, `upgrade`).
    """
    path = Path(path)
    if not path.is_file():
        return None
    text = path.read_text()
    if heading:
        lines, start, level = split(text), None, None
        text = None
        for index, line in enumerate(lines):
            match = LEGACY_HEADING.fullmatch(line.rstrip("\n"))
            if not match:
                continue
            if start is not None:
                if len(match.group(1)) <= level:
                    text = "".join(lines[start:index])
                    break
            elif match.group(2).strip().lower() == heading.strip().lower():
                start, level = index, len(match.group(1))
        if text is None and start is not None:
            text = "".join(lines[start:])
        if text is None:
            return None
    return hashlib.sha256(text.strip().encode()).hexdigest()

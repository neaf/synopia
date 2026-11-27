#!/usr/bin/python3
"""Takes full-page headless screenshots of a storyboard, in light and dark. Never opens a window.

Usage: shoot.py <page.html> [--out DIR] [--width 1440] [--height 6000] [--theme light|dark|both]
Prints one `path  WxH` line per screenshot, with ` (no data-h, used --height)` or
` (clipped from H)` when that applies. Any failure prints one `FAIL <reason>` line and exits 1.
Per theme: one --dump-dom pass at WIDTHx900 reads data-h from <html>, then one screenshot at that height.
Browser lookup and the facts behind it: harness-common/topics/Chrome headless shell.md.
"""
import argparse, os, platform, re, shutil, subprocess, sys, tempfile
from pathlib import Path

SHELL = "chromium_headless_shell-*/chrome-headless-shell-mac-{arch}/chrome-headless-shell"
INSTALL = "install it with: npx playwright install --only-shell"
HEIGHT = re.compile(r'<html[^>]*\bdata-h="(\d+)"')
DUMP_HEIGHT = 900
MAX_HEIGHT = 200000  # the tallest screenshot measured whole (topic doc, "Tall screenshots")
TIMEOUT = 120


class Fail(Exception):
    """An expected failure. The message is the plain-text reason."""


def version(path):
    m = re.search(r"chromium_headless_shell-(\d+)", str(path))
    return int(m.group(1)) if m else -1


def is_executable(path):
    return bool(path) and os.path.isfile(path) and os.access(path, os.X_OK)


def host_arch():
    return "arm64" if platform.machine() == "arm64" else "x64"


def find_chrome(env=os.environ, home=None):
    """chrome-headless-shell only, never a browser app (topic doc, "Which binary").

    Order: $CHROME, chrome-headless-shell on PATH, the newest executable Playwright shell for the
    host architecture under $PLAYWRIGHT_BROWSERS_PATH or ~/Library/Caches/ms-playwright.
    Raises Fail when $CHROME is set but is not an executable file.
    """
    chrome = env.get("CHROME")
    if chrome:
        if not is_executable(chrome):
            raise Fail(f"$CHROME is not an executable file: {chrome}")
        return chrome
    found = shutil.which("chrome-headless-shell", path=env.get("PATH"))
    if found:
        return found
    cache = env.get("PLAYWRIGHT_BROWSERS_PATH") or Path(home or Path.home(), "Library/Caches/ms-playwright")
    shells = [p for p in Path(cache).glob(SHELL.format(arch=host_arch())) if is_executable(str(p))]
    return str(max(shells, key=version)) if shells else None


def page_url(page, theme):
    return Path(page).resolve().as_uri() + f"?theme={theme}"


def shot_height(dom, fallback):
    """(height to shoot, note for the output line or '')."""
    m = HEIGHT.search(dom)
    if not m:
        height, note = fallback, " (no data-h, used --height)"
    else:
        height, note = int(m.group(1)), ""
    if height > MAX_HEIGHT:
        return MAX_HEIGHT, f" (clipped from {height})"
    return height, note


def reason(stderr, default):
    lines = [line.strip() for line in (stderr or "").splitlines() if line.strip()]
    return lines[-1] if lines else default


def run(chrome, profile, width, height, *args):
    cmd = [chrome, "--headless", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
           "--no-default-browser-check", f"--user-data-dir={profile}",
           f"--window-size={width},{height}", "--virtual-time-budget=3000", *args]
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=TIMEOUT)
    except subprocess.TimeoutExpired:
        raise Fail(f"chrome ran past its {TIMEOUT} s timeout") from None
    except OSError as error:
        raise Fail(f"cannot run {chrome}: {error.strerror or error}") from None


def shoot(a):
    chrome = find_chrome()
    if not chrome:
        raise Fail(f"no chrome-headless-shell found; {INSTALL}")
    if not os.path.isfile(a.page):
        raise Fail(f"{a.page} not found")
    os.makedirs(a.out, exist_ok=True)
    stem = Path(a.page).stem
    themes = ("light", "dark") if a.theme == "both" else (a.theme,)
    with tempfile.TemporaryDirectory() as profile:
        for theme in themes:
            url = page_url(a.page, theme)
            dump = run(chrome, profile, a.width, DUMP_HEIGHT, "--dump-dom", url)
            if dump.returncode:
                raise Fail(f"{theme} dump: {reason(dump.stderr, f'exit {dump.returncode}')}")
            height, note = shot_height(dump.stdout, a.height)
            shot = os.path.join(a.out, f"{stem}-{theme}.png")
            r = run(chrome, profile, a.width, height, f"--screenshot={shot}", url)
            if r.returncode or not os.path.isfile(shot):
                raise Fail(f"{theme}: {reason(r.stderr, 'no screenshot')}")
            print(f"{shot}  {a.width}x{height}{note}", flush=True)


def main():
    ap = argparse.ArgumentParser(description="Headless screenshots of a storyboard page, in light and dark.")
    ap.add_argument("page")
    ap.add_argument("--out", default=os.path.join(tempfile.gettempdir(), "storyboard-shots"))
    ap.add_argument("--width", type=int, default=1440)
    ap.add_argument("--height", type=int, default=6000)
    ap.add_argument("--theme", choices=("light", "dark", "both"), default="both")
    a = ap.parse_args()
    try:
        shoot(a)
    except Fail as error:
        print(f"FAIL {error}")
        sys.exit(1)


if __name__ == "__main__":
    main()

#!/usr/bin/python3
"""Prints one line per state change of GitHub pull requests or of local checks.

Usage:
  watch.py pr <number> [<number> ...] [--repo OWNER/NAME] [--reviewer LOGIN ...]
            [--interval SECONDS] [--until all|ci|bots] [--timeout MINUTES]
            [--allow-no-checks] [--once]
  watch.py local --cmd COMMAND [--cmd COMMAND ...] [--path PATH ...]
            [--interval SECONDS] [--debounce SECONDS] [--cmd-timeout SECONDS]
            [--timeout MINUTES] [--once]

The last line says why it stopped: ALL DONE, CI DONE, BOTS DONE (exit 0), NOT DONE (pr --once, exit 1),
ALL PASS (exit 0) or FAILED: <commands> (local --once, exit 1), TIMEOUT (exit 3), GH FAILING: <cause> (exit 4).
"""
import argparse, math, os, re, signal, subprocess, sys, time
from pathlib import Path

# -I drops the script's folder from sys.path; resolve() follows the skill link (topics/macOS Python.md).
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "harness-common" / "scripts"))
from github import Gh, GhError  # noqa: E402

SKIP_DIRS = {
    ".git", ".ai-notes", ".attack-plan", ".rearch", ".venv", "venv", "node_modules", "__pycache__", ".tox",
    ".mypy_cache", ".pytest_cache", ".gradle", ".idea", ".next", ".dart_tool", "build", "dist", "target",
    "coverage", "DerivedData", "Pods",
}
FAILING_CONCLUSIONS = {"FAILURE", "TIMED_OUT", "STARTUP_FAILURE"}
FAILING_STATES = {"FAILURE", "ERROR"}
PENDING_STATES = {"PENDING", "EXPECTED"}
# Review states that count as a review of the head commit: a dismissed review does not.
REVIEWED_STATES = {"APPROVED", "CHANGES_REQUESTED", "COMMENTED"}
NEWEST = "\uffff"  # sorts after every timestamp
DONE_LINES = {"all": "ALL DONE", "ci": "CI DONE", "bots": "BOTS DONE"}
GH_FAILING_ROUNDS = 3
ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
TAIL_LINES = 15
LABEL_WIDTH = 70


def is_check_run(item):
    return "status" in item or "conclusion" in item


def item_name(item):
    return item.get("name") or item.get("context")


def stamp(item):
    """Start time for picking the newest run. A queued run has none yet, so it is the newest (topics/GitHub.md)."""
    value = item.get("startedAt") if is_check_run(item) else item.get("createdAt")
    return NEWEST if not value or value.startswith("0001-") else value


def latest_checks(rollup):
    """One entry per (workflow, name): its newest run that was not cancelled, else its newest cancelled run.

    A cancelled run beside another run of the same check is a superseded duplicate (topics/GitHub.md).
    """
    newest = {}
    for item in rollup:
        key = (item.get("workflowName"), item_name(item))
        rank = (item.get("conclusion") != "CANCELLED", stamp(item))
        if key not in newest or rank >= newest[key][0]:
            newest[key] = (rank, item)
    return [item for _, item in newest.values()]


def checks(rollup):
    """Returns (pending, failing): whether a check still runs, and the sorted labels of the failing ones.

    A check whose only run is cancelled is failing, labelled `<name> (cancelled)`.
    """
    pending, failing = False, set()
    for item in latest_checks(rollup):
        if is_check_run(item):
            if item.get("status") != "COMPLETED":
                pending = True
            elif item.get("conclusion") in FAILING_CONCLUSIONS:
                failing.add(item_name(item))
            elif item.get("conclusion") == "CANCELLED":
                failing.add(f"{item_name(item)} (cancelled)")
        elif item.get("state") in PENDING_STATES:
            pending = True
        elif item.get("state") in FAILING_STATES:
            failing.add(item_name(item))
    return pending, sorted(failing)


def normalize_login(login):
    """REST names a bot `claude[bot]`, GraphQL `claude` (topics/GitHub.md)."""
    login = (login or "").lower()
    return login[: -len("[bot]")] if login.endswith("[bot]") else login


def pr_state(snap, reviewers, allow_no_checks=False):
    """The compared state of one open PR from a github.Gh snapshot."""
    head, rollup = snap["head"], snap["rollup"]
    pending, failing = checks(rollup)
    pending = pending or (not rollup and not allow_no_checks)
    reviewed = {
        normalize_login(review["login"])
        for review in snap["reviews"] if review["commit"] == head and review["state"] in REVIEWED_STATES
    }
    open_threads = [thread for thread in snap["threads"] if not thread["resolved"]]
    return {
        "sha": head[:7],
        "pending": pending,
        "failing": failing,
        "missing": [login for login in reviewers if normalize_login(login) not in reviewed],
        "unresolved": len(open_threads),
        "human": sum(1 for thread in open_threads if not thread["is_bot"]),
    }


def is_done(state, until="all"):
    """all: CI green, reviewed, no open thread. ci: no check running. bots: as all, human threads allowed."""
    if state["pending"]:
        return False
    if until == "ci":
        return True
    threads = state["unresolved"] - state["human"] if until == "bots" else state["unresolved"]
    return not (state["failing"] or state["missing"] or threads)


def format_pr(number, state, reviewers):
    parts = [
        f"#{number} {state['sha']}",
        "CI running" if state["pending"] else "CI done",
        "failing: " + (", ".join(state["failing"]) or "none"),
    ]
    if reviewers:
        if state["missing"]:
            parts.append("waiting for review: " + ", ".join(state["missing"]))
        else:
            parts.append("reviewed")
    threads = f"unresolved threads: {state['unresolved']}"
    if state["human"]:
        threads += f" (human {state['human']})"
    parts.append(threads)
    return " | ".join(parts)


def report_changes(previous, current, reviewers):
    lines = [format_pr(number, state, reviewers) for number, state in current.items() if previous.get(number) != state]
    return {**previous, **current}, lines


def run_pr(numbers, repo, reviewers, until, interval, timeout, allow_no_checks, once, gh, sleep, clock, emit):
    """Poll until done. Done needs two identical rounds in a row, except with --once."""
    active, printed, last_round, failures, started = list(numbers), {}, None, {}, clock()
    while True:
        current, closed = {}, []
        for number in active:
            try:
                snap = gh.pr_snapshot(repo, number)
            except GhError as error:
                count = failures.get(number, (0, ""))[0] + 1
                failures[number] = (count, str(error))
                print(f"skipped #{number} this round: {error}", file=sys.stderr)
                continue
            failures.pop(number, None)
            if snap["state"] != "OPEN":
                emit(f"#{number} {snap['state'].lower()}, stopped watching")
                closed.append(number)
                continue
            current[number] = pr_state(snap, reviewers, allow_no_checks)
        active = [number for number in active if number not in closed]
        printed, lines = report_changes(printed, current, reviewers)
        for line in lines:
            emit(line)
        for number, (count, message) in failures.items():
            if count >= GH_FAILING_ROUNDS:
                emit(f"GH FAILING: #{number} {message}")
                return 4
        complete = len(current) == len(active)
        if complete and all(is_done(current[number], until) for number in active):
            if not active or once or current == last_round:
                emit(DONE_LINES[until])
                return 0
        last_round = current if complete else None
        if once:
            emit("NOT DONE")
            return 1
        if timeout and clock() - started >= timeout:
            emit("TIMEOUT")
            return 3
        sleep(interval)


def run_shell(command, timeout):
    """(exit code, output) of one shell command; exit code None when it ran past `timeout` seconds.

    stdin is closed, so a command that asks for input fails instead of hanging. The command runs in its own
    process group, so a timeout kills its children too, and the pipe closes.
    """
    process = subprocess.Popen(
        command, shell=True, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, errors="replace", start_new_session=True,
    )
    try:
        output, _ = process.communicate(timeout=timeout)
        return process.returncode, output
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        output, _ = process.communicate()
        output = output or ""
        if output and not output.endswith("\n"):
            output += "\n"
        return None, output + f"timed out after {timeout:g} s\n"


def run_commands(commands, runner):
    return [(command, *runner(command)) for command in commands]


def label(command):
    return command if len(command) <= LABEL_WIDTH else command[: LABEL_WIDTH - 3] + "..."


def tail(output, lines=TAIL_LINES):
    return ANSI.sub("", output).rstrip().splitlines()[-lines:]


def outcome(code, output):
    """What a rerun is compared on: pass, or the exit code and the output tail of a failure."""
    return "pass" if code == 0 else (code, tuple(tail(output)))


def report_results(previous, results):
    """results: (command, exit code or None, output). previous: command -> outcome. Lines only on change."""
    lines, now = [], {}
    for command, code, output in results:
        now[command] = outcome(code, output)
        if previous.get(command) == now[command]:
            continue
        if code == 0:
            lines.append(f"PASS {label(command)}")
        else:
            lines.append(f"FAIL {label(command)} " + ("(timed out)" if code is None else f"(exit {code})"))
            lines.extend("    " + line for line in now[command][1])
    return {**previous, **now}, lines


def walk_files(root):
    if os.path.isfile(root):
        yield root
        return
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [name for name in dirnames if name not in SKIP_DIRS]
        for name in filenames:
            yield os.path.join(dirpath, name)


def snapshot(roots):
    files = {}
    for root in roots:
        for path in walk_files(root):
            try:
                stat = os.stat(path)
            except OSError:
                continue
            files[path] = (stat.st_mtime_ns, stat.st_size)
    return files


class Trigger:
    """Says when a run is due: files changed since the last run, and quiet for `delay` seconds."""

    def __init__(self, delay, initial):
        self.delay, self.ran_on, self.seen, self.changed_at = delay, initial, initial, None

    def observe(self, current, now):
        if current != self.seen:
            self.seen, self.changed_at = current, now
        if self.changed_at is not None and now - self.changed_at >= self.delay and self.seen != self.ran_on:
            self.ran_on, self.changed_at = self.seen, None
            return True
        return False

    def ran(self, current):
        """The files as they are after a run: what the commands wrote does not trigger the next run."""
        self.ran_on = self.seen = current
        self.changed_at = None


def run_local(commands, roots, interval, debounce, once, runner, sleep, clock, emit, timeout=0):
    if once:
        results = run_commands(commands, runner)
        _, lines = report_results({}, results)
        for line in lines:
            emit(line)
        failed = [label(command) for command, code, _ in results if code != 0]
        emit("ALL PASS" if not failed else "FAILED: " + ", ".join(failed))
        return 1 if failed else 0
    started = clock()
    previous, lines = report_results({}, run_commands(commands, runner))
    for line in lines:
        emit(line)
    trigger = Trigger(debounce, snapshot(roots))
    while True:
        if timeout and clock() - started >= timeout:
            emit("TIMEOUT")
            return 3
        sleep(interval)
        if trigger.observe(snapshot(roots), clock()):
            previous, lines = report_results(previous, run_commands(commands, runner))
            for line in lines:
                emit(line)
            trigger.ran(snapshot(roots))


def number(minimum, strict):
    def parse(text):
        try:
            value = float(text)
        except ValueError:
            raise argparse.ArgumentTypeError(f"not a number: {text}") from None
        if not math.isfinite(value) or value < minimum or (strict and value == minimum):
            raise argparse.ArgumentTypeError(f"must be {'>' if strict else '>='} {minimum:g}: {text}")
        return value
    return parse


positive, non_negative = number(0, True), number(0, False)


def parser():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    modes = ap.add_subparsers(dest="mode", required=True)
    pr = modes.add_parser("pr", help="watch GitHub pull requests")
    pr.add_argument("numbers", nargs="+", type=int)
    pr.add_argument("--repo", help="OWNER/NAME; default: the repository of the current folder")
    pr.add_argument("--reviewer", action="append", default=[], dest="reviewers",
                    help="login whose review must cover the head commit (repeatable)")
    pr.add_argument("--interval", type=positive, default=120, help="seconds between polls, > 0")
    pr.add_argument("--until", choices=tuple(DONE_LINES), default="all",
                    help="ci: stop when no check runs; bots: as all, but unresolved human threads are allowed")
    pr.add_argument("--timeout", type=non_negative, default=0, help="minutes before TIMEOUT; 0 means no limit")
    pr.add_argument("--allow-no-checks", action="store_true", help="a PR with no checks at all counts as done")
    pr.add_argument("--once", action="store_true", help="one round, then exit")
    local = modes.add_parser("local", help="rerun commands when files change")
    local.add_argument("--cmd", action="append", required=True, dest="commands", help="shell command (repeatable)")
    local.add_argument("--path", action="append", dest="paths", help="folder or file to watch (default: .)")
    local.add_argument("--interval", type=positive, default=2, help="seconds between scans, > 0")
    local.add_argument("--debounce", type=non_negative, default=1, help="quiet seconds before a rerun")
    local.add_argument("--cmd-timeout", type=positive, default=600, help="seconds before a command is killed")
    local.add_argument("--timeout", type=non_negative, default=0, help="minutes before TIMEOUT; 0 means no limit")
    local.add_argument("--once", action="store_true", help="run once, then exit with the combined status")
    return ap


def emit(line):
    print(line, flush=True)


def main(argv=None, gh=None):
    args = parser().parse_args(argv)
    if args.mode == "pr":
        gh = gh or Gh()
        try:
            repo = args.repo or gh.repo()
        except GhError as error:
            emit(f"GH FAILING: cannot resolve the repository: {error}")
            return 4
        return run_pr(args.numbers, repo, args.reviewers, args.until, args.interval, args.timeout * 60,
                      args.allow_no_checks, args.once, gh, time.sleep, time.monotonic, emit)
    roots = [os.path.abspath(path) for path in args.paths or ["."]]
    return run_local(args.commands, roots, args.interval, args.debounce, args.once,
                     lambda command: run_shell(command, args.cmd_timeout), time.sleep, time.monotonic, emit,
                     timeout=args.timeout * 60)


if __name__ == "__main__":
    sys.exit(main())

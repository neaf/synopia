#!/usr/bin/python3
"""Lists the unresolved review threads of pull requests; replies to and resolves threads a bot started.

Usage:
  review_threads.py list --pr N [N ...] [--repo OWNER/NAME]
  review_threads.py resolve --thread ID [ID ...]
  review_threads.py reply --thread ID --body-file FILE|-

list: one line per unresolved thread, `#<pr> <thread id> bot|human <login> <path>[:<line>] <url> | <first line>`,
then `<n> unresolved: <b> bot, <h> human`. Exit 0, or 1 with `FAIL #<pr>: <cause>` when a PR cannot be read.
resolve: one line per thread, `RESOLVED <id>`, `RESOLVED <id> (already)`, `REFUSED: <id> human thread
(<login>), the user resolves it` or `FAIL <id>: <cause>`. Exit 0 when every thread is resolved, else 1.
reply: posts the file's text (`-` reads stdin) in one thread as the gh user, then resolves it: `REPLIED <id> <url>`
and `RESOLVED <id>`. A human thread is refused (`REFUSED: <id> human thread (<login>), the user replies`), and
a resolved one gets no reply (`REFUSED: <id> already resolved, no reply posted`). A failed resolve after the
reply prints `FAIL <id>: replied, not resolved: <cause>`: run `resolve` for it, not `reply`, so the text is not
posted twice. Exit 0 when the reply is posted and the thread resolved, else 1.
Only threads a bot started are written to. Human threads stay for the user.
"""
import argparse, sys
from pathlib import Path

# -I drops the script's folder from sys.path; resolve() follows the skill link (topics/macOS Python.md).
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "harness-common" / "scripts"))
from github import Gh, GhError  # noqa: E402

TEXT_WIDTH = 100


def say(line):
    print(line, flush=True)


def summary(body):
    lines = [line.strip() for line in (body or "").splitlines() if line.strip()]
    text = lines[0] if lines else ""
    return text if len(text) <= TEXT_WIDTH else text[:TEXT_WIDTH - 3] + "..."


def thread_line(number, thread):
    place = thread["path"] or "-"
    if thread["line"] is not None:
        place += f":{thread['line']}"
    kind = "bot" if thread["is_bot"] else "human"
    return f"#{number} {thread['id']} {kind} {thread['login']} {place} {thread['url']} | {summary(thread['body'])}"


def list_threads(gh, numbers, repo=None):
    try:
        repo = repo or gh.repo()
    except GhError as error:
        say(f"FAIL cannot resolve the repository: {error}")
        return 1
    failed, bots, humans = False, 0, 0
    for number in numbers:
        try:
            snapshot = gh.pr_snapshot(repo, number)
        except GhError as error:
            say(f"FAIL #{number}: {error}")
            failed = True
            continue
        for thread in snapshot["threads"]:
            if thread["resolved"]:
                continue
            say(thread_line(number, thread))
            bots, humans = bots + thread["is_bot"], humans + (not thread["is_bot"])
    say(f"{bots + humans} unresolved: {bots} bot, {humans} human")
    return 1 if failed else 0


def resolve_threads(gh, ids):
    done = True
    for thread_id in ids:
        try:
            thread = gh.thread(thread_id)
            if not thread["is_bot"]:
                say(f"REFUSED: {thread_id} human thread ({thread['login']}), the user resolves it")
                done = False
            elif thread["resolved"]:
                say(f"RESOLVED {thread_id} (already)")
            elif gh.resolve_thread(thread_id):
                say(f"RESOLVED {thread_id}")
            else:
                say(f"FAIL {thread_id}: GitHub did not mark it resolved")
                done = False
        except GhError as error:
            say(f"FAIL {thread_id}: {error}")
            done = False
    return 0 if done else 1


def reply_thread(gh, thread_id, body):
    try:
        thread = gh.thread(thread_id)
        if not thread["is_bot"]:
            say(f"REFUSED: {thread_id} human thread ({thread['login']}), the user replies")
            return 1
        if thread["resolved"]:
            say(f"REFUSED: {thread_id} already resolved, no reply posted")
            return 1
        say(f"REPLIED {thread_id} {gh.reply_to_thread(thread_id, body)}")
    except GhError as error:
        say(f"FAIL {thread_id}: {error}")
        return 1
    try:
        if gh.resolve_thread(thread_id):
            say(f"RESOLVED {thread_id}")
            return 0
        cause = "GitHub did not mark it resolved"
    except GhError as error:
        cause = str(error)
    say(f"FAIL {thread_id}: replied, not resolved: {cause}")
    return 1


def read_body(parser, path):
    try:
        body = sys.stdin.read() if path == "-" else Path(path).read_text()
    except OSError as error:
        parser.error(f"cannot read {path}: {error.strerror}")
    if not body.strip():
        parser.error(f"{path} holds no reply text")
    return body.strip()


def main(argv, gh=None):
    parser = argparse.ArgumentParser(
        description="List unresolved review threads; reply to and resolve threads a bot started.")
    commands = parser.add_subparsers(dest="command", required=True)
    listing = commands.add_parser("list", help="unresolved threads of the pull requests, bot or human")
    listing.add_argument("--pr", required=True, nargs="+", type=int, metavar="N", help="pull request numbers")
    listing.add_argument("--repo", help="OWNER/NAME (default: the repository of the current folder)")
    resolving = commands.add_parser("resolve", help="resolve threads a bot started; human threads are refused")
    resolving.add_argument("--thread", required=True, nargs="+", metavar="ID", help="thread ids from `list`")
    replying = commands.add_parser("reply", help="post a reply in a thread a bot started, then resolve it")
    replying.add_argument("--thread", required=True, metavar="ID", help="one thread id from `list`")
    replying.add_argument("--body-file", required=True, metavar="FILE", help="the reply text; - reads stdin")
    options = parser.parse_args(argv)
    body = read_body(parser, options.body_file) if options.command == "reply" else None
    gh = gh or Gh()
    if options.command == "list":
        return list_threads(gh, options.pr, options.repo)
    if options.command == "reply":
        return reply_thread(gh, options.thread, body)
    return resolve_threads(gh, options.thread)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

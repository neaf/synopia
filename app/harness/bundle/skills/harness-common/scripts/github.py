#!/usr/bin/python3
"""GitHub adapter over the `gh` CLI: one runner, `GhError`, the paginated pull request snapshot, one thread, reply, resolve.

Facts: skills/harness-common/topics/GitHub.md. Library only, no CLI. Every gh failure raises GhError with
one line that names the cause.
"""
import json, shutil, subprocess

BINARY = "gh"
PAGE = 100  # a GraphQL connection takes `first` up to 100 (GitHub.md "Quirk: lists stop at 100")

CHECKS = """
      commits(last: 1) { nodes { commit { oid statusCheckRollup {
        contexts(first: %d, after: $checks) { pageInfo { hasNextPage endCursor } nodes {
          __typename
          ... on CheckRun { name status conclusion startedAt checkSuite { workflowRun { workflow { name } } } }
          ... on StatusContext { context state createdAt }
        } } } } } }""" % PAGE
REVIEWS = """
      reviews(first: %d, after: $reviews) { pageInfo { hasNextPage endCursor } nodes {
        state author { __typename login } commit { oid }
      } }""" % PAGE
THREADS = """
      reviewThreads(first: %d, after: $threads) { pageInfo { hasNextPage endCursor } nodes {
        id isResolved path line comments(first: 1) { nodes { url body author { __typename login } } }
      } }""" % PAGE
PARTS = {"checks": CHECKS, "reviews": REVIEWS, "threads": THREADS}
THREAD = ("query($id: ID!) { node(id: $id) { __typename ... on PullRequestReviewThread { "
          "id isResolved path line pullRequest { number } "
          "comments(first: 1) { nodes { url body author { __typename login } } } } } }")
REPLY = ("mutation($id: ID!, $body: String!) { addPullRequestReviewThreadReply("
         "input: {pullRequestReviewThreadId: $id, body: $body}) { comment { url } } }")
RESOLVE = ("mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) "
           "{ thread { id isResolved } } }")


class GhError(Exception):
    """A failed gh call or an unreadable answer. The message is one line."""


def first_line(text):
    lines = (text or "").strip().splitlines()
    return lines[0] if lines else ""


def run(args, timeout=60):
    """stdout of `gh <args>`. GhError when gh is missing, fails or times out."""
    if not shutil.which(BINARY):
        raise GhError("gh not found on PATH")
    try:
        done = subprocess.run([BINARY, *args], capture_output=True, text=True, timeout=timeout,
                              stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        raise GhError(f"gh {args[0]} timed out after {timeout} s") from None
    except OSError as error:
        raise GhError(str(error)) from None
    if done.returncode:
        raise GhError(first_line(done.stderr) or f"gh exited with {done.returncode}")
    return done.stdout


def snapshot_query(parts):
    """The PR query for the named connections. Page reads ask only for the connections that have more."""
    variables = "$owner: String!, $name: String!, $number: Int!, " + ", ".join(f"${p}: String" for p in parts)
    body = "".join(PARTS[p] for p in parts)
    return (f"query({variables}) {{ repository(owner: $owner, name: $name) {{ pullRequest(number: $number) {{\n"
            f"      state headRefOid{body}\n    }} }} }}")


def actor(node):
    """(login, is_bot) of an Actor. A deleted account is null: GitHub shows it as `ghost`."""
    author = node.get("author") or {}
    return author.get("login") or "ghost", author.get("__typename") == "Bot"


def check_item(node):
    """A rollup item in the shape watch.py reads: CheckRun keys or StatusContext keys."""
    if node.get("__typename") == "StatusContext":
        return {"context": node["context"], "state": node["state"], "createdAt": node.get("createdAt")}
    workflow_run = (node.get("checkSuite") or {}).get("workflowRun") or {}
    return {"name": node["name"], "workflowName": (workflow_run.get("workflow") or {}).get("name"),
            "status": node["status"], "conclusion": node.get("conclusion"), "startedAt": node.get("startedAt")}


def review_item(node):
    login, is_bot = actor(node)
    return {"login": login, "is_bot": is_bot, "state": node["state"], "commit": (node.get("commit") or {}).get("oid")}


def thread_item(node):
    comments = (node.get("comments") or {}).get("nodes") or [{}]
    login, is_bot = actor(comments[0])
    return {"id": node["id"], "url": comments[0].get("url"), "resolved": node["isResolved"], "path": node.get("path"),
            "line": node.get("line"), "login": login, "is_bot": is_bot, "body": comments[0].get("body") or ""}


class Gh:
    """gh calls through one runner: runner(args) -> stdout, raises GhError. Tests pass a fake."""

    def __init__(self, runner=run):
        self.runner = runner

    def graphql(self, query, **variables):
        """`data` of one GraphQL call. Strings go as -f (raw), numbers as -F: -F reads `@file` values."""
        args = ["api", "graphql", "-f", f"query={query}"]
        for key, value in variables.items():
            if value is None:
                continue
            args += ["-F" if isinstance(value, int) else "-f", f"{key}={value}"]
        try:
            answer = json.loads(self.runner(args))
        except ValueError:
            raise GhError("gh api graphql printed no JSON") from None
        if answer.get("errors"):
            raise GhError("GraphQL: " + first_line(answer["errors"][0].get("message")))
        return answer.get("data") or {}

    def repo(self):
        """OWNER/NAME of the repository of the current folder."""
        name = self.runner(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).strip()
        if "/" not in name:
            raise GhError(f"gh repo view printed {name!r}, not OWNER/NAME")
        return name

    def pr_snapshot(self, repo, number):
        """State, head, rollup, reviews and threads of one PR, every page read.

        One call per round, plus one per connection page past 100 items (NFR-11).
        """
        owner, _, name = repo.partition("/")
        cursors = {part: None for part in PARTS}
        items = {part: [] for part in PARTS}
        state = head = None
        while cursors is not None:
            data = self.graphql(snapshot_query(list(cursors)), owner=owner, name=name, number=number, **cursors)
            try:
                pr = data["repository"]["pullRequest"]
                if pr is None:
                    raise GhError(f"no pull request #{number} in {repo}")
                if head is not None and pr["headRefOid"] != head:
                    raise GhError(f"#{number} head moved while its pages were read")
                state, head = pr["state"], pr["headRefOid"]
                more = {}
                for part in cursors:
                    connection = self.connection(pr, part, head, number)
                    items[part] += connection["nodes"]
                    if connection["pageInfo"]["hasNextPage"]:
                        more[part] = connection["pageInfo"]["endCursor"]
            except (KeyError, TypeError, IndexError) as error:
                raise GhError(f"unexpected GraphQL answer for #{number}: missing {error}") from None
            cursors = more or None
        return {
            "state": state, "head": head,
            "rollup": [check_item(n) for n in items["checks"]],
            "reviews": [review_item(n) for n in items["reviews"]],
            "threads": [thread_item(n) for n in items["threads"]],
        }

    @staticmethod
    def connection(pr, part, head, number):
        if part == "reviews":
            return pr["reviews"] or {"nodes": [], "pageInfo": {"hasNextPage": False}}
        if part == "threads":
            return pr["reviewThreads"]
        commit = pr["commits"]["nodes"][0]["commit"]
        if commit["oid"] != head:
            raise GhError(f"#{number} head moved while it was read")
        rollup = commit["statusCheckRollup"]  # null before any check registers
        return rollup["contexts"] if rollup else {"nodes": [], "pageInfo": {"hasNextPage": False}}

    def thread(self, thread_id):
        """One review thread by its node id, in the snapshot's thread shape plus `pr` (its PR number)."""
        node = self.graphql(THREAD, id=thread_id).get("node")
        if not node or node.get("__typename") != "PullRequestReviewThread":
            raise GhError(f"no review thread {thread_id}")
        try:
            return dict(thread_item(node), pr=node["pullRequest"]["number"])
        except (KeyError, TypeError) as error:
            raise GhError(f"unexpected GraphQL answer for thread {thread_id}: missing {error}") from None

    def reply_to_thread(self, thread_id, body):
        """Post `body` as a reply in one review thread, as the gh user. Writes to GitHub. Returns the comment URL."""
        data = self.graphql(REPLY, id=thread_id, body=body)
        try:
            return data["addPullRequestReviewThreadReply"]["comment"]["url"]
        except (KeyError, TypeError):
            raise GhError(f"unexpected GraphQL answer replying to {thread_id}") from None

    def resolve_thread(self, thread_id):
        """Resolve one review thread. Writes to GitHub: only callers that are allowed to resolve use it."""
        data = self.graphql(RESOLVE, id=thread_id)
        try:
            return data["resolveReviewThread"]["thread"]["isResolved"] is True
        except (KeyError, TypeError):
            raise GhError(f"unexpected GraphQL answer resolving {thread_id}") from None

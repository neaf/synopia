#!/usr/bin/python3
"""git adapter: one runner, `GitError` and `Conflict`, the version gate, remote branches, merges without a checkout.

Facts: skills/harness-common/topics/git.md. Library only, no CLI. A failed git call raises GitError with one
line that names the command and the cause. A merge with conflicts raises Conflict, which is not a GitError.
"""
import os, re, subprocess

BINARY = "git"


class GitError(Exception):
    """A failed git call: bad ref, network, old git, missing identity. The message is one line."""


class Conflict(Exception):
    """`merge-tree` found conflicts. `files` lists the conflicted paths; it can be empty (git.md).

    `head` is the branch being merged, when the caller knows it: `merge_tree` sees only commits.
    """

    def __init__(self, files, messages=(), head=None):
        self.files, self.messages, self.head = list(files), list(messages), head
        super().__init__(", ".join(self.files) or "a conflict with no conflicted file")


def cause(text):
    """The line of git's output that names the cause: the first `fatal:`, `error:` or `[rejected]` line,
    else the first line. A `fatal: ` prefix is dropped."""
    lines = [line.strip() for line in (text or "").splitlines() if line.strip()]
    named = [line for line in lines if line.startswith(("fatal:", "error:")) or "[rejected]" in line]
    line = (named or lines or [""])[0]
    return line[len("fatal: "):] if line.startswith("fatal: ") else line


def run(args, cwd=".", timeout=300):
    """(exit code, stdout, stderr) of `git -C cwd <args>`. Never prompts: stdin closed, no terminal prompt."""
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0")
    try:
        done = subprocess.run([BINARY, "-C", str(cwd), *args], capture_output=True, text=True, timeout=timeout,
                              stdin=subprocess.DEVNULL, env=env)
    except subprocess.TimeoutExpired:
        raise GitError(f"git {args[0]} timed out after {timeout} s") from None
    except OSError as error:
        raise GitError(f"git not runnable: {error}") from None
    return done.returncode, done.stdout, done.stderr


class Git:
    """git calls in one repository through one runner: runner(args, cwd) -> (code, stdout, stderr)."""

    def __init__(self, cwd=".", runner=run):
        self.cwd, self.runner = cwd, runner

    def call(self, *args, ok=(0,)):
        """(code, stdout) of one call. GitError when the exit code is not in `ok`."""
        code, out, err = self.runner(list(args), self.cwd)
        if code not in ok:
            raise GitError(f"git {args[0]}: {cause(err) or cause(out) or f'exit {code}'}")
        return code, out

    def out(self, *args):
        return self.call(*args)[1].strip()

    def version(self):
        """(major, minor, patch) from `git --version`, such as `git version 2.39.5 (Apple Git-154)`."""
        text = self.out("--version")
        found = re.search(r"(\d+)\.(\d+)(?:\.(\d+))?", text)
        if not found:
            raise GitError(f"git --version printed {text!r}")
        return tuple(int(part or 0) for part in found.groups())

    def require(self, major, minor):
        """GitError naming both versions when git is older than major.minor."""
        found = self.version()
        if found[:2] < (major, minor):
            raise GitError(f"needs git {major}.{minor} or later, found {'.'.join(map(str, found))}")

    def require_identity(self):
        """`commit-tree` needs user.name and user.email (git.md "`commit-tree` needs an identity")."""
        for role in ("GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"):
            if self.runner(["var", role], self.cwd)[0] != 0:
                raise GitError("no git identity: set user.name and user.email (git config)")

    def remote_has(self, remote, branch):
        """Whether the remote has the branch, by `ls-remote`. A failed call raises; it never means absent."""
        return bool(self.out("ls-remote", "--heads", remote, f"refs/heads/{branch}"))

    def default_branch(self, remote):
        """The remote's HEAD branch, from `ls-remote --symref`."""
        for line in self.out("ls-remote", "--symref", remote, "HEAD").splitlines():
            if line.startswith("ref: refs/heads/"):
                return line[len("ref: refs/heads/"):].split()[0]
        raise GitError(f"{remote} names no HEAD branch")

    def fetch(self, remote, *branches):
        """Fetch each branch into `<remote>/<branch>` with an explicit refspec: a single-branch clone's
        configured refspec does not cover other branches (git.md "Fetch and remote branches")."""
        refspecs = [f"+refs/heads/{b}:refs/remotes/{remote}/{b}" for b in dict.fromkeys(branches)]
        self.call("fetch", "-q", remote, *refspecs)

    def rev(self, ref):
        """The commit SHA of a ref."""
        return self.resolve(ref, "commit")

    def tree_of(self, rev):
        return self.resolve(rev, "tree")

    def resolve(self, ref, kind):
        code, out = self.call("rev-parse", "--verify", "-q", f"{ref}^{{{kind}}}", ok=(0, 1))
        if code:
            raise GitError(f"no {kind} {ref}")
        return out.strip()

    def is_ancestor(self, a, b):
        """Whether commit a is contained in b (a == b counts)."""
        return self.call("merge-base", "--is-ancestor", a, b, ok=(0, 1))[0] == 0

    def merge_tree(self, a, b):
        """The merged tree of two commits, no work tree or index touched. Conflict on exit 1 (git.md)."""
        code, out = self.call("merge-tree", "--write-tree", "--name-only", a, b, ok=(0, 1))
        lines = out.splitlines()
        if code == 0:
            return lines[0].strip()
        body = lines[1:]
        blank = body.index("") if "" in body else len(body)
        raise Conflict(body[:blank], [line for line in body[blank + 1:] if line.strip()])

    def signs_commits(self):
        """`commit-tree` ignores commit.gpgsign (git.md "`commit-tree` does not sign"), so read it here."""
        code, out = self.call("config", "--bool", "commit.gpgsign", ok=(0, 1))
        return code == 0 and out.strip() == "true"

    def commit_tree(self, tree, parents, message):
        args = ["commit-tree", tree]
        for parent in parents:
            args += ["-p", parent]
        if self.signs_commits():
            args.append("-S")
        return self.out(*args, "-m", message)

    def push(self, remote, commit, branch):
        """Plain push of a commit to a branch. Never forced: a non-fast-forward is refused by the remote."""
        self.call("push", "-q", remote, f"{commit}:refs/heads/{branch}")

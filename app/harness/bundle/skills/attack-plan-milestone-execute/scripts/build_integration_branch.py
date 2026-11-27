#!/usr/bin/python3
"""Builds an integration branch from the heads of several branches, without a checkout.

Usage:
  build_integration_branch.py --target BRANCH --heads A,B,C [--from BASE] [--default BRANCH]
      [--message TEXT] [--push] [--repo PATH] [--remote NAME]

The first run starts from the default branch. Later runs merge the heads on top of the
existing target (--from target), so the push stays a fast-forward. A head already in the
result is skipped, so a run with nothing new adds no commit. A conflict stops the run and
pushes nothing. The last line of output is INTEGRATION_BRANCH_EVENT with a JSON payload whose
status is pushed, built, unchanged, conflict or failed. Exit 0 for the first three, 1 otherwise.
Needs git 2.38 or later (merge-tree --write-tree).
"""
import argparse, json, sys
from pathlib import Path

# -I drops the script's folder from sys.path; resolve() follows the skill link (topics/macOS Python.md).
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "harness-common" / "scripts"))
from git import Conflict, Git, GitError  # noqa: E402

MIN_GIT = (2, 38)


class Failure(Exception):
    pass


class BuildIntegrationBranch:
    def __init__(self, target, heads, base=None, default=None, message=None, push=False,
                 repo=".", remote="origin", out=None, git=None):
        self.target = target
        self.heads = heads
        self.base = base
        self.default = default
        self.message = message
        self.push = push
        self.remote = remote
        self.out = out or sys.stdout
        self.git = git or Git(repo)
        self.target_sha = None
        self.identity_checked = False

    def run(self):
        try:
            self.git.require(*MIN_GIT)
            self.fetch()
            current = self.base_commit()
            self.say(f"base {self.base_name()} {short(current)}")
            for head in self.heads:
                current = self.merge(current, head)
            status = self.publish(current)
            self.event(status=status, target=self.target, sha=current)
            return True
        except Conflict as conflict:
            self.say(f"CONFLICT merging {conflict.head}")
            for line in conflict.files + conflict.messages:
                self.say(f"  {line}")
            self.event(status="conflict", target=self.target, head=conflict.head, files=conflict.files,
                       error=f"CONFLICT merging {conflict.head}")
            return False
        except (Failure, GitError) as error:
            self.say(f"FAILED: {error}")
            self.event(status="failed", target=self.target, error=str(error))
            return False

    def fetch(self):
        if self.default is None:
            self.default = self.git.default_branch(self.remote)
        branches = [self.default, *self.heads]
        if self.base not in (None, "target", self.default):
            branches.append(self.base)
        if self.git.remote_has(self.remote, self.target):
            branches.append(self.target)
            self.git.fetch(self.remote, *branches)
            self.target_sha = self.git.rev(f"{self.remote}/{self.target}")
        else:
            self.git.fetch(self.remote, *branches)

    def base_name(self):
        return self.base or ("target" if self.target_sha else self.default)

    def base_commit(self):
        name = self.base_name()
        if name == "target":
            if not self.target_sha:
                raise Failure(f"{self.target} does not exist on {self.remote}: use --from {self.default}")
            return self.target_sha
        return self.git.rev(f"{self.remote}/{name}")

    def merge(self, current, head):
        other = self.git.rev(f"{self.remote}/{head}")
        if self.git.is_ancestor(other, current):
            self.say(f"skipped {head}: already in {short(current)}")
            return current
        try:
            tree = self.git.merge_tree(current, other)
        except Conflict as conflict:
            conflict.head = head
            raise
        if not self.identity_checked:
            self.git.require_identity()
            self.identity_checked = True
        commit = self.git.commit_tree(tree, [current, other], self.merge_message(head))
        self.say(f"merged {head} -> {short(commit)}")
        return commit

    def merge_message(self, head):
        return ": ".join(part for part in (self.message, f"Merge {head}") if part)

    def publish(self, commit):
        if commit == self.target_sha:
            self.say(f"unchanged: {self.target} is already at {short(commit)}")
            return "unchanged"
        if not self.push:
            self.say(f"built {short(commit)}, not pushed (pass --push to update {self.target})")
            return "built"
        self.git.push(self.remote, commit, self.target)
        self.say(f"pushed {self.target} at {short(commit)}")
        return "pushed"

    def say(self, line):
        print(line, file=self.out, flush=True)

    def event(self, **payload):
        self.say(f"INTEGRATION_BRANCH_EVENT {json.dumps(payload)}")


def short(sha):
    return sha[:12]


def split_list(value):
    return [item for item in value.split(",") if item]


def main(argv):
    parser = argparse.ArgumentParser(description="Build or update an integration branch from branch heads, without a checkout.")
    parser.add_argument("--target", required=True, help="integration branch to build or update")
    parser.add_argument("--heads", required=True, type=split_list, help="comma-separated branches to merge, in order")
    parser.add_argument("--from", dest="base", help="default branch name, or target to merge on top of the integration branch (default: target when it exists, else the default branch)")
    parser.add_argument("--default", help="default branch of the remote (default: read from the remote)")
    parser.add_argument("--message", help="prefix for the merge commit messages")
    parser.add_argument("--push", action="store_true", help="push the result (plain push, never forced)")
    parser.add_argument("--repo", default=".", help="repository path (default: current folder)")
    parser.add_argument("--remote", default="origin", help="remote name (default: origin)")
    options = parser.parse_args(argv)
    if not options.heads:
        parser.error("--heads needs at least one branch")
    run = BuildIntegrationBranch(target=options.target, heads=options.heads, base=options.base,
                                 default=options.default, message=options.message, push=options.push,
                                 repo=options.repo, remote=options.remote)
    return 0 if run.run() else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

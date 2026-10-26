"""Tests of the git operations, on real temporary repositories (no network): python3 -m unittest discover -s tests"""

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import gitops  # noqa: E402
from gitops import GitError  # noqa: E402


def git(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout


def make_clone(remote, target):
    git(remote.parent, "clone", "-q", str(remote), str(target))
    git(target, "config", "user.name", "Test")
    git(target, "config", "user.email", "test@example.com")
    return target


class GitOpsTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        base = Path(tmp.name)
        self.remote = base / "remote.git"
        git(base, "init", "-q", "--bare", "-b", "main", str(self.remote))
        self.repo = base / "work"
        self.repo.mkdir()
        git(self.repo, "init", "-q", "-b", "main")
        git(self.repo, "config", "user.name", "Test")
        git(self.repo, "config", "user.email", "test@example.com")
        (self.repo / "a.txt").write_text("one\n")
        git(self.repo, "add", "a.txt")
        git(self.repo, "commit", "-q", "-m", "First commit")
        git(self.repo, "remote", "add", "origin", str(self.remote))
        git(self.repo, "push", "-q", "-u", "origin", "main")
        self.path = str(self.repo)
        self.base = base

    def paths(self, kind):
        return [f["path"] for f in gitops.state(self.path)["files"][kind]]

    def test_state_lists_branch_and_changes(self):
        (self.repo / "a.txt").write_text("two\n")
        (self.repo / "new.txt").write_text("x\n")
        (self.repo / "sub").mkdir()
        (self.repo / "sub" / "b c.txt").write_text("space\n")
        state = gitops.state(str(self.repo / "sub"))  # from a subfolder
        self.assertEqual((state["root"], state["branch"], state["upstream"]), (str(self.repo), "main", "origin/main"))
        self.assertEqual([f["path"] for f in state["files"]["unstaged"]], ["a.txt"])
        self.assertEqual(sorted(f["path"] for f in state["files"]["untracked"]), ["new.txt", "sub/b c.txt"])
        self.assertEqual([b["name"] for b in state["branches"]["local"]], ["main"])
        self.assertEqual(state["branches"]["remote"], ["origin/main"])

    def test_stage_unstage_discard(self):
        (self.repo / "a.txt").write_text("two\n")
        (self.repo / "new.txt").write_text("x\n")
        gitops.stage(self.path, ["a.txt"])
        self.assertEqual(self.paths("staged"), ["a.txt"])
        gitops.unstage(self.path, ["a.txt"])
        self.assertEqual((self.paths("staged"), self.paths("unstaged")), ([], ["a.txt"]))
        gitops.discard(self.path, ["a.txt", "new.txt"])
        self.assertEqual((self.repo / "a.txt").read_text(), "one\n")
        self.assertFalse((self.repo / "new.txt").exists())
        self.assertEqual(self.paths("untracked"), [])

    def test_commit_and_log(self):
        (self.repo / "a.txt").write_text("two\n")
        with self.assertRaisesRegex(GitError, "No staged files"):  # changed but not staged
            gitops.commit(self.path, "Message")
        gitops.stage(self.path, ["a.txt"])
        with self.assertRaises(GitError):
            gitops.commit(self.path, "   ")
        gitops.unstage(self.path, ["a.txt"])
        gitops.stage(self.path)
        gitops.commit(self.path, "Second commit")
        commits = gitops.log(self.path)
        self.assertEqual([c["subject"] for c in commits], ["Second commit", "First commit"])
        self.assertEqual(commits[0]["parents"], [commits[1]["hash"]])
        self.assertIn({"type": "head", "name": "main"}, commits[0]["refs"])
        self.assertIn({"type": "remote", "name": "origin/main"}, commits[1]["refs"])
        details = gitops.commit_details(self.path, commits[0]["hash"])
        self.assertEqual((details["message"], details["files"]), ("Second commit", [{"code": "M", "from": None, "path": "a.txt"}]))
        self.assertIn("+two", gitops.diff(self.path, "a.txt", "commit", commits[0]["hash"])["diff"])

    def test_diffs(self):
        (self.repo / "a.txt").write_text("two\n")
        (self.repo / "new.txt").write_text("new content\n")
        self.assertIn("+two", gitops.diff(self.path, "a.txt", "unstaged")["diff"])
        self.assertIn("+new content", gitops.diff(self.path, "new.txt", "untracked")["diff"])
        gitops.stage(self.path, ["a.txt"])
        self.assertIn("-one", gitops.diff(self.path, "a.txt", "staged")["diff"])
        with self.assertRaises(GitError):
            gitops.diff(self.path, "a.txt", "unknown")

    def test_branches(self):
        gitops.create_branch(self.path, "feature/try")
        self.assertEqual(gitops.state(self.path)["branch"], "feature/try")
        gitops.push(self.path)  # without a remote branch: created, and tracked
        self.assertEqual(gitops.state(self.path)["upstream"], "origin/feature/try")
        gitops.checkout(self.path, "main")
        git(self.repo, "branch", "-q", "-D", "feature/try")
        gitops.checkout(self.path, "origin/feature/try")  # remote branch: local branch that tracks it
        state = gitops.state(self.path)
        self.assertEqual((state["branch"], state["upstream"]), ("feature/try", "origin/feature/try"))
        with self.assertRaises(GitError):
            gitops.checkout(self.path, "missing")

    def test_branch_open_in_another_worktree(self):
        other = self.base / "other-worktree"
        git(self.repo, "worktree", "add", "-q", "-b", "beside", str(other))
        branches = {b["name"]: b for b in gitops.state(self.path)["branches"]["local"]}
        self.assertEqual(os.path.realpath(branches["beside"]["worktree"]), os.path.realpath(other))
        self.assertIsNone(branches["main"]["worktree"])  # the one here
        # Seen from the worktree, it is main that is checked out elsewhere.
        from_other = {b["name"]: b for b in gitops.state(str(other))["branches"]["local"]}
        self.assertEqual(os.path.realpath(from_other["main"]["worktree"]), os.path.realpath(self.repo))
        with self.assertRaises(GitError) as raised:
            gitops.checkout(self.path, "beside")
        self.assertIn("checked out in another worktree", str(raised.exception))

    def test_fetch_pull_push_between_clones(self):
        other = make_clone(self.remote, self.base / "other")
        (other / "a.txt").write_text("from the other clone\n")
        git(other, "commit", "-q", "-am", "Commit from the other clone")
        git(other, "push", "-q")
        gitops.fetch(self.path)
        self.assertEqual(gitops.state(self.path)["behind"], 1)
        gitops.pull(self.path)
        self.assertEqual(((self.repo / "a.txt").read_text(), gitops.state(self.path)["behind"]), ("from the other clone\n", 0))
        (self.repo / "a.txt").write_text("back\n")
        gitops.stage(self.path)
        gitops.commit(self.path, "Back")
        self.assertEqual(gitops.state(self.path)["ahead"], 1)
        gitops.push(self.path)
        self.assertEqual(gitops.state(self.path)["ahead"], 0)

    def test_rejects_unsafe_input(self):
        for bad_files in (["../outside.txt"], ["/etc/passwd"], [""], "a.txt", [], [12]):
            with self.assertRaises(GitError):
                gitops.stage(self.path, bad_files)
        for bad_branch in ("-x", "a..b", "with space", "", None):
            with self.assertRaises(GitError):
                gitops.create_branch(self.path, bad_branch)
        for bad_hash in ("zzz", "123", "--all", None):
            with self.assertRaises(GitError):
                gitops.commit_details(self.path, bad_hash)
        with self.assertRaises(GitError):
            gitops.state(str(self.base))  # not a repository
        with self.assertRaises(GitError):
            gitops.state(str(self.base / "absent"))

    def test_empty_repository(self):
        empty = self.base / "empty"
        empty.mkdir()
        git(empty, "init", "-q", "-b", "main")
        (empty / "f.txt").write_text("x\n")
        self.assertEqual(gitops.log(str(empty)), [])
        gitops.stage(str(empty), ["f.txt"])
        gitops.unstage(str(empty), ["f.txt"])  # without HEAD
        self.assertEqual([f["path"] for f in gitops.state(str(empty))["files"]["untracked"]], ["f.txt"])

    def test_network_errors_do_not_hang(self):
        git(self.repo, "remote", "set-url", "origin", str(self.base / "absent.git"))
        with self.assertRaisesRegex(GitError, "Remote repository not found"):  # immediate, no password asked
            gitops.fetch(self.path)

    def test_push_rejected_when_remote_moved_on(self):
        other = make_clone(self.remote, self.base / "other")
        (other / "a.txt").write_text("other\n")
        git(other, "commit", "-q", "-am", "Remote moves ahead")
        git(other, "push", "-q")
        (self.repo / "b.txt").write_text("local\n")
        gitops.stage(self.path)
        gitops.commit(self.path, "Commit local")
        with self.assertRaisesRegex(GitError, "Pull first"):
            gitops.push(self.path)
        gitops.fetch(self.path)
        with self.assertRaisesRegex(GitError, "have diverged"):  # local and remote each have a commit
            gitops.pull(self.path)

    def test_local_conflicts_and_existing_branch(self):
        gitops.create_branch(self.path, "other")
        (self.repo / "a.txt").write_text("on other\n")
        gitops.stage(self.path)
        gitops.commit(self.path, "On other")
        gitops.checkout(self.path, "main")
        (self.repo / "a.txt").write_text("local change\n")
        with self.assertRaisesRegex(GitError, "would be overwritten"):
            gitops.checkout(self.path, "other")
        with self.assertRaisesRegex(GitError, "already exists"):
            gitops.create_branch(self.path, "other")

    def test_missing_identity(self):
        git(self.repo, "config", "--unset", "user.name")
        git(self.repo, "config", "--unset", "user.email")
        (self.repo / "a.txt").write_text("x\n")
        gitops.stage(self.path)
        env = {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1", "EMAIL": "", "GIT_AUTHOR_NAME": "",
               "GIT_COMMITTER_NAME": ""}
        with mock.patch.dict(os.environ, env):
            with self.assertRaisesRegex(GitError, "Git identity not configured"):
                gitops.commit(self.path, "No identity")

    def test_friendly_error_mapping(self):
        cases = {
            "fatal: unable to access 'https://x/': Could not resolve host: x": "unreachable",
            "remote: HTTP Basic: Access denied\nfatal: Authentication failed for 'https://x/'": "Access to the remote repository denied",
            "git@x: Permission denied (publickey).\nfatal: Could not read from remote repository.": "SSH key",
            "fatal: Unable to create '/r/.git/index.lock': File exists.": "index.lock",
            "error: you need to resolve your current index first\nfile.txt: needs merge\nUnmerged paths": "conflicts",
            "! [remote rejected] main -> main (pre-receive hook declined)": "rejected the push",
        }
        for raw, expected in cases.items():
            self.assertIn(expected, gitops.friendly_error(raw, "push"))
        self.assertIn("Git details", gitops.friendly_error("nothing to commit", "commit"))
        self.assertEqual(gitops.friendly_error("unknown error", "x"), "unknown error")  # not recognized: as is


if __name__ == "__main__":
    unittest.main()

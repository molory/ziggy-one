"""Tests des opérations git, sur de vrais dépôts temporaires (sans réseau) : python3 -m unittest discover -s tests"""

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
        self.remote = base / "distant.git"
        git(base, "init", "-q", "--bare", "-b", "main", str(self.remote))
        self.repo = base / "travail"
        self.repo.mkdir()
        git(self.repo, "init", "-q", "-b", "main")
        git(self.repo, "config", "user.name", "Test")
        git(self.repo, "config", "user.email", "test@example.com")
        (self.repo / "a.txt").write_text("un\n")
        git(self.repo, "add", "a.txt")
        git(self.repo, "commit", "-q", "-m", "Premier commit")
        git(self.repo, "remote", "add", "origin", str(self.remote))
        git(self.repo, "push", "-q", "-u", "origin", "main")
        self.path = str(self.repo)
        self.base = base

    def paths(self, kind):
        return [f["path"] for f in gitops.state(self.path)["files"][kind]]

    def test_state_lists_branch_and_changes(self):
        (self.repo / "a.txt").write_text("deux\n")
        (self.repo / "nouveau.txt").write_text("x\n")
        (self.repo / "sous").mkdir()
        (self.repo / "sous" / "b c.txt").write_text("espace\n")
        state = gitops.state(str(self.repo / "sous"))  # depuis un sous-dossier
        self.assertEqual((state["root"], state["branch"], state["upstream"]), (str(self.repo), "main", "origin/main"))
        self.assertEqual([f["path"] for f in state["files"]["unstaged"]], ["a.txt"])
        self.assertEqual(sorted(f["path"] for f in state["files"]["untracked"]), ["nouveau.txt", "sous/b c.txt"])
        self.assertEqual([b["name"] for b in state["branches"]["local"]], ["main"])
        self.assertEqual(state["branches"]["remote"], ["origin/main"])

    def test_stage_unstage_discard(self):
        (self.repo / "a.txt").write_text("deux\n")
        (self.repo / "nouveau.txt").write_text("x\n")
        gitops.stage(self.path, ["a.txt"])
        self.assertEqual(self.paths("staged"), ["a.txt"])
        gitops.unstage(self.path, ["a.txt"])
        self.assertEqual((self.paths("staged"), self.paths("unstaged")), ([], ["a.txt"]))
        gitops.discard(self.path, ["a.txt", "nouveau.txt"])
        self.assertEqual((self.repo / "a.txt").read_text(), "un\n")
        self.assertFalse((self.repo / "nouveau.txt").exists())
        self.assertEqual(self.paths("untracked"), [])

    def test_commit_and_log(self):
        (self.repo / "a.txt").write_text("deux\n")
        with self.assertRaisesRegex(GitError, "Aucun fichier indexé"):  # modifié mais pas indexé
            gitops.commit(self.path, "Message")
        gitops.stage(self.path, ["a.txt"])
        with self.assertRaises(GitError):
            gitops.commit(self.path, "   ")
        gitops.unstage(self.path, ["a.txt"])
        gitops.stage(self.path)
        gitops.commit(self.path, "Deuxième commit")
        commits = gitops.log(self.path)
        self.assertEqual([c["subject"] for c in commits], ["Deuxième commit", "Premier commit"])
        self.assertEqual(commits[0]["parents"], [commits[1]["hash"]])
        self.assertIn({"type": "head", "name": "main"}, commits[0]["refs"])
        self.assertIn({"type": "remote", "name": "origin/main"}, commits[1]["refs"])
        details = gitops.commit_details(self.path, commits[0]["hash"])
        self.assertEqual((details["message"], details["files"]), ("Deuxième commit", [{"code": "M", "from": None, "path": "a.txt"}]))
        self.assertIn("+deux", gitops.diff(self.path, "a.txt", "commit", commits[0]["hash"])["diff"])

    def test_diffs(self):
        (self.repo / "a.txt").write_text("deux\n")
        (self.repo / "nouveau.txt").write_text("contenu neuf\n")
        self.assertIn("+deux", gitops.diff(self.path, "a.txt", "unstaged")["diff"])
        self.assertIn("+contenu neuf", gitops.diff(self.path, "nouveau.txt", "untracked")["diff"])
        gitops.stage(self.path, ["a.txt"])
        self.assertIn("-un", gitops.diff(self.path, "a.txt", "staged")["diff"])
        with self.assertRaises(GitError):
            gitops.diff(self.path, "a.txt", "inconnu")

    def test_branches(self):
        gitops.create_branch(self.path, "feature/essai")
        self.assertEqual(gitops.state(self.path)["branch"], "feature/essai")
        gitops.push(self.path)  # sans branche distante : créée, et suivie
        self.assertEqual(gitops.state(self.path)["upstream"], "origin/feature/essai")
        gitops.checkout(self.path, "main")
        git(self.repo, "branch", "-q", "-D", "feature/essai")
        gitops.checkout(self.path, "origin/feature/essai")  # branche distante : branche locale qui la suit
        state = gitops.state(self.path)
        self.assertEqual((state["branch"], state["upstream"]), ("feature/essai", "origin/feature/essai"))
        with self.assertRaises(GitError):
            gitops.checkout(self.path, "inexistante")

    def test_branch_open_in_another_worktree(self):
        other = self.base / "autre-worktree"
        git(self.repo, "worktree", "add", "-q", "-b", "a-cote", str(other))
        branches = {b["name"]: b for b in gitops.state(self.path)["branches"]["local"]}
        self.assertEqual(os.path.realpath(branches["a-cote"]["worktree"]), os.path.realpath(other))
        self.assertIsNone(branches["main"]["worktree"])  # celle d'ici
        # Vu depuis le worktree, c'est main qui est ouverte ailleurs.
        from_other = {b["name"]: b for b in gitops.state(str(other))["branches"]["local"]}
        self.assertEqual(os.path.realpath(from_other["main"]["worktree"]), os.path.realpath(self.repo))
        with self.assertRaises(GitError) as raised:
            gitops.checkout(self.path, "a-cote")
        self.assertIn("ouverte dans un autre worktree", str(raised.exception))

    def test_fetch_pull_push_between_clones(self):
        other = make_clone(self.remote, self.base / "autre")
        (other / "a.txt").write_text("depuis l'autre clone\n")
        git(other, "commit", "-q", "-am", "Commit de l'autre clone")
        git(other, "push", "-q")
        gitops.fetch(self.path)
        self.assertEqual(gitops.state(self.path)["behind"], 1)
        gitops.pull(self.path)
        self.assertEqual(((self.repo / "a.txt").read_text(), gitops.state(self.path)["behind"]), ("depuis l'autre clone\n", 0))
        (self.repo / "a.txt").write_text("retour\n")
        gitops.stage(self.path)
        gitops.commit(self.path, "Retour")
        self.assertEqual(gitops.state(self.path)["ahead"], 1)
        gitops.push(self.path)
        self.assertEqual(gitops.state(self.path)["ahead"], 0)

    def test_rejects_unsafe_input(self):
        for bad_files in (["../dehors.txt"], ["/etc/passwd"], [""], "a.txt", [], [12]):
            with self.assertRaises(GitError):
                gitops.stage(self.path, bad_files)
        for bad_branch in ("-x", "a..b", "avec espace", "", None):
            with self.assertRaises(GitError):
                gitops.create_branch(self.path, bad_branch)
        for bad_hash in ("zzz", "123", "--all", None):
            with self.assertRaises(GitError):
                gitops.commit_details(self.path, bad_hash)
        with self.assertRaises(GitError):
            gitops.state(str(self.base))  # pas un dépôt
        with self.assertRaises(GitError):
            gitops.state(str(self.base / "absent"))

    def test_empty_repository(self):
        empty = self.base / "vide"
        empty.mkdir()
        git(empty, "init", "-q", "-b", "main")
        (empty / "f.txt").write_text("x\n")
        self.assertEqual(gitops.log(str(empty)), [])
        gitops.stage(str(empty), ["f.txt"])
        gitops.unstage(str(empty), ["f.txt"])  # sans HEAD
        self.assertEqual([f["path"] for f in gitops.state(str(empty))["files"]["untracked"]], ["f.txt"])

    def test_network_errors_do_not_hang(self):
        git(self.repo, "remote", "set-url", "origin", str(self.base / "absent.git"))
        with self.assertRaisesRegex(GitError, "Dépôt distant introuvable"):  # immédiat, sans mot de passe demandé
            gitops.fetch(self.path)

    def test_push_rejected_when_remote_moved_on(self):
        other = make_clone(self.remote, self.base / "autre")
        (other / "a.txt").write_text("autre\n")
        git(other, "commit", "-q", "-am", "Avance du distant")
        git(other, "push", "-q")
        (self.repo / "b.txt").write_text("local\n")
        gitops.stage(self.path)
        gitops.commit(self.path, "Commit local")
        with self.assertRaisesRegex(GitError, "Fais d'abord un Pull"):
            gitops.push(self.path)
        gitops.fetch(self.path)
        with self.assertRaisesRegex(GitError, "ont divergé"):  # local et distant ont chacun un commit
            gitops.pull(self.path)

    def test_local_conflicts_and_existing_branch(self):
        gitops.create_branch(self.path, "autre")
        (self.repo / "a.txt").write_text("sur autre\n")
        gitops.stage(self.path)
        gitops.commit(self.path, "Sur autre")
        gitops.checkout(self.path, "main")
        (self.repo / "a.txt").write_text("modif locale\n")
        with self.assertRaisesRegex(GitError, "seraient écrasées"):
            gitops.checkout(self.path, "autre")
        with self.assertRaisesRegex(GitError, "existe déjà"):
            gitops.create_branch(self.path, "autre")

    def test_missing_identity(self):
        git(self.repo, "config", "--unset", "user.name")
        git(self.repo, "config", "--unset", "user.email")
        (self.repo / "a.txt").write_text("x\n")
        gitops.stage(self.path)
        env = {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1", "EMAIL": "", "GIT_AUTHOR_NAME": "",
               "GIT_COMMITTER_NAME": ""}
        with mock.patch.dict(os.environ, env):
            with self.assertRaisesRegex(GitError, "Identité git non configurée"):
                gitops.commit(self.path, "Sans identité")

    def test_friendly_error_mapping(self):
        cases = {
            "fatal: unable to access 'https://x/': Could not resolve host: x": "injoignable",
            "remote: HTTP Basic: Access denied\nfatal: Authentication failed for 'https://x/'": "Accès au dépôt distant refusé",
            "git@x: Permission denied (publickey).\nfatal: Could not read from remote repository.": "clé SSH",
            "fatal: Unable to create '/r/.git/index.lock': File exists.": "index.lock",
            "error: you need to resolve your current index first\nfile.txt: needs merge\nUnmerged paths": "Conflits",
            "! [remote rejected] main -> main (pre-receive hook declined)": "refusé le push",
        }
        for raw, expected in cases.items():
            self.assertIn(expected, gitops.friendly_error(raw, "push"))
        self.assertIn("Détail git", gitops.friendly_error("nothing to commit", "commit"))
        self.assertEqual(gitops.friendly_error("erreur inconnue", "x"), "erreur inconnue")  # non reconnue : telle quelle


if __name__ == "__main__":
    unittest.main()

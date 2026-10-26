"""Tests du choix de dossier d'un nouvel agent : python3 -m unittest discover -s tests"""

import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from folders import create_subfolder, in_git_repo, list_subfolders, recent_folders, resolve_dir  # noqa: E402


class FoldersTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        for name in ("beta", "Alpha", ".cache", "gamma"):
            (self.root / name).mkdir()
        (self.root / "fichier.txt").write_text("contenu")
        os.symlink(self.root / "gamma", self.root / "lien-gamma")

    def test_resolve_dir_validates(self):
        self.assertEqual(resolve_dir(f"  {self.root}/beta/../gamma  "), (self.root / "gamma").resolve())
        for bad in ("", "   ", None, 12, "relatif/chemin", str(self.root / "absent"), str(self.root / "fichier.txt")):
            with self.assertRaises(ValueError):
                resolve_dir(bad)

    def test_lists_visible_subfolders_sorted(self):
        listing = list_subfolders(str(self.root))
        self.assertEqual(listing["dirs"], ["Alpha", "beta", "gamma", "lien-gamma"])  # ni caché, ni fichier
        self.assertEqual(listing["path"], str(self.root.resolve()))
        self.assertEqual(listing["parent"], str(self.root.resolve().parent))
        self.assertFalse(listing["truncated"])
        self.assertIsNone(list_subfolders("/")["parent"])

    def test_unreadable_folder(self):
        locked = self.root / "verrouille"
        locked.mkdir(mode=0o000)
        self.addCleanup(locked.chmod, 0o700)
        if os.access(locked, os.R_OK):  # exécuté en root : le test n'a pas de sens
            self.skipTest("droits ignorés pour cet utilisateur")
        with self.assertRaises(ValueError):
            list_subfolders(str(locked))

    def test_create_subfolder(self):
        created = create_subfolder(str(self.root), "  delta  ")
        self.assertEqual(created, self.root.resolve() / "delta")
        self.assertTrue(created.is_dir())
        self.assertIn("delta", list_subfolders(str(self.root))["dirs"])
        for bad in ("", "  ", None, "a/b", "..", ".cache-bis", "x" * 256, "delta", "fichier.txt"):
            with self.assertRaises(ValueError):
                create_subfolder(str(self.root), bad)
        with self.assertRaises(ValueError):
            create_subfolder(str(self.root / "absent"), "zeta")

    def test_in_git_repo(self):
        repo = self.root / "Alpha"
        (repo / ".git").mkdir()
        (repo / "src" / "module").mkdir(parents=True)
        worktree = self.root / "beta"
        (worktree / ".git").write_text("gitdir: /ailleurs")  # worktree : .git est un fichier
        self.assertTrue(in_git_repo(str(repo)))
        self.assertTrue(in_git_repo(str(repo / "src" / "module")))  # sous-dossier d'un dépôt
        self.assertTrue(in_git_repo(str(worktree)))
        self.assertFalse(in_git_repo(str(self.root / "gamma")))
        for bad in (None, "", 12):
            self.assertFalse(in_git_repo(bad))

    def test_recent_folders(self):
        alpha, beta, gamma = (str(self.root / name) for name in ("Alpha", "beta", "gamma"))
        entries = [
            {"cwd": alpha, "updatedAt": 10},
            {"cwd": beta, "updatedAt": 30},
            {"cwd": alpha, "updatedAt": 50},
            {"cwd": str(self.root / "disparu"), "updatedAt": 99},  # n'existe plus
            {"cwd": gamma, "updatedAt": 20},
            {"cwd": None},
        ]
        recent = recent_folders(entries)
        self.assertEqual([(f["path"], f["agents"], f["lastUsed"]) for f in recent],
                         [(alpha, 2, 50), (beta, 1, 30), (gamma, 1, 20)])
        self.assertEqual(len(recent_folders(entries, limit=2)), 2)


if __name__ == "__main__":
    unittest.main()

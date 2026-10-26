"""Tests de l'onglet Fichiers, sur de vrais dossiers et dépôts temporaires : python3 -m unittest discover -s tests"""

import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import files  # noqa: E402
from files import FileConflict  # noqa: E402


def git(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout


class FilesTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.base = Path(tmp.name).resolve()
        self.root = self.base / "agent"
        (self.root / "src" / "lib").mkdir(parents=True)
        (self.root / "Docs").mkdir()
        (self.root / ".git").mkdir()  # faux .git : ne doit jamais être exposé
        (self.root / ".git" / "config").write_text("secret")
        (self.root / ".env").write_text("A=1\n")
        (self.root / "b.txt").write_text("deux\n")
        (self.root / "A.md").write_text("# Titre\n")
        (self.root / "src" / "main.py").write_text("print('Bonjour')\n")
        (self.root / "src" / "lib" / "util.py").write_text("def aide():\n    return 'bonjour'\n")
        (self.base / "dehors.txt").write_text("hors du dossier")
        self.path = str(self.root)

    # --- chemins -----------------------------------------------------------------------

    def test_paths_must_stay_inside_the_agent_folder(self):
        for bad in ("../dehors.txt", "src/../../dehors.txt", "/etc/passwd", str(self.base / "dehors.txt"),
                    "a\0b", ".git/config", "src/.git/x"):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                files.read_file(self.path, bad)
        with self.assertRaises(ValueError):
            files.list_dir(self.path, "..")
        with self.assertRaises(ValueError):
            files.list_dir(self.path, ".git")
        with self.assertRaises(ValueError):
            files.read_file("relatif", "b.txt")
        with self.assertRaises(ValueError):
            files.read_file(str(self.base / "absent"), "b.txt")
        with self.assertRaises(ValueError):
            files.list_dir(str(self.root / ".git"), "")

    def test_symlinks_outside_or_to_git_are_refused(self):
        (self.root / "sortie.txt").symlink_to(self.base / "dehors.txt")
        (self.root / "sortie-dir").symlink_to(self.base)
        (self.root / "vers-git").symlink_to(self.root / ".git")
        (self.root / "interne.txt").symlink_to(self.root / "b.txt")
        (self.root / "interne-dir").symlink_to(self.root / "src")
        (self.root / "casse").symlink_to(self.root / "absent")
        for bad in ("sortie.txt", "sortie-dir/dehors.txt", "vers-git/config"):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                files.read_file(self.path, bad)
        self.assertEqual(files.read_file(self.path, "interne.txt")["content"], "deux\n")
        names = {e["name"]: e["type"] for e in files.list_dir(self.path)["entries"]}
        self.assertEqual(names["interne.txt"], "file")
        self.assertEqual(names["interne-dir"], "dir")
        for hidden in ("sortie.txt", "sortie-dir", "vers-git", "casse", ".git"):
            self.assertNotIn(hidden, names)

    # --- liste -------------------------------------------------------------------------

    def test_list_sorts_dirs_first_and_keeps_hidden_files_but_not_git(self):
        listing = files.list_dir(self.path, "")
        self.assertEqual(listing["dir"], "")
        self.assertFalse(listing["truncated"])
        self.assertEqual([e["name"] for e in listing["entries"]], ["Docs", "src", ".env", "A.md", "b.txt"])
        self.assertEqual(listing["entries"][0], {"name": "Docs", "type": "dir", "size": None})
        self.assertEqual(listing["entries"][-1], {"name": "b.txt", "type": "file", "size": 5})
        sub = files.list_dir(self.path, "./src//lib/")
        self.assertEqual((sub["dir"], [e["name"] for e in sub["entries"]]), ("src/lib", ["util.py"]))
        with self.assertRaises(ValueError):
            files.list_dir(self.path, "b.txt")

    def test_list_is_capped(self):
        with mock.patch.object(files, "MAX_ENTRIES", 2):
            listing = files.list_dir(self.path)
        self.assertEqual((len(listing["entries"]), listing["truncated"]), (2, True))

    # --- lecture -----------------------------------------------------------------------

    def test_read_text_binary_image_and_too_large(self):
        text = files.read_file(self.path, "src/main.py")
        info = os.stat(self.root / "src" / "main.py")
        self.assertEqual(text, {"file": "src/main.py", "kind": "text", "size": info.st_size, "editable": True,
                                "version": f"{info.st_mtime_ns}-{info.st_size}", "content": "print('Bonjour')\n"})
        (self.root / "nul.dat").write_bytes(b"abc\0def")
        (self.root / "latin1.txt").write_bytes("café".encode("latin-1"))
        (self.root / "logo.svg").write_text("<svg xmlns='http://www.w3.org/2000/svg'/>")
        (self.root / "gros.txt").write_bytes(b"a" * (files.MAX_TEXT + 1))
        (self.root / "moyen.txt").write_bytes(b"a" * (files.MAX_EDITABLE + 1))
        self.assertEqual(files.read_file(self.path, "nul.dat")["kind"], "binary")
        self.assertEqual(files.read_file(self.path, "latin1.txt")["kind"], "binary")
        image = files.read_file(self.path, "logo.svg")
        self.assertEqual((image["kind"], image["mime"], image["editable"]), ("image", "image/svg+xml", False))
        self.assertNotIn("content", image)
        self.assertEqual(files.read_file(self.path, "gros.txt")["kind"], "too_large")
        medium = files.read_file(self.path, "moyen.txt")
        self.assertEqual((medium["kind"], medium["editable"]), ("text", False))
        with self.assertRaises(ValueError):
            files.read_file(self.path, "src")
        with self.assertRaises(ValueError):
            files.read_file(self.path, "absent.txt")
        with self.assertRaises(ValueError):
            files.read_file(self.path, "")

    def test_read_image_only_serves_images(self):
        (self.root / "pixel.png").write_bytes(b"\x89PNG\r\n")
        self.assertEqual(files.read_image(self.path, "pixel.png"), (b"\x89PNG\r\n", "image/png"))
        with self.assertRaises(ValueError):
            files.read_image(self.path, "b.txt")

    # --- écriture ----------------------------------------------------------------------

    def test_write_replaces_content_atomically_and_keeps_mode(self):
        target = self.root / "src" / "main.py"
        target.chmod(0o750)
        version = files.read_file(self.path, "src/main.py")["version"]
        written = files.write_file(self.path, "src/main.py", "a\r\nb\n", version)
        self.assertEqual(target.read_bytes(), b"a\r\nb\n")
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o750)
        self.assertEqual((written["file"], written["size"]), ("src/main.py", 5))
        self.assertEqual(written["version"], files.read_file(self.path, "src/main.py")["version"])
        self.assertEqual(sorted(p.name for p in target.parent.iterdir()), ["lib", "main.py"])  # pas de reste

    def test_write_detects_changes_on_disk(self):
        version = files.read_file(self.path, "b.txt")["version"]
        (self.root / "b.txt").write_text("changé par un agent\n")
        with self.assertRaises(FileConflict) as caught:
            files.write_file(self.path, "b.txt", "mien", version)
        self.assertEqual(caught.exception.version, files.read_file(self.path, "b.txt")["version"])
        self.assertIn("a changé sur le disque", str(caught.exception))
        self.assertEqual((self.root / "b.txt").read_text(), "changé par un agent\n")

    def test_write_refuses_what_cannot_be_edited(self):
        (self.root / "nul.dat").write_bytes(b"abc\0def")
        (self.root / "sortie.txt").symlink_to(self.base / "dehors.txt")
        version = files.read_file(self.path, "b.txt")["version"]
        cases = [("nul.dat", "x"), ("src", "x"), ("absent.txt", "x"), ("sortie.txt", "x"), (".git/config", "x"),
                 ("../dehors.txt", "x"), ("b.txt", "a" * (files.MAX_EDITABLE + 1)), ("b.txt", None)]
        for name, content in cases:
            current = version
            if name != "b.txt" and (self.root / name).is_file():
                info = os.stat(self.root / name)
                current = f"{info.st_mtime_ns}-{info.st_size}"
            with self.subTest(name=name), self.assertRaises(ValueError):
                files.write_file(self.path, name, content, current)
        self.assertEqual((self.base / "dehors.txt").read_text(), "hors du dossier")
        self.assertEqual((self.root / "b.txt").read_text(), "deux\n")

    def test_write_through_an_inner_symlink_keeps_the_link(self):
        link = self.root / "lien.txt"
        link.symlink_to(self.root / "b.txt")
        version = files.read_file(self.path, "lien.txt")["version"]
        files.write_file(self.path, "lien.txt", "nouveau\n", version)
        self.assertTrue(link.is_symlink())
        self.assertEqual((self.root / "b.txt").read_text(), "nouveau\n")

    # --- recherche ---------------------------------------------------------------------

    def test_search_without_git_walks_the_folder(self):
        (self.root / "node_modules").mkdir()
        (self.root / "node_modules" / "util.js").write_text("bonjour")
        (self.root / "image.bin").write_bytes(b"bonjour\0")
        names = [r["file"] for r in files.search(self.path, "util", "name")["results"]]
        self.assertEqual(names, ["src/lib/util.py"])
        fuzzy = [r["file"] for r in files.search(self.path, "slu", "name")["results"]]
        self.assertEqual(fuzzy, ["src/lib/util.py"])
        content = files.search(self.path, "BONJOUR", "content")
        self.assertEqual(sorted((r["file"], r["line"]) for r in content["results"]),
                         [("src/lib/util.py", 2), ("src/main.py", 1)])
        self.assertFalse(content["truncated"])
        self.assertEqual(files.search(self.path, "config", "name")["results"], [])  # .git ignoré
        self.assertEqual(files.search(self.path, "secret", "content")["results"], [])

    def test_name_ranking_prefers_basename_contiguous_and_short(self):
        ranked = sorted(["docs/main-notes.md", "main.py", "src/main.py", "m/a/i/n.txt", "domain/x.py"],
                        key=lambda rel: files._name_rank("main", rel))
        self.assertEqual(ranked, ["main.py", "src/main.py", "docs/main-notes.md", "domain/x.py", "m/a/i/n.txt"])
        self.assertIsNone(files._name_rank("zz", "main.py"))

    def test_search_validates_its_parameters(self):
        for query, mode in (("", "name"), ("  ", "content"), ("x", "regex"), ("a\0", "name")):
            with self.subTest(query=query, mode=mode), self.assertRaises(ValueError):
                files.search(self.path, query, mode)

    def test_search_results_are_capped(self):
        with mock.patch.object(files, "MAX_CONTENT_RESULTS", 1):
            content = files.search(self.path, "bonjour", "content")
        self.assertEqual((len(content["results"]), content["truncated"]), (1, True))
        with mock.patch.object(files, "MAX_NAME_RESULTS", 1):
            names = files.search(self.path, "py", "name")
        self.assertEqual((len(names["results"]), names["truncated"]), (1, True))

    def test_long_lines_are_clipped(self):
        (self.root / "long.txt").write_text("x" * 1000 + "aiguille\n")
        [hit] = files.search(self.path, "aiguille", "content")["results"]
        self.assertEqual(len(hit["text"]), files.MAX_LINE)


class GitSearchTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.repo = Path(tmp.name).resolve() / "depot"
        self.repo.mkdir()
        git(self.repo, "init", "-q", "-b", "main")
        git(self.repo, "config", "user.name", "Test")
        git(self.repo, "config", "user.email", "test@example.com")
        (self.repo / ".gitignore").write_text("ignore/\n")
        (self.repo / "outil").mkdir()
        (self.repo / "outil" / "suivi.py").write_text("Aiguille = 1\n")
        (self.repo / "racine.txt").write_text("aiguille à la racine\n")
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-q", "-m", "init")
        (self.repo / "outil" / "nouveau.py").write_text("x = 'AIGUILLE'\n")  # non suivi
        (self.repo / "ignore").mkdir()
        (self.repo / "ignore" / "cache.py").write_text("aiguille\n")
        (self.repo / "outil" / "binaire.bin").write_bytes(b"aiguille\0")

    def test_uses_git_files_relative_to_the_agent_folder(self):
        agent = str(self.repo / "outil")
        names = sorted(r["file"] for r in files.search(agent, "py", "name")["results"])
        self.assertEqual(names, ["nouveau.py", "suivi.py"])
        content = files.search(agent, "aiguille", "content")
        self.assertEqual(sorted((r["file"], r["line"], r["text"]) for r in content["results"]),
                         [("nouveau.py", 1, "x = 'AIGUILLE'"), ("suivi.py", 1, "Aiguille = 1")])

    def test_respects_gitignore_from_the_repo_root(self):
        names = [r["file"] for r in files.search(str(self.repo), "cache", "name")["results"]]
        self.assertEqual(names, [])
        content = sorted(r["file"] for r in files.search(str(self.repo), "aiguille", "content")["results"])
        self.assertEqual(content, ["outil/nouveau.py", "outil/suivi.py", "racine.txt"])

    def test_no_match_is_not_an_error(self):
        self.assertEqual(files.search(str(self.repo), "introuvable", "content"),
                         {"results": [], "truncated": False})

    def test_query_starting_with_a_dash_is_text(self):
        (self.repo / "tiret.txt").write_text("option --force\n")
        hits = files.search(str(self.repo), "--force", "content")["results"]
        self.assertEqual([r["file"] for r in hits], ["tiret.txt"])


if __name__ == "__main__":
    unittest.main()

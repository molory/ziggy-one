"""Tests of the Files tab, on real temporary folders and repositories: python3 -m unittest discover -s tests"""

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
        (self.root / ".git").mkdir()  # fake .git: must never be exposed
        (self.root / ".git" / "config").write_text("secret")
        (self.root / ".env").write_text("A=1\n")
        (self.root / "b.txt").write_text("two\n")
        (self.root / "A.md").write_text("# Title\n")
        (self.root / "src" / "main.py").write_text("print('Hello')\n")
        (self.root / "src" / "lib" / "util.py").write_text("def helper():\n    return 'hello'\n")
        (self.base / "outside.txt").write_text("outside the folder")
        self.path = str(self.root)

    # --- paths -------------------------------------------------------------------------

    def test_paths_must_stay_inside_the_agent_folder(self):
        for bad in ("../outside.txt", "src/../../outside.txt", "/etc/passwd", str(self.base / "outside.txt"),
                    "a\0b", ".git/config", "src/.git/x"):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                files.read_file(self.path, bad)
        with self.assertRaises(ValueError):
            files.list_dir(self.path, "..")
        with self.assertRaises(ValueError):
            files.list_dir(self.path, ".git")
        with self.assertRaises(ValueError):
            files.read_file("relative", "b.txt")
        with self.assertRaises(ValueError):
            files.read_file(str(self.base / "absent"), "b.txt")
        with self.assertRaises(ValueError):
            files.list_dir(str(self.root / ".git"), "")

    def test_symlinks_outside_or_to_git_are_refused(self):
        (self.root / "exit.txt").symlink_to(self.base / "outside.txt")
        (self.root / "exit-dir").symlink_to(self.base)
        (self.root / "to-git").symlink_to(self.root / ".git")
        (self.root / "inner.txt").symlink_to(self.root / "b.txt")
        (self.root / "inner-dir").symlink_to(self.root / "src")
        (self.root / "broken").symlink_to(self.root / "absent")
        for bad in ("exit.txt", "exit-dir/outside.txt", "to-git/config"):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                files.read_file(self.path, bad)
        self.assertEqual(files.read_file(self.path, "inner.txt")["content"], "two\n")
        names = {e["name"]: e["type"] for e in files.list_dir(self.path)["entries"]}
        self.assertEqual(names["inner.txt"], "file")
        self.assertEqual(names["inner-dir"], "dir")
        for hidden in ("exit.txt", "exit-dir", "to-git", "broken", ".git"):
            self.assertNotIn(hidden, names)

    # --- listing -----------------------------------------------------------------------

    def test_list_sorts_dirs_first_and_keeps_hidden_files_but_not_git(self):
        listing = files.list_dir(self.path, "")
        self.assertEqual(listing["dir"], "")
        self.assertFalse(listing["truncated"])
        self.assertEqual([e["name"] for e in listing["entries"]], ["Docs", "src", ".env", "A.md", "b.txt"])
        self.assertEqual(listing["entries"][0], {"name": "Docs", "type": "dir", "size": None})
        self.assertEqual(listing["entries"][-1], {"name": "b.txt", "type": "file", "size": 4})
        sub = files.list_dir(self.path, "./src//lib/")
        self.assertEqual((sub["dir"], [e["name"] for e in sub["entries"]]), ("src/lib", ["util.py"]))
        with self.assertRaises(ValueError):
            files.list_dir(self.path, "b.txt")

    def test_list_is_capped(self):
        with mock.patch.object(files, "MAX_ENTRIES", 2):
            listing = files.list_dir(self.path)
        self.assertEqual((len(listing["entries"]), listing["truncated"]), (2, True))

    # --- reading -----------------------------------------------------------------------

    def test_read_text_binary_image_and_too_large(self):
        text = files.read_file(self.path, "src/main.py")
        info = os.stat(self.root / "src" / "main.py")
        self.assertEqual(text, {"file": "src/main.py", "kind": "text", "size": info.st_size, "editable": True,
                                "version": f"{info.st_mtime_ns}-{info.st_size}", "content": "print('Hello')\n"})
        (self.root / "null.dat").write_bytes(b"abc\0def")
        (self.root / "latin1.txt").write_bytes("café".encode("latin-1"))
        (self.root / "logo.svg").write_text("<svg xmlns='http://www.w3.org/2000/svg'/>")
        (self.root / "large.txt").write_bytes(b"a" * (files.MAX_TEXT + 1))
        (self.root / "medium.txt").write_bytes(b"a" * (files.MAX_EDITABLE + 1))
        self.assertEqual(files.read_file(self.path, "null.dat")["kind"], "binary")
        self.assertEqual(files.read_file(self.path, "latin1.txt")["kind"], "binary")
        image = files.read_file(self.path, "logo.svg")
        self.assertEqual((image["kind"], image["mime"], image["editable"]), ("image", "image/svg+xml", False))
        self.assertNotIn("content", image)
        self.assertEqual(files.read_file(self.path, "large.txt")["kind"], "too_large")
        medium = files.read_file(self.path, "medium.txt")
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

    # --- writing -----------------------------------------------------------------------

    def test_write_replaces_content_atomically_and_keeps_mode(self):
        target = self.root / "src" / "main.py"
        target.chmod(0o750)
        version = files.read_file(self.path, "src/main.py")["version"]
        written = files.write_file(self.path, "src/main.py", "a\r\nb\n", version)
        self.assertEqual(target.read_bytes(), b"a\r\nb\n")
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o750)
        self.assertEqual((written["file"], written["size"]), ("src/main.py", 5))
        self.assertEqual(written["version"], files.read_file(self.path, "src/main.py")["version"])
        self.assertEqual(sorted(p.name for p in target.parent.iterdir()), ["lib", "main.py"])  # nothing left behind

    def test_write_detects_changes_on_disk(self):
        version = files.read_file(self.path, "b.txt")["version"]
        (self.root / "b.txt").write_text("changed by an agent\n")
        with self.assertRaises(FileConflict) as caught:
            files.write_file(self.path, "b.txt", "mine", version)
        self.assertEqual(caught.exception.version, files.read_file(self.path, "b.txt")["version"])
        self.assertIn("changed on disk", str(caught.exception))
        self.assertEqual((self.root / "b.txt").read_text(), "changed by an agent\n")

    def test_write_refuses_what_cannot_be_edited(self):
        (self.root / "null.dat").write_bytes(b"abc\0def")
        (self.root / "exit.txt").symlink_to(self.base / "outside.txt")
        version = files.read_file(self.path, "b.txt")["version"]
        cases = [("null.dat", "x"), ("src", "x"), ("absent.txt", "x"), ("exit.txt", "x"), (".git/config", "x"),
                 ("../outside.txt", "x"), ("b.txt", "a" * (files.MAX_EDITABLE + 1)), ("b.txt", None)]
        for name, content in cases:
            current = version
            if name != "b.txt" and (self.root / name).is_file():
                info = os.stat(self.root / name)
                current = f"{info.st_mtime_ns}-{info.st_size}"
            with self.subTest(name=name), self.assertRaises(ValueError):
                files.write_file(self.path, name, content, current)
        self.assertEqual((self.base / "outside.txt").read_text(), "outside the folder")
        self.assertEqual((self.root / "b.txt").read_text(), "two\n")

    def test_write_through_an_inner_symlink_keeps_the_link(self):
        link = self.root / "link.txt"
        link.symlink_to(self.root / "b.txt")
        version = files.read_file(self.path, "link.txt")["version"]
        files.write_file(self.path, "link.txt", "new\n", version)
        self.assertTrue(link.is_symlink())
        self.assertEqual((self.root / "b.txt").read_text(), "new\n")

    # --- search ------------------------------------------------------------------------

    def test_search_without_git_walks_the_folder(self):
        (self.root / "node_modules").mkdir()
        (self.root / "node_modules" / "util.js").write_text("hello")
        (self.root / "image.bin").write_bytes(b"hello\0")
        names = [r["file"] for r in files.search(self.path, "util", "name")["results"]]
        self.assertEqual(names, ["src/lib/util.py"])
        fuzzy = [r["file"] for r in files.search(self.path, "slu", "name")["results"]]
        self.assertEqual(fuzzy, ["src/lib/util.py"])
        content = files.search(self.path, "HELLO", "content")
        self.assertEqual(sorted((r["file"], r["line"]) for r in content["results"]),
                         [("src/lib/util.py", 2), ("src/main.py", 1)])
        self.assertFalse(content["truncated"])
        self.assertEqual(files.search(self.path, "config", "name")["results"], [])  # .git ignored
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
            content = files.search(self.path, "hello", "content")
        self.assertEqual((len(content["results"]), content["truncated"]), (1, True))
        with mock.patch.object(files, "MAX_NAME_RESULTS", 1):
            names = files.search(self.path, "py", "name")
        self.assertEqual((len(names["results"]), names["truncated"]), (1, True))

    def test_long_lines_are_clipped(self):
        (self.root / "long.txt").write_text("x" * 1000 + "needle\n")
        [hit] = files.search(self.path, "needle", "content")["results"]
        self.assertEqual(len(hit["text"]), files.MAX_LINE)


class GitSearchTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.repo = Path(tmp.name).resolve() / "repo"
        self.repo.mkdir()
        git(self.repo, "init", "-q", "-b", "main")
        git(self.repo, "config", "user.name", "Test")
        git(self.repo, "config", "user.email", "test@example.com")
        (self.repo / ".gitignore").write_text("ignore/\n")
        (self.repo / "tool").mkdir()
        (self.repo / "tool" / "tracked.py").write_text("Needle = 1\n")
        (self.repo / "root.txt").write_text("needle at the root\n")
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-q", "-m", "init")
        (self.repo / "tool" / "new.py").write_text("x = 'NEEDLE'\n")  # untracked
        (self.repo / "ignore").mkdir()
        (self.repo / "ignore" / "cache.py").write_text("needle\n")
        (self.repo / "tool" / "binary.bin").write_bytes(b"needle\0")

    def test_uses_git_files_relative_to_the_agent_folder(self):
        agent = str(self.repo / "tool")
        names = sorted(r["file"] for r in files.search(agent, "py", "name")["results"])
        self.assertEqual(names, ["new.py", "tracked.py"])
        content = files.search(agent, "needle", "content")
        self.assertEqual(sorted((r["file"], r["line"], r["text"]) for r in content["results"]),
                         [("new.py", 1, "x = 'NEEDLE'"), ("tracked.py", 1, "Needle = 1")])

    def test_respects_gitignore_from_the_repo_root(self):
        names = [r["file"] for r in files.search(str(self.repo), "cache", "name")["results"]]
        self.assertEqual(names, [])
        content = sorted(r["file"] for r in files.search(str(self.repo), "needle", "content")["results"])
        self.assertEqual(content, ["root.txt", "tool/new.py", "tool/tracked.py"])

    def test_no_match_is_not_an_error(self):
        self.assertEqual(files.search(str(self.repo), "nowhere", "content"),
                         {"results": [], "truncated": False})

    def test_query_starting_with_a_dash_is_text(self):
        (self.repo / "dash.txt").write_text("option --force\n")
        hits = files.search(str(self.repo), "--force", "content")["results"]
        self.assertEqual([r["file"] for r in hits], ["dash.txt"])


if __name__ == "__main__":
    unittest.main()

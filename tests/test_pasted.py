import os
import tempfile
import time
import unittest
from pathlib import Path

import pasted


class SafeNameTest(unittest.TestCase):
    def test_names_typed_into_the_terminal_have_no_special_character(self):
        self.assertEqual(pasted.safe_name("notes.md"), "notes.md")
        self.assertEqual(pasted.safe_name("../../etc/passwd"), "passwd")
        self.assertEqual(pasted.safe_name("C:\\Users\\me\\Plan $(rm -rf).md"), "Plan_rm_-rf_.md")
        self.assertEqual(pasted.safe_name("résumé 2026.pdf"), "résumé_2026.pdf")
        self.assertEqual(pasted.safe_name(".."), "pasted")
        self.assertEqual(pasted.safe_name(None), "pasted")


class PastedFilesTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.files = pasted.PastedFiles(Path(tmp.name) / "pasted")

    def test_same_name_twice_gives_two_files(self):
        first = self.files.save("0123456789ab", "a.md", b"one")
        second = self.files.save("0123456789ab", "a.md", b"two")
        self.assertNotEqual(first, second)
        self.assertEqual((Path(first).read_bytes(), Path(second).read_bytes()), (b"one", b"two"))

    def test_refuses_empty_or_too_large(self):
        with self.assertRaises(ValueError):
            self.files.save("0123456789ab", "a.md", b"")
        with self.assertRaises(ValueError):
            self.files.save("0123456789ab", "a.md", b"x" * (pasted.MAX_SIZE + 1))

    def test_old_pastes_are_removed(self):
        old = Path(self.files.save("0123456789ab", "old.md", b"old"))
        week_ago = time.time() - pasted.KEEP - 60
        os.utime(old.parent, (week_ago, week_ago))
        recent = Path(self.files.save("0123456789ab", "new.md", b"new"))
        self.assertFalse(old.exists())
        self.assertTrue(recent.exists())


if __name__ == "__main__":
    unittest.main()

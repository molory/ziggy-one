"""The fuzz targets (fuzz/) on seeded random inputs, without atheris: python3 -m unittest discover -s tests

CI also runs them with atheris (coverage-guided). A failure here prints the seed to replay it.
"""

import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "fuzz"))

import fuzz_kanban  # noqa: E402
import fuzz_paths  # noqa: E402
from provider import RandomProvider  # noqa: E402

RUNS = 2000


class FuzzTargetsTest(unittest.TestCase):
    def run_target(self, target, folder):
        for seed in range(RUNS):
            with self.subTest(seed=seed):
                target(RandomProvider(seed), folder)

    def test_a_damaged_kanban_file_loads_with_defaults(self):
        with tempfile.TemporaryDirectory() as folder:
            self.run_target(fuzz_kanban.check, folder)

    def test_a_path_never_resolves_outside_the_folder_or_into_git(self):
        with tempfile.TemporaryDirectory() as folder:
            root = fuzz_paths.make_tree(folder)
            self.run_target(fuzz_paths.check, root)
            self.assertTrue(os.path.isdir(root))


if __name__ == "__main__":
    unittest.main()

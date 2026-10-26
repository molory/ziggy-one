"""Tests of context filling: python3 -m unittest discover -s tests"""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from context import ContextWindows, used_tokens  # noqa: E402


class ContextTest(unittest.TestCase):
    def test_used_tokens_counts_input_and_cache(self):
        usage = {"input_tokens": 2, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 30, "output_tokens": 500}
        self.assertEqual(used_tokens(usage), 132)  # the answer is not yet in the context sent
        self.assertIsNone(used_tokens({}))
        self.assertIsNone(used_tokens(None))
        self.assertEqual(used_tokens({"input_tokens": True, "cache_read_input_tokens": 5}), 5)

    def test_windows_are_learned_and_kept(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "context-windows.json"
            windows = ContextWindows(path)
            self.assertEqual(windows.window("claude-x"), 200_000)  # nothing learned: default value
            windows.learn({"claude-x[1m]": {"contextWindow": 1_000_000}, "autre": {"contextWindow": "?"}})
            self.assertEqual(ContextWindows(path).window("claude-x"), 1_000_000)  # read back from the file
            self.assertEqual(windows.describe("claude-x", 250_000), {"tokens": 250_000, "window": 1_000_000})
            self.assertIsNone(windows.describe("claude-x", None))

    def test_unknown_window_guesses_from_usage(self):
        windows = ContextWindows()
        self.assertEqual(windows.window("claude-y[1m]"), 1_000_000)
        self.assertEqual(windows.window("claude-y", 300_000), 1_000_000)  # already beyond 200,000
        self.assertEqual(windows.window(None, 1000), 200_000)

    def test_model_seen_beyond_default_gets_large_window(self):
        windows = ContextWindows()
        windows.observe("claude-z", 150_000)
        self.assertEqual(windows.window("claude-z", 10_000), 200_000)
        windows.observe("claude-z", 300_000)
        self.assertEqual(windows.window("claude-z", 10_000), 1_000_000)  # applies to its other sessions
        windows.learn({"claude-w": {"contextWindow": 200_000}})
        windows.observe("claude-w", 300_000)  # a window given by Claude Code wins
        self.assertEqual(windows.window("claude-w"), 200_000)


if __name__ == "__main__":
    unittest.main()

"""Tests of the "!! command" console: python3 -m unittest discover -s tests"""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import server  # noqa: E402
from fakes import drain, wait_for  # noqa: E402
from shell import ShellRuns  # noqa: E402

CONV = "abcdef012345"


class ShellRunsTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.cwd = tmp.name
        self.bus = server.Bus()
        self.events = self.bus.subscribe()
        self.shell = ShellRuns(self.bus)
        self.addCleanup(self.shell.stop_all)
        self.seen = []

    def run_events(self, run_id, timeout=5):
        """Events of the command until it ends."""
        def ended():
            self.seen += [data for kind, data in drain(self.events) if kind == "shell"]
            return any(e["run"] == run_id and e.get("ended") for e in self.seen)
        self.assertTrue(wait_for(ended, timeout))
        return [e for e in self.seen if e["run"] == run_id]

    def output(self, events):
        return "".join(e.get("output", "") for e in events)

    def test_runs_in_the_agent_folder_and_merges_stderr(self):
        events = self.run_events(self.shell.start(CONV, self.cwd, "pwd; echo error >&2; exit 3"))
        self.assertEqual(events[0], {"conversation": CONV, "run": events[0]["run"], "started": True,
                                     "command": "pwd; echo error >&2; exit 3", "cwd": self.cwd})
        self.assertEqual(self.output(events), f"{Path(self.cwd).resolve()}\nerror\n")
        end = events[-1]
        self.assertEqual((end["code"], end["truncated"], end["timedOut"]), (3, False, False))
        self.assertEqual(self.shell.running(), [])

    def test_no_terminal_colors_and_no_input(self):
        events = self.run_events(self.shell.start(CONV, self.cwd, "printf '\\033[31mred\\033[0m\\n'; cat; echo end"))
        self.assertEqual(self.output(events), "red\nend\n")

    def test_stop_kills_the_whole_command(self):
        run_id = self.shell.start(CONV, self.cwd, "sleep 30 & sleep 30")
        self.assertEqual(self.shell.running(CONV), [run_id])
        self.assertTrue(self.shell.stop(run_id))
        self.assertNotEqual(self.run_events(run_id)[-1]["code"], 0)
        self.assertFalse(self.shell.stop(run_id))

    def test_timeout_stops_the_command(self):
        shell = ShellRuns(self.bus, timeout=0.3)
        end = self.run_events(shell.start(CONV, self.cwd, "sleep 30"))[-1]
        self.assertTrue(end["timedOut"])

    def test_invalid_requests(self):
        for command in ("", "   ", None, "x" * 20_000):
            with self.assertRaises(ValueError):
                self.shell.start(CONV, self.cwd, command)
        with self.assertRaises(ValueError):
            self.shell.start(CONV, str(Path(self.cwd) / "absent"), "ls")
        shell = ShellRuns(self.bus, max_running=1)
        self.addCleanup(shell.stop_all)
        shell.start(CONV, self.cwd, "sleep 30")
        with self.assertRaises(RuntimeError):
            shell.start(CONV, self.cwd, "ls")


if __name__ == "__main__":
    unittest.main()

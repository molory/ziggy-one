"""Tests of the Terminal tab (fake claude in a real pseudo-terminal): python3 -m unittest discover -s tests"""

import base64
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import server  # noqa: E402
from fakes import FAKE_INTERACTIVE, wait_for  # noqa: E402
from terminal import Terminals, clean_size  # noqa: E402



class TerminalsTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.cwd = tmp.name
        fake = Path(tmp.name) / "claude"
        fake.write_text(FAKE_INTERACTIVE)
        fake.chmod(0o755)
        patcher = mock.patch.dict(os.environ, {"PATH": f"{tmp.name}{os.pathsep}{os.environ['PATH']}", "CLAUDECODE": "1"})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.bus = server.Bus()
        self.events = self.bus.subscribe()
        self.seen = []
        self.terminals = Terminals(self.bus)
        self.addCleanup(self.terminals.stop_all)

    def screen(self):
        """Everything the terminal has shown so far ("terminal" events received)."""
        while not self.events.empty():
            self.seen.append(self.events.get_nowait())
        return b"".join(base64.b64decode(d["data"]) for kind, d in self.seen if kind == "terminal").decode()

    def test_claude_runs_in_a_real_terminal_and_receives_keys(self):
        self.terminals.start("c1", self.cwd, ["--resume", "abc"], 100, 30)
        self.assertTrue(wait_for(lambda: "SIZE 100x30" in self.screen()))
        screen = self.screen()
        self.assertIn("TTY True CTTY True", screen)
        self.assertIn('ARGS ["--resume", "abc"]', screen)
        self.assertIn("ENV None xterm-256color", screen, "the parent Claude Code session is not inherited")
        self.terminals.write("c1", "hello\r")
        self.assertTrue(wait_for(lambda: "GOT hello" in self.screen()))
        self.terminals.resize("c1", 120, 40)
        self.assertTrue(wait_for(lambda: "SIZE 120x40" in self.screen()))
        snapshot = self.terminals.snapshot("c1")
        self.assertTrue(snapshot["running"])
        self.assertIn("GOT hello", base64.b64decode(snapshot["data"]).decode())
        self.assertGreater(snapshot["seq"], 0)

    def test_stop_closes_claude_and_reports_it(self):
        self.terminals.start("c1", self.cwd, [], 80, 24)
        self.assertTrue(wait_for(lambda: "SIZE" in self.screen()))
        self.assertEqual(self.terminals.list(), ["c1"])
        self.assertTrue(self.terminals.stop("c1"))
        self.assertTrue(wait_for(lambda: not self.terminals.running("c1")))
        statuses = [d for kind, d in self.seen + [self.events.get() for _ in range(self.events.qsize())] if kind == "terminal_status"]
        self.assertEqual([s["running"] for s in statuses], [True, False])
        self.assertEqual(self.terminals.snapshot("c1"), {"running": False, "seq": 0, "data": ""})
        with self.assertRaises(RuntimeError):
            self.terminals.write("c1", "x")

    def test_input_and_size_are_validated(self):
        with self.assertRaises(ValueError):
            clean_size("80", 24)
        self.assertEqual(clean_size(5000, 1), (500, 5))
        self.terminals.start("c1", self.cwd, [], 80, 24)
        with self.assertRaises(ValueError):
            self.terminals.write("c1", 12)


class TerminalHttpTest(unittest.TestCase):
    def test_index_gets_a_fresh_style_nonce(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        srv = server.ZiggyServer(0, tmp.name, {}, data_dir=Path(tmp.name) / "data")
        self.addCleanup(srv.server_close)
        handler = server.Handler.__new__(server.Handler)
        sent = []
        handler._send = lambda status, body=b"", content_type=None, headers=None: sent.append((body, headers))
        handler._json = lambda status, obj: sent.append((status, obj))
        handler._static("/")
        handler._static("/")
        (first, first_headers), (second, _) = sent
        nonce = first_headers["Content-Security-Policy"].split("'nonce-")[1].split("'")[0]
        self.assertIn(f'content="{nonce}"'.encode(), first)
        self.assertNotIn(b"__CSP_NONCE__", first)
        self.assertNotEqual(first, second, "one nonce per load")
        self.assertIn("script-src 'self';", first_headers["Content-Security-Policy"], "scripts stay strict")
        self.assertIn("style-src-attr 'unsafe-inline'", first_headers["Content-Security-Policy"], "xterm.js 24-bit colours")

    def test_xterm_source_map_is_served(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        srv = server.ZiggyServer(0, tmp.name, {}, data_dir=Path(tmp.name) / "data")
        self.addCleanup(srv.server_close)
        handler = server.Handler.__new__(server.Handler)
        sent = []
        handler._send = lambda status, body=b"", content_type=None, headers=None: sent.append((status, content_type, body))
        handler._json = lambda status, obj: sent.append((status, None, obj))
        handler._static("/vendor/xterm/xterm.js.map")
        status, content_type, body = sent[0]
        self.assertEqual((status, content_type), (200, "application/json; charset=utf-8"))
        self.assertEqual(len(json.loads(body)["sourcesContent"]), 87, "the original TypeScript code")


if __name__ == "__main__":
    unittest.main()

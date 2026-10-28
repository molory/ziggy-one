"""Tests of the signed-in browsers (sessions)."""

import json
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import browser_sessions  # noqa: E402
from browser_sessions import IDLE_LIFETIME, MAX_SESSIONS, BrowserSessions  # noqa: E402


class BrowserSessionsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "browser-sessions.json"

    def test_session_is_checked_and_kept_across_restarts(self):
        sessions = BrowserSessions(self.path)
        session_id = sessions.create("Firefox", now=1000)
        self.assertEqual(sessions.check(session_id, now=1001), browser_sessions.digest(session_id))
        self.assertIsNone(sessions.check("forged", now=1001))
        self.assertIsNone(sessions.check(None))
        self.assertIsNotNone(BrowserSessions(self.path).check(session_id, now=1002), "kept after a restart")

    def test_file_holds_digests_only(self):
        sessions = BrowserSessions(self.path)
        session_id = sessions.create("Firefox")
        text = self.path.read_text()
        self.assertNotIn(session_id, text)
        self.assertIn(browser_sessions.digest(session_id), json.loads(text))
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

    def test_idle_session_ends(self):
        sessions = BrowserSessions(self.path)
        session_id = sessions.create("Firefox", now=0)
        self.assertIsNotNone(sessions.check(session_id, now=IDLE_LIFETIME - 10), "use extends it")
        self.assertIsNotNone(sessions.check(session_id, now=2 * IDLE_LIFETIME - 20))
        self.assertIsNone(sessions.check(session_id, now=3 * IDLE_LIFETIME))

    def test_sign_out(self):
        sessions = BrowserSessions(self.path)
        now = time.time()
        mine, other = sessions.create("A", now=now - 2), sessions.create("B", now=now - 1)
        me = sessions.check(mine)
        listed = sessions.list(current=me)
        self.assertEqual([b["agent"] for b in listed], ["B", "A"])
        self.assertEqual([b["current"] for b in listed], [False, True])
        other_id = next(b["id"] for b in listed if not b["current"])
        self.assertFalse(sessions.sign_out(other_id, current=me))
        self.assertIsNone(sessions.check(other))
        self.assertTrue(sessions.sign_out(browser_sessions.public_id(me), current=me), "this browser")
        self.assertIsNone(sessions.check(mine))

    def test_sign_out_others_and_all(self):
        sessions = BrowserSessions(self.path)
        mine = sessions.create("A")
        others = [sessions.create("B"), sessions.create("C")]
        me = sessions.check(mine)
        self.assertEqual(sessions.sign_out_others(me), 2)
        self.assertTrue(all(sessions.check(s) is None for s in others))
        self.assertTrue(sessions.alive(me))
        sessions.sign_out_all()
        self.assertFalse(sessions.alive(me))

    def test_oldest_sessions_go_beyond_the_limit(self):
        sessions = BrowserSessions(self.path)
        first = sessions.create("first", now=100)
        for i in range(MAX_SESSIONS):
            sessions.create(str(i), now=200 + i)
        self.assertIsNone(sessions.check(first, now=300))
        self.assertEqual(len(sessions.list(now=300)), MAX_SESSIONS)


if __name__ == "__main__":
    unittest.main()

"""Tests du redémarrage propre du serveur : python3 -m unittest discover -s tests"""

import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import server  # noqa: E402
from fakes import drain, wait_for  # noqa: E402
from restart import PAUSE, RESUME, Restart  # noqa: E402


class FakeTerminals:
    def __init__(self, running):
        self.open = set(running)
        self.typed = []
        self.started = []

    def running(self, cid):
        return cid in self.open

    def list(self):
        return sorted(self.open)

    def write(self, cid, data):
        if cid not in self.open:
            raise RuntimeError("le terminal est fermé")
        if data != "\r":
            self.typed.append((cid, data))


class FakeConversations:
    def __init__(self, busy):
        self.busy = set(busy)

    def list(self):
        return [{"id": cid, "busy": cid in self.busy} for cid in ("a", "b", "c")]

    def get(self, cid):
        return cid if cid in ("a", "b", "c") else None


class FakeServer:
    def __init__(self, busy, running):
        self.bus = server.Bus()
        self.terminals = FakeTerminals(running)
        self.conversations = FakeConversations(busy)
        self.stopped = threading.Event()

    def shutdown(self):
        self.stopped.set()

    def start_terminal(self, conversation, cols, rows):
        self.terminals.open.add(conversation)
        self.terminals.started.append(conversation)


class RestartTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)

    def make(self, busy, running):
        fake = FakeServer(busy, running)
        events = fake.bus.subscribe()
        return fake, Restart(fake, self.dir, poll=0.05, reopen_delay=0), events

    def test_pause_wait_restart_then_reopen_and_resume(self):
        fake, restart, events = self.make(busy={"a"}, running={"a", "b"})
        restart.request()
        self.assertTrue(wait_for(lambda: restart.snapshot()["paused"] == ["a"]))  # b était au repos : pas de message
        self.assertEqual(fake.terminals.typed, [("a", PAUSE)])
        self.assertEqual(restart.snapshot()["phase"], "waiting")
        with self.assertRaises(RuntimeError):
            restart.request()  # déjà demandé
        fake.conversations.busy.clear()  # a s'est arrêté
        self.assertTrue(fake.stopped.wait(3))
        self.assertTrue(restart.requested)
        handoff = json.loads((self.dir / "restart.json").read_text())
        self.assertEqual((handoff["terminals"], handoff["paused"], handoff["forced"]), (["a", "b"], ["a"], False))
        self.assertIn("restarting", [e[1]["state"]["phase"] for e in drain(events) if e[1]["state"]])

        # Le serveur suivant rouvre les terminaux et fait reprendre l'agent mis en pause.
        after = FakeServer(busy=set(), running=set())
        restarted = Restart(after, self.dir, reopen_delay=0)
        restarted.resume_after_restart()
        self.assertEqual(after.terminals.started, ["a", "b"])
        self.assertEqual(after.terminals.typed, [("a", RESUME)])
        self.assertEqual((restarted.last["reopened"], restarted.last["resumed"]), (2, 1))
        self.assertFalse((self.dir / "restart.json").exists())
        self.assertEqual(Restart(after, self.dir).last["reopened"], 2)  # compte rendu gardé
        restarted.resume_after_restart()  # rien à refaire
        self.assertEqual(after.terminals.started, ["a", "b"])

    def test_force_and_cancel(self):
        fake, restart, _ = self.make(busy={"a"}, running={"a"})
        restart.request()
        self.assertTrue(wait_for(lambda: restart.snapshot()["waiting"] == ["a"]))
        restart.cancel()
        self.assertTrue(wait_for(lambda: restart.snapshot() is None))
        self.assertFalse(fake.stopped.is_set())
        self.assertEqual(len(fake.terminals.typed), 2)  # la pause, puis « on ne redémarre pas »
        with self.assertRaises(RuntimeError):
            restart.cancel()
        restart.request()
        restart.force()
        self.assertTrue(fake.stopped.wait(3))  # sans attendre l'agent au travail
        self.assertTrue(json.loads((self.dir / "restart.json").read_text())["forced"])


if __name__ == "__main__":
    unittest.main()

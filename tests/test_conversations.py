"""Tests du registre des agents (conversations.py) : python3 -m unittest discover -s tests"""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import server  # noqa: E402
from conversations import NEW_LABEL, ConversationManager  # noqa: E402
from fakes import drain  # noqa: E402

SESSION = "11111111-2222-4333-8444-555555555555"
OTHER = "22222222-2222-4333-8444-555555555555"


class ConversationsTest(unittest.TestCase):
    def setUp(self):
        self.bus = server.Bus()
        self.events = self.bus.subscribe()
        self.started = []
        self.manager = ConversationManager(self.bus, "/tmp", on_session_started=lambda c, s, previous=None: self.started.append((c, s)))

    def test_open_reuses_the_agent_of_a_session(self):
        fresh = self.manager.open()
        resumed = self.manager.open(resume=SESSION, cwd="/projet")
        self.assertIs(self.manager.open(resume=SESSION), resumed)
        self.assertEqual((fresh.cwd, fresh.label, resumed.cwd), ("/tmp", NEW_LABEL, "/projet"))
        self.assertIs(self.manager.find_by_session(SESSION), resumed)
        self.assertEqual({s["id"] for s in self.manager.list()}, {fresh.id, resumed.id})

    def test_session_and_busy_state_are_published(self):
        agent = self.manager.open()
        drain(self.events)
        agent.adopt_session(SESSION)
        agent.adopt_session(SESSION)  # déjà connue : rien de plus
        self.assertEqual(self.started, [(agent.id, SESSION)])
        self.assertTrue(agent.set_busy(True, prompt="Corrige le bug\nsuite"))
        self.assertFalse(agent.set_busy(True))
        status = agent.status()
        self.assertEqual((status["sessionId"], status["busy"], status["label"]), (SESSION, True, "Corrige le bug"))
        self.assertEqual(agent.prompt, "Corrige le bug\nsuite")
        self.assertTrue(agent.set_busy(False))
        kinds = [kind for kind, _ in drain(self.events)]
        self.assertEqual(kinds, ["status"] * 3)

    def test_session_adopted_only_once_it_has_a_history(self):
        written = set()
        calls = []
        manager = ConversationManager(self.bus, "/tmp", has_history=lambda s: s in written,
                                      on_session_started=lambda c, s, previous=None: calls.append((s, previous)))
        agent = manager.open()
        agent.adopt_session(SESSION)  # Claude Code l'a ouverte, mais rien n'est encore écrit
        self.assertIsNone(agent.session_id)
        written.add(SESSION)
        agent.adopt_session(SESSION)
        written.add(OTHER)
        agent.adopt_session(OTHER)  # /clear : nouvelle session, l'ancienne est indiquée pour que tout suive
        self.assertEqual(calls, [(SESSION, None), (OTHER, SESSION)])

    def test_agents_survive_a_restart_until_removed(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "conversations.json"
            manager = ConversationManager(self.bus, "/tmp", path=path)
            empty = manager.open(cwd="/projet")  # jamais utilisé : il doit rester quand même
            used = manager.open(cwd="/autre")
            used.adopt_session(SESSION)
            used.set_busy(True, prompt="Corrige le bug")
            reloaded = ConversationManager(self.bus, "/tmp", path=path)
            statuses = {s["id"]: s for s in reloaded.list()}
            self.assertEqual(set(statuses), {empty.id, used.id})
            self.assertEqual((statuses[empty.id]["cwd"], statuses[empty.id]["sessionId"]), ("/projet", None))
            self.assertEqual((statuses[used.id]["sessionId"], statuses[used.id]["label"]), (SESSION, "Corrige le bug"))
            self.assertFalse(statuses[used.id]["busy"])  # au repos après le redémarrage
            self.assertEqual(reloaded.find_by_session(SESSION).id, used.id)
            reloaded.remove(empty.id)
            self.assertEqual([s["id"] for s in ConversationManager(self.bus, "/tmp", path=path).list()], [used.id])
            path.write_text("{abîmé")
            self.assertEqual(ConversationManager(self.bus, "/tmp", path=path).list(), [])

    def test_remove_publishes(self):
        agent = self.manager.open()
        drain(self.events)
        self.assertTrue(self.manager.remove(agent.id))
        self.assertFalse(self.manager.remove(agent.id))
        self.assertIsNone(self.manager.get(agent.id))
        self.assertEqual(drain(self.events), [("conversation_removed", {"conversation": agent.id})])


if __name__ == "__main__":
    unittest.main()

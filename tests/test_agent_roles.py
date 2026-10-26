"""Tests des rôles d'agents et de l'annuaire donné au démarrage des sessions : python3 -m unittest discover -s tests"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import server  # noqa: E402
from agents import MAX_ROLE, AgentSettings  # noqa: E402


class AgentRolesTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.srv = server.ZiggyServer(0, tmp.name, {}, data_dir=self.tmp / "data")
        self.addCleanup(self.srv.server_close)

    def agent(self, name, role=None):
        conversation = self.srv.conversations.open(cwd=str(self.tmp), label=name)
        self.srv.agents.rename(conversation.id, name)
        if role is not None:
            self.srv.agents.set_role(conversation.id, role)
        return conversation

    def test_role_is_cleaned_saved_and_cleared(self):
        settings = AgentSettings(server.Bus(), self.tmp / "agents.json")
        settings.set_role("0123456789ab", "  Envoie les\n messages\x1b Teams  " + "x" * 1000)
        role = settings.snapshot()["0123456789ab"]["role"]
        self.assertTrue(role.startswith("Envoie les messages Teams "))
        self.assertEqual(len(role), MAX_ROLE)
        self.assertEqual(AgentSettings(server.Bus(), self.tmp / "agents.json").snapshot(), settings.snapshot(), "relu du disque")
        settings.set_role("0123456789ab", "")
        self.assertNotIn("0123456789ab", settings.snapshot())
        with self.assertRaises(ValueError):
            settings.set_role("pas-une-cle", "x")

    def test_directory_lists_the_other_agents_with_a_role(self):
        me = self.agent("Ziggy Boss")
        self.assertEqual(self.srv.agent_directory(me), "", "personne n'a de rôle : rien d'ajouté")
        self.agent("Teams", "Envoie et lit les messages Teams.")
        self.agent("Jira", "Gère les tickets Jira.")
        self.agent("Sans rôle")
        hidden = self.agent("Supprimé", "Ne doit pas apparaître.")
        self.srv.agents.hide(hidden.id)
        text = self.srv.agent_directory(me)
        self.assertTrue(text.startswith("<ziggy-agents>\nTu es « Ziggy Boss »"), text)
        self.assertIn("SendMessage(to: \"<nom>\")", text)
        self.assertLess(text.index("« Jira »"), text.index("« Teams »"), "rangés par nom")
        self.assertIn("- « Teams » (fermé pour l’instant) : Envoie et lit les messages Teams.", text)
        self.assertNotIn("Sans rôle", text)
        self.assertNotIn("Supprimé", text)

    def test_an_agent_learns_its_own_role_but_is_not_listed_to_itself(self):
        teams = self.agent("Teams", "Envoie les messages Teams.")
        text = self.srv.agent_directory(teams)
        self.assertIn("Ton rôle : Envoie les messages Teams.", text)
        self.assertNotIn("- « Teams »", text)

    def test_terminals_get_a_session_start_hook(self):
        conversation = self.agent("A")
        hooks = json.loads(self.srv._hook_settings(conversation).read_text())["hooks"]
        self.assertIn("ziggy_hook.py", hooks["SessionStart"][0]["hooks"][0]["command"])
        self.assertIn(" session ", hooks["SessionStart"][0]["hooks"][0]["command"])


if __name__ == "__main__":
    unittest.main()

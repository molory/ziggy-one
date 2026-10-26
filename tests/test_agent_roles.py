"""Tests of the agent roles and of the directory given when sessions start: python3 -m unittest discover -s tests"""

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
        settings.set_role("0123456789ab", "  Sends the\n Teams\x1b messages  " + "x" * 1000)
        role = settings.snapshot()["0123456789ab"]["role"]
        self.assertTrue(role.startswith("Sends the Teams messages "))
        self.assertEqual(len(role), MAX_ROLE)
        self.assertEqual(AgentSettings(server.Bus(), self.tmp / "agents.json").snapshot(), settings.snapshot(), "read back from the disk")
        settings.set_role("0123456789ab", "")
        self.assertNotIn("0123456789ab", settings.snapshot())
        with self.assertRaises(ValueError):
            settings.set_role("not-a-key", "x")

    def test_directory_lists_the_other_agents_with_a_role(self):
        me = self.agent("Ziggy Boss")
        self.assertEqual(self.srv.agent_directory(me), "", "nobody has a role: nothing added")
        self.agent("Teams", "Sends and reads the Teams messages.")
        self.agent("Jira", "Handles the Jira tickets.")
        self.agent("No role")
        hidden = self.agent("Deleted", "Must not appear.")
        self.srv.agents.hide(hidden.id)
        text = self.srv.agent_directory(me)
        self.assertTrue(text.startswith("<ziggy-agents>\nYou are \"Ziggy Boss\""), text)
        self.assertIn("SendMessage(to: \"<name>\")", text)
        self.assertLess(text.index("\"Jira\""), text.index("\"Teams\""), "sorted by name")
        self.assertIn("- \"Teams\" (closed for now): Sends and reads the Teams messages.", text)
        self.assertNotIn("No role", text)
        self.assertNotIn("Deleted", text)

    def test_an_agent_learns_its_own_role_but_is_not_listed_to_itself(self):
        teams = self.agent("Teams", "Sends the Teams messages.")
        text = self.srv.agent_directory(teams)
        self.assertIn("Your role: Sends the Teams messages.", text)
        self.assertNotIn("- \"Teams\"", text)

    def test_terminals_get_a_session_start_hook(self):
        conversation = self.agent("A")
        hooks = json.loads(self.srv._hook_settings(conversation).read_text())["hooks"]
        self.assertIn("ziggy_hook.py", hooks["SessionStart"][0]["hooks"][0]["command"])
        self.assertIn(" session ", hooks["SessionStart"][0]["hooks"][0]["command"])


if __name__ == "__main__":
    unittest.main()

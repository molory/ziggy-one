"""First launch: ZiggyBoss and the welcome board: python3 -m unittest discover -s tests"""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import onboarding  # noqa: E402
import server  # noqa: E402


class OnboardingTest(unittest.TestCase):
    def make_server(self, data_dir):
        srv = server.ZiggyServer(0, str(data_dir), {}, data_dir=data_dir)
        self.addCleanup(srv.server_close)
        return srv

    def test_first_launch_creates_ziggy_boss_and_the_welcome_board_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp) / "data"
            srv = self.make_server(data_dir)
            srv.onboarding.run(srv, tmp)
            [boss] = srv.conversations.list()
            self.assertEqual((boss["label"], boss["cwd"]), ("ZiggyBoss", tmp))
            self.assertEqual(srv.agents.name_for([boss["id"]]), "ZiggyBoss")
            self.assertIn(boss["id"], srv.pins.list())
            self.assertEqual([key for key, _, _ in srv.agents.roles()], [boss["id"]])
            [board] = srv.kanban.list()
            self.assertEqual(board["name"], "Board")
            [ticket] = srv.kanban.get(board["id"])["tickets"]
            self.assertEqual((ticket["title"], ticket["column"]), ("WELCOME/ Onboarding todo", board["columns"][0]["id"]))
            self.assertIn("- [ ] ", ticket["description"])

            # Opening ZiggyBoss: Claude Code starts with its introduction as first message; the loading screen
            # ("introducing") lasts until the end of that first turn, and the introduction is not sent again.
            conversation = srv.conversations.get(boss["id"])
            self.assertEqual((boss["intro"], boss["introducing"]), (True, False))
            started = []
            srv.terminals.start = lambda conversation, cwd, args, cols, rows: started.append(args)
            srv.start_terminal(conversation, 80, 24)
            self.assertIn(onboarding.BOSS_INTRO, started[0])
            self.assertEqual((conversation.status()["intro"], conversation.status()["introducing"]), (False, True))
            conversation.set_busy(False)  # idle before the prompt arrives: still introducing
            self.assertTrue(conversation.introducing)
            conversation.set_busy(True, prompt=onboarding.BOSS_INTRO)
            conversation.set_busy(False)  # end of the first turn
            self.assertFalse(conversation.introducing)
            srv.start_terminal(conversation, 80, 24)
            self.assertNotIn(onboarding.BOSS_INTRO, started[1])

            # Next starts: nothing more while an agent exists, even with an empty Kanban.
            srv.server_close()
            again = self.make_server(data_dir)
            self.assertEqual(again.conversations.get(boss["id"]).intro, "")
            again.kanban.delete_board(board["id"])
            again.onboarding.run(again, tmp)
            self.assertEqual((len(again.conversations.list()), again.kanban.list()), (1, []))

    def test_ziggy_boss_comes_back_when_no_agent_is_left(self):
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp) / "data"
            srv = self.make_server(data_dir)
            srv.onboarding.run(srv, tmp)
            [boss] = srv.conversations.list()
            srv.conversations.remove(boss["id"])
            srv.server_close()
            again = self.make_server(data_dir)
            again.onboarding.run(again, tmp)
            [new_boss] = again.conversations.list()
            self.assertEqual((new_boss["label"], new_boss["cwd"]), ("ZiggyBoss", tmp))
            self.assertIn(new_boss["id"], again.pins.list())
            self.assertEqual(len(again.kanban.list()), 1)  # the welcome board is not created twice

    def test_closing_the_terminal_ends_the_introduction(self):
        with tempfile.TemporaryDirectory() as tmp:
            srv = self.make_server(Path(tmp) / "data")
            srv.onboarding.run(srv, tmp)
            [boss] = srv.conversations.list()
            conversation = srv.conversations.get(boss["id"])
            srv.terminals.start = lambda *args: None
            srv.start_terminal(conversation, 80, 24)
            self.assertTrue(conversation.introducing)
            srv._terminal_closed(conversation.id)
            self.assertFalse(conversation.introducing)

    def test_existing_install_keeps_its_agents_and_only_gets_the_board_when_its_kanban_is_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp) / "data"
            srv = self.make_server(data_dir)
            mine = srv.conversations.open(cwd=tmp)
            srv.onboarding.run(srv, tmp)
            self.assertEqual([c["id"] for c in srv.conversations.list()], [mine.id])
            self.assertEqual([b["name"] for b in srv.kanban.list()], ["Board"])


if __name__ == "__main__":
    unittest.main()

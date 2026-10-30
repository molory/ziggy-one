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

            # Opening ZiggyBoss: Claude Code starts with its introduction as first message.
            started = []
            srv.terminals.start = lambda conversation, cwd, args, cols, rows: started.append(args)
            srv.start_terminal(srv.conversations.get(boss["id"]), 80, 24)
            self.assertIn(onboarding.BOSS_INTRO, started[0])

            # Next starts: nothing more, even after deleting everything; the introduction is kept until used.
            srv.server_close()
            again = self.make_server(data_dir)
            self.assertEqual(again.conversations.get(boss["id"]).intro, onboarding.BOSS_INTRO)
            again.kanban.delete_board(board["id"])
            again.onboarding.run(again, tmp)
            self.assertEqual((len(again.conversations.list()), again.kanban.list()), (1, []))

    def test_existing_install_only_gets_the_board_when_its_kanban_is_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp) / "data"
            data_dir.mkdir()
            (data_dir / "agents.json").write_text("{}")
            srv = self.make_server(data_dir)
            srv.onboarding.run(srv, tmp)
            self.assertEqual(srv.conversations.list(), [])
            self.assertEqual([b["name"] for b in srv.kanban.list()], ["Board"])


if __name__ == "__main__":
    unittest.main()

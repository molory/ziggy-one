"""Tests of the agents' MCP tools (Kanban): python3 -m unittest discover -s tests"""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import agent_mcp  # noqa: E402
import server  # noqa: E402
import ticket_links  # noqa: E402
from kanban import Kanban  # noqa: E402

TOKEN = "server-token"


class AgentMcpTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.kanban = Kanban(server.Bus(), Path(tmp.name) / "kanbans.json", Path(tmp.name) / "files")
        self.board = self.kanban.create_board("Atlas")
        self.tools = agent_mcp.KanbanTools(self.kanban, render=lambda n: ticket_links.render(
            self.kanban.export(n), TOKEN, "http://127.0.0.1:1"))

    def call(self, name, arguments=None, actor="Teams/Outlook"):
        response = agent_mcp.dispatch({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                       "params": {"name": name, "arguments": arguments or {}}}, self.tools, actor)
        result = response["result"]
        return result["content"][0]["text"], result["isError"]

    def test_keys_identify_the_agent(self):
        key = agent_mcp.agent_key(TOKEN, "abcdef123456")
        self.assertEqual(agent_mcp.check_key(TOKEN, key), "abcdef123456")
        for bad in (None, "", "abcdef123456", "abcdef123456.fake", key + "0", agent_mcp.agent_key("other", "abcdef123456")):
            self.assertIsNone(agent_mcp.check_key(TOKEN, bad))

    def test_protocol(self):
        init = agent_mcp.dispatch({"jsonrpc": "2.0", "id": 0, "method": "initialize",
                                   "params": {"protocolVersion": "2025-06-18"}}, self.tools, "x")
        self.assertEqual(init["result"]["serverInfo"]["name"], "ziggy")
        self.assertIn("tools", init["result"]["capabilities"])
        self.assertIsNone(agent_mcp.dispatch({"jsonrpc": "2.0", "method": "notifications/initialized"}, self.tools, "x"))
        names = [t["name"] for t in agent_mcp.dispatch({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, self.tools, "x")["result"]["tools"]]
        self.assertEqual(names, ["kanban_boards", "kanban_list_tickets", "kanban_get_ticket",
                                 "kanban_create_ticket", "kanban_update_ticket", "kanban_move_ticket"])
        self.assertFalse(any("delete" in name for name in names), "no deletion for agents")
        unknown = agent_mcp.dispatch({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "kanban_delete"}}, self.tools, "x")
        self.assertEqual(unknown["error"]["code"], agent_mcp.INVALID_PARAMS)
        self.assertEqual(agent_mcp.dispatch({"id": 4}, self.tools, "x")["error"]["code"], agent_mcp.INVALID_REQUEST)

    def test_agent_creates_updates_and_moves_a_ticket(self):
        text, error = self.call("kanban_create_ticket", {"column": "to do", "title": "Send the report", "description": "On Teams"})
        self.assertFalse(error)
        number = int(text.split("#")[1].split()[0])
        self.assertIn(f"#{number} [To do] Send the report", self.call("kanban_list_tickets", {"board": "atlas"})[0])
        self.assertFalse(self.call("kanban_update_ticket", {"number": f"#{number}", "append": "Sent at 2 pm."})[1])
        self.assertFalse(self.call("kanban_move_ticket", {"number": number, "column": "Done"})[1])
        ticket, _ = self.call("kanban_get_ticket", {"number": number})
        self.assertIn("- Column: Done", ticket)
        self.assertIn("On Teams\n\nSent at 2 pm.", ticket)
        self.assertIn("(by Teams/Outlook)", ticket)  # the history tells which agent acted
        authors = {entry["by"] for entry in self.kanban.ticket_history(self.kanban.find_number(number)["ticket"])}
        self.assertEqual(authors, {"Teams/Outlook"})
        self.assertIn("Done (1)", self.call("kanban_boards")[0])
        self.assertIn("No ticket", self.call("kanban_list_tickets", {"query": "nowhere"})[0])


    def test_agents_set_and_read_the_delivery_date(self):
        ticket = self.kanban.create_ticket(self.board["id"], self.board["columns"][0]["id"], "Ship it")
        number = ticket["number"]
        self.assertEqual(self.call("kanban_update_ticket", {"number": number, "due": "2026-11-20"}), (f"Ticket #{number} updated.", False))
        self.assertIn("- Delivery date: 2026-11-20", self.call("kanban_get_ticket", {"number": number})[0])
        self.assertIn(f"#{number} [To do] Ship it (due 2026-11-20)", self.call("kanban_list_tickets", {"board": "Atlas"})[0])
        text, error = self.call("kanban_update_ticket", {"number": number, "due": "next week"})
        self.assertTrue(error)
        self.assertIn("Invalid delivery date", text)
        self.call("kanban_update_ticket", {"number": number, "due": ""})
        self.assertNotIn("Delivery date", self.call("kanban_get_ticket", {"number": number})[0].split("## History")[0])
    def test_clear_errors_for_the_agent(self):
        self.kanban.create_board("Ziggy")
        for name, arguments, expected in (
            ("kanban_list_tickets", {}, "Specify the board"),
            ("kanban_list_tickets", {"board": "Unknown"}, "Boards: Atlas, Ziggy"),
            ("kanban_create_ticket", {"board": "Atlas", "column": "Later", "title": "x"}, "Columns: To do"),
            ("kanban_create_ticket", {"board": "Atlas", "title": "  "}, "Empty title"),
            ("kanban_get_ticket", {"number": "#999"}, "#999 not found"),
            ("kanban_get_ticket", {"number": True}, "Invalid ticket number"),
            ("kanban_update_ticket", {"number": "abc"}, "Invalid ticket number"),
        ):
            text, error = self.call(name, arguments)
            self.assertTrue(error, name)
            self.assertIn(expected, text, name)


if __name__ == "__main__":
    unittest.main()

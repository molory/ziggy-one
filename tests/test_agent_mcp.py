"""Tests des outils MCP des agents (Kanban) : python3 -m unittest discover -s tests"""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import agent_mcp  # noqa: E402
import server  # noqa: E402
import ticket_links  # noqa: E402
from kanban import Kanban  # noqa: E402

TOKEN = "token-du-serveur"


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
        for bad in (None, "", "abcdef123456", "abcdef123456.faux", key + "0", agent_mcp.agent_key("autre", "abcdef123456")):
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
        self.assertFalse(any("delete" in name for name in names), "pas de suppression pour les agents")
        unknown = agent_mcp.dispatch({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "kanban_delete"}}, self.tools, "x")
        self.assertEqual(unknown["error"]["code"], agent_mcp.INVALID_PARAMS)
        self.assertEqual(agent_mcp.dispatch({"id": 4}, self.tools, "x")["error"]["code"], agent_mcp.INVALID_REQUEST)

    def test_agent_creates_updates_and_moves_a_ticket(self):
        text, error = self.call("kanban_create_ticket", {"column": "à faire", "title": "Envoyer le compte rendu", "description": "Sur Teams"})
        self.assertFalse(error)
        number = int(text.split("#")[1].split()[0])
        self.assertIn(f"#{number} [À faire] Envoyer le compte rendu", self.call("kanban_list_tickets", {"board": "atlas"})[0])
        self.assertFalse(self.call("kanban_update_ticket", {"number": f"#{number}", "append": "Envoyé à 14 h."})[1])
        self.assertFalse(self.call("kanban_move_ticket", {"number": number, "column": "Fait"})[1])
        ticket, _ = self.call("kanban_get_ticket", {"number": number})
        self.assertIn("- Colonne : Fait", ticket)
        self.assertIn("Sur Teams\n\nEnvoyé à 14 h.", ticket)
        self.assertIn("(par Teams/Outlook)", ticket)  # l'historique dit quel agent a agi
        authors = {entry["by"] for entry in self.kanban.ticket_history(self.kanban.find_number(number)["ticket"])}
        self.assertEqual(authors, {"Teams/Outlook"})
        self.assertIn("Fait (1)", self.call("kanban_boards")[0])
        self.assertIn("Aucun ticket", self.call("kanban_list_tickets", {"query": "introuvable"})[0])

    def test_clear_errors_for_the_agent(self):
        self.kanban.create_board("Ziggy")
        for name, arguments, expected in (
            ("kanban_list_tickets", {}, "Précise le tableau"),
            ("kanban_list_tickets", {"board": "Inconnu"}, "Tableaux : Atlas, Ziggy"),
            ("kanban_create_ticket", {"board": "Atlas", "column": "Plus tard", "title": "x"}, "Colonnes : À faire"),
            ("kanban_create_ticket", {"board": "Atlas", "title": "  "}, "titre"),
            ("kanban_get_ticket", {"number": "#999"}, "#999 introuvable"),
            ("kanban_get_ticket", {"number": True}, "Numéro de ticket invalide"),
            ("kanban_update_ticket", {"number": "abc"}, "Numéro de ticket invalide"),
        ):
            text, error = self.call(name, arguments)
            self.assertTrue(error, name)
            self.assertIn(expected, text, name)


if __name__ == "__main__":
    unittest.main()

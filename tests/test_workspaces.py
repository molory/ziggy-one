"""Tests des workspaces (groupes d'agents) : python3 -m unittest discover -s tests"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import server  # noqa: E402
from fakes import drain  # noqa: E402
from workspaces import MAX_NAME, Workspaces  # noqa: E402

A = "11111111-2222-4333-8444-555555555555"
B = "22222222-2222-4333-8444-555555555555"


class WorkspacesTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = Path(tmp.name) / "sous-dossier" / "workspaces.json"
        self.bus = server.Bus()
        self.events = self.bus.subscribe()
        self.workspaces = Workspaces(self.bus, self.path)

    def test_create_validates_and_normalizes_the_name(self):
        for bad in ("", "   ", None, 12):
            with self.assertRaises(ValueError):
                self.workspaces.create(bad)
        item = self.workspaces.create("  Mes   connecteurs ")
        self.assertEqual(item["name"], "Mes connecteurs")
        self.assertEqual(len(self.workspaces.create("x" * 500)["name"]), MAX_NAME)

    def test_share_activity_is_on_by_default_and_can_be_turned_off(self):
        item = self.workspaces.create("Ziggy")
        self.workspaces.add_agent(item["id"], A)
        self.assertTrue(self.workspaces.workspace_for([B, A])["shareActivity"])
        self.assertIsNone(self.workspaces.workspace_for([B]))
        with self.assertRaises(ValueError):
            self.workspaces.update(item["id"], {"shareActivity": "non"})
        self.workspaces.update(item["id"], {"shareActivity": False})
        self.assertFalse(Workspaces(self.bus, self.path).workspace_for([A])["shareActivity"])

    def test_changes_are_saved_privately_and_published(self):
        item = self.workspaces.create("Connecteurs")
        self.workspaces.add_agent(item["id"], A)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.path.parent.stat().st_mode & 0o777, 0o700)
        reloaded = Workspaces(server.Bus(), self.path).list()
        self.assertEqual([(w["name"], w["agents"]) for w in reloaded], [("Connecteurs", [A])])
        kinds = [kind for kind, _ in drain(self.events)]
        self.assertEqual(kinds, ["workspaces", "workspaces"])

    def test_an_agent_belongs_to_one_workspace_at_a_time(self):
        first, second = self.workspaces.create("Un"), self.workspaces.create("Deux")
        self.workspaces.add_agent(first["id"], A)
        self.workspaces.add_agent(first["id"], A)  # pas de doublon
        self.workspaces.add_agent(second["id"], A)  # déplacé
        agents = {w["name"]: w["agents"] for w in self.workspaces.list()}
        self.assertEqual(agents, {"Un": [], "Deux": [A]})

    def test_remove_delete_and_unknown_workspace(self):
        item = self.workspaces.create("Un")
        self.workspaces.add_agent(item["id"], A)
        self.assertTrue(self.workspaces.remove_agent(item["id"], A))
        self.assertEqual(self.workspaces.list()[0]["agents"], [])
        self.assertFalse(self.workspaces.add_agent("000000000000", A))
        self.assertTrue(self.workspaces.delete(item["id"]))
        self.assertFalse(self.workspaces.delete(item["id"]))

    def test_rename_and_color(self):
        item = self.workspaces.create("Un")
        self.assertIsNone(item["hue"])  # couleur automatique
        self.assertTrue(self.workspaces.update(item["id"], {"name": "  Connecteurs  ", "hue": 215}))
        self.assertEqual({k: self.workspaces.list()[0][k] for k in ("name", "hue")}, {"name": "Connecteurs", "hue": 215})
        self.workspaces.update(item["id"], {"hue": None})  # retour à l'automatique, nom inchangé
        self.assertEqual({k: self.workspaces.list()[0][k] for k in ("name", "hue")}, {"name": "Connecteurs", "hue": None})
        for bad in ({"hue": 360}, {"hue": -1}, {"hue": "rouge"}, {"hue": True}, {"name": " "}):
            with self.assertRaises(ValueError):
                self.workspaces.update(item["id"], bad)
        self.assertFalse(self.workspaces.update("000000000000", {"name": "x"}))
        self.assertEqual(Workspaces(server.Bus(), self.path).list()[0]["name"], "Connecteurs")  # enregistré

    def test_invalid_agent_keys_are_rejected(self):
        item = self.workspaces.create("Un")
        for bad in ("../../etc", "*", "", None, "ABCDEF123456"):
            with self.assertRaises(ValueError):
                self.workspaces.add_agent(item["id"], bad)

    def test_conversation_key_is_replaced_by_its_session(self):
        item = self.workspaces.create("Un")
        self.workspaces.add_agent(item["id"], "abcdef123456")  # discussion pas encore démarrée
        self.workspaces.replace_agent_key("abcdef123456", B)
        self.assertEqual(self.workspaces.list()[0]["agents"], [B])
        self.workspaces.replace_agent_key("inconnu", A)  # rien à remplacer : aucun changement
        self.assertEqual(self.workspaces.agent_keys(), [B])

    def test_damaged_file_gives_an_empty_list(self):
        self.path.parent.mkdir(parents=True)
        for content in ("{", "[1, 2]", json.dumps([{"id": "pas-un-id", "name": "x"}])):
            self.path.write_text(content)
            self.assertEqual(Workspaces(server.Bus(), self.path).list(), [])
        self.path.write_text(json.dumps([{"id": "abcdef123456", "name": "Ok", "agents": [A, "../x"]}]))
        self.assertEqual(Workspaces(server.Bus(), self.path).list()[0]["agents"], [A])


if __name__ == "__main__":
    unittest.main()

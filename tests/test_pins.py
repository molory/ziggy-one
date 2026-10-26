"""Tests des épingles enregistrées côté serveur : python3 -m unittest discover -s tests"""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import server  # noqa: E402
from fakes import drain  # noqa: E402
from pins import Pins  # noqa: E402

A = "11111111-2222-4333-8444-555555555555"
B = "22222222-2222-4333-8444-555555555555"
WORKSPACE = "workspace:0123456789ab"


class PinsTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = Path(tmp.name) / "pins.json"
        self.bus = server.Bus()
        self.events = self.bus.subscribe()
        self.pins = Pins(self.bus, self.path)

    def test_kept_in_order_and_reloaded(self):
        self.assertEqual(self.pins.set([B, WORKSPACE, A, B, "../x", "workspace:nope", 12]), [B, WORKSPACE, A])
        self.assertEqual(drain(self.events), [("pins", [B, WORKSPACE, A])])
        self.pins.set([B, WORKSPACE, A])
        self.assertEqual(drain(self.events), [])  # rien de changé : ni écriture ni événement
        self.assertEqual(Pins(self.bus, self.path).list(), [B, WORKSPACE, A])  # survit au redémarrage
        self.assertEqual(self.pins.agent_keys(), [B, A])
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

    def test_follows_a_conversation_once_it_has_a_session(self):
        self.pins.set(["abcdef123456", B])
        self.pins.replace_key("abcdef123456", A)
        self.assertEqual(self.pins.list(), [A, B])
        self.pins.replace_key(A, B)  # déjà épinglé sous l'autre identifiant : une seule épingle
        self.assertEqual(self.pins.list(), [B])

    def test_invalid_input(self):
        with self.assertRaises(ValueError):
            self.pins.set("pas une liste")
        self.path.write_text("{abîmé")
        self.assertEqual(Pins(self.bus, self.path).list(), [])


if __name__ == "__main__":
    unittest.main()

"""Tests des réglages d'agent (nom, suppression) : python3 -m unittest discover -s tests"""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import server  # noqa: E402
from agents import MAX_NAME, AgentSettings  # noqa: E402
from fakes import drain  # noqa: E402

A = "11111111-2222-4333-8444-555555555555"
B = "22222222-2222-4333-8444-555555555555"


class AgentSettingsTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = Path(tmp.name) / "agents.json"
        self.bus = server.Bus()
        self.events = self.bus.subscribe()
        self.settings = AgentSettings(self.bus, self.path)

    def test_rename_and_reset(self):
        self.settings.rename(A, "  Revue   MR 59 ")
        self.assertEqual(self.settings.snapshot(), {A: {"name": "Revue MR 59"}})
        self.settings.rename(A, "x" * 300)
        self.assertEqual(len(self.settings.snapshot()[A]["name"]), MAX_NAME)
        self.settings.rename(A, "")  # nom d'origine
        self.assertEqual(self.settings.snapshot(), {})
        self.assertEqual([kind for kind, _ in drain(self.events)], ["agents"] * 3)

    def test_hide_keeps_what_is_needed_to_restore(self):
        self.settings.rename(A, "Mon agent")
        self.settings.hide(A, "Corrige le connecteur", "/home/x/atlas")
        hidden = self.settings.snapshot()[A]
        self.assertEqual(hidden["name"], "Mon agent")
        self.assertEqual((hidden["hidden"]["label"], hidden["hidden"]["cwd"]), ("Corrige le connecteur", "/home/x/atlas"))
        self.assertTrue(self.settings.restore(A))
        self.assertFalse(self.settings.restore(A))
        self.assertEqual(self.settings.snapshot(), {A: {"name": "Mon agent"}})

    def test_saved_privately_and_reloaded(self):
        self.settings.rename(A, "Un")
        self.settings.hide(B, "Deux", "/d")
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(AgentSettings(server.Bus(), self.path).snapshot(), self.settings.snapshot())

    def test_claude_options(self):
        self.settings.set_options(A, {"model": "haiku", "permissionMode": "plan", "chrome": True})
        self.assertEqual(self.settings.options_for([None, "inconnu", A]), {"model": "haiku", "permissionMode": "plan", "chrome": True})
        self.settings.set_options(A, {"model": "", "permissionMode": None, "chrome": None})  # tout par défaut
        self.assertEqual(self.settings.options_for([A]), {})
        self.assertNotIn(A, self.settings.snapshot())
        for bad in ({"model": "gpt"}, {"permissionMode": "bypassPermissions"}, {"chrome": "oui"}, "texte"):
            with self.assertRaises(ValueError):
                self.settings.set_options(A, bad)
        self.settings.set_options(B, {"model": "opus"})
        self.assertEqual(AgentSettings(server.Bus(), self.path).options_for([B]), {"model": "opus"})  # enregistré

    def test_avatar_letters_and_animal(self):
        self.settings.set_avatar(A, {"abbr": "LA", "kind": "letters"})
        self.assertEqual(self.settings.snapshot()[A], {"avatar": {"abbr": "LA"}})
        self.settings.set_avatar(A, {"abbr": "🧑‍💻", "kind": "animal", "animal": "Loutre"})  # emoji composé (ZWJ)
        self.assertEqual(self.settings.snapshot()[A]["avatar"], {"abbr": "🧑‍💻", "kind": "animal", "animal": "Loutre"})
        self.settings.set_avatar(A, {})  # avatar par défaut
        self.assertNotIn(A, self.settings.snapshot())
        for bad in ({"abbr": "a b"}, {"abbr": "x" * 17}, {"abbr": "\x07"}, {"kind": "video"},
                    {"kind": "animal", "animal": "Licorne"}, {"kind": "animal"}, {"kind": "image"}, "texte"):
            with self.assertRaises(ValueError, msg=bad):
                self.settings.set_avatar(A, bad)

    def test_avatar_image_is_kept_privately_and_replaced(self):
        png = b"\x89PNG\r\n\x1a\n" + b"0" * 100
        webp = b"RIFF\x00\x00\x00\x00WEBPVP8 " + b"0" * 100
        self.settings.set_avatar(A, {"kind": "image", "abbr": "L"}, png)
        first = self.settings.snapshot()[A]["avatar"]["image"]
        self.assertEqual(self.settings.avatar_image(first), (png, "image/png"))
        stored = self.path.parent / "avatars" / first
        self.assertEqual(stored.stat().st_mode & 0o777, 0o600)
        self.settings.set_avatar(A, {"kind": "image", "abbr": "M"})  # sans nouvelle image : gardée
        self.assertEqual(self.settings.snapshot()[A]["avatar"], {"abbr": "M", "kind": "image", "image": first})
        self.settings.set_avatar(A, {"kind": "image"}, webp)
        second = self.settings.snapshot()[A]["avatar"]["image"]
        self.assertNotEqual(second, first)
        self.assertFalse(stored.exists(), "l'ancienne image est supprimée")
        self.assertEqual(AgentSettings(server.Bus(), self.path).snapshot(), self.settings.snapshot())  # relu
        self.settings.set_avatar(A, {"kind": "animal", "animal": "Renard"})  # un autre type retire l'image
        self.assertIsNone(self.settings.avatar_image(second))
        for bad in (b"<svg onload=alert(1)>", b"\x89PNG\r\n\x1a\n" + b"0" * 300_000):
            with self.assertRaises(ValueError):
                self.settings.set_avatar(A, {"kind": "image"}, bad)
        with self.assertRaises(ValueError):
            self.settings.set_avatar(A, {"kind": "letters"}, png)  # une image sans le type « image »
        self.assertIsNone(self.settings.avatar_image("../agents.json"))

    def test_damaged_avatar_in_file_falls_back(self):
        self.path.write_text('{"%s": {"name": "a", "avatar": {"abbr": "a b", "kind": "image", "image": "../x"}}}' % A)
        self.assertEqual(AgentSettings(server.Bus(), self.path).snapshot(), {A: {"name": "a"}})

    def test_invalid_input(self):
        for bad_key in ("../x", "", None, "*"):
            with self.assertRaises(ValueError):
                self.settings.rename(bad_key, "x")
            with self.assertRaises(ValueError):
                self.settings.hide(bad_key)
        with self.assertRaises(ValueError):
            self.settings.rename(A, 12)

    def test_settings_follow_a_conversation_once_it_has_a_session(self):
        self.settings.rename("abcdef123456", "Nouveau")
        self.settings.replace_key("abcdef123456", A)
        self.assertEqual(self.settings.snapshot(), {A: {"name": "Nouveau"}})

    def test_generated_names_are_unique_and_kept(self):
        conversation = "abcdef123456"
        self.settings.rename(B, "Loutre agile")
        drain(self.events)
        self.settings.ensure_names([[A], [B], [None, conversation], ["pas-un-id"]])
        snapshot = self.settings.snapshot()
        self.assertNotIn("generated", snapshot[B])  # déjà nommé
        names = [snapshot[A]["generated"], snapshot[conversation]["generated"]]
        self.assertEqual(len({*names, "Loutre agile"}), 3)  # tous différents
        self.assertTrue(all(len(name.split()) == 2 for name in names))
        self.assertEqual([kind for kind, _ in drain(self.events)], ["agents"])  # une seule écriture
        self.settings.ensure_names([[A]])
        self.assertEqual(self.settings.snapshot()[A]["generated"], names[0])  # stable
        self.assertEqual(self.settings.name_for([A]), names[0])
        self.settings.rename(A, "Revue")
        self.assertEqual(self.settings.name_for([A]), "Revue")  # le nom donné prime
        # La discussion démarre : sa session garde le nom déjà affiché, même si elle en a reçu un entre-temps.
        self.settings.ensure_names([["33333333-2222-4333-8444-555555555555"]])
        self.settings.replace_key(conversation, "33333333-2222-4333-8444-555555555555")
        self.assertEqual(self.settings.snapshot()["33333333-2222-4333-8444-555555555555"]["generated"], names[1])
        self.assertEqual(AgentSettings(self.bus, self.path).snapshot(), self.settings.snapshot())  # relu du fichier

    def test_generate_name_avoids_taken_names(self):
        from names import ADJECTIVES, ANIMALS, generate_name
        everything = [f"{animal} {adjective}" for animal in ANIMALS for adjective in ADJECTIVES]
        self.assertEqual(generate_name(everything[1:]), everything[0])
        self.assertRegex(generate_name(everything), r"^\S+ \S+ 2$")  # tout est pris : numéroté

    def test_damaged_file_gives_no_settings(self):
        for content in ("{", "[1]", '{"../x": {"name": "a"}, "%s": "pas un objet"}' % A):
            self.path.write_text(content)
            self.assertEqual(AgentSettings(server.Bus(), self.path).snapshot(), {})


if __name__ == "__main__":
    unittest.main()

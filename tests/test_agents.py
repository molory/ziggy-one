"""Tests of the agent settings (name, deletion): python3 -m unittest discover -s tests"""

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
        self.settings.rename(A, "  Review   MR 59 ")
        self.assertEqual(self.settings.snapshot(), {A: {"name": "Review MR 59"}})
        self.settings.rename(A, "x" * 300)
        self.assertEqual(len(self.settings.snapshot()[A]["name"]), MAX_NAME)
        self.settings.rename(A, "")  # original name
        self.assertEqual(self.settings.snapshot(), {})
        self.assertEqual([kind for kind, _ in drain(self.events)], ["agents"] * 3)

    def test_hide_keeps_what_is_needed_to_restore(self):
        self.settings.rename(A, "My agent")
        self.settings.hide(A, "Fix the connector", "/home/x/atlas")
        hidden = self.settings.snapshot()[A]
        self.assertEqual(hidden["name"], "My agent")
        self.assertEqual((hidden["hidden"]["label"], hidden["hidden"]["cwd"]), ("Fix the connector", "/home/x/atlas"))
        self.assertTrue(self.settings.restore(A))
        self.assertFalse(self.settings.restore(A))
        self.assertEqual(self.settings.snapshot(), {A: {"name": "My agent"}})

    def test_saved_privately_and_reloaded(self):
        self.settings.rename(A, "One")
        self.settings.hide(B, "Two", "/d")
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(AgentSettings(server.Bus(), self.path).snapshot(), self.settings.snapshot())

    def test_claude_options(self):
        self.settings.set_options(A, {"model": "haiku", "permissionMode": "plan", "chrome": True})
        self.assertEqual(self.settings.options_for([None, "unknown", A]), {"model": "haiku", "permissionMode": "plan", "chrome": True})
        self.settings.set_options(A, {"model": "", "permissionMode": None, "chrome": None})  # all defaults
        self.assertEqual(self.settings.options_for([A]), {})
        self.assertNotIn(A, self.settings.snapshot())
        for bad in ({"model": "gpt"}, {"permissionMode": "bypassPermissions"}, {"chrome": "yes"}, "text"):
            with self.assertRaises(ValueError):
                self.settings.set_options(A, bad)
        self.settings.set_options(B, {"model": "opus"})
        self.assertEqual(AgentSettings(server.Bus(), self.path).options_for([B]), {"model": "opus"})  # saved

    def test_avatar_letters_and_animal(self):
        self.settings.set_avatar(A, {"abbr": "LA", "kind": "letters"})
        self.assertEqual(self.settings.snapshot()[A], {"avatar": {"abbr": "LA"}})
        self.settings.set_avatar(A, {"abbr": "🧑‍💻", "kind": "animal", "animal": "Otter"})  # composed emoji (ZWJ)
        self.assertEqual(self.settings.snapshot()[A]["avatar"], {"abbr": "🧑‍💻", "kind": "animal", "animal": "Otter"})
        self.settings.set_avatar(A, {"kind": "animal", "animal": "Loutre"})  # older French name: its English name
        self.assertEqual(self.settings.snapshot()[A]["avatar"], {"kind": "animal", "animal": "Otter"})
        self.settings.set_avatar(A, {})  # default avatar
        self.assertNotIn(A, self.settings.snapshot())
        for bad in ({"abbr": "a b"}, {"abbr": "x" * 17}, {"abbr": "\x07"}, {"kind": "video"},
                    {"kind": "animal", "animal": "Unicorn"}, {"kind": "animal"}, {"kind": "image"}, "text"):
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
        self.settings.set_avatar(A, {"kind": "image", "abbr": "M"})  # without a new image: kept
        self.assertEqual(self.settings.snapshot()[A]["avatar"], {"abbr": "M", "kind": "image", "image": first})
        self.settings.set_avatar(A, {"kind": "image"}, webp)
        second = self.settings.snapshot()[A]["avatar"]["image"]
        self.assertNotEqual(second, first)
        self.assertFalse(stored.exists(), "the old image is deleted")
        self.assertEqual(AgentSettings(server.Bus(), self.path).snapshot(), self.settings.snapshot())  # read back
        self.settings.set_avatar(A, {"kind": "animal", "animal": "Fox"})  # another type removes the image
        self.assertIsNone(self.settings.avatar_image(second))
        for bad in (b"<svg onload=alert(1)>", b"\x89PNG\r\n\x1a\n" + b"0" * 300_000):
            with self.assertRaises(ValueError):
                self.settings.set_avatar(A, {"kind": "image"}, bad)
        with self.assertRaises(ValueError):
            self.settings.set_avatar(A, {"kind": "letters"}, png)  # an image without the "image" type
        self.assertIsNone(self.settings.avatar_image("../agents.json"))

    def test_older_french_animal_in_file_is_kept(self):
        self.path.write_text('{"%s": {"avatar": {"kind": "animal", "animal": "Loutre"}}}' % A)
        self.assertEqual(AgentSettings(server.Bus(), self.path).snapshot(), {A: {"avatar": {"kind": "animal", "animal": "Otter"}}})

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
        self.settings.rename("abcdef123456", "New")
        self.settings.replace_key("abcdef123456", A)
        self.assertEqual(self.settings.snapshot(), {A: {"name": "New"}})

    def test_generated_names_are_unique_and_kept(self):
        conversation = "abcdef123456"
        self.settings.rename(B, "Agile Otter")
        drain(self.events)
        self.settings.ensure_names([[A], [B], [None, conversation], ["not-an-id"]])
        snapshot = self.settings.snapshot()
        self.assertNotIn("generated", snapshot[B])  # already named
        names = [snapshot[A]["generated"], snapshot[conversation]["generated"]]
        self.assertEqual(len({*names, "Agile Otter"}), 3)  # all different
        self.assertTrue(all(len(name.split()) == 2 for name in names))
        self.assertEqual([kind for kind, _ in drain(self.events)], ["agents"])  # a single write
        self.settings.ensure_names([[A]])
        self.assertEqual(self.settings.snapshot()[A]["generated"], names[0])  # stable
        self.assertEqual(self.settings.name_for([A]), names[0])
        self.settings.rename(A, "Review")
        self.assertEqual(self.settings.name_for([A]), "Review")  # the given name wins
        # The conversation starts: its session keeps the name already shown, even if it got one in the meantime.
        self.settings.ensure_names([["33333333-2222-4333-8444-555555555555"]])
        self.settings.replace_key(conversation, "33333333-2222-4333-8444-555555555555")
        self.assertEqual(self.settings.snapshot()["33333333-2222-4333-8444-555555555555"]["generated"], names[1])
        self.assertEqual(AgentSettings(self.bus, self.path).snapshot(), self.settings.snapshot())  # read back from the file

    def test_generate_name_avoids_taken_names(self):
        from names import ADJECTIVES, ANIMALS, generate_name
        everything = [f"{adjective} {animal}" for adjective in ADJECTIVES for animal in ANIMALS]
        self.assertEqual(generate_name(everything[1:]), everything[0])
        self.assertRegex(generate_name(everything), r"^[A-Z][a-z]+ [A-Z][a-z]+ 2$")  # all taken: numbered

    def test_damaged_file_gives_no_settings(self):
        for content in ("{", "[1]", '{"../x": {"name": "a"}, "%s": "not an object"}' % A):
            self.path.write_text(content)
            self.assertEqual(AgentSettings(server.Bus(), self.path).snapshot(), {})


if __name__ == "__main__":
    unittest.main()

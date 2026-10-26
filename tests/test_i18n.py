"""Server translations and global settings: python3 -m unittest discover -s tests"""

import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import i18n  # noqa: E402
import server  # noqa: E402
from settings import Settings  # noqa: E402


def placeholders(text):
    return sorted(re.findall(r"\{(\w+)\}", text))


class I18nTest(unittest.TestCase):
    def tearDown(self):
        i18n.set_language("en")

    def test_english_source_and_french_fallback(self):
        i18n.set_language("en")
        self.assertEqual(i18n.tr("Unknown language: {code}", code="xx"), "Unknown language: xx")
        i18n.set_language("fr")
        self.assertEqual(i18n.tr("Not translated yet"), "Not translated yet")
        i18n.set_language("xx")
        self.assertEqual(i18n.language(), "en")

    def test_french_catalog_keeps_placeholders(self):
        catalog = json.loads((i18n.LOCALES_DIR / "fr.json").read_text(encoding="utf-8"))
        for key, value in catalog.items():
            self.assertTrue(value.strip(), key)
            self.assertEqual(placeholders(value), placeholders(key), key)

    def test_settings_are_saved_and_set_the_server_language(self):
        with tempfile.TemporaryDirectory() as tmp:
            bus = server.Bus()
            events = bus.subscribe()
            settings = Settings(bus, Path(tmp) / "settings.json")
            self.assertEqual(settings.snapshot(), {"language": "en"})
            self.assertEqual(settings.update({"language": "fr"}), {"language": "fr"})
            self.assertEqual(i18n.language(), "fr")
            self.assertEqual(events.get_nowait(), ("settings", {"language": "fr"}))
            self.assertEqual(Settings(bus, Path(tmp) / "settings.json").snapshot(), {"language": "fr"}, "reloaded")
            for bad in ({"language": "xx"}, {"theme": "dark"}, {}, "fr"):
                with self.assertRaises(ValueError):
                    settings.update(bad)

    def test_page_gets_the_language_before_any_script(self):
        with tempfile.TemporaryDirectory() as tmp:
            srv = server.ZiggyServer(0, tmp, {}, data_dir=Path(tmp) / "data")
            self.addCleanup(srv.server_close)
            handler = server.Handler.__new__(server.Handler)
            sent = []
            handler._send = lambda status, body=b"", content_type=None, headers=None: sent.append(body)
            handler._static("/")
            self.assertIn(b'<html lang="en">', sent[-1])
            srv.settings.update({"language": "fr"})
            handler._static("/")
            self.assertIn(b'<html lang="fr">', sent[-1])


if __name__ == "__main__":
    unittest.main()

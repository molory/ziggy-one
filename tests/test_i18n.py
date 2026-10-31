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

    def test_catalogs_keep_placeholders_and_the_same_keys(self):
        french = json.loads((i18n.LOCALES_DIR / "fr.json").read_text(encoding="utf-8"))
        for code in i18n.LANGUAGES[1:]:
            catalog = json.loads((i18n.LOCALES_DIR / f"{code}.json").read_text(encoding="utf-8"))
            self.assertEqual(sorted(catalog), sorted(french), code)
            for key, value in catalog.items():
                self.assertTrue(value.strip(), f"{code}: {key}")
                self.assertEqual(placeholders(value), placeholders(key), f"{code}: {key}")

    def test_arabic_is_written_right_to_left(self):
        i18n.set_language("ar")
        self.assertEqual(i18n.direction(), "rtl")
        i18n.set_language("fr")
        self.assertEqual(i18n.direction(), "ltr")

    def test_settings_are_saved_and_set_the_server_language(self):
        with tempfile.TemporaryDirectory() as tmp:
            bus = server.Bus()
            events = bus.subscribe()
            settings = Settings(bus, Path(tmp) / "settings.json")
            self.assertEqual(settings.snapshot(), {"language": "en", "corners": "default", "color": "orange"})
            self.assertEqual(settings.update({"language": "fr"}), {"language": "fr", "corners": "default", "color": "orange"})
            self.assertEqual(i18n.language(), "fr")
            self.assertEqual(events.get_nowait(), ("settings", {"language": "fr", "corners": "default", "color": "orange"}))
            self.assertEqual(settings.update({"corners": "square"})["corners"], "square")
            self.assertEqual(settings.update({"color": "purple"})["color"], "purple")
            reloaded = Settings(bus, Path(tmp) / "settings.json").snapshot()
            self.assertEqual(reloaded, {"language": "fr", "corners": "square", "color": "purple"}, "reloaded")
            for bad in ({"language": "xx"}, {"corners": "pointy"}, {"color": "#ff0000"}, {"theme": "dark"}, {}, "fr"):
                with self.assertRaises(ValueError):
                    settings.update(bad)

    def test_page_gets_the_language_before_any_script(self):
        with tempfile.TemporaryDirectory() as tmp:
            srv = server.ZiggyServer(0, tmp, {}, data_dir=Path(tmp) / "data")
            self.addCleanup(srv.server_close)
            handler = server.Handler.__new__(server.Handler)
            handler.server = srv
            sent = []
            handler._send = lambda status, body=b"", content_type=None, headers=None: sent.append(body)
            handler._static("/")
            self.assertIn(b'<html lang="en" dir="ltr" data-corners="default">', sent[-1])
            srv.settings.update({"language": "fr"})
            handler._static("/")
            self.assertIn(b'<html lang="fr" dir="ltr" data-corners="default">', sent[-1])
            srv.settings.update({"language": "ar"})
            handler._static("/")
            self.assertIn(b'<html lang="ar" dir="rtl" data-corners="default">', sent[-1])
            srv.settings.update({"language": "fr"})
            srv.settings.update({"corners": "square"})
            handler._static("/")
            self.assertIn(b'data-corners="square"', sent[-1])


if __name__ == "__main__":
    unittest.main()

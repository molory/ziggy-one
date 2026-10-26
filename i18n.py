"""Translations of the messages the server shows in the interface (errors, status texts…).

English is the source language: messages are written in English and wrapped in `tr("…")` (not `_`, which is
often a throwaway variable). Other languages are JSON dictionaries keyed by that English text (`locales/<code>.json`); a missing entry falls back to English.
`{name}` placeholders are filled with `str.format`. The language is the one chosen in the Configuration
(settings.py). Texts written for the agents (hooks, MCP tools) are not translated: they are always in English.
"""

import json
import threading
from pathlib import Path

LANGUAGES = ("en", "fr")
LOCALES_DIR = Path(__file__).resolve().parent / "locales"

_lock = threading.Lock()
_catalogs = {}
_language = "en"


def _load(code):
    try:
        data = json.loads((LOCALES_DIR / f"{code}.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return {k: v for k, v in data.items() if isinstance(k, str) and isinstance(v, str)} if isinstance(data, dict) else {}


def set_language(code):
    """Language of the server messages; unknown codes fall back to English."""
    global _language
    code = code if code in LANGUAGES else "en"
    with _lock:
        if code != "en" and code not in _catalogs:
            _catalogs[code] = _load(code)
        _language = code


def language():
    return _language


def tr(text, **params):
    """Translated message; `text` is the English source, `{name}` placeholders are filled from `params`."""
    translated = _catalogs.get(_language, {}).get(text, text) if _language != "en" else text
    return translated.format(**params) if params else translated

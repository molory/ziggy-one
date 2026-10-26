"""Global settings of Ziggy One, chosen in the Configuration (General tab): for now, the interface language.

Saved by the server (`settings.json`, 0600): they apply to every browser and to the server's own messages.
"""

import threading
from pathlib import Path

import i18n
from storage import read_json, write_json

DEFAULTS = {"language": "en"}


class Settings:
    def __init__(self, bus, path, event="settings"):
        self._bus = bus
        self._event = event
        self._path = Path(path)
        self._lock = threading.Lock()
        raw = read_json(self._path, {})
        raw = raw if isinstance(raw, dict) else {}
        language = raw.get("language")
        self._values = {**DEFAULTS, "language": language if language in i18n.LANGUAGES else DEFAULTS["language"]}
        i18n.set_language(self._values["language"])

    def snapshot(self):
        with self._lock:
            return dict(self._values)

    def update(self, changes):
        """Changes some settings; ValueError on an unknown setting or value."""
        if not isinstance(changes, dict) or not changes:
            raise ValueError(i18n.tr("No setting to change."))
        unknown = set(changes) - set(DEFAULTS)
        if unknown:
            raise ValueError(i18n.tr("Unknown setting: {name}", name=", ".join(sorted(unknown))))
        if "language" in changes and changes["language"] not in i18n.LANGUAGES:
            raise ValueError(i18n.tr("Unknown language: {code}", code=str(changes["language"])[:20]))
        with self._lock:
            self._values.update(changes)
            write_json(self._path, self._values)
            i18n.set_language(self._values["language"])
            snapshot = dict(self._values)
        self._bus.publish(self._event, snapshot)
        return snapshot

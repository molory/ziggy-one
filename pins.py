"""Pins of the agent list: agents and workspaces kept at the top, in the chosen order.

Saved on the server (local JSON file, 0600): they survive a restart and apply to all browsers and
profiles, unlike browser storage.
"""

import json
import re
import threading
from pathlib import Path

from i18n import tr
from storage import is_agent_key, read_json, write_json

WORKSPACE_PIN_RE = re.compile(r"^workspace:[0-9a-f]{12}$")
MAX_PINS = 100


def clean_pins(pins):
    """Valid pins (agent or workspace), without duplicates, in the order received; ValueError if not a list."""
    if not isinstance(pins, list):
        raise ValueError(tr("Expected a list of pins"))
    cleaned = []
    for pin in pins:
        if (is_agent_key(pin) or (isinstance(pin, str) and WORKSPACE_PIN_RE.match(pin))) and pin not in cleaned:
            cleaned.append(pin)
    return cleaned[:MAX_PINS]


class Pins:
    """`event`: name of the event published on every change (Kanban boards have their own pins)."""

    def __init__(self, bus, path, event="pins"):
        self._bus = bus
        self._event = event
        self._path = Path(path)
        self._lock = threading.Lock()
        try:
            self._items = clean_pins(read_json(self._path, []))
        except ValueError:
            self._items = []

    def _changed(self):
        # Called with _lock held.
        write_json(self._path, self._items)
        self._bus.publish(self._event, list(self._items))

    def list(self):
        with self._lock:
            return list(self._items)

    def agent_keys(self):
        """Pinned agents, to return in the list even if they are old."""
        with self._lock:
            return [pin for pin in self._items if is_agent_key(pin)]

    def set(self, pins):
        """Replaces all pins (the interface sends the full list, in order)."""
        cleaned = clean_pins(pins)
        with self._lock:
            if cleaned != self._items:
                self._items = cleaned
                self._changed()
            return list(self._items)

    def add(self, pin):
        """Pins at the end (a new agent or workspace is pinned by default); nothing if already pinned."""
        with self._lock:
            cleaned = clean_pins([*self._items, pin])
            if cleaned != self._items:
                self._items = cleaned
                self._changed()

    def replace_key(self, old, new):
        """A started conversation now has a session: its pin follows it."""
        if not is_agent_key(new):
            return
        with self._lock:
            if old not in self._items:
                return
            index = self._items.index(old)
            if new in self._items:
                self._items.pop(index)
            else:
                self._items[index] = new
            self._changed()

"""Épingles de la liste des agents : agents et workspaces gardés en tête, dans l'ordre choisi.

Enregistrées côté serveur (fichier JSON local, 0600) : elles survivent au redémarrage et valent pour
tous les navigateurs et profils, contrairement au stockage du navigateur.
"""

import json
import re
import threading
from pathlib import Path

from storage import is_agent_key, read_json, write_json

WORKSPACE_PIN_RE = re.compile(r"^workspace:[0-9a-f]{12}$")
MAX_PINS = 100


def clean_pins(pins):
    """Épingles valides (agent ou workspace), sans doublon, dans l'ordre reçu ; ValueError si ce n'est pas une liste."""
    if not isinstance(pins, list):
        raise ValueError("liste d'épingles attendue")
    cleaned = []
    for pin in pins:
        if (is_agent_key(pin) or (isinstance(pin, str) and WORKSPACE_PIN_RE.match(pin))) and pin not in cleaned:
            cleaned.append(pin)
    return cleaned[:MAX_PINS]


class Pins:
    """`event` : nom de l'événement publié à chaque changement (les tableaux Kanban ont leurs propres épingles)."""

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
        # Appelé avec _lock acquis.
        write_json(self._path, self._items)
        self._bus.publish(self._event, list(self._items))

    def list(self):
        with self._lock:
            return list(self._items)

    def agent_keys(self):
        """Agents épinglés, à renvoyer dans la liste même s'ils sont anciens."""
        with self._lock:
            return [pin for pin in self._items if is_agent_key(pin)]

    def set(self, pins):
        """Remplace toutes les épingles (l'interface envoie la liste complète, dans l'ordre)."""
        cleaned = clean_pins(pins)
        with self._lock:
            if cleaned != self._items:
                self._items = cleaned
                self._changed()
            return list(self._items)

    def replace_key(self, old, new):
        """Une discussion démarrée a désormais une session : son épingle la suit."""
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

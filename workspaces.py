"""Workspaces : des groupes d'agents, enregistrés dans un fichier JSON local (0600).

Un agent est désigné par l'identifiant de sa session Claude Code (ou, tant qu'elle n'a pas
démarré, par celui de sa discussion ziggy-one). Il appartient à un seul workspace à la fois.

`shareActivity` : les agents du workspace qui travaillent dans le même dépôt reçoivent, avec chaque
message, ce que les autres ont fait depuis (voir activity.py). Activé par défaut.
"""

import json
import re
import secrets
import threading
import time
from pathlib import Path

from storage import is_agent_key, read_json, write_json

WORKSPACE_ID_RE = re.compile(r"^[0-9a-f]{12}$")
MAX_NAME = 80
MAX_WORKSPACES = 100
MAX_AGENTS = 200


def clean_hue(hue):
    """Teinte de l'avatar (0 à 359), ou None pour la couleur automatique."""
    if hue is None:
        return None
    if isinstance(hue, bool) or not isinstance(hue, int) or not 0 <= hue < 360:
        raise ValueError("couleur invalide (teinte de 0 à 359)")
    return hue


def clean_name(name):
    if not isinstance(name, str) or not name.strip():
        raise ValueError("le nom du workspace est vide")
    return " ".join(name.split())[:MAX_NAME]


class Workspaces:
    """`event` : nom de l'événement publié à chaque changement (les tableaux Kanban ont leurs propres workspaces)."""

    def __init__(self, bus, path, event="workspaces"):
        self._bus = bus
        self._event = event
        self._path = Path(path)
        self._lock = threading.Lock()
        self._items = self._load()

    # --- fichier ----------------------------------------------------------------

    def _load(self):
        """Lecture défensive : un fichier absent ou abîmé donne une liste vide, jamais une erreur."""
        data = read_json(self._path, [])
        items = []
        for raw in data if isinstance(data, list) else []:
            if not isinstance(raw, dict) or not WORKSPACE_ID_RE.match(str(raw.get("id"))):
                continue
            try:
                name = clean_name(raw.get("name"))
            except ValueError:
                continue
            agents = [a for a in raw.get("agents", []) if is_agent_key(a)]
            try:
                hue = clean_hue(raw.get("hue"))
            except ValueError:
                hue = None
            share = raw.get("shareActivity")
            items.append({"id": raw["id"], "name": name, "hue": hue, "agents": agents[:MAX_AGENTS],
                          "shareActivity": share if isinstance(share, bool) else True,
                          "createdAt": raw.get("createdAt") if isinstance(raw.get("createdAt"), (int, float)) else 0})
        return items[:MAX_WORKSPACES]

    def _changed(self):
        # Appelé avec _lock acquis.
        write_json(self._path, self._items)
        snapshot = json.loads(json.dumps(self._items))
        self._bus.publish(self._event, snapshot)

    # --- lecture -------------------------------------------------------------------

    def list(self):
        with self._lock:
            return json.loads(json.dumps(self._items))

    def workspace_for(self, keys):
        """Workspace qui contient l'agent (sous l'un de ses identifiants), ou None."""
        with self._lock:
            item = next((item for item in self._items if any(key in item["agents"] for key in keys)), None)
            return json.loads(json.dumps(item)) if item else None

    def agent_keys(self):
        with self._lock:
            return [key for item in self._items for key in item["agents"]]

    # --- modifications ------------------------------------------------------------------

    def _find(self, workspace_id):
        return next((item for item in self._items if item["id"] == workspace_id), None)

    def create(self, name):
        name = clean_name(name)
        with self._lock:
            if len(self._items) >= MAX_WORKSPACES:
                raise ValueError(f"{MAX_WORKSPACES} workspaces au maximum")
            item = {"id": secrets.token_hex(6), "name": name, "hue": None, "agents": [], "shareActivity": True,
                    "createdAt": time.time()}
            self._items.append(item)
            self._changed()
            return dict(item, agents=[])

    def update(self, workspace_id, changes):
        """Nom, couleur, partage de l'activité : seules les clés présentes (« name », « hue »,
        « shareActivity ») sont modifiées."""
        name = clean_name(changes["name"]) if "name" in changes else None
        hue = clean_hue(changes["hue"]) if "hue" in changes else None
        if "shareActivity" in changes and not isinstance(changes["shareActivity"], bool):
            raise ValueError("shareActivity doit valoir true ou false")
        with self._lock:
            item = self._find(workspace_id)
            if item is None:
                return False
            if "name" in changes:
                item["name"] = name
            if "hue" in changes:
                item["hue"] = hue
            if "shareActivity" in changes:
                item["shareActivity"] = changes["shareActivity"]
            self._changed()
            return True

    def delete(self, workspace_id):
        """Supprime le workspace ; ses agents reviennent dans la liste générale."""
        with self._lock:
            item = self._find(workspace_id)
            if item is None:
                return False
            self._items.remove(item)
            self._changed()
            return True

    def add_agent(self, workspace_id, key):
        """Ajoute un agent ; s'il était dans un autre workspace, il en est retiré."""
        if not is_agent_key(key):
            raise ValueError("identifiant d'agent invalide")
        with self._lock:
            item = self._find(workspace_id)
            if item is None:
                return False
            for other in self._items:
                if other is not item and key in other["agents"]:
                    other["agents"].remove(key)
            if key not in item["agents"]:
                if len(item["agents"]) >= MAX_AGENTS:
                    raise ValueError(f"{MAX_AGENTS} agents au maximum par workspace")
                item["agents"].append(key)
            self._changed()
            return True

    def remove_agent_everywhere(self, keys):
        """Retire l'agent (sous n'importe lequel de ses identifiants) de tous les workspaces."""
        with self._lock:
            changed = False
            for item in self._items:
                kept = [key for key in item["agents"] if key not in keys]
                if len(kept) != len(item["agents"]):
                    item["agents"] = kept
                    changed = True
            if changed:
                self._changed()

    def remove_agent(self, workspace_id, key):
        with self._lock:
            item = self._find(workspace_id)
            if item is None:
                return False
            if key in item["agents"]:
                item["agents"].remove(key)
                self._changed()
            return True

    def replace_agent_key(self, old, new):
        """Une discussion démarrée a désormais une session : on la désigne par celle-ci, qui dure."""
        if not is_agent_key(new):
            return
        with self._lock:
            changed = False
            for item in self._items:
                if old in item["agents"]:
                    index = item["agents"].index(old)
                    if new in item["agents"]:
                        item["agents"].pop(index)
                    else:
                        item["agents"][index] = new
                    changed = True
            if changed:
                self._changed()

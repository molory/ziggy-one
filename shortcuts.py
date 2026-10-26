"""Raccourcis de prompts : des messages tout prêts, envoyés au Terminal d'un agent en un geste.

Deux sortes de listes : celle d'un agent (à lui seul) et celle d'un workspace (commune à tous ses agents).
Dans le Terminal, le panneau des raccourcis montre ceux de l'agent puis ceux de son workspace ; les dix
premiers ont un chiffre (1…9, 0).

Enregistrés côté serveur (fichier JSON local, 0600) : ils survivent au redémarrage et valent pour tous les
navigateurs. L'interface envoie toujours une liste complète, dans l'ordre.
"""

import re
import secrets
import threading
from pathlib import Path

from storage import is_agent_key, read_json, write_json

ID_RE = re.compile(r"^[0-9a-f]{12}$")
WORKSPACE_ID_RE = ID_RE
CONTROL_RE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")  # le prompt garde ses sauts de ligne et tabulations
MAX_ITEMS = 50
MAX_TITLE = 80
MAX_PROMPT = 20_000
SCOPES = {"agent": "agents", "workspace": "workspaces"}


def clean_items(items, strict=True):
    """Raccourcis valides, dans l'ordre reçu. Strict (envoi de l'interface) : ValueError au premier défaut ;
    sinon (lecture du fichier) les raccourcis abîmés sont ignorés."""
    if not isinstance(items, list):
        if strict:
            raise ValueError("liste de raccourcis attendue")
        return []
    if strict and len(items) > MAX_ITEMS:
        raise ValueError(f"{MAX_ITEMS} raccourcis au maximum")
    cleaned, seen = [], set()
    for item in items[:MAX_ITEMS]:
        try:
            if not isinstance(item, dict):
                raise ValueError("raccourci invalide")
            title, prompt = item.get("title", ""), item.get("prompt")
            if not isinstance(title, str) or not isinstance(prompt, str):
                raise ValueError("raccourci invalide")
            title = CONTROL_RE.sub("", title).replace("\t", " ").replace("\n", " ").strip()
            prompt = CONTROL_RE.sub("", prompt.replace("\r\n", "\n").replace("\r", "\n")).strip()
            if not prompt:
                raise ValueError("un raccourci a besoin d'un prompt")
            if len(title) > MAX_TITLE or len(prompt) > MAX_PROMPT:
                raise ValueError(f"titre ({MAX_TITLE}) ou prompt ({MAX_PROMPT} caractères) trop long")
        except ValueError:
            if strict:
                raise
            continue
        item_id = item.get("id")
        if not isinstance(item_id, str) or not ID_RE.match(item_id) or item_id in seen:
            item_id = secrets.token_hex(6)  # nouveau raccourci : l'identifiant est donné ici
        seen.add(item_id)
        cleaned.append({"id": item_id, "title": title, "prompt": prompt})
    return cleaned


class Shortcuts:
    def __init__(self, bus, path, event="shortcuts"):
        self._bus = bus
        self._event = event
        self._path = Path(path)
        self._lock = threading.Lock()
        raw = read_json(self._path, {})
        raw = raw if isinstance(raw, dict) else {}
        self._data = {"agents": {}, "workspaces": {}}
        for scope, valid in (("agents", is_agent_key), ("workspaces", lambda k: bool(WORKSPACE_ID_RE.match(k)))):
            lists = raw.get(scope) if isinstance(raw.get(scope), dict) else {}
            for owner, items in lists.items():
                items = clean_items(items, strict=False)
                if isinstance(owner, str) and valid(owner) and items:
                    self._data[scope][owner] = items

    def _snapshot(self):
        # Appelé avec _lock acquis.
        return {scope: {owner: [dict(i) for i in items] for owner, items in lists.items()}
                for scope, lists in self._data.items()}

    def _changed(self):
        # Appelé avec _lock acquis.
        write_json(self._path, self._data)
        self._bus.publish(self._event, self._snapshot())

    def snapshot(self):
        with self._lock:
            return self._snapshot()

    def set(self, scope, owner, items):
        """Remplace la liste d'un agent (`scope` « agent ») ou d'un workspace (« workspace »)."""
        if scope not in SCOPES:
            raise ValueError("portée inconnue : agent ou workspace")
        valid = is_agent_key(owner) if scope == "agent" else isinstance(owner, str) and WORKSPACE_ID_RE.match(owner)
        if not valid:
            raise ValueError("agent ou workspace invalide")
        cleaned = clean_items(items)
        with self._lock:
            lists = self._data[SCOPES[scope]]
            if cleaned != lists.get(owner, []):
                if cleaned:
                    lists[owner] = cleaned
                else:
                    lists.pop(owner, None)
                self._changed()
            return self._snapshot()

    def replace_key(self, old, new):
        """Une discussion démarrée a désormais une session : ses raccourcis la suivent."""
        if not is_agent_key(new):
            return
        with self._lock:
            agents = self._data["agents"]
            if old not in agents:
                return
            moved = agents.pop(old)
            kept = agents.get(new, [])
            ids = {item["id"] for item in kept}
            agents[new] = (kept + [item for item in moved if item["id"] not in ids])[:MAX_ITEMS]
            self._changed()

    def drop_workspace(self, workspace_id):
        """Workspace supprimé : ses raccourcis aussi."""
        with self._lock:
            if self._data["workspaces"].pop(workspace_id, None) is not None:
                self._changed()

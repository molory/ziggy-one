"""Prompt shortcuts: ready-made messages, sent to an agent's Terminal in one gesture.

Two kinds of lists: an agent's own (for it alone) and a workspace's (shared by all its agents).
In the Terminal, the shortcuts panel shows the agent's then its workspace's; the first ten have a
digit (1…9, 0).

Saved on the server (local JSON file, 0600): they survive a restart and apply to all browsers.
The interface always sends a full list, in order.
"""

import re
import secrets
import threading
from pathlib import Path

from i18n import tr
from storage import is_agent_key, read_json, write_json

ID_RE = re.compile(r"^[0-9a-f]{12}$")
WORKSPACE_ID_RE = ID_RE
CONTROL_RE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")  # the prompt keeps its line breaks and tabs
MAX_ITEMS = 50
MAX_TITLE = 80
MAX_PROMPT = 20_000
SCOPES = {"agent": "agents", "workspace": "workspaces"}


def clean_items(items, strict=True):
    """Valid shortcuts, in the order received. Strict (sent by the interface): ValueError on the first flaw;
    otherwise (reading the file) damaged shortcuts are ignored."""
    if not isinstance(items, list):
        if strict:
            raise ValueError(tr("Expected a list of shortcuts"))
        return []
    if strict and len(items) > MAX_ITEMS:
        raise ValueError(tr("{count} shortcuts at most", count=MAX_ITEMS))
    cleaned, seen = [], set()
    for item in items[:MAX_ITEMS]:
        try:
            if not isinstance(item, dict):
                raise ValueError(tr("Invalid shortcut"))
            title, prompt = item.get("title", ""), item.get("prompt")
            if not isinstance(title, str) or not isinstance(prompt, str):
                raise ValueError(tr("Invalid shortcut"))
            title = CONTROL_RE.sub("", title).replace("\t", " ").replace("\n", " ").strip()
            prompt = CONTROL_RE.sub("", prompt.replace("\r\n", "\n").replace("\r", "\n")).strip()
            if not prompt:
                raise ValueError(tr("A shortcut needs a prompt"))
            if len(title) > MAX_TITLE or len(prompt) > MAX_PROMPT:
                raise ValueError(tr("Title ({title}) or prompt ({prompt} characters) too long", title=MAX_TITLE, prompt=MAX_PROMPT))
        except ValueError:
            if strict:
                raise
            continue
        item_id = item.get("id")
        if not isinstance(item_id, str) or not ID_RE.match(item_id) or item_id in seen:
            item_id = secrets.token_hex(6)  # new shortcut: the id is given here
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
        # Called with _lock held.
        return {scope: {owner: [dict(i) for i in items] for owner, items in lists.items()}
                for scope, lists in self._data.items()}

    def _changed(self):
        # Called with _lock held.
        write_json(self._path, self._data)
        self._bus.publish(self._event, self._snapshot())

    def snapshot(self):
        with self._lock:
            return self._snapshot()

    def set(self, scope, owner, items):
        """Replaces the list of an agent (`scope` "agent") or of a workspace ("workspace")."""
        if scope not in SCOPES:
            raise ValueError(tr("Unknown scope: agent or workspace"))
        valid = is_agent_key(owner) if scope == "agent" else isinstance(owner, str) and WORKSPACE_ID_RE.match(owner)
        if not valid:
            raise ValueError(tr("Invalid agent or workspace"))
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
        """A started conversation now has a session: its shortcuts follow it."""
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
        """Deleted workspace: its shortcuts too."""
        with self._lock:
            if self._data["workspaces"].pop(workspace_id, None) is not None:
                self._changed()

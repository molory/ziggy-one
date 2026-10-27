"""Workspaces: groups of agents, saved in a local JSON file (0600).

An agent is designated by the id of its Claude Code session (or, until it has started, by the id of
its ziggy-one conversation). It belongs to a single workspace at a time.

`shareActivity`: the agents of the workspace that work in the same repository receive, with each
message, what the others have done since (see activity.py). On by default.
"""

import json
import re
import secrets
import threading
import time
from pathlib import Path

from i18n import tr
from storage import is_agent_key, read_json, write_json

WORKSPACE_ID_RE = re.compile(r"^[0-9a-f]{12}$")
MAX_NAME = 80
MAX_WORKSPACES = 100
MAX_AGENTS = 200


def clean_hue(hue):
    """Hue of the avatar (0 to 359), or None for the automatic color."""
    if hue is None:
        return None
    if isinstance(hue, bool) or not isinstance(hue, int) or not 0 <= hue < 360:
        raise ValueError(tr("Invalid color (hue from 0 to 359)"))
    return hue


def clean_name(name):
    if not isinstance(name, str) or not name.strip():
        raise ValueError(tr("The workspace name is empty"))
    return " ".join(name.split())[:MAX_NAME]


class Workspaces:
    """`event`: name of the event published on every change (Kanban boards have their own workspaces)."""

    def __init__(self, bus, path, event="workspaces"):
        self._bus = bus
        self._event = event
        self._path = Path(path)
        self._lock = threading.Lock()
        self._items = self._load()

    # --- file -------------------------------------------------------------------

    def _load(self):
        """Defensive reading: a missing or damaged file gives an empty list, never an error."""
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
        # Called with _lock held.
        write_json(self._path, self._items)
        snapshot = json.loads(json.dumps(self._items))
        self._bus.publish(self._event, snapshot)

    # --- reading -------------------------------------------------------------------

    def list(self):
        with self._lock:
            return json.loads(json.dumps(self._items))

    def workspace_for(self, keys):
        """Workspace that contains the agent (under one of its ids), or None."""
        with self._lock:
            item = next((item for item in self._items if any(key in item["agents"] for key in keys)), None)
            return json.loads(json.dumps(item)) if item else None

    def agent_keys(self):
        with self._lock:
            return [key for item in self._items for key in item["agents"]]

    # --- changes ------------------------------------------------------------------------

    def _find(self, workspace_id):
        return next((item for item in self._items if item["id"] == workspace_id), None)

    def create(self, name):
        name = clean_name(name)
        with self._lock:
            if len(self._items) >= MAX_WORKSPACES:
                raise ValueError(tr("{count} workspaces at most", count=MAX_WORKSPACES))
            item = {"id": secrets.token_hex(6), "name": name, "hue": None, "agents": [], "shareActivity": True,
                    "createdAt": time.time()}
            self._items.append(item)
            self._changed()
            return dict(item, agents=[])

    def update(self, workspace_id, changes):
        """Name, color, activity sharing: only the keys present ("name", "hue", "shareActivity")
        are changed."""
        name = clean_name(changes["name"]) if "name" in changes else None
        hue = clean_hue(changes["hue"]) if "hue" in changes else None
        if "shareActivity" in changes and not isinstance(changes["shareActivity"], bool):
            raise ValueError(tr("shareActivity must be true or false"))
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
        """Deletes the workspace; its agents go back to the general list."""
        with self._lock:
            item = self._find(workspace_id)
            if item is None:
                return False
            self._items.remove(item)
            self._changed()
            return True

    def add_agent(self, workspace_id, key):
        """Adds an agent; if it was in another workspace, it is removed from it."""
        return self._put_agent(workspace_id, key, move=False, before=None)

    def place_agent(self, workspace_id, key, before):
        """Adds or moves an agent (drag and drop) just before the agent `before`, at the end if None or absent;
        if it was in another workspace, it is removed from it."""
        if before is not None and not is_agent_key(before):
            raise ValueError(tr("Invalid agent id"))
        return self._put_agent(workspace_id, key, move=True, before=before)

    def _put_agent(self, workspace_id, key, move, before):
        if not is_agent_key(key):
            raise ValueError(tr("Invalid agent id"))
        with self._lock:
            item = self._find(workspace_id)
            if item is None:
                return False
            for other in self._items:
                if other is not item and key in other["agents"]:
                    other["agents"].remove(key)
            agents = item["agents"]
            if key in agents and move:
                agents.remove(key)
            if key not in agents:
                if len(agents) >= MAX_AGENTS:
                    raise ValueError(tr("{count} agents at most per workspace", count=MAX_AGENTS))
                agents.insert(agents.index(before) if before in agents else len(agents), key)
            self._changed()
            return True

    def move(self, workspace_id, before):
        """Moves a workspace (drag and drop) just before the workspace `before`, at the end if None or absent."""
        if before is not None and not WORKSPACE_ID_RE.match(str(before)):
            raise ValueError(tr("Unknown workspace"))
        with self._lock:
            item = self._find(workspace_id)
            if item is None:
                return False
            self._items.remove(item)
            target = self._find(before) if before is not None else None
            self._items.insert(self._items.index(target) if target else len(self._items), item)
            self._changed()
            return True

    def remove_agent_everywhere(self, keys):
        """Removes the agent (under any of its ids) from all workspaces."""
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
        """A started conversation now has a session: it is designated by the session, which lasts."""
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

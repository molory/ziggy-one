"""Agent settings: custom name, avatar, Claude settings (model, permissions, Chrome) and agents
deleted from the list (local JSON file, 0600).

The avatar: an abbreviation (1 or 2 characters), shown alone, or an animal (Twemoji image served with the
page), or an image picked from the disk, cropped by the browser and kept in `avatars/` (0600).

Deleting an agent removes it from ziggy-one without touching its Claude Code history: we keep
what is needed to show it in "Deleted agents" (name, folder, date) so it can be restored.
"""

import json
import os
import re
import secrets
import threading
import time
import unicodedata
from pathlib import Path

from i18n import tr
from names import ANIMALS, FRENCH_ANIMALS, generate_name
from storage import is_agent_key, read_json, write_json

MAX_NAME = 80
MAX_LABEL = 200
MAX_PATH = 500
MAX_ROLE = 600  # role: what can be entrusted to the agent, given to the other agents (directory)
MODELS = ("opus", "sonnet", "haiku")
PERMISSION_MODES = ("auto", "default", "acceptEdits", "plan")
AVATAR_KINDS = ("letters", "animal", "image")
# 2 visible characters, a limit enforced by the browser; a composed emoji counts several code points.
MAX_ABBR = 16
MAX_AVATAR_IMAGE = 300_000  # image already cropped and scaled down (256 px) by the browser
AVATAR_IMAGE_RE = re.compile(r"^[0-9a-f]{16}$")
AVATAR_IMAGE_TYPES = {"png": "image/png", "jpeg": "image/jpeg", "webp": "image/webp"}


def clean_options(raw, strict=False):
    """Claude settings of an agent; a missing value (or None, "") keeps the default value.

    In strict mode, an unknown value is an error; otherwise (reading the file) it is ignored.
    """
    if not isinstance(raw, dict):
        if strict:
            raise ValueError(tr("Invalid settings"))
        return {}
    options = {}
    checks = {
        "model": lambda v: v in MODELS,
        "permissionMode": lambda v: v in PERMISSION_MODES,
        "chrome": lambda v: isinstance(v, bool),
    }
    for name, valid in checks.items():
        value = raw.get(name)
        if value is None or value == "":
            continue
        if valid(value):
            options[name] = value
        elif strict:
            raise ValueError(tr("Invalid value for {name}: {value}", name=name, value=repr(value)))
    return options


def clean_abbr(value):
    """Avatar abbreviation: no spaces or control characters (the ZWJ of composed emoji stays)."""
    if value is None or value == "":
        return ""
    if not isinstance(value, str) or len(value) > MAX_ABBR:
        raise ValueError(tr("Invalid abbreviation"))
    if any(char.isspace() or (unicodedata.category(char).startswith("C") and unicodedata.category(char) != "Cf")
           for char in value):
        raise ValueError(tr("Invalid abbreviation"))
    return value


def clean_avatar(raw, strict=False):
    """Avatar of an agent ({abbr, kind, animal, image}); empty = the default avatar (initial on its color).

    In strict mode (request), an invalid value is an error; otherwise (reading the file) it is ignored.
    The image id never comes from the browser: `strict` drops it. An animal saved under its French name
    (older avatars) becomes its English name.
    """
    if not isinstance(raw, dict):
        if strict:
            raise ValueError(tr("Invalid avatar"))
        return {}
    avatar = {}
    try:
        abbr = clean_abbr(raw.get("abbr"))
    except ValueError:
        if strict:
            raise
        abbr = ""
    if abbr:
        avatar["abbr"] = abbr
    kind = raw.get("kind") or "letters"
    if kind not in AVATAR_KINDS:
        if strict:
            raise ValueError(tr("Invalid avatar type: {kind}", kind=repr(kind)))
        kind = "letters"
    animal = raw.get("animal")
    if isinstance(animal, str):
        animal = FRENCH_ANIMALS.get(animal, animal)
    if animal not in (None, "") and animal not in ANIMALS:
        if strict:
            raise ValueError(tr("Unknown animal: {animal}", animal=repr(animal)))
        animal = None
    if kind == "animal":
        if not animal:
            if strict:
                raise ValueError(tr("Missing animal"))
            kind = "letters"
        else:
            avatar["animal"] = animal
    image = None if strict else raw.get("image")
    if kind == "image" and not (isinstance(image, str) and AVATAR_IMAGE_RE.match(image)):
        if not strict:
            kind = "letters"
    elif kind == "image":
        avatar["image"] = image
    if kind != "letters":
        avatar["kind"] = kind
    return avatar


def image_type(data):
    """Type of an avatar image, from its first bytes (PNG, JPEG or WebP); None otherwise."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return None


def clean_role(value):
    """Role of an agent: free text, spaces and line breaks collapsed, without control characters."""
    if not isinstance(value, str):
        return ""
    return " ".join("".join(ch for ch in value if ch.isprintable() or ch.isspace()).split())[:MAX_ROLE]


def _clip(value, limit):
    return value[:limit] if isinstance(value, str) else ""


class AgentSettings:
    def __init__(self, bus, path, avatars_dir=None):
        self._bus = bus
        self._path = Path(path)
        self._avatars = Path(avatars_dir) if avatars_dir else self._path.parent / "avatars"
        self._lock = threading.Lock()
        self._items = self._load()

    def _load(self):
        data = read_json(self._path, {})
        items = {}
        for key, raw in (data.items() if isinstance(data, dict) else []):
            if not is_agent_key(key) or not isinstance(raw, dict):
                continue
            entry = {}
            for field in ("name", "generated"):
                if isinstance(raw.get(field), str) and raw[field].strip():
                    entry[field] = " ".join(raw[field].split())[:MAX_NAME]
            options = clean_options(raw.get("options"))
            if options:
                entry["options"] = options
            role = clean_role(raw.get("role"))
            if role:
                entry["role"] = role
            avatar = clean_avatar(raw.get("avatar"))
            if avatar:
                entry["avatar"] = avatar
            hidden = raw.get("hidden")
            if isinstance(hidden, dict):
                entry["hidden"] = {
                    "label": _clip(hidden.get("label"), MAX_LABEL),
                    "cwd": _clip(hidden.get("cwd"), MAX_PATH),
                    "at": hidden.get("at") if isinstance(hidden.get("at"), (int, float)) else 0,
                }
            if entry:
                items[key] = entry
        return items

    def _changed(self):
        # Called with _lock held. An empty entry (no name, not deleted) is not kept.
        self._items = {key: entry for key, entry in self._items.items() if entry}
        write_json(self._path, self._items)
        self._bus.publish("agents", json.loads(json.dumps(self._items)))

    def snapshot(self):
        with self._lock:
            return json.loads(json.dumps(self._items))

    def rename(self, key, name):
        """Name given to the agent; an empty name gives it back its generated name."""
        if not is_agent_key(key):
            raise ValueError(tr("Invalid agent id"))
        if name is not None and not isinstance(name, str):
            raise ValueError(tr("Invalid name"))
        name = " ".join((name or "").split())[:MAX_NAME]
        with self._lock:
            entry = self._items.setdefault(key, {})
            if name:
                entry["name"] = name
            else:
                entry.pop("name", None)
            self._changed()

    def set_options(self, key, options):
        """Claude settings of the agent (model, permissions, Chrome); empty = default values."""
        if not is_agent_key(key):
            raise ValueError(tr("Invalid agent id"))
        cleaned = clean_options(options, strict=True)
        with self._lock:
            entry = self._items.setdefault(key, {})
            if cleaned:
                entry["options"] = cleaned
            else:
                entry.pop("options", None)
            self._changed()

    def set_role(self, key, role):
        """Role of the agent, given to the other agents when their session starts; empty = no role."""
        if not is_agent_key(key):
            raise ValueError(tr("Invalid agent id"))
        if role is not None and not isinstance(role, str):
            raise ValueError(tr("Invalid role"))
        role = clean_role(role)
        with self._lock:
            entry = self._items.setdefault(key, {})
            if role:
                entry["role"] = role
            else:
                entry.pop("role", None)
            self._changed()

    def roles(self):
        """Agents that have a role and are not deleted: [(key, name, role)]."""
        with self._lock:
            return [(key, entry.get("name") or entry.get("generated") or "", entry["role"])
                    for key, entry in self._items.items() if entry.get("role") and "hidden" not in entry]

    def set_avatar(self, key, avatar, image=None):
        """Avatar of the agent; `image` (PNG, JPEG or WebP bytes) replaces its image.

        Without a new image, the "image" type keeps the one it already has; another type deletes it.
        """
        if not is_agent_key(key):
            raise ValueError(tr("Invalid agent id"))
        cleaned = clean_avatar(avatar, strict=True)
        kind = cleaned.get("kind", "letters")
        if image is not None:
            if kind != "image":
                raise ValueError(tr('An image goes with the "image" type'))
            if not isinstance(image, bytes) or len(image) > MAX_AVATAR_IMAGE or image_type(image) is None:
                raise ValueError(tr("Invalid image (PNG, JPEG or WebP, 300 KB max)"))
        with self._lock:
            entry = self._items.setdefault(key, {})
            old = entry.get("avatar", {}).get("image")
            if image is not None:
                cleaned["image"] = self._save_image(image)
            elif kind == "image":
                if not old:
                    raise ValueError(tr("No image chosen"))
                cleaned["image"] = old
            if cleaned:
                entry["avatar"] = cleaned
            else:
                entry.pop("avatar", None)
            self._changed()
        if old and old != cleaned.get("image"):
            (self._avatars / old).unlink(missing_ok=True)

    def _save_image(self, data):
        # Called with _lock held. A new id for each image: the browser can keep it in its cache.
        self._avatars.mkdir(parents=True, exist_ok=True, mode=0o700)
        image_id = secrets.token_hex(8)
        fd = os.open(self._avatars / image_id, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as file:
            file.write(data)
        return image_id

    def avatar_image(self, image_id):
        """(bytes, MIME type) of the avatar image, or None if it does not exist."""
        if not isinstance(image_id, str) or not AVATAR_IMAGE_RE.match(image_id):
            return None
        try:
            data = (self._avatars / image_id).read_bytes()
        except OSError:
            return None
        kind = image_type(data)
        return (data, AVATAR_IMAGE_TYPES[kind]) if kind else None

    def options_for(self, keys):
        """Claude settings saved under one of the agent's ids ({} if there are none)."""
        with self._lock:
            for key in keys:
                options = self._items.get(key, {}).get("options") if key else None
                if options:
                    return dict(options)
            return {}

    def name_for(self, keys):
        """Name of the agent: the one given to it, otherwise its generated name; None if it has none."""
        with self._lock:
            entries = [self._items.get(key, {}) for key in keys if key]
            return next((entry[field] for field in ("name", "generated") for entry in entries if field in entry), None)

    def ensure_names(self, groups):
        """Gives a unique generated name to the agents that have neither a name nor a generated name.

        `groups`: for each agent, its ids (session, conversation), the first one being used to
        save the name. A single write for all the named agents.
        """
        with self._lock:
            taken = {entry[field] for entry in self._items.values() for field in ("name", "generated") if field in entry}
            named = False
            for keys in groups:
                keys = [key for key in keys if is_agent_key(key)]
                if not keys or any("name" in self._items.get(k, {}) or "generated" in self._items.get(k, {}) for k in keys):
                    continue
                name = generate_name(taken)
                taken.add(name)
                self._items.setdefault(keys[0], {})["generated"] = name
                named = True
            if named:
                self._changed()

    def hide(self, key, label="", cwd=""):
        if not is_agent_key(key):
            raise ValueError(tr("Invalid agent id"))
        with self._lock:
            self._items.setdefault(key, {})["hidden"] = {
                "label": _clip(label, MAX_LABEL), "cwd": _clip(cwd, MAX_PATH), "at": time.time(),
            }
            self._changed()

    def restore(self, key):
        """Removes the agent from the deleted ones; returns what was kept of it (name, folder), or None."""
        with self._lock:
            entry = self._items.get(key)
            if entry is None or "hidden" not in entry:
                return None
            hidden = entry.pop("hidden")
            self._changed()
            return hidden

    def replace_key(self, old, new):
        """A started conversation now has a session: its settings follow it."""
        if not is_agent_key(new):
            return
        with self._lock:
            entry = self._items.pop(old, None)
            if entry is None:
                return
            merged = {**entry, **self._items.get(new, {})}
            if "generated" in entry:
                merged["generated"] = entry["generated"]  # the agent keeps the name already shown
            self._items[new] = merged
            self._changed()

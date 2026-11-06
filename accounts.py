"""Claude accounts of the terminals: profiles, each a long-lived token made by `claude setup-token`.

The active profile applies to every `claude` that the server starts (terminals, `claude auth status`, the usage
probe, commit messages): main() puts its token in the server's environment (CLAUDE_CODE_OAUTH_TOKEN) before
anything else, and Claude Code then uses it instead of the login of the machine. No profile: the login of the
machine (`/login`), as before.

Switching account goes through the clean restart (restart.py): the choice is saved, the server relaunches itself,
the new environment applies at the start and the terminals reopen on their sessions (--resume). The history stays
in ~/.claude, whatever the account, so the conversations go on.

The tokens stay in accounts.json (0600, in the data folder that the agents may not read) and never go to the
browser. They are in the environment of the `claude` processes, as Claude Code needs them there.
"""

import os
import re
import secrets
import threading
import time

from i18n import tr
from storage import read_json, write_json

ENV_TOKEN = "CLAUDE_CODE_OAUTH_TOKEN"
# Set with the token: the profile applied (its id). On a relaunch (same process, same environment), it tells
# that the token is ours, to remove it before applying the new choice; a token set outside Ziggy One is kept.
ENV_PROFILE = "ZIGGY_ONE_ACCOUNT"
# What `claude setup-token` prints (sk-ant-oat01-…); an API key (sk-ant-api…) is refused by Claude Code here.
TOKEN_RE = re.compile(r"^sk-ant-oat[0-9]{2}-[A-Za-z0-9_-]{16,500}$")
ID_RE = re.compile(r"^[0-9a-f]{12}$")
MAX_NAME = 60
MAX_PROFILES = 20


def _profiles(raw):
    """Valid profiles of a file, possibly damaged or edited by hand."""
    items = raw.get("profiles") if isinstance(raw, dict) else None
    profiles = []
    for item in items if isinstance(items, list) else []:
        if (isinstance(item, dict) and isinstance(item.get("id"), str) and ID_RE.match(item["id"])
                and isinstance(item.get("name"), str) and isinstance(item.get("token"), str)
                and TOKEN_RE.match(item["token"]) and all(p["id"] != item["id"] for p in profiles)):
            added = item.get("added")
            profiles.append({"id": item["id"], "name": item["name"][:MAX_NAME], "token": item["token"],
                             "added": added if isinstance(added, (int, float)) else 0})
    return profiles[:MAX_PROFILES]


def _active(raw, profiles):
    active = raw.get("active") if isinstance(raw, dict) else None
    return active if any(p["id"] == active for p in profiles) else None


def apply(path, environ=None):
    """At the start, before any `claude`: the token of the active profile in the environment, or none.

    Returns the id of the profile applied (None: the login of the machine)."""
    environ = os.environ if environ is None else environ
    if environ.pop(ENV_PROFILE, None) is not None:
        environ.pop(ENV_TOKEN, None)  # ours, from before the relaunch
    raw = read_json(path, {})
    profiles = _profiles(raw)
    active = _active(raw, profiles)
    if active is None:
        return None
    environ[ENV_TOKEN] = next(p["token"] for p in profiles if p["id"] == active)
    environ[ENV_PROFILE] = active
    return active


class Accounts:
    """Profiles of accounts (accounts.json). Event: accounts.

    `running`: the profile applied at the start of this process (see apply); `active`: the one chosen, which
    applies at the next start (they differ while a switch waits for its restart).

    The file is read again before each change: two servers may share the data folder (one per port), and neither
    must drop a profile that the other added. `check(token)`: None if Claude accepts the token, else the error.
    """

    def __init__(self, bus, path, environ=None, check=None):
        self._bus = bus
        self._path = path
        self._check = check
        self._lock = threading.Lock()
        self._load()
        environ = os.environ if environ is None else environ
        running = environ.get(ENV_PROFILE)
        self.running = running if any(p["id"] == running for p in self._profiles) else None

    def _load(self):
        raw = read_json(self._path, {})
        self._profiles = _profiles(raw)
        self._active = _active(raw, self._profiles)

    def _save(self):
        write_json(self._path, {"active": self._active, "profiles": self._profiles})

    def snapshot(self):
        """For the browser: names and dates, never the tokens."""
        with self._lock:
            self._load()
            return {"active": self._active, "running": self.running,
                    "profiles": [{"id": p["id"], "name": p["name"], "added": p["added"]} for p in self._profiles]}

    def running_name(self):
        with self._lock:
            return next((p["name"] for p in self._profiles if p["id"] == self.running), None)

    def _publish(self):
        self._bus.publish("accounts", self.snapshot())

    def add(self, name, token):
        name = name.strip() if isinstance(name, str) else ""
        token = token.strip() if isinstance(token, str) else ""
        if not name or len(name) > MAX_NAME or any(c in name for c in "\r\n\t"):
            raise ValueError(tr("Invalid name"))
        if not TOKEN_RE.match(token):
            raise ValueError(tr("Invalid token: paste the one that `claude setup-token` prints (sk-ant-oat01-…)"))
        # Before saving: with a token, `claude auth status` says "logged in" without asking, so a dead token would
        # only show up after the switch, in every terminal at once.
        error = self._check(token) if self._check else None
        if error:
            raise ValueError(tr("Claude refused this token: {error}", error=error))
        with self._lock:
            self._load()
            if len(self._profiles) >= MAX_PROFILES:
                raise ValueError(tr("Too many accounts"))
            if any(p["name"] == name for p in self._profiles):
                raise ValueError(tr("An account already has this name"))
            self._profiles.append({"id": secrets.token_hex(6), "name": name, "token": token, "added": time.time()})
            self._save()
        self._publish()
        return self.snapshot()

    def delete(self, profile_id):
        with self._lock:
            self._load()
            if profile_id in (self._active, self.running):
                raise ValueError(tr("This account is in use: switch to another one first"))
            kept = [p for p in self._profiles if p["id"] != profile_id]
            if len(kept) == len(self._profiles):
                raise ValueError(tr("Unknown account"))
            self._profiles = kept
            self._save()
        self._publish()
        return self.snapshot()

    def select(self, profile_id):
        """Chosen for the next start; None: the login of the machine. True if the choice changed."""
        with self._lock:
            self._load()
            if profile_id is not None and not any(p["id"] == profile_id for p in self._profiles):
                raise ValueError(tr("Unknown account"))
            changed = profile_id != self._active
            self._active = profile_id
            self._save()
        self._publish()
        return changed

    def pending(self):
        """A switch waits for its restart."""
        with self._lock:
            self._load()
            return self._active != self.running

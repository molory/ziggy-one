"""Signed-in browsers: one random session per sign-in, instead of the access token in the cookie.

The token only proves who may sign in (`?login=` links, `?token=`); the browser receives a session id of its own.
A session can be signed out alone, from the account window, and ends after IDLE_LIFETIME without use.
The file (0600) keeps only a SHA-256 of each id: reading it does not give a working cookie.
"""

import hashlib
import secrets
import threading
import time
from pathlib import Path

from storage import read_json, write_json

IDLE_LIFETIME = 30 * 24 * 3600  # seconds without use before a session ends
COOKIE_MAX_AGE = 400 * 24 * 3600  # the browser keeps the cookie; the server decides (IDLE_LIFETIME)
SEEN_PRECISION = 3600  # "last used" written at most once an hour per session
MAX_SESSIONS = 200  # beyond that, the least recently used are signed out
MAX_AGENT = 300  # characters of User-Agent kept


def digest(session_id):
    return hashlib.sha256(str(session_id).encode()).hexdigest()


def public_id(key):
    """Identifier shown to the interface (to sign a browser out): part of the digest, never the session id."""
    return key[:16]


class BrowserSessions:
    def __init__(self, path):
        self._path = Path(path)
        self._lock = threading.Lock()
        raw = read_json(self._path, {})
        self._items = {
            key: entry for key, entry in (raw.items() if isinstance(raw, dict) else [])
            if isinstance(key, str) and len(key) == 64 and isinstance(entry, dict)
            and isinstance(entry.get("created"), (int, float)) and isinstance(entry.get("lastSeen"), (int, float))
        }

    def _save(self):
        # Called with _lock held.
        write_json(self._path, self._items)

    def _prune(self, now):
        # Called with _lock held: expired sessions, then the oldest beyond MAX_SESSIONS.
        alive = {k: e for k, e in self._items.items() if now - e["lastSeen"] <= IDLE_LIFETIME}
        if len(alive) > MAX_SESSIONS:
            kept = sorted(alive, key=lambda k: alive[k]["lastSeen"], reverse=True)[:MAX_SESSIONS]
            alive = {k: alive[k] for k in kept}
        changed = len(alive) != len(self._items)
        self._items = alive
        return changed

    def create(self, user_agent="", now=None):
        """New session for a browser that just signed in: returns its id (the cookie value)."""
        now = time.time() if now is None else now
        session_id = secrets.token_urlsafe(32)
        with self._lock:
            self._items[digest(session_id)] = {
                "created": now, "lastSeen": now, "agent": str(user_agent or "")[:MAX_AGENT],
            }
            self._prune(now)
            self._save()
        return session_id

    def check(self, session_id, now=None):
        """Digest of the session if the id is valid (and notes its use), otherwise None."""
        if not isinstance(session_id, str) or not session_id:
            return None
        now = time.time() if now is None else now
        key = digest(session_id)
        with self._lock:
            entry = self._items.get(key)
            if entry is None:
                return None
            if now - entry["lastSeen"] > IDLE_LIFETIME:
                del self._items[key]
                self._save()
                return None
            if now - entry["lastSeen"] >= SEEN_PRECISION:
                entry["lastSeen"] = now
                self._save()
        return key

    def alive(self, key):
        """The session (digest) still exists: an open event stream stops when it is signed out."""
        with self._lock:
            return key in self._items

    def list(self, current=None, now=None):
        """Signed-in browsers, most recently used first; `current`: digest of the asking browser."""
        now = time.time() if now is None else now
        with self._lock:
            if self._prune(now):
                self._save()
            items = sorted(self._items.items(), key=lambda item: item[1]["lastSeen"], reverse=True)
            return [{
                "id": public_id(key), "created": entry["created"], "lastSeen": entry["lastSeen"],
                "agent": entry.get("agent", ""), "current": key == current,
            } for key, entry in items]

    def sign_out(self, public, current=None):
        """Ends the session shown under this id; True if it was the asking browser's."""
        with self._lock:
            keys = [key for key in self._items if public_id(key) == public]
            for key in keys:
                del self._items[key]
            if keys:
                self._save()
        return current in keys

    def sign_out_others(self, current):
        """Ends every session except the asking browser's; returns how many."""
        with self._lock:
            others = [key for key in self._items if key != current]
            for key in others:
                del self._items[key]
            if others:
                self._save()
        return len(others)

    def sign_out_all(self):
        """New access token (`--new-token`): every browser signs in again."""
        with self._lock:
            if self._items:
                self._items = {}
                self._save()

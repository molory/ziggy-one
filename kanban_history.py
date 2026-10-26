"""History of Kanban tickets: every change, in an append-only log.

One JSON line per change in `kanban-history.jsonl` (0600), never rewritten: a write can only damage the
current line, which is ignored when read back. The log is read in full at startup and kept in memory,
grouped by ticket.

Each entry keeps the names as they were (columns, files): the history stays readable even if a column
is renamed or deleted later. The history of a deleted ticket stays in the log.
"""

import json
import os
import re
import threading
import time
from pathlib import Path

ID_RE = re.compile(r"^[0-9a-f]{12}$")
KINDS = {"created", "title", "description", "moved", "file_added", "file_removed", "deleted"}
MAX_TEXT = 20_000  # like a ticket description
MAX_AUTHOR = 80  # name of an agent
MAX_PER_TICKET = 500  # entries returned per ticket (the most recent)


class TicketHistory:
    def __init__(self, path):
        self._path = Path(path)
        self._lock = threading.Lock()
        self._entries = {}  # ticket → [entry, …] in order
        try:
            text = self._path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            text = ""
        # Last line cut (interrupted write): the next entry will start with a line break, otherwise it
        # would stick to the damaged piece and be lost with it.
        self._cut = bool(text) and not text.endswith("\n")
        for line in text.splitlines():
            try:
                entry = json.loads(line)
            except ValueError:
                continue  # damaged line (interrupted write): ignored
            if isinstance(entry, dict) and ID_RE.match(str(entry.get("ticket"))) and entry.get("kind") in KINDS:
                self._entries.setdefault(entry["ticket"], []).append(entry)

    def record(self, ticket_id, kind, by=None, **details):
        """Adds a change to the log (on disk first, then in memory). `by`: the agent that made the change
        (MCP tools), otherwise "user" (the interface)."""
        if kind not in KINDS:
            raise ValueError(f"unknown change: {kind}")
        author = by[:MAX_AUTHOR] if isinstance(by, str) and by.strip() else "user"
        entry = {"ticket": ticket_id, "at": time.time(), "kind": kind, "by": author}
        for key, value in details.items():
            entry[key] = value[:MAX_TEXT] if isinstance(value, str) else value
        line = (json.dumps(entry, ensure_ascii=False) + "\n").encode("utf-8")
        with self._lock:
            if self._cut:
                line = b"\n" + line
                self._cut = False
            self._path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            fd = os.open(self._path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            try:
                os.write(fd, line)  # a single write in append mode: the line arrives whole
            finally:
                os.close(fd)
            self._entries.setdefault(ticket_id, []).append(entry)
        return dict(entry)

    def of(self, ticket_id):
        """Changes of the ticket, oldest first."""
        with self._lock:
            return [dict(entry) for entry in self._entries.get(ticket_id, [])[-MAX_PER_TICKET:]]

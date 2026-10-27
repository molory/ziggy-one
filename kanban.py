"""Kanban boards (Tasks mode): boards, columns, tickets and their attached files.

Everything lives in a local JSON file (0600, written atomically); attached files are stored in a private
folder, one subfolder per ticket, and kept as long as the ticket exists. Every change is published on the
live stream: "kanbans" (the list of boards, for the sidebar) and "kanban_board" (the changed board, with
its tickets). Every change to a ticket is also recorded in its history (kanban_history.py) before being
published.

The order of the tickets in a column is their `position` (0, 1, 2…), renumbered on every move.
Each ticket has a unique number across all boards (#1, #2…), never reused: it identifies the ticket
(address /t/<number>, "#42" references between tickets or in conversations).
"""

import datetime
import json
import os
import re
import secrets
import shutil
import threading
import time
from pathlib import Path

from i18n import tr
from kanban_history import TicketHistory
from storage import read_json, write_json

ID_RE = re.compile(r"^[0-9a-f]{12}$")  # board, ticket
COLUMN_RE = re.compile(r"^[0-9a-f]{8}$")
FILE_RE = re.compile(r"^[0-9a-f]{16}$")
DUE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")  # delivery date of a ticket, a calendar day (no time, no time zone)


def clean_due(value):
    """Delivery date of a ticket: "YYYY-MM-DD", or None for no date (None or "" removes it). ValueError otherwise."""
    if value is None or value == "":
        return None
    if not isinstance(value, str) or not DUE_RE.match(value):
        raise ValueError(tr("Invalid delivery date (expected YYYY-MM-DD)"))
    try:
        datetime.date.fromisoformat(value)
    except ValueError:
        raise ValueError(tr("Invalid delivery date (expected YYYY-MM-DD)")) from None
    return value
MAX_BOARDS = 200
MAX_COLUMNS = 20
MAX_TICKETS = 2000  # per board
MAX_NAME = 80
MAX_COLUMN_NAME = 60
MAX_TITLE = 200
MAX_DESCRIPTION = 20_000
MAX_FILES = 20  # per ticket
MAX_FILE = 25 * 1024 * 1024
# English names, translated (tr) when a board is created: existing boards keep their columns.
DEFAULT_COLUMNS = (("To do", None), ("In progress", 35), ("Done", 140))
# Error messages of each text field: (invalid, empty).
FIELD_ERRORS = {
    "name": ("Invalid name", "Empty name"),
    "column": ("Invalid column", "Empty column"),
    "file name": ("Invalid file name", "Empty file name"),
    "board name": ("Invalid board name", "Empty board name"),
    "column name": ("Invalid column name", "Empty column name"),
    "title": ("Invalid title", "Empty title"),
    "description": ("Invalid description", "Empty description"),
}


def _text(value, limit, what, required=True):
    invalid, empty = FIELD_ERRORS[what]
    if not isinstance(value, str):
        raise ValueError(tr(invalid))
    value = " ".join(value.split())[:limit] if required else value[:limit]
    if required and not value:
        raise ValueError(tr(empty))
    return value


def clean_hue(hue):
    """Hue (0 to 359), or None for the neutral color."""
    if hue is None:
        return None
    if isinstance(hue, bool) or not isinstance(hue, int) or not 0 <= hue < 360:
        raise ValueError(tr("Invalid color (hue from 0 to 359)"))
    return hue


def clean_file_name(name):
    name = _text(name, 200, "file name").replace("/", "_").replace("\\", "_")
    return "_" + name if name.startswith(".") else name


class Kanban:
    def __init__(self, bus, path, files_dir, history_path=None):
        self._bus = bus
        self._path = Path(path)
        self._files = Path(files_dir)
        self.history = TicketHistory(history_path or self._path.with_name("kanban-history.jsonl"))
        self._lock = threading.Lock()
        data = read_json(self._path, {})
        data = data if isinstance(data, dict) else {}
        self._boards = [b for b in map(self._load_board, data.get("boards") or []) if b][:MAX_BOARDS]
        known = {board["id"]: board for board in self._boards}
        self._tickets = [t for t in (self._load_ticket(raw, known) for raw in data.get("tickets") or []) if t]
        self._next_number = data.get("nextNumber") if isinstance(data.get("nextNumber"), int) else 1
        if self._number_tickets():
            write_json(self._path, self._data())

    # --- defensive file reading ----------------------------------------------------------

    @staticmethod
    def _load_board(raw):
        if not isinstance(raw, dict) or not ID_RE.match(str(raw.get("id"))):
            return None
        try:
            name = _text(raw.get("name"), MAX_NAME, "name")
            hue = clean_hue(raw.get("hue"))
        except ValueError:
            return None
        columns = []
        for column in raw.get("columns") or []:
            if not isinstance(column, dict) or not COLUMN_RE.match(str(column.get("id"))):
                continue
            try:
                columns.append({"id": column["id"], "name": _text(column.get("name"), MAX_COLUMN_NAME, "column"),
                                "hue": clean_hue(column.get("hue"))})
            except ValueError:
                continue
        if not columns:
            return None
        stamp = raw.get("createdAt") if isinstance(raw.get("createdAt"), (int, float)) else 0
        return {"id": raw["id"], "name": name, "hue": hue, "columns": columns[:MAX_COLUMNS], "createdAt": stamp,
                "updatedAt": raw.get("updatedAt") if isinstance(raw.get("updatedAt"), (int, float)) else stamp}

    @staticmethod
    def _load_ticket(raw, boards):
        if not isinstance(raw, dict) or not ID_RE.match(str(raw.get("id"))) or raw.get("board") not in boards:
            return None
        if raw.get("column") not in {c["id"] for c in boards[raw["board"]]["columns"]}:
            return None
        try:
            title = _text(raw.get("title"), MAX_TITLE, "title")
        except ValueError:
            return None
        description = raw.get("description") if isinstance(raw.get("description"), str) else ""
        files = [
            {"id": f["id"], "name": str(f.get("name"))[:200], "type": str(f.get("type") or "")[:100],
             "size": f.get("size") if isinstance(f.get("size"), int) else 0}
            for f in raw.get("files") or [] if isinstance(f, dict) and FILE_RE.match(str(f.get("id")))
        ]
        stamp = raw.get("createdAt") if isinstance(raw.get("createdAt"), (int, float)) else 0
        try:
            due = clean_due(raw.get("due"))
        except ValueError:
            due = None  # damaged date: dropped, the ticket stays
        return {
            "id": raw["id"], "board": raw["board"], "column": raw["column"], "due": due,
            "position": raw.get("position") if isinstance(raw.get("position"), int) else 0,
            "title": title, "description": description[:MAX_DESCRIPTION], "files": files[:MAX_FILES],
            "number": raw.get("number") if isinstance(raw.get("number"), int) and raw["number"] > 0 else None,
            "agent": raw.get("agent") if isinstance(raw.get("agent"), str) else None,  # reserved: ticket assigned to an agent
            "createdAt": stamp,
            "updatedAt": raw.get("updatedAt") if isinstance(raw.get("updatedAt"), (int, float)) else stamp,
        }

    def _number_tickets(self):
        """Numbers the tickets that have no number (created before numbers existed) or a duplicate one.

        Oldest first. Returns True if something changed (to be saved).
        """
        seen = set()
        missing = []
        for ticket in sorted(self._tickets, key=lambda t: t["createdAt"]):
            if ticket["number"] is None or ticket["number"] in seen:
                missing.append(ticket)
            else:
                seen.add(ticket["number"])
        start = max([self._next_number, *(n + 1 for n in seen)])
        for offset, ticket in enumerate(missing):
            ticket["number"] = start + offset
        self._next_number = start + len(missing)
        return bool(missing)

    def _data(self):
        return {"boards": self._boards, "tickets": self._tickets, "nextNumber": self._next_number}

    # --- state ----------------------------------------------------------------------------------

    def _board(self, board_id):
        board = next((b for b in self._boards if b["id"] == board_id), None)
        if board is None:
            raise KeyError(tr("Unknown board"))
        return board

    def _ticket(self, ticket_id):
        ticket = next((t for t in self._tickets if t["id"] == ticket_id), None)
        if ticket is None:
            raise KeyError(tr("Unknown ticket"))
        return ticket

    def _column_tickets(self, board_id, column_id):
        tickets = [t for t in self._tickets if t["board"] == board_id and t["column"] == column_id]
        return sorted(tickets, key=lambda t: t["position"])

    def _summary(self, board):
        tickets = [t for t in self._tickets if t["board"] == board["id"]]
        return {**json.loads(json.dumps(board)), "ticketCount": len(tickets),
                "counts": {c["id"]: sum(1 for t in tickets if t["column"] == c["id"]) for c in board["columns"]}}

    def _board_data(self, board):
        tickets = sorted((t for t in self._tickets if t["board"] == board["id"]), key=lambda t: (t["column"], t["position"]))
        return {"board": self._summary(board), "tickets": json.loads(json.dumps(tickets))}

    def _changed(self, board=None, boards=False, deleted=None):
        # Called with _lock held.
        if board is not None:
            board["updatedAt"] = time.time()
        write_json(self._path, self._data())
        if boards or board is not None:
            self._bus.publish("kanbans", [self._summary(b) for b in self._boards])
        if board is not None:
            self._bus.publish("kanban_board", self._board_data(board))
        if deleted is not None:
            self._bus.publish("kanban_board", {"board": None, "deleted": deleted, "tickets": []})

    def list(self):
        with self._lock:
            return [self._summary(b) for b in self._boards]

    def get(self, board_id):
        with self._lock:
            return self._board_data(self._board(board_id))

    # --- boards ----------------------------------------------------------------------------------

    def create_board(self, name):
        name = _text(name, MAX_NAME, "board name")
        with self._lock:
            if len(self._boards) >= MAX_BOARDS:
                raise ValueError(tr("{count} boards at most", count=MAX_BOARDS))
            now = time.time()
            board = {"id": secrets.token_hex(6), "name": name, "hue": None,
                     "columns": [{"id": secrets.token_hex(4), "name": tr(n), "hue": h} for n, h in DEFAULT_COLUMNS],
                     "createdAt": now, "updatedAt": now}
            self._boards.append(board)
            self._changed(board)
            return self._summary(board)

    def update_board(self, board_id, changes):
        """Name and/or color: only the keys present ("name", "hue") are changed."""
        name = _text(changes["name"], MAX_NAME, "board name") if "name" in changes else None
        hue = clean_hue(changes["hue"]) if "hue" in changes else None
        with self._lock:
            board = self._board(board_id)
            if "name" in changes:
                board["name"] = name
            if "hue" in changes:
                board["hue"] = hue
            self._changed(board)

    def delete_board(self, board_id):
        """Deletes the board, its tickets and their files."""
        with self._lock:
            board = self._board(board_id)
            gone = [t["id"] for t in self._tickets if t["board"] == board_id]
            for ticket_id in gone:
                self.history.record(ticket_id, "deleted", reason=f"board \"{board['name']}\" deleted")
            self._tickets = [t for t in self._tickets if t["board"] != board_id]
            self._boards.remove(board)
            self._changed(boards=True, deleted=board_id)
        for ticket_id in gone:
            shutil.rmtree(self._files / ticket_id, ignore_errors=True)

    # --- columns ----------------------------------------------------------------------------------

    def _column(self, board, column_id):
        column = next((c for c in board["columns"] if c["id"] == column_id), None)
        if column is None:
            raise KeyError(tr("Unknown column"))
        return column

    def add_column(self, board_id, name, hue=None):
        name = _text(name, MAX_COLUMN_NAME, "column name")
        hue = clean_hue(hue)
        with self._lock:
            board = self._board(board_id)
            if len(board["columns"]) >= MAX_COLUMNS:
                raise ValueError(tr("{count} columns at most", count=MAX_COLUMNS))
            column = {"id": secrets.token_hex(4), "name": name, "hue": hue}
            board["columns"].append(column)
            self._changed(board)
            return dict(column)

    def update_column(self, board_id, column_id, changes):
        name = _text(changes["name"], MAX_COLUMN_NAME, "column name") if "name" in changes else None
        hue = clean_hue(changes["hue"]) if "hue" in changes else None
        with self._lock:
            board = self._board(board_id)
            column = self._column(board, column_id)
            if "name" in changes:
                column["name"] = name
            if "hue" in changes:
                column["hue"] = hue
            self._changed(board)

    def move_column(self, board_id, column_id, index):
        if isinstance(index, bool) or not isinstance(index, int):
            raise ValueError(tr("Invalid position"))
        with self._lock:
            board = self._board(board_id)
            column = self._column(board, column_id)
            board["columns"].remove(column)
            board["columns"].insert(max(0, min(index, len(board["columns"]))), column)
            self._changed(board)

    def delete_column(self, board_id, column_id, into=None):
        """Deletes a column; its tickets go to the end of `into` (required if the column is not empty)."""
        with self._lock:
            board = self._board(board_id)
            column = self._column(board, column_id)
            if len(board["columns"]) == 1:
                raise ValueError(tr("A board keeps at least one column"))
            moving = self._column_tickets(board_id, column_id)
            if moving:
                if into == column_id:
                    raise ValueError(tr("Choose another column for its tickets"))
                target = self._column(board, into) if isinstance(into, str) else None
                if target is None:
                    raise ValueError(tr("The column \"{name}\" contains tickets: choose where to move them", name=column["name"]))
                start = len(self._column_tickets(board_id, target["id"]))
                for offset, ticket in enumerate(moving):
                    ticket.update(column=target["id"], position=start + offset)
                    self.history.record(ticket["id"], "moved", fromColumn=column["name"], toColumn=target["name"],
                                        reason="column deleted")
            board["columns"].remove(column)
            self._changed(board)

    # --- tickets ----------------------------------------------------------------------------------

    def create_ticket(self, board_id, column_id, title, description="", by=None):
        title = _text(title, MAX_TITLE, "title")
        description = _text(description, MAX_DESCRIPTION, "description", required=False)
        with self._lock:
            board = self._board(board_id)
            self._column(board, column_id)
            if sum(1 for t in self._tickets if t["board"] == board_id) >= MAX_TICKETS:
                raise ValueError(tr("{count} tickets at most per board", count=MAX_TICKETS))
            now = time.time()
            ticket = {"id": secrets.token_hex(6), "number": self._next_number, "board": board_id, "column": column_id,
                      "position": len(self._column_tickets(board_id, column_id)), "title": title,
                      "description": description, "files": [], "agent": None, "due": None,
                      "createdAt": now, "updatedAt": now}
            self._next_number += 1  # never reused, even if the ticket is deleted
            self._tickets.append(ticket)
            self.history.record(ticket["id"], "created", by=by, column=self._column(board, column_id)["name"], title=title)
            self._changed(board)
            return dict(ticket)

    def update_ticket(self, ticket_id, changes, by=None):
        """Title, description and/or delivery date (`due`, None to remove it): only the keys present are changed."""
        title = _text(changes["title"], MAX_TITLE, "title") if "title" in changes else None
        due = clean_due(changes["due"]) if "due" in changes else None
        description = (_text(changes["description"], MAX_DESCRIPTION, "description", required=False)
                       if "description" in changes else None)
        with self._lock:
            ticket = self._ticket(ticket_id)
            changed = False
            # Only real changes are recorded (saving without changing anything leaves no trace).
            if "title" in changes and title != ticket["title"]:
                self.history.record(ticket_id, "title", by=by, before=ticket["title"], after=title)
                ticket["title"] = title
                changed = True
            if "description" in changes and description != ticket["description"]:
                self.history.record(ticket_id, "description", by=by, before=ticket["description"], after=description)
                ticket["description"] = description
                changed = True
            if "due" in changes and due != ticket.get("due"):
                self.history.record(ticket_id, "due", by=by, before=ticket.get("due"), after=due)
                ticket["due"] = due
                changed = True
            if changed:
                ticket["updatedAt"] = time.time()
                self._changed(self._board(ticket["board"]))

    def move_ticket(self, ticket_id, column_id, index, by=None):
        """Puts the ticket at position `index` of the column (clamped), and renumbers the affected columns."""
        if isinstance(index, bool) or not isinstance(index, int):
            raise ValueError(tr("Invalid position"))
        with self._lock:
            ticket = self._ticket(ticket_id)
            board = self._board(ticket["board"])
            target_column = self._column(board, column_id)
            if column_id != ticket["column"]:  # a mere reordering within the column is not recorded
                self.history.record(ticket_id, "moved", by=by, fromColumn=self._column(board, ticket["column"])["name"],
                                    toColumn=target_column["name"])
            source = [t for t in self._column_tickets(board["id"], ticket["column"]) if t is not ticket]
            for position, other in enumerate(source):
                other["position"] = position
            target = source if column_id == ticket["column"] else self._column_tickets(board["id"], column_id)
            target.insert(max(0, min(index, len(target))), ticket)
            ticket["column"] = column_id
            for position, other in enumerate(target):
                other["position"] = position
            self._changed(board)

    def delete_ticket(self, ticket_id):
        with self._lock:
            ticket = self._ticket(ticket_id)
            board = self._board(ticket["board"])
            self.history.record(ticket_id, "deleted", title=ticket["title"])
            self._tickets.remove(ticket)
            for position, other in enumerate(self._column_tickets(board["id"], ticket["column"])):
                other["position"] = position
            self._changed(board)
        shutil.rmtree(self._files / ticket_id, ignore_errors=True)

    # --- attached files -----------------------------------------------------------------------------

    def add_file(self, ticket_id, name, media_type, data):
        name = clean_file_name(name)
        media_type = media_type if isinstance(media_type, str) and len(media_type) <= 100 else ""
        if len(data) > MAX_FILE:
            raise ValueError(tr("File too large ({size} MB at most)", size=MAX_FILE // (1024 * 1024)))
        with self._lock:
            ticket = self._ticket(ticket_id)
            if len(ticket["files"]) >= MAX_FILES:
                raise ValueError(tr("{count} files at most per ticket", count=MAX_FILES))
            entry = {"id": secrets.token_hex(8), "name": name, "type": media_type, "size": len(data)}
            self._files.mkdir(parents=True, exist_ok=True, mode=0o700)
            folder = self._files / ticket_id
            folder.mkdir(exist_ok=True, mode=0o700)
            fd = os.open(folder / entry["id"], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as file:
                file.write(data)
            ticket["files"].append(entry)
            self.history.record(ticket_id, "file_added", name=name, size=len(data))
            ticket["updatedAt"] = time.time()
            self._changed(self._board(ticket["board"]))
            return dict(entry)

    def find_number(self, number):
        """Ticket with this number: {board, ticket}; KeyError if it does not exist (or no longer exists)."""
        with self._lock:
            ticket = next((t for t in self._tickets if t["number"] == number), None)
            if ticket is None:
                raise KeyError(tr("Ticket #{number} not found", number=number))
            return {"board": ticket["board"], "ticket": ticket["id"], "number": number}

    def export(self, number):
        """Everything needed to read a ticket outside Ziggy (link shared with an agent); KeyError if it does not exist."""
        with self._lock:
            ticket = next((t for t in self._tickets if t["number"] == number), None)
            if ticket is None:
                raise KeyError(tr("Ticket #{number} not found", number=number))
            board = self._board(ticket["board"])
            columns = {c["id"]: c["name"] for c in board["columns"]}
            titles = {t["number"]: (t["title"], columns.get(t["column"], "")) for t in self._tickets if t["board"] == board["id"]}
            others = {t["number"]: (t["title"], "") for t in self._tickets if t["board"] != board["id"]}
            return {
                "ticket": json.loads(json.dumps(ticket)),
                "board": board["name"],
                "column": columns.get(ticket["column"], ""),
                "known": {**others, **titles},  # number → (title, column): for cited tickets
                "history": self.history.of(ticket["id"]),
            }

    def index(self):
        """All tickets in brief (number, title, board): to turn "#42" into a link."""
        with self._lock:
            names = {b["id"]: b["name"] for b in self._boards}
            return [{"number": t["number"], "id": t["id"], "board": t["board"], "boardName": names.get(t["board"], ""),
                     "title": t["title"]} for t in self._tickets]

    def ticket_history(self, ticket_id):
        """Changes of an existing ticket, oldest first; KeyError if it does not exist."""
        with self._lock:
            self._ticket(ticket_id)
        return self.history.of(ticket_id)

    def file(self, ticket_id, file_id):
        """(path, name, type) of an attached file; KeyError if it does not exist."""
        with self._lock:
            ticket = self._ticket(ticket_id)
            entry = next((f for f in ticket["files"] if f["id"] == file_id), None)
            if entry is None:
                raise KeyError(tr("Unknown file"))
            return self._files / ticket_id / file_id, entry["name"], entry["type"]

    def delete_file(self, ticket_id, file_id):
        with self._lock:
            ticket = self._ticket(ticket_id)
            entry = next((f for f in ticket["files"] if f["id"] == file_id), None)
            if entry is None:
                raise KeyError(tr("Unknown file"))
            ticket["files"].remove(entry)
            self.history.record(ticket_id, "file_removed", name=entry["name"])
            ticket["updatedAt"] = time.time()
            self._changed(self._board(ticket["board"]))
        (self._files / ticket_id / file_id).unlink(missing_ok=True)

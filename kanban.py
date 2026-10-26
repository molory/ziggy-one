"""Tableaux Kanban (mode Tâches) : tableaux, colonnes, tickets et leurs fichiers joints.

Tout tient dans un fichier JSON local (0600, écrit atomiquement) ; les fichiers joints sont rangés dans
un dossier privé, un sous-dossier par ticket, et gardés tant que le ticket existe. Chaque modification
est publiée sur le flux temps réel : « kanbans » (la liste des tableaux, pour la barre latérale) et
« kanban_board » (le tableau modifié, avec ses tickets). Chaque changement d'un ticket est aussi noté
dans son historique (kanban_history.py), avant d'être publié.

L'ordre des tickets d'une colonne est leur `position` (0, 1, 2…), renumérotée à chaque déplacement.
Chaque ticket a un numéro unique, tous tableaux confondus (#1, #2…), jamais réutilisé : il sert à le
désigner (adresse /t/<numéro>, références « #42 » entre tickets ou dans les discussions).
"""

import json
import os
import re
import secrets
import shutil
import threading
import time
from pathlib import Path

from kanban_history import TicketHistory
from storage import read_json, write_json

ID_RE = re.compile(r"^[0-9a-f]{12}$")  # tableau, ticket
COLUMN_RE = re.compile(r"^[0-9a-f]{8}$")
FILE_RE = re.compile(r"^[0-9a-f]{16}$")
MAX_BOARDS = 200
MAX_COLUMNS = 20
MAX_TICKETS = 2000  # par tableau
MAX_NAME = 80
MAX_COLUMN_NAME = 60
MAX_TITLE = 200
MAX_DESCRIPTION = 20_000
MAX_FILES = 20  # par ticket
MAX_FILE = 25 * 1024 * 1024
DEFAULT_COLUMNS = (("À faire", None), ("En cours", 35), ("Fait", 140))


def _text(value, limit, what, required=True):
    if not isinstance(value, str):
        raise ValueError(f"{what} invalide")
    value = " ".join(value.split())[:limit] if required else value[:limit]
    if required and not value:
        raise ValueError(f"{what} vide")
    return value


def clean_hue(hue):
    """Teinte (0 à 359), ou None pour la couleur neutre."""
    if hue is None:
        return None
    if isinstance(hue, bool) or not isinstance(hue, int) or not 0 <= hue < 360:
        raise ValueError("couleur invalide (teinte de 0 à 359)")
    return hue


def clean_file_name(name):
    name = _text(name, 200, "nom de fichier").replace("/", "_").replace("\\", "_")
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

    # --- lecture défensive du fichier -----------------------------------------------------

    @staticmethod
    def _load_board(raw):
        if not isinstance(raw, dict) or not ID_RE.match(str(raw.get("id"))):
            return None
        try:
            name = _text(raw.get("name"), MAX_NAME, "nom")
            hue = clean_hue(raw.get("hue"))
        except ValueError:
            return None
        columns = []
        for column in raw.get("columns") or []:
            if not isinstance(column, dict) or not COLUMN_RE.match(str(column.get("id"))):
                continue
            try:
                columns.append({"id": column["id"], "name": _text(column.get("name"), MAX_COLUMN_NAME, "colonne"),
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
            title = _text(raw.get("title"), MAX_TITLE, "titre")
        except ValueError:
            return None
        description = raw.get("description") if isinstance(raw.get("description"), str) else ""
        files = [
            {"id": f["id"], "name": str(f.get("name"))[:200], "type": str(f.get("type") or "")[:100],
             "size": f.get("size") if isinstance(f.get("size"), int) else 0}
            for f in raw.get("files") or [] if isinstance(f, dict) and FILE_RE.match(str(f.get("id")))
        ]
        stamp = raw.get("createdAt") if isinstance(raw.get("createdAt"), (int, float)) else 0
        return {
            "id": raw["id"], "board": raw["board"], "column": raw["column"],
            "position": raw.get("position") if isinstance(raw.get("position"), int) else 0,
            "title": title, "description": description[:MAX_DESCRIPTION], "files": files[:MAX_FILES],
            "number": raw.get("number") if isinstance(raw.get("number"), int) and raw["number"] > 0 else None,
            "agent": raw.get("agent") if isinstance(raw.get("agent"), str) else None,  # réservé : ticket confié à un agent
            "createdAt": stamp,
            "updatedAt": raw.get("updatedAt") if isinstance(raw.get("updatedAt"), (int, float)) else stamp,
        }

    def _number_tickets(self):
        """Numérote les tickets qui n'en ont pas (créés avant les numéros) ou dont le numéro est en double.

        Les plus anciens d'abord. Retourne True si quelque chose a changé (à enregistrer).
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

    # --- état ---------------------------------------------------------------------------------

    def _board(self, board_id):
        board = next((b for b in self._boards if b["id"] == board_id), None)
        if board is None:
            raise KeyError("tableau inconnu")
        return board

    def _ticket(self, ticket_id):
        ticket = next((t for t in self._tickets if t["id"] == ticket_id), None)
        if ticket is None:
            raise KeyError("ticket inconnu")
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
        # Appelé avec _lock acquis.
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

    # --- tableaux --------------------------------------------------------------------------------

    def create_board(self, name):
        name = _text(name, MAX_NAME, "nom du tableau")
        with self._lock:
            if len(self._boards) >= MAX_BOARDS:
                raise ValueError(f"{MAX_BOARDS} tableaux au maximum")
            now = time.time()
            board = {"id": secrets.token_hex(6), "name": name, "hue": None,
                     "columns": [{"id": secrets.token_hex(4), "name": n, "hue": h} for n, h in DEFAULT_COLUMNS],
                     "createdAt": now, "updatedAt": now}
            self._boards.append(board)
            self._changed(board)
            return self._summary(board)

    def update_board(self, board_id, changes):
        """Nom et/ou couleur : seules les clés présentes (« name », « hue ») sont modifiées."""
        name = _text(changes["name"], MAX_NAME, "nom du tableau") if "name" in changes else None
        hue = clean_hue(changes["hue"]) if "hue" in changes else None
        with self._lock:
            board = self._board(board_id)
            if "name" in changes:
                board["name"] = name
            if "hue" in changes:
                board["hue"] = hue
            self._changed(board)

    def delete_board(self, board_id):
        """Supprime le tableau, ses tickets et leurs fichiers."""
        with self._lock:
            board = self._board(board_id)
            gone = [t["id"] for t in self._tickets if t["board"] == board_id]
            for ticket_id in gone:
                self.history.record(ticket_id, "deleted", reason=f"tableau « {board['name']} » supprimé")
            self._tickets = [t for t in self._tickets if t["board"] != board_id]
            self._boards.remove(board)
            self._changed(boards=True, deleted=board_id)
        for ticket_id in gone:
            shutil.rmtree(self._files / ticket_id, ignore_errors=True)

    # --- colonnes ---------------------------------------------------------------------------------

    def _column(self, board, column_id):
        column = next((c for c in board["columns"] if c["id"] == column_id), None)
        if column is None:
            raise KeyError("colonne inconnue")
        return column

    def add_column(self, board_id, name, hue=None):
        name = _text(name, MAX_COLUMN_NAME, "nom de la colonne")
        hue = clean_hue(hue)
        with self._lock:
            board = self._board(board_id)
            if len(board["columns"]) >= MAX_COLUMNS:
                raise ValueError(f"{MAX_COLUMNS} colonnes au maximum")
            column = {"id": secrets.token_hex(4), "name": name, "hue": hue}
            board["columns"].append(column)
            self._changed(board)
            return dict(column)

    def update_column(self, board_id, column_id, changes):
        name = _text(changes["name"], MAX_COLUMN_NAME, "nom de la colonne") if "name" in changes else None
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
            raise ValueError("position invalide")
        with self._lock:
            board = self._board(board_id)
            column = self._column(board, column_id)
            board["columns"].remove(column)
            board["columns"].insert(max(0, min(index, len(board["columns"]))), column)
            self._changed(board)

    def delete_column(self, board_id, column_id, into=None):
        """Supprime une colonne ; ses tickets vont à la fin de `into` (obligatoire si elle n'est pas vide)."""
        with self._lock:
            board = self._board(board_id)
            column = self._column(board, column_id)
            if len(board["columns"]) == 1:
                raise ValueError("un tableau garde au moins une colonne")
            moving = self._column_tickets(board_id, column_id)
            if moving:
                if into == column_id:
                    raise ValueError("choisis une autre colonne pour ses tickets")
                target = self._column(board, into) if isinstance(into, str) else None
                if target is None:
                    raise ValueError(f"la colonne « {column['name']} » contient des tickets : choisis où les déplacer")
                start = len(self._column_tickets(board_id, target["id"]))
                for offset, ticket in enumerate(moving):
                    ticket.update(column=target["id"], position=start + offset)
                    self.history.record(ticket["id"], "moved", fromColumn=column["name"], toColumn=target["name"],
                                        reason="colonne supprimée")
            board["columns"].remove(column)
            self._changed(board)

    # --- tickets ----------------------------------------------------------------------------------

    def create_ticket(self, board_id, column_id, title, description="", by=None):
        title = _text(title, MAX_TITLE, "titre")
        description = _text(description, MAX_DESCRIPTION, "description", required=False)
        with self._lock:
            board = self._board(board_id)
            self._column(board, column_id)
            if sum(1 for t in self._tickets if t["board"] == board_id) >= MAX_TICKETS:
                raise ValueError(f"{MAX_TICKETS} tickets au maximum par tableau")
            now = time.time()
            ticket = {"id": secrets.token_hex(6), "number": self._next_number, "board": board_id, "column": column_id,
                      "position": len(self._column_tickets(board_id, column_id)), "title": title,
                      "description": description, "files": [], "agent": None, "createdAt": now, "updatedAt": now}
            self._next_number += 1  # jamais réutilisé, même si le ticket est supprimé
            self._tickets.append(ticket)
            self.history.record(ticket["id"], "created", by=by, column=self._column(board, column_id)["name"], title=title)
            self._changed(board)
            return dict(ticket)

    def update_ticket(self, ticket_id, changes, by=None):
        """Titre et/ou description : seules les clés présentes sont modifiées."""
        title = _text(changes["title"], MAX_TITLE, "titre") if "title" in changes else None
        description = (_text(changes["description"], MAX_DESCRIPTION, "description", required=False)
                       if "description" in changes else None)
        with self._lock:
            ticket = self._ticket(ticket_id)
            changed = False
            # Seuls les vrais changements sont notés (enregistrer sans rien modifier ne laisse pas de trace).
            if "title" in changes and title != ticket["title"]:
                self.history.record(ticket_id, "title", by=by, before=ticket["title"], after=title)
                ticket["title"] = title
                changed = True
            if "description" in changes and description != ticket["description"]:
                self.history.record(ticket_id, "description", by=by, before=ticket["description"], after=description)
                ticket["description"] = description
                changed = True
            if changed:
                ticket["updatedAt"] = time.time()
                self._changed(self._board(ticket["board"]))

    def move_ticket(self, ticket_id, column_id, index, by=None):
        """Place le ticket à la position `index` de la colonne (bornée), et renumérote les colonnes touchées."""
        if isinstance(index, bool) or not isinstance(index, int):
            raise ValueError("position invalide")
        with self._lock:
            ticket = self._ticket(ticket_id)
            board = self._board(ticket["board"])
            target_column = self._column(board, column_id)
            if column_id != ticket["column"]:  # un simple changement de rang dans la colonne n'est pas noté
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

    # --- fichiers joints ----------------------------------------------------------------------------

    def add_file(self, ticket_id, name, media_type, data):
        name = clean_file_name(name)
        media_type = media_type if isinstance(media_type, str) and len(media_type) <= 100 else ""
        if len(data) > MAX_FILE:
            raise ValueError(f"fichier trop gros ({MAX_FILE // (1024 * 1024)} Mo au maximum)")
        with self._lock:
            ticket = self._ticket(ticket_id)
            if len(ticket["files"]) >= MAX_FILES:
                raise ValueError(f"{MAX_FILES} fichiers au maximum par ticket")
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
        """Ticket portant ce numéro : {board, ticket} ; KeyError s'il n'existe pas (ou plus)."""
        with self._lock:
            ticket = next((t for t in self._tickets if t["number"] == number), None)
            if ticket is None:
                raise KeyError(f"ticket #{number} introuvable")
            return {"board": ticket["board"], "ticket": ticket["id"], "number": number}

    def export(self, number):
        """Tout ce qu'il faut pour lire un ticket hors de Ziggy (lien partagé à un agent) ; KeyError s'il n'existe pas."""
        with self._lock:
            ticket = next((t for t in self._tickets if t["number"] == number), None)
            if ticket is None:
                raise KeyError(f"ticket #{number} introuvable")
            board = self._board(ticket["board"])
            columns = {c["id"]: c["name"] for c in board["columns"]}
            titles = {t["number"]: (t["title"], columns.get(t["column"], "")) for t in self._tickets if t["board"] == board["id"]}
            others = {t["number"]: (t["title"], "") for t in self._tickets if t["board"] != board["id"]}
            return {
                "ticket": json.loads(json.dumps(ticket)),
                "board": board["name"],
                "column": columns.get(ticket["column"], ""),
                "known": {**others, **titles},  # numéro → (titre, colonne) : pour les tickets cités
                "history": self.history.of(ticket["id"]),
            }

    def index(self):
        """Tous les tickets en bref (numéro, titre, tableau) : pour transformer « #42 » en lien."""
        with self._lock:
            names = {b["id"]: b["name"] for b in self._boards}
            return [{"number": t["number"], "id": t["id"], "board": t["board"], "boardName": names.get(t["board"], ""),
                     "title": t["title"]} for t in self._tickets]

    def ticket_history(self, ticket_id):
        """Changements d'un ticket existant, du plus ancien au plus récent ; KeyError s'il n'existe pas."""
        with self._lock:
            self._ticket(ticket_id)
        return self.history.of(ticket_id)

    def file(self, ticket_id, file_id):
        """(chemin, nom, type) d'un fichier joint ; KeyError s'il n'existe pas."""
        with self._lock:
            ticket = self._ticket(ticket_id)
            entry = next((f for f in ticket["files"] if f["id"] == file_id), None)
            if entry is None:
                raise KeyError("fichier inconnu")
            return self._files / ticket_id / file_id, entry["name"], entry["type"]

    def delete_file(self, ticket_id, file_id):
        with self._lock:
            ticket = self._ticket(ticket_id)
            entry = next((f for f in ticket["files"] if f["id"] == file_id), None)
            if entry is None:
                raise KeyError("fichier inconnu")
            ticket["files"].remove(entry)
            self.history.record(ticket_id, "file_removed", name=entry["name"])
            ticket["updatedAt"] = time.time()
            self._changed(self._board(ticket["board"]))
        (self._files / ticket_id / file_id).unlink(missing_ok=True)

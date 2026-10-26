"""Historique des tickets Kanban : chaque changement, dans un journal en ajout seul.

Une ligne JSON par changement dans `kanban-history.jsonl` (0600), jamais réécrite : une écriture ne
peut abîmer que la ligne en cours, ignorée à la relecture. Le journal est relu en entier au démarrage
et gardé en mémoire, rangé par ticket.

Chaque entrée garde les noms tels qu'ils étaient (colonnes, fichiers) : l'historique reste lisible même
si une colonne est renommée ou supprimée ensuite. L'historique d'un ticket supprimé reste dans le journal.
"""

import json
import os
import re
import threading
import time
from pathlib import Path

ID_RE = re.compile(r"^[0-9a-f]{12}$")
KINDS = {"created", "title", "description", "moved", "file_added", "file_removed", "deleted"}
MAX_TEXT = 20_000  # comme une description de ticket
MAX_AUTHOR = 80  # nom d'un agent
MAX_PER_TICKET = 500  # entrées renvoyées par ticket (les plus récentes)


class TicketHistory:
    def __init__(self, path):
        self._path = Path(path)
        self._lock = threading.Lock()
        self._entries = {}  # ticket → [entrée, …] dans l'ordre
        try:
            text = self._path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            text = ""
        # Dernière ligne coupée (écriture interrompue) : la prochaine entrée commencera par un saut de
        # ligne, sinon elle se collerait au morceau abîmé et serait perdue avec lui.
        self._cut = bool(text) and not text.endswith("\n")
        for line in text.splitlines():
            try:
                entry = json.loads(line)
            except ValueError:
                continue  # ligne abîmée (écriture interrompue) : ignorée
            if isinstance(entry, dict) and ID_RE.match(str(entry.get("ticket"))) and entry.get("kind") in KINDS:
                self._entries.setdefault(entry["ticket"], []).append(entry)

    def record(self, ticket_id, kind, by=None, **details):
        """Ajoute un changement au journal (sur disque d'abord, puis en mémoire). `by` : l'agent auteur
        du changement (outils MCP), sinon « user » (l'interface)."""
        if kind not in KINDS:
            raise ValueError(f"changement inconnu : {kind}")
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
                os.write(fd, line)  # une seule écriture en mode ajout : la ligne arrive entière
            finally:
                os.close(fd)
            self._entries.setdefault(ticket_id, []).append(entry)
        return dict(entry)

    def of(self, ticket_id):
        """Changements du ticket, du plus ancien au plus récent."""
        with self._lock:
            return [dict(entry) for entry in self._entries.get(ticket_id, [])[-MAX_PER_TICKET:]]

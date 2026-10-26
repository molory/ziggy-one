"""Agents ouverts dans ziggy-one : un dossier, une session Claude Code, et son état.

Claude Code tourne dans l'onglet Terminal de l'agent (terminal.py). Ce module ne lance rien : il garde
pour chaque agent son dossier, sa session (connue dès que Claude Code l'a créée ou reprise) et s'il est
au travail, d'après les hooks de Claude Code et le registre de ses sessions.

Un agent est désigné par sa discussion (identifiant ziggy-one, 12 caractères hexadécimaux) tant
que sa session n'a pas d'historique, puis par sa session Claude Code.

Les agents ouverts sont enregistrés (conversations.json) : ils restent dans la liste après un redémarrage
du serveur, même sans aucun message, jusqu'à ce qu'on les supprime.
"""

import json
import re
import secrets
import threading
import time
from pathlib import Path

from storage import is_agent_key, read_json, write_json

NEW_LABEL = "Nouvel agent"
CONVERSATION_ID_RE = re.compile(r"^[0-9a-f]{12}$")


def parse_json_line(line):
    try:
        value = json.loads(line)
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


class Conversation:
    """Un agent ouvert ici. `prompt` : son dernier message (hook UserPromptSubmit), pour le bilan du tour."""

    def __init__(self, manager, conversation_id, cwd, resume_from=None, label=""):
        self._manager = manager
        self._lock = threading.Lock()
        self.id = conversation_id
        self.cwd = cwd
        self.resume_from = resume_from
        self.label = label or NEW_LABEL
        self.git = manager.in_git_repo(cwd)  # dossier dans un dépôt git ?
        self.session_id = None
        self.busy = False
        self.waiting = None  # ce que l'agent attend de toi : "permission", "question", ou None
        self.prompt = ""
        self.last_activity = time.time()

    def status(self):
        with self._lock:
            return {
                "id": self.id,
                "label": self.label,
                "cwd": self.cwd,
                "git": self.git,
                "sessionId": self.session_id,
                "resumeFrom": self.resume_from,
                "busy": self.busy,
                "waiting": self.waiting,
                "lastActivity": self.last_activity,
            }

    def _publish_status(self):
        self._manager.bus.publish("status", self.status())

    def adopt_session(self, session_id):
        """Session utilisée par Claude Code (créée, reprise, ou changée par /clear, /resume).

        Adoptée seulement une fois son historique écrit : une session que Claude Code ouvre puis laisse
        vide (ou quitte aussitôt pour une autre) n'emporte pas le nom, les épingles ni le workspace de
        l'agent, qui disparaîtrait avec elle au redémarrage.
        """
        if not self._manager.has_history(session_id):
            return
        with self._lock:
            if session_id == self.session_id:
                return
            previous, self.session_id = self.session_id, session_id
        self._manager.session_started(self.id, session_id, previous)
        self._publish_status()

    def set_waiting(self, kind):
        """L'agent attend ta réponse (« permission », « question ») ou plus (None) ; publié s'il change."""
        with self._lock:
            if kind == self.waiting:
                return False
            self.waiting = kind
        self._publish_status()
        return True

    def set_busy(self, busy, prompt=None):
        """Au travail ou non ; retourne True si l'état a changé."""
        with self._lock:
            if prompt is not None:
                self.prompt = prompt
            labelled = self.label == NEW_LABEL
            if prompt is not None and self.label == NEW_LABEL and prompt.strip():
                self.label = prompt.strip().splitlines()[0][:80]
            changed = busy != self.busy
            self.busy = busy
            self.last_activity = time.time()
        if labelled and self.label != NEW_LABEL:
            self._manager.save()  # premier message : son nom par défaut est enregistré
        if changed or prompt is not None:
            self._publish_status()
        return changed


class ConversationManager:
    """Les agents ouverts dans ziggy-one, enregistrés pour être retrouvés au redémarrage du serveur."""

    def __init__(self, bus, default_cwd, in_git_repo=lambda cwd: False, on_session_started=None,
                 has_history=lambda session_id: True, path=None):
        self.bus = bus
        self.default_cwd = default_cwd
        self.in_git_repo = in_git_repo
        self.has_history = has_history  # la session a-t-elle un historique sur disque ?
        self._on_session_started = on_session_started
        self._lock = threading.Lock()
        self._path = Path(path) if path else None
        self._conversations = self._load()

    # --- fichier ------------------------------------------------------------------------

    def _load(self):
        """Agents ouverts avant le redémarrage, au repos ; un fichier absent ou abîmé n'en donne aucun."""
        conversations = {}
        data = read_json(self._path, []) if self._path else []
        for raw in data if isinstance(data, list) else []:
            if not isinstance(raw, dict) or not CONVERSATION_ID_RE.match(str(raw.get("id"))):
                continue
            if not isinstance(raw.get("cwd"), str) or not raw["cwd"]:
                continue
            resume = raw.get("resumeFrom") if is_agent_key(raw.get("resumeFrom")) else None
            label = raw.get("label") if isinstance(raw.get("label"), str) else ""
            conversation = Conversation(self, raw["id"], raw["cwd"], resume, label[:200])
            if is_agent_key(raw.get("sessionId")):
                conversation.session_id = raw["sessionId"]
            if isinstance(raw.get("lastActivity"), (int, float)):
                conversation.last_activity = raw["lastActivity"]
            conversations[conversation.id] = conversation
        return conversations

    def save(self):
        """Enregistre les agents ouverts (dossier, session, nom par défaut), pour les retrouver au redémarrage."""
        if self._path is None:
            return
        keep = ("id", "cwd", "sessionId", "resumeFrom", "label", "lastActivity")
        with self._lock:
            records = [{key: c.status()[key] for key in keep} for c in self._conversations.values()]
            write_json(self._path, records)

    def get(self, conversation_id):
        with self._lock:
            return self._conversations.get(conversation_id)

    def _all(self):
        with self._lock:
            return list(self._conversations.values())

    def list(self):
        statuses = [c.status() for c in self._all()]
        return sorted(statuses, key=lambda s: s["lastActivity"], reverse=True)

    def session_started(self, conversation_id, session_id, previous=None):
        """Un agent vient d'obtenir (ou de changer de) session Claude Code ; `previous` : l'ancienne."""
        self.save()
        if self._on_session_started is not None:
            self._on_session_started(conversation_id, session_id, previous)

    def find_by_session(self, session_id):
        for conversation in self._all():
            if session_id in (conversation.session_id, conversation.resume_from):
                return conversation
        return None

    def open(self, resume=None, cwd=None, label=""):
        """Agent pour une session (celui qui la suit déjà, sinon un nouveau), ou un agent vierge."""
        if resume is not None:
            existing = self.find_by_session(resume)
            if existing is not None:
                return existing
        conversation = Conversation(self, secrets.token_hex(6), cwd or self.default_cwd, resume, label)
        with self._lock:
            self._conversations[conversation.id] = conversation
        self.save()
        self.bus.publish("status", conversation.status())
        return conversation

    def remove(self, conversation_id):
        with self._lock:
            conversation = self._conversations.pop(conversation_id, None)
        if conversation is None:
            return False
        self.save()
        self.bus.publish("conversation_removed", {"conversation": conversation_id})
        return True

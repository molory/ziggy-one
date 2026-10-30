"""Agents open in ziggy-one: a folder, a Claude Code session, and its state.

Claude Code runs in the agent's Terminal tab (terminal.py). This module launches nothing: it keeps
for each agent its folder, its session (known as soon as Claude Code has created or resumed it) and whether
it is working, from the Claude Code hooks and its session registry.

An agent is identified by its conversation (ziggy-one id, 12 hexadecimal characters) as long as
its session has no history, then by its Claude Code session.

Open agents are saved (conversations.json): they stay in the list after a server restart,
even without any message, until they are deleted.
"""

import json
import re
import secrets
import threading
import time
from pathlib import Path

from i18n import tr
from storage import is_agent_key, read_json, write_json

# Default name, stored in English and translated when shown (status()); "Nouvel agent" is the old stored form.
NEW_LABEL = "New agent"
LEGACY_NEW_LABELS = ("Nouvel agent",)
CONVERSATION_ID_RE = re.compile(r"^[0-9a-f]{12}$")


def parse_json_line(line):
    try:
        value = json.loads(line)
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


class Conversation:
    """An agent open here. `prompt`: its last message (UserPromptSubmit hook), for the turn summary."""

    def __init__(self, manager, conversation_id, cwd, resume_from=None, label="", intro=""):
        self._manager = manager
        self._lock = threading.Lock()
        self.id = conversation_id
        self.cwd = cwd
        self.resume_from = resume_from
        self.label = label if label and label not in LEGACY_NEW_LABELS else NEW_LABEL
        self.git = manager.in_git_repo(cwd)  # folder inside a git repository?
        self.intro = intro  # first message, sent when Claude Code starts without a session (ZiggyBoss)
        self.introducing = False  # Claude Code started with `intro`: until the end of that first turn
        self.session_id = None
        self.busy = False
        self.waiting = None  # what the agent waits for from you: "permission", "question", or None
        self.prompt = ""
        self.last_activity = time.time()

    def status(self):
        with self._lock:
            return {
                "id": self.id,
                "label": tr(NEW_LABEL) if self.label == NEW_LABEL else self.label,
                "cwd": self.cwd,
                "git": self.git,
                "sessionId": self.session_id,
                "resumeFrom": self.resume_from,
                "busy": self.busy,
                "waiting": self.waiting,
                "lastActivity": self.last_activity,
                "intro": bool(self.intro),
                "introducing": self.introducing,
            }

    def _publish_status(self):
        self._manager.bus.publish("status", self.status())

    def adopt_session(self, session_id):
        """Session used by Claude Code (created, resumed, or changed by /clear, /resume).

        Adopted only once its history is written: a session that Claude Code opens then leaves
        empty (or quits right away for another) does not take the agent's name, pins or workspace
        along, which would vanish with it on restart.
        """
        if not self._manager.has_history(session_id):
            return
        with self._lock:
            if session_id == self.session_id:
                return
            previous, self.session_id = self.session_id, session_id
        self._manager.session_started(self.id, session_id, previous)
        self._publish_status()

    def intro_started(self):
        """Claude Code has just started with `intro` as its first message: it is used, not sent again."""
        with self._lock:
            self.intro, self.introducing = "", True
        self._manager.save()
        self._publish_status()

    def intro_stopped(self):
        """Its terminal closed: no more introduction under way (finished or not)."""
        with self._lock:
            if not self.introducing:
                return
            self.introducing = False
        self._publish_status()

    def set_waiting(self, kind):
        """The agent waits for your answer ("permission", "question") or no longer does (None); published if it changes."""
        with self._lock:
            if kind == self.waiting:
                return False
            self.waiting = kind
        self._publish_status()
        return True

    def set_busy(self, busy, prompt=None):
        """Working or not; returns True if the state changed."""
        with self._lock:
            if prompt is not None:
                self.prompt = prompt
            labelled = self.label == NEW_LABEL
            if prompt is not None and self.label == NEW_LABEL and prompt.strip():
                self.label = prompt.strip().splitlines()[0][:80]
            changed = busy != self.busy
            self.busy = busy
            if changed and not busy:
                self.introducing = False  # end of the turn: the introduction is done
            self.last_activity = time.time()
        if labelled and self.label != NEW_LABEL:
            self._manager.save()  # first message: its default name is saved
        if changed or prompt is not None:
            self._publish_status()
        return changed


class ConversationManager:
    """The agents open in ziggy-one, saved to be found again when the server restarts."""

    def __init__(self, bus, default_cwd, in_git_repo=lambda cwd: False, on_session_started=None,
                 has_history=lambda session_id: True, path=None):
        self.bus = bus
        self.default_cwd = default_cwd
        self.in_git_repo = in_git_repo
        self.has_history = has_history  # does the session have a history on disk?
        self._on_session_started = on_session_started
        self._lock = threading.Lock()
        self._path = Path(path) if path else None
        self._conversations = self._load()

    # --- file ---------------------------------------------------------------------------

    def _load(self):
        """Agents open before the restart, idle; a missing or damaged file gives none."""
        conversations = {}
        data = read_json(self._path, []) if self._path else []
        for raw in data if isinstance(data, list) else []:
            if not isinstance(raw, dict) or not CONVERSATION_ID_RE.match(str(raw.get("id"))):
                continue
            if not isinstance(raw.get("cwd"), str) or not raw["cwd"]:
                continue
            resume = raw.get("resumeFrom") if is_agent_key(raw.get("resumeFrom")) else None
            label = raw.get("label") if isinstance(raw.get("label"), str) else ""
            intro = raw.get("intro") if isinstance(raw.get("intro"), str) else ""
            conversation = Conversation(self, raw["id"], raw["cwd"], resume, label[:200], intro)
            if is_agent_key(raw.get("sessionId")):
                conversation.session_id = raw["sessionId"]
            if isinstance(raw.get("lastActivity"), (int, float)):
                conversation.last_activity = raw["lastActivity"]
            conversations[conversation.id] = conversation
        return conversations

    def save(self):
        """Saves the open agents (folder, session, default name), to find them again on restart."""
        if self._path is None:
            return
        keep = ("id", "cwd", "sessionId", "resumeFrom", "label", "lastActivity")
        with self._lock:
            records = [{**{key: c.status()[key] for key in keep}, "label": c.label, **({"intro": c.intro} if c.intro else {})}
                       for c in self._conversations.values()]
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
        """An agent has just got (or changed) its Claude Code session; `previous`: the old one."""
        self.save()
        if self._on_session_started is not None:
            self._on_session_started(conversation_id, session_id, previous)

    def find_by_session(self, session_id):
        for conversation in self._all():
            if session_id in (conversation.session_id, conversation.resume_from):
                return conversation
        return None

    def open(self, resume=None, cwd=None, label="", intro=""):
        """Agent for a session (the one already following it, else a new one), or a blank agent."""
        if resume is not None:
            existing = self.find_by_session(resume)
            if existing is not None:
                return existing
        conversation = Conversation(self, secrets.token_hex(6), cwd or self.default_cwd, resume, label, intro)
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

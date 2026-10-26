"""Redémarrage propre du serveur, demandé depuis l'écran Configuration.

1. Les agents au travail reçoivent dans leur terminal une demande de pause ; on attend qu'ils soient tous au
   repos (20 minutes au plus). On peut forcer le redémarrage, ou l'annuler (les agents mis en pause reprennent).
2. Le serveur note ce qu'il faudra rouvrir (restart.json), ferme ses terminaux et se relance (même commande).
3. Au démarrage suivant, il rouvre les terminaux, dit aux agents mis en pause de reprendre, et garde le compte
   rendu (last-restart.json) que l'interface affiche.

Chaque étape est publiée sur le flux temps réel (événement « server_restart »).
"""

import json
import threading
import time
from pathlib import Path

from storage import read_json, write_json

WAIT_IDLE = 20 * 60  # secondes au plus pour que les agents se mettent au repos
POLL = 2
REOPEN_DELAY = 12  # secondes : le temps que Claude Code se rouvre avant le message de reprise
PAUSE = ("⏸ Le serveur ziggy-one va redémarrer. Termine proprement l'étape en cours (ne laisse rien à moitié), "
         "écris en une phrase où tu en es, puis arrête-toi et attends. Tu reprendras au redémarrage.")
RESUME = "▶ Le serveur ziggy-one a redémarré. Reprends là où tu t'étais arrêté."


def type_message(terminals, conversation_id, text):
    """Comme au clavier : le texte, puis Entrée à part (sinon Claude Code y voit un collage)."""
    try:
        terminals.write(conversation_id, text)
        time.sleep(0.3)
        terminals.write(conversation_id, "\r")
        return True
    except (RuntimeError, ValueError, OSError):
        return False  # terminal fermé entre-temps


class Restart:
    def __init__(self, server, data_dir, wait_idle=WAIT_IDLE, poll=POLL, reopen_delay=REOPEN_DELAY):
        self._server = server
        self._handoff = Path(data_dir) / "restart.json"
        self._last_path = Path(data_dir) / "last-restart.json"
        self._wait_idle = wait_idle
        self._poll = poll
        self._reopen_delay = reopen_delay
        self._lock = threading.Lock()
        self._state = None  # demande en cours : {phase, requestedAt, deadline, paused, waiting}
        self._force = threading.Event()
        self._cancel = threading.Event()
        last = read_json(self._last_path, None)
        self.last = last if isinstance(last, dict) else None
        self.requested = False  # lu par main() : relancer le processus après l'arrêt

    def snapshot(self):
        with self._lock:
            return json.loads(json.dumps(self._state)) if self._state else None

    def _publish(self):
        self._server.bus.publish("server_restart", {"state": self.snapshot(), "last": self.last})

    def _busy(self):
        return [c["id"] for c in self._server.conversations.list() if c.get("busy")]

    # --- demande, forçage, annulation ---------------------------------------------------------------

    def request(self):
        with self._lock:
            if self._state:
                raise RuntimeError("un redémarrage est déjà demandé")
            now = time.time()
            self._state = {"phase": "waiting", "requestedAt": now, "deadline": now + self._wait_idle,
                           "paused": [], "waiting": []}
            self._force.clear()
            self._cancel.clear()
        threading.Thread(target=self._run, daemon=True).start()
        return self.snapshot()

    def force(self):
        if not self.snapshot():
            raise RuntimeError("aucun redémarrage en cours")
        self._force.set()

    def cancel(self):
        state = self.snapshot()
        if not state or state["phase"] != "waiting":
            raise RuntimeError("aucun redémarrage en attente")
        self._cancel.set()

    def _run(self):
        terminals = self._server.terminals
        paused = [cid for cid in self._busy() if terminals.running(cid) and type_message(terminals, cid, PAUSE)]
        with self._lock:
            self._state["paused"] = paused
        deadline = self.snapshot()["deadline"]
        while time.time() < deadline and not self._force.is_set():
            if self._cancel.is_set():
                for cid in paused:
                    type_message(terminals, cid, RESUME.replace("a redémarré", "ne redémarre finalement pas"))
                with self._lock:
                    self._state = None
                self._publish()
                return
            busy = self._busy()
            with self._lock:
                changed = busy != self._state["waiting"]
                self._state["waiting"] = busy
            if changed or not busy:
                self._publish()
            if not busy:
                break
            self._force.wait(self._poll)
        # Relance : ce qu'il faudra rouvrir, puis arrêt du serveur (main() relance le processus).
        with self._lock:
            self._state["phase"] = "restarting"
            requested_at = self._state["requestedAt"]
        write_json(self._handoff, {"requestedAt": requested_at, "terminals": terminals.list(), "paused": paused,
                                   "forced": self._force.is_set()})
        self._publish()
        time.sleep(0.5)  # le temps que l'événement parte vers les onglets
        self.requested = True
        threading.Thread(target=self._server.shutdown, daemon=True).start()

    # --- au démarrage suivant -------------------------------------------------------------------------

    def resume_after_restart(self):
        """À lancer une fois le serveur prêt : rouvre les terminaux d'avant le redémarrage, puis la reprise."""
        handoff = read_json(self._handoff, None)
        if not isinstance(handoff, dict):
            return
        self._handoff.unlink(missing_ok=True)
        conversations = self._server.conversations
        reopened = []
        for cid in handoff.get("terminals") or []:
            conversation = conversations.get(cid) if isinstance(cid, str) else None
            if conversation is None:
                continue
            try:
                self._server.start_terminal(conversation, 120, 36)
                reopened.append(cid)
            except (ValueError, RuntimeError, OSError):
                continue
        time.sleep(self._reopen_delay if reopened else 0)
        resumed = [cid for cid in handoff.get("paused") or [] if cid in reopened
                   and type_message(self._server.terminals, cid, RESUME)]
        self.last = {"requestedAt": handoff.get("requestedAt"), "completedAt": time.time(),
                     "reopened": len(reopened), "resumed": len(resumed), "forced": bool(handoff.get("forced"))}
        write_json(self._last_path, self.last)
        self._publish()

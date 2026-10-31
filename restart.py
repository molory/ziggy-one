"""Clean restart of the server, requested from the Configuration screen.

1. Working agents get a pause request in their terminal; we wait until they are all idle (20 minutes at
   most). The restart can be forced, or cancelled (paused agents resume).
2. The server records what to reopen (restart.json), closes its terminals and relaunches itself (same command).
3. On the next start, it reopens the terminals, tells the paused agents to resume, and keeps the report
   (last-restart.json) that the interface shows.

Each step is published on the live stream ("server_restart" event).
"""

import json
import threading
import time
from pathlib import Path

from i18n import tr
from storage import read_json, write_json

WAIT_IDLE = 20 * 60  # at most this many seconds for the agents to go idle
POLL = 2
REOPEN_DELAY = 12  # seconds: time for Claude Code to reopen before the resume message
PAUSE = ("⏸ The ziggy-one server is about to restart. Finish the current step cleanly (leave nothing half done), "
         "write one sentence on where you are, then stop and wait. You will resume after the restart.")
RESUME = "▶ The ziggy-one server has restarted. Pick up where you left off."
CANCELLED = "▶ The ziggy-one server will not restart after all. Pick up where you left off."


def type_message(terminals, conversation_id, text):
    """Like typing: the text, then Enter separately (otherwise Claude Code sees a paste)."""
    try:
        terminals.write(conversation_id, text)
        time.sleep(0.3)
        terminals.write(conversation_id, "\r")
        return True
    except (RuntimeError, ValueError, OSError):
        return False  # terminal closed in the meantime


class Restart:
    def __init__(self, server, data_dir, wait_idle=WAIT_IDLE, poll=POLL, reopen_delay=REOPEN_DELAY):
        self._server = server
        self._handoff = Path(data_dir) / "restart.json"
        self._last_path = Path(data_dir) / "last-restart.json"
        self._wait_idle = wait_idle
        self._poll = poll
        self._reopen_delay = reopen_delay
        self._lock = threading.Lock()
        self._state = None  # pending request: {phase, requestedAt, deadline, paused, waiting}
        self._force = threading.Event()
        self._cancel = threading.Event()
        last = read_json(self._last_path, None)
        self.last = last if isinstance(last, dict) else None
        self.requested = False  # read by main(): relaunch the process after shutdown

    def snapshot(self):
        with self._lock:
            return json.loads(json.dumps(self._state)) if self._state else None

    def _publish(self):
        self._server.bus.publish("server_restart", {"state": self.snapshot(), "last": self.last})

    def _busy(self):
        return [c["id"] for c in self._server.conversations.list() if c.get("busy")]

    # --- request, force, cancel --------------------------------------------------------------------

    def request(self, requester=None):
        """`requester`: the agent that asked (server_restart tool). It gets no pause request, as it ends its turn
        by itself, but it gets the resume message, to report or carry on after the restart."""
        with self._lock:
            if self._state:
                raise RuntimeError(tr("A restart is already requested"))
            now = time.time()
            self._state = {"phase": "waiting", "requestedAt": now, "deadline": now + self._wait_idle,
                           "paused": [], "waiting": [], "requester": requester}
            self._force.clear()
            self._cancel.clear()
        threading.Thread(target=self._run, daemon=True).start()
        return self.snapshot()

    def force(self):
        if not self.snapshot():
            raise RuntimeError(tr("No restart in progress"))
        self._force.set()

    def cancel(self):
        state = self.snapshot()
        if not state or state["phase"] != "waiting":
            raise RuntimeError(tr("No pending restart"))
        self._cancel.set()

    def _run(self):
        terminals = self._server.terminals
        requester = self.snapshot()["requester"]
        paused = [cid for cid in self._busy() if cid != requester and terminals.running(cid)
                  and type_message(terminals, cid, PAUSE)]
        if requester and terminals.running(requester):
            paused.append(requester)
        with self._lock:
            self._state["paused"] = paused
        deadline = self.snapshot()["deadline"]
        while time.time() < deadline and not self._force.is_set():
            if self._cancel.is_set():
                for cid in paused:
                    type_message(terminals, cid, CANCELLED)
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
        # Relaunch: what to reopen, then server shutdown (main() relaunches the process).
        with self._lock:
            self._state["phase"] = "restarting"
            requested_at = self._state["requestedAt"]
        write_json(self._handoff, {"requestedAt": requested_at, "terminals": terminals.list(), "paused": paused,
                                   "forced": self._force.is_set()})
        self._publish()
        time.sleep(0.5)  # time for the event to reach the tabs
        self.requested = True
        threading.Thread(target=self._server.shutdown, daemon=True).start()

    # --- on the next start ---------------------------------------------------------------------------

    def resume_after_restart(self):
        """Run once the server is ready: reopens the terminals from before the restart, then the resume."""
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

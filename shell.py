"""Commandes shell lancées depuis la saisie (« !! commande »), dans le dossier de l'agent.

La commande passe par le shell de l'utilisateur ($SHELL -c), sans entrée (stdin fermé), avec un délai
maximal. Sa sortie (stdout et stderr mêlés, dans l'ordre) est diffusée par morceaux sur le flux SSE
au fil de l'exécution. Elle n'est pas envoyée à Claude : c'est une console à côté de la discussion.
"""

import codecs
import os
import re
import secrets
import signal
import subprocess
import threading
import time

TIMEOUT = 10 * 60  # secondes avant d'arrêter une commande
MAX_OUTPUT = 1_000_000  # caractères diffusés par commande ; le reste est ignoré (la commande continue)
MAX_COMMAND = 10_000
MAX_RUNNING = 5
READ_SIZE = 4096
# Séquences de contrôle du terminal (couleurs, curseur) : illisibles hors d'un terminal.
ANSI_RE = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])")


def _shell():
    shell = os.environ.get("SHELL", "")
    return shell if os.path.isabs(shell) and os.access(shell, os.X_OK) else "/bin/sh"


def _env():
    # Ni pager, ni couleurs, ni demande de mot de passe : la commande n'a pas de terminal.
    return {
        **os.environ, "TERM": "dumb", "NO_COLOR": "1", "PAGER": "cat", "GIT_PAGER": "cat",
        "GIT_TERMINAL_PROMPT": "0", "SYSTEMD_PAGER": "",
    }


class ShellRuns:
    """Commandes en cours, par discussion. Événements : shell (début, sortie, fin)."""

    def __init__(self, bus, timeout=TIMEOUT, max_running=MAX_RUNNING):
        self._bus = bus
        self._timeout = timeout
        self._max_running = max_running
        self._lock = threading.Lock()
        self._runs = {}  # identifiant → {"conversation", "proc"}

    def running(self, conversation=None):
        with self._lock:
            return [run_id for run_id, run in self._runs.items() if conversation in (None, run["conversation"])]

    def start(self, conversation, cwd, command):
        """Lance la commande dans `cwd` et rend son identifiant ; la sortie arrive par le flux."""
        if not isinstance(command, str) or not command.strip():
            raise ValueError("commande vide")
        if len(command) > MAX_COMMAND:
            raise ValueError("commande trop longue")
        if not isinstance(cwd, str) or not os.path.isdir(cwd):
            raise ValueError("dossier de l'agent introuvable")
        with self._lock:
            if len(self._runs) >= self._max_running:
                raise RuntimeError(f"{self._max_running} commandes tournent déjà : attends qu'une se termine.")
            run_id = secrets.token_hex(6)
            proc = subprocess.Popen(
                [_shell(), "-c", command], cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT, start_new_session=True, env=_env(),
            )
            self._runs[run_id] = {"conversation": conversation, "proc": proc}
        self._publish(conversation, run_id, {"started": True, "command": command, "cwd": cwd})
        threading.Thread(target=self._pump, args=(conversation, run_id, proc), daemon=True).start()
        return run_id

    def stop(self, run_id):
        """Arrête la commande et tout ce qu'elle a lancé (son groupe de processus)."""
        with self._lock:
            run = self._runs.get(run_id)
        if run is None:
            return False
        _kill(run["proc"], signal.SIGTERM)
        return True

    def stop_all(self):
        for run_id in self.running():
            self.stop(run_id)

    def _publish(self, conversation, run_id, data):
        self._bus.publish("shell", {"conversation": conversation, "run": run_id, **data})

    def _pump(self, conversation, run_id, proc):
        started = time.monotonic()
        timed_out = threading.Event()

        def expire():
            timed_out.set()
            _kill(proc, signal.SIGTERM)

        timer = threading.Timer(self._timeout, expire)
        timer.daemon = True
        timer.start()
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        sent = 0
        truncated = False
        fd = proc.stdout.fileno()
        while True:
            chunk = os.read(fd, READ_SIZE)
            if not chunk:
                break
            text = ANSI_RE.sub("", decoder.decode(chunk)).replace("\r\n", "\n")
            if sent >= MAX_OUTPUT:
                truncated = True
                continue  # on vide le tuyau pour que la commande ne se bloque pas
            text = text[: MAX_OUTPUT - sent]
            sent += len(text)
            if text:
                self._publish(conversation, run_id, {"output": text})
        code = proc.wait()
        timer.cancel()
        proc.stdout.close()
        with self._lock:
            self._runs.pop(run_id, None)
        self._publish(conversation, run_id, {
            "ended": True, "code": code, "seconds": round(time.monotonic() - started, 1),
            "truncated": truncated, "timedOut": timed_out.is_set(),
        })


def _kill(proc, sig):
    try:
        os.killpg(proc.pid, sig)
    except (ProcessLookupError, PermissionError):
        return
    try:
        proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

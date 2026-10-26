"""Claude Code dans un vrai terminal (onglet Terminal) : `claude` interactif dans un pseudo-terminal.

Le serveur lance `claude` lui-même (jamais un shell) dans le dossier de l'agent, en reprenant sa
session. L'écran (octets bruts du terminal, en base64) part sur le flux SSE, numéroté ; les touches
arrivent par POST. La sortie récente est gardée pour redessiner l'écran à l'ouverture de l'onglet.

`setsid --ctty --wait` donne à Claude Code un terminal de contrôle (redimensionnement, Ctrl+C) sans
fork dans ce processus Python multi-thread.
"""

import base64
import collections
import fcntl
import os
import signal
import struct
import subprocess
import termios
import threading
import time

REPLAY_BYTES = 512 * 1024  # sortie gardée pour redessiner l'écran d'un onglet qui s'ouvre
MAX_INPUT = 64 * 1024  # caractères par envoi de touches (un collage compris)
READ_SIZE = 65536
# Variables d'une session Claude Code parente (le serveur peut avoir été lancé par un agent) :
# héritées, elles feraient croire au nouveau `claude` qu'il tourne dans une autre session.
PARENT_SESSION_VARS = (
    "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_EXECPATH", "CLAUDE_PID", "CLAUDE_EFFORT",
)


def clean_size(cols, rows):
    if not all(isinstance(v, int) and not isinstance(v, bool) for v in (cols, rows)):
        raise ValueError("taille du terminal invalide")
    return max(20, min(cols, 500)), max(5, min(rows, 200))


def _env():
    env = {key: value for key, value in os.environ.items() if key not in PARENT_SESSION_VARS}
    return {**env, "TERM": "xterm-256color", "COLORTERM": "truecolor"}


def _set_size(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


class _Terminal:
    def __init__(self, conversation, proc, fd):
        self.conversation = conversation
        self.proc = proc
        self.fd = fd
        self.seq = 0
        self.chunks = collections.deque()  # (numéro, octets) récents
        self.size = 0
        self.started = time.time()


class Terminals:
    """Terminaux Claude Code ouverts, un par discussion. Événements : terminal, terminal_status."""

    def __init__(self, bus, on_exit=None):
        self._bus = bus
        self._on_exit = on_exit  # appelé (discussion, pid de claude) quand un terminal se ferme
        self._lock = threading.Lock()
        self._terminals = {}

    def running(self, conversation):
        with self._lock:
            return conversation in self._terminals

    def list(self):
        with self._lock:
            return sorted(self._terminals)

    def claude_pid(self, conversation):
        """Pid du processus `claude` (enfant de setsid), pour le retrouver dans le registre des sessions."""
        with self._lock:
            terminal = self._terminals.get(conversation)
        if terminal is None:
            return None
        pid = terminal.proc.pid
        try:
            # setsid ne fait un fork que s'il dirige déjà un groupe ; sinon il devient lui-même `claude`.
            if open(f"/proc/{pid}/comm").read().strip() != "setsid":
                return pid
            children = open(f"/proc/{pid}/task/{pid}/children").read().split()
        except OSError:
            return None
        return int(children[0]) if children else None

    def start(self, conversation, cwd, args, cols, rows):
        cols, rows = clean_size(cols, rows)
        if not os.path.isdir(cwd):
            raise ValueError("dossier de l'agent introuvable")
        with self._lock:
            if conversation in self._terminals:
                return
            master, slave = os.openpty()
            try:
                _set_size(master, cols, rows)
                proc = subprocess.Popen(
                    ["setsid", "--ctty", "--wait", "claude", *args], cwd=cwd, env=_env(),
                    stdin=slave, stdout=slave, stderr=slave, close_fds=True,
                )
            except OSError:
                os.close(master)
                raise
            finally:
                os.close(slave)
            terminal = _Terminal(conversation, proc, master)
            self._terminals[conversation] = terminal
        threading.Thread(target=self._pump, args=(terminal,), daemon=True).start()
        self._bus.publish("terminal_status", {"conversation": conversation, "running": True})

    def write(self, conversation, data):
        if not isinstance(data, str) or len(data) > MAX_INPUT:
            raise ValueError("saisie invalide")
        with self._lock:
            terminal = self._terminals.get(conversation)
        if terminal is None:
            raise RuntimeError("le terminal est fermé")
        payload = data.encode()
        while payload:
            written = os.write(terminal.fd, payload)
            payload = payload[written:]

    def resize(self, conversation, cols, rows):
        cols, rows = clean_size(cols, rows)
        with self._lock:
            terminal = self._terminals.get(conversation)
        if terminal is None:
            return
        _set_size(terminal.fd, cols, rows)
        # Même taille qu'avant : le noyau ne prévient pas. On demande quand même un redessin
        # (un onglet qui se rouvre veut un écran complet).
        try:
            os.killpg(os.tcgetpgrp(terminal.fd), signal.SIGWINCH)
        except OSError:
            pass

    def stats(self):
        """Terminaux ouverts : {conversation, startedAt, memory}. `memory` : mémoire vive (octets) de tous les
        processus de la session du terminal (Claude Code, ses commandes, ses serveurs MCP), None si illisible."""
        with self._lock:
            items = [(conversation, terminal.started) for conversation, terminal in self._terminals.items()]
        sessions = {}
        for conversation, _ in items:
            pid = self.claude_pid(conversation)
            try:
                sessions[conversation] = os.getsid(pid) if pid else None
            except OSError:
                sessions[conversation] = None
        wanted = {sid for sid in sessions.values() if sid}
        page = os.sysconf("SC_PAGE_SIZE")
        memory = collections.Counter()
        for entry in os.scandir("/proc"):
            if not wanted or not entry.name.isdigit():
                continue
            try:
                with open(f"/proc/{entry.name}/stat") as file:
                    stat = file.read()
                # Après le nom (entre parenthèses) : état, parent, groupe, session…
                sid = int(stat[stat.rindex(")") + 2:].split()[3])
                if sid in wanted:
                    with open(f"/proc/{entry.name}/statm") as file:
                        memory[sid] += int(file.read().split()[1]) * page
            except (OSError, ValueError, IndexError):
                continue  # processus terminé entre-temps
        return [{"conversation": conversation, "startedAt": started,
                 "memory": memory.get(sessions[conversation]) if sessions[conversation] else None}
                for conversation, started in items]

    def snapshot(self, conversation):
        """Sortie récente, pour redessiner l'écran : {running, seq (dernier numéro inclus), data}."""
        with self._lock:
            terminal = self._terminals.get(conversation)
            if terminal is None:
                return {"running": False, "seq": 0, "data": ""}
            data = b"".join(chunk for _, chunk in terminal.chunks)
            return {"running": True, "seq": terminal.seq, "data": base64.b64encode(data).decode()}

    def stop(self, conversation):
        """Ferme Claude Code (SIGHUP, comme un terminal qu'on ferme), puis le tue s'il traîne."""
        with self._lock:
            terminal = self._terminals.get(conversation)
        if terminal is None:
            return False
        _signal_group(terminal.proc, signal.SIGHUP)
        try:
            terminal.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            _signal_group(terminal.proc, signal.SIGKILL)
        return True

    def stop_all(self):
        for conversation in self.list():
            self.stop(conversation)

    def _pump(self, terminal):
        while True:
            try:
                chunk = os.read(terminal.fd, READ_SIZE)
            except OSError:  # EIO : plus aucun processus n'a le terminal ouvert
                break
            if not chunk:
                break
            with self._lock:
                terminal.seq += 1
                seq = terminal.seq
                terminal.chunks.append((seq, chunk))
                terminal.size += len(chunk)
                while terminal.size > REPLAY_BYTES and len(terminal.chunks) > 1:
                    terminal.size -= len(terminal.chunks.popleft()[1])
            self._bus.publish("terminal", {
                "conversation": terminal.conversation, "seq": seq, "data": base64.b64encode(chunk).decode(),
            })
        code = terminal.proc.wait()
        os.close(terminal.fd)
        with self._lock:
            self._terminals.pop(terminal.conversation, None)
        self._bus.publish("terminal_status", {"conversation": terminal.conversation, "running": False, "code": code})
        if self._on_exit is not None:
            self._on_exit(terminal.conversation)


def _signal_group(proc, sig):
    """Le signal va à tout le groupe de la session (setsid, claude et ce qu'il a lancé)."""
    try:
        os.killpg(proc.pid, sig)
    except (ProcessLookupError, PermissionError):
        pass

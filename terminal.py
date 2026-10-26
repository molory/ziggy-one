"""Claude Code in a real terminal (Terminal tab): interactive `claude` in a pseudo-terminal.

The server launches `claude` itself (never a shell) in the agent's folder, resuming its
session. The screen (raw terminal bytes, in base64) goes out on the SSE stream, numbered; keys
come in by POST. Recent output is kept to redraw the screen when the tab opens.

Claude Code needs the terminal as its controlling terminal (resizing, Ctrl+C). Popen starts it
in a new session, then a tiny Python launcher takes the terminal (TIOCSCTTY) and becomes `claude`
(exec): no code runs between fork and exec in this multi-threaded process, and it works on Linux
and macOS alike.
"""

import base64
import collections
import fcntl
import os
import signal
import struct
import subprocess
import sys
import termios
import threading
import time

from i18n import tr

REPLAY_BYTES = 512 * 1024  # output kept to redraw the screen of a tab that opens
MAX_INPUT = 64 * 1024  # characters per key send (a paste included)
READ_SIZE = 65536
# Variables of a parent Claude Code session (the server may have been started by an agent):
# if inherited, they would make the new `claude` believe it runs inside another session.
PARENT_SESSION_VARS = (
    "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_EXECPATH", "CLAUDE_PID", "CLAUDE_EFFORT",
)
# Run in the new session: takes the terminal (stdin) as controlling terminal, then becomes the command.
CTTY_EXEC = (
    "import fcntl, os, sys, termios\n"
    "fcntl.ioctl(0, termios.TIOCSCTTY, 0)\n"
    "try:\n"
    "    os.execvp(sys.argv[1], sys.argv[1:])\n"
    "except OSError as error:\n"
    "    sys.exit(f'ziggy: cannot run {sys.argv[1]}: {error.strerror}')\n"
)


def clean_size(cols, rows):
    if not all(isinstance(v, int) and not isinstance(v, bool) for v in (cols, rows)):
        raise ValueError(tr("Invalid terminal size"))
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
        self.chunks = collections.deque()  # recent (number, bytes)
        self.size = 0
        self.started = time.time()


class Terminals:
    """Open Claude Code terminals, one per conversation. Events: terminal, terminal_status."""

    def __init__(self, bus, on_exit=None):
        self._bus = bus
        self._on_exit = on_exit  # called (conversation, claude pid) when a terminal closes
        self._lock = threading.Lock()
        self._terminals = {}

    def running(self, conversation):
        with self._lock:
            return conversation in self._terminals

    def list(self):
        with self._lock:
            return sorted(self._terminals)

    def claude_pid(self, conversation):
        """Pid of the `claude` process (the launcher becomes it), to find it in the session registry."""
        with self._lock:
            terminal = self._terminals.get(conversation)
        return None if terminal is None else terminal.proc.pid

    def start(self, conversation, cwd, args, cols, rows):
        cols, rows = clean_size(cols, rows)
        if not os.path.isdir(cwd):
            raise ValueError(tr("Agent folder not found"))
        with self._lock:
            if conversation in self._terminals:
                return
            master, slave = os.openpty()
            try:
                _set_size(master, cols, rows)
                proc = subprocess.Popen(
                    [sys.executable, "-I", "-c", CTTY_EXEC, "claude", *args], cwd=cwd, env=_env(),
                    stdin=slave, stdout=slave, stderr=slave, close_fds=True, start_new_session=True,
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
            raise ValueError(tr("Invalid input"))
        with self._lock:
            terminal = self._terminals.get(conversation)
        if terminal is None:
            raise RuntimeError(tr("The terminal is closed"))
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
        # Same size as before: the kernel does not notify. Ask for a redraw anyway
        # (a tab that reopens wants a full screen).
        try:
            os.killpg(os.tcgetpgrp(terminal.fd), signal.SIGWINCH)
        except OSError:
            pass

    def stats(self):
        """Open terminals: {conversation, startedAt, memory}. `memory`: RAM (bytes) of all the processes of
        the terminal's session (Claude Code, its commands, its MCP servers), None if unreadable."""
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
        memory = _session_memory(wanted) if wanted else {}
        return [{"conversation": conversation, "startedAt": started,
                 "memory": memory.get(sessions[conversation]) if sessions[conversation] else None}
                for conversation, started in items]

    def snapshot(self, conversation):
        """Recent output, to redraw the screen: {running, seq (last number included), data}."""
        with self._lock:
            terminal = self._terminals.get(conversation)
            if terminal is None:
                return {"running": False, "seq": 0, "data": ""}
            data = b"".join(chunk for _, chunk in terminal.chunks)
            return {"running": True, "seq": terminal.seq, "data": base64.b64encode(data).decode()}

    def stop(self, conversation):
        """Closes Claude Code (SIGHUP, like closing a terminal), then kills it if it lingers."""
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
            except OSError:  # EIO: no process has the terminal open any more
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


def _session_memory(wanted):
    """RAM (bytes) of the processes of each session of `wanted`: /proc on Linux, `ps` elsewhere (macOS)."""
    if os.path.isdir("/proc/self"):
        return _proc_session_memory(wanted)
    memory = collections.Counter()
    try:
        output = subprocess.run(["ps", "-A", "-o", "pid=,rss="], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.TimeoutExpired):
        return memory
    for line in output.splitlines():
        try:
            pid, rss = (int(value) for value in line.split())
            sid = os.getsid(pid)
        except (OSError, ValueError):
            continue  # process ended in the meantime
        if sid in wanted:
            memory[sid] += rss * 1024
    return memory


def _proc_session_memory(wanted):
    page = os.sysconf("SC_PAGE_SIZE")
    memory = collections.Counter()
    for entry in os.scandir("/proc"):
        if not entry.name.isdigit():
            continue
        try:
            with open(f"/proc/{entry.name}/stat") as file:
                stat = file.read()
            # After the name (in parentheses): state, parent, group, session…
            sid = int(stat[stat.rindex(")") + 2:].split()[3])
            if sid in wanted:
                with open(f"/proc/{entry.name}/statm") as file:
                    memory[sid] += int(file.read().split()[1]) * page
        except (OSError, ValueError, IndexError):
            continue  # process ended in the meantime
    return memory


def _signal_group(proc, sig):
    """The signal goes to the whole session group (claude and what it launched)."""
    try:
        os.killpg(proc.pid, sig)
    except (ProcessLookupError, PermissionError):
        pass

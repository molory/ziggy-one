"""Shell commands run from the input box ("!! command"), in the agent's folder.

The command goes through the user's shell ($SHELL -c), with no input (stdin closed) and a maximum
duration. Its output (stdout and stderr merged, in order) is streamed in chunks on the SSE stream
as it runs. It is not sent to Claude: it is a console next to the conversation.
"""

import codecs
import os
import re
import secrets
import signal
import subprocess
import threading
import time

from i18n import tr

TIMEOUT = 10 * 60  # seconds before stopping a command
MAX_OUTPUT = 1_000_000  # characters streamed per command; the rest is dropped (the command goes on)
MAX_COMMAND = 10_000
MAX_RUNNING = 5
READ_SIZE = 4096
# Terminal control sequences (colours, cursor): unreadable outside a terminal.
ANSI_RE = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])")


def _shell():
    shell = os.environ.get("SHELL", "")
    return shell if os.path.isabs(shell) and os.access(shell, os.X_OK) else "/bin/sh"


def _env():
    # No pager, no colours, no password prompt: the command has no terminal.
    return {
        **os.environ, "TERM": "dumb", "NO_COLOR": "1", "PAGER": "cat", "GIT_PAGER": "cat",
        "GIT_TERMINAL_PROMPT": "0", "SYSTEMD_PAGER": "",
    }


class ShellRuns:
    """Running commands, per conversation. Events: shell (start, output, end)."""

    def __init__(self, bus, timeout=TIMEOUT, max_running=MAX_RUNNING):
        self._bus = bus
        self._timeout = timeout
        self._max_running = max_running
        self._lock = threading.Lock()
        self._runs = {}  # id → {"conversation", "proc"}

    def running(self, conversation=None):
        with self._lock:
            return [run_id for run_id, run in self._runs.items() if conversation in (None, run["conversation"])]

    def start(self, conversation, cwd, command):
        """Starts the command in `cwd` and returns its id; the output comes through the stream."""
        if not isinstance(command, str) or not command.strip():
            raise ValueError(tr("Empty command"))
        if len(command) > MAX_COMMAND:
            raise ValueError(tr("Command too long"))
        if not isinstance(cwd, str) or not os.path.isdir(cwd):
            raise ValueError(tr("Agent folder not found"))
        with self._lock:
            if len(self._runs) >= self._max_running:
                raise RuntimeError(tr("{count} commands are already running: wait for one to finish.", count=self._max_running))
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
        """Stops the command and everything it launched (its process group)."""
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
                continue  # drain the pipe so that the command does not block
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

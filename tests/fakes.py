"""Helpers shared by the tests: a fake `claude` executable (no quota used)."""

import os
import sys
import time
from pathlib import Path
from unittest import mock

# Fake `claude`: answers each stream-json message with init, assistant (12,000 context tokens)
# then result (400,000-token window).
# - `--resume X` keeps session X, except with `--fork-session` (new session, like the real one);
# - a message starting with "slow" takes 1.5 s to answer (to simulate a turn in progress);
# - if FAKE_CLAUDE_LOG is set, each launch appends a line with its arguments to it.
FAKE_CLAUDE = f"""#!{sys.executable}
import json, os, sys, time, uuid
args = sys.argv[1:]
if os.environ.get("FAKE_CLAUDE_LOG"):
    with open(os.environ["FAKE_CLAUDE_LOG"], "a") as log:
        log.write(json.dumps(args) + "\\n")
sid = str(uuid.uuid4())
if "--resume" in args and "--fork-session" not in args:
    sid = args[args.index("--resume") + 1]
for line in sys.stdin:
    content = json.loads(line)["message"]["content"]
    if isinstance(content, list):  # attached files: answer with the block types and the text
        content = " ".join(b.get("text") or "[" + b["type"] + "]" for b in content)
    text = content
    if text.startswith("slow"):
        time.sleep(1.5)
    for event in (
        {{"type": "system", "subtype": "init", "session_id": sid}},
        {{"type": "assistant", "parent_tool_use_id": None, "message": {{
            "model": "claude-fake", "content": [{{"type": "text", "text": "echo: " + text}}],
            "usage": {{"input_tokens": 2000, "cache_read_input_tokens": 9000, "cache_creation_input_tokens": 1000}},
        }}}},
        {{"type": "result", "subtype": "success", "is_error": False, "total_cost_usd": 0.01, "session_id": sid,
          "result": "echo: " + text,
          "modelUsage": {{"claude-fake": {{"contextWindow": 400000}}}}}},
    ):
        print(json.dumps(event), flush=True)
"""


def install_fake_claude(test_case, directory):
    """Puts the fake `claude` first in PATH for the test. Returns the launches file."""
    fake = Path(directory) / "claude"
    fake.write_text(FAKE_CLAUDE)
    fake.chmod(0o755)
    launches = Path(directory) / "launches.jsonl"
    patcher = mock.patch.dict(os.environ, {
        "PATH": f"{directory}{os.pathsep}{os.environ['PATH']}",
        "FAKE_CLAUDE_LOG": str(launches),
    })
    patcher.start()
    test_case.addCleanup(patcher.stop)
    return launches


def wait_for(predicate, timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return False


def drain(events):
    """Events (type, data) already published on a subscription queue."""
    items = []
    while not events.empty():
        items.append(events.get_nowait())
    return items


# Fake interactive `claude`: says whether it has a terminal (and a controlling terminal), its arguments,
# two environment variables, its size (repeated on each SIGWINCH), then echoes each typed line.
FAKE_INTERACTIVE = f"""#!{sys.executable}
import json, os, signal, sys
def size(*_):
    # os.write, not print: a SIGWINCH can land while print is running (macOS may send two in a row),
    # and print inside print raises "reentrant call" and kills the fake.
    columns, lines = os.get_terminal_size(0)
    os.write(1, f"SIZE {{columns}}x{{lines}}\\n".encode())
try:
    os.close(os.open("/dev/tty", os.O_RDWR))
    ctty = True
except OSError:
    ctty = False
print("TTY", os.isatty(0), "CTTY", ctty, flush=True)
print("ARGS", json.dumps(sys.argv[1:]), flush=True)
print("ENV", os.environ.get("CLAUDECODE"), os.environ.get("TERM"), flush=True)
signal.signal(signal.SIGWINCH, size)
size()
for line in sys.stdin:
    print("GOT", line.strip(), flush=True)
"""



def install_fake_interactive_claude(test_case, directory):
    """Puts the fake interactive `claude` first in PATH for the test."""
    fake = Path(directory) / "claude"
    fake.write_text(FAKE_INTERACTIVE)
    fake.chmod(0o755)
    patcher = mock.patch.dict(os.environ, {"PATH": f"{directory}{os.pathsep}{os.environ['PATH']}"})
    patcher.start()
    test_case.addCleanup(patcher.stop)

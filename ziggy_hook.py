#!/usr/bin/env python3
"""Claude Code hook of the ziggy-one terminals (SessionStart, UserPromptSubmit, Stop, Notification, PostToolUse).

Ziggy starts Claude Code with `--settings`: this script reads the event on its input (JSON), forwards
it to the local server, and prints its answer. For UserPromptSubmit, what is printed is added to the
message context: what the other agents of the workspace did (shared activity). For
SessionStart, it is added to the session context: the agent directory (who does what, how to reach them).

Usage: ziggy_hook.py <session|prompt|stop|notify|tool> <port> <conversation> <token file>

It must never get in Claude Code's way: server stopped, timeout or error, it stays silent and exits with 0.
"""

import sys
import urllib.request
from pathlib import Path

TIMEOUT = 8  # seconds; the hook itself is limited by Claude Code


def main(argv):
    if len(argv) != 5 or argv[1] not in ("session", "prompt", "stop", "notify", "tool"):
        return 0
    event, port, conversation, token_file = argv[1:]
    try:
        payload = sys.stdin.buffer.read()
        token = Path(token_file).read_text().strip()
        request = urllib.request.Request(
            f"http://127.0.0.1:{int(port)}/hooks/{event}?conversation={conversation}", payload,
            {"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        )
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            text = response.read().decode("utf-8", "replace")
    except Exception:  # noqa: BLE001 — nothing must reach Claude Code
        return 0
    if text.strip():
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

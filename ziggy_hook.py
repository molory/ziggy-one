#!/usr/bin/env python3
"""Hook Claude Code des terminaux de ziggy-one (SessionStart, UserPromptSubmit, Stop, Notification, PostToolUse).

Ziggy lance Claude Code avec `--settings` : ce script reçoit l'événement sur son entrée (JSON), le
transmet au serveur local, et affiche sa réponse. Pour UserPromptSubmit, ce qui est affiché est ajouté
au contexte du message : ce qu'ont fait les autres agents du workspace (activité partagée). Pour
SessionStart, il est ajouté au contexte de la session : l'annuaire des agents (qui fait quoi, comment les joindre).

Usage : ziggy_hook.py <session|prompt|stop|notify|tool> <port> <discussion> <fichier du token>

Il ne doit jamais gêner Claude Code : serveur arrêté, délai dépassé ou erreur, il se tait et sort en 0.
"""

import sys
import urllib.request
from pathlib import Path

TIMEOUT = 8  # secondes ; le hook est lui-même limité par Claude Code


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
    except Exception:  # noqa: BLE001 — rien ne doit remonter jusqu'à Claude Code
        return 0
    if text.strip():
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

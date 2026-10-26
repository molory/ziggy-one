"""Outils partagés par les tests : un faux exécutable `claude` (aucun quota consommé)."""

import os
import sys
import time
from pathlib import Path
from unittest import mock

# Faux `claude` : répond à chaque message stream-json par init, assistant (12 000 tokens de contexte)
# puis result (fenêtre de 400 000 tokens).
# - `--resume X` garde la session X, sauf avec `--fork-session` (nouvelle session, comme le vrai) ;
# - un message qui commence par « lent » met 1,5 s à répondre (pour simuler un tour en cours) ;
# - si FAKE_CLAUDE_LOG est défini, chaque lancement y ajoute une ligne avec ses arguments.
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
    if isinstance(content, list):  # fichiers joints : on répond avec le type des blocs et le texte
        content = " ".join(b.get("text") or "[" + b["type"] + "]" for b in content)
    text = content
    if text.startswith("lent"):
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
    """Place le faux `claude` en tête du PATH le temps du test. Retourne le fichier des lancements."""
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
    """Événements (type, données) déjà publiés sur une file d'abonnement."""
    items = []
    while not events.empty():
        items.append(events.get_nowait())
    return items


# Faux `claude` interactif : dit s'il a un terminal (et un terminal de contrôle), ses arguments,
# deux variables d'environnement, sa taille (et la redit à chaque SIGWINCH), puis répète chaque ligne tapée.
FAKE_INTERACTIVE = f"""#!{sys.executable}
import json, os, signal, sys
def size(*_):
    columns, lines = os.get_terminal_size(0)
    print(f"SIZE {{columns}}x{{lines}}", flush=True)
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
    """Place le faux `claude` interactif en tête du PATH le temps du test."""
    fake = Path(directory) / "claude"
    fake.write_text(FAKE_INTERACTIVE)
    fake.chmod(0o755)
    patcher = mock.patch.dict(os.environ, {"PATH": f"{directory}{os.pathsep}{os.environ['PATH']}"})
    patcher.start()
    test_case.addCleanup(patcher.stop)

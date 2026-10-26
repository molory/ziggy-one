"""Génération d'un message de commit par Claude (Haiku), à partir des modifications indexées.

Claude ne reçoit que le diff indexé (tronqué s'il est trop long) et les titres des derniers commits,
pour reprendre la langue et le style du dépôt. Il n'a aucun outil et ne fait rien d'autre qu'écrire.
"""

import json
import re
import subprocess
import tempfile

import gitops

MAX_DIFF = 60_000
TIMEOUT = 120
CLAUDE_CMD = [
    "claude", "-p", "--model", "haiku", "--tools", "", "--max-turns", "1",
    "--no-session-persistence", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--output-format", "json",
]
PROMPT = """Écris le message de commit git pour les modifications indexées ci-dessous.

- Reprends la langue et le style des commits récents du dépôt.
- Une première ligne de titre de 72 caractères au plus, à l'impératif, sans point final.
- Si c'est utile, une ligne vide puis quelques puces courtes qui expliquent le pourquoi.
- Ta réponse est directement le message : pas de phrase d'introduction, ni guillemets, ni bloc de code.

Commits récents :
{recent}

Statistiques :
{stat}

Diff indexé :
{diff}
"""


def clean(text):
    """Retire ce que le modèle ajoute parfois autour du message (bloc de code, guillemets, préfixe)."""
    text = text.strip()
    fenced = re.search(r"```[\w-]*\n(.*?)(?:\n```|$)", text, flags=re.DOTALL)
    if fenced:
        # Le message est dans un bloc de code, souvent précédé d'une phrase d'introduction : on garde le bloc.
        text = fenced.group(1).strip()
    else:
        lines = text.splitlines()
        if len(lines) > 1 and lines[0].rstrip().endswith(":"):
            text = "\n".join(lines[1:]).strip()  # introduction du type « Voici le message : »
    text = re.sub(r"^(message de commit|commit message)\s*:\s*", "", text, flags=re.IGNORECASE).strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "\"'«":
        text = text[1:-1].strip()
    return text


def generate(path):
    """Message de commit proposé pour ce qui est indexé ; GitError s'il n'y a rien ou en cas d'échec."""
    root = gitops.repo_root(path)
    if not gitops.has_staged_changes(root):
        raise gitops.GitError(gitops.NOTHING_STAGED)
    diff = gitops.run(root, "diff", "--cached", "-M").stdout
    stat = gitops.run(root, "diff", "--cached", "--stat").stdout
    recent = gitops.run(root, "log", "-10", "--format=- %s", check=False).stdout or "(aucun)"
    if len(diff) > MAX_DIFF:
        diff = diff[:MAX_DIFF] + "\n… (diff tronqué)"
    prompt = PROMPT.format(recent=recent.strip(), stat=stat.strip(), diff=diff)
    try:
        result = subprocess.run(
            CLAUDE_CMD, input=prompt, capture_output=True, text=True, timeout=TIMEOUT,
            cwd=tempfile.gettempdir(),  # hors du dépôt : ni CLAUDE.md ni réglages du projet
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise gitops.GitError(f"génération du message impossible : {exc}") from None
    try:
        payload = json.loads(result.stdout)
    except ValueError:
        raise gitops.GitError(result.stderr.strip()[-500:] or "réponse illisible de Claude") from None
    message = clean(str(payload.get("result") or ""))
    if payload.get("is_error") or not message:
        raise gitops.GitError("Claude n'a pas pu écrire le message de commit")
    return message

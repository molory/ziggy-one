"""Fichiers de données de ziggy-one : un dossier privé, des fichiers écrits atomiquement (JSON, token)."""

import json
import os
import re
import secrets
import tempfile
from pathlib import Path

# Identifiant d'un agent : sa session Claude Code (UUID) ou, tant qu'elle n'a pas démarré,
# sa discussion ziggy-one (12 caractères hexadécimaux).
AGENT_KEY_RE = re.compile(r"^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{12})$")


def default_data_dir():
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share") / "ziggy-one"


def is_agent_key(value):
    return isinstance(value, str) and AGENT_KEY_RE.match(value) is not None


def persistent_token(path, renew=False):
    """Token d'accès gardé d'un démarrage à l'autre (fichier 0600) : les onglets restent connectés.

    Créé au premier lancement, ou recréé si `renew` (par exemple si l'adresse a fuité).
    """
    path = Path(path)
    if not renew:
        try:
            token = path.read_text().strip()
        except OSError:
            token = ""
        if len(token) >= 32:
            return token
    token = secrets.token_urlsafe(32)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".token-")
    with os.fdopen(fd, "w") as file:
        file.write(token)
    os.replace(tmp, path)
    return token


def write_private(path, text):
    """Fichier texte privé (0600, dossier 0700), écrit atomiquement."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.stem}-")
    try:
        with os.fdopen(fd, "w") as file:
            file.write(text)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def read_json(path, default):
    """Lecture défensive : un fichier absent ou illisible donne `default`, jamais une erreur."""
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return default


def write_json(path, data):
    """Écriture atomique (fichier temporaire puis remplacement), fichier 0600 dans un dossier 0700."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.stem}-", suffix=".json")
    try:
        with os.fdopen(fd, "w") as file:
            json.dump(data, file, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise

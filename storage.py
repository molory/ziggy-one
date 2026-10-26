"""Data files of ziggy-one: a private folder, files written atomically (JSON, token)."""

import json
import os
import re
import secrets
import tempfile
from pathlib import Path

# Identifier of an agent: its Claude Code session (UUID) or, until that session has started,
# its ziggy-one conversation (12 hexadecimal characters).
AGENT_KEY_RE = re.compile(r"^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{12})$")


def default_data_dir():
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share") / "ziggy-one"


def is_agent_key(value):
    return isinstance(value, str) and AGENT_KEY_RE.match(value) is not None


def persistent_token(path, renew=False):
    """Access token kept from one start to the next (0600 file): tabs stay signed in.

    Created on the first launch, or created again if `renew` (for example if the address leaked).
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
    """Private text file (0600, folder 0700), written atomically."""
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
    """Defensive read: a missing or unreadable file gives `default`, never an error."""
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return default


def write_json(path, data):
    """Atomic write (temporary file then replace), 0600 file in a 0700 folder."""
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

"""Choosing the folder of a new agent: subfolders of a folder, recently used folders, creating a
subfolder.

Only folder names are returned, never file contents. Hidden folders (starting with ".") are neither
offered nor created.
"""

import os
from pathlib import Path

from i18n import tr

MAX_ENTRIES = 500
MAX_NAME = 255


def resolve_dir(path):
    """Normalized absolute path of an existing folder; ValueError otherwise."""
    if not isinstance(path, str) or not path.strip():
        raise ValueError(tr("Empty path"))
    candidate = Path(path.strip()).expanduser()
    if not candidate.is_absolute():
        raise ValueError(tr("Expected an absolute path (starting with /)"))
    candidate = candidate.resolve()
    if not candidate.is_dir():
        raise ValueError(tr("This folder does not exist"))
    return candidate


def list_subfolders(path):
    """Visible subfolders of a folder, sorted by name."""
    folder = resolve_dir(path)
    names = []
    try:
        with os.scandir(folder) as entries:
            for entry in entries:
                if entry.name.startswith("."):
                    continue
                try:
                    if entry.is_dir():
                        names.append(entry.name)
                except OSError:
                    continue
    except PermissionError:
        raise ValueError(tr("Access to this folder denied")) from None
    names.sort(key=str.lower)
    return {
        "path": str(folder),
        "parent": str(folder.parent) if folder.parent != folder else None,
        "home": str(Path.home()),
        "dirs": names[:MAX_ENTRIES],
        "truncated": len(names) > MAX_ENTRIES,
    }


def create_subfolder(parent, name):
    """Creates the folder `name` in `parent` (existing) and returns its path; ValueError otherwise.

    A single level: the name contains no "/" and does not start with ".".
    """
    folder = resolve_dir(parent)
    name = name.strip() if isinstance(name, str) else ""
    if not name:
        raise ValueError(tr("Empty folder name"))
    if "/" in name or "\0" in name:
        raise ValueError(tr("The name cannot contain \"/\""))
    if name.startswith("."):
        raise ValueError(tr("The name cannot start with \".\""))
    if len(name.encode()) > MAX_NAME:
        raise ValueError(tr("Folder name too long"))
    target = folder / name
    try:
        target.mkdir(mode=0o755)
    except FileExistsError:
        raise ValueError(tr("This folder already exists")) from None
    except PermissionError:
        raise ValueError(tr("Not allowed to create a folder here")) from None
    except OSError as exc:
        raise ValueError(tr("Could not create the folder: {error}", error=exc.strerror or exc)) from None
    return target


def in_git_repo(path):
    """Is the folder in a git repository (itself or one of its parents contains a .git)?

    `.git` can be a folder (repository) or a file (worktree, submodule).
    """
    if not isinstance(path, str) or not path:
        return False
    try:
        current = Path(path).resolve()
    except (OSError, RuntimeError):
        return False
    return any((folder / ".git").exists() for folder in (current, *current.parents))


def recent_folders(entries, limit=5):
    """Folders most recently used by agents, that still exist.

    `entries`: {"cwd", "updatedAt"} items (sessions, conversations), in any order.
    """
    folders = {}
    for entry in entries:
        cwd = entry.get("cwd")
        if not isinstance(cwd, str) or not cwd:
            continue
        updated = entry.get("updatedAt") if isinstance(entry.get("updatedAt"), (int, float)) else 0
        folder = folders.setdefault(cwd, {"path": cwd, "lastUsed": 0, "agents": 0})
        folder["agents"] += 1
        folder["lastUsed"] = max(folder["lastUsed"], updated)
    ordered = sorted(folders.values(), key=lambda folder: folder["lastUsed"], reverse=True)
    return [folder for folder in ordered if os.path.isdir(folder["path"])][:limit]

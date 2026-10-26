"""Choix du dossier d'un nouvel agent : sous-dossiers d'un dossier, dossiers récemment utilisés,
création d'un sous-dossier.

Seuls des noms de dossiers sont renvoyés, jamais le contenu des fichiers. Les dossiers cachés
(qui commencent par « . ») ne sont pas proposés, ni créés.
"""

import os
from pathlib import Path

MAX_ENTRIES = 500
MAX_NAME = 255


def resolve_dir(path):
    """Chemin absolu normalisé d'un dossier existant ; ValueError sinon."""
    if not isinstance(path, str) or not path.strip():
        raise ValueError("chemin vide")
    candidate = Path(path.strip()).expanduser()
    if not candidate.is_absolute():
        raise ValueError("chemin absolu attendu (il commence par /)")
    candidate = candidate.resolve()
    if not candidate.is_dir():
        raise ValueError("ce dossier n'existe pas")
    return candidate


def list_subfolders(path):
    """Sous-dossiers visibles d'un dossier, triés par nom."""
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
        raise ValueError("accès refusé à ce dossier") from None
    names.sort(key=str.lower)
    return {
        "path": str(folder),
        "parent": str(folder.parent) if folder.parent != folder else None,
        "home": str(Path.home()),
        "dirs": names[:MAX_ENTRIES],
        "truncated": len(names) > MAX_ENTRIES,
    }


def create_subfolder(parent, name):
    """Crée le dossier `name` dans `parent` (existant) et retourne son chemin ; ValueError sinon.

    Un seul niveau : le nom ne contient pas de « / » et ne commence pas par « . ».
    """
    folder = resolve_dir(parent)
    name = name.strip() if isinstance(name, str) else ""
    if not name:
        raise ValueError("nom de dossier vide")
    if "/" in name or "\0" in name:
        raise ValueError("le nom ne peut pas contenir « / »")
    if name.startswith("."):
        raise ValueError("le nom ne peut pas commencer par « . »")
    if len(name.encode()) > MAX_NAME:
        raise ValueError("nom de dossier trop long")
    target = folder / name
    try:
        target.mkdir(mode=0o755)
    except FileExistsError:
        raise ValueError("ce dossier existe déjà") from None
    except PermissionError:
        raise ValueError("pas le droit de créer un dossier ici") from None
    except OSError as exc:
        raise ValueError(f"création impossible : {exc.strerror or exc}") from None
    return target


def in_git_repo(path):
    """Le dossier est-il dans un dépôt git (lui-même ou l'un de ses parents contient un .git) ?

    `.git` peut être un dossier (dépôt) ou un fichier (worktree, sous-module).
    """
    if not isinstance(path, str) or not path:
        return False
    try:
        current = Path(path).resolve()
    except (OSError, RuntimeError):
        return False
    return any((folder / ".git").exists() for folder in (current, *current.parents))


def recent_folders(entries, limit=5):
    """Dossiers les plus récemment utilisés par des agents, encore existants.

    `entries` : des {"cwd", "updatedAt"} (sessions, discussions), dans n'importe quel ordre.
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

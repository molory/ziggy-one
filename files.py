"""Onglet Fichiers : parcourir, lire, chercher et modifier les fichiers du dossier d'un agent.

Tout chemin demandé est relatif au dossier de l'agent et doit y rester une fois les liens
symboliques résolus. Le dossier `.git` n'est jamais lu, listé, cherché ni modifié.
"""

import mimetypes
import os
import stat
import subprocess
import tempfile
import threading
import time

import gitops
from folders import in_git_repo, resolve_dir

MAX_ENTRIES = 2000
MAX_TEXT = 1_000_000
MAX_EDITABLE = 512_000
MAX_IMAGE = 10_000_000
SNIFF = 8192
MAX_NAME_RESULTS = 200
MAX_CONTENT_RESULTS = 500
MAX_LINE = 300
MAX_QUERY = 500
MAX_WALK = 50_000
SEARCH_TIMEOUT = 10
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".bmp"}
IMAGE_MIME = {".svg": "image/svg+xml", ".webp": "image/webp", ".ico": "image/x-icon", ".bmp": "image/bmp"}
SKIPPED_DIRS = {".git", "node_modules", "venv", ".venv", "__pycache__", "dist", "build", "target", ".idea", ".cache"}
OUTSIDE = "chemin en dehors du dossier de l'agent"
CONFLICT = ("Le fichier a changé sur le disque depuis son ouverture (un agent l'a peut-être modifié) : "
            "recharge-le avant d'enregistrer.")


class FileConflict(Exception):
    """Le fichier a changé depuis son ouverture ; `version` est celle sur le disque."""

    def __init__(self, version):
        super().__init__(CONFLICT)
        self.version = version


# --- chemins ---------------------------------------------------------------------------

def _root(path):
    """Dossier de l'agent, résolu ; refusé s'il est dans un `.git`."""
    root = resolve_dir(path)
    if ".git" in root.parts:
        raise ValueError("le dossier .git n'est pas accessible")
    return str(root)


def _inside(root, real):
    """Chemin relatif (« / ») de `real` dans `root` ; ValueError s'il en sort ou passe par `.git`."""
    if real != root and not real.startswith(root.rstrip(os.sep) + os.sep):
        raise ValueError(OUTSIDE)
    rel = os.path.relpath(real, root)
    parts = [] if rel == "." else rel.split(os.sep)
    if ".git" in parts:
        raise ValueError("le dossier .git n'est pas accessible")
    return parts


def _resolve(root, rel):
    """(chemin réel, chemin relatif normalisé) d'un chemin relatif au dossier de l'agent."""
    if rel is None:
        rel = ""
    if not isinstance(rel, str) or "\0" in rel:
        raise ValueError("chemin invalide")
    if rel.startswith("/") or os.path.isabs(rel):
        raise ValueError(OUTSIDE)
    parts = [part for part in rel.split("/") if part not in ("", ".")]
    if ".." in parts:
        raise ValueError(OUTSIDE)
    if ".git" in parts:
        raise ValueError("le dossier .git n'est pas accessible")
    real = os.path.realpath(os.path.join(root, *parts))
    _inside(root, real)
    return real, "/".join(parts)


def _version(info):
    return f"{info.st_mtime_ns}-{info.st_size}"


def _regular_file(root, rel):
    """(chemin réel, chemin relatif, stat) d'un fichier existant du dossier de l'agent."""
    real, rel = _resolve(root, rel)
    if not rel:
        raise ValueError("fichier attendu")
    try:
        info = os.stat(real)
    except FileNotFoundError:
        raise ValueError("ce fichier n'existe pas") from None
    if not stat.S_ISREG(info.st_mode):
        raise ValueError("ce n'est pas un fichier")
    return real, rel, info


# --- lecture ---------------------------------------------------------------------------

def list_dir(path, rel=""):
    """Contenu d'un seul dossier : dossiers puis fichiers, par nom ; sans `.git`."""
    root = _root(path)
    real, rel = _resolve(root, rel)
    if not os.path.isdir(real):
        raise ValueError("ce dossier n'existe pas")
    entries = []
    try:
        with os.scandir(real) as scan:
            for entry in scan:
                if entry.name == ".git":
                    continue
                try:
                    if entry.is_symlink():
                        _inside(root, os.path.realpath(entry.path))
                    info = entry.stat()
                except (OSError, ValueError):
                    continue  # lien cassé, hors du dossier ou vers .git
                if stat.S_ISDIR(info.st_mode):
                    entries.append({"name": entry.name, "type": "dir", "size": None})
                else:
                    entries.append({"name": entry.name, "type": "file", "size": info.st_size})
    except PermissionError:
        raise ValueError("accès refusé à ce dossier") from None
    entries.sort(key=lambda e: (e["type"] != "dir", e["name"].lower(), e["name"]))
    return {"dir": rel, "entries": entries[:MAX_ENTRIES], "truncated": len(entries) > MAX_ENTRIES}


def _image_mime(extension):
    return IMAGE_MIME.get(extension) or mimetypes.guess_type("x" + extension)[0] or "application/octet-stream"


def _describe(real, rel, info):
    """Nature d'un fichier (texte, image, binaire, trop gros) et, pour un texte, son contenu."""
    size = info.st_size
    result = {"file": rel, "size": size, "version": _version(info), "editable": False}
    extension = os.path.splitext(real)[1].lower()
    if extension in IMAGE_EXTENSIONS:
        if size > MAX_IMAGE:
            return {**result, "kind": "too_large"}
        return {**result, "kind": "image", "mime": _image_mime(extension)}
    if size > MAX_TEXT:
        return {**result, "kind": "too_large"}
    with open(real, "rb") as handle:
        data = handle.read(MAX_TEXT + 1)
    if b"\0" in data[:SNIFF]:
        return {**result, "kind": "binary"}
    try:
        content = data.decode("utf-8")
    except UnicodeDecodeError:
        return {**result, "kind": "binary"}
    return {**result, "kind": "text", "content": content, "editable": len(data) <= MAX_EDITABLE}


def read_file(path, rel):
    """Fichier à afficher : texte (contenu), image, binaire ou trop gros ; avec sa version."""
    root = _root(path)
    real, rel, info = _regular_file(root, rel)
    return _describe(real, rel, info)


def read_image(path, rel):
    """(octets, type MIME) d'une image du dossier de l'agent ; ValueError pour tout autre fichier."""
    root = _root(path)
    real, rel, info = _regular_file(root, rel)
    described = _describe(real, rel, info)
    if described["kind"] != "image":
        raise ValueError("ce fichier n'est pas une image affichable")
    with open(real, "rb") as handle:
        return handle.read(MAX_IMAGE + 1)[:MAX_IMAGE], described["mime"]


# --- écriture --------------------------------------------------------------------------

def write_file(path, rel, content, version):
    """Remplace le contenu d'un fichier texte existant, sauf s'il a changé depuis `version`.

    Écriture atomique (fichier temporaire puis renommage), droits du fichier conservés.
    """
    if not isinstance(content, str):
        raise ValueError("contenu texte attendu")
    if not isinstance(version, str) or not version:
        raise ValueError("version attendue")
    root = _root(path)
    real, rel, info = _regular_file(root, rel)
    if _version(info) != version:
        raise FileConflict(_version(info))
    described = _describe(real, rel, info)
    if described["kind"] != "text" or not described["editable"]:
        raise ValueError("ce fichier ne peut pas être modifié ici (binaire ou trop gros)")
    data = content.encode("utf-8")
    if len(data) > MAX_EDITABLE:
        raise ValueError("contenu trop gros (512 Ko au plus)")
    folder, name = os.path.split(real)
    fd, tmp = tempfile.mkstemp(dir=folder, prefix=f".{name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fchmod(handle.fileno(), stat.S_IMODE(info.st_mode))
            os.fsync(handle.fileno())
        os.replace(tmp, real)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    after = os.stat(real)
    return {"file": rel, "version": _version(after), "size": after.st_size}


# --- recherche -------------------------------------------------------------------------

def _in_git(root):
    """Le dossier est-il dans l'arbre de travail d'un vrai dépôt git ?"""
    if not in_git_repo(root):
        return False
    try:
        result = gitops.run(root, "rev-parse", "--is-inside-work-tree", timeout=SEARCH_TIMEOUT, check=False)
    except gitops.GitError:
        return False
    return result.returncode == 0 and result.stdout.strip() == "true"


def _git_files(root):
    """Fichiers suivis et non suivis (hors .gitignore) sous `root`, ou None hors dépôt git."""
    if not _in_git(root):
        return None
    try:
        result = gitops.run(root, "ls-files", "-co", "--exclude-standard", "-z",
                            timeout=SEARCH_TIMEOUT, check=False)
    except gitops.GitError:
        return None
    if result.returncode != 0:
        return None
    names = [name for name in result.stdout.split("\0") if name and ".git" not in name.split("/")]
    return list(dict.fromkeys(names))  # un fichier en conflit apparaît plusieurs fois


def _walk_files(root):
    """Fichiers sous `root` hors dossiers ignorés (.git, node_modules…) ; (liste, tronquée)."""
    found = []
    for folder, dirs, names in os.walk(root):
        dirs[:] = sorted(d for d in dirs if d not in SKIPPED_DIRS)
        rel_folder = os.path.relpath(folder, root)
        for name in sorted(names):
            rel = name if rel_folder == "." else os.path.join(rel_folder, name)
            found.append(rel.replace(os.sep, "/"))
            if len(found) >= MAX_WALK:
                return found, True
    return found, False


def _all_files(root):
    files = _git_files(root)
    if files is not None:
        return files[:MAX_WALK], len(files) > MAX_WALK, True
    files, truncated = _walk_files(root)
    return files, truncated, False


def _is_subsequence(query, text):
    position = 0
    for char in query:
        position = text.find(char, position) + 1
        if not position:
            return False
    return True


def _name_rank(query, rel):
    """Rang d'un chemin pour la recherche par nom (plus petit = meilleur), None s'il ne correspond pas."""
    lower = rel.lower()
    base = lower.rsplit("/", 1)[-1]
    if query in base:
        tier = 0
    elif query in lower:
        tier = 1
    elif _is_subsequence(query, base):
        tier = 2
    elif _is_subsequence(query, lower):
        tier = 3
    else:
        return None
    return tier, len(rel), lower


def _search_names(root, query, files, truncated):
    query = query.lower()
    ranked = sorted((rank, rel) for rel in files if (rank := _name_rank(query, rel)) is not None)
    results = []
    for _, rel in ranked:
        if os.path.isfile(os.path.join(root, rel)):  # git peut lister un fichier supprimé
            results.append({"file": rel})
            if len(results) >= MAX_NAME_RESULTS:
                return {"results": results, "truncated": True}
    return {"results": results, "truncated": truncated}


def _git_grep(root, query):
    """Recherche par `git grep` (fichiers suivis et non suivis, sans binaires) ; arrêtée à 500 lignes."""
    command = ["git", "grep", "-n", "-I", "-i", "-F", "-z", "--untracked", "--no-color", "-e", query, "--"]
    with tempfile.TemporaryFile() as errors:
        try:
            process = subprocess.Popen(command, cwd=root, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                       stderr=errors, env=gitops._env())
        except OSError as exc:
            raise ValueError(f"impossible de lancer git : {exc}") from None
        timer = threading.Timer(SEARCH_TIMEOUT, process.kill)
        timer.start()
        results, truncated = [], False
        try:
            for line in process.stdout:
                fields = line.rstrip(b"\r\n").split(b"\0", 2)
                if len(fields) != 3 or not fields[1].isdigit():
                    continue
                rel = fields[0].decode("utf-8", "replace")
                if ".git" in rel.split("/"):
                    continue
                if len(results) >= MAX_CONTENT_RESULTS:
                    truncated = True
                    break
                text = fields[2].decode("utf-8", "replace")[:MAX_LINE]
                results.append({"file": rel, "line": int(fields[1]), "text": text})
        finally:
            if truncated:
                process.kill()
            process.stdout.close()
            code = process.wait()
            timer.cancel()
        if code not in (0, 1) and not truncated:  # 1 : aucune ligne trouvée
            if code < 0:  # arrêtée par le délai
                return {"results": results, "truncated": True}
            errors.seek(0)
            detail = errors.read().decode("utf-8", "replace").strip()
            raise ValueError(f"recherche impossible : {detail[-500:] or f'git grep a échoué ({code})'}")
    return {"results": results, "truncated": truncated}


def _scan_contents(root, query, files, truncated):
    """Recherche ligne à ligne hors dépôt git, sans binaires ni fichiers de plus de 1 Mo."""
    query = query.lower()
    deadline = time.monotonic() + SEARCH_TIMEOUT
    results = []
    for rel in files:
        if time.monotonic() > deadline:
            return {"results": results, "truncated": True}
        full = os.path.join(root, rel)
        try:
            _inside(root, os.path.realpath(full))
            if not os.path.isfile(full) or os.path.getsize(full) > MAX_TEXT:
                continue
            with open(full, "rb") as handle:
                data = handle.read(MAX_TEXT + 1)
        except (OSError, ValueError):
            continue
        if b"\0" in data[:SNIFF]:
            continue
        for number, line in enumerate(data.decode("utf-8", "replace").splitlines(), 1):
            if query in line.lower():
                if len(results) >= MAX_CONTENT_RESULTS:
                    return {"results": results, "truncated": True}
                results.append({"file": rel, "line": number, "text": line[:MAX_LINE]})
    return {"results": results, "truncated": truncated}


def search(path, query, mode="name"):
    """Recherche dans le dossier de l'agent, par nom de fichier (approchée) ou par contenu (texte exact)."""
    root = _root(path)
    if not isinstance(query, str) or not query.strip():
        raise ValueError("recherche vide")
    if "\0" in query or len(query) > MAX_QUERY:
        raise ValueError("recherche invalide")
    if mode not in ("name", "content"):
        raise ValueError("mode de recherche inconnu (name ou content)")
    if mode == "name":
        files, truncated, _ = _all_files(root)
        return _search_names(root, query.strip(), files, truncated)
    if _in_git(root):
        return _git_grep(root, query)
    files, truncated = _walk_files(root)
    return _scan_contents(root, query, files, truncated)

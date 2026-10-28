"""Files tab: browse, read, search and edit the files of an agent's folder.

Every requested path is relative to the agent's folder and must stay in it once symbolic links are
resolved. The `.git` folder is never read, listed, searched or changed.
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
from i18n import tr
from storage import default_data_dir

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
# English sources, translated (tr) when raised.
OUTSIDE = "Path outside the agent's folder"
CONFLICT = ("The file changed on disk since it was opened (an agent may have edited it): "
            "reload it before saving.")


class FileConflict(Exception):
    """The file changed since it was opened; `version` is the one on disk."""

    def __init__(self, version):
        super().__init__(tr(CONFLICT))
        self.version = version


# --- paths -----------------------------------------------------------------------------

PROTECTED_MESSAGE = "This folder holds secrets: the Files tab does not open it"


def _protected_dirs():
    """Folders of secrets never shown, even inside an agent's folder: Ziggy One's data (its token),
    SSH, GnuPG and AWS keys."""
    home = os.path.expanduser("~")
    folders = [default_data_dir(), *(os.path.join(home, name) for name in (".ssh", ".gnupg", ".aws"))]
    return [os.path.realpath(folder) for folder in folders]


def _is_protected(real):
    return any(real == folder or real.startswith(folder + os.sep) for folder in _protected_dirs())


def _root(path):
    """The agent's folder, resolved; refused if it is inside a `.git` or a folder of secrets."""
    root = resolve_dir(path)
    if ".git" in root.parts:
        raise ValueError(tr("The .git folder is not accessible"))
    if _is_protected(str(root)):
        raise ValueError(tr(PROTECTED_MESSAGE))
    return str(root)


def _inside(root, real):
    """Relative path ("/") of `real` in `root`; ValueError if it goes outside or through `.git`."""
    if real != root and not real.startswith(root.rstrip(os.sep) + os.sep):
        raise ValueError(tr(OUTSIDE))
    rel = os.path.relpath(real, root)
    parts = [] if rel == "." else rel.split(os.sep)
    if ".git" in parts:
        raise ValueError(tr("The .git folder is not accessible"))
    if _is_protected(real):
        raise ValueError(tr(PROTECTED_MESSAGE))
    return parts


def _resolve(root, rel):
    """(real path, normalized relative path) of a path relative to the agent's folder."""
    if rel is None:
        rel = ""
    if not isinstance(rel, str) or "\0" in rel:
        raise ValueError(tr("Invalid path"))
    if rel.startswith("/") or os.path.isabs(rel):
        raise ValueError(tr(OUTSIDE))
    parts = [part for part in rel.split("/") if part not in ("", ".")]
    if ".." in parts:
        raise ValueError(tr(OUTSIDE))
    if ".git" in parts:
        raise ValueError(tr("The .git folder is not accessible"))
    real = os.path.realpath(os.path.join(root, *parts))
    _inside(root, real)
    return real, "/".join(parts)


def _version(info):
    return f"{info.st_mtime_ns}-{info.st_size}"


def _regular_file(root, rel):
    """(real path, relative path, stat) of an existing file of the agent's folder."""
    real, rel = _resolve(root, rel)
    if not rel:
        raise ValueError(tr("Expected a file"))
    try:
        info = os.stat(real)
    except FileNotFoundError:
        raise ValueError(tr("This file does not exist")) from None
    if not stat.S_ISREG(info.st_mode):
        raise ValueError(tr("This is not a file"))
    return real, rel, info


# --- reading ---------------------------------------------------------------------------

def list_dir(path, rel=""):
    """Content of a single folder: folders then files, by name; without `.git`."""
    root = _root(path)
    real, rel = _resolve(root, rel)
    if not os.path.isdir(real):
        raise ValueError(tr("This folder does not exist"))
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
                    continue  # broken link, outside the folder or to .git
                if stat.S_ISDIR(info.st_mode):
                    entries.append({"name": entry.name, "type": "dir", "size": None})
                else:
                    entries.append({"name": entry.name, "type": "file", "size": info.st_size})
    except PermissionError:
        raise ValueError(tr("Access to this folder denied")) from None
    entries.sort(key=lambda e: (e["type"] != "dir", e["name"].lower(), e["name"]))
    return {"dir": rel, "entries": entries[:MAX_ENTRIES], "truncated": len(entries) > MAX_ENTRIES}


def _image_mime(extension):
    return IMAGE_MIME.get(extension) or mimetypes.guess_type("x" + extension)[0] or "application/octet-stream"


def _describe(real, rel, info):
    """Kind of a file (text, image, binary, too large) and, for a text, its content."""
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
    """File to display: text (content), image, binary or too large; with its version."""
    root = _root(path)
    real, rel, info = _regular_file(root, rel)
    return _describe(real, rel, info)


def read_image(path, rel):
    """(bytes, MIME type) of an image of the agent's folder; ValueError for any other file."""
    root = _root(path)
    real, rel, info = _regular_file(root, rel)
    described = _describe(real, rel, info)
    if described["kind"] != "image":
        raise ValueError(tr("This file is not a displayable image"))
    with open(real, "rb") as handle:
        return handle.read(MAX_IMAGE + 1)[:MAX_IMAGE], described["mime"]


# --- writing ---------------------------------------------------------------------------

def write_file(path, rel, content, version):
    """Replaces the content of an existing text file, unless it changed since `version`.

    Atomic write (temporary file then rename), file permissions kept.
    """
    if not isinstance(content, str):
        raise ValueError(tr("Expected text content"))
    if not isinstance(version, str) or not version:
        raise ValueError(tr("Expected a version"))
    root = _root(path)
    real, rel, info = _regular_file(root, rel)
    if _version(info) != version:
        raise FileConflict(_version(info))
    described = _describe(real, rel, info)
    if described["kind"] != "text" or not described["editable"]:
        raise ValueError(tr("This file cannot be edited here (binary or too large)"))
    data = content.encode("utf-8")
    if len(data) > MAX_EDITABLE:
        raise ValueError(tr("Content too large (512 KB at most)"))
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


# --- search ----------------------------------------------------------------------------

def _in_git(root):
    """Is the folder in the working tree of a real git repository?"""
    if not in_git_repo(root):
        return False
    try:
        result = gitops.run(root, "rev-parse", "--is-inside-work-tree", timeout=SEARCH_TIMEOUT, check=False)
    except gitops.GitError:
        return False
    return result.returncode == 0 and result.stdout.strip() == "true"


def _git_files(root):
    """Tracked and untracked files (excluding .gitignore) under `root`, or None outside a git repository."""
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
    return list(dict.fromkeys(names))  # a conflicted file appears several times


def _walk_files(root):
    """Files under `root` excluding ignored folders (.git, node_modules…); (list, truncated)."""
    found = []
    for folder, dirs, names in os.walk(root):
        dirs[:] = sorted(d for d in dirs if d not in SKIPPED_DIRS
                         and not _is_protected(os.path.realpath(os.path.join(folder, d))))
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
    """Rank of a path for the name search (smaller = better), None if it does not match."""
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
        if os.path.isfile(os.path.join(root, rel)):  # git may list a deleted file
            results.append({"file": rel})
            if len(results) >= MAX_NAME_RESULTS:
                return {"results": results, "truncated": True}
    return {"results": results, "truncated": truncated}


def _git_grep(root, query):
    """Search with `git grep` (tracked and untracked files, no binaries); stopped at 500 lines."""
    command = ["git", "grep", "-n", "-I", "-i", "-F", "-z", "--untracked", "--no-color", "-e", query, "--"]
    with tempfile.TemporaryFile() as errors:
        try:
            process = subprocess.Popen(command, cwd=root, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                       stderr=errors, env=gitops._env())
        except OSError as exc:
            raise ValueError(tr("Could not run git: {error}", error=exc)) from None
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
        if code not in (0, 1) and not truncated:  # 1: no line found
            if code < 0:  # stopped by the timeout
                return {"results": results, "truncated": True}
            errors.seek(0)
            detail = errors.read().decode("utf-8", "replace").strip()
            raise ValueError(tr("Search failed: {detail}", detail=detail[-500:] or f"git grep failed ({code})"))
    return {"results": results, "truncated": truncated}


def _scan_contents(root, query, files, truncated):
    """Line-by-line search outside a git repository, without binaries or files over 1 MB."""
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
    """Search in the agent's folder, by file name (fuzzy) or by content (exact text)."""
    root = _root(path)
    if not isinstance(query, str) or not query.strip():
        raise ValueError(tr("Empty search"))
    if "\0" in query or len(query) > MAX_QUERY:
        raise ValueError(tr("Invalid search"))
    if mode not in ("name", "content"):
        raise ValueError(tr("Unknown search mode (name or content)"))
    if mode == "name":
        files, truncated, _ = _all_files(root)
        return _search_names(root, query.strip(), files, truncated)
    if _in_git(root):
        return _git_grep(root, query)
    files, truncated = _walk_files(root)
    return _scan_contents(root, query, files, truncated)

"""Opérations git de l'écran Git (façon Sourcetree) : état, historique, diffs, et quelques actions
(indexer, annuler, commiter, changer ou créer de branche, fetch, pull, push).

Git est lancé sans shell, avec des arguments contrôlés : les noms de branche sont validés par git,
les chemins de fichiers sont passés après « -- » et doivent rester dans le dépôt. Git ne peut jamais
attendre un mot de passe (GIT_TERMINAL_PROMPT=0, ssh en mode batch) et chaque commande a un délai.
Aucune opération qui réécrit l'historique (reset --hard, push --force…) n'est proposée.
"""

import os
import re
import subprocess

LOCAL_TIMEOUT = 20
NETWORK_TIMEOUT = 90
MAX_DIFF = 400_000
MAX_LOG = 500
MAX_FILES = 500
HASH_RE = re.compile(r"^[0-9a-f]{4,40}$")
FIELD, RECORD = "\x1f", "\x1e"


class GitError(Exception):
    """Erreur à montrer telle quelle dans l'interface."""


NOTHING_STAGED = "Aucun fichier indexé : indexe des fichiers (bouton + ou « Tout indexer ») avant de commiter."

# Erreurs git courantes → explication en français et marche à suivre. Le premier motif trouvé dans
# la sortie de git l'emporte ; le détail technique de git est ajouté dessous.
FRIENDLY_ERRORS = [
    (("Author identity unknown", "Please tell me who you are", "empty ident name"),
     "Identité git non configurée : indique ton nom et ton e-mail avec "
     "`git config --global user.name \"…\"` et `git config --global user.email …`."),
    (("nothing to commit", "no changes added to commit", "nothing added to commit"), NOTHING_STAGED),
    (("pre-receive hook declined", "protected branch", "remote rejected"),
     "Le dépôt distant a refusé le push (branche protégée ou règle du serveur)."),
    (("[rejected]", "non-fast-forward", "fetch first", "Updates were rejected"),
     "Push refusé : le dépôt distant contient des commits que tu n'as pas. Fais d'abord un Pull."),
    (("Not possible to fast-forward", "Diverging branches", "have diverged"),
     "Pull impossible en avance rapide : ta branche et la branche distante ont divergé. "
     "Fusionne ou rebase dans un terminal (ziggy-one ne le fait pas à ta place)."),
    (("There is no tracking information", "no upstream branch"),
     "Cette branche ne suit aucune branche distante : fais d'abord un Push pour la créer."),
    (("couldn't find remote ref",),
     "La branche distante n'existe plus (supprimée sur le serveur). Fais un Fetch pour mettre à jour la liste."),
    (("does not appear to be a git repository", "repository not found", "Repository not found"),
     "Dépôt distant introuvable : vérifie son adresse (`git remote -v`) et que tu y as accès."),
    (("Permission denied", "Authentication failed", "returned error: 401", "returned error: 403", "could not read Username", "could not read Password",
      "terminal prompts disabled", "Host key verification failed", "Could not read from remote repository"),
     "Accès au dépôt distant refusé. ziggy-one ne peut pas demander de mot de passe : vérifie ta clé SSH "
     "(ssh-agent) ou ton gestionnaire d'identifiants git, puis réessaie."),
    (("Could not resolve host", "Connection timed out", "Connection refused", "Network is unreachable",
      "unable to access"),
     "Dépôt distant injoignable : vérifie ta connexion réseau et l'adresse du dépôt (`git remote -v`)."),
    (("would be overwritten by checkout", "would be overwritten by merge", "Please commit your changes or stash them"),
     "Des modifications locales seraient écrasées : commite-les ou annule-les avant de continuer."),
    (("is already used by worktree", "is already checked out at"),
     "Cette branche est ouverte dans un autre worktree : git ne permet pas de l'ouvrir ici aussi. "
     "Clique dessus dans la liste des branches pour afficher ce worktree."),
    (("already exists",),
     "Une branche de ce nom existe déjà."),
    (("index.lock",),
     "Une autre opération git est en cours (ou s'est interrompue). Réessaie dans un instant ; si le problème "
     "persiste, supprime le fichier .git/index.lock."),
    (("unmerged", "Unmerged paths", "fix conflicts", "CONFLICT"),
     "Conflits non résolus : résous-les dans ton éditeur ou un terminal avant de continuer."),
    (("did not match any file",),
     "Fichier introuvable dans le dépôt : la liste a peut-être changé, actualise."),
    (("hook",),
     "Un hook git a refusé l'opération : voir sa sortie ci-dessous."),
]


def friendly_error(raw, command):
    """Message d'erreur lisible : explication en français, puis le détail de git."""
    raw = raw.strip()
    for patterns, explanation in FRIENDLY_ERRORS:
        if any(pattern in raw for pattern in patterns):
            return f"{explanation}\n\nDétail git : {raw[-800:]}"
    return raw[-2000:] or f"git {command} a échoué"


def _env():
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_OPTIONAL_LOCKS": "0", "LC_ALL": "C"}
    env.setdefault("GIT_SSH_COMMAND", "ssh -o BatchMode=yes")
    return env


def run(root, *args, timeout=LOCAL_TIMEOUT, check=True):
    try:
        result = subprocess.run(
            ["git", *args], cwd=root, capture_output=True, text=True, errors="replace",
            timeout=timeout, stdin=subprocess.DEVNULL, env=_env(),
        )
    except subprocess.TimeoutExpired:
        raise GitError(f"git {args[0]} : délai dépassé") from None
    except OSError as exc:
        raise GitError(f"impossible de lancer git : {exc}") from None
    if check and result.returncode != 0:
        raise GitError(friendly_error(f"{result.stderr}\n{result.stdout}", args[0]))
    return result


def repo_root(path):
    """Racine du dépôt qui contient ce dossier ; GitError s'il n'y en a pas."""
    if not isinstance(path, str) or not os.path.isdir(path):
        raise GitError("dossier introuvable")
    result = run(path, "rev-parse", "--show-toplevel", check=False)
    if result.returncode != 0:
        raise GitError("ce dossier n'est pas dans un dépôt git")
    return result.stdout.strip()


def _safe_files(root, files):
    """Chemins relatifs au dépôt, refusés s'ils en sortent."""
    if not isinstance(files, list) or not files or len(files) > MAX_FILES:
        raise GitError("liste de fichiers invalide")
    safe = []
    for name in files:
        if not isinstance(name, str) or not name or "\0" in name or os.path.isabs(name):
            raise GitError("chemin de fichier invalide")
        full = os.path.normpath(os.path.join(root, name))
        if os.path.commonpath([root, full]) != root:
            raise GitError("ce fichier est hors du dépôt")
        safe.append(os.path.relpath(full, root))
    return safe


def _check_branch_name(root, name):
    if not isinstance(name, str) or not name or name.startswith("-"):
        raise GitError("nom de branche invalide")
    if run(root, "check-ref-format", "--branch", name, check=False).returncode != 0:
        raise GitError(f"nom de branche invalide : {name}")
    return name


# --- lecture --------------------------------------------------------------------------

def state(path):
    """Branche courante, avance/retard, fichiers modifiés (indexés ou non) et branches."""
    root = repo_root(path)
    porcelain = run(root, "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all").stdout
    info = {"head": None, "upstream": None, "ahead": 0, "behind": 0}
    staged, unstaged, untracked, conflicted = [], [], [], []
    tokens = porcelain.split("\0")
    index = 0
    while index < len(tokens):
        token = tokens[index]
        index += 1
        if not token:
            continue
        if token.startswith("# branch.head "):
            info["head"] = token[len("# branch.head "):]
        elif token.startswith("# branch.upstream "):
            info["upstream"] = token[len("# branch.upstream "):]
        elif token.startswith("# branch.ab "):
            ahead, behind = token[len("# branch.ab "):].split()
            info["ahead"], info["behind"] = int(ahead), -int(behind)
        elif token[0] in "12":
            parts = token.split(" ", 8 if token[0] == "1" else 9)
            xy, file_path = parts[1], parts[-1]
            original = None
            if token[0] == "2":  # renommage : le chemin d'origine suit
                original = tokens[index]
                index += 1
            if xy[0] != ".":
                staged.append({"path": file_path, "code": xy[0], "from": original})
            if xy[1] != ".":
                unstaged.append({"path": file_path, "code": xy[1], "from": None})
        elif token[0] == "u":
            conflicted.append({"path": token.split(" ", 10)[-1], "code": "U", "from": None})
        elif token[0] == "?":
            untracked.append({"path": token[2:], "code": "?", "from": None})

    refs = run(
        root, "for-each-ref",
        f"--format=%(refname){FIELD}%(refname:short){FIELD}%(upstream:short){FIELD}%(upstream:track,nobracket)"
        f"{FIELD}%(worktreepath)",
        "refs/heads", "refs/remotes",
    ).stdout
    local, remote = [], []
    for line in refs.splitlines():
        full, short, upstream, track, worktree = (line.split(FIELD) + ["", "", "", ""])[:5]
        if full.startswith("refs/heads/"):
            # Branche ouverte dans un autre worktree : on ne peut pas y passer ici, mais on peut afficher ce worktree.
            elsewhere = worktree and os.path.realpath(worktree) != os.path.realpath(root)
            local.append({
                "name": short, "current": short == info["head"], "upstream": upstream or None, "track": track or "",
                "worktree": worktree if elsewhere else None,
            })
        elif full.startswith("refs/remotes/") and not full.endswith("/HEAD"):
            remote.append(short)
    detached = info["head"] == "(detached)"
    return {
        "root": root,
        "name": os.path.basename(root),
        "branch": None if detached else info["head"],
        "detached": detached,
        "upstream": info["upstream"],
        "ahead": info["ahead"],
        "behind": info["behind"],
        "files": {"staged": staged, "unstaged": unstaged + conflicted, "untracked": untracked},
        "branches": {"local": local, "remote": remote},
        "remotes": run(root, "remote").stdout.split(),
    }


def _parse_refs(decoration):
    refs = []
    for ref in filter(None, (part.strip() for part in decoration.split(","))):
        if ref.startswith("HEAD -> "):
            refs.append({"type": "head", "name": ref[len("HEAD -> "):]})
        elif ref == "HEAD":
            refs.append({"type": "head", "name": "HEAD"})
        elif ref.startswith("tag: "):
            refs.append({"type": "tag", "name": ref[len("tag: "):]})
        else:
            refs.append({"type": "remote" if "/" in ref else "branch", "name": ref})
    return refs


def log(path, limit=200):
    """Historique de toutes les branches, du plus récent au plus ancien (pour le graphe)."""
    root = repo_root(path)
    limit = max(1, min(int(limit), MAX_LOG))
    fmt = FIELD.join(["%H", "%P", "%an", "%at", "%s", "%D"]) + RECORD
    result = run(root, "log", "--branches", "--remotes", "--tags", "HEAD", "--date-order",
                 f"--max-count={limit}", f"--format={fmt}", check=False)
    if result.returncode != 0:
        if "does not have any commits" in result.stderr or "unknown revision" in result.stderr:
            return []  # dépôt sans aucun commit
        raise GitError(result.stderr.strip()[-2000:])
    commits = []
    for record in filter(None, (r.strip("\n") for r in result.stdout.split(RECORD))):
        commit_hash, parents, author, timestamp, subject, decoration = (record.split(FIELD) + [""] * 6)[:6]
        commits.append({
            "hash": commit_hash,
            "short": commit_hash[:7],
            "parents": parents.split(),
            "author": author,
            "date": int(timestamp or 0),
            "subject": subject,
            "refs": _parse_refs(decoration),
        })
    return commits


def commit_details(path, commit_hash):
    root = repo_root(path)
    if not isinstance(commit_hash, str) or not HASH_RE.match(commit_hash):
        raise GitError("identifiant de commit invalide")
    header = run(root, "show", "-s", f"--format=%H{FIELD}%an{FIELD}%ae{FIELD}%at{FIELD}%B", commit_hash).stdout
    full, author, email, timestamp, body = (header.split(FIELD, 4) + [""] * 5)[:5]
    names = run(root, "show", "--format=", "--name-status", "-z", "-M", "--diff-merges=first-parent", commit_hash).stdout
    tokens = [t for t in names.split("\0") if t]
    files, index = [], 0
    while index < len(tokens):
        code = tokens[index]
        if code[0] in "RC":  # renommé ou copié : ancien chemin, puis nouveau
            files.append({"code": code[0], "from": tokens[index + 1], "path": tokens[index + 2]})
            index += 3
        else:
            files.append({"code": code[0], "from": None, "path": tokens[index + 1]})
            index += 2
    return {"hash": full, "author": author, "email": email, "date": int(timestamp or 0),
            "message": body.strip(), "files": files}


def diff(path, file_name, mode, commit_hash=None):
    """Diff d'un fichier : non indexé, indexé, non suivi, ou dans un commit."""
    root = repo_root(path)
    (file_name,) = _safe_files(root, [file_name])
    if mode == "unstaged":
        result = run(root, "diff", "-M", "--", file_name)
    elif mode == "staged":
        result = run(root, "diff", "--cached", "-M", "--", file_name)
    elif mode == "untracked":
        # Fichier nouveau : comparé à « rien » (git renvoie 1 quand il y a une différence).
        result = run(root, "diff", "--no-index", "--", os.devnull, file_name, check=False)
    elif mode == "commit":
        if not isinstance(commit_hash, str) or not HASH_RE.match(commit_hash):
            raise GitError("identifiant de commit invalide")
        result = run(root, "show", "--format=", "-M", "--diff-merges=first-parent", commit_hash, "--", file_name)
    else:
        raise GitError("type de diff inconnu")
    text = result.stdout
    return {"diff": text[:MAX_DIFF], "truncated": len(text) > MAX_DIFF}


# --- actions ----------------------------------------------------------------------------

def _output(*results):
    return "\n".join(filter(None, ((r.stdout + r.stderr).strip() for r in results)))


def stage(path, files=None):
    root = repo_root(path)
    if files is None:
        return _output(run(root, "add", "-A"))
    return _output(run(root, "add", "-A", "--", *_safe_files(root, files)))


def unstage(path, files=None):
    root = repo_root(path)
    targets = _safe_files(root, files) if files is not None else ["."]
    if run(root, "rev-parse", "--verify", "-q", "HEAD", check=False).returncode != 0:
        # Pas encore de commit : on retire simplement les fichiers de l'index.
        return _output(run(root, "rm", "--cached", "-r", "-q", "--", *targets))
    return _output(run(root, "restore", "--staged", "--", *targets))


def discard(path, files):
    """Annule les modifications non indexées ; supprime les fichiers non suivis demandés."""
    root = repo_root(path)
    targets = _safe_files(root, files)
    untracked = {f["path"] for f in state(root)["files"]["untracked"]}
    to_clean = [f for f in targets if f in untracked]
    to_restore = [f for f in targets if f not in untracked]
    results = []
    if to_restore:
        results.append(run(root, "restore", "--worktree", "--", *to_restore))
    if to_clean:
        results.append(run(root, "clean", "-f", "-q", "--", *to_clean))
    return _output(*results)


def has_staged_changes(root):
    # Code 1 : l'index diffère du dernier commit (ou de l'arbre vide dans un dépôt sans commit).
    return run(root, "diff", "--cached", "--quiet", check=False).returncode == 1


def commit(path, message):
    root = repo_root(path)
    if not has_staged_changes(root):
        raise GitError(NOTHING_STAGED)
    if not isinstance(message, str) or not message.strip():
        raise GitError("le message de commit est vide")
    if len(message) > 10_000:
        raise GitError("message de commit trop long")
    return _output(run(root, "commit", "-m", message.strip()))


def checkout(path, name):
    """Passe sur une branche locale, ou crée la branche locale qui suit une branche distante."""
    root = repo_root(path)
    current = state(root)
    local = {b["name"] for b in current["branches"]["local"]}
    if name in local:
        return _output(run(root, "switch", _check_branch_name(root, name)))
    if name in current["branches"]["remote"]:
        local_name = _check_branch_name(root, name.split("/", 1)[1])
        if local_name in local:
            return _output(run(root, "switch", local_name))
        return _output(run(root, "switch", "-c", local_name, "--track", name))
    raise GitError(f"branche inconnue : {name}")


def create_branch(path, name):
    root = repo_root(path)
    return _output(run(root, "switch", "-c", _check_branch_name(root, name)))


def fetch(path):
    root = repo_root(path)
    return _output(run(root, "fetch", "--all", "--prune", timeout=NETWORK_TIMEOUT)) or "À jour."


def pull(path):
    root = repo_root(path)
    return _output(run(root, "pull", "--ff-only", timeout=NETWORK_TIMEOUT))


def push(path):
    """Pousse la branche courante ; sans branche distante associée, la crée sur le dépôt distant."""
    root = repo_root(path)
    current = state(root)
    if current["detached"] or not current["branch"]:
        raise GitError("aucune branche courante à pousser")
    if current["upstream"]:
        return _output(run(root, "push", timeout=NETWORK_TIMEOUT))
    remotes = current["remotes"]
    if not remotes:
        raise GitError("aucun dépôt distant configuré")
    remote = "origin" if "origin" in remotes else remotes[0]
    return _output(run(root, "push", "-u", remote, "HEAD", timeout=NETWORK_TIMEOUT))

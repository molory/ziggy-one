"""Git operations of the Git screen (Sourcetree style): status, history, diffs, and a few actions
(stage, discard, commit, switch or create a branch, fetch, pull, push).

Git runs without a shell, with controlled arguments: branch names are validated by git, file paths
are passed after "--" and must stay inside the repository. Git can never wait for a password
(GIT_TERMINAL_PROMPT=0, ssh in batch mode) and every command has a timeout.
No operation that rewrites history (reset --hard, push --force…) is offered.
"""

import os
import re
import subprocess

from i18n import tr

LOCAL_TIMEOUT = 20
NETWORK_TIMEOUT = 90
MAX_DIFF = 400_000
MAX_LOG = 500
MAX_FILES = 500
HASH_RE = re.compile(r"^[0-9a-f]{4,40}$")
FIELD, RECORD = "\x1f", "\x1e"


class GitError(Exception):
    """Error to show as is in the interface."""


# English source, translated (tr) when raised.
NOTHING_STAGED = "No staged files: stage files (+ button or \"Stage all\") before committing."

# Common git errors → plain explanation and what to do (English sources, translated when shown). The
# first pattern found in git's output wins; git's technical details are added below.
FRIENDLY_ERRORS = [
    (("Author identity unknown", "Please tell me who you are", "empty ident name"),
     "Git identity not configured: set your name and email with "
     "`git config --global user.name \"…\"` and `git config --global user.email …`."),
    (("nothing to commit", "no changes added to commit", "nothing added to commit"), NOTHING_STAGED),
    (("pre-receive hook declined", "protected branch", "remote rejected"),
     "The remote repository rejected the push (protected branch or server rule)."),
    (("[rejected]", "non-fast-forward", "fetch first", "Updates were rejected"),
     "Push rejected: the remote repository has commits you do not have. Pull first."),
    (("Not possible to fast-forward", "Diverging branches", "have diverged"),
     "Cannot pull with a fast-forward: your branch and the remote branch have diverged. "
     "Merge or rebase in a terminal (ziggy-one does not do it for you)."),
    (("There is no tracking information", "no upstream branch"),
     "This branch does not track any remote branch: push first to create it."),
    (("couldn't find remote ref",),
     "The remote branch no longer exists (deleted on the server). Fetch to update the list."),
    (("does not appear to be a git repository", "repository not found", "Repository not found"),
     "Remote repository not found: check its address (`git remote -v`) and that you have access to it."),
    (("Permission denied", "Authentication failed", "returned error: 401", "returned error: 403", "could not read Username", "could not read Password",
      "terminal prompts disabled", "Host key verification failed", "Could not read from remote repository"),
     "Access to the remote repository denied. ziggy-one cannot ask for a password: check your SSH key "
     "(ssh-agent) or your git credential manager, then try again."),
    (("Could not resolve host", "Connection timed out", "Connection refused", "Network is unreachable",
      "unable to access"),
     "Remote repository unreachable: check your network connection and the repository address (`git remote -v`)."),
    (("would be overwritten by checkout", "would be overwritten by merge", "Please commit your changes or stash them"),
     "Local changes would be overwritten: commit or discard them before continuing."),
    (("is already used by worktree", "is already checked out at"),
     "This branch is checked out in another worktree: git does not allow checking it out here too. "
     "Click it in the branch list to show that worktree."),
    (("already exists",),
     "A branch with this name already exists."),
    (("index.lock",),
     "Another git operation is in progress (or was interrupted). Try again in a moment; if the problem "
     "persists, delete the .git/index.lock file."),
    (("unmerged", "Unmerged paths", "fix conflicts", "CONFLICT"),
     "Unresolved conflicts: resolve them in your editor or a terminal before continuing."),
    (("did not match any file",),
     "File not found in the repository: the list may have changed, refresh."),
    (("hook",),
     "A git hook rejected the operation: see its output below."),
]


def friendly_error(raw, command):
    """Readable error message: a plain explanation, then git's details."""
    raw = raw.strip()
    for patterns, explanation in FRIENDLY_ERRORS:
        if any(pattern in raw for pattern in patterns):
            return f"{tr(explanation)}\n\n{tr('Git details: {details}', details=raw[-800:])}"
    return raw[-2000:] or tr("git {command} failed", command=command)


# Shown diffs: never an external diff program or a textconv filter declared by the repository.
NO_DIFF_PROGRAMS = ("--no-ext-diff", "--no-textconv")

# Settings forced on every git call (like `git -c`, above the repository's config): a repository's
# `.git/config` must not run a program in the background (core.fsmonitor runs one on `git status`).
FORCED_CONFIG = (("core.fsmonitor", "false"),)


def _env():
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_OPTIONAL_LOCKS": "0", "LC_ALL": "C"}
    env.setdefault("GIT_SSH_COMMAND", "ssh -o BatchMode=yes")
    count = int(env["GIT_CONFIG_COUNT"]) if env.get("GIT_CONFIG_COUNT", "").isdigit() else 0
    for key, value in FORCED_CONFIG:  # after those of the environment, if any
        env[f"GIT_CONFIG_KEY_{count}"] = key
        env[f"GIT_CONFIG_VALUE_{count}"] = value
        count += 1
    env["GIT_CONFIG_COUNT"] = str(count)
    return env


def run(root, *args, timeout=LOCAL_TIMEOUT, check=True):
    try:
        result = subprocess.run(
            ["git", *args], cwd=root, capture_output=True, text=True, errors="replace",
            timeout=timeout, stdin=subprocess.DEVNULL, env=_env(),
        )
    except subprocess.TimeoutExpired:
        raise GitError(tr("git {command}: timed out", command=args[0])) from None
    except OSError as exc:
        raise GitError(tr("Could not run git: {error}", error=exc)) from None
    if check and result.returncode != 0:
        raise GitError(friendly_error(f"{result.stderr}\n{result.stdout}", args[0]))
    return result


def repo_root(path):
    """Root of the repository that contains this folder; GitError if there is none."""
    if not isinstance(path, str) or not os.path.isdir(path):
        raise GitError(tr("Folder not found"))
    result = run(path, "rev-parse", "--show-toplevel", check=False)
    if result.returncode != 0:
        raise GitError(tr("This folder is not in a git repository"))
    return result.stdout.strip()


def _safe_files(root, files):
    """Paths relative to the repository, refused if they go outside it."""
    if not isinstance(files, list) or not files or len(files) > MAX_FILES:
        raise GitError(tr("Invalid file list"))
    safe = []
    for name in files:
        if not isinstance(name, str) or not name or "\0" in name or os.path.isabs(name):
            raise GitError(tr("Invalid file path"))
        full = os.path.normpath(os.path.join(root, name))
        if os.path.commonpath([root, full]) != root:
            raise GitError(tr("This file is outside the repository"))
        safe.append(os.path.relpath(full, root))
    return safe


def _check_branch_name(root, name):
    if not isinstance(name, str) or not name or name.startswith("-"):
        raise GitError(tr("Invalid branch name"))
    if run(root, "check-ref-format", "--branch", name, check=False).returncode != 0:
        raise GitError(tr("Invalid branch name: {name}", name=name))
    return name


# --- reading --------------------------------------------------------------------------

def state(path):
    """Current branch, ahead/behind, changed files (staged or not) and branches."""
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
            if token[0] == "2":  # rename: the original path follows
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
            # Branch checked out in another worktree: cannot switch to it here, but that worktree can be shown.
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
    """History of all branches, newest first (for the graph)."""
    root = repo_root(path)
    limit = max(1, min(int(limit), MAX_LOG))
    fmt = FIELD.join(["%H", "%P", "%an", "%at", "%s", "%D"]) + RECORD
    result = run(root, "log", "--branches", "--remotes", "--tags", "HEAD", "--date-order",
                 f"--max-count={limit}", f"--format={fmt}", check=False)
    if result.returncode != 0:
        if "does not have any commits" in result.stderr or "unknown revision" in result.stderr:
            return []  # repository without any commit
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
        raise GitError(tr("Invalid commit id"))
    header = run(root, "show", "-s", f"--format=%H{FIELD}%an{FIELD}%ae{FIELD}%at{FIELD}%B", commit_hash).stdout
    full, author, email, timestamp, body = (header.split(FIELD, 4) + [""] * 5)[:5]
    names = run(root, "show", "--format=", "--name-status", "-z", "-M", "--diff-merges=first-parent", commit_hash).stdout
    tokens = [t for t in names.split("\0") if t]
    files, index = [], 0
    while index < len(tokens):
        code = tokens[index]
        if code[0] in "RC":  # renamed or copied: old path, then new one
            files.append({"code": code[0], "from": tokens[index + 1], "path": tokens[index + 2]})
            index += 3
        else:
            files.append({"code": code[0], "from": None, "path": tokens[index + 1]})
            index += 2
    return {"hash": full, "author": author, "email": email, "date": int(timestamp or 0),
            "message": body.strip(), "files": files}


def diff(path, file_name, mode, commit_hash=None):
    """Diff of a file: unstaged, staged, untracked, or in a commit."""
    root = repo_root(path)
    (file_name,) = _safe_files(root, [file_name])
    if mode == "unstaged":
        result = run(root, "diff", *NO_DIFF_PROGRAMS, "-M", "--", file_name)
    elif mode == "staged":
        result = run(root, "diff", *NO_DIFF_PROGRAMS, "--cached", "-M", "--", file_name)
    elif mode == "untracked":
        # New file: compared to "nothing" (git returns 1 when there is a difference).
        result = run(root, "diff", *NO_DIFF_PROGRAMS, "--no-index", "--", os.devnull, file_name, check=False)
    elif mode == "commit":
        if not isinstance(commit_hash, str) or not HASH_RE.match(commit_hash):
            raise GitError(tr("Invalid commit id"))
        result = run(root, "show", *NO_DIFF_PROGRAMS, "--format=", "-M", "--diff-merges=first-parent", commit_hash, "--", file_name)
    else:
        raise GitError(tr("Unknown diff type"))
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
        # No commit yet: simply remove the files from the index.
        return _output(run(root, "rm", "--cached", "-r", "-q", "--", *targets))
    return _output(run(root, "restore", "--staged", "--", *targets))


def discard(path, files):
    """Discards unstaged changes; deletes the requested untracked files."""
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
    # Exit code 1: the index differs from the last commit (or from the empty tree in a repository without commits).
    return run(root, "diff", "--cached", "--quiet", check=False).returncode == 1


def commit(path, message):
    root = repo_root(path)
    if not has_staged_changes(root):
        raise GitError(tr(NOTHING_STAGED))
    if not isinstance(message, str) or not message.strip():
        raise GitError(tr("The commit message is empty"))
    if len(message) > 10_000:
        raise GitError(tr("Commit message too long"))
    return _output(run(root, "commit", "-m", message.strip()))


def checkout(path, name):
    """Switches to a local branch, or creates the local branch that tracks a remote branch."""
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
    raise GitError(tr("Unknown branch: {name}", name=name))


def create_branch(path, name):
    root = repo_root(path)
    return _output(run(root, "switch", "-c", _check_branch_name(root, name)))


def fetch(path):
    root = repo_root(path)
    return _output(run(root, "fetch", "--all", "--prune", timeout=NETWORK_TIMEOUT)) or tr("Up to date.")


def pull(path):
    root = repo_root(path)
    return _output(run(root, "pull", "--ff-only", timeout=NETWORK_TIMEOUT))


def push(path):
    """Pushes the current branch; without an associated remote branch, creates it on the remote."""
    root = repo_root(path)
    current = state(root)
    if current["detached"] or not current["branch"]:
        raise GitError(tr("No current branch to push"))
    if current["upstream"]:
        return _output(run(root, "push", timeout=NETWORK_TIMEOUT))
    remotes = current["remotes"]
    if not remotes:
        raise GitError(tr("No remote repository configured"))
    remote = "origin" if "origin" in remotes else remotes[0]
    return _output(run(root, "push", "-u", remote, "HEAD", timeout=NETWORK_TIMEOUT))

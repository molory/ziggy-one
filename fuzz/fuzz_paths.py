"""Fuzz target: a path sent by the browser or an agent never resolves outside the agent's folder, nor into `.git`.

`files._resolve` is the guard of the Files tab and of every file route. The folder used here holds the traps: links
to the parent, to an outside folder, to an absolute path, to `.git`, a link loop. Run with atheris (Linux x86_64, CI):
    pip install --require-hashes --only-binary=:all: -r .github/requirements-fuzz.txt
    python fuzz/fuzz_paths.py -max_total_time=60
Without atheris, tests/test_fuzz.py runs the same check on random inputs.
"""

import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import files  # noqa: E402

try:
    import atheris
except ImportError:  # unit tests on any OS: RandomProvider instead (fuzz/provider.py)
    atheris = None

PARTS = ["", ".", "..", "...", ".git", ".GIT", "a", "b.txt", "up", "out", "abs", "git", "loop", "back", "~", "//",
         "\\", "..\\..", "a\0", ".git/", "a/..", "%2e%2e", " ", " "]


def make_tree(folder):
    """The agent's folder `root` (resolved) with its traps, next to an `outside` folder. Returns `root`."""
    base = Path(os.path.realpath(folder))
    root, outside = base / "root", base / "outside"
    (root / "a").mkdir(parents=True)
    (root / ".git").mkdir()
    outside.mkdir()
    (root / "a" / "b.txt").write_text("b")
    (root / ".git" / "config").write_text("[core]")
    (outside / "secret").write_text("s")
    links = {"up": "..", "out": str(outside), "abs": "/", "git": ".git", "loop": "loop", "a/back": "../.."}
    for name, target in links.items():
        os.symlink(target, root / name)
    return str(root)


def path(provider):
    parts = [provider.PickValueInList(PARTS) if provider.ConsumeIntInRange(0, 4) else provider.ConsumeUnicodeNoSurrogates(6)
             for _ in range(provider.ConsumeIntInRange(0, 6))]
    text = "/".join(parts)
    return "/" + text if provider.ConsumeIntInRange(0, 9) == 0 else text


def check(provider, root):
    rel = path(provider)
    try:
        real, normalized = files._resolve(root, rel)
    except ValueError:
        return  # refused: fine
    assert real == root or real.startswith(root + os.sep), f"{rel!r} resolved outside the folder: {real!r}"
    inside = os.path.relpath(real, root).split(os.sep)
    assert ".git" not in inside, f"{rel!r} resolved into .git: {real!r}"
    assert ".." not in normalized.split("/"), f"{rel!r} gave the relative path {normalized!r}"


def main():
    if atheris is None:
        sys.exit("atheris is not installed (Linux x86_64): see the docstring of this file")
    root = make_tree(tempfile.mkdtemp())
    atheris.instrument_all()
    atheris.Setup(sys.argv, lambda data: check(atheris.FuzzedDataProvider(data), root))
    atheris.Fuzz()


if __name__ == "__main__":
    main()

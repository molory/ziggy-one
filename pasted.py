"""Files pasted into an agent's terminal, saved so that Claude Code can read them by their path.

In a terminal, pasting a file copied in the Finder types its path. The browser only gives its content: it is
saved here, in a private folder of its own, and the terminal receives the path. Without this, Ziggy One
would send Ctrl+V and Claude Code would read the system clipboard itself, which holds the file's icon
(an image), not the file.

The folder is next to Ziggy One's data folder, not inside it: the agents are denied reading the data folder
(tokens, sessions), and a deny rule of Claude Code cannot have exceptions.

Files are kept 7 days, then removed at the next paste.
"""

import os
import re
import secrets
import shutil
import time
from pathlib import Path

from i18n import tr

MAX_SIZE = 25 * 1024 * 1024  # as a file attached to a ticket
KEEP = 7 * 24 * 3600
# Typed as is into the terminal: no space or character a shell or Claude Code would read specially.
UNSAFE = re.compile(r"[^\w.+-]+")


def safe_name(name):
    """Name of the saved file: the pasted file's base name, with the unsafe characters replaced by "_"."""
    base = os.path.basename(str(name or "").replace("\\", "/"))
    base = UNSAFE.sub("_", base).strip("._")[:120]
    return base or "pasted"


class PastedFiles:
    def __init__(self, folder):
        self.folder = Path(folder)

    def save(self, conversation_id, name, data):
        """Saves `data` (bytes) and returns its absolute path. Folder 0700, file 0600."""
        if not isinstance(data, bytes) or not data:
            raise ValueError(tr("Invalid file"))
        if len(data) > MAX_SIZE:
            raise ValueError(tr("File too large ({size} MB at most)", size=MAX_SIZE // (1024 * 1024)))
        self.prune()
        folder = self.folder / conversation_id / secrets.token_hex(8)
        folder.mkdir(parents=True, mode=0o700)
        for parent in (self.folder, self.folder / conversation_id):
            parent.chmod(0o700)
        path = folder / safe_name(name)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as file:
            file.write(data)
        return str(path)

    def prune(self, now=None):
        """Removes the pastes older than KEEP."""
        limit = (now or time.time()) - KEEP
        for paste in self.folder.glob("*/*"):
            try:
                if paste.is_dir() and not paste.is_symlink() and paste.stat().st_mtime < limit:
                    shutil.rmtree(paste, ignore_errors=True)
            except OSError:
                pass

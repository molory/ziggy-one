"""Generation of a commit message by Claude (Haiku), from the staged changes.

Claude only gets the staged diff (truncated if too long) and the titles of the latest commits, to
follow the language and style of the repository. It has no tools and does nothing but write.
"""

import json
import re
import subprocess
import tempfile

import gitops
from i18n import tr

MAX_DIFF = 60_000
TIMEOUT = 120
CLAUDE_CMD = [
    "claude", "-p", "--model", "haiku", "--tools", "", "--max-turns", "1",
    "--no-session-persistence", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--output-format", "json",
]
PROMPT = """Write the git commit message for the staged changes below.

- Follow the language and style of the repository's recent commits.
- A first title line of 72 characters at most, in the imperative mood, with no final period.
- If useful, a blank line then a few short bullet points that explain the why.
- Your answer is the message itself: no introductory sentence, no quotes, no code block.

Recent commits:
{recent}

Stats:
{stat}

Staged diff:
{diff}
"""


def clean(text):
    """Removes what the model sometimes adds around the message (code block, quotes, prefix)."""
    text = text.strip()
    fenced = re.search(r"```[\w-]*\n(.*?)(?:\n```|$)", text, flags=re.DOTALL)
    if fenced:
        # The message is in a code block, often preceded by an introductory sentence: keep the block.
        text = fenced.group(1).strip()
    else:
        lines = text.splitlines()
        if len(lines) > 1 and lines[0].rstrip().endswith(":"):
            text = "\n".join(lines[1:]).strip()  # an introduction such as "Here is the message:"
    text = re.sub(r"^(message de commit|commit message)\s*:\s*", "", text, flags=re.IGNORECASE).strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "\"'«":
        text = text[1:-1].strip()
    return text


def generate(path):
    """Proposed commit message for what is staged; GitError if there is nothing or on failure."""
    root = gitops.repo_root(path)
    if not gitops.has_staged_changes(root):
        raise gitops.GitError(tr(gitops.NOTHING_STAGED))
    diff = gitops.run(root, "diff", "--cached", "-M").stdout
    stat = gitops.run(root, "diff", "--cached", "--stat").stdout
    recent = gitops.run(root, "log", "-10", "--format=- %s", check=False).stdout or "(none)"
    if len(diff) > MAX_DIFF:
        diff = diff[:MAX_DIFF] + "\n… (diff truncated)"
    prompt = PROMPT.format(recent=recent.strip(), stat=stat.strip(), diff=diff)
    try:
        result = subprocess.run(
            CLAUDE_CMD, input=prompt, capture_output=True, text=True, timeout=TIMEOUT,
            cwd=tempfile.gettempdir(),  # outside the repository: no CLAUDE.md, no project settings
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise gitops.GitError(tr("Could not generate the message: {error}", error=exc)) from None
    try:
        payload = json.loads(result.stdout)
    except ValueError:
        raise gitops.GitError(result.stderr.strip()[-500:] or tr("Unreadable answer from Claude")) from None
    message = clean(str(payload.get("result") or ""))
    if payload.get("is_error") or not message:
        raise gitops.GitError(tr("Claude could not write the commit message"))
    return message

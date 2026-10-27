"""Ticket links readable by an agent: /t/<number>?k=<key>.

In the browser (Ziggy cookie), a ticket's address opens its card. Without a cookie, an agent (curl,
WebFetch…) that presents the ticket's key gets the ticket as Markdown text: title, board, column,
description, attached files (with their download link), cited tickets and history.

The key is an HMAC of the number with the server token: it opens that ticket only, read-only, and
`--new-token` invalidates all links at once. The links given in the text (files, cited tickets) carry
their own key: the agent can follow them.
"""

import hashlib
import hmac
import re
import time
from urllib.parse import quote

KEY_LENGTH = 20  # hex characters (80 bits)
REFERENCE_RE = re.compile(r"(^|[^\w&])#([1-9]\d{0,8})(?!\w)")  # same rule as the interface

HISTORY_LABELS = {
    "created": lambda e: f"Created in \"{e.get('column', '')}\"",
    "title": lambda e: f"Title: \"{e.get('before', '')}\" → \"{e.get('after', '')}\"",
    "description": lambda e: "Description changed" if e.get("before") else "Description added",
    "due": lambda e: (f"Delivery date: {e.get('before') or 'none'} → {e.get('after') or 'none'}"),
    "moved": lambda e: f"Moved from \"{e.get('fromColumn', '')}\" to \"{e.get('toColumn', '')}\""
                       + (f" ({e['reason']})" if e.get("reason") else ""),
    "file_added": lambda e: f"File attached: {e.get('name', '')}",
    "file_removed": lambda e: f"File removed: {e.get('name', '')}",
    "deleted": lambda e: "Deleted",
}


def key(token, number):
    return hmac.new(token.encode(), f"ticket:{number}".encode(), hashlib.sha256).hexdigest()[:KEY_LENGTH]


def valid(token, number, given):
    return isinstance(given, str) and hmac.compare_digest(given, key(token, number))


def ticket_path(token, number):
    """Path to share: /t/42?k=…"""
    return f"/t/{number}?k={key(token, number)}"


def file_path(token, number, file_id, name):
    return f"/t/{number}/files/{file_id}/{quote(name)}?k={key(token, number)}"


def _when(epoch):
    return time.strftime("%Y-%m-%d %H:%M", time.localtime(epoch))


def _size(size):
    return f"{size} B" if size < 1024 else f"{size / 1024:.0f} KB" if size < 1024 * 1024 else f"{size / 1048576:.1f} MB"


def render(export, token, origin):
    """The ticket as Markdown, for an agent. `export` comes from Kanban.export; `origin`: http://127.0.0.1:6767."""
    ticket = export["ticket"]
    number = ticket["number"]
    lines = [
        f"# #{number} · {ticket['title']}",
        "",
        f"- Board: {export['board']}",
        f"- Column: {export['column']}",
        *([f"- Delivery date: {ticket['due']}"] if ticket.get("due") else []),
        f"- Created {_when(ticket['createdAt'])} · updated {_when(ticket['updatedAt'])}",
        f"- Link: {origin}{ticket_path(token, number)}",
        "",
        "## Description",
        "",
        ticket["description"].strip() or "(none)",
    ]
    if ticket["files"]:
        lines += ["", "## Attached files", ""]
        lines += [f"- {f['name']} ({_size(f['size'])}): {origin}{file_path(token, number, f['id'], f['name'])}"
                  for f in ticket["files"]]
    cited = []
    for match in REFERENCE_RE.finditer(ticket["description"]):
        other = int(match.group(2))
        if other != number and other in export["known"] and other not in cited:
            cited.append(other)
    if cited:
        lines += ["", "## Cited tickets", ""]
        for other in cited:
            title, column = export["known"][other]
            where = f" ({column})" if column else ""
            lines.append(f"- #{other} · {title}{where}: {origin}{ticket_path(token, other)}")
    if export["history"]:
        lines += ["", "## History", ""]
        lines += [f"- {_when(e['at'])} · {HISTORY_LABELS.get(e['kind'], lambda _: e['kind'])(e)}"
                  + (f" (by {e['by']})" if e.get("by") not in (None, "user") else "") for e in export["history"]]
    return "\n".join(lines) + "\n"

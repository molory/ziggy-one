"""Liens de tickets lisibles par un agent : /t/<numéro>?k=<clé>.

Dans le navigateur (cookie de Ziggy), l'adresse d'un ticket ouvre sa fiche. Sans cookie, un agent (curl,
WebFetch…) qui présente la clé du ticket reçoit le ticket en texte Markdown : titre, tableau, colonne,
description, fichiers joints (avec leur lien de téléchargement), tickets cités et historique.

La clé est un HMAC du numéro par le token du serveur : elle ouvre ce ticket-là seulement, en lecture,
et `--new-token` invalide tous les liens d'un coup. Les liens donnés dans le texte (fichiers, tickets
cités) portent leur propre clé : l'agent peut les suivre.
"""

import hashlib
import hmac
import re
import time
from urllib.parse import quote

KEY_LENGTH = 20  # caractères hexadécimaux (80 bits)
REFERENCE_RE = re.compile(r"(^|[^\w&])#([1-9]\d{0,8})(?!\w)")  # même règle que l'interface

HISTORY_LABELS = {
    "created": lambda e: f"Créé dans « {e.get('column', '')} »",
    "title": lambda e: f"Titre : « {e.get('before', '')} » → « {e.get('after', '')} »",
    "description": lambda e: "Description modifiée" if e.get("before") else "Description ajoutée",
    "moved": lambda e: f"Déplacé de « {e.get('fromColumn', '')} » vers « {e.get('toColumn', '')} »"
                       + (f" ({e['reason']})" if e.get("reason") else ""),
    "file_added": lambda e: f"Fichier joint : {e.get('name', '')}",
    "file_removed": lambda e: f"Fichier retiré : {e.get('name', '')}",
    "deleted": lambda e: "Supprimé",
}


def key(token, number):
    return hmac.new(token.encode(), f"ticket:{number}".encode(), hashlib.sha256).hexdigest()[:KEY_LENGTH]


def valid(token, number, given):
    return isinstance(given, str) and hmac.compare_digest(given, key(token, number))


def ticket_path(token, number):
    """Chemin à partager : /t/42?k=…"""
    return f"/t/{number}?k={key(token, number)}"


def file_path(token, number, file_id, name):
    return f"/t/{number}/files/{file_id}/{quote(name)}?k={key(token, number)}"


def _when(epoch):
    return time.strftime("%d/%m/%Y %H:%M", time.localtime(epoch))


def _size(size):
    return f"{size} o" if size < 1024 else f"{size / 1024:.0f} Ko" if size < 1024 * 1024 else f"{size / 1048576:.1f} Mo"


def render(export, token, origin):
    """Le ticket en Markdown, pour un agent. `export` vient de Kanban.export ; `origin` : http://127.0.0.1:6767."""
    ticket = export["ticket"]
    number = ticket["number"]
    lines = [
        f"# #{number} · {ticket['title']}",
        "",
        f"- Tableau : {export['board']}",
        f"- Colonne : {export['column']}",
        f"- Créé le {_when(ticket['createdAt'])} · modifié le {_when(ticket['updatedAt'])}",
        f"- Lien : {origin}{ticket_path(token, number)}",
        "",
        "## Description",
        "",
        ticket["description"].strip() or "(aucune)",
    ]
    if ticket["files"]:
        lines += ["", "## Fichiers joints", ""]
        lines += [f"- {f['name']} ({_size(f['size'])}) : {origin}{file_path(token, number, f['id'], f['name'])}"
                  for f in ticket["files"]]
    cited = []
    for match in REFERENCE_RE.finditer(ticket["description"]):
        other = int(match.group(2))
        if other != number and other in export["known"] and other not in cited:
            cited.append(other)
    if cited:
        lines += ["", "## Tickets cités", ""]
        for other in cited:
            title, column = export["known"][other]
            where = f" ({column})" if column else ""
            lines.append(f"- #{other} · {title}{where} : {origin}{ticket_path(token, other)}")
    if export["history"]:
        lines += ["", "## Historique", ""]
        lines += [f"- {_when(e['at'])} · {HISTORY_LABELS.get(e['kind'], lambda _: e['kind'])(e)}"
                  + (f" (par {e['by']})" if e.get("by") not in (None, "user") else "") for e in export["history"]]
    return "\n".join(lines) + "\n"

"""Export PDF d'un échange de la discussion, avec Chrome ou Chromium en mode invisible.

L'interface envoie le contenu déjà mis en forme (HTML du Markdown rendu). Le serveur l'entoure d'une
page complète, avec sa feuille de style et une règle de sécurité (CSP) qui interdit tout script et tout
chargement extérieur ; Chrome l'imprime sans accès au réseau. Sans Chrome sur le poste, l'interface
passe par la fenêtre d'impression du navigateur.
"""

import html as html_lib
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

BROWSERS = ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge")
MAX_HTML = 4_000_000
TIMEOUT = 60  # secondes


class PdfUnavailable(Exception):
    """Aucun navigateur pour fabriquer le PDF sur ce poste."""


def find_browser():
    return next((path for path in map(shutil.which, BROWSERS) if path), None)


def safe_filename(name):
    """Nom de fichier sûr pour un téléchargement, terminé par .pdf."""
    stem = re.sub(r"[^\w.-]+", "-", name if isinstance(name, str) else "", flags=re.UNICODE).strip(".-")[:80]
    return f"{stem or 'discussion'}.pdf"


STYLE = """
@page { margin: 18mm 16mm; }
body { font: 11pt/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; color: #1f1f1d; }
h1 { font-size: 15pt; margin: 0 0 4mm; }
.pdf-meta { color: #6b6b66; font-size: 9pt; margin: 0 0 6mm; }
h2.pdf-section { font-size: 12pt; color: #c2410c; border-bottom: 1px solid #e2e1dc; padding-bottom: 1mm; margin: 6mm 0 3mm; }
.pdf-question { white-space: pre-wrap; background: #f6f1ea; border-radius: 6px; padding: 3mm 4mm; }
pre, code { font-family: ui-monospace, "DejaVu Sans Mono", monospace; font-size: 9pt; }
pre { background: #f1f1ee; border-radius: 6px; padding: 3mm; white-space: pre-wrap; overflow-wrap: anywhere; }
table { border-collapse: collapse; } th, td { border: 1px solid #e2e1dc; padding: 1mm 2mm; }
blockquote { border-left: 3px solid #e2e1dc; margin-left: 0; padding-left: 3mm; color: #6b6b66; }
img { max-width: 100%; }
"""
CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:"


def full_page(title, body):
    """Page complète autour du contenu reçu : titre, feuille de style, CSP (ni script, ni chargement)."""
    title = html_lib.escape(title if isinstance(title, str) else "", quote=True)[:200]
    return (f'<!doctype html><html lang="fr"><head><meta charset="utf-8">'
            f'<meta http-equiv="Content-Security-Policy" content="{CSP}">'
            f"<title>{title}</title><style>{STYLE}</style></head><body>{body}</body></html>")


def html_to_pdf(body, title="", browser=None):
    """Octets du PDF d'un contenu HTML ; ValueError s'il est invalide, PdfUnavailable sans navigateur."""
    if not isinstance(body, str) or not body.strip():
        raise ValueError("contenu vide")
    html = full_page(title, body)
    if len(html.encode()) > MAX_HTML:
        raise ValueError("contenu trop volumineux pour un PDF")
    browser = browser or find_browser()
    if browser is None:
        raise PdfUnavailable("Chrome ou Chromium introuvable : impossible de fabriquer le PDF ici")
    with tempfile.TemporaryDirectory(prefix="zo-pdf-") as tmp:
        page = Path(tmp) / "page.html"
        out = Path(tmp) / "page.pdf"
        page.write_text(html, encoding="utf-8")
        cmd = [
            browser, "--headless=new", "--disable-gpu", "--no-first-run",
            f"--user-data-dir={tmp}/profil",
            "--host-resolver-rules=MAP * ~NOTFOUND",  # pas de réseau : rien ne sort du poste
            "--no-pdf-header-footer", f"--print-to-pdf={out}", page.as_uri(),
        ]
        try:
            subprocess.run(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           timeout=TIMEOUT, check=False, env={**os.environ, "LANG": "fr_FR.UTF-8"})
        except subprocess.TimeoutExpired:
            raise ValueError("le PDF a pris trop de temps à se fabriquer") from None
        if not out.exists() or out.stat().st_size == 0:
            raise ValueError("le navigateur n'a pas produit de PDF")
        return out.read_bytes()

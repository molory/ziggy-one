"""PDF export of an exchange of the conversation, with headless Chrome or Chromium.

The interface sends the already formatted content (HTML of the rendered Markdown). The server wraps it in a
full page, with its stylesheet and a security rule (CSP) that forbids any script and any external
loading; Chrome prints it without network access. Without Chrome on the machine, the interface
uses the browser's print dialog.
"""

import html as html_lib
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

import i18n
from i18n import tr

BROWSERS = ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge")
MAX_HTML = 4_000_000
TIMEOUT = 60  # seconds


class PdfUnavailable(Exception):
    """No browser to make the PDF on this machine."""


def find_browser():
    return next((path for path in map(shutil.which, BROWSERS) if path), None)


def safe_filename(name):
    """Safe file name for a download, ending in .pdf."""
    stem = re.sub(r"[^\w.-]+", "-", name if isinstance(name, str) else "", flags=re.UNICODE).strip(".-")[:80]
    return f"{stem or 'conversation'}.pdf"


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
# Tags that can navigate or load despite the CSP (a <meta http-equiv="refresh"> to file:///… would print a
# local file): removed from the content. The interface never produces them.
LOADING_TAGS = re.compile(r"</?(meta|base|link|iframe|frame|frameset|object|embed|portal)\b[^>]*>", re.IGNORECASE)


def full_page(title, body):
    """Full page around the received content: title, stylesheet, CSP (no script, no loading)."""
    title = html_lib.escape(title if isinstance(title, str) else "", quote=True)[:200]
    body = LOADING_TAGS.sub("", body)
    return (f'<!doctype html><html lang="{i18n.language()}"><head><meta charset="utf-8">'
            f'<meta http-equiv="Content-Security-Policy" content="{CSP}">'
            f"<title>{title}</title><style>{STYLE}</style></head><body>{body}</body></html>")


def html_to_pdf(body, title="", browser=None):
    """PDF bytes of an HTML content; ValueError if it is invalid, PdfUnavailable without a browser."""
    if not isinstance(body, str) or not body.strip():
        raise ValueError(tr("Empty content"))
    html = full_page(title, body)
    if len(html.encode()) > MAX_HTML:
        raise ValueError(tr("Content too large for a PDF"))
    browser = browser or find_browser()
    if browser is None:
        raise PdfUnavailable(tr("Chrome or Chromium not found: cannot make the PDF here"))
    with tempfile.TemporaryDirectory(prefix="zo-pdf-") as tmp:
        page = Path(tmp) / "page.html"
        out = Path(tmp) / "page.pdf"
        page.write_text(html, encoding="utf-8")
        cmd = [
            browser, "--headless=new", "--disable-gpu", "--no-first-run",
            f"--user-data-dir={tmp}/profile",
            "--host-resolver-rules=MAP * ~NOTFOUND",  # no network: nothing leaves the machine
            "--no-pdf-header-footer", f"--print-to-pdf={out}", page.as_uri(),
        ]
        try:
            subprocess.run(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           timeout=TIMEOUT, check=False, env={**os.environ, "LANG": "fr_FR.UTF-8" if i18n.language() == "fr" else "en_US.UTF-8"})
        except subprocess.TimeoutExpired:
            raise ValueError(tr("The PDF took too long to make")) from None
        if not out.exists() or out.stat().st_size == 0:
            raise ValueError(tr("The browser did not produce a PDF"))
        return out.read_bytes()

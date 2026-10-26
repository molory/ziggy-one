"""Types de fichiers servis dans un onglet (fichiers joints aux tickets) : image, PDF, texte ou téléchargement."""

from pathlib import Path

IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}
TEXT_TYPES = {
    "application/json", "application/xml", "application/javascript", "application/x-sh",
    "application/x-yaml", "application/yaml", "application/toml", "application/sql",
}
TEXT_EXTENSIONS = {
    ".txt", ".md", ".csv", ".tsv", ".log", ".json", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf",
    ".xml", ".html", ".css", ".js", ".mjs", ".ts", ".tsx", ".jsx", ".py", ".java", ".kt", ".go", ".rs",
    ".c", ".h", ".cpp", ".sh", ".sql", ".properties", ".env.example", ".diff", ".patch",
}


def is_text(name, media_type):
    return media_type.startswith("text/") or media_type in TEXT_TYPES or Path(name.lower()).suffix in TEXT_EXTENSIONS

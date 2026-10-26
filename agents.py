"""Réglages des agents : nom personnalisé, avatar, réglages de Claude (modèle, permissions, Chrome) et agents
supprimés de la liste (fichier JSON local, 0600).

L'avatar : une abréviation (1 ou 2 caractères), affichée seule, ou un animal (image Twemoji servie avec la
page), ou une image choisie sur le disque, recadrée par le navigateur et gardée dans `avatars/` (0600).

Supprimer un agent le retire de ziggy-one sans toucher à son historique Claude Code : on garde
de quoi l'afficher dans « Agents supprimés » (nom, dossier, date) pour pouvoir le restaurer.
"""

import json
import os
import re
import secrets
import threading
import time
import unicodedata
from pathlib import Path

from names import ANIMALS, generate_name
from storage import is_agent_key, read_json, write_json

MAX_NAME = 80
MAX_LABEL = 200
MAX_PATH = 500
MAX_ROLE = 600  # rôle : ce qu'on peut confier à l'agent, donné aux autres agents (annuaire)
MODELS = ("opus", "sonnet", "haiku")
PERMISSION_MODES = ("auto", "default", "acceptEdits", "plan")
AVATAR_KINDS = ("letters", "animal", "image")
# 2 caractères visibles, limite tenue par le navigateur ; un emoji composé compte plusieurs points de code.
MAX_ABBR = 16
MAX_AVATAR_IMAGE = 300_000  # image déjà recadrée et réduite (256 px) par le navigateur
AVATAR_IMAGE_RE = re.compile(r"^[0-9a-f]{16}$")
AVATAR_IMAGE_TYPES = {"png": "image/png", "jpeg": "image/jpeg", "webp": "image/webp"}


def clean_options(raw, strict=False):
    """Réglages de Claude d'un agent ; une valeur absente (ou None, "") laisse la valeur par défaut.

    En mode strict, une valeur inconnue est une erreur ; sinon (lecture du fichier) elle est ignorée.
    """
    if not isinstance(raw, dict):
        if strict:
            raise ValueError("réglages invalides")
        return {}
    options = {}
    checks = {
        "model": lambda v: v in MODELS,
        "permissionMode": lambda v: v in PERMISSION_MODES,
        "chrome": lambda v: isinstance(v, bool),
    }
    for name, valid in checks.items():
        value = raw.get(name)
        if value is None or value == "":
            continue
        if valid(value):
            options[name] = value
        elif strict:
            raise ValueError(f"valeur invalide pour {name} : {value!r}")
    return options


def clean_abbr(value):
    """Abréviation de l'avatar : sans espace ni caractère de contrôle (le ZWJ des emoji composés reste)."""
    if value is None or value == "":
        return ""
    if not isinstance(value, str) or len(value) > MAX_ABBR:
        raise ValueError("abréviation invalide")
    if any(char.isspace() or (unicodedata.category(char).startswith("C") and unicodedata.category(char) != "Cf")
           for char in value):
        raise ValueError("abréviation invalide")
    return value


def clean_avatar(raw, strict=False):
    """Avatar d'un agent ({abbr, kind, animal, image}) ; vide = l'avatar par défaut (initiale sur sa couleur).

    En mode strict (requête), une valeur invalide est une erreur ; sinon (lecture du fichier) elle est ignorée.
    L'identifiant d'image ne vient jamais du navigateur : `strict` l'écarte.
    """
    if not isinstance(raw, dict):
        if strict:
            raise ValueError("avatar invalide")
        return {}
    avatar = {}
    try:
        abbr = clean_abbr(raw.get("abbr"))
    except ValueError:
        if strict:
            raise
        abbr = ""
    if abbr:
        avatar["abbr"] = abbr
    kind = raw.get("kind") or "letters"
    if kind not in AVATAR_KINDS:
        if strict:
            raise ValueError(f"type d'avatar invalide : {kind!r}")
        kind = "letters"
    animal = raw.get("animal")
    if animal not in (None, "") and animal not in ANIMALS:
        if strict:
            raise ValueError(f"animal inconnu : {animal!r}")
        animal = None
    if kind == "animal":
        if not animal:
            if strict:
                raise ValueError("animal manquant")
            kind = "letters"
        else:
            avatar["animal"] = animal
    image = None if strict else raw.get("image")
    if kind == "image" and not (isinstance(image, str) and AVATAR_IMAGE_RE.match(image)):
        if not strict:
            kind = "letters"
    elif kind == "image":
        avatar["image"] = image
    if kind != "letters":
        avatar["kind"] = kind
    return avatar


def image_type(data):
    """Type d'une image d'avatar, d'après ses premiers octets (PNG, JPEG ou WebP) ; None sinon."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return None


def clean_role(value):
    """Rôle d'un agent : texte libre, espaces et sauts de ligne réduits, sans caractère de contrôle."""
    if not isinstance(value, str):
        return ""
    return " ".join("".join(ch for ch in value if ch.isprintable() or ch.isspace()).split())[:MAX_ROLE]


def _clip(value, limit):
    return value[:limit] if isinstance(value, str) else ""


class AgentSettings:
    def __init__(self, bus, path, avatars_dir=None):
        self._bus = bus
        self._path = Path(path)
        self._avatars = Path(avatars_dir) if avatars_dir else self._path.parent / "avatars"
        self._lock = threading.Lock()
        self._items = self._load()

    def _load(self):
        data = read_json(self._path, {})
        items = {}
        for key, raw in (data.items() if isinstance(data, dict) else []):
            if not is_agent_key(key) or not isinstance(raw, dict):
                continue
            entry = {}
            for field in ("name", "generated"):
                if isinstance(raw.get(field), str) and raw[field].strip():
                    entry[field] = " ".join(raw[field].split())[:MAX_NAME]
            options = clean_options(raw.get("options"))
            if options:
                entry["options"] = options
            role = clean_role(raw.get("role"))
            if role:
                entry["role"] = role
            avatar = clean_avatar(raw.get("avatar"))
            if avatar:
                entry["avatar"] = avatar
            hidden = raw.get("hidden")
            if isinstance(hidden, dict):
                entry["hidden"] = {
                    "label": _clip(hidden.get("label"), MAX_LABEL),
                    "cwd": _clip(hidden.get("cwd"), MAX_PATH),
                    "at": hidden.get("at") if isinstance(hidden.get("at"), (int, float)) else 0,
                }
            if entry:
                items[key] = entry
        return items

    def _changed(self):
        # Appelé avec _lock acquis. Une entrée vide (ni nom, ni suppression) n'est pas gardée.
        self._items = {key: entry for key, entry in self._items.items() if entry}
        write_json(self._path, self._items)
        self._bus.publish("agents", json.loads(json.dumps(self._items)))

    def snapshot(self):
        with self._lock:
            return json.loads(json.dumps(self._items))

    def rename(self, key, name):
        """Nom donné à l'agent ; un nom vide lui rend son nom généré."""
        if not is_agent_key(key):
            raise ValueError("identifiant d'agent invalide")
        if name is not None and not isinstance(name, str):
            raise ValueError("nom invalide")
        name = " ".join((name or "").split())[:MAX_NAME]
        with self._lock:
            entry = self._items.setdefault(key, {})
            if name:
                entry["name"] = name
            else:
                entry.pop("name", None)
            self._changed()

    def set_options(self, key, options):
        """Réglages de Claude de l'agent (modèle, permissions, Chrome) ; vides = valeurs par défaut."""
        if not is_agent_key(key):
            raise ValueError("identifiant d'agent invalide")
        cleaned = clean_options(options, strict=True)
        with self._lock:
            entry = self._items.setdefault(key, {})
            if cleaned:
                entry["options"] = cleaned
            else:
                entry.pop("options", None)
            self._changed()

    def set_role(self, key, role):
        """Rôle de l'agent, donné aux autres agents au démarrage de leur session ; vide = pas de rôle."""
        if not is_agent_key(key):
            raise ValueError("identifiant d'agent invalide")
        if role is not None and not isinstance(role, str):
            raise ValueError("rôle invalide")
        role = clean_role(role)
        with self._lock:
            entry = self._items.setdefault(key, {})
            if role:
                entry["role"] = role
            else:
                entry.pop("role", None)
            self._changed()

    def roles(self):
        """Agents qui ont un rôle et ne sont pas supprimés : [(clé, nom, rôle)]."""
        with self._lock:
            return [(key, entry.get("name") or entry.get("generated") or "", entry["role"])
                    for key, entry in self._items.items() if entry.get("role") and "hidden" not in entry]

    def set_avatar(self, key, avatar, image=None):
        """Avatar de l'agent ; `image` (octets PNG, JPEG ou WebP) remplace son image.

        Sans nouvelle image, le type « image » garde celle qu'il a déjà ; un autre type la supprime.
        """
        if not is_agent_key(key):
            raise ValueError("identifiant d'agent invalide")
        cleaned = clean_avatar(avatar, strict=True)
        kind = cleaned.get("kind", "letters")
        if image is not None:
            if kind != "image":
                raise ValueError("une image va avec le type « image »")
            if not isinstance(image, bytes) or len(image) > MAX_AVATAR_IMAGE or image_type(image) is None:
                raise ValueError("image invalide (PNG, JPEG ou WebP, 300 Ko au plus)")
        with self._lock:
            entry = self._items.setdefault(key, {})
            old = entry.get("avatar", {}).get("image")
            if image is not None:
                cleaned["image"] = self._save_image(image)
            elif kind == "image":
                if not old:
                    raise ValueError("aucune image choisie")
                cleaned["image"] = old
            if cleaned:
                entry["avatar"] = cleaned
            else:
                entry.pop("avatar", None)
            self._changed()
        if old and old != cleaned.get("image"):
            (self._avatars / old).unlink(missing_ok=True)

    def _save_image(self, data):
        # Appelé avec _lock acquis. Nouvel identifiant à chaque image : le navigateur peut la garder en cache.
        self._avatars.mkdir(parents=True, exist_ok=True, mode=0o700)
        image_id = secrets.token_hex(8)
        fd = os.open(self._avatars / image_id, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as file:
            file.write(data)
        return image_id

    def avatar_image(self, image_id):
        """(octets, type MIME) de l'image d'avatar, ou None si elle n'existe pas."""
        if not isinstance(image_id, str) or not AVATAR_IMAGE_RE.match(image_id):
            return None
        try:
            data = (self._avatars / image_id).read_bytes()
        except OSError:
            return None
        kind = image_type(data)
        return (data, AVATAR_IMAGE_TYPES[kind]) if kind else None

    def options_for(self, keys):
        """Réglages de Claude enregistrés sous l'un des identifiants de l'agent ({} s'il n'y en a pas)."""
        with self._lock:
            for key in keys:
                options = self._items.get(key, {}).get("options") if key else None
                if options:
                    return dict(options)
            return {}

    def name_for(self, keys):
        """Nom de l'agent : celui qu'on lui a donné, sinon son nom généré ; None s'il n'en a pas."""
        with self._lock:
            entries = [self._items.get(key, {}) for key in keys if key]
            return next((entry[field] for field in ("name", "generated") for entry in entries if field in entry), None)

    def ensure_names(self, groups):
        """Donne un nom généré, unique, aux agents qui n'ont ni nom ni nom généré.

        `groups` : pour chaque agent, ses identifiants (session, discussion), le premier servant à
        enregistrer le nom. Une seule écriture pour tous les agents nommés.
        """
        with self._lock:
            taken = {entry[field] for entry in self._items.values() for field in ("name", "generated") if field in entry}
            named = False
            for keys in groups:
                keys = [key for key in keys if is_agent_key(key)]
                if not keys or any("name" in self._items.get(k, {}) or "generated" in self._items.get(k, {}) for k in keys):
                    continue
                name = generate_name(taken)
                taken.add(name)
                self._items.setdefault(keys[0], {})["generated"] = name
                named = True
            if named:
                self._changed()

    def hide(self, key, label="", cwd=""):
        if not is_agent_key(key):
            raise ValueError("identifiant d'agent invalide")
        with self._lock:
            self._items.setdefault(key, {})["hidden"] = {
                "label": _clip(label, MAX_LABEL), "cwd": _clip(cwd, MAX_PATH), "at": time.time(),
            }
            self._changed()

    def restore(self, key):
        """Retire l'agent des supprimés ; renvoie ce qu'on en avait gardé (nom, dossier), ou None."""
        with self._lock:
            entry = self._items.get(key)
            if entry is None or "hidden" not in entry:
                return None
            hidden = entry.pop("hidden")
            self._changed()
            return hidden

    def replace_key(self, old, new):
        """Une discussion démarrée a désormais une session : ses réglages la suivent."""
        if not is_agent_key(new):
            return
        with self._lock:
            entry = self._items.pop(old, None)
            if entry is None:
                return
            merged = {**entry, **self._items.get(new, {})}
            if "generated" in entry:
                merged["generated"] = entry["generated"]  # l'agent garde le nom qu'on voit déjà
            self._items[new] = merged
            self._changed()

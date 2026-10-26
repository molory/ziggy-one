"""Remplissage du contexte d'un agent : tokens envoyés au modèle au dernier appel, taille de sa fenêtre.

Les tokens viennent de l'usage du dernier message de l'assistant (entrée + cache lu + cache écrit).
La taille de la fenêtre n'est donnée par Claude Code qu'en fin de tour (`modelUsage[].contextWindow`) :
on la retient par modèle, dans un fichier, pour les sessions qui n'ont pas tourné ici.
"""

import threading
from pathlib import Path

from storage import read_json, write_json

DEFAULT_WINDOW = 200_000
LARGE_WINDOW = 1_000_000
USAGE_FIELDS = ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")


def _count(value):
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def used_tokens(usage):
    """Tokens du contexte d'après l'usage d'un message de l'assistant ; None si l'usage est illisible."""
    if not isinstance(usage, dict):
        return None
    counts = [usage[field] for field in USAGE_FIELDS if _count(usage.get(field))]
    return sum(counts) if counts else None


def base_model(model):
    """Modèle sans le suffixe « [1m] » que Claude Code ajoute pour la fenêtre d'un million de tokens."""
    return model.removesuffix("[1m]") if isinstance(model, str) else None


def is_compact_boundary(entry):
    """Compaction : le contexte d'avant ne compte plus (le prochain message dira la nouvelle taille)."""
    return entry.get("type") == "system" and entry.get("subtype") == "compact_boundary"


class ContextWindows:
    """Taille de fenêtre de chaque modèle, apprise des fins de tour."""

    def __init__(self, path=None):
        self._path = Path(path) if path else None
        self._lock = threading.Lock()
        data = read_json(self._path, {}) if self._path else {}
        self._windows = {
            model: size for model, size in (data.items() if isinstance(data, dict) else [])
            if isinstance(model, str) and _count(size) and size > 0
        }

    def learn(self, model_usage):
        """Retient les fenêtres d'un `modelUsage` de fin de tour."""
        if not isinstance(model_usage, dict):
            return
        with self._lock:
            before = dict(self._windows)
            for model, data in model_usage.items():
                size = data.get("contextWindow") if isinstance(data, dict) else None
                if isinstance(model, str) and _count(size) and size > 0:
                    self._windows[base_model(model)] = size
            if self._windows != before and self._path:
                write_json(self._path, self._windows)

    def observe(self, model, tokens):
        """Un modèle vu au-delà de 200 000 tokens a la grande fenêtre, s'il n'en a pas déjà une apprise."""
        model = base_model(model)
        if not model or not _count(tokens) or tokens <= DEFAULT_WINDOW:
            return
        with self._lock:
            if model in self._windows:
                return
            self._windows[model] = LARGE_WINDOW
            if self._path:
                write_json(self._path, self._windows)

    def window(self, model, tokens=None):
        """Fenêtre du modèle : apprise, sinon 200 000 tokens (un million si on l'a déjà dépassée)."""
        with self._lock:
            known = self._windows.get(base_model(model))
        if known:
            return known
        if isinstance(model, str) and model.endswith("[1m]") or (tokens or 0) > DEFAULT_WINDOW:
            return LARGE_WINDOW
        return DEFAULT_WINDOW

    def describe(self, model, tokens):
        """{"tokens", "window"} pour l'interface ; None si on ne connaît pas encore le contexte."""
        if tokens is None:
            return None
        return {"tokens": tokens, "window": self.window(model, tokens)}

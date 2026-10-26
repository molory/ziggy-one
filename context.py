"""How full an agent's context is: tokens sent to the model on the last call, size of its window.

The tokens come from the usage of the assistant's last message (input + cache read + cache written).
Claude Code gives the window size only at the end of a turn (`modelUsage[].contextWindow`):
it is remembered per model, in a file, for the sessions that did not run here.
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
    """Context tokens from the usage of an assistant message; None if the usage is unreadable."""
    if not isinstance(usage, dict):
        return None
    counts = [usage[field] for field in USAGE_FIELDS if _count(usage.get(field))]
    return sum(counts) if counts else None


def base_model(model):
    """Model without the "[1m]" suffix that Claude Code adds for the one-million-token window."""
    return model.removesuffix("[1m]") if isinstance(model, str) else None


def is_compact_boundary(entry):
    """Compaction: the previous context no longer counts (the next message will give the new size)."""
    return entry.get("type") == "system" and entry.get("subtype") == "compact_boundary"


class ContextWindows:
    """Window size of each model, learned from turn ends."""

    def __init__(self, path=None):
        self._path = Path(path) if path else None
        self._lock = threading.Lock()
        data = read_json(self._path, {}) if self._path else {}
        self._windows = {
            model: size for model, size in (data.items() if isinstance(data, dict) else [])
            if isinstance(model, str) and _count(size) and size > 0
        }

    def learn(self, model_usage):
        """Remembers the windows of an end-of-turn `modelUsage`."""
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
        """A model seen beyond 200,000 tokens has the large window, unless it already has a learned one."""
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
        """Window of the model: learned, else 200,000 tokens (one million if it was already exceeded)."""
        with self._lock:
            known = self._windows.get(base_model(model))
        if known:
            return known
        if isinstance(model, str) and model.endswith("[1m]") or (tokens or 0) > DEFAULT_WINDOW:
            return LARGE_WINDOW
        return DEFAULT_WINDOW

    def describe(self, model, tokens):
        """{"tokens", "window"} for the interface; None if the context is not known yet."""
        if tokens is None:
            return None
        return {"tokens": tokens, "window": self.window(model, tokens)}

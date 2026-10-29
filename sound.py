"""Sound played by the browser when an agent finishes its turn (Configuration › General).

By default sounds/done.mp3, a chime made for Ziggy One; it can be replaced by a file of your own, kept in the
data folder (`finish-sound.bin`, 0600) with its name (`finish-sound.json`). Only audio is accepted, recognised
by its first bytes (never by the name or the type the browser gives), and served with its own type.
Turning the sound on or off is a choice of each browser (button next to the plan usage), not stored here.
"""

import os
import tempfile
import threading
import time
from pathlib import Path

from i18n import tr
from storage import read_json, write_json

DEFAULT_FILE = Path(__file__).resolve().parent / "sounds" / "done.mp3"
DEFAULT_NAME = "done.mp3"
MAX_SIZE = 2 * 1024 * 1024  # a notification sound, not music
MAX_NAME = 120


def audio_type(data):
    """Content type of an audio file from its first bytes, or None if it is not a known audio format."""
    head = bytes(data[:16])
    if head.startswith(b"ID3") or (len(head) > 1 and head[0] == 0xFF and head[1] & 0xE0 == 0xE0 and head[1] & 0x06):
        return "audio/mpeg"  # MP3, with or without an ID3 tag (frame sync, layer set: not AAC ADTS)
    if head.startswith(b"RIFF") and head[8:12] == b"WAVE":
        return "audio/wav"
    if head.startswith(b"OggS"):
        return "audio/ogg"
    if head.startswith(b"fLaC"):
        return "audio/flac"
    if head[4:8] == b"ftyp":
        return "audio/mp4"  # M4A / AAC
    if len(head) > 1 and head[0] == 0xFF and head[1] & 0xF6 == 0xF0:
        return "audio/aac"  # ADTS
    return None


class FinishSound:
    def __init__(self, bus, data_dir, event="sound"):
        self._bus = bus
        self._event = event
        self._file = Path(data_dir) / "finish-sound.bin"
        self._meta = Path(data_dir) / "finish-sound.json"
        self._lock = threading.Lock()
        raw = read_json(self._meta, None)
        self._custom = None
        if isinstance(raw, dict) and isinstance(raw.get("name"), str) and isinstance(raw.get("version"), (int, float)) \
                and self._file.is_file():
            self._custom = {"name": raw["name"][:MAX_NAME], "version": raw["version"]}

    def info(self):
        """What the interface shows: name, custom or not, and a version (changes with the file, for caching)."""
        with self._lock:
            if self._custom:
                return {"name": self._custom["name"], "custom": True, "version": self._custom["version"]}
            return {"name": DEFAULT_NAME, "custom": False, "version": 0}

    def read(self):
        """(bytes, content type) of the sound to play; the default one if the custom file is unreadable."""
        with self._lock:
            custom = self._custom is not None
        if custom:
            try:
                data = self._file.read_bytes()
                kind = audio_type(data)
                if kind:
                    return data, kind
            except OSError:
                pass
        return DEFAULT_FILE.read_bytes(), "audio/mpeg"

    def set(self, name, data):
        """Replaces the sound by a file of your own; ValueError if it is not audio or too large."""
        if not data:
            raise ValueError(tr("Empty file"))
        if len(data) > MAX_SIZE:
            raise ValueError(tr("Sound too large (2 MB max)"))
        if audio_type(data) is None:
            raise ValueError(tr("Not an audio file (MP3, WAV, OGG, M4A, AAC or FLAC)"))
        name = Path(str(name or "")).name.strip()[:MAX_NAME] or "sound"
        with self._lock:
            self._file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            fd, tmp = tempfile.mkstemp(dir=self._file.parent, prefix=".finish-sound-")
            try:
                with os.fdopen(fd, "wb") as file:
                    file.write(data)
                os.replace(tmp, self._file)
            except BaseException:
                Path(tmp).unlink(missing_ok=True)
                raise
            self._custom = {"name": name, "version": time.time()}
            write_json(self._meta, self._custom)
        return self._published()

    def reset(self):
        """Back to the default sound."""
        with self._lock:
            self._custom = None
            self._file.unlink(missing_ok=True)
            self._meta.unlink(missing_ok=True)
        return self._published()

    def _published(self):
        info = self.info()
        self._bus.publish(self._event, info)
        return info

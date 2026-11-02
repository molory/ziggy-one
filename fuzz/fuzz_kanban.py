"""Fuzz target: a damaged kanbans.json loads with defaults and never stops the server at start.

The loaders (`Kanban._load_board`, `_load_ticket`) read a file that a crash, a disk error or a hand edit can damage:
every field must be checked, whatever its type. Run with atheris (Linux x86_64, CI):
    pip install --require-hashes --only-binary=:all: -r .github/requirements-fuzz.txt
    python fuzz/fuzz_kanban.py -max_total_time=60
Without atheris, tests/test_fuzz.py runs the same check on random inputs.
"""

import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from kanban import Kanban  # noqa: E402

try:
    import atheris
except ImportError:  # unit tests on any OS: RandomProvider instead (fuzz/provider.py)
    atheris = None

# Valid identifiers (so that tickets can reference boards and columns), the same with a line break, and broken ones.
BOARD, COLUMN, TICKET, FILE = "0123456789ab", "01234567", "ba9876543210", "0123456789abcdef"
STRINGS = [BOARD, COLUMN, TICKET, FILE, BOARD + "\n", COLUMN + "\n", "", " ", "To do", "2026-01-31", "2026-02-30",
           "1999-1-1", "NaN"]
KEYS = ["boards", "tickets", "nextNumber", "id", "name", "hue", "columns", "createdAt", "updatedAt", "board",
        "column", "title", "description", "files", "type", "size", "due", "position", "number", "agent", "archivedAt"]


class NullBus:
    def publish(self, kind, data):
        pass


def value(provider, depth=0):
    """A JSON value, biased towards the names and identifiers the loaders look for."""
    kind = provider.ConsumeIntInRange(0, 9 if depth < 4 else 5)
    if kind == 0:
        return None
    if kind == 1:
        return provider.ConsumeBool()
    if kind == 2:
        return provider.ConsumeIntInRange(-(2**62), 2**62) if provider.ConsumeBool() else provider.ConsumeIntInRange(-2, 400)
    if kind == 3:
        return provider.ConsumeRegularFloat()
    if kind == 4:
        return provider.PickValueInList(STRINGS)
    if kind == 5:
        return provider.ConsumeUnicodeNoSurrogates(20)
    if kind in (6, 7):
        return [value(provider, depth + 1) for _ in range(provider.ConsumeIntInRange(0, 4))]
    return {(provider.PickValueInList(KEYS) if provider.ConsumeIntInRange(0, 9) else provider.ConsumeUnicodeNoSurrogates(8)):
            value(provider, depth + 1) for _ in range(provider.ConsumeIntInRange(0, 6))}


def shaped(provider, fields):
    """A record with the expected fields: each one usually valid, sometimes missing or of any type."""
    record = {}
    for key, good in fields.items():
        choice = provider.ConsumeIntInRange(0, 9)
        if choice < 7:
            record[key] = good() if callable(good) else good
        elif choice < 9:
            record[key] = value(provider, 2)
    return record


def records(provider, make):
    return [make(provider) for _ in range(provider.ConsumeIntInRange(0, 4))]


def column(provider):
    return shaped(provider, {"id": lambda: provider.PickValueInList([COLUMN, "76543210"]), "name": "To do", "hue": 35})


def board(provider):
    return shaped(provider, {"id": BOARD, "name": "Board", "hue": None, "columns": lambda: records(provider, column),
                             "createdAt": 1.5, "updatedAt": 2})


def attachment(provider):
    return shaped(provider, {"id": FILE, "name": "notes.txt", "type": "text/plain", "size": 3})


def ticket(provider):
    return shaped(provider, {
        "id": lambda: provider.PickValueInList([TICKET, "cba987654321"]), "board": BOARD, "column": COLUMN,
        "title": "Title", "description": "Text", "files": lambda: records(provider, attachment), "due": "2026-01-31",
        "position": 0, "number": lambda: provider.ConsumeIntInRange(-1, 3), "agent": None, "archivedAt": None,
        "createdAt": lambda: provider.ConsumeIntInRange(0, 3), "updatedAt": 1,
    })


def document(provider):
    """Usually boards and tickets shaped like the real ones; sometimes any JSON value, or text that is not JSON."""
    choice = provider.ConsumeIntInRange(0, 9)
    if choice == 0:
        return provider.ConsumeUnicodeNoSurrogates(40)
    if choice == 1:
        return json.dumps(value(provider))
    return json.dumps(shaped(provider, {"boards": lambda: records(provider, board),
                                        "tickets": lambda: records(provider, ticket), "nextNumber": 1}))


def check(provider, folder):
    path = Path(folder) / "kanbans.json"
    path.write_text(document(provider), encoding="utf-8")
    kanban = Kanban(NullBus(), path, Path(folder) / "kanban-files")
    json.dumps(kanban._data())  # what it loaded can be saved again


def main():
    if atheris is None:
        sys.exit("atheris is not installed (Linux x86_64): see the docstring of this file")
    folder = tempfile.mkdtemp()
    atheris.instrument_all()
    atheris.Setup(sys.argv, lambda data: check(atheris.FuzzedDataProvider(data), folder))
    atheris.Fuzz()


if __name__ == "__main__":
    main()

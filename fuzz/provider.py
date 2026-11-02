"""Inputs of the fuzz targets.

With atheris (CI, Linux x86_64), the targets get its FuzzedDataProvider: coverage-guided fuzzing. Without it (unit
tests, every OS), RandomProvider offers the same methods on a seeded random generator, so the same checks run in
`python3 -m unittest discover -s tests` with no dependency.
"""

import random

# Unicode characters that tend to break parsers: line breaks, NUL, separators, a right-to-left mark, an emoji.
ODD_CHARACTERS = "\n\r\t\0/\\.:\u2028\u200f\U0001f600\u00e9"


class RandomProvider:
    """The subset of atheris.FuzzedDataProvider used by the targets (same method names), on random.Random(seed)."""

    def __init__(self, seed):
        self._random = random.Random(seed)

    def ConsumeIntInRange(self, low, high):
        return self._random.randint(low, high)

    def ConsumeBool(self):
        return self._random.random() < 0.5

    def ConsumeRegularFloat(self):
        return self._random.choice([0.0, -1.5, 1e308, -1e-308, self._random.uniform(-1e12, 1e12)])

    def ConsumeUnicodeNoSurrogates(self, count):
        alphabet = "abcdef0123456789 -" + ODD_CHARACTERS
        return "".join(self._random.choice(alphabet) for _ in range(self._random.randint(0, count)))

    def PickValueInList(self, values):
        return self._random.choice(values)

"""The Z logo in the color chosen in Configuration › General: SVG for the page, PNG for the favicon.

The color tells several Ziggy One apart (orange on the laptop, purple on the Mac mini…). The PNG is drawn here,
without any image library: three polygons filled with 4×4 supersampling.
"""

import struct
import zlib
from functools import lru_cache

# Name → (light, dark) tones of the logo; orange is the original one.
COLORS = {
    "orange": ("#f6b492", "#ea580c"),
    "red": ("#fca5a5", "#dc2626"),
    "pink": ("#f9a8d4", "#db2777"),
    "purple": ("#c4b5fd", "#7c3aed"),
    "blue": ("#93c5fd", "#2563eb"),
    "teal": ("#5eead4", "#0d9488"),
    "green": ("#86efac", "#16a34a"),
    "gray": ("#cbd5e1", "#475569"),
}
DEFAULT = "orange"
VIEW = (40, 40, 432)  # x, y, size of the square viewBox
LIGHT = (((68, 152), (165, 45), (357, 45), (264, 152)), ((155, 465), (248, 359), (442, 359), (345, 466)))
DARK = (((70, 360), (357, 46), (444, 147), (155, 465)),)
SAMPLES = 4


def _points(polygon):
    return " ".join(f"{x},{y}" for x, y in polygon)


def svg(color):
    light, dark = COLORS.get(color, COLORS[DEFAULT])
    x, y, size = VIEW
    shapes = "".join(f'<polygon fill="{fill}" points="{_points(p)}"/>' for fill, group in ((light, LIGHT), (dark, DARK))
                     for p in group)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{x} {y} {size} {size}"><title>Ziggy One</title>'
            f'{shapes}</svg>').encode()


def _inside(polygon, px, py):
    inside = False
    for (x1, y1), (x2, y2) in zip(polygon, polygon[1:] + polygon[:1], strict=True):
        if (y1 > py) != (y2 > py) and px < x1 + (py - y1) * (x2 - x1) / (y2 - y1):
            inside = not inside
    return inside


def _rgb(hex_color):
    return tuple(int(hex_color[i:i + 2], 16) for i in (1, 3, 5))


@lru_cache(maxsize=len(COLORS) + 1)
def png(color, size=64):
    """Square RGBA PNG of the logo, transparent around it."""
    light, dark = (_rgb(c) for c in COLORS.get(color, COLORS[DEFAULT]))
    x0, y0, view = VIEW
    rows = []
    for row in range(size):
        line = bytearray(b"\0")  # filter: none
        for col in range(size):
            hits = {"light": 0, "dark": 0}
            for sy in range(SAMPLES):
                for sx in range(SAMPLES):
                    px = x0 + (col + (sx + 0.5) / SAMPLES) * view / size
                    py = y0 + (row + (sy + 0.5) / SAMPLES) * view / size
                    if any(_inside(p, px, py) for p in DARK):
                        hits["dark"] += 1  # drawn last: on top of the light tone
                    elif any(_inside(p, px, py) for p in LIGHT):
                        hits["light"] += 1
            covered = hits["light"] + hits["dark"]
            if not covered:
                line += b"\0\0\0\0"
                continue
            mix = [round((l * hits["light"] + d * hits["dark"]) / covered) for l, d in zip(light, dark, strict=True)]
            line += bytes([*mix, round(255 * covered / SAMPLES ** 2)])
        rows.append(bytes(line))

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8 bits, RGBA
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(b"".join(rows), 9))
            + chunk(b"IEND", b""))

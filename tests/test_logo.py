"""Logo and favicon in the chosen color: python3 -m unittest discover -s tests"""

import struct
import sys
import tempfile
import unittest
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import logo  # noqa: E402
import server  # noqa: E402


def pixels(data):
    """Size and RGBA rows of one of our PNGs (no filter, one IDAT chunk)."""
    width, height = struct.unpack(">II", data[16:24])
    start = data.index(b"IDAT") + 4
    raw = zlib.decompress(data[start:start + struct.unpack(">I", data[start - 8:start - 4])[0]])
    stride = 1 + 4 * width
    return width, height, [raw[r * stride + 1:(r + 1) * stride] for r in range(height)]


class LogoTest(unittest.TestCase):
    def test_svg_and_png_take_the_color(self):
        self.assertIn(b'fill="#7c3aed"', logo.svg("purple"))
        self.assertEqual(logo.svg("nope"), logo.svg("orange"))
        width, height, rows = pixels(logo.png("purple"))
        self.assertEqual((width, height), (64, 64))
        middle = rows[32][32 * 4:33 * 4]  # the diagonal of the Z: dark tone, opaque
        self.assertEqual(middle, bytes([0x7C, 0x3A, 0xED, 255]))
        self.assertEqual(rows[63][:4], b"\0\0\0\0")  # bottom left corner: transparent

    def test_page_and_icons_follow_the_setting(self):
        with tempfile.TemporaryDirectory() as tmp:
            srv = server.ZiggyServer(0, tmp, {}, data_dir=Path(tmp) / "data")
            self.addCleanup(srv.server_close)
            handler = server.Handler.__new__(server.Handler)
            handler.server = srv
            sent = []
            handler._send = lambda status, body=b"", content_type=None, headers=None: sent.append((body, content_type))
            srv.settings.update({"color": "teal"})
            handler._static("/")
            self.assertIn(b'href="/favicon.png?c=teal"', sent[-1][0])
            handler._static("/logo.svg")
            self.assertEqual(sent[-1], (logo.svg("teal"), "image/svg+xml"))
            handler._static("/favicon.png")
            self.assertEqual(sent[-1], (logo.png("teal"), "image/png"))


if __name__ == "__main__":
    unittest.main()

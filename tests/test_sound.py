import base64
import http.cookiejar
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

import server
import sound
from sound import FinishSound, audio_type


class Bus:
    def __init__(self):
        self.events = []

    def publish(self, event, data):
        self.events.append((event, data))


WAV = b"RIFF\x24\x00\x00\x00WAVEfmt " + b"\x00" * 32


class AudioTypeTest(unittest.TestCase):
    def test_known_formats(self):
        self.assertEqual(audio_type(sound.DEFAULT_FILE.read_bytes()), "audio/mpeg")
        self.assertEqual(audio_type(b"ID3\x04" + b"\x00" * 20), "audio/mpeg")
        self.assertEqual(audio_type(b"\xff\xfb\x90\x00" + b"\x00" * 20), "audio/mpeg")
        self.assertEqual(audio_type(WAV), "audio/wav")
        self.assertEqual(audio_type(b"OggS" + b"\x00" * 20), "audio/ogg")
        self.assertEqual(audio_type(b"fLaC" + b"\x00" * 20), "audio/flac")
        self.assertEqual(audio_type(b"\x00\x00\x00\x20ftypM4A " + b"\x00" * 20), "audio/mp4")
        self.assertEqual(audio_type(b"\xff\xf1\x50\x80" + b"\x00" * 20), "audio/aac")

    def test_not_audio(self):
        for data in (b"<svg onload=alert(1)>", b"<html>", b"\x89PNG\r\n\x1a\n", b"", b"\xff"):
            self.assertIsNone(audio_type(data), data)


class FinishSoundTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)
        self.bus = Bus()

    def test_default_then_custom_then_default(self):
        sounds = FinishSound(self.bus, self.dir)
        self.assertEqual(sounds.info(), {"name": "done.mp3", "custom": False, "version": 0})
        self.assertEqual(sounds.read(), (sound.DEFAULT_FILE.read_bytes(), "audio/mpeg"))
        info = sounds.set("../../ding.wav", WAV)
        self.assertEqual(info["name"], "ding.wav", "only the file name is kept")
        self.assertTrue(info["custom"])
        self.assertEqual(self.bus.events[-1], ("sound", info))
        self.assertEqual(sounds.read(), (WAV, "audio/wav"))
        self.assertEqual((self.dir / "finish-sound.bin").stat().st_mode & 0o777, 0o600)
        # Kept across a restart.
        self.assertEqual(FinishSound(Bus(), self.dir).info(), info)
        self.assertFalse(sounds.reset()["custom"])
        self.assertFalse((self.dir / "finish-sound.bin").exists())
        self.assertFalse(FinishSound(Bus(), self.dir).info()["custom"])

    def test_refuses_what_is_not_a_sound(self):
        sounds = FinishSound(self.bus, self.dir)
        for data in (b"", b"<html><script>", b"ID3" + b"\x00" * sound.MAX_SIZE):
            with self.assertRaises(ValueError):
                sounds.set("x.mp3", data)
        self.assertFalse(sounds.info()["custom"])
        self.assertEqual(self.bus.events, [])


class SoundHttpTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.srv = server.ZiggyServer(0, tmp.name, {}, data_dir=Path(tmp.name) / "data")
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.addCleanup(self.srv.server_close)
        self.addCleanup(self.srv.shutdown)
        self.base = f"http://127.0.0.1:{self.srv.server_address[1]}"
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.opener.open(f"{self.base}/?login={self.srv.logins.make()}").read()

    def post(self, path, body):
        request = urllib.request.Request(self.base + path, json.dumps(body).encode(),
                                         {"Content-Type": "application/json", "Origin": self.base})
        return json.loads(self.opener.open(request).read())

    def test_routes(self):
        with self.assertRaises(urllib.error.HTTPError) as denied:
            urllib.request.urlopen(f"{self.base}/api/sound")
        denied.exception.close()
        self.assertEqual(denied.exception.code, 401, "signed-in browsers only")
        response = self.opener.open(f"{self.base}/api/sound")
        self.assertEqual(response.headers["Content-Type"], "audio/mpeg")
        self.assertIn("sandbox", response.headers["Content-Security-Policy"])
        self.assertEqual(response.read(), sound.DEFAULT_FILE.read_bytes())
        info = self.post("/api/sound", {"name": "ding.wav", "data": base64.b64encode(WAV).decode()})["sound"]
        self.assertEqual(info["name"], "ding.wav")
        response = self.opener.open(f"{self.base}/api/sound?v={info['version']}")
        self.assertEqual((response.headers["Content-Type"], response.read()), ("audio/wav", WAV))
        with self.assertRaises(urllib.error.HTTPError) as refused:
            self.post("/api/sound", {"name": "x.mp3", "data": base64.b64encode(b"<html>").decode()})
        refused.exception.close()
        self.assertEqual(refused.exception.code, 400)
        self.assertFalse(self.post("/api/sound/reset", {})["sound"]["custom"])


if __name__ == "__main__":
    unittest.main()

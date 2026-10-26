"""Tests of the single-use sign-in links."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import login_links  # noqa: E402

TOKEN = "t" * 43


class LoginLinksTest(unittest.TestCase):
    def test_link_is_valid_once(self):
        links = login_links.LoginLinks(TOKEN)
        link = login_links.make(TOKEN)  # made by another process that reads the token file
        self.assertTrue(links.redeem(link))
        self.assertFalse(links.redeem(link))

    def test_rejects_expired_forged_or_malformed_links(self):
        links = login_links.LoginLinks(TOKEN)
        self.assertFalse(links.redeem(login_links.make(TOKEN, now=0)))
        self.assertFalse(links.redeem(login_links.make("other token" * 4)))
        expires, nonce, signature = login_links.make(TOKEN).split(".")
        self.assertFalse(links.redeem(f"{int(expires) + 3600}.{nonce}.{signature}"), "expiry pushed back")
        for link in ("", "abc", "1.2", "x.y.z", None):
            self.assertFalse(links.redeem(link))

    def test_used_links_are_forgotten_after_expiry(self):
        links = login_links.LoginLinks(TOKEN)
        self.assertTrue(links.redeem(login_links.make(TOKEN, now=1000), now=1000))
        links.redeem(login_links.make(TOKEN, now=5000), now=5000)
        self.assertEqual(len(links._used), 1)


if __name__ == "__main__":
    unittest.main()

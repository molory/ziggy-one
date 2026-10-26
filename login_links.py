"""Single-use sign-in links: /?login=<expiry>.<nonce>.<signature>.

`ziggy` opens the browser on such a link rather than on /?token=…: the address, which goes through the
browser's command line, its history or a log, is worthless once used, and after LIFETIME.
The signature is an HMAC with the server token: another process that reads the token file (0600) can
make one, for example `ziggy` started while the server is already running.
"""

import hashlib
import hmac
import secrets
import threading
import time

LIFETIME = 300  # seconds


def _signature(token, expires, nonce):
    return hmac.new(token.encode(), f"login:{expires}:{nonce}".encode(), hashlib.sha256).hexdigest()[:32]


def make(token, now=None):
    expires = int(time.time() if now is None else now) + LIFETIME
    nonce = secrets.token_urlsafe(12)
    return f"{expires}.{nonce}.{_signature(token, expires, nonce)}"


class LoginLinks:
    """Server side: a valid link opens only one session, used links are forgotten when they expire."""

    def __init__(self, token):
        self.token = token
        self._used = {}  # nonce → expiry
        self._lock = threading.Lock()

    def make(self):
        return make(self.token)

    def redeem(self, link, now=None):
        now = time.time() if now is None else now
        try:
            expires, nonce, signature = str(link).split(".")
            expires = int(expires)
        except ValueError:
            return False
        if not nonce or expires < now or expires > now + LIFETIME + 60:
            return False
        if not hmac.compare_digest(signature.encode(), _signature(self.token, expires, nonce).encode()):
            return False
        with self._lock:
            self._used = {n: e for n, e in self._used.items() if e >= now}
            if nonce in self._used:
                return False
            self._used[nonce] = expires
        return True

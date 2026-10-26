"""Liens de connexion à usage unique : /?login=<expiration>.<aléa>.<signature>.

`ziggy` ouvre le navigateur sur un tel lien plutôt que sur /?token=… : l'adresse, qui passe par la ligne de
commande du navigateur, son historique ou un journal, ne vaut plus rien une fois utilisée, ni après LIFETIME.
La signature est un HMAC par le token du serveur : un autre processus qui lit le fichier du token (0600) peut
en fabriquer un, par exemple `ziggy` lancé alors que le serveur tourne déjà.
"""

import hashlib
import hmac
import secrets
import threading
import time

LIFETIME = 300  # secondes


def _signature(token, expires, nonce):
    return hmac.new(token.encode(), f"login:{expires}:{nonce}".encode(), hashlib.sha256).hexdigest()[:32]


def make(token, now=None):
    expires = int(time.time() if now is None else now) + LIFETIME
    nonce = secrets.token_urlsafe(12)
    return f"{expires}.{nonce}.{_signature(token, expires, nonce)}"


class LoginLinks:
    """Côté serveur : un lien valide n'ouvre qu'une session, les liens utilisés sont oubliés à leur expiration."""

    def __init__(self, token):
        self.token = token
        self._used = {}  # aléa → expiration
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

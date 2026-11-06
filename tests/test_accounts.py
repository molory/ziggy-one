"""Tests of the Claude accounts of the terminals: python3 -m unittest discover -s tests"""

import http.client
import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import accounts  # noqa: E402
import server  # noqa: E402

TOKEN = "sk-ant-oat01-" + "a" * 40
OTHER = "sk-ant-oat01-" + "b" * 40


class AccountsTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = Path(tmp.name) / "accounts.json"
        self.bus = server.Bus()

    def make(self, environ=None):
        return accounts.Accounts(self.bus, self.path, environ={} if environ is None else environ)

    def test_add_validates_and_never_shows_the_token(self):
        store = self.make()
        api_key = "sk-ant-api03-" + "c" * 40  # an API key, not a token of `claude setup-token`
        for name, token in (("", TOKEN), ("a\nb", TOKEN), ("x" * 61, TOKEN), ("work", "nope"),
                            ("work", TOKEN + "\nX"), ("work", None), ("work", api_key)):
            with self.assertRaises(ValueError, msg=(name, token)):
                store.add(name, token)
        snapshot = store.add(" work ", f"  {TOKEN}\n")
        self.assertEqual([p["name"] for p in snapshot["profiles"]], ["work"])
        self.assertNotIn(TOKEN, json.dumps(snapshot))
        with self.assertRaises(ValueError):
            store.add("work", OTHER)  # same name
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(json.loads(self.path.read_text())["profiles"][0]["token"], TOKEN)

    def test_token_refused_by_claude_is_not_saved(self):
        checked = []
        store = accounts.Accounts(self.bus, self.path, environ={},
                                  check=lambda token: checked.append(token) or "401 OAuth access token is invalid")
        with self.assertRaises(ValueError) as caught:
            store.add("work", TOKEN)
        self.assertIn("401", str(caught.exception))
        self.assertEqual(checked, [TOKEN])
        self.assertFalse(self.path.exists())

    def test_two_servers_on_one_data_folder_keep_each_others_profiles(self):
        first, second = self.make(), self.make()
        first.add("work", TOKEN)
        second.add("personal", OTHER)
        work = next(p["id"] for p in second.snapshot()["profiles"] if p["name"] == "work")
        second.select(work)
        self.assertEqual([p["name"] for p in first.snapshot()["profiles"]], ["work", "personal"])
        self.assertEqual(first.snapshot()["active"], work)

    def test_apply_sets_then_removes_our_token_only(self):
        store = self.make()
        work = store.add("work", TOKEN)["profiles"][0]["id"]
        environ = {}
        self.assertIsNone(accounts.apply(self.path, environ))  # nothing chosen: the login of the machine
        self.assertEqual(environ, {})
        store.select(work)
        self.assertEqual(accounts.apply(self.path, environ), work)
        self.assertEqual(environ, {accounts.ENV_TOKEN: TOKEN, accounts.ENV_PROFILE: work})
        self.assertEqual(self.make(environ).running, work)
        store.select(None)
        self.assertIsNone(accounts.apply(self.path, environ))  # relaunch: ours is removed
        self.assertEqual(environ, {})
        outside = {accounts.ENV_TOKEN: OTHER}  # set outside Ziggy One: kept
        self.assertIsNone(accounts.apply(self.path, outside))
        self.assertEqual(outside, {accounts.ENV_TOKEN: OTHER})

    def test_select_delete_and_pending(self):
        store = self.make()
        work = store.add("work", TOKEN)["profiles"][0]["id"]
        with self.assertRaises(ValueError):
            store.select("000000000000")
        self.assertFalse(store.pending())
        self.assertTrue(store.select(work))
        self.assertTrue(store.pending())  # chosen, applied at the next start
        with self.assertRaises(ValueError):
            store.delete(work)  # chosen
        store.select(None)
        self.assertFalse(store.pending())
        self.assertEqual(store.delete(work)["profiles"], [])
        with self.assertRaises(ValueError):
            store.delete(work)

    def test_rename_keeps_the_token_and_the_account_in_use(self):
        store = self.make()
        work = store.add("wrok", TOKEN)["profiles"][0]["id"]
        store.add("personal", OTHER)
        store.select(work)
        environ = {}
        accounts.apply(self.path, environ)
        running = self.make(environ)
        for name in ("", "a\nb", "x" * 61, "personal"):  # invalid, or the other one's name
            with self.assertRaises(ValueError, msg=name):
                store.rename(work, name)
        with self.assertRaises(ValueError):
            store.rename("000000000000", "work")
        snapshot = store.rename(work, " work ")
        self.assertEqual([p["name"] for p in snapshot["profiles"]], ["work", "personal"])
        self.assertEqual(snapshot["active"], work)
        self.assertEqual(json.loads(self.path.read_text())["profiles"][0]["token"], TOKEN)
        self.assertEqual(running.running_name(), "work")  # read again: renamed by the other instance
        store.rename(work, "work")  # same name: allowed

    def test_damaged_file(self):
        self.path.write_text(json.dumps({"active": "ffffffffffff", "profiles": [
            {"id": "aaaaaaaaaaaa", "name": "ok", "token": TOKEN},
            {"id": "aaaaaaaaaaaa", "name": "duplicate", "token": TOKEN},
            {"id": "bad", "name": "x", "token": TOKEN},
            {"id": "bbbbbbbbbbbb", "name": "x", "token": "not a token"},
            "junk",
        ]}))
        snapshot = self.make({accounts.ENV_PROFILE: "cccccccccccc"}).snapshot()
        self.assertEqual([p["name"] for p in snapshot["profiles"]], ["ok"])
        self.assertIsNone(snapshot["active"])  # unknown profile
        self.assertIsNone(snapshot["running"])
        self.path.write_text("{broken")
        self.assertEqual(self.make().snapshot()["profiles"], [])
        self.assertIsNone(accounts.apply(self.path, {}))


class AccountsHttpTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.httpd = server.ZiggyServer(port=0, conversation_cwd=tmp.name, account={"loggedIn": True},
                                        data_dir=tmp.name)
        self.addCleanup(self.httpd.server_close)
        self.port = self.httpd.server_address[1]
        self.host = f"127.0.0.1:{self.port}"
        self.headers = {"Host": self.host, "Origin": f"http://{self.host}", "Content-Type": "application/json",
                        "Cookie": f"{self.httpd.cookie_name}={self.httpd.sessions.create()}"}
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.addCleanup(self.httpd.shutdown)
        patcher = mock.patch.object(server, "check_token", return_value=None)  # no real `claude` call
        patcher.start()
        self.addCleanup(patcher.stop)

    def call(self, method, path, body=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        connection.request(method, path, body=None if body is None else json.dumps(body).encode(),
                           headers=self.headers)
        response = connection.getresponse()
        raw = response.read().decode()
        connection.close()
        return response.status, raw

    def test_routes_switch_through_a_clean_restart(self):
        status, raw = self.call("POST", "/api/accounts/add", {"name": "work", "token": TOKEN})
        self.assertEqual(status, 200)
        self.assertNotIn(TOKEN, raw)
        work = json.loads(raw)["profiles"][0]["id"]
        self.assertEqual(self.call("POST", "/api/accounts/add", {"name": "bad", "token": "x"})[0], 400)
        self.assertEqual(self.call("POST", "/api/accounts/switch", {"id": 5})[0], 400)
        self.assertEqual(self.call("POST", "/api/accounts/switch", {"id": "000000000000"})[0], 400)
        with mock.patch.object(self.httpd.restart, "request") as request:
            status, raw = self.call("POST", "/api/accounts/switch", {"id": work})
            self.assertEqual(status, 200)
            request.assert_called_once()
            self.assertEqual(json.loads(raw)["accounts"]["active"], work)
            request.reset_mock()
            self.call("POST", "/api/accounts/switch", {"id": None})  # back to the one in use: nothing to restart
            request.assert_not_called()
        for path in ("/api/accounts", "/api/state"):
            status, raw = self.call("GET", path)
            self.assertEqual(status, 200, path)
            self.assertNotIn(TOKEN, raw, path)
        self.assertIn('"profile": null', self.call("GET", "/api/state")[1])

    def test_switching_back_cancels_the_restart_of_the_switch_only(self):
        work = json.loads(self.call("POST", "/api/accounts/add", {"name": "work", "token": TOKEN})[1])["profiles"][0]["id"]
        restart = mock.Mock(last=None)  # server.info() reads it
        restart.snapshot.return_value = None
        restart.request.return_value = {"requestedAt": 1.0}
        with mock.patch.object(self.httpd, "restart", restart):
            self.call("POST", "/api/accounts/switch", {"id": work})
            restart.snapshot.return_value = {"phase": "waiting", "requestedAt": 1.0}
            self.call("POST", "/api/accounts/switch", {"id": None})
            restart.cancel.assert_called_once()
            # A restart asked for otherwise (button, agent) is left alone.
            restart.reset_mock()
            restart.snapshot.return_value = {"phase": "waiting", "requestedAt": 2.0}
            self.call("POST", "/api/accounts/switch", {"id": work})
            self.call("POST", "/api/accounts/switch", {"id": None})
            restart.request.assert_not_called()
            restart.cancel.assert_not_called()

    def test_rename_route(self):
        work = json.loads(self.call("POST", "/api/accounts/add", {"name": "wrok", "token": TOKEN})[1])["profiles"][0]["id"]
        self.assertEqual(self.call("POST", "/api/accounts/rename", {"id": work, "name": " "})[0], 400)
        self.assertEqual(self.call("POST", "/api/accounts/rename", {"id": None, "name": "x"})[0], 400)
        status, raw = self.call("POST", "/api/accounts/rename", {"id": work, "name": "work"})
        self.assertEqual(status, 200)
        self.assertNotIn(TOKEN, raw)
        self.assertEqual(json.loads(raw)["profiles"][0]["name"], "work")

    def test_cancelled_restart_drops_the_switch(self):
        work = json.loads(self.call("POST", "/api/accounts/add", {"name": "work", "token": TOKEN})[1])["profiles"][0]["id"]
        with mock.patch.object(self.httpd.restart, "request"):
            self.call("POST", "/api/accounts/switch", {"id": work})
        with mock.patch.object(self.httpd.restart, "cancel"):
            self.assertEqual(self.call("POST", "/api/server/restart", {"action": "cancel"})[0], 200)
        self.assertIsNone(self.httpd.accounts.snapshot()["active"])

    def test_without_origin_refused(self):
        del self.headers["Origin"]
        self.assertEqual(self.call("POST", "/api/accounts/add", {"name": "work", "token": TOKEN})[0], 403)


# Fake `claude -p` for check_token: accepts only the token "good", like the real one answers (result event).
FAKE_PROBE = f"""#!{sys.executable}
import json, os
bad = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN") != "sk-ant-oat01-good"
print(json.dumps({{"type": "system", "subtype": "init"}}))
print(json.dumps({{"type": "result", "is_error": bad,
                  "result": "Failed to authenticate. API Error: 401 OAuth access token is invalid." if bad else "ok"}}))
"""


class CheckTokenTest(unittest.TestCase):
    def test_runs_claude_with_the_token(self):
        with tempfile.TemporaryDirectory() as directory:
            fake = Path(directory) / "claude"
            fake.write_text(FAKE_PROBE)
            fake.chmod(0o700)
            path = f"{directory}{os.pathsep}{os.environ['PATH']}"
            with mock.patch.dict(os.environ, {"PATH": path, accounts.ENV_TOKEN: "sk-ant-oat01-good"}):
                self.assertIn("401", server.check_token("sk-ant-oat01-other"))  # the one given, not the server's
                os.environ[accounts.ENV_TOKEN] = "sk-ant-oat01-other"
                self.assertIsNone(server.check_token("sk-ant-oat01-good"))


if __name__ == "__main__":
    unittest.main()

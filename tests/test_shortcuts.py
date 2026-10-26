"""Tests of the prompt shortcuts: python3 -m unittest discover -s tests"""

import http.client
import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import server  # noqa: E402
from shortcuts import MAX_ITEMS, Shortcuts, clean_items  # noqa: E402

AGENT = "0123456789ab"
SESSION = "11111111-2222-3333-4444-555555555555"
WORKSPACE = "abcdefabcdef"


class ShortcutsTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = Path(tmp.name) / "shortcuts.json"
        self.bus = server.Bus()
        self.events = self.bus.subscribe()
        self.store = Shortcuts(self.bus, self.path)

    def test_lists_are_saved_privately_and_published(self):
        data = self.store.set("agent", AGENT, [{"title": " Tests ", "prompt": "Run the tests\r\n\x1b[2Jthen summarize"}])
        item = data["agents"][AGENT][0]
        self.assertEqual((item["title"], item["prompt"]), ("Tests", "Run the tests\n[2Jthen summarize"))
        self.assertRegex(item["id"], r"^[0-9a-f]{12}$")
        self.store.set("workspace", WORKSPACE, [{"prompt": "Do a review"}, dict(item)])
        self.assertEqual(oct(os.stat(self.path).st_mode & 0o777), "0o600")
        reloaded = Shortcuts(self.bus, self.path).snapshot()
        self.assertEqual(reloaded, self.store.snapshot())
        self.assertEqual([i["id"] for i in reloaded["workspaces"][WORKSPACE]][1], item["id"], "id kept")
        kinds = [self.events.get_nowait()[0] for _ in range(self.events.qsize())]
        self.assertEqual(kinds, ["shortcuts", "shortcuts"])
        self.store.set("agent", AGENT, [])
        self.assertNotIn(AGENT, self.store.snapshot()["agents"], "empty list: removed")

    def test_invalid_input_is_refused(self):
        for scope, owner, items in [
            ("global", AGENT, []), ("agent", "../x", []), ("workspace", "nope", []),
            ("agent", AGENT, "x"), ("agent", AGENT, [{"prompt": "  "}]), ("agent", AGENT, [{"prompt": 3}]),
            ("agent", AGENT, [{"prompt": "x" * 20_001}]), ("agent", AGENT, [{"prompt": "x"}] * (MAX_ITEMS + 1)),
        ]:
            with self.assertRaises(ValueError, msg=(scope, owner, str(items)[:40])):
                self.store.set(scope, owner, items)
        self.assertEqual(clean_items([{"prompt": "ok"}, "damaged", {"prompt": ""}], strict=False)[0]["prompt"], "ok")

    def test_shortcuts_follow_the_agent_to_its_session(self):
        self.store.set("agent", AGENT, [{"prompt": "a"}])
        self.store.set("agent", SESSION, [{"prompt": "b"}])
        self.store.replace_key(AGENT, SESSION)
        agents = self.store.snapshot()["agents"]
        self.assertNotIn(AGENT, agents)
        self.assertEqual([i["prompt"] for i in agents[SESSION]], ["b", "a"])

    def test_http_route_and_workspace_deletion(self):
        srv = server.ZiggyServer(0, str(self.path.parent), {}, data_dir=self.path.parent / "data")
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)
        host = f"127.0.0.1:{srv.server_address[1]}"
        headers = {"Host": host, "Origin": f"http://{host}", "Cookie": f"{srv.cookie_name}={srv.token}",
                   "Content-Type": "application/json"}

        def call(path, body):
            connection = http.client.HTTPConnection(*host.split(":"), timeout=5)
            connection.request("POST", path, body=json.dumps(body).encode(), headers=headers)
            response = connection.getresponse()
            data = json.loads(response.read() or b"null")
            connection.close()
            return response.status, data

        workspace = srv.workspaces.create("W")
        status, data = call("/api/shortcuts", {"scope": "workspace", "owner": workspace["id"], "items": [{"prompt": "x"}]})
        self.assertEqual(status, 200, data)
        self.assertEqual(data["shortcuts"]["workspaces"][workspace["id"]][0]["prompt"], "x")
        self.assertEqual(call("/api/shortcuts", {"scope": "agent", "owner": "x", "items": []})[0], 400)
        self.assertEqual(call(f"/api/workspaces/{workspace['id']}/delete", {})[0], 200)
        self.assertEqual(srv.shortcuts.snapshot()["workspaces"], {})

if __name__ == "__main__":
    unittest.main()

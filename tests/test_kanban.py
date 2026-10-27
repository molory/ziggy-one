"""Tests of the Tasks mode (Kanban boards): python3 -m unittest discover -s tests"""

import base64
import http.cookiejar
import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import server  # noqa: E402
from fakes import drain  # noqa: E402
from kanban import MAX_COLUMNS, Kanban  # noqa: E402


class KanbanTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)
        self.bus = server.Bus()
        self.events = self.bus.subscribe()
        self.kb = self.make()
        self.board = self.kb.create_board("  Ziggy   roadmap ")
        self.todo, self.doing, self.done = (c["id"] for c in self.board["columns"])

    def make(self):
        return Kanban(self.bus, self.dir / "data" / "kanbans.json", self.dir / "data" / "kanban-files")

    def titles(self, column):
        tickets = self.kb.get(self.board["id"])["tickets"]
        return [t["title"] for t in sorted(tickets, key=lambda t: t["position"]) if t["column"] == column]

    def test_new_board_has_default_columns_and_is_saved_privately(self):
        self.assertEqual(self.board["name"], "Ziggy roadmap")
        self.assertEqual([c["name"] for c in self.board["columns"]], ["To do", "In progress", "Done"])
        self.assertEqual((self.dir / "data" / "kanbans.json").stat().st_mode & 0o777, 0o600)
        kinds = [kind for kind, _ in drain(self.events)]
        self.assertEqual(kinds, ["kanbans", "kanban_board"])
        for bad in ("", "  ", None):
            with self.assertRaises(ValueError):
                self.kb.create_board(bad)

    def test_tickets_move_within_and_across_columns(self):
        board = self.board["id"]
        ids = {t: self.kb.create_ticket(board, self.todo, t)["id"] for t in ("A", "B", "C")}
        self.kb.move_ticket(ids["C"], self.todo, 0)
        self.assertEqual(self.titles(self.todo), ["C", "A", "B"])
        self.kb.move_ticket(ids["A"], self.doing, 99)  # clamped to the end
        self.assertEqual((self.titles(self.todo), self.titles(self.doing)), (["C", "B"], ["A"]))
        self.kb.move_ticket(ids["B"], self.doing, 0)
        self.assertEqual(self.titles(self.doing), ["B", "A"])
        positions = sorted(t["position"] for t in self.kb.get(board)["tickets"] if t["column"] == self.doing)
        self.assertEqual(positions, [0, 1])
        with self.assertRaises(KeyError):
            self.kb.move_ticket(ids["B"], "deadbeef", 0)
        with self.assertRaises(ValueError):
            self.kb.move_ticket(ids["B"], self.done, "0")

    def test_ticket_edit_and_delete_renumbers(self):
        board = self.board["id"]
        a, b = (self.kb.create_ticket(board, self.todo, t)["id"] for t in ("A", "B"))
        self.kb.update_ticket(b, {"title": " B  bis ", "description": "# Details\\n\\n- item"})
        ticket = next(t for t in self.kb.get(board)["tickets"] if t["id"] == b)
        self.assertEqual((ticket["title"], ticket["description"]), ("B bis", "# Details\\n\\n- item"))
        self.kb.delete_ticket(a)
        self.assertEqual([t["position"] for t in self.kb.get(board)["tickets"]], [0])
        with self.assertRaises(ValueError):
            self.kb.update_ticket(b, {"title": ""})

    def test_columns_can_be_customized(self):
        board = self.board["id"]
        review = self.kb.add_column(board, "Proofreading", 200)["id"]
        self.kb.update_column(board, review, {"name": "Review", "hue": None})
        self.kb.move_column(board, review, 1)
        columns = self.kb.get(board)["board"]["columns"]
        self.assertEqual([(c["name"], c["hue"]) for c in columns][:2], [("To do", None), ("Review", None)])
        with self.assertRaises(ValueError):
            self.kb.update_column(board, review, {"hue": 400})
        for index in range(MAX_COLUMNS - 4):
            self.kb.add_column(board, f"C{index}")
        with self.assertRaises(ValueError):
            self.kb.add_column(board, "one too many")

    def test_deleting_a_non_empty_column_needs_a_destination(self):
        board = self.board["id"]
        self.kb.create_ticket(board, self.done, "finished")
        self.kb.create_ticket(board, self.todo, "to do")
        with self.assertRaisesRegex(ValueError, "contains tickets"):
            self.kb.delete_column(board, self.todo)
        self.kb.delete_column(board, self.todo, into=self.done)
        self.assertEqual(self.titles(self.done), ["finished", "to do"])
        self.kb.delete_column(board, self.doing)  # empty: no destination needed
        with self.assertRaisesRegex(ValueError, "at least one column"):
            self.kb.delete_column(board, self.done)

    def test_files_are_private_and_removed_with_their_ticket_or_board(self):
        board = self.board["id"]
        ticket = self.kb.create_ticket(board, self.todo, "with a file")["id"]
        entry = self.kb.add_file(ticket, "../../etc/passwd", "text/plain", b"content")
        path, name, media_type = self.kb.file(ticket, entry["id"])
        self.assertEqual((path.read_bytes(), name, media_type), (b"content", "_.._.._etc_passwd", "text/plain"))
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)
        self.kb.delete_file(ticket, entry["id"])
        self.assertFalse(path.exists())
        second = self.kb.add_file(ticket, "notes.md", "text/markdown", b"x")
        self.kb.delete_board(board)
        self.assertFalse((self.dir / "data" / "kanban-files" / ticket).exists())
        with self.assertRaises(KeyError):
            self.kb.file(ticket, second["id"])
        self.assertEqual(self.kb.list(), [])

    def test_every_change_is_recorded_in_the_ticket_history(self):
        board = self.board["id"]
        ticket = self.kb.create_ticket(board, self.todo, "Write")["id"]
        other = self.kb.create_ticket(board, self.todo, "Other")["id"]
        self.kb.update_ticket(ticket, {"title": "Write the tests", "description": "v1"})
        self.kb.update_ticket(ticket, {"title": "Write the tests", "description": "v1"})  # nothing changes
        self.kb.move_ticket(ticket, self.todo, 1)  # mere reordering: not recorded
        self.kb.move_ticket(ticket, self.doing, 0)
        self.kb.update_column(board, self.doing, {"name": "In progress (renamed)"})
        entry = self.kb.add_file(ticket, "spec.pdf", "application/pdf", b"%PDF")
        self.kb.delete_file(ticket, entry["id"])
        self.kb.delete_column(board, self.doing, into=self.done)
        history = self.kb.ticket_history(ticket)
        self.assertEqual([h["kind"] for h in history],
                         ["created", "title", "description", "moved", "file_added", "file_removed", "moved"])
        created, title, description, moved, added, removed, forced = history
        self.assertEqual((created["column"], created["title"]), ("To do", "Write"))
        self.assertEqual((title["before"], title["after"]), ("Write", "Write the tests"))
        self.assertEqual((description["before"], description["after"]), ("", "v1"))
        self.assertEqual((moved["fromColumn"], moved["toColumn"]), ("To do", "In progress"), "names at the time of the change")
        self.assertEqual((added["name"], added["size"], removed["name"]), ("spec.pdf", 4, "spec.pdf"))
        self.assertEqual((forced["fromColumn"], forced["toColumn"], forced["reason"]), ("In progress (renamed)", "Done", "column deleted"))
        self.assertEqual([h["kind"] for h in self.kb.ticket_history(other)], ["created"])

    def test_delivery_date_can_be_set_changed_and_removed(self):
        ticket = self.kb.create_ticket(self.board["id"], self.todo, "Ship the release")
        self.assertIsNone(ticket["due"])
        self.kb.update_ticket(ticket["id"], {"due": "2026-11-05"}, by="Teams")
        self.kb.update_ticket(ticket["id"], {"due": "2026-11-05"})  # same date: no history entry
        self.kb.update_ticket(ticket["id"], {"due": "2026-11-12"})
        self.assertEqual(self.make().get(self.board["id"])["tickets"][0]["due"], "2026-11-12", "saved")
        self.kb.update_ticket(ticket["id"], {"due": None})
        self.assertIsNone(self.kb.get(self.board["id"])["tickets"][0]["due"])
        dues = [(e["before"], e["after"], e["by"]) for e in self.kb.history.of(ticket["id"]) if e["kind"] == "due"]
        self.assertEqual(dues, [(None, "2026-11-05", "Teams"), ("2026-11-05", "2026-11-12", "user"), ("2026-11-12", None, "user")])
        for bad in ("2026-02-30", "05/11/2026", "2026-11-5", 20261105, "tomorrow"):
            with self.assertRaises(ValueError, msg=bad):
                self.kb.update_ticket(ticket["id"], {"due": bad})

    def test_history_is_persisted_append_only(self):
        board = self.board["id"]
        ticket = self.kb.create_ticket(board, self.todo, "Persisted")["id"]
        self.kb.update_ticket(ticket, {"title": "Persisted!"})
        journal = self.dir / "data" / "kanban-history.jsonl"
        self.assertEqual(journal.stat().st_mode & 0o777, 0o600)
        with journal.open("a") as file:
            file.write('{"ticket": "cut off mid-wr')  # crash during a write…
        self.kb = self.make()  # …then restart
        self.assertEqual([h["kind"] for h in self.kb.ticket_history(ticket)], ["created", "title"])
        self.kb.delete_ticket(ticket)
        with self.assertRaises(KeyError):
            self.kb.ticket_history(ticket)  # the ticket no longer exists…
        kinds = [json.loads(line).get("kind") for line in journal.read_text().splitlines() if line.endswith("}")]
        self.assertEqual(kinds, ["created", "title", "deleted"], "…but its history stays in the log")

    def test_tickets_get_unique_numbers_never_reused(self):
        other = self.kb.create_board("Other")
        first = self.kb.create_ticket(self.board["id"], self.todo, "One")
        second = self.kb.create_ticket(other["id"], other["columns"][0]["id"], "Two")
        self.assertEqual((first["number"], second["number"]), (1, 2), "numbering shared by all boards")
        self.kb.delete_ticket(second["id"])
        third = self.kb.create_ticket(self.board["id"], self.todo, "Three")
        self.assertEqual(third["number"], 3, "a deleted number is not reused")
        self.assertEqual(self.make().create_ticket(self.board["id"], self.todo, "Four")["number"], 4, "persisted counter")
        self.assertEqual(self.kb.find_number(3), {"board": self.board["id"], "ticket": third["id"], "number": 3})
        with self.assertRaisesRegex(KeyError, "#2"):
            self.kb.find_number(2)
        self.assertEqual({(t["number"], t["title"], t["boardName"]) for t in self.kb.index()},
                         {(1, "One", "Ziggy roadmap"), (3, "Three", "Ziggy roadmap")})

    def test_tickets_created_before_numbers_are_numbered_oldest_first(self):
        board = self.board["id"]
        for title in ("Old", "Recent", "Duplicate"):
            self.kb.create_ticket(board, self.todo, title)
        path = self.dir / "data" / "kanbans.json"
        data = json.loads(path.read_text())
        del data["nextNumber"]
        data["tickets"][0].pop("number")
        data["tickets"][1].pop("number")
        data["tickets"][2]["number"] = 7
        data["tickets"][0]["createdAt"], data["tickets"][1]["createdAt"] = 1, 2
        path.write_text(json.dumps(data))
        numbers = {t["title"]: t["number"] for t in self.make().get(board)["tickets"]}
        self.assertEqual(numbers, {"Duplicate": 7, "Old": 8, "Recent": 9})
        self.assertEqual(json.loads(path.read_text())["nextNumber"], 10, "numbers saved as soon as loaded")

    def test_reload_ignores_damaged_entries(self):
        board = self.board["id"]
        self.kb.create_ticket(board, self.todo, "kept")
        path = self.dir / "data" / "kanbans.json"
        data = json.loads(path.read_text())
        data["boards"].append({"id": "not-an-id", "name": "x", "columns": []})
        data["tickets"] += [{"id": "a" * 12, "board": board, "column": "unknown", "title": "orphan"}, "anything"]
        path.write_text(json.dumps(data))
        reloaded = self.make()
        self.assertEqual([b["name"] for b in reloaded.list()], ["Ziggy roadmap"])
        self.assertEqual([t["title"] for t in reloaded.get(board)["tickets"]], ["kept"])
        path.write_text("not json")
        self.assertEqual(self.make().list(), [])


class KanbanHttpTest(unittest.TestCase):
    """The routes end to end, on a real local server."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.srv = server.ZiggyServer(0, tmp.name, {}, data_dir=Path(tmp.name) / "data")
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.addCleanup(self.srv.server_close)
        self.addCleanup(self.srv.shutdown)
        self.base = f"http://127.0.0.1:{self.srv.server_address[1]}"
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.opener.open(f"{self.base}/?token={self.srv.token}").read()

    def post(self, path, body):
        request = urllib.request.Request(self.base + path, json.dumps(body).encode(),
                                         {"Content-Type": "application/json", "Origin": self.base})
        return json.loads(self.opener.open(request).read())

    def get(self, path):
        return self.opener.open(self.base + path).read()

    def test_board_ticket_file_workspace_and_pin(self):
        board = self.post("/api/kanbans", {"name": "Sprint"})
        todo = board["columns"][0]["id"]
        ticket = self.post(f"/api/kanbans/{board['id']}/tickets", {"column": todo, "title": "Write the tests"})
        self.post(f"/api/kanbans/tickets/{ticket['id']}/move", {"column": board["columns"][1]["id"], "index": 0})
        found = json.loads(self.get(f"/api/kanbans/tickets/number/{ticket['number']}"))
        self.assertEqual(found["ticket"], ticket["id"])
        self.assertIn(b'<div class="layout', self.get(f"/t/{ticket['number']}"), "a ticket's address serves the page")
        self.post(f"/api/kanbans/tickets/{ticket['id']}/update", {"due": "2026-12-01"})
        self.assertEqual(json.loads(self.get(f"/api/kanbans/{board['id']}"))["tickets"][0]["due"], "2026-12-01")
        history = json.loads(self.get(f"/api/kanbans/tickets/{ticket['id']}/history"))["history"]
        self.assertEqual([(h["kind"], h.get("toColumn")) for h in history],
                         [("created", None), ("moved", "In progress"), ("due", None)])
        data = base64.b64encode(b"%PDF-1.4 fake").decode()
        entry = self.post(f"/api/kanbans/tickets/{ticket['id']}/files", {"name": "spec.pdf", "type": "application/pdf", "data": data})
        self.assertEqual(self.get(f"/api/kanbans/tickets/{ticket['id']}/files/{entry['id']}/spec.pdf"), b"%PDF-1.4 fake")
        workspace = self.post("/api/kanbans/workspaces", {"name": "Projects"})
        self.post(f"/api/kanbans/workspaces/{workspace['id']}/add", {"board": board["id"]})
        self.post("/api/kanbans/pins", {"pins": [board["id"]]})
        listing = json.loads(self.get("/api/kanbans"))
        self.assertEqual(listing["boards"][0]["counts"][board["columns"][1]["id"]], 1)
        self.assertEqual(listing["workspaces"][0]["agents"], [board["id"]])
        self.assertEqual(listing["pins"], [board["id"]])
        # Agent workspaces and pins are not touched.
        self.assertEqual(self.srv.workspaces.list(), [])
        self.post(f"/api/kanbans/{board['id']}/delete", {})
        listing = json.loads(self.get("/api/kanbans"))
        self.assertEqual((listing["boards"], listing["workspaces"][0]["agents"], listing["pins"]), ([], [], []))

    def test_shared_link_lets_an_agent_read_the_ticket(self):
        board = self.post("/api/kanbans", {"name": "Sprint"})
        todo = board["columns"][0]["id"]
        cited = self.post(f"/api/kanbans/{board['id']}/tickets", {"column": todo, "title": "Cited ticket"})
        ticket = self.post(f"/api/kanbans/{board['id']}/tickets", {
            "column": todo, "title": "Read a ticket", "description": f"See #{cited['number']} for context."})
        self.post(f"/api/kanbans/tickets/{ticket['id']}/files",
                  {"name": "notes.txt", "type": "text/plain", "data": base64.b64encode(b"attached content").decode()})
        link = json.loads(self.get(f"/api/kanbans/tickets/{ticket['id']}/link"))["path"]
        self.assertRegex(link, rf"^/t/{ticket['number']}\?k=[0-9a-f]{{20}}$")
        agent = urllib.request.build_opener()  # an agent: no cookie
        text = agent.open(self.base + link).read().decode()
        self.assertIn(f"# #{ticket['number']} · Read a ticket", text)
        self.assertIn("- Column: To do", text)
        self.assertIn(f"See #{cited['number']} for context.", text)
        self.assertIn("## History", text)
        file_url = next(line.split(": ", 1)[1] for line in text.splitlines() if line.startswith("- notes.txt"))
        self.assertEqual(agent.open(file_url).read(), b"attached content")
        cited_url = next(line.split(": ", 1)[1] for line in text.splitlines() if line.startswith(f"- #{cited['number']}"))
        self.assertIn("# #1 · Cited ticket", agent.open(cited_url).read().decode(), "cited tickets can be followed")
        # In the browser (cookie), the same address opens the page.
        self.assertIn(b'<div class="layout', self.get(link))
        for bad in (f"/t/{ticket['number']}", f"/t/{ticket['number']}?k=0000", f"/t/{cited['number']}?k={link.split('k=')[1]}"):
            with self.assertRaises(urllib.error.HTTPError) as caught:
                agent.open(self.base + bad)
            self.assertEqual(caught.exception.code, 401, bad)
            caught.exception.close()

    def test_errors_are_explained(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.post("/api/kanbans/tickets/aaaaaaaaaaaa/update", {"title": "x"})
        self.assertEqual((caught.exception.code, json.loads(caught.exception.read())["error"]), (404, "Unknown ticket"))
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.post("/api/kanbans", {"name": ""})
        self.assertEqual(caught.exception.code, 400)
        caught.exception.close()


if __name__ == "__main__":
    unittest.main()

"""Tests of ziggy-one (stdlib only): python3 -m unittest discover -s tests"""

import http.client
import base64
import contextlib
import io
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import server  # noqa: E402
from fakes import drain, install_fake_interactive_claude, wait_for  # noqa: E402

class ParsingTest(unittest.TestCase):
    def test_parse_json_line(self):
        self.assertEqual(server.parse_json_line('{"a": 1}'), {"a": 1})
        self.assertIsNone(server.parse_json_line("not json"))
        self.assertIsNone(server.parse_json_line("[1, 2]"))

    def test_build_claude_args_puts_allowed_tools_last(self):
        args = server.build_claude_args(model="opus", allowed_tools=["Edit"], chrome=True)
        self.assertEqual(args, ["--model", "opus", "--chrome", "--allowedTools", "Edit", "mcp__claude-in-chrome"])
        self.assertEqual(server.build_claude_args(), [])

    def test_list_active_sessions_keeps_live_pids_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / "live.json").write_text(json.dumps({"pid": os.getpid(), "sessionId": "a", "updatedAt": 1}))
            (directory / "dead.json").write_text(json.dumps({"pid": 2**22 + 12345, "sessionId": "b"}))
            (directory / "broken.json").write_text("{")
            (directory / "x.key").write_text("secret")
            sessions = server.list_active_sessions(directory)
        self.assertEqual([s["sessionId"] for s in sessions], ["a"])
        self.assertEqual(set(sessions[0]), set(server.SESSION_FIELDS))


class HeaderTest(unittest.TestCase):
    def test_send_refuses_a_line_break_in_a_header_value(self):
        handler = server.Handler.__new__(server.Handler)
        handler.send_response = mock.Mock()
        for value in ("a\r\nSet-Cookie: x=1", "a\nb"):
            with self.assertRaises(ValueError):
                handler._send(200, b"x", headers={"Content-Disposition": value})
        handler.send_response.assert_not_called()

    def test_every_header_refuses_a_line_break(self):
        # _send_file and the event stream write their headers themselves: the check is in send_header.
        handler = server.Handler.__new__(server.Handler)
        handler.request_version = "HTTP/1.1"
        handler._headers_buffer = []
        handler.send_header("Content-Disposition", "inline; filename*=UTF-8''a%0Ab")  # encoded: fine
        for value in ("inline; filename=a\r\nSet-Cookie: x=1", "a\nb"):
            with self.assertRaises(ValueError):
                handler.send_header("Content-Disposition", value)
        self.assertEqual(len(handler._headers_buffer), 1)


class ListSessionsTest(unittest.TestCase):
    def test_merges_open_sessions_with_recent_transcripts(self):
        recent = [
            {"sessionId": "b", "cwd": "/b", "updatedAt": 300, "lastPrompt": "B", "costUsd": 1.0},
            {"sessionId": "a", "cwd": "/a", "updatedAt": 100, "lastPrompt": "A", "costUsd": None},
        ]
        live = [
            {"sessionId": "a", "cwd": "/a", "name": "a-1", "status": "busy", "updatedAt": 500_000, "pid": 10},
            {"sessionId": "c", "cwd": "/c", "name": "c-1", "status": "idle", "updatedAt": 200_000, "pid": 11},
            {"sessionId": "b", "cwd": "/b", "name": "b-1", "status": "busy", "updatedAt": 900_000, "pid": 12},
        ]
        with mock.patch.object(server.transcripts, "list_recent", return_value=recent), \
                mock.patch.object(server, "list_active_sessions", return_value=live), \
                mock.patch.object(server.transcripts, "find_transcript", return_value=None):
            sessions = server.list_sessions(our_pids={12})  # "b" runs in ziggy-one
        self.assertEqual([s["sessionId"] for s in sessions], ["a", "b", "c"])
        self.assertTrue(all(s["git"] is False for s in sessions))  # /a, /b, /c: no repository
        a, b, c = sessions
        self.assertEqual((a["active"], a["lastPrompt"], a["status"], a["updatedAt"]), (True, "A", "busy", 500))
        self.assertEqual((b["active"], b["costUsd"]), (False, 1.0))
        self.assertEqual((c["active"], c["cwd"], c["lastPrompt"]), (True, "/c", None))


class ListSessionsIncludeTest(unittest.TestCase):
    def test_pinned_sessions_are_returned_even_if_old(self):
        old = {"sessionId": "old", "cwd": "/o", "updatedAt": 1, "lastPrompt": "Old", "costUsd": None}
        with mock.patch.object(server.transcripts, "list_recent", return_value=[]), \
                mock.patch.object(server, "list_active_sessions", return_value=[]), \
                mock.patch.object(server.transcripts, "find_transcript",
                                  side_effect=lambda sid: Path("/x") if sid == "old" else None), \
                mock.patch.object(server.transcripts, "summarize", return_value=old):
            sessions = server.list_sessions(include=["old", "missing"])
        self.assertEqual(sessions, [{**old, "active": False, "git": False, "context": None}])


class UsageTest(unittest.TestCase):
    def test_update_reads_unified_windows_and_publishes(self):
        bus = server.Bus()
        q = bus.subscribe()
        usage = server.Usage(bus)
        usage.update({
            "status": "allowed",
            "unifiedWindows": {"five_hour": {"utilization": 0.04, "resetsAt": 10}, "bad": "x"},
        })
        snapshot = usage.snapshot()
        self.assertEqual(snapshot["windows"], {"five_hour": {"utilization": 0.04, "resetsAt": 10}})
        self.assertEqual(snapshot["status"], "allowed")
        self.assertEqual(q.get_nowait()[0], "usage")

    def test_update_falls_back_to_single_window(self):
        usage = server.Usage(server.Bus())
        usage.update({"rateLimitType": "seven_day", "utilization": 0.5, "resetsAt": 20})
        self.assertEqual(usage.snapshot()["windows"], {"seven_day": {"utilization": 0.5, "resetsAt": 20}})


class ConversationsHttpTest(unittest.TestCase):
    """Full HTTP walk-through with the fake interactive claude: open, Terminal, hooks, delete."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        install_fake_interactive_claude(self, tmp.name)
        self.tmp = Path(tmp.name)
        self.httpd = server.ZiggyServer(port=0, conversation_cwd=tmp.name, account={},
                                          defaults={"model": "sonnet", "permissionMode": "auto"},
                                          data_dir=tmp.name)
        # Dummy sessions: they have no history on disk, treat them as written.
        self.httpd.conversations.has_history = lambda session_id: True
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(self.httpd.shutdown)
        self.events = self.httpd.bus.subscribe()
        port = self.httpd.server_address[1]
        self.host = f"127.0.0.1:{port}"
        self.headers = {
            "Host": self.host, "Origin": f"http://{self.host}",
            "Cookie": f"{self.httpd.cookie_name}={self.httpd.sessions.create()}", "Content-Type": "application/json",
        }

    def call(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection(*self.host.split(":"), timeout=5)
        payload = json.dumps(body).encode() if body is not None else None
        connection.request(method, path, body=payload, headers={**self.headers, **(headers or {})})
        response = connection.getresponse()
        data = json.loads(response.read() or b"null")
        connection.close()
        return response.status, data

    def raw(self, method, path):
        """Raw response (status, body, headers), for what is not JSON."""
        connection = http.client.HTTPConnection(*self.host.split(":"), timeout=5)
        connection.request(method, path, headers=self.headers)
        response = connection.getresponse()
        body = response.read()
        connection.close()
        return response.status, body, dict(response.getheaders())

    def screen(self, conversation_id):
        return base64.b64decode(self.httpd.terminals.snapshot(conversation_id)["data"]).decode()

    def launch_args(self, conversation_id):
        """Arguments received by the fake claude of the agent's terminal."""
        self.assertTrue(wait_for(lambda: "ARGS " in self.screen(conversation_id)))
        line = next(l for l in self.screen(conversation_id).splitlines() if l.startswith("ARGS "))
        return json.loads(line[5:])

    def hook(self, event, conversation_id, payload, token=None):
        headers = {"Host": self.host, "Content-Type": "application/json",
                   "Authorization": f"Bearer {token or self.httpd.hook_token}"}
        connection = http.client.HTTPConnection(*self.host.split(":"), timeout=5)
        connection.request("POST", f"/hooks/{event}?conversation={conversation_id}", body=json.dumps(payload).encode(),
                           headers=headers)
        response = connection.getresponse()
        body = response.read().decode()
        connection.close()
        return response.status, body

    def test_session_start_hook_gives_the_agent_directory(self):
        _, me = self.call("POST", "/api/conversations", {})
        _, teams = self.call("POST", "/api/conversations", {})
        self.assertEqual(self.hook("session", me["id"], {"source": "startup"}), (200, ""), "no role: nothing")
        self.call("POST", "/api/agents/rename", {"agent": teams["id"], "name": "Teams"})
        status, data = self.call("POST", "/api/agents/role", {"agent": teams["id"], "role": "Sends the Teams messages."})
        self.assertEqual((status, data["agents"][teams["id"]]["role"]), (200, "Sends the Teams messages."))
        status, text = self.hook("session", me["id"], {"source": "startup"})
        self.assertEqual(status, 200)
        self.assertIn('- "Teams" (closed for now): Sends the Teams messages.', text)
        self.assertEqual(self.hook("session", me["id"], {}, token="wrong")[0], 403)
        self.assertEqual(self.call("POST", "/api/agents/role", {"agent": teams["id"], "role": 3})[0], 400)

    def test_open_and_delete(self):
        status, first = self.call("POST", "/api/conversations", {})
        self.assertEqual((status, first["busy"], first["sessionId"]), (200, False, None))
        _, second = self.call("POST", "/api/conversations", {})
        _, state = self.call("GET", "/api/state")
        self.assertEqual({c["id"] for c in state["conversations"]}, {first["id"], second["id"]})
        self.assertEqual(state["defaultCwd"], self.httpd.conversations.default_cwd)
        self.assertNotIn("permissions", state)
        self.assertEqual(self.call("POST", f"/api/conversations/{first['id']}/delete", {})[0], 200)
        self.assertEqual(self.call("POST", f"/api/conversations/{first['id']}/terminal-start", {"cols": 80, "rows": 24})[0], 404)
        for gone in ("message", "interrupt"):
            self.assertEqual(self.call("POST", f"/api/conversations/{second['id']}/{gone}", {"text": "x"})[0], 404, gone)

    def test_agents_get_kanban_tools_with_their_own_key(self):
        _, opened = self.call("POST", "/api/conversations", {})
        self.call("POST", "/api/agents/rename", {"agent": opened["id"], "name": "Teams/Outlook"})
        self.httpd.kanban.create_board("Atlas")
        self.call("POST", f"/api/conversations/{opened['id']}/terminal-start", {"cols": 100, "rows": 30})
        args = self.launch_args(opened["id"])
        config_path = Path(args[args.index("--mcp-config") + 1])
        self.assertEqual(config_path.stat().st_mode & 0o777, 0o600)
        server_config = json.loads(config_path.read_text())["mcpServers"]["ziggy"]
        self.assertEqual(server_config["url"], f"http://127.0.0.1:{self.httpd.port}/mcp")
        key = server_config["headers"]["Authorization"]
        self.assertNotIn(key.split()[-1], " ".join(args), "the key goes through the file, not the command line")

        def mcp(message, headers):
            # Like Claude Code: no cookie, no origin.
            return self.call("POST", "/mcp", message, {"Cookie": "", "Origin": "", **headers})

        create = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                  "params": {"name": "kanban_create_ticket", "arguments": {"title": "Notify the team"}}}
        status, response = mcp(create, {"Authorization": key})
        self.assertEqual(status, 200)
        self.assertIn("created", response["result"]["content"][0]["text"])
        number = self.httpd.kanban.index()[-1]["number"]
        history = self.httpd.kanban.ticket_history(self.httpd.kanban.find_number(number)["ticket"])
        self.assertEqual(history[0]["by"], "Teams/Outlook")
        self.assertEqual(mcp(create, {})[0], 401)  # without key
        self.assertEqual(mcp(create, {"Authorization": "Bearer abcdef123456.fake"})[0], 401)
        self.assertEqual(mcp(create, {"Authorization": key, "Origin": "http://evil.example"})[0], 403)  # web page
        self.assertEqual(mcp({"jsonrpc": "2.0", "method": "notifications/initialized"}, {"Authorization": key})[0], 202)
        self.assertEqual(self.call("GET", "/mcp")[0], 405)
        self.call("POST", f"/api/conversations/{opened['id']}/terminal-stop", {})
        self.assertTrue(wait_for(lambda: not config_path.exists()), "MCP configuration deleted on close")

    def test_agents_create_agents_and_group_them_in_workspaces(self):
        _, boss = self.call("POST", "/api/conversations", {})
        self.call("POST", "/api/agents/rename", {"agent": boss["id"], "name": "Doxo Boss"})
        key = f"Bearer {server.agent_mcp.agent_key(self.httpd.token, boss['id'])}"
        projects = tempfile.TemporaryDirectory()  # outside ziggy-one's data (self.tmp), which is refused
        self.addCleanup(projects.cleanup)
        repo = Path(projects.name) / "api"
        repo.mkdir()

        def tool(name, arguments):
            status, response = self.call("POST", "/mcp", {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                                         "params": {"name": name, "arguments": arguments}},
                                         {"Cookie": "", "Origin": "", "Authorization": key})
            self.assertEqual(status, 200)
            return response["result"]["content"][0]["text"], response["result"]["isError"]

        text, error = tool("agents_create", {"name": "Doxo API", "folder": str(repo), "role": "Backend NestJS",
                                             "workspace": "Doxomed"})
        self.assertFalse(error, text)
        self.assertIn("(new)", text)
        created = next(c for c in self.httpd.conversations.list() if c["cwd"] == str(repo.resolve()))
        self.assertFalse(self.httpd.terminals.running(created["id"]), "a created agent does not start by itself")
        self.assertEqual(self.httpd.agents.name_for([created["id"]]), "Doxo API")
        self.assertIn((created["id"], "Doxo API", "Backend NestJS"), self.httpd.agents.roles())
        workspace = self.httpd.workspaces.workspace_for([created["id"]])
        self.assertEqual(workspace["name"], "Doxomed")
        # The caller joins the same workspace, by its name; the workspace is found again, not created twice.
        text, error = tool("agents_set_workspace", {"agent": "doxo boss", "workspace": "doxomed"})
        self.assertFalse(error, text)
        self.assertEqual(self.httpd.workspaces.workspace_for([boss["id"]])["id"], workspace["id"])
        self.assertEqual(len(self.httpd.workspaces.list()), 1)
        listing, _ = tool("agents_list", {})
        self.assertIn(f'"Doxo API" (not started) in {repo.resolve()}, workspace "Doxomed": Backend NestJS', listing)
        # Refused: same name, missing folder, ziggy-one's data, unknown agent.
        self.assertTrue(tool("agents_create", {"name": "doxo api", "folder": str(repo)})[1])
        self.assertTrue(tool("agents_create", {"name": "Other", "folder": str(self.tmp / "missing")})[1])
        self.assertTrue(tool("agents_create", {"name": "Other", "folder": str(self.httpd.data_dir)})[1])
        self.assertTrue(tool("agents_set_workspace", {"agent": "Nobody", "workspace": "Doxomed"})[1])

    def test_only_the_agent_in_ziggy_ones_folder_can_restart_the_server(self):
        _, boss = self.call("POST", "/api/conversations", {"cwd": str(server.WEB_DIR.parent)})
        _, other = self.call("POST", "/api/conversations", {})

        def mcp(conversation, method, params=None):
            key = f"Bearer {server.agent_mcp.agent_key(self.httpd.token, conversation['id'])}"
            return self.call("POST", "/mcp", {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}},
                             {"Cookie": "", "Origin": "", "Authorization": key})[1]

        def names(conversation):
            return [tool["name"] for tool in mcp(conversation, "tools/list")["result"]["tools"]]

        self.assertIn("server_restart", names(boss))
        self.assertNotIn("server_restart", names(other))
        self.assertIn("agents_create", names(other))
        call = {"name": "server_restart", "arguments": {}}
        with mock.patch.object(self.httpd.restart, "request") as request:
            self.assertEqual(mcp(other, "tools/call", call)["error"]["code"], server.agent_mcp.INVALID_PARAMS)
            request.assert_not_called()
            result = mcp(boss, "tools/call", call)["result"]
        self.assertFalse(result["isError"], result)
        request.assert_called_once_with(requester=boss["id"])

    def test_open_terminals_with_their_memory(self):
        _, opened = self.call("POST", "/api/conversations", {})
        self.assertEqual(self.call("GET", "/api/terminals"), (200, {"terminals": []}))
        self.call("POST", f"/api/conversations/{opened['id']}/terminal-start", {"cols": 100, "rows": 30})
        self.launch_args(opened["id"])  # (fake) Claude Code has started
        status, data = self.call("GET", "/api/terminals")
        self.assertEqual(status, 200)
        [terminal] = data["terminals"]
        self.assertEqual(terminal["conversation"], opened["id"])
        self.assertGreater(terminal["memory"], 1024 * 1024)  # a few MB at least
        self.assertLessEqual(terminal["startedAt"], time.time())
        self.call("POST", f"/api/conversations/{opened['id']}/terminal-stop", {})
        self.assertTrue(wait_for(lambda: self.call("GET", "/api/terminals")[1]["terminals"] == []))

    def test_shell_command_runs_in_the_agent_folder_without_claude(self):
        _, opened = self.call("POST", "/api/conversations", {})
        status, started = self.call("POST", f"/api/conversations/{opened['id']}/shell", {"command": "echo hello"})
        self.assertEqual(status, 200)
        events = []
        self.assertTrue(wait_for(lambda: events.extend(drain(self.events)) or any(
            k == "shell" and d.get("ended") for k, d in events)))
        shell = [d for k, d in events if k == "shell" and d["run"] == started["run"]]
        self.assertEqual("".join(d.get("output", "") for d in shell), "hello\n")
        self.assertEqual(shell[0]["cwd"], self.httpd.conversations.default_cwd)
        self.assertFalse(self.httpd.terminals.running(opened["id"]), "Claude Code is not started")
        self.assertEqual(self.call("POST", f"/api/conversations/{opened['id']}/shell", {"command": " "})[0], 400)
        stop = self.call("POST", f"/api/conversations/{opened['id']}/shell-stop", {"run": started["run"]})
        self.assertEqual(stop[0], 404)  # already ended

    def test_agent_waiting_for_an_answer(self):
        _, opened = self.call("POST", "/api/conversations", {})
        conversation = self.httpd.conversations.get(opened["id"])
        self.hook("prompt", opened["id"], {"prompt": "deploy"})
        self.assertEqual(self.hook("notify", opened["id"], {"notification_type": "permission_prompt"}), (200, ""))
        self.assertEqual(conversation.status()["waiting"], "permission")
        self.hook("tool", opened["id"], {"tool_name": "Bash"})  # allowed: the command ran
        self.assertIsNone(conversation.status()["waiting"])
        self.hook("notify", opened["id"], {"notification_type": "elicitation_dialog"})
        self.assertEqual(conversation.status()["waiting"], "question")
        self.hook("notify", opened["id"], {"notification_type": "idle_prompt"})  # ignored
        self.assertEqual(conversation.status()["waiting"], "question")
        self.hook("stop", opened["id"], {})
        self.assertIsNone(conversation.status()["waiting"])

    def test_session_named_after_the_agent_and_rename_closes_the_terminal(self):
        _, opened = self.call("POST", "/api/conversations", {})
        self.call("POST", "/api/agents/rename", {"agent": opened["id"], "name": "Teams/Outlook"})
        self.call("POST", f"/api/conversations/{opened['id']}/terminal-start", {"cols": 100, "rows": 30})
        first = self.launch_args(opened["id"])
        self.assertIn("--name=Teams/Outlook", first)  # name seen by the other agents, in one argument
        self.assertLess(first.index("--name=Teams/Outlook"), first.index("--model"))  # before --allowedTools, variadic
        # Same name: the terminal stays open.
        status, result = self.call("POST", "/api/agents/rename", {"agent": opened["id"], "name": " Teams/Outlook "})
        self.assertEqual((status, result["terminalClosed"]), (200, False))
        self.assertTrue(self.httpd.terminals.running(opened["id"]))
        # New name: the terminal is closed, it will be reopened under that name.
        status, result = self.call("POST", "/api/agents/rename", {"agent": opened["id"], "name": "Messaging"})
        self.assertEqual((status, result["terminalClosed"]), (200, True))
        self.assertTrue(wait_for(lambda: not self.httpd.terminals.running(opened["id"])))

    def test_terminal_runs_claude_with_our_hooks_and_agent_options(self):
        _, opened = self.call("POST", "/api/conversations", {})
        self.assertEqual(self.call("POST", f"/api/conversations/{opened['id']}/terminal-start", {"cols": 100, "rows": 30})[0], 200)
        first = self.launch_args(opened["id"])
        self.assertEqual(first[first.index("--model") + 1], "sonnet")  # server default
        self.assertEqual(first[first.index("--permission-mode") + 1], "auto")
        settings = Path(first[first.index("--settings") + 1])
        self.assertEqual(settings.stat().st_mode & 0o777, 0o600)
        hooks = json.loads(settings.read_text())["hooks"]
        self.assertEqual(set(hooks), {"SessionStart", "UserPromptSubmit", "Stop", "Notification", "PostToolUse"})
        command = hooks["UserPromptSubmit"][0]["hooks"][0]["command"]
        self.assertIn(f"ziggy_hook.py prompt {self.httpd.port} {opened['id']}", command)
        self.assertNotIn(self.httpd.hook_token, command, "the token goes through a file, not the command line")
        # Ziggy One's data (token, keys) out of reach of the agent's file tools.
        data = f"/{self.httpd.data_dir.resolve()}/**"
        self.assertEqual(json.loads(settings.read_text())["permissions"]["deny"], [f"Read({data})", f"Edit({data})"])
        # Agent settings: applied at the next opening, on the same session.
        session = "11111111-2222-4333-8444-555555555555"
        self.httpd.conversations.get(opened["id"]).adopt_session(session)
        options = {"model": "haiku", "permissionMode": "plan", "chrome": False}
        self.assertEqual(self.call("POST", "/api/agents/options", {"agent": session, "options": options})[0], 200)
        self.call("POST", f"/api/conversations/{opened['id']}/terminal-stop", {})
        self.assertTrue(wait_for(lambda: not self.httpd.terminals.running(opened["id"])))
        self.assertFalse(settings.exists(), "terminal settings deleted when it closes")
        with mock.patch.object(server.transcripts, "find_transcript", return_value=Path("/history.jsonl")):
            self.call("POST", f"/api/conversations/{opened['id']}/terminal-start", {"cols": 100, "rows": 30})
        second = self.launch_args(opened["id"])
        self.assertEqual(second[second.index("--model") + 1], "haiku")
        self.assertEqual(second[second.index("--permission-mode") + 1], "plan")
        self.assertEqual(second[second.index("--resume") + 1], session)
        bad = {"agent": session, "options": {"permissionMode": "bypassPermissions"}}
        self.assertEqual(self.call("POST", "/api/agents/options", bad)[0], 400)
        # Avatar: image sent in base64, then served from its id, cached.
        png = b"\x89PNG\r\n\x1a\n" + b"0" * 50
        body = {"agent": session, "avatar": {"kind": "image", "abbr": "LA"}, "image": base64.b64encode(png).decode()}
        status, data = self.call("POST", "/api/agents/avatar", body)
        self.assertEqual(status, 200)
        image_id = data["agents"][session]["avatar"]["image"]
        status, served, headers = self.raw("GET", f"/api/agents/avatars/{image_id}")
        self.assertEqual((status, served, headers["Content-Type"]), (200, png, "image/png"))
        self.assertIn("immutable", headers["Cache-Control"])
        self.assertEqual(self.raw("GET", "/api/agents/avatars/0123456789abcdef")[0], 404)
        self.assertEqual(self.call("POST", "/api/agents/avatar", {**body, "image": "not base64!"})[0], 400)
        self.assertEqual(self.call("POST", "/api/agents/avatar", {"agent": session, "avatar": {"kind": "rocket"}})[0], 400)

    def test_hooks_track_turns_and_share_activity(self):
        repo = self.tmp / "repo"
        repo.mkdir()
        subprocess.run(["git", "init", "-q", "-b", "main"], cwd=repo, check=True)
        _, slave = self.call("POST", "/api/conversations", {"cwd": str(repo)})
        _, boss = self.call("POST", "/api/conversations", {"cwd": str(repo)})
        _, workspace = self.call("POST", "/api/workspaces", {"name": "Ziggy"})
        for agent in (slave, boss):
            self.call("POST", f"/api/workspaces/{workspace['id']}/add", {"agent": agent["id"]})
        self.call("GET", "/api/state")
        drain(self.events)
        # The boss speaks a first time (nothing to share), then the slave works.
        self.assertEqual(self.hook("prompt", boss["id"], {"session_id": "22222222-2222-4333-8444-555555555555", "prompt": "hi"}), (200, ""))
        status, text = self.hook("prompt", slave["id"], {"session_id": "11111111-2222-4333-8444-555555555555", "prompt": "merge the branch"})
        self.assertEqual((status, text), (200, ""))
        conversation = self.httpd.conversations.get(slave["id"])
        self.assertTrue(conversation.status()["busy"])
        self.assertEqual(conversation.session_id, "11111111-2222-4333-8444-555555555555")
        projects = self.tmp / "projects"
        transcript = projects / "x" / "s.jsonl"
        transcript.parent.mkdir(parents=True)
        transcript.write_text(json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": "Branch merged."}]}}) + "\n")
        with mock.patch.object(server.transcripts, "PROJECTS_DIR", projects):
            self.assertEqual(self.hook("stop", slave["id"], {"session_id": conversation.session_id, "transcript_path": str(transcript)})[0], 200)
        self.assertFalse(conversation.status()["busy"])
        ends = [d for k, d in drain(self.events) if k == "turn_end"]
        self.assertEqual(ends, [{"conversation": slave["id"], "summary": "Branch merged."}])
        # On the boss's next message, the hook gives it what the slave did, through the real script.
        self.assertTrue(wait_for(lambda: self.httpd.activity._events))
        payload = json.dumps({"session_id": "22222222-2222-4333-8444-555555555555", "prompt": "and now?"})
        result = subprocess.run(
            [sys.executable, str(server.HOOK_SCRIPT), "prompt", str(self.httpd.port), boss["id"], str(self.httpd.hook_token_file)],
            input=payload, capture_output=True, text=True, timeout=20,
        )
        self.assertEqual(result.returncode, 0)
        self.assertIn("<ziggy-shared-context>", result.stdout)
        self.assertIn('"merge the branch" → Branch merged.', result.stdout)
        # Recent Claude Code: the last answer comes with the hook.
        self.hook("prompt", boss["id"], {"prompt": "test"})
        self.hook("stop", boss["id"], {"last_assistant_message": "Direct answer."})
        self.assertIn({"conversation": boss["id"], "summary": "Direct answer."}, [d for k, d in drain(self.events) if k == "turn_end"])
        # Wrong token: refused; unknown agent: nothing to do; unreachable server: the script stays silent.
        self.assertEqual(self.hook("prompt", boss["id"], {}, token="fake")[0], 403)
        self.assertEqual(self.hook("prompt", "aaaaaaaaaaaa", {"prompt": "x"}), (200, ""))
        silent = subprocess.run([sys.executable, str(server.HOOK_SCRIPT), "prompt", "1", boss["id"], "/absent"],
                                input="{}", capture_output=True, text=True, timeout=20)
        self.assertEqual((silent.returncode, silent.stdout), (0, ""))

    def test_deleting_an_agent_closes_its_terminal_and_hides_it(self):
        _, opened = self.call("POST", "/api/conversations", {})
        self.call("POST", f"/api/conversations/{opened['id']}/terminal-start", {"cols": 80, "rows": 24})
        self.assertTrue(wait_for(lambda: self.httpd.terminals.running(opened["id"])))
        session = "11111111-2222-4333-8444-555555555555"
        self.httpd.conversations.get(opened["id"]).adopt_session(session)
        body = {"agent": session, "keys": [session, opened["id"]], "conversation": opened["id"],
                "label": "hi", "cwd": self.httpd.conversations.default_cwd}
        status, result = self.call("POST", "/api/agents/delete", body)
        self.assertEqual(status, 200)
        self.assertIsNone(self.httpd.conversations.get(opened["id"]))
        self.assertFalse(self.httpd.terminals.running(opened["id"]))
        self.assertEqual(result["agents"][session]["hidden"]["label"], "hi")
        self.assertEqual(self.call("POST", "/api/agents/restore", {"agent": session})[0], 200)

    def test_settings_follow_the_agent_when_its_session_changes(self):
        first, second = "11111111-2222-4333-8444-555555555555", "22222222-2222-4333-8444-555555555555"
        _, opened = self.call("POST", "/api/conversations", {})
        conversation = self.httpd.conversations.get(opened["id"])
        conversation.adopt_session(first)
        self.call("POST", "/api/agents/rename", {"agent": first, "name": "Duck"})
        self.call("POST", "/api/pins", {"pins": [first]})
        conversation.adopt_session(second)  # /clear in Claude Code
        self.assertEqual(self.httpd.agents.snapshot()[second]["name"], "Duck")
        self.assertNotIn(first, self.httpd.agents.snapshot())
        self.assertEqual(self.httpd.pins.list(), [second])
        # Restart: the agent is found again, with its session.
        reloaded = server.ConversationManager(self.httpd.bus, str(self.tmp), path=self.tmp / "conversations.json")
        self.assertEqual(reloaded.get(opened["id"]).session_id, second)

    def test_pins_are_kept_by_the_server(self):
        session = "11111111-2222-4333-8444-555555555555"
        status, saved = self.call("POST", "/api/pins", {"pins": [session, "workspace:0123456789ab", "../x"]})
        self.assertEqual((status, saved["pins"]), (200, [session, "workspace:0123456789ab"]))
        _, state = self.call("GET", "/api/state")
        self.assertEqual(state["pins"], [session, "workspace:0123456789ab"])
        self.assertEqual(self.call("POST", "/api/pins", {"pins": "x"})[0], 400)
        # A pinned agent is returned in the list even if old, without the interface asking for it.
        with mock.patch.object(server, "list_sessions", return_value=[]) as listing:
            self.call("GET", "/api/sessions")
        self.assertIn(session, listing.call_args.kwargs["include"])

    def test_new_agent_in_a_chosen_folder(self):
        folder = Path(self.httpd.conversations.default_cwd) / "project"
        folder.mkdir()
        status, created = self.call("POST", "/api/conversations", {"cwd": str(folder)})
        self.assertEqual((status, created["cwd"]), (200, str(folder.resolve())))
        self.assertEqual(self.httpd.pins.list(), [created["id"]])  # a new agent is pinned by default
        self.assertEqual(self.call("POST", "/api/conversations", {"cwd": "relative"})[0], 400)
        self.assertEqual(self.call("POST", "/api/conversations", {"cwd": str(folder / "absent")})[0], 400)
        status, listing = self.call("GET", f"/api/folders?path={folder.parent}")
        self.assertEqual((status, "project" in listing["dirs"]), (200, True))
        self.assertEqual(self.call("GET", "/api/folders?path=relative")[0], 400)
        status, recent = self.call("GET", "/api/folders/recent")
        self.assertEqual(status, 200)
        self.assertIn(str(folder.resolve()), [f["path"] for f in recent["folders"]])
        self.assertLessEqual(len(recent["folders"]), 5)
        status, one = self.call("GET", "/api/folders/recent?limit=1")
        self.assertEqual((status, len(one["folders"])), (200, 1))
        self.assertEqual(self.call("GET", "/api/folders/recent?limit=abc")[0], 200)  # default value
        self.assertEqual(self.call("GET", "/api/folders", headers={"Cookie": ""})[0], 401)

    def test_create_folder_for_a_new_agent(self):
        parent = Path(self.httpd.conversations.default_cwd)
        status, listing = self.call("POST", "/api/folders/create", {"parent": str(parent), "name": " new "})
        self.assertEqual((status, listing["path"], listing["dirs"]), (200, str((parent / "new").resolve()), []))
        status, error = self.call("POST", "/api/folders/create", {"parent": str(parent), "name": "new"})
        self.assertEqual((status, error["error"]), (400, "This folder already exists"))
        self.assertEqual(self.call("POST", "/api/folders/create", {"parent": "relative", "name": "x"})[0], 400)

    def test_files_routes(self):
        folder = Path(self.httpd.conversations.default_cwd).resolve() / "files"
        (folder / "src").mkdir(parents=True)
        (folder / "src" / "app.py").write_text("print('needle')\n")
        (folder / "logo.svg").write_text("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>")
        path = urllib.parse.quote(str(folder))
        status, listing = self.call("GET", f"/api/files/list?path={path}&dir=")
        self.assertEqual((status, [e["name"] for e in listing["entries"]]), (200, ["src", "logo.svg"]))
        status, read = self.call("GET", f"/api/files/read?path={path}&file=src/app.py")
        self.assertEqual((status, read["kind"], read["content"]), (200, "text", "print('needle')\n"))
        self.assertEqual(self.call("GET", f"/api/files/read?path={path}&file=../{folder.parent.name}")[0], 400)
        self.assertEqual(self.call("GET", "/api/files/read?path=relative&file=x")[0], 400)
        status, found = self.call("GET", f"/api/files/search?path={path}&q=needle&mode=content")
        self.assertEqual((status, found["results"][0]["file"]), (200, "src/app.py"))
        self.assertEqual(self.call("GET", f"/api/files/search?path={path}&q=&mode=name")[0], 400)
        self.assertEqual(self.call("GET", f"/api/files/list?path={path}", headers={"Cookie": ""})[0], 401)
        # Raw image: served with a CSP that forbids the SVG's scripts.
        connection = http.client.HTTPConnection(*self.host.split(":"), timeout=5)
        connection.request("GET", f"/api/files/raw?path={path}&file=logo.svg", headers=self.headers)
        response = connection.getresponse()
        self.assertEqual((response.status, response.getheader("Content-Type")), (200, "image/svg+xml"))
        self.assertEqual(response.getheader("Content-Security-Policy"), "default-src 'none'; style-src 'unsafe-inline'; sandbox")
        self.assertEqual(response.getheader("X-Content-Type-Options"), "nosniff")
        self.assertIn(b"<svg", response.read())
        connection.close()
        self.assertEqual(self.call("GET", f"/api/files/raw?path={path}&file=src/app.py")[0], 400)

    def test_files_write_route(self):
        folder = Path(self.httpd.conversations.default_cwd).resolve()
        (folder / "notes.txt").write_text("before\n")
        status, read = self.call("GET", f"/api/files/read?path={urllib.parse.quote(str(folder))}&file=notes.txt")
        body = {"path": str(folder), "file": "notes.txt", "content": "after\n" + "x" * 1_200_000, "version": read["version"]}
        self.assertEqual(self.call("POST", "/api/files/write", body)[0], 400)  # > 512 KB, but body accepted
        body["content"] = "after\n"
        status, written = self.call("POST", "/api/files/write", body)
        self.assertEqual((status, written["file"], written["size"]), (200, "notes.txt", len(b"after\n")))
        self.assertEqual((folder / "notes.txt").read_text(), "after\n")
        status, conflict = self.call("POST", "/api/files/write", body)  # old version
        self.assertEqual((status, conflict["version"]), (409, written["version"]))
        self.assertIn("changed on disk", conflict["error"])
        status, _ = self.call("POST", "/api/files/write", {**body, "file": "../x.txt", "version": written["version"]})
        self.assertEqual(status, 400)

    def test_git_routes(self):
        repo = Path(self.httpd.conversations.default_cwd) / "repo"
        repo.mkdir()
        for args in (["init", "-q", "-b", "main"], ["config", "user.name", "Test"], ["config", "user.email", "t@example.com"]):
            subprocess.run(["git", *args], cwd=repo, check=True)
        (repo / "a.txt").write_text("one\n")
        quoted = urllib.parse.quote(str(repo))
        status, state = self.call("GET", f"/api/git/state?path={quoted}")
        self.assertEqual((status, [f["path"] for f in state["files"]["untracked"]]), (200, ["a.txt"]))
        self.assertEqual(self.call("POST", "/api/git/stage", {"path": str(repo), "files": ["a.txt"]})[0], 200)
        status, result = self.call("POST", "/api/git/commit", {"path": str(repo), "message": "First"})
        self.assertEqual((status, result["state"]["files"]["staged"]), (200, []))
        status, log = self.call("GET", f"/api/git/log?path={quoted}")
        self.assertEqual([c["subject"] for c in log["commits"]], ["First"])
        self.assertEqual(self.call("POST", "/api/git/stage", {"path": str(repo), "files": ["../x"]})[0], 400)
        self.assertEqual(self.call("GET", f"/api/git/state?path={urllib.parse.quote(str(repo.parent))}")[0], 400)
        self.assertEqual(self.call("POST", "/api/git/stage", {"path": str(repo)}, headers={"Origin": "http://evil.example"})[0], 403)

class HttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.httpd = server.ZiggyServer(port=0, conversation_cwd=tempfile.gettempdir(), account={},
                                         data_dir=cls.tmp.name)
        cls.port = cls.httpd.server_address[1]
        cls.host = f"127.0.0.1:{cls.port}"
        cls.origin = f"http://{cls.host}"
        cls.cookie = f"{cls.httpd.cookie_name}={cls.httpd.sessions.create()}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.tmp.cleanup()

    def request(self, method, path, headers=None, body=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        connection.request(method, path, body=body, headers={"Host": self.host, **(headers or {})})
        response = connection.getresponse()
        response.read()
        connection.close()
        return response

    def test_rejects_unknown_host(self):
        self.assertEqual(self.request("GET", "/", {"Host": "evil.example"}).status, 403)

    def test_token_in_url_no_longer_signs_in(self):
        for path in (f"/?token={self.httpd.token}", "/?token=fake", "/?other=1"):
            response = self.request("GET", path)
            self.assertEqual(response.status, 303)
            self.assertEqual(response.getheader("Location"), "/")
            self.assertIsNone(response.getheader("Set-Cookie"), path)

    def test_login_link_sets_strict_cookie(self):
        response = self.request("GET", f"/?login={self.httpd.logins.make()}")
        self.assertEqual(response.status, 303)
        cookie = response.getheader("Set-Cookie")
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=Strict", cookie)
        self.assertNotIn(self.httpd.token, cookie, "the browser gets a session, never the token")

    def json_request(self, method, path, cookie, body=None):
        headers = {"Host": self.host, "Cookie": cookie}
        if method == "POST":
            headers |= {"Origin": self.origin, "Content-Type": "application/json"}
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        connection.request(method, path, body=json.dumps(body or {}).encode() if method == "POST" else None, headers=headers)
        response = connection.getresponse()
        data = json.loads(response.read() or b"null")
        connection.close()
        return response, data

    def sign_in(self):
        """Signs in like a browser (single-use link): the cookie it receives."""
        response = self.request("GET", f"/?login={self.httpd.logins.make()}", {"User-Agent": "Test browser"})
        return response.getheader("Set-Cookie").split(";")[0]

    def test_token_is_not_a_cookie(self):
        self.assertEqual(self.request("GET", "/api/server", {"Cookie": f"{self.httpd.cookie_name}={self.httpd.token}"}).status, 401)

    def test_signed_in_browsers_can_be_signed_out(self):
        mine, other = self.sign_in(), self.sign_in()
        response, data = self.json_request("GET", "/api/browsers", mine)
        self.assertEqual(response.status, 200)
        current = [b for b in data["browsers"] if b["current"]]
        self.assertEqual(len(current), 1)
        self.assertEqual(current[0]["agent"], "Test browser")
        # Another browser, signed out from this one.
        _, data = self.json_request("GET", "/api/browsers", other)
        other_id = next(b["id"] for b in data["browsers"] if b["current"])
        response, _ = self.json_request("POST", "/api/browsers/sign-out", mine, {"id": other_id})
        self.assertEqual(response.status, 200)
        self.assertEqual(self.json_request("GET", "/api/server", other)[0].status, 401)
        self.assertEqual(self.json_request("GET", "/api/server", mine)[0].status, 200)
        # This browser: its cookie is cleared.
        response, data = self.json_request("POST", "/api/browsers/sign-out", mine, {"id": current[0]["id"]})
        self.assertEqual(data, {"signedOut": "current"})
        self.assertIn("Max-Age=0", response.getheader("Set-Cookie"))
        self.assertEqual(self.json_request("GET", "/api/server", mine)[0].status, 401)

    def test_sign_out_other_browsers(self):
        mine, others = self.sign_in(), [self.sign_in(), self.sign_in()]
        # The other tests' cookie goes too: it is given back afterwards.
        self.addCleanup(lambda: setattr(HttpTest, "cookie", f"{self.httpd.cookie_name}={self.httpd.sessions.create()}"))
        response, data = self.json_request("POST", "/api/browsers/sign-out-others", mine)
        self.assertEqual(response.status, 200)
        self.assertEqual([b["current"] for b in data["browsers"]], [True])
        for cookie in others:
            self.assertEqual(self.json_request("GET", "/api/server", cookie)[0].status, 401)
        self.assertEqual(self.json_request("GET", "/api/server", mine)[0].status, 200)

    def test_login_link_works_once(self):
        link = self.httpd.logins.make()
        self.assertEqual(self.request("GET", f"/?login={link}").status, 303)
        self.assertEqual(self.request("GET", f"/?login={link}").status, 403, "a link works only once")
        self.assertEqual(self.request("GET", "/?login=fake").status, 403)

    def test_login_link_for_another_browser(self):
        headers = {"Origin": f"http://{self.host}", "Content-Type": "application/json"}
        self.assertEqual(self.request("POST", "/api/login-link", headers, b"{}").status, 401, "only from a signed-in browser")
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        connection.request("POST", "/api/login-link", body=b"{}", headers={"Host": self.host, "Cookie": self.cookie, **headers})
        response = connection.getresponse()
        data = json.loads(response.read())
        connection.close()
        self.assertEqual(response.status, 200)
        self.assertTrue(data["path"].startswith("/?login="))
        self.assertEqual(self.request("GET", data["path"]).status, 303, "the other browser signs in")
        self.assertEqual(self.request("GET", data["path"]).status, 403, "once")

    def test_api_requires_cookie(self):
        self.assertEqual(self.request("GET", "/api/state").status, 401)
        self.assertEqual(self.request("GET", "/api/sessions", {"Cookie": self.cookie}).status, 200)

    def test_post_requires_local_origin(self):
        headers = {"Cookie": self.cookie, "Content-Length": "2"}
        self.assertEqual(self.request("POST", "/api/conversations", headers, b"{}").status, 403)
        headers["Origin"] = "http://evil.example"
        self.assertEqual(self.request("POST", "/api/conversations", headers, b"{}").status, 403)
        headers["Origin"] = self.origin
        self.assertEqual(self.request("POST", "/api/conversations", headers, b"{}").status, 200)

    def test_negative_content_length_is_rejected_without_hanging(self):
        with socket.create_connection(("127.0.0.1", self.port), timeout=3) as sock:
            sock.sendall((
                f"POST /api/conversations HTTP/1.1\r\nHost: {self.host}\r\nOrigin: {self.origin}\r\n"
                f"Cookie: {self.cookie}\r\nContent-Length: -1\r\n\r\n"
            ).encode())
            response = b""
            while chunk := sock.recv(4096):
                response += chunk
                if b"\r\n\r\n" in response and response.rstrip().endswith(b"}"):
                    break
            self.assertTrue(response.startswith(b"HTTP/1.0 400 "), response[:40])

    def test_rejects_invalid_resume_id(self):
        headers = {"Cookie": self.cookie, "Origin": self.origin, "Content-Type": "application/json"}
        body = json.dumps({"resume": "../../etc"}).encode()
        self.assertEqual(self.request("POST", "/api/conversations", headers, body).status, 400)

    def test_resume_unknown_session_is_rejected(self):
        headers = {"Cookie": self.cookie, "Origin": self.origin, "Content-Type": "application/json"}
        body = json.dumps({"resume": "99999999-2222-4333-8444-555555555555"}).encode()
        self.assertEqual(self.request("POST", "/api/conversations", headers, body).status, 400)

    def test_transcript_route_validates_and_skips_unchanged_sessions(self):
        headers = {"Cookie": self.cookie}
        self.assertEqual(self.request("GET", "/api/transcript?session=../../etc/passwd", headers).status, 400)
        unknown = "/api/transcript?session=99999999-2222-4333-8444-555555555555"
        self.assertEqual(self.request("GET", unknown, headers).status, 404)
        self.assertEqual(self.request("GET", unknown).status, 401)
        transcript = Path(self.tmp.name) / "99999999-2222-4333-8444-555555555555.jsonl"
        transcript.write_text(json.dumps({"type": "user", "uuid": "u1", "message": {"role": "user", "content": "hi"}}) + "\n")

        def get(path):
            connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
            connection.request("GET", path, headers={"Host": self.host, **headers})
            data = json.loads(connection.getresponse().read())
            connection.close()
            return data

        with mock.patch.object(server.transcripts, "find_transcript", return_value=transcript):
            first = get(unknown)
            self.assertEqual([m["content"][0]["text"] for m in first["messages"]], ["hi"])
            self.assertEqual(get(f"{unknown}&since={first['signature']}"), {"unchanged": True, "signature": first["signature"]})

    def test_hooks_require_their_own_token(self):
        body = json.dumps({"prompt": "x"}).encode()
        self.assertEqual(self.request("POST", "/hooks/prompt", {}, body).status, 403)
        # The browser cookie is not enough: /hooks is reserved for the Claude Code terminals.
        self.assertEqual(self.request("POST", "/hooks/prompt", {"Cookie": self.cookie, "Origin": self.origin}, body).status, 403)
        auth = {"Authorization": f"Bearer {self.httpd.hook_token}"}
        self.assertEqual(self.request("POST", "/hooks/prompt", {**auth, "Host": "evil.example"}, body).status, 403)
        self.assertEqual(self.request("POST", "/hooks/prompt", auth, body).status, 200)
        self.assertEqual(self.request("POST", "/hooks/unknown", auth, body).status, 403)
        self.assertEqual(self.httpd.hook_token_file.read_text(), self.httpd.hook_token)
        self.assertEqual(self.httpd.hook_token_file.stat().st_mode & 0o777, 0o600)

    def test_workspace_routes(self):
        headers = {"Cookie": self.cookie, "Origin": self.origin, "Content-Type": "application/json"}

        def post(path, body):
            response = self.request("POST", path, headers, json.dumps(body).encode())
            return response.status

        self.assertEqual(post("/api/workspaces", {"name": "  "}), 400)
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        connection.request("POST", "/api/workspaces", body=json.dumps({"name": "Connectors"}).encode(),
                           headers={"Host": self.host, **headers})
        workspace = json.loads(connection.getresponse().read())
        connection.close()
        base = f"/api/workspaces/{workspace['id']}"
        self.assertIn(f"workspace:{workspace['id']}", self.httpd.pins.list())  # pinned by default
        agent = "11111111-2222-4333-8444-555555555555"
        self.assertEqual(post(f"{base}/add", {"agent": agent}), 200)
        self.assertEqual(post(f"{base}/add", {"agent": "../../etc"}), 400)
        self.assertEqual(post("/api/workspaces/000000000000/add", {"agent": agent}), 404)
        self.assertEqual(self.httpd.workspaces.list()[0]["agents"], [agent])
        other = "22222222-2222-4333-8444-555555555555"
        self.assertEqual(post(f"{base}/place", {"agent": other, "before": agent}), 200)
        self.assertEqual(self.httpd.workspaces.list()[0]["agents"], [other, agent])
        self.assertEqual(post(f"{base}/place", {"agent": other, "before": "../x"}), 400)
        self.assertEqual(post(f"{base}/remove", {"agent": other}), 200)
        self.assertEqual(post(f"{base}/move", {"before": None}), 200)
        self.assertEqual(post(f"{base}/move", {"before": "nope"}), 400)
        self.assertEqual(post(f"{base}/remove", {"agent": agent}), 200)
        self.assertEqual(post(f"{base}/update", {"name": "Batch", "hue": 200}), 200)
        self.assertEqual(post(f"{base}/update", {"hue": 999}), 400)
        self.assertEqual({k: self.httpd.workspaces.list()[0][k] for k in ("name", "hue")}, {"name": "Batch", "hue": 200})
        self.assertEqual(self.request("POST", f"{base}/delete", {"Cookie": self.cookie}, b"{}").status, 403)  # without Origin
        self.assertEqual(post(f"{base}/delete", {}), 200)
        self.assertEqual(self.httpd.workspaces.list(), [])

    def test_agent_routes(self):
        headers = {"Cookie": self.cookie, "Origin": self.origin, "Content-Type": "application/json"}

        def post(path, body):
            return self.request("POST", path, headers, json.dumps(body).encode()).status

        agent = "33333333-2222-4333-8444-555555555555"
        self.assertEqual(post("/api/agents/rename", {"agent": "../x", "name": "a"}), 400)
        self.assertEqual(post("/api/agents/rename", {"agent": agent, "name": "My agent"}), 200)
        workspace = self.httpd.workspaces.create("Group")
        self.httpd.workspaces.add_agent(workspace["id"], agent)
        body = {"agent": agent, "keys": [agent, "not-a-key"], "label": "Review", "cwd": "/tmp"}
        self.assertEqual(post("/api/agents/delete", body), 200)
        self.assertEqual(self.httpd.workspaces.list()[-1]["agents"], [])  # removed from its workspace
        self.assertIn("hidden", self.httpd.agents.snapshot()[agent])
        self.assertEqual(post("/api/agents/restore", {"agent": agent}), 200)
        self.assertEqual(post("/api/agents/restore", {"agent": agent}), 404)
        # Without history, the restored agent gets a conversation back in its folder, with its name.
        reopened = next(c for c in self.httpd.conversations.list() if c["label"] == "Review")
        self.assertEqual(reopened["cwd"], "/tmp")
        self.assertEqual(self.httpd.agents.snapshot()[reopened["id"]], {"name": "My agent"})
        self.httpd.conversations.remove(reopened["id"])
        self.httpd.workspaces.delete(workspace["id"])

    def test_token_survives_restarts(self):
        with tempfile.TemporaryDirectory() as data:
            first = server.ZiggyServer(port=0, conversation_cwd=data, account={}, data_dir=data)
            first.server_close()
            again = server.ZiggyServer(port=0, conversation_cwd=data, account={}, data_dir=data)
            again.server_close()
            self.assertEqual(first.token, again.token)
            self.assertEqual((Path(data) / "token").stat().st_mode & 0o777, 0o600)
            renewed = server.ZiggyServer(port=0, conversation_cwd=data, account={},
                                           data_dir=data, renew_token=True)
            renewed.server_close()
            self.assertNotEqual(renewed.token, first.token)
            (Path(data) / "token").write_text("short")  # damaged file: a new token is created
            fixed = server.ZiggyServer(port=0, conversation_cwd=data, account={}, data_dir=data)
            fixed.server_close()
            self.assertGreaterEqual(len(fixed.token), 32)

    def test_static_files_and_traversal(self):
        index = self.request("GET", "/")
        self.assertEqual(index.status, 200)
        self.assertIn("default-src 'self'", index.getheader("Content-Security-Policy"))
        self.assertEqual(self.request("GET", "/../server.py").status, 404)
        self.assertEqual(self.request("GET", "/%2e%2e/server.py").status, 404)



class ShowLoginTest(unittest.TestCase):
    """`ziggy` opens the browser on a single-use link; `ziggy --link` prints it (for another browser)."""

    def show(self, open_browser):
        out = io.StringIO()
        with mock.patch("server.webbrowser.open", return_value=True) as opened, contextlib.redirect_stdout(out):
            server.show_login(6767, "x" * 32, open_browser)
        return opened, out.getvalue()

    def test_opened_in_the_browser(self):
        opened, out = self.show(True)
        self.assertTrue(opened.call_args.args[0].startswith("http://127.0.0.1:6767/?login="))
        self.assertNotIn("?login=", out, "the link is not printed")
        self.assertIn("not opening in your browser", out)
        self.assertIn("`ziggy --link`", out)

    def test_printed_for_another_browser(self):
        opened, out = self.show(False)
        opened.assert_not_called()
        self.assertIn("http://127.0.0.1:6767/?login=", out)

    def test_command_keeps_the_port(self):
        out = io.StringIO()
        with mock.patch("server.webbrowser.open", return_value=True), contextlib.redirect_stdout(out):
            server.show_login(6799, "x" * 32, True)
        self.assertIn("`ziggy --port 6799 --link`", out.getvalue())


if __name__ == "__main__":
    unittest.main()

"""Tests de ziggy-one (stdlib uniquement) : python3 -m unittest discover -s tests"""

import http.client
import base64
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
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import server  # noqa: E402
from fakes import drain, install_fake_interactive_claude, wait_for  # noqa: E402

class ParsingTest(unittest.TestCase):
    def test_parse_json_line(self):
        self.assertEqual(server.parse_json_line('{"a": 1}'), {"a": 1})
        self.assertIsNone(server.parse_json_line("pas du json"))
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
            sessions = server.list_sessions(our_pids={12})  # « b » tourne dans ziggy-one
        self.assertEqual([s["sessionId"] for s in sessions], ["a", "b", "c"])
        self.assertTrue(all(s["git"] is False for s in sessions))  # /a, /b, /c : pas de dépôt
        a, b, c = sessions
        self.assertEqual((a["active"], a["lastPrompt"], a["status"], a["updatedAt"]), (True, "A", "busy", 500))
        self.assertEqual((b["active"], b["costUsd"]), (False, 1.0))
        self.assertEqual((c["active"], c["cwd"], c["lastPrompt"]), (True, "/c", None))


class ListSessionsIncludeTest(unittest.TestCase):
    def test_pinned_sessions_are_returned_even_if_old(self):
        old = {"sessionId": "old", "cwd": "/o", "updatedAt": 1, "lastPrompt": "Ancien", "costUsd": None}
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
    """Parcours complet par HTTP avec le faux claude interactif : ouvrir, Terminal, hooks, supprimer."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        install_fake_interactive_claude(self, tmp.name)
        self.tmp = Path(tmp.name)
        self.httpd = server.ZiggyServer(port=0, conversation_cwd=tmp.name, account={},
                                          defaults={"model": "sonnet", "permissionMode": "auto"},
                                          data_dir=tmp.name)
        # Sessions factices : elles n'ont pas d'historique sur disque, on les considère comme écrites.
        self.httpd.conversations.has_history = lambda session_id: True
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(self.httpd.shutdown)
        self.events = self.httpd.bus.subscribe()
        port = self.httpd.server_address[1]
        self.host = f"127.0.0.1:{port}"
        self.headers = {
            "Host": self.host, "Origin": f"http://{self.host}",
            "Cookie": f"{self.httpd.cookie_name}={self.httpd.token}", "Content-Type": "application/json",
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
        """Réponse brute (statut, corps, en-têtes), pour ce qui n'est pas du JSON."""
        connection = http.client.HTTPConnection(*self.host.split(":"), timeout=5)
        connection.request(method, path, headers=self.headers)
        response = connection.getresponse()
        body = response.read()
        connection.close()
        return response.status, body, dict(response.getheaders())

    def screen(self, conversation_id):
        return base64.b64decode(self.httpd.terminals.snapshot(conversation_id)["data"]).decode()

    def launch_args(self, conversation_id):
        """Arguments reçus par le faux claude du terminal de l'agent."""
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
        self.assertEqual(self.hook("session", me["id"], {"source": "startup"}), (200, ""), "aucun rôle : rien")
        self.call("POST", "/api/agents/rename", {"agent": teams["id"], "name": "Teams"})
        status, data = self.call("POST", "/api/agents/role", {"agent": teams["id"], "role": "Envoie les messages Teams."})
        self.assertEqual((status, data["agents"][teams["id"]]["role"]), (200, "Envoie les messages Teams."))
        status, text = self.hook("session", me["id"], {"source": "startup"})
        self.assertEqual(status, 200)
        self.assertIn("« Teams » (fermé pour l’instant) : Envoie les messages Teams.", text)
        self.assertEqual(self.hook("session", me["id"], {}, token="mauvais")[0], 403)
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
        self.assertNotIn(key.split()[-1], " ".join(args), "la clé passe par le fichier, pas par la ligne de commande")

        def mcp(message, headers):
            # Comme Claude Code : ni cookie, ni origine.
            return self.call("POST", "/mcp", message, {"Cookie": "", "Origin": "", **headers})

        create = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                  "params": {"name": "kanban_create_ticket", "arguments": {"title": "Prévenir l'équipe"}}}
        status, response = mcp(create, {"Authorization": key})
        self.assertEqual(status, 200)
        self.assertIn("créé", response["result"]["content"][0]["text"])
        number = self.httpd.kanban.index()[-1]["number"]
        history = self.httpd.kanban.ticket_history(self.httpd.kanban.find_number(number)["ticket"])
        self.assertEqual(history[0]["by"], "Teams/Outlook")
        self.assertEqual(mcp(create, {})[0], 401)  # sans clé
        self.assertEqual(mcp(create, {"Authorization": "Bearer abcdef123456.faux"})[0], 401)
        self.assertEqual(mcp(create, {"Authorization": key, "Origin": "http://evil.example"})[0], 403)  # page web
        self.assertEqual(mcp({"jsonrpc": "2.0", "method": "notifications/initialized"}, {"Authorization": key})[0], 202)
        self.assertEqual(self.call("GET", "/mcp")[0], 405)
        self.call("POST", f"/api/conversations/{opened['id']}/terminal-stop", {})
        self.assertTrue(wait_for(lambda: not config_path.exists()), "configuration MCP supprimée à la fermeture")

    def test_open_terminals_with_their_memory(self):
        _, opened = self.call("POST", "/api/conversations", {})
        self.assertEqual(self.call("GET", "/api/terminals"), (200, {"terminals": []}))
        self.call("POST", f"/api/conversations/{opened['id']}/terminal-start", {"cols": 100, "rows": 30})
        self.launch_args(opened["id"])  # Claude Code (faux) a démarré
        status, data = self.call("GET", "/api/terminals")
        self.assertEqual(status, 200)
        [terminal] = data["terminals"]
        self.assertEqual(terminal["conversation"], opened["id"])
        self.assertGreater(terminal["memory"], 1024 * 1024)  # quelques Mo au moins
        self.assertLessEqual(terminal["startedAt"], time.time())
        self.call("POST", f"/api/conversations/{opened['id']}/terminal-stop", {})
        self.assertTrue(wait_for(lambda: self.call("GET", "/api/terminals")[1]["terminals"] == []))

    def test_shell_command_runs_in_the_agent_folder_without_claude(self):
        _, opened = self.call("POST", "/api/conversations", {})
        status, started = self.call("POST", f"/api/conversations/{opened['id']}/shell", {"command": "echo bonjour"})
        self.assertEqual(status, 200)
        events = []
        self.assertTrue(wait_for(lambda: events.extend(drain(self.events)) or any(
            k == "shell" and d.get("ended") for k, d in events)))
        shell = [d for k, d in events if k == "shell" and d["run"] == started["run"]]
        self.assertEqual("".join(d.get("output", "") for d in shell), "bonjour\n")
        self.assertEqual(shell[0]["cwd"], self.httpd.conversations.default_cwd)
        self.assertFalse(self.httpd.terminals.running(opened["id"]), "Claude Code n'est pas lancé")
        self.assertEqual(self.call("POST", f"/api/conversations/{opened['id']}/shell", {"command": " "})[0], 400)
        stop = self.call("POST", f"/api/conversations/{opened['id']}/shell-stop", {"run": started["run"]})
        self.assertEqual(stop[0], 404)  # déjà terminée

    def test_agent_waiting_for_an_answer(self):
        _, opened = self.call("POST", "/api/conversations", {})
        conversation = self.httpd.conversations.get(opened["id"])
        self.hook("prompt", opened["id"], {"prompt": "déploie"})
        self.assertEqual(self.hook("notify", opened["id"], {"notification_type": "permission_prompt"}), (200, ""))
        self.assertEqual(conversation.status()["waiting"], "permission")
        self.hook("tool", opened["id"], {"tool_name": "Bash"})  # autorisé : la commande s'est exécutée
        self.assertIsNone(conversation.status()["waiting"])
        self.hook("notify", opened["id"], {"notification_type": "elicitation_dialog"})
        self.assertEqual(conversation.status()["waiting"], "question")
        self.hook("notify", opened["id"], {"notification_type": "idle_prompt"})  # ignoré
        self.assertEqual(conversation.status()["waiting"], "question")
        self.hook("stop", opened["id"], {})
        self.assertIsNone(conversation.status()["waiting"])

    def test_session_named_after_the_agent_and_rename_closes_the_terminal(self):
        _, opened = self.call("POST", "/api/conversations", {})
        self.call("POST", "/api/agents/rename", {"agent": opened["id"], "name": "Teams/Outlook"})
        self.call("POST", f"/api/conversations/{opened['id']}/terminal-start", {"cols": 100, "rows": 30})
        first = self.launch_args(opened["id"])
        self.assertEqual(first[first.index("--name") + 1], "Teams/Outlook")  # nom vu par les autres agents
        self.assertLess(first.index("--name"), first.index("--model"))  # avant --allowedTools, variadique
        # Même nom : le terminal reste ouvert.
        status, result = self.call("POST", "/api/agents/rename", {"agent": opened["id"], "name": " Teams/Outlook "})
        self.assertEqual((status, result["terminalClosed"]), (200, False))
        self.assertTrue(self.httpd.terminals.running(opened["id"]))
        # Nouveau nom : le terminal est fermé, il sera rouvert sous ce nom.
        status, result = self.call("POST", "/api/agents/rename", {"agent": opened["id"], "name": "Messagerie"})
        self.assertEqual((status, result["terminalClosed"]), (200, True))
        self.assertTrue(wait_for(lambda: not self.httpd.terminals.running(opened["id"])))

    def test_terminal_runs_claude_with_our_hooks_and_agent_options(self):
        _, opened = self.call("POST", "/api/conversations", {})
        self.assertEqual(self.call("POST", f"/api/conversations/{opened['id']}/terminal-start", {"cols": 100, "rows": 30})[0], 200)
        first = self.launch_args(opened["id"])
        self.assertEqual(first[first.index("--model") + 1], "sonnet")  # défaut du serveur
        self.assertEqual(first[first.index("--permission-mode") + 1], "auto")
        settings = Path(first[first.index("--settings") + 1])
        self.assertEqual(settings.stat().st_mode & 0o777, 0o600)
        hooks = json.loads(settings.read_text())["hooks"]
        self.assertEqual(set(hooks), {"SessionStart", "UserPromptSubmit", "Stop", "Notification", "PostToolUse"})
        command = hooks["UserPromptSubmit"][0]["hooks"][0]["command"]
        self.assertIn(f"ziggy_hook.py prompt {self.httpd.port} {opened['id']}", command)
        self.assertNotIn(self.httpd.hook_token, command, "le token passe par un fichier, pas par la ligne de commande")
        # Réglages de l'agent : pris en compte à la prochaine ouverture, sur la même session.
        session = "11111111-2222-4333-8444-555555555555"
        self.httpd.conversations.get(opened["id"]).adopt_session(session)
        options = {"model": "haiku", "permissionMode": "plan", "chrome": False}
        self.assertEqual(self.call("POST", "/api/agents/options", {"agent": session, "options": options})[0], 200)
        self.call("POST", f"/api/conversations/{opened['id']}/terminal-stop", {})
        self.assertTrue(wait_for(lambda: not self.httpd.terminals.running(opened["id"])))
        self.assertFalse(settings.exists(), "réglages du terminal supprimés à sa fermeture")
        with mock.patch.object(server.transcripts, "find_transcript", return_value=Path("/historique.jsonl")):
            self.call("POST", f"/api/conversations/{opened['id']}/terminal-start", {"cols": 100, "rows": 30})
        second = self.launch_args(opened["id"])
        self.assertEqual(second[second.index("--model") + 1], "haiku")
        self.assertEqual(second[second.index("--permission-mode") + 1], "plan")
        self.assertEqual(second[second.index("--resume") + 1], session)
        bad = {"agent": session, "options": {"permissionMode": "bypassPermissions"}}
        self.assertEqual(self.call("POST", "/api/agents/options", bad)[0], 400)
        # Avatar : image envoyée en base64, servie ensuite depuis son identifiant, gardée en cache.
        png = b"\x89PNG\r\n\x1a\n" + b"0" * 50
        body = {"agent": session, "avatar": {"kind": "image", "abbr": "LA"}, "image": base64.b64encode(png).decode()}
        status, data = self.call("POST", "/api/agents/avatar", body)
        self.assertEqual(status, 200)
        image_id = data["agents"][session]["avatar"]["image"]
        status, served, headers = self.raw("GET", f"/api/agents/avatars/{image_id}")
        self.assertEqual((status, served, headers["Content-Type"]), (200, png, "image/png"))
        self.assertIn("immutable", headers["Cache-Control"])
        self.assertEqual(self.raw("GET", "/api/agents/avatars/0123456789abcdef")[0], 404)
        self.assertEqual(self.call("POST", "/api/agents/avatar", {**body, "image": "pas du base64 !"})[0], 400)
        self.assertEqual(self.call("POST", "/api/agents/avatar", {"agent": session, "avatar": {"kind": "fusée"}})[0], 400)

    def test_hooks_track_turns_and_share_activity(self):
        repo = self.tmp / "depot"
        repo.mkdir()
        subprocess.run(["git", "init", "-q", "-b", "main"], cwd=repo, check=True)
        _, slave = self.call("POST", "/api/conversations", {"cwd": str(repo)})
        _, boss = self.call("POST", "/api/conversations", {"cwd": str(repo)})
        _, workspace = self.call("POST", "/api/workspaces", {"name": "Ziggy"})
        for agent in (slave, boss):
            self.call("POST", f"/api/workspaces/{workspace['id']}/add", {"agent": agent["id"]})
        self.call("GET", "/api/state")
        drain(self.events)
        # Le boss parle une première fois (rien à partager), puis le slave travaille.
        self.assertEqual(self.hook("prompt", boss["id"], {"session_id": "22222222-2222-4333-8444-555555555555", "prompt": "salut"}), (200, ""))
        status, text = self.hook("prompt", slave["id"], {"session_id": "11111111-2222-4333-8444-555555555555", "prompt": "fusionne la branche"})
        self.assertEqual((status, text), (200, ""))
        conversation = self.httpd.conversations.get(slave["id"])
        self.assertTrue(conversation.status()["busy"])
        self.assertEqual(conversation.session_id, "11111111-2222-4333-8444-555555555555")
        projects = self.tmp / "projects"
        transcript = projects / "x" / "s.jsonl"
        transcript.parent.mkdir(parents=True)
        transcript.write_text(json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": "Branche fusionnée."}]}}) + "\n")
        with mock.patch.object(server.transcripts, "PROJECTS_DIR", projects):
            self.assertEqual(self.hook("stop", slave["id"], {"session_id": conversation.session_id, "transcript_path": str(transcript)})[0], 200)
        self.assertFalse(conversation.status()["busy"])
        ends = [d for k, d in drain(self.events) if k == "turn_end"]
        self.assertEqual(ends, [{"conversation": slave["id"], "summary": "Branche fusionnée."}])
        # Au message suivant du boss, le hook lui donne ce qu'a fait le slave, par le vrai script.
        self.assertTrue(wait_for(lambda: self.httpd.activity._events))
        payload = json.dumps({"session_id": "22222222-2222-4333-8444-555555555555", "prompt": "et maintenant ?"})
        result = subprocess.run(
            [sys.executable, str(server.HOOK_SCRIPT), "prompt", str(self.httpd.port), boss["id"], str(self.httpd.hook_token_file)],
            input=payload, capture_output=True, text=True, timeout=20,
        )
        self.assertEqual(result.returncode, 0)
        self.assertIn("<ziggy-shared-context>", result.stdout)
        self.assertIn("« fusionne la branche » → Branche fusionnée.", result.stdout)
        # Claude Code récent : la dernière réponse arrive avec le hook.
        self.hook("prompt", boss["id"], {"prompt": "test"})
        self.hook("stop", boss["id"], {"last_assistant_message": "Réponse directe."})
        self.assertIn({"conversation": boss["id"], "summary": "Réponse directe."}, [d for k, d in drain(self.events) if k == "turn_end"])
        # Mauvais token : refusé ; agent inconnu : rien à faire ; serveur injoignable : le script se tait.
        self.assertEqual(self.hook("prompt", boss["id"], {}, token="faux")[0], 403)
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
                "label": "salut", "cwd": self.httpd.conversations.default_cwd}
        status, result = self.call("POST", "/api/agents/delete", body)
        self.assertEqual(status, 200)
        self.assertIsNone(self.httpd.conversations.get(opened["id"]))
        self.assertFalse(self.httpd.terminals.running(opened["id"]))
        self.assertEqual(result["agents"][session]["hidden"]["label"], "salut")
        self.assertEqual(self.call("POST", "/api/agents/restore", {"agent": session})[0], 200)

    def test_settings_follow_the_agent_when_its_session_changes(self):
        first, second = "11111111-2222-4333-8444-555555555555", "22222222-2222-4333-8444-555555555555"
        _, opened = self.call("POST", "/api/conversations", {})
        conversation = self.httpd.conversations.get(opened["id"])
        conversation.adopt_session(first)
        self.call("POST", "/api/agents/rename", {"agent": first, "name": "Canard"})
        self.call("POST", "/api/pins", {"pins": [first]})
        conversation.adopt_session(second)  # /clear dans Claude Code
        self.assertEqual(self.httpd.agents.snapshot()[second]["name"], "Canard")
        self.assertNotIn(first, self.httpd.agents.snapshot())
        self.assertEqual(self.httpd.pins.list(), [second])
        # Redémarrage : l'agent est retrouvé, avec sa session.
        reloaded = server.ConversationManager(self.httpd.bus, str(self.tmp), path=self.tmp / "conversations.json")
        self.assertEqual(reloaded.get(opened["id"]).session_id, second)

    def test_pins_are_kept_by_the_server(self):
        session = "11111111-2222-4333-8444-555555555555"
        status, saved = self.call("POST", "/api/pins", {"pins": [session, "workspace:0123456789ab", "../x"]})
        self.assertEqual((status, saved["pins"]), (200, [session, "workspace:0123456789ab"]))
        _, state = self.call("GET", "/api/state")
        self.assertEqual(state["pins"], [session, "workspace:0123456789ab"])
        self.assertEqual(self.call("POST", "/api/pins", {"pins": "x"})[0], 400)
        # Un agent épinglé est renvoyé dans la liste même ancien, sans que l'interface le demande.
        with mock.patch.object(server, "list_sessions", return_value=[]) as listing:
            self.call("GET", "/api/sessions")
        self.assertIn(session, listing.call_args.kwargs["include"])

    def test_new_agent_in_a_chosen_folder(self):
        folder = Path(self.httpd.conversations.default_cwd) / "projet"
        folder.mkdir()
        status, created = self.call("POST", "/api/conversations", {"cwd": str(folder)})
        self.assertEqual((status, created["cwd"]), (200, str(folder.resolve())))
        self.assertEqual(self.call("POST", "/api/conversations", {"cwd": "relatif"})[0], 400)
        self.assertEqual(self.call("POST", "/api/conversations", {"cwd": str(folder / "absent")})[0], 400)
        status, listing = self.call("GET", f"/api/folders?path={folder.parent}")
        self.assertEqual((status, "projet" in listing["dirs"]), (200, True))
        self.assertEqual(self.call("GET", "/api/folders?path=relatif")[0], 400)
        status, recent = self.call("GET", "/api/folders/recent")
        self.assertEqual(status, 200)
        self.assertIn(str(folder.resolve()), [f["path"] for f in recent["folders"]])
        self.assertLessEqual(len(recent["folders"]), 5)
        status, one = self.call("GET", "/api/folders/recent?limit=1")
        self.assertEqual((status, len(one["folders"])), (200, 1))
        self.assertEqual(self.call("GET", "/api/folders/recent?limit=abc")[0], 200)  # valeur par défaut
        self.assertEqual(self.call("GET", "/api/folders", headers={"Cookie": ""})[0], 401)

    def test_create_folder_for_a_new_agent(self):
        parent = Path(self.httpd.conversations.default_cwd)
        status, listing = self.call("POST", "/api/folders/create", {"parent": str(parent), "name": " nouveau "})
        self.assertEqual((status, listing["path"], listing["dirs"]), (200, str((parent / "nouveau").resolve()), []))
        status, error = self.call("POST", "/api/folders/create", {"parent": str(parent), "name": "nouveau"})
        self.assertEqual((status, error["error"]), (400, "ce dossier existe déjà"))
        self.assertEqual(self.call("POST", "/api/folders/create", {"parent": "relatif", "name": "x"})[0], 400)

    def test_files_routes(self):
        folder = Path(self.httpd.conversations.default_cwd).resolve() / "fichiers"
        (folder / "src").mkdir(parents=True)
        (folder / "src" / "app.py").write_text("print('aiguille')\n")
        (folder / "logo.svg").write_text("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>")
        path = urllib.parse.quote(str(folder))
        status, listing = self.call("GET", f"/api/files/list?path={path}&dir=")
        self.assertEqual((status, [e["name"] for e in listing["entries"]]), (200, ["src", "logo.svg"]))
        status, read = self.call("GET", f"/api/files/read?path={path}&file=src/app.py")
        self.assertEqual((status, read["kind"], read["content"]), (200, "text", "print('aiguille')\n"))
        self.assertEqual(self.call("GET", f"/api/files/read?path={path}&file=../{folder.parent.name}")[0], 400)
        self.assertEqual(self.call("GET", f"/api/files/read?path=relatif&file=x")[0], 400)
        status, found = self.call("GET", f"/api/files/search?path={path}&q=aiguille&mode=content")
        self.assertEqual((status, found["results"][0]["file"]), (200, "src/app.py"))
        self.assertEqual(self.call("GET", f"/api/files/search?path={path}&q=&mode=name")[0], 400)
        self.assertEqual(self.call("GET", f"/api/files/list?path={path}", headers={"Cookie": ""})[0], 401)
        # Image brute : servie avec une CSP qui interdit les scripts du SVG.
        connection = http.client.HTTPConnection(*self.host.split(":"), timeout=5)
        connection.request("GET", f"/api/files/raw?path={path}&file=logo.svg", headers=self.headers)
        response = connection.getresponse()
        self.assertEqual((response.status, response.getheader("Content-Type")), (200, "image/svg+xml"))
        self.assertEqual(response.getheader("Content-Security-Policy"), "default-src 'none'; style-src 'unsafe-inline'")
        self.assertEqual(response.getheader("X-Content-Type-Options"), "nosniff")
        self.assertIn(b"<svg", response.read())
        connection.close()
        self.assertEqual(self.call("GET", f"/api/files/raw?path={path}&file=src/app.py")[0], 400)

    def test_files_write_route(self):
        folder = Path(self.httpd.conversations.default_cwd).resolve()
        (folder / "notes.txt").write_text("avant\n")
        status, read = self.call("GET", f"/api/files/read?path={urllib.parse.quote(str(folder))}&file=notes.txt")
        body = {"path": str(folder), "file": "notes.txt", "content": "après\n" + "x" * 1_200_000, "version": read["version"]}
        self.assertEqual(self.call("POST", "/api/files/write", body)[0], 400)  # > 512 Ko, mais corps accepté
        body["content"] = "après\n"
        status, written = self.call("POST", "/api/files/write", body)
        self.assertEqual((status, written["file"], written["size"]), (200, "notes.txt", len("après\n".encode())))
        self.assertEqual((folder / "notes.txt").read_text(), "après\n")
        status, conflict = self.call("POST", "/api/files/write", body)  # ancienne version
        self.assertEqual((status, conflict["version"]), (409, written["version"]))
        self.assertIn("a changé sur le disque", conflict["error"])
        status, _ = self.call("POST", "/api/files/write", {**body, "file": "../x.txt", "version": written["version"]})
        self.assertEqual(status, 400)

    def test_git_routes(self):
        repo = Path(self.httpd.conversations.default_cwd) / "depot"
        repo.mkdir()
        for args in (["init", "-q", "-b", "main"], ["config", "user.name", "Test"], ["config", "user.email", "t@example.com"]):
            subprocess.run(["git", *args], cwd=repo, check=True)
        (repo / "a.txt").write_text("un\n")
        quoted = urllib.parse.quote(str(repo))
        status, state = self.call("GET", f"/api/git/state?path={quoted}")
        self.assertEqual((status, [f["path"] for f in state["files"]["untracked"]]), (200, ["a.txt"]))
        self.assertEqual(self.call("POST", "/api/git/stage", {"path": str(repo), "files": ["a.txt"]})[0], 200)
        status, result = self.call("POST", "/api/git/commit", {"path": str(repo), "message": "Premier"})
        self.assertEqual((status, result["state"]["files"]["staged"]), (200, []))
        status, log = self.call("GET", f"/api/git/log?path={quoted}")
        self.assertEqual([c["subject"] for c in log["commits"]], ["Premier"])
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
        cls.cookie = f"{cls.httpd.cookie_name}={cls.httpd.token}"
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

    def test_token_exchange_sets_strict_cookie(self):
        self.assertEqual(self.request("GET", "/?token=faux").status, 403)
        response = self.request("GET", f"/?token={self.httpd.token}")
        self.assertEqual(response.status, 303)
        cookie = response.getheader("Set-Cookie")
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=Strict", cookie)

    def test_login_link_works_once(self):
        link = self.httpd.logins.make()
        self.assertEqual(self.request("GET", f"/?login={link}").status, 303)
        self.assertEqual(self.request("GET", f"/?login={link}").status, 403, "un lien ne sert qu'une fois")
        self.assertEqual(self.request("GET", "/?login=faux").status, 403)

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
        transcript.write_text(json.dumps({"type": "user", "uuid": "u1", "message": {"role": "user", "content": "salut"}}) + "\n")

        def get(path):
            connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
            connection.request("GET", path, headers={"Host": self.host, **headers})
            data = json.loads(connection.getresponse().read())
            connection.close()
            return data

        with mock.patch.object(server.transcripts, "find_transcript", return_value=transcript):
            first = get(unknown)
            self.assertEqual([m["content"][0]["text"] for m in first["messages"]], ["salut"])
            self.assertEqual(get(f"{unknown}&since={first['signature']}"), {"unchanged": True, "signature": first["signature"]})

    def test_hooks_require_their_own_token(self):
        body = json.dumps({"prompt": "x"}).encode()
        self.assertEqual(self.request("POST", "/hooks/prompt", {}, body).status, 403)
        # Le cookie du navigateur ne suffit pas : /hooks est réservé aux terminaux Claude Code.
        self.assertEqual(self.request("POST", "/hooks/prompt", {"Cookie": self.cookie, "Origin": self.origin}, body).status, 403)
        auth = {"Authorization": f"Bearer {self.httpd.hook_token}"}
        self.assertEqual(self.request("POST", "/hooks/prompt", {**auth, "Host": "evil.example"}, body).status, 403)
        self.assertEqual(self.request("POST", "/hooks/prompt", auth, body).status, 200)
        self.assertEqual(self.request("POST", "/hooks/inconnu", auth, body).status, 403)
        self.assertEqual(self.httpd.hook_token_file.read_text(), self.httpd.hook_token)
        self.assertEqual(self.httpd.hook_token_file.stat().st_mode & 0o777, 0o600)

    def test_workspace_routes(self):
        headers = {"Cookie": self.cookie, "Origin": self.origin, "Content-Type": "application/json"}

        def post(path, body):
            response = self.request("POST", path, headers, json.dumps(body).encode())
            return response.status

        self.assertEqual(post("/api/workspaces", {"name": "  "}), 400)
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        connection.request("POST", "/api/workspaces", body=json.dumps({"name": "Connecteurs"}).encode(),
                           headers={"Host": self.host, **headers})
        workspace = json.loads(connection.getresponse().read())
        connection.close()
        base = f"/api/workspaces/{workspace['id']}"
        agent = "11111111-2222-4333-8444-555555555555"
        self.assertEqual(post(f"{base}/add", {"agent": agent}), 200)
        self.assertEqual(post(f"{base}/add", {"agent": "../../etc"}), 400)
        self.assertEqual(post("/api/workspaces/000000000000/add", {"agent": agent}), 404)
        self.assertEqual(self.httpd.workspaces.list()[0]["agents"], [agent])
        self.assertEqual(post(f"{base}/remove", {"agent": agent}), 200)
        self.assertEqual(post(f"{base}/update", {"name": "Batch", "hue": 200}), 200)
        self.assertEqual(post(f"{base}/update", {"hue": 999}), 400)
        self.assertEqual({k: self.httpd.workspaces.list()[0][k] for k in ("name", "hue")}, {"name": "Batch", "hue": 200})
        self.assertEqual(self.request("POST", f"{base}/delete", {"Cookie": self.cookie}, b"{}").status, 403)  # sans Origin
        self.assertEqual(post(f"{base}/delete", {}), 200)
        self.assertEqual(self.httpd.workspaces.list(), [])

    def test_agent_routes(self):
        headers = {"Cookie": self.cookie, "Origin": self.origin, "Content-Type": "application/json"}

        def post(path, body):
            return self.request("POST", path, headers, json.dumps(body).encode()).status

        agent = "33333333-2222-4333-8444-555555555555"
        self.assertEqual(post("/api/agents/rename", {"agent": "../x", "name": "a"}), 400)
        self.assertEqual(post("/api/agents/rename", {"agent": agent, "name": "Mon agent"}), 200)
        workspace = self.httpd.workspaces.create("Groupe")
        self.httpd.workspaces.add_agent(workspace["id"], agent)
        body = {"agent": agent, "keys": [agent, "pas-une-cle"], "label": "Revue", "cwd": "/tmp"}
        self.assertEqual(post("/api/agents/delete", body), 200)
        self.assertEqual(self.httpd.workspaces.list()[-1]["agents"], [])  # retiré de son workspace
        self.assertIn("hidden", self.httpd.agents.snapshot()[agent])
        self.assertEqual(post("/api/agents/restore", {"agent": agent}), 200)
        self.assertEqual(post("/api/agents/restore", {"agent": agent}), 404)
        # Sans historique, l'agent restauré retrouve une discussion dans son dossier, avec son nom.
        reopened = next(c for c in self.httpd.conversations.list() if c["label"] == "Revue")
        self.assertEqual(reopened["cwd"], "/tmp")
        self.assertEqual(self.httpd.agents.snapshot()[reopened["id"]], {"name": "Mon agent"})
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
            (Path(data) / "token").write_text("court")  # fichier abîmé : un nouveau token est créé
            fixed = server.ZiggyServer(port=0, conversation_cwd=data, account={}, data_dir=data)
            fixed.server_close()
            self.assertGreaterEqual(len(fixed.token), 32)

    def test_static_files_and_traversal(self):
        index = self.request("GET", "/")
        self.assertEqual(index.status, 200)
        self.assertIn("default-src 'self'", index.getheader("Content-Security-Policy"))
        self.assertEqual(self.request("GET", "/../server.py").status, 404)
        self.assertEqual(self.request("GET", "/%2e%2e/server.py").status, 404)


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""ziggy-one: drives local Claude Code conversations and shows the plan usage.

No third-party dependency: Python standard library only.
The server only listens on 127.0.0.1 and requires a token generated at startup.
"""

import argparse
import base64
import binascii
import errno
import hmac
import json
import os
import queue
import re
import secrets
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, urlsplit
from urllib.request import urlopen
import webbrowser

import media
import transcripts
from activity import SHARED_TAG, SharedActivity
from agents import AgentSettings
from context import ContextWindows
from conversations import ConversationManager, parse_json_line
from folders import create_subfolder, in_git_repo, list_subfolders, recent_folders, resolve_dir
import commit_message
import files as agent_files  # "files" is already used as a variable name
import gitops
import pdf
from terminal import Terminals
import i18n
from i18n import tr
import kanban
import login_links
from browser_sessions import COOKIE_MAX_AGE, BrowserSessions
import ticket_links
from restart import Restart
from shell import ShellRuns
import agent_mcp
from storage import default_data_dir, is_agent_key, persistent_token, write_private
import logo
from onboarding import Onboarding
from pins import Pins
from settings import Settings
from sound import FinishSound
from shortcuts import Shortcuts
from workspaces import Workspaces

WEB_DIR = (Path(__file__).resolve().parent / "web").resolve()
SESSIONS_DIR = Path.home() / ".claude" / "sessions"
MAX_BODY = 1_000_000
MAX_KANBAN_FILE_BODY = 36_000_000  # file attached to a ticket (25 MB, base64-encoded)
MAX_PDF_BODY = 5_000_000  # HTML page of an exchange of the conversation, to export as PDF
MAX_FILE_BODY = 2_500_000  # file saved from the Files tab (512 KB, JSON-escaped)
MAX_SOUND_BODY = 3_000_000  # sound of the end of a turn (2 MB, base64-encoded)
# Image served from an agent's folder: an SVG must not be able to run a script.
RAW_FILE_HEADERS = {"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
                    "X-Content-Type-Options": "nosniff"}

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".webmanifest": "application/manifest+json",
    ".woff2": "font/woff2",
    ".map": "application/json; charset=utf-8",  # xterm.js source map: its original TypeScript code
}
SECURITY_HEADERS = {
    "Content-Security-Policy": (
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: "
        "https://img.shields.io/badge/ https://badgen.net/badge/; "
        "connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
    ),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
}

# Minimal call (Haiku, no tools nor MCP): it only serves to get the rate_limit_event.
PROBE_CMD = [
    "claude", "-p", "--model", "haiku", "--tools", "", "--max-turns", "1",
    "--no-session-persistence", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--output-format", "stream-json", "--verbose", "Reply only: ok",
]
KANBAN_BOARD_ROUTE = re.compile(r"^/api/kanbans/([0-9a-f]{12})$")
KANBAN_BOARD_ACTION_ROUTE = re.compile(r"^/api/kanbans/([0-9a-f]{12})/(update|delete|columns|tickets|archive)$")
KANBAN_COLUMN_ROUTE = re.compile(r"^/api/kanbans/([0-9a-f]{12})/columns/([0-9a-f]{8})/(update|move|delete)$")
KANBAN_TICKET_ROUTE = re.compile(r"^/api/kanbans/tickets/([0-9a-f]{12})/(update|move|delete|files|archive|unarchive)$")
KANBAN_NUMBER_ROUTE = re.compile(r"^/api/kanbans/tickets/number/([1-9][0-9]{0,8})$")
TICKET_PAGE_ROUTE = re.compile(r"^/t/([1-9][0-9]{0,8})$")  # address of a ticket: the page, which opens its card
TICKET_FILE_LINK_ROUTE = re.compile(r"^/t/([1-9][0-9]{0,8})/files/([0-9a-f]{16})(?:/[^/]*)?$")
KANBAN_LINK_ROUTE = re.compile(r"^/api/kanbans/tickets/([0-9a-f]{12})/link$")
KANBAN_HISTORY_ROUTE = re.compile(r"^/api/kanbans/tickets/([0-9a-f]{12})/history$")
KANBAN_FILES_ROUTE = re.compile(r"^/api/kanbans/tickets/[0-9a-f]{12}/files$")
KANBAN_FILE_ROUTE = re.compile(r"^/api/kanbans/tickets/([0-9a-f]{12})/files/([0-9a-f]{16})(?:/[^/]*)?$")
KANBAN_FILE_DELETE_ROUTE = re.compile(r"^/api/kanbans/tickets/([0-9a-f]{12})/files/([0-9a-f]{16})/delete$")
KANBAN_WORKSPACE_ROUTE = re.compile(r"^/api/kanbans/workspaces/([0-9a-f]{12})/(update|add|remove|delete)$")
CONVERSATION_ROUTE = re.compile(
    r"^/api/conversations/([0-9a-f]{12})/(delete|shell|shell-stop|terminal-start|terminal-input|terminal-resize|terminal-stop)$"
)
HOOK_ROUTE = re.compile(r"^/hooks/(session|prompt|stop|notify|tool)$")
# Notification hook: what Claude Code waits for from you (the rest, like "idle_prompt", is ignored).
WAITING_KINDS = {"permission_prompt": "permission", "elicitation_dialog": "question"}
HOOK_SCRIPT = Path(__file__).resolve().parent / "ziggy_hook.py"
HOOK_TIMEOUT = 15  # seconds given to the hook by Claude Code
USAGE_REFRESH = 5 * 60  # the plan usage is read again at the end of a turn, at most every 5 minutes
MAX_TURN_SUMMARY = 300  # characters of the last answer in the end-of-turn notification
WORKSPACE_ROUTE = re.compile(r"^/api/workspaces/([0-9a-f]{12})/(update|add|place|move|remove|delete)$")
AGENT_ROUTE = re.compile(r"^/api/agents/(rename|options|role|avatar|delete|restore)$")
AVATAR_IMAGE_ROUTE = re.compile(r"^/api/agents/avatars/([0-9a-f]{16})$")
# Default Claude settings (those of the command line), which an agent can override.
DEFAULT_OPTIONS = {"model": None, "permissionMode": None, "allowedTools": [], "chrome": False}
GIT_ACTION_ROUTE = re.compile(r"^/api/git/(stage|unstage|discard|commit|checkout|branch|fetch|pull|push|message)$")

ACCOUNT_FIELDS = ("loggedIn", "authMethod", "apiProvider", "email", "orgName", "subscriptionType")
SESSION_FIELDS = (
    "pid", "sessionId", "name", "cwd", "status", "kind", "entrypoint", "version", "startedAt", "updatedAt",
)


def cookie_value(header, name):
    """Value of one cookie of the Cookie header. Read by hand: SimpleCookie gives up on the whole header
    when another local site set a cookie it cannot parse (JSON, brackets…), which would sign the user out."""
    for part in header.split(";"):
        key, sep, value = part.strip().partition("=")
        if sep and key == name:
            return value.strip()
    return None


def same_secret(given, expected):
    """Constant-time comparison, without error if the received value is not ASCII."""
    return hmac.compare_digest(str(given).encode(), expected.encode())


def read_account():
    """Claude Code account of the machine, via `claude auth status` (no secret in the output)."""
    try:
        result = subprocess.run(
            ["claude", "auth", "status", "--json"], capture_output=True, text=True,
            timeout=30, stdin=subprocess.DEVNULL,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"error": tr("`claude auth status` failed: {error}", error=exc)}
    data = parse_json_line(result.stdout)
    if data is None:
        return {"error": result.stderr.strip()[:500] or tr("Unreadable answer")}
    account = {key: data.get(key) for key in ACCOUNT_FIELDS}
    try:
        version = subprocess.run(
            ["claude", "--version"], capture_output=True, text=True, timeout=30, stdin=subprocess.DEVNULL,
        ).stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        version = ""
    account["version"] = version.split(" ")[0] or None  # "2.1.306 (Claude Code)"
    return account


def pid_alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def list_active_sessions(sessions_dir=SESSIONS_DIR):
    """Reads the Claude Code session registry, read-only (.key files are ignored)."""
    sessions = []
    for path in sessions_dir.glob("*.json"):
        try:
            data = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        if not isinstance(data, dict):
            continue
        pid = data.get("pid")
        if not isinstance(pid, int) or not pid_alive(pid):
            continue
        sessions.append({key: data.get(key) for key in SESSION_FIELDS})
    sessions.sort(key=lambda s: s.get("updatedAt") or 0, reverse=True)
    return sessions


def list_sessions(limit=50, our_pids=(), include=(), windows=None):
    """Open sessions (registry) and recent ones (transcripts), from the most recent to the oldest.

    "active" means open elsewhere (a terminal…): our own processes are not part of it.
    `include`: sessions to return even if they are not among the most recent (pinned agents).
    `windows`: known window sizes, for the context filling of each session.
    """
    sessions = {s["sessionId"]: {**s, "active": False} for s in transcripts.list_recent(limit)}
    for session_id in include:
        if session_id not in sessions:
            path = transcripts.find_transcript(session_id)
            if path is not None:
                sessions[session_id] = {**transcripts.summarize(path), "active": False}
    for live in list_active_sessions():
        session_id = live.get("sessionId")
        if not isinstance(session_id, str) or live.get("pid") in our_pids:
            continue
        base = sessions.get(session_id)
        if base is None:
            path = transcripts.find_transcript(session_id)
            base = transcripts.summarize(path) if path else {"sessionId": session_id, "lastPrompt": None, "costUsd": None}
        updated_ms = live.get("updatedAt")
        sessions[session_id] = {
            **base,
            "active": True,
            "cwd": live.get("cwd") or base.get("cwd"),
            "updatedAt": max(base.get("updatedAt") or 0, updated_ms / 1000 if isinstance(updated_ms, (int, float)) else 0),
            "name": live.get("name"),
            "status": live.get("status"),
        }
    windows = windows or ContextWindows()
    for session in sessions.values():
        windows.observe(session.get("model"), session.get("contextTokens"))
    for session in sessions.values():
        session["context"] = windows.describe(session.pop("model", None), session.pop("contextTokens", None))
    # Git repository: a single check per folder, even if it hosts several sessions.
    git_by_cwd = {}
    for session in sessions.values():
        cwd = session.get("cwd")
        if cwd not in git_by_cwd:
            git_by_cwd[cwd] = in_git_repo(cwd)
        session["git"] = git_by_cwd[cwd]
    return sorted(sessions.values(), key=lambda s: s.get("updatedAt") or 0, reverse=True)


class Bus:
    """Broadcasts events to all the tabs subscribed to the SSE stream."""

    def __init__(self):
        self._subscribers = set()
        self._lock = threading.Lock()

    def subscribe(self):
        q = queue.Queue(maxsize=1000)
        with self._lock:
            self._subscribers.add(q)
        return q

    def unsubscribe(self, q):
        with self._lock:
            self._subscribers.discard(q)

    def publish(self, kind, data):
        with self._lock:
            subscribers = list(self._subscribers)
        for q in subscribers:
            try:
                q.put_nowait((kind, data))
            except queue.Full:
                pass


class Usage:
    def __init__(self, bus):
        self._bus = bus
        self._lock = threading.Lock()
        self._probe_lock = threading.Lock()
        self._data = {"windows": {}, "status": None, "isUsingOverage": None, "overageStatus": None,
                      "overageDisabledReason": None, "updatedAt": None}

    def snapshot(self):
        with self._lock:
            return dict(self._data)

    def update(self, info):
        windows = {
            name: {"utilization": w.get("utilization"), "resetsAt": w.get("resetsAt")}
            for name, w in (info.get("unifiedWindows") or {}).items()
            if isinstance(w, dict)
        }
        if not windows and info.get("rateLimitType"):
            windows[info["rateLimitType"]] = {
                "utilization": info.get("utilization"), "resetsAt": info.get("resetsAt"),
            }
        with self._lock:
            self._data = {
                "windows": windows,
                "status": info.get("status"),
                "isUsingOverage": info.get("isUsingOverage"),
                # Extra usage (beyond the plan): available or not, and why.
                "overageStatus": info.get("overageStatus"),
                "overageDisabledReason": info.get("overageDisabledReason"),
                "updatedAt": time.time(),
            }
            snapshot = dict(self._data)
        self._bus.publish("usage", snapshot)

    def probe(self):
        """Runs a minimal call to refresh the usage. Returns an error message or None."""
        if not self._probe_lock.acquire(blocking=False):
            return tr("A refresh is already in progress")
        try:
            result = subprocess.run(
                PROBE_CMD, capture_output=True, text=True, timeout=90,
                cwd=tempfile.gettempdir(), stdin=subprocess.DEVNULL,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            return tr("The claude call failed: {error}", error=exc)
        finally:
            self._probe_lock.release()
        found = False
        for line in result.stdout.splitlines():
            event = parse_json_line(line)
            if event and event.get("type") == "rate_limit_event":
                self.update(event.get("rate_limit_info") or {})
                found = True
        if found:
            return None
        return result.stderr.strip()[:500] or tr("No rate_limit_event received")


class ZiggyServer(ThreadingHTTPServer):
    """Local HTTP server and the state shared between requests."""

    daemon_threads = True

    def __init__(self, port, conversation_cwd, account, defaults=None, data_dir=None, renew_token=False):
        super().__init__(("127.0.0.1", port), Handler)
        port = self.server_address[1]
        self.bus = Bus()
        self.usage = Usage(self.bus)
        self.terminals = Terminals(self.bus, on_exit=self._terminal_closed)
        data_dir = Path(data_dir) if data_dir else default_data_dir()
        self.data_dir = data_dir
        # Private folder (token, sessions, keys), even if it was created before with wider permissions.
        data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.onboarding = Onboarding(data_dir / "onboarding.json")
        try:
            data_dir.chmod(0o700)
        except OSError:
            pass
        # Global settings first: the interface language applies to every message of the server.
        self.settings = Settings(self.bus, data_dir / "settings.json")
        self.finish_sound = FinishSound(self.bus, data_dir)
        self.defaults = {**DEFAULT_OPTIONS, **(defaults or {})}
        self.workspaces = Workspaces(self.bus, data_dir / "workspaces.json")
        self.pins = Pins(self.bus, data_dir / "pins.json")
        self.shortcuts = Shortcuts(self.bus, data_dir / "shortcuts.json")
        # Tasks mode: Kanban boards, with their own workspaces and pins.
        self.kanban = kanban.Kanban(self.bus, data_dir / "kanbans.json", data_dir / "kanban-files")
        # "!! command" in the Conversation input: console in the agent's folder, without Claude.
        self.shell = ShellRuns(self.bus)
        # Clean restart requested from the Configuration screen; start time and version, to see it.
        self.restart = Restart(self, data_dir)
        self.started_at = time.time()
        self.version = git_version()
        # MCP tools of the agents (POST /mcp): read tickets and move them forward, without being able to delete any;
        # list, create and group agents (a created one does not start by itself); restart the server, only for
        # the agents working in Ziggy One's own folder (ZiggyBoss).
        self.mcp_tools = agent_mcp.AgentTools(self, self.kanban, render=lambda number: ticket_links.render(
            self.kanban.export(number), self.token, f"http://127.0.0.1:{self.server_address[1]}"), home=WEB_DIR.parent)
        self.kanban_workspaces = Workspaces(self.bus, data_dir / "kanban-workspaces.json", event="kanban_workspaces")
        self.kanban_pins = Pins(self.bus, data_dir / "kanban-pins.json", event="kanban_pins")
        self.agents = AgentSettings(self.bus, data_dir / "agents.json")
        self.context_windows = ContextWindows(data_dir / "context-windows.json")
        self.activity = SharedActivity(data_dir / "activity.json", self.workspaces.workspace_for, self.agents.name_for)
        self.account = account
        # Token kept from one start to the next: open tabs stay signed in after a relaunch.
        self.token = persistent_token(data_dir / "token", renew=renew_token)
        self.logins = login_links.LoginLinks(self.token, data_dir / "used-login-links.json")
        # Signed-in browsers: each has its own session (the cookie), never the token itself.
        self.sessions = BrowserSessions(data_dir / "browser-sessions.json")
        if renew_token:
            self.sessions.sign_out_all()
        # Terminal hooks: their own token (0600 file, renewed at each start), distinct from
        # the browser's, and one Claude Code settings file per terminal.
        self.port = port
        self.hook_token = secrets.token_urlsafe(32)
        self.hook_token_file = data_dir / "hook-token"
        write_private(self.hook_token_file, self.hook_token)
        self._last_usage_probe = 0.0
        self.conversations = ConversationManager(
            self.bus, conversation_cwd, in_git_repo=in_git_repo,
            # An agent filed or renamed before its first message is then identified by its session.
            on_session_started=self._session_started,
            has_history=lambda session_id: transcripts.find_transcript(session_id) is not None,
            path=data_dir / "conversations.json",  # open agents: found again on restart
        )
        threading.Thread(target=self._follow_terminal_sessions, daemon=True).start()
        self.cookie_name = f"zo_{port}"
        self.allowed_hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        self.allowed_origins = {f"http://{host}" for host in self.allowed_hosts}

    def _claude_args_for(self, conversation):
        """`claude` options for this conversation: those of its agent, else the default ones.

        Called while the process starts (conversation lock held): direct read.
        """
        keys = [conversation.session_id, conversation.resume_from, conversation.id] if conversation else []
        options = {**self.defaults, **self.agents.options_for(keys)}
        return build_claude_args(options["model"], options["permissionMode"], options["allowedTools"], options["chrome"])

    def our_pids(self):
        """`claude` processes of our terminals: their sessions are not "open elsewhere"."""
        return {pid for pid in map(self.terminals.claude_pid, self.terminals.list()) if pid is not None}

    def _hook_settings(self, conversation):
        """Claude Code settings of an agent's terminal (0600 file): our start-of-turn and end-of-turn hooks,
        and Ziggy One's data (token, keys, hook settings) out of reach of the agent's file tools."""
        def hook(event):
            command = (f"python3 -I {shlex.quote(str(HOOK_SCRIPT))} {event} {self.port} {conversation.id} "
                       f"{shlex.quote(str(self.hook_token_file))}")
            return [{"hooks": [{"type": "command", "command": command, "timeout": HOOK_TIMEOUT}]}]

        path = self.data_dir / "hooks" / f"{conversation.id}.json"
        hooks = {
            "SessionStart": hook("session"),  # start, resume, /clear, compaction: the agent directory
            "UserPromptSubmit": hook("prompt"),
            "Stop": hook("stop"),
            "Notification": hook("notify"),  # permission requested, question asked: the agent is waiting for you
            "PostToolUse": hook("tool"),  # the tool ran: you answered, the agent no longer waits for you
        }
        # "//" + absolute path: a path from the root of the disk in Claude Code's permission rules.
        data = f"/{self.data_dir.resolve()}/**"
        permissions = {"deny": [f"Read({data})", f"Edit({data})"]}
        write_private(path, json.dumps({"hooks": hooks, "permissions": permissions}))
        return path

    def _mcp_config(self, conversation):
        """"ziggy" MCP server of an agent's terminal (0600 file): its key does not go through the command line."""
        config = {"mcpServers": {"ziggy": {
            "type": "http",
            "url": f"http://127.0.0.1:{self.port}/mcp",
            "headers": {"Authorization": f"Bearer {agent_mcp.agent_key(self.token, conversation.id)}"},
        }}}
        path = self.data_dir / "mcp" / f"{conversation.id}.json"
        write_private(path, json.dumps(config))
        return path

    def start_terminal(self, conversation, cols, rows):
        """Opens Claude Code (interactive) in a terminal, on the agent's session."""
        # --mcp-config is variadic: followed by another option, it only takes its file.
        args = ["--mcp-config", str(self._mcp_config(conversation)), "--settings", str(self._hook_settings(conversation))]
        target = conversation.session_id or conversation.resume_from
        if target and transcripts.find_transcript(target) is not None:
            args += ["--resume", target]
            ours = self.our_pids()
            if any(s.get("sessionId") == target and s.get("pid") not in ours for s in list_active_sessions()):
                args.append("--fork-session")  # open in another terminal: work on a copy
        # Not when it is already open: start() then does nothing, the introduction is not used.
        intro = conversation.intro if "--resume" not in args and not self.terminals.running(conversation.id) else ""
        if intro:
            args.append(intro)  # first message (ZiggyBoss introduces itself), before the variadic options
        # Session name = agent name in ziggy-one: the other agents find it under that name
        # (Claude Code's ListAgents / SendMessage), instead of "folder-xx".
        name = self.agents.name_for(self.agent_keys(conversation))
        if name:
            args.append(f"--name={name}")  # one argument: a name starting with "-" stays a name
        args += self._claude_args_for(conversation)  # --allowedTools is variadic: it stays last
        self.terminals.start(conversation.id, conversation.cwd, args, cols, rows)
        if intro:
            conversation.intro_started()

    def agent_directory(self, conversation):
        """Directory given to an agent when its session starts: its role, and the other agents that have one,
        reachable with ListAgents / SendMessage under their name (that of their session). Empty if nobody has a role."""
        own_keys = set(self.agent_keys(conversation))
        open_keys = set()
        for other in self.conversations.list():
            if self.terminals.running(other["id"]):
                open_keys.update(k for k in (other.get("sessionId"), other.get("resumeFrom"), other["id"]) if k)
        own_role, others = None, []
        for key, name, role in self.agents.roles():
            if key in own_keys:
                own_role = role
            elif name:
                others.append((name, role, key in open_keys))
        if not own_role and not others:
            return ""
        lines = ["<ziggy-agents>"]
        me = self.agents.name_for(list(own_keys)) or "this agent"
        lines.append(f"You are \"{me}\", a Claude Code agent started by Ziggy One (the tool that runs the user's agents)."
                     + (f" Your role: {own_role}" if own_role else ""))
        if others:
            lines += ["", "The user's other agents, each with a role. To hand them a task that fits their role,"
                      " find them with ListAgents, then write to them with SendMessage(to: \"<name>\"), giving everything"
                      " they need (exact text, recipient…). A closed agent does not show up in ListAgents: tell"
                      " the user instead of doing it another way without their approval."]
            lines += [f"- \"{name}\"{' (open)' if is_open else ' (closed for now)'}: {role}"
                      for name, role, is_open in sorted(others, key=lambda item: item[0].lower())]
        lines.append("</ziggy-agents>")
        return "\n".join(lines) + "\n"

    @staticmethod
    def agent_keys(conversation):
        """Identifiers under which an agent's settings can be saved."""
        return [key for key in (conversation.session_id, conversation.resume_from, conversation.id) if key]

    def rename_agent(self, key, name):
        """Renames the agent; if its name changes while Claude Code runs in its terminal, the terminal is
        closed: the session only takes its name at launch, it will be reopened under the new one. Returns True
        if a terminal was closed."""
        conversation = self.conversations.get(key) or self.conversations.find_by_session(key)
        keys = self.agent_keys(conversation) if conversation else [key]
        before = self.agents.name_for(keys)
        self.agents.rename(key, name)
        if conversation is None or self.agents.name_for(keys) == before or not self.terminals.running(conversation.id):
            return False
        return self.terminals.stop(conversation.id)

    def _terminal_closed(self, conversation_id):
        (self.data_dir / "hooks" / f"{conversation_id}.json").unlink(missing_ok=True)
        (self.data_dir / "mcp" / f"{conversation_id}.json").unlink(missing_ok=True)
        conversation = self.conversations.get(conversation_id)
        if conversation is not None:
            conversation.set_waiting(None)
            conversation.set_busy(False)
            conversation.intro_stopped()

    def _follow_terminal_sessions(self, interval=1):
        """For each terminal, from the Claude Code registry: the session (new, /clear, /resume…),
        which the agent follows, and the "working" state (safety net if a hook does not arrive, Esc…)."""
        while True:
            time.sleep(interval)
            for conversation_id in self.terminals.list():
                pid = self.terminals.claude_pid(conversation_id)
                conversation = self.conversations.get(conversation_id)
                if pid is None or conversation is None:
                    continue
                try:
                    entry = json.loads((SESSIONS_DIR / f"{pid}.json").read_text())
                except (OSError, ValueError):
                    continue
                if not isinstance(entry, dict):
                    continue
                session_id = entry.get("sessionId")
                if isinstance(session_id, str) and is_agent_key(session_id):
                    conversation.adopt_session(session_id)
                if entry.get("status") in ("busy", "idle"):
                    conversation.set_busy(entry["status"] == "busy")

    def on_prompt(self, conversation, payload):
        """UserPromptSubmit hook: the agent starts working; returns the shared context to add (or "")."""
        prompt = payload.get("prompt") if isinstance(payload.get("prompt"), str) else ""
        conversation.set_waiting(None)  # you answered with a message
        conversation.set_busy(True, prompt=prompt)
        shared = self.activity.before_send(conversation)
        return f"<{SHARED_TAG}>\n{shared}\n</{SHARED_TAG}>\n" if shared else ""

    def on_stop(self, conversation, payload):
        """Stop hook: end of the turn. Notification, summary for the shared activity, plan usage."""
        conversation.set_waiting(None)
        conversation.set_busy(False)
        # Claude Code gives the last answer; failing that (older version), read it back from the history.
        text = payload.get("last_assistant_message") if isinstance(payload.get("last_assistant_message"), str) else ""
        path = payload.get("transcript_path")
        if not text and isinstance(path, str) and Path(path).resolve().is_relative_to(transcripts.PROJECTS_DIR.resolve()):
            try:
                text = transcripts.last_assistant_text(path)
            except OSError:
                pass
        self.bus.publish("turn_end", {"conversation": conversation.id, "summary": text[:MAX_TURN_SUMMARY]})
        threading.Thread(
            target=self.activity.after_turn, args=(conversation, conversation.prompt, text, False), daemon=True,
        ).start()
        if time.time() - self._last_usage_probe > USAGE_REFRESH:
            self._last_usage_probe = time.time()
            threading.Thread(target=self.usage.probe, daemon=True).start()

    def name_agents(self, sessions=()):
        """Generated name for each shown agent that has none: sessions of the list and conversations from here."""
        groups = []
        for status in self.conversations.list():
            groups.append([status.get("sessionId"), status.get("resumeFrom"), status["id"]])
        for session in sessions:
            session_id = session.get("sessionId")
            conversation = self.conversations.find_by_session(session_id) if session_id else None
            groups.append([session_id, conversation.id if conversation else None])
        self.agents.ensure_names(groups)

    def _session_started(self, conversation_id, session_id, previous=None):
        """Name, pin and workspace follow the agent: from its conversation, or from its old session
        (/clear, /resume…), to its new session."""
        for old in (conversation_id, previous):
            if old and old != session_id:
                self.workspaces.replace_agent_key(old, session_id)
                self.pins.replace_key(old, session_id)
                self.agents.replace_key(old, session_id)
                self.shortcuts.replace_key(old, session_id)

    def _reopen_restored(self, key, hidden):
        """Agent restored without history or conversation: a conversation is reopened for it in its folder,
        and its settings (name, avatar…) follow it. Without this, it would show up nowhere."""
        conversations = self.conversations
        if transcripts.find_transcript(key) is not None or conversations.get(key) or conversations.find_by_session(key):
            return
        cwd = hidden.get("cwd") if os.path.isdir(hidden.get("cwd") or "") else None
        conversation = conversations.open(cwd=cwd, label=hidden.get("label") or "")
        self._session_started(key, conversation.id)

    def info(self):
        """What the Configuration screen shows about the server: start, version, ongoing or last restart.

        `folder` and `path` (where Ziggy One is installed, the PATH where it looks for `claude`): for the
        prompt of the "Claude Code is not ready" screen, to hand to an agent that fixes it."""
        return {"startedAt": self.started_at, "version": self.version, "pid": os.getpid(),
                "restart": self.restart.snapshot(), "lastRestart": self.restart.last,
                "folder": str(WEB_DIR.parent), "path": os.environ.get("PATH", ""), "platform": sys.platform}

    def server_close(self):
        super().server_close()
        # Also called by socketserver when the bind fails, before __init__ has created these attributes.
        if hasattr(self, "shell"):
            self.shell.stop_all()
        if hasattr(self, "terminals"):
            self.terminals.stop_all()


class Handler(BaseHTTPRequestHandler):
    server_version = "ziggy-one"
    sys_version = ""
    # A connection that sends nothing for a minute is closed (an idle program cannot hold threads forever).
    # The event stream is not affected: it writes at least every 15 s.
    timeout = 60

    def log_message(self, fmt, *args):
        pass

    # --- helpers -----------------------------------------------------------

    def _send(self, status, body=b"", content_type="application/json; charset=utf-8", headers=None):
        headers = headers or {}
        # http.server writes header values as they are: a line break would start a new header (response splitting).
        if any("\r" in str(value) or "\n" in str(value) for value in headers.values()):
            raise ValueError("line break in an HTTP header value")
        self.send_response(status)
        for name, value in SECURITY_HEADERS.items():
            self.send_header(name, headers.get(name, value))  # a route can harden a security header
        self.send_header("Cache-Control", headers.get("Cache-Control", "no-store"))
        if body:
            self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for name, value in headers.items():
            if name not in SECURITY_HEADERS and name != "Cache-Control":
                self.send_header(name, value)
        self.end_headers()
        if body and self.command != "HEAD":
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass  # the browser closed the connection before the answer (tab closed, reloaded…)

    def _pdf(self, body):
        """HTML page (an exchange of the conversation) → PDF to download; 501 without Chrome on the machine."""
        try:
            data = pdf.html_to_pdf(body.get("html"), body.get("title"))
        except pdf.PdfUnavailable as exc:
            return self._json(501, {"error": str(exc)})
        except ValueError as exc:
            return self._json(400, {"error": str(exc)})
        name = pdf.safe_filename(body.get("filename"))
        disposition = f"attachment; filename=\"{name.encode('ascii', 'replace').decode()}\"; filename*=UTF-8''{quote(name)}"
        return self._send(200, data, "application/pdf", headers={"Content-Disposition": disposition})

    def _mcp(self):
        """MCP tools for the agents (JSON-RPC over HTTP): the agent's key says who makes the change.

        No cookie here: only the key, given to Claude Code in a private file, grants access. A web page
        therefore cannot use it (and a request from a browser carries an origin, which is refused)."""
        if not self._host_ok():
            return self._json(403, {"error": tr("Host refused")})
        if self.headers.get("Origin") and not self._origin_ok():
            return self._json(403, {"error": tr("Origin refused")})
        authorization = self.headers.get("Authorization", "")
        conversation_id = agent_mcp.check_key(self.server.token, authorization.removeprefix("Bearer ").strip())
        if conversation_id is None:
            return self._json(401, {"error": tr("Invalid agent key")})
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length < 0 or length > MAX_BODY:
                raise ValueError("Invalid Content-Length")
            message = json.loads(self.rfile.read(length) or b"null")
        except ValueError:
            return self._json(400, {"jsonrpc": "2.0", "id": None, "error": {"code": agent_mcp.PARSE_ERROR, "message": "Invalid JSON"}})
        conversation = self.server.conversations.get(conversation_id)
        keys = self.server.agent_keys(conversation) if conversation else [conversation_id]
        actor = self.server.agents.name_for(keys) or f"agent {conversation_id}"
        response = agent_mcp.dispatch(message, self.server.mcp_tools, actor, conversation_id)
        if response is None:
            return self._send(202)  # notification: nothing to answer
        return self._json(200, response)

    def _json(self, status, obj):
        self._send(status, json.dumps(obj, ensure_ascii=False).encode())

    def _host_ok(self):
        # Blocks DNS rebinding: only the expected local names are accepted.
        return self.headers.get("Host", "") in self.server.allowed_hosts

    def _authenticated(self):
        """True if the cookie holds a valid browser session; its digest is kept in self.session."""
        self.session = None
        value = cookie_value(self.headers.get("Cookie", ""), self.server.cookie_name)
        if value is not None:
            self.session = self.server.sessions.check(value)
        return self.session is not None

    def _origin_ok(self):
        return self.headers.get("Origin") in self.server.allowed_origins

    def _read_json(self, limit=MAX_BODY):
        length = int(self.headers.get("Content-Length") or 0)
        if length < 0 or length > limit:
            raise ValueError(tr("Invalid Content-Length"))
        raw = self.rfile.read(length) if length else b""
        data = json.loads(raw or b"{}")
        if not isinstance(data, dict):
            raise ValueError(tr("JSON object expected"))
        return data

    # --- routes ------------------------------------------------------------

    def do_GET(self):
        if not self._host_ok():
            return self._json(403, {"error": tr("Host refused")})
        url = urlsplit(self.path)
        if url.path == "/mcp":
            return self._json(405, {"error": tr("The MCP server only answers POST")})
        if url.path == "/" and url.query:
            query = parse_qs(url.query)
            if "login" not in query:
                # Old /?token=… bookmarks: the token no longer signs in (it would sit in the history and the
                # address bar). Back to /, which works if this browser is already signed in, else says how to.
                return self._send(303, headers={"Location": "/"})
            if not self.server.logins.redeem(query["login"][0]):  # single-use link from `ziggy`
                return self._json(403, {"error": tr("Sign-in link invalid, expired or already used")})
            # The browser gets a session of its own, which can be signed out alone: never the token.
            session_id = self.server.sessions.create(self.headers.get("User-Agent", ""))
            cookie = (f"{self.server.cookie_name}={session_id}; HttpOnly; SameSite=Strict; Path=/; "
                      f"Max-Age={COOKIE_MAX_AGE}")
            return self._send(303, headers={"Location": "/", "Set-Cookie": cookie})
        if url.path.startswith("/api/"):
            if not self._authenticated():
                return self._json(401, {"error": tr("Not authenticated")})
            # Sessions to always return (pinned or filed agents), identifiers validated.
            include = [
                session_id for session_id in parse_qs(url.query).get("include", [""])[0].split(",")
                if transcripts.UUID_RE.match(session_id)
            ][:200]
            include += [key for key in self.server.pins.agent_keys() if transcripts.UUID_RE.match(key) and key not in include]
            if url.path == "/api/state":
                conversations = self.server.conversations
                sessions = list_sessions(
                    our_pids=self.server.our_pids(), include=include, windows=self.server.context_windows,
                )
                self.server.name_agents(sessions)  # before copying the settings, to have the names in them
                return self._json(200, {
                    "account": self.server.account,
                    "usage": self.server.usage.snapshot(),
                    "defaultCwd": conversations.default_cwd,
                    "defaults": {k: self.server.defaults[k] for k in ("model", "permissionMode", "chrome")},
                    "conversations": conversations.list(),
                    "terminals": self.server.terminals.list(),
                    "workspaces": self.server.workspaces.list(),
                    "pins": self.server.pins.list(),
                    "server": self.server.info(),
                    "shortcuts": self.server.shortcuts.snapshot(),
                    "settings": self.server.settings.snapshot(),
                    "sound": self.server.finish_sound.info(),
                    "agents": self.server.agents.snapshot(),
                    "sessions": sessions,
                })
            if url.path == "/api/sessions":
                sessions = list_sessions(our_pids=self.server.our_pids(), include=include, windows=self.server.context_windows)
                self.server.name_agents(sessions)  # the new names also go out as an "agents" event
                return self._json(200, {"sessions": sessions})
            if url.path == "/api/server":
                return self._json(200, self.server.info())
            if url.path == "/api/browsers":
                return self._json(200, {"browsers": self.server.sessions.list(current=self.session)})
            if url.path == "/api/terminals":
                # Configuration screen: the open Claude Code terminals, when they opened and their memory.
                return self._json(200, {"terminals": self.server.terminals.stats()})
            if url.path == "/api/workspaces":
                return self._json(200, {"workspaces": self.server.workspaces.list()})
            if url.path.startswith("/api/kanbans"):
                return self._kanban_get(url.path)
            if url.path == "/api/folders":
                path = parse_qs(url.query).get("path", [""])[0] or str(Path.home())
                try:
                    return self._json(200, list_subfolders(path))
                except ValueError as exc:
                    return self._json(400, {"error": str(exc)})
            if url.path.startswith("/api/git/"):
                return self._git_read(url)
            if url.path.startswith("/api/files/"):
                return self._files_read(url)
            if url.path == "/api/folders/recent":
                # ?limit=N (1 to 50, 5 by default); "more" says whether there are more beyond.
                raw_limit = parse_qs(url.query).get("limit", ["5"])[0]
                limit = min(max(int(raw_limit), 1), 50) if raw_limit.isdigit() else 5
                conversations = self.server.conversations
                used = [*list_sessions(limit=200, our_pids=self.server.our_pids()),
                        *({"cwd": c["cwd"], "updatedAt": c["lastActivity"]} for c in conversations.list())]
                folders = recent_folders(used, limit=limit + 1)
                return self._json(200, {"folders": folders[:limit], "more": len(folders) > limit})
            if url.path == "/api/terminal":
                conversation_id = parse_qs(url.query).get("conversation", [""])[0]
                return self._json(200, self.server.terminals.snapshot(conversation_id))
            if url.path == "/api/transcript":
                # Conversation tab: the formatted session; "since" avoids reading it again if nothing changed.
                params = parse_qs(url.query)
                session_id = params.get("session", [""])[0]
                if not transcripts.UUID_RE.match(session_id):
                    return self._json(400, {"error": tr("Invalid session id")})
                path = transcripts.find_transcript(session_id)
                if path is None:
                    return self._json(404, {"error": tr("No history for this session")})
                try:
                    signature = transcripts.signature(path)
                    if params.get("since", [""])[0] == signature:
                        return self._json(200, {"unchanged": True, "signature": signature})
                    return self._json(200, {**transcripts.read_transcript(path), "signature": signature})
                except OSError as exc:
                    return self._json(500, {"error": tr("Cannot read: {error}", error=exc)})
            if url.path == "/api/events":
                return self._stream_events()
            if url.path == "/api/sound":
                # End-of-turn sound: yours or the default one; ?v= changes with the file, so it can be kept.
                data, kind = self.server.finish_sound.read()
                return self._send(200, data, kind, {**RAW_FILE_HEADERS, "Cache-Control": "private, max-age=31536000, immutable"})
            avatar = AVATAR_IMAGE_ROUTE.match(url.path)
            if avatar:
                image = self.server.agents.avatar_image(avatar.group(1))
                if image is None:
                    return self._json(404, {"error": tr("Image not found")})
                # An image never changes under its id: the browser keeps it.
                return self._send(200, image[0], image[1], {**RAW_FILE_HEADERS, "Cache-Control": "private, max-age=31536000, immutable"})
            return self._json(404, {"error": tr("Unknown route")})
        # Address of a ticket (/t/42): in the user's browser, the page, which opens the card;
        # for an agent (no cookie, with the link's key), the ticket as text. Attached files: key required.
        page = TICKET_PAGE_ROUTE.match(url.path)
        file_link = TICKET_FILE_LINK_ROUTE.match(url.path)
        if file_link or (page and not self._authenticated()):
            return self._ticket_link(url, page, file_link)
        return self._static("/" if page else url.path)

    def do_POST(self):
        hook = HOOK_ROUTE.match(urlsplit(self.path).path)
        if hook:
            return self._hook(hook.group(1))  # Claude Code in a terminal: its own token
        if urlsplit(self.path).path == "/mcp":
            return self._mcp()  # MCP tools of the agents: their own key
        if not self._host_ok() or not self._origin_ok():
            return self._json(403, {"error": tr("Origin refused")})
        if not self._authenticated():
            return self._json(401, {"error": tr("Not authenticated")})
        path = urlsplit(self.path).path
        try:
            limit = (MAX_FILE_BODY if path == "/api/files/write" else MAX_PDF_BODY if path == "/api/pdf"
                     else MAX_KANBAN_FILE_BODY if KANBAN_FILES_ROUTE.match(path)
                     else MAX_SOUND_BODY if path == "/api/sound" else MAX_BODY)
            body = self._read_json(limit)
        except ValueError as exc:
            return self._json(400, {"error": str(exc)})
        conversations = self.server.conversations
        try:
            if path == "/api/account/check":
                # Claude Code installed or signed in since the start: checked again, without restarting.
                self.server.account = read_account()
                return self._json(200, self.server.account)
            if path == "/api/usage/refresh":
                error = self.server.usage.probe()
                if error:
                    return self._json(502, {"error": error})
                return self._json(200, self.server.usage.snapshot())
            if path == "/api/conversations":
                return self._open_conversation(body)
            if path.startswith("/api/kanbans"):
                return self._kanban_post(path, body)
            if path == "/api/server/restart":
                # Clean restart: start (pause working agents, wait), force (right now), cancel.
                action = body.get("action")
                if action == "start":
                    self.server.restart.request()
                elif action == "force":
                    self.server.restart.force()
                elif action == "cancel":
                    self.server.restart.cancel()
                else:
                    return self._json(400, {"error": tr("Unknown action (start, force or cancel)")})
                return self._json(200, self.server.info())
            if path == "/api/login-link":
                # Single-use sign-in link, to open the interface in another browser (only from a signed-in one).
                return self._json(200, {"path": f"/?login={self.server.logins.make()}", "lifetime": login_links.LIFETIME})
            if path == "/api/browsers/sign-out":
                # One signed-in browser; this one, if it is its own id (its cookie is then cleared).
                public = body.get("id")
                if not isinstance(public, str) or not public:
                    return self._json(400, {"error": tr("Invalid browser id")})
                if self.server.sessions.sign_out(public, current=self.session):
                    cookie = f"{self.server.cookie_name}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"
                    return self._send(200, b'{"signedOut": "current"}', headers={"Set-Cookie": cookie})
                return self._json(200, {"browsers": self.server.sessions.list(current=self.session)})
            if path == "/api/browsers/sign-out-others":
                self.server.sessions.sign_out_others(self.session)
                return self._json(200, {"browsers": self.server.sessions.list(current=self.session)})
            if path == "/api/pins":
                try:
                    return self._json(200, {"pins": self.server.pins.set(body.get("pins"))})
                except ValueError as exc:
                    return self._json(400, {"error": str(exc)})
            if path == "/api/sound":
                try:
                    data = base64.b64decode(body.get("data") or "", validate=True)
                except binascii.Error:
                    return self._json(400, {"error": tr("Invalid file")})
                try:
                    return self._json(200, {"sound": self.server.finish_sound.set(body.get("name"), data)})
                except ValueError as exc:
                    return self._json(400, {"error": str(exc)})
            if path == "/api/sound/reset":
                return self._json(200, {"sound": self.server.finish_sound.reset()})
            if path == "/api/settings":
                try:
                    return self._json(200, {"settings": self.server.settings.update(body.get("settings"))})
                except ValueError as exc:
                    return self._json(400, {"error": str(exc)})
            if path == "/api/shortcuts":
                try:
                    shortcuts = self.server.shortcuts.set(body.get("scope"), body.get("owner"), body.get("items"))
                except ValueError as exc:
                    return self._json(400, {"error": str(exc)})
                return self._json(200, {"shortcuts": shortcuts})
            if path == "/api/workspaces":
                workspace = self.server.workspaces.create(body.get("name"))
                self.server.pins.add(f"workspace:{workspace['id']}")  # pinned by default, can be unpinned
                return self._json(200, workspace)
            if path == "/api/folders/create":
                # New subfolder for an agent: returns the content of the created folder.
                try:
                    created = create_subfolder(body.get("parent"), body.get("name"))
                    return self._json(200, list_subfolders(str(created)))
                except ValueError as exc:
                    return self._json(400, {"error": str(exc)})
            if path == "/api/pdf":
                return self._pdf(body)
            if path == "/api/files/write":
                return self._files_write(body)
            match = AGENT_ROUTE.match(path)
            if match:
                return self._agent_action(match.group(1), body)
            match = GIT_ACTION_ROUTE.match(path)
            if match:
                return self._git_action(match.group(1), body)
            match = WORKSPACE_ROUTE.match(path)
            if match:
                workspace_id, action = match.groups()
                workspaces = self.server.workspaces
                if action == "delete":
                    found = workspaces.delete(workspace_id)
                    if found:
                        self.server.shortcuts.drop_workspace(workspace_id)
                elif action == "update":
                    changes = {key: body[key] for key in ("name", "hue", "shareActivity") if key in body}
                    found = workspaces.update(workspace_id, changes)
                elif action == "add":
                    found = workspaces.add_agent(workspace_id, body.get("agent"))
                elif action == "place":  # drag and drop: the agent goes just before `before` (null: at the end)
                    found = workspaces.place_agent(workspace_id, body.get("agent"), body.get("before"))
                elif action == "move":  # drag and drop: the workspace goes just before `before` (null: at the end)
                    found = workspaces.move(workspace_id, body.get("before"))
                else:
                    found = workspaces.remove_agent(workspace_id, body.get("agent"))
                if not found:
                    return self._json(404, {"error": tr("Unknown workspace")})
                return self._json(200, {"workspaces": workspaces.list()})
            match = CONVERSATION_ROUTE.match(path)
            if match:
                conversation_id, action = match.groups()
                conversation = conversations.get(conversation_id)
                if conversation is None:
                    return self._json(404, {"error": tr("Unknown agent")})
                if action == "terminal-start":
                    self.server.start_terminal(conversation, body.get("cols"), body.get("rows"))
                    return self._json(200, self.server.terminals.snapshot(conversation_id))
                elif action == "terminal-input":
                    self.server.terminals.write(conversation_id, body.get("data"))
                    return self._json(200, {"ok": True})
                elif action == "terminal-resize":
                    self.server.terminals.resize(conversation_id, body.get("cols"), body.get("rows"))
                    return self._json(200, {"ok": True})
                elif action == "terminal-stop":
                    self.server.terminals.stop(conversation_id)
                    return self._json(200, {"ok": True})
                elif action == "shell":
                    # "!! command" in the Conversation: console in the agent's folder, without Claude.
                    run_id = self.server.shell.start(conversation_id, conversation.cwd, body.get("command"))
                    return self._json(200, {"run": run_id})
                elif action == "shell-stop":
                    if body.get("run") not in self.server.shell.running(conversation_id):
                        return self._json(404, {"error": tr("Command ended or unknown")})
                    self.server.shell.stop(body["run"])
                    return self._json(200, {"ok": True})
                else:
                    self.server.terminals.stop(conversation_id)
                    for run_id in self.server.shell.running(conversation_id):
                        self.server.shell.stop(run_id)
                    conversations.remove(conversation_id)
                    return self._json(200, {"ok": True})
        except ValueError as exc:
            return self._json(400, {"error": str(exc)})
        except (RuntimeError, OSError) as exc:
            return self._json(409, {"error": str(exc)})
        return self._json(404, {"error": tr("Unknown route")})

    # --- Tasks mode: Kanban boards ---------------------------------------------------------

    def _kanban_get(self, path):
        board = self.server.kanban
        try:
            if path == "/api/kanbans":
                return self._json(200, {
                    "boards": board.list(), "workspaces": self.server.kanban_workspaces.list(),
                    "pins": self.server.kanban_pins.list(),
                })
            match = KANBAN_FILE_ROUTE.match(path)
            if match:
                file_path, name, media_type = board.file(*match.groups())
                try:
                    size, file = file_path.stat().st_size, file_path.open("rb")
                except OSError:
                    return self._json(404, {"error": tr("File not found")})
                with file:
                    return self._send_file(name, media_type, size, file)
            match = KANBAN_BOARD_ROUTE.match(path)
            if match:
                return self._json(200, board.get(match.group(1)))
            if path == "/api/kanbans/index":
                return self._json(200, {"tickets": board.index()})
            match = KANBAN_NUMBER_ROUTE.match(path)
            if match:
                return self._json(200, board.find_number(int(match.group(1))))
            match = KANBAN_HISTORY_ROUTE.match(path)
            if match:
                return self._json(200, {"history": board.ticket_history(match.group(1))})
            match = KANBAN_LINK_ROUTE.match(path)
            if match:
                # Link to share (with its read key), for the "Copy link" button.
                number = next((t["number"] for t in board.index() if t["id"] == match.group(1)), None)
                if number is None:
                    raise KeyError(tr("Unknown ticket"))
                return self._json(200, {"path": ticket_links.ticket_path(self.server.token, number)})
        except KeyError as exc:
            return self._json(404, {"error": exc.args[0]})
        return self._json(404, {"error": tr("Unknown route")})

    def _ticket_link(self, url, page, file_link):
        """Ticket read by an agent with its link's key: Markdown text, or an attached file."""
        number = int((page or file_link).group(1))
        if not ticket_links.valid(self.server.token, number, parse_qs(url.query).get("k", [""])[0]):
            return self._send(401, b"Ticket link without a valid key: copy the link from the ticket card "
                                   b"(\"Copy link\" button).\n", "text/plain; charset=utf-8")
        try:
            export = self.server.kanban.export(number)
            if file_link:
                file_path, name, media_type = self.server.kanban.file(export["ticket"]["id"], file_link.group(2))
                size, file = file_path.stat().st_size, file_path.open("rb")
                with file:
                    return self._send_file(name, media_type, size, file)
        except (KeyError, OSError):
            return self._send(404, f"Ticket #{number} or file not found (deleted?).\n".encode(), "text/plain; charset=utf-8")
        text = ticket_links.render(export, self.server.token, f"http://{self.headers.get('Host')}")
        # Plain text (Markdown): readable as is by an agent as in a browser.
        return self._send(200, text.encode(), "text/plain; charset=utf-8")

    def _kanban_post(self, path, body):
        """Boards, columns, tickets, attached files, workspaces and pins of the Tasks mode."""
        kb = self.server.kanban
        try:
            if path == "/api/kanbans":
                return self._json(200, kb.create_board(body.get("name")))
            if path == "/api/kanbans/pins":
                return self._json(200, {"pins": self.server.kanban_pins.set(body.get("pins"))})
            if path == "/api/kanbans/workspaces":
                return self._json(200, self.server.kanban_workspaces.create(body.get("name")))
            match = KANBAN_WORKSPACE_ROUTE.match(path)
            if match:
                workspace_id, action = match.groups()
                workspaces = self.server.kanban_workspaces
                if action == "delete":
                    found = workspaces.delete(workspace_id)
                elif action == "update":
                    found = workspaces.update(workspace_id, {k: body[k] for k in ("name", "hue") if k in body})
                elif action == "add":
                    kb.get(body.get("board"))  # existing board (KeyError otherwise)
                    found = workspaces.add_agent(workspace_id, body.get("board"))
                else:
                    found = workspaces.remove_agent(workspace_id, body.get("board"))
                if not found:
                    return self._json(404, {"error": tr("Unknown workspace")})
                return self._json(200, {"workspaces": workspaces.list()})
            match = KANBAN_BOARD_ACTION_ROUTE.match(path)
            if match:
                board_id, action = match.groups()
                if action == "update":
                    kb.update_board(board_id, {k: body[k] for k in ("name", "hue") if k in body})
                elif action == "delete":
                    kb.delete_board(board_id)
                    self.server.kanban_workspaces.remove_agent_everywhere({board_id})
                    self.server.kanban_pins.set([p for p in self.server.kanban_pins.list() if p != board_id])
                    return self._json(200, {"ok": True})
                elif action == "columns":
                    return self._json(200, kb.add_column(board_id, body.get("name"), body.get("hue")))
                elif action == "archive":
                    return self._json(200, {"archived": kb.archive_column(board_id, body.get("column"))})
                else:
                    return self._json(200, kb.create_ticket(
                        board_id, body.get("column"), body.get("title"), body.get("description", "")))
                return self._json(200, kb.get(board_id))
            match = KANBAN_COLUMN_ROUTE.match(path)
            if match:
                board_id, column_id, action = match.groups()
                if action == "update":
                    kb.update_column(board_id, column_id, {k: body[k] for k in ("name", "hue") if k in body})
                elif action == "move":
                    kb.move_column(board_id, column_id, body.get("index"))
                else:
                    kb.delete_column(board_id, column_id, body.get("into"))
                return self._json(200, kb.get(board_id))
            match = KANBAN_TICKET_ROUTE.match(path)
            if match:
                ticket_id, action = match.groups()
                if action == "update":
                    kb.update_ticket(ticket_id, {k: body[k] for k in ("title", "description", "due") if k in body})
                elif action == "move":
                    kb.move_ticket(ticket_id, body.get("column"), body.get("index"))
                elif action == "delete":
                    kb.delete_ticket(ticket_id)
                elif action == "archive":
                    kb.archive_ticket(ticket_id)
                elif action == "unarchive":
                    kb.unarchive_ticket(ticket_id)
                else:
                    try:
                        data = base64.b64decode(body.get("data") or "", validate=True)
                    except (ValueError, TypeError):
                        raise ValueError(tr("Badly encoded file")) from None
                    return self._json(200, kb.add_file(ticket_id, body.get("name"), body.get("type"), data))
                return self._json(200, {"ok": True})
            match = KANBAN_FILE_DELETE_ROUTE.match(path)
            if match:
                kb.delete_file(*match.groups())
                return self._json(200, {"ok": True})
        except KeyError as exc:
            return self._json(404, {"error": exc.args[0]})
        return self._json(404, {"error": tr("Unknown route")})

    def _git_read(self, url):
        """Git reads: status, history, details of a commit, diff of a file."""
        query = {key: values[0] for key, values in parse_qs(url.query).items()}
        path = query.get("path", "")
        try:
            if url.path == "/api/git/state":
                return self._json(200, gitops.state(path))
            if url.path == "/api/git/log":
                limit = query.get("limit", "200")
                return self._json(200, {"commits": gitops.log(path, int(limit) if limit.isdigit() else 200)})
            if url.path == "/api/git/commit":
                return self._json(200, gitops.commit_details(path, query.get("hash")))
            if url.path == "/api/git/diff":
                return self._json(200, gitops.diff(path, query.get("file"), query.get("mode"), query.get("hash")))
        except gitops.GitError as exc:
            return self._json(400, {"error": str(exc)})
        return self._json(404, {"error": tr("Unknown route")})

    def _files_read(self, url):
        """Files tab: content of a folder, reading a file, raw image, search."""
        query = {key: values[0] for key, values in parse_qs(url.query).items()}
        path = query.get("path", "")
        try:
            if url.path == "/api/files/list":
                return self._json(200, agent_files.list_dir(path, query.get("dir", "")))
            if url.path == "/api/files/read":
                return self._json(200, agent_files.read_file(path, query.get("file", "")))
            if url.path == "/api/files/raw":
                data, mime = agent_files.read_image(path, query.get("file", ""))
                return self._send(200, data, mime, headers=RAW_FILE_HEADERS)
            if url.path == "/api/files/search":
                return self._json(200, agent_files.search(path, query.get("q", ""), query.get("mode", "name")))
        except ValueError as exc:
            return self._json(400, {"error": str(exc)})
        except OSError as exc:
            return self._json(400, {"error": tr("Cannot read: {error}", error=exc.strerror or exc)})
        return self._json(404, {"error": tr("Unknown route")})

    def _files_write(self, body):
        """Saves a text file edited in the Files tab; 409 if it changed in the meantime."""
        try:
            return self._json(200, agent_files.write_file(body.get("path"), body.get("file"), body.get("content"),
                                                    body.get("version")))
        except agent_files.FileConflict as exc:
            return self._json(409, {"error": str(exc), "version": exc.version})
        except ValueError as exc:
            return self._json(400, {"error": str(exc)})
        except OSError as exc:
            return self._json(400, {"error": tr("Cannot write: {error}", error=exc.strerror or exc)})

    def _git_action(self, action, body):
        """Git action; returns the git output and the updated repository status."""
        path = body.get("path")
        files = body.get("files")
        try:
            if action == "message":
                # Commit message suggested by Claude, to review before committing.
                return self._json(200, {"message": commit_message.generate(path)})
            if action == "stage":
                output = gitops.stage(path, files)
            elif action == "unstage":
                output = gitops.unstage(path, files)
            elif action == "discard":
                output = gitops.discard(path, files)
            elif action == "commit":
                output = gitops.commit(path, body.get("message"))
            elif action == "checkout":
                output = gitops.checkout(path, body.get("branch"))
            elif action == "branch":
                output = gitops.create_branch(path, body.get("name"))
            elif action == "fetch":
                output = gitops.fetch(path)
            elif action == "pull":
                output = gitops.pull(path)
            else:
                output = gitops.push(path)
            return self._json(200, {"output": output, "state": gitops.state(path)})
        except gitops.GitError as exc:
            return self._json(400, {"error": str(exc)})

    def _agent_action(self, action, body):
        """Rename, delete (remove from ziggy-one, history kept) or restore an agent."""
        key = body.get("agent")
        if not is_agent_key(key):
            return self._json(400, {"error": tr("Invalid agent id")})
        agents = self.server.agents
        if action == "rename":
            closed = self.server.rename_agent(key, body.get("name"))
            return self._json(200, {"agents": agents.snapshot(), "terminalClosed": closed})
        elif action == "avatar":
            # Image cropped by the browser, sent in base64; without an image, the agent keeps its own.
            raw = body.get("image")
            try:
                image = base64.b64decode(raw, validate=True) if isinstance(raw, str) else None
            except binascii.Error:
                return self._json(400, {"error": tr("Invalid image")})
            agents.set_avatar(key, body.get("avatar"), image)
        elif action == "options":
            # Applied the next time Claude Code opens in the Terminal.
            agents.set_options(key, body.get("options"))
            return self._json(200, {"agents": agents.snapshot()})
        elif action == "role":
            # Given to the other agents when their session starts (directory, SessionStart hook).
            agents.set_role(key, body.get("role"))
            return self._json(200, {"agents": agents.snapshot()})
        elif action == "restore":
            hidden = agents.restore(key)
            if not hidden:
                return self._json(404, {"error": tr("Agent not deleted")})
            self.server._reopen_restored(key, hidden)
        else:
            # All the agent's ids (session, copy, conversation), to remove it from everywhere.
            other_keys = body.get("keys") if isinstance(body.get("keys"), list) else []
            keys = {key, *(k for k in other_keys[:10] if is_agent_key(k))}
            conversation_id = body.get("conversation")
            if isinstance(conversation_id, str):
                self.server.terminals.stop(conversation_id)  # closes Claude Code if it runs here
                self.server.conversations.remove(conversation_id)
            self.server.workspaces.remove_agent_everywhere(keys)
            agents.hide(key, body.get("label"), body.get("cwd"))
        return self._json(200, {"agents": agents.snapshot()})

    def _open_conversation(self, body):
        """Opens a conversation: blank, or to resume a session (launching nothing before the 1st message)."""
        resume = body.get("resume")
        label = body.get("label") if isinstance(body.get("label"), str) else ""
        cwd = None
        if resume is None and body.get("cwd") is not None:
            # New agent in the chosen folder.
            try:
                cwd = str(resolve_dir(body.get("cwd")))
            except ValueError as exc:
                return self._json(400, {"error": str(exc)})
        if resume is not None:
            if not isinstance(resume, str) or not transcripts.UUID_RE.match(resume):
                return self._json(400, {"error": tr("Invalid session id")})
            # Open session (registry) or past one (transcript on disk).
            session = next((s for s in list_active_sessions() if s["sessionId"] == resume), None)
            if session is not None:
                cwd = session.get("cwd")
            else:
                path = transcripts.find_transcript(resume)
                if path is None:
                    return self._json(400, {"error": tr("Session not found")})
                cwd = transcripts.transcript_cwd(path)
            if not isinstance(cwd, str) or not os.path.isdir(cwd):
                return self._json(400, {"error": tr("The folder of this session no longer exists")})
        conversation = self.server.conversations.open(resume=resume, cwd=cwd, label=label[:200])
        if resume is None:
            self.server.pins.add(conversation.id)  # new agent: pinned by default, can be unpinned
        self.server.name_agents()
        return self._json(200, conversation.status())

    def _hook(self, event):
        """Claude Code hook in a terminal (ziggy_hook.py): start or end of an agent's turn."""
        authorization = self.headers.get("Authorization", "")
        if not self._host_ok() or not same_secret(authorization, f"Bearer {self.server.hook_token}"):
            return self._json(403, {"error": tr("Access denied")})
        try:
            payload = self._read_json()
        except ValueError as exc:
            return self._json(400, {"error": str(exc)})
        conversation = self.server.conversations.get(parse_qs(urlsplit(self.path).query).get("conversation", [""])[0])
        if conversation is None:
            return self._send(200, b"", "text/plain; charset=utf-8")  # agent closed in the meantime: nothing to do
        session_id = payload.get("session_id")
        if is_agent_key(session_id):
            conversation.adopt_session(session_id)
        if event == "session":
            text = self.server.agent_directory(conversation)
        elif event == "prompt":
            text = self.server.on_prompt(conversation, payload)
        elif event == "stop":
            text = self.server.on_stop(conversation, payload)
        elif event == "notify":
            kind = WAITING_KINDS.get(payload.get("notification_type"))
            if kind:
                conversation.set_waiting(kind)
            text = ""
        else:  # tool
            conversation.set_waiting(None)
            text = ""
        return self._send(200, (text or "").encode(), "text/plain; charset=utf-8")

    def _send_file(self, name, media_type, size, file):
        """File opened in a tab, from our origin: only images and PDFs keep their type;
        a text (HTML and SVG included) is shown as plain text; the rest is downloaded. The CSP sandbox
        prevents any script.
        """
        quoted = quote(name, safe="")
        if media_type in media.IMAGE_TYPES or media_type == "application/pdf":
            content_type, disposition = media_type, "inline"
        elif media.is_text(name, media_type):
            content_type, disposition = "text/plain; charset=utf-8", "inline"
        else:
            content_type, disposition = "application/octet-stream", "attachment"
        # Chrome's PDF viewer does not open in a sandbox: a PDF does not run any script
        # of the page anyway.
        csp = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; object-src 'self'"
        if media_type != "application/pdf":
            csp += "; sandbox"
        self.send_response(200)
        for header, value in {**SECURITY_HEADERS, "Content-Security-Policy": csp}.items():
            self.send_header(header, value)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(size))
        self.send_header("Content-Disposition", f"{disposition}; filename*=UTF-8''{quoted}")
        self.end_headers()
        try:
            shutil.copyfileobj(file, self.wfile)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _static(self, path):
        relative = "index.html" if path in ("", "/") else path.lstrip("/")
        if relative in ("logo.svg", "favicon.png"):
            # Logo and favicon in the chosen color (Configuration › General); ?c= in the page changes with it.
            color = self.server.settings.snapshot()["color"]
            body, kind = (logo.svg(color), MIME[".svg"]) if relative == "logo.svg" else (logo.png(color), "image/png")
            return self._send(200, body, kind, {"Cache-Control": "no-cache"})
        target = (WEB_DIR / relative).resolve()
        if not target.is_relative_to(WEB_DIR) or not target.is_file():
            return self._json(404, {"error": tr("Not found")})
        content_type = MIME.get(target.suffix)
        if content_type is None:
            return self._json(404, {"error": tr("Not found")})
        body = target.read_bytes()
        headers = None
        if relative == "index.html":
            # Style nonce, new at each load: only our scripts can create <style> elements
            # (the xterm.js terminal needs them); injected markup would stay blocked. Style attributes
            # allowed: xterm.js sets the exact (24-bit) text colours there, without which Claude Code shows
            # without its colours. A style attribute can neither load nor run anything.
            nonce = secrets.token_urlsafe(16)
            body = body.replace(b"__CSP_NONCE__", nonce.encode())
            # Interface language (Configuration › General), known before any script runs: see web/i18n.js.
            body = body.replace(b"__LANG__", i18n.language().encode())
            body = body.replace(b"__DIR__", i18n.direction().encode())  # Arabic: right to left
            # Corner style (Configuration › General), applied before the first render.
            body = body.replace(b"__CORNERS__", self.server.settings.snapshot()["corners"].encode())
            body = body.replace(b"__COLOR__", self.server.settings.snapshot()["color"].encode())  # logo and favicon
            csp = SECURITY_HEADERS["Content-Security-Policy"].replace(
                "style-src 'self'", f"style-src 'self' 'nonce-{nonce}'; style-src-attr 'unsafe-inline'")
            headers = {"Content-Security-Policy": csp}
        self._send(200, body, content_type, headers)

    def _stream_events(self):
        self.send_response(200)
        for name, value in SECURITY_HEADERS.items():
            self.send_header(name, value)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        q = self.server.bus.subscribe()
        try:
            while True:
                try:
                    kind, data = q.get(timeout=15)
                    payload = f"event: {kind}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"
                except queue.Empty:
                    payload = ": ping\n\n"
                if not self.server.sessions.alive(self.session):
                    break  # browser signed out: its stream stops too
                self.wfile.write(payload.encode())
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            self.server.bus.unsubscribe(q)


def build_claude_args(model=None, permission_mode=None, allowed_tools=(), chrome=False):
    """Options passed to each `claude` process of the conversation."""
    args = []
    if model:
        args += ["--model", model]
    if permission_mode:
        args += ["--permission-mode", permission_mode]
    tools = list(allowed_tools)
    if chrome:
        args.append("--chrome")
        tools.append("mcp__claude-in-chrome")
    if tools:
        # Variadic option: always last on the command line.
        args += ["--allowedTools", *tools]
    return args


def git_version():
    """Commit of the running code ("7185ee0"), or None outside a git repository."""
    try:
        result = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=Path(__file__).resolve().parent,
                                capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return result.stdout.strip() or None


def ziggy_listens(port):
    """True if a ziggy-one server answers on this port (Server header)."""
    try:
        with urlopen(f"http://127.0.0.1:{port}/api/state", timeout=3) as response:
            server_header = response.headers.get("Server", "")
    except HTTPError as error:  # 401 without cookie: the answer still says who answers
        server_header = error.headers.get("Server", "")
    except (URLError, OSError):
        return False
    return server_header.startswith("ziggy-one")


def show_login(port, token, open_browser):
    """Address to bookmark, and single-use sign-in link: opened in the browser or printed (`ziggy --link`, to
    paste into another browser)."""
    address = f"http://127.0.0.1:{port}/"
    link = f"{address}?login={login_links.make(token)}"
    # The command to give again: on another port, `ziggy` alone would start a second server on 6767.
    command = "ziggy --link" if port == 6767 else f"ziggy --port {port} --link"
    print(f"ziggy-one → {address}", flush=True)
    if open_browser and webbrowser.open(link):
        print("interface opened in the browser", flush=True)
        # webbrowser.open can succeed without anything showing up (no default browser, headless session…).
        print(f"not opening in your browser, or want another one? run `{command}` "
              "and paste the link it prints into your browser", flush=True)
    else:
        minutes = login_links.LIFETIME // 60
        print(f"sign in (single-use link, valid {minutes} min): {link}", flush=True)
        print(f"running `{command}` again gives a new one", flush=True)


def main():
    parser = argparse.ArgumentParser(description="Drives local Claude Code sessions.")
    parser.add_argument("--port", type=int, default=6767)
    parser.add_argument("--cwd", default=os.getcwd(),
                        help="working folder of new conversations (default: current folder)")
    parser.add_argument("--model", help="model of the conversation (default: Claude Code's)")
    parser.add_argument("--permission-mode",
                        choices=["default", "acceptEdits", "plan", "auto", "dontAsk"],
                        help="permission mode of the conversation")
    parser.add_argument("--allowed-tools", nargs="*", default=[],
                        help='allowed tool rules, e.g. "Bash(git status)" "Edit"')
    parser.add_argument("--chrome", action="store_true",
                        help="enables Claude in Chrome and allows its tools")
    parser.add_argument("--new-token", action="store_true",
                        help="generates a new access token (open tabs will have to use the new address)")
    parser.add_argument("--open", action="store_true",
                        help="opens the interface in the browser, already signed in (single-use link)")
    parser.add_argument("--link", action="store_true",
                        help="prints a single-use sign-in link instead of opening the browser (for another browser)")
    args = parser.parse_args()

    try:
        server = ZiggyServer(
            port=args.port,
            conversation_cwd=str(Path(args.cwd).resolve()),
            defaults={"model": args.model, "permissionMode": args.permission_mode,
                      "allowedTools": args.allowed_tools, "chrome": args.chrome},
            account=read_account(),
            renew_token=args.new_token,
        )
    except OSError as error:
        if error.errno != errno.EADDRINUSE:
            raise
        if not ziggy_listens(args.port):
            sys.exit(f"ziggy-one: port {args.port} is already used by another program (try --port)")
        # Already running: only open the interface, with the running server's token.
        print(f"ziggy-one is already running on port {args.port}", flush=True)
        show_login(args.port, persistent_token(default_data_dir() / "token"), args.open and not args.link)
        return
    server.onboarding.run(server, WEB_DIR.parent)  # no agent yet: ZiggyBoss; first launch: the welcome board
    threading.Thread(target=server.usage.probe, daemon=True).start()

    # `kill` (SIGTERM) stops the server as cleanly as Ctrl+C: the Claude Code terminals are closed.
    def interrupt(signum, frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupt)

    # Never the token itself on screen or in a log: a link that works only once.
    show_login(server.server_address[1], server.token, args.open and not args.link)
    # After a restart requested from the interface: reopens the terminals and makes the agents resume.
    threading.Thread(target=server.restart.resume_after_restart, daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        if server.terminals.list():
            print("\nziggy-one: closing the Claude Code terminals… (Ctrl+C again to kill them now)", flush=True)
    finally:
        server.server_close()
    if server.restart.requested:
        # Same command, same process (log and terminal kept); --new-token must not be replayed.
        # Nor --open or --link: the open tabs reconnect by themselves.
        argv = [arg for arg in sys.argv[1:] if arg not in ("--new-token", "--open", "--link")]
        print("ziggy-one: restart requested from the interface", flush=True)
        os.execv(sys.executable, [sys.executable, str(Path(__file__).resolve()), *argv])


if __name__ == "__main__":
    main()

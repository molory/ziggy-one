#!/usr/bin/env python3
"""ziggy-one : pilote des discussions Claude Code locales et affiche l'usage du forfait.

Aucune dépendance tierce : bibliothèque standard Python uniquement.
Le serveur n'écoute que sur 127.0.0.1 et exige un token généré au démarrage.
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
from http.cookies import CookieError, SimpleCookie
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
import files as agent_files  # « files » sert déjà de nom de variable
import gitops
import pdf
from terminal import Terminals
import kanban
import login_links
import ticket_links
from restart import Restart
from shell import ShellRuns
import agent_mcp
from storage import default_data_dir, is_agent_key, persistent_token, write_private
from pins import Pins
from shortcuts import Shortcuts
from workspaces import Workspaces

WEB_DIR = (Path(__file__).resolve().parent / "web").resolve()
SESSIONS_DIR = Path.home() / ".claude" / "sessions"
MAX_BODY = 1_000_000
MAX_KANBAN_FILE_BODY = 36_000_000  # fichier joint à un ticket (25 Mo, encodés en base64)
MAX_PDF_BODY = 5_000_000  # page HTML d'un échange de la discussion, à exporter en PDF
MAX_FILE_BODY = 2_500_000  # fichier enregistré depuis l'onglet Fichiers (512 Ko, échappés en JSON)
# Image servie depuis le dossier d'un agent : un SVG ne doit pas pouvoir lancer de script.
RAW_FILE_HEADERS = {"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
                    "X-Content-Type-Options": "nosniff"}

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".map": "application/json; charset=utf-8",  # source map de xterm.js : son code TypeScript d'origine
}
SECURITY_HEADERS = {
    "Content-Security-Policy": (
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
        "connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
    ),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
}

# Appel minimal (Haiku, sans outils ni MCP) : il sert uniquement à récupérer le rate_limit_event.
PROBE_CMD = [
    "claude", "-p", "--model", "haiku", "--tools", "", "--max-turns", "1",
    "--no-session-persistence", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--output-format", "stream-json", "--verbose", "Réponds uniquement : ok",
]
KANBAN_BOARD_ROUTE = re.compile(r"^/api/kanbans/([0-9a-f]{12})$")
KANBAN_BOARD_ACTION_ROUTE = re.compile(r"^/api/kanbans/([0-9a-f]{12})/(update|delete|columns|tickets)$")
KANBAN_COLUMN_ROUTE = re.compile(r"^/api/kanbans/([0-9a-f]{12})/columns/([0-9a-f]{8})/(update|move|delete)$")
KANBAN_TICKET_ROUTE = re.compile(r"^/api/kanbans/tickets/([0-9a-f]{12})/(update|move|delete|files)$")
KANBAN_NUMBER_ROUTE = re.compile(r"^/api/kanbans/tickets/number/([1-9][0-9]{0,8})$")
TICKET_PAGE_ROUTE = re.compile(r"^/t/([1-9][0-9]{0,8})$")  # adresse d'un ticket : la page, qui ouvre sa fiche
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
# Hook Notification : ce que Claude Code attend de toi (le reste, comme « idle_prompt », est ignoré).
WAITING_KINDS = {"permission_prompt": "permission", "elicitation_dialog": "question"}
HOOK_SCRIPT = Path(__file__).resolve().parent / "ziggy_hook.py"
HOOK_TIMEOUT = 15  # secondes accordées au hook par Claude Code
USAGE_REFRESH = 5 * 60  # l'usage du forfait est relu en fin de tour, au plus toutes les 5 minutes
MAX_TURN_SUMMARY = 300  # caractères de la dernière réponse dans la notification de fin de tour
WORKSPACE_ROUTE = re.compile(r"^/api/workspaces/([0-9a-f]{12})/(update|add|remove|delete)$")
AGENT_ROUTE = re.compile(r"^/api/agents/(rename|options|role|avatar|delete|restore)$")
AVATAR_IMAGE_ROUTE = re.compile(r"^/api/agents/avatars/([0-9a-f]{16})$")
# Réglages de Claude par défaut (ceux de la ligne de commande), qu'un agent peut remplacer.
DEFAULT_OPTIONS = {"model": None, "permissionMode": None, "allowedTools": [], "chrome": False}
GIT_ACTION_ROUTE = re.compile(r"^/api/git/(stage|unstage|discard|commit|checkout|branch|fetch|pull|push|message)$")

ACCOUNT_FIELDS = ("loggedIn", "authMethod", "apiProvider", "email", "orgName", "subscriptionType")
SESSION_FIELDS = (
    "pid", "sessionId", "name", "cwd", "status", "kind", "entrypoint", "version", "startedAt", "updatedAt",
)


def same_secret(given, expected):
    """Comparaison en temps constant, sans erreur si la valeur reçue n'est pas en ASCII."""
    return hmac.compare_digest(str(given).encode(), expected.encode())


def read_account():
    """Compte Claude Code du poste, via `claude auth status` (aucun secret dans la sortie)."""
    try:
        result = subprocess.run(
            ["claude", "auth", "status", "--json"], capture_output=True, text=True,
            timeout=30, stdin=subprocess.DEVNULL,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"error": f"échec de `claude auth status` : {exc}"}
    data = parse_json_line(result.stdout)
    if data is None:
        return {"error": result.stderr.strip()[:500] or "réponse illisible"}
    account = {key: data.get(key) for key in ACCOUNT_FIELDS}
    try:
        version = subprocess.run(
            ["claude", "--version"], capture_output=True, text=True, timeout=30, stdin=subprocess.DEVNULL,
        ).stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        version = ""
    account["version"] = version.split(" ")[0] or None  # « 2.1.306 (Claude Code) »
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
    """Lit le registre des sessions Claude Code en lecture seule (les fichiers .key sont ignorés)."""
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
    """Sessions ouvertes (registre) et récentes (transcripts), de la plus récente à la plus ancienne.

    « active » signifie ouverte ailleurs (un terminal…) : nos propres processus n'en font pas partie.
    `include` : sessions à renvoyer même si elles ne sont pas parmi les plus récentes (agents épinglés).
    `windows` : tailles de fenêtre connues, pour le remplissage du contexte de chaque session.
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
    # Dépôt git : un seul test par dossier, même s'il héberge plusieurs sessions.
    git_by_cwd = {}
    for session in sessions.values():
        cwd = session.get("cwd")
        if cwd not in git_by_cwd:
            git_by_cwd[cwd] = in_git_repo(cwd)
        session["git"] = git_by_cwd[cwd]
    return sorted(sessions.values(), key=lambda s: s.get("updatedAt") or 0, reverse=True)


class Bus:
    """Diffuse les événements à tous les onglets abonnés au flux SSE."""

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
                # Usage supplémentaire (au-delà du forfait) : disponible ou non, et pourquoi.
                "overageStatus": info.get("overageStatus"),
                "overageDisabledReason": info.get("overageDisabledReason"),
                "updatedAt": time.time(),
            }
            snapshot = dict(self._data)
        self._bus.publish("usage", snapshot)

    def probe(self):
        """Lance un appel minimal pour rafraîchir l'usage. Retourne un message d'erreur ou None."""
        if not self._probe_lock.acquire(blocking=False):
            return "une actualisation est déjà en cours"
        try:
            result = subprocess.run(
                PROBE_CMD, capture_output=True, text=True, timeout=90,
                cwd=tempfile.gettempdir(), stdin=subprocess.DEVNULL,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            return f"échec de l'appel claude : {exc}"
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
        return result.stderr.strip()[:500] or "aucun rate_limit_event reçu"


class ZiggyServer(ThreadingHTTPServer):
    """Serveur HTTP local et l'état partagé entre les requêtes."""

    daemon_threads = True

    def __init__(self, port, conversation_cwd, account, defaults=None, data_dir=None, renew_token=False):
        super().__init__(("127.0.0.1", port), Handler)
        port = self.server_address[1]
        self.bus = Bus()
        self.usage = Usage(self.bus)
        self.terminals = Terminals(self.bus, on_exit=self._terminal_closed)
        data_dir = Path(data_dir) if data_dir else default_data_dir()
        self.data_dir = data_dir
        self.defaults = {**DEFAULT_OPTIONS, **(defaults or {})}
        self.workspaces = Workspaces(self.bus, data_dir / "workspaces.json")
        self.pins = Pins(self.bus, data_dir / "pins.json")
        self.shortcuts = Shortcuts(self.bus, data_dir / "shortcuts.json")
        # Mode Tâches : tableaux Kanban, avec leurs propres workspaces et épingles.
        self.kanban = kanban.Kanban(self.bus, data_dir / "kanbans.json", data_dir / "kanban-files")
        # « !! commande » dans la saisie de la Discussion : console dans le dossier de l'agent, sans Claude.
        self.shell = ShellRuns(self.bus)
        # Redémarrage propre demandé depuis l'écran Configuration ; heure de démarrage et version, pour le voir.
        self.restart = Restart(self, data_dir)
        self.started_at = time.time()
        self.version = git_version()
        # Outils MCP des agents (POST /mcp) : lire et faire avancer les tickets, sans pouvoir en supprimer.
        self.kanban_tools = agent_mcp.KanbanTools(self.kanban, render=lambda number: ticket_links.render(
            self.kanban.export(number), self.token, f"http://127.0.0.1:{self.server_address[1]}"))
        self.kanban_workspaces = Workspaces(self.bus, data_dir / "kanban-workspaces.json", event="kanban_workspaces")
        self.kanban_pins = Pins(self.bus, data_dir / "kanban-pins.json", event="kanban_pins")
        self.agents = AgentSettings(self.bus, data_dir / "agents.json")
        self.context_windows = ContextWindows(data_dir / "context-windows.json")
        self.activity = SharedActivity(data_dir / "activity.json", self.workspaces.workspace_for, self.agents.name_for)
        self.account = account
        # Token gardé d'un démarrage à l'autre : les onglets ouverts restent connectés après une relance.
        self.token = persistent_token(data_dir / "token", renew=renew_token)
        self.logins = login_links.LoginLinks(self.token)
        # Hooks des terminaux : un token propre (fichier 0600, renouvelé à chaque démarrage), distinct de
        # celui du navigateur, et un fichier de réglages Claude Code par terminal.
        self.port = port
        self.hook_token = secrets.token_urlsafe(32)
        self.hook_token_file = data_dir / "hook-token"
        write_private(self.hook_token_file, self.hook_token)
        self._last_usage_probe = 0.0
        self.conversations = ConversationManager(
            self.bus, conversation_cwd, in_git_repo=in_git_repo,
            # Un agent rangé ou renommé avant son premier message est ensuite désigné par sa session.
            on_session_started=self._session_started,
            has_history=lambda session_id: transcripts.find_transcript(session_id) is not None,
            path=data_dir / "conversations.json",  # agents ouverts : retrouvés au redémarrage
        )
        threading.Thread(target=self._follow_terminal_sessions, daemon=True).start()
        self.cookie_name = f"zo_{port}"
        self.allowed_hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        self.allowed_origins = {f"http://{host}" for host in self.allowed_hosts}

    def _claude_args_for(self, conversation):
        """Options de `claude` pour cette discussion : celles de son agent, sinon celles par défaut.

        Appelée pendant le démarrage du processus (verrou de la discussion tenu) : lecture directe.
        """
        keys = [conversation.session_id, conversation.resume_from, conversation.id] if conversation else []
        options = {**self.defaults, **self.agents.options_for(keys)}
        return build_claude_args(options["model"], options["permissionMode"], options["allowedTools"], options["chrome"])

    def our_pids(self):
        """Processus `claude` de nos terminaux : leurs sessions ne sont pas « ouvertes ailleurs »."""
        return {pid for pid in map(self.terminals.claude_pid, self.terminals.list()) if pid is not None}

    def _hook_settings(self, conversation):
        """Réglages Claude Code du terminal d'un agent (fichier 0600) : nos hooks de début et de fin de tour."""
        def hook(event):
            command = (f"python3 -I {shlex.quote(str(HOOK_SCRIPT))} {event} {self.port} {conversation.id} "
                       f"{shlex.quote(str(self.hook_token_file))}")
            return [{"hooks": [{"type": "command", "command": command, "timeout": HOOK_TIMEOUT}]}]

        path = self.data_dir / "hooks" / f"{conversation.id}.json"
        hooks = {
            "SessionStart": hook("session"),  # démarrage, reprise, /clear, compaction : l'annuaire des agents
            "UserPromptSubmit": hook("prompt"),
            "Stop": hook("stop"),
            "Notification": hook("notify"),  # autorisation demandée, question posée : l'agent t'attend
            "PostToolUse": hook("tool"),  # l'outil s'est exécuté : tu as répondu, l'agent ne t'attend plus
        }
        write_private(path, json.dumps({"hooks": hooks}))
        return path

    def _mcp_config(self, conversation):
        """Serveur MCP « ziggy » du terminal d'un agent (fichier 0600) : sa clé ne passe pas par la ligne de commande."""
        config = {"mcpServers": {"ziggy": {
            "type": "http",
            "url": f"http://127.0.0.1:{self.port}/mcp",
            "headers": {"Authorization": f"Bearer {agent_mcp.agent_key(self.token, conversation.id)}"},
        }}}
        path = self.data_dir / "mcp" / f"{conversation.id}.json"
        write_private(path, json.dumps(config))
        return path

    def start_terminal(self, conversation, cols, rows):
        """Ouvre Claude Code (interactif) dans un terminal, sur la session de l'agent."""
        # --mcp-config est variadique : suivi d'une autre option, il ne prend que son fichier.
        args = ["--mcp-config", str(self._mcp_config(conversation)), "--settings", str(self._hook_settings(conversation))]
        target = conversation.session_id or conversation.resume_from
        if target and transcripts.find_transcript(target) is not None:
            args += ["--resume", target]
            ours = self.our_pids()
            if any(s.get("sessionId") == target and s.get("pid") not in ours for s in list_active_sessions()):
                args.append("--fork-session")  # ouverte dans un autre terminal : on travaille sur une copie
        # Nom de la session = nom de l'agent dans ziggy-one : les autres agents le trouvent sous ce nom
        # (ListAgents / SendMessage de Claude Code), au lieu de « dossier-xx ».
        name = self.agents.name_for(self.agent_keys(conversation))
        if name:
            args += ["--name", name]
        args += self._claude_args_for(conversation)  # --allowedTools est variadique : il reste en dernier
        self.terminals.start(conversation.id, conversation.cwd, args, cols, rows)

    def agent_directory(self, conversation):
        """Annuaire donné à un agent au démarrage de sa session : son rôle, et les autres agents qui en ont un,
        joignables par ListAgents / SendMessage sous leur nom (celui de leur session). Vide si personne n'a de rôle."""
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
        me = self.agents.name_for(list(own_keys)) or "cet agent"
        lines.append(f"Tu es « {me} », un agent Claude Code lancé par Ziggy One (l'outil qui pilote les agents de l'utilisateur)."
                     + (f" Ton rôle : {own_role}" if own_role else ""))
        if others:
            lines += ["", "Autres agents de l'utilisateur, chacun avec un rôle. Pour leur confier une tâche qui relève de leur rôle,"
                      " trouve-les avec ListAgents puis écris-leur avec SendMessage(to: \"<nom>\"), en donnant tout le"
                      " nécessaire (texte exact, destinataire…). Un agent fermé n'apparaît pas dans ListAgents : dis-le à"
                      " l'utilisateur plutôt que de faire autrement sans son accord."]
            lines += [f"- « {name} »{' (ouvert)' if is_open else ' (fermé pour l’instant)'} : {role}"
                      for name, role, is_open in sorted(others, key=lambda item: item[0].lower())]
        lines.append("</ziggy-agents>")
        return "\n".join(lines) + "\n"

    @staticmethod
    def agent_keys(conversation):
        """Identifiants sous lesquels les réglages d'un agent peuvent être enregistrés."""
        return [key for key in (conversation.session_id, conversation.resume_from, conversation.id) if key]

    def rename_agent(self, key, name):
        """Renomme l'agent ; si son nom change et que Claude Code tourne dans son terminal, le terminal est
        fermé : la session ne prend son nom qu'au lancement, il sera rouvert sous le nouveau. Renvoie True
        si un terminal a été fermé."""
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

    def _follow_terminal_sessions(self, interval=1):
        """Pour chaque terminal, d'après le registre de Claude Code : la session (nouvelle, /clear, /resume…),
        que l'agent suit, et l'état « au travail » (filet de sécurité si un hook n'arrive pas, Échap…)."""
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
        """Hook UserPromptSubmit : l'agent se met au travail ; renvoie le contexte partagé à ajouter (ou "")."""
        prompt = payload.get("prompt") if isinstance(payload.get("prompt"), str) else ""
        conversation.set_waiting(None)  # tu as répondu par un message
        conversation.set_busy(True, prompt=prompt)
        shared = self.activity.before_send(conversation)
        return f"<{SHARED_TAG}>\n{shared}\n</{SHARED_TAG}>\n" if shared else ""

    def on_stop(self, conversation, payload):
        """Hook Stop : fin du tour. Notification, bilan pour l'activité partagée, usage du forfait."""
        conversation.set_waiting(None)
        conversation.set_busy(False)
        # Claude Code donne la dernière réponse ; à défaut (version plus ancienne), on la relit dans l'historique.
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
        """Nom généré pour chaque agent affiché qui n'en a pas : sessions de la liste et discussions d'ici."""
        groups = []
        for status in self.conversations.list():
            groups.append([status.get("sessionId"), status.get("resumeFrom"), status["id"]])
        for session in sessions:
            session_id = session.get("sessionId")
            conversation = self.conversations.find_by_session(session_id) if session_id else None
            groups.append([session_id, conversation.id if conversation else None])
        self.agents.ensure_names(groups)

    def _session_started(self, conversation_id, session_id, previous=None):
        """Nom, épingle et workspace suivent l'agent : de sa discussion, ou de son ancienne session
        (/clear, /resume…), vers sa nouvelle session."""
        for old in (conversation_id, previous):
            if old and old != session_id:
                self.workspaces.replace_agent_key(old, session_id)
                self.pins.replace_key(old, session_id)
                self.agents.replace_key(old, session_id)
                self.shortcuts.replace_key(old, session_id)

    def _reopen_restored(self, key, hidden):
        """Agent restauré sans historique ni discussion : on lui rouvre une discussion dans son dossier,
        et ses réglages (nom, avatar…) la suivent. Sans cela, il n'apparaîtrait nulle part."""
        conversations = self.conversations
        if transcripts.find_transcript(key) is not None or conversations.get(key) or conversations.find_by_session(key):
            return
        cwd = hidden.get("cwd") if os.path.isdir(hidden.get("cwd") or "") else None
        conversation = conversations.open(cwd=cwd, label=hidden.get("label") or "")
        self._session_started(key, conversation.id)

    def info(self):
        """Ce que l'écran Configuration montre du serveur : démarrage, version, redémarrage en cours ou dernier."""
        return {"startedAt": self.started_at, "version": self.version, "pid": os.getpid(),
                "restart": self.restart.snapshot(), "lastRestart": self.restart.last}

    def server_close(self):
        super().server_close()
        # Appelé aussi par socketserver quand le bind échoue, avant que __init__ ait créé ces attributs.
        if hasattr(self, "shell"):
            self.shell.stop_all()
        if hasattr(self, "terminals"):
            self.terminals.stop_all()


class Handler(BaseHTTPRequestHandler):
    server_version = "ziggy-one"
    sys_version = ""

    def log_message(self, fmt, *args):
        pass

    # --- utilitaires -------------------------------------------------------

    def _send(self, status, body=b"", content_type="application/json; charset=utf-8", headers=None):
        self.send_response(status)
        headers = headers or {}
        for name, value in SECURITY_HEADERS.items():
            self.send_header(name, headers.get(name, value))  # une route peut durcir un en-tête de sécurité
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
                pass  # le navigateur a fermé la connexion avant la réponse (onglet fermé, rechargé…)

    def _pdf(self, body):
        """Page HTML (un échange de la discussion) → PDF à télécharger ; 501 sans Chrome sur le poste."""
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
        """Outils MCP pour les agents (JSON-RPC sur HTTP) : la clé de l'agent dit qui fait le changement.

        Pas de cookie ici : seule la clé, donnée à Claude Code dans un fichier privé, ouvre l'accès. Une page
        web ne peut donc pas s'en servir (et une requête d'un navigateur porte une origine, refusée)."""
        if not self._host_ok():
            return self._json(403, {"error": "hôte refusé"})
        if self.headers.get("Origin") and not self._origin_ok():
            return self._json(403, {"error": "origine refusée"})
        authorization = self.headers.get("Authorization", "")
        conversation_id = agent_mcp.check_key(self.server.token, authorization.removeprefix("Bearer ").strip())
        if conversation_id is None:
            return self._json(401, {"error": "clé d'agent invalide"})
        try:
            message = json.loads(self.rfile.read(min(int(self.headers.get("Content-Length") or 0), MAX_BODY)) or b"null")
        except ValueError:
            return self._json(400, {"jsonrpc": "2.0", "id": None, "error": {"code": agent_mcp.PARSE_ERROR, "message": "JSON invalide"}})
        conversation = self.server.conversations.get(conversation_id)
        keys = self.server.agent_keys(conversation) if conversation else [conversation_id]
        actor = self.server.agents.name_for(keys) or f"agent {conversation_id}"
        response = agent_mcp.dispatch(message, self.server.kanban_tools, actor)
        if response is None:
            return self._send(202)  # notification : rien à répondre
        return self._json(200, response)

    def _json(self, status, obj):
        self._send(status, json.dumps(obj, ensure_ascii=False).encode())

    def _host_ok(self):
        # Bloque le DNS rebinding : seuls les noms locaux attendus sont acceptés.
        return self.headers.get("Host", "") in self.server.allowed_hosts

    def _authenticated(self):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
        except CookieError:
            return False
        morsel = cookie.get(self.server.cookie_name)
        return morsel is not None and same_secret(morsel.value, self.server.token)

    def _origin_ok(self):
        return self.headers.get("Origin") in self.server.allowed_origins

    def _read_json(self, limit=MAX_BODY):
        length = int(self.headers.get("Content-Length") or 0)
        if length < 0 or length > limit:
            raise ValueError("Content-Length invalide")
        raw = self.rfile.read(length) if length else b""
        data = json.loads(raw or b"{}")
        if not isinstance(data, dict):
            raise ValueError("objet JSON attendu")
        return data

    # --- routes ------------------------------------------------------------

    def do_GET(self):
        if not self._host_ok():
            return self._json(403, {"error": "hôte refusé"})
        url = urlsplit(self.path)
        if url.path == "/mcp":
            return self._json(405, {"error": "le serveur MCP ne répond qu'en POST"})
        if url.path == "/" and url.query:
            query = parse_qs(url.query)
            if "login" in query:  # lien à usage unique de `ziggy`
                if not self.server.logins.redeem(query["login"][0]):
                    return self._json(403, {"error": "lien de connexion invalide, expiré ou déjà utilisé"})
            elif not same_secret(query.get("token", [""])[0], self.server.token):
                return self._json(403, {"error": "token invalide"})
            cookie = f"{self.server.cookie_name}={self.server.token}; HttpOnly; SameSite=Strict; Path=/"
            return self._send(303, headers={"Location": "/", "Set-Cookie": cookie})
        if url.path.startswith("/api/"):
            if not self._authenticated():
                return self._json(401, {"error": "non authentifié"})
            # Sessions à toujours renvoyer (agents épinglés ou rangés), identifiants validés.
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
                self.server.name_agents(sessions)  # avant la copie des réglages, pour y avoir les noms
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
                    "agents": self.server.agents.snapshot(),
                    "sessions": sessions,
                })
            if url.path == "/api/sessions":
                sessions = list_sessions(our_pids=self.server.our_pids(), include=include, windows=self.server.context_windows)
                self.server.name_agents(sessions)  # les nouveaux noms partent aussi en événement « agents »
                return self._json(200, {"sessions": sessions})
            if url.path == "/api/server":
                return self._json(200, self.server.info())
            if url.path == "/api/terminals":
                # Écran Configuration : les terminaux Claude Code ouverts, leur ouverture et leur mémoire.
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
                # ?limit=N (1 à 50, 5 par défaut) ; « more » dit s'il en reste au-delà.
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
                # Onglet Discussion : la session mise en forme ; « since » évite de la relire si rien n'a changé.
                params = parse_qs(url.query)
                session_id = params.get("session", [""])[0]
                if not transcripts.UUID_RE.match(session_id):
                    return self._json(400, {"error": "identifiant de session invalide"})
                path = transcripts.find_transcript(session_id)
                if path is None:
                    return self._json(404, {"error": "aucun historique pour cette session"})
                try:
                    signature = transcripts.signature(path)
                    if params.get("since", [""])[0] == signature:
                        return self._json(200, {"unchanged": True, "signature": signature})
                    return self._json(200, {**transcripts.read_transcript(path), "signature": signature})
                except OSError as exc:
                    return self._json(500, {"error": f"lecture impossible : {exc}"})
            if url.path == "/api/events":
                return self._stream_events()
            avatar = AVATAR_IMAGE_ROUTE.match(url.path)
            if avatar:
                image = self.server.agents.avatar_image(avatar.group(1))
                if image is None:
                    return self._json(404, {"error": "image introuvable"})
                # Une image ne change jamais sous son identifiant : le navigateur la garde.
                return self._send(200, image[0], image[1], {**RAW_FILE_HEADERS, "Cache-Control": "private, max-age=31536000, immutable"})
            return self._json(404, {"error": "route inconnue"})
        # Adresse d'un ticket (/t/42) : dans le navigateur de l'utilisateur, la page, qui ouvre la fiche ;
        # pour un agent (sans cookie, avec la clé du lien), le ticket en texte. Fichiers joints : clé exigée.
        page = TICKET_PAGE_ROUTE.match(url.path)
        file_link = TICKET_FILE_LINK_ROUTE.match(url.path)
        if file_link or (page and not self._authenticated()):
            return self._ticket_link(url, page, file_link)
        return self._static("/" if page else url.path)

    def do_POST(self):
        hook = HOOK_ROUTE.match(urlsplit(self.path).path)
        if hook:
            return self._hook(hook.group(1))  # Claude Code dans un terminal : son propre token
        if urlsplit(self.path).path == "/mcp":
            return self._mcp()  # outils MCP des agents : leur propre clé
        if not self._host_ok() or not self._origin_ok():
            return self._json(403, {"error": "origine refusée"})
        if not self._authenticated():
            return self._json(401, {"error": "non authentifié"})
        path = urlsplit(self.path).path
        try:
            limit = (MAX_FILE_BODY if path == "/api/files/write" else MAX_PDF_BODY if path == "/api/pdf"
                     else MAX_KANBAN_FILE_BODY if KANBAN_FILES_ROUTE.match(path) else MAX_BODY)
            body = self._read_json(limit)
        except ValueError as exc:
            return self._json(400, {"error": str(exc)})
        conversations = self.server.conversations
        try:
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
                # Redémarrage propre : start (pause des agents au travail, attente), force (tout de suite), cancel.
                action = body.get("action")
                if action == "start":
                    self.server.restart.request()
                elif action == "force":
                    self.server.restart.force()
                elif action == "cancel":
                    self.server.restart.cancel()
                else:
                    return self._json(400, {"error": "action inconnue (start, force ou cancel)"})
                return self._json(200, self.server.info())
            if path == "/api/pins":
                try:
                    return self._json(200, {"pins": self.server.pins.set(body.get("pins"))})
                except ValueError as exc:
                    return self._json(400, {"error": str(exc)})
            if path == "/api/shortcuts":
                try:
                    shortcuts = self.server.shortcuts.set(body.get("scope"), body.get("owner"), body.get("items"))
                except ValueError as exc:
                    return self._json(400, {"error": str(exc)})
                return self._json(200, {"shortcuts": shortcuts})
            if path == "/api/workspaces":
                return self._json(200, self.server.workspaces.create(body.get("name")))
            if path == "/api/folders/create":
                # Nouveau sous-dossier pour un agent : renvoie le contenu du dossier créé.
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
                else:
                    found = workspaces.remove_agent(workspace_id, body.get("agent"))
                if not found:
                    return self._json(404, {"error": "workspace inconnu"})
                return self._json(200, {"workspaces": workspaces.list()})
            match = CONVERSATION_ROUTE.match(path)
            if match:
                conversation_id, action = match.groups()
                conversation = conversations.get(conversation_id)
                if conversation is None:
                    return self._json(404, {"error": "agent inconnu"})
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
                    # « !! commande » dans la Discussion : console dans le dossier de l'agent, sans Claude.
                    run_id = self.server.shell.start(conversation_id, conversation.cwd, body.get("command"))
                    return self._json(200, {"run": run_id})
                elif action == "shell-stop":
                    if body.get("run") not in self.server.shell.running(conversation_id):
                        return self._json(404, {"error": "commande terminée ou inconnue"})
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
        return self._json(404, {"error": "route inconnue"})

    # --- mode Tâches : tableaux Kanban ------------------------------------------------------

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
                    return self._json(404, {"error": "fichier introuvable"})
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
                # Lien à partager (avec sa clé de lecture), pour le bouton « Copier le lien ».
                number = next((t["number"] for t in board.index() if t["id"] == match.group(1)), None)
                if number is None:
                    raise KeyError("ticket inconnu")
                return self._json(200, {"path": ticket_links.ticket_path(self.server.token, number)})
        except KeyError as exc:
            return self._json(404, {"error": exc.args[0]})
        return self._json(404, {"error": "route inconnue"})

    def _ticket_link(self, url, page, file_link):
        """Ticket lu par un agent grâce à la clé de son lien : texte Markdown, ou un fichier joint."""
        number = int((page or file_link).group(1))
        if not ticket_links.valid(self.server.token, number, parse_qs(url.query).get("k", [""])[0]):
            return self._send(401, "Lien de ticket sans clé valide : copie le lien depuis la fiche du ticket "
                                   "(bouton « Copier le lien »).\n".encode(), "text/plain; charset=utf-8")
        try:
            export = self.server.kanban.export(number)
            if file_link:
                file_path, name, media_type = self.server.kanban.file(export["ticket"]["id"], file_link.group(2))
                size, file = file_path.stat().st_size, file_path.open("rb")
                with file:
                    return self._send_file(name, media_type, size, file)
        except (KeyError, OSError):
            return self._send(404, f"Ticket #{number} ou fichier introuvable (supprimé ?).\n".encode(), "text/plain; charset=utf-8")
        text = ticket_links.render(export, self.server.token, f"http://{self.headers.get('Host')}")
        # Texte brut (Markdown) : lisible tel quel par un agent comme dans un navigateur.
        return self._send(200, text.encode(), "text/plain; charset=utf-8")

    def _kanban_post(self, path, body):
        """Tableaux, colonnes, tickets, fichiers joints, workspaces et épingles du mode Tâches."""
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
                    kb.get(body.get("board"))  # tableau existant (KeyError sinon)
                    found = workspaces.add_agent(workspace_id, body.get("board"))
                else:
                    found = workspaces.remove_agent(workspace_id, body.get("board"))
                if not found:
                    return self._json(404, {"error": "workspace inconnu"})
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
                    kb.update_ticket(ticket_id, {k: body[k] for k in ("title", "description") if k in body})
                elif action == "move":
                    kb.move_ticket(ticket_id, body.get("column"), body.get("index"))
                elif action == "delete":
                    kb.delete_ticket(ticket_id)
                else:
                    try:
                        data = base64.b64decode(body.get("data") or "", validate=True)
                    except (ValueError, TypeError):
                        raise ValueError("fichier mal encodé") from None
                    return self._json(200, kb.add_file(ticket_id, body.get("name"), body.get("type"), data))
                return self._json(200, {"ok": True})
            match = KANBAN_FILE_DELETE_ROUTE.match(path)
            if match:
                kb.delete_file(*match.groups())
                return self._json(200, {"ok": True})
        except KeyError as exc:
            return self._json(404, {"error": exc.args[0]})
        return self._json(404, {"error": "route inconnue"})

    def _git_read(self, url):
        """Lecture git : état, historique, détail d'un commit, diff d'un fichier."""
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
        return self._json(404, {"error": "route inconnue"})

    def _files_read(self, url):
        """Onglet Fichiers : contenu d'un dossier, lecture d'un fichier, image brute, recherche."""
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
            return self._json(400, {"error": f"lecture impossible : {exc.strerror or exc}"})
        return self._json(404, {"error": "route inconnue"})

    def _files_write(self, body):
        """Enregistre un fichier texte modifié dans l'onglet Fichiers ; 409 s'il a changé entre-temps."""
        try:
            return self._json(200, agent_files.write_file(body.get("path"), body.get("file"), body.get("content"),
                                                    body.get("version")))
        except agent_files.FileConflict as exc:
            return self._json(409, {"error": str(exc), "version": exc.version})
        except ValueError as exc:
            return self._json(400, {"error": str(exc)})
        except OSError as exc:
            return self._json(400, {"error": f"écriture impossible : {exc.strerror or exc}"})

    def _git_action(self, action, body):
        """Action git ; renvoie la sortie de git et l'état à jour du dépôt."""
        path = body.get("path")
        files = body.get("files")
        try:
            if action == "message":
                # Message de commit proposé par Claude, à relire avant de commiter.
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
        """Renommer, supprimer (retirer de ziggy-one, historique gardé) ou restaurer un agent."""
        key = body.get("agent")
        if not is_agent_key(key):
            return self._json(400, {"error": "identifiant d'agent invalide"})
        agents = self.server.agents
        if action == "rename":
            closed = self.server.rename_agent(key, body.get("name"))
            return self._json(200, {"agents": agents.snapshot(), "terminalClosed": closed})
        elif action == "avatar":
            # Image recadrée par le navigateur, envoyée en base64 ; sans image, l'agent garde la sienne.
            raw = body.get("image")
            try:
                image = base64.b64decode(raw, validate=True) if isinstance(raw, str) else None
            except binascii.Error:
                return self._json(400, {"error": "image invalide"})
            agents.set_avatar(key, body.get("avatar"), image)
        elif action == "options":
            # Pris en compte à la prochaine ouverture de Claude Code dans le Terminal.
            agents.set_options(key, body.get("options"))
            return self._json(200, {"agents": agents.snapshot()})
        elif action == "role":
            # Donné aux autres agents au démarrage de leur session (annuaire, hook SessionStart).
            agents.set_role(key, body.get("role"))
            return self._json(200, {"agents": agents.snapshot()})
        elif action == "restore":
            hidden = agents.restore(key)
            if not hidden:
                return self._json(404, {"error": "agent non supprimé"})
            self.server._reopen_restored(key, hidden)
        else:
            # Tous les identifiants de l'agent (session, copie, discussion), pour le retirer de partout.
            other_keys = body.get("keys") if isinstance(body.get("keys"), list) else []
            keys = {key, *(k for k in other_keys[:10] if is_agent_key(k))}
            conversation_id = body.get("conversation")
            if isinstance(conversation_id, str):
                self.server.terminals.stop(conversation_id)  # ferme Claude Code s'il tourne ici
                self.server.conversations.remove(conversation_id)
            self.server.workspaces.remove_agent_everywhere(keys)
            agents.hide(key, body.get("label"), body.get("cwd"))
        return self._json(200, {"agents": agents.snapshot()})

    def _open_conversation(self, body):
        """Ouvre une discussion : vierge, ou pour reprendre une session (sans rien lancer avant le 1er message)."""
        resume = body.get("resume")
        label = body.get("label") if isinstance(body.get("label"), str) else ""
        cwd = None
        if resume is None and body.get("cwd") is not None:
            # Nouvel agent dans le dossier choisi.
            try:
                cwd = str(resolve_dir(body.get("cwd")))
            except ValueError as exc:
                return self._json(400, {"error": str(exc)})
        if resume is not None:
            if not isinstance(resume, str) or not transcripts.UUID_RE.match(resume):
                return self._json(400, {"error": "identifiant de session invalide"})
            # Session ouverte (registre) ou passée (transcript sur disque).
            session = next((s for s in list_active_sessions() if s["sessionId"] == resume), None)
            if session is not None:
                cwd = session.get("cwd")
            else:
                path = transcripts.find_transcript(resume)
                if path is None:
                    return self._json(400, {"error": "session introuvable"})
                cwd = transcripts.transcript_cwd(path)
            if not isinstance(cwd, str) or not os.path.isdir(cwd):
                return self._json(400, {"error": "le dossier de cette session n'existe plus"})
        conversation = self.server.conversations.open(resume=resume, cwd=cwd, label=label[:200])
        self.server.name_agents()
        return self._json(200, conversation.status())

    def _hook(self, event):
        """Hook de Claude Code dans un terminal (ziggy_hook.py) : début ou fin d'un tour d'un agent."""
        authorization = self.headers.get("Authorization", "")
        if not self._host_ok() or not same_secret(authorization, f"Bearer {self.server.hook_token}"):
            return self._json(403, {"error": "accès refusé"})
        try:
            payload = self._read_json()
        except ValueError as exc:
            return self._json(400, {"error": str(exc)})
        conversation = self.server.conversations.get(parse_qs(urlsplit(self.path).query).get("conversation", [""])[0])
        if conversation is None:
            return self._send(200, b"", "text/plain; charset=utf-8")  # agent fermé entre-temps : rien à faire
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
        """Fichier ouvert dans un onglet, depuis notre origine : seuls les images et les PDF gardent leur type ;
        un texte (HTML, SVG compris) s'affiche en texte brut ; le reste se télécharge. Le bac à sable CSP
        empêche tout script.
        """
        quoted = quote(name, safe="")
        if media_type in media.IMAGE_TYPES or media_type == "application/pdf":
            content_type, disposition = media_type, "inline"
        elif media.is_text(name, media_type):
            content_type, disposition = "text/plain; charset=utf-8", "inline"
        else:
            content_type, disposition = "application/octet-stream", "attachment"
        # Le lecteur PDF de Chrome ne s'ouvre pas dans un bac à sable : un PDF n'exécute de toute façon
        # pas de script de la page.
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
        target = (WEB_DIR / relative).resolve()
        if not target.is_relative_to(WEB_DIR) or not target.is_file():
            return self._json(404, {"error": "introuvable"})
        content_type = MIME.get(target.suffix)
        if content_type is None:
            return self._json(404, {"error": "introuvable"})
        body = target.read_bytes()
        headers = None
        if relative == "index.html":
            # Nonce de styles, nouveau à chaque chargement : seuls nos scripts peuvent créer des <style>
            # (le terminal xterm.js en a besoin) ; du balisage injecté, lui, resterait bloqué. Attributs style
            # permis : xterm.js y pose les couleurs exactes (24 bits) du texte, sans quoi Claude Code s'affiche
            # sans ses couleurs. Un attribut style ne peut ni charger ni exécuter quoi que ce soit.
            nonce = secrets.token_urlsafe(16)
            body = body.replace(b"__CSP_NONCE__", nonce.encode())
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
                self.wfile.write(payload.encode())
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            self.server.bus.unsubscribe(q)


def build_claude_args(model=None, permission_mode=None, allowed_tools=(), chrome=False):
    """Options passées à chaque processus `claude` de la conversation."""
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
        # Option variadique : toujours en dernier dans la ligne de commande.
        args += ["--allowedTools", *tools]
    return args


def git_version():
    """Commit du code en cours d'exécution (« 7185ee0 »), ou None hors d'un dépôt git."""
    try:
        result = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=Path(__file__).resolve().parent,
                                capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return result.stdout.strip() or None


def ziggy_listens(port):
    """Vrai si c'est un serveur ziggy-one qui répond sur ce port (en-tête Server)."""
    try:
        with urlopen(f"http://127.0.0.1:{port}/api/state", timeout=3) as response:
            server_header = response.headers.get("Server", "")
    except HTTPError as error:  # 401 sans cookie : la réponse dit quand même qui répond
        server_header = error.headers.get("Server", "")
    except (URLError, OSError):
        return False
    return server_header.startswith("ziggy-one")


def show_login(port, token, open_browser):
    """Adresse à garder en favori, et lien de connexion à usage unique : ouvert dans le navigateur ou affiché."""
    address = f"http://127.0.0.1:{port}/"
    link = f"{address}?login={login_links.make(token)}"
    print(f"ziggy-one → {address}", flush=True)
    if open_browser and webbrowser.open(link):
        print("interface ouverte dans le navigateur", flush=True)
    else:
        minutes = login_links.LIFETIME // 60
        print(f"connexion (lien à usage unique, valable {minutes} min) : {link}", flush=True)
        print("relancer `ziggy` en donne un nouveau", flush=True)


def main():
    parser = argparse.ArgumentParser(description="Pilote une session Claude Code locale.")
    parser.add_argument("--port", type=int, default=6767)
    parser.add_argument("--cwd", default=os.getcwd(),
                        help="dossier de travail des nouvelles discussions (défaut : dossier courant)")
    parser.add_argument("--model", help="modèle de la conversation (défaut : celui de Claude Code)")
    parser.add_argument("--permission-mode",
                        choices=["default", "acceptEdits", "plan", "auto", "dontAsk"],
                        help="mode de permission de la conversation")
    parser.add_argument("--allowed-tools", nargs="*", default=[],
                        help='règles d\'outils autorisés, ex. "Bash(git status)" "Edit"')
    parser.add_argument("--chrome", action="store_true",
                        help="active Claude in Chrome et autorise ses outils")
    parser.add_argument("--new-token", action="store_true",
                        help="génère un nouveau token d'accès (les onglets ouverts devront utiliser la nouvelle adresse)")
    parser.add_argument("--open", action="store_true",
                        help="ouvre l'interface dans le navigateur, déjà connectée (lien à usage unique)")
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
            sys.exit(f"ziggy-one : le port {args.port} est déjà pris par un autre programme (essayer --port)")
        # Déjà lancé : on ouvre seulement l'interface, avec le token du serveur qui tourne.
        print(f"ziggy-one tourne déjà sur le port {args.port}", flush=True)
        show_login(args.port, persistent_token(default_data_dir() / "token"), args.open)
        return
    threading.Thread(target=server.usage.probe, daemon=True).start()

    # `kill` (SIGTERM) arrête le serveur aussi proprement que Ctrl+C : les terminaux Claude Code sont fermés.
    def interrupt(signum, frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupt)

    # Jamais le token lui-même à l'écran ni dans un journal : un lien qui ne sert qu'une fois.
    show_login(server.server_address[1], server.token, args.open)
    # Après un redémarrage demandé depuis l'interface : rouvre les terminaux et fait reprendre les agents.
    threading.Thread(target=server.restart.resume_after_restart, daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    if server.restart.requested:
        # Même commande, même processus (journal et terminal conservés) ; --new-token ne doit pas se rejouer.
        # --open non plus : les onglets ouverts se reconnectent seuls.
        argv = [arg for arg in sys.argv[1:] if arg not in ("--new-token", "--open")]
        print("ziggy-one : redémarrage demandé depuis l'interface", flush=True)
        os.execv(sys.executable, [sys.executable, str(Path(__file__).resolve()), *argv])


if __name__ == "__main__":
    main()

"""Read-only access to Claude Code transcripts: ~/.claude/projects/<folder>/<sessionId>.jsonl

The format is not officially documented: parsing is defensive. Only known types are kept
and the rest is ignored, so a format change gives at worst an incomplete history,
never an error.
"""

import json
import re
import threading
from pathlib import Path

from activity import split_shared
from context import is_compact_boundary, used_tokens

PROJECTS_DIR = Path.home() / ".claude" / "projects"
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

MAX_PROMPT = 200
TAIL_BYTES = 256 * 1024
MAX_CACHED = 2000
# Conversation tab: conversation read back and formatted (read-only).
MAX_MESSAGES = 500
MAX_TEXT = 8000
MAX_TOOL_INPUT = 2000
MAX_TOOL_RESULT = 1500
MAX_SUBAGENTS = 50  # subagents read per session (the last ones launched)
MAX_SUBAGENT_MESSAGES = 200
SUBAGENT_TOOLS = ("Agent", "Task")
# Fields of an action that summarize it (command, file, pattern…), kept even when its input is too long.
SUMMARY_FIELDS = ("command", "description", "file_path", "notebook_path", "path", "pattern", "url", "query", "prompt",
                  "subagent_type")

# Summaries already read, per file: read again only if the file changed (modification time, size).
_summaries = {}
_summaries_lock = threading.Lock()


def _entries(path):
    with path.open(encoding="utf-8", errors="replace") as file:
        for line in file:
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            if isinstance(entry, dict):
                yield entry


def _clip(text, limit):
    return text if len(text) <= limit else text[:limit] + "…"


def find_transcript(session_id, projects_dir=PROJECTS_DIR):
    """Path of a session's transcript, whatever its project folder. None if missing."""
    if not isinstance(session_id, str) or not UUID_RE.match(session_id):
        return None
    return next(projects_dir.glob(f"*/{session_id}.jsonl"), None)


def transcript_cwd(path):
    """Working folder of the session, read from the first entry that gives it."""
    for entry in _entries(path):
        if isinstance(entry.get("cwd"), str):
            return entry["cwd"]
    return None


def last_assistant_text(path):
    """Last text of the main agent in a session (end of turn, Stop hook); "" if there is none."""
    text = ""
    with Path(path).open("rb") as file:
        size = file.seek(0, 2)
        file.seek(max(0, size - TAIL_BYTES))
        if size > TAIL_BYTES:
            file.readline()  # line cut by the seek
        for raw in file:
            try:
                entry = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(entry, dict) or entry.get("type") != "assistant" or entry.get("isSidechain"):
                continue
            content = (entry.get("message") or {}).get("content") if isinstance(entry.get("message"), dict) else None
            parts = [b.get("text", "") for b in content or [] if isinstance(b, dict) and b.get("type") == "text"]
            if any(part.strip() for part in parts):
                text = "\n".join(parts).strip()
    return text


def signature(path):
    """File fingerprint (time and size): the Conversation tab reads the session again only if it changed."""
    stat = Path(path).stat()
    return f"{stat.st_mtime_ns}:{stat.st_size}"


def _result_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                parts.append(str(item.get("text", "")))
            else:
                parts.append(f"[{item.get('type') if isinstance(item, dict) else '?'}]")
        return "\n".join(parts)
    return ""


def _clean_block(block):
    if not isinstance(block, dict):
        return None
    kind = block.get("type")
    if kind == "text":
        return {"type": "text", "text": _clip(str(block.get("text", "")), MAX_TEXT)}
    if kind == "tool_use":
        tool_input = block.get("input")
        raw = json.dumps(tool_input, ensure_ascii=False)
        if len(raw) > MAX_TOOL_INPUT:
            # Input too long (big file written…): its short, readable fields, shortened.
            tool_input = {
                key: _clip(value, 500) for key, value in (tool_input.items() if isinstance(tool_input, dict) else [])
                if key in SUMMARY_FIELDS and isinstance(value, str)
            }
            tool_input["truncated"] = True
        return {"type": "tool_use", "id": block.get("id"), "name": block.get("name"), "input": tool_input}
    if kind == "tool_result":
        return {
            "type": "tool_result",
            "toolUseId": block.get("tool_use_id"),
            "is_error": bool(block.get("is_error")),
            "content": _clip(_result_text(block.get("content")), MAX_TOOL_RESULT),
        }
    if kind in ("thinking", "redacted_thinking"):
        return None
    # Image, document…: only the type is kept, not the content.
    return {"type": str(kind)}


def _clean_message(entry):
    message = entry.get("message")
    if not isinstance(message, dict):
        return None
    content = message.get("content")
    shared = None
    if entry["type"] == "user" and isinstance(content, str):
        # Old sessions: shared context added to the message by ziggy-one, shown separately.
        shared, content = split_shared(content)
    if isinstance(content, str):
        blocks = [{"type": "text", "text": _clip(content, MAX_TEXT)}]
    elif isinstance(content, list):
        blocks = [block for block in map(_clean_block, content) if block]
    else:
        return None
    if not blocks:
        return None
    cleaned = {"id": entry.get("uuid"), "role": entry["type"], "timestamp": entry.get("timestamp"), "content": blocks}
    if shared:
        cleaned["shared"] = _clip(shared, MAX_TEXT)
    return cleaned


def read_transcript(path):
    """Main conversation of a session, for the Conversation tab.

    Entries form a tree (parentUuid): rewinds and subagents create branches.
    We start from the last message of the main conversation and walk up the chain.
    """
    by_uuid = {}
    leaf = None
    cost = None
    for entry in _entries(path):
        uuid = entry.get("uuid")
        if isinstance(uuid, str):
            by_uuid[uuid] = entry
        kind = entry.get("type")
        if kind in ("user", "assistant") and isinstance(uuid, str) and not entry.get("isSidechain"):
            leaf = uuid
        elif kind == "cost-state":
            cost = entry.get("totalCostUSD")

    chain = []
    seen = set()
    uuid = leaf
    while uuid in by_uuid and uuid not in seen:
        seen.add(uuid)
        entry = by_uuid[uuid]
        chain.append(entry)
        # After a compaction, the link to the pre-compaction part goes through logicalParentUuid.
        uuid = entry.get("parentUuid") or entry.get("logicalParentUuid")
    chain.reverse()

    messages = []
    for entry in chain:
        if entry.get("type") in ("user", "assistant") and not entry.get("isMeta"):
            message = _clean_message(entry)
            if message:
                messages.append(message)
    truncated = len(messages) > MAX_MESSAGES
    messages = messages[-MAX_MESSAGES:]
    launched = [
        block["id"] for message in messages for block in message["content"]
        if block["type"] == "tool_use" and block.get("name") in SUBAGENT_TOOLS and isinstance(block.get("id"), str)
    ]
    return {
        "sessionId": path.stem,
        "costUsd": cost if isinstance(cost, (int, float)) else None,
        "truncated": truncated,
        "messages": messages,
        "subagents": read_subagents(path, launched[-MAX_SUBAGENTS:]),
    }


def read_subagents(path, tool_use_ids):
    """Work of the subagents launched in the session, keyed by Agent tool call.

    Claude Code saves them separately: <session>/subagents/agent-<id>.jsonl, with a .meta.json that
    gives the call (toolUseId), the description and the agent type.
    """
    folder = path.parent / path.stem / "subagents"
    wanted = set(tool_use_ids)
    if not wanted or not folder.is_dir():
        return {}
    subagents = {}
    for meta_path in folder.glob("agent-*.meta.json"):
        try:
            meta = json.loads(meta_path.read_text())
        except (OSError, ValueError):
            continue
        tool_use_id = meta.get("toolUseId") if isinstance(meta, dict) else None
        transcript = meta_path.with_name(meta_path.name.removesuffix(".meta.json") + ".jsonl")
        if tool_use_id not in wanted or not transcript.is_file():
            continue
        messages = []
        try:
            for entry in _entries(transcript):
                if entry.get("type") in ("user", "assistant") and not entry.get("isMeta"):
                    message = _clean_message(entry)
                    if message:
                        messages.append(message)
        except OSError:
            continue
        subagents[tool_use_id] = {
            "description": str(meta.get("description") or ""),
            "type": str(meta.get("agentType") or ""),
            "finished": bool(meta.get("finished")),
            "truncated": len(messages) > MAX_SUBAGENT_MESSAGES,
            "messages": messages[-MAX_SUBAGENT_MESSAGES:],
        }
    return subagents


def summarize(path):
    """Summary of a session for the list, read again only if its file changed since last time."""
    stat = path.stat()
    signature = (stat.st_mtime_ns, stat.st_size)
    with _summaries_lock:
        cached = _summaries.get(path)
    if cached and cached[0] == signature:
        return dict(cached[1])  # copy: the caller may modify it
    summary = _summarize(path, stat)
    with _summaries_lock:
        if len(_summaries) >= MAX_CACHED:
            _summaries.clear()
        _summaries[path] = (signature, summary)
    return dict(summary)


def _summarize(path, stat):
    """Summary of a session: only the end of the file is read."""
    last_prompt = None
    cost = None
    context_tokens = None
    model = None
    with path.open("rb") as file:
        if stat.st_size > TAIL_BYTES:
            file.seek(-TAIL_BYTES, 2)
            file.readline()  # line cut by the seek
        for raw in file:
            try:
                entry = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(entry, dict):
                continue
            if entry.get("type") == "last-prompt" and isinstance(entry.get("lastPrompt"), str):
                last_prompt = split_shared(entry["lastPrompt"])[1]
            elif entry.get("type") == "cost-state":
                cost = entry.get("totalCostUSD")
            elif entry.get("type") == "assistant" and not entry.get("isSidechain"):
                message = entry.get("message") if isinstance(entry.get("message"), dict) else {}
                tokens = used_tokens(message.get("usage"))
                if tokens is not None:
                    context_tokens, model = tokens, message.get("model")
            elif is_compact_boundary(entry):
                context_tokens = None
    return {
        "sessionId": path.stem,
        "cwd": transcript_cwd(path),
        "updatedAt": stat.st_mtime,
        "lastPrompt": _clip(last_prompt, MAX_PROMPT) if last_prompt else None,
        "costUsd": cost if isinstance(cost, (int, float)) else None,
        "contextTokens": context_tokens,
        "model": model if isinstance(model, str) else None,
    }


def list_recent(limit=50, projects_dir=PROJECTS_DIR):
    """Most recent sessions, across all folders."""
    candidates = []
    for path in projects_dir.glob("*/*.jsonl"):
        if not UUID_RE.match(path.stem):
            continue
        try:
            candidates.append((path.stat().st_mtime, path))
        except OSError:
            continue
    candidates.sort(reverse=True)
    sessions = []
    for _, path in candidates[:limit]:
        try:
            sessions.append(summarize(path))
        except OSError:
            continue
    return sessions

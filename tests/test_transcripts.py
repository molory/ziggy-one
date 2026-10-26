"""Tests de la lecture des transcripts Claude Code : python3 -m unittest discover -s tests"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import transcripts  # noqa: E402
from activity import with_shared  # noqa: E402

SESSION_ID = "11111111-2222-4333-8444-555555555555"
CWD = "/home/test/mon.projet"


def entry(kind, uuid, parent, content, **extra):
    return {
        "type": kind, "uuid": uuid, "parentUuid": parent, "sessionId": SESSION_ID, "cwd": CWD,
        "timestamp": "2026-10-20T10:00:00Z", "message": {"role": kind, "content": content}, **extra,
    }


# Conversation principale : a → b → c → d → g (pièce jointe) → h.
# « x » est une branche abandonnée (retour en arrière), « side » un sous-agent.
LINES = [
    entry("user", "a", None, "Bonjour"),
    entry("assistant", "b", "a", [{"type": "thinking", "thinking": "..."}, {"type": "text", "text": "Salut"}]),
    entry("user", "x", "b", "Branche abandonnée"),
    entry("assistant", "c", "b", [{"type": "tool_use", "id": "t1", "name": "Read", "input": {"file_path": "a.py"}}]),
    entry("user", "d", "c", [{"type": "tool_result", "tool_use_id": "t1", "content": "x" * 5000, "is_error": False}]),
    entry("assistant", "side", "d", [{"type": "text", "text": "Sous-agent"}], isSidechain=True),
    {"type": "attachment", "uuid": "g", "parentUuid": "d", "attachment": {}},
    entry("user", "meta", "g", "<caveat>interne</caveat>", isMeta=True),
    entry("assistant", "h", "g", [{"type": "text", "text": "Fini"}, {"type": "image", "source": {"data": "AAAA"}}]),
    {"type": "cost-state", "totalCostUSD": 0.42},
    {"type": "last-prompt", "lastPrompt": "Bonjour", "leafUuid": "a"},
    {"type": "type-inconnu", "foo": 1},
]


class TranscriptTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.projects = Path(self.tmp.name)
        self.project = self.projects / "-home-test-mon-projet"
        self.project.mkdir()
        self.path = self.project / f"{SESSION_ID}.jsonl"
        lines = [json.dumps(line) for line in LINES]
        lines.insert(3, "pas du json")
        lines.insert(5, "[1, 2]")
        self.path.write_text("\n".join(lines) + "\n")

    def test_find_transcript_validates_id(self):
        self.assertEqual(transcripts.find_transcript(SESSION_ID, self.projects), self.path)
        self.assertIsNone(transcripts.find_transcript("../../etc/passwd", self.projects))
        self.assertIsNone(transcripts.find_transcript("*", self.projects))
        self.assertIsNone(transcripts.find_transcript("99999999-2222-4333-8444-555555555555", self.projects))

    def test_read_follows_main_branch_only(self):
        transcript = transcripts.read_transcript(self.path)
        self.assertEqual(transcript["sessionId"], SESSION_ID)
        self.assertEqual(transcript["costUsd"], 0.42)
        self.assertFalse(transcript["truncated"])
        messages = transcript["messages"]
        self.assertEqual([m["role"] for m in messages], ["user", "assistant", "assistant", "user", "assistant"])
        self.assertEqual(messages[0]["content"], [{"type": "text", "text": "Bonjour"}])
        # La réflexion est retirée, l'image réduite à son type.
        self.assertEqual(messages[1]["content"], [{"type": "text", "text": "Salut"}])
        self.assertEqual(messages[4]["content"], [{"type": "text", "text": "Fini"}, {"type": "image"}])
        self.assertEqual(messages[2]["content"][0]["name"], "Read")
        result = messages[3]["content"][0]
        self.assertEqual(result["type"], "tool_result")
        self.assertEqual(len(result["content"]), transcripts.MAX_TOOL_RESULT + 1)

    def test_read_survives_parent_cycle(self):
        cycle = [entry("user", "p", "q", "un"), entry("assistant", "q", "p", [{"type": "text", "text": "deux"}])]
        self.path.write_text("\n".join(json.dumps(line) for line in cycle))
        self.assertEqual(len(transcripts.read_transcript(self.path)["messages"]), 2)

    def test_read_truncates_long_sessions(self):
        many = [entry("user", f"u{i}", f"u{i - 1}" if i else None, f"m{i}") for i in range(transcripts.MAX_MESSAGES + 10)]
        self.path.write_text("\n".join(json.dumps(line) for line in many))
        transcript = transcripts.read_transcript(self.path)
        self.assertTrue(transcript["truncated"])
        self.assertEqual(len(transcript["messages"]), transcripts.MAX_MESSAGES)
        self.assertEqual(transcript["messages"][-1]["content"][0]["text"], f"m{transcripts.MAX_MESSAGES + 9}")

    def test_subagents_are_read_from_their_own_files(self):
        launch = {"type": "tool_use", "id": "toolu_1", "name": "Agent", "input": {"description": "Lister", "prompt": "ls"}}
        self.path.write_text("\n".join(json.dumps(e) for e in [
            {"type": "user", "uuid": "u1", "parentUuid": None, "cwd": CWD, "message": {"role": "user", "content": "go"}},
            {"type": "assistant", "uuid": "a1", "parentUuid": "u1", "message": {"role": "assistant", "content": [launch]}},
        ]) + "\n")
        folder = self.project / SESSION_ID / "subagents"
        folder.mkdir(parents=True)
        (folder / "agent-x1.meta.json").write_text(json.dumps(
            {"agentType": "Explore", "description": "Lister", "toolUseId": "toolu_1", "finished": True}))
        (folder / "agent-x1.jsonl").write_text("\n".join(json.dumps(e) for e in [
            {"type": "user", "isSidechain": True, "message": {"role": "user", "content": "ls"}},
            {"type": "attachment", "isSidechain": True},
            {"type": "assistant", "isSidechain": True, "message": {"role": "assistant", "content": [{"type": "text", "text": "a.txt"}]}},
        ]) + "\n")
        (folder / "agent-x2.meta.json").write_text(json.dumps({"toolUseId": "toolu_absent"}))  # appel hors historique
        transcript = transcripts.read_transcript(self.path)
        self.assertEqual(transcript["messages"][1]["content"][0]["id"], "toolu_1")
        subagent = transcript["subagents"]["toolu_1"]
        self.assertEqual((subagent["type"], subagent["description"], subagent["finished"]), ("Explore", "Lister", True))
        self.assertEqual([m["role"] for m in subagent["messages"]], ["user", "assistant"])
        self.assertEqual(list(transcript["subagents"]), ["toolu_1"])

    def test_long_tool_input_keeps_its_summary_fields(self):
        command = "printf '%s' " + "x" * 3000
        self.path.write_text(json.dumps({"type": "assistant", "uuid": "a1", "message": {"content": [
            {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": command, "timeout": 5}}]}}) + "\n")
        tool = transcripts.read_transcript(self.path)["messages"][0]["content"][0]
        self.assertEqual(set(tool["input"]), {"command", "tronqué"})
        self.assertTrue(tool["input"]["command"].startswith("printf '%s' xxx"))
        self.assertLessEqual(len(tool["input"]["command"]), 501)

    def test_signature_changes_with_the_file(self):
        before = transcripts.signature(self.path)
        with self.path.open("a") as file:
            file.write("{}\n")
        self.assertNotEqual(transcripts.signature(self.path), before)

    def test_transcript_cwd(self):
        self.assertEqual(transcripts.transcript_cwd(self.path), CWD)

    def test_list_recent_spans_all_folders(self):
        other_project = self.projects / "-autre"
        other_project.mkdir()
        other = other_project / "22222222-2222-4333-8444-555555555555.jsonl"
        other.write_text(
            json.dumps({"type": "user", "cwd": "/autre", "message": {"content": "x"}}) + "\n"
            + json.dumps({"type": "last-prompt", "lastPrompt": "Plus récent"}) + "\n"
        )
        os.utime(self.path, (1_000, 1_000))
        (self.project / "pas-une-session.jsonl").write_text("{}")
        recent = transcripts.list_recent(projects_dir=self.projects)
        self.assertEqual([(s["lastPrompt"], s["cwd"]) for s in recent], [("Plus récent", "/autre"), ("Bonjour", CWD)])
        self.assertEqual(recent[1]["costUsd"], 0.42)
        self.assertEqual(len(transcripts.list_recent(limit=1, projects_dir=self.projects)), 1)

    def test_summarize_reads_only_the_tail(self):
        padding = json.dumps({"type": "last-prompt", "lastPrompt": "trop ancien"})
        filler = "\n".join([json.dumps({"type": "bruit", "data": "y" * 1000})] * 400)
        self.path.write_text(f"{padding}\n{filler}\n{json.dumps({'type': 'last-prompt', 'lastPrompt': 'récent'})}\n")
        self.assertGreater(self.path.stat().st_size, transcripts.TAIL_BYTES)
        self.assertEqual(transcripts.summarize(self.path)["lastPrompt"], "récent")

    def test_shared_context_is_kept_apart_from_the_user_message(self):
        sent = with_shared("Ziggy slave a fusionné", "Relance le serveur")
        self.path.write_text("\n".join(json.dumps(e) for e in [
            {"type": "user", "uuid": "u1", "parentUuid": None, "cwd": CWD, "message": {"role": "user", "content": sent}},
            {"type": "last-prompt", "lastPrompt": sent},
        ]) + "\n")
        # Anciennes sessions (contexte partagé alors ajouté au message) : la liste montre le message seul.
        self.assertEqual(transcripts.summarize(self.path)["lastPrompt"], "Relance le serveur")

    def test_summarize_rereads_only_changed_files(self):
        self.path.write_text(json.dumps({"type": "last-prompt", "lastPrompt": "premier"}) + "\n")
        with mock.patch.object(transcripts, "_summarize", wraps=transcripts._summarize) as reads:
            first = transcripts.summarize(self.path)
            first["lastPrompt"] = "modifié par l'appelant"  # copie : le cache n'est pas touché
            self.assertEqual(transcripts.summarize(self.path)["lastPrompt"], "premier")
            self.assertEqual(reads.call_count, 1)  # fichier inchangé : pas relu
            with self.path.open("a") as file:
                file.write(json.dumps({"type": "last-prompt", "lastPrompt": "second"}) + "\n")
            self.assertEqual(transcripts.summarize(self.path)["lastPrompt"], "second")
            self.assertEqual(reads.call_count, 2)

    def test_last_assistant_text_is_the_end_of_the_turn(self):
        self.path.write_text("\n".join(json.dumps(e) for e in [
            {"type": "assistant", "message": {"content": [{"type": "text", "text": "Premier"}]}},
            {"type": "assistant", "isSidechain": True, "message": {"content": [{"type": "text", "text": "Sous-agent"}]}},
            {"type": "assistant", "message": {"content": [{"type": "text", "text": "Fini :"}, {"type": "tool_use"}, {"type": "text", "text": "tout est bon."}]}},
            {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Bash"}]}},
            {"type": "user", "message": {"content": "merci"}},
        ]) + "\n")
        self.assertEqual(transcripts.last_assistant_text(self.path), "Fini :\ntout est bon.")
        self.path.write_text("")
        self.assertEqual(transcripts.last_assistant_text(self.path), "")

    def test_summarize_reads_context_of_main_agent(self):
        def assistant(tokens, **extra):
            usage = {"input_tokens": 1, "cache_read_input_tokens": tokens, "cache_creation_input_tokens": 9}
            return {"type": "assistant", "message": {"model": "claude-x", "usage": usage}, **extra}

        lines = [assistant(1000), assistant(50000), assistant(7, isSidechain=True)]
        self.path.write_text("\n".join(map(json.dumps, lines)) + "\n")
        summary = transcripts.summarize(self.path)
        self.assertEqual((summary["contextTokens"], summary["model"]), (50010, "claude-x"))  # sous-agent ignoré

        # Après une compaction, l'ancien contexte ne compte plus.
        lines.append({"type": "system", "subtype": "compact_boundary"})
        self.path.write_text("\n".join(map(json.dumps, lines)) + "\n")
        self.assertIsNone(transcripts.summarize(self.path)["contextTokens"])


if __name__ == "__main__":
    unittest.main()

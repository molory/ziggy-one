"""Tests de la génération du message de commit (faux claude, aucun quota) : python3 -m unittest discover -s tests"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import commit_message  # noqa: E402
from gitops import GitError  # noqa: E402

# Faux `claude -p --output-format json` : garde la consigne reçue et renvoie la réponse préparée.
FAKE = f"""#!{sys.executable}
import json, os, sys
prompt = sys.stdin.read()
open(os.environ["FAKE_PROMPT"], "w").write(prompt)
print(json.dumps(json.loads(open(os.environ["FAKE_REPLY"]).read())))
"""


def git(cwd, *args):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


class CommitMessageTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        base = Path(tmp.name)
        fake = base / "claude"
        fake.write_text(FAKE)
        fake.chmod(0o755)
        self.prompt_file, self.reply_file = base / "prompt.txt", base / "reply.json"
        patcher = mock.patch.dict(os.environ, {
            "PATH": f"{base}{os.pathsep}{os.environ['PATH']}",
            "FAKE_PROMPT": str(self.prompt_file), "FAKE_REPLY": str(self.reply_file),
        })
        patcher.start()
        self.addCleanup(patcher.stop)
        self.repo = base / "depot"
        self.repo.mkdir()
        for args in (["init", "-q", "-b", "main"], ["config", "user.name", "T"], ["config", "user.email", "t@example.com"]):
            git(self.repo, *args)
        (self.repo / "app.py").write_text("print('v1')\n")
        git(self.repo, "add", "app.py")
        git(self.repo, "commit", "-q", "-m", "Ajoute l'application")

    def reply(self, payload):
        self.reply_file.write_text(json.dumps(payload))

    def test_generates_a_cleaned_message_from_the_staged_diff(self):
        (self.repo / "app.py").write_text("print('v2')\n")
        git(self.repo, "add", "app.py")
        self.reply({"result": "```\nMessage de commit : Passe à la version 2\n```", "is_error": False})
        self.assertEqual(commit_message.generate(str(self.repo)), "Passe à la version 2")
        prompt = self.prompt_file.read_text()
        self.assertIn("- Ajoute l'application", prompt)  # style des commits récents
        self.assertIn("+print('v2')", prompt)  # le diff indexé

    def test_nothing_staged(self):
        (self.repo / "app.py").write_text("non indexé\n")
        with self.assertRaisesRegex(GitError, "Aucun fichier indexé"):
            commit_message.generate(str(self.repo))

    def test_claude_error(self):
        (self.repo / "app.py").write_text("print('v2')\n")
        git(self.repo, "add", "app.py")
        for payload in ({"result": "", "is_error": False}, {"result": "x", "is_error": True}):
            self.reply(payload)
            with self.assertRaises(GitError):
                commit_message.generate(str(self.repo))

    def test_clean(self):
        self.assertEqual(commit_message.clean('"Corrige le bug"'), "Corrige le bug")
        self.assertEqual(commit_message.clean("```text\nTitre\n\n- puce\n```"), "Titre\n\n- puce")
        self.assertEqual(commit_message.clean("Commit message: Fix"), "Fix")
        # Cas réel : une phrase d'introduction, puis le message dans un bloc de code non refermé.
        intro = "Message de commit proposé, en français, aligné sur les commits récents :\n\n```\nAjoute un écran Git\n\n- puce"
        self.assertEqual(commit_message.clean(intro), "Ajoute un écran Git\n\n- puce")
        self.assertEqual(commit_message.clean("Voici le message :\nCorrige le bug"), "Corrige le bug")


if __name__ == "__main__":
    unittest.main()

// Tests de l'onglet Discussion (sans DOM) : node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildTurns, classifyUserText, toolNames, toolSummary, turnMarkdown } from "../web/discussion-logic.js";

const user = (id, text) => ({ id, role: "user", content: [{ type: "text", text }] });
const assistant = (id, ...content) => ({ id, role: "assistant", content });
const result = (id, toolUseId, content, isError = false) => ({ id, role: "user", content: [{ type: "tool_result", toolUseId, content, is_error: isError }] });

test("classifyUserText : messages, commandes, sorties, et le reste ignoré", () => {
  assert.deepEqual(classifyUserText("Corrige le bug"), { sent: { kind: "prompt", text: "Corrige le bug" } });
  assert.deepEqual(classifyUserText("<command-name>/model</command-name>\n<command-args>haiku</command-args>"),
    { sent: { kind: "command", text: "/model haiku" } });
  assert.deepEqual(classifyUserText("<bash-input>git status</bash-input>"), { sent: { kind: "bash", text: "git status" } });
  assert.deepEqual(classifyUserText("<bash-stdout>propre</bash-stdout><bash-stderr></bash-stderr>"),
    { item: { kind: "output", label: "Sortie", text: "propre" } });
  assert.deepEqual(classifyUserText("<task-notification><summary>Agent fini</summary></task-notification>"),
    { item: { kind: "info", text: "Agent fini" } });
  assert.equal(classifyUserText("<system-reminder>rappel</system-reminder>"), null);
  assert.equal(classifyUserText("<ide_opened_file>a.py</ide_opened_file>"), null);
});

test("buildTurns : un échange par message envoyé, actions regroupées avec leur résultat", () => {
  const turns = buildTurns([
    user("u1", "Liste les fichiers"),
    assistant("a1", { type: "text", text: "Je regarde." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }),
    result("r1", "t1", "a.txt"),
    assistant("a2", { type: "tool_use", id: "t2", name: "Read", input: { file_path: "/x/a.txt" } }),
    result("r2", "t2", "contenu", true),
    assistant("a3", { type: "text", text: "Il y a a.txt." }),
    user("u2", "<command-name>/clear</command-name>"),
    user("u3", "<system-reminder>ignoré</system-reminder>"),
    assistant("a4", { type: "tool_use", id: "s1", name: "Agent", input: { description: "Chercher" } }),
  ]);
  assert.deepEqual(turns.map((t) => [t.id, t.sent?.kind, t.sent?.text]), [["u1", "prompt", "Liste les fichiers"], ["u2", "command", "/clear"]]);
  const [first, second] = turns;
  assert.deepEqual(first.items.map((i) => i.kind), ["text", "tools", "text"]);
  const group = /** @type {any} */ (first.items[1]);
  assert.deepEqual(group.tools.map((t) => [t.name, t.result, t.isError]), [["Bash", "a.txt", false], ["Read", "contenu", true]]);
  assert.deepEqual(second.items, [{ kind: "subagent", id: "s1", input: { description: "Chercher" } }]);
});

test("buildTurns : une réponse sans message (début de session reprise) a son propre échange", () => {
  const turns = buildTurns([assistant("a1", { type: "text", text: "Bonjour" })]);
  assert.deepEqual(turns.map((t) => [t.sent, t.items.length]), [[null, 1]]);
});

test("toolSummary et toolNames : une ligne lisible", () => {
  assert.equal(toolSummary("Bash", { command: "git   status\n-s" }), "git status -s");
  assert.equal(toolSummary("Edit", { file_path: "/home/x/projet/web/app.js", old_string: "x" }), "web/app.js");
  assert.equal(toolSummary("Grep", { pattern: "TODO" }), "TODO");
  assert.equal(toolSummary("Inconnu", { a: 1 }), '{"a":1}');
  assert.equal(toolSummary("Bash", { command: "x".repeat(200) }).length, 140);
  assert.equal(toolNames([{ name: "Bash" }, { name: "Read" }, { name: "Bash" }].map((t, i) => ({ id: String(i), input: {}, ...t }))), "Bash, Read");
});

test("turnMarkdown : question et réponse, ou réponse seule, sans les actions", () => {
  const turn = {
    id: "t",
    sent: { kind: "prompt", text: "Corrige le bug" },
    items: [
      { kind: "text", text: "Je regarde.\n" },
      { kind: "tools", id: "x", tools: [{ id: "x", name: "Bash", input: { command: "ls" } }] },
      { kind: "text", text: "C'est corrigé." },
    ],
  };
  assert.equal(turnMarkdown(turn, false), "Je regarde.\n\nC'est corrigé.");
  assert.equal(turnMarkdown(turn, true), "## Question\n\nCorrige le bug\n\n## Réponse\n\nJe regarde.\n\nC'est corrigé.");
  const bash = { id: "b", sent: { kind: "bash", text: "git status" }, items: [] };
  assert.equal(turnMarkdown(bash, true), "## Question\n\n! git status\n\n## Réponse\n\n_Pas de réponse écrite._");
});

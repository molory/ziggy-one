// Tests of the Discussion tab (without DOM): node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildTurns, classifyUserText, toolNames, toolSummary, turnMarkdown } from "../web/discussion-logic.js";

const user = (id, text) => ({ id, role: "user", content: [{ type: "text", text }] });
const assistant = (id, ...content) => ({ id, role: "assistant", content });
const result = (id, toolUseId, content, isError = false) => ({ id, role: "user", content: [{ type: "tool_result", toolUseId, content, is_error: isError }] });

test("classifyUserText: messages, commands, outputs, and the rest ignored", () => {
  assert.deepEqual(classifyUserText("Fix the bug"), { sent: { kind: "prompt", text: "Fix the bug" } });
  assert.deepEqual(classifyUserText("<command-name>/model</command-name>\n<command-args>haiku</command-args>"),
    { sent: { kind: "command", text: "/model haiku" } });
  assert.deepEqual(classifyUserText("<bash-input>git status</bash-input>"), { sent: { kind: "bash", text: "git status" } });
  assert.deepEqual(classifyUserText("<bash-stdout>clean</bash-stdout><bash-stderr></bash-stderr>"),
    { item: { kind: "output", label: "Output", text: "clean" } });
  assert.deepEqual(classifyUserText("<task-notification><summary>Agent done</summary></task-notification>"),
    { item: { kind: "info", text: "Agent done" } });
  assert.equal(classifyUserText("<system-reminder>reminder</system-reminder>"), null);
  assert.equal(classifyUserText("<ide_opened_file>a.py</ide_opened_file>"), null);
});

test("buildTurns: one exchange per message sent, actions grouped with their result", () => {
  const turns = buildTurns([
    user("u1", "List the files"),
    assistant("a1", { type: "text", text: "Looking." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }),
    result("r1", "t1", "a.txt"),
    assistant("a2", { type: "tool_use", id: "t2", name: "Read", input: { file_path: "/x/a.txt" } }),
    result("r2", "t2", "content", true),
    assistant("a3", { type: "text", text: "There is a.txt." }),
    user("u2", "<command-name>/clear</command-name>"),
    user("u3", "<system-reminder>ignored</system-reminder>"),
    assistant("a4", { type: "tool_use", id: "s1", name: "Agent", input: { description: "Search" } }),
  ]);
  assert.deepEqual(turns.map((t) => [t.id, t.sent?.kind, t.sent?.text]), [["u1", "prompt", "List the files"], ["u2", "command", "/clear"]]);
  const [first, second] = turns;
  assert.deepEqual(first.items.map((i) => i.kind), ["text", "tools", "text"]);
  const group = /** @type {any} */ (first.items[1]);
  assert.deepEqual(group.tools.map((t) => [t.name, t.result, t.isError]), [["Bash", "a.txt", false], ["Read", "content", true]]);
  assert.deepEqual(second.items, [{ kind: "subagent", id: "s1", input: { description: "Search" } }]);
});

test("buildTurns: a reply without a message (start of a resumed session) has its own exchange", () => {
  const turns = buildTurns([assistant("a1", { type: "text", text: "Hello" })]);
  assert.deepEqual(turns.map((t) => [t.sent, t.items.length]), [[null, 1]]);
});

test("toolSummary and toolNames: one readable line", () => {
  assert.equal(toolSummary("Bash", { command: "git   status\n-s" }), "git status -s");
  assert.equal(toolSummary("Edit", { file_path: "/home/x/project/web/app.js", old_string: "x" }), "web/app.js");
  assert.equal(toolSummary("Grep", { pattern: "TODO" }), "TODO");
  assert.equal(toolSummary("Unknown", { a: 1 }), '{"a":1}');
  assert.equal(toolSummary("Bash", { command: "x".repeat(200) }).length, 140);
  assert.equal(toolNames([{ name: "Bash" }, { name: "Read" }, { name: "Bash" }].map((t, i) => ({ id: String(i), input: {}, ...t }))), "Bash, Read");
});

test("turnMarkdown: question and answer, or answer alone, without the actions", () => {
  const turn = {
    id: "t",
    sent: { kind: "prompt", text: "Fix the bug" },
    items: [
      { kind: "text", text: "Looking.\n" },
      { kind: "tools", id: "x", tools: [{ id: "x", name: "Bash", input: { command: "ls" } }] },
      { kind: "text", text: "It is fixed." },
    ],
  };
  assert.equal(turnMarkdown(turn, false), "Looking.\n\nIt is fixed.");
  assert.equal(turnMarkdown(turn, true), "## Question\n\nFix the bug\n\n## Answer\n\nLooking.\n\nIt is fixed.");
  const bash = { id: "b", sent: { kind: "bash", text: "git status" }, items: [] };
  assert.equal(turnMarkdown(bash, true), "## Question\n\n! git status\n\n## Answer\n\n_No written answer._");
});

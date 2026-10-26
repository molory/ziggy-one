// Tests of the prompt shortcuts (Node, no dependency): node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { agentShortcuts, digitFor, indexForCode, moveItem, ownerKey, panelItems, shortcutLabel } from "../web/shortcuts-logic.js";

const s = (prompt, title = "") => ({ id: prompt, title, prompt });

test("an agent's shortcuts follow it from its discussion to its session", () => {
  const conversation = { id: "c0ffee000001", sessionId: "sess-uuid", resumeFrom: null };
  assert.equal(ownerKey({ agents: {}, workspaces: {} }, conversation), "sess-uuid", "new list: the session");
  const data = { agents: { c0ffee000001: [s("a")] }, workspaces: {} };
  assert.equal(ownerKey(data, conversation), "c0ffee000001", "existing list (not yet moved by the server)");
  assert.deepEqual(agentShortcuts(data, conversation), [s("a")]);
  assert.equal(ownerKey(data, { id: "new000000000" }), "new000000000");
});

test("the panel: the agent's then the workspace's, digits 1…9 then 0", () => {
  const own = Array.from({ length: 7 }, (_, i) => s(`a${i}`));
  const shared = Array.from({ length: 5 }, (_, i) => s(`w${i}`));
  const data = { agents: { agent: own }, workspaces: { ws: shared } };
  const items = panelItems(data, { id: "agent" }, "ws");
  assert.deepEqual(items.map((i) => i.digit), ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", null, null]);
  assert.deepEqual(items.map((i) => i.source), [...Array(7).fill("agent"), ...Array(5).fill("workspace")]);
  assert.equal(items[7].shortcut.prompt, "w0");
  assert.deepEqual(panelItems(data, { id: "agent" }, null).length, 7, "outside a workspace: its own only");
});

test("digit keys, top row and numeric keypad", () => {
  assert.equal(indexForCode("Digit1"), 0);
  assert.equal(indexForCode("Digit9"), 8);
  assert.equal(indexForCode("Digit0"), 9);
  assert.equal(indexForCode("Numpad3"), 2);
  assert.equal(indexForCode("KeyA"), -1);
  assert.equal(digitFor(10), null);
});

test("displayed title: given, otherwise the first line of the prompt, shortened", () => {
  assert.equal(shortcutLabel(s("x", "Tests")), "Tests");
  assert.equal(shortcutLabel(s("Run the tests\nthen summarize")), "Run the tests");
  assert.equal(shortcutLabel(s("x".repeat(80))).length, 60);
});

test("moving a shortcut, clamped at the ends", () => {
  assert.deepEqual(moveItem(["a", "b", "c"], 0, 1), ["b", "a", "c"]);
  assert.deepEqual(moveItem(["a", "b", "c"], 2, 1), ["a", "b", "c"]);
  assert.deepEqual(moveItem(["a", "b", "c"], 2, -2), ["c", "a", "b"]);
});

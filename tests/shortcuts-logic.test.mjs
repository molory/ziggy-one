// Tests des raccourcis de prompts (Node, sans dépendance) : node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { agentShortcuts, digitFor, indexForCode, moveItem, ownerKey, panelItems, shortcutLabel } from "../web/shortcuts-logic.js";

const s = (prompt, title = "") => ({ id: prompt, title, prompt });

test("les raccourcis d'un agent le suivent de sa discussion à sa session", () => {
  const conversation = { id: "c0ffee000001", sessionId: "sess-uuid", resumeFrom: null };
  assert.equal(ownerKey({ agents: {}, workspaces: {} }, conversation), "sess-uuid", "nouvelle liste : la session");
  const data = { agents: { c0ffee000001: [s("a")] }, workspaces: {} };
  assert.equal(ownerKey(data, conversation), "c0ffee000001", "liste existante (pas encore déplacée par le serveur)");
  assert.deepEqual(agentShortcuts(data, conversation), [s("a")]);
  assert.equal(ownerKey(data, { id: "new000000000" }), "new000000000");
});

test("le panneau : ceux de l'agent puis ceux du workspace, chiffres 1…9 puis 0", () => {
  const own = Array.from({ length: 7 }, (_, i) => s(`a${i}`));
  const shared = Array.from({ length: 5 }, (_, i) => s(`w${i}`));
  const data = { agents: { agent: own }, workspaces: { ws: shared } };
  const items = panelItems(data, { id: "agent" }, "ws");
  assert.deepEqual(items.map((i) => i.digit), ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", null, null]);
  assert.deepEqual(items.map((i) => i.source), [...Array(7).fill("agent"), ...Array(5).fill("workspace")]);
  assert.equal(items[7].shortcut.prompt, "w0");
  assert.deepEqual(panelItems(data, { id: "agent" }, null).length, 7, "hors workspace : les siens seulement");
});

test("touches chiffres, rangée du haut et pavé numérique", () => {
  assert.equal(indexForCode("Digit1"), 0);
  assert.equal(indexForCode("Digit9"), 8);
  assert.equal(indexForCode("Digit0"), 9);
  assert.equal(indexForCode("Numpad3"), 2);
  assert.equal(indexForCode("KeyA"), -1);
  assert.equal(digitFor(10), null);
});

test("titre affiché : donné, sinon la première ligne du prompt, abrégée", () => {
  assert.equal(shortcutLabel(s("x", "Tests")), "Tests");
  assert.equal(shortcutLabel(s("Lance les tests\npuis résume")), "Lance les tests");
  assert.equal(shortcutLabel(s("x".repeat(80))).length, 60);
});

test("déplacer un raccourci, borné aux extrémités", () => {
  assert.deepEqual(moveItem(["a", "b", "c"], 0, 1), ["b", "a", "c"]);
  assert.deepEqual(moveItem(["a", "b", "c"], 2, 1), ["a", "b", "c"]);
  assert.deepEqual(moveItem(["a", "b", "c"], 2, -2), ["c", "a", "b"]);
});

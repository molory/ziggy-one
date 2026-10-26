// Tests du mode Tâches (sans DOM) : node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { boardRow, columnTickets, descriptionPreview, dropIndex, keyboardMove, moveTicket, shareLink } from "../web/kanban-logic.js";
import { orderRows } from "../web/pins.js";
import { splitByWorkspace } from "../web/workspaces.js";

const columns = [{ id: "todo", name: "À faire", hue: null }, { id: "doing", name: "En cours", hue: 35 }, { id: "done", name: "Fait", hue: 140 }];
const ticket = (id, column, position) => ({ id, board: "b", column, position, title: id, description: "", files: [], createdAt: 0, updatedAt: 0 });
const tickets = [ticket("A", "todo", 0), ticket("B", "todo", 1), ticket("C", "todo", 2), ticket("D", "doing", 0)];
const titles = (list, column) => columnTickets(list, column).map((t) => t.id);

test("dropIndex : avant le premier ticket dont le milieu est plus bas", () => {
  assert.equal(dropIndex([10, 30, 50], 5), 0);
  assert.equal(dropIndex([10, 30, 50], 31), 2);
  assert.equal(dropIndex([10, 30, 50], 99), 3);
  assert.equal(dropIndex([], 0), 0);
});

test("moveTicket suit la règle du serveur, sans modifier la liste reçue", () => {
  const moved = moveTicket(tickets, "C", "todo", 0);
  assert.deepEqual(titles(moved, "todo"), ["C", "A", "B"]);
  const across = moveTicket(moved, "A", "doing", 99);
  assert.deepEqual([titles(across, "todo"), titles(across, "doing")], [["C", "B"], ["D", "A"]]);
  assert.deepEqual(columnTickets(across, "todo").map((t) => t.position), [0, 1]);
  assert.deepEqual(titles(tickets, "todo"), ["A", "B", "C"]);
});

test("keyboardMove : flèches dans la colonne et entre colonnes, null au bord", () => {
  assert.deepEqual(keyboardMove(columns, tickets, "B", "ArrowUp"), { column: "todo", index: 0 });
  assert.equal(keyboardMove(columns, tickets, "A", "ArrowUp"), null);
  assert.equal(keyboardMove(columns, tickets, "C", "ArrowDown"), null);
  assert.deepEqual(keyboardMove(columns, tickets, "C", "ArrowRight"), { column: "doing", index: 1 });
  assert.equal(keyboardMove(columns, tickets, "A", "ArrowLeft"), null);
});

test("les tableaux passent par les épingles et workspaces des agents", () => {
  const boards = [{ id: "b1" }, { id: "b2" }, { id: "b3" }].map((b) => boardRow(/** @type {any} */ (b)));
  const { members, rest } = splitByWorkspace(boards, [{ id: "w", name: "W", agents: ["b2"] }]);
  assert.deepEqual(members.get("w").map((r) => r.board.id), ["b2"]);
  const { pinned, others } = orderRows(rest, ["b3"], () => true);
  assert.deepEqual([pinned.map((r) => r.board.id), others.map((r) => r.board.id)], [["b3"], ["b1"]]);
});

test("descriptionPreview : première ligne lisible, sans Markdown", () => {
  assert.equal(descriptionPreview("\n# Titre **gras**\n- point"), "Titre gras");
  assert.equal(descriptionPreview("- `code` à faire"), "code à faire");
  assert.equal(descriptionPreview(""), "");
  assert.equal(descriptionPreview("x".repeat(200), 10), "xxxxxxxxx…");
});

test("adresse d'un ticket : /t/<numéro>", async () => {
  const { ticketUrl, ticketNumberFromPath } = await import("../web/kanban-logic.js");
  assert.equal(ticketUrl("http://127.0.0.1:6767", 42), "http://127.0.0.1:6767/t/42");
  assert.equal(ticketNumberFromPath("/t/42"), 42);
  for (const path of ["/t/0", "/t/42/x", "/t/abc", "/", "/t/"]) assert.equal(ticketNumberFromPath(path), null, path);
});

test("splitReferences : seuls les « #42 » de tickets connus, en mot à part", async () => {
  const { splitReferences } = await import("../web/kanban-logic.js");
  const known = (/** @type {number} */ n) => n === 42 || n === 7;
  assert.deepEqual(splitReferences("Voir #42 et (#7).", known),
    [{ text: "Voir " }, { number: 42, text: "#42" }, { text: " et (" }, { number: 7, text: "#7" }, { text: ")." }]);
  assert.deepEqual(splitReferences("#42", known), [{ number: 42, text: "#42" }]);
  for (const text of ["abc#42", "#42b", "&#42;", "#99 inconnu", "#042"]) {
    assert.ok(splitReferences(text, known).every((part) => !("number" in part)), text);
  }
});

test("shareLink : lien avec clé de lecture, sinon l'adresse simple du ticket", async () => {
  const ticket = { id: "abc", number: 42 };
  const withKey = await shareLink(async (path) => {
    assert.equal(path, "/api/kanbans/tickets/abc/link");
    return { path: "/t/42?key=secret" };
  }, "http://127.0.0.1:6767", ticket);
  assert.equal(withKey, "http://127.0.0.1:6767/t/42?key=secret");
  const fallback = await shareLink(async () => { throw new Error("hors ligne"); }, "http://127.0.0.1:6767", ticket);
  assert.equal(fallback, "http://127.0.0.1:6767/t/42");
});

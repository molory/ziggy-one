// Tasks mode tests (no DOM): node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  boardRow, columnTickets, descriptionPreview, dropIndex, keyboardMove, moveTicket, shareLink, tagHue, titleTags,
} from "../web/kanban-logic.js";
import { orderRows } from "../web/pins.js";
import { splitByWorkspace } from "../web/workspaces.js";

const columns = [{ id: "todo", name: "To do", hue: null }, { id: "doing", name: "In progress", hue: 35 }, { id: "done", name: "Done", hue: 140 }];
const ticket = (id, column, position) => ({ id, board: "b", column, position, title: id, description: "", files: [], createdAt: 0, updatedAt: 0 });
const tickets = [ticket("A", "todo", 0), ticket("B", "todo", 1), ticket("C", "todo", 2), ticket("D", "doing", 0)];
const titles = (list, column) => columnTickets(list, column).map((t) => t.id);

test("dropIndex: before the first ticket whose middle is lower", () => {
  assert.equal(dropIndex([10, 30, 50], 5), 0);
  assert.equal(dropIndex([10, 30, 50], 31), 2);
  assert.equal(dropIndex([10, 30, 50], 99), 3);
  assert.equal(dropIndex([], 0), 0);
});

test("moveTicket follows the server rule, without changing the given list", () => {
  const moved = moveTicket(tickets, "C", "todo", 0);
  assert.deepEqual(titles(moved, "todo"), ["C", "A", "B"]);
  const across = moveTicket(moved, "A", "doing", 99);
  assert.deepEqual([titles(across, "todo"), titles(across, "doing")], [["C", "B"], ["D", "A"]]);
  assert.deepEqual(columnTickets(across, "todo").map((t) => t.position), [0, 1]);
  assert.deepEqual(titles(tickets, "todo"), ["A", "B", "C"]);
});

test("keyboardMove: arrows within the column and across columns, null at the edge", () => {
  assert.deepEqual(keyboardMove(columns, tickets, "B", "ArrowUp"), { column: "todo", index: 0 });
  assert.equal(keyboardMove(columns, tickets, "A", "ArrowUp"), null);
  assert.equal(keyboardMove(columns, tickets, "C", "ArrowDown"), null);
  assert.deepEqual(keyboardMove(columns, tickets, "C", "ArrowRight"), { column: "doing", index: 1 });
  assert.equal(keyboardMove(columns, tickets, "A", "ArrowLeft"), null);
});

test("boards go through the agents' pins and workspaces", () => {
  const boards = [{ id: "b1" }, { id: "b2" }, { id: "b3" }].map((b) => boardRow(/** @type {any} */ (b)));
  const { members, rest } = splitByWorkspace(boards, [{ id: "w", name: "W", agents: ["b2"] }]);
  assert.deepEqual(members.get("w").map((r) => r.board.id), ["b2"]);
  const { pinned, others } = orderRows(rest, ["b3"], () => true);
  assert.deepEqual([pinned.map((r) => r.board.id), others.map((r) => r.board.id)], [["b3"], ["b1"]]);
});

test("descriptionPreview: first readable line, without Markdown", () => {
  assert.equal(descriptionPreview("\n# Title **bold**\n- item"), "Title bold");
  assert.equal(descriptionPreview("- `code` to do"), "code to do");
  assert.equal(descriptionPreview(""), "");
  assert.equal(descriptionPreview("x".repeat(200), 10), "xxxxxxxxx…");
});

test("ticket address: /t/<number>", async () => {
  const { ticketUrl, ticketNumberFromPath } = await import("../web/kanban-logic.js");
  assert.equal(ticketUrl("http://127.0.0.1:6767", 42), "http://127.0.0.1:6767/t/42");
  assert.equal(ticketNumberFromPath("/t/42"), 42);
  for (const path of ["/t/0", "/t/42/x", "/t/abc", "/", "/t/"]) assert.equal(ticketNumberFromPath(path), null, path);
});

test("splitReferences: only \"#42\" of known tickets, as a separate word", async () => {
  const { splitReferences } = await import("../web/kanban-logic.js");
  const known = (/** @type {number} */ n) => n === 42 || n === 7;
  assert.deepEqual(splitReferences("See #42 and (#7).", known),
    [{ text: "See " }, { number: 42, text: "#42" }, { text: " and (" }, { number: 7, text: "#7" }, { text: ")." }]);
  assert.deepEqual(splitReferences("#42", known), [{ number: 42, text: "#42" }]);
  for (const text of ["abc#42", "#42b", "&#42;", "#99 unknown", "#042"]) {
    assert.ok(splitReferences(text, known).every((part) => !("number" in part)), text);
  }
});

test("shareLink: link with read key, otherwise the plain ticket address", async () => {
  const ticket = { id: "abc", number: 42 };
  const withKey = await shareLink(async (path) => {
    assert.equal(path, "/api/kanbans/tickets/abc/link");
    return { path: "/t/42?key=secret" };
  }, "http://127.0.0.1:6767", ticket);
  assert.equal(withKey, "http://127.0.0.1:6767/t/42?key=secret");
  const fallback = await shareLink(async () => { throw new Error("offline"); }, "http://127.0.0.1:6767", ticket);
  assert.equal(fallback, "http://127.0.0.1:6767/t/42");
});

test("titleTags: UPPERCASE words with a leading or trailing / become tags", () => {
  assert.deepEqual(titleTags("/SMYNO/FEATURE Fix login"), { tags: ["SMYNO", "FEATURE"], rest: "Fix login" });
  assert.deepEqual(titleTags("SMYNO/FEATURE/ Fix login"), { tags: ["SMYNO", "FEATURE"], rest: "Fix login" });
  assert.deepEqual(titleTags("/SMYNO/FEATURE/Fix login"), { tags: ["SMYNO", "FEATURE"], rest: "Fix login" });
  assert.deepEqual(titleTags("BUG/"), { tags: ["BUG"], rest: "" });
  assert.deepEqual(titleTags("/V2/ÉTÉ_2 Plan"), { tags: ["V2", "ÉTÉ_2"], rest: "Plan" });
  for (const title of ["API fix", "A/B testing", "/SMYNOfix", "/Smyno/ Fix", "Fix /BUG/"]) {
    assert.deepEqual(titleTags(title), { tags: [], rest: title }, title);
  }
});

test("tagHue: the same text always gives the same hue", () => {
  assert.equal(tagHue("SMYNO"), tagHue("SMYNO"));
  assert.notEqual(tagHue("SMYNO"), tagHue("FEATURE"));
  for (const tag of ["A", "SMYNO", "FEATURE", "ÉTÉ"]) assert.ok(tagHue(tag) >= 0 && tagHue(tag) < 360);
});

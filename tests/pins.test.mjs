// Tests of the pinned agents (Node, no dependency): node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { migratePins, orderRows, pinIndex, pinnedFirst, rowKeys, togglePin } from "../web/pins.js";

const ids = (rows) => rows.map((row) => row.sessionId ?? row.conversation.id);

test("pinned ones go first, in pin order, whatever the filter", () => {
  const rows = [
    { sessionId: "a", active: true },
    { sessionId: "b", active: false },
    { sessionId: "c", active: true },
    { sessionId: "d", active: false },
  ];
  const { pinned, others } = orderRows(rows, ["d", "c"], (row) => row.active);
  assert.deepEqual(ids(pinned), ["d", "c"]); // "d" is closed but stays shown
  assert.deepEqual(ids(others), ["a"]); // "b" is filtered out
});

test("pin then unpin", () => {
  const row = { sessionId: "a" };
  let pins = togglePin([], row);
  assert.deepEqual(pins, ["a"]);
  assert.equal(pinIndex(pins, row), 0);
  pins = togglePin(pins, row);
  assert.deepEqual(pins, []);
});

test("a pin follows the agent by any of its ids", () => {
  // Discussion not started yet, pinned by its temporary id.
  const pins = togglePin([], { conversation: { id: "conv1" } });
  assert.deepEqual(pins, ["conv1"]);
  // It starts: the row now carries its session.
  const started = { sessionId: "s1", conversation: { id: "conv1", sessionId: "s1" } };
  assert.equal(pinIndex(pins, started), 0);
  assert.deepEqual(migratePins(pins, [started]), ["s1"]); // survives a server restart
  // Unpinning removes the pin, whatever the id used.
  assert.deepEqual(togglePin(["s1"], started), []);
});

test("a copy and its original session give only one pinned row", () => {
  const conversation = { id: "conv1", sessionId: "copy", resumeFrom: "origin" };
  const rows = [
    { sessionId: "copy", conversation },
    { sessionId: "origin", active: true, conversation },
  ];
  assert.deepEqual(rowKeys(rows[1]), ["origin", "copy", "origin", "conv1"]);
  const { pinned, others } = orderRows(rows, ["origin"], () => true);
  assert.deepEqual(ids(pinned), ["copy"]);
  assert.deepEqual(others, []);
});

test("migratePins keeps a pin whose agent is not in the list", () => {
  assert.deepEqual(migratePins(["absent"], [{ sessionId: "a" }]), ["absent"]);
});

test("in a workspace, pinned ones go first without changing the order of the others", () => {
  const rows = [{ sessionId: "a" }, { sessionId: "b" }, { sessionId: "c" }, { sessionId: "d" }];
  const { pinned, others } = pinnedFirst(rows, ["d", "b"]);
  assert.deepEqual(ids(pinned), ["d", "b"]);
  assert.deepEqual(ids(others), ["a", "c"]);
});

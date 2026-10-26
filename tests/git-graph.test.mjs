// Tests of the branch graph (Node, no dependency) : node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { computeGraph } from "../web/git-graph.js";

const lanes = (rows) => rows.map((row) => row.lane);

test("linear history: a single lane", () => {
  const rows = computeGraph([
    { hash: "c", parents: ["b"] },
    { hash: "b", parents: ["a"] },
    { hash: "a", parents: [] },
  ]);
  assert.deepEqual(lanes(rows), [0, 0, 0]);
  assert.ok(rows.every((row) => row.width === 1));
  // The first commit has nothing above; the last one nothing below.
  assert.deepEqual(rows[0].segments, [{ x1: 0, y1: 0.5, x2: 0, y2: 1, lane: 0 }]);
  assert.deepEqual(rows[2].segments, [{ x1: 0, y1: 0, x2: 0, y2: 0.5, lane: 0 }]);
});

test("branch then merge: two lanes joining", () => {
  //   m      merge of f into main
  //   |\\
  //   | f    commit on the branch
  //   b |    commit on main
  //   |/
  //   a
  const rows = computeGraph([
    { hash: "m", parents: ["b", "f"] },
    { hash: "f", parents: ["a"] },
    { hash: "b", parents: ["a"] },
    { hash: "a", parents: [] },
  ]);
  assert.deepEqual(lanes(rows), [0, 1, 0, 0]);
  // The merge goes to both its parents.
  assert.deepEqual(rows[0].segments.filter((s) => s.y1 === 0.5).map((s) => s.x2), [0, 1]);
  // On the row of "b", the lane of "f" (awaiting "a") passes alongside.
  assert.ok(rows[2].segments.some((s) => s.x1 === 1 && s.x2 === 1 && s.y1 === 0 && s.y2 === 1));
  // "a" is awaited by both lanes: they converge on it.
  const converging = rows[3].segments.filter((s) => s.y2 === 0.5).map((s) => s.x1).sort();
  assert.deepEqual(converging, [0, 1]);
  assert.equal(rows[3].width, 2);
});

test("two independent branch heads", () => {
  const rows = computeGraph([
    { hash: "x", parents: ["a"] },
    { hash: "y", parents: ["a"] },
    { hash: "a", parents: [] },
  ]);
  assert.deepEqual(lanes(rows), [0, 1, 0]);
});

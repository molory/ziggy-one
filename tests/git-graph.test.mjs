// Tests du graphe des branches (Node, sans dépendance) : node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { computeGraph } from "../web/git-graph.js";

const lanes = (rows) => rows.map((row) => row.lane);

test("historique linéaire : un seul couloir", () => {
  const rows = computeGraph([
    { hash: "c", parents: ["b"] },
    { hash: "b", parents: ["a"] },
    { hash: "a", parents: [] },
  ]);
  assert.deepEqual(lanes(rows), [0, 0, 0]);
  assert.ok(rows.every((row) => row.width === 1));
  // Le premier commit n'a rien au-dessus ; le dernier rien en dessous.
  assert.deepEqual(rows[0].segments, [{ x1: 0, y1: 0.5, x2: 0, y2: 1, lane: 0 }]);
  assert.deepEqual(rows[2].segments, [{ x1: 0, y1: 0, x2: 0, y2: 0.5, lane: 0 }]);
});

test("branche puis fusion : deux couloirs qui se rejoignent", () => {
  //   m      fusion de f dans main
  //   |\\
  //   | f    commit sur la branche
  //   b |    commit sur main
  //   |/
  //   a
  const rows = computeGraph([
    { hash: "m", parents: ["b", "f"] },
    { hash: "f", parents: ["a"] },
    { hash: "b", parents: ["a"] },
    { hash: "a", parents: [] },
  ]);
  assert.deepEqual(lanes(rows), [0, 1, 0, 0]);
  // La fusion part vers ses deux parents.
  assert.deepEqual(rows[0].segments.filter((s) => s.y1 === 0.5).map((s) => s.x2), [0, 1]);
  // Sur la ligne de « b », le couloir de « f » (qui attend « a ») passe à côté.
  assert.ok(rows[2].segments.some((s) => s.x1 === 1 && s.x2 === 1 && s.y1 === 0 && s.y2 === 1));
  // « a » est attendu par les deux couloirs : ils convergent sur lui.
  const converging = rows[3].segments.filter((s) => s.y2 === 0.5).map((s) => s.x1).sort();
  assert.deepEqual(converging, [0, 1]);
  assert.equal(rows[3].width, 2);
});

test("deux têtes de branche indépendantes", () => {
  const rows = computeGraph([
    { hash: "x", parents: ["a"] },
    { hash: "y", parents: ["a"] },
    { hash: "a", parents: [] },
  ]);
  assert.deepEqual(lanes(rows), [0, 1, 0]);
});

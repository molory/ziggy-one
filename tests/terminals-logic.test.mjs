// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";

import { formatBytes, formatSince, isIdle, sortTerminals } from "../web/terminals-logic.js";

test("formatBytes : Mo puis Go", () => {
  assert.equal(formatBytes(312 * 1024 * 1024), "312 Mo");
  assert.equal(formatBytes(1.4 * 1024 * 1024 * 1024), "1,4 Go");
  assert.equal(formatBytes(null), "—");
});

test("formatSince : minutes, heures, jours", () => {
  assert.equal(formatSince(1000, 1020), "à l'instant");
  assert.equal(formatSince(0, 5 * 60), "5 min");
  assert.equal(formatSince(0, (2 * 60 + 4) * 60), "2 h 04");
  assert.equal(formatSince(0, (3 * 24 + 4) * 3600), "3 j 4 h");
});

test("sortTerminals : en attente, au travail, puis par mémoire", () => {
  const rows = [
    { id: "a", state: "active", memory: 900 },
    { id: "b", state: "busy", memory: 100 },
    { id: "c", state: "waiting", memory: 50 },
    { id: "d", state: "active", memory: null },
    { id: "e", state: "active", memory: 1200 },
  ];
  assert.deepEqual(sortTerminals(rows).map((r) => r.id), ["c", "b", "e", "a", "d"]);
  assert.equal(isIdle("active"), true);
  assert.equal(isIdle("busy"), false);
  assert.equal(isIdle("waiting"), false);
});

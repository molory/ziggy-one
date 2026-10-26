// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";

import { uniqueName } from "../web/agent-names.js";

test("uniqueName: the folder name, numbered if it is already taken", () => {
  assert.equal(uniqueName("atlas", []), "atlas");
  assert.equal(uniqueName("atlas", ["Atlas", "other"]), "atlas 2"); // ignoring case
  assert.equal(uniqueName("atlas", ["atlas", "atlas 2", " ATLAS  3 "]), "atlas 4");
  assert.equal(uniqueName("  connector  batch ", []), "connector batch");
  assert.equal(uniqueName("", []), "agent");
});

// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";

import { uniqueName } from "../web/agent-names.js";

test("uniqueName : le nom du dossier, numéroté s'il est déjà pris", () => {
  assert.equal(uniqueName("atlas", []), "atlas");
  assert.equal(uniqueName("atlas", ["Atlas", "autre"]), "atlas 2"); // sans tenir compte de la casse
  assert.equal(uniqueName("atlas", ["atlas", "atlas 2", " ATLAS  3 "]), "atlas 4");
  assert.equal(uniqueName("  connector  batch ", []), "connector batch");
  assert.equal(uniqueName("", []), "agent");
});

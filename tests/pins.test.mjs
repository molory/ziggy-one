// Tests des agents épinglés (Node, sans dépendance) : node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { migratePins, orderRows, pinIndex, pinnedFirst, rowKeys, togglePin } from "../web/pins.js";

const ids = (rows) => rows.map((row) => row.sessionId ?? row.conversation.id);

test("les épinglés passent en tête, dans l'ordre des épingles, quel que soit le filtre", () => {
  const rows = [
    { sessionId: "a", active: true },
    { sessionId: "b", active: false },
    { sessionId: "c", active: true },
    { sessionId: "d", active: false },
  ];
  const { pinned, others } = orderRows(rows, ["d", "c"], (row) => row.active);
  assert.deepEqual(ids(pinned), ["d", "c"]); // « d » est fermé mais reste affiché
  assert.deepEqual(ids(others), ["a"]); // « b » est filtré
});

test("épingler puis désépingler", () => {
  const row = { sessionId: "a" };
  let pins = togglePin([], row);
  assert.deepEqual(pins, ["a"]);
  assert.equal(pinIndex(pins, row), 0);
  pins = togglePin(pins, row);
  assert.deepEqual(pins, []);
});

test("une épingle suit l'agent par n'importe lequel de ses identifiants", () => {
  // Discussion pas encore démarrée, épinglée par son identifiant provisoire.
  const pins = togglePin([], { conversation: { id: "conv1" } });
  assert.deepEqual(pins, ["conv1"]);
  // Elle démarre : la ligne porte maintenant sa session.
  const started = { sessionId: "s1", conversation: { id: "conv1", sessionId: "s1" } };
  assert.equal(pinIndex(pins, started), 0);
  assert.deepEqual(migratePins(pins, [started]), ["s1"]); // survit au redémarrage du serveur
  // Désépingler retire l'épingle, quel que soit l'identifiant utilisé.
  assert.deepEqual(togglePin(["s1"], started), []);
});

test("une copie et sa session d'origine ne donnent qu'une ligne épinglée", () => {
  const conversation = { id: "conv1", sessionId: "copie", resumeFrom: "origine" };
  const rows = [
    { sessionId: "copie", conversation },
    { sessionId: "origine", active: true, conversation },
  ];
  assert.deepEqual(rowKeys(rows[1]), ["origine", "copie", "origine", "conv1"]);
  const { pinned, others } = orderRows(rows, ["origine"], () => true);
  assert.deepEqual(ids(pinned), ["copie"]);
  assert.deepEqual(others, []);
});

test("migratePins garde une épingle dont l'agent n'est pas dans la liste", () => {
  assert.deepEqual(migratePins(["absent"], [{ sessionId: "a" }]), ["absent"]);
});

test("dans un workspace, les épinglés passent devant sans changer l'ordre des autres", () => {
  const rows = [{ sessionId: "a" }, { sessionId: "b" }, { sessionId: "c" }, { sessionId: "d" }];
  const { pinned, others } = pinnedFirst(rows, ["d", "b"]);
  assert.deepEqual(ids(pinned), ["d", "b"]);
  assert.deepEqual(ids(others), ["a", "c"]);
});

// Tests de la répartition des agents en workspaces (Node, sans dépendance) : node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { memberKey, pinnedHead, splitByWorkspace, workspacePinKey, workspaceState } from "../web/workspaces.js";

const ids = (rows) => rows.map((row) => row.sessionId);

test("les agents vont dans leur workspace, dans l'ordre d'ajout ; les autres restent hors groupe", () => {
  const rows = [{ sessionId: "a" }, { sessionId: "b" }, { sessionId: "c" }, { sessionId: "d" }];
  const workspaces = [
    { id: "w1", name: "Un", agents: ["c", "a"] },
    { id: "w2", name: "Deux", agents: [] },
  ];
  const { members, rest } = splitByWorkspace(rows, workspaces);
  assert.deepEqual(ids(members.get("w1")), ["c", "a"]);
  assert.deepEqual(members.get("w2"), []);
  assert.deepEqual(ids(rest), ["b", "d"]);
});

test("un agent est reconnu par n'importe lequel de ses identifiants", () => {
  // Ajouté avant son premier message (identifiant de discussion), il a depuis une session.
  const row = { sessionId: "s1", conversation: { id: "conv1", sessionId: "s1" } };
  const workspace = { id: "w1", name: "Un", agents: ["conv1"] };
  assert.equal(memberKey(workspace, row), "conv1");
  assert.deepEqual(ids(splitByWorkspace([row], [workspace]).members.get("w1")), ["s1"]);
});

test("une copie et sa session d'origine ne donnent qu'une ligne dans le workspace", () => {
  const conversation = { id: "conv1", sessionId: "copie", resumeFrom: "origine" };
  const rows = [{ sessionId: "copie", conversation }, { sessionId: "origine", conversation }];
  const { members, rest } = splitByWorkspace(rows, [{ id: "w1", name: "Un", agents: ["origine"] }]);
  assert.deepEqual(ids(members.get("w1")), ["copie"]);
  assert.deepEqual(rest, []);
});

test("état résumé d'un workspace", () => {
  assert.equal(workspaceState(["busy", "waiting", "active"]), "waiting"); // un agent attend ta réponse : prioritaire
  assert.equal(workspaceState(["inactive", "busy", "active"]), "busy");
  assert.equal(workspaceState(["inactive", "active"]), "active");
  assert.equal(workspaceState(["inactive"]), "inactive");
  assert.equal(workspaceState([]), "inactive");
});

test("agents et workspaces épinglés se mêlent en tête, dans l'ordre des épingles", () => {
  const workspaces = [
    { id: "w1", name: "Un", agents: [] },
    { id: "w2", name: "Deux", agents: [] },
    { id: "w3", name: "Trois", agents: [] },
  ];
  const pinnedRows = [{ sessionId: "a" }, { sessionId: "b" }];
  const pins = ["b", workspacePinKey("w3"), "a", workspacePinKey("w1")];
  const { head, unpinned } = pinnedHead(pinnedRows, workspaces, pins);
  assert.deepEqual(head.map((e) => (e.kind === "agent" ? e.row.sessionId : e.workspace.id)), ["b", "w3", "a", "w1"]);
  assert.deepEqual(unpinned.map((w) => w.id), ["w2"]);
});

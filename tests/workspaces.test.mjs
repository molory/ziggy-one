// Tests of the distribution of agents into workspaces (Node, no dependency): node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { memberKey, pinnedHead, splitByWorkspace, workspacePinKey, workspaceState } from "../web/workspaces.js";

const ids = (rows) => rows.map((row) => row.sessionId);

test("agents go into their workspace, in the order added; the others stay outside any group", () => {
  const rows = [{ sessionId: "a" }, { sessionId: "b" }, { sessionId: "c" }, { sessionId: "d" }];
  const workspaces = [
    { id: "w1", name: "One", agents: ["c", "a"] },
    { id: "w2", name: "Two", agents: [] },
  ];
  const { members, rest } = splitByWorkspace(rows, workspaces);
  assert.deepEqual(ids(members.get("w1")), ["c", "a"]);
  assert.deepEqual(members.get("w2"), []);
  assert.deepEqual(ids(rest), ["b", "d"]);
});

test("an agent is recognized by any of its ids", () => {
  // Added before its first message (discussion id), it has a session since then.
  const row = { sessionId: "s1", conversation: { id: "conv1", sessionId: "s1" } };
  const workspace = { id: "w1", name: "One", agents: ["conv1"] };
  assert.equal(memberKey(workspace, row), "conv1");
  assert.deepEqual(ids(splitByWorkspace([row], [workspace]).members.get("w1")), ["s1"]);
});

test("a copy and its original session give only one row in the workspace", () => {
  const conversation = { id: "conv1", sessionId: "copy", resumeFrom: "origin" };
  const rows = [{ sessionId: "copy", conversation }, { sessionId: "origin", conversation }];
  const { members, rest } = splitByWorkspace(rows, [{ id: "w1", name: "One", agents: ["origin"] }]);
  assert.deepEqual(ids(members.get("w1")), ["copy"]);
  assert.deepEqual(rest, []);
});

test("summary state of a workspace", () => {
  assert.equal(workspaceState(["busy", "waiting", "active"]), "waiting"); // an agent is waiting for your answer: takes priority
  assert.equal(workspaceState(["inactive", "busy", "active"]), "busy");
  assert.equal(workspaceState(["inactive", "active"]), "active");
  assert.equal(workspaceState(["inactive"]), "inactive");
  assert.equal(workspaceState([]), "inactive");
});

test("pinned agents and workspaces mix at the head, in pin order", () => {
  const workspaces = [
    { id: "w1", name: "One", agents: [] },
    { id: "w2", name: "Two", agents: [] },
    { id: "w3", name: "Three", agents: [] },
  ];
  const pinnedRows = [{ sessionId: "a" }, { sessionId: "b" }];
  const pins = ["b", workspacePinKey("w3"), "a", workspacePinKey("w1")];
  const { head, unpinned } = pinnedHead(pinnedRows, workspaces, pins);
  assert.deepEqual(head.map((e) => (e.kind === "agent" ? e.row.sessionId : e.workspace.id)), ["b", "w3", "a", "w1"]);
  assert.deepEqual(unpinned.map((w) => w.id), ["w2"]);
});

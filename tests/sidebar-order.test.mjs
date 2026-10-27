// Tests of reorganizing the agent list by drag and drop (Node, no dependency): node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  TOP_ZONES, accepts, applyToPins, applyToWorkspaces, containerZone, moveBefore, planDrop, stepBefore, workspaceZones,
} from "../web/sidebar-order.js";

const pinnedAgent = { kind: "agent", id: "a", pinned: true, pinKey: "a", workspace: null };
const looseAgent = { kind: "agent", id: "b", pinned: false, workspace: null };
const memberAgent = { kind: "agent", id: "c", pinned: false, workspace: "w1", memberKey: "c" };
const pinnedWorkspace = { kind: "workspace", id: "w1", pinned: true, pinKey: "workspace:w1" };
const workspace = { kind: "workspace", id: "w2", pinned: false };

test("moveBefore puts the key just before another one, or at the end", () => {
  assert.deepEqual(moveBefore(["a", "b", "c"], "c", "a"), ["c", "a", "b"]);
  assert.deepEqual(moveBefore(["a", "b", "c"], "a", null), ["b", "c", "a"]);
  assert.deepEqual(moveBefore(["a", "b"], "x", "b"), ["a", "x", "b"], "a new key is inserted");
  assert.deepEqual(moveBefore(["a", "b"], "a", "gone"), ["b", "a"], "an unknown neighbour means the end");
});

test("a move keeps the pin state, and a workspace never goes into a workspace", () => {
  const w1 = workspaceZones("w1");
  assert.ok(accepts(TOP_ZONES.pins, pinnedAgent) && accepts(w1.pins, pinnedAgent));
  assert.ok(!accepts(TOP_ZONES.loose, pinnedAgent) && !accepts(w1.members, pinnedAgent));
  assert.ok(accepts(TOP_ZONES.loose, looseAgent) && accepts(w1.members, looseAgent) && !accepts(TOP_ZONES.pins, looseAgent));
  assert.ok(accepts(TOP_ZONES.pins, pinnedWorkspace) && !accepts(w1.pins, pinnedWorkspace));
  assert.ok(accepts(TOP_ZONES.workspaces, workspace) && !accepts(TOP_ZONES.pins, workspace));
  assert.ok(!accepts(TOP_ZONES.workspaces, pinnedAgent), "agents are not mixed with the unpinned workspaces");
});

test("dropped on a container, an item goes to the matching zone", () => {
  assert.equal(containerZone(pinnedAgent, "w1").id, "ws:w1:pins");
  assert.equal(containerZone(looseAgent, "w1").id, "ws:w1:members");
  assert.equal(containerZone(memberAgent, null).id, "top:loose");
  assert.equal(containerZone(pinnedWorkspace, "w1").id, "top:pins", "a workspace stays at the top");
  assert.equal(containerZone(workspace, null).id, "top:workspaces");
});

test("reordering pins and workspaces", () => {
  const order = ["workspace:w1", "a", "x"];
  assert.deepEqual(planDrop(pinnedAgent, TOP_ZONES.pins, "workspace:w1", order), [{ type: "pins", key: "a", before: "workspace:w1" }]);
  assert.deepEqual(planDrop(pinnedAgent, TOP_ZONES.pins, "x", order), [], "dropped where it already is");
  assert.deepEqual(planDrop(pinnedWorkspace, TOP_ZONES.pins, null, order), [{ type: "pins", key: "workspace:w1", before: null }]);
  assert.deepEqual(planDrop(workspace, TOP_ZONES.workspaces, "w3", ["w3", "w2"]), [{ type: "move", workspace: "w2", before: "w3" }]);
  assert.deepEqual(planDrop(workspace, TOP_ZONES.pins, null, order), [], "refused zone: nothing");
});

test("agents join, move inside and leave workspaces", () => {
  const w1 = workspaceZones("w1");
  const w2 = workspaceZones("w2");
  assert.deepEqual(planDrop(looseAgent, w1.members, "c", ["c"]), [{ type: "place", workspace: "w1", agent: "b", before: "c" }]);
  assert.deepEqual(planDrop(memberAgent, w1.members, null, ["c", "d"]), [{ type: "place", workspace: "w1", agent: "c", before: null }]);
  assert.deepEqual(planDrop(memberAgent, w1.members, "d", ["c", "d"]), [], "same place");
  assert.deepEqual(planDrop(memberAgent, w2.members, null, []), [{ type: "place", workspace: "w2", agent: "c", before: null }]);
  assert.deepEqual(planDrop(memberAgent, TOP_ZONES.loose, null, []), [{ type: "leave", workspace: "w1", agent: "c" }]);
  assert.deepEqual(planDrop(looseAgent, TOP_ZONES.loose, null, []), [], "already outside any workspace");
  // A pinned agent: joins at the end of the workspace, its pin gives its place on screen.
  assert.deepEqual(planDrop(pinnedAgent, w1.pins, "p", ["p"]), [
    { type: "place", workspace: "w1", agent: "a", before: null },
    { type: "pins", key: "a", before: "p" },
  ]);
  const pinnedMember = { ...pinnedAgent, workspace: "w1", memberKey: "a" };
  assert.deepEqual(planDrop(pinnedMember, TOP_ZONES.pins, "x", ["x"]), [
    { type: "leave", workspace: "w1", agent: "a" },
    { type: "pins", key: "a", before: "x" },
  ]);
});

test("operations applied on screen follow the server's rules", () => {
  const workspaces = [{ id: "w1", agents: ["c", "d"] }, { id: "w2", agents: [] }, { id: "w3", agents: [] }];
  const placed = applyToWorkspaces(workspaces, [{ type: "place", workspace: "w2", agent: "c", before: null }]);
  assert.deepEqual(placed.map((w) => w.agents), [["d"], ["c"], []], "an agent is in a single workspace");
  const moved = applyToWorkspaces(workspaces, [{ type: "move", workspace: "w3", before: "w1" }]);
  assert.deepEqual(moved.map((w) => w.id), ["w3", "w1", "w2"]);
  assert.deepEqual(applyToWorkspaces(workspaces, [{ type: "leave", workspace: "w1", agent: "d" }])[0].agents, ["c"]);
  assert.deepEqual(workspaces[0].agents, ["c", "d"], "the input is not modified");
  assert.deepEqual(applyToPins(["a", "b", "c"], [{ type: "pins", key: "c", before: "a" }, { type: "leave", workspace: "w1", agent: "x" }]), ["c", "a", "b"]);
});

test("Alt + arrows: one step up or down, nothing past the edges", () => {
  const keys = ["a", "b", "c"];
  assert.equal(stepBefore(keys, "b", -1), "a");
  assert.equal(stepBefore(keys, "a", 1), "c");
  assert.equal(stepBefore(keys, "b", 1), null, "to the end");
  assert.equal(stepBefore(keys, "a", -1), undefined);
  assert.equal(stepBefore(keys, "c", 1), undefined);
  assert.equal(stepBefore(keys, "z", 1), undefined);
});

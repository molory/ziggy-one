// @ts-check
// Distribution of the agents among workspaces. Without DOM: testable with Node.

import { pinIndex, rowKeys } from "./pins.js";

/** @typedef {{id: string, name: string, hue?: number | null, agents: string[], shareActivity?: boolean}} Workspace */

/**
 * Id under which the agent appears in the workspace, or undefined if it is not part of it.
 *
 * @param {Workspace} workspace
 * @param {import("./pins.js").AgentRow} row
 */
export function memberKey(workspace, row) {
  return rowKeys(row).find((key) => workspace.agents.includes(key));
}

/**
 * Agents of each workspace (in the order they were added), and agents outside any workspace.
 * A copy and its original session lead to the same discussion: only one of the two is kept.
 *
 * @template {import("./pins.js").AgentRow} T
 * @param {T[]} rows
 * @param {Workspace[]} workspaces
 * @returns {{members: Map<string, T[]>, rest: T[]}}
 */
export function splitByWorkspace(rows, workspaces) {
  /** @type {Map<string, T[]>} */
  const members = new Map(workspaces.map((workspace) => [workspace.id, []]));
  const rest = [];
  const seenConversations = new Set();
  for (const row of rows) {
    const workspace = workspaces.find((w) => memberKey(w, row) !== undefined);
    if (!workspace) {
      rest.push(row);
      continue;
    }
    const conversationId = row.conversation?.id;
    if (conversationId && seenConversations.has(conversationId)) continue;
    if (conversationId) seenConversations.add(conversationId);
    members.get(workspace.id)?.push(row);
  }
  for (const workspace of workspaces) {
    const position = (/** @type {T} */ row) =>
      workspace.agents.indexOf(/** @type {string} */ (memberKey(workspace, row)));
    members.get(workspace.id)?.sort((a, b) => position(a) - position(b));
  }
  return { members, rest };
}

/**
 * Summary state of a workspace: it is thinking if one of its agents is thinking, it is open if
 * one of them is.
 *
 * @param {string[]} states states of its agents ("busy", "active", "inactive")
 */
export function workspaceState(states) {
  if (states.includes("waiting")) return "waiting"; // an agent of the workspace is waiting for your answer
  if (states.includes("busy")) return "busy";
  if (states.includes("active")) return "active";
  return "inactive";
}

/**
 * Pin of a workspace, stored with the agents' pins (no agent id starts like this).
 *
 * @param {string} id
 */
export const workspacePinKey = (id) => `workspace:${id}`;

/**
 * Head of the list: pinned agents and workspaces, mixed in pin order;
 * then the unpinned workspaces, in their creation order.
 *
 * @template {import("./pins.js").AgentRow} T
 * @param {T[]} pinnedRows pinned agents (outside any workspace)
 * @param {Workspace[]} workspaces
 * @param {string[]} pins
 */
export function pinnedHead(pinnedRows, workspaces, pins) {
  const isPinned = (/** @type {Workspace} */ workspace) => pins.includes(workspacePinKey(workspace.id));
  /** @type {({kind: "agent", row: T, index: number} | {kind: "workspace", workspace: Workspace, index: number})[]} */
  const head = [
    ...pinnedRows.map((row) => ({ kind: /** @type {const} */ ("agent"), row, index: pinIndex(pins, row) })),
    ...workspaces.filter(isPinned).map((workspace) => ({
      kind: /** @type {const} */ ("workspace"), workspace, index: pins.indexOf(workspacePinKey(workspace.id)),
    })),
  ];
  head.sort((a, b) => a.index - b.index);
  return { head, unpinned: workspaces.filter((workspace) => !isPinned(workspace)) };
}

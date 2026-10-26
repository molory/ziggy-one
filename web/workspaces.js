// @ts-check
// Répartition des agents entre workspaces. Sans DOM : testable avec Node.

import { pinIndex, rowKeys } from "./pins.js";

/** @typedef {{id: string, name: string, hue?: number | null, agents: string[], shareActivity?: boolean}} Workspace */

/**
 * Identifiant sous lequel l'agent figure dans le workspace, ou undefined s'il n'en fait pas partie.
 *
 * @param {Workspace} workspace
 * @param {import("./pins.js").AgentRow} row
 */
export function memberKey(workspace, row) {
  return rowKeys(row).find((key) => workspace.agents.includes(key));
}

/**
 * Agents de chaque workspace (dans l'ordre où ils ont été ajoutés), et agents hors workspace.
 * Une copie et sa session d'origine mènent à la même discussion : un seul des deux est gardé.
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
 * État résumé d'un workspace : il réfléchit si l'un de ses agents réfléchit, il est ouvert si
 * l'un d'eux l'est.
 *
 * @param {string[]} states états de ses agents (« busy », « active », « inactive »)
 */
export function workspaceState(states) {
  if (states.includes("waiting")) return "waiting"; // un agent du workspace attend ta réponse
  if (states.includes("busy")) return "busy";
  if (states.includes("active")) return "active";
  return "inactive";
}

/**
 * Épingle d'un workspace, rangée avec celles des agents (aucun identifiant d'agent ne commence ainsi).
 *
 * @param {string} id
 */
export const workspacePinKey = (id) => `workspace:${id}`;

/**
 * Tête de liste : agents et workspaces épinglés, mêlés dans l'ordre des épingles ;
 * puis les workspaces non épinglés, dans leur ordre de création.
 *
 * @template {import("./pins.js").AgentRow} T
 * @param {T[]} pinnedRows agents épinglés (hors workspace)
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

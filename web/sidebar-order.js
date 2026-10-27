// @ts-check
// Reorganizing the agent list by drag and drop (or Alt + arrows). Without DOM: testable with Node.
//
// The list is made of zones, each with its own order:
//   - "pins" zones: pinned agents and workspaces at the top of the list, or the pinned agents of a
//     workspace. Their order is the order of the pins.
//   - "workspaces": the unpinned workspaces, in their saved order.
//   - "members": the unpinned agents of a workspace, in the workspace's order.
//   - "loose": the unpinned agents outside any workspace. Sorted by date: it has no order of its own.
// A move keeps the pin state: a pinned item only goes to a "pins" zone, an unpinned one to the
// others. Every move is described the same way: "just before that item, or at the end (null)".

/**
 * @typedef {"pins" | "workspaces" | "members" | "loose"} ZoneKind
 * @typedef {{id: string, kind: ZoneKind, workspace: string | null}} Zone
 * @typedef {{kind: "agent" | "workspace", id: string, pinned: boolean, pinKey?: string,
 *   workspace?: string | null, memberKey?: string}} DragItem
 *   `id`: stable id of the agent (its first key) or of the workspace; `pinKey`: its entry in the pins;
 *   `workspace` / `memberKey`: the workspace an agent belongs to, and its id there.
 * @typedef {{type: "pins", key: string, before: string | null}
 *   | {type: "place", workspace: string, agent: string, before: string | null}
 *   | {type: "leave", workspace: string, agent: string}
 *   | {type: "move", workspace: string, before: string | null}} Operation
 */

/** Zones of the top of the list. */
export const TOP_ZONES = {
  pins: /** @type {Zone} */ ({ id: "top:pins", kind: "pins", workspace: null }),
  workspaces: /** @type {Zone} */ ({ id: "top:workspaces", kind: "workspaces", workspace: null }),
  loose: /** @type {Zone} */ ({ id: "top:loose", kind: "loose", workspace: null }),
};

/**
 * Zones inside a workspace: its pinned agents, then the others.
 *
 * @param {string} workspace
 * @returns {{pins: Zone, members: Zone}}
 */
export function workspaceZones(workspace) {
  return {
    pins: { id: `ws:${workspace}:pins`, kind: "pins", workspace },
    members: { id: `ws:${workspace}:members`, kind: "members", workspace },
  };
}

/**
 * Whether the item can be dropped in the zone (a move keeps the pin state; no workspace in a workspace).
 *
 * @param {Zone} zone
 * @param {DragItem} item
 */
export function accepts(zone, item) {
  if (item.kind === "workspace") return zone.workspace === null && zone.kind === (item.pinned ? "pins" : "workspaces");
  return item.pinned ? zone.kind === "pins" : zone.kind === "members" || zone.kind === "loose";
}

/**
 * Zone where an item goes when dropped on a container rather than between two rows: a workspace
 * (its header, or a collapsed workspace) for an agent, the top of the list otherwise.
 *
 * @param {DragItem} item
 * @param {string | null} workspace hovered workspace, null for the top of the list
 * @returns {Zone}
 */
export function containerZone(item, workspace) {
  if (item.kind === "agent" && workspace !== null) {
    const zones = workspaceZones(workspace);
    return item.pinned ? zones.pins : zones.members;
  }
  if (item.kind === "workspace") return item.pinned ? TOP_ZONES.pins : TOP_ZONES.workspaces;
  return item.pinned ? TOP_ZONES.pins : TOP_ZONES.loose;
}

/**
 * The list with `key` moved just before `before` (at the end if null or absent).
 *
 * @param {string[]} list
 * @param {string} key
 * @param {string | null} before
 */
export function moveBefore(list, key, before) {
  const rest = list.filter((item) => item !== key);
  const index = before === null ? -1 : rest.indexOf(before);
  rest.splice(index === -1 ? rest.length : index, 0, key);
  return rest;
}

/**
 * Key of the zone's item before which `key` lands, one step up (-1) or down (+1) with the keyboard:
 * null for the end, undefined if it is already at the edge.
 *
 * @param {string[]} keys order of the zone
 * @param {string} key
 * @param {-1 | 1} step
 * @returns {string | null | undefined}
 */
export function stepBefore(keys, key, step) {
  const index = keys.indexOf(key);
  if (index === -1) return undefined;
  if (step === -1) return index === 0 ? undefined : keys[index - 1];
  if (index === keys.length - 1) return undefined;
  return keys[index + 2] ?? null;
}

/**
 * Key that designates the item in the zone (pin, workspace id, id in the workspace).
 *
 * @param {DragItem} item
 * @param {Zone} zone
 */
export function keyIn(item, zone) {
  if (zone.kind === "pins") return item.pinKey ?? item.id;
  if (zone.kind === "members" && item.workspace === zone.workspace) return item.memberKey ?? item.id;
  return item.id;
}

/**
 * Operations to apply for a drop, none if it changes nothing.
 *
 * @param {DragItem} item
 * @param {Zone} zone where it is dropped (accepted, see `accepts`)
 * @param {string | null} before item of the zone just after the drop point, null for the end
 * @param {string[]} order current order of the zone (to recognize a drop at the same place)
 * @returns {Operation[]}
 */
export function planDrop(item, zone, before, order) {
  if (!accepts(zone, item)) return [];
  const key = keyIn(item, zone);
  const reordered = zone.kind === "loose" ? order : moveBefore(order, key, before);
  const sameOrder = reordered.length === order.length && reordered.every((k, i) => k === order[i]);
  /** @type {Operation[]} */
  const operations = [];
  if (item.kind === "workspace") {
    if (sameOrder) return [];
    return [zone.kind === "pins" ? { type: "pins", key, before } : { type: "move", workspace: item.id, before }];
  }
  const from = item.workspace ?? null;
  // Membership: leave the old workspace, or join (and place in) the new one.
  if (zone.workspace === null && from !== null) {
    operations.push({ type: "leave", workspace: from, agent: item.memberKey ?? item.id });
  } else if (zone.workspace !== null && (zone.kind === "members" ? !sameOrder || from !== zone.workspace : from !== zone.workspace)) {
    // A pinned agent is placed at the end of the workspace: its pin gives its place on screen.
    operations.push({
      type: "place", workspace: zone.workspace, agent: item.memberKey ?? item.id, before: zone.kind === "members" ? before : null,
    });
  }
  if (zone.kind === "pins" && !sameOrder) operations.push({ type: "pins", key, before });
  return operations;
}

/**
 * Workspaces after a drop, applied right away on screen (same rules as the server: an agent is in
 * a single workspace).
 *
 * @template {{id: string, agents: string[]}} W
 * @param {W[]} workspaces
 * @param {Operation[]} operations
 * @returns {W[]}
 */
export function applyToWorkspaces(workspaces, operations) {
  let next = workspaces.map((w) => ({ ...w, agents: [...w.agents] }));
  for (const op of operations) {
    if (op.type === "leave") {
      next = next.map((w) => (w.id === op.workspace ? { ...w, agents: w.agents.filter((a) => a !== op.agent) } : w));
    } else if (op.type === "place") {
      next = next.map((w) => {
        if (w.id === op.workspace) return { ...w, agents: moveBefore(w.agents, op.agent, op.before) };
        return { ...w, agents: w.agents.filter((a) => a !== op.agent) };
      });
    } else if (op.type === "move") {
      const order = moveBefore(next.map((w) => w.id), op.workspace, op.before);
      next = order.map((id) => /** @type {W} */ (next.find((w) => w.id === id)));
    }
  }
  return next;
}

/**
 * Pins after a drop.
 *
 * @param {string[]} pins
 * @param {Operation[]} operations
 */
export function applyToPins(pins, operations) {
  return operations.reduce((list, op) => (op.type === "pins" ? moveBefore(list, op.key, op.before) : list), pins);
}

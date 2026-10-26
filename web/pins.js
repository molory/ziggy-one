// @ts-check
// Agents pinned at the top of the list. Without DOM: testable with Node.
//
// One agent can be designated by several ids: its session, its ziggy-one
// discussion, the session it is a copy of… A pin follows it whatever the id.

/**
 * @typedef {{sessionId?: string | null, active?: boolean,
 *   conversation?: {id: string, sessionId?: string | null, resumeFrom?: string | null}}} AgentRow
 */

/**
 * Ids of an agent, from the most stable to the least stable.
 *
 * @param {AgentRow} row
 * @returns {string[]}
 */
export function rowKeys(row) {
  const c = row.conversation;
  return [row.sessionId, c?.sessionId, c?.resumeFrom, c?.id].filter((key) => typeof key === "string" && key !== "");
}

/**
 * Position of the agent's pin, or -1 if it is not pinned.
 *
 * @param {string[]} pins
 * @param {AgentRow} row
 */
export function pinIndex(pins, row) {
  const keys = rowKeys(row);
  return pins.findIndex((pin) => keys.includes(pin));
}

/**
 * Pins (at the end) or unpins an agent. Returns a new list.
 *
 * @param {string[]} pins
 * @param {AgentRow} row
 */
export function togglePin(pins, row) {
  const keys = rowKeys(row);
  if (pinIndex(pins, row) !== -1) return pins.filter((pin) => !keys.includes(pin));
  return keys.length ? [...pins, keys[0]] : pins;
}

/**
 * Replaces the pins set on a temporary id (discussion not started yet)
 * with the session id, which survives a server restart.
 *
 * @param {string[]} pins
 * @param {AgentRow[]} rows
 */
export function migratePins(pins, rows) {
  return pins.map((pin) => {
    const row = rows.find((r) => rowKeys(r).includes(pin));
    const best = row ? rowKeys(row)[0] : undefined;
    return best ?? pin;
  });
}

/**
 * Rows to show: the pinned ones first (in pin order, whatever the filter),
 * then the others in the order received, filtered.
 *
 * @template {AgentRow} T
 * @param {T[]} rows
 * @param {string[]} pins
 * @param {(row: T) => boolean} keep filter applied to the unpinned agents
 * @returns {{pinned: T[], others: T[]}}
 */
export function orderRows(rows, pins, keep) {
  const pinned = [];
  const seenConversations = new Set();
  for (const row of rows) {
    if (pinIndex(pins, row) === -1) continue;
    // A copy and its original session lead to the same discussion: a single pinned row.
    const conversationId = row.conversation?.id;
    if (conversationId && seenConversations.has(conversationId)) continue;
    if (conversationId) seenConversations.add(conversationId);
    pinned.push(row);
  }
  pinned.sort((a, b) => pinIndex(pins, a) - pinIndex(pins, b));
  const others = rows.filter((row) => pinIndex(pins, row) === -1 && keep(row));
  return { pinned, others };
}

/**
 * The pinned agents first (in pin order), then the others in the order received.
 * Used inside a workspace, where all agents are shown whatever the filter.
 *
 * @template {AgentRow} T
 * @param {T[]} rows
 * @param {string[]} pins
 * @returns {{pinned: T[], others: T[]}}
 */
export function pinnedFirst(rows, pins) {
  const pinned = rows.filter((row) => pinIndex(pins, row) !== -1);
  pinned.sort((a, b) => pinIndex(pins, a) - pinIndex(pins, b));
  return { pinned, others: rows.filter((row) => pinIndex(pins, row) === -1) };
}

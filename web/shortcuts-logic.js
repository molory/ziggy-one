// @ts-check
// Prompt shortcuts: logic without DOM (tested with node --test).
// An agent has its shortcuts; those of its workspace are added after them. The first ten have a digit:
// 1…9 then 0, as on the keyboard.

/**
 * @typedef {{id?: string, title: string, prompt: string}} Shortcut
 * @typedef {{agents: Record<string, Shortcut[]>, workspaces: Record<string, Shortcut[]>}} ShortcutData
 * @typedef {{shortcut: Shortcut, source: "agent" | "workspace", digit: string | null}} PanelItem
 */

export const MAX_ITEMS = 50;

/** @returns {ShortcutData} */
export const emptyShortcuts = () => ({ agents: {}, workspaces: {} });

/**
 * Possible ids of an agent (its session, its copy, its discussion), from the most durable to the most recent.
 *
 * @param {any} conversation
 * @returns {string[]}
 */
export function agentKeys(conversation) {
  return [conversation?.sessionId, conversation?.resumeFrom, conversation?.id].filter((key) => typeof key === "string" && key !== "");
}

/**
 * Key under which the agent's shortcuts are stored: the one that already has some, otherwise the most durable
 * (the server carries them over from the discussion to its session).
 *
 * @param {ShortcutData} data
 * @param {any} conversation
 */
export function ownerKey(data, conversation) {
  const keys = agentKeys(conversation);
  return keys.find((key) => data.agents[key]?.length) ?? keys[0] ?? null;
}

/**
 * @param {ShortcutData} data
 * @param {any} conversation
 * @returns {Shortcut[]}
 */
export function agentShortcuts(data, conversation) {
  const key = ownerKey(data, conversation);
  return (key && data.agents[key]) || [];
}

/** Digit of the shortcut at position `index` (0 → "1", 9 → "0"), or null after the tenth. */
export function digitFor(index) {
  return index < 9 ? String(index + 1) : index === 9 ? "0" : null;
}

/**
 * Position of the shortcut of a digit key (event.code "Digit1"… "Digit0", numeric keypad included), or -1.
 *
 * @param {string} code
 */
export function indexForCode(code) {
  const match = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (!match) return -1;
  return match[1] === "0" ? 9 : Number(match[1]) - 1;
}

/**
 * Shortcuts of the Terminal panel: the agent's, then its workspace's.
 *
 * @param {ShortcutData} data
 * @param {any} conversation
 * @param {string | null} workspaceId
 * @returns {PanelItem[]}
 */
export function panelItems(data, conversation, workspaceId) {
  const own = agentShortcuts(data, conversation).map((shortcut) => ({ shortcut, source: /** @type {const} */ ("agent") }));
  const shared = (workspaceId && data.workspaces[workspaceId]) || [];
  const all = [...own, ...shared.map((shortcut) => ({ shortcut, source: /** @type {const} */ ("workspace") }))];
  return all.map((item, index) => ({ ...item, digit: digitFor(index) }));
}

/**
 * Displayed title: the given title, otherwise the start of the prompt.
 *
 * @param {Shortcut} shortcut
 */
export function shortcutLabel(shortcut) {
  if (shortcut.title) return shortcut.title;
  const line = shortcut.prompt.trim().split("\n")[0];
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

/**
 * Copy of the list with item `index` moved by `delta` places (clamped at the ends).
 *
 * @template T
 * @param {T[]} items
 * @param {number} index
 * @param {number} delta
 */
export function moveItem(items, index, delta) {
  const target = Math.max(0, Math.min(items.length - 1, index + delta));
  const next = [...items];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item);
  return next;
}

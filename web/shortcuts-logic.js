// @ts-check
// Raccourcis de prompts : logique sans DOM (testée avec node --test).
// Un agent a ses raccourcis ; ceux de son workspace s'y ajoutent, après. Les dix premiers ont un chiffre :
// 1…9 puis 0, comme sur le clavier.

/**
 * @typedef {{id?: string, title: string, prompt: string}} Shortcut
 * @typedef {{agents: Record<string, Shortcut[]>, workspaces: Record<string, Shortcut[]>}} ShortcutData
 * @typedef {{shortcut: Shortcut, source: "agent" | "workspace", digit: string | null}} PanelItem
 */

export const MAX_ITEMS = 50;

/** @returns {ShortcutData} */
export const emptyShortcuts = () => ({ agents: {}, workspaces: {} });

/**
 * Identifiants possibles d'un agent (sa session, sa copie, sa discussion), du plus durable au plus récent.
 *
 * @param {any} conversation
 * @returns {string[]}
 */
export function agentKeys(conversation) {
  return [conversation?.sessionId, conversation?.resumeFrom, conversation?.id].filter((key) => typeof key === "string" && key !== "");
}

/**
 * Clé sous laquelle les raccourcis de l'agent sont rangés : celle qui en a déjà, sinon la plus durable
 * (le serveur les fait suivre de la discussion vers sa session).
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

/** Chiffre du raccourci à la position `index` (0 → « 1 », 9 → « 0 »), ou null après le dixième. */
export function digitFor(index) {
  return index < 9 ? String(index + 1) : index === 9 ? "0" : null;
}

/**
 * Position du raccourci d'une touche chiffre (event.code « Digit1 »… « Digit0 », pavé numérique compris), ou -1.
 *
 * @param {string} code
 */
export function indexForCode(code) {
  const match = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (!match) return -1;
  return match[1] === "0" ? 9 : Number(match[1]) - 1;
}

/**
 * Raccourcis du panneau du Terminal : ceux de l'agent, puis ceux de son workspace.
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
 * Titre affiché : le titre donné, sinon le début du prompt.
 *
 * @param {Shortcut} shortcut
 */
export function shortcutLabel(shortcut) {
  if (shortcut.title) return shortcut.title;
  const line = shortcut.prompt.trim().split("\n")[0];
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

/**
 * Copie de la liste avec l'élément `index` déplacé de `delta` places (bornée aux extrémités).
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

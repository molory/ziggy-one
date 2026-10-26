// @ts-check
// Agents épinglés en haut de la liste. Sans DOM : testable avec Node.
//
// Un même agent peut être désigné par plusieurs identifiants : sa session, sa discussion
// ziggy-one, la session dont elle est la copie… Une épingle le suit quel que soit l'identifiant.

/**
 * @typedef {{sessionId?: string | null, active?: boolean,
 *   conversation?: {id: string, sessionId?: string | null, resumeFrom?: string | null}}} AgentRow
 */

/**
 * Identifiants d'un agent, du plus stable au moins stable.
 *
 * @param {AgentRow} row
 * @returns {string[]}
 */
export function rowKeys(row) {
  const c = row.conversation;
  return [row.sessionId, c?.sessionId, c?.resumeFrom, c?.id].filter((key) => typeof key === "string" && key !== "");
}

/**
 * Position de l'épingle de l'agent, ou -1 s'il n'est pas épinglé.
 *
 * @param {string[]} pins
 * @param {AgentRow} row
 */
export function pinIndex(pins, row) {
  const keys = rowKeys(row);
  return pins.findIndex((pin) => keys.includes(pin));
}

/**
 * Épingle (à la fin) ou désépingle un agent. Retourne une nouvelle liste.
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
 * Remplace les épingles posées sur un identifiant provisoire (discussion pas encore démarrée)
 * par l'identifiant de session, qui survit au redémarrage du serveur.
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
 * Lignes à afficher : les épinglées d'abord (dans l'ordre des épingles, quel que soit le filtre),
 * puis les autres dans l'ordre reçu, filtrées.
 *
 * @template {AgentRow} T
 * @param {T[]} rows
 * @param {string[]} pins
 * @param {(row: T) => boolean} keep filtre appliqué aux agents non épinglés
 * @returns {{pinned: T[], others: T[]}}
 */
export function orderRows(rows, pins, keep) {
  const pinned = [];
  const seenConversations = new Set();
  for (const row of rows) {
    if (pinIndex(pins, row) === -1) continue;
    // Une copie et sa session d'origine mènent à la même discussion : une seule ligne épinglée.
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
 * Les agents épinglés d'abord (dans l'ordre des épingles), puis les autres dans l'ordre reçu.
 * Sert à l'intérieur d'un workspace, où tous les agents sont affichés quel que soit le filtre.
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

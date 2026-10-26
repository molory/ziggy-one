// @ts-check
// Écran Configuration, onglet Terminaux Claude : formats et ordre des lignes. Sans DOM : testable avec Node.

/**
 * Mémoire lisible : « 312 Mo », « 1,4 Go ».
 *
 * @param {number | null | undefined} bytes
 */
export function formatBytes(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "—";
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${Math.round(mb)} Mo`;
  return `${(mb / 1024).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} Go`;
}

/**
 * Depuis combien de temps : « 5 min », « 2 h 14 », « 3 j 4 h ».
 *
 * @param {number} startedAt secondes (epoch)
 * @param {number} now secondes (epoch)
 */
export function formatSince(startedAt, now) {
  const minutes = Math.max(0, Math.floor((now - startedAt) / 60));
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${String(minutes % 60).padStart(2, "0")}`;
  return `${Math.floor(hours / 24)} j ${hours % 24} h`;
}

const STATE_ORDER = { waiting: 0, busy: 1 };

/**
 * Ordre des terminaux : ceux qui t'attendent, puis au travail, puis les plus gourmands en mémoire.
 *
 * @template {{state: string, memory: number | null}} T
 * @param {T[]} rows
 * @returns {T[]}
 */
export function sortTerminals(rows) {
  const rank = (/** @type {T} */ row) => STATE_ORDER[/** @type {"waiting" | "busy"} */ (row.state)] ?? 2;
  return [...rows].sort((a, b) => rank(a) - rank(b) || (b.memory ?? 0) - (a.memory ?? 0));
}

/**
 * Un terminal se ferme sans confirmation seulement si son agent est au repos.
 *
 * @param {string} state état de l'agent (waiting, busy, active…)
 */
export const isIdle = (state) => state !== "busy" && state !== "waiting";

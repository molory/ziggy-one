// @ts-check
// Mode Tâches : calculs sans DOM (testables avec Node) pour la liste des tableaux et les déplacements.

/**
 * @typedef {{id: string, name: string, hue: number | null}} Column
 * @typedef {{id: string, name: string, hue: number | null, columns: Column[], ticketCount?: number,
 *   counts?: Record<string, number>, createdAt: number, updatedAt: number}} Board
 * @typedef {{id: string, board: string, column: string, position: number, title: string, description: string,
 *   files: {id: string, name: string, type: string, size: number}[], createdAt: number, updatedAt: number}} Ticket
 */

/**
 * Un tableau vu comme une ligne de la barre latérale. Les fonctions d'épingles et de workspaces des
 * agents désignent une ligne par `sessionId` : le tableau y met son identifiant.
 *
 * @param {Board} board
 */
export const boardRow = (board) => ({ sessionId: board.id, board });

/**
 * Tickets d'une colonne, dans l'ordre.
 *
 * @param {Ticket[]} tickets
 * @param {string} column
 */
export const columnTickets = (tickets, column) =>
  tickets.filter((t) => t.column === column).sort((a, b) => a.position - b.position);

/**
 * Position d'insertion d'après la hauteur du pointeur : avant le premier ticket dont le milieu est plus bas.
 *
 * @param {number[]} middles milieux verticaux des tickets de la colonne (sans celui qu'on déplace), dans l'ordre
 * @param {number} y
 */
export function dropIndex(middles, y) {
  const index = middles.findIndex((middle) => y < middle);
  return index === -1 ? middles.length : index;
}

/**
 * Déplacement appliqué tout de suite à l'écran, en attendant la réponse du serveur (même règle que lui) :
 * le ticket va à la position `index` (bornée) de `column`, et les colonnes touchées sont renumérotées.
 *
 * @param {Ticket[]} tickets
 * @param {string} id
 * @param {string} column
 * @param {number} index
 * @returns {Ticket[]}
 */
export function moveTicket(tickets, id, column, index) {
  const moving = tickets.find((t) => t.id === id);
  if (!moving) return tickets;
  const rest = tickets.filter((t) => t.id !== id).map((t) => ({ ...t }));
  const source = columnTickets(rest, moving.column);
  source.forEach((t, position) => (t.position = position));
  const target = columnTickets(rest, column);
  const placed = { ...moving, column };
  target.splice(Math.max(0, Math.min(index, target.length)), 0, placed);
  target.forEach((t, position) => (t.position = position));
  return [...rest, placed];
}

/**
 * Déplacement au clavier (Alt + flèche) : ←/→ change de colonne (même rang, borné), ↑/↓ change de rang.
 * Retourne null si le ticket est déjà au bord.
 *
 * @param {Column[]} columns
 * @param {Ticket[]} tickets
 * @param {string} id
 * @param {"ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown"} key
 * @returns {{column: string, index: number} | null}
 */
export function keyboardMove(columns, tickets, id, key) {
  const ticket = tickets.find((t) => t.id === id);
  if (!ticket) return null;
  const columnIndex = columns.findIndex((c) => c.id === ticket.column);
  const rank = columnTickets(tickets, ticket.column).findIndex((t) => t.id === id);
  if (key === "ArrowUp" || key === "ArrowDown") {
    const next = rank + (key === "ArrowUp" ? -1 : 1);
    const count = columnTickets(tickets, ticket.column).length;
    return next < 0 || next >= count ? null : { column: ticket.column, index: next };
  }
  const target = columns[columnIndex + (key === "ArrowLeft" ? -1 : 1)];
  if (!target) return null;
  return { column: target.id, index: Math.min(rank, columnTickets(tickets, target.id).length) };
}

/**
 * Première ligne lisible d'une description Markdown (aperçu sur la carte).
 *
 * @param {string} description
 * @param {number} [limit]
 */
export function descriptionPreview(description, limit = 140) {
  const line = description
    .split("\n")
    .map((l) => l.replace(/^\s*(?:#+|[-*+]|\d+\.|>)\s*/, "").replace(/[*_`]/g, "").trim())
    .find(Boolean);
  if (!line) return "";
  return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line;
}

// --- numéros et adresses des tickets ----------------------------------------------------------

const TICKET_PATH = /^\/t\/([1-9]\d{0,8})$/;

/**
 * Adresse d'un ticket, à partager (lien copié, référence dans un agent).
 *
 * @param {string} origin ex. http://127.0.0.1:6767
 * @param {number} number
 */
export const ticketUrl = (origin, number) => `${origin}/t/${number}`;

/**
 * Lien à partager d'un ticket : avec sa clé de lecture (un agent peut alors le lire), sinon l'adresse simple.
 *
 * @param {(path: string) => Promise<any>} api
 * @param {string} origin
 * @param {{id: string, number: number}} ticket
 */
export async function shareLink(api, origin, ticket) {
  try {
    return `${origin}${(await api(`/api/kanbans/tickets/${ticket.id}/link`)).path}`;
  } catch {
    return ticketUrl(origin, ticket.number);
  }
}

/**
 * Numéro du ticket désigné par un chemin d'adresse (/t/42), sinon null.
 *
 * @param {string} pathname
 */
export function ticketNumberFromPath(pathname) {
  const match = TICKET_PATH.exec(pathname);
  return match ? Number(match[1]) : null;
}

/**
 * Découpe un texte autour des références « #42 » à des tickets connus : morceaux de texte et numéros.
 * « #42 » doit être un mot à part (pas « abc#42 », ni « #42b », ni une entité « &#42 »).
 *
 * @param {string} text
 * @param {(number: number) => boolean} known
 * @returns {({text: string} | {number: number, text: string})[]}
 */
export function splitReferences(text, known) {
  /** @type {({text: string} | {number: number, text: string})[]} */
  const parts = [];
  const pattern = /(^|[^\w&])#([1-9]\d{0,8})(?!\w)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const number = Number(match[2]);
    if (!known(number)) continue;
    const start = /** @type {number} */ (match.index) + match[1].length;
    if (start > last) parts.push({ text: text.slice(last, start) });
    parts.push({ number, text: `#${number}` });
    last = start + match[2].length + 1;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

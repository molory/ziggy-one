// @ts-check
// Tasks mode: DOM-free computations (testable with Node) for the board list and moves.

/**
 * @typedef {{id: string, name: string, hue: number | null}} Column
 * @typedef {{id: string, name: string, hue: number | null, columns: Column[], ticketCount?: number,
 *   counts?: Record<string, number>, archivedCount?: number, createdAt: number, updatedAt: number}} Board
 * @typedef {{id: string, board: string, column: string, position: number, title: string, description: string,
 *   files: {id: string, name: string, type: string, size: number}[], due?: string | null,
 *   archivedAt?: number | null, createdAt: number, updatedAt: number}} Ticket
 */

/**
 * A board seen as a sidebar row. The agents' pin and workspace functions identify a row by
 * `sessionId`: the board puts its id there.
 *
 * @param {Board} board
 */
export const boardRow = (board) => ({ sessionId: board.id, board });

/**
 * Tickets shown in a column (archived ones are off the board), in order.
 *
 * @param {Ticket[]} tickets
 * @param {string} column
 */
export const columnTickets = (tickets, column) =>
  tickets.filter((t) => t.column === column && !t.archivedAt).sort((a, b) => a.position - b.position);

/** Names of the column of finished tickets (folded): the default "Done", in English and French. */
const DONE_NAMES = new Set(["done", "fait", "termine"]);
/** @param {string} text */
const fold = (text) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();

/**
 * Column whose tickets can be archived: the one named "Done" (or "Fait", "Terminé"), otherwise the last
 * column. None on a board with a single column.
 *
 * @param {Column[]} columns
 * @returns {string | null} its id
 */
export function doneColumn(columns) {
  if (columns.length < 2) return null;
  return (columns.find((c) => DONE_NAMES.has(fold(c.name))) ?? columns[columns.length - 1]).id;
}

/**
 * Archived tickets of a board, most recently archived first.
 *
 * @param {Ticket[]} tickets
 */
export const archivedTickets = (tickets) =>
  tickets.filter((t) => t.archivedAt).sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));

/**
 * Insertion index from the pointer height: before the first ticket whose middle is lower.
 *
 * @param {number[]} middles vertical middles of the column's tickets (without the one being moved), in order
 * @param {number} y
 */
export function dropIndex(middles, y) {
  const index = middles.findIndex((middle) => y < middle);
  return index === -1 ? middles.length : index;
}

/**
 * Move applied on screen right away, while waiting for the server's answer (same rule as the server):
 * the ticket goes to position `index` (clamped) of `column`, and the affected columns are renumbered.
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
 * Keyboard move (Alt + arrow): ←/→ changes column (same rank, clamped), ↑/↓ changes rank.
 * Returns null if the ticket is already at the edge.
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
 * First readable line of a Markdown description (preview on the card).
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

// --- ticket numbers and addresses -------------------------------------------------------------

const TICKET_PATH = /^\/t\/([1-9]\d{0,8})$/;

/**
 * Address of a ticket, to share (copied link, reference in an agent).
 *
 * @param {string} origin e.g. http://127.0.0.1:6767
 * @param {number} number
 */
export const ticketUrl = (origin, number) => `${origin}/t/${number}`;

/**
 * Share link of a ticket: with its read key (an agent can then read it), otherwise the plain address.
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
 * Number of the ticket designated by an address path (/t/42), otherwise null.
 *
 * @param {string} pathname
 */
export function ticketNumberFromPath(pathname) {
  const match = TICKET_PATH.exec(pathname);
  return match ? Number(match[1]) : null;
}

/**
 * Splits a text around "#42" references to known tickets: text pieces and numbers.
 * "#42" must be a separate word (not "abc#42", nor "#42b", nor an entity "&#42").
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

// --- tags at the start of a title ---------------------------------------------------------------

/** UPPERCASE words separated by "/", with a leading and/or trailing "/" (e.g. "/SMYNO/FEATURE"). */
const TAG_WORD = String.raw`\p{Lu}[\p{Lu}\p{N}_-]*(?=\/|\s|$)`;
const TITLE_TAGS = new RegExp(String.raw`^\s*(\/)?(${TAG_WORD}(?:\/${TAG_WORD})*)(\/)?`, "u");

/**
 * Tags written at the start of a title, shown as chips on the card, and the rest of the title.
 * "/SMYNO/FEATURE Fix login" and "SMYNO/FEATURE/ Fix login" give the tags SMYNO and FEATURE.
 * Without a leading or trailing "/", nothing is a tag ("API fix", "A/B testing").
 *
 * @param {string} title
 * @returns {{tags: string[], rest: string}}
 */
export function titleTags(title) {
  const match = TITLE_TAGS.exec(title);
  if (!match || (!match[1] && !match[3])) return { tags: [], rest: title };
  return { tags: match[2].split("/"), rest: title.slice(match[0].length).trim() };
}

/**
 * Hue of a tag, derived from its text: the same text always has the same color.
 *
 * @param {string} tag
 */
export function tagHue(tag) {
  let hash = 0x811c9dc5; // FNV-1a
  for (const char of tag) {
    hash ^= /** @type {number} */ (char.codePointAt(0));
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 360;
}

/** Days before a delivery date at which its badge starts turning red. */
export const DUE_HORIZON = 14;

/**
 * Days from today (the local calendar day of `now`) to a delivery date "YYYY-MM-DD": 0 today, 1 tomorrow,
 * negative when late. Counted in calendar days, so the hour of the day and daylight saving do not matter.
 *
 * @param {string} due
 * @param {Date} [now]
 */
export function daysUntil(due, now = new Date()) {
  const [year, month, day] = due.split("-").map(Number);
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((Date.UTC(year, month - 1, day) - today) / 86_400_000);
}

/**
 * How urgent a delivery date is, from 0 (DUE_HORIZON days away or more) to 1 (due today or late): the badge
 * gets redder as the date approaches.
 *
 * @param {number} days result of daysUntil
 */
export function dueUrgency(days) {
  if (days <= 0) return 1;
  return days >= DUE_HORIZON ? 0 : Math.round((1 - days / DUE_HORIZON) * 100) / 100;
}

// @ts-check
// Configuration screen, Claude terminals tab: formats and order of the rows. Without DOM: testable with Node.

import { locale, t } from "./i18n.js";

/**
 * Readable memory: "312 MB", "1.4 GB".
 *
 * @param {number | null | undefined} bytes
 */
export function formatBytes(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "—";
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return t("{n} MB", { n: Math.round(mb) });
  return t("{n} GB", { n: (mb / 1024).toLocaleString(locale(), { maximumFractionDigits: 1 }) });
}

/**
 * How long since: "5 min", "2h 14m", "3d 4h".
 *
 * @param {number} startedAt seconds (epoch)
 * @param {number} now seconds (epoch)
 */
export function formatSince(startedAt, now) {
  const minutes = Math.max(0, Math.floor((now - startedAt) / 60));
  if (minutes < 1) return t("just now");
  if (minutes < 60) return t("{minutes} min", { minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("{hours}h {minutes}m", { hours, minutes: String(minutes % 60).padStart(2, "0") });
  return t("{days}d {hours}h", { days: Math.floor(hours / 24), hours: hours % 24 });
}

const STATE_ORDER = { waiting: 0, busy: 1 };

/**
 * Order of the terminals: those waiting for you, then working, then the most memory-hungry.
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
 * A terminal closes without confirmation only if its agent is idle.
 *
 * @param {string} state state of the agent (waiting, busy, active…)
 */
export const isIdle = (state) => state !== "busy" && state !== "waiting";

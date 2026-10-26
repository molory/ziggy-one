// @ts-check
// Default name of a new agent: the name of its working folder, made unique. No DOM: testable with Node.

/**
 * `base`, or "base 2", "base 3"… if it is already taken (ignoring case and extra spaces):
 * agents find each other by their name.
 *
 * @param {string} base
 * @param {Iterable<string>} taken names already used by agents
 */
export function uniqueName(base, taken) {
  const fold = (/** @type {string} */ text) => text.trim().replace(/\s+/g, " ").toLowerCase();
  const used = new Set([...taken].filter((name) => typeof name === "string").map(fold));
  const clean = base.trim().replace(/\s+/g, " ").slice(0, 70) || "agent";
  if (!used.has(fold(clean))) return clean;
  let number = 2;
  while (used.has(fold(`${clean} ${number}`))) number += 1;
  return `${clean} ${number}`;
}

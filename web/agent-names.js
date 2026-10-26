// @ts-check
// Nom par défaut d'un nouvel agent : le nom de son dossier de travail, rendu unique. Sans DOM : testable avec Node.

/**
 * `base`, ou « base 2 », « base 3 »… s'il est déjà pris (sans tenir compte de la casse ni des espaces en trop) :
 * les agents se trouvent entre eux par leur nom.
 *
 * @param {string} base
 * @param {Iterable<string>} taken noms déjà portés par des agents
 */
export function uniqueName(base, taken) {
  const fold = (/** @type {string} */ text) => text.trim().replace(/\s+/g, " ").toLocaleLowerCase("fr");
  const used = new Set([...taken].filter((name) => typeof name === "string").map(fold));
  const clean = base.trim().replace(/\s+/g, " ").slice(0, 70) || "agent";
  if (!used.has(fold(clean))) return clean;
  let number = 2;
  while (used.has(fold(`${clean} ${number}`))) number += 1;
  return `${clean} ${number}`;
}

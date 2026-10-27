// @ts-check
// Search in the sidebar (agents, boards and tickets). Without DOM: testable with Node.
// A search looks through everything the list knows, even what its filters hide (Active, pinned only,
// collapsed workspaces). Case and accents do not count, and every word of the query must be found
// in one of the item's texts, in any order ("smy feat" finds "/SMYNO/FEATURE Fix login").

/** @param {string} text */
export const normalizeText = (text) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/**
 * Words of a query, normalized; none for an empty query (no search in progress).
 *
 * @param {string} query
 */
export const searchTerms = (query) => normalizeText(query).split(/\s+/).filter(Boolean);

/**
 * Whether every word is found in one of the texts.
 *
 * @param {string[]} terms see `searchTerms`
 * @param {(string | null | undefined)[]} texts
 */
export function matchesTerms(terms, texts) {
  const haystack = normalizeText(texts.filter(Boolean).join("\n"));
  return terms.every((term) => haystack.includes(term));
}

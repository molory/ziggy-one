// Tests of the sidebar search (Node, no dependency): node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { matchesTerms, normalizeText, searchTerms } from "../web/sidebar-search.js";

test("searchTerms: lower case words, without accents", () => {
  assert.deepEqual(searchTerms("  Tâche   ÉTÉ "), ["tache", "ete"]);
  assert.deepEqual(searchTerms("   "), [], "empty query: no search");
  assert.equal(normalizeText("Ça"), "ca");
});

test("matchesTerms: every word, in any order, in any of the texts", () => {
  assert.ok(matchesTerms(searchTerms("feat smy"), ["/SMYNO/FEATURE Fix login"]));
  assert.ok(matchesTerms(searchTerms("ziggy boss"), ["Ziggy Boss", "/Users/me/ziggy-one"]));
  assert.ok(matchesTerms(searchTerms("boss one"), ["Ziggy Boss", null, "/Users/me/ziggy-one"]), "words across texts");
  assert.ok(matchesTerms(searchTerms("ete"), ["Planning de l'été"]));
  assert.ok(!matchesTerms(searchTerms("boss two"), ["Ziggy Boss", "/Users/me/ziggy-one"]));
  assert.ok(matchesTerms([], ["anything"]), "no word: everything matches");
});

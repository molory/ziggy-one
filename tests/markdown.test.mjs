// Tests de l'analyse Markdown (Node, sans dépendance) : node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { parseInline, parseMarkdown } from "../web/markdown.js";

const types = (blocks) => blocks.map((block) => block.type);

test("mise en forme dans le texte", () => {
  assert.deepEqual(parseInline("du **gras**, de l'*italique*, du `code` et ~~barré~~"), [
    { type: "text", text: "du " },
    { type: "strong", children: [{ type: "text", text: "gras" }] },
    { type: "text", text: ", de l'" },
    { type: "em", children: [{ type: "text", text: "italique" }] },
    { type: "text", text: ", du " },
    { type: "code", text: "code" },
    { type: "text", text: " et " },
    { type: "del", children: [{ type: "text", text: "barré" }] },
  ]);
  // Le code n'est pas interprété ; un snake_case n'est pas de l'italique.
  assert.deepEqual(parseInline("`**pas gras**` mon_nom_de_variable"), [
    { type: "code", text: "**pas gras**" },
    { type: "text", text: " mon_nom_de_variable" },
  ]);
  assert.deepEqual(parseInline("2 * 3 * 4"), [{ type: "text", text: "2 * 3 * 4" }]);
});

test("liens : seulement http(s) et mailto", () => {
  assert.deepEqual(parseInline("[doc](https://exemple.fr/a)"), [
    { type: "link", href: "https://exemple.fr/a", children: [{ type: "text", text: "doc" }] },
  ]);
  assert.deepEqual(parseInline("[piège](javascript:alert(1))"), [{ type: "text", text: "[piège](javascript:alert(1))" }]);
  const bare = parseInline("voir https://gitlab.com/x/y.");
  assert.deepEqual(bare[1], { type: "link", href: "https://gitlab.com/x/y", children: [{ type: "text", text: "https://gitlab.com/x/y" }] });
  assert.deepEqual(bare[2], { type: "text", text: "." }); // la ponctuation finale n'est pas dans le lien
});

test("blocs : titres, paragraphes, code, citation, séparateur", () => {
  const blocks = parseMarkdown("# Titre\n\nUn paragraphe\nsur deux lignes.\n\n```python\nprint('a')\n\nprint('b')\n```\n> une citation\n\n---");
  assert.deepEqual(types(blocks), ["heading", "paragraph", "code", "quote", "rule"]);
  assert.deepEqual(blocks[0], { type: "heading", level: 1, children: [{ type: "text", text: "Titre" }] });
  assert.deepEqual(blocks[1].children, [{ type: "text", text: "Un paragraphe\nsur deux lignes." }]);
  assert.deepEqual(blocks[2], { type: "code", lang: "python", text: "print('a')\n\nprint('b')" });
  assert.deepEqual(types(blocks[3].children), ["paragraph"]);
});

test("bloc de code non refermé : jusqu'à la fin (réponse en cours)", () => {
  assert.deepEqual(parseMarkdown("```js\nconst a = 1;"), [{ type: "code", lang: "js", text: "const a = 1;" }]);
});

test("listes à puces, numérotées et imbriquées", () => {
  const [list] = parseMarkdown("- un\n- deux\n  - deux.a\n  - deux.b\n- trois");
  assert.equal(list.type, "list");
  assert.equal(list.ordered, false);
  assert.equal(list.items.length, 3);
  assert.deepEqual(types(list.items[1]), ["paragraph", "list"]);
  assert.equal(list.items[1][1].items.length, 2);
  const [ordered] = parseMarkdown("3. trois\n4. quatre");
  assert.equal(ordered.ordered, true);
  assert.equal(ordered.start, 3);
  // Une puce puis un numéro : deux listes distinctes.
  assert.deepEqual(types(parseMarkdown("- a\n1. b")), ["list", "list"]);
});

test("tableaux, même juste après un paragraphe", () => {
  const blocks = parseMarkdown("Résultats :\n| Nom | Coût |\n|---|---:|\n| a | 1 $ |\n| b | 2 $ |");
  assert.deepEqual(types(blocks), ["paragraph", "table"]);
  const table = blocks[1];
  assert.deepEqual(table.head, [[{ type: "text", text: "Nom" }], [{ type: "text", text: "Coût" }]]);
  assert.deepEqual(table.align, ["left", "right"]);
  assert.equal(table.rows.length, 2);
});

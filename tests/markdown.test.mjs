// Tests of the Markdown parser (Node, no dependency) : node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { parseInline, parseMarkdown } from "../web/markdown.js";

const types = (blocks) => blocks.map((block) => block.type);

test("inline formatting", () => {
  assert.deepEqual(parseInline("some **bold**, some *italic*, some `code` and ~~struck~~"), [
    { type: "text", text: "some " },
    { type: "strong", children: [{ type: "text", text: "bold" }] },
    { type: "text", text: ", some " },
    { type: "em", children: [{ type: "text", text: "italic" }] },
    { type: "text", text: ", some " },
    { type: "code", text: "code" },
    { type: "text", text: " and " },
    { type: "del", children: [{ type: "text", text: "struck" }] },
  ]);
  // Code is not interpreted; a snake_case name is not italic.
  assert.deepEqual(parseInline("`**not bold**` my_variable_name"), [
    { type: "code", text: "**not bold**" },
    { type: "text", text: " my_variable_name" },
  ]);
  assert.deepEqual(parseInline("2 * 3 * 4"), [{ type: "text", text: "2 * 3 * 4" }]);
});

test("links: only http(s) and mailto", () => {
  assert.deepEqual(parseInline("[doc](https://example.com/a)"), [
    { type: "link", href: "https://example.com/a", children: [{ type: "text", text: "doc" }] },
  ]);
  assert.deepEqual(parseInline("[trap](javascript:alert(1))"), [{ type: "text", text: "[trap](javascript:alert(1))" }]);
  const bare = parseInline("see https://gitlab.com/x/y.");
  assert.deepEqual(bare[1], { type: "link", href: "https://gitlab.com/x/y", children: [{ type: "text", text: "https://gitlab.com/x/y" }] });
  assert.deepEqual(bare[2], { type: "text", text: "." }); // the final punctuation is not part of the link
});

test("blocks: headings, paragraphs, code, quote, rule", () => {
  const blocks = parseMarkdown("# Title\n\nA paragraph\non two lines.\n\n```python\nprint('a')\n\nprint('b')\n```\n> a quote\n\n---");
  assert.deepEqual(types(blocks), ["heading", "paragraph", "code", "quote", "rule"]);
  assert.deepEqual(blocks[0], { type: "heading", level: 1, children: [{ type: "text", text: "Title" }] });
  assert.deepEqual(blocks[1].children, [{ type: "text", text: "A paragraph\non two lines." }]);
  assert.deepEqual(blocks[2], { type: "code", lang: "python", text: "print('a')\n\nprint('b')" });
  assert.deepEqual(types(blocks[3].children), ["paragraph"]);
});

test("unclosed code block: up to the end (answer in progress)", () => {
  assert.deepEqual(parseMarkdown("```js\nconst a = 1;"), [{ type: "code", lang: "js", text: "const a = 1;" }]);
});

test("bulleted, numbered and nested lists", () => {
  const [list] = parseMarkdown("- one\n- two\n  - two.a\n  - two.b\n- three");
  assert.equal(list.type, "list");
  assert.equal(list.ordered, false);
  assert.equal(list.items.length, 3);
  assert.deepEqual(types(list.items[1]), ["paragraph", "list"]);
  assert.equal(list.items[1][1].items.length, 2);
  const [ordered] = parseMarkdown("3. three\n4. four");
  assert.equal(ordered.ordered, true);
  assert.equal(ordered.start, 3);
  // A bullet then a number: two separate lists.
  assert.deepEqual(types(parseMarkdown("- a\n1. b")), ["list", "list"]);
});

test("tables, even right after a paragraph", () => {
  const blocks = parseMarkdown("Results:\n| Name | Cost |\n|---|---:|\n| a | 1 $ |\n| b | 2 $ |");
  assert.deepEqual(types(blocks), ["paragraph", "table"]);
  const table = blocks[1];
  assert.deepEqual(table.head, [[{ type: "text", text: "Name" }], [{ type: "text", text: "Cost" }]]);
  assert.deepEqual(table.align, ["left", "right"]);
  assert.equal(table.rows.length, 2);
});

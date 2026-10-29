// Tests of the Markdown parser (Node, no dependency) : node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { parseInline, parseMarkdown, toggleTask } from "../web/markdown.js";

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

test("images: only badges are loaded, the others become links", () => {
  const badge = "https://img.shields.io/badge/build-passing-green";
  assert.deepEqual(parseInline(`![build](${badge})`), [{ type: "image", src: badge, alt: "build" }]);
  // Badge inside a link, as in READMEs.
  assert.deepEqual(parseInline(`[![build](${badge})](https://ci.example.com)`), [
    { type: "link", href: "https://ci.example.com", children: [{ type: "image", src: badge, alt: "build" }] },
  ]);
  assert.deepEqual(parseInline("![shot](https://evil.example/x.png?secret)"), [
    { type: "link", href: "https://evil.example/x.png?secret", children: [{ type: "text", text: "shot" }] },
  ]);
  // shields.io routes that fetch another server are not static badges.
  assert.equal(parseInline("![x](https://img.shields.io/endpoint?url=https://evil.example)")[0].type, "link");
  assert.deepEqual(parseInline("![x](javascript:alert(1))")[0].type, "text");
});

test("task lists: state and line of each box", () => {
  const text = "Intro\n\n- [ ] first\n- [x] second\n  - [X] nested\n- plain\n\n> - [ ] quoted";
  const [, list, quote] = parseMarkdown(text);
  assert.deepEqual(list.tasks, [{ checked: false, line: 2 }, { checked: true, line: 3 }, null]);
  assert.deepEqual(list.items[0][0].children, [{ type: "text", text: "first" }]);
  assert.deepEqual(list.items[1][1].tasks, [{ checked: true, line: 4 }]);
  assert.deepEqual(quote.children[0].tasks, [{ checked: false, line: 7 }]);
  assert.equal(toggleTask(text, 2, true), text.replace("- [ ] first", "- [x] first"));
  assert.equal(toggleTask(text, 4, false), text.replace("[X] nested", "[ ] nested"));
  assert.equal(toggleTask(text, 7, true), text.replace("> - [ ] quoted", "> - [x] quoted"));
  assert.equal(toggleTask(text, 0, true), text, "a line without a box is unchanged");
  // "[link](url)" at the start of an item is not a box.
  assert.equal(parseMarkdown("- [doc](https://a.example) x")[0].tasks[0], null);
});

// Tests of the Files tab logic (Node, no dependency) : node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  breadcrumbs, detectIndent, formatSize, fuzzyIndices, groupByFile, highlightOccurrences,
  indentSelection, isMarkdown, parentDirs, segmentsFromIndices,
} from "../web/files-tree.js";

test("fuzzy search prefers the file name over folders", () => {
  assert.deepEqual(fuzzyIndices("app", "web/app.js"), [4, 5, 6]);
  assert.deepEqual(fuzzyIndices("wapp", "web/app.js"), [0, 4, 5, 6]); // spills over into folders
  assert.deepEqual(fuzzyIndices("AJ", "web/app.js"), [4, 8]); // case-insensitive
  assert.equal(fuzzyIndices("zz", "web/app.js"), null);
  assert.deepEqual(fuzzyIndices("  ", "a"), []);
});

test("highlighted positions are grouped into pieces", () => {
  assert.deepEqual(segmentsFromIndices("abcd", [1, 2]), [
    { text: "a", match: false }, { text: "bc", match: true }, { text: "d", match: false },
  ]);
  assert.deepEqual(segmentsFromIndices("ab", null), [{ text: "ab", match: false }]);
});

test("every occurrence of the query is highlighted, ignoring case", () => {
  assert.deepEqual(highlightOccurrences("Foo foo bar", "foo"), [
    { text: "Foo", match: true }, { text: " ", match: false }, { text: "foo", match: true }, { text: " bar", match: false },
  ]);
  assert.deepEqual(highlightOccurrences("abc", ""), [{ text: "abc", match: false }]);
});

test("breadcrumbs and parent folders", () => {
  assert.deepEqual(breadcrumbs("a/b/c.txt"), [
    { name: "a", path: "a" }, { name: "b", path: "a/b" }, { name: "c.txt", path: "a/b/c.txt" },
  ]);
  assert.deepEqual(parentDirs("a/b/c.txt"), ["a", "a/b"]);
  assert.deepEqual(parentDirs("c.txt"), []);
});

test("sizes and types", () => {
  assert.equal(formatSize(512), "512 B");
  assert.equal(formatSize(1536), "1.5 KB");
  assert.equal(formatSize(3 * 1024 * 1024), "3 MB");
  assert.ok(isMarkdown("docs/README.md"));
  assert.ok(!isMarkdown("md.txt"));
});

test("content results grouped by file", () => {
  const groups = groupByFile([
    { file: "a", line: 1, text: "x" }, { file: "b", line: 2, text: "y" }, { file: "a", line: 5, text: "z" },
  ]);
  assert.deepEqual(groups, [
    { file: "a", lines: [{ line: 1, text: "x" }, { line: 5, text: "z" }] },
    { file: "b", lines: [{ line: 2, text: "y" }] },
  ]);
});

test("detected indentation", () => {
  assert.equal(detectIndent("a\n\tb\n\tc"), "\t");
  assert.equal(detectIndent("a\n  b\n    c"), "  ");
  assert.equal(detectIndent("a\n    b"), "    ");
  assert.equal(detectIndent(""), "    ");
});

test("Tab inserts at the cursor, indents or outdents the selected lines", () => {
  assert.deepEqual(indentSelection("ab", 1, 1, false), { value: "a\tb", start: 2, end: 2 });
  // Selection over two lines, from "b" to "d".
  assert.deepEqual(indentSelection("ab\ncd\nef", 1, 4, false, "  "), { value: "  ab\n  cd\nef", start: 3, end: 8 });
  // Selection of whole lines (up to the start of the next one): the next one is untouched.
  assert.deepEqual(indentSelection("ab\ncd\n", 0, 3, false), { value: "\tab\ncd\n", start: 0, end: 4 });
  assert.deepEqual(indentSelection("\tab\n    cd", 1, 10, true), { value: "ab\ncd", start: 0, end: 5 });
  // Shift+Tab without a selection: outdents the cursor line.
  assert.deepEqual(indentSelection("x\n  yz", 5, 5, true), { value: "x\nyz", start: 3, end: 3 });
});

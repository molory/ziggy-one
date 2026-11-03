// Tests of a message typed from the Discussion tab (Node, no dependency): node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_PASTED_TEXT, pastedAsText, pastedText, typedText } from "../web/terminal-input.js";

test("each line break becomes Esc+Enter, like Shift+Enter in the terminal", () => {
  assert.equal(typedText("one\ntwo\r\nthree"), "one\x1b\rtwo\x1b\rthree");
});

test("no sequence slipped into the terminal; tabs to spaces; empty ends removed", () => {
  assert.equal(typedText("  \n\x1b[2Jhi\x07\t!\x9b \n\n"), "[2Jhi    !");
});

test("text files are pasted as text, other or too large files as a path", () => {
  assert.equal(pastedAsText({ name: "Notes.MD", type: "", size: 10 }), true);
  assert.equal(pastedAsText({ name: "data", type: "application/json", size: 10 }), true);
  assert.equal(pastedAsText({ name: "x.csv", type: "text/csv", size: 10 }), true);
  assert.equal(pastedAsText({ name: "plan.pdf", type: "application/pdf", size: 10 }), false);
  assert.equal(pastedAsText({ name: "big.md", type: "text/markdown", size: MAX_PASTED_TEXT + 1 }), false);
});

test("a pasted file cannot end the bracketed paste or send keys", () => {
  assert.equal(pastedText("# Title\r\nline\x1b[201~\x03rm\tx\x9b\n"), "# Title\nline[201~rm\tx\n");
});

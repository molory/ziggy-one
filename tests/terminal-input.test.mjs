// Tests of a message typed from the Discussion tab (Node, no dependency): node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { typedText } from "../web/terminal-input.js";

test("each line break becomes Esc+Enter, like Shift+Enter in the terminal", () => {
  assert.equal(typedText("one\ntwo\r\nthree"), "one\x1b\rtwo\x1b\rthree");
});

test("no sequence slipped into the terminal; tabs to spaces; empty ends removed", () => {
  assert.equal(typedText("  \n\x1b[2Jhi\x07\t!\x9b \n\n"), "[2Jhi    !");
});

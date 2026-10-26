// Tests of the coloring of your messages in the terminal (Node, no dependency): node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { createRecolor } from "../web/terminal-colors.js";

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);
const MESSAGE = "\x1b[11B\x1b[48;2;55;55;55m\x1b[38;2;153;153;153m❯ \x1b[38;2;255;255;255mhello\x1b[39m   \r";
const TINT_PROMPT = "\x1b[48;2;70;50;38m\x1b[1;38;2;251;146;60m❯\x1b[22m\x1b[38;2;153;153;153m ";
const TINTED = `\x1b[11B${TINT_PROMPT}\x1b[38;2;255;255;255mhello\x1b[39m   \r`;

test("your message gets the orange background and a bold orange ❯; the rest does not change", () => {
  const recolor = createRecolor();
  assert.equal(dec(recolor.push(enc(`before ${MESSAGE} after \x1b[48;2;1;2;3m`))), `before ${TINTED} after \x1b[48;2;1;2;3m`);
});

test("the following lines of a long message (background only) are recolored too", () => {
  const recolor = createRecolor();
  assert.equal(dec(recolor.push(enc("\x1b[48;2;55;55;55m  more"))), "\x1b[48;2;70;50;38m  more");
});

test("redrawn screen: the omitted grey of the ❯ (already active) is recolored too; the input box (non-breaking ❯) is not", () => {
  const recolor = createRecolor();
  assert.equal(dec(recolor.push(enc("\x1b[3B\x1b[48;2;55;55;55m❯ \x1b[38;2;255;255;255mhello"))),
    `\x1b[3B${TINT_PROMPT}\x1b[38;2;255;255;255mhello`);
  const input = enc("\x1b[1B\x1b[38;2;153;153;153m❯\u00a0\x1b[39m");
  assert.deepEqual(recolor.push(input), input);
});

test("a sequence split between two chunks is recolored anyway", () => {
  const whole = enc(`x${MESSAGE}y`);
  for (let cut = 0; cut <= whole.length; cut++) {
    const recolor = createRecolor();
    const out = [...recolor.push(whole.slice(0, cut)), ...recolor.push(whole.slice(cut))];
    assert.equal(dec(new Uint8Array(out)), `x${TINTED}y`, `cut at ${cut}`);
  }
});

test("without a message, the bytes go through as is", () => {
  const recolor = createRecolor();
  const bytes = enc("\x1b[38;2;215;119;87m✽ Churning…\x1b[K");
  assert.deepEqual(recolor.push(bytes), bytes);
});

// Tests de la mise en couleur de tes messages dans le terminal (Node, sans dépendance) : node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { createRecolor } from "../web/terminal-colors.js";

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);
const MESSAGE = "\x1b[11B\x1b[48;2;55;55;55m\x1b[38;2;153;153;153m❯ \x1b[38;2;255;255;255mbonjour\x1b[39m   \r";
const TINT_PROMPT = "\x1b[48;2;70;50;38m\x1b[1;38;2;251;146;60m❯\x1b[22m\x1b[38;2;153;153;153m ";
const TINTED = `\x1b[11B${TINT_PROMPT}\x1b[38;2;255;255;255mbonjour\x1b[39m   \r`;

test("ton message prend le fond orange et un ❯ orange en gras ; le reste ne change pas", () => {
  const recolor = createRecolor();
  assert.equal(dec(recolor.push(enc(`avant ${MESSAGE} après \x1b[48;2;1;2;3m`))), `avant ${TINTED} après \x1b[48;2;1;2;3m`);
});

test("les lignes suivantes d'un long message (fond seul) sont aussi recolorées", () => {
  const recolor = createRecolor();
  assert.equal(dec(recolor.push(enc("\x1b[48;2;55;55;55m  suite"))), "\x1b[48;2;70;50;38m  suite");
});

test("écran redessiné : le gris du ❯ omis (déjà actif) est recoloré aussi ; la zone de saisie (❯ insécable) non", () => {
  const recolor = createRecolor();
  assert.equal(dec(recolor.push(enc("\x1b[3B\x1b[48;2;55;55;55m❯ \x1b[38;2;255;255;255mbonjour"))),
    `\x1b[3B${TINT_PROMPT}\x1b[38;2;255;255;255mbonjour`);
  const input = enc("\x1b[1B\x1b[38;2;153;153;153m❯\u00a0\x1b[39m");
  assert.deepEqual(recolor.push(input), input);
});

test("une séquence coupée entre deux morceaux est recolorée quand même", () => {
  const whole = enc(`x${MESSAGE}y`);
  for (let cut = 0; cut <= whole.length; cut++) {
    const recolor = createRecolor();
    const out = [...recolor.push(whole.slice(0, cut)), ...recolor.push(whole.slice(cut))];
    assert.equal(dec(new Uint8Array(out)), `x${TINTED}y`, `coupure à ${cut}`);
  }
});

test("sans message, les octets passent tels quels", () => {
  const recolor = createRecolor();
  const bytes = enc("\x1b[38;2;215;119;87m✽ Churning…\x1b[K");
  assert.deepEqual(recolor.push(bytes), bytes);
});

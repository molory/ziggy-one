// Agents orbiting on the home screen (Node, no dependency): node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { HERO_MAX, HERO_MIN, heroCast } from "../web/hero-logic.js";

/** A repeatable "random": cycles through the given values. */
const sequence = (...values) => {
  let i = 0;
  return () => values[i++ % values.length];
};

const agent = (letter, state = "active") => ({ letter, hue: 200, state });

test("with no agent, the orbits get random extras up to the minimum", () => {
  const cast = heroCast([], sequence(0.1, 0.9, 0.3, 0.7, 0.5));
  assert.equal(cast.length, HERO_MIN);
  assert.equal(new Set(cast.map((a) => a.letter)).size, HERO_MIN, "letters are distinct");
});

test("your agents come first and keep their look; extras never reuse their letters", () => {
  const mine = [agent("Z", "busy"), agent("D", "waiting")];
  const cast = heroCast(mine, sequence(0.05, 0.6, 0.95, 0.2));
  assert.deepEqual(cast.slice(0, 2), mine);
  assert.equal(cast.length, HERO_MIN);
  for (const extra of cast.slice(2)) {
    assert.ok(!["Z", "D"].includes(extra.letter));
    assert.ok(["active", "inactive"].includes(extra.state), "an extra never pulses as working");
    assert.ok(!(extra.hue >= 20 && extra.hue <= 50) && !(extra.hue >= 100 && extra.hue <= 160), `hue ${extra.hue}`);
  }
});

test("enough agents: no extra, and no more than the maximum", () => {
  const eight = [..."ABCDEFGH"].map((l) => agent(l));
  assert.deepEqual(heroCast(eight), eight);
  const many = [..."ABCDEFGHIJKLMNOP"].map((l) => agent(l));
  assert.equal(heroCast(many).length, HERO_MAX);
});

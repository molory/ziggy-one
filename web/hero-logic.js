// @ts-check
// Who orbits Ziggy on the home screen (pure logic, no DOM: tested with node --test).
// Your agents first; with fewer than HERO_MIN, random extras fill the orbits so the scene never looks empty.

export const HERO_MIN = 8;
export const HERO_MAX = 12;

/** @typedef {{letter: string, hue: number, state: string}} HeroAgent */

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * @param {HeroAgent[]} agents your agents, in display order
 * @param {() => number} [random] Math.random by default (0 <= x < 1)
 * @returns {HeroAgent[]} between HERO_MIN and HERO_MAX agents
 */
export function heroCast(agents, random = Math.random) {
  const cast = agents.slice(0, HERO_MAX);
  const used = new Set(cast.map((a) => a.letter));
  while (cast.length < HERO_MIN) {
    const free = [...LETTERS].filter((l) => !used.has(l));
    const letter = free[Math.floor(random() * free.length)] ?? "Z";
    used.add(letter);
    // Same rule as the agents' colors: no hue close to the state dots (orange "thinking", green "active").
    let hue;
    do hue = Math.floor(random() * 360);
    while ((hue >= 20 && hue <= 50) || (hue >= 100 && hue <= 160));
    // Never "busy" or "waiting": a pulse would suggest real work.
    cast.push({ letter, hue, state: random() < 0.5 ? "active" : "inactive" });
  }
  return cast;
}

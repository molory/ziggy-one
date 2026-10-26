// @ts-check
// Tes messages, plus visibles dans le terminal. Claude Code les affiche sur un fond gris sombre
// (48;2;55;55;55), précédés d'un « ❯ » gris : au passage, le fond devient une teinte orange de Ziggy et
// le « ❯ » orange vif, en gras. On change la couleur à l'arrivée plutôt que de surligner des lignes :
// Claude Code redessine l'écran sans cesse, la couleur suit. Si Claude Code change ce gris (nouvelle
// version, autre /theme), rien n'est recoloré : l'affichage reste celui d'origine.

const encoder = new TextEncoder();
const USER_BACKGROUND = "\x1b[48;2;55;55;55m";
const PROMPT_GREY = "\x1b[38;2;153;153;153m";
const TINT_BACKGROUND = "\x1b[48;2;70;50;38m";
// Après le « ❯ », le gris attendu par Claude Code est remis : il ne le renvoie pas s'il le croit actif.
const TINT_PROMPT = `${TINT_BACKGROUND}\x1b[1;38;2;251;146;60m❯\x1b[22m${PROMPT_GREY} `;
// Du plus long au plus court. En redessinant l'écran, Claude Code omet le gris du « ❯ » s'il est déjà actif.
// « ❯ » suivi d'une espace : ton message ; suivi d'une espace insécable, c'est la zone de saisie.
const RULES = [
  [`${USER_BACKGROUND}${PROMPT_GREY}❯ `, TINT_PROMPT],
  [`${USER_BACKGROUND}❯ `, TINT_PROMPT],
  [USER_BACKGROUND, TINT_BACKGROUND],
].map(([from, to]) => [encoder.encode(from), encoder.encode(to)]);
const ESC = 0x1b;

/**
 * @param {Uint8Array} bytes
 * @param {number} at
 * @param {Uint8Array} pattern
 * @returns {"yes" | "no" | "maybe"} « maybe » : les octets s'arrêtent au milieu du motif
 */
function matchAt(bytes, at, pattern) {
  for (let i = 0; i < pattern.length; i++) {
    if (at + i >= bytes.length) return "maybe";
    if (bytes[at + i] !== pattern[i]) return "no";
  }
  return "yes";
}

/**
 * Recoloreur d'un flux d'écran. Une séquence peut arriver coupée entre deux morceaux : sa fin incomplète
 * est gardée pour le morceau suivant.
 */
export function createRecolor() {
  /** @type {Uint8Array} */
  let carry = new Uint8Array(0);
  return {
    /** @param {Uint8Array} chunk @returns {Uint8Array} */
    push(chunk) {
      const bytes = carry.length ? concat([carry, chunk]) : chunk;
      carry = new Uint8Array(0);
      /** @type {Uint8Array[]} */
      const parts = [];
      let start = 0;
      for (let i = bytes.indexOf(ESC); i !== -1; i = bytes.indexOf(ESC, i + 1)) {
        const results = RULES.map(([from]) => matchAt(bytes, i, from));
        if (results.includes("maybe")) {
          // Fin du morceau au milieu d'un motif possible (même après le fond : le « ❯ » peut suivre) : on attend la suite.
          parts.push(bytes.subarray(start, i));
          carry = bytes.slice(i);
          return concat(parts);
        }
        const rule = RULES[results.indexOf("yes")];
        if (rule) {
          parts.push(bytes.subarray(start, i), rule[1]);
          start = i + rule[0].length;
          i = start - 1;
        }
      }
      parts.push(bytes.subarray(start));
      return parts.length === 1 ? parts[0] : concat(parts);
    },
    reset() {
      carry = new Uint8Array(0);
    },
  };
}

/** @param {Uint8Array[]} parts */
function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

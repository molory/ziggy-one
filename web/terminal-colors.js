// @ts-check
// Your messages, more visible in the terminal. Claude Code shows them on a dark grey background
// (48;2;55;55;55), preceded by a grey "❯": on the way through, the background becomes a Ziggy orange tint and
// the "❯" bright orange, in bold. We change the color on arrival rather than highlighting lines:
// Claude Code redraws the screen constantly, the color follows. If Claude Code changes this grey (new
// version, other /theme), nothing is recolored: the display stays the original one.

const encoder = new TextEncoder();
const USER_BACKGROUND = "\x1b[48;2;55;55;55m";
const PROMPT_GREY = "\x1b[38;2;153;153;153m";
const TINT_BACKGROUND = "\x1b[48;2;70;50;38m";
// After the "❯", the grey Claude Code expects is restored: it does not send it again if it thinks it is active.
const TINT_PROMPT = `${TINT_BACKGROUND}\x1b[1;38;2;251;146;60m❯\x1b[22m${PROMPT_GREY} `;
// Longest to shortest. When redrawing the screen, Claude Code omits the grey of the "❯" if it is already active.
// "❯" followed by a space: your message; followed by a non-breaking space, it is the input box.
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
 * @returns {"yes" | "no" | "maybe"} "maybe": the bytes stop in the middle of the pattern
 */
function matchAt(bytes, at, pattern) {
  for (let i = 0; i < pattern.length; i++) {
    if (at + i >= bytes.length) return "maybe";
    if (bytes[at + i] !== pattern[i]) return "no";
  }
  return "yes";
}

/**
 * Recolorer of a screen stream. A sequence can arrive split between two chunks: its incomplete end
 * is kept for the next chunk.
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
          // End of the chunk in the middle of a possible pattern (even after the background: the "❯" may follow): wait for the rest.
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

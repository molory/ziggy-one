// @ts-check
// A message written outside the terminal (Discussion tab), as one would type it in Claude Code.

/**
 * Keys to send to type `text` (without the final Enter): each line break becomes Esc+Enter,
 * Claude Code's line break (Shift+Enter in the terminal). Control characters are removed: a
 * message cannot slip a sequence into the terminal. A tab becomes spaces (Tab completes, in
 * Claude Code). Spaces and empty lines at the ends of the message: removed.
 *
 * @param {string} text
 */
export function typedText(text) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "")
    .trim()
    .split("\n")
    .join("\x1b\r");
}

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

// Text files pasted as their content (Claude Code folds a long paste into "[Pasted text #1 +N lines]").
// Beyond this size, or for any other file, the terminal gets the file's path instead (see pasted.py).
export const MAX_PASTED_TEXT = 512 * 1024;
const TEXT_TYPES = /^(?:text\/|application\/(?:json|xml|x-yaml|yaml|toml|x-sh|javascript|x-python|sql)\b)/;
const TEXT_EXTENSIONS = new Set([
  "md", "markdown", "txt", "text", "csv", "tsv", "json", "jsonl", "yaml", "yml", "toml", "ini", "xml", "html",
  "css", "js", "mjs", "ts", "tsx", "jsx", "vue", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cpp",
  "cs", "php", "sh", "zsh", "sql", "log", "env", "conf", "diff", "patch",
]);

/**
 * Whether a pasted file is pasted as its text rather than as its path: a text type or extension, and not too large.
 * The content must still be valid UTF-8 (checked when it is read).
 *
 * @param {{name: string, type: string, size: number}} file
 */
export function pastedAsText(file) {
  if (file.size > MAX_PASTED_TEXT) return false;
  const extension = /\.([^./]+)$/.exec(file.name)?.[1]?.toLowerCase() ?? "";
  return TEXT_TYPES.test(file.type) || TEXT_EXTENSIONS.has(extension);
}

/**
 * Content of a pasted text file, safe to paste into the terminal: control characters are removed (except tab and
 * line breaks), so the file cannot end the bracketed paste ("\x1b[201~") and type keys into Claude Code.
 *
 * @param {string} text
 */
export function pastedText(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

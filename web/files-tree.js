// @ts-check
// Pure logic of the Files tab (no DOM, tested by tests/files-tree.test.mjs): search highlighting,
// breadcrumbs, sizes, indentation in the editor.

import { locale, t } from "./i18n.js";

/**
 * @typedef {{text: string, match: boolean}} Segment piece of text, highlighted or not
 */

/**
 * Positions of the query characters found in order in the path (fuzzy search), or null.
 * The file name is searched first, as it says more than the folders.
 *
 * @param {string} query
 * @param {string} path
 * @returns {number[] | null}
 */
export function fuzzyIndices(query, path) {
  const wanted = query.toLowerCase().replace(/\s+/g, "");
  if (!wanted) return [];
  const text = path.toLowerCase();
  /** @param {number} from */
  const scan = (from) => {
    const found = [];
    let at = from;
    for (const char of wanted) {
      at = text.indexOf(char, at);
      if (at < 0) return null;
      found.push(at++);
    }
    return found;
  };
  return scan(path.lastIndexOf("/") + 1) ?? scan(0);
}

/**
 * Splits a text into pieces by the positions to highlight (consecutive ones grouped).
 *
 * @param {string} text
 * @param {number[] | null} indices
 * @returns {Segment[]}
 */
export function segmentsFromIndices(text, indices) {
  const marked = new Set(indices ?? []);
  /** @type {Segment[]} */
  const segments = [];
  for (let i = 0; i < text.length; i++) {
    const match = marked.has(i);
    const last = segments[segments.length - 1];
    if (last && last.match === match) last.text += text[i];
    else segments.push({ text: text[i], match });
  }
  return segments;
}

/**
 * Highlights every occurrence of the query in the text, ignoring case.
 *
 * @param {string} text
 * @param {string} query
 * @returns {Segment[]}
 */
export function highlightOccurrences(text, query) {
  if (!query) return text ? [{ text, match: false }] : [];
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  /** @type {Segment[]} */
  const segments = [];
  let from = 0;
  for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, from)) {
    if (at > from) segments.push({ text: text.slice(from, at), match: false });
    segments.push({ text: text.slice(at, at + needle.length), match: true });
    from = at + needle.length;
  }
  if (from < text.length) segments.push({ text: text.slice(from), match: false });
  return segments;
}

/**
 * Breadcrumbs of a relative path: each part with the path leading to it.
 *
 * @param {string} file
 * @returns {{name: string, path: string}[]}
 */
export function breadcrumbs(file) {
  const parts = file.split("/").filter(Boolean);
  return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join("/") }));
}

/**
 * Parent folders of a file, from the top to the nearest: those to expand to show it.
 *
 * @param {string} file
 */
export function parentDirs(file) {
  return breadcrumbs(file).slice(0, -1).map((crumb) => crumb.path);
}

/**
 * Readable size, in the interface language: "512 B", "1.5 KB", "3.2 MB".
 *
 * @param {number} bytes
 */
export function formatSize(bytes) {
  const number = (/** @type {number} */ n) => n.toLocaleString(locale(), { maximumFractionDigits: 1 });
  if (bytes < 1024) return t("{size} B", { size: bytes });
  if (bytes < 1024 * 1024) return t("{size} KB", { size: number(bytes / 1024) });
  return t("{size} MB", { size: number(bytes / (1024 * 1024)) });
}

/** @param {string} file */
export const isMarkdown = (file) => /\.(md|markdown|mdx)$/i.test(file);

/**
 * Groups content search results by file, in order of arrival.
 *
 * @param {{file: string, line: number, text: string}[]} results
 * @returns {{file: string, lines: {line: number, text: string}[]}[]}
 */
export function groupByFile(results) {
  /** @type {Map<string, {line: number, text: string}[]>} */
  const groups = new Map();
  for (const { file, line, text } of results) {
    if (!groups.has(file)) groups.set(file, []);
    groups.get(file)?.push({ line, text });
  }
  return [...groups].map(([file, lines]) => ({ file, lines }));
}

/**
 * Indentation of the file: a tab if its lines start with one, otherwise 2 or 4 spaces.
 *
 * @param {string} text
 */
export function detectIndent(text) {
  let tabs = 0;
  let spaces = 0;
  let twos = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("\t")) tabs++;
    else {
      const width = /^ +(?=\S)/.exec(line)?.[0].length ?? 0;
      if (width) spaces++;
      if (width % 4 === 2) twos++;
    }
  }
  if (tabs > spaces) return "\t";
  return twos ? "  " : "    ";
}

/**
 * Tab key in the editor: inserts an indentation at the cursor, or indents (outdents with Shift)
 * every line of the selection. Returns the new text and the new selection.
 *
 * @param {string} value
 * @param {number} start
 * @param {number} end
 * @param {boolean} outdent
 * @param {string} [unit] indentation (see detectIndent)
 */
export function indentSelection(value, start, end, outdent, unit = "\t") {
  if (start === end && !outdent) {
    return { value: value.slice(0, start) + unit + value.slice(end), start: start + unit.length, end: start + unit.length };
  }
  const first = value.lastIndexOf("\n", start - 1) + 1;
  // A selection that stops at the start of a line does not include that line.
  const stop = end > start && value[end - 1] === "\n" ? end - 1 : end;
  const lineEnd = value.indexOf("\n", stop);
  const last = lineEnd < 0 ? value.length : lineEnd;
  const lines = value.slice(first, last).split("\n");
  let startShift = 0;
  let total = 0;
  const changed = lines.map((line, i) => {
    let delta;
    let next;
    if (outdent) {
      const removed = line.startsWith("\t") ? 1 : (/^ {1,4}/.exec(line)?.[0].length ?? 0);
      next = line.slice(removed);
      delta = -removed;
    } else {
      next = unit + line;
      delta = unit.length;
    }
    if (i === 0) startShift = delta;
    total += delta;
    return next;
  });
  // The selection start follows the text, unless it is at the start of a line (the line stays whole).
  const newStart = start === first && start !== end ? first : Math.max(first, start + startShift);
  return {
    value: value.slice(0, first) + changed.join("\n") + value.slice(last),
    start: newStart,
    end: start === end ? newStart : end + total,
  };
}

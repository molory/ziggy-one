// @ts-check
// Markdown of Claude's answers, with no dependency and no innerHTML: the text is first parsed into a
// structure (parseMarkdown, no DOM, testable with Node), then rendered element by element
// (renderMarkdown) with textContent. Links are only kept for http(s) and mailto. Images are only shown for
// badges (BADGE_IMAGE, also allowed by the page's CSP): any other image would let a text (an agent's answer,
// a ticket) make the browser call any server; it becomes a link. Task lists ("- [ ] …") can be ticked when the
// caller passes `onToggle`.

import { t } from "./i18n.js";

/**
 * @typedef {{type: "text" | "code", text: string}
 *   | {type: "strong" | "em" | "del", children: Inline[]}
 *   | {type: "link", href: string, children: Inline[]}
 *   | {type: "image", src: string, alt: string}} Inline
 * @typedef {{type: "heading", level: number, children: Inline[]}
 *   | {type: "paragraph", children: Inline[]}
 *   | {type: "code", lang: string, text: string}
 *   | {type: "quote", children: Block[]}
 *   | {type: "list", ordered: boolean, start: number, items: Block[][], tasks: (Task | null)[]}
 *   | {type: "table", head: Inline[][], rows: Inline[][][], align: string[]}
 *   | {type: "rule"}} Block
 * @typedef {{checked: boolean, line: number}} Task  "- [x] …" item; `line`: its line in the text (from 0)
 * @typedef {{onToggle?: (line: number, checked: boolean) => void}} RenderOptions
 */

const SAFE_LINK = /^(https?:\/\/|mailto:)/i;
// Static badges (shields.io, badgen): the only images loaded from outside. Keep in sync with the CSP (server.py).
export const BADGE_IMAGE = /^https:\/\/(img\.shields\.io|badgen\.net)\/badge\//i;
const INLINE = new RegExp(
  [
    /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/.source, // 1-2: code
    /\[((?:!\[[^\]\n]*\]\([^)\s]+\)|[^\]\n])+)\]\(([^)\s]+)\)/.source, // 3-4: link (its text can be an image: badge)
    /\*\*(?=\S)([\s\S]*?\S)\*\*/.source, // 5: bold
    /__(?=\S)([\s\S]*?\S)__/.source, // 6: bold
    /~~(?=\S)([\s\S]*?\S)~~/.source, // 7: strikethrough
    /\*(?=[^\s*])([\s\S]*?[^\s*])\*/.source, // 8: italic
    /(?<![\p{L}\p{N}_])_(?=\S)([\s\S]*?\S)_(?![\p{L}\p{N}_])/.source, // 9: italic
    /(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])/.source, // 10: bare URL
    /!\[([^\]\n]*)\]\(([^)\s]+)\)/.source, // 11-12: image
  ].join("|"),
  "gu",
);

/**
 * @param {string} text
 * @returns {Inline[]}
 */
export function parseInline(text) {
  /** @type {Inline[]} */
  const nodes = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    if (index > last) nodes.push({ type: "text", text: text.slice(last, index) });
    const [whole, , code, label, href, bold1, bold2, strike, em1, em2, url, alt, src] = match;
    if (code !== undefined) nodes.push({ type: "code", text: code.length > 1 && code.startsWith(" ") && code.endsWith(" ") ? code.slice(1, -1) : code });
    else if (label !== undefined) {
      nodes.push(SAFE_LINK.test(href) ? { type: "link", href, children: parseInline(label) } : { type: "text", text: whole });
    } else if (bold1 !== undefined || bold2 !== undefined) nodes.push({ type: "strong", children: parseInline(bold1 ?? bold2) });
    else if (strike !== undefined) nodes.push({ type: "del", children: parseInline(strike) });
    else if (em1 !== undefined || em2 !== undefined) nodes.push({ type: "em", children: parseInline(em1 ?? em2) });
    else if (url !== undefined) nodes.push({ type: "link", href: url, children: [{ type: "text", text: url }] });
    else if (src !== undefined) {
      if (BADGE_IMAGE.test(src)) nodes.push({ type: "image", src, alt });
      else if (SAFE_LINK.test(src)) nodes.push({ type: "link", href: src, children: [{ type: "text", text: alt || src }] });
      else nodes.push({ type: "text", text: whole });
    }
    last = index + whole.length;
  }
  if (last < text.length) nodes.push({ type: "text", text: text.slice(last) });
  // Consecutive text pieces (a rejected link, for example) merged into one.
  return nodes.reduce((merged, node) => {
    const previous = merged[merged.length - 1];
    if (node.type === "text" && previous?.type === "text") previous.text += node.text;
    else merged.push(node);
    return merged;
  }, /** @type {Inline[]} */ ([]));
}

const FENCE = /^\s{0,3}(```+|~~~+)\s*([\w+#.-]*)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const LIST_ITEM = /^(\s*)([-*+]|(\d{1,9})[.)])\s+(.*)$/;
const TASK = /^\[([ xX])\](?:\s+|$)/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** @param {string} line */
const splitRow = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());

/**
 * @param {string} text
 * @param {number} [offset] line of `text` in the whole text (a quote's content), for the task lines
 * @returns {Block[]}
 */
export function parseMarkdown(text, offset = 0) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  /** @type {Block[]} */
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // Code block (up to the closing fence, or to the end if it is not closed).
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      const body = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) body.push(lines[i++]);
      i += 1;
      blocks.push({ type: "code", lang: fence[2], text: body.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, children: parseInline(heading[2]) });
      i += 1;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ type: "rule" });
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const body = [];
      const first = i;
      while (i < lines.length && QUOTE.test(lines[i])) body.push(/** @type {RegExpExecArray} */ (QUOTE.exec(lines[i++]))[1]);
      blocks.push({ type: "quote", children: parseMarkdown(body.join("\n"), offset + first) });
      continue;
    }

    // Table: a header line with |, then a separator line.
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1])) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map((cell) => (cell.endsWith(":") ? (cell.startsWith(":") ? "center" : "right") : "left"));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(splitRow(lines[i++]).map(parseInline));
      blocks.push({ type: "table", head: head.map(parseInline), rows, align });
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const list = parseList(lines, i, offset);
      blocks.push(list.block);
      i = list.next;
      continue;
    }

    // Paragraph: up to an empty line or another block type. Line breaks are kept.
    const body = [];
    while (
      i < lines.length && lines[i].trim() && !FENCE.test(lines[i]) && !HEADING.test(lines[i])
      && !QUOTE.test(lines[i]) && !LIST_ITEM.test(lines[i]) && !RULE.test(lines[i])
      && !(lines[i].includes("|") && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1]))
    ) {
      body.push(lines[i++]);
    }
    blocks.push({ type: "paragraph", children: parseInline(body.join("\n")) });
  }
  return blocks;
}

/**
 * List (and its sublists, more indented) from line `start`.
 *
 * @param {string[]} lines
 * @param {number} start
 * @param {number} offset
 * @returns {{block: Block, next: number}}
 */
function parseList(lines, start, offset) {
  const first = /** @type {RegExpExecArray} */ (LIST_ITEM.exec(lines[start]));
  const indent = first[1].length;
  const ordered = first[3] !== undefined;
  /** @type {Block[][]} */
  const items = [];
  /** @type {(Task | null)[]} */
  const tasks = [];
  let i = start;
  while (i < lines.length) {
    const item = LIST_ITEM.exec(lines[i]);
    if (!item || item[1].length < indent || (item[1].length === indent && (item[3] !== undefined) !== ordered)) break;
    if (item[1].length > indent) {
      // Sublist: attached to the previous item.
      const sub = parseList(lines, i, offset);
      items[items.length - 1]?.push(sub.block);
      i = sub.next;
      continue;
    }
    // Item text: its line, plus the continuation lines (indented, not empty, not an item).
    const task = TASK.exec(item[4]);
    tasks.push(task ? { checked: task[1] !== " ", line: offset + i } : null);
    const text = [task ? item[4].slice(task[0].length) : item[4]];
    i += 1;
    while (i < lines.length && lines[i].trim() && !LIST_ITEM.test(lines[i]) && /^\s+/.test(lines[i])) text.push(lines[i++].trim());
    items.push([{ type: "paragraph", children: parseInline(text.join("\n")) }]);
    // Empty line between two items of the same list: keep going.
    if (i < lines.length && !lines[i].trim() && i + 1 < lines.length && LIST_ITEM.test(lines[i + 1])) {
      const nextItem = /** @type {RegExpExecArray} */ (LIST_ITEM.exec(lines[i + 1]));
      if (nextItem[1].length >= indent) i += 1;
    }
  }
  return { block: { type: "list", ordered, start: ordered ? Number(first[3]) : 1, items, tasks }, next: i };
}

/**
 * The text with the task of line `line` ticked or not ("- [ ]" ↔ "- [x]"); unchanged if that line has none.
 *
 * @param {string} text
 * @param {number} line
 * @param {boolean} checked
 */
export function toggleTask(text, line, checked) {
  const lines = text.split("\n");
  if (line < 0 || line >= lines.length) return text;
  lines[line] = lines[line].replace(/^((?:\s{0,3}>\s?)*\s*(?:[-*+]|\d{1,9}[.)])\s+)\[[ xX]\]/, `$1[${checked ? "x" : " "}]`);
  return lines.join("\n");
}

// --- rendering (browser) --------------------------------------------------------------------

/**
 * @param {Inline[]} nodes
 * @param {Node} parent
 */
function renderInline(nodes, parent) {
  for (const node of nodes) {
    if (node.type === "text") {
      parent.appendChild(document.createTextNode(node.text));
    } else if (node.type === "code") {
      const code = document.createElement("code");
      code.textContent = node.text;
      parent.appendChild(code);
    } else if (node.type === "image") {
      const image = document.createElement("img");
      image.src = node.src;
      image.alt = node.alt;
      image.className = "md-image";
      image.loading = "lazy";
      image.referrerPolicy = "no-referrer";
      parent.appendChild(image);
    } else if (node.type === "link") {
      const link = document.createElement("a");
      link.href = node.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      renderInline(node.children, link);
      parent.appendChild(link);
    } else {
      const tag = { strong: "strong", em: "em", del: "del" }[node.type];
      const element = document.createElement(tag);
      renderInline(node.children, element);
      parent.appendChild(element);
    }
  }
}

/**
 * @param {Block[]} blocks
 * @param {Node} parent
 * @param {RenderOptions} options
 */
function renderBlocks(blocks, parent, options) {
  for (const block of blocks) {
    if (block.type === "heading") {
      // Headings smaller than the page's: # becomes h3.
      const heading = document.createElement(`h${Math.min(6, block.level + 2)}`);
      renderInline(block.children, heading);
      parent.appendChild(heading);
    } else if (block.type === "paragraph") {
      const paragraph = document.createElement("p");
      renderInline(block.children, paragraph);
      parent.appendChild(paragraph);
    } else if (block.type === "code") {
      parent.appendChild(codeBlock(block.lang, block.text));
    } else if (block.type === "quote") {
      const quote = document.createElement("blockquote");
      renderBlocks(block.children, quote, options);
      parent.appendChild(quote);
    } else if (block.type === "list") {
      const list = document.createElement(block.ordered ? "ol" : "ul");
      if (block.ordered && block.start !== 1) /** @type {HTMLOListElement} */ (list).start = block.start;
      block.items.forEach((item, index) => {
        const li = document.createElement("li");
        renderBlocks(item, li, options);
        const task = block.tasks[index];
        if (task) {
          li.className = "md-task";
          const box = document.createElement("input");
          box.type = "checkbox";
          box.checked = task.checked;
          const { onToggle } = options;
          if (onToggle) box.addEventListener("change", () => onToggle(task.line, box.checked));
          else box.disabled = true;
          const first = li.firstChild;
          if (first instanceof HTMLParagraphElement) first.prepend(box);
          else li.prepend(box);
        }
        list.appendChild(li);
      });
      parent.appendChild(list);
    } else if (block.type === "table") {
      const wrapper = document.createElement("div");
      wrapper.className = "md-table";
      const table = document.createElement("table");
      const headRow = document.createElement("tr");
      block.head.forEach((cell, index) => {
        const th = document.createElement("th");
        th.style.textAlign = block.align[index] ?? "left";
        renderInline(cell, th);
        headRow.appendChild(th);
      });
      const thead = document.createElement("thead");
      thead.appendChild(headRow);
      const tbody = document.createElement("tbody");
      for (const row of block.rows) {
        const tr = document.createElement("tr");
        row.forEach((cell, index) => {
          const td = document.createElement("td");
          td.style.textAlign = block.align[index] ?? "left";
          renderInline(cell, td);
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      }
      table.append(thead, tbody);
      wrapper.appendChild(table);
      parent.appendChild(wrapper);
    } else if (block.type === "rule") {
      parent.appendChild(document.createElement("hr"));
    }
  }
}

/**
 * Code block: language and "Copy" button above it.
 *
 * @param {string} lang
 * @param {string} text
 */
function codeBlock(lang, text) {
  const wrapper = document.createElement("div");
  wrapper.className = "md-code";
  const bar = document.createElement("div");
  bar.className = "md-code-bar";
  const language = document.createElement("span");
  language.textContent = lang || "code";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "md-copy";
  copy.textContent = t("Copy");
  copy.addEventListener("click", () => {
    navigator.clipboard.writeText(text).then(
      () => {
        copy.textContent = t("Copied");
        setTimeout(() => {
          copy.textContent = t("Copy");
        }, 1500);
      },
      () => {
        copy.textContent = t("Copy failed");
      },
    );
  });
  bar.append(language, copy);
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.textContent = text;
  pre.appendChild(code);
  wrapper.append(bar, pre);
  return wrapper;
}

/**
 * Renders Markdown into an element (never interpreting HTML).
 *
 * @param {string} text
 * @param {HTMLElement} target
 * @param {RenderOptions} [options] `onToggle`: task boxes can be ticked (otherwise read-only)
 */
export function renderMarkdown(text, target, options = {}) {
  renderBlocks(parseMarkdown(text), target, options);
}

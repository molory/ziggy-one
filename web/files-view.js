// @ts-check
// Files screen of the chat card: tree of the agent's folder (loaded folder by folder), search by name
// or in the content (Ctrl+P), file preview (numbered text, Markdown, images) and simple editing of a text
// file, with conflict detection on save.
// Content and file names never go through innerHTML: text nodes only.

import {
  breadcrumbs, detectIndent, formatSize, fuzzyIndices, groupByFile, highlightOccurrences,
  indentSelection, isMarkdown, parentDirs, segmentsFromIndices,
} from "./files-tree.js";
import { t } from "./i18n.js";

const SEARCH_DELAY = 250; // ms
const LINE_HEIGHT = 1.5; // em, must match .files-code in style.css

/** Default icons, if the caller provides none. */
const DEFAULT_ICONS = {
  refresh: "M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  file: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5",
  chevron: "M9 6l6 6-6 6",
  copy: "M9 9h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H11a2 2 0 0 1-2-2zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1",
  save: "M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM7 3v5h8M7 21v-7h10v7",
  edit: "M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z",
  close: "M6 6l12 12M18 6L6 18",
};

/**
 * @typedef {object} FilesViewDeps
 * @property {(path: string, body?: object) => Promise<any>} api
 * @property {(tag: string, className?: string, text?: string) => HTMLElement} el
 * @property {(d: string) => SVGElement} icon
 * @property {(options: {title: string, message: string, confirmLabel?: string, danger?: boolean}) => Promise<boolean>} confirmDialog
 * @property {(text: string, target: HTMLElement) => void} renderMarkdown
 * @property {Partial<Record<keyof typeof DEFAULT_ICONS, string>>} [icons]
 *
 * @typedef {{name: string, type: "dir" | "file", size: number}} Entry
 * @typedef {{file: string, kind: string, size: number, version: string, content?: string, editable: boolean, mime?: string}} FileData
 */

/** @param {unknown} err */
function errorText(err) {
  if (err instanceof TypeError) return t("The ziggy-one server is not responding: check that it is running, then reload the page.");
  return err instanceof Error ? err.message : String(err);
}

/**
 * @param {HTMLElement} root container of the screen
 * @param {FilesViewDeps} deps
 */
export function mountFilesView(root, deps) {
  const { api, el, icon, confirmDialog, renderMarkdown } = deps;
  const icons = { ...DEFAULT_ICONS, ...deps.icons };
  /** @type {string | null} folder of the agent */
  let folder = null;
  /** @type {Map<string, {entries: Entry[], truncated: boolean}>} content of the folders already read */
  let listings = new Map();
  /** @type {Set<string>} expanded folders */
  const expanded = new Set();
  /** @type {FileData | null} open file */
  let current = null;
  let editing = false;
  let draft = ""; // editor text
  let showSource = false; // Markdown: source rather than preview
  let conflict = false; // the file changed on disk since it was read
  let highlightLine = 0;
  let busy = false;
  let searchTimer = 0;
  let searchSeq = 0; // ignores outdated search answers
  let openSeq = 0; // same for opening files

  // --- structure ---------------------------------------------------------------------
  root.classList.add("files-view");
  const side = el("nav", "files-side");
  side.setAttribute("aria-label", t("Files of the folder"));
  const searchRow = el("div", "files-search");
  const searchInput = /** @type {HTMLInputElement} */ (el("input", "text-input"));
  Object.assign(searchInput, { type: "search", placeholder: t("Search for a file… (Ctrl+P)"), autocomplete: "off", spellcheck: false });
  searchInput.setAttribute("aria-label", t("Search for a file"));
  const refreshButton = toolButton(icons.refresh, "", t("Refresh"), () => refresh());
  searchRow.append(searchInput, refreshButton);
  const contentToggle = el("label", "files-toggle");
  const contentBox = /** @type {HTMLInputElement} */ (el("input"));
  contentBox.type = "checkbox";
  contentToggle.append(contentBox, el("span", "", t("In the content")));
  const list = el("div", "files-list");
  side.append(searchRow, contentToggle, list);

  const main = el("section", "files-main");
  const header = el("div", "files-header");
  const crumbs = el("div", "files-crumbs");
  const meta = el("span", "files-meta");
  const dirtyMark = el("span", "files-dirty", t("• modified"));
  const actions = el("div", "files-actions");
  const copyButton = toolButton(icons.copy, t("Copy path"), t("Copy the full path of the file"), () => copyPath());
  const sourceButton = toolButton("", t("Source"), t("Switch between the preview and the source"), () => {
    showSource = !showSource;
    renderHeader();
    renderContent();
  });
  const editButton = toolButton(icons.edit, t("Edit"), t("Edit the file"), () => startEditing());
  const saveButton = toolButton(icons.save, t("Save"), t("Save (Ctrl+S)"), () => save());
  saveButton.classList.add("primary-tool");
  const cancelButton = toolButton(icons.close, t("Cancel"), t("Leave editing without saving"), () => cancelEditing());
  actions.append(copyButton, sourceButton, editButton, cancelButton, saveButton);
  header.append(crumbs, meta, dirtyMark, actions);
  const conflictBar = el("div", "files-conflict");
  const reloadButton = el("button", "", t("Reload"));
  const keepButton = el("button", "", t("Keep editing"));
  for (const b of [reloadButton, keepButton]) /** @type {HTMLButtonElement} */ (b).type = "button";
  conflictBar.append(el("span", "", t("The file changed on disk since you opened it.")), reloadButton, keepButton);
  reloadButton.addEventListener("click", () => reload());
  keepButton.addEventListener("click", () => {
    conflict = false;
    renderHeader();
  });
  const content = el("div", "files-content");
  main.append(header, conflictBar, content);

  const body = el("div", "files-body");
  body.append(side, main);
  const statusLine = el("p", "files-status-line");
  statusLine.setAttribute("aria-live", "polite");
  root.replaceChildren(body, statusLine);

  /**
   * @param {string} iconPath
   * @param {string} label
   * @param {string} title
   * @param {() => void} onClick
   */
  function toolButton(iconPath, label, title, onClick) {
    const button = /** @type {HTMLButtonElement} */ (el("button", "git-tool files-tool"));
    button.type = "button";
    button.title = title;
    button.setAttribute("aria-label", label || title);
    if (iconPath) button.append(icon(iconPath));
    if (label) button.append(el("span", "", label));
    button.addEventListener("click", onClick);
    return button;
  }

  /**
   * @param {string} message
   * @param {"info" | "error"} [kind]
   */
  function setStatus(message, kind = "info") {
    statusLine.textContent = message;
    statusLine.className = `files-status-line ${kind}`;
  }

  /** @param {boolean} on */
  function setBusy(on) {
    busy = on;
    root.classList.toggle("busy", on);
  }

  /**
   * @param {HTMLElement} parent
   * @param {{text: string, match: boolean}[]} segments
   */
  function appendSegments(parent, segments) {
    for (const s of segments) parent.append(s.match ? el("mark", "", s.text) : document.createTextNode(s.text));
  }

  // --- data ------------------------------------------------------------------------

  const query = (/** @type {Record<string, string>} */ params) =>
    Object.entries({ path: folder ?? "", ...params }).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  const readFile = (/** @type {string} */ file) => api(`/api/files/read?${query({ file })}`);

  /** @param {string} dir */
  async function fetchDir(dir) {
    const result = await api(`/api/files/list?${query({ dir })}`);
    return { entries: /** @type {Entry[]} */ (result.entries), truncated: Boolean(result.truncated) };
  }

  /** @param {string} dir */
  async function loadDir(dir) {
    try {
      listings.set(dir, await fetchDir(dir));
    } catch (err) {
      expanded.delete(dir);
      setStatus(errorText(err), "error");
    }
  }

  /** Rereads the root and the expanded folders (those that disappeared collapse). */
  async function refreshTree() {
    if (!folder) return;
    const asked = folder;
    const dirs = ["", ...expanded];
    const results = await Promise.allSettled(dirs.map(fetchDir));
    if (asked !== folder) return;
    const next = new Map();
    results.forEach((result, i) => {
      if (result.status === "fulfilled") next.set(dirs[i], result.value);
      else if (dirs[i]) expanded.delete(dirs[i]);
      else setStatus(errorText(result.reason), "error");
    });
    listings = next;
    renderTree();
  }

  // --- tree and results ----------------------------------------------------------------

  const searching = () => searchInput.value.trim() !== "";

  function renderTree() {
    if (searching()) return;
    const focused = /** @type {HTMLElement | null} */ (list.querySelector(":focus"))?.dataset.path;
    if (!folder || !listings.has("")) {
      list.replaceChildren(el("p", "muted small files-note", folder ? t("Loading…") : ""));
      return;
    }
    /** @type {HTMLElement[]} */
    const items = [];
    const walk = (/** @type {string} */ dir, /** @type {number} */ depth) => {
      const listing = listings.get(dir);
      if (!listing) {
        items.push(note(t("Loading…"), depth));
        return;
      }
      for (const entry of listing.entries) {
        const path = dir ? `${dir}/${entry.name}` : entry.name;
        items.push(treeItem(entry, path, depth));
        if (entry.type === "dir" && expanded.has(path)) walk(path, depth + 1);
      }
      if (listing.truncated) items.push(note(t("… list truncated"), depth));
      if (!dir && !listing.entries.length) items.push(note(t("Empty folder."), 0));
    };
    walk("", 0);
    list.replaceChildren(...items);
    if (focused) /** @type {HTMLElement | null} */ (list.querySelector(`[data-path="${CSS.escape(focused)}"]`))?.focus();
  }

  /**
   * @param {string} text
   * @param {number} depth
   */
  function note(text, depth) {
    const p = el("p", "muted small files-note", text);
    p.style.paddingLeft = `${1.6 + depth * 0.9}rem`;
    return p;
  }

  /**
   * @param {Entry} entry
   * @param {string} path
   * @param {number} depth
   */
  function treeItem(entry, path, depth) {
    const isDir = entry.type === "dir";
    const open = isDir && expanded.has(path);
    const button = el("button", `files-item${!isDir && current?.file === path ? " selected" : ""}`);
    /** @type {HTMLButtonElement} */ (button).type = "button";
    button.dataset.path = path;
    button.dataset.type = entry.type;
    button.title = path;
    button.style.paddingLeft = `${0.3 + depth * 0.9}rem`;
    const chevron = el("span", `files-chevron${open ? " open" : ""}`);
    if (isDir) {
      chevron.append(icon(icons.chevron));
      button.setAttribute("aria-expanded", String(open));
    }
    button.append(chevron, icon(isDir ? icons.folder : icons.file), el("span", "files-name", entry.name));
    button.addEventListener("click", () => (isDir ? toggleDir(path) : openFile(path)));
    return button;
  }

  /**
   * @param {string} dir
   * @param {boolean} [open]
   */
  async function toggleDir(dir, open = !expanded.has(dir)) {
    if (!open) {
      expanded.delete(dir);
      renderTree();
      return;
    }
    expanded.add(dir);
    renderTree();
    if (!listings.has(dir)) {
      await loadDir(dir);
      renderTree();
    }
  }

  /**
   * Expands the folders leading to this path (and this folder itself if it is one).
   *
   * @param {string[]} dirs
   */
  async function expandAll(dirs) {
    for (const dir of dirs) expanded.add(dir);
    await Promise.all(dirs.filter((dir) => !listings.has(dir)).map(loadDir));
    renderTree();
    list.querySelector(".files-item.selected")?.scrollIntoView({ block: "nearest" });
  }

  /** @param {string} dir */
  async function revealDir(dir) {
    clearSearch();
    await expandAll([...parentDirs(dir), dir]);
    /** @type {HTMLElement | null} */ (list.querySelector(`[data-path="${CSS.escape(dir)}"]`))?.focus();
  }

  // Keyboard: arrows to move, right/left to expand/collapse.
  list.addEventListener("keydown", (event) => {
    const items = /** @type {HTMLElement[]} */ ([...list.querySelectorAll("button")]);
    const target = /** @type {HTMLElement} */ (event.target);
    const index = items.indexOf(target);
    if (index < 0) return;
    const path = target.dataset.path ?? "";
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      items[Math.min(items.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)))].focus();
    } else if (event.key === "ArrowRight" && target.dataset.type === "dir" && !expanded.has(path)) {
      toggleDir(path, true);
    } else if (event.key === "ArrowLeft" && target.dataset.type === "dir" && expanded.has(path)) {
      toggleDir(path, false);
    } else if (event.key === "ArrowLeft" && path.includes("/")) {
      /** @type {HTMLElement | null} */ (list.querySelector(`[data-path="${CSS.escape(path.slice(0, path.lastIndexOf("/")))}"]`))?.focus();
    }
  });

  // --- search --------------------------------------------------------------------------

  /** @param {number} [delay] */
  function scheduleSearch(delay = SEARCH_DELAY) {
    clearTimeout(searchTimer);
    if (!searching()) {
      searchSeq++;
      renderTree();
      return;
    }
    searchTimer = window.setTimeout(runSearch, delay);
  }

  async function runSearch() {
    if (!folder || !searching()) return;
    const q = searchInput.value.trim();
    const mode = contentBox.checked ? "content" : "name";
    const seq = ++searchSeq;
    try {
      const result = await api(`/api/files/search?${query({ q, mode })}`);
      if (seq === searchSeq) renderResults(result.results ?? [], Boolean(result.truncated), q, mode);
    } catch (err) {
      if (seq === searchSeq) setStatus(errorText(err), "error");
    }
  }

  function clearSearch() {
    if (!searching()) return;
    searchInput.value = "";
    scheduleSearch();
  }

  /**
   * @param {any[]} results
   * @param {boolean} truncated
   * @param {string} q
   * @param {string} mode
   */
  function renderResults(results, truncated, q, mode) {
    /** @type {HTMLElement[]} */
    const items = [];
    const resultButton = (/** @type {string} */ className, /** @type {() => void} */ onClick) => {
      const button = el("button", `files-result ${className}`);
      /** @type {HTMLButtonElement} */ (button).type = "button";
      button.addEventListener("click", onClick);
      return button;
    };
    if (mode === "name") {
      for (const { file } of results) {
        const button = resultButton(`files-item${current?.file === file ? " selected" : ""}`, () => openFile(file));
        button.dataset.path = file;
        button.title = file;
        const name = el("span", "files-name");
        appendSegments(name, segmentsFromIndices(file, fuzzyIndices(q, file)));
        button.append(icon(icons.file), name);
        items.push(button);
      }
    } else {
      for (const group of groupByFile(results)) {
        const head = resultButton(`files-item files-group${current?.file === group.file ? " selected" : ""}`, () => openFile(group.file));
        head.dataset.path = group.file;
        head.title = group.file;
        head.append(icon(icons.file), el("span", "files-name", group.file), el("span", "git-count", String(group.lines.length)));
        items.push(head);
        for (const hit of group.lines) {
          const button = resultButton("files-hit", () => openFile(group.file, hit.line));
          button.append(el("span", "files-hit-line", `${hit.line}:`));
          const text = el("span", "files-hit-text");
          appendSegments(text, highlightOccurrences(hit.text.trimStart(), q));
          button.append(text);
          items.push(button);
        }
      }
    }
    if (!results.length) items.push(el("p", "muted small files-note", t("No results.")));
    if (truncated) items.push(el("p", "muted small files-note", t("Results truncated: refine your search.")));
    list.replaceChildren(...items);
  }

  searchInput.addEventListener("input", () => scheduleSearch());
  contentBox.addEventListener("change", () => {
    scheduleSearch(0);
    searchInput.focus();
  });
  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && searchInput.value) {
      event.preventDefault();
      event.stopPropagation();
      clearSearch();
    } else if (event.key === "ArrowDown" || event.key === "Enter") {
      const first = /** @type {HTMLElement | null} */ (list.querySelector("button"));
      if (!first) return;
      event.preventDefault();
      if (event.key === "Enter" && searching()) first.click();
      else first.focus();
    }
  });

  // --- open file -----------------------------------------------------------------------

  const isDirty = () => editing && current !== null && draft !== (current.content ?? "");

  /** Asks for confirmation before losing unsaved changes. */
  async function confirmDiscard(/** @type {"open" | "leave" | "agent"} */ reason) {
    if (!isDirty()) return true;
    const file = current?.file;
    const messages = {
      open: () => t("The changes to \"{file}\" are not saved: they will be lost if you open another file.", { file }),
      leave: () => t("The changes to \"{file}\" are not saved: they will be lost if you leave editing.", { file }),
      agent: () => t("The changes to \"{file}\" are not saved: they will be lost if you switch agents.", { file }),
    };
    return confirmDialog({
      title: t("Discard your changes?"),
      message: messages[reason](),
      confirmLabel: t("Discard"),
      danger: true,
    });
  }

  /**
   * @param {string} file
   * @param {number} [line] line to show (content search)
   */
  async function openFile(file, line = 0) {
    if (current?.file === file) {
      highlightLine = line;
      if (editing) placeCaret();
      else renderContent();
      return;
    }
    if (!(await confirmDiscard("open"))) return;
    const seq = ++openSeq;
    try {
      const data = await readFile(file);
      if (seq !== openSeq) return;
      showFile(data, line);
      expandAll(parentDirs(file));
    } catch (err) {
      if (seq === openSeq) setStatus(errorText(err), "error");
    }
  }

  /**
   * @param {FileData} data
   * @param {number} [line]
   */
  function showFile(data, line = 0) {
    const sameFile = current?.file === data.file;
    current = data;
    editing = false;
    draft = data.content ?? "";
    conflict = false;
    if (!sameFile) showSource = false;
    highlightLine = line;
    setStatus("");
    renderHeader();
    renderContent();
    for (const item of list.querySelectorAll(".files-item")) {
      item.classList.toggle("selected", /** @type {HTMLElement} */ (item).dataset.path === data.file && /** @type {HTMLElement} */ (item).dataset.type !== "dir");
    }
  }

  async function reload() {
    if (!current) return;
    const confirmed = !isDirty() || await confirmDialog({
      title: t("Reload the file?"),
      message: t("Your unsaved changes will be replaced by the version on disk."),
      confirmLabel: t("Reload"),
      danger: true,
    });
    if (!confirmed) return;
    try {
      showFile(await readFile(current.file));
      setStatus(t("File reloaded from disk."));
    } catch (err) {
      setStatus(errorText(err), "error");
    }
  }

  function renderHeader() {
    header.hidden = !current;
    conflictBar.hidden = !conflict;
    if (!current) return;
    const file = current.file;
    crumbs.replaceChildren();
    breadcrumbs(file).forEach((crumb, i, all) => {
      if (i) crumbs.append(el("span", "files-sep", "/"));
      if (i === all.length - 1) {
        crumbs.append(el("strong", "files-crumb-file", crumb.name));
        return;
      }
      const button = el("button", "files-crumb", crumb.name);
      /** @type {HTMLButtonElement} */ (button).type = "button";
      button.title = t("Show {path} in the tree", { path: crumb.path });
      button.addEventListener("click", () => revealDir(crumb.path));
      crumbs.append(button);
    });
    crumbs.title = file;
    const text = current.kind === "text";
    meta.textContent = text && !current.editable ? t("{size} · read-only", { size: formatSize(current.size) }) : formatSize(current.size);
    const markdown = text && isMarkdown(file) && !editing;
    sourceButton.hidden = !markdown;
    sourceButton.replaceChildren(el("span", "", showSource ? t("Preview") : t("Source")));
    sourceButton.setAttribute("aria-label", showSource ? t("Show the preview") : t("Show the source"));
    editButton.hidden = editing || !(text && current.editable);
    saveButton.hidden = !editing;
    cancelButton.hidden = !editing;
    updateDirty();
  }

  function updateDirty() {
    const dirty = isDirty();
    dirtyMark.hidden = !dirty;
    /** @type {HTMLButtonElement} */ (saveButton).disabled = !dirty;
  }

  function renderContent() {
    if (!current) {
      content.replaceChildren(el("p", "muted files-placeholder", t("Choose a file on the left, or find it with Ctrl+P.")));
      return;
    }
    const { kind, file } = current;
    if (kind === "image") {
      const frame = el("div", "files-image");
      const img = /** @type {HTMLImageElement} */ (el("img"));
      img.src = `/api/files/raw?${query({ file, v: current.version ?? "" })}`;
      img.alt = file;
      frame.append(img);
      content.replaceChildren(frame);
    } else if (kind === "too_large") {
      content.replaceChildren(el("p", "muted files-placeholder", t("File too large to preview ({size}).", { size: formatSize(current.size) })));
    } else if (kind !== "text") {
      content.replaceChildren(el("p", "muted files-placeholder", t("Binary file: no preview.")));
    } else if (editing) {
      content.replaceChildren(editor());
      placeCaret();
    } else if (isMarkdown(file) && !showSource) {
      const preview = el("div", "files-markdown markdown");
      renderMarkdown(current.content ?? "", preview);
      content.replaceChildren(preview);
    } else {
      content.replaceChildren(codeView(current.content ?? ""));
    }
  }

  /** @param {string} text */
  function codeView(text) {
    const scroller = el("div", "files-code");
    const inner = el("div", "files-code-inner");
    const lines = text.split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop(); // final line break
    const gutter = el("pre", "files-gutter", lines.map((_, i) => i + 1).join("\n"));
    gutter.setAttribute("aria-hidden", "true");
    inner.append(gutter, el("pre", "files-text", text));
    scroller.append(inner);
    if (highlightLine > 0) {
      const mark = el("div", "files-line-mark");
      mark.style.top = `calc(0.5rem + ${(highlightLine - 1) * LINE_HEIGHT}em)`;
      inner.append(mark);
      requestAnimationFrame(() => {
        scroller.scrollTop = mark.offsetTop - scroller.clientHeight / 3;
      });
    }
    return scroller;
  }

  // --- editing -------------------------------------------------------------------------

  /** @type {HTMLTextAreaElement | null} */
  let area = null;

  function editor() {
    const textarea = /** @type {HTMLTextAreaElement} */ (el("textarea", "files-editor"));
    Object.assign(textarea, { value: draft, spellcheck: false, wrap: "off" });
    textarea.setAttribute("autocapitalize", "off");
    textarea.setAttribute("aria-label", t("Content of {file}", { file: current?.file }));
    const unit = detectIndent(current?.content ?? "");
    textarea.addEventListener("input", () => {
      draft = textarea.value;
      updateDirty();
    });
    textarea.addEventListener("keydown", (event) => {
      if (event.key !== "Tab" || event.ctrlKey || event.altKey || event.metaKey) return;
      event.preventDefault();
      const r = indentSelection(textarea.value, textarea.selectionStart, textarea.selectionEnd, event.shiftKey, unit);
      replaceText(textarea, r.value);
      textarea.setSelectionRange(r.start, r.end);
    });
    area = textarea;
    return textarea;
  }

  /**
   * Replaces the text touching only the changed part, through insertText when the browser allows it:
   * undo (Ctrl+Z) keeps working.
   *
   * @param {HTMLTextAreaElement} textarea
   * @param {string} next
   */
  function replaceText(textarea, next) {
    const old = textarea.value;
    let a = 0;
    while (a < old.length && a < next.length && old[a] === next[a]) a++;
    let b = 0;
    while (b < old.length - a && b < next.length - a && old[old.length - 1 - b] === next[next.length - 1 - b]) b++;
    textarea.setSelectionRange(a, old.length - b);
    const inserted = document.execCommand?.("insertText", false, next.slice(a, next.length - b));
    if (!inserted || textarea.value !== next) textarea.value = next;
    draft = next;
    updateDirty();
  }

  /** Puts the cursor at the start of the requested line (or of the file) and focuses the editor. */
  function placeCaret() {
    if (!area) return;
    const textarea = area;
    let offset = 0;
    for (let line = 1; line < highlightLine && offset >= 0; line++) offset = textarea.value.indexOf("\n", offset) + 1 || -1;
    offset = Math.max(0, offset);
    textarea.focus();
    textarea.setSelectionRange(offset, offset);
    const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight) || 18;
    if (highlightLine > 0) textarea.scrollTop = (highlightLine - 1) * lineHeight - textarea.clientHeight / 3;
  }

  function startEditing() {
    if (!current || current.kind !== "text" || !current.editable) return;
    editing = true;
    draft = current.content ?? "";
    renderHeader();
    renderContent();
  }

  async function cancelEditing() {
    if (!(await confirmDiscard("leave"))) return;
    editing = false;
    conflict = false;
    draft = current?.content ?? "";
    area = null;
    renderHeader();
    renderContent();
  }

  async function save() {
    if (!current || !editing || busy || !folder) return;
    const file = current.file;
    const text = draft;
    setBusy(true);
    setStatus(t("Saving…"));
    try {
      const result = await api("/api/files/write", { path: folder, file, content: text, version: current.version });
      current = { ...current, content: text, version: result.version, size: result.size };
      editing = false;
      conflict = false;
      area = null;
      setStatus(t("Saved."));
      renderHeader();
      renderContent();
    } catch (err) {
      // Conflict (HTTP 409): the file changed on disk. The error does not always carry the HTTP code:
      // then compare the version on disk with the one that was read.
      conflict = /** @type {any} */ (err)?.status === 409 || await changedOnDisk(file);
      setStatus(errorText(err), "error");
      renderHeader();
    } finally {
      setBusy(false);
    }
  }

  /** @param {string} file */
  async function changedOnDisk(file) {
    try {
      return (await readFile(file)).version !== current?.version;
    } catch {
      return false;
    }
  }

  async function copyPath() {
    if (!current || !folder) return;
    const absolute = `${folder.replace(/\/+$/, "")}/${current.file}`;
    try {
      await navigator.clipboard.writeText(absolute);
      setStatus(t("Path copied: {path}", { path: absolute }));
    } catch {
      setStatus(t("Copy failed (clipboard refused by the browser): {path}", { path: absolute }), "error");
    }
  }

  // Shortcuts: Ctrl+S saves, Ctrl+P searches for a file.
  root.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === "s") {
      event.preventDefault();
      if (editing) save();
    } else if (key === "p") {
      event.preventDefault();
      focusSearch();
    }
  });

  function focusSearch() {
    searchInput.focus();
    searchInput.select();
  }

  /** Rereads the tree (or reruns the search) and the open file if it is not being edited. */
  async function refresh() {
    if (!folder) return;
    if (searching()) runSearch();
    await refreshTree();
    if (current && !editing) {
      try {
        const data = await readFile(current.file);
        if (current && !editing && data.file === current.file && data.version !== current.version) showFile(data, highlightLine);
      } catch (err) {
        setStatus(errorText(err), "error");
      }
    }
  }

  renderHeader();
  renderContent();

  return {
    /**
     * Shows the files of this folder. Same folder: keep the state and reread the tree.
     *
     * @param {string} next
     */
    async open(next) {
      if (next === folder) {
        await refreshTree();
        return;
      }
      if (!(await confirmDiscard("agent"))) return;
      folder = next;
      listings = new Map();
      expanded.clear();
      current = null;
      editing = false;
      conflict = false;
      area = null;
      draft = "";
      highlightLine = 0;
      searchInput.value = "";
      clearTimeout(searchTimer);
      searchSeq++;
      openSeq++;
      setStatus("");
      renderHeader();
      renderContent();
      renderTree();
      await refreshTree();
    },
    refresh,
    hasUnsavedChanges: isDirty,
    focusSearch,
  };
}

// @ts-check
// Tasks mode: the Kanban boards. Sidebar (boards, collapsible workspaces, pins), and in the center
// the chosen board, or creation, or settings (board: name, color, columns; workspace).
// The list reuses the agents' CSS classes and pin and workspace functions: it looks and behaves
// the same way.

import { t, tn } from "./i18n.js";
import { mountBoardView } from "./kanban-board.js";
import { boardRow, tagHue, titleTags } from "./kanban-logic.js";
import { mountTicketDialog } from "./kanban-ticket.js";
import { orderRows, pinnedFirst } from "./pins.js";
import { matchesTerms, searchTerms } from "./sidebar-search.js";
import { memberKey, pinnedHead, splitByWorkspace, workspacePinKey } from "./workspaces.js";

const SELECTED_KEY = "zo-selected-board";
const COLLAPSED_KEY = "zo-collapsed-board-workspaces";
/** Tickets shown at most in search results (the rest is counted). */
const TICKET_RESULTS_MAX = 50;

/**
 * @typedef {import("./kanban-logic.js").Board} Board
 * @typedef {import("./kanban-logic.js").Ticket} Ticket
 * @typedef {import("./workspaces.js").Workspace} Workspace
 *
 * @typedef {object} KanbanDeps
 * @property {(path: string, body?: object) => Promise<any>} api
 * @property {(tag: string, className?: string, text?: string) => HTMLElement} el
 * @property {(d: string) => SVGElement} icon
 * @property {Record<string, string>} icons pin, gear, close, file, plus, workspace, board
 * @property {(options: any) => Promise<boolean>} confirmDialog
 * @property {(text: string, target: HTMLElement, options?: {onToggle?: (line: number, checked: boolean) => void}) => void} renderMarkdown
 * @property {(key: string) => number} autoHue automatic hue (same assignment as the agents)
 * @property {number[]} hues offered hues
 * @property {(text: string) => string} initialOf
 * @property {(epochSeconds: number) => string} shortDate
 *
 * @typedef {{list: HTMLElement, search: HTMLInputElement, title: HTMLElement, body: HTMLElement, settings: HTMLElement, close: HTMLElement, create: HTMLElement}} KanbanElements
 */

/** @param {string} key @param {any} fallback */
function loadSaved(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

/** @param {string} key @param {any} value */
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable: the choice holds for this tab only.
  }
}

/**
 * @param {KanbanElements} dom
 * @param {KanbanDeps} deps
 */
export function mountKanban(dom, deps) {
  const { api, el, icon, icons } = deps;
  /** @type {Board[]} */
  let boards = [];
  /** @type {Workspace[]} */
  let workspaces = [];
  /** @type {string[]} */
  let pins = [];
  /** @type {string | null} */
  let selected = loadSaved(SELECTED_KEY, null);
  /** @type {{kind: "board"} | {kind: "create"} | {kind: "settings", id: string} | {kind: "workspace", id: string}} */
  let view = { kind: "board" };
  /** @type {null | (() => void)} redraws the open settings view when the data changes */
  let viewRefresh = null;
  const collapsed = new Set(/** @type {string[]} */ (loadSaved(COLLAPSED_KEY, [])));
  let loaded = false;
  /** @type {Map<number, {id: string, board: string, boardName: string, title: string}>} all tickets, by number */
  let index = new Map();
  /** @type {number | undefined} */
  let indexTimer;

  async function loadIndex() {
    try {
      const data = await api("/api/kanbans/index");
      index = new Map(data.tickets.map((/** @type {any} */ t) => [t.number, t]));
      if (searchTerms(dom.search.value).length) drawList(); // results with the new titles
    } catch {
      // Index unavailable: "#42" references stay plain text.
    }
  }
  /** Reloads the index shortly after a series of changes (a single call for several events). */
  const refreshIndex = () => {
    clearTimeout(indexTimer);
    indexTimer = window.setTimeout(loadIndex, 300);
  };

  /**
   * Displayed address: /t/<number> when a ticket card is open, otherwise /#tasks.
   *
   * @param {string} url
   */
  const setAddress = (url) => {
    if (`${location.pathname}${location.hash}` !== url) history.replaceState(null, "", url);
  };

  const error = el("p", "form-error kanban-error");
  error.hidden = true;
  /** @param {unknown} err */
  const showError = (err) => {
    error.textContent = err instanceof Error ? err.message : String(err);
    error.hidden = false;
  };

  const boardHost = el("div", "kanban-host");
  const boardView = mountBoardView(boardHost, {
    api, el, icon, icons: { plus: icons.plus, file: icons.file }, showError,
    openTicket: (id) => {
      const data = boardView.current();
      const ticket = data?.tickets.find((t) => t.id === id);
      if (data && ticket) ticketDialog.open(ticket, data.board);
    },
  });
  const ticketDialog = mountTicketDialog({
    api, el, icon, icons: { close: icons.close, file: icons.file },
    confirmDialog: deps.confirmDialog, renderMarkdown: deps.renderMarkdown,
    lookup: (number) => index.get(number),
    onOpen: (number) => setAddress(`/t/${number}`),
    onClose: () => {
      if (location.pathname.startsWith("/t/")) setAddress("/#tasks");
    },
  });

  /** @param {{id: string, hue?: number | null}} item @param {string} prefix */
  const hueOf = (item, prefix) => (Number.isInteger(item.hue) ? /** @type {number} */ (item.hue) : deps.autoHue(`${prefix}:${item.id}`));

  // --- sidebar -------------------------------------------------------------------------------

  /** @param {string[]} next */
  function savePins(next) {
    if (JSON.stringify(next) === JSON.stringify(pins)) return;
    pins = next;
    api("/api/kanbans/pins", { pins }).catch(showError);
  }

  /**
   * Pin or gear button of a row.
   *
   * @param {string} className
   * @param {string} path
   * @param {string} title
   * @param {string} label
   * @param {() => void} onClick
   */
  function rowButton(className, path, title, label, onClick) {
    const button = el("button", className);
    button.type = "button";
    button.title = title;
    button.setAttribute("aria-label", label);
    button.append(icon(path));
    button.addEventListener("click", onClick);
    return button;
  }

  /** @param {{sessionId: string, board: Board}} row */
  function boardItem(row) {
    const board = row.board;
    const pinned = pins.includes(board.id);
    const isSelected = board.id === selected && view.kind === "board";
    const configuring = view.kind === "settings" && view.id === board.id;
    const classes = ["session", "board-row", isSelected && "selected", pinned && "pinned", configuring && "configuring"];
    const item = el("li", classes.filter(Boolean).join(" "));
    item.style.setProperty("--agent-hue", String(hueOf(board, "board")));
    const open = el("button", "session-open");
    open.type = "button";
    open.title = board.name;
    if (isSelected) open.setAttribute("aria-current", "true");
    const avatar = el("span", "agent-avatar board-avatar", deps.initialOf(board.name));
    avatar.setAttribute("aria-hidden", "true");
    const text = el("span", "agent-text");
    const meta = el("span", "muted small agent-meta");
    meta.append(el("span", "", deps.shortDate(board.updatedAt)));
    const count = board.ticketCount ?? 0;
    meta.append(el("span", "", count ? tn(count, "{n} ticket", "{n} tickets") : t("empty")));
    // Spread by column: a chip in the color of each non-empty column.
    const spread = el("span", "board-spread");
    for (const column of board.columns) {
      const n = board.counts?.[column.id] ?? 0;
      if (!n) continue;
      const chip = el("span", "board-spread-chip", String(n));
      if (Number.isInteger(column.hue)) chip.style.setProperty("--col-hue", String(column.hue));
      else chip.classList.add("neutral");
      chip.title = t("{name}: {n}", { name: column.name, n });
      spread.append(chip);
    }
    if (spread.childElementCount) meta.append(spread);
    text.append(el("span", "session-name", board.name), meta);
    open.append(avatar, text);
    open.addEventListener("click", () => selectBoard(board.id));
    const pin = rowButton("pin-button", icons.pin, pinned ? t("Unpin") : t("Pin to top"),
      pinned ? t("Unpin \"{name}\"", { name: board.name }) : t("Pin \"{name}\"", { name: board.name }), () => {
        savePins(pinned ? pins.filter((p) => p !== board.id) : [...pins, board.id]);
        drawList();
      });
    pin.setAttribute("aria-pressed", String(pinned));
    const gear = rowButton("pin-button more-button", icons.gear, t("Configure board"), t("Configure \"{name}\"", { name: board.name }),
      () => openSettings(board.id));
    const actions = el("div", "row-actions");
    actions.append(pin, gear);
    item.append(open, actions);
    return item;
  }

  /**
   * @param {Workspace} workspace
   * @param {{sessionId: string, board: Board}[]} rows
   */
  function workspaceItem(workspace, rows) {
    const isCollapsed = collapsed.has(workspace.id);
    const pinKey = workspacePinKey(workspace.id);
    const pinned = pins.includes(pinKey);
    const configuring = view.kind === "workspace" && view.id === workspace.id;
    const classes = ["workspace", isCollapsed && "collapsed", pinned && "pinned", configuring && "configuring"];
    const item = el("li", classes.filter(Boolean).join(" "));
    item.style.setProperty("--agent-hue", String(hueOf(workspace, "board-workspace")));
    const head = el("div", "workspace-head");
    const toggle = el("button", "workspace-toggle");
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", String(!isCollapsed));
    toggle.title = workspace.name;
    const badge = el("span", "workspace-icon", deps.initialOf(workspace.name));
    badge.setAttribute("aria-hidden", "true");
    const text = el("span", "agent-text");
    const count = rows.length === 0 ? t("No boards") : tn(rows.length, "{n} board", "{n} boards");
    text.append(el("span", "session-name", workspace.name), el("span", "muted small", count));
    const chevron = el("span", "workspace-chevron");
    chevron.setAttribute("aria-hidden", "true");
    toggle.append(badge, text, chevron);
    toggle.addEventListener("click", () => {
      if (collapsed.has(workspace.id)) collapsed.delete(workspace.id);
      else collapsed.add(workspace.id);
      save(COLLAPSED_KEY, [...collapsed]);
      drawList();
    });
    const pin = rowButton("pin-button", icons.pin, pinned ? t("Unpin") : t("Pin to top"),
      pinned ? t("Unpin workspace \"{name}\"", { name: workspace.name }) : t("Pin workspace \"{name}\"", { name: workspace.name }), () => {
        savePins(pinned ? pins.filter((key) => key !== pinKey) : [...pins, pinKey]);
        drawList();
      });
    pin.setAttribute("aria-pressed", String(pinned));
    const gear = rowButton("pin-button more-button", icons.gear, t("Configure workspace"),
      t("Configure workspace \"{name}\"", { name: workspace.name }), () => openWorkspaceSettings(workspace.id));
    const actions = el("div", "row-actions");
    actions.append(pin, gear);
    head.append(toggle, actions);
    item.append(head);
    if (!isCollapsed) {
      const body = el("ul", "workspace-agents");
      if (rows.length) {
        const { pinned: pinnedRows, others } = pinnedFirst(rows, pins);
        const pinnedItems = pinnedRows.map(boardItem);
        pinnedItems.at(-1)?.classList.toggle("pinned-last", others.length > 0);
        body.append(...pinnedItems, ...others.map(boardItem));
      } else {
        const empty = el("li", "workspace-empty");
        const add = el("button", "link-button", t("Add boards"));
        add.type = "button";
        add.addEventListener("click", () => openWorkspaceSettings(workspace.id));
        empty.append(add);
        body.append(empty);
      }
      item.append(body);
    }
    return item;
  }

  /**
   * Row of a ticket found by the search: a click opens its card, on its board.
   *
   * @param {{number: number, board: string, boardName: string, title: string}} ticket
   */
  function ticketResult(ticket) {
    const board = boards.find((b) => b.id === ticket.board);
    const item = el("li", "session ticket-result");
    if (board) item.style.setProperty("--agent-hue", String(hueOf(board, "board")));
    const open = el("button", "session-open");
    open.type = "button";
    open.title = `#${ticket.number} · ${ticket.title}`;
    const avatar = el("span", "agent-avatar board-avatar", deps.initialOf(ticket.boardName));
    avatar.setAttribute("aria-hidden", "true");
    const text = el("span", "agent-text");
    const { tags, rest } = titleTags(ticket.title);
    const title = el("span", "session-name");
    for (const tag of tags) {
      const chip = el("span", "kanban-tag", tag);
      chip.style.setProperty("--tag-hue", String(tagHue(tag)));
      title.append(chip, " ");
    }
    if (rest) title.append(rest);
    const meta = el("span", "muted small agent-meta");
    meta.append(el("span", "", `#${ticket.number}`), el("span", "", ticket.boardName));
    text.append(title, meta);
    open.append(avatar, text);
    open.addEventListener("click", () => openNumber(ticket.number));
    item.append(open);
    return item;
  }

  /**
   * Search results: the boards (name, workspace) and the tickets (number, title, board) that match.
   *
   * @param {string[]} terms
   */
  function searchItems(terms) {
    const workspaceName = (/** @type {Board} */ board) =>
      workspaces.find((w) => memberKey(w, boardRow(board)) !== undefined)?.name;
    const foundBoards = [...boards].sort((a, b) => b.updatedAt - a.updatedAt)
      .filter((board) => matchesTerms(terms, [board.name, workspaceName(board)]));
    const foundTickets = [...index.values()].sort((a, b) => b.number - a.number)
      .filter((ticket) => matchesTerms(terms, [`#${ticket.number}`, ticket.title, ticket.boardName]));
    if (!foundBoards.length && !foundTickets.length) return [el("li", "muted search-empty", t("No matching board or ticket."))];
    const items = foundBoards.map((board) => boardItem(boardRow(board)));
    if (foundTickets.length) {
      items.push(el("li", "search-group", tn(foundTickets.length, "{n} ticket", "{n} tickets")));
      items.push(...foundTickets.slice(0, TICKET_RESULTS_MAX).map(ticketResult));
      const more = foundTickets.length - TICKET_RESULTS_MAX;
      if (more > 0) items.push(el("li", "muted small search-empty", tn(more, "{n} more ticket: refine the search", "{n} more tickets: refine the search")));
    }
    return items;
  }

  function drawList() {
    const terms = searchTerms(dom.search.value);
    if (terms.length) {
      dom.list.replaceChildren(...searchItems(terms));
      return;
    }
    // Most recently changed first, like the agents.
    const rows = [...boards].sort((a, b) => b.updatedAt - a.updatedAt).map(boardRow);
    const { members, rest } = splitByWorkspace(rows, workspaces);
    const { pinned, others } = orderRows(rest, pins, () => true);
    const { head, unpinned } = pinnedHead(pinned, workspaces, pins);
    const block = (/** @type {Workspace} */ workspace) => workspaceItem(workspace, members.get(workspace.id) || []);
    if (!head.length && !unpinned.length && !others.length) {
      dom.list.replaceChildren(el("li", "muted", t("No boards. Create one with \"+\".")));
      return;
    }
    const headItems = head.map((entry) => (entry.kind === "agent" ? boardItem(entry.row) : block(entry.workspace)));
    headItems.at(-1)?.classList.toggle("pinned-last", unpinned.length + others.length > 0);
    dom.list.replaceChildren(...headItems, ...unpinned.map(block), ...others.map(boardItem));
  }

  // --- center card -------------------------------------------------------------------------

  /**
   * @param {string} title
   * @param {boolean} onBoard the board is shown (gear visible)
   * @param {Node[]} children
   */
  function showCard(title, onBoard, ...children) {
    dom.title.textContent = title;
    dom.settings.hidden = !onBoard;
    dom.close.hidden = onBoard || !boards.length;
    error.hidden = true;
    dom.body.replaceChildren(error, ...children);
  }

  /** @param {string} id */
  async function selectBoard(id) {
    selected = id;
    save(SELECTED_KEY, id);
    view = { kind: "board" };
    viewRefresh = null;
    const board = boards.find((b) => b.id === id);
    showCard(board?.name ?? t("Board"), true, boardHost);
    drawList();
    try {
      const data = await api(`/api/kanbans/${id}`);
      if (selected === id && view.kind === "board") boardView.show(data);
    } catch (err) {
      showError(err);
    }
  }

  /** Default view: the chosen board, otherwise the first one, otherwise creation. */
  function showDefault() {
    const board = boards.find((b) => b.id === selected) ?? boards[0];
    if (board) selectBoard(board.id);
    else openCreate();
  }

  /**
   * @param {string} iconPath
   * @param {string} title
   * @param {string} description
   * @param {() => void} onClick
   */
  function choiceTile(iconPath, title, description, onClick) {
    const tile = el("button", "choice-tile");
    tile.type = "button";
    const iconBox = el("span", "choice-icon");
    iconBox.append(icon(iconPath));
    const text = el("span", "choice-text");
    text.append(el("strong", "", title), el("span", "muted small", description));
    tile.append(iconBox, text);
    tile.addEventListener("click", onClick);
    return tile;
  }

  function openCreate() {
    view = { kind: "create" };
    viewRefresh = null;
    const choices = el("div", "create-choices");
    choices.append(
      choiceTile(icons.board, t("Board"), t("A Kanban: columns (To do, In progress, Done…) and tickets to move."), () => nameForm("board")),
      choiceTile(icons.workspace, t("Workspace"), t("A group to keep several boards together. It collapses in the list."), () => nameForm("workspace")),
    );
    const intro = boards.length ? t("What do you want to create?") : t("No boards yet: create the first one.");
    showCard(t("Create"), false, el("p", "muted", intro), choices);
    drawList();
    /** @type {HTMLElement | null} */ (choices.querySelector("button"))?.focus();
  }

  /** @param {"board" | "workspace"} kind */
  function nameForm(kind) {
    const form = el("form", "workspace-form");
    const label = el("label", "field-label", kind === "board" ? t("Board name") : t("Workspace name"));
    label.setAttribute("for", "kanban-name");
    const input = /** @type {HTMLInputElement} */ (el("input", "text-input"));
    Object.assign(input, { id: "kanban-name", maxLength: 80, required: true, autocomplete: "off",
      placeholder: kind === "board" ? t("E.g. Ziggy One") : t("E.g. Personal projects") });
    const back = el("button", "", t("Back"));
    back.type = "button";
    back.addEventListener("click", openCreate);
    const submit = /** @type {HTMLButtonElement} */ (el("button", "primary", kind === "board" ? t("Create board") : t("Create workspace")));
    submit.type = "submit";
    const actions = el("div", "panel-actions");
    actions.append(back, submit);
    form.append(label, input, actions);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      submit.disabled = true;
      try {
        if (kind === "board") {
          const created = await api("/api/kanbans", { name: input.value });
          if (!boards.some((b) => b.id === created.id)) boards = [...boards, created];
          selectBoard(created.id);
        } else {
          const created = await api("/api/kanbans/workspaces", { name: input.value });
          if (!workspaces.some((w) => w.id === created.id)) workspaces = [...workspaces, created];
          openWorkspaceSettings(created.id);
        }
      } catch (err) {
        showError(err);
        submit.disabled = false;
      }
    });
    showCard(kind === "board" ? t("New board") : t("New workspace"), false, form);
    input.focus();
  }

  /**
   * Swatches: "Auto" (or "Neutral") then the offered hues.
   *
   * @param {string} label
   * @param {number | null} current
   * @param {(hue: number | null) => void} onPick
   * @param {string} [noneLabel]
   */
  function swatches(label, current, onPick, noneLabel = t("Auto")) {
    const group = el("div", "swatches");
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", label);
    for (const hue of [null, ...deps.hues]) {
      const swatch = el("button", hue === null ? "swatch auto" : "swatch", hue === null ? noneLabel : "");
      swatch.type = "button";
      swatch.setAttribute("role", "radio");
      swatch.setAttribute("aria-checked", String(hue === current));
      swatch.title = hue === null ? noneLabel : t("Hue {hue}°", { hue });
      if (hue !== null) swatch.style.setProperty("--agent-hue", String(hue));
      swatch.addEventListener("click", () => onPick(hue));
      group.append(swatch);
    }
    return group;
  }

  /**
   * Board settings: name, color, columns (name, color, order, deletion), deletion of the board.
   *
   * @param {string} id
   */
  function openSettings(id) {
    view = { kind: "settings", id };
    const call = (/** @type {string} */ path, /** @type {object} */ body) => api(path, body).catch(showError);
    viewRefresh = () => {
      const board = boards.find((b) => b.id === id);
      if (!board) {
        showDefault();
        return;
      }
      // The current input (column name…) survives the redraw.
      const focused = /** @type {HTMLInputElement | null} */ (document.activeElement);
      const focusKey = focused?.dataset.focusKey;
      const typing = focusKey && focused?.tagName === "INPUT" ? focused.value : null;
      const nameForm = el("form", "settings-section");
      const nameLabel = el("label", "settings-title", t("Name"));
      nameLabel.setAttribute("for", "board-rename");
      const nameInput = /** @type {HTMLInputElement} */ (el("input", "text-input"));
      Object.assign(nameInput, { id: "board-rename", value: board.name, maxLength: 80, required: true, autocomplete: "off" });
      const rename = el("button", "primary", t("Rename"));
      rename.type = "submit";
      const nameRow = el("div", "inline-field");
      nameRow.append(nameInput, rename);
      nameForm.append(nameLabel, nameRow);
      nameForm.addEventListener("submit", (event) => {
        event.preventDefault();
        call(`/api/kanbans/${id}/update`, { name: nameInput.value });
      });

      const colorSection = el("div", "settings-section");
      colorSection.append(el("h3", "settings-title", t("Color")),
        swatches(t("Board color"), board.hue, (hue) => call(`/api/kanbans/${id}/update`, { hue })));

      const columnsSection = el("div", "settings-section");
      const list = el("ol", "column-editor");
      board.columns.forEach((column, index) => {
        const item = el("li", "column-editor-row");
        if (Number.isInteger(column.hue)) item.style.setProperty("--col-hue", String(column.hue));
        else item.classList.add("neutral");
        const colorPicker = el("details", "column-color");
        const dot = el("summary", "kanban-dot");
        dot.title = t("Column color");
        dot.setAttribute("aria-label", t("Color of \"{name}\"", { name: column.name }));
        colorPicker.append(dot, swatches(t("Color of \"{name}\"", { name: column.name }), column.hue,
          (hue) => call(`/api/kanbans/${id}/columns/${column.id}/update`, { hue }), t("Neutral")));
        const input = /** @type {HTMLInputElement} */ (el("input", "text-input"));
        Object.assign(input, { value: column.name, maxLength: 60, required: true, autocomplete: "off" });
        input.dataset.focusKey = `column-${column.id}`;
        input.setAttribute("aria-label", t("Column name"));
        const commit = () => {
          if (input.value.trim() && input.value.trim() !== column.name) {
            call(`/api/kanbans/${id}/columns/${column.id}/update`, { name: input.value });
          }
        };
        input.addEventListener("change", commit);
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
        });
        const up = el("button", "icon-button", "↑");
        const down = el("button", "icon-button", "↓");
        const moves = [[up, -1, "up", t("Move up"), t("Move up \"{name}\"", { name: column.name })],
          [down, 1, "down", t("Move down"), t("Move down \"{name}\"", { name: column.name })]];
        for (const [button, step, key, label, aria] of /** @type {[HTMLElement, number, string, string, string][]} */ (moves)) {
          /** @type {HTMLButtonElement} */ (button).type = "button";
          button.title = label;
          button.setAttribute("aria-label", aria);
          /** @type {HTMLButtonElement} */ (button).disabled = index + step < 0 || index + step >= board.columns.length;
          button.dataset.focusKey = `${key}-${column.id}`;
          button.addEventListener("click", () => call(`/api/kanbans/${id}/columns/${column.id}/move`, { index: index + step }));
        }
        const remove = el("button", "icon-button danger-icon");
        remove.type = "button";
        remove.title = t("Delete column");
        remove.setAttribute("aria-label", t("Delete \"{name}\"", { name: column.name }));
        remove.append(icon(icons.close));
        /** @type {HTMLButtonElement} */ (remove).disabled = board.columns.length === 1;
        remove.addEventListener("click", () => deleteColumn(board, column));
        const count = board.counts?.[column.id] ?? 0;
        item.append(colorPicker, input, el("span", "muted small column-editor-count", String(count)), up, down, remove);
        list.append(item);
      });
      const addForm = el("form", "inline-field");
      const addInput = /** @type {HTMLInputElement} */ (el("input", "text-input"));
      Object.assign(addInput, { placeholder: t("New column"), maxLength: 60, autocomplete: "off" });
      addInput.dataset.focusKey = "new-column";
      addInput.setAttribute("aria-label", t("Name of the new column"));
      const add = el("button", "", t("Add"));
      add.type = "submit";
      addForm.append(addInput, add);
      addForm.addEventListener("submit", (event) => {
        event.preventDefault();
        const name = addInput.value.trim();
        addInput.value = "";
        if (name) call(`/api/kanbans/${id}/columns`, { name });
      });
      columnsSection.append(el("h3", "settings-title", t("Columns")), list, addForm);

      const danger = el("div", "settings-section danger-zone");
      const remove = el("button", "danger", t("Delete board"));
      remove.type = "button";
      remove.addEventListener("click", async () => {
        const count = board.ticketCount ?? 0;
        const confirmed = await deps.confirmDialog({
          title: t("Delete \"{name}\"?", { name: board.name.slice(0, 60) }),
          message: count
            ? tn(count, "Its ticket and its attached files will be deleted.", "Its {n} tickets and their attached files will be deleted.")
            : t("The board is empty."),
          confirmLabel: t("Delete"),
          danger: true,
        });
        if (confirmed) call(`/api/kanbans/${id}/delete`, {});
      });
      danger.append(el("h3", "settings-title", t("Delete")), el("p", "muted small", t("Deletes the board, its tickets and their attached files.")), remove);

      const done = el("button", "primary", t("Done"));
      done.type = "button";
      done.addEventListener("click", () => selectBoard(id));
      const footer = el("div", "panel-actions");
      footer.append(done);
      showCard(t("Configure board"), false, nameForm, colorSection, columnsSection, danger, footer);
      dom.close.hidden = false;
      const again = /** @type {HTMLInputElement | null} */ (focusKey ? dom.body.querySelector(`[data-focus-key="${focusKey}"]`) : null);
      if (again) {
        if (typing !== null) again.value = typing;
        again.focus();
      }
      drawList();
    };
    viewRefresh();
  }

  /**
   * Deletes a column; if it has tickets, asks where to send them.
   *
   * @param {Board} board
   * @param {import("./kanban-logic.js").Column} column
   */
  async function deleteColumn(board, column) {
    const count = board.counts?.[column.id] ?? 0;
    const others = board.columns.filter((c) => c.id !== column.id);
    const select = /** @type {HTMLSelectElement} */ (el("select", "text-input"));
    select.setAttribute("aria-label", t("Column receiving the tickets"));
    for (const other of others) {
      const option = /** @type {HTMLOptionElement} */ (el("option", "", other.name));
      option.value = other.id;
      select.append(option);
    }
    const content = el("label", "field-label");
    content.append(el("span", "", `${t("Move its tickets to")} `), select);
    const confirmed = await deps.confirmDialog({
      title: t("Delete column \"{name}\"?", { name: column.name.slice(0, 60) }),
      message: count ? tn(count, "It contains {n} ticket.", "It contains {n} tickets.") : t("It is empty."),
      content: count ? content : undefined,
      confirmLabel: t("Delete"),
      danger: true,
    });
    if (!confirmed) return;
    api(`/api/kanbans/${board.id}/columns/${column.id}/delete`, count ? { into: select.value } : {}).catch(showError);
  }

  /**
   * Settings of a board workspace: name, color, boards (checkboxes), deletion.
   *
   * @param {string} id
   */
  function openWorkspaceSettings(id) {
    view = { kind: "workspace", id };
    const call = (/** @type {string} */ path, /** @type {object} */ body) => api(path, body).catch(showError);
    viewRefresh = () => {
      const workspace = workspaces.find((w) => w.id === id);
      if (!workspace) {
        showDefault();
        return;
      }
      const nameForm = el("form", "settings-section");
      const nameLabel = el("label", "settings-title", t("Name"));
      nameLabel.setAttribute("for", "board-workspace-rename");
      const nameInput = /** @type {HTMLInputElement} */ (el("input", "text-input"));
      Object.assign(nameInput, { id: "board-workspace-rename", value: workspace.name, maxLength: 80, required: true, autocomplete: "off" });
      const rename = el("button", "primary", t("Rename"));
      rename.type = "submit";
      const nameRow = el("div", "inline-field");
      nameRow.append(nameInput, rename);
      nameForm.append(nameLabel, nameRow);
      nameForm.addEventListener("submit", (event) => {
        event.preventDefault();
        call(`/api/kanbans/workspaces/${id}/update`, { name: nameInput.value });
      });
      const colorSection = el("div", "settings-section");
      colorSection.append(el("h3", "settings-title", t("Color")),
        swatches(t("Workspace color"), Number.isInteger(workspace.hue) ? /** @type {number} */ (workspace.hue) : null,
          (hue) => call(`/api/kanbans/workspaces/${id}/update`, { hue })));
      const boardsSection = el("div", "settings-section");
      const list = el("ul", "picker-list");
      for (const board of boards) {
        const row = boardRow(board);
        const key = memberKey(workspace, row);
        const elsewhere = key === undefined ? workspaces.find((w) => w.id !== id && memberKey(w, row) !== undefined) : undefined;
        const item = el("li", "picker-item");
        item.style.setProperty("--agent-hue", String(hueOf(board, "board")));
        const label = el("label", "picker-label");
        const box = /** @type {HTMLInputElement} */ (el("input"));
        box.type = "checkbox";
        box.checked = key !== undefined;
        box.addEventListener("change", () =>
          call(`/api/kanbans/workspaces/${id}/${box.checked ? "add" : "remove"}`, { board: board.id }));
        const avatar = el("span", "agent-avatar small-avatar", deps.initialOf(board.name));
        avatar.setAttribute("aria-hidden", "true");
        const text = el("span", "agent-text");
        text.append(el("span", "session-name", board.name),
          el("span", "muted small", elsewhere ? t("in \"{name}\"", { name: elsewhere.name }) : tn(board.ticketCount ?? 0, "{n} ticket", "{n} tickets")));
        label.append(box, avatar, text);
        item.append(label);
        list.append(item);
      }
      if (!boards.length) list.append(el("li", "muted small", t("No boards.")));
      boardsSection.append(el("h3", "settings-title", t("Boards")),
        el("p", "muted small", t("Check the boards to keep in this workspace. A board is in only one workspace at a time.")), list);
      const danger = el("div", "settings-section danger-zone");
      const remove = el("button", "danger", t("Delete workspace"));
      remove.type = "button";
      remove.addEventListener("click", async () => {
        const confirmed = await deps.confirmDialog({
          title: t("Delete \"{name}\"?", { name: workspace.name.slice(0, 60) }),
          message: t("Its boards go back to the main list. No board is deleted."),
          confirmLabel: t("Delete"),
          danger: true,
        });
        if (confirmed) call(`/api/kanbans/workspaces/${id}/delete`, {});
      });
      danger.append(el("h3", "settings-title", t("Delete")), el("p", "muted small", t("Its boards go back to the main list.")), remove);
      const done = el("button", "primary", t("Done"));
      done.type = "button";
      done.addEventListener("click", showDefault);
      const footer = el("div", "panel-actions");
      footer.append(done);
      showCard(t("Configure workspace"), false, nameForm, colorSection, boardsSection, danger, footer);
      dom.close.hidden = false;
      drawList();
    };
    viewRefresh();
  }

  /**
   * Opens a ticket card by its number (address /t/42, "#42" link, search result), on its board.
   *
   * @param {number} number
   */
  async function openNumber(number) {
    try {
      const found = await api(`/api/kanbans/tickets/number/${number}`);
      await selectBoard(found.board);
      const data = boardView.current();
      const ticket = data?.tickets.find((t) => t.id === found.ticket);
      if (data && ticket) ticketDialog.open(ticket, data.board);
    } catch (err) {
      showError(err);
      setAddress("/#tasks");
    }
  }

  dom.search.addEventListener("input", drawList);
  dom.create.addEventListener("click", openCreate);
  dom.settings.addEventListener("click", () => selected && openSettings(selected));
  dom.close.addEventListener("click", showDefault);

  return {
    openNumber,
    /** Loads boards, workspaces and pins (at startup, and after a reconnection). */
    async load() {
      await loadIndex();
      try {
        const data = await api("/api/kanbans");
        boards = data.boards;
        workspaces = data.workspaces;
        pins = data.pins;
        drawList();
        if (!loaded || (view.kind === "board" && !boards.some((b) => b.id === selected))) showDefault();
        else if (view.kind === "board" && selected) selectBoard(selected);
        loaded = true;
      } catch (err) {
        showError(err);
      }
    },
    /** @param {Board[]} list */
    onBoards(list) {
      boards = list;
      drawList();
      if (view.kind === "board" && selected) {
        const board = boards.find((b) => b.id === selected);
        if (board) dom.title.textContent = board.name;
      }
      viewRefresh?.();
    },
    /** @param {{board: Board | null, deleted?: string, tickets: Ticket[]}} data */
    onBoard(data) {
      refreshIndex(); // up-to-date titles and numbers for "#42" links
      ticketDialog.update(data);
      if (data.deleted) {
        ticketDialog.boardDeleted(data.deleted);
        if (data.deleted === selected) {
          selected = null;
          if (view.kind === "board" || (view.kind === "settings" && view.id === data.deleted)) showDefault();
        }
        return;
      }
      if (data.board && data.board.id === selected && view.kind === "board") {
        boardView.update(/** @type {any} */ (data));
      }
    },
    /** @param {Workspace[]} list */
    onWorkspaces(list) {
      workspaces = list;
      drawList();
      viewRefresh?.();
    },
    /** @param {string[]} list */
    onPins(list) {
      pins = list;
      drawList();
    },
  };
}

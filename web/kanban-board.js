// @ts-check
// Tasks mode: the board shown in the center. Columns side by side (horizontal scrolling), tickets as
// cards, quick add at the bottom of a column, "+" column at the end. Moves by drag and drop
// (the browser's native drag and drop, no library) or with the keyboard: Alt + arrows on a card.
// The move shows right away; the server's answer (kanban_board event) is authoritative.
// The last column (where finished tickets end up: "Done") can be archived, ticket by ticket or all at once:
// archived tickets leave the board (they are listed in the board settings, Archive tab).
// No content goes through innerHTML: text nodes only.

import { locale, t, tn } from "./i18n.js";
import {
  columnTickets, daysUntil, descriptionPreview, dropIndex, dueUrgency, keyboardMove, moveTicket, shareLink, tagHue, titleTags,
} from "./kanban-logic.js";

const TICKET_TYPE = "application/x-ziggy-ticket";

/**
 * @typedef {import("./kanban-logic.js").Board} Board
 * @typedef {import("./kanban-logic.js").Ticket} Ticket
 * @typedef {{board: Board, tickets: Ticket[]}} BoardData
 *
 * @typedef {object} BoardViewDeps
 * @property {(path: string, body?: object) => Promise<any>} api
 * @property {(tag: string, className?: string, text?: string) => HTMLElement} el
 * @property {(d: string) => SVGElement} icon
 * @property {{plus: string, file: string, archive: string}} icons
 * @property {(ticketId: string) => void} openTicket
 * @property {(err: unknown) => void} showError
 * @property {(options: {title: string, message: string, confirmLabel?: string}) => Promise<boolean>} confirmDialog
 */

/**
 * @param {HTMLElement} root
 * @param {BoardViewDeps} deps
 */
export function mountBoardView(root, deps) {
  const { api, el, icon } = deps;
  /** @type {BoardData | null} */
  let data = null;
  /** @type {{id: string, height: number} | null} ticket being dragged */
  let dragged = null;
  /** @type {BoardData | null} data received during a drag, shown at the end */
  let pending = null;
  /** @type {string | null} card to refocus after a keyboard move */
  let focusAfter = null;
  /** @type {string | null} column whose quick-add area is open */
  let addingIn = null;
  const placeholder = el("li", "kanban-placeholder");
  placeholder.setAttribute("aria-hidden", "true");

  /**
   * Color of a column: its hue, or neutral.
   *
   * @param {HTMLElement} target
   * @param {number | null} hue
   */
  const paint = (target, hue) => {
    if (Number.isInteger(hue)) target.style.setProperty("--col-hue", String(hue));
    target.classList.toggle("neutral", !Number.isInteger(hue));
  };

  /**
   * Moves a ticket: on screen right away, then on the server (which sends back the updated board).
   *
   * @param {string} id
   * @param {string} column
   * @param {number} index
   */
  function move(id, column, index) {
    if (!data) return;
    data = { ...data, tickets: moveTicket(data.tickets, id, column, index) };
    render();
    api(`/api/kanbans/tickets/${id}/move`, { column, index }).catch((err) => {
      deps.showError(err);
      // The server refused: go back to its state.
      api(`/api/kanbans/${data?.board.id}`).then(update).catch(() => {});
    });
  }

  /**
   * Ticket number: a click copies its link (to paste into another ticket or an agent).
   *
   * @param {Ticket} ticket
   */
  function numberButton(ticket) {
    const label = `#${ticket.number}`;
    const button = el("button", "kanban-card-number", label);
    /** @type {HTMLButtonElement} */ (button).type = "button";
    button.title = t("Copy the ticket link");
    button.setAttribute("aria-label", t("Copy the link of ticket {label}", { label }));
    /** @type {number | undefined} */
    let timer;
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      const url = await shareLink(api, location.origin, ticket);
      try {
        await navigator.clipboard.writeText(url);
        button.textContent = t("Link copied");
        button.classList.add("copied");
      } catch {
        button.textContent = label;
        deps.showError(new Error(t("Copy blocked by the browser. Ticket link: {url}", { url })));
      }
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        button.textContent = label;
        button.classList.remove("copied");
      }, 1500);
    });
    return button;
  }

  /**
   * Days left before the delivery date, redder as it approaches (--urgency 0…1); solid red when late.
   *
   * @param {string} due "YYYY-MM-DD"
   */
  function dueBadge(due) {
    const days = daysUntil(due);
    const label = days < 0 ? tn(-days, "{n} day late", "{n} days late")
      : days === 0 ? t("Today") : days === 1 ? t("Tomorrow") : tn(days, "{n} day", "{n} days");
    const badge = el("span", `kanban-due${days < 0 ? " late" : ""}`, label);
    badge.style.setProperty("--urgency", String(dueUrgency(days)));
    const [year, month, day] = due.split("-").map(Number);
    const date = new Date(year, month - 1, day).toLocaleDateString(locale(), { dateStyle: "medium" });
    badge.title = t("Delivery on {date}", { date });
    return badge;
  }

  /**
   * Archive button: on each card of the last column (one ticket), in its header (all its tickets).
   *
   * @param {string} className
   * @param {string} label
   * @param {() => void} onClick
   */
  function archiveButton(className, label, onClick) {
    const button = el("button", `icon-button ${className}`);
    /** @type {HTMLButtonElement} */ (button).type = "button";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.append(icon(deps.icons.archive));
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      onClick();
    });
    return button;
  }

  /** @param {Ticket} ticket */
  function archiveTicket(ticket) {
    if (!data) return;
    data = { ...data, tickets: data.tickets.map((t) => (t.id === ticket.id ? { ...t, archivedAt: Date.now() / 1000 } : t)) };
    render();
    api(`/api/kanbans/tickets/${ticket.id}/archive`, {}).catch((err) => {
      deps.showError(err);
      api(`/api/kanbans/${data?.board.id}`).then(update).catch(() => {});
    });
  }

  /**
   * @param {import("./kanban-logic.js").Column} column
   * @param {number} count
   */
  async function archiveColumn(column, count) {
    if (!data) return;
    const board = data.board.id;
    const confirmed = await deps.confirmDialog({
      title: t("Archive the tickets of \"{name}\"?", { name: column.name.slice(0, 60) }),
      message: tn(count, "{n} ticket will leave the board. You will find it in the board settings, Archive tab.",
        "{n} tickets will leave the board. You will find them in the board settings, Archive tab."),
      confirmLabel: t("Archive"),
    });
    if (confirmed) api(`/api/kanbans/${board}/archive`, { column: column.id }).catch(deps.showError);
  }

  /**
   * @param {Ticket} ticket
   * @param {boolean} archivable the ticket is in the last column
   */
  function card(ticket, archivable) {
    const item = el("li", "kanban-card");
    item.draggable = true;
    item.dataset.id = ticket.id;
    const open = el("button", "kanban-card-open");
    open.type = "button";
    open.dataset.id = ticket.id;
    open.setAttribute("aria-keyshortcuts", "Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown");
    open.title = t("Open the ticket · Alt + arrows to move it");
    const { tags, rest } = titleTags(ticket.title);
    if (rest) open.append(el("span", "kanban-card-title", rest));
    const preview = descriptionPreview(ticket.description);
    if (preview) open.append(el("span", "kanban-card-preview", preview));
    if (ticket.files.length) {
      const files = el("span", "kanban-card-meta");
      files.append(icon(deps.icons.file), el("span", "", String(ticket.files.length)));
      files.title = tn(ticket.files.length, "{n} attached file", "{n} attached files");
      open.append(files);
    }
    open.addEventListener("click", () => deps.openTicket(ticket.id));
    // Ticket number and title tags on the same line, above the title.
    const head = el("div", "kanban-card-head");
    head.append(numberButton(ticket));
    if (tags.length) {
      const chips = el("span", "kanban-card-tags");
      for (const tag of tags) {
        const chip = el("span", "kanban-tag", tag);
        chip.style.setProperty("--tag-hue", String(tagHue(tag)));
        chips.append(chip);
      }
      chips.addEventListener("click", () => deps.openTicket(ticket.id));
      head.append(chips);
    }
    if (ticket.due) head.append(dueBadge(ticket.due));
    if (archivable) {
      head.append(archiveButton("kanban-card-archive", t("Archive the ticket #{number}", { number: ticket.number }),
        () => archiveTicket(ticket)));
    }
    item.append(head);
    open.addEventListener("keydown", (event) => {
      if (!event.altKey || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key) || !data) return;
      event.preventDefault();
      const target = keyboardMove(data.board.columns, data.tickets, ticket.id, /** @type {any} */ (event.key));
      if (!target) return;
      focusAfter = ticket.id;
      move(ticket.id, target.column, target.index);
    });
    item.addEventListener("dragstart", (event) => {
      if (!event.dataTransfer) return;
      dragged = { id: ticket.id, height: item.offsetHeight };
      event.dataTransfer.setData(TICKET_TYPE, ticket.id);
      event.dataTransfer.effectAllowed = "move";
      placeholder.style.height = `${dragged.height}px`;
      // On the next tick: the browser has already taken the image of the dragged card.
      requestAnimationFrame(() => item.classList.add("dragging"));
    });
    item.addEventListener("dragend", () => {
      item.classList.remove("dragging");
      dragged = null;
      placeholder.remove();
      for (const zone of root.querySelectorAll(".drop-target")) zone.classList.remove("drop-target");
      if (pending) update(pending);
    });
    item.append(open);
    return item;
  }

  /**
   * Quick-add area at the bottom of a column: a title, Enter creates the ticket (Esc cancels).
   *
   * @param {string} columnId
   */
  function quickAdd(columnId) {
    const wrap = el("div", "kanban-add");
    if (addingIn !== columnId) {
      const open = el("button", "kanban-add-open");
      open.type = "button";
      open.append(icon(deps.icons.plus), el("span", "", t("Add a ticket")));
      open.addEventListener("click", () => {
        addingIn = columnId;
        render();
        /** @type {HTMLTextAreaElement | null} */ (root.querySelector(`.kanban-add textarea`))?.focus();
      });
      wrap.append(open);
      return wrap;
    }
    const input = /** @type {HTMLTextAreaElement} */ (el("textarea", "text-input kanban-add-input"));
    input.rows = 2;
    input.maxLength = 200;
    input.placeholder = t("Ticket title… (Enter to create, Esc to cancel)");
    const create = async () => {
      const title = input.value.trim();
      if (!title || !data) return;
      input.disabled = true;
      try {
        await api(`/api/kanbans/${data.board.id}/tickets`, { column: columnId, title });
        input.value = "";
      } catch (err) {
        deps.showError(err);
      } finally {
        input.disabled = false;
        input.focus();
      }
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        create();
      } else if (event.key === "Escape") {
        event.stopPropagation();
        addingIn = null;
        render();
      }
    });
    input.addEventListener("blur", () => {
      if (!input.value.trim() && addingIn === columnId) {
        addingIn = null;
        // After a possible click elsewhere (another column): do not redraw under the pointer.
        setTimeout(() => addingIn === null && render());
      }
    });
    wrap.append(input);
    return wrap;
  }

  /**
   * @param {import("./kanban-logic.js").Column} column
   * @param {number} index
   * @param {import("./kanban-logic.js").Column[]} columns
   */
  function columnSection(column, index, columns) {
    if (!data) return el("section");
    const tickets = columnTickets(data.tickets, column.id);
    const last = index === columns.length - 1 && columns.length > 1;
    const section = el("section", "kanban-column");
    section.dataset.column = column.id;
    paint(section, column.hue);
    const head = el("header", "kanban-column-head");
    const dot = el("span", "kanban-dot");
    dot.setAttribute("aria-hidden", "true");
    head.append(dot, el("h3", "kanban-column-name", column.name), el("span", "kanban-count", String(tickets.length)));
    if (last && tickets.length) {
      head.append(archiveButton("kanban-column-archive", t("Archive all the tickets of \"{name}\"", { name: column.name }),
        () => archiveColumn(column, tickets.length)));
    }
    const list = el("ol", "kanban-cards");
    list.setAttribute("aria-label", t("Tickets in \"{name}\"", { name: column.name }));
    list.append(...tickets.map((ticket) => card(ticket, last)));
    // Drag and drop: the insertion line follows the pointer in the hovered column.
    section.addEventListener("dragover", (event) => {
      if (!dragged || !event.dataTransfer?.types.includes(TICKET_TYPE)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      for (const zone of root.querySelectorAll(".drop-target")) if (zone !== section) zone.classList.remove("drop-target");
      section.classList.add("drop-target");
      const others = /** @type {HTMLElement[]} */ ([...list.querySelectorAll(".kanban-card")]).filter((c) => c.dataset.id !== dragged?.id);
      const index = dropIndex(others.map((c) => { const box = c.getBoundingClientRect(); return box.top + box.height / 2; }), event.clientY);
      const before = others[index] ?? null;
      if (placeholder.parentElement !== list || placeholder.nextElementSibling !== before) list.insertBefore(placeholder, before);
      placeholder.dataset.index = String(index);
    });
    section.addEventListener("drop", (event) => {
      if (!dragged || !event.dataTransfer?.types.includes(TICKET_TYPE)) return;
      event.preventDefault();
      const index = Number(placeholder.dataset.index ?? tickets.length);
      const id = dragged.id;
      placeholder.remove();
      move(id, column.id, index);
    });
    section.append(head, list, quickAdd(column.id));
    return section;
  }

  /** "+" column at the end of the board: adds a column. */
  function addColumn() {
    const section = el("section", "kanban-column kanban-new-column");
    const form = el("form", "kanban-new-column-form");
    const input = /** @type {HTMLInputElement} */ (el("input", "text-input"));
    Object.assign(input, { placeholder: t("New column"), maxLength: 60, autocomplete: "off" });
    input.setAttribute("aria-label", t("Name of the new column"));
    const add = el("button", "", t("Add"));
    add.type = "submit";
    form.append(input, add);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!input.value.trim() || !data) return;
      try {
        await api(`/api/kanbans/${data.board.id}/columns`, { name: input.value });
        input.value = "";
      } catch (err) {
        deps.showError(err);
      }
    });
    section.append(form);
    return section;
  }

  function render() {
    if (!data) {
      root.replaceChildren();
      return;
    }
    const scroll = /** @type {HTMLElement | null} */ (root.firstElementChild)?.scrollLeft ?? 0;
    const board = el("div", "kanban-board");
    board.append(...data.board.columns.map(columnSection), addColumn());
    root.replaceChildren(board);
    board.scrollLeft = scroll;
    if (focusAfter) {
      /** @type {HTMLElement | null} */ (root.querySelector(`.kanban-card-open[data-id="${focusAfter}"]`))?.focus();
      focusAfter = null;
    }
  }

  /** @param {BoardData} next */
  function update(next) {
    if (dragged) {
      pending = next; // no redraw under the pointer during a drag
      return;
    }
    pending = null;
    // The ticket that had the keyboard keeps it; the quick-add area keeps its input.
    const active = /** @type {HTMLElement | null} */ (document.activeElement);
    if (!focusAfter && active?.classList.contains("kanban-card-open") && root.contains(active)) focusAfter = active.dataset.id ?? null;
    const typing = active?.classList.contains("kanban-add-input") && root.contains(active)
      ? /** @type {HTMLTextAreaElement} */ (active).value : null;
    data = next;
    render();
    if (typing !== null) {
      const input = /** @type {HTMLTextAreaElement | null} */ (root.querySelector(".kanban-add-input"));
      if (input) {
        input.value = typing;
        input.focus();
      }
    }
  }

  return {
    /** @param {BoardData} next */
    show(next) {
      addingIn = null;
      update(next);
    },
    update,
    /** @returns {BoardData | null} */
    current: () => data,
    clear() {
      data = null;
      render();
    },
  };
}

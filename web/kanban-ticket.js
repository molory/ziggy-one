// @ts-check
// Tasks mode: a ticket's card, in a window (<dialog>). Title, column, Markdown description
// (Write / Preview tabs), attached files (button, drag and drop or paste), deletion.
// Changes are saved with "Save" (or Ctrl+Enter); closing with unsaved changes asks for confirmation.
// Files and column are saved right away.
// At the bottom, the ticket history (all its changes, kept by the server), newest first.

import { formatSize } from "./files-tree.js";
import { locale, t } from "./i18n.js";
import { splitReferences, ticketUrl } from "./kanban-logic.js";
import { toggleTask } from "./markdown.js";

const MAX_FILE = 25 * 1024 * 1024; // as in kanban.py

/**
 * @typedef {import("./kanban-logic.js").Board} Board
 * @typedef {import("./kanban-logic.js").Ticket} Ticket
 *
 * @typedef {object} TicketDeps
 * @property {(path: string, body?: object) => Promise<any>} api
 * @property {(tag: string, className?: string, text?: string) => HTMLElement} el
 * @property {(d: string) => SVGElement} icon
 * @property {{close: string, file: string}} icons
 * @property {(options: {title: string, message: string, confirmLabel?: string, cancelLabel?: string, danger?: boolean}) => Promise<boolean>} confirmDialog
 * @property {(text: string, target: HTMLElement, options?: {onToggle?: (line: number, checked: boolean) => void}) => void} renderMarkdown
 * @property {(number: number) => {title: string, boardName: string} | undefined} lookup ticket by its number
 * @property {(number: number) => void} onOpen card opened (the address becomes /t/<number>)
 * @property {() => void} onClose card closed
 */

/**
 * Replaces, in already formatted text, the "#42" of known tickets with links to /t/42
 * (outside code and links). Nodes are created one by one: no innerHTML.
 *
 * @param {HTMLElement} root
 * @param {TicketDeps["lookup"]} lookup
 */
export function linkReferences(root, lookup) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement?.closest("code, pre, a") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  /** @type {Text[]} */
  const nodes = [];
  while (walker.nextNode()) nodes.push(/** @type {Text} */ (walker.currentNode));
  for (const node of nodes) {
    const parts = splitReferences(node.data, (n) => lookup(n) !== undefined);
    if (!parts.some((part) => "number" in part)) continue;
    node.replaceWith(...parts.map((part) => {
      if (!("number" in part)) return document.createTextNode(part.text);
      const info = lookup(part.number);
      const link = document.createElement("a");
      link.href = `/t/${part.number}`;
      link.className = "ticket-ref";
      link.textContent = part.text;
      if (info) link.title = `#${part.number} · ${info.title}${info.boardName ? ` (${info.boardName})` : ""}`;
      return link;
    }));
  }
}

/** @param {File} file */
const readBase64 = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result).split(",", 2)[1] ?? ""));
    reader.addEventListener("error", () => reject(new Error(t("Cannot read {name}", { name: file.name }))));
    reader.readAsDataURL(file);
  });

/** @param {TicketDeps} deps */
export function mountTicketDialog(deps) {
  const { api, el, icon } = deps;
  const dialog = /** @type {HTMLDialogElement} */ (el("dialog", "modal ticket-dialog"));
  dialog.setAttribute("aria-label", "Ticket");
  document.body.append(dialog);
  dialog.addEventListener("close", () => deps.onClose());

  /** @type {Ticket | null} */
  let ticket = null;
  /** @type {Board | null} */
  let board = null;
  let saved = { title: "", description: "" };

  const title = /** @type {HTMLInputElement} */ (el("input", "ticket-title"));
  Object.assign(title, { maxLength: 200, autocomplete: "off", required: true });
  title.setAttribute("aria-label", t("Ticket title"));
  const close = el("button", "icon-button");
  close.type = "button";
  close.title = t("Close (Esc)");
  close.setAttribute("aria-label", t("Close"));
  close.append(icon(deps.icons.close));
  // Ticket number and "Copy link" button (address /t/<number>, to paste into a ticket or an agent).
  // The number copies the link too (as on the board's cards).
  const number = el("button", "ticket-number");
  /** @type {HTMLButtonElement} */ (number).type = "button";
  number.title = t("Copy the ticket link");
  const copy = el("button", "ticket-copy", t("Copy link"));
  copy.type = "button";
  /** @type {number | undefined} */
  let copiedTimer;
  // Link to share: with its read key, an agent can read the ticket (text) by following this link.
  /** @type {string | null} */
  let shareUrl = null;
  copy.addEventListener("click", async () => {
    if (!ticket) return;
    const url = shareUrl ?? ticketUrl(location.origin, ticket.number);
    try {
      await navigator.clipboard.writeText(url);
      copy.textContent = t("Link copied");
      number.classList.add("copied");
    } catch {
      // Clipboard blocked by the browser: show the link to copy by hand.
      copy.textContent = url;
    }
    copy.title = url;
    clearTimeout(copiedTimer);
    copiedTimer = window.setTimeout(() => {
      copy.textContent = t("Copy link");
      number.classList.remove("copied");
    }, 2000);
  });
  number.addEventListener("click", () => copy.click());
  const head = el("div", "ticket-head");
  head.append(number, title, copy, close);

  const columnSelect = /** @type {HTMLSelectElement} */ (el("select", "text-input ticket-column"));
  columnSelect.setAttribute("aria-label", t("Column"));
  const dates = el("span", "muted small");
  const meta = el("div", "ticket-meta");
  meta.append(el("span", "muted small", t("Column")), columnSelect, dates);

  // Delivery date: saved as soon as it is picked; "Remove" takes it off. Shown as a badge on the card.
  const dueInput = /** @type {HTMLInputElement} */ (el("input", "text-input ticket-due-input"));
  dueInput.type = "date";
  dueInput.id = "ticket-due";
  const dueLabel = el("label", "muted small", t("Delivery date"));
  dueLabel.setAttribute("for", "ticket-due");
  const dueRemove = /** @type {HTMLButtonElement} */ (el("button", "link-button", t("Remove")));
  dueRemove.type = "button";
  dueRemove.setAttribute("aria-label", t("Remove the delivery date"));
  const dueRow = el("div", "ticket-meta ticket-due");
  dueRow.append(dueLabel, dueInput, dueRemove);
  /** @param {string | null} due */
  async function saveDue(due) {
    if (!ticket || (ticket.due ?? null) === due) return;
    error.hidden = true;
    try {
      await api(`/api/kanbans/tickets/${ticket.id}/update`, { due });
    } catch (err) {
      dueInput.value = ticket?.due ?? "";
      showError(err);
    }
  }
  // "change" fires once a full date is picked (typing it digit by digit does not save half a date).
  dueInput.addEventListener("change", () => {
    if (dueInput.value || !dueInput.validity.badInput) saveDue(dueInput.value || null);
  });
  dueRemove.addEventListener("click", () => {
    dueInput.value = "";
    saveDue(null);
  });

  // Description: Write / Preview.
  const tabs = el("div", "ticket-tabs");
  tabs.setAttribute("role", "tablist");
  const writeTab = el("button", "", t("Write"));
  const previewTab = el("button", "", t("Preview"));
  for (const tab of [writeTab, previewTab]) {
    /** @type {HTMLButtonElement} */ (tab).type = "button";
    tab.setAttribute("role", "tab");
  }
  tabs.append(writeTab, previewTab);
  const description = /** @type {HTMLTextAreaElement} */ (el("textarea", "text-input ticket-description"));
  description.placeholder = t("Description (Markdown: headings, lists, `code`, links…)");
  description.maxLength = 20000;
  description.setAttribute("aria-label", "Description");
  const preview = el("div", "ticket-preview markdown");
  /** @param {boolean} previewing */
  const showTab = (previewing) => {
    writeTab.setAttribute("aria-selected", String(!previewing));
    previewTab.setAttribute("aria-selected", String(previewing));
    description.hidden = previewing;
    preview.hidden = !previewing;
    if (previewing) {
      preview.replaceChildren();
      if (description.value.trim()) {
        deps.renderMarkdown(description.value, preview, { onToggle: toggleTaskBox });
        linkReferences(preview, deps.lookup); // "#42": link to ticket 42
      }
      else preview.append(el("p", "muted", t("No description.")));
    }
  };
  /**
   * Box of a task list ticked in the preview: the description changes; saved at once unless other changes
   * wait for "Save" (they would be saved with it).
   *
   * @param {number} line
   * @param {boolean} checked
   */
  const toggleTaskBox = (line, checked) => {
    const pending = dirty();
    description.value = toggleTask(description.value, line, checked);
    showTab(true);
    refreshSave();
    if (!pending) saveChanges();
  };
  writeTab.addEventListener("click", () => showTab(false));
  previewTab.addEventListener("click", () => showTab(true));

  // Attached files.
  const files = el("ul", "ticket-files");
  const picker = /** @type {HTMLInputElement} */ (el("input"));
  picker.type = "file";
  picker.multiple = true;
  picker.hidden = true;
  const attach = el("button", "", t("Attach files"));
  attach.type = "button";
  attach.addEventListener("click", () => picker.click());
  picker.addEventListener("change", () => {
    upload([...(picker.files ?? [])]);
    picker.value = "";
  });
  const filesSection = el("div", "ticket-files-section");
  filesSection.append(el("h3", "settings-title", t("Files")), files, attach, picker,
    el("p", "muted small", t("Drag or paste files into this window. 25 MB max per file.")));

  // History: reloaded on opening and on every change of the board.
  const history = /** @type {HTMLDetailsElement} */ (el("details", "ticket-history"));
  const historySummary = el("summary", "settings-title", t("History"));
  const historyList = el("ol", "ticket-history-list");
  history.append(historySummary, historyList);
  let historyRequest = 0;

  /**
   * Sentence for a change, with the names as they were at that time.
   *
   * @param {any} entry
   */
  function describe(entry) {
    switch (entry.kind) {
      case "created": return t("Created in \"{column}\"", { column: entry.column });
      case "title": return t("Title: \"{before}\" → \"{after}\"", { before: entry.before, after: entry.after });
      case "description": return entry.before ? t("Description changed") : t("Description added");
      case "due": return entry.after
        ? (entry.before ? t("Delivery date: {before} → {after}", { before: entry.before, after: entry.after })
          : t("Delivery date set: {after}", { after: entry.after }))
        : t("Delivery date removed");
      case "moved": {
        const params = { from: entry.fromColumn, to: entry.toColumn, reason: t(entry.reason) };
        return entry.reason ? t("Moved from \"{from}\" to \"{to}\" ({reason})", params) : t("Moved from \"{from}\" to \"{to}\"", params);
      }
      case "file_added": return t("File attached: {name} ({size})", { name: entry.name, size: formatSize(entry.size ?? 0) });
      case "file_removed": return t("File removed: {name}", { name: entry.name });
      default: return entry.kind;
    }
  }

  /** @param {any[]} entries oldest first */
  function renderHistory(entries) {
    historySummary.textContent = t("History ({count})", { count: entries.length });
    historyList.replaceChildren(...[...entries].reverse().map((entry) => {
      const item = el("li", `ticket-history-item kind-${entry.kind}`);
      const when = el("time", "muted small", new Date(entry.at * 1000).toLocaleString(locale(), { dateStyle: "short", timeStyle: "short" }));
      when.setAttribute("datetime", new Date(entry.at * 1000).toISOString());
      item.append(when, el("span", "", describe(entry)));
      // Change made by an agent (MCP tools): its name.
      if (entry.by && entry.by !== "user") item.append(el("span", "ticket-history-by muted small", t("by {name}", { name: entry.by })));
      // Description: before / after, collapsed.
      if (entry.kind === "description") {
        const diff = el("details", "ticket-history-diff");
        diff.append(el("summary", "link-button", t("Show before / after")));
        for (const [label, text] of [[t("Before"), entry.before], [t("After"), entry.after]]) {
          diff.append(el("span", "muted small", label), el("pre", "ticket-history-text", text || t("(empty)")));
        }
        item.append(diff);
      }
      return item;
    }));
    if (!entries.length) historyList.append(el("li", "muted small", t("No recorded changes.")));
  }

  async function loadHistory() {
    if (!ticket) return;
    const request = ++historyRequest;
    try {
      const data = await api(`/api/kanbans/tickets/${ticket.id}/history`);
      if (request === historyRequest) renderHistory(data.history);
    } catch {
      // Ticket deleted in the meantime: the card closes by itself.
    }
  }

  const error = el("p", "form-error");
  error.hidden = true;
  const remove = el("button", "danger", t("Delete ticket"));
  remove.type = "button";
  const save = /** @type {HTMLButtonElement} */ (el("button", "primary", t("Save")));
  save.type = "button";
  save.title = t("Save (Ctrl+Enter)");
  const footer = el("div", "ticket-footer");
  footer.append(remove, el("span", "spacer"), save);

  const body = el("div", "ticket-body");
  body.append(head, meta, dueRow, tabs, description, preview, filesSection, history, error, footer);
  dialog.append(body);

  /** @param {unknown} err */
  const showError = (err) => {
    error.textContent = err instanceof Error ? err.message : String(err);
    error.hidden = false;
  };
  const dirty = () => Boolean(ticket) && (title.value.trim() !== saved.title || description.value !== saved.description);
  const refreshSave = () => {
    save.disabled = !dirty() || !title.value.trim();
  };
  title.addEventListener("input", refreshSave);
  description.addEventListener("input", refreshSave);

  /** The ticket's files and column, from the latest data received. */
  function renderLive() {
    if (!ticket || !board) return;
    columnSelect.replaceChildren(...board.columns.map((column) => {
      const option = /** @type {HTMLOptionElement} */ (el("option", "", column.name));
      option.value = column.id;
      option.selected = column.id === ticket?.column;
      return option;
    }));
    const when = (/** @type {number} */ time) => new Date(time * 1000).toLocaleString(locale(), { dateStyle: "short", timeStyle: "short" });
    dates.textContent = t("Created {created} · modified {updated}", { created: when(ticket.createdAt), updated: when(ticket.updatedAt) });
    if (document.activeElement !== dueInput) dueInput.value = ticket.due ?? "";
    dueRemove.hidden = !ticket.due;
    files.replaceChildren(...ticket.files.map((file) => {
      const item = el("li", "ticket-file");
      const link = /** @type {HTMLAnchorElement} */ (el("a", "ticket-file-link"));
      link.href = `/api/kanbans/tickets/${ticket?.id}/files/${file.id}/${encodeURIComponent(file.name)}`;
      link.target = "_blank";
      link.rel = "noopener";
      link.append(icon(deps.icons.file), el("span", "", file.name));
      const drop = el("button", "link-button", t("Remove"));
      drop.type = "button";
      drop.setAttribute("aria-label", t("Remove \"{name}\"", { name: file.name }));
      drop.addEventListener("click", async () => {
        try {
          await api(`/api/kanbans/tickets/${ticket?.id}/files/${file.id}/delete`, {});
        } catch (err) {
          showError(err);
        }
      });
      item.append(link, el("span", "muted small", formatSize(file.size)), drop);
      return item;
    }));
    if (!ticket.files.length) files.append(el("li", "muted small", t("No files.")));
  }

  /** @param {File[]} list */
  async function upload(list) {
    if (!ticket) return;
    const id = ticket.id;
    error.hidden = true;
    for (const file of list) {
      if (file.size > MAX_FILE) {
        showError(t("\"{name}\" is too large (25 MB max).", { name: file.name }));
        continue;
      }
      try {
        await api(`/api/kanbans/tickets/${id}/files`, { name: file.name, type: file.type, data: await readBase64(file) });
      } catch (err) {
        showError(err);
      }
    }
  }

  async function saveChanges() {
    if (!ticket || save.disabled) return;
    error.hidden = true;
    save.disabled = true;
    try {
      await api(`/api/kanbans/tickets/${ticket.id}/update`, { title: title.value, description: description.value });
      saved = { title: title.value.trim(), description: description.value };
    } catch (err) {
      showError(err);
    }
    refreshSave();
  }
  save.addEventListener("click", saveChanges);
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      saveChanges();
    } else if (event.key === "Enter" && event.target === title) {
      event.preventDefault();
      saveChanges();
    }
  });

  columnSelect.addEventListener("change", async () => {
    if (!ticket) return;
    try {
      await api(`/api/kanbans/tickets/${ticket.id}/move`, { column: columnSelect.value, index: 1e6 });
    } catch (err) {
      showError(err);
    }
  });

  remove.addEventListener("click", async () => {
    if (!ticket) return;
    const confirmed = await deps.confirmDialog({
      title: t("Delete \"{name}\"?", { name: ticket.title.slice(0, 60) }),
      message: ticket.files.length ? t("The ticket and its attached files will be deleted.") : t("The ticket will be deleted."),
      confirmLabel: t("Delete"),
      danger: true,
    });
    if (!confirmed || !ticket) return;
    try {
      await api(`/api/kanbans/tickets/${ticket.id}/delete`, {});
      ticket = null;
      dialog.close();
    } catch (err) {
      showError(err);
    }
  });

  async function requestClose() {
    if (dirty()) {
      const discard = await deps.confirmDialog({
        title: t("Close without saving?"),
        message: t("Your changes to the title or description will be lost."),
        confirmLabel: t("Close without saving"),
        cancelLabel: t("Keep editing"),
        danger: true,
      });
      if (!discard) return;
    }
    ticket = null;
    dialog.close();
  }
  close.addEventListener("click", requestClose);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault(); // Esc: same path as the button, so nothing is lost silently
    requestClose();
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) requestClose(); // click on the backdrop
  });

  // Files dragged or pasted into the window.
  dialog.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    dialog.classList.add("dropping");
  });
  dialog.addEventListener("dragleave", (event) => {
    if (event.target === dialog) dialog.classList.remove("dropping");
  });
  dialog.addEventListener("drop", (event) => {
    if (!event.dataTransfer?.files.length) return;
    event.preventDefault();
    dialog.classList.remove("dropping");
    upload([...event.dataTransfer.files]);
  });
  dialog.addEventListener("paste", (event) => {
    const pasted = [...(event.clipboardData?.files ?? [])];
    if (!pasted.length) return;
    event.preventDefault();
    upload(pasted);
  });

  return {
    /**
     * @param {Ticket} next
     * @param {Board} nextBoard
     */
    open(next, nextBoard) {
      ticket = next;
      number.textContent = `#${next.number}`;
      clearTimeout(copiedTimer);
      copy.textContent = t("Copy link");
      copy.title = ticketUrl(location.origin, next.number);
      shareUrl = null;
      api(`/api/kanbans/tickets/${next.id}/link`)
        .then((link) => {
          if (ticket?.id === next.id) {
            shareUrl = `${location.origin}${link.path}`;
            copy.title = `${shareUrl}\n${t("With this link, an agent can read the ticket.")}`;
          }
        })
        .catch(() => {});
      deps.onOpen(next.number);
      board = nextBoard;
      saved = { title: next.title, description: next.description };
      title.value = next.title;
      description.value = next.description;
      error.hidden = true;
      showTab(false);
      renderLive();
      refreshSave();
      historyList.replaceChildren();
      historySummary.textContent = t("History");
      loadHistory();
      if (!dialog.open) dialog.showModal();
      if (!next.description) description.focus();
      else title.focus();
    },
    /**
     * New board data: the card follows (files, column), or closes if the ticket is gone.
     *
     * @param {{board: Board | null, tickets: Ticket[]}} data
     */
    update(data) {
      if (!ticket || !dialog.open) return;
      if (data.board?.id !== ticket.board) return;
      const next = data.tickets.find((t) => t.id === ticket?.id);
      if (!next) {
        ticket = null;
        dialog.close();
        return;
      }
      ticket = next;
      board = data.board;
      // The current input is kept; if nothing was changed, follow the server (another tab).
      if (title.value.trim() === saved.title && description.value === saved.description) {
        title.value = next.title;
        description.value = next.description;
      }
      saved = { title: next.title, description: next.description };
      renderLive();
      refreshSave();
      loadHistory();
    },
    /** @param {string} boardId the board was deleted */
    boardDeleted(boardId) {
      if (ticket?.board === boardId && dialog.open) {
        ticket = null;
        dialog.close();
      }
    },
  };
}

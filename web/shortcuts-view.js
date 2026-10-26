// @ts-check
// Shortcuts tab: an agent's ready-made prompts (its own), and those of its workspace, shared by
// all its agents (managed in the workspace view). The editor serves both: add, edit, reorder,
// delete. The order matters: in the Terminal, the first ten have a digit (Ctrl+Shift+1…9, 0).
// No content goes through innerHTML.

import { t } from "./i18n.js";
import { MAX_ITEMS, moveItem, panelItems, shortcutLabel } from "./shortcuts-logic.js";

/**
 * @typedef {import("./shortcuts-logic.js").Shortcut} Shortcut
 * @typedef {import("./shortcuts-logic.js").ShortcutData} ShortcutData
 *
 * @typedef {object} EditorDeps
 * @property {(tag: string, className?: string, text?: string) => HTMLElement} el
 * @property {(d: string) => SVGElement} icon
 * @property {(options: {title: string, message: string, confirmLabel: string, danger?: boolean}) => Promise<boolean>} confirmDialog
 */

export const SHORTCUT_ICONS = {
  bolt: "M13 2L4 14h7l-1 8 9-12h-7z",
  plus: "M12 5v14M5 12h14",
  up: "M12 19V5M6 11l6-6 6 6",
  down: "M12 5v14M6 13l6 6 6-6",
  edit: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z",
  trash: "M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14",
};

/**
 * Title and prompt of a shortcut; without a title, a one-line prompt is not repeated below it.
 *
 * @param {EditorDeps["el"]} el
 * @param {Shortcut} shortcut
 */
function shortcutText(el, shortcut) {
  const text = el("div", "shortcut-text");
  const label = shortcutLabel(shortcut);
  text.append(el("strong", "shortcut-title", label));
  if (shortcut.prompt.trim() !== label) text.append(el("span", "shortcut-prompt muted small", shortcut.prompt));
  return text;
}

/**
 * Editor of a list of shortcuts. `save` receives the full list, in order; it rejects on error.
 *
 * @param {EditorDeps} deps
 * @param {{emptyText: string, digits: boolean}} options digits: show the Terminal digit
 */
export function createShortcutsEditor(deps, options) {
  const { el, icon, confirmDialog } = deps;
  const node = el("div", "shortcut-editor");
  const list = el("ol", "shortcut-list");
  const error = el("p", "form-error");
  error.hidden = true;
  const add = /** @type {HTMLButtonElement} */ (el("button", "shortcut-add"));
  add.type = "button";
  add.append(icon(SHORTCUT_ICONS.plus), el("span", "", t("New shortcut")));
  node.append(list, error, add);

  /** @type {Shortcut[]} */
  let items = [];
  /** @type {(items: Shortcut[]) => Promise<void>} */
  let save = async () => {};
  /** @type {number | "new" | null} shortcut being edited */
  let editing = null;

  /** @param {Shortcut[]} next */
  async function commit(next) {
    error.hidden = true;
    try {
      await save(next);
      return true;
    } catch (err) {
      error.textContent = err instanceof Error ? err.message : String(err);
      error.hidden = false;
      return false;
    }
  }

  /**
   * Small icon button.
   *
   * @param {string} d
   * @param {string} label
   * @param {() => void} onClick
   * @param {boolean} [disabled]
   */
  function action(d, label, onClick, disabled = false) {
    const button = /** @type {HTMLButtonElement} */ (el("button", "icon-button small"));
    button.type = "button";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.disabled = disabled;
    button.append(icon(d));
    button.addEventListener("click", onClick);
    return button;
  }

  /**
   * Form of a shortcut (new or existing).
   *
   * @param {Shortcut | null} shortcut
   * @param {number | "new"} index
   */
  function form(shortcut, index) {
    const formEl = /** @type {HTMLFormElement} */ (el("form", "shortcut-form"));
    const title = /** @type {HTMLInputElement} */ (el("input", "text-input"));
    Object.assign(title, { maxLength: 80, placeholder: t("Title (optional)"), value: shortcut?.title ?? "", autocomplete: "off" });
    title.setAttribute("aria-label", t("Shortcut title"));
    const prompt = /** @type {HTMLTextAreaElement} */ (el("textarea", "text-input"));
    Object.assign(prompt, { rows: 4, maxLength: 20000, required: true, placeholder: t("The prompt sent to the agent…"), value: shortcut?.prompt ?? "" });
    prompt.setAttribute("aria-label", "Prompt");
    const cancel = el("button", "", t("Cancel"));
    /** @type {HTMLButtonElement} */ (cancel).type = "button";
    cancel.addEventListener("click", () => {
      editing = null;
      render();
    });
    const submit = el("button", "primary", shortcut ? t("Save") : t("Add"));
    /** @type {HTMLButtonElement} */ (submit).type = "submit";
    const buttons = el("div", "shortcut-form-actions");
    buttons.append(cancel, submit);
    formEl.append(title, prompt, buttons);
    formEl.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!prompt.value.trim()) return;
      const value = { ...(shortcut?.id ? { id: shortcut.id } : {}), title: title.value.trim(), prompt: prompt.value };
      const next = index === "new" ? [...items, value] : items.map((item, i) => (i === index ? value : item));
      if (await commit(next)) {
        editing = null;
        render();
      }
    });
    // Ctrl+Enter saves; Esc cancels.
    formEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        formEl.requestSubmit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancel.click();
      }
    });
    queueMicrotask(() => (shortcut ? prompt : title).focus());
    return formEl;
  }

  /**
   * @param {Shortcut} shortcut
   * @param {number} index
   */
  function row(shortcut, index) {
    const li = el("li", "shortcut-item");
    if (editing === index) {
      li.append(form(shortcut, index));
      return li;
    }
    const digit = index < 10 ? (index === 9 ? "0" : String(index + 1)) : "";
    const actions = el("div", "shortcut-actions");
    actions.append(
      action(SHORTCUT_ICONS.up, t("Move up"), () => commit(moveItem(items, index, -1)), index === 0),
      action(SHORTCUT_ICONS.down, t("Move down"), () => commit(moveItem(items, index, 1)), index === items.length - 1),
      action(SHORTCUT_ICONS.edit, t("Edit"), () => {
        editing = index;
        render();
      }),
      action(SHORTCUT_ICONS.trash, t("Delete"), async () => {
        const confirmed = await confirmDialog({
          title: t("Delete this shortcut?"),
          message: t("\"{name}\" will no longer be offered.", { name: shortcutLabel(shortcut) }),
          confirmLabel: t("Delete"),
          danger: true,
        });
        if (confirmed) commit(items.filter((_, i) => i !== index));
      }),
    );
    if (options.digits) li.append(el("kbd", `shortcut-digit${digit ? "" : " none"}`, digit));
    li.append(shortcutText(el, shortcut), actions);
    return li;
  }

  function render() {
    const rows = items.map(row);
    if (!items.length && editing !== "new") rows.push(el("li", "shortcut-empty muted small", options.emptyText));
    if (editing === "new") {
      const li = el("li", "shortcut-item");
      li.append(form(null, "new"));
      rows.push(li);
    }
    list.replaceChildren(...rows);
    add.hidden = editing !== null || items.length >= MAX_ITEMS;
  }

  add.addEventListener("click", () => {
    editing = "new";
    render();
  });

  return {
    node,
    /**
     * New list (data received); an open form stays open.
     *
     * @param {Shortcut[]} next
     * @param {(items: Shortcut[]) => Promise<void>} onSave
     */
    set(next, onSave) {
      const changedLength = next.length !== items.length;
      items = next;
      save = onSave;
      if (typeof editing === "number" && (changedLength || editing >= items.length)) editing = null;
      // Open form: not redrawn (the input in progress would be lost).
      if (editing === null) render();
    },
    /** Change of agent or workspace: form closed. */
    reset() {
      editing = null;
      error.hidden = true;
    },
  };
}

/**
 * @typedef {object} ShortcutsViewDeps
 * @property {(tag: string, className?: string, text?: string) => HTMLElement} el
 * @property {(d: string) => SVGElement} icon
 * @property {EditorDeps["confirmDialog"]} confirmDialog
 * @property {() => ShortcutData} data
 * @property {(conversation: any, items: Shortcut[]) => Promise<void>} saveAgent
 * @property {(conversation: any) => {id: string, name: string} | null} workspaceOf
 * @property {(workspaceId: string) => void} openWorkspace opens the workspace's shortcuts
 */

/**
 * Shortcuts tab of an agent.
 *
 * @param {HTMLElement} root
 * @param {ShortcutsViewDeps} deps
 */
export function mountShortcutsView(root, deps) {
  const { el, icon } = deps;
  /** @type {any} */
  let shown = null;

  const intro = el("p", "shortcut-intro muted small");
  // One sentence with the keys in it: {ctrl} and {shift} become <kbd> elements.
  const keys = { ctrl: el("kbd", "", "Ctrl"), shift: el("kbd", "", t("Shift")) };
  const sentence = t("In the Terminal, hold {ctrl} + {shift} to see the shortcuts, then press a digit to send the prompt (or click it).");
  intro.append(...sentence.split(/(\{ctrl\}|\{shift\})/).map((part) => (part === "{ctrl}" ? keys.ctrl : part === "{shift}" ? keys.shift : part)));
  const ownTitle = el("h3", "settings-title", t("This agent's shortcuts"));
  const editor = createShortcutsEditor(deps, { emptyText: t("No shortcuts for this agent."), digits: true });
  const sharedSection = el("section", "shortcut-shared");
  const sharedTitle = el("h3", "settings-title");
  const sharedList = el("ol", "shortcut-list readonly");
  const manage = el("button", "", t("Manage the workspace's shortcuts"));
  /** @type {HTMLButtonElement} */ (manage).type = "button";
  manage.addEventListener("click", () => {
    const workspace = shown && deps.workspaceOf(shown);
    if (workspace) deps.openWorkspace(workspace.id);
  });
  sharedSection.append(sharedTitle, sharedList, manage);
  const inner = el("div", "shortcut-page");
  inner.append(intro, ownTitle, editor.node, sharedSection);
  root.append(inner);

  function render() {
    if (!shown) return;
    const conversation = shown;
    const data = deps.data();
    const workspace = deps.workspaceOf(conversation);
    const items = panelItems(data, conversation, workspace?.id ?? null);
    const own = items.filter((item) => item.source === "agent").map((item) => item.shortcut);
    editor.set(own, (next) => deps.saveAgent(conversation, next));
    sharedSection.hidden = !workspace;
    if (!workspace) return;
    sharedTitle.textContent = t("Shortcuts of the \"{name}\" workspace", { name: workspace.name });
    const shared = items.filter((item) => item.source === "workspace");
    sharedList.replaceChildren(...(shared.length ? shared.map((item) => {
      const li = el("li", "shortcut-item");
      li.append(el("kbd", `shortcut-digit${item.digit ? "" : " none"}`, item.digit ?? ""), shortcutText(el, item.shortcut));
      return li;
    }) : [el("li", "shortcut-empty muted small", t("No shared shortcuts yet."))]));
  }

  return {
    /** @param {any} conversation */
    open(conversation) {
      if (shown?.id !== conversation.id) editor.reset();
      shown = conversation;
      render();
    },
    hide() {
      shown = null;
    },
    /** Data changed (here or elsewhere). */
    refresh() {
      render();
    },
  };
}

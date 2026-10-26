// @ts-check
// Shortcuts panel, over the Terminal. Ctrl+Shift held: it appears (and disappears on
// release); Ctrl+Shift+1…9, 0 sends the shortcut of that digit. Ctrl+digit alone is taken by the
// browser (tab switching), Ctrl+Shift+digit is not. The "Shortcuts" button of the bar
// keeps it open: click a shortcut, or type its digit; Esc closes it.

import { t } from "./i18n.js";
import { indexForCode, shortcutLabel } from "./shortcuts-logic.js";

/**
 * @typedef {import("./shortcuts-logic.js").PanelItem} PanelItem
 *
 * @typedef {object} PanelDeps
 * @property {(tag: string, className?: string, text?: string) => HTMLElement} el
 * @property {() => boolean} active an agent's Terminal is shown
 * @property {() => PanelItem[]} items shortcuts of the agent shown
 * @property {() => boolean} canSend Claude Code is open
 * @property {(item: PanelItem) => void} send
 * @property {() => void} manage opens the Shortcuts tab
 */

/**
 * @param {HTMLElement} host terminal area (the panel sits at its bottom)
 * @param {PanelDeps} deps
 */
export function mountShortcutsPanel(host, deps) {
  const { el } = deps;
  const panel = el("div", "shortcut-panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", t("Shortcuts"));
  panel.setAttribute("aria-hidden", "true");
  host.append(panel);
  /** @type {"closed" | "held" | "pinned"} held: Ctrl+Shift held; pinned: opened by the button */
  let state = "closed";
  // Ctrl+Shift held for a short moment before opening: Ctrl+Shift+C (copy) does not make the panel flicker.
  const HOLD_MS = 150;
  /** @type {number | undefined} */
  let holdTimer;
  const cancelHold = () => {
    clearTimeout(holdTimer);
    holdTimer = undefined;
  };

  function render() {
    const items = deps.items();
    const head = el("div", "shortcut-panel-head");
    const keys = el("span", "shortcut-panel-keys");
    keys.append(el("kbd", "", "Ctrl"), el("kbd", "", t("Shift")), el("span", "", t("+ digit")));
    head.append(el("strong", "", t("Shortcuts")), keys);
    const list = el("ol", "shortcut-panel-list");
    items.forEach((item, index) => {
      const li = el("li");
      const button = /** @type {HTMLButtonElement} */ (el("button", `shortcut-panel-item${item.source === "workspace" ? " shared" : ""}`));
      button.type = "button";
      button.disabled = !deps.canSend();
      button.title = item.shortcut.prompt;
      button.style.setProperty("--i", String(Math.min(index, 12)));
      button.append(
        el("kbd", `shortcut-digit${item.digit ? "" : " none"}`, item.digit ?? ""),
        el("span", "shortcut-panel-label", shortcutLabel(item.shortcut)),
      );
      if (item.source === "workspace") button.append(el("span", "shortcut-panel-tag", "workspace"));
      // mousedown: the terminal would otherwise keep the keyboard… and releasing Ctrl+Shift would close the panel before the click.
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => trigger(index));
      li.append(button);
      list.append(li);
    });
    const foot = el("div", "shortcut-panel-foot muted small");
    if (!items.length) foot.append(`${t("No shortcuts.")} `);
    else if (!deps.canSend()) foot.append(`${t("Open Claude Code to send a shortcut.")} `);
    const manage = el("button", "link-button", items.length ? t("Manage shortcuts") : t("Add a shortcut"));
    /** @type {HTMLButtonElement} */ (manage).type = "button";
    manage.addEventListener("mousedown", (event) => event.preventDefault());
    manage.addEventListener("click", () => {
      close();
      deps.manage();
    });
    foot.append(manage);
    panel.replaceChildren(head, list, foot);
  }

  /** @param {"held" | "pinned"} how */
  function open(how) {
    if (!deps.active()) return;
    if (state === "closed") render();
    state = how;
    panel.classList.add("open");
    panel.setAttribute("aria-hidden", "false");
  }

  function close() {
    state = "closed";
    panel.classList.remove("open");
    panel.setAttribute("aria-hidden", "true");
  }

  /** @param {number} index */
  function trigger(index) {
    const item = deps.items()[index];
    if (!item || !deps.canSend()) return;
    close();
    deps.send(item);
  }

  // Capture phase: before xterm.js, which would otherwise send the key to Claude Code.
  window.addEventListener("keydown", (event) => {
    cancelHold();
    if (!deps.active()) {
      if (state !== "closed") close();
      return;
    }
    const chord = event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey;
    const index = indexForCode(event.code);
    if (chord && index >= 0) {
      event.preventDefault();
      event.stopPropagation();
      trigger(index);
    } else if (chord && (event.key === "Control" || event.key === "Shift")) {
      if (state === "closed") holdTimer = window.setTimeout(() => open("held"), HOLD_MS);
    } else if (state === "pinned" && index >= 0 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      event.stopPropagation();
      trigger(index);
    } else if (state === "pinned" && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (state === "held" && chord) {
      close(); // Ctrl+Shift+other key (Ctrl+Shift+C…): it was not for the shortcuts
    }
  }, true);
  window.addEventListener("keyup", (event) => {
    cancelHold();
    if (state === "held" && !(event.ctrlKey && event.shiftKey)) close();
  }, true);
  window.addEventListener("blur", () => {
    cancelHold();
    if (state === "held") close();
  });

  return {
    /** Button of the bar: opens or closes the panel. */
    toggle() {
      if (state === "pinned") close();
      else open("pinned");
    },
    close,
    /** Shortcuts or state changed: the open panel follows. */
    refresh() {
      if (state !== "closed") render();
    },
  };
}

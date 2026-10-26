// @ts-check
// Panneau des raccourcis, par-dessus le Terminal. Ctrl+Maj maintenus : il apparaît (et disparaît au
// relâchement) ; Ctrl+Maj+1…9, 0 envoie le raccourci de ce chiffre. Ctrl+chiffre seul est pris par le
// navigateur (changement d'onglet), Ctrl+Maj+chiffre ne l'est pas. Le bouton « Raccourcis » de la barre
// le garde ouvert : on clique un raccourci, ou on tape son chiffre ; Échap le ferme.

import { indexForCode, shortcutLabel } from "./shortcuts-logic.js";

/**
 * @typedef {import("./shortcuts-logic.js").PanelItem} PanelItem
 *
 * @typedef {object} PanelDeps
 * @property {(tag: string, className?: string, text?: string) => HTMLElement} el
 * @property {() => boolean} active le Terminal d'un agent est affiché
 * @property {() => PanelItem[]} items raccourcis de l'agent affiché
 * @property {() => boolean} canSend Claude Code est ouvert
 * @property {(item: PanelItem) => void} send
 * @property {() => void} manage ouvre l'onglet Raccourcis
 */

/**
 * @param {HTMLElement} host zone du terminal (le panneau s'y pose en bas)
 * @param {PanelDeps} deps
 */
export function mountShortcutsPanel(host, deps) {
  const { el } = deps;
  const panel = el("div", "shortcut-panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Raccourcis");
  panel.setAttribute("aria-hidden", "true");
  host.append(panel);
  /** @type {"closed" | "held" | "pinned"} held : Ctrl+Maj maintenus ; pinned : ouvert par le bouton */
  let state = "closed";
  // Ctrl+Maj maintenus un court instant avant d'ouvrir : Ctrl+Maj+C (copier) ne fait pas clignoter le panneau.
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
    keys.append(el("kbd", "", "Ctrl"), el("kbd", "", "Maj"), el("span", "", "+ chiffre"));
    head.append(el("strong", "", "Raccourcis"), keys);
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
      // mousedown : le terminal garderait sinon le clavier… et Ctrl+Maj relâchés fermeraient le panneau avant le clic.
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => trigger(index));
      li.append(button);
      list.append(li);
    });
    const foot = el("div", "shortcut-panel-foot muted small");
    if (!items.length) foot.append("Aucun raccourci. ");
    else if (!deps.canSend()) foot.append("Ouvre Claude Code pour envoyer un raccourci. ");
    const manage = el("button", "link-button", items.length ? "Gérer les raccourcis" : "Ajouter un raccourci");
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

  // Phase de capture : avant xterm.js, qui enverrait sinon la touche à Claude Code.
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
      close(); // Ctrl+Maj+autre touche (Ctrl+Maj+C…) : ce n'était pas pour les raccourcis
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
    /** Bouton de la barre : ouvre ou ferme le panneau. */
    toggle() {
      if (state === "pinned") close();
      else open("pinned");
    },
    close,
    /** Raccourcis ou état changés : le panneau ouvert suit. */
    refresh() {
      if (state !== "closed") render();
    },
  };
}

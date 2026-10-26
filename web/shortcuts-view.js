// @ts-check
// Onglet Raccourcis : les prompts tout prêts d'un agent (à lui seul), et ceux de son workspace, communs à
// tous ses agents (gérés dans la vue du workspace). L'éditeur sert aux deux : ajouter, modifier, ordonner,
// supprimer. L'ordre compte : dans le Terminal, les dix premiers ont un chiffre (Ctrl+Maj+1…9, 0).
// Aucun contenu ne passe par innerHTML.

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
 * Titre et prompt d'un raccourci ; sans titre, le prompt d'une ligne n'est pas répété dessous.
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
 * Éditeur d'une liste de raccourcis. `save` reçoit la liste complète, dans l'ordre ; il rejette en cas d'erreur.
 *
 * @param {EditorDeps} deps
 * @param {{emptyText: string, digits: boolean}} options digits : afficher le chiffre du Terminal
 */
export function createShortcutsEditor(deps, options) {
  const { el, icon, confirmDialog } = deps;
  const node = el("div", "shortcut-editor");
  const list = el("ol", "shortcut-list");
  const error = el("p", "form-error");
  error.hidden = true;
  const add = /** @type {HTMLButtonElement} */ (el("button", "shortcut-add"));
  add.type = "button";
  add.append(icon(SHORTCUT_ICONS.plus), el("span", "", "Nouveau raccourci"));
  node.append(list, error, add);

  /** @type {Shortcut[]} */
  let items = [];
  /** @type {(items: Shortcut[]) => Promise<void>} */
  let save = async () => {};
  /** @type {number | "new" | null} raccourci en cours d'édition */
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
   * Petit bouton icône.
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
   * Formulaire d'un raccourci (nouveau ou existant).
   *
   * @param {Shortcut | null} shortcut
   * @param {number | "new"} index
   */
  function form(shortcut, index) {
    const formEl = /** @type {HTMLFormElement} */ (el("form", "shortcut-form"));
    const title = /** @type {HTMLInputElement} */ (el("input", "text-input"));
    Object.assign(title, { maxLength: 80, placeholder: "Titre (facultatif)", value: shortcut?.title ?? "", autocomplete: "off" });
    title.setAttribute("aria-label", "Titre du raccourci");
    const prompt = /** @type {HTMLTextAreaElement} */ (el("textarea", "text-input"));
    Object.assign(prompt, { rows: 4, maxLength: 20000, required: true, placeholder: "Le prompt envoyé à l'agent…", value: shortcut?.prompt ?? "" });
    prompt.setAttribute("aria-label", "Prompt");
    const cancel = el("button", "", "Annuler");
    /** @type {HTMLButtonElement} */ (cancel).type = "button";
    cancel.addEventListener("click", () => {
      editing = null;
      render();
    });
    const submit = el("button", "primary", shortcut ? "Enregistrer" : "Ajouter");
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
    // Ctrl+Entrée enregistre ; Échap annule.
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
      action(SHORTCUT_ICONS.up, "Monter", () => commit(moveItem(items, index, -1)), index === 0),
      action(SHORTCUT_ICONS.down, "Descendre", () => commit(moveItem(items, index, 1)), index === items.length - 1),
      action(SHORTCUT_ICONS.edit, "Modifier", () => {
        editing = index;
        render();
      }),
      action(SHORTCUT_ICONS.trash, "Supprimer", async () => {
        const confirmed = await confirmDialog({
          title: "Supprimer ce raccourci ?",
          message: `« ${shortcutLabel(shortcut)} » ne sera plus proposé.`,
          confirmLabel: "Supprimer",
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
     * Nouvelle liste (données reçues) ; un formulaire ouvert reste ouvert.
     *
     * @param {Shortcut[]} next
     * @param {(items: Shortcut[]) => Promise<void>} onSave
     */
    set(next, onSave) {
      const changedLength = next.length !== items.length;
      items = next;
      save = onSave;
      if (typeof editing === "number" && (changedLength || editing >= items.length)) editing = null;
      // Formulaire ouvert : on ne le redessine pas (la saisie en cours serait perdue).
      if (editing === null) render();
    },
    /** Change d'agent ou de workspace : formulaire fermé. */
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
 * @property {(workspaceId: string) => void} openWorkspace ouvre les raccourcis du workspace
 */

/**
 * Onglet Raccourcis d'un agent.
 *
 * @param {HTMLElement} root
 * @param {ShortcutsViewDeps} deps
 */
export function mountShortcutsView(root, deps) {
  const { el, icon } = deps;
  /** @type {any} */
  let shown = null;

  const intro = el("p", "shortcut-intro muted small");
  intro.append(
    "Dans le Terminal, maintiens ",
    el("kbd", "", "Ctrl"), " + ", el("kbd", "", "Maj"),
    " pour voir les raccourcis, puis appuie sur un chiffre pour envoyer le prompt (ou clique dessus).",
  );
  const ownTitle = el("h3", "settings-title", "Raccourcis de cet agent");
  const editor = createShortcutsEditor(deps, { emptyText: "Aucun raccourci pour cet agent.", digits: true });
  const sharedSection = el("section", "shortcut-shared");
  const sharedTitle = el("h3", "settings-title");
  const sharedList = el("ol", "shortcut-list readonly");
  const manage = el("button", "", "Gérer les raccourcis du workspace");
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
    sharedTitle.textContent = `Raccourcis du workspace « ${workspace.name} »`;
    const shared = items.filter((item) => item.source === "workspace");
    sharedList.replaceChildren(...(shared.length ? shared.map((item) => {
      const li = el("li", "shortcut-item");
      li.append(el("kbd", `shortcut-digit${item.digit ? "" : " none"}`, item.digit ?? ""), shortcutText(el, item.shortcut));
      return li;
    }) : [el("li", "shortcut-empty muted small", "Aucun raccourci commun pour l'instant.")]));
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
    /** Données changées (ici ou ailleurs). */
    refresh() {
      render();
    },
  };
}

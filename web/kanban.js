// @ts-check
// Mode Tâches : les tableaux Kanban. Barre latérale (tableaux, workspaces repliables, épingles), et au
// centre le tableau choisi, ou la création, ou des réglages (tableau : nom, couleur, colonnes ; workspace).
// La liste reprend les classes CSS et les fonctions d'épingles et de workspaces des agents : elle
// s'affiche et se comporte de la même façon.

import { mountBoardView } from "./kanban-board.js";
import { boardRow } from "./kanban-logic.js";
import { mountTicketDialog } from "./kanban-ticket.js";
import { orderRows, pinnedFirst } from "./pins.js";
import { memberKey, pinnedHead, splitByWorkspace, workspacePinKey } from "./workspaces.js";

const SELECTED_KEY = "zo-selected-board";
const COLLAPSED_KEY = "zo-collapsed-board-workspaces";

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
 * @property {(text: string, target: HTMLElement) => void} renderMarkdown
 * @property {(key: string) => number} autoHue teinte automatique (même attribution que les agents)
 * @property {number[]} hues teintes proposées
 * @property {(text: string) => string} initialOf
 * @property {(epochSeconds: number) => string} shortDate
 *
 * @typedef {{list: HTMLElement, title: HTMLElement, body: HTMLElement, settings: HTMLElement, close: HTMLElement, create: HTMLElement}} KanbanElements
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
    // Stockage indisponible : le choix vaut pour cet onglet seulement.
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
  /** @type {null | (() => void)} redessine la vue de réglages ouverte quand les données changent */
  let viewRefresh = null;
  const collapsed = new Set(/** @type {string[]} */ (loadSaved(COLLAPSED_KEY, [])));
  let loaded = false;
  /** @type {Map<number, {id: string, board: string, boardName: string, title: string}>} tous les tickets, par numéro */
  let index = new Map();
  /** @type {number | undefined} */
  let indexTimer;

  async function loadIndex() {
    try {
      const data = await api("/api/kanbans/index");
      index = new Map(data.tickets.map((/** @type {any} */ t) => [t.number, t]));
    } catch {
      // Index indisponible : les « #42 » restent du texte.
    }
  }
  /** Relit l'index peu après une série de changements (un seul appel pour plusieurs événements). */
  const refreshIndex = () => {
    clearTimeout(indexTimer);
    indexTimer = window.setTimeout(loadIndex, 300);
  };

  /**
   * Adresse affichée : /t/<numéro> quand une fiche est ouverte, sinon /#taches.
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
      if (location.pathname.startsWith("/t/")) setAddress("/#taches");
    },
  });

  /** @param {{id: string, hue?: number | null}} item @param {string} prefix */
  const hueOf = (item, prefix) => (Number.isInteger(item.hue) ? /** @type {number} */ (item.hue) : deps.autoHue(`${prefix}:${item.id}`));

  // --- barre latérale ---------------------------------------------------------------------

  /** @param {string[]} next */
  function savePins(next) {
    if (JSON.stringify(next) === JSON.stringify(pins)) return;
    pins = next;
    api("/api/kanbans/pins", { pins }).catch(showError);
  }

  /**
   * Bouton épingle ou engrenage d'une ligne.
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
    meta.append(el("span", "", count ? `${count} ticket${count > 1 ? "s" : ""}` : "vide"));
    // Répartition par colonne : une pastille de la couleur de chaque colonne non vide.
    const spread = el("span", "board-spread");
    for (const column of board.columns) {
      const n = board.counts?.[column.id] ?? 0;
      if (!n) continue;
      const chip = el("span", "board-spread-chip", String(n));
      if (Number.isInteger(column.hue)) chip.style.setProperty("--col-hue", String(column.hue));
      else chip.classList.add("neutral");
      chip.title = `${column.name} : ${n}`;
      spread.append(chip);
    }
    if (spread.childElementCount) meta.append(spread);
    text.append(el("span", "session-name", board.name), meta);
    open.append(avatar, text);
    open.addEventListener("click", () => selectBoard(board.id));
    const pin = rowButton("pin-button", icons.pin, pinned ? "Désépingler" : "Épingler en haut",
      `${pinned ? "Désépingler" : "Épingler"} « ${board.name} »`, () => {
        savePins(pinned ? pins.filter((p) => p !== board.id) : [...pins, board.id]);
        drawList();
      });
    pin.setAttribute("aria-pressed", String(pinned));
    const gear = rowButton("pin-button more-button", icons.gear, "Configurer le tableau", `Configurer « ${board.name} »`,
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
    const count = rows.length === 0 ? "Aucun tableau" : `${rows.length} tableau${rows.length > 1 ? "x" : ""}`;
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
    const pin = rowButton("pin-button", icons.pin, pinned ? "Désépingler" : "Épingler en haut",
      `${pinned ? "Désépingler" : "Épingler"} le workspace « ${workspace.name} »`, () => {
        savePins(pinned ? pins.filter((key) => key !== pinKey) : [...pins, pinKey]);
        drawList();
      });
    pin.setAttribute("aria-pressed", String(pinned));
    const gear = rowButton("pin-button more-button", icons.gear, "Configurer le workspace",
      `Configurer le workspace « ${workspace.name} »`, () => openWorkspaceSettings(workspace.id));
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
        const add = el("button", "link-button", "Ajouter des tableaux");
        add.type = "button";
        add.addEventListener("click", () => openWorkspaceSettings(workspace.id));
        empty.append(add);
        body.append(empty);
      }
      item.append(body);
    }
    return item;
  }

  function drawList() {
    // Les plus récemment modifiés d'abord, comme les agents.
    const rows = [...boards].sort((a, b) => b.updatedAt - a.updatedAt).map(boardRow);
    const { members, rest } = splitByWorkspace(rows, workspaces);
    const { pinned, others } = orderRows(rest, pins, () => true);
    const { head, unpinned } = pinnedHead(pinned, workspaces, pins);
    const block = (/** @type {Workspace} */ workspace) => workspaceItem(workspace, members.get(workspace.id) || []);
    if (!head.length && !unpinned.length && !others.length) {
      dom.list.replaceChildren(el("li", "muted", "Aucun tableau. Crée-en un avec « + »."));
      return;
    }
    const headItems = head.map((entry) => (entry.kind === "agent" ? boardItem(entry.row) : block(entry.workspace)));
    headItems.at(-1)?.classList.toggle("pinned-last", unpinned.length + others.length > 0);
    dom.list.replaceChildren(...headItems, ...unpinned.map(block), ...others.map(boardItem));
  }

  // --- carte centrale ---------------------------------------------------------------------

  /**
   * @param {string} title
   * @param {boolean} onBoard le tableau est affiché (engrenage visible)
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
    showCard(board?.name ?? "Tableau", true, boardHost);
    drawList();
    try {
      const data = await api(`/api/kanbans/${id}`);
      if (selected === id && view.kind === "board") boardView.show(data);
    } catch (err) {
      showError(err);
    }
  }

  /** Vue par défaut : le tableau choisi, sinon le premier, sinon la création. */
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
      choiceTile(icons.board, "Tableau", "Un Kanban : des colonnes (À faire, En cours, Fait…) et des tickets à déplacer.", () => nameForm("board")),
      choiceTile(icons.workspace, "Workspace", "Un groupe pour ranger plusieurs tableaux ensemble. Il se replie dans la liste.", () => nameForm("workspace")),
    );
    const intro = boards.length ? "Que veux-tu créer ?" : "Aucun tableau pour l'instant : crée le premier.";
    showCard("Créer", false, el("p", "muted", intro), choices);
    drawList();
    /** @type {HTMLElement | null} */ (choices.querySelector("button"))?.focus();
  }

  /** @param {"board" | "workspace"} kind */
  function nameForm(kind) {
    const form = el("form", "workspace-form");
    const label = el("label", "field-label", kind === "board" ? "Nom du tableau" : "Nom du workspace");
    label.setAttribute("for", "kanban-name");
    const input = /** @type {HTMLInputElement} */ (el("input", "text-input"));
    Object.assign(input, { id: "kanban-name", maxLength: 80, required: true, autocomplete: "off",
      placeholder: kind === "board" ? "Ex. Ziggy One" : "Ex. Projets perso" });
    const back = el("button", "", "Retour");
    back.type = "button";
    back.addEventListener("click", openCreate);
    const submit = /** @type {HTMLButtonElement} */ (el("button", "primary", kind === "board" ? "Créer le tableau" : "Créer le workspace"));
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
    showCard(kind === "board" ? "Nouveau tableau" : "Nouveau workspace", false, form);
    input.focus();
  }

  /**
   * Nuancier : « Auto » (ou « Neutre ») puis les teintes proposées.
   *
   * @param {string} label
   * @param {number | null} current
   * @param {(hue: number | null) => void} onPick
   * @param {string} [noneLabel]
   */
  function swatches(label, current, onPick, noneLabel = "Auto") {
    const group = el("div", "swatches");
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", label);
    for (const hue of [null, ...deps.hues]) {
      const swatch = el("button", hue === null ? "swatch auto" : "swatch", hue === null ? noneLabel : "");
      swatch.type = "button";
      swatch.setAttribute("role", "radio");
      swatch.setAttribute("aria-checked", String(hue === current));
      swatch.title = hue === null ? noneLabel : `Teinte ${hue}°`;
      if (hue !== null) swatch.style.setProperty("--agent-hue", String(hue));
      swatch.addEventListener("click", () => onPick(hue));
      group.append(swatch);
    }
    return group;
  }

  /**
   * Réglages d'un tableau : nom, couleur, colonnes (nom, couleur, ordre, suppression), suppression du tableau.
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
      // La saisie en cours (nom de colonne…) survit au redessin.
      const focused = /** @type {HTMLInputElement | null} */ (document.activeElement);
      const focusKey = focused?.dataset.focusKey;
      const typing = focusKey && focused?.tagName === "INPUT" ? focused.value : null;
      const nameForm = el("form", "settings-section");
      const nameLabel = el("label", "settings-title", "Nom");
      nameLabel.setAttribute("for", "board-rename");
      const nameInput = /** @type {HTMLInputElement} */ (el("input", "text-input"));
      Object.assign(nameInput, { id: "board-rename", value: board.name, maxLength: 80, required: true, autocomplete: "off" });
      const rename = el("button", "primary", "Renommer");
      rename.type = "submit";
      const nameRow = el("div", "inline-field");
      nameRow.append(nameInput, rename);
      nameForm.append(nameLabel, nameRow);
      nameForm.addEventListener("submit", (event) => {
        event.preventDefault();
        call(`/api/kanbans/${id}/update`, { name: nameInput.value });
      });

      const colorSection = el("div", "settings-section");
      colorSection.append(el("h3", "settings-title", "Couleur"),
        swatches("Couleur du tableau", board.hue, (hue) => call(`/api/kanbans/${id}/update`, { hue })));

      const columnsSection = el("div", "settings-section");
      const list = el("ol", "column-editor");
      board.columns.forEach((column, index) => {
        const item = el("li", "column-editor-row");
        if (Number.isInteger(column.hue)) item.style.setProperty("--col-hue", String(column.hue));
        else item.classList.add("neutral");
        const colorPicker = el("details", "column-color");
        const dot = el("summary", "kanban-dot");
        dot.title = "Couleur de la colonne";
        dot.setAttribute("aria-label", `Couleur de « ${column.name} »`);
        colorPicker.append(dot, swatches(`Couleur de « ${column.name} »`, column.hue,
          (hue) => call(`/api/kanbans/${id}/columns/${column.id}/update`, { hue }), "Neutre"));
        const input = /** @type {HTMLInputElement} */ (el("input", "text-input"));
        Object.assign(input, { value: column.name, maxLength: 60, required: true, autocomplete: "off" });
        input.dataset.focusKey = `column-${column.id}`;
        input.setAttribute("aria-label", "Nom de la colonne");
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
        for (const [button, step, label] of /** @type {[HTMLElement, number, string][]} */ ([[up, -1, "Monter"], [down, 1, "Descendre"]])) {
          /** @type {HTMLButtonElement} */ (button).type = "button";
          button.title = label;
          button.setAttribute("aria-label", `${label} « ${column.name} »`);
          /** @type {HTMLButtonElement} */ (button).disabled = index + step < 0 || index + step >= board.columns.length;
          button.dataset.focusKey = `${label}-${column.id}`;
          button.addEventListener("click", () => call(`/api/kanbans/${id}/columns/${column.id}/move`, { index: index + step }));
        }
        const remove = el("button", "icon-button danger-icon");
        remove.type = "button";
        remove.title = "Supprimer la colonne";
        remove.setAttribute("aria-label", `Supprimer « ${column.name} »`);
        remove.append(icon(icons.close));
        /** @type {HTMLButtonElement} */ (remove).disabled = board.columns.length === 1;
        remove.addEventListener("click", () => deleteColumn(board, column));
        const count = board.counts?.[column.id] ?? 0;
        item.append(colorPicker, input, el("span", "muted small column-editor-count", String(count)), up, down, remove);
        list.append(item);
      });
      const addForm = el("form", "inline-field");
      const addInput = /** @type {HTMLInputElement} */ (el("input", "text-input"));
      Object.assign(addInput, { placeholder: "Nouvelle colonne", maxLength: 60, autocomplete: "off" });
      addInput.dataset.focusKey = "new-column";
      addInput.setAttribute("aria-label", "Nom de la nouvelle colonne");
      const add = el("button", "", "Ajouter");
      add.type = "submit";
      addForm.append(addInput, add);
      addForm.addEventListener("submit", (event) => {
        event.preventDefault();
        const name = addInput.value.trim();
        addInput.value = "";
        if (name) call(`/api/kanbans/${id}/columns`, { name });
      });
      columnsSection.append(el("h3", "settings-title", "Colonnes"), list, addForm);

      const danger = el("div", "settings-section danger-zone");
      const remove = el("button", "danger", "Supprimer le tableau");
      remove.type = "button";
      remove.addEventListener("click", async () => {
        const count = board.ticketCount ?? 0;
        const confirmed = await deps.confirmDialog({
          title: `Supprimer « ${board.name.slice(0, 60)} » ?`,
          message: count ? `Ses ${count} ticket${count > 1 ? "s" : ""} et leurs fichiers joints seront supprimés.` : "Le tableau est vide.",
          confirmLabel: "Supprimer",
          danger: true,
        });
        if (confirmed) call(`/api/kanbans/${id}/delete`, {});
      });
      danger.append(el("h3", "settings-title", "Supprimer"), el("p", "muted small", "Supprime le tableau, ses tickets et leurs fichiers joints."), remove);

      const done = el("button", "primary", "Terminé");
      done.type = "button";
      done.addEventListener("click", () => selectBoard(id));
      const footer = el("div", "panel-actions");
      footer.append(done);
      showCard("Configurer le tableau", false, nameForm, colorSection, columnsSection, danger, footer);
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
   * Supprime une colonne ; si elle a des tickets, demande où les envoyer.
   *
   * @param {Board} board
   * @param {import("./kanban-logic.js").Column} column
   */
  async function deleteColumn(board, column) {
    const count = board.counts?.[column.id] ?? 0;
    const others = board.columns.filter((c) => c.id !== column.id);
    const select = /** @type {HTMLSelectElement} */ (el("select", "text-input"));
    select.setAttribute("aria-label", "Colonne qui reçoit les tickets");
    for (const other of others) {
      const option = /** @type {HTMLOptionElement} */ (el("option", "", other.name));
      option.value = other.id;
      select.append(option);
    }
    const content = el("label", "field-label");
    content.append(el("span", "", "Déplacer ses tickets vers "), select);
    const confirmed = await deps.confirmDialog({
      title: `Supprimer la colonne « ${column.name.slice(0, 60)} » ?`,
      message: count ? `Elle contient ${count} ticket${count > 1 ? "s" : ""}.` : "Elle est vide.",
      content: count ? content : undefined,
      confirmLabel: "Supprimer",
      danger: true,
    });
    if (!confirmed) return;
    api(`/api/kanbans/${board.id}/columns/${column.id}/delete`, count ? { into: select.value } : {}).catch(showError);
  }

  /**
   * Réglages d'un workspace de tableaux : nom, couleur, tableaux (à cocher), suppression.
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
      const nameLabel = el("label", "settings-title", "Nom");
      nameLabel.setAttribute("for", "board-workspace-rename");
      const nameInput = /** @type {HTMLInputElement} */ (el("input", "text-input"));
      Object.assign(nameInput, { id: "board-workspace-rename", value: workspace.name, maxLength: 80, required: true, autocomplete: "off" });
      const rename = el("button", "primary", "Renommer");
      rename.type = "submit";
      const nameRow = el("div", "inline-field");
      nameRow.append(nameInput, rename);
      nameForm.append(nameLabel, nameRow);
      nameForm.addEventListener("submit", (event) => {
        event.preventDefault();
        call(`/api/kanbans/workspaces/${id}/update`, { name: nameInput.value });
      });
      const colorSection = el("div", "settings-section");
      colorSection.append(el("h3", "settings-title", "Couleur"),
        swatches("Couleur du workspace", Number.isInteger(workspace.hue) ? /** @type {number} */ (workspace.hue) : null,
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
          el("span", "muted small", elsewhere ? `dans « ${elsewhere.name} »` : `${board.ticketCount ?? 0} ticket(s)`));
        label.append(box, avatar, text);
        item.append(label);
        list.append(item);
      }
      if (!boards.length) list.append(el("li", "muted small", "Aucun tableau."));
      boardsSection.append(el("h3", "settings-title", "Tableaux"),
        el("p", "muted small", "Coche les tableaux à ranger dans ce workspace. Un tableau n'est que dans un workspace à la fois."), list);
      const danger = el("div", "settings-section danger-zone");
      const remove = el("button", "danger", "Supprimer le workspace");
      remove.type = "button";
      remove.addEventListener("click", async () => {
        const confirmed = await deps.confirmDialog({
          title: `Supprimer « ${workspace.name.slice(0, 60)} » ?`,
          message: "Ses tableaux reviennent dans la liste générale. Aucun tableau n'est supprimé.",
          confirmLabel: "Supprimer",
          danger: true,
        });
        if (confirmed) call(`/api/kanbans/workspaces/${id}/delete`, {});
      });
      danger.append(el("h3", "settings-title", "Supprimer"), el("p", "muted small", "Ses tableaux reviennent dans la liste générale."), remove);
      const done = el("button", "primary", "Terminé");
      done.type = "button";
      done.addEventListener("click", showDefault);
      const footer = el("div", "panel-actions");
      footer.append(done);
      showCard("Configurer le workspace", false, nameForm, colorSection, boardsSection, danger, footer);
      dom.close.hidden = false;
      drawList();
    };
    viewRefresh();
  }

  dom.create.addEventListener("click", openCreate);
  dom.settings.addEventListener("click", () => selected && openSettings(selected));
  dom.close.addEventListener("click", showDefault);

  return {
    /**
     * Ouvre la fiche d'un ticket d'après son numéro (adresse /t/42, lien « #42 »), sur son tableau.
     *
     * @param {number} number
     */
    async openNumber(number) {
      try {
        const found = await api(`/api/kanbans/tickets/number/${number}`);
        await selectBoard(found.board);
        const data = boardView.current();
        const ticket = data?.tickets.find((t) => t.id === found.ticket);
        if (data && ticket) ticketDialog.open(ticket, data.board);
      } catch (err) {
        showError(err);
        setAddress("/#taches");
      }
    },
    /** Charge tableaux, workspaces et épingles (au démarrage, et après une reconnexion). */
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
      refreshIndex(); // titres et numéros à jour pour les liens « #42 »
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

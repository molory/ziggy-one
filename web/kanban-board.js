// @ts-check
// Mode Tâches : le tableau affiché au centre. Colonnes côte à côte (défilement horizontal), tickets en
// cartes, ajout rapide en bas de colonne, colonne « + » au bout. Déplacement par glisser-déposer
// (glisser-déposer natif du navigateur, sans bibliothèque) ou au clavier : Alt + flèches sur une carte.
// Le déplacement s'affiche tout de suite ; la réponse du serveur (événement kanban_board) fait foi.
// Aucun contenu ne passe par innerHTML : uniquement des nœuds texte.

import { columnTickets, descriptionPreview, dropIndex, keyboardMove, moveTicket, shareLink } from "./kanban-logic.js";

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
 * @property {{plus: string, file: string}} icons
 * @property {(ticketId: string) => void} openTicket
 * @property {(err: unknown) => void} showError
 */

/**
 * @param {HTMLElement} root
 * @param {BoardViewDeps} deps
 */
export function mountBoardView(root, deps) {
  const { api, el, icon } = deps;
  /** @type {BoardData | null} */
  let data = null;
  /** @type {{id: string, height: number} | null} ticket en cours de glisser */
  let dragged = null;
  /** @type {BoardData | null} données reçues pendant un glisser, affichées à la fin */
  let pending = null;
  /** @type {string | null} carte à refocaliser après un déplacement au clavier */
  let focusAfter = null;
  /** @type {string | null} colonne dont la zone d'ajout rapide est ouverte */
  let addingIn = null;
  const placeholder = el("li", "kanban-placeholder");
  placeholder.setAttribute("aria-hidden", "true");

  /**
   * Couleur d'une colonne : sa teinte, ou neutre.
   *
   * @param {HTMLElement} target
   * @param {number | null} hue
   */
  const paint = (target, hue) => {
    if (Number.isInteger(hue)) target.style.setProperty("--col-hue", String(hue));
    target.classList.toggle("neutral", !Number.isInteger(hue));
  };

  /**
   * Déplace un ticket : tout de suite à l'écran, puis sur le serveur (qui renvoie le tableau à jour).
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
      // Le serveur a refusé : on revient à son état.
      api(`/api/kanbans/${data?.board.id}`).then(update).catch(() => {});
    });
  }

  /**
   * Numéro du ticket : un clic copie son lien (à coller dans un autre ticket ou un agent).
   *
   * @param {Ticket} ticket
   */
  function numberButton(ticket) {
    const label = `#${ticket.number}`;
    const button = el("button", "kanban-card-number", label);
    /** @type {HTMLButtonElement} */ (button).type = "button";
    button.title = "Copier le lien du ticket";
    button.setAttribute("aria-label", `Copier le lien du ticket ${label}`);
    /** @type {number | undefined} */
    let timer;
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      const url = await shareLink(api, location.origin, ticket);
      try {
        await navigator.clipboard.writeText(url);
        button.textContent = "Lien copié";
        button.classList.add("copied");
      } catch {
        button.textContent = label;
        deps.showError(new Error(`Copie refusée par le navigateur. Lien du ticket : ${url}`));
      }
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        button.textContent = label;
        button.classList.remove("copied");
      }, 1500);
    });
    return button;
  }

  /** @param {Ticket} ticket */
  function card(ticket) {
    const item = el("li", "kanban-card");
    item.draggable = true;
    item.dataset.id = ticket.id;
    const open = el("button", "kanban-card-open");
    open.type = "button";
    open.dataset.id = ticket.id;
    open.setAttribute("aria-keyshortcuts", "Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown");
    open.title = "Ouvrir le ticket · Alt + flèches pour le déplacer";
    open.append(el("span", "kanban-card-title", ticket.title));
    const preview = descriptionPreview(ticket.description);
    if (preview) open.append(el("span", "kanban-card-preview", preview));
    if (ticket.files.length) {
      const files = el("span", "kanban-card-meta");
      files.append(icon(deps.icons.file), el("span", "", String(ticket.files.length)));
      files.title = `${ticket.files.length} fichier${ticket.files.length > 1 ? "s" : ""} joint${ticket.files.length > 1 ? "s" : ""}`;
      open.append(files);
    }
    open.addEventListener("click", () => deps.openTicket(ticket.id));
    item.append(numberButton(ticket));
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
      // Au tick suivant : le navigateur a déjà pris l'image de la carte à glisser.
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
   * Zone d'ajout rapide en bas de colonne : un titre, Entrée crée le ticket (Échap annule).
   *
   * @param {string} columnId
   */
  function quickAdd(columnId) {
    const wrap = el("div", "kanban-add");
    if (addingIn !== columnId) {
      const open = el("button", "kanban-add-open");
      open.type = "button";
      open.append(icon(deps.icons.plus), el("span", "", "Ajouter un ticket"));
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
    input.placeholder = "Titre du ticket… (Entrée pour créer, Échap pour annuler)";
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
        // Après le clic éventuel ailleurs (autre colonne) : on ne redessine pas sous le pointeur.
        setTimeout(() => addingIn === null && render());
      }
    });
    wrap.append(input);
    return wrap;
  }

  /** @param {import("./kanban-logic.js").Column} column */
  function columnSection(column) {
    if (!data) return el("section");
    const tickets = columnTickets(data.tickets, column.id);
    const section = el("section", "kanban-column");
    section.dataset.column = column.id;
    paint(section, column.hue);
    const head = el("header", "kanban-column-head");
    const dot = el("span", "kanban-dot");
    dot.setAttribute("aria-hidden", "true");
    head.append(dot, el("h3", "kanban-column-name", column.name), el("span", "kanban-count", String(tickets.length)));
    const list = el("ol", "kanban-cards");
    list.setAttribute("aria-label", `Tickets « ${column.name} »`);
    list.append(...tickets.map(card));
    // Glisser-déposer : la ligne d'insertion suit le pointeur dans la colonne survolée.
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

  /** Colonne « + » au bout du tableau : ajoute une colonne. */
  function addColumn() {
    const section = el("section", "kanban-column kanban-new-column");
    const form = el("form", "kanban-new-column-form");
    const input = /** @type {HTMLInputElement} */ (el("input", "text-input"));
    Object.assign(input, { placeholder: "Nouvelle colonne", maxLength: 60, autocomplete: "off" });
    input.setAttribute("aria-label", "Nom de la nouvelle colonne");
    const add = el("button", "", "Ajouter");
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
      pending = next; // pas de redessin sous le pointeur pendant un glisser
      return;
    }
    pending = null;
    // Le ticket qui avait le clavier le garde ; la zone d'ajout rapide garde sa saisie.
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

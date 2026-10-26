// @ts-check
// Mode Tâches : la fiche d'un ticket, dans une fenêtre (<dialog>). Titre, colonne, description en
// Markdown (onglets Écrire / Aperçu), fichiers joints (bouton, glisser-déposer ou coller), suppression.
// Les modifications s'enregistrent avec « Enregistrer » (ou Ctrl+Entrée) ; fermer avec des modifications
// non enregistrées demande confirmation. Les fichiers et la colonne s'enregistrent tout de suite.
// En bas, l'historique du ticket (tous ses changements, gardés par le serveur), du plus récent au plus ancien.

import { formatSize } from "./files-tree.js";
import { splitReferences, ticketUrl } from "./kanban-logic.js";

const MAX_FILE = 25 * 1024 * 1024; // comme kanban.py

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
 * @property {(text: string, target: HTMLElement) => void} renderMarkdown
 * @property {(number: number) => {title: string, boardName: string} | undefined} lookup ticket d'après son numéro
 * @property {(number: number) => void} onOpen fiche ouverte (l'adresse devient /t/<numéro>)
 * @property {() => void} onClose fiche fermée
 */

/**
 * Remplace, dans un texte déjà mis en forme, les « #42 » de tickets connus par des liens vers /t/42
 * (hors code et hors liens). Les nœuds sont créés un à un : aucun innerHTML.
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
    reader.addEventListener("error", () => reject(new Error(`lecture impossible : ${file.name}`)));
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
  title.setAttribute("aria-label", "Titre du ticket");
  const close = el("button", "icon-button");
  close.type = "button";
  close.title = "Fermer (Échap)";
  close.setAttribute("aria-label", "Fermer");
  close.append(icon(deps.icons.close));
  // Numéro du ticket et bouton « Copier le lien » (adresse /t/<numéro>, à coller dans un ticket ou un agent).
  // Le numéro copie aussi le lien (comme sur les cartes du tableau).
  const number = el("button", "ticket-number");
  /** @type {HTMLButtonElement} */ (number).type = "button";
  number.title = "Copier le lien du ticket";
  const copy = el("button", "ticket-copy", "Copier le lien");
  copy.type = "button";
  /** @type {number | undefined} */
  let copiedTimer;
  // Lien à partager : avec sa clé de lecture, un agent peut lire le ticket (texte) en suivant ce lien.
  /** @type {string | null} */
  let shareUrl = null;
  copy.addEventListener("click", async () => {
    if (!ticket) return;
    const url = shareUrl ?? ticketUrl(location.origin, ticket.number);
    try {
      await navigator.clipboard.writeText(url);
      copy.textContent = "Lien copié";
      number.classList.add("copied");
    } catch {
      // Presse-papiers refusé par le navigateur : on montre le lien à copier à la main.
      copy.textContent = url;
    }
    copy.title = url;
    clearTimeout(copiedTimer);
    copiedTimer = window.setTimeout(() => {
      copy.textContent = "Copier le lien";
      number.classList.remove("copied");
    }, 2000);
  });
  number.addEventListener("click", () => copy.click());
  const head = el("div", "ticket-head");
  head.append(number, title, copy, close);

  const columnSelect = /** @type {HTMLSelectElement} */ (el("select", "text-input ticket-column"));
  columnSelect.setAttribute("aria-label", "Colonne");
  const dates = el("span", "muted small");
  const meta = el("div", "ticket-meta");
  meta.append(el("span", "muted small", "Colonne"), columnSelect, dates);

  // Description : Écrire / Aperçu.
  const tabs = el("div", "ticket-tabs");
  tabs.setAttribute("role", "tablist");
  const writeTab = el("button", "", "Écrire");
  const previewTab = el("button", "", "Aperçu");
  for (const tab of [writeTab, previewTab]) {
    /** @type {HTMLButtonElement} */ (tab).type = "button";
    tab.setAttribute("role", "tab");
  }
  tabs.append(writeTab, previewTab);
  const description = /** @type {HTMLTextAreaElement} */ (el("textarea", "text-input ticket-description"));
  description.placeholder = "Description (Markdown : titres, listes, `code`, liens…)";
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
        deps.renderMarkdown(description.value, preview);
        linkReferences(preview, deps.lookup); // « #42 » : lien vers le ticket 42
      }
      else preview.append(el("p", "muted", "Pas de description."));
    }
  };
  writeTab.addEventListener("click", () => showTab(false));
  previewTab.addEventListener("click", () => showTab(true));

  // Fichiers joints.
  const files = el("ul", "ticket-files");
  const picker = /** @type {HTMLInputElement} */ (el("input"));
  picker.type = "file";
  picker.multiple = true;
  picker.hidden = true;
  const attach = el("button", "", "Joindre des fichiers");
  attach.type = "button";
  attach.addEventListener("click", () => picker.click());
  picker.addEventListener("change", () => {
    upload([...(picker.files ?? [])]);
    picker.value = "";
  });
  const filesSection = el("div", "ticket-files-section");
  filesSection.append(el("h3", "settings-title", "Fichiers"), files, attach, picker,
    el("p", "muted small", "Glisse ou colle des fichiers dans cette fenêtre. 25 Mo au maximum par fichier."));

  // Historique : relu à l'ouverture et à chaque changement du tableau.
  const history = /** @type {HTMLDetailsElement} */ (el("details", "ticket-history"));
  const historySummary = el("summary", "settings-title", "Historique");
  const historyList = el("ol", "ticket-history-list");
  history.append(historySummary, historyList);
  let historyRequest = 0;

  /**
   * Phrase d'un changement, avec les noms tels qu'ils étaient à ce moment-là.
   *
   * @param {any} entry
   */
  function describe(entry) {
    const quote = (/** @type {string} */ text) => `« ${text} »`;
    switch (entry.kind) {
      case "created": return `Créé dans ${quote(entry.column)}`;
      case "title": return `Titre : ${quote(entry.before)} → ${quote(entry.after)}`;
      case "description": return entry.before ? "Description modifiée" : "Description ajoutée";
      case "moved": return `Déplacé de ${quote(entry.fromColumn)} vers ${quote(entry.toColumn)}${entry.reason ? ` (${entry.reason})` : ""}`;
      case "file_added": return `Fichier joint : ${entry.name} (${formatSize(entry.size ?? 0)})`;
      case "file_removed": return `Fichier retiré : ${entry.name}`;
      default: return entry.kind;
    }
  }

  /** @param {any[]} entries du plus ancien au plus récent */
  function renderHistory(entries) {
    historySummary.textContent = `Historique (${entries.length})`;
    historyList.replaceChildren(...[...entries].reverse().map((entry) => {
      const item = el("li", `ticket-history-item kind-${entry.kind}`);
      const when = el("time", "muted small", new Date(entry.at * 1000).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }));
      when.setAttribute("datetime", new Date(entry.at * 1000).toISOString());
      item.append(when, el("span", "", describe(entry)));
      // Changement fait par un agent (outils MCP) : son nom.
      if (entry.by && entry.by !== "user") item.append(el("span", "ticket-history-by muted small", `par ${entry.by}`));
      // Description : avant / après, repliés.
      if (entry.kind === "description") {
        const diff = el("details", "ticket-history-diff");
        diff.append(el("summary", "link-button", "Voir avant / après"));
        for (const [label, text] of [["Avant", entry.before], ["Après", entry.after]]) {
          diff.append(el("span", "muted small", label), el("pre", "ticket-history-text", text || "(vide)"));
        }
        item.append(diff);
      }
      return item;
    }));
    if (!entries.length) historyList.append(el("li", "muted small", "Aucun changement enregistré."));
  }

  async function loadHistory() {
    if (!ticket) return;
    const request = ++historyRequest;
    try {
      const data = await api(`/api/kanbans/tickets/${ticket.id}/history`);
      if (request === historyRequest) renderHistory(data.history);
    } catch {
      // Ticket supprimé entre-temps : la fiche se ferme d'elle-même.
    }
  }

  const error = el("p", "form-error");
  error.hidden = true;
  const remove = el("button", "danger", "Supprimer le ticket");
  remove.type = "button";
  const save = /** @type {HTMLButtonElement} */ (el("button", "primary", "Enregistrer"));
  save.type = "button";
  save.title = "Enregistrer (Ctrl+Entrée)";
  const footer = el("div", "ticket-footer");
  footer.append(remove, el("span", "spacer"), save);

  const body = el("div", "ticket-body");
  body.append(head, meta, tabs, description, preview, filesSection, history, error, footer);
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

  /** Fichiers et colonne du ticket, d'après les dernières données reçues. */
  function renderLive() {
    if (!ticket || !board) return;
    columnSelect.replaceChildren(...board.columns.map((column) => {
      const option = /** @type {HTMLOptionElement} */ (el("option", "", column.name));
      option.value = column.id;
      option.selected = column.id === ticket?.column;
      return option;
    }));
    const when = (/** @type {number} */ t) => new Date(t * 1000).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
    dates.textContent = `Créé le ${when(ticket.createdAt)} · modifié le ${when(ticket.updatedAt)}`;
    files.replaceChildren(...ticket.files.map((file) => {
      const item = el("li", "ticket-file");
      const link = /** @type {HTMLAnchorElement} */ (el("a", "ticket-file-link"));
      link.href = `/api/kanbans/tickets/${ticket?.id}/files/${file.id}/${encodeURIComponent(file.name)}`;
      link.target = "_blank";
      link.rel = "noopener";
      link.append(icon(deps.icons.file), el("span", "", file.name));
      const drop = el("button", "link-button", "Retirer");
      drop.type = "button";
      drop.setAttribute("aria-label", `Retirer « ${file.name} »`);
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
    if (!ticket.files.length) files.append(el("li", "muted small", "Aucun fichier."));
  }

  /** @param {File[]} list */
  async function upload(list) {
    if (!ticket) return;
    const id = ticket.id;
    error.hidden = true;
    for (const file of list) {
      if (file.size > MAX_FILE) {
        showError(`« ${file.name} » est trop gros (25 Mo au maximum).`);
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
      title: `Supprimer « ${ticket.title.slice(0, 60)} » ?`,
      message: ticket.files.length ? "Le ticket et ses fichiers joints seront supprimés." : "Le ticket sera supprimé.",
      confirmLabel: "Supprimer",
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
        title: "Fermer sans enregistrer ?",
        message: "Tes modifications du titre ou de la description seront perdues.",
        confirmLabel: "Fermer sans enregistrer",
        cancelLabel: "Continuer",
        danger: true,
      });
      if (!discard) return;
    }
    ticket = null;
    dialog.close();
  }
  close.addEventListener("click", requestClose);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault(); // Échap : même chemin que le bouton, pour ne rien perdre sans le dire
    requestClose();
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) requestClose(); // clic sur le fond
  });

  // Fichiers glissés ou collés dans la fenêtre.
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
      copy.textContent = "Copier le lien";
      copy.title = ticketUrl(location.origin, next.number);
      shareUrl = null;
      api(`/api/kanbans/tickets/${next.id}/link`)
        .then((link) => {
          if (ticket?.id === next.id) {
            shareUrl = `${location.origin}${link.path}`;
            copy.title = `${shareUrl}\nAvec ce lien, un agent peut lire le ticket.`;
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
      historySummary.textContent = "Historique";
      loadHistory();
      if (!dialog.open) dialog.showModal();
      if (!next.description) description.focus();
      else title.focus();
    },
    /**
     * Nouvelles données du tableau : la fiche suit (fichiers, colonne), ou se ferme si le ticket a disparu.
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
      // La saisie en cours est gardée ; si rien n'était modifié, on suit le serveur (autre onglet).
      if (title.value.trim() === saved.title && description.value === saved.description) {
        title.value = next.title;
        description.value = next.description;
      }
      saved = { title: next.title, description: next.description };
      renderLive();
      refreshSave();
      loadHistory();
    },
    /** @param {string} boardId le tableau a été supprimé */
    boardDeleted(boardId) {
      if (ticket?.board === boardId && dialog.open) {
        ticket = null;
        dialog.close();
      }
    },
  };
}

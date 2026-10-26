// @ts-check
// Onglet Discussion : la conversation de l'agent, mise en forme (ce que tu écris part dans le Terminal).
// Relue depuis la session Claude Code tant que l'onglet est affiché ; le serveur ne la renvoie que si elle a
// changé. En bas, une zone de saisie : le message envoyé est tapé dans le Terminal, où l'on bascule. Deux affichages : « Tout » (messages et réponses), « Mes messages » (seulement ce que tu as envoyé,
// chaque réponse se déplie à la demande). Deux boutons flottants, en bas à droite contre les messages :
// replier / déplier, et aller en haut / en bas. Aucun contenu ne passe par innerHTML.

import { buildTurns, replyText, sentText, toolNames, toolSummary, turnMarkdown } from "./discussion-logic.js";
import { createDropdown } from "./dropdown.js";

const MODE_KEY = "zo-discussion-mode";
const POLL_MS = 2000;

/**
 * @typedef {import("./discussion-logic.js").Turn} Turn
 * @typedef {import("./discussion-logic.js").Item} Item
 *
 * @typedef {object} DiscussionDeps
 * @property {(path: string, body?: object) => Promise<any>} api
 * @property {(tag: string, className?: string, text?: string) => HTMLElement} el
 * @property {(text: string, target: HTMLElement) => void} renderMarkdown
 * @property {(conversation: any) => string} [agentName] nom affiché de l'agent (titre des PDF)
 * @property {(conversation: any) => boolean} isRunning Claude Code est-il ouvert dans le Terminal ?
 * @property {(conversation: any, text: string) => Promise<void>} send tape le message dans le Terminal
 */

const ICONS = {
  // Replier : ne garder que mes messages ; déplier : toute la discussion.
  collapse: "M7 4l5 5 5-5M7 20l5-5 5 5",
  expand: "M7 9l5-5 5 5M7 15l5 5 5-5",
  down: "M12 5v14M6 13l6 6 6-6",
  up: "M12 19V5M6 11l6-6 6 6",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  check: "M5 12l5 5L20 7",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  pdf: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M12 11v6M9 14l3 3 3-3",
  send: "M12 19V5M5 12l7-7 7 7",
};

/** @param {string} d tracé SVG (24×24, en traits) */
function icon(d) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  svg.append(path);
  return svg;
}

/** @param {string | undefined} iso */
function timeOf(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  const sameDay = date.toDateString() === new Date().toDateString();
  return date.toLocaleString("fr-FR", sameDay ? { hour: "2-digit", minute: "2-digit" } : { dateStyle: "short", timeStyle: "short" });
}

/** @param {string} key */
function loadMode(key) {
  try {
    return localStorage.getItem(key) === "mine" ? "mine" : "all";
  } catch {
    return "all";
  }
}

/**
 * @param {HTMLElement} root
 * @param {DiscussionDeps} deps
 */
export function mountDiscussionView(root, deps) {
  const { api, el } = deps;
  /** @type {"all" | "mine"} */
  let mode = loadMode(MODE_KEY);
  /** @type {any} agent affiché (null : onglet caché) */
  let shown = null;
  /** @type {string | null} */
  let session = null;
  /** @type {string | null} agent de la discussion chargée (gardée quand on change d'onglet) */
  let loadedFor = null;
  /** @type {string | null} empreinte de la dernière version reçue */
  let signature = null;
  /** @type {any} */
  let transcript = null;
  /** @type {number | undefined} */
  let timer;
  let loading = false;
  // Menu d'un message (copier, PDF) : posé sur la page, il survit aux relectures de la discussion.
  const dropdown = createDropdown({ el, icon });
  /** @type {string | null} échange dont le menu est ouvert */
  let menuTurn = null;
  // Résumé de la barre ; un message bref (copié, PDF…) le remplace un instant.
  let summaryText = "";
  /** @type {number | undefined} */
  let flashTimer;
  // Ce que tu as déplié ou replié : gardé d'une relecture à l'autre.
  const openTurns = new Set();
  const toggled = new Map(); // identifiant d'un bloc repliable → ouvert ?

  // Barre : le résumé de la discussion.
  const bar = el("div", "discussion-bar");
  const summary = el("span", "discussion-summary muted small");
  bar.append(summary);
  const log = el("div", "discussion-log");
  log.setAttribute("aria-live", "polite");

  // Boutons flottants : replier / déplier, puis aller en haut / en bas (selon l'endroit où l'on est).
  const fabs = el("div", "discussion-fabs");
  const foldButton = el("button", "fab discussion-fold");
  foldButton.type = "button";
  foldButton.addEventListener("click", () => setMode(mode === "mine" ? "all" : "mine"));
  const scrollButton = el("button", "fab discussion-scroll");
  scrollButton.type = "button";
  scrollButton.addEventListener("click", () => {
    // Saut direct : une animation serait longue sur une grande discussion.
    log.scrollTop = atBottom() ? 0 : log.scrollHeight;
    renderFabs();
  });
  fabs.append(foldButton, scrollButton);
  // Les boutons flottants restent contre les messages, au-dessus de la zone de saisie.
  const main = el("div", "discussion-main");
  main.append(log, fabs);

  // Zone de saisie : Entrée envoie, Maj+Entrée ajoute une ligne (comme dans le Terminal). Un brouillon par agent.
  /** @type {Map<string, string>} */
  const drafts = new Map();
  const composer = /** @type {HTMLFormElement} */ (el("form", "discussion-composer"));
  const input = /** @type {HTMLTextAreaElement} */ (el("textarea"));
  input.rows = 1;
  input.setAttribute("aria-label", "Message à l'agent");
  // Mode console (« !! » au début) : la saisie devient une commande shell, lancée dans le dossier de l'agent.
  const shellBadge = el("span", "shell-badge", "$");
  shellBadge.title = "Mode console : la saisie est une commande shell (Échap pour revenir à l'agent)";
  shellBadge.hidden = true;
  const sendButton = /** @type {HTMLButtonElement} */ (el("button", "discussion-send"));
  sendButton.type = "submit";
  sendButton.title = "Envoyer dans le Terminal (Entrée)";
  sendButton.setAttribute("aria-label", "Envoyer dans le Terminal");
  sendButton.append(icon(ICONS.send));
  composer.append(shellBadge, input, sendButton);
  root.append(bar, main, composer);

  /** La zone grandit avec le message, jusqu'à une dizaine de lignes. */
  function fitInput() {
    input.style.height = "auto";
    const border = input.offsetHeight - input.clientHeight;
    input.style.height = `${Math.min(input.scrollHeight + border, 220)}px`;
  }

  /**
   * Un message part dans le Terminal : il faut que Claude Code y soit ouvert. Le mode console, lui, n'a pas
   * besoin de Claude : la saisie reste donc toujours possible (« !! » pour y passer).
   */
  function renderComposer() {
    const running = Boolean(shown && deps.isRunning(shown));
    composer.classList.toggle("shell-mode", shellMode);
    shellBadge.hidden = !shellMode;
    input.disabled = !shown;
    input.setAttribute("aria-label", shellMode ? "Commande shell" : "Message à l'agent");
    input.placeholder = shellMode
      ? `Commande shell dans ${shown?.cwd ?? "le dossier de l'agent"} (Entrée lance, Échap revient à l'agent)`
      : running
        ? "Écrire à l'agent… (Entrée envoie dans le Terminal, Maj+Entrée : nouvelle ligne, !! : commande shell)"
        : "Ouvre Claude Code dans l'onglet Terminal pour écrire à l'agent, ou tape !! pour une commande shell.";
    sendButton.title = shellMode ? "Lancer la commande (Entrée)" : "Envoyer dans le Terminal (Entrée)";
    sendButton.setAttribute("aria-label", shellMode ? "Lancer la commande" : "Envoyer dans le Terminal");
    sendButton.disabled = !input.value.trim() || (!shellMode && !running);
  }

  // --- mode console : « !! commande » lance une commande shell dans le dossier de l'agent -----------
  // La commande et sa sortie s'affichent dans la discussion, à la suite des messages ; rien ne part à Claude.
  const SHELL_PREFIX = "!!";
  let shellMode = false;
  /** @type {string[]} commandes lancées, pour ↑ / ↓ en mode console */
  const shellHistory = [];
  let historyIndex = -1;
  /** @type {Map<string, {node: HTMLElement, body: HTMLElement, status: HTMLElement, stop: HTMLElement}>} */
  const shellRuns = new Map();
  /** @type {Map<string, HTMLElement[]>} blocs des commandes de chaque agent, gardés d'une relecture à l'autre */
  const shellBlocks = new Map();

  /** @param {boolean} on */
  function setShellMode(on) {
    if (on === shellMode) return;
    shellMode = on;
    historyIndex = -1;
    renderComposer();
  }

  async function runShellCommand() {
    const conversation = shown;
    const command = input.value.trim();
    if (!conversation || !command) return;
    if (shellHistory.at(-1) !== command) shellHistory.push(command);
    historyIndex = -1;
    input.value = "";
    drafts.delete(conversation.id);
    fitInput();
    renderComposer();
    try {
      await deps.api(`/api/conversations/${conversation.id}/shell`, { command });
    } catch (err) {
      input.value = command;
      renderComposer();
      flash(`Commande impossible : ${/** @type {Error} */ (err).message}`);
    }
  }

  /**
   * Événement d'une commande : début (bloc console), sortie (ajoutée au fil de l'eau), fin (code, durée).
   *
   * @param {any} data
   */
  function onShell(data) {
    if (data.started) {
      const node = el("div", "entry console");
      const head = el("div", "console-head");
      const status = el("span", "console-status", "en cours…");
      const stop = el("button", "console-stop", "Arrêter");
      /** @type {HTMLButtonElement} */ (stop).type = "button";
      stop.addEventListener("click", () => {
        /** @type {HTMLButtonElement} */ (stop).disabled = true;
        deps.api(`/api/conversations/${data.conversation}/shell-stop`, { run: data.run }).catch(() => {});
      });
      const command = el("code", "console-command", `$ ${data.command}`);
      command.title = data.cwd;
      head.append(command, status, stop);
      const body = el("pre", "console-body");
      node.append(head, body);
      shellRuns.set(data.run, { node, body, status, stop });
      shellBlocks.set(data.conversation, [...(shellBlocks.get(data.conversation) ?? []), node]);
      if (shown?.id === data.conversation) {
        const stick = atBottom();
        log.append(node);
        if (stick) log.scrollTop = log.scrollHeight;
      }
      return;
    }
    const run = shellRuns.get(data.run);
    if (!run) return;
    const stick = run.node.isConnected && atBottom();
    if (data.output) run.body.append(document.createTextNode(data.output));
    if (data.ended) {
      shellRuns.delete(data.run);
      run.stop.remove();
      // Code négatif : arrêtée par un signal (bouton Arrêter, délai dépassé).
      const outcome = data.timedOut ? "délai dépassé (10 min)" : data.code < 0 ? "arrêtée" : `code ${data.code}`;
      const notes = [outcome, `${String(data.seconds).replace(".", ",")} s`];
      if (data.truncated) notes.push("sortie tronquée");
      run.status.textContent = notes.join(" · ");
      run.status.classList.add(data.code === 0 ? "ok" : "failed");
      if (!run.body.textContent) run.body.remove();
    }
    if (stick) log.scrollTop = log.scrollHeight;
  }

  input.addEventListener("input", () => {
    // « !! » au début passe en mode console (et ne fait pas partie de la commande).
    if (input.value.startsWith(SHELL_PREFIX)) {
      const caret = Math.max(0, input.selectionStart - SHELL_PREFIX.length);
      input.value = input.value.slice(SHELL_PREFIX.length);
      input.setSelectionRange(caret, caret);
      setShellMode(true);
    }
    if (shown) drafts.set(shown.id, input.value);
    fitInput();
    renderComposer();
  });
  input.addEventListener("keydown", (event) => {
    // Mode console : Échap, ou Retour arrière au tout début, revient à l'agent.
    if (shellMode && (event.key === "Escape" || (event.key === "Backspace" && input.selectionStart === 0 && input.selectionEnd === 0))) {
      event.preventDefault();
      event.stopPropagation();
      setShellMode(false);
      return;
    }
    // Mode console : ↑ / ↓ rappellent les commandes déjà lancées.
    if (shellMode && (event.key === "ArrowUp" || event.key === "ArrowDown") && shellHistory.length && !input.value.includes("\n")) {
      event.preventDefault();
      const last = shellHistory.length - 1;
      historyIndex = event.key === "ArrowUp"
        ? (historyIndex === -1 ? last : Math.max(0, historyIndex - 1))
        : (historyIndex === -1 || historyIndex >= last ? -1 : historyIndex + 1);
      input.value = historyIndex === -1 ? "" : shellHistory[historyIndex];
      input.setSelectionRange(input.value.length, input.value.length);
      fitInput();
      renderComposer();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      composer.requestSubmit();
    }
  });
  composer.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (shellMode) {
      runShellCommand();
      return;
    }
    const conversation = shown;
    const text = input.value;
    if (!conversation || !text.trim() || !deps.isRunning(conversation)) return;
    try {
      await deps.send(conversation, text);
      drafts.delete(conversation.id);
      // Onglet déjà masqué (bascule sur le Terminal) ou même agent : la zone se vide ; autre agent, son brouillon reste.
      if (!shown || shown.id === conversation.id) input.value = "";
      fitInput();
      renderComposer();
    } catch (err) {
      flash(`Envoi impossible : ${/** @type {Error} */ (err).message}`);
    }
  });

  const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 60;

  /** Les boutons flottants suivent l'affichage et la position dans la discussion. */
  function renderFabs() {
    const mine = mode === "mine";
    const foldLabel = mine ? "Afficher toute la discussion" : "N'afficher que mes messages";
    foldButton.replaceChildren(icon(mine ? ICONS.expand : ICONS.collapse));
    foldButton.title = foldLabel;
    foldButton.setAttribute("aria-label", foldLabel);
    foldButton.setAttribute("aria-pressed", String(mine));
    const scrollable = log.scrollHeight > log.clientHeight + 10;
    scrollButton.hidden = !scrollable;
    const down = !atBottom();
    const scrollLabel = down ? "Aller en bas de la discussion" : "Aller en haut de la discussion";
    scrollButton.replaceChildren(icon(down ? ICONS.down : ICONS.up));
    scrollButton.title = scrollLabel;
    scrollButton.setAttribute("aria-label", scrollLabel);
  }
  log.addEventListener("scroll", renderFabs, { passive: true });

  /** @param {"all" | "mine"} next */
  function setMode(next) {
    mode = next;
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      // Stockage indisponible : le choix vaut pour cet onglet seulement.
    }
    root.classList.toggle("mine-only", mode === "mine");
    if (mode === "all") openTurns.clear();
    render(true);
  }
  root.classList.toggle("mine-only", mode === "mine");

  /**
   * Bloc repliable dont l'état survit aux relectures.
   *
   * @param {string} key
   * @param {string} className
   * @param {Node[]} head
   * @param {() => Node[]} body construit à l'ouverture seulement (sorties longues)
   */
  function foldable(key, className, head, body) {
    const details = /** @type {HTMLDetailsElement} */ (el("details", className));
    const summaryEl = el("summary");
    summaryEl.append(...head);
    details.append(summaryEl);
    let filled = false;
    const fill = () => {
      if (filled) return;
      filled = true;
      details.append(...body());
    };
    if (toggled.get(key)) {
      details.open = true;
      fill();
    }
    details.addEventListener("toggle", () => {
      toggled.set(key, details.open);
      if (details.open) fill();
    });
    return details;
  }

  /**
   * @param {import("./discussion-logic.js").Tool} tool
   */
  function toolRow(tool) {
    const row = el("li", `tool-row${tool.isError ? " failed" : ""}`);
    const line = el("div", "tool-line");
    line.append(el("span", "tool-name", tool.name), el("span", "tool-summary", toolSummary(tool.name, tool.input)));
    row.append(line);
    if (tool.result) {
      row.append(foldable(`result:${tool.id}`, "tool-result", [el("span", "", tool.isError ? "Erreur" : "Résultat")],
        () => [el("pre", "", tool.result ?? "")]));
    }
    return row;
  }

  /**
   * @param {Item} item
   * @param {string} prefix
   * @returns {Node}
   */
  function itemNode(item, prefix) {
    if (item.kind === "text") {
      const box = el("div", "reply-text markdown");
      deps.renderMarkdown(item.text, box);
      return box;
    }
    if (item.kind === "tools") {
      const count = item.tools.length;
      const failed = item.tools.some((tool) => tool.isError);
      const head = [
        el("span", "tool-group-count", `${count} action${count > 1 ? "s" : ""}`),
        el("span", "tool-group-names", toolNames(item.tools)),
      ];
      if (failed) head.push(el("span", "tool-group-failed", "erreur"));
      return foldable(`${prefix}tools:${item.id}`, "tool-group", head, () => {
        const list = el("ol", "tool-list");
        list.append(...item.tools.map(toolRow));
        return [list];
      });
    }
    if (item.kind === "subagent") {
      const sub = transcript?.subagents?.[item.id];
      const description = item.input?.description || sub?.description || "Sous-agent";
      const head = [el("span", "subagent-label", "Sous-agent"), el("span", "subagent-description", description)];
      const type = item.input?.subagent_type || sub?.type;
      if (type) head.push(el("span", "subagent-type", type));
      return foldable(`${prefix}agent:${item.id}`, "reply-subagent", head, () => {
        if (!sub) return [el("p", "muted small", "Son travail n'est pas encore enregistré.")];
        // Son travail : tout sauf sa consigne (le premier message), déjà résumée dans le titre.
        const items = buildTurns(sub.messages).flatMap((turn, index) => (index === 0 && turn.sent ? turn.items : [
          ...(turn.sent ? [/** @type {Item} */ ({ kind: "info", text: turn.sent.text })] : []), ...turn.items,
        ]));
        return items.map((child) => itemNode(child, `${prefix}${item.id}/`));
      });
    }
    if (item.kind === "output") {
      const box = el("div", "reply-output");
      box.append(el("span", "reply-output-label", item.label), el("pre", "", item.text));
      return box;
    }
    return el("p", "reply-info", item.text);
  }

  /** @param {Turn} turn */
  function turnNode(turn) {
    const open = openTurns.has(turn.id);
    const article = el("article", `turn${open ? " open" : ""}${turn.sent ? "" : " no-sent"}`);
    article.dataset.turn = turn.id;
    if (turn.sent) {
      const sent = el("div", `turn-sent kind-${turn.sent.kind}`);
      const bubble = el("div", "turn-bubble");
      if (turn.sent.kind === "prompt") bubble.textContent = turn.sent.text;
      else bubble.append(el("code", "", turn.sent.kind === "bash" ? `! ${turn.sent.text}` : turn.sent.text));
      const meta = el("div", "turn-meta muted small");
      meta.append(el("span", "", timeOf(turn.sent.timestamp)));
      if (turn.items.length) {
        // « Mes messages » : la réponse se déplie sous le message.
        const toggle = el("button", "link-button turn-toggle", open ? "Masquer la réponse" : "Voir la réponse");
        toggle.type = "button";
        toggle.addEventListener("click", () => {
          if (openTurns.has(turn.id)) openTurns.delete(turn.id);
          else openTurns.add(turn.id);
          render(false);
        });
        meta.append(toggle);
      }
      meta.append(optionsButton(turn));
      sent.append(bubble, meta);
      if (turn.sent.shared) {
        sent.append(foldable(`shared:${turn.id}`, "turn-shared", [el("span", "", "Contexte partagé avec l'agent")],
          () => [el("div", "turn-shared-body", turn.sent?.shared ?? "")]));
      }
      article.append(sent);
    }
    const reply = el("div", "turn-reply");
    reply.append(...turn.items.map((item) => itemNode(item, `${turn.id}/`)));
    article.append(reply);
    return article;
  }

  /** @param {boolean} toBottom aller en bas (changement d'affichage, première lecture) */
  function render(toBottom) {
    const stick = toBottom || log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    const scroll = log.scrollTop;
    if (!shown) return;
    const consoleBlocks = shellBlocks.get(shown.id) ?? [];
    if (!session) {
      log.replaceChildren(el("p", "discussion-empty muted", "Pas encore de discussion : écris à Claude Code dans l'onglet Terminal."),
        ...consoleBlocks);
      summary.textContent = "";
      return;
    }
    if (!transcript) {
      log.replaceChildren(el("p", "discussion-empty muted", "Chargement de la discussion…"));
      return;
    }
    const turns = buildTurns(transcript.messages);
    const sentCount = turns.filter((turn) => turn.sent).length;
    const cost = typeof transcript.costUsd === "number" ? ` · ${transcript.costUsd.toFixed(2)} $` : "";
    summaryText = `${sentCount} message${sentCount > 1 ? "s" : ""} envoyé${sentCount > 1 ? "s" : ""}${cost}`;
    if (flashTimer === undefined) summary.textContent = summaryText;
    const nodes = turns.map(turnNode);
    if (transcript.truncated) nodes.unshift(el("p", "discussion-empty muted small", "Seuls les 500 derniers messages sont affichés."));
    if (!turns.length) nodes.push(el("p", "discussion-empty muted", "Pas encore de message dans cette session."));
    // Commandes lancées en mode console : à la suite des messages (mêmes blocs, la sortie continue d'arriver).
    log.replaceChildren(...nodes, ...consoleBlocks);
    log.scrollTop = stick ? log.scrollHeight : scroll;
    renderFabs();
    // Menu ouvert : il suit le bouton redessiné de son message.
    if (menuTurn) {
      const button = [...log.querySelectorAll(".turn-options")].find((node) => node.closest("article")?.dataset.turn === menuTurn);
      dropdown.reanchor(/** @type {HTMLElement | null} */ (button ?? null));
      if (!button) menuTurn = null;
    }
  }

  /**
   * Bouton « ⋯ » d'un message : copier ou exporter en PDF la question et la réponse, ou la réponse seule.
   *
   * @param {Turn} turn
   */
  function optionsButton(turn) {
    const button = el("button", "turn-options");
    /** @type {HTMLButtonElement} */ (button).type = "button";
    button.title = "Options du message";
    button.setAttribute("aria-label", "Options du message");
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", "false");
    button.append(icon(ICONS.more));
    const hasReply = Boolean(replyText(turn));
    button.addEventListener("click", () => {
      menuTurn = menuTurn === turn.id ? null : turn.id;
      dropdown.toggle(button, [
        { label: "Copier la question et la réponse", icon: ICONS.copy, onSelect: () => copyTurn(turn, true, button) },
        { label: "Copier la réponse", icon: ICONS.copy, disabled: !hasReply, onSelect: () => copyTurn(turn, false, button) },
        "separator",
        { label: "PDF : question et réponse", icon: ICONS.pdf, onSelect: () => exportPdf(turn, true) },
        { label: "PDF : réponse seule", icon: ICONS.pdf, disabled: !hasReply, onSelect: () => exportPdf(turn, false) },
      ]);
      if (!dropdown.isOpen()) menuTurn = null;
    });
    return button;
  }

  /**
   * @param {Turn} turn
   * @param {boolean} withQuestion
   * @param {HTMLElement} button
   */
  async function copyTurn(turn, withQuestion, button) {
    menuTurn = null;
    try {
      await navigator.clipboard.writeText(turnMarkdown(turn, withQuestion));
      flash(withQuestion ? "Question et réponse copiées." : "Réponse copiée.");
      button.classList.add("done");
      window.setTimeout(() => button.classList.remove("done"), 1500);
    } catch {
      flash("Copie refusée par le navigateur.");
    }
  }

  /** Message bref dans la barre de la discussion, à la place du résumé. @param {string} text */
  function flash(text) {
    summary.textContent = text;
    summary.classList.add("flash");
    clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => {
      flashTimer = undefined;
      summary.textContent = summaryText;
      summary.classList.remove("flash");
    }, 2500);
  }

  /**
   * Contenu du PDF : la question (texte tel quel) et la réponse (Markdown rendu), construit sans innerHTML.
   *
   * @param {Turn} turn
   * @param {boolean} withQuestion
   */
  function pdfContent(turn, withQuestion) {
    const page = el("div");
    const agent = shown ? deps.agentName?.(shown) ?? shown.label ?? "" : "";
    page.append(el("h1", "", agent || "Discussion"));
    const when = turn.sent?.timestamp ? new Date(turn.sent.timestamp) : null;
    if (when && !Number.isNaN(when.getTime())) {
      page.append(el("p", "pdf-meta", when.toLocaleString("fr-FR", { dateStyle: "long", timeStyle: "short" })));
    }
    if (withQuestion && turn.sent) {
      page.append(el("h2", "pdf-section", "Question"), el("div", "pdf-question", sentText(turn.sent)));
      page.append(el("h2", "pdf-section", "Réponse"));
    }
    const reply = el("div", "markdown");
    const text = replyText(turn);
    if (text) deps.renderMarkdown(text, reply);
    else reply.append(el("p", "", "Pas de réponse écrite."));
    page.append(reply);
    return page;
  }

  /**
   * Télécharge l'échange en PDF (fabriqué par le serveur) ; sans Chrome sur le poste, fenêtre d'impression.
   *
   * @param {Turn} turn
   * @param {boolean} withQuestion
   */
  async function exportPdf(turn, withQuestion) {
    menuTurn = null;
    const content = pdfContent(turn, withQuestion);
    const title = content.querySelector("h1")?.textContent ?? "Discussion";
    const words = (turn.sent ? sentText(turn.sent) : "").split(/\s+/).slice(0, 6).join(" ");
    const filename = `${withQuestion ? "question-reponse" : "reponse"}${words ? ` ${words}` : ""}`;
    flash("PDF en préparation…");
    try {
      const res = await fetch("/api/pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ html: content.innerHTML, title, filename }),
      });
      if (res.status === 501) {
        printFallback(content, title);
        return;
      }
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
      const url = URL.createObjectURL(await res.blob());
      const link = /** @type {HTMLAnchorElement} */ (el("a"));
      link.href = url;
      link.download = decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "discussion.pdf");
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      flash("PDF téléchargé.");
    } catch (err) {
      flash(`PDF impossible : ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Sans Chrome sur le poste : impression du navigateur (« Enregistrer en PDF »), dans un cadre caché.
   *
   * @param {HTMLElement} content
   * @param {string} title
   */
  function printFallback(content, title) {
    const frame = /** @type {HTMLIFrameElement} */ (el("iframe", "print-frame"));
    frame.setAttribute("aria-hidden", "true");
    document.body.append(frame);
    const doc = /** @type {Document} */ (frame.contentDocument);
    doc.title = title;
    const style = doc.createElement("style");
    style.textContent = "body{font:11pt/1.55 system-ui,sans-serif}pre{white-space:pre-wrap;background:#f1f1ee;padding:8px}"
      + ".pdf-question{white-space:pre-wrap;background:#f6f1ea;padding:8px}.pdf-section{color:#c2410c}";
    doc.head.append(style);
    doc.body.append(doc.importNode(content, true));
    frame.contentWindow?.print();
    window.setTimeout(() => frame.remove(), 60_000);
    flash("Choisis « Enregistrer en PDF » dans la fenêtre d'impression.");
  }

  /** Relit la session si elle a changé (le serveur répond « inchangée » sinon). */
  async function refresh() {
    if (!shown || !session || loading) return;
    loading = true;
    const asked = session;
    try {
      const query = new URLSearchParams({ session: asked, ...(signature ? { since: signature } : {}) });
      const data = await api(`/api/transcript?${query}`);
      if (asked !== session || data.unchanged) return;
      const first = !transcript;
      transcript = data;
      signature = data.signature;
      render(first);
    } catch (err) {
      // Session sans historique (Claude Code vient de démarrer) : on réessaie au prochain tour.
      if (!transcript) {
        log.replaceChildren(el("p", "discussion-empty muted", /** @type {any} */ (err).status === 404
          ? "Pas encore de discussion : écris à Claude Code dans l'onglet Terminal."
          : `Lecture impossible : ${/** @type {Error} */ (err).message}`));
      }
    } finally {
      loading = false;
    }
  }

  return {
    /**
     * Affiche la discussion d'un agent (onglet visible) et la tient à jour.
     *
     * @param {any} conversation
     */
    open(conversation) {
      const nextSession = conversation.sessionId || conversation.resumeFrom || null;
      const changed = loadedFor !== conversation.id || nextSession !== session;
      const arriving = shown?.id !== conversation.id;
      shown = conversation;
      if (arriving) {
        input.value = drafts.get(conversation.id) ?? "";
        fitInput();
      }
      renderComposer();
      if (changed) {
        if (loadedFor !== conversation.id) setShellMode(false); // autre agent : on revient à l'écriture à l'agent
        loadedFor = conversation.id;
        session = nextSession;
        signature = null;
        transcript = null;
        openTurns.clear();
        toggled.clear();
        render(true);
      } else {
        render(true);
      }
      refresh();
      timer ??= window.setInterval(refresh, POLL_MS);
    },
    /** Claude Code ouvert ou fermé dans le Terminal : la zone de saisie suit. */
    refreshComposer() {
      if (shown) renderComposer();
    },
    /** Commande shell lancée depuis la saisie (événement « shell » du serveur). */
    onShell,
    hide() {
      shown = null;
      clearInterval(timer);
      timer = undefined;
    },
  };
}

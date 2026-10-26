// @ts-check
// Onglet Terminal : le vrai Claude Code (interactif) de l'agent, affiché par xterm.js (copie figée dans
// vendor/xterm, chargée au premier usage). Le serveur lance `claude` dans un pseudo-terminal : l'écran
// arrive par le flux SSE (événements « terminal », numérotés), les touches repartent par POST.
// Un terminal xterm par agent, gardé quand on change d'agent ou d'onglet.

import { createRecolor } from "./terminal-colors.js";
import { typedText } from "./terminal-input.js";

const XTERM_SCRIPTS = ["/vendor/xterm/xterm.js", "/vendor/xterm/addon-fit.js"];
const NONCE = document.querySelector('meta[name="csp-nonce"]')?.getAttribute("content") ?? "";
// Fond sombre, texte clair : les couleurs d'un terminal.
const THEME = {
  background: "#1d1f23",
  foreground: "#e4e6eb",
  cursor: "#e4e6eb",
  selectionBackground: "#3b4048",
};

/** @type {Promise<void> | undefined} */
let xtermLoading;

/** Charge xterm.js une seule fois. Ses balises <style> reçoivent le nonce CSP de la page. */
function loadXterm() {
  xtermLoading ??= (async () => {
    const create = Document.prototype.createElement;
    // @ts-ignore -- même signature que l'originale
    Document.prototype.createElement = function (tag, options) {
      const element = create.call(this, tag, options);
      if (String(tag).toLowerCase() === "style") /** @type {HTMLStyleElement} */ (element).nonce = NONCE;
      return element;
    };
    for (const src of XTERM_SCRIPTS) {
      await new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = src;
        script.addEventListener("load", resolve);
        script.addEventListener("error", () => reject(new Error(`chargement impossible : ${src}`)));
        document.head.append(script);
      });
    }
  })();
  return xtermLoading;
}

/** @param {string} base64 */
function decode(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * @typedef {object} TerminalViewDeps
 * @property {(path: string, body?: object) => Promise<any>} api
 * @property {(tag: string, className?: string, text?: string) => HTMLElement} el
 *
 * @typedef {{term: any, fit: any, host: HTMLElement, seq: number, ready: boolean, early: {seq: number, data: string}[],
 *   pending: string, sending: boolean, recolor: ReturnType<typeof createRecolor>}} Entry
 */

/**
 * @param {HTMLElement} root
 * @param {TerminalViewDeps} deps
 */
export function mountTerminalView(root, deps) {
  const { api, el } = deps;
  /** @type {Set<string>} agents dont Claude Code tourne dans un terminal */
  const running = new Set();
  /** @type {Map<string, Entry>} */
  const entries = new Map();
  /** @type {any} agent affiché (null : onglet caché) */
  let shown = null;

  const status = el("span", "terminal-status muted small");
  const stop = /** @type {HTMLButtonElement} */ (el("button", "terminal-stop", "Fermer Claude Code"));
  stop.type = "button";
  // Rappel des raccourcis de copier-coller (et confirmation d'une copie).
  const HINT = "Glisser sélectionne · Ctrl+C copie · Ctrl+V colle";
  const hint = el("span", "terminal-hint muted small", HINT);
  const bar = el("div", "terminal-bar");
  bar.append(status, hint, stop);
  const intro = el("div", "terminal-intro");
  const introText = el("p", "muted");
  const start = /** @type {HTMLButtonElement} */ (el("button", "primary", "Ouvrir Claude Code"));
  start.type = "button";
  const error = el("p", "form-error");
  error.hidden = true;
  intro.append(el("h3", "", "Claude Code dans un terminal"), introText, start, error);
  const screens = el("div", "terminal-screens");
  root.append(bar, intro, screens);

  /** @param {unknown} err */
  const showError = (err) => {
    error.textContent = err instanceof Error ? err.message : String(err);
    error.hidden = false;
  };

  /**
   * Terminal xterm de l'agent (créé au besoin, à la taille de la zone).
   *
   * @param {string} id
   */
  async function entryFor(id) {
    const existing = entries.get(id);
    if (existing) return existing;
    await loadXterm();
    // xterm.js copie ses exports sur window (window.Terminal est la classe) ; l'addon s'y range sous FitAddon.
    const Terminal = /** @type {any} */ (window).Terminal;
    const fitAddon = /** @type {any} */ (window).FitAddon;
    const host = el("div", "terminal-screen");
    screens.append(host);
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: getComputedStyle(document.body).getPropertyValue("--mono") || "monospace",
      fontSize: 13,
      scrollback: 5000,
      theme: THEME,
    });
    const fit = new fitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(host);
    /** @type {Entry} */
    const entry = { term, fit, host, seq: 0, ready: false, early: [], pending: "", sending: false, recolor: createRecolor() };
    entries.set(id, entry);
    term.onData((/** @type {string} */ data) => sendInput(id, entry, data));
    // Copier-coller, comme dans un terminal. Ctrl+C copie la sélection s'il y en a une (sans sélection, il
    // interrompt Claude Code) ; Ctrl+Maj+C copie toujours. Ctrl+V et Ctrl+Maj+V laissent le navigateur coller :
    // xterm.js reçoit l'événement paste et envoie le texte.
    // Maj+Entrée : nouvelle ligne dans le message. xterm.js enverrait \r comme Entrée (envoi) ; on envoie
    // Échap+Entrée, que Claude Code lit comme un retour à la ligne.
    term.attachCustomKeyEventHandler((/** @type {KeyboardEvent} */ event) => {
      if (event.key === "Enter" && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
        if (event.type === "keydown") {
          event.preventDefault();
          sendInput(id, entry, "\x1b\r");
        }
        return false;
      }
      if (event.type !== "keydown" || !(event.ctrlKey || event.metaKey) || event.altKey) return true;
      const key = event.key.toLowerCase();
      if (key === "c" && (event.shiftKey || term.hasSelection())) {
        event.preventDefault();
        copySelection(term);
        return false;
      }
      return key !== "v"; // false : xterm.js n'envoie pas ^V, le navigateur colle
    });
    // Sélection à la souris. Claude Code, en plein écran, capture la souris : un glisser lui serait envoyé.
    // xterm.js réserve Maj + glisser à la sélection ; on inverse : un glisser simple sélectionne, et
    // Maj + glisser va à Claude Code. Le double-clic (mot) et le triple-clic (ligne) suivent.
    host.addEventListener("mousedown", (event) => {
      if (!event.isTrusted || event.button !== 0 || event.ctrlKey || event.altKey || event.metaKey) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      term.focus();
      selecting = !event.shiftKey; // le glisser qui suit (déplacements, relâchement) est retransmis avec Maj
      event.target?.dispatchEvent(withShift(event, !event.shiftKey));
    }, true);
    // Copie demandée par Claude Code lui-même (séquence OSC 52, par exemple /copy) : vers le presse-papiers.
    // Seule l'écriture est prise en charge, jamais la lecture du presse-papiers par le programme.
    term.parser.registerOscHandler(52, (/** @type {string} */ data) => {
      const encoded = data.slice(data.indexOf(";") + 1);
      if (!encoded || encoded === "?") return true;
      try {
        const text = new TextDecoder().decode(Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)));
        navigator.clipboard.writeText(text).then(() => flash("Copié par Claude Code"), () => flash("Copie refusée par le navigateur"));
      } catch {
        // Contenu illisible : ignoré.
      }
      return true;
    });
    // Presse-papiers sans texte (une image copiée) : Claude Code la lit lui-même sur ^V, comme dans un terminal.
    host.addEventListener("paste", (event) => {
      if (event.clipboardData?.getData("text/plain")) return;
      if (event.clipboardData?.files.length) {
        event.preventDefault();
        event.stopPropagation();
        sendInput(id, entry, "\x16");
      }
    }, true);
    /** @type {number | undefined} */
    let resizeTimer;
    term.onResize((/** @type {{cols: number, rows: number}} */ size) => {
      clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        if (running.has(id)) api(`/api/conversations/${id}/terminal-resize`, size).catch(() => {});
      }, 100);
    });
    new ResizeObserver(() => {
      if (!host.hidden && host.clientWidth) fit.fit();
    }).observe(host);
    return entry;
  }

  /** @type {number | undefined} */
  let copiedTimer;
  /** Glisser de sélection en cours (voir entryFor) : ses déplacements et son relâchement passent avec Maj. */
  let selecting = false;

  /**
   * Copie d'un événement de souris, avec ou sans Maj (xterm.js sélectionne quand Maj est enfoncée).
   *
   * @param {MouseEvent} event
   * @param {boolean} shiftKey
   */
  const withShift = (event, shiftKey) => new MouseEvent(event.type, {
    bubbles: true, cancelable: true, view: window, detail: event.detail, button: event.button, buttons: event.buttons,
    clientX: event.clientX, clientY: event.clientY, screenX: event.screenX, screenY: event.screenY, shiftKey,
  });
  // Pendant un glisser de sélection, xterm.js ne doit voir que des événements « avec Maj » : sinon Claude Code
  // reçoit le relâchement, ce qui compte comme une saisie et efface la sélection.
  for (const type of ["mousemove", "mouseup"]) {
    document.addEventListener(type, (event) => {
      if (!selecting || !event.isTrusted) return;
      if (type === "mouseup") selecting = false;
      event.stopImmediatePropagation();
      (event.target ?? document).dispatchEvent(withShift(event, true));
    }, true);
  }

  /**
   * Copie la sélection du terminal dans le presse-papiers, et le dit dans la barre du terminal.
   *
   * @param {any} term
   */
  async function copySelection(term) {
    const text = term.getSelection();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      term.clearSelection();
      flash("Sélection copiée");
    } catch {
      flash("Copie refusée par le navigateur");
    }
  }

  /**
   * Message passager à la place du rappel des raccourcis.
   *
   * @param {string} message
   */
  function flash(message) {
    hint.textContent = message;
    hint.classList.add("flash");
    clearTimeout(copiedTimer);
    copiedTimer = window.setTimeout(() => {
      hint.textContent = HINT;
      hint.classList.remove("flash");
    }, 1800);
  }

  /**
   * Touches tapées : envoyées dans l'ordre, regroupées tant qu'un envoi est en cours.
   *
   * @param {string} id
   * @param {Entry} entry
   * @param {string} data
   */
  async function sendInput(id, entry, data) {
    entry.pending += data;
    if (entry.sending) return;
    entry.sending = true;
    while (entry.pending) {
      const chunk = entry.pending;
      entry.pending = "";
      try {
        await api(`/api/conversations/${id}/terminal-input`, { data: chunk });
      } catch (err) {
        entry.pending = "";
        if (shown?.id === id) showError(err);
      }
    }
    entry.sending = false;
  }

  /**
   * Redessine l'écran : sortie récente gardée par le serveur, puis ce qui est arrivé entre-temps.
   *
   * @param {string} id
   * @param {Entry} entry
   * @param {{seq: number, data: string}} snapshot
   */
  function replay(id, entry, snapshot) {
    entry.term.reset();
    entry.recolor.reset();
    if (snapshot.data) entry.term.write(entry.recolor.push(decode(snapshot.data)));
    entry.seq = snapshot.seq;
    for (const chunk of entry.early) if (chunk.seq > entry.seq) write(entry, chunk);
    entry.early = [];
    entry.ready = true;
    // Même taille : le serveur demande quand même à Claude Code de redessiner tout l'écran.
    api(`/api/conversations/${id}/terminal-resize`, { cols: entry.term.cols, rows: entry.term.rows }).catch(() => {});
  }

  /**
   * @param {Entry} entry
   * @param {{seq: number, data: string}} chunk
   */
  function write(entry, chunk) {
    entry.seq = chunk.seq;
    entry.term.write(entry.recolor.push(decode(chunk.data)));
  }

  /** @param {boolean} [focus] donner le clavier au terminal (arrivée sur l'onglet ou sur l'agent) */
  function render(focus = false) {
    const c = shown;
    const id = c?.id;
    const isRunning = Boolean(id && running.has(id));
    const entry = id ? entries.get(id) : undefined;
    for (const [key, other] of entries) other.host.hidden = key !== id;
    bar.hidden = !isRunning && !entry;
    intro.hidden = isRunning;
    stop.hidden = !isRunning;
    status.textContent = isRunning
      ? `Claude Code · ${c.cwd}`
      : entry ? "Claude Code est fermé." : "";
    if (!isRunning && c) {
      introText.textContent = `Ouvre Claude Code dans ${c.cwd}${c.sessionId || c.resumeFrom ? ", sur la session de cet agent" : ""}. `
        + "Toutes ses commandes y marchent (/model, mode plan…). Fermer cet onglet du navigateur ne l'arrête pas.";
    }
    if (isRunning && entry) {
      entry.fit.fit();
      if (focus) entry.term.focus();
    }
  }

  /** Ouvre Claude Code pour l'agent affiché. */
  async function startClaude() {
    const c = shown;
    if (!c || running.has(c.id) || start.disabled) return;
    start.disabled = true;
    error.hidden = true;
    try {
      const entry = await entryFor(c.id);
      entry.host.hidden = false;
      entry.fit.fit();
      entry.ready = false;
      const snapshot = await api(`/api/conversations/${c.id}/terminal-start`, { cols: entry.term.cols, rows: entry.term.rows });
      running.add(c.id);
      replay(c.id, entry, snapshot);
    } catch (err) {
      showError(err);
    } finally {
      start.disabled = false;
      render(true);
    }
  }
  start.addEventListener("click", startClaude);

  stop.addEventListener("click", () => {
    if (shown) api(`/api/conversations/${shown.id}/terminal-stop`, {}).catch(showError);
  });

  /**
   * Affiche le terminal d'un agent (onglet visible) ; s'il tourne déjà, son écran est redessiné.
   *
   * @param {any} conversation
   */
  async function open(conversation) {
    const arriving = shown?.id !== conversation.id;
    shown = conversation;
    if (arriving) error.hidden = true;
    render(arriving);
    const id = conversation.id;
    if (!running.has(id) || entries.get(id)?.ready) return;
    try {
      const entry = await entryFor(id);
      if (shown?.id !== id) return;
      render(true);
      replay(id, entry, await api(`/api/terminal?conversation=${encodeURIComponent(id)}`));
    } catch (err) {
      showError(err);
    }
  }

  return {
    open,
    // Pour les raccourcis : leur bouton dans la barre, leur panneau sur l'écran, et le message bref de la barre.
    bar,
    stopButton: stop,
    screens,
    flash,
    /**
     * Affiche l'agent et ouvre aussitôt son Claude Code (nouvel agent).
     *
     * @param {any} conversation
     */
    async start(conversation) {
      await open(conversation);
      await startClaude();
    },
    hide() {
      shown = null;
    },
    /** @param {string[]} ids terminaux ouverts (état initial du serveur) */
    setRunning(ids) {
      running.clear();
      for (const id of ids) running.add(id);
    },
    /** @param {string} id */
    isRunning: (id) => running.has(id),
    /**
     * Tape un message dans le Claude Code de l'agent puis l'envoie (Entrée), comme au clavier.
     *
     * @param {any} conversation
     * @param {string} text
     */
    async type(conversation, text) {
      const id = conversation.id;
      if (!running.has(id)) throw new Error("Claude Code n'est pas ouvert dans le Terminal.");
      const entry = await entryFor(id);
      sendInput(id, entry, typedText(text));
      // Entrée à part : arrivée avec le texte, Claude Code la prendrait pour un collage (un saut de ligne).
      await new Promise((resolve) => setTimeout(resolve, 150));
      sendInput(id, entry, "\r");
      if (shown?.id === id) entry.term.focus();
    },
    /** @param {{conversation: string, seq: number, data: string}} chunk */
    onData(chunk) {
      const entry = entries.get(chunk.conversation);
      if (!entry) return; // jamais affiché ici : l'écran sera redessiné à l'ouverture
      if (!entry.ready) entry.early.push(chunk);
      else if (chunk.seq > entry.seq) write(entry, chunk);
    },
    /** @param {{conversation: string, running: boolean, code?: number}} event */
    onStatus(event) {
      if (event.running) running.add(event.conversation);
      else {
        running.delete(event.conversation);
        const entry = entries.get(event.conversation);
        if (entry) {
          entry.ready = false;
          entry.term.write(`\r\n\x1b[2m[Claude Code fermé${typeof event.code === "number" ? ` · code ${event.code}` : ""}]\x1b[0m\r\n`);
        }
      }
      if (shown?.id !== event.conversation) return;
      if (event.running) open(shown); // ouvert depuis un autre onglet du navigateur
      else render();
    },
    /** Rafraîchit l'onglet (état de l'agent changé). */
    refresh() {
      if (shown) render();
    },
  };
}

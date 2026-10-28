// @ts-check
// Terminal tab: the agent's real (interactive) Claude Code, shown by xterm.js (frozen copy in
// vendor/xterm, loaded on first use). The server runs `claude` in a pseudo-terminal: the screen
// comes through the SSE stream (numbered "terminal" events), keys go back by POST.
// One xterm terminal per agent, kept when switching agent or tab.

import { t } from "./i18n.js";
import { createRecolor } from "./terminal-colors.js";
import { typedText } from "./terminal-input.js";

const XTERM_SCRIPTS = ["/vendor/xterm/xterm.js", "/vendor/xterm/addon-fit.js"];
const NONCE = document.querySelector('meta[name="csp-nonce"]')?.getAttribute("content") ?? "";
// Dark background, light text: the colors of a terminal.
const THEME = {
  background: "#1d1f23",
  foreground: "#e4e6eb",
  cursor: "#e4e6eb",
  selectionBackground: "#3b4048",
};

/** @type {Promise<void> | undefined} */
let xtermLoading;

/** Loads xterm.js only once. Its <style> tags get the page's CSP nonce. */
function loadXterm() {
  xtermLoading ??= (async () => {
    const create = Document.prototype.createElement;
    // @ts-ignore -- same signature as the original
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
        script.addEventListener("error", () => reject(new Error(t("Loading failed: {src}", { src }))));
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
 *   pending: string, sending: boolean, recolor: ReturnType<typeof createRecolor>, code?: number, stopping?: boolean}} Entry
 */

/**
 * @param {string} d SVG path (24×24, stroked)
 */
function icon(d) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  svg.append(path);
  return svg;
}

// Terminal window with a prompt, and the circular arrow of the Reopen button.
const TERMINAL_ICON = "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM6 9l3 3-3 3M12 15h5";
const REOPEN_ICON = "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5";

/**
 * @param {HTMLElement} root
 * @param {TerminalViewDeps} deps
 */
export function mountTerminalView(root, deps) {
  const { api, el } = deps;
  /** @type {Set<string>} agents whose Claude Code runs in a terminal */
  const running = new Set();
  /** @type {Map<string, Entry>} */
  const entries = new Map();
  /** @type {any} agent shown (null: tab hidden) */
  let shown = null;

  const status = el("span", "terminal-status muted small");
  const stop = /** @type {HTMLButtonElement} */ (el("button", "terminal-stop", t("Close Claude Code")));
  stop.type = "button";
  // Reminder of the copy-paste shortcuts (and confirmation of a copy).
  const HINT = t("Drag selects · Ctrl+C copies · Ctrl+V pastes");
  const hint = el("span", "terminal-hint muted small", HINT);
  const bar = el("div", "terminal-bar");
  bar.append(status, hint, stop);
  const intro = el("div", "terminal-intro");
  const introText = el("p", "muted");
  const start = /** @type {HTMLButtonElement} */ (el("button", "primary", t("Open Claude Code")));
  start.type = "button";
  const error = el("p", "form-error");
  error.hidden = true;
  intro.append(el("h3", "", t("Claude Code in a terminal")), introText, start, error);
  // Claude Code stopped: a card over its last screen, to reopen it (or look at what it printed).
  const closed = el("div", "terminal-closed");
  closed.setAttribute("role", "status");
  const closedIcon = el("div", "terminal-closed-icon");
  closedIcon.append(icon(TERMINAL_ICON));
  const closedDetail = el("p", "terminal-closed-detail muted small");
  const reopen = /** @type {HTMLButtonElement} */ (el("button", "primary terminal-reopen"));
  reopen.type = "button";
  reopen.append(icon(REOPEN_ICON), t("Reopen Claude Code"));
  const peekButton = /** @type {HTMLButtonElement} */ (el("button", "terminal-peek", t("See the last output")));
  peekButton.type = "button";
  const closedActions = el("div", "terminal-closed-actions");
  closedActions.append(reopen, peekButton);
  closed.append(closedIcon, el("h3", "", t("Claude Code is closed.")), closedDetail, closedActions);
  // While reading the last output: Reopen moves to the bar.
  const reopenBar = /** @type {HTMLButtonElement} */ (el("button", "terminal-reopen-bar"));
  reopenBar.type = "button";
  reopenBar.append(icon(REOPEN_ICON), t("Reopen"));
  bar.insertBefore(reopenBar, stop);
  /** @type {Set<string>} agents whose closed card is set aside to read the last output */
  const peeking = new Set();
  const screens = el("div", "terminal-screens");
  screens.append(closed);
  root.append(bar, intro, screens);

  /** @param {unknown} err */
  const showError = (err) => {
    error.textContent = err instanceof Error ? err.message : String(err);
    error.hidden = false;
  };

  /**
   * The agent's xterm terminal (created when needed, at the size of the area).
   *
   * @param {string} id
   */
  async function entryFor(id) {
    const existing = entries.get(id);
    if (existing) return existing;
    await loadXterm();
    // xterm.js copies its exports onto window (window.Terminal is the class); the addon goes there under FitAddon.
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
      macOptionClickForcesSelection: true, // macOS: Option + drag selects (see FORCE_SELECTION_KEY)
    });
    const fit = new fitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(host);
    /** @type {Entry} */
    const entry = { term, fit, host, seq: 0, ready: false, early: [], pending: "", sending: false, recolor: createRecolor() };
    entries.set(id, entry);
    term.onData((/** @type {string} */ data) => sendInput(id, entry, data));
    // Copy-paste, as in a terminal. Ctrl+C copies the selection if there is one (without a selection, it
    // interrupts Claude Code); Ctrl+Shift+C always copies. Ctrl+V and Ctrl+Shift+V let the browser paste:
    // xterm.js gets the paste event and sends the text.
    // Shift+Enter: new line in the message. xterm.js would send \r like Enter (send); we send
    // Esc+Enter, which Claude Code reads as a line break.
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
      return key !== "v"; // false: xterm.js does not send ^V, the browser pastes
    });
    // Mouse selection. Claude Code, full screen, captures the mouse: a drag would be sent to it.
    // xterm.js reserves Shift + drag (Option + drag on macOS) for selection; we invert it: a plain
    // drag selects, and Shift + drag goes to Claude Code. Double-click (word) and triple-click (line) follow.
    host.addEventListener("mousedown", (event) => {
      if (!event.isTrusted || event.button !== 0 || event.ctrlKey || event.altKey || event.metaKey) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      term.focus();
      selecting = !event.shiftKey; // the drag that follows (moves, release) is forwarded as a forced selection
      event.target?.dispatchEvent(forcingSelection(event, !event.shiftKey));
    }, true);
    // Copy requested by Claude Code itself (OSC 52 sequence, e.g. /copy): to the clipboard.
    // Only writing is supported, never reading the clipboard by the program.
    term.parser.registerOscHandler(52, (/** @type {string} */ data) => {
      const encoded = data.slice(data.indexOf(";") + 1);
      if (!encoded || encoded === "?") return true;
      try {
        const text = new TextDecoder().decode(Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)));
        navigator.clipboard.writeText(text).then(() => flash(t("Copied by Claude Code")), () => flash(t("Copy refused by the browser")));
      } catch {
        // Unreadable content: ignored.
      }
      return true;
    });
    // Clipboard without text (a copied image): Claude Code reads it itself on ^V, as in a terminal.
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
  /** Selection drag in progress (see entryFor): its moves and its release go through with Shift. */
  let selecting = false;

  /** Key that makes xterm.js select even when the program captures the mouse: Option on macOS
   * (with macOptionClickForcesSelection, same platform test as xterm.js), Shift elsewhere. */
  const FORCE_SELECTION_KEY = /Mac/.test(navigator.platform) ? "altKey" : "shiftKey";

  /**
   * Copy of a mouse event, with or without the key that forces a selection in xterm.js.
   *
   * @param {MouseEvent} event
   * @param {boolean} force
   */
  const forcingSelection = (event, force) => new MouseEvent(event.type, {
    bubbles: true, cancelable: true, view: window, detail: event.detail, button: event.button, buttons: event.buttons,
    clientX: event.clientX, clientY: event.clientY, screenX: event.screenX, screenY: event.screenY,
    [FORCE_SELECTION_KEY]: force,
  });
  // During a selection drag, xterm.js must only see "forced" events: otherwise Claude Code
  // receives the release, which counts as input and clears the selection.
  for (const type of ["mousemove", "mouseup"]) {
    document.addEventListener(type, (event) => {
      if (!selecting || !event.isTrusted) return;
      if (type === "mouseup") selecting = false;
      event.stopImmediatePropagation();
      (event.target ?? document).dispatchEvent(forcingSelection(event, true));
    }, true);
  }

  /**
   * Copies the terminal selection to the clipboard, and says so in the terminal bar.
   *
   * @param {any} term
   */
  async function copySelection(term) {
    const text = term.getSelection();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      term.clearSelection();
      flash(t("Selection copied"));
    } catch {
      flash(t("Copy refused by the browser"));
    }
  }

  /**
   * Passing message in place of the shortcuts reminder.
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
   * Typed keys: sent in order, grouped while a send is in progress.
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
   * Redraws the screen: recent output kept by the server, then what arrived in the meantime.
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
    // Same size: the server still asks Claude Code to redraw the whole screen.
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

  /** @param {boolean} [focus] give the keyboard to the terminal (arriving on the tab or on the agent) */
  function render(focus = false) {
    const c = shown;
    const id = c?.id;
    const isRunning = Boolean(id && running.has(id));
    const entry = id ? entries.get(id) : undefined;
    for (const [key, other] of entries) other.host.hidden = key !== id;
    const isClosed = Boolean(!isRunning && entry);
    const peek = Boolean(isClosed && id && peeking.has(id));
    bar.hidden = !isRunning && !entry;
    intro.hidden = isRunning || isClosed;
    stop.hidden = !isRunning;
    closed.hidden = !isClosed || peek;
    reopenBar.hidden = !peek;
    screens.classList.toggle("is-closed", isClosed && !peek);
    // The error goes under the button that was clicked.
    (isClosed ? closed : intro).append(error);
    if (isClosed && entry) {
      // The exit code only when it stopped by itself (closed from here, the code is the hangup's).
      const folder = c.cwd.split("/").filter(Boolean).pop() || c.cwd;
      closedDetail.textContent = typeof entry.code === "number" && entry.code !== 0 && !entry.stopping
        ? t("It stopped with code {code}, in {folder}.", { code: entry.code, folder })
        : t("It stopped, in {folder}.", { folder });
      closedDetail.title = c.cwd;
    }
    status.textContent = isRunning
      ? `Claude Code · ${c.cwd}`
      : entry ? t("Claude Code is closed.") : "";
    if (!isRunning && c) {
      introText.textContent = c.sessionId || c.resumeFrom
        ? t("Opens Claude Code in {folder}, on this agent's session. All its commands work there (/model, plan mode…). Closing this browser tab does not stop it.", { folder: c.cwd })
        : t("Opens Claude Code in {folder}. All its commands work there (/model, plan mode…). Closing this browser tab does not stop it.", { folder: c.cwd });
    }
    if (isRunning && entry) {
      entry.fit.fit();
      if (focus) entry.term.focus();
    }
  }

  /** Opens Claude Code for the agent shown. */
  async function startClaude() {
    const c = shown;
    if (!c || running.has(c.id) || start.disabled) return;
    start.disabled = reopen.disabled = reopenBar.disabled = true;
    error.hidden = true;
    peeking.delete(c.id);
    try {
      const entry = await entryFor(c.id);
      entry.host.hidden = false;
      entry.fit.fit();
      entry.ready = false;
      entry.stopping = false;
      const snapshot = await api(`/api/conversations/${c.id}/terminal-start`, { cols: entry.term.cols, rows: entry.term.rows });
      running.add(c.id);
      replay(c.id, entry, snapshot);
    } catch (err) {
      showError(err);
    } finally {
      start.disabled = reopen.disabled = reopenBar.disabled = false;
      render(true);
    }
  }
  start.addEventListener("click", startClaude);
  reopen.addEventListener("click", startClaude);
  reopenBar.addEventListener("click", startClaude);
  peekButton.addEventListener("click", () => {
    if (!shown) return;
    peeking.add(shown.id);
    render();
    entries.get(shown.id)?.term.scrollToBottom();
  });

  stop.addEventListener("click", () => {
    if (!shown) return;
    const entry = entries.get(shown.id);
    if (entry) entry.stopping = true;
    api(`/api/conversations/${shown.id}/terminal-stop`, {}).catch(showError);
  });

  /**
   * Shows an agent's terminal (visible tab); if it is already running, its screen is redrawn.
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
    // For the shortcuts: their button in the bar, their panel on the screen, and the bar's short message.
    bar,
    stopButton: stop,
    screens,
    flash,
    /**
     * Shows the agent and opens its Claude Code right away (new agent).
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
    /** @param {string[]} ids open terminals (initial state from the server) */
    setRunning(ids) {
      running.clear();
      for (const id of ids) running.add(id);
    },
    /** @param {string} id */
    isRunning: (id) => running.has(id),
    /**
     * Types a message into the agent's Claude Code then sends it (Enter), as on the keyboard.
     *
     * @param {any} conversation
     * @param {string} text
     */
    async type(conversation, text) {
      const id = conversation.id;
      if (!running.has(id)) throw new Error(t("Claude Code is not open in the Terminal."));
      const entry = await entryFor(id);
      sendInput(id, entry, typedText(text));
      // Enter on its own: arriving with the text, Claude Code would take it as a paste (a line break).
      await new Promise((resolve) => setTimeout(resolve, 150));
      sendInput(id, entry, "\r");
      if (shown?.id === id) entry.term.focus();
    },
    /** @param {{conversation: string, seq: number, data: string}} chunk */
    onData(chunk) {
      const entry = entries.get(chunk.conversation);
      if (!entry) return; // never shown here: the screen will be redrawn on opening
      if (!entry.ready) entry.early.push(chunk);
      else if (chunk.seq > entry.seq) write(entry, chunk);
    },
    /** @param {{conversation: string, running: boolean, code?: number}} event */
    onStatus(event) {
      if (event.running) running.add(event.conversation);
      else {
        running.delete(event.conversation);
        peeking.delete(event.conversation);
        const entry = entries.get(event.conversation);
        if (entry) {
          entry.ready = false;
          entry.code = event.code;
          const line = typeof event.code === "number" ? t("Claude Code closed · code {code}", { code: event.code }) : t("Claude Code closed");
          entry.term.write(`\r\n\x1b[2m[${line}]\x1b[0m\r\n`);
        }
      }
      if (shown?.id !== event.conversation) return;
      if (event.running) open(shown); // opened from another browser tab
      else render();
    },
    /** Refreshes the tab (agent state changed). */
    refresh() {
      if (shown) render();
    },
  };
}

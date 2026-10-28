// @ts-check
// Discussion tab: the agent's conversation, formatted (what you write goes to the Terminal).
// Re-read from the Claude Code session while the tab is shown; the server only sends it back if it has
// changed. At the bottom, an input box: the message sent is typed into the Terminal, which we switch to. Two views: "All" (messages and replies), "My messages" (only what you sent,
// each reply unfolds on demand). Two floating buttons, bottom right against the messages:
// fold / unfold, and go to top / bottom. No content goes through innerHTML.

import { buildTurns, replyText, sentText, toolNames, toolSummary, turnMarkdown } from "./discussion-logic.js";
import { createDropdown } from "./dropdown.js";
import { locale, t, tn } from "./i18n.js";

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
 * @property {(conversation: any) => string} [agentName] displayed name of the agent (PDF title)
 * @property {(conversation: any) => boolean} isRunning is Claude Code open in the Terminal?
 * @property {(conversation: any, text: string) => Promise<void>} send types the message into the Terminal
 */

const ICONS = {
  // Fold: keep only my messages; unfold: the whole discussion.
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

/** @param {string} d SVG path (24×24, stroked) */
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
  return date.toLocaleString(locale(), sameDay ? { hour: "2-digit", minute: "2-digit" } : { dateStyle: "short", timeStyle: "short" });
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
  /** @type {any} agent shown (null: tab hidden) */
  let shown = null;
  /** @type {string | null} */
  let session = null;
  /** @type {string | null} agent of the loaded discussion (kept when switching tabs) */
  let loadedFor = null;
  /** @type {string | null} fingerprint of the last version received */
  let signature = null;
  /** @type {any} */
  let transcript = null;
  /** @type {number | undefined} */
  let timer;
  let loading = false;
  // Menu of a message (copy, PDF): placed on the page, it survives re-reads of the discussion.
  const dropdown = createDropdown({ el, icon });
  /** @type {string | null} exchange whose menu is open */
  let menuTurn = null;
  // Summary in the bar; a short message (copied, PDF…) replaces it for a moment.
  let summaryText = "";
  /** @type {number | undefined} */
  let flashTimer;
  // What you unfolded or folded: kept from one re-read to the next.
  const openTurns = new Set();
  const toggled = new Map(); // id of a foldable block → open?

  // Bar: the summary of the discussion.
  const bar = el("div", "discussion-bar");
  const summary = el("span", "discussion-summary muted small");
  bar.append(summary);
  const log = el("div", "discussion-log");
  log.setAttribute("aria-live", "polite");

  // Floating buttons: fold / unfold, then go to top / bottom (depending on where we are).
  const fabs = el("div", "discussion-fabs");
  const foldButton = el("button", "fab discussion-fold");
  foldButton.type = "button";
  foldButton.addEventListener("click", () => setMode(mode === "mine" ? "all" : "mine"));
  const scrollButton = el("button", "fab discussion-scroll");
  scrollButton.type = "button";
  scrollButton.addEventListener("click", () => {
    // Direct jump: an animation would be slow on a long discussion.
    log.scrollTop = atBottom() ? 0 : log.scrollHeight;
    renderFabs();
  });
  fabs.append(foldButton, scrollButton);
  // The floating buttons stay against the messages, above the input box.
  const main = el("div", "discussion-main");
  main.append(log, fabs);

  // Input box: Enter sends, Shift+Enter adds a line (as in the Terminal). One draft per agent.
  /** @type {Map<string, string>} */
  const drafts = new Map();
  const composer = /** @type {HTMLFormElement} */ (el("form", "discussion-composer"));
  const input = /** @type {HTMLTextAreaElement} */ (el("textarea"));
  input.rows = 1;
  input.setAttribute("aria-label", t("Message to the agent"));
  // Console mode ("!!" at the start): the input becomes a shell command, run in the agent's folder.
  const shellBadge = el("span", "shell-badge", "$");
  shellBadge.title = t("Console mode: the input is a shell command (Esc to go back to the agent)");
  shellBadge.hidden = true;
  const sendButton = /** @type {HTMLButtonElement} */ (el("button", "discussion-send"));
  sendButton.type = "submit";
  sendButton.title = t("Send to the Terminal (Enter)");
  sendButton.setAttribute("aria-label", t("Send to the Terminal"));
  sendButton.append(icon(ICONS.send));
  composer.append(shellBadge, input, sendButton);
  root.append(bar, main, composer);

  /** The box grows with the message, up to about ten lines. */
  function fitInput() {
    input.style.height = "auto";
    const border = input.offsetHeight - input.clientHeight;
    input.style.height = `${Math.min(input.scrollHeight + border, 220)}px`;
  }

  /**
   * A message goes to the Terminal: Claude Code must be open there. Console mode does not need Claude:
   * so input always stays possible ("!!" to switch to it).
   */
  function renderComposer() {
    const running = Boolean(shown && deps.isRunning(shown));
    composer.classList.toggle("shell-mode", shellMode);
    shellBadge.hidden = !shellMode;
    input.disabled = !shown;
    input.setAttribute("aria-label", shellMode ? t("Shell command") : t("Message to the agent"));
    input.placeholder = shellMode
      ? (shown?.cwd
        ? t("Shell command in {folder} (Enter runs, Esc goes back to the agent)", { folder: shown.cwd })
        : t("Shell command in the agent's folder (Enter runs, Esc goes back to the agent)"))
      : running
        ? t("Write to the agent… (Enter sends to the Terminal, Shift+Enter: new line, !!: shell command)")
        : t("Open Claude Code in the Terminal tab to write to the agent, or type !! for a shell command.");
    sendButton.title = shellMode ? t("Run the command (Enter)") : t("Send to the Terminal (Enter)");
    sendButton.setAttribute("aria-label", shellMode ? t("Run the command") : t("Send to the Terminal"));
    sendButton.disabled = !input.value.trim() || (!shellMode && !running);
  }

  // --- console mode: "!! command" runs a shell command in the agent's folder ------------------------
  // The command and its output are shown in the discussion, after the messages; nothing goes to Claude.
  const SHELL_PREFIX = "!!";
  let shellMode = false;
  /** @type {string[]} commands run, for ↑ / ↓ in console mode */
  const shellHistory = [];
  let historyIndex = -1;
  /** @type {Map<string, {node: HTMLElement, body: HTMLElement, status: HTMLElement, stop: HTMLElement}>} */
  const shellRuns = new Map();
  /** @type {Map<string, HTMLElement[]>} command blocks of each agent, kept from one re-read to the next */
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
      flash(t("Command failed: {error}", { error: /** @type {Error} */ (err).message }));
    }
  }

  /**
   * Event of a command: start (console block), output (appended as it comes), end (code, duration).
   *
   * @param {any} data
   */
  function onShell(data) {
    if (data.started) {
      const node = el("div", "entry console");
      const head = el("div", "console-head");
      const status = el("span", "console-status", t("running…"));
      const stop = el("button", "console-stop", t("Stop"));
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
      // Negative code: stopped by a signal (Stop button, timeout).
      const outcome = data.timedOut ? t("timed out (10 min)") : data.code < 0 ? t("stopped") : t("code {code}", { code: data.code });
      const notes = [outcome, `${Number(data.seconds).toLocaleString(locale())} s`];
      if (data.truncated) notes.push(t("output truncated"));
      run.status.textContent = notes.join(" · ");
      run.status.classList.add(data.code === 0 ? "ok" : "failed");
      if (!run.body.textContent) run.body.remove();
    }
    if (stick) log.scrollTop = log.scrollHeight;
  }

  input.addEventListener("input", () => {
    // "!!" at the start switches to console mode (and is not part of the command).
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
    // Console mode: Esc, or Backspace at the very start, goes back to the agent.
    if (shellMode && (event.key === "Escape" || (event.key === "Backspace" && input.selectionStart === 0 && input.selectionEnd === 0))) {
      event.preventDefault();
      event.stopPropagation();
      setShellMode(false);
      return;
    }
    // Console mode: ↑ / ↓ recall the commands already run.
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
      // Tab already hidden (switched to the Terminal) or same agent: the box is cleared; other agent, its draft stays.
      if (!shown || shown.id === conversation.id) input.value = "";
      fitInput();
      renderComposer();
    } catch (err) {
      flash(t("Sending failed: {error}", { error: /** @type {Error} */ (err).message }));
    }
  });

  const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 60;

  /** The floating buttons follow the view and the position in the discussion. */
  function renderFabs() {
    const mine = mode === "mine";
    const foldLabel = mine ? t("Show the whole discussion") : t("Show only my messages");
    foldButton.replaceChildren(icon(mine ? ICONS.expand : ICONS.collapse));
    foldButton.title = foldLabel;
    foldButton.setAttribute("aria-label", foldLabel);
    foldButton.setAttribute("aria-pressed", String(mine));
    const scrollable = log.scrollHeight > log.clientHeight + 10;
    scrollButton.hidden = !scrollable;
    const down = !atBottom();
    const scrollLabel = down ? t("Go to the bottom of the discussion") : t("Go to the top of the discussion");
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
      // Storage unavailable: the choice applies to this tab only.
    }
    root.classList.toggle("mine-only", mode === "mine");
    if (mode === "all") openTurns.clear();
    render(true);
  }
  root.classList.toggle("mine-only", mode === "mine");

  /**
   * Foldable block whose state survives re-reads.
   *
   * @param {string} key
   * @param {string} className
   * @param {Node[]} head
   * @param {() => Node[]} body built on opening only (long outputs)
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
      row.append(foldable(`result:${tool.id}`, "tool-result", [el("span", "", tool.isError ? t("Error") : t("Result"))],
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
        el("span", "tool-group-count", tn(count, "{n} action", "{n} actions")),
        el("span", "tool-group-names", toolNames(item.tools)),
      ];
      if (failed) head.push(el("span", "tool-group-failed", t("error")));
      return foldable(`${prefix}tools:${item.id}`, "tool-group", head, () => {
        const list = el("ol", "tool-list");
        list.append(...item.tools.map(toolRow));
        return [list];
      });
    }
    if (item.kind === "subagent") {
      const sub = transcript?.subagents?.[item.id];
      const description = item.input?.description || sub?.description || t("Subagent");
      const head = [el("span", "subagent-label", t("Subagent")), el("span", "subagent-description", description)];
      const type = item.input?.subagent_type || sub?.type;
      if (type) head.push(el("span", "subagent-type", type));
      return foldable(`${prefix}agent:${item.id}`, "reply-subagent", head, () => {
        if (!sub) return [el("p", "muted small", t("Its work is not recorded yet."))];
        // Its work: everything but its instructions (the first message), already summarized in the title.
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
        // "My messages": the reply unfolds under the message.
        const toggle = el("button", "link-button turn-toggle", open ? t("Hide the reply") : t("Show the reply"));
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
        sent.append(foldable(`shared:${turn.id}`, "turn-shared", [el("span", "", t("Context shared with the agent"))],
          () => [el("div", "turn-shared-body", turn.sent?.shared ?? "")]));
      }
      article.append(sent);
    }
    const reply = el("div", "turn-reply");
    reply.append(...turn.items.map((item) => itemNode(item, `${turn.id}/`)));
    article.append(reply);
    return article;
  }

  /** @param {boolean} toBottom go to the bottom (view change, first read) */
  function render(toBottom) {
    const stick = toBottom || log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    const scroll = log.scrollTop;
    if (!shown) return;
    renderFabs(); // their icons, even when the discussion is still empty
    const consoleBlocks = shellBlocks.get(shown.id) ?? [];
    if (!session) {
      log.replaceChildren(el("p", "discussion-empty muted", t("No discussion yet: write to Claude Code in the Terminal tab.")),
        ...consoleBlocks);
      summary.textContent = "";
      return;
    }
    if (!transcript) {
      log.replaceChildren(el("p", "discussion-empty muted", t("Loading the discussion…")));
      return;
    }
    const turns = buildTurns(transcript.messages);
    const sentCount = turns.filter((turn) => turn.sent).length;
    const cost = typeof transcript.costUsd === "number"
      ? ` · ${transcript.costUsd.toLocaleString(locale(), { style: "currency", currency: "USD" })}`
      : "";
    summaryText = `${tn(sentCount, "{n} message sent", "{n} messages sent")}${cost}`;
    if (flashTimer === undefined) summary.textContent = summaryText;
    const nodes = turns.map(turnNode);
    if (transcript.truncated) nodes.unshift(el("p", "discussion-empty muted small", t("Only the last 500 messages are shown.")));
    if (!turns.length) nodes.push(el("p", "discussion-empty muted", t("No message in this session yet.")));
    // Commands run in console mode: after the messages (same blocks, the output keeps coming).
    log.replaceChildren(...nodes, ...consoleBlocks);
    log.scrollTop = stick ? log.scrollHeight : scroll;
    renderFabs();
    // Open menu: it follows the redrawn button of its message.
    if (menuTurn) {
      const button = [...log.querySelectorAll(".turn-options")].find((node) => node.closest("article")?.dataset.turn === menuTurn);
      dropdown.reanchor(/** @type {HTMLElement | null} */ (button ?? null));
      if (!button) menuTurn = null;
    }
  }

  /**
   * "⋯" button of a message: copy or export to PDF the question and the answer, or the answer alone.
   *
   * @param {Turn} turn
   */
  function optionsButton(turn) {
    const button = el("button", "turn-options");
    /** @type {HTMLButtonElement} */ (button).type = "button";
    button.title = t("Message options");
    button.setAttribute("aria-label", t("Message options"));
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", "false");
    button.append(icon(ICONS.more));
    const hasReply = Boolean(replyText(turn));
    button.addEventListener("click", () => {
      menuTurn = menuTurn === turn.id ? null : turn.id;
      dropdown.toggle(button, [
        { label: t("Copy the question and the answer"), icon: ICONS.copy, onSelect: () => copyTurn(turn, true, button) },
        { label: t("Copy the answer"), icon: ICONS.copy, disabled: !hasReply, onSelect: () => copyTurn(turn, false, button) },
        "separator",
        { label: t("PDF: question and answer"), icon: ICONS.pdf, onSelect: () => exportPdf(turn, true) },
        { label: t("PDF: answer only"), icon: ICONS.pdf, disabled: !hasReply, onSelect: () => exportPdf(turn, false) },
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
      flash(withQuestion ? t("Question and answer copied.") : t("Answer copied."));
      button.classList.add("done");
      window.setTimeout(() => button.classList.remove("done"), 1500);
    } catch {
      flash(t("Copy refused by the browser."));
    }
  }

  /** Short message in the discussion bar, in place of the summary. @param {string} text */
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
   * Content of the PDF: the question (text as is) and the answer (rendered Markdown), built without innerHTML.
   *
   * @param {Turn} turn
   * @param {boolean} withQuestion
   */
  function pdfContent(turn, withQuestion) {
    const page = el("div");
    const agent = shown ? deps.agentName?.(shown) ?? shown.label ?? "" : "";
    page.append(el("h1", "", agent || t("Discussion")));
    const when = turn.sent?.timestamp ? new Date(turn.sent.timestamp) : null;
    if (when && !Number.isNaN(when.getTime())) {
      page.append(el("p", "pdf-meta", when.toLocaleString(locale(), { dateStyle: "long", timeStyle: "short" })));
    }
    if (withQuestion && turn.sent) {
      page.append(el("h2", "pdf-section", t("Question")), el("div", "pdf-question", sentText(turn.sent)));
      page.append(el("h2", "pdf-section", t("Answer")));
    }
    const reply = el("div", "markdown");
    const text = replyText(turn);
    if (text) deps.renderMarkdown(text, reply);
    else reply.append(el("p", "", t("No written answer.")));
    page.append(reply);
    return page;
  }

  /**
   * Downloads the exchange as a PDF (made by the server); without Chrome on the machine, print window.
   *
   * @param {Turn} turn
   * @param {boolean} withQuestion
   */
  async function exportPdf(turn, withQuestion) {
    menuTurn = null;
    const content = pdfContent(turn, withQuestion);
    const title = content.querySelector("h1")?.textContent ?? t("Discussion");
    const words = (turn.sent ? sentText(turn.sent) : "").split(/\s+/).slice(0, 6).join(" ");
    const filename = `${withQuestion ? t("question-answer") : t("answer")}${words ? ` ${words}` : ""}`;
    flash(t("Preparing the PDF…"));
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
      flash(t("PDF downloaded."));
    } catch (err) {
      flash(t("PDF failed: {error}", { error: err instanceof Error ? err.message : err }));
    }
  }

  /**
   * Without Chrome on the machine: browser printing ("Save as PDF"), in a hidden frame.
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
      + ".pdf-question{white-space:pre-wrap;background:#f6f1ea;padding:8px}.pdf-section{color:#ea580c}";
    doc.head.append(style);
    doc.body.append(doc.importNode(content, true));
    frame.contentWindow?.print();
    window.setTimeout(() => frame.remove(), 60_000);
    flash(t("Choose \"Save as PDF\" in the print window."));
  }

  /** Re-reads the session if it has changed (otherwise the server answers "unchanged"). */
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
      // Session without history (Claude Code just started): retry on the next round.
      if (!transcript) {
        log.replaceChildren(el("p", "discussion-empty muted", /** @type {any} */ (err).status === 404
          ? t("No discussion yet: write to Claude Code in the Terminal tab.")
          : t("Reading failed: {error}", { error: /** @type {Error} */ (err).message })));
      }
    } finally {
      loading = false;
    }
  }

  return {
    /**
     * Shows an agent's discussion (visible tab) and keeps it up to date.
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
        if (loadedFor !== conversation.id) setShellMode(false); // other agent: back to writing to the agent
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
    /** Claude Code opened or closed in the Terminal: the input box follows. */
    refreshComposer() {
      if (shown) renderComposer();
    },
    /** Shell command run from the input ("shell" event of the server). */
    onShell,
    hide() {
      shown = null;
      clearInterval(timer);
      timer = undefined;
    },
  };
}

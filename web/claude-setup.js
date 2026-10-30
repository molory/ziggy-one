// @ts-check
// Claude Code not ready (not installed, not signed in, or not answering): a full screen over the app.
// The fix is handed to an AI agent: a prompt to copy (with what Ziggy One knows: the problem, its folder,
// the PATH where it looks for `claude`), pasted into Claude or any other agent, then "Check again".
// Motion: Ziggy and Claude Code linked by a cut wire; a small chat plays the fix and the wire heals (CSS loop).
// "Continue without Claude Code" opens a second view: Ziggy One is open source, an AI agent can adapt it to
// another coding agent (a prompt to copy), or go on to the Tasks mode, which works without any agent.
// No content goes through innerHTML: text nodes only.

import { t } from "./i18n.js";

/** @typedef {"missing" | "signed-out" | "error"} ClaudeProblem */

/**
 * What prevents Ziggy One from using Claude Code, or null if it is ready.
 * A cloud provider (Bedrock, Vertex…) has no claude.ai sign-in: it counts as ready.
 *
 * @param {any} account answer of `claude auth status` (server.read_account)
 * @returns {ClaudeProblem | null}
 */
export function claudeProblem(account) {
  if (!account) return null; // not known yet
  if (account.error) return /No such file|not found|ENOENT/i.test(account.error) ? "missing" : "error";
  if (account.loggedIn) return null;
  return account.apiProvider && account.apiProvider !== "firstParty" ? null : "signed-out";
}

/**
 * Prompt for the agent that fixes it (in English, like every text given to the agents).
 *
 * @param {ClaudeProblem} problem
 * @param {any} account
 * @param {{folder?: string, path?: string, platform?: string} | null} server
 */
export function fixPrompt(problem, account, server) {
  const what = {
    missing: "the `claude` command is not found (Claude Code is not installed, or not on Ziggy One's PATH).",
    "signed-out": "Claude Code is installed but not signed in.",
    error: `\`claude auth status\` fails: ${account?.error ?? "unknown error"}`,
  }[problem];
  return [
    "Ziggy One (a local web interface that runs Claude Code) cannot use Claude Code on this computer.",
    "",
    `Problem: ${what}`,
    ...(server?.folder ? [`Ziggy One folder: ${server.folder}`] : []),
    ...(server?.path ? [`Ziggy One looks for \`claude\` on this PATH: ${server.path}`] : []),
    ...(server?.platform ? [`System: ${server.platform}`] : []),
    "",
    "Please fix it:",
    "1. Make sure Claude Code is installed and `claude` is on that PATH (install guide: https://docs.claude.com/en/docs/claude-code/setup). If it is installed elsewhere, link it into a folder of that PATH.",
    "2. Make sure it is signed in: `claude auth status --json` must show \"loggedIn\": true. Otherwise run `claude auth login` (I will finish the sign-in in my browser).",
    "3. Do not change Ziggy One's code or data. When it works, tell me to click \"Check again\" in Ziggy One.",
  ].join("\n");
}

/**
 * Prompt for the agent that adapts Ziggy One to another coding agent.
 *
 * @param {string} agent the agent chosen (may be empty: the agent asks)
 * @param {{folder?: string} | null} server
 */
export function adaptPrompt(agent, server) {
  const name = agent.trim() || "[the coding agent I want: ask me which one]";
  return [
    `Ziggy One${server?.folder ? ` (folder: ${server.folder})` : ""} is a local web interface built around Claude Code`,
    `(the \`claude\` command). I want it to work with another coding agent: ${name}.`,
    "",
    "Please adapt it:",
    "1. Read README.md and docs/GUIDE.md, then the code that starts and talks to Claude Code (terminal.py,",
    "   conversations.py, server.py, ziggy_hook.py, agent_mcp.py), to see what Ziggy One relies on.",
    `2. Before changing anything, give me a short plan: what maps directly to ${name}, what has no equivalent,`,
    "   and what I would lose.",
    "3. Once I agree, implement it without breaking Claude Code support, and run the tests",
    "   (python3 -m unittest discover -s tests, node --test tests/*.test.mjs).",
  ].join("\n");
}

/**
 * @typedef {object} SetupDeps
 * @property {(path: string, body?: object) => Promise<any>} api
 * @property {(tag: string, className?: string, text?: string) => HTMLElement} el
 * @property {(account: any) => void} onAccount new answer of the check (ready or not)
 */

/** @param {SetupDeps} deps */
export function mountClaudeSetup(deps) {
  const { el } = deps;
  const screen = el("section", "setup-screen");
  screen.hidden = true;
  screen.setAttribute("role", "alertdialog");
  screen.setAttribute("aria-modal", "true");
  screen.setAttribute("aria-labelledby", "setup-title");
  document.body.append(screen);
  let dismissed = false;
  /** @type {string} */
  let prompt = "";
  /** @type {{folder?: string, path?: string, platform?: string} | null} */
  let serverInfo = null;

  // Ziggy ── ✂ ── Claude Code: the wire is cut, then heals when the agent answers.
  const link = el("div", "setup-link");
  link.setAttribute("aria-hidden", "true");
  const ziggy = el("span", "setup-node setup-ziggy");
  const logo = /** @type {HTMLImageElement} */ (el("img"));
  logo.src = "/logo.svg";
  logo.alt = "";
  ziggy.append(logo);
  const wire = el("span", "setup-wire");
  wire.append(el("span", "setup-wire-left"), el("span", "setup-wire-right"), el("span", "setup-spark"), el("span", "setup-heal"));
  const claude = el("span", "setup-node setup-claude");
  claude.append(el("span", "setup-claude-mark", ">_"));
  link.append(ziggy, wire, claude);

  const title = el("h1", "setup-title");
  title.id = "setup-title";
  const lead = el("p", "setup-lead", t("Ziggy One needs it to run your agents. Let an AI agent fix it:"));

  // The fix, played in a loop: you paste the prompt, the agent works, then answers.
  const chat = el("div", "setup-chat");
  chat.setAttribute("aria-hidden", "true");
  const you = el("div", "setup-bubble setup-you");
  you.append(el("span", "setup-bubble-text", t("Fix Ziggy One so it can use Claude Code…")));
  const typing = el("div", "setup-bubble setup-agent setup-typing");
  typing.append(el("span"), el("span"), el("span"));
  const done = el("div", "setup-bubble setup-agent setup-done");
  done.append(el("span", "setup-check", "✓"), el("span", "", t("Done. Click “Check again”.")));
  const reply = el("div", "setup-reply");
  reply.append(typing, done);
  chat.append(you, reply);

  const steps = el("ol", "setup-steps");
  for (const text of [t("Copy the prompt"), t("Paste it into Claude or any AI agent"), t("Check again")]) {
    steps.append(el("li", "", text));
  }

  const copy = /** @type {HTMLButtonElement} */ (el("button", "primary", t("Copy the prompt")));
  copy.type = "button";
  const check = /** @type {HTMLButtonElement} */ (el("button", "", t("Check again")));
  check.type = "button";
  const actions = el("div", "setup-actions");
  actions.append(copy, check);
  const status = el("p", "setup-status");
  status.setAttribute("role", "status");
  const hint = el("p", "setup-hint");
  const skip = /** @type {HTMLButtonElement} */ (el("button", "link-button setup-skip", t("Continue without Claude Code")));
  skip.type = "button";
  skip.title = t("Use another agent, or only the Tasks mode.");

  const card = el("div", "setup-card");
  card.append(link, title, lead, chat, steps, actions, status, hint, skip);
  screen.append(card);

  // Second view: another agent than Claude Code. Ziggy ── ✓ ── an agent of your choice (its mark changes).
  const otherLink = el("div", "setup-link setup-other-link");
  otherLink.setAttribute("aria-hidden", "true");
  const otherZiggy = /** @type {HTMLElement} */ (ziggy.cloneNode(true));
  const otherWire = el("span", "setup-wire setup-wire-live");
  otherWire.append(el("span", "setup-pulse"));
  const any = el("span", "setup-node setup-any");
  for (const mark of [">_", "</>", "AI", "?"]) any.append(el("span", "setup-any-mark", mark));
  otherLink.append(otherZiggy, otherWire, any);
  const otherTitle = el("h1", "setup-title", t("Use another agent"));
  otherTitle.id = "setup-other-title";
  const otherLead = el("p", "setup-lead",
    t("Ziggy One is built for Claude Code, but it is open source: ask an AI agent to adapt it to the agent of your choice."));
  const agentInput = /** @type {HTMLInputElement} */ (el("input", "text-input setup-agent-input"));
  Object.assign(agentInput, { placeholder: t("Your agent (e.g. Codex, Gemini CLI, Aider…)"), maxLength: 60, autocomplete: "off" });
  agentInput.setAttribute("aria-label", t("Your agent"));
  const otherCopy = /** @type {HTMLButtonElement} */ (el("button", "primary", t("Copy the prompt")));
  otherCopy.type = "button";
  const tasks = /** @type {HTMLButtonElement} */ (el("button", "", t("Continue to Tasks")));
  tasks.type = "button";
  tasks.title = t("The Tasks mode works without any agent.");
  const otherActions = el("div", "setup-actions");
  otherActions.append(otherCopy, tasks);
  const back = /** @type {HTMLButtonElement} */ (el("button", "link-button setup-skip", t("← Back to Claude Code")));
  back.type = "button";
  const otherCard = el("div", "setup-card");
  otherCard.hidden = true;
  otherCard.append(otherLink, otherTitle, otherLead, agentInput, otherActions, back);
  screen.append(otherCard);

  /** @param {boolean} other */
  const showView = (other) => {
    card.hidden = other;
    otherCard.hidden = !other;
    screen.setAttribute("aria-labelledby", other ? "setup-other-title" : "setup-title");
    if (other) agentInput.focus();
  };

  /**
   * @param {HTMLButtonElement} button
   * @param {() => string} text
   */
  const copier = (button, text) => {
    /** @type {number | undefined} */
    let timer;
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(text());
        button.textContent = t("Copied — paste it into your agent");
      } catch {
        button.textContent = t("Copy blocked");
      }
      clearTimeout(timer);
      timer = window.setTimeout(() => (button.textContent = t("Copy the prompt")), 2500);
    });
  };
  copier(copy, () => prompt);
  copier(otherCopy, () => adaptPrompt(agentInput.value, serverInfo));
  check.addEventListener("click", async () => {
    check.disabled = true;
    status.textContent = t("Checking…");
    status.className = "setup-status";
    try {
      const account = await deps.api("/api/account/check", {});
      if (claudeProblem(account)) {
        deps.onAccount(account); // the problem may have changed (installed, still signed out)
        status.textContent = t("Still not ready.");
        status.className = "setup-status bad";
      } else {
        screen.classList.add("ready"); // the wire heals for good, then the screen goes away
        status.textContent = t("Claude Code is ready.");
        status.className = "setup-status good";
        await new Promise((resolve) => setTimeout(resolve, 1200));
        screen.classList.remove("ready");
        status.textContent = "";
        deps.onAccount(account);
      }
    } catch (err) {
      status.textContent = err instanceof Error ? err.message : String(err);
      status.className = "setup-status bad";
    } finally {
      check.disabled = false;
    }
  });
  skip.addEventListener("click", () => showView(true));
  back.addEventListener("click", () => showView(false));
  tasks.addEventListener("click", () => {
    dismissed = true;
    screen.hidden = true;
    location.hash = "#tasks";
  });

  return {
    /**
     * Shows the screen if Claude Code is not ready, hides it otherwise.
     *
     * @param {any} account
     * @param {{folder?: string, path?: string, platform?: string} | null} server
     */
    update(account, server) {
      const problem = claudeProblem(account);
      if (!problem) {
        screen.hidden = true;
        return;
      }
      prompt = fixPrompt(problem, account, server);
      serverInfo = server;
      title.textContent = { missing: t("Claude Code is not installed"), "signed-out": t("Claude Code is not signed in"),
        error: t("Claude Code is not answering") }[problem];
      // One sentence per language (word order differs), the command set in it as code.
      const sentence = problem === "missing" ? t("Or yourself: install Claude Code, then run {command} in a terminal.")
        : t("Or yourself: run {command} in a terminal.");
      const [before, after = ""] = sentence.split("{command}");
      hint.replaceChildren(before, el("code", "", problem === "missing" ? "claude" : "claude auth login"), after);
      if (!dismissed) screen.hidden = false;
    },
  };
}

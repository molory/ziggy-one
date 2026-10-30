// @ts-check
// Claude Code not ready (not installed, not signed in, or not answering): a full screen over the app.
// The fix is handed to an AI agent: a prompt to copy (with what Ziggy One knows: the problem, its folder,
// the PATH where it looks for `claude`), pasted into Claude or any other agent, then "Check again".
// Motion: Ziggy and Claude Code linked by a cut wire; a small chat plays the fix and the wire heals (CSS loop).
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
  skip.title = t("The Tasks mode works without it; agents will not start.");

  const card = el("div", "setup-card");
  card.append(link, title, lead, chat, steps, actions, status, hint, skip);
  screen.append(card);

  /** @type {number | undefined} */
  let copyTimer;
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      copy.textContent = t("Copied — paste it into your agent");
    } catch {
      copy.textContent = t("Copy blocked");
    }
    clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => (copy.textContent = t("Copy the prompt")), 2500);
  });
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
  skip.addEventListener("click", () => {
    dismissed = true;
    screen.hidden = true;
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
      title.textContent = { missing: t("Claude Code is not installed"), "signed-out": t("Claude Code is not signed in"),
        error: t("Claude Code is not answering") }[problem];
      hint.replaceChildren(document.createTextNode(problem === "missing"
        ? t("Or yourself: install Claude Code, then run ") : t("Or yourself: run ")),
      el("code", "", problem === "missing" ? "claude" : "claude auth login"),
      document.createTextNode(t(" in a terminal.")));
      if (!dismissed) screen.hidden = false;
    },
  };
}

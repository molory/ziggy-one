// @ts-check
// All content coming from Claude is inserted via textContent, never via innerHTML.

import { createAvatarEditor } from "./avatar-editor.js";
import { abbrSuggestions, animalOf, avatarLook, fillAvatar } from "./avatars.js";
import { uniqueName } from "./agent-names.js";
import { createHero } from "./hero.js";
import { formatBytes, formatSince, isIdle, sortTerminals } from "./terminals-logic.js";
import { mountFilesView } from "./files-view.js";
import { mountDiscussionView } from "./discussion-view.js";
import { mountKanban } from "./kanban.js";
import { ticketNumberFromPath } from "./kanban-logic.js";
import { mountTerminalView } from "./terminal-view.js";
import { agentKeys, emptyShortcuts, panelItems, shortcutLabel } from "./shortcuts-logic.js";
import { mountShortcutsPanel } from "./shortcuts-panel.js";
import { SHORTCUT_ICONS, createShortcutsEditor, mountShortcutsView } from "./shortcuts-view.js";
import { mountGitView } from "./git-view.js";
import { renderMarkdown } from "./markdown.js";
import { LANGUAGES, currentLanguage, locale, t, tn, translateStatic } from "./i18n.js";
import { confirmDialog, dismissDialog, isDialogOpen, onDialogClose } from "./modal.js";
import { migratePins, orderRows, pinIndex, pinnedFirst, rowKeys, togglePin } from "./pins.js";
import { memberKey, pinnedHead, splitByWorkspace, workspacePinKey, workspaceState } from "./workspaces.js";

// Static markup of index.html, written in English: translated once, before anything else is drawn.
translateStatic(document.documentElement);
/** Global settings (Configuration › General). @type {{language: string}} */
let globalSettings = { language: currentLanguage() };

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

const WINDOW_LABELS = {
  five_hour: t("Current session (5h)"),
  seven_day: t("Week, all models (7d)"),
  seven_day_opus: t("Week, Opus"),
  seven_day_sonnet: t("Week, Sonnet"),
};
// Short labels for the top bar.
const WINDOW_SHORT_LABELS = {
  five_hour: t("5h"),
  seven_day: t("7d"),
  seven_day_opus: t("7d Opus"),
  seven_day_sonnet: t("7d Sonnet"),
};

/**
 * @param {string} path
 * @param {object} [body]
 */
async function api(path, body) {
  const init = body === undefined
    ? {}
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) $("auth-error").hidden = false;
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
  return data;
}

/** @type {number | undefined} */
let toastTimer;

/**
 * Transient error at the bottom of the screen (action refused, network…).
 *
 * @param {string} message
 */
function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.hidden = true), 6000);
}

/**
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** @param {number} epochSeconds */
function formatReset(epochSeconds) {
  const date = new Date(epochSeconds * 1000);
  const minutes = Math.max(0, Math.round((date.getTime() - Date.now()) / 60000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const delay = h >= 24
    ? t("{days}d {hours}h", { days: Math.floor(h / 24), hours: h % 24 })
    : h > 0 ? t("{hours}h {minutes}", { hours: h, minutes: String(m).padStart(2, "0") }) : t("{minutes} min", { minutes: m });
  const when = date.toLocaleString(locale(), { weekday: "short", hour: "2-digit", minute: "2-digit" });
  return t("resets in {delay} ({when})", { delay, when });
}

// --- account, usage and preferences: the gauge of the top bar opens the details ---------

const AUTH_LABELS = { "claude.ai": t("claude.ai account"), api_key: t("API key") };
const PLAN_LABELS = { pro: "Pro", max: "Max", team: "Team", enterprise: "Enterprise" };
const STATUS_LABELS = { allowed: t("Within limits"), allowed_warning: t("Close to the limit"), rejected: t("Limit reached") };
const OVERAGE_REASONS = {
  org_level_disabled: t("disabled by the organization"),
  out_of_credits: t("out of credits"),
  overage_not_provisioned: t("not subscribed"),
};

/** @type {any} */
let account = null;
/** @type {any} */
let usage = { windows: {} };
const accountDialog = /** @type {HTMLDialogElement} */ ($("account-dialog"));

/** @param {any} data */
function renderAccount(data) {
  account = data;
  const connected = Boolean(data && !data.error && data.loggedIn);
  const initial = connected ? (data.email || "?").charAt(0).toUpperCase() : "?";
  $("avatar").textContent = initial;
  $("account-avatar").textContent = initial;
  $("account-email").textContent = connected ? data.email || "—" : data?.error || t("Not logged in");
  $("account-sub").textContent = connected
    ? [data.orgName, data.subscriptionType && t("{plan} plan", { plan: PLAN_LABELS[data.subscriptionType] || data.subscriptionType }), AUTH_LABELS[data.authMethod] || data.authMethod]
      .filter(Boolean).join(" · ")
    : "";
  renderUsageButtonLabel();
}

/** @param {string} name */
const windowPercent = (name) => {
  const utilization = usage.windows?.[name]?.utilization;
  return typeof utilization === "number" ? Math.round(utilization * 100) : null;
};
/** @param {number | null} pct */
const usageLevel = (pct) => (pct === null ? "unknown" : pct >= 80 ? "hot" : pct >= 50 ? "warm" : "ok");
const windowNames = () => Object.keys(usage.windows || {}).sort(
  (a, b) => (a in WINDOW_LABELS ? 0 : 1) - (b in WINDOW_LABELS ? 0 : 1),
);

/** @param {any} data */
function renderUsage(data) {
  usage = data || { windows: {} };
  const items = windowNames().map((name) => {
    const pct = windowPercent(name);
    const chip = el("span", `usage-chip level-${usageLevel(pct)}`);
    chip.style.setProperty("--pct", String(Math.min(100, pct ?? 0)));
    const ring = el("span", "usage-ring");
    ring.setAttribute("aria-hidden", "true");
    chip.append(ring, el("span", "usage-label", WINDOW_SHORT_LABELS[name] || name), el("span", "usage-value", pct === null ? "—" : t("{pct}%", { pct })));
    return chip;
  });
  if (items.length === 0) items.push(el("span", "usage-label", t("Unknown usage")));
  const alerts = [];
  if (usage.status === "rejected") alerts.push(t("limit reached"));
  else if (usage.status === "allowed_warning") alerts.push(t("close to the limit"));
  if (usage.isUsingOverage) alerts.push(t("overage"));
  if (alerts.length) items.push(el("span", "usage-alert", alerts.join(" · ")));
  $("usage-windows").replaceChildren(...items);
  renderRailUsage();
  // Collapsed sidebar: only the avatar stays visible, ringed with the color of the 5h usage.
  $("avatar").dataset.level = usageLevel(windowPercent("five_hour"));
  renderUsageButtonLabel();
  if (accountDialog.open) renderAccountDialog();
}

/** Collapsed sidebar: one gauge per usage window, stacked at the bottom of the rail (percentage then window). */
function renderRailUsage() {
  const gauges = windowNames().map((name) => {
    const pct = windowPercent(name);
    const gauge = el("span", `usage-chip rail-gauge level-${usageLevel(pct)}`);
    gauge.style.setProperty("--pct", String(Math.min(100, pct ?? 0)));
    const ring = el("span", "usage-ring");
    ring.setAttribute("aria-hidden", "true");
    gauge.append(ring, el("span", "usage-value", pct === null ? "—" : `${pct}%`), el("span", "usage-label", WINDOW_SHORT_LABELS[name] || name));
    return gauge;
  });
  const rail = $("rail-usage");
  rail.replaceChildren(...gauges);
  rail.hidden = gauges.length === 0;
  rail.classList.toggle("alert", usage.status === "rejected" || usage.status === "allowed_warning" || Boolean(usage.isUsingOverage));
}

function renderUsageButtonLabel() {
  const windows = windowNames().map((name) => t("{label}: {pct}%", { label: WINDOW_LABELS[name] || name, pct: windowPercent(name) ?? "—" }));
  const label = [t("Account and plan usage"), account?.email, ...windows].filter(Boolean).join(" · ");
  for (const button of [$("usage"), $("rail-usage")]) {
    button.title = label;
    button.setAttribute("aria-label", label);
  }
}

/**
 * @param {HTMLElement} list
 * @param {[string, string | null | undefined][]} rows
 */
function fillFacts(list, rows) {
  list.replaceChildren();
  for (const [label, value] of rows) {
    if (value) list.append(el("dt", "", label), el("dd", "", value));
  }
}

/** Content of the dialog: usage bars with their reset, status, then Ziggy One. */
function renderAccountDialog() {
  const bars = windowNames().map((name) => {
    const pct = windowPercent(name);
    const w = usage.windows[name];
    const row = el("div", `usage-bar level-${usageLevel(pct)}`);
    row.style.setProperty("--pct", String(Math.min(100, pct ?? 0)));
    const head = el("div", "usage-bar-head");
    head.append(el("span", "", WINDOW_LABELS[name] || name), el("strong", "", pct === null ? "—" : t("{pct}% used", { pct })));
    const track = el("div", "usage-bar-track");
    track.setAttribute("role", "meter");
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", "100");
    if (pct !== null) track.setAttribute("aria-valuenow", String(pct));
    track.setAttribute("aria-label", WINDOW_LABELS[name] || name);
    track.append(el("span", "usage-bar-fill"));
    row.append(head, track);
    if (w.resetsAt) {
      const reset = formatReset(w.resetsAt);
      row.append(el("span", "muted small", reset.charAt(0).toUpperCase() + reset.slice(1)));
    }
    return row;
  });
  if (bars.length === 0) bars.push(el("p", "muted small", t("Unknown usage: it is read on every Claude reply, or with the Refresh button.")));
  $("usage-bars").replaceChildren(...bars);
  $("usage-updated").textContent = usage.updatedAt
    ? t("updated at {time}", { time: new Date(usage.updatedAt * 1000).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" }) })
    : "";
  const overage = usage.isUsingOverage
    ? t("in use")
    : usage.overageStatus === "rejected" || usage.overageDisabledReason
      ? usage.overageDisabledReason
        ? t("unavailable ({reason})", { reason: OVERAGE_REASONS[usage.overageDisabledReason] || usage.overageDisabledReason })
        : t("unavailable")
      : usage.overageStatus ? t("available") : null;
  fillFacts($("usage-facts"), [
    [t("Status"), STATUS_LABELS[usage.status] || usage.status],
    [t("Extra usage"), overage],
  ]);

  const rows = sessionRows();
  const state = rows.map(agentState);
  const cost = rows.reduce((sum, row) => sum + (typeof row.costUsd === "number" ? row.costUsd : 0), 0);
  const running = [...conversations.values()].filter((c) => terminalView.isRunning(c.id)).length;
  fillFacts($("ziggy-facts"), [
    [t("Active agents"), t("{active} of {total}, {busy} working", {
      active: state.filter((s) => s !== "inactive").length,
      total: rows.length,
      busy: state.filter((s) => s === "busy").length,
    })],
    [t("Open Claude Code terminals"), String(running)],
    [t("Cost of listed agents"), t("${cost} (API equivalent, not billed on a plan)", { cost: cost.toFixed(2) })],
    ["Claude Code", account?.version ? t("version {version}", { version: account.version }) : null],
  ]);
}

/** @type {number | undefined} */
let accountTimer;
$("usage").addEventListener("click", () => {
  renderAccountDialog();
  accountDialog.showModal();
  accountTimer = window.setInterval(renderAccountDialog, 30_000); // countdowns to the resets
});
$("rail-usage").addEventListener("click", () => $("usage").click());
$("open-settings").addEventListener("click", () => {
  accountDialog.close();
  openSettingsPanel();
});
accountDialog.addEventListener("close", () => clearInterval(accountTimer));
$("account-close").addEventListener("click", () => accountDialog.close());
// A click on the backdrop (outside the content) closes the dialog.
accountDialog.addEventListener("click", (event) => {
  if (event.target === accountDialog) accountDialog.close();
});

// Refresh: from the top bar (without opening the dialog) or from the dialog.
const refreshButtons = /** @type {HTMLButtonElement[]} */ ([$("usage-refresh"), $("refresh-usage")]);

async function refreshUsage() {
  for (const button of refreshButtons) {
    button.disabled = true;
    button.classList.add("loading");
  }
  try {
    renderUsage(await api("/api/usage/refresh", {}));
  } catch (err) {
    const message = t("Refresh failed: {error}", { error: err.message });
    $("usage-updated").textContent = message;
    $("usage-refresh").title = message;
  } finally {
    for (const button of refreshButtons) {
      button.disabled = false;
      button.classList.remove("loading");
    }
  }
}
for (const button of refreshButtons) button.addEventListener("click", refreshUsage);

/** @param {string} theme */
function applyTheme(theme) {
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  try {
    if (theme === "light" || theme === "dark") localStorage.setItem("zo-theme", theme);
    else localStorage.removeItem("zo-theme");
  } catch {
    // Storage unavailable: the choice applies to this tab only.
  }
}

const currentTheme = document.documentElement.dataset.theme || "system";
for (const input of /** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll('input[name="theme"]'))) {
  input.checked = input.value === currentTheme;
  input.addEventListener("change", () => applyTheme(input.value));
}

// --- resizable sidebar ------------------------------------------------------------

const SIDEBAR_DEFAULT = 340;
const SIDEBAR_MIN = 240;
const layout = /** @type {HTMLElement} */ (document.querySelector(".layout"));
const resizer = $("sidebar-resizer");

// The central area always keeps at least 480 px.
const sidebarMax = () => Math.max(SIDEBAR_MIN, Math.min(640, window.innerWidth - 480));

/**
 * @param {number} width
 * @param {boolean} [persist]
 */
function setSidebarWidth(width, persist = true) {
  const clamped = Math.round(Math.min(sidebarMax(), Math.max(SIDEBAR_MIN, width)));
  layout.style.setProperty("--sidebar-width", `${clamped}px`);
  resizer.setAttribute("aria-valuemin", String(SIDEBAR_MIN));
  resizer.setAttribute("aria-valuemax", String(sidebarMax()));
  resizer.setAttribute("aria-valuenow", String(clamped));
  if (!persist) return;
  try {
    localStorage.setItem("zo-sidebar-width", String(clamped));
  } catch {
    // Storage unavailable: the width applies to this tab only.
  }
}

const currentSidebarWidth = () => Number(resizer.getAttribute("aria-valuenow")) || SIDEBAR_DEFAULT;

resizer.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  resizer.setPointerCapture(event.pointerId);
  document.body.classList.add("resizing");
  // The sidebar starts at the left edge: its width is the pointer position in the layout.
  const onMove = (/** @type {PointerEvent} */ e) => setSidebarWidth(e.clientX - layout.getBoundingClientRect().left, false);
  resizer.addEventListener("pointermove", onMove);
  resizer.addEventListener("lostpointercapture", () => {
    resizer.removeEventListener("pointermove", onMove);
    document.body.classList.remove("resizing");
    setSidebarWidth(currentSidebarWidth());
  }, { once: true });
});

resizer.addEventListener("dblclick", () => setSidebarWidth(SIDEBAR_DEFAULT));

resizer.addEventListener("keydown", (event) => {
  const step = event.shiftKey ? 64 : 16;
  const keys = {
    ArrowLeft: currentSidebarWidth() - step,
    ArrowRight: currentSidebarWidth() + step,
    Home: SIDEBAR_MIN,
    End: sidebarMax(),
  };
  if (!(event.key in keys)) return;
  event.preventDefault();
  setSidebarWidth(keys[event.key]);
});

// If the window shrinks, narrow the sidebar without overwriting the chosen width.
window.addEventListener("resize", () => {
  let saved = SIDEBAR_DEFAULT;
  try {
    saved = Number(localStorage.getItem("zo-sidebar-width")) || SIDEBAR_DEFAULT;
  } catch {
    saved = currentSidebarWidth();
  }
  setSidebarWidth(saved, false);
});

try {
  setSidebarWidth(Number(localStorage.getItem("zo-sidebar-width")) || SIDEBAR_DEFAULT, false);
} catch {
  setSidebarWidth(SIDEBAR_DEFAULT, false);
}

// --- sidebar collapsed into an avatar rail ---------------------------------------
// Collapsed, the sidebar only shows the avatar column (same layout, cropped): hovered,
// it opens over the content without shifting it, each avatar staying in place.

const SIDEBAR_COLLAPSED_KEY = "zo-sidebar-collapsed";
const PEEK_OPEN_DELAY = 150;
const PEEK_CLOSE_DELAY = 300;
const PEEK_CLOSE_DURATION = 180; // closing animation (peek-close in style.css)
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const sidebar = /** @type {HTMLElement} */ (document.querySelector(".sidebar"));
const sidebarToggle = $("sidebar-toggle");
/** @type {number | undefined} */
let peekTimer;

/** Applies a layout change without animation (loading, sidebar already open on hover). */
function withoutAnimation(/** @type {() => void} */ change) {
  layout.classList.add("instant");
  change();
  requestAnimationFrame(() => requestAnimationFrame(() => layout.classList.remove("instant")));
}

/** @param {boolean} collapsed */
function setSidebarCollapsed(collapsed, persist = true) {
  // Keeping open a sidebar already expanded on hover: it is already in place, nothing to animate.
  const instant = !persist || (!collapsed && layout.classList.contains("peek"));
  clearTimeout(peekTimer);
  const change = () => {
    layout.classList.toggle("collapsed", collapsed);
    layout.classList.remove("peek", "peek-closing");
  };
  if (instant) withoutAnimation(change);
  else change();
  // While the column widens, the content keeps its final width (no text reflowing).
  if (!collapsed && !instant) {
    layout.classList.add("expanding");
    window.setTimeout(() => layout.classList.remove("expanding"), 260);
  }
  sidebarToggle.setAttribute("aria-expanded", String(!collapsed));
  const label = collapsed ? t("Keep the sidebar open (Ctrl+B)") : t("Collapse the sidebar (Ctrl+B)");
  sidebarToggle.title = label;
  sidebarToggle.setAttribute("aria-label", label);
  if (!persist) return;
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // Storage unavailable: the choice applies to this tab only.
  }
}

/**
 * @param {boolean} open
 * @param {number} [delay]
 */
function setPeek(open, delay = 0) {
  clearTimeout(peekTimer);
  const apply = () => {
    if (open) {
      if (layout.classList.contains("collapsed")) layout.classList.remove("peek-closing");
      layout.classList.toggle("peek", layout.classList.contains("collapsed"));
      return;
    }
    if (!layout.classList.contains("peek") || layout.classList.contains("peek-closing")) return;
    if (reducedMotion()) {
      layout.classList.remove("peek");
      return;
    }
    // The sidebar folds back to the rail, then takes its place in the layout again.
    layout.classList.add("peek-closing");
    peekTimer = window.setTimeout(() => layout.classList.remove("peek", "peek-closing"), PEEK_CLOSE_DURATION);
  };
  if (delay) peekTimer = window.setTimeout(apply, delay);
  else apply();
}

/**
 * Key typed in the Claude Code terminal: it is for Claude Code (Ctrl+B, Ctrl+P…), not for Ziggy.
 *
 * @param {KeyboardEvent} event
 */
const inTerminal = (event) => event.target instanceof Element && Boolean(event.target.closest(".terminal-screen"));

sidebarToggle.addEventListener("click", () => setSidebarCollapsed(!layout.classList.contains("collapsed")));
document.addEventListener("keydown", (event) => {
  if (inTerminal(event)) return;
  if (event.key.toLowerCase() === "b" && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
    event.preventDefault();
    setSidebarCollapsed(!layout.classList.contains("collapsed"));
  }
});
sidebar.addEventListener("pointerenter", () => setPeek(true, PEEK_OPEN_DELAY));
sidebar.addEventListener("pointerleave", () => setPeek(false, PEEK_CLOSE_DELAY));
sidebar.addEventListener("focusin", () => setPeek(true));
sidebar.addEventListener("focusout", (event) => {
  if (!sidebar.contains(/** @type {Node | null} */ (event.relatedTarget)) && !sidebar.matches(":hover")) setPeek(false);
});
// Opening an agent, its configuration or the creation closes the panel: make room for the content.
sidebar.addEventListener("click", (event) => {
  const target = /** @type {HTMLElement} */ (event.target);
  if (!layout.classList.contains("peek") || !target.closest(".session-open, .more-button, #new-conversation")) return;
  setPeek(false);
  /** @type {HTMLElement} */ (document.activeElement)?.blur();
});

try {
  setSidebarCollapsed(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1", false);
} catch {
  setSidebarCollapsed(false, false);
}

// --- open agents ------------------------------------------------------------------------------
// An agent open here = a folder and a Claude Code session, used in the Terminal tab.
// The server says whether it is working (Claude Code hooks and its session registry).

/** @type {Map<string, any>} status of each open agent, by id */
const conversations = new Map();
/** @type {string | null} */
let selectedId = null;
let defaultCwd = "";

/** @param {string | null | undefined} sessionId */
const conversationForSession = (sessionId) =>
  sessionId ? [...conversations.values()].find((c) => c.sessionId === sessionId || c.resumeFrom === sessionId) : undefined;

/** @param {string} text @param {number} max */
const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);

function renderHeader() {
  const c = selectedId ? conversations.get(selectedId) : null;
  const row = c ? { sessionId: c.sessionId || c.resumeFrom, conversation: c, cwd: c.cwd } : null;
  const name = row ? displayName(row) : "Agent";
  $("chat-title").textContent = name;
  $("chat-title").title = c?.cwd ?? "";
  const avatar = $("chat-avatar");
  avatar.hidden = !row;
  if (row) {
    avatar.style.setProperty("--agent-hue", String(agentHue(row.sessionId || c.id || name)));
    fillAvatar(avatar, avatarLook(agentAvatar(row), avatarLetter(customName(row), row.cwd, name)));
  }
}

/**
 * Shows an agent: its tabs (Terminal by default), and its Claude Code if already running.
 *
 * @param {string} id
 * @param {{start?: boolean}} [options] start: open Claude Code right away (new agent)
 */
async function selectConversation(id, { start = false } = {}) {
  const conversation = conversations.get(id);
  if (!conversation) return;
  selectedId = id;
  markSeen(id);
  closePanel();
  try {
    localStorage.setItem("zo-selected-conversation", id);
  } catch {
    // Storage unavailable: the selection is not kept on reload.
  }
  if (start) activeTab = "terminal";
  renderHeader();
  renderTabs();
  drawSessions();
  if (start) terminalView.start(conversation);
}

/** Idle state: no agent shown, the "Create" card takes the center. */
function showIdle() {
  selectedId = null;
  try {
    localStorage.removeItem("zo-selected-conversation");
  } catch {
    // Storage unavailable: nothing to forget.
  }
  renderHeader();
  drawSessions();
  openCreatePanel();
}

/** @param {any} status */
function storeConversation(status) {
  conversations.set(status.id, status);
  return status;
}

/**
 * Opens a session: the agent already following it, otherwise a new one (Claude Code opens in the Terminal).
 *
 * @param {string} sessionId
 * @param {string} label
 */
async function openSession(sessionId, label) {
  const existing = conversationForSession(sessionId);
  if (existing) return selectConversation(existing.id);
  try {
    const status = storeConversation(await api("/api/conversations", { resume: sessionId, label }));
    await selectConversation(status.id);
  } catch (err) {
    showToast(t("Could not open: {error}", { error: err.message }));
  }
}

/**
 * Creates an agent and immediately opens Claude Code in its Terminal.
 *
 * @param {string} [cwd] folder it will work in; the server's default otherwise
 * @param {string} [name] name given to the agent
 */
async function newConversation(cwd, name, workspaceId) {
  const status = storeConversation(await api("/api/conversations", cwd ? { cwd } : {}));
  // The server pins a new agent by default: same here, before its "pins" event arrives.
  if (!pins.includes(status.id)) pins = [...pins, status.id];
  if (name?.trim()) setAgentSettings((await api("/api/agents/rename", { agent: status.id, name })).agents);
  if (workspaceId) setWorkspaces((await api(`/api/workspaces/${workspaceId}/add`, { agent: status.id })).workspaces);
  await selectConversation(status.id, { start: true });
  return status.id;
}

// "+": creation card (agent or workspace) in the center.
$("new-conversation").addEventListener("click", () => openCreatePanel());

// --- sessions -------------------------------------------------------------------

/** @type {any[]} */
let allSessions = [];
let sessionFilter = "open";

/** @param {any[]} sessions */
function renderSessions(sessions) {
  allSessions = sessions;
  drawSessions();
}

/**
 * Rows of the list: the sessions, plus the agents open here that are not in it yet (new ones…).
 * Deleted agents are not in it.
 */
function sessionRows() {
  const rows = allSessions.map((s) => ({ ...s, conversation: conversationForSession(s.sessionId) }));
  for (const c of conversations.values()) {
    if (rows.some((row) => row.conversation === c)) continue;
    rows.unshift({
      sessionId: c.sessionId || c.resumeFrom, cwd: c.cwd, git: c.git, lastPrompt: c.label,
      updatedAt: c.lastActivity, costUsd: c.costUsd, conversation: c,
    });
  }
  return rows.filter((row) => !isHidden(row));
}

// Pinned agents: always at the top of the list, in the order they were pinned.
// Pins are saved on the server (pins.json): they survive a restart and apply to all browsers.
// The browser's old pins are taken over once, then forgotten.
const LEGACY_PINS_KEY = "zo-pinned-agents";
/** @type {string[]} */
let pins = [];

/**
 * Server pins, completed with those this browser had kept (only once).
 *
 * @param {string[]} serverPins
 */
function loadPins(serverPins) {
  pins = serverPins;
  /** @type {string[]} */
  let legacy = [];
  try {
    const saved = JSON.parse(localStorage.getItem(LEGACY_PINS_KEY) || "[]");
    if (Array.isArray(saved)) legacy = saved.filter((pin) => typeof pin === "string");
    localStorage.removeItem(LEGACY_PINS_KEY);
  } catch {
    // Storage unavailable: nothing to take over.
  }
  savePins([...serverPins, ...legacy.filter((pin) => !serverPins.includes(pin))]);
}

/** @param {string[]} next */
function savePins(next) {
  if (JSON.stringify(next) === JSON.stringify(pins)) return;
  pins = next;
  api("/api/pins", { pins }).catch((err) => showToast(t("Pins not saved: {error}", { error: err.message })));
}

/** Parameter so that the server returns the pinned agents or those in a workspace, even old ones. */
function includeAgents() {
  const keys = [...new Set([...pins, ...workspaces.flatMap((workspace) => workspace.agents)])];
  return keys.length ? `?include=${encodeURIComponent(keys.join(","))}` : "";
}

function drawSessions() {
  const rows = sessionRows();
  savePins(migratePins(pins, rows));
  const isOpen = (/** @type {any} */ row) => Boolean(row.active || row.conversation);
  $("filter-open").replaceChildren(t("Active"), el("span", "count", String(rows.filter(isOpen).length)));
  $("filter-all").replaceChildren(t("All"), el("span", "count", String(rows.length)));
  const list = $("session-list");
  list.replaceChildren();
  // Order: pinned agents, workspaces (with their agents, whatever the filter), then the other
  // agents, from newest to oldest.
  const { members, rest } = splitByWorkspace(rows, workspaces);
  const { pinned, others: unpinnedRows } = orderRows(rest, pins, (row) => sessionFilter === "all" || isOpen(row));
  const others = pinnedOnly ? [] : unpinnedRows;
  const { head, unpinned } = pinnedHead(pinned, workspaces, pins);
  const block = (/** @type {any} */ workspace) => workspaceItem(workspace, members.get(workspace.id) || []);
  if (head.length === 0 && unpinned.length === 0 && others.length === 0) {
    const empty = pinnedOnly ? t("No pinned agents.") : sessionFilter === "open" ? t("No active agents.") : t("No agents.");
    list.append(el("li", "muted", empty));
  } else {
    // At the top, pinned agents and workspaces, in pin order; then the other workspaces and agents.
    const headItems = head.map((entry) => (entry.kind === "agent" ? sessionItem(entry.row) : block(entry.workspace)));
    headItems.at(-1)?.classList.toggle("pinned-last", unpinned.length + others.length > 0);
    list.append(...headItems, ...unpinned.map(block), ...others.map(sessionItem));
  }
  if (pinnedOnly && unpinnedRows.length) list.append(hiddenAgentsNote(unpinnedRows.length));
  // Access to deleted agents, to restore them.
  const hiddenCount = hiddenAgents().length;
  if (hiddenCount) {
    const entry = el("li", "deleted-entry");
    const link = el("button", "link-button", t("Deleted agents ({count})", { count: hiddenCount }));
    link.type = "button";
    link.addEventListener("click", openDeletedPanel);
    entry.append(link);
    list.append(entry);
  }
}

const AGENT_STATE_LABELS = { waiting: t("waiting for your reply"), busy: t("thinking"), active: t("active"), inactive: t("inactive") };
/** What the agent is waiting for from you (Claude Code Notification hook). */
const WAITING_LABELS = { permission: t("a permission"), question: t("an answer to its question") };

/**
 * State of an agent, shown only by the dot of its avatar:
 * "busy" (twinkling orange) if it is thinking, "active" (green) if it is active, otherwise "inactive" (gray).
 *
 * @param {any} row
 */
function agentState(row) {
  const c = row.conversation;
  // Waiting for your reply (permission, question): comes before everything else, it is your turn.
  if (c?.waiting) return "waiting";
  // Two possible sources for the same agent: its terminal in ziggy-one, and the session
  // open in a terminal (the Claude Code registry says whether it is working).
  const busyHere = Boolean(c?.busy);
  const busyInTerminal = Boolean(row.active && row.status === "busy");
  if (busyHere || busyInTerminal) return "busy";
  // Active = green: open in ziggy-one (Claude Code open or not) or in a terminal.
  // Same rule as the "Active" filter.
  if (c || row.active) return "active";
  return "inactive";
}

// Color of each agent (avatar and folder tag). Each new agent gets the next hue, shifted by the
// golden angle (≈ 137.5°): two agents in a row have clearly distinct colors. The assignment is
// remembered so that an agent keeps its color from one reload to the next.
const AGENT_COLORS_KEY = "zo-agent-colors";
const AGENT_COLORS_MAX = 300;
const agentColors = loadAgentColors();

function loadAgentColors() {
  try {
    const saved = JSON.parse(localStorage.getItem(AGENT_COLORS_KEY) || "{}");
    if (Number.isInteger(saved.next) && saved.hues && typeof saved.hues === "object") return saved;
  } catch {
    // Storage unavailable or unreadable: start from scratch.
  }
  return { next: 0, hues: {} };
}

/**
 * @param {string} key stable id of the agent
 * @returns {number} hue (0-359)
 */
function agentHue(key) {
  if (!(key in agentColors.hues)) {
    // Skip the hues too close to the state dots (orange "thinking", green "active"),
    // which would show poorly on the avatar.
    let hue;
    do {
      hue = Math.round((agentColors.next * 137.508) % 360);
      agentColors.next += 1;
    } while ((hue >= 20 && hue <= 50) || (hue >= 100 && hue <= 160));
    agentColors.hues[key] = hue;
    // Forget the oldest agents beyond a certain number.
    const keys = Object.keys(agentColors.hues);
    for (const old of keys.slice(0, Math.max(0, keys.length - AGENT_COLORS_MAX))) delete agentColors.hues[old];
    try {
      localStorage.setItem(AGENT_COLORS_KEY, JSON.stringify(agentColors));
    } catch {
      // Storage unavailable: the colors apply to this tab only.
    }
  }
  return agentColors.hues[key];
}

/**
 * Short date for the list: the time today, day/month this year, the full date otherwise.
 *
 * @param {number} epochSeconds
 */
function shortDate(epochSeconds) {
  const date = new Date(epochSeconds * 1000);
  const now = new Date();
  const time = date.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === now.toDateString()) return time;
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.toLocaleDateString(locale(), { day: "2-digit", month: "2-digit" })} ${time}`;
  }
  return date.toLocaleDateString(locale());
}

/**
 * Last message of the agent: the one sent from here (up to date as soon as sent), otherwise the one from its history.
 *
 * @param {any} row
 */
const agentLabel = (row) =>
  row.conversation?.lastPrompt || row.lastPrompt || row.name || row.conversation?.label || t("Agent {id}", { id: String(row.sessionId).slice(0, 8) });

/** @param {string} text */
const initialOf = (text) => (text.match(/[\p{L}\p{N}]/u)?.[0] || "?").toUpperCase();

/**
 * Letter of an agent's avatar: the first of the name it was given, otherwise that of the folder
 * it works in, otherwise that of its last message.
 *
 * @param {string | undefined} name name given to the agent
 * @param {string | undefined} cwd
 * @param {string} fallback
 */
const avatarLetter = (name, cwd, fallback) => initialOf(name || cwd?.split("/").filter(Boolean).pop() || fallback);

/**
 * Avatar of an agent: the one chosen for it (abbreviation, animal or image), otherwise its letter.
 *
 * @param {string} className
 * @param {any} avatar saved avatar
 * @param {string} letter default letter (avatarLetter)
 */
function avatarNode(className, avatar, letter) {
  const node = el("span", className);
  node.setAttribute("aria-hidden", "true");
  fillAvatar(node, avatarLook(avatar, letter));
  return node;
}

/**
 * Context of the agent ({tokens, window}): the one read from its history.
 *
 * @param {any} row
 */
const agentContext = (row) => row.conversation?.context || row.context || null;

/** @param {{tokens: number, window: number}} context */
const contextPercent = (context) => Math.min(100, Math.round((context.tokens / context.window) * 100));

/** @param {number} tokens */
const kiloTokens = (tokens) =>
  tokens >= 1_000_000
    ? `${(tokens / 1_000_000).toLocaleString(locale(), { maximumFractionDigits: 1 })} M`
    : `${Math.round(tokens / 1000)} k`;

/** @param {{tokens: number, window: number}} context */
const contextText = (context) =>
  t("{pct}% ({used} / {window} tokens)", {
    pct: contextPercent(context),
    used: kiloTokens(context.tokens),
    window: kiloTokens(context.window),
  });

/**
 * Context fill: a pie (green, orange from 50%, red from 80%) and the percentage.
 *
 * @param {{tokens: number, window: number}} context
 */
function contextPie(context) {
  const pct = contextPercent(context);
  const chip = el("span", `context-chip level-${pct >= 80 ? "hot" : pct >= 50 ? "warm" : "ok"}`);
  chip.style.setProperty("--pct", String(pct));
  chip.title = t("Context: {context}", { context: contextText(context) });
  const pie = el("span", "context-pie");
  pie.setAttribute("aria-hidden", "true");
  chip.append(pie, el("span", "context-value", t("{pct}%", { pct })), el("span", "visually-hidden", ` ${t("of context")}`));
  return chip;
}

/**
 * Row of an agent: a click opens it; on the right, the pin and the ⋯ configuration button.
 *
 * @param {any} row
 */
function sessionItem(row) {
  const c = row.conversation;
  const label = displayName(row);
  const when = row.updatedAt ? shortDate(row.updatedAt) : "";
  const cost = typeof row.costUsd === "number" ? t("${cost}", { cost: row.costUsd.toFixed(2) }) : "";
  const state = agentState(row);
  const selected = Boolean(c && c.id === selectedId);
  const pinned = pinIndex(pins, row) !== -1;
  const unseen = Boolean(c && unseenConversations.has(c.id));
  const classes = ["session", `state-${state}`, selected && "selected", pinned && "pinned", unseen && "unseen"];
  const item = el("li", classes.filter(Boolean).join(" "));
  // Avatar and folder tag share the agent's color.
  item.style.setProperty("--agent-hue", String(agentHue(row.sessionId || c?.id || label)));
  const button = el("button", "session-open");
  button.type = "button";
  // The state is not written on screen: it is given to screen readers and as a tooltip.
  button.title = state === "waiting"
    ? t("{name}: waiting for {what}", {
      name: label,
      what: WAITING_LABELS[/** @type {"permission" | "question"} */ (c?.waiting)] ?? t("your reply"),
    })
    : `${label} (${AGENT_STATE_LABELS[state]})`;
  if (selected) button.setAttribute("aria-current", "true");

  const avatar = avatarNode("agent-avatar", agentAvatar(row), avatarLetter(customName(row), row.cwd, label));
  avatar.append(el("span", "agent-dot"));
  const folder = row.cwd ? row.cwd.split("/").filter(Boolean).pop() : "";
  const text = el("span", "agent-text");
  // Date · folder · cost: only the folder is shortened ("…") if space runs out.
  const meta = el("span", "muted small agent-meta");
  if (when) meta.append(el("span", "", when));
  if (folder) {
    const folderEl = el("span", "agent-folder", folder);
    folderEl.title = row.cwd;
    meta.append(folderEl);
  }
  // Folder in a git repository: a small icon to the right of the tag.
  if (row.git || c?.git) {
    const git = el("span", "agent-git");
    git.title = t("Git repository");
    git.setAttribute("aria-label", t("git repository"));
    git.append(icon(ICONS.git));
    meta.append(git);
  }
  if (cost) meta.append(el("span", "", cost));
  const context = agentContext(row);
  if (context) meta.append(contextPie(context));
  // A named agent: its name as title, then its last message. Otherwise the last message is the title.
  const name = customName(row);
  if (name) text.append(el("span", "agent-title", name), el("span", "last-message", agentLabel(row)), meta);
  else text.append(el("span", "session-name", label), meta);
  button.append(avatar, text, el("span", "visually-hidden", `, ${AGENT_STATE_LABELS[state]}`));
  button.addEventListener("click", () => (c ? selectConversation(c.id) : openSession(row.sessionId, label)));

  // Actions next to the row button (a button cannot contain another one).
  const pin = el("button", "pin-button");
  pin.type = "button";
  pin.title = pinned ? t("Unpin") : t("Pin to top");
  pin.setAttribute("aria-label", pinned ? t('Unpin "{name}"', { name: label }) : t('Pin "{name}"', { name: label }));
  pin.setAttribute("aria-pressed", String(pinned));
  pin.append(icon(ICONS.pin));
  pin.addEventListener("click", () => {
    savePins(togglePin(pins, row));
    drawSessions();
  });
  const actions = el("div", "row-actions");
  actions.append(pin);
  item.append(button, actions);
  return item;
}

const ICONS = {
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  pin: "M12 17v5M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.8a2 2 0 0 0-1.1-1.8l-1.8-.9A2 2 0 0 1 15 10.8V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z",
  close: "M6 6l12 12M18 6L6 18",
  file: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5",
  image: "M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM21 15l-5-5L5 20",
  agent: "M5 8h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2zM12 8V4H8M9 13v2M15 13v2",
  workspace: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  up: "M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11",
  folderPlus: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 10v6M9 13h6",
  git: "M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9",
  gear: "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2zM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
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

// --- workspaces: collapsible groups of agents ------------------------------------------

/** @type {{id: string, name: string, agents: string[]}[]} */
let workspaces = [];

/** Workspace of the agent, or null. @param {any} conversation */
function workspaceOf(conversation) {
  const keys = agentKeys(conversation);
  return workspaces.find((workspace) => keys.some((key) => workspace.agents.includes(key))) ?? null;
}

// --- prompt shortcuts: those of an agent, those of a workspace (shared by its agents) ------------------

/** @type {import("./shortcuts-logic.js").ShortcutData} */
let shortcutsData = emptyShortcuts();

/** @param {import("./shortcuts-logic.js").ShortcutData} data */
function setShortcuts(data) {
  shortcutsData = { ...emptyShortcuts(), ...data };
  shortcutsView.refresh();
  shortcutsPanel.refresh();
  if (panelView?.kind === "workspace") panelRefresh?.();
}

/**
 * Saves a full list (the server returns it cleaned, with the ids of the new ones).
 *
 * @param {"agent" | "workspace"} scope
 * @param {string} owner
 * @param {import("./shortcuts-logic.js").Shortcut[]} items
 */
async function saveShortcuts(scope, owner, items) {
  setShortcuts((await api("/api/shortcuts", { scope, owner, items })).shortcuts);
}

/** @param {typeof workspaces} list */
function setWorkspaces(list) {
  workspaces = list;
  // Pins of deleted workspaces no longer serve any purpose.
  const known = new Set(list.map((workspace) => workspacePinKey(workspace.id)));
  savePins(pins.filter((pin) => !pin.startsWith("workspace:") || known.has(pin)));
  drawSessions();
  panelRefresh?.();
  configRefresh?.();
  shortcutsView.refresh();
  shortcutsPanel.refresh();
}

// Colors offered for a workspace (on top of the automatic color): clearly distinct, and
// far from the orange and green of the state dots.
const WORKSPACE_HUES = [0, 15, 55, 75, 175, 195, 215, 235, 260, 280, 305, 330];

/**
 * Hue of a workspace: the chosen one, otherwise an automatically assigned hue.
 *
 * @param {{id: string, hue?: number | null}} workspace
 */
const workspaceHue = (workspace) => (Number.isInteger(workspace.hue) ? workspace.hue : agentHue(`workspace:${workspace.id}`));

// Collapsed workspaces: a display preference, specific to this browser.
// "Pinned only": unpinned agents outside workspaces are hidden (each workspace has its own
// switch). Display preference of this browser.
const PINNED_ONLY_KEY = "zo-pinned-only";
let pinnedOnly = (() => {
  try {
    return localStorage.getItem(PINNED_ONLY_KEY) === "1";
  } catch {
    return false;
  }
})();

/** @param {boolean} on */
function setPinnedOnly(on) {
  pinnedOnly = on;
  try {
    localStorage.setItem(PINNED_ONLY_KEY, on ? "1" : "0");
  } catch {
    // Storage unavailable: the choice applies to this tab only.
  }
  syncPinnedOnly();
  drawSessions();
}

function syncPinnedOnly() {
  const button = $("pinned-only");
  const label = pinnedOnly ? t("Show all agents") : t("Show pinned agents only");
  button.setAttribute("aria-pressed", String(pinnedOnly));
  button.title = label;
  button.setAttribute("aria-label", label);
}
$("pinned-only").addEventListener("click", () => setPinnedOnly(!pinnedOnly));
syncPinnedOnly();

// "Pinned only" of a workspace: its switch, to the right of "x/y pinned". Off by default:
// all its agents are shown; on, only its pinned agents.
const PINNED_ONLY_WORKSPACES_KEY = "zo-pinned-only-workspaces";
const pinnedOnlyWorkspaces = new Set((() => {
  try {
    const saved = JSON.parse(localStorage.getItem(PINNED_ONLY_WORKSPACES_KEY) || "[]");
    return Array.isArray(saved) ? saved.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
})());

/**
 * @param {string} id
 * @param {boolean} on
 */
function setWorkspacePinnedOnly(id, on) {
  if (on) pinnedOnlyWorkspaces.add(id);
  else pinnedOnlyWorkspaces.delete(id);
  try {
    localStorage.setItem(PINNED_ONLY_WORKSPACES_KEY, JSON.stringify([...pinnedOnlyWorkspaces]));
  } catch {
    // Storage unavailable: the choice applies to this tab only.
  }
  drawSessions();
}

const COLLAPSED_KEY = "zo-collapsed-workspaces";
const collapsedWorkspaces = new Set(loadCollapsed());

function loadCollapsed() {
  try {
    const saved = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || "[]");
    return Array.isArray(saved) ? saved.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** @param {string} id */
function toggleCollapsed(id) {
  if (collapsedWorkspaces.has(id)) collapsedWorkspaces.delete(id);
  else collapsedWorkspaces.add(id);
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsedWorkspaces]));
  } catch {
    // Storage unavailable: the choice applies to this tab only.
  }
  drawSessions();
}

/**
 * Block of a workspace in the list: collapsible header (with pin and gear), then its agents.
 *
 * @param {{id: string, name: string, hue?: number | null, agents: string[]}} workspace
 * @param {any[]} rows its agents
 */
function workspaceItem(workspace, rows) {
  const collapsed = collapsedWorkspaces.has(workspace.id);
  const state = workspaceState(rows.map(agentState));
  const pinKey = workspacePinKey(workspace.id);
  const pinned = pins.includes(pinKey);
  const configuring = panelView?.kind === "workspace" && panelView.id === workspace.id;
  const classes = ["workspace", `state-${state}`, collapsed && "collapsed", pinned && "pinned", configuring && "configuring"];
  const item = el("li", classes.filter(Boolean).join(" "));
  item.style.setProperty("--agent-hue", String(workspaceHue(workspace)));

  const head = el("div", "workspace-head");
  // A click on the workspace opens its card, on the Configuration tab; the arrow collapses / expands it.
  const toggle = el("button", "workspace-toggle");
  toggle.type = "button";
  toggle.title = t("{name} ({state}): open the workspace", { name: workspace.name, state: AGENT_STATE_LABELS[state] });
  const badge = el("span", "workspace-icon", initialOf(workspace.name));
  badge.setAttribute("aria-hidden", "true");
  badge.append(el("span", "agent-dot"));
  // Pinned agents out of the total ("2/5 pinned"), and the switch that keeps only the pinned ones.
  const { pinned: pinnedRows, others } = pinnedFirst(rows, pins);
  const onlyPinned = pinnedOnlyWorkspaces.has(workspace.id);
  const count = rows.length === 0
    ? t("No agents")
    : t("{n}/{total} pinned", { n: pinnedRows.length, total: rows.length });
  const text = el("span", "agent-text");
  // The counter line is drawn over the button (.workspace-sub): this one only reserves its space.
  const spacer = el("span", "muted small workspace-count-space", count);
  spacer.setAttribute("aria-hidden", "true");
  text.append(el("span", "session-name", workspace.name), spacer);
  toggle.append(badge, text, el("span", "visually-hidden", `, ${count}, ${AGENT_STATE_LABELS[state]}`));
  toggle.addEventListener("click", () => openWorkspacePanel(workspace.id));
  const sub = el("div", "workspace-sub");
  sub.append(el("span", "muted small", count));
  if (rows.length) {
    const label = onlyPinned ? t("Show all agents of the workspace") : t("Show only the pinned agents of the workspace");
    const switcher = el("button", "ws-switch");
    switcher.type = "button";
    switcher.setAttribute("role", "switch");
    switcher.setAttribute("aria-checked", String(onlyPinned));
    switcher.setAttribute("aria-label", t('{label} ("{name}")', { label, name: workspace.name }));
    switcher.title = label;
    switcher.append(el("span", "ws-switch-knob"));
    switcher.addEventListener("click", () => setWorkspacePinnedOnly(workspace.id, !onlyPinned));
    // The state at a glance: a list (all agents) or a pin (pinned only).
    const stateIcon = el("span", `ws-switch-icon${onlyPinned ? " on" : ""}`);
    stateIcon.title = onlyPinned ? t("Pinned agents only") : t("All agents");
    stateIcon.append(icon(onlyPinned ? ICONS.pin : ICONS.list));
    sub.append(switcher, stateIcon);
  }

  const pin = el("button", "pin-button");
  pin.type = "button";
  pin.title = pinned ? t("Unpin") : t("Pin to top");
  pin.setAttribute("aria-label", pinned
    ? t('Unpin the workspace "{name}"', { name: workspace.name })
    : t('Pin the workspace "{name}"', { name: workspace.name }));
  pin.setAttribute("aria-pressed", String(pinned));
  pin.append(icon(ICONS.pin));
  pin.addEventListener("click", () => {
    savePins(pinned ? pins.filter((key) => key !== pinKey) : [...pins, pinKey]);
    drawSessions();
  });
  const fold = el("button", "pin-button workspace-fold");
  fold.type = "button";
  fold.title = collapsed ? t("Expand") : t("Collapse");
  fold.setAttribute("aria-label", collapsed
    ? t('Expand the workspace "{name}"', { name: workspace.name })
    : t('Collapse the workspace "{name}"', { name: workspace.name }));
  fold.setAttribute("aria-expanded", String(!collapsed));
  const chevron = el("span", "workspace-chevron");
  chevron.setAttribute("aria-hidden", "true");
  fold.append(chevron);
  fold.addEventListener("click", () => toggleCollapsed(workspace.id));
  const actions = el("div", "row-actions");
  actions.append(pin, fold);
  head.append(toggle, sub, actions);
  item.append(head);

  if (!collapsed) {
    const body = el("ul", "workspace-agents");
    if (rows.length) {
      // Pinned agents keep their place at the top of the workspace.
      const pinnedItems = pinnedRows.map(sessionItem);
      if (onlyPinned) {
        // Pinned only: the other agents of the workspace are summed up in one line.
        body.append(...pinnedItems);
        if (others.length) {
          body.append(hiddenAgentsNote(others.length, () => setWorkspacePinnedOnly(workspace.id, false)));
        }
      } else {
        pinnedItems.at(-1)?.classList.toggle("pinned-last", others.length > 0);
        body.append(...pinnedItems, ...others.map(sessionItem));
      }
    } else {
      const empty = el("li", "workspace-empty");
      const add = el("button", "link-button", t("Add agents"));
      add.type = "button";
      add.addEventListener("click", () => openWorkspacePanel(workspace.id));
      empty.append(add);
      body.append(empty);
    }
    item.append(body);
  }
  return item;
}

/**
 * Line "N unpinned agents hidden", which shows everything again on click.
 *
 * @param {number} count
 * @param {() => void} [showAll] what shows everything again (by default: turn off "pinned only" of the list)
 */
function hiddenAgentsNote(count, showAll = () => setPinnedOnly(false)) {
  const item = el("li", "workspace-empty hidden-agents");
  const show = el("button", "link-button", tn(count, "{n} unpinned agent hidden · show all", "{n} unpinned agents hidden · show all"));
  /** @type {HTMLButtonElement} */ (show).type = "button";
  show.addEventListener("click", showAll);
  item.append(show);
  return item;
}

// --- central card: create an agent or a workspace, manage a workspace -----------------------

const chatCard = $("chat");
const panel = $("panel");
const panelBody = $("panel-body");
/** @type {null | {kind: "create"} | {kind: "new-agent"} | {kind: "workspace", id: string} | {kind: "deleted"} | {kind: "settings"}} */
let panelView = null;
/** @type {null | (() => void)} refreshes the card shown when the data changes */
let panelRefresh = null;

/**
 * @param {string} title
 * @param {Node[]} children
 */
function showPanel(title, ...children) {
  panel.classList.remove("hero-mode"); // the home screen (animation) has no header: the others do
  $("panel-title").textContent = title;
  panelBody.replaceChildren(...children);
  // In idle state, the "Create" card has nothing to close.
  $("panel-close").hidden = !selectedId && panelView?.kind === "create";
  chatCard.hidden = true;
  panel.hidden = false;
}

function closePanel() {
  const wasConfiguring = panelView?.kind === "workspace";
  panelView = null;
  panelRefresh = null;
  if (!selectedId) {
    openCreatePanel(); // nothing behind the card: idle state
    if (wasConfiguring) drawSessions();
    return;
  }
  panel.hidden = true;
  chatCard.hidden = false;
  if (wasConfiguring) drawSessions(); // removes the highlight of the configured row
}

$("panel-close").addEventListener("click", closePanel);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !panel.hidden && !$("panel-close").hidden && !isDialogOpen() && !inTasksMode()) closePanel();
});

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

// --- Configuration (button of the usage dialog): the open Claude Code terminals -----------------------------

// --- server: start, version, clean restart (Configuration screen, banner at the top) ------------------------

/** @type {{startedAt: number, version: string | null, pid: number, restart: any, lastRestart: any} | null} */
let serverInfo = null;
const RESTARTED_KEY = "zo-restarted-from"; // page reloaded after a restart: start time of the previous server
/** @type {number | undefined} */
let bannerTimer;

/** @param {number} epoch */
const clock = (epoch) => new Date(epoch * 1000).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });

/**
 * Banner at the top of the screen.
 *
 * @param {"waiting" | "restarting" | "done" | null} kind
 * @param {Node[]} [content]
 */
function showServerBanner(kind, content = []) {
  const banner = $("server-banner");
  clearTimeout(bannerTimer);
  banner.hidden = !kind;
  banner.className = `server-banner${kind ? ` ${kind}` : ""}`;
  banner.replaceChildren(...content);
  if (kind === "done") bannerTimer = window.setTimeout(() => showServerBanner(null), 15_000);
}

/** Names of the agents being waited for, for the banner. @param {string[]} ids */
const agentNames = (ids) => ids.map(conversationName).join(", ");

/** The banner follows the restart in progress (waiting for the agents, relaunch). */
function renderRestartBanner() {
  const restart = serverInfo?.restart;
  if (!restart) {
    if ($("server-banner").classList.contains("waiting") || $("server-banner").classList.contains("restarting")) showServerBanner(null);
    return;
  }
  if (restart.phase === "restarting") {
    showServerBanner("restarting", [el("span", "server-spinner"), el("span", "", t("Restarting the server… the page will reload by itself."))]);
    return;
  }
  const waiting = restart.waiting ?? [];
  const text = waiting.length
    ? tn(
      waiting.length,
      "Server restart requested: waiting for {n} working agent ({names}), until {time} at most.",
      "Server restart requested: waiting for {n} working agents ({names}), until {time} at most.",
      { names: agentNames(waiting), time: clock(restart.deadline) },
    )
    : t("Server restart requested: the agents are idle, it is starting…");
  const force = el("button", "", t("Force now"));
  /** @type {HTMLButtonElement} */ (force).type = "button";
  force.addEventListener("click", () => restartAction("force"));
  const cancel = el("button", "", t("Cancel"));
  /** @type {HTMLButtonElement} */ (cancel).type = "button";
  cancel.addEventListener("click", () => restartAction("cancel"));
  showServerBanner("waiting", [el("span", "server-spinner"), el("span", "server-banner-text", text), force, cancel]);
}

/** @param {"start" | "force" | "cancel"} action */
async function restartAction(action) {
  try {
    serverInfo = await api("/api/server/restart", { action });
    sessionStorage.setItem(RESTARTED_KEY, String(serverInfo?.startedAt ?? ""));
  } catch (err) {
    showServerBanner("waiting", [el("span", "", t("Could not restart: {error}", { error: err instanceof Error ? err.message : err }))]);
    return;
  }
  if (action === "cancel") sessionStorage.removeItem(RESTARTED_KEY);
  renderRestartBanner();
  if (panelView?.kind === "settings") renderSettingsPanel();
}

/** On load: was the page just reloaded after a restart? If so, confirm it. */
function confirmRestart() {
  let previous = null;
  try {
    previous = sessionStorage.getItem(RESTARTED_KEY);
    sessionStorage.removeItem(RESTARTED_KEY);
  } catch {
    // Storage unavailable: no confirmation.
  }
  if (!previous || !serverInfo || String(serverInfo.startedAt) === previous) return;
  confirmingRestart = true;
  showRestartDone();
}

/** The server may finish reopening the terminals after the reload: the banner is then completed. */
let confirmingRestart = false;

function showRestartDone() {
  if (!serverInfo) return;
  const last = serverInfo.lastRestart;
  const parts = [t("✓ Server restarted at {time}", { time: clock(serverInfo.startedAt) })];
  if (serverInfo.version) parts.push(t("version {version}", { version: serverInfo.version }));
  if (last && last.completedAt >= serverInfo.startedAt) {
    parts.push(tn(last.reopened, "{n} terminal reopened", "{n} terminals reopened"));
    if (last.resumed) parts.push(tn(last.resumed, "{n} agent resumed", "{n} agents resumed"));
  }
  const close = el("button", "icon-button");
  /** @type {HTMLButtonElement} */ (close).type = "button";
  close.setAttribute("aria-label", t("Close"));
  close.append(icon(ICONS.close));
  close.addEventListener("click", () => showServerBanner(null));
  showServerBanner("done", [el("span", "server-banner-text", parts.join(" · ")), close]);
}

/**
 * The real-time stream reopened after a cut: if the server changed (restarted), reload the page
 * to get its up-to-date code; the confirmation shows on return.
 */
async function checkServerAfterReconnect() {
  let info;
  try {
    info = await api("/api/server");
  } catch {
    return;
  }
  if (serverInfo && info.startedAt !== serverInfo.startedAt) {
    try {
      sessionStorage.setItem(RESTARTED_KEY, String(serverInfo.startedAt));
    } catch {
      // Storage unavailable: reload without confirmation.
    }
    location.reload();
    return;
  }
  serverInfo = info;
  renderRestartBanner();
}

/** @type {number | undefined} re-reading of the memory, while the screen is shown */
let settingsTimer;
/** Terminals read on the last pass: the list is redrawn right away when an agent changes state. */
/** @type {{conversation: string, startedAt: number, memory: number | null}[]} */
let terminalStats = [];

/** Opens the Configuration screen in the center, on the Claude terminals tab. */
function openSettingsPanel() {
  panelView = { kind: "settings" };
  panelRefresh = renderSettingsPanel;
  clearInterval(settingsTimer);
  settingsTimer = window.setInterval(() => {
    if (panelView?.kind !== "settings" || panel.hidden) {
      clearInterval(settingsTimer);
      return;
    }
    loadTerminalStats();
  }, 10_000);
  renderSettingsPanel();
  loadTerminalStats();
}

async function loadTerminalStats() {
  try {
    terminalStats = (await api("/api/terminals")).terminals;
  } catch {
    return; // server unreachable: the list keeps its last values
  }
  if (panelView?.kind === "settings") renderSettingsPanel();
}

/** Open terminals, with their agent and its state, in display order. */
function terminalRows() {
  const rows = sessionRows();
  return sortTerminals(terminalStats.flatMap((stat) => {
    const c = conversations.get(stat.conversation);
    if (!c) return [];
    const row = rows.find((r) => r.conversation === c) ?? { sessionId: c.sessionId || c.resumeFrom, cwd: c.cwd, conversation: c };
    return [{ ...stat, c, row, state: agentState(row) }];
  }));
}

/** @param {string} conversationId @param {string} state @param {string} name */
async function closeTerminal(conversationId, state, name) {
  if (!isIdle(state)) {
    const confirmed = await confirmDialog({
      title: t('Close the terminal of "{name}"?', { name: clip(name, 50) }),
      message: state === "waiting"
        ? t("It is waiting for your reply: its request will be dropped. Its session is kept, it will resume it on reopening.")
        : t("It is working: its turn will be interrupted. Its session is kept, it will resume it on reopening."),
      confirmLabel: t("Close the terminal"),
      danger: true,
    });
    if (!confirmed) return;
  }
  await api(`/api/conversations/${conversationId}/terminal-stop`, {});
  loadTerminalStats();
}

/** Tab shown in the Configuration screen. */
let settingsTab = "terminals";

/** Server tab: running since…, version, last restart, and the button to restart. */
function serverPane() {
  const pane = el("div", "panel-pane");
  const info = serverInfo;
  const card = el("div", "server-card");
  const head = el("div", "server-card-head");
  const restarting = Boolean(info?.restart);
  head.append(el("span", `server-dot${restarting ? " warm" : ""}`),
    el("strong", "", restarting ? t("Restart requested") : t("Server running")));
  card.append(head);
  if (info) {
    const facts = el("dl", "account-details");
    fillFacts(facts, [
      [t("Started"), t("{date} (running for {since})", {
        date: new Date(info.startedAt * 1000).toLocaleString(locale(), { dateStyle: "medium", timeStyle: "short" }),
        since: formatSince(info.startedAt, Date.now() / 1000),
      })],
      [t("Version"), info.version ? t("commit {version}", { version: info.version }) : null],
      [t("Process"), t("pid {pid}", { pid: info.pid })],
      [t("Last restart"), info.lastRestart?.completedAt ? lastRestartText(info.lastRestart) : null],
    ]);
    card.append(facts);
  }
  const how = el("p", "muted small", t("Clean restart: working agents get a pause request, the server waits until they are idle (20 min at most), relaunches itself with the same command, reopens the terminals and resumes the paused agents. The page reloads and confirms the restart."));
  const button = /** @type {HTMLButtonElement} */ (el("button", "primary", restarting ? t("Restarting…") : t("Restart the server")));
  button.type = "button";
  button.disabled = restarting;
  button.addEventListener("click", async () => {
    const working = [...conversations.values()].filter((c) => c.busy).map((c) => c.id);
    const confirmed = await confirmDialog({
      title: t("Restart the server?"),
      message: `${working.length
        ? tn(
          working.length,
          "{n} agent is working ({names}): it will get a pause request and the server will wait for the end of its step (20 min at most).",
          "{n} agents are working ({names}): they will get a pause request and the server will wait for the end of their step (20 min at most).",
          { names: agentNames(working) },
        )
        : t("No agent is working: the server restarts right away.")}\n\n${t("Open terminals will be reopened, and the page will reload to confirm the restart.")}`,
      confirmLabel: t("Restart"),
    });
    if (confirmed) restartAction("start");
  });
  card.append(how, button);
  pane.append(card);
  return pane;
}

/**
 * Last restart, for the Server tab: date, terminals reopened, agents resumed, forced or not.
 *
 * @param {{completedAt: number, reopened: number, resumed?: number, forced?: boolean}} last
 */
function lastRestartText(last) {
  let text = `${new Date(last.completedAt * 1000).toLocaleString(locale(), { dateStyle: "medium", timeStyle: "short" })} · ${
    tn(last.reopened, "{n} terminal reopened", "{n} terminals reopened")}`;
  if (last.resumed) text += `, ${tn(last.resumed, "{n} agent resumed", "{n} agents resumed")}`;
  return last.forced ? t("{text} (forced)", { text }) : text;
}

/** General tab: settings of Ziggy One for every browser, saved by the server (the interface language). */
function generalPane() {
  const pane = el("div", "panel-pane general-pane");
  const section = el("div", "settings-section");
  const label = el("label", "settings-title", t("Language"));
  label.setAttribute("for", "settings-language");
  const select = /** @type {HTMLSelectElement} */ (el("select", "text-input"));
  select.id = "settings-language";
  // Each language is named in its own language, so it can be found whatever the current one.
  select.append(...LANGUAGES.map(([code, name]) => new Option(name, code)));
  select.value = globalSettings.language;
  const error = el("p", "form-error");
  error.hidden = true;
  select.addEventListener("change", async () => {
    select.disabled = true;
    try {
      const result = await api("/api/settings", { settings: { language: select.value } });
      globalSettings = result.settings;
      location.reload(); // every text of the page is drawn in the new language
    } catch (err) {
      select.value = globalSettings.language;
      select.disabled = false;
      showPanelError(error, err);
    }
  });
  section.append(label, select, el("p", "muted small",
    t("Language of the interface and of the server messages, for every browser. Texts given to the agents stay in English.")), error);
  pane.append(section);
  return pane;
}

function renderSettingsPanel() {
  const now = Date.now() / 1000;
  const items = terminalRows();
  const idle = items.filter((item) => isIdle(item.state));
  const working = items.length - idle.length;
  const total = items.reduce((sum, item) => sum + (item.memory ?? 0), 0);

  // Tabs of the screen: the open Claude terminals, the server (restart), and the general settings (language).
  const tabs = el("div", "chat-tabs panel-tabs");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "Configuration");
  for (const [key, label] of [["terminals", t("Claude terminals")], ["server", t("Server")], ["general", t("General")]]) {
    const tab = el("button", "", label);
    /** @type {HTMLButtonElement} */ (tab).type = "button";
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(settingsTab === key));
    tab.addEventListener("click", () => {
      settingsTab = key;
      renderSettingsPanel();
    });
    tabs.append(tab);
  }
  if (settingsTab === "server") {
    showPanel("Configuration", tabs, serverPane());
    return;
  }
  if (settingsTab === "general") {
    showPanel("Configuration", tabs, generalPane());
    return;
  }

  // At a glance: how many, who is waiting for you or working, how much memory.
  const stat = (/** @type {string} */ value, /** @type {string} */ label, /** @type {string} */ tone = "") => {
    const tile = el("div", `settings-stat${tone ? ` ${tone}` : ""}`);
    tile.append(el("strong", "", value), el("span", "muted small", label));
    return tile;
  };
  const stats = el("div", "settings-stats");
  stats.append(
    stat(String(items.length), tn(items.length, "open terminal", "open terminals")),
    stat(String(working), t("working or waiting"), working ? "warm" : ""),
    stat(items.length ? formatBytes(total) : "—", t("memory used")),
  );

  const toolbar = el("div", "terminals-toolbar");
  toolbar.append(el("p", "muted small", t("Each agent keeps its Claude Code open in the background. Closing a terminal frees its memory; the agent resumes its session when you reopen it.")));
  if (idle.length) {
    const closeIdle = el("button", "", tn(idle.length, "Close the idle terminal", "Close the {n} idle terminals"));
    /** @type {HTMLButtonElement} */ (closeIdle).type = "button";
    closeIdle.addEventListener("click", async () => {
      const confirmed = await confirmDialog({
        title: tn(idle.length, "Close the idle terminal?", "Close the {n} idle terminals?"),
        message: t("Agents that are working or waiting for you stay open. The others will resume their session on reopening."),
        confirmLabel: t("Close"),
      });
      if (!confirmed) return;
      await Promise.all(idle.map((item) => api(`/api/conversations/${item.conversation}/terminal-stop`, {}).catch(() => {})));
      loadTerminalStats();
    });
    toolbar.append(closeIdle);
  }

  const STATE_TEXT = { waiting: t("Waiting for your reply"), busy: t("Working"), active: t("Idle"), inactive: t("Idle") };
  const list = el("ul", "terminals-list");
  for (const item of items) {
    const name = displayName(item.row);
    const li = el("li", `terminal-row session state-${item.state}`);
    li.style.setProperty("--agent-hue", String(agentHue(item.row.sessionId || item.c.id || name)));
    const avatar = avatarNode("agent-avatar", agentAvatar(item.row), avatarLetter(customName(item.row), item.c.cwd, name));
    avatar.append(el("span", "agent-dot"));
    const who = el("div", "terminal-who");
    const folder = el("span", "agent-folder", baseName(item.c.cwd));
    folder.title = item.c.cwd;
    who.append(el("strong", "terminal-name", name), folder);
    const pill = el("span", `state-pill state-${item.state}`, STATE_TEXT[/** @type {"waiting"} */ (item.state)] ?? t("Idle"));
    const facts = el("div", "terminal-facts muted small");
    const since = formatSince(item.startedAt, now);
    facts.append(el("span", "", since === t("just now") ? t("opened just now") : t("open for {since}", { since })),
      el("span", "terminal-memory", formatBytes(item.memory)));
    const open = el("button", "", t("Open"));
    /** @type {HTMLButtonElement} */ (open).type = "button";
    open.addEventListener("click", async () => {
      await selectConversation(item.c.id);
      setTab("terminal");
    });
    const close = el("button", "danger-outline", t("Close"));
    /** @type {HTMLButtonElement} */ (close).type = "button";
    close.setAttribute("aria-label", t('Close the terminal of "{name}"', { name }));
    close.addEventListener("click", () => closeTerminal(item.conversation, item.state, name).catch((err) => showPanelError(error, err)));
    const actions = el("div", "terminal-actions");
    actions.append(open, close);
    li.append(avatar, who, pill, facts, actions);
    list.append(li);
  }
  if (!items.length) list.append(el("li", "terminals-empty muted", t("No Claude Code terminal open.")));

  const error = el("p", "form-error");
  error.hidden = true;
  const pane = el("div", "panel-pane");
  pane.append(stats, toolbar, error, list);
  showPanel("Configuration", tabs, pane);
}

function openCreatePanel() {
  panelView = { kind: "create" };
  panelRefresh = null;
  const error = el("p", "form-error");
  error.hidden = true;
  const choices = el("div", "create-choices");
  choices.append(
    choiceTile(ICONS.agent, "Agent", t("Claude Code in the folder of your choice, opened in its Terminal."), openNewAgentPanel),
    choiceTile(ICONS.workspace, "Workspace", t("A group to keep several agents together. It collapses in the list."), openWorkspaceForm),
  );
  if (!selectedId) {
    showIdleHero();
    return;
  }
  showPanel(t("Create"), el("p", "muted", t("What do you want to create?")), error, choices);
  /** @type {HTMLElement | null} */ (choices.querySelector("button"))?.focus();
}

/** Order of the agents around Ziggy: who is waiting for you, who is working, who is open, then the most recent. */
const HERO_ORDER = { waiting: 0, busy: 1, active: 2, inactive: 3 };

/** No agent open: the animated home screen, with your agents in orbit and the two buttons to create. */
function showIdleHero() {
  const rows = sessionRows()
    .map((row) => ({ row, state: agentState(row) }))
    .sort((a, b) => (HERO_ORDER[/** @type {"busy"} */ (a.state)] ?? 3) - (HERO_ORDER[/** @type {"busy"} */ (b.state)] ?? 3));
  const agents = rows.map(({ row, state }) => {
    const name = displayName(row);
    return { letter: avatarLetter(customName(row), row.cwd, name), hue: agentHue(row.sessionId || row.conversation?.id || name), state };
  });
  const active = rows.filter((r) => r.state !== "inactive").length;
  const busy = rows.filter((r) => r.state === "busy" || r.state === "waiting").length;
  const stats = [
    tn(active, "{n} active agent", "{n} active agents"),
    busy ? t("{n} working", { n: busy }) : null,
    tn(workspaces.length, "{n} workspace", "{n} workspaces"),
  ].filter(Boolean).join(" · ");
  const hero = createHero({
    el, icon, agents, stats,
    icons: { agent: ICONS.agent, workspace: ICONS.workspace },
    onAgent: () => openNewAgentPanel(),
    onWorkspace: openWorkspaceForm,
  });
  showPanel("Ziggy One", hero);
  panel.classList.add("hero-mode");
  /** @type {HTMLElement | null} */ (hero.querySelector(".hero-button"))?.focus({ preventScroll: true });
}

function openWorkspaceForm() {
  panelView = { kind: "create" };
  const form = el("form", "workspace-form");
  const label = el("label", "field-label", t("Workspace name"));
  label.setAttribute("for", "workspace-name");
  const input = /** @type {HTMLInputElement} */ (el("input", "text-input"));
  Object.assign(input, { id: "workspace-name", maxLength: 80, required: true, autocomplete: "off", placeholder: t("E.g. Batch connectors") });
  const error = el("p", "form-error");
  error.hidden = true;
  const back = el("button", "", t("Back"));
  back.type = "button";
  back.addEventListener("click", openCreatePanel);
  const submit = /** @type {HTMLButtonElement} */ (el("button", "primary", t("Create the workspace")));
  submit.type = "submit";
  const actions = el("div", "panel-actions");
  actions.append(back, submit);
  form.append(label, input, error, actions);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    try {
      const created = await api("/api/workspaces", { name: input.value });
      // Pinned by default by the server: same here, before its "pins" event arrives.
      if (!pins.includes(`workspace:${created.id}`)) pins = [...pins, `workspace:${created.id}`];
      if (!workspaces.some((w) => w.id === created.id)) setWorkspaces([...workspaces, created]);
      openWorkspacePanel(created.id);
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
      submit.disabled = false;
    }
  });
  showPanel(t("New workspace"), form);
  input.focus();
}

/**
 * "Configure the workspace" card: name, color, agents (checkboxes), deletion.
 * It updates in place when the data changes, without losing the search in progress.
 *
 * @param {string} id
 */
function openWorkspacePanel(id, tab = "settings") {
  const workspace = workspaces.find((w) => w.id === id);
  if (!workspace) return;
  panelView = { kind: "workspace", id };
  const error = el("p", "form-error");
  error.hidden = true;
  /** @param {object} changes */
  const update = (changes) =>
    api(`/api/workspaces/${id}/update`, changes)
      .then((result) => setWorkspaces(result.workspaces))
      .catch((err) => showPanelError(error, err));

  // Who this workspace is: icon, name, number of agents.
  const summary = el("div", "agent-summary workspace-summary");
  const badge = el("span", "workspace-icon big-avatar");
  badge.setAttribute("aria-hidden", "true");
  const summaryName = el("strong", "agent-summary-name");
  const summaryCount = el("span", "muted small");
  const summaryText = el("span", "agent-text");
  summaryText.append(summaryName, summaryCount);
  summary.append(badge, summaryText);

  // Name.
  const nameForm = el("form", "settings-section");
  const nameLabel = el("label", "settings-title", t("Name"));
  nameLabel.setAttribute("for", "workspace-rename");
  const nameInput = /** @type {HTMLInputElement} */ (el("input", "text-input"));
  Object.assign(nameInput, { id: "workspace-rename", maxLength: 80, required: true, autocomplete: "off" });
  const rename = el("button", "primary", t("Rename"));
  /** @type {HTMLButtonElement} */ (rename).type = "submit";
  const nameRow = el("div", "inline-field");
  nameRow.append(nameInput, rename);
  nameForm.append(nameLabel, nameRow);
  nameForm.addEventListener("submit", (event) => {
    event.preventDefault();
    update({ name: nameInput.value });
  });

  // Color: automatic or one of the offered hues.
  const colorSection = el("div", "settings-section");
  const swatches = el("div", "swatches");
  swatches.setAttribute("role", "radiogroup");
  swatches.setAttribute("aria-label", t("Workspace color"));
  /** @type {[HTMLElement, number | null][]} */
  const swatchButtons = [null, ...WORKSPACE_HUES].map((hue) => {
    const swatch = el("button", hue === null ? "swatch auto" : "swatch", hue === null ? t("Auto") : "");
    /** @type {HTMLButtonElement} */ (swatch).type = "button";
    swatch.setAttribute("role", "radio");
    swatch.title = hue === null ? t("Automatic color") : t("Hue {hue}°", { hue });
    if (hue !== null) swatch.style.setProperty("--agent-hue", String(hue));
    swatch.addEventListener("click", () => update({ hue }));
    return [swatch, hue];
  });
  swatches.append(...swatchButtons.map(([swatch]) => swatch));
  colorSection.append(el("h3", "settings-title", t("Color")), swatches);

  // Activity shared between the agents of the same repository.
  const shareSection = el("div", "settings-section");
  const shareToggle = el("label", "toggle");
  const shareBox = /** @type {HTMLInputElement} */ (el("input"));
  shareBox.type = "checkbox";
  shareBox.addEventListener("change", () => update({ shareActivity: shareBox.checked }));
  shareToggle.append(shareBox, el("span", "", t("Share activity between agents of the same repository")));
  shareSection.append(
    el("h3", "settings-title", t("Shared activity")),
    shareToggle,
    el(
      "p",
      "muted small",
      t("With each message, the agent gets a few lines about what the other agents of this workspace did in the same repository since its previous message: requests, results, commits. It is shown above your message."),
    ),
  );

  // Agents.
  const agentsSection = el("div", "settings-section agents-section");
  const search = /** @type {HTMLInputElement} */ (el("input", "text-input"));
  Object.assign(search, { type: "search", placeholder: t("Search for an agent or a folder…"), autocomplete: "off" });
  search.setAttribute("aria-label", t("Search for an agent"));
  const list = el("ul", "picker-list");
  agentsSection.append(
    el("h3", "settings-title", "Agents"),
    el("p", "muted small", t("Check the agents to put in this workspace. An agent is only in one workspace at a time.")),
    search,
    list,
  );

  // Deletion.
  const dangerSection = el("div", "settings-section danger-zone");
  const remove = el("button", "danger", t("Delete the workspace"));
  /** @type {HTMLButtonElement} */ (remove).type = "button";
  remove.addEventListener("click", async () => {
    const current = workspaces.find((w) => w.id === id);
    if (!current) return;
    const confirmed = await confirmDialog({
      title: t('Delete "{name}"?', { name: clip(current.name, 60) }),
      message: t("Its agents go back to the general list. No agent is stopped or deleted."),
      confirmLabel: t("Delete"),
      danger: true,
    });
    if (!confirmed) return;
    try {
      setWorkspaces((await api(`/api/workspaces/${id}/delete`, {})).workspaces);
      closePanel();
    } catch (err) {
      showPanelError(error, err);
    }
  });
  dangerSection.append(
    el("h3", "settings-title", t("Delete")),
    el("p", "muted small", t("Its agents go back to the general list, without being stopped or deleted.")),
    remove,
  );

  const done = el("button", "primary", t("Done"));
  /** @type {HTMLButtonElement} */ (done).type = "button";
  done.addEventListener("click", closePanel);
  const footer = el("div", "panel-actions");
  footer.append(done);

  // Shortcuts shared by all the agents of the workspace.
  const shortcutsPane = el("div", "panel-pane");
  const shortcutsIntro = el("p", "muted small");
  shortcutsIntro.textContent = t("Shared by all the agents of the workspace. In their Terminal (Ctrl+Shift), they come after each agent's own shortcuts.");
  const shortcutsEditor = createShortcutsEditor({ el, icon, confirmDialog }, { emptyText: t("No shared shortcuts."), digits: false });
  shortcutsPane.append(shortcutsIntro, shortcutsEditor.node);
  const settingsPane = el("div", "panel-pane");
  settingsPane.append(error, nameForm, colorSection, shareSection, agentsSection, dangerSection);

  // Two tabs: Shortcuts, then Configuration (always last, open by default).
  const tabs = el("div", "chat-tabs panel-tabs");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", t("Workspace view"));
  const tabButtons = /** @type {[string, string, HTMLElement][]} */ ([["shortcuts", t("Shortcuts"), shortcutsPane], ["settings", t("Configuration"), settingsPane]])
    .map(([key, label, pane]) => {
      const button = el("button", "", label);
      /** @type {HTMLButtonElement} */ (button).type = "button";
      button.setAttribute("role", "tab");
      button.addEventListener("click", () => showTab(key));
      tabs.append(button);
      return /** @type {[string, HTMLElement, HTMLElement]} */ ([key, button, pane]);
    });
  /** @param {string} key */
  const showTab = (key) => {
    for (const [tabKey, button, pane] of tabButtons) {
      button.setAttribute("aria-selected", String(tabKey === key));
      button.tabIndex = tabKey === key ? 0 : -1;
      pane.hidden = tabKey !== key;
    }
  };
  showTab(tab);

  // Update in place: called on opening and on every data change.
  panelRefresh = () => {
    shortcutsEditor.set(shortcutsData.workspaces[id] ?? [], (items) => saveShortcuts("workspace", id, items));
    const current = workspaces.find((w) => w.id === id);
    if (!current) {
      closePanel(); // deleted (in another tab…)
      return;
    }
    const hue = workspaceHue(current);
    summary.style.setProperty("--agent-hue", String(hue));
    badge.textContent = initialOf(current.name);
    summaryName.textContent = current.name;
    const memberCount = splitByWorkspace(sessionRows(), workspaces).members.get(id)?.length ?? 0;
    summaryCount.textContent = memberCount === 0 ? t("No agents") : tn(memberCount, "{n} agent", "{n} agents");
    if (document.activeElement !== nameInput) nameInput.value = current.name;
    for (const [swatch, swatchHue] of swatchButtons) {
      swatch.setAttribute("aria-checked", String(swatchHue === (Number.isInteger(current.hue) ? current.hue : null)));
    }
    shareBox.checked = current.shareActivity !== false;
    renderPicker(current, list, search.value);
  };
  search.addEventListener("input", panelRefresh);
  showPanel(workspace.name, summary, tabs, shortcutsPane, settingsPane, footer);
  panelRefresh();
  drawSessions(); // outlines the configured workspace
}

/**
 * @param {{id: string, name: string, agents: string[]}} workspace
 * @param {HTMLElement} list
 * @param {string} query
 */
function renderPicker(workspace, list, query) {
  const words = query.trim().toLowerCase();
  const rows = sessionRows().filter((row) => !words || `${displayName(row)} ${row.cwd || ""}`.toLowerCase().includes(words));
  list.replaceChildren(...rows.map((row) => pickerItem(workspace, row)));
  if (rows.length === 0) list.append(el("li", "muted small", t("No matching agent.")));
}

/**
 * @param {{id: string, name: string, agents: string[]}} workspace
 * @param {any} row
 */
function pickerItem(workspace, row) {
  const key = memberKey(workspace, row);
  const elsewhere = key === undefined ? workspaces.find((w) => w.id !== workspace.id && memberKey(w, row) !== undefined) : undefined;
  const label = displayName(row);
  const item = el("li", "picker-item");
  item.style.setProperty("--agent-hue", String(agentHue(row.sessionId || row.conversation?.id || label)));
  const wrapper = el("label", "picker-label");
  const box = /** @type {HTMLInputElement} */ (el("input"));
  box.type = "checkbox";
  box.checked = key !== undefined;
  box.addEventListener("change", async () => {
    box.disabled = true;
    try {
      const result = box.checked
        ? await api(`/api/workspaces/${workspace.id}/add`, { agent: rowKeys(row)[0] })
        : await api(`/api/workspaces/${workspace.id}/remove`, { agent: key });
      setWorkspaces(result.workspaces);
    } catch (err) {
      box.checked = !box.checked;
      box.disabled = false;
      showToast(err.message);
    }
  });
  const avatar = avatarNode("agent-avatar small-avatar", agentAvatar(row), avatarLetter(customName(row), row.cwd, label));
  const text = el("span", "agent-text");
  const folder = row.cwd ? row.cwd.split("/").filter(Boolean).pop() : "";
  const details = [folder, elsewhere && t('in "{name}"', { name: elsewhere.name })].filter(Boolean).join(" · ");
  text.append(el("span", "session-name", label), el("span", "muted small", details));
  wrapper.append(box, avatar, text);
  item.append(wrapper);
  return item;
}

/** @param {boolean} [quiet] automatic re-read: an error is not shown */
async function refreshSessions(quiet = false) {
  try {
    renderSessions((await api(`/api/sessions${includeAgents()}`)).sessions);
  } catch (err) {
    if (!quiet) showToast(err.message);
  }
}

$("refresh-sessions").addEventListener("click", () => refreshSessions());

// Re-read of the list, grouped: several close requests make only one.
/** @type {number | undefined} */
let refreshSoonTimer;
function refreshSessionsSoon(delay = 1500) {
  clearTimeout(refreshSoonTimer);
  refreshSoonTimer = window.setTimeout(() => refreshSessions(true), delay);
}

// Agents launched in a terminal do not notify: the list is re-read regularly,
// only when the tab is visible (the server only re-reads the histories that changed).
const SESSIONS_POLL_MS = 25_000;
window.setInterval(() => {
  if (document.visibilityState === "visible") refreshSessions(true);
}, SESSIONS_POLL_MS);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshSessionsSoon(0);
});

try {
  if (localStorage.getItem("zo-session-filter") === "all") sessionFilter = "all";
} catch {
  // Storage unavailable: "Active" filter by default.
}
for (const input of /** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll('input[name="session-filter"]'))) {
  input.checked = input.value === sessionFilter;
  input.addEventListener("change", () => {
    sessionFilter = input.value;
    try {
      localStorage.setItem("zo-session-filter", sessionFilter);
    } catch {
      // Storage unavailable: the choice applies to this tab only.
    }
    drawSessions();
  });
}

$("chat-close").addEventListener("click", showIdle);

// --- tabs of an agent: Terminal / Discussion / Git / Files -----------------------------------------------

const gitView = mountGitView($("git-view"), {
  api, el, icon, confirmDialog, shortDate,
  icons: {
    refresh: "M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5",
    fetch: "M12 13v8M8 17l4 4 4-4M20.88 18.09A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.29",
    pull: "M12 3v12M7 10l5 5 5-5M5 21h14",
    push: "M12 21V9M7 14l5-5 5 5M5 3h14",
    branch: "M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9",
    plus: "M12 5v14M5 12h14",
    minus: "M5 12h14",
    undo: "M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11",
  },
});
const filesView = mountFilesView($("files-view"), {
  api, el, icon, confirmDialog, renderMarkdown,
  icons: {
    refresh: "M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5",
    search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35",
    folder: ICONS.workspace,
    file: ICONS.file,
    chevron: "M9 6l6 6-6 6",
    copy: "M9 9h11v11H9zM5 15H4V4h11v1",
    save: "M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM7 3v5h8V3M7 21v-7h10v7",
    edit: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z",
    close: ICONS.close,
  },
});
// Terminal: the agent's real Claude Code (xterm.js), the default tab.
const terminalView = mountTerminalView($("terminal-view"), { api, el });
// Discussion: the agent's conversation, formatted, read-only, to the right of the Terminal.
const discussionView = mountDiscussionView($("discussion-view"), {
  api, el, renderMarkdown,
  agentName: (c) => displayName({ sessionId: c.sessionId || c.resumeFrom, conversation: c }),
  isRunning: (c) => terminalView.isRunning(c.id),
  // The message goes to the Terminal, which we switch to in order to follow the reply.
  send: async (c, text) => {
    if (selectedId === c.id) setTab("terminal");
    await terminalView.type(c, text);
  },
});
// Shortcuts: the agent's ready-made prompts, and its workspace's (read-only here).
const shortcutsView = mountShortcutsView($("shortcuts-view"), {
  el, icon, confirmDialog,
  data: () => shortcutsData,
  workspaceOf,
  saveAgent: async (c, items) => {
    const keys = agentKeys(c);
    const owner = keys.find((key) => shortcutsData.agents[key]?.length) ?? keys[0];
    await saveShortcuts("agent", owner, items);
  },
  openWorkspace: (id) => openWorkspacePanel(id, "shortcuts"),
});
// Shortcuts panel over the Terminal (Ctrl+Shift), and its button in the Terminal bar.
const shortcutsPanel = mountShortcutsPanel(terminalView.screens, {
  el,
  active: () => activeTab === "terminal" && Boolean(selectedConversation()) && panel.hidden && !isDialogOpen() && !inTasksMode(),
  items: () => {
    const c = selectedConversation();
    return c ? panelItems(shortcutsData, c, workspaceOf(c)?.id ?? null) : [];
  },
  canSend: () => {
    const c = selectedConversation();
    return Boolean(c && terminalView.isRunning(c.id));
  },
  send: (item) => {
    const c = selectedConversation();
    if (!c) return;
    terminalView.type(c, item.shortcut.prompt)
      .then(() => terminalView.flash(t("Shortcut sent: {label}", { label: shortcutLabel(item.shortcut) })))
      .catch((err) => terminalView.flash(t("Could not send: {error}", { error: err instanceof Error ? err.message : err })));
  },
  manage: () => setTab("shortcuts"),
});
{
  const button = el("button", "terminal-shortcuts");
  /** @type {HTMLButtonElement} */ (button).type = "button";
  button.title = t("Shortcuts (hold Ctrl+Shift)");
  button.append(icon(SHORTCUT_ICONS.bolt), el("span", "", t("Shortcuts")));
  button.addEventListener("mousedown", (event) => event.preventDefault()); // the terminal keeps the keyboard
  button.addEventListener("click", () => shortcutsPanel.toggle());
  terminalView.bar.insertBefore(button, terminalView.stopButton);
}
let activeTab = "terminal";
/** Folder shown by the Files tab the last time it was visible (null: tab hidden). */
let filesShownFor = null;
const TABS = [["terminal", "terminal-view"], ["discussion", "discussion-view"], ["git", "git-view"], ["files", "files-view"],
  ["shortcuts", "shortcuts-view"], ["config", "config-view"]];
/** Agent whose Configuration tab is shown (null: tab hidden); redrawn when its settings change. */
let configShownFor = null;
/** @type {null | (() => void)} */
let configRefresh = null;

/** Agent shown, or null. */
const selectedConversation = () => (selectedId ? conversations.get(selectedId) ?? null : null);

/** Folder of the agent shown if it is in a git repository, otherwise null. */
function selectedGitFolder() {
  const c = selectedConversation();
  if (!c) return null;
  const row = sessionRows().find((r) => r.conversation === c);
  return c.git || row?.git ? c.cwd : null;
}

/** Tabs of an open agent: Git only for a repository; a screen loads when it is shown. */
function renderTabs() {
  const folder = selectedConversation()?.cwd ?? null;
  const gitFolder = selectedGitFolder();
  $("chat-tabs").hidden = !folder;
  $("tab-git").hidden = !gitFolder;
  if (!folder || (activeTab === "git" && !gitFolder)) activeTab = "terminal";
  for (const [tab, panelId] of TABS) {
    $(`tab-${tab}`).setAttribute("aria-selected", String(activeTab === tab));
    $(`tab-${tab}`).tabIndex = activeTab === tab ? 0 : -1;
    $(panelId).hidden = activeTab !== tab;
  }
  if (activeTab === "git" && gitFolder) gitView.open(gitFolder);
  // Files: loaded when arriving on the tab or when the agent changes, not on every status received.
  const filesFolder = activeTab === "files" ? folder : null;
  if (filesFolder && filesFolder !== filesShownFor) filesView.open(filesFolder);
  filesShownFor = filesFolder;
  const conversation = selectedConversation();
  if (activeTab === "terminal" && conversation) terminalView.open(conversation);
  else terminalView.hide();
  if (activeTab === "discussion" && conversation) discussionView.open(conversation);
  else discussionView.hide();
  if (activeTab === "shortcuts" && conversation) shortcutsView.open(conversation);
  else shortcutsView.hide();
  if (activeTab !== "terminal") shortcutsPanel.close();
  // Configuration: drawn when arriving on the tab or when the agent changes, then when its settings change.
  const configKey = activeTab === "config" && conversation ? conversation.sessionId || conversation.resumeFrom || conversation.id : null;
  if (configKey !== configShownFor) {
    configShownFor = configKey;
    avatarEditor = null; // fresh editor for each agent
    configRefresh = configKey ? () => renderAgentPanel(configKey) : null;
    configRefresh?.();
  }
}

/** @param {string} tab */
function setTab(tab) {
  activeTab = tab;
  renderTabs();
  $(`tab-${tab}`).focus();
}

for (const [tab] of TABS) $(`tab-${tab}`).addEventListener("click", () => setTab(tab));
// Keyboard: ← / → move from one visible tab to the next.
$("chat-tabs").addEventListener("keydown", (event) => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  const visible = TABS.map(([tab]) => tab).filter((tab) => !$(`tab-${tab}`).hidden);
  const step = event.key === "ArrowRight" ? 1 : -1;
  setTab(visible[(visible.indexOf(activeTab) + step + visible.length) % visible.length]);
});
// Ctrl+P: opens the Files tab on the search (instead of the browser's print).
document.addEventListener("keydown", (event) => {
  if (inTerminal(event) || inTasksMode()) return;
  if (event.key.toLowerCase() !== "p" || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
  if (!selectedConversation() || isDialogOpen()) return;
  event.preventDefault();
  if (activeTab !== "files") setTab("files");
  filesView.focusSearch();
});
// Unsaved changes: the browser asks for confirmation before leaving the page.
window.addEventListener("beforeunload", (event) => {
  if (filesView.hasUnsavedChanges()) event.preventDefault();
});

// --- new agent: choice of the folder it will work in --------------------------------------

/** @param {string} path */
const baseName = (path) => path.split("/").filter(Boolean).pop() || "/";

/**
 * "New agent" card: a current folder, chosen among the recent ones or by browsing;
 * the button creates the agent in that folder.
 */
/** @param {string} [workspaceId] workspace offered by default for the new agent */
function openNewAgentPanel(workspaceId) {
  panelView = { kind: "new-agent" };
  panelRefresh = null;
  const error = el("p", "form-error");
  error.hidden = true;
  let current = "";

  // Name: by default that of the working folder (numbered if already taken), which follows the chosen folder
  // as long as it has not been edited. Left empty, the agent still takes the folder name.
  const nameForm = el("form", "settings-section");
  const nameLabel = el("label", "settings-title", t("Name"));
  nameLabel.setAttribute("for", "new-agent-name");
  const nameInput = /** @type {HTMLInputElement} */ (el("input", "text-input"));
  Object.assign(nameInput, { id: "new-agent-name", maxLength: 80, autocomplete: "off" });
  let nameEdited = false;
  nameInput.addEventListener("input", () => (nameEdited = nameInput.value.trim() !== ""));
  nameForm.append(nameLabel, nameInput, el("p", "muted small", t("By default, the name of the working folder.")));
  // Workspace to put the agent in as soon as it is created (optional); offered only if there are any.
  const workspaceSection = el("div", "settings-section");
  const workspaceLabel = el("label", "settings-title", "Workspace");
  workspaceLabel.setAttribute("for", "new-agent-workspace");
  const workspaceSelect = /** @type {HTMLSelectElement} */ (el("select", "text-input"));
  workspaceSelect.id = "new-agent-workspace";
  workspaceSelect.append(new Option(t("No workspace"), ""), ...workspaces.map((w) => new Option(w.name, w.id)));
  workspaceSelect.value = workspaces.some((w) => w.id === workspaceId) ? workspaceId ?? "" : "";
  workspaceSection.append(workspaceLabel, workspaceSelect);
  workspaceSection.hidden = workspaces.length === 0;
  /** Default name for the chosen folder: its name, unique among the agents. */
  const defaultName = () => {
    const taken = [...sessionRows().map(customName), ...Object.values(agentSettings).flatMap((s) => [s.name, s.generated])];
    return uniqueName(current ? baseName(current) : "", /** @type {string[]} */ (taken.filter(Boolean)));
  };
  nameForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!create.disabled) create.click();
  });

  // Recent: the last folders where agents worked.
  const recentSection = el("div", "settings-section");
  const recentList = el("div", "recent-folders");
  recentList.append(el("p", "muted small", t("Loading…")));
  recentSection.append(el("h3", "settings-title", t("Recent")), recentList);
  /** @type {[HTMLElement, string][]} */
  let recentButtons = [];

  // Browse: editable path, breadcrumb, subfolders.
  const browseSection = el("div", "settings-section browse-section");
  const pathForm = el("form", "inline-field path-field");
  const pathInput = /** @type {HTMLInputElement} */ (el("input", "text-input"));
  Object.assign(pathInput, { spellcheck: false, autocomplete: "off", placeholder: t("/path/to/folder") });
  pathInput.setAttribute("aria-label", t("Folder path"));
  const go = el("button", "", t("Go"));
  /** @type {HTMLButtonElement} */ (go).type = "submit";
  pathForm.append(pathInput, go);
  pathForm.addEventListener("submit", (event) => {
    event.preventDefault();
    browse(pathInput.value);
  });
  const crumbs = el("nav", "breadcrumb");
  crumbs.setAttribute("aria-label", t("Current folder"));
  const dirList = el("ul", "folder-list");

  // New folder in the current folder: a link, which opens a field for its name.
  const newFolder = el("button", "link-button new-folder-toggle");
  /** @type {HTMLButtonElement} */ (newFolder).type = "button";
  newFolder.append(icon(ICONS.folderPlus), el("span", "", t("New folder here")));
  const newFolderForm = el("form", "inline-field new-folder-form");
  newFolderForm.hidden = true;
  const newFolderInput = /** @type {HTMLInputElement} */ (el("input", "text-input"));
  Object.assign(newFolderInput, { maxLength: 255, required: true, spellcheck: false, autocomplete: "off", placeholder: t("Folder name") });
  newFolderInput.setAttribute("aria-label", t("Name of the new folder"));
  const newFolderSubmit = /** @type {HTMLButtonElement} */ (el("button", "primary", t("Create")));
  newFolderSubmit.type = "submit";
  const newFolderCancel = el("button", "", t("Cancel"));
  /** @type {HTMLButtonElement} */ (newFolderCancel).type = "button";
  newFolderForm.append(newFolderInput, newFolderSubmit, newFolderCancel);
  /** @param {boolean} open */
  const toggleNewFolder = (open) => {
    newFolderForm.hidden = !open;
    newFolder.hidden = open;
    newFolderInput.value = "";
    if (open) newFolderInput.focus();
  };
  newFolder.addEventListener("click", () => toggleNewFolder(true));
  newFolderCancel.addEventListener("click", () => toggleNewFolder(false));
  newFolderInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation(); // Escape closes the field, not the card
      toggleNewFolder(false);
      newFolder.focus();
    }
  });
  newFolderForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    newFolderSubmit.disabled = true;
    try {
      // The created folder becomes the current folder: the agent will work in it.
      const created = await api("/api/folders/create", { parent: current, name: newFolderInput.value });
      toggleNewFolder(false);
      await browse(created.path);
    } catch (err) {
      showPanelError(error, err);
      newFolderInput.focus();
    } finally {
      newFolderSubmit.disabled = false;
    }
  });
  browseSection.append(el("h3", "settings-title", t("Browse")), pathForm, crumbs, dirList, newFolder, newFolderForm);

  // Footer: the chosen folder and the creation.
  const chosen = el("p", "chosen-folder");
  const back = el("button", "", t("Back"));
  /** @type {HTMLButtonElement} */ (back).type = "button";
  back.addEventListener("click", openCreatePanel);
  const create = /** @type {HTMLButtonElement} */ (el("button", "primary", t("Create the agent")));
  create.type = "button";
  create.disabled = true;
  create.addEventListener("click", async () => {
    create.disabled = true;
    try {
      await newConversation(current, nameInput.value.trim() || defaultName(), workspaceSelect.value || undefined);
    } catch (err) {
      showPanelError(error, err);
      create.disabled = false;
    }
  });
  const footer = el("div", "panel-actions");
  footer.append(chosen, back, create);

  /** @param {string} path */
  async function browse(path) {
    let listing;
    try {
      listing = await api(`/api/folders?path=${encodeURIComponent(path)}`);
    } catch (err) {
      showPanelError(error, err);
      return;
    }
    error.hidden = true;
    current = listing.path;
    pathInput.value = listing.path;

    // Breadcrumb: each segment leads back to its folder.
    const parts = listing.path.split("/").filter(Boolean);
    const segments = [["/", "/"], ...parts.map((part, i) => [part, `/${parts.slice(0, i + 1).join("/")}`])];
    crumbs.replaceChildren(...segments.map(([label, target], i) => {
      const crumb = el("button", i === segments.length - 1 ? "crumb current" : "crumb", label);
      /** @type {HTMLButtonElement} */ (crumb).type = "button";
      if (i === segments.length - 1) crumb.setAttribute("aria-current", "location");
      crumb.addEventListener("click", () => browse(target));
      return crumb;
    }));

    // Subfolders: a click goes into them.
    const items = [];
    if (listing.parent) items.push(folderEntry(t("Parent folder"), listing.parent, ICONS.up));
    const join = (/** @type {string} */ name) => (listing.path.endsWith("/") ? listing.path + name : `${listing.path}/${name}`);
    items.push(...listing.dirs.map((/** @type {string} */ name) => folderEntry(name, join(name), ICONS.workspace)));
    if (listing.dirs.length === 0) items.push(el("li", "muted small folder-empty", t("No subfolders.")));
    if (listing.truncated) items.push(el("li", "muted small folder-empty", t("List truncated: type the path to go further.")));
    dirList.replaceChildren(...items);
    dirList.scrollTop = 0;

    for (const [button, folderPath] of recentButtons) button.setAttribute("aria-pressed", String(folderPath === current));
    chosen.replaceChildren(el("span", "muted small", `${t("Folder:")} `), el("strong", "", baseName(current)));
    chosen.title = current;
    create.textContent = t('Create the agent in "{folder}"', { folder: clip(baseName(current), 30) });
    create.disabled = false;
    if (!nameEdited) {
      nameInput.value = defaultName();
      nameInput.placeholder = nameInput.value;
    }
  }

  /**
   * @param {string} label
   * @param {string} target
   * @param {string} iconPath
   */
  function folderEntry(label, target, iconPath) {
    const item = el("li");
    const button = el("button", "folder-entry");
    /** @type {HTMLButtonElement} */ (button).type = "button";
    button.append(icon(iconPath), el("span", "", label));
    button.addEventListener("click", () => browse(target));
    item.append(button);
    return item;
  }

  showPanel(t("New agent"), el("p", "muted", t("Choose the folder the agent will work in.")), error, nameForm, workspaceSection, recentSection, browseSection, footer);

  // Recent: 5 first, then 10 more on each "Show more".
  let recentLimit = 5;
  const more = el("button", "link-button", t("Show more recent folders"));
  /** @type {HTMLButtonElement} */ (more).type = "button";
  more.hidden = true;
  more.addEventListener("click", () => {
    recentLimit += 10;
    loadRecents().catch((err) => showPanelError(error, err));
  });
  recentSection.append(more);

  async function loadRecents() {
    const { folders, more: hasMore } = await api(`/api/folders/recent?limit=${recentLimit}`);
    recentButtons = folders.map((/** @type {any} */ folder) => {
      const card = el("button", "recent-folder");
      /** @type {HTMLButtonElement} */ (card).type = "button";
      card.title = folder.path;
      card.style.setProperty("--agent-hue", String(agentHue(`folder:${folder.path}`)));
      const badge = el("span", "recent-folder-icon");
      badge.append(icon(ICONS.workspace));
      const text = el("span", "agent-text");
      const agents = tn(folder.agents, "{n} agent", "{n} agents");
      text.append(
        el("strong", "recent-folder-name", baseName(folder.path)),
        el("span", "muted small recent-folder-path", folder.path),
        el("span", "muted small", [folder.lastUsed && shortDate(folder.lastUsed), agents].filter(Boolean).join(" · ")),
      );
      card.append(badge, text);
      card.addEventListener("click", () => browse(folder.path));
      return [card, folder.path];
    });
    if (recentButtons.length) recentList.replaceChildren(...recentButtons.map(([card]) => card));
    else recentList.replaceChildren(el("p", "muted small", t("No recent folder: browse below.")));
    for (const [card, folderPath] of recentButtons) card.setAttribute("aria-pressed", String(folderPath === current));
    more.hidden = !hasMore;
    return folders;
  }

  // Starting point: the most recent folder, otherwise the server's default folder.
  loadRecents()
    .then((folders) => browse(folders[0]?.path || defaultCwd))
    .catch((err) => {
      recentList.replaceChildren();
      showPanelError(error, err);
      return browse(defaultCwd);
    });
}

// --- agent settings: custom name, deleted agents -------------------------------------------

/** @type {Record<string, {name?: string, hidden?: {label: string, cwd: string, at: number}}>} */
let agentSettings = {};

/** @param {typeof agentSettings} settings */
function setAgentSettings(settings) {
  agentSettings = settings;
  drawSessions();
  renderHeader();
  panelRefresh?.();
  configRefresh?.();
}

/**
 * Name given to the agent, if it has one (saved under one of its ids).
 *
 * @param {any} row
 */
const givenName = (row) => rowKeys(row).map((key) => agentSettings[key]?.name).find(Boolean);
/** Role of the agent (given to the other agents in their directory), or "". @param {any} row */
const agentRole = (row) => rowKeys(row).map((key) => agentSettings[key]?.role).find(Boolean) ?? "";

/**
 * Name generated by the server for an unnamed agent ("Agile otter"), unique and stable.
 *
 * @param {any} row
 */
const generatedName = (row) => rowKeys(row).map((key) => agentSettings[key]?.generated).find(Boolean);

/**
 * Name of the agent: the one it was given, otherwise its generated name. The last message becomes the subtitle.
 *
 * @param {any} row
 */
const customName = (row) => givenName(row) || generatedName(row);

/** @param {any} row */
const displayName = (row) => customName(row) || agentLabel(row);

/**
 * Claude settings of the agent (model, permissions, Chrome), saved under one of its ids.
 *
 * @param {any} row
 * @returns {{model?: string, permissionMode?: string, chrome?: boolean}}
 */
const agentOptions = (row) => rowKeys(row).map((key) => agentSettings[key]?.options).find(Boolean) ?? {};

/**
 * Avatar chosen for the agent (abbreviation, animal or image), saved under one of its ids.
 *
 * @param {any} row
 * @returns {{abbr?: string, kind?: string, animal?: string, image?: string}}
 */
const agentAvatar = (row) => rowKeys(row).map((key) => agentSettings[key]?.avatar).find(Boolean) ?? {};

/** Server's default Claude settings (command line). */
let claudeDefaults = { model: null, permissionMode: null, chrome: false };
const MODEL_LABELS = { opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" };
const PERMISSION_LABELS = {
  auto: t("Auto (Claude decides)"),
  default: t("Manual (it asks)"),
  acceptEdits: t("Edits accepted"),
  plan: t("Plan (read-only)"),
};

/** @param {any} row */
const isHidden = (row) => rowKeys(row).some((key) => agentSettings[key]?.hidden);

/** Deleted agents, from newest to oldest, with what is needed to show them. */
function hiddenAgents() {
  return Object.entries(agentSettings)
    .filter(([, settings]) => settings.hidden)
    .map(([key, settings]) => ({
      key,
      name: settings.name || settings.generated || settings.hidden?.label || t("Agent {id}", { id: key.slice(0, 8) }),
      customName: settings.name || settings.generated,
      avatar: settings.avatar,
      cwd: settings.hidden?.cwd || "",
      at: settings.hidden?.at || 0,
    }))
    .sort((a, b) => b.at - a.at);
}

/** @param {string} key */
const findRow = (key) => sessionRows().find((row) => rowKeys(row).includes(key));

/**
 * Error message shown in the central card.
 *
 * @param {HTMLElement} target
 * @param {unknown} err
 */
function showPanelError(target, err) {
  target.textContent = err instanceof Error ? err.message : String(err);
  target.hidden = false;
}

/**
 * Renames the agent; an empty name restores the generated name. Claude Code only takes its name at launch: if its
 * terminal is open, the server closes it (after confirmation here), and it will be reopened under the new name.
 *
 * @param {any} row
 * @param {string} name
 */
async function renameAgent(row, name) {
  const c = row.conversation;
  // Name the agent will have: the one typed (spaces collapsed as the server does), otherwise its generated name.
  const next = name.trim().replace(/\s+/g, " ") || generatedName(row) || "";
  if (c && terminalView.isRunning(c.id) && next !== (customName(row) ?? "")) {
    const confirmed = await confirmDialog({
      title: t("Close Claude Code to rename it?"),
      message: t("The other agents find this one by its session name, which Claude Code only takes at launch. Its terminal will be closed; reopen it so that it carries the new name (the discussion resumes where it was).")
        + (c.busy ? `\n\n${t("It is working: its current turn will be interrupted.")}` : ""),
      confirmLabel: t("Rename and close"),
      danger: Boolean(c.busy),
    });
    if (!confirmed) return;
  }
  const keys = name.trim()
    ? [rowKeys(row)[0]]
    : rowKeys(row).filter((key) => agentSettings[key]?.name); // clear the name, under all its ids
  let settings = agentSettings;
  for (const key of keys) settings = (await api("/api/agents/rename", { agent: key, name })).agents;
  setAgentSettings(settings);
}

/**
 * Removes the agent from ziggy-one, after confirmation. Its Claude Code history is kept.
 *
 * @param {any} row
 */
async function deleteAgent(row) {
  const name = displayName(row);
  const c = row.conversation;
  const started = Boolean(row.sessionId);
  const details = started
    ? t("Claude is stopped if it runs in ziggy-one, and the agent leaves the list, its workspace and the pins.")
      + (row.active ? ` ${t("It stays active in your terminal.")}` : "")
      + `\n\n${t('Its Claude Code history is kept: you can restore it from "Deleted agents".')}`
    : t("This agent has not started yet: it is simply removed.");
  const confirmed = await confirmDialog({
    title: t('Delete "{name}"?', { name: clip(name, 60) }),
    message: details,
    confirmLabel: t("Delete"),
    danger: true,
  });
  if (!confirmed) return;
  const keys = rowKeys(row);
  if (started) {
    const result = await api("/api/agents/delete", {
      agent: keys[0], keys, conversation: c?.id, label: name, cwd: row.cwd || "",
    });
    setAgentSettings(result.agents);
  } else if (c) {
    await api(`/api/conversations/${c.id}/delete`, {});
  }
  savePins(pins.filter((pin) => !keys.includes(pin)));
  closePanel();
}


/** @type {ReturnType<typeof createAvatarEditor> | null} */
let avatarEditor = null;
/** Role being typed: the panel is rebuilt on every settings change. @type {{key: string, value: string} | null} */
let roleDraft = null;

/** @param {string} key */
function renderAgentPanel(key) {
  const row = findRow(key);
  const view = $("config-view");
  if (!row) {
    view.replaceChildren(el("p", "muted config-missing", t("This agent is no longer in the list.")));
    return;
  }
  const c = row.conversation;
  const name = displayName(row);
  const state = agentState(row);
  const error = el("p", "form-error");
  error.hidden = true;

  // Who this agent is: avatar, name, state.
  const summary = el("div", `agent-summary session state-${state}`);
  const hue = String(agentHue(row.sessionId || c?.id || name));
  summary.style.setProperty("--agent-hue", hue);
  const letter = avatarLetter(customName(row), row.cwd, name);
  const avatar = avatarNode("agent-avatar big-avatar", agentAvatar(row), letter);
  avatar.append(el("span", "agent-dot"));

  // Avatar: the same editor from one render to the next, to keep a crop or a search in progress.
  if (!avatarEditor) {
    avatarEditor = createAvatarEditor({
      el,
      save: async (chosen, image) => {
        const agent = rowKeys(findRow(key) ?? row)[0]; // the discussion may have received its session in the meantime
        setAgentSettings((await api("/api/agents/avatar", { agent, avatar: chosen, image })).agents);
      },
      onError: (err) => showPanelError(error, err),
    });
  }
  avatarEditor.node.style.setProperty("--agent-hue", hue);
  avatarEditor.update({
    avatar: agentAvatar(row),
    fallback: letter,
    ownAnimal: animalOf(generatedName(row)),
    suggestions: abbrSuggestions(customName(row), row.cwd),
  });
  const summaryText = el("span", "agent-text");
  const stateLabel = AGENT_STATE_LABELS[state];
  summaryText.append(el("strong", "agent-summary-name", name));
  if (customName(row)) summaryText.append(el("span", "last-message", agentLabel(row))); // the last message stays visible
  summaryText.append(el("span", "muted small", stateLabel.charAt(0).toUpperCase() + stateLabel.slice(1)));
  summary.append(avatar, summaryText);

  // Name.
  const nameForm = el("form", "settings-section");
  const nameInput = /** @type {HTMLInputElement} */ (el("input", "text-input"));
  Object.assign(nameInput, { id: "agent-name", value: givenName(row) || "", placeholder: generatedName(row) || agentLabel(row), maxLength: 80, autocomplete: "off" });
  const nameLabel = el("label", "settings-title", t("Name"));
  nameLabel.setAttribute("for", "agent-name");
  const rename = el("button", "primary", t("Rename"));
  /** @type {HTMLButtonElement} */ (rename).type = "submit";
  const nameRow = el("div", "inline-field");
  nameRow.append(nameInput, rename);
  nameForm.append(nameLabel, nameRow, el("p", "muted small", t("The other agents find it under this name (Claude Code's ListAgents and SendMessage tools).")));
  // Emptying the field then submitting removes the name: the agent takes back its generated name.
  nameForm.addEventListener("submit", (event) => {
    event.preventDefault();
    renameAgent(row, nameInput.value).catch((err) => showPanelError(error, err));
  });

  // Role: what can be entrusted to it. The other agents read it in their directory when their session starts.
  const roleForm = el("form", "settings-section role-section");
  const roleLabel = el("label", "settings-title", t("Role"));
  roleLabel.setAttribute("for", "agent-role");
  const roleInput = /** @type {HTMLTextAreaElement} */ (el("textarea", "text-input"));
  const savedRole = agentRole(row);
  Object.assign(roleInput, {
    id: "agent-role", rows: 3, maxLength: 600,
    value: roleDraft?.key === key ? roleDraft.value : savedRole,
    placeholder: t("E.g.: Sends and reads Teams and Outlook messages; asks for approval before sending anything."),
  });
  const saveRole = /** @type {HTMLButtonElement} */ (el("button", "primary", t("Save the role")));
  saveRole.type = "submit";
  saveRole.disabled = roleInput.value.trim() === savedRole;
  roleInput.addEventListener("input", () => {
    roleDraft = { key, value: roleInput.value };
    saveRole.disabled = roleInput.value.trim() === savedRole;
  });
  roleForm.append(roleLabel, roleInput, saveRole, el("p", "muted small",
    t("The other agents launched by Ziggy know it by its name and this role, and know how to write to it (SendMessage). Taken into account at the next start of their session (or /clear).")));
  roleForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    saveRole.disabled = true;
    try {
      const agent = rowKeys(findRow(key) ?? row)[0];
      const result = await api("/api/agents/role", { agent, role: roleInput.value });
      roleDraft = null;
      setAgentSettings(result.agents);
    } catch (err) {
      saveRole.disabled = false;
      showPanelError(error, err);
    }
  });

  // Workspace.
  const workspaceSection = el("div", "settings-section");
  const workspaceLabel = el("label", "settings-title", "Workspace");
  workspaceLabel.setAttribute("for", "agent-workspace");
  workspaceSection.append(workspaceLabel);
  const current = workspaces.find((w) => memberKey(w, row) !== undefined);
  if (workspaces.length === 0) {
    const create = el("button", "link-button", t("Create a workspace"));
    /** @type {HTMLButtonElement} */ (create).type = "button";
    create.addEventListener("click", openWorkspaceForm);
    workspaceSection.append(el("p", "muted small", t("No workspace yet.")), create);
  } else {
    const select = /** @type {HTMLSelectElement} */ (el("select", "text-input"));
    select.id = "agent-workspace";
    select.append(new Option(t("No workspace"), ""), ...workspaces.map((w) => new Option(w.name, w.id)));
    select.value = current?.id ?? "";
    select.addEventListener("change", async () => {
      select.disabled = true;
      try {
        // Adding to a workspace removes from the old one; "None" only removes.
        const result = select.value
          ? await api(`/api/workspaces/${select.value}/add`, { agent: rowKeys(row)[0] })
          : await api(`/api/workspaces/${current?.id}/remove`, { agent: current && memberKey(current, row) });
        setWorkspaces(result.workspaces);
      } catch (err) {
        select.value = current?.id ?? "";
        select.disabled = false;
        showPanelError(error, err);
      }
    });
    workspaceSection.append(select);
  }

  // Claude: model, permissions, Chrome — each list recalls the server's default value.
  const claudeSection = el("div", "settings-section");
  const options = agentOptions(row);
  const permissionLabel = (/** @type {string | null} */ mode) => PERMISSION_LABELS[mode ?? "default"] ?? mode;
  /** @type {[string, string, [string, string][]][]} */
  const fields = [
    ["model", t("Model"), [["", t("Default ({value})", {
      value: claudeDefaults.model ? MODEL_LABELS[claudeDefaults.model] ?? claudeDefaults.model : t("Claude Code's"),
    })], ...Object.entries(MODEL_LABELS)]],
    ["permissionMode", t("Permissions"), [["", t("Default ({value})", { value: permissionLabel(claudeDefaults.permissionMode) })],
      ...Object.entries(PERMISSION_LABELS)]],
    ["chrome", "Claude in Chrome", [["", t("Default ({value})", { value: claudeDefaults.chrome ? t("enabled") : t("disabled") })],
      ["true", t("Enabled (drives your Chrome)")], ["false", t("Disabled")]]],
  ];
  const selects = /** @type {Record<string, HTMLSelectElement>} */ ({});
  const grid = el("div", "settings-grid");
  for (const [name, label, choices] of fields) {
    const select = /** @type {HTMLSelectElement} */ (el("select", "text-input"));
    select.id = `agent-option-${name}`;
    select.append(...choices.map(([value, text]) => new Option(text, value)));
    select.value = options[name] === undefined ? "" : String(options[name]);
    const fieldLabel = el("label", "settings-field-label", label);
    fieldLabel.setAttribute("for", select.id);
    grid.append(fieldLabel, select);
    selects[name] = select;
    select.addEventListener("change", async () => {
      const chosen = {
        model: selects.model.value || null,
        permissionMode: selects.permissionMode.value || null,
        chrome: selects.chrome.value === "" ? null : selects.chrome.value === "true",
      };
      try {
        setAgentSettings((await api("/api/agents/options", { agent: rowKeys(row)[0], options: chosen })).agents);
      } catch (err) {
        showPanelError(error, err);
      }
    });
  }
  claudeSection.append(
    el("h3", "settings-title", "Claude"),
    grid,
    el("p", "muted small", t("Changes apply the next time Claude Code opens in the Terminal (close it then reopen it).")),
  );

  // Information.
  const infoSection = el("div", "settings-section");
  infoSection.append(el("h3", "settings-title", t("Information")));
  const info = el("dl", "settings-info");
  const addInfo = (/** @type {string} */ label, /** @type {string} */ value) => {
    if (value) info.append(el("dt", "", label), el("dd", "", value));
  };
  addInfo(t("Folder"), row.cwd || "");
  addInfo(t("Session"), row.sessionId || t("not started yet"));
  addInfo(t("Active in"), c && row.active ? t("ziggy-one and a terminal") : c ? "ziggy-one" : row.active ? t("a terminal") : "");
  addInfo(t("Activity"), row.updatedAt ? new Date(row.updatedAt * 1000).toLocaleString(locale(), { dateStyle: "medium", timeStyle: "short" }) : "");
  addInfo(t("Cost"), typeof row.costUsd === "number" ? t("${cost}", { cost: row.costUsd.toFixed(4) }) : "");
  const context = agentContext(row);
  addInfo(t("Context"), context ? contextText(context) : "");
  infoSection.append(info);

  // Deletion.
  const dangerSection = el("div", "settings-section danger-zone");
  const remove = el("button", "danger", t("Delete the agent"));
  /** @type {HTMLButtonElement} */ (remove).type = "button";
  remove.addEventListener("click", () => deleteAgent(row).catch((err) => showPanelError(error, err)));
  dangerSection.append(
    el("h3", "settings-title", t("Delete")),
    el("p", "muted small", t("Removes the agent from ziggy-one. Its Claude Code history is kept and it can be restored.")),
    remove,
  );

  const focused = avatarEditor.node.contains(document.activeElement) ? /** @type {HTMLElement} */ (document.activeElement) : null;
  const typingRole = document.activeElement?.id === "agent-role";
  const scroll = view.firstElementChild?.scrollTop ?? 0;
  const body = el("div", "panel-body config-body");
  body.append(summary, error, nameForm, roleForm, avatarEditor.node, workspaceSection, claudeSection, infoSection, dangerSection);
  view.replaceChildren(body);
  body.scrollTop = scroll; // rebuilt on every settings change: keep the position
  focused?.focus();
  if (typingRole) {
    roleInput.focus();
    roleInput.setSelectionRange(roleInput.value.length, roleInput.value.length);
  }
}

function openDeletedPanel() {
  panelView = { kind: "deleted" };
  panelRefresh = renderDeletedPanel;
  renderDeletedPanel();
}

function renderDeletedPanel() {
  const items = hiddenAgents();
  if (items.length === 0) {
    closePanel();
    return;
  }
  const error = el("p", "form-error");
  error.hidden = true;
  const list = el("ul", "picker-list");
  for (const agent of items) {
    const item = el("li", "deleted-item");
    item.style.setProperty("--agent-hue", String(agentHue(agent.key)));
    const avatar = avatarNode("agent-avatar small-avatar", agent.avatar, avatarLetter(agent.customName, agent.cwd, agent.name));
    const text = el("span", "agent-text");
    const folder = agent.cwd.split("/").filter(Boolean).pop() || "";
    const details = [folder, agent.at && t("deleted {date}", { date: shortDate(agent.at) })].filter(Boolean).join(" · ");
    text.append(el("span", "session-name", agent.name), el("span", "muted small", details));
    const restore = el("button", "", t("Restore"));
    /** @type {HTMLButtonElement} */ (restore).type = "button";
    restore.setAttribute("aria-label", t('Restore "{name}"', { name: agent.name }));
    restore.addEventListener("click", async () => {
      try {
        setAgentSettings((await api("/api/agents/restore", { agent: agent.key })).agents);
        refreshSessions(); // it may be older than the sessions already loaded
      } catch (err) {
        showPanelError(error, err);
      }
    });
    item.append(avatar, text, restore);
    list.append(item);
  }
  const done = el("button", "primary", t("Done"));
  /** @type {HTMLButtonElement} */ (done).type = "button";
  done.addEventListener("click", closePanel);
  const footer = el("div", "panel-actions");
  footer.append(done);
  const intro = el("p", "muted small", t("These agents were removed from ziggy-one. Their Claude Code history is intact."));
  showPanel(t("Deleted agents"), intro, error, list, footer);
}

// --- notifications: agent finishing its turn in the Terminal (Claude Code Stop hook) ------------------
// Only for an agent that is not in view (tab in the background, or another agent shown).
// The tab title counts the agents to check; each notification has a label (tag):
// with several tabs open, it shows only once.

const NOTIFY_KEY = "zo-notifications";
/** @type {Set<string>} agents that finished a turn not yet checked */
const unseenConversations = new Set();
const notifyToggle = /** @type {HTMLInputElement} */ ($("notify-toggle"));

const notificationsSupported = () => "Notification" in window;
const notificationsOn = () => {
  try {
    return notificationsSupported() && Notification.permission === "granted" && localStorage.getItem(NOTIFY_KEY) === "on";
  } catch {
    return false;
  }
};

/** @param {string} id */
const isWatched = (id) => id === selectedId && document.visibilityState === "visible" && chatCard.hidden === false;

/** Counter in the tab title: agents to check. */
function updateAttention() {
  const count = unseenConversations.size;
  const waiting = [...conversations.values()].filter((c) => c.waiting).length;
  const parts = [waiting && `⏳${waiting}`, count && String(count)].filter(Boolean);
  document.title = parts.length ? `(${parts.join(" · ")}) Ziggy One` : "Ziggy One";
}

/** @param {string} id */
function markSeen(id) {
  if (unseenConversations.delete(id)) {
    updateAttention();
    drawSessions();
  }
}

/** @param {string} conversationId */
function conversationName(conversationId) {
  const c = conversations.get(conversationId);
  return c ? displayName({ sessionId: c.sessionId || c.resumeFrom, conversation: c }) : t("An agent");
}

/**
 * @param {string} title
 * @param {string} body
 * @param {string} tag a notification replaces the previous one with the same tag (and only shows once)
 * @param {string} conversationId agent opened on click
 */
function notify(title, body, tag, conversationId) {
  if (!notificationsOn()) return;
  let notification;
  try {
    notification = new Notification(title, { body: clip(body, 180), tag });
  } catch (error) {
    showNotifyHint(t("Notification refused by the browser: {error}", { error: error instanceof Error ? error.message : error }));
    return;
  }
  notification.addEventListener("error", () => {
    showNotifyHint(t("The browser could not show the notification: check the system's notification settings."));
  });
  notification.addEventListener("click", () => {
    window.focus();
    if (conversations.has(conversationId)) selectConversation(conversationId);
    notification.close();
  });
}

/**
 * End of a turn in the Terminal: "something new" on the agent, and a notification if it is not in view.
 *
 * @param {{conversation: string, summary: string}} data
 */
function onTurnEnd(data) {
  refreshSessionsSoon(); // last message, cost and context of the list have changed
  if (isWatched(data.conversation)) return;
  unseenConversations.add(data.conversation);
  updateAttention();
  drawSessions();
  notify(t("{name} has finished", { name: conversationName(data.conversation) }), data.summary || "", `zo-done-${data.conversation}`, data.conversation);
}

// Coming back to the tab clears the "something new" of the agent shown.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && selectedId) markSeen(selectedId);
});

/** @param {string} message */
function showNotifyHint(message) {
  const hint = $("notify-hint");
  hint.textContent = message;
  hint.hidden = !message;
}

function syncNotifyToggle() {
  notifyToggle.checked = notificationsOn();
  if (!notificationsSupported()) {
    notifyToggle.disabled = true;
    showNotifyHint(t("This browser does not support notifications."));
  } else if (Notification.permission === "denied") {
    showNotifyHint(t("Blocked by the browser: allow them in the site settings, then reload the page."));
  } else {
    showNotifyHint("");
  }
}

notifyToggle.addEventListener("change", async () => {
  let enabled = notifyToggle.checked;
  /** @type {NotificationPermission} */
  let answer = Notification.permission;
  if (enabled && answer !== "granted") {
    answer = await Notification.requestPermission();
    enabled = answer === "granted";
  }
  try {
    localStorage.setItem(NOTIFY_KEY, enabled ? "on" : "off");
  } catch {
    // Storage unavailable: the choice applies to this tab only.
  }
  syncNotifyToggle();
  if (notifyToggle.checked !== enabled) {
    showNotifyHint(t("This browser does not save the choice: notifications stay off."));
  } else if (answer === "default") {
    // Request closed, or hidden by Chrome (small crossed-out bell in the address bar).
    showNotifyHint(t("Chrome did not grant permission: click the icon to the left of the address, Notifications → Allow, then turn it back on."));
  }
  if (enabled) notify(t("Notifications on"), t("Ziggy One will notify you when an agent finishes its turn."), "zo-test", "");
});
syncNotifyToggle();

// --- real-time stream ------------------------------------------------------------

function connect() {
  // EventSource reconnects by itself if the server restarts.
  const source = new EventSource("/api/events");
  const on = (/** @type {string} */ name, /** @type {(data: any) => void} */ handler) =>
    source.addEventListener(name, (e) => handler(JSON.parse(/** @type {MessageEvent} */ (e).data)));
  // Stream cut (server stopped or relaunched), then resumed: did the server restart?
  let interrupted = false;
  source.addEventListener("error", () => {
    if (!interrupted && serverInfo?.restart) {
      serverInfo.restart.phase = "restarting";
      renderRestartBanner();
    }
    interrupted = true;
  });
  source.addEventListener("open", () => {
    if (interrupted) checkServerAfterReconnect();
    interrupted = false;
  });
  on("server_restart", (data) => {
    if (serverInfo) Object.assign(serverInfo, { restart: data.state, lastRestart: data.last });
    // Terminals reopened after the reload: the restart confirmation is completed.
    if (confirmingRestart && !data.state && data.last?.completedAt >= (serverInfo?.startedAt ?? Infinity)) showRestartDone();
    else renderRestartBanner();
    if (panelView?.kind === "settings") renderSettingsPanel();
  });
  on("usage", renderUsage);
  on("status", (status) => {
    if (panelView?.kind === "settings") window.setTimeout(renderSettingsPanel); // agent state changed
    const wasWaiting = conversations.get(status.id)?.waiting;
    storeConversation(status);
    if (status.waiting && status.waiting !== wasWaiting && !isWatched(status.id)) {
      notify(t("{name} is waiting for your reply", { name: conversationName(status.id) }),
        t("It is waiting for {what}.", { what: WAITING_LABELS[status.waiting] ?? t("your reply") }),
        `zo-waiting-${status.id}`, status.id);
    }
    if (status.waiting !== wasWaiting) updateAttention();
    if (status.id === selectedId) renderHeader();
    drawSessions();
  });
  on("turn_end", onTurnEnd);
  on("shell", (data) => discussionView.onShell(data)); // "!! command" of the Discussion
  on("terminal", (data) => terminalView.onData(data));
  on("terminal_status", (data) => {
    terminalView.onStatus(data);
    if (panelView?.kind === "settings") loadTerminalStats();
    discussionView.refreshComposer();
    shortcutsPanel.refresh();
    if (data.conversation === selectedId) renderHeader();
  });
  on("conversation_removed", (data) => {
    conversations.delete(data.conversation);
    if (selectedId === data.conversation) showIdle();
    else drawSessions();
    refreshSessions();
  });
  on("workspaces", setWorkspaces);
  on("kanbans", (list) => kanban.onBoards(list));
  on("kanban_board", (data) => kanban.onBoard(data));
  on("kanban_workspaces", (list) => kanban.onWorkspaces(list));
  on("kanban_pins", (list) => kanban.onPins(list));
  // Pins changed in another tab (or here: same list, nothing moves).
  on("pins", (/** @type {string[]} */ list) => {
    pins = list;
    drawSessions();
  });
  on("agents", setAgentSettings);
  on("shortcuts", setShortcuts);
  // Language changed (here or in another tab): the page reloads in the new language.
  on("settings", (/** @type {{language: string}} */ settings) => {
    globalSettings = settings;
    if (settings.language !== currentLanguage()) location.reload();
  });
}

// --- modes: Agents or Tasks (Kanban boards) --------------------------------------
// The layout carries the mode (class mode-tasks): the CSS shows one or the other, the agents'
// logic does not depend on it. The mode is remembered by this browser and visible in the address (#tasks).

const MODE_KEY = "zo-mode";
const kanban = mountKanban(
  { list: $("board-list"), title: $("board-title"), body: $("board-body"), settings: $("board-settings"), close: $("board-close"), create: $("new-board") },
  {
    api, el, icon, confirmDialog, renderMarkdown, initialOf, shortDate,
    autoHue: agentHue,
    hues: WORKSPACE_HUES,
    icons: {
      pin: ICONS.pin, gear: ICONS.gear, close: ICONS.close, file: ICONS.file, workspace: ICONS.workspace,
      plus: "M12 5v14M5 12h14",
      board: "M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v6h-4z",
    },
  },
);

const inTasksMode = () => layout.classList.contains("mode-tasks");

/** @param {"agents" | "tasks"} mode */
function setMode(mode) {
  layout.classList.toggle("mode-tasks", mode === "tasks");
  for (const input of /** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll('input[name="mode"]'))) {
    input.checked = input.value === mode;
  }
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // Storage unavailable: the mode applies to this tab only.
  }
  // Address: "/" in Agents mode; in Tasks mode, that of the open ticket (/t/42) or "/#tasks".
  const onTicket = ticketNumberFromPath(location.pathname) !== null;
  const url = mode === "agents" ? "/" : onTicket ? location.pathname : "/#tasks";
  if (`${location.pathname}${location.hash}` !== url) history.replaceState(null, "", url);
}

// Link to a ticket (/t/42), wherever it is (description of a ticket…): opened here, without
// reloading the page or opening a tab.
document.addEventListener("click", (event) => {
  const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (!link || event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) return;
  const url = new URL(/** @type {HTMLAnchorElement} */ (link).href, location.href);
  const number = url.origin === location.origin ? ticketNumberFromPath(url.pathname) : null;
  if (number === null) return;
  event.preventDefault();
  setMode("tasks");
  kanban.openNumber(number);
});

for (const input of /** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll('input[name="mode"]'))) {
  input.addEventListener("change", () => setMode(/** @type {"agents" | "tasks"} */ (input.value)));
}
// "#taches" is the former (French) address of the Tasks mode: still accepted, for saved links.
const isTasksHash = () => location.hash === "#tasks" || location.hash === "#taches";
window.addEventListener("hashchange", () => setMode(isTasksHash() ? "tasks" : "agents"));
{
  let saved = null;
  try {
    saved = localStorage.getItem(MODE_KEY);
  } catch {
    // Storage unavailable.
  }
  const onTicket = ticketNumberFromPath(location.pathname) !== null;
  setMode(onTicket || isTasksHash() || (!location.hash && saved === "tasks") ? "tasks" : "agents");
}

async function init() {
  try {
    const state = await api(`/api/state${includeAgents()}`);
    serverInfo = state.server ?? null;
    renderAccount(state.account);
    renderUsage(state.usage);
    defaultCwd = state.defaultCwd;
    for (const status of state.conversations) storeConversation(status);
    updateAttention(); // agents already waiting for your reply: in the tab title
    confirmRestart(); // page reloaded after a restart: confirmation banner
    renderRestartBanner(); // restart already requested (another tab): waiting banner
    terminalView.setRunning(state.terminals ?? []);
    discussionView.refreshComposer();
    workspaces = state.workspaces ?? []; // missing if the server is from an earlier version
    loadPins(state.pins ?? []);
    shortcutsData = { ...emptyShortcuts(), ...(state.shortcuts ?? {}) };
    globalSettings = state.settings ?? globalSettings;
    agentSettings = state.agents ?? {};
    claudeDefaults = state.defaults ?? claudeDefaults;
    renderSessions(state.sessions);
    // The workspaces' agents and the pins taken over from the browser were not known at the time of the
    // request: ask for them again, even old ones.
    if (workspaces.some((workspace) => workspace.agents.length) || pins.length > (state.pins ?? []).length) refreshSessions();
    connect();
    let saved = null;
    try {
      saved = localStorage.getItem("zo-selected-conversation");
    } catch {
      // Storage unavailable.
    }
    if (saved && conversations.has(saved)) await selectConversation(saved);
    else showIdle();
    // Address of a ticket (/t/42): its card opens once the boards are loaded.
    const ticketNumber = ticketNumberFromPath(location.pathname);
    kanban.load().then(() => ticketNumber !== null && kanban.openNumber(ticketNumber));
  } catch (err) {
    // Unauthenticated session: the error banner is already shown by api().
    console.error("Could not load ziggy-one:", err);
  }
}

init();

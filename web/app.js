// @ts-check
// Tout le contenu venant de Claude est inséré via textContent, jamais via innerHTML.

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
import { confirmDialog, dismissDialog, isDialogOpen, onDialogClose } from "./modal.js";
import { migratePins, orderRows, pinIndex, pinnedFirst, rowKeys, togglePin } from "./pins.js";
import { memberKey, pinnedHead, splitByWorkspace, workspacePinKey, workspaceState } from "./workspaces.js";

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

const WINDOW_LABELS = {
  five_hour: "Session en cours (5 h)",
  seven_day: "Semaine, tous modèles (7 j)",
  seven_day_opus: "Semaine, Opus",
  seven_day_sonnet: "Semaine, Sonnet",
};
// Libellés courts pour la barre du haut.
const WINDOW_SHORT_LABELS = {
  five_hour: "5 h",
  seven_day: "7 j",
  seven_day_opus: "7 j Opus",
  seven_day_sonnet: "7 j Sonnet",
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
 * Erreur passagère en bas de l'écran (action refusée, réseau…).
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
  const delay = h >= 24 ? `${Math.floor(h / 24)} j ${h % 24} h` : h > 0 ? `${h} h ${String(m).padStart(2, "0")}` : `${m} min`;
  const when = date.toLocaleString("fr-FR", { weekday: "short", hour: "2-digit", minute: "2-digit" });
  return `réinitialisation dans ${delay} (${when})`;
}

// --- compte, usage et préférences : la jauge de la barre du haut ouvre le détail ---------

const AUTH_LABELS = { "claude.ai": "Compte claude.ai", api_key: "Clé API" };
const PLAN_LABELS = { pro: "Pro", max: "Max", team: "Team", enterprise: "Enterprise" };
const STATUS_LABELS = { allowed: "Dans les limites", allowed_warning: "Proche de la limite", rejected: "Limite atteinte" };
const OVERAGE_REASONS = {
  org_level_disabled: "désactivé par l'organisation",
  out_of_credits: "crédits épuisés",
  overage_not_provisioned: "non souscrit",
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
  $("account-email").textContent = connected ? data.email || "—" : data?.error || "Non connecté";
  $("account-sub").textContent = connected
    ? [data.orgName, data.subscriptionType && `Forfait ${PLAN_LABELS[data.subscriptionType] || data.subscriptionType}`, AUTH_LABELS[data.authMethod] || data.authMethod]
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
    chip.append(ring, el("span", "usage-label", WINDOW_SHORT_LABELS[name] || name), el("span", "usage-value", pct === null ? "—" : `${pct} %`));
    return chip;
  });
  if (items.length === 0) items.push(el("span", "usage-label", "Usage inconnu"));
  const alerts = [];
  if (usage.status === "rejected") alerts.push("limite atteinte");
  else if (usage.status === "allowed_warning") alerts.push("proche de la limite");
  if (usage.isUsingOverage) alerts.push("dépassement");
  if (alerts.length) items.push(el("span", "usage-alert", alerts.join(" · ")));
  $("usage-windows").replaceChildren(...items);
  renderRailUsage();
  // Barre repliée : seul l'avatar reste visible, entouré de la couleur de l'usage sur 5 h.
  $("avatar").dataset.level = usageLevel(windowPercent("five_hour"));
  renderUsageButtonLabel();
  if (accountDialog.open) renderAccountDialog();
}

/** Barre repliée : une jauge par fenêtre d'usage, empilées en bas du rail (pourcentage puis fenêtre). */
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
  const windows = windowNames().map((name) => `${WINDOW_LABELS[name] || name} : ${windowPercent(name) ?? "—"} %`);
  const label = ["Compte et usage du forfait", account?.email, ...windows].filter(Boolean).join(" · ");
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

/** Contenu de la fenêtre : barres d'usage avec leur réinitialisation, état, puis Ziggy One. */
function renderAccountDialog() {
  const bars = windowNames().map((name) => {
    const pct = windowPercent(name);
    const w = usage.windows[name];
    const row = el("div", `usage-bar level-${usageLevel(pct)}`);
    row.style.setProperty("--pct", String(Math.min(100, pct ?? 0)));
    const head = el("div", "usage-bar-head");
    head.append(el("span", "", WINDOW_LABELS[name] || name), el("strong", "", pct === null ? "—" : `${pct} % utilisé`));
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
  if (bars.length === 0) bars.push(el("p", "muted small", "Usage inconnu : il est lu à chaque réponse de Claude, ou avec le bouton Actualiser."));
  $("usage-bars").replaceChildren(...bars);
  $("usage-updated").textContent = usage.updatedAt
    ? `mis à jour à ${new Date(usage.updatedAt * 1000).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`
    : "";
  const overage = usage.isUsingOverage
    ? "en cours d'utilisation"
    : usage.overageStatus === "rejected" || usage.overageDisabledReason
      ? `indisponible${usage.overageDisabledReason ? ` (${OVERAGE_REASONS[usage.overageDisabledReason] || usage.overageDisabledReason})` : ""}`
      : usage.overageStatus ? "disponible" : null;
  fillFacts($("usage-facts"), [
    ["État", STATUS_LABELS[usage.status] || usage.status],
    ["Usage supplémentaire", overage],
  ]);

  const rows = sessionRows();
  const state = rows.map(agentState);
  const cost = rows.reduce((sum, row) => sum + (typeof row.costUsd === "number" ? row.costUsd : 0), 0);
  const running = [...conversations.values()].filter((c) => terminalView.isRunning(c.id)).length;
  fillFacts($("ziggy-facts"), [
    ["Agents actifs", `${state.filter((s) => s !== "inactive").length} sur ${rows.length}, dont ${state.filter((s) => s === "busy").length} au travail`],
    ["Terminaux Claude Code ouverts", String(running)],
    ["Coût des agents listés", `${cost.toFixed(2)} $ (équivalent API, non facturé sur un forfait)`],
    ["Claude Code", account?.version ? `version ${account.version}` : null],
  ]);
}

/** @type {number | undefined} */
let accountTimer;
$("usage").addEventListener("click", () => {
  renderAccountDialog();
  accountDialog.showModal();
  accountTimer = window.setInterval(renderAccountDialog, 30_000); // comptes à rebours des réinitialisations
});
$("rail-usage").addEventListener("click", () => $("usage").click());
$("open-settings").addEventListener("click", () => {
  accountDialog.close();
  openSettingsPanel();
});
accountDialog.addEventListener("close", () => clearInterval(accountTimer));
$("account-close").addEventListener("click", () => accountDialog.close());
// Un clic sur le fond (hors du contenu) ferme la fenêtre.
accountDialog.addEventListener("click", (event) => {
  if (event.target === accountDialog) accountDialog.close();
});

// Actualiser : depuis la barre du haut (sans ouvrir la fenêtre) ou depuis la fenêtre.
const refreshButtons = /** @type {HTMLButtonElement[]} */ ([$("usage-refresh"), $("refresh-usage")]);

async function refreshUsage() {
  for (const button of refreshButtons) {
    button.disabled = true;
    button.classList.add("loading");
  }
  try {
    renderUsage(await api("/api/usage/refresh", {}));
  } catch (err) {
    const message = `Actualisation impossible : ${err.message}`;
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
    // Stockage indisponible : le choix vaut pour cet onglet seulement.
  }
}

const currentTheme = document.documentElement.dataset.theme || "system";
for (const input of /** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll('input[name="theme"]'))) {
  input.checked = input.value === currentTheme;
  input.addEventListener("change", () => applyTheme(input.value));
}

// --- barre latérale redimensionnable ---------------------------------------------

const SIDEBAR_DEFAULT = 340;
const SIDEBAR_MIN = 240;
const layout = /** @type {HTMLElement} */ (document.querySelector(".layout"));
const resizer = $("sidebar-resizer");

// La zone centrale garde toujours au moins 480 px.
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
    // Stockage indisponible : la largeur vaut pour cet onglet seulement.
  }
}

const currentSidebarWidth = () => Number(resizer.getAttribute("aria-valuenow")) || SIDEBAR_DEFAULT;

resizer.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  resizer.setPointerCapture(event.pointerId);
  document.body.classList.add("resizing");
  // La barre part du bord gauche : sa largeur est la position du pointeur dans la mise en page.
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

// Si la fenêtre rétrécit, on resserre la barre sans écraser la largeur choisie.
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

// --- barre repliée en rail d'avatars --------------------------------------------
// Repliée, la barre ne montre que la colonne des avatars (même mise en page, rognée) : survolée,
// elle s'ouvre par-dessus le contenu sans le décaler, chaque avatar restant à sa place.

const SIDEBAR_COLLAPSED_KEY = "zo-sidebar-collapsed";
const PEEK_OPEN_DELAY = 150;
const PEEK_CLOSE_DELAY = 300;
const PEEK_CLOSE_DURATION = 180; // animation de fermeture (peek-close dans style.css)
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const sidebar = /** @type {HTMLElement} */ (document.querySelector(".sidebar"));
const sidebarToggle = $("sidebar-toggle");
/** @type {number | undefined} */
let peekTimer;

/** Applique un changement de mise en page sans animation (chargement, barre déjà ouverte au survol). */
function withoutAnimation(/** @type {() => void} */ change) {
  layout.classList.add("instant");
  change();
  requestAnimationFrame(() => requestAnimationFrame(() => layout.classList.remove("instant")));
}

/** @param {boolean} collapsed */
function setSidebarCollapsed(collapsed, persist = true) {
  // Garder ouverte une barre déjà dépliée au survol : elle est déjà à sa place, rien à animer.
  const instant = !persist || (!collapsed && layout.classList.contains("peek"));
  clearTimeout(peekTimer);
  const change = () => {
    layout.classList.toggle("collapsed", collapsed);
    layout.classList.remove("peek", "peek-closing");
  };
  if (instant) withoutAnimation(change);
  else change();
  // Pendant que la colonne s'élargit, le contenu garde sa largeur finale (pas de texte qui se réorganise).
  if (!collapsed && !instant) {
    layout.classList.add("expanding");
    window.setTimeout(() => layout.classList.remove("expanding"), 260);
  }
  sidebarToggle.setAttribute("aria-expanded", String(!collapsed));
  const label = collapsed ? "Garder la barre ouverte (Ctrl+B)" : "Réduire la barre (Ctrl+B)";
  sidebarToggle.title = label;
  sidebarToggle.setAttribute("aria-label", label);
  if (!persist) return;
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // Stockage indisponible : le choix vaut pour cet onglet seulement.
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
    // La barre se replie vers le rail, puis reprend sa place dans la mise en page.
    layout.classList.add("peek-closing");
    peekTimer = window.setTimeout(() => layout.classList.remove("peek", "peek-closing"), PEEK_CLOSE_DURATION);
  };
  if (delay) peekTimer = window.setTimeout(apply, delay);
  else apply();
}

/**
 * Touche tapée dans le terminal Claude Code : elle est pour lui (Ctrl+B, Ctrl+P…), pas pour Ziggy.
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
// Ouvrir un agent, sa configuration ou la création referme le panneau : place au contenu.
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

// --- agents ouverts ---------------------------------------------------------------------------
// Un agent ouvert ici = un dossier et une session Claude Code, qu'on utilise dans l'onglet Terminal.
// Le serveur dit s'il est au travail (hooks de Claude Code et registre de ses sessions).

/** @type {Map<string, any>} statut de chaque agent ouvert, par identifiant */
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
 * Affiche un agent : ses onglets (Terminal par défaut), et son Claude Code s'il tourne déjà.
 *
 * @param {string} id
 * @param {{start?: boolean}} [options] start : ouvrir tout de suite Claude Code (nouvel agent)
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
    // Stockage indisponible : la sélection n'est pas retenue au rechargement.
  }
  if (start) activeTab = "terminal";
  renderHeader();
  renderTabs();
  drawSessions();
  if (start) terminalView.start(conversation);
}

/** État idle : aucun agent affiché, la carte « Créer » prend le centre. */
function showIdle() {
  selectedId = null;
  try {
    localStorage.removeItem("zo-selected-conversation");
  } catch {
    // Stockage indisponible : rien à oublier.
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
 * Ouvre une session : l'agent qui la suit déjà, sinon un nouveau (Claude Code s'ouvre dans le Terminal).
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
    showToast(`Ouverture impossible : ${err.message}`);
  }
}

/**
 * Crée un agent et ouvre aussitôt Claude Code dans son Terminal.
 *
 * @param {string} [cwd] dossier où il travaillera ; celui par défaut du serveur sinon
 * @param {string} [name] nom donné à l'agent
 */
async function newConversation(cwd, name, workspaceId) {
  const status = storeConversation(await api("/api/conversations", cwd ? { cwd } : {}));
  if (name?.trim()) setAgentSettings((await api("/api/agents/rename", { agent: status.id, name })).agents);
  if (workspaceId) setWorkspaces((await api(`/api/workspaces/${workspaceId}/add`, { agent: status.id })).workspaces);
  await selectConversation(status.id, { start: true });
  return status.id;
}

// « + » : carte de création (agent ou workspace) au centre.
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
 * Lignes de la liste : les sessions, plus les agents ouverts ici qui n'y figurent pas encore (nouveaux…).
 * Les agents supprimés n'y sont pas.
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

// Agents épinglés : toujours en tête de liste, dans l'ordre où ils ont été épinglés.
// Enregistrées sur le serveur (pins.json) : elles survivent au redémarrage et valent pour tous les
// navigateurs. Les anciennes épingles du navigateur sont reprises une fois, puis oubliées.
const LEGACY_PINS_KEY = "zo-pinned-agents";
/** @type {string[]} */
let pins = [];

/**
 * Épingles du serveur, complétées par celles qu'avait gardées ce navigateur (une seule fois).
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
    // Stockage indisponible : rien à reprendre.
  }
  savePins([...serverPins, ...legacy.filter((pin) => !serverPins.includes(pin))]);
}

/** @param {string[]} next */
function savePins(next) {
  if (JSON.stringify(next) === JSON.stringify(pins)) return;
  pins = next;
  api("/api/pins", { pins }).catch((err) => showToast(`Épingles non enregistrées : ${err.message}`));
}

/** Paramètre pour que le serveur renvoie les agents épinglés ou rangés dans un workspace, même anciens. */
function includeAgents() {
  const keys = [...new Set([...pins, ...workspaces.flatMap((workspace) => workspace.agents)])];
  return keys.length ? `?include=${encodeURIComponent(keys.join(","))}` : "";
}

function drawSessions() {
  const rows = sessionRows();
  savePins(migratePins(pins, rows));
  const isOpen = (/** @type {any} */ row) => Boolean(row.active || row.conversation);
  $("filter-open").replaceChildren("Actifs", el("span", "count", String(rows.filter(isOpen).length)));
  $("filter-all").replaceChildren("Tous", el("span", "count", String(rows.length)));
  const list = $("session-list");
  list.replaceChildren();
  // Ordre : agents épinglés, workspaces (avec leurs agents, quel que soit le filtre), puis les autres
  // agents, du plus récent au plus ancien.
  const { members, rest } = splitByWorkspace(rows, workspaces);
  const { pinned, others: unpinnedRows } = orderRows(rest, pins, (row) => sessionFilter === "all" || isOpen(row));
  const others = pinnedOnly ? [] : unpinnedRows;
  const { head, unpinned } = pinnedHead(pinned, workspaces, pins);
  const block = (/** @type {any} */ workspace) => workspaceItem(workspace, members.get(workspace.id) || []);
  if (head.length === 0 && unpinned.length === 0 && others.length === 0) {
    const empty = pinnedOnly ? "Aucun agent épinglé." : sessionFilter === "open" ? "Aucun agent actif." : "Aucun agent.";
    list.append(el("li", "muted", empty));
  } else {
    // En tête, agents et workspaces épinglés, dans l'ordre des épingles ; puis les autres workspaces et agents.
    const headItems = head.map((entry) => (entry.kind === "agent" ? sessionItem(entry.row) : block(entry.workspace)));
    headItems.at(-1)?.classList.toggle("pinned-last", unpinned.length + others.length > 0);
    list.append(...headItems, ...unpinned.map(block), ...others.map(sessionItem));
  }
  if (pinnedOnly && unpinnedRows.length) list.append(hiddenAgentsNote(unpinnedRows.length));
  // Accès aux agents supprimés, pour les restaurer.
  const hiddenCount = hiddenAgents().length;
  if (hiddenCount) {
    const entry = el("li", "deleted-entry");
    const link = el("button", "link-button", `Agents supprimés (${hiddenCount})`);
    link.type = "button";
    link.addEventListener("click", openDeletedPanel);
    entry.append(link);
    list.append(entry);
  }
}

const AGENT_STATE_LABELS = { waiting: "attend ta réponse", busy: "réfléchit", active: "actif", inactive: "inactif" };
/** Ce que l'agent attend de toi (hook Notification de Claude Code). */
const WAITING_LABELS = { permission: "une autorisation", question: "une réponse à sa question" };

/**
 * État d'un agent, montré uniquement par la pastille de son avatar :
 * « busy » (orange scintillant) s'il réfléchit, « active » (vert) s'il est actif, sinon « inactive » (gris).
 *
 * @param {any} row
 */
function agentState(row) {
  const c = row.conversation;
  // En attente de ta réponse (autorisation, question) : passe avant tout le reste, c'est à toi de jouer.
  if (c?.waiting) return "waiting";
  // Deux sources possibles pour un même agent : son terminal dans ziggy-one, et la session
  // ouverte dans un terminal (le registre de Claude Code dit si elle travaille).
  const busyHere = Boolean(c?.busy);
  const busyInTerminal = Boolean(row.active && row.status === "busy");
  if (busyHere || busyInTerminal) return "busy";
  // Actif = vert : ouvert dans ziggy-one (Claude Code ouvert ou non) ou dans un terminal.
  // C'est la même règle que le filtre « Actifs ».
  if (c || row.active) return "active";
  return "inactive";
}

// Couleur de chaque agent (avatar et cartouche du dossier). Chaque nouvel agent reçoit la teinte
// suivante, décalée de l'angle d'or (≈ 137,5°) : deux agents à la suite ont des couleurs bien
// distinctes. L'attribution est mémorisée pour qu'un agent garde sa couleur d'un rechargement à l'autre.
const AGENT_COLORS_KEY = "zo-agent-colors";
const AGENT_COLORS_MAX = 300;
const agentColors = loadAgentColors();

function loadAgentColors() {
  try {
    const saved = JSON.parse(localStorage.getItem(AGENT_COLORS_KEY) || "{}");
    if (Number.isInteger(saved.next) && saved.hues && typeof saved.hues === "object") return saved;
  } catch {
    // Stockage indisponible ou illisible : on repart de zéro.
  }
  return { next: 0, hues: {} };
}

/**
 * @param {string} key identifiant stable de l'agent
 * @returns {number} teinte (0-359)
 */
function agentHue(key) {
  if (!(key in agentColors.hues)) {
    // On saute les teintes trop proches des pastilles d'état (orange « réfléchit », vert « actif »),
    // qui se verraient mal sur l'avatar.
    let hue;
    do {
      hue = Math.round((agentColors.next * 137.508) % 360);
      agentColors.next += 1;
    } while ((hue >= 20 && hue <= 50) || (hue >= 100 && hue <= 160));
    agentColors.hues[key] = hue;
    // On oublie les agents les plus anciens au-delà d'un certain nombre.
    const keys = Object.keys(agentColors.hues);
    for (const old of keys.slice(0, Math.max(0, keys.length - AGENT_COLORS_MAX))) delete agentColors.hues[old];
    try {
      localStorage.setItem(AGENT_COLORS_KEY, JSON.stringify(agentColors));
    } catch {
      // Stockage indisponible : les couleurs valent pour cet onglet seulement.
    }
  }
  return agentColors.hues[key];
}

/**
 * Date courte pour la liste : l'heure aujourd'hui, jour/mois cette année, la date complète sinon.
 *
 * @param {number} epochSeconds
 */
function shortDate(epochSeconds) {
  const date = new Date(epochSeconds * 1000);
  const now = new Date();
  const time = date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === now.toDateString()) return time;
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" })} ${time}`;
  }
  return date.toLocaleDateString("fr-FR");
}

/**
 * Dernier message de l'agent : celui envoyé d'ici (à jour dès l'envoi), sinon celui de son historique.
 *
 * @param {any} row
 */
const agentLabel = (row) =>
  row.conversation?.lastPrompt || row.lastPrompt || row.name || row.conversation?.label || `Agent ${String(row.sessionId).slice(0, 8)}`;

/** @param {string} text */
const initialOf = (text) => (text.match(/[\p{L}\p{N}]/u)?.[0] || "?").toUpperCase();

/**
 * Lettre de l'avatar d'un agent : la première du nom qu'on lui a donné, sinon celle du dossier
 * où il travaille, sinon celle de son dernier message.
 *
 * @param {string | undefined} name nom donné à l'agent
 * @param {string | undefined} cwd
 * @param {string} fallback
 */
const avatarLetter = (name, cwd, fallback) => initialOf(name || cwd?.split("/").filter(Boolean).pop() || fallback);

/**
 * Avatar d'un agent : celui qu'on lui a choisi (abréviation, animal ou image), sinon sa lettre.
 *
 * @param {string} className
 * @param {any} avatar avatar enregistré
 * @param {string} letter lettre par défaut (avatarLetter)
 */
function avatarNode(className, avatar, letter) {
  const node = el("span", className);
  node.setAttribute("aria-hidden", "true");
  fillAvatar(node, avatarLook(avatar, letter));
  return node;
}

/**
 * Contexte de l'agent ({tokens, window}) : celui lu dans son historique.
 *
 * @param {any} row
 */
const agentContext = (row) => row.conversation?.context || row.context || null;

/** @param {{tokens: number, window: number}} context */
const contextPercent = (context) => Math.min(100, Math.round((context.tokens / context.window) * 100));

/** @param {number} tokens */
const kiloTokens = (tokens) =>
  tokens >= 1_000_000
    ? `${(tokens / 1_000_000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} M`
    : `${Math.round(tokens / 1000)} k`;

/** @param {{tokens: number, window: number}} context */
const contextText = (context) =>
  `${contextPercent(context)} % (${kiloTokens(context.tokens)} / ${kiloTokens(context.window)} tokens)`;

/**
 * Remplissage du contexte : un camembert (vert, orange dès 50 %, rouge dès 80 %) et le pourcentage.
 *
 * @param {{tokens: number, window: number}} context
 */
function contextPie(context) {
  const pct = contextPercent(context);
  const chip = el("span", `context-chip level-${pct >= 80 ? "hot" : pct >= 50 ? "warm" : "ok"}`);
  chip.style.setProperty("--pct", String(pct));
  chip.title = `Contexte : ${contextText(context)}`;
  const pie = el("span", "context-pie");
  pie.setAttribute("aria-hidden", "true");
  chip.append(pie, el("span", "context-value", `${pct} %`), el("span", "visually-hidden", " de contexte"));
  return chip;
}

/**
 * Ligne d'un agent : un clic l'ouvre ; à droite, l'épingle et le bouton ⋯ de configuration.
 *
 * @param {any} row
 */
function sessionItem(row) {
  const c = row.conversation;
  const label = displayName(row);
  const when = row.updatedAt ? shortDate(row.updatedAt) : "";
  const cost = typeof row.costUsd === "number" ? `${row.costUsd.toFixed(2)} $` : "";
  const state = agentState(row);
  const selected = Boolean(c && c.id === selectedId);
  const pinned = pinIndex(pins, row) !== -1;
  const unseen = Boolean(c && unseenConversations.has(c.id));
  const classes = ["session", `state-${state}`, selected && "selected", pinned && "pinned", unseen && "unseen"];
  const item = el("li", classes.filter(Boolean).join(" "));
  // Avatar et cartouche du dossier partagent la couleur de l'agent.
  item.style.setProperty("--agent-hue", String(agentHue(row.sessionId || c?.id || label)));
  const button = el("button", "session-open");
  button.type = "button";
  // L'état n'est pas écrit à l'écran : il est donné aux lecteurs d'écran et en infobulle.
  button.title = state === "waiting"
    ? `${label} : attend ${WAITING_LABELS[/** @type {"permission" | "question"} */ (c?.waiting)] ?? "ta réponse"}`
    : `${label} (${AGENT_STATE_LABELS[state]})`;
  if (selected) button.setAttribute("aria-current", "true");

  const avatar = avatarNode("agent-avatar", agentAvatar(row), avatarLetter(customName(row), row.cwd, label));
  avatar.append(el("span", "agent-dot"));
  const folder = row.cwd ? row.cwd.split("/").filter(Boolean).pop() : "";
  const text = el("span", "agent-text");
  // Date · dossier · coût : seul le dossier se raccourcit (« … ») si la place manque.
  const meta = el("span", "muted small agent-meta");
  if (when) meta.append(el("span", "", when));
  if (folder) {
    const folderEl = el("span", "agent-folder", folder);
    folderEl.title = row.cwd;
    meta.append(folderEl);
  }
  // Dossier dans un dépôt git : une petite icône à droite de la cartouche.
  if (row.git || c?.git) {
    const git = el("span", "agent-git");
    git.title = "Dépôt git";
    git.setAttribute("aria-label", "dépôt git");
    git.append(icon(ICONS.git));
    meta.append(git);
  }
  if (cost) meta.append(el("span", "", cost));
  const context = agentContext(row);
  if (context) meta.append(contextPie(context));
  // Un agent nommé : son nom en titre, puis son dernier message. Sinon le dernier message sert de titre.
  const name = customName(row);
  if (name) text.append(el("span", "agent-title", name), el("span", "last-message", agentLabel(row)), meta);
  else text.append(el("span", "session-name", label), meta);
  button.append(avatar, text, el("span", "visually-hidden", `, ${AGENT_STATE_LABELS[state]}`));
  button.addEventListener("click", () => (c ? selectConversation(c.id) : openSession(row.sessionId, label)));

  // Actions à côté du bouton de la ligne (un bouton ne peut pas en contenir un autre).
  const pin = el("button", "pin-button");
  pin.type = "button";
  pin.title = pinned ? "Désépingler" : "Épingler en haut";
  pin.setAttribute("aria-label", `${pinned ? "Désépingler" : "Épingler"} « ${label} »`);
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

// --- workspaces : groupes d'agents, repliables -----------------------------------------

/** @type {{id: string, name: string, agents: string[]}[]} */
let workspaces = [];

/** Workspace de l'agent, ou null. @param {any} conversation */
function workspaceOf(conversation) {
  const keys = agentKeys(conversation);
  return workspaces.find((workspace) => keys.some((key) => workspace.agents.includes(key))) ?? null;
}

// --- raccourcis de prompts : ceux d'un agent, ceux d'un workspace (communs à ses agents) ----------------

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
 * Enregistre une liste complète (le serveur la renvoie nettoyée, avec les identifiants des nouveaux).
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
  // Les épingles des workspaces supprimés n'ont plus d'objet.
  const known = new Set(list.map((workspace) => workspacePinKey(workspace.id)));
  savePins(pins.filter((pin) => !pin.startsWith("workspace:") || known.has(pin)));
  drawSessions();
  panelRefresh?.();
  configRefresh?.();
  shortcutsView.refresh();
  shortcutsPanel.refresh();
}

// Couleurs proposées pour un workspace (en plus de la couleur automatique) : bien distinctes, et
// loin de l'orange et du vert des pastilles d'état.
const WORKSPACE_HUES = [0, 15, 55, 75, 175, 195, 215, 235, 260, 280, 305, 330];

/**
 * Teinte d'un workspace : celle choisie, sinon une teinte attribuée automatiquement.
 *
 * @param {{id: string, hue?: number | null}} workspace
 */
const workspaceHue = (workspace) => (Number.isInteger(workspace.hue) ? workspace.hue : agentHue(`workspace:${workspace.id}`));

// Workspaces repliés : une préférence d'affichage, propre à ce navigateur.
// « Épinglés seulement » : les agents non épinglés hors workspace sont cachés (chaque workspace a son propre
// interrupteur). Préférence d'affichage de ce navigateur.
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
    // Stockage indisponible : le choix vaut pour cet onglet seulement.
  }
  syncPinnedOnly();
  drawSessions();
}

function syncPinnedOnly() {
  const button = $("pinned-only");
  const label = pinnedOnly ? "Afficher tous les agents" : "Afficher seulement les agents épinglés";
  button.setAttribute("aria-pressed", String(pinnedOnly));
  button.title = label;
  button.setAttribute("aria-label", label);
}
$("pinned-only").addEventListener("click", () => setPinnedOnly(!pinnedOnly));
syncPinnedOnly();

// « Épinglés seulement » d'un workspace : son interrupteur, à droite de « x/y épinglés ». Éteint par défaut :
// tous ses agents sont affichés ; allumé, seulement ses agents épinglés.
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
    // Stockage indisponible : le choix vaut pour cet onglet seulement.
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
    // Stockage indisponible : le choix vaut pour cet onglet seulement.
  }
  drawSessions();
}

/**
 * Bloc d'un workspace dans la liste : en-tête repliable (avec épingle et engrenage), puis ses agents.
 *
 * @param {{id: string, name: string, hue?: number | null, agents: string[]}} workspace
 * @param {any[]} rows ses agents
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
  // Un clic sur le workspace ouvre sa carte, sur l'onglet Configuration ; la flèche le plie / déplie.
  const toggle = el("button", "workspace-toggle");
  toggle.type = "button";
  toggle.title = `${workspace.name} (${AGENT_STATE_LABELS[state]}) : ouvrir le workspace`;
  const badge = el("span", "workspace-icon", initialOf(workspace.name));
  badge.setAttribute("aria-hidden", "true");
  badge.append(el("span", "agent-dot"));
  // Agents épinglés sur le total (« 2/5 épinglés »), et l'interrupteur qui ne garde que les épinglés.
  const { pinned: pinnedRows, others } = pinnedFirst(rows, pins);
  const onlyPinned = pinnedOnlyWorkspaces.has(workspace.id);
  const count = rows.length === 0 ? "Aucun agent" : `${pinnedRows.length}/${rows.length} épinglé${pinnedRows.length > 1 ? "s" : ""}`;
  const text = el("span", "agent-text");
  // La ligne du compteur est dessinée par-dessus le bouton (.workspace-sub) : celle-ci ne fait que réserver sa place.
  const spacer = el("span", "muted small workspace-count-space", count);
  spacer.setAttribute("aria-hidden", "true");
  text.append(el("span", "session-name", workspace.name), spacer);
  toggle.append(badge, text, el("span", "visually-hidden", `, ${count}, ${AGENT_STATE_LABELS[state]}`));
  toggle.addEventListener("click", () => openWorkspacePanel(workspace.id));
  const sub = el("div", "workspace-sub");
  sub.append(el("span", "muted small", count));
  if (rows.length) {
    const label = onlyPinned ? "Afficher tous les agents du workspace" : "N'afficher que les agents épinglés du workspace";
    const switcher = el("button", "ws-switch");
    switcher.type = "button";
    switcher.setAttribute("role", "switch");
    switcher.setAttribute("aria-checked", String(onlyPinned));
    switcher.setAttribute("aria-label", `${label} (« ${workspace.name} »)`);
    switcher.title = label;
    switcher.append(el("span", "ws-switch-knob"));
    switcher.addEventListener("click", () => setWorkspacePinnedOnly(workspace.id, !onlyPinned));
    // L'état en un coup d'œil : une liste (tous les agents) ou une épingle (épinglés seulement).
    const stateIcon = el("span", `ws-switch-icon${onlyPinned ? " on" : ""}`);
    stateIcon.title = onlyPinned ? "Seulement les agents épinglés" : "Tous les agents";
    stateIcon.append(icon(onlyPinned ? ICONS.pin : ICONS.list));
    sub.append(switcher, stateIcon);
  }

  const pin = el("button", "pin-button");
  pin.type = "button";
  pin.title = pinned ? "Désépingler" : "Épingler en haut";
  pin.setAttribute("aria-label", `${pinned ? "Désépingler" : "Épingler"} le workspace « ${workspace.name} »`);
  pin.setAttribute("aria-pressed", String(pinned));
  pin.append(icon(ICONS.pin));
  pin.addEventListener("click", () => {
    savePins(pinned ? pins.filter((key) => key !== pinKey) : [...pins, pinKey]);
    drawSessions();
  });
  const fold = el("button", "pin-button workspace-fold");
  fold.type = "button";
  fold.title = collapsed ? "Déplier" : "Replier";
  fold.setAttribute("aria-label", `${collapsed ? "Déplier" : "Replier"} le workspace « ${workspace.name} »`);
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
      // Les épinglés gardent leur place en tête du workspace.
      const pinnedItems = pinnedRows.map(sessionItem);
      if (onlyPinned) {
        // Épinglés seulement : les autres agents du workspace sont résumés en une ligne.
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
      const add = el("button", "link-button", "Ajouter des agents");
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
 * Ligne « N agents non épinglés masqués », qui réaffiche tout au clic.
 *
 * @param {number} count
 * @param {() => void} [showAll] ce qui réaffiche tout (par défaut : couper « épinglés seulement » de la liste)
 */
function hiddenAgentsNote(count, showAll = () => setPinnedOnly(false)) {
  const item = el("li", "workspace-empty hidden-agents");
  const show = el("button", "link-button", `${count} agent${count > 1 ? "s" : ""} non épinglé${count > 1 ? "s" : ""} masqué${count > 1 ? "s" : ""} · tout afficher`);
  /** @type {HTMLButtonElement} */ (show).type = "button";
  show.addEventListener("click", showAll);
  item.append(show);
  return item;
}

// --- carte centrale : créer un agent ou un workspace, gérer un workspace --------------------

const chatCard = $("chat");
const panel = $("panel");
const panelBody = $("panel-body");
/** @type {null | {kind: "create"} | {kind: "new-agent"} | {kind: "workspace", id: string} | {kind: "deleted"} | {kind: "settings"}} */
let panelView = null;
/** @type {null | (() => void)} rafraîchit la carte affichée quand les données changent */
let panelRefresh = null;

/**
 * @param {string} title
 * @param {Node[]} children
 */
function showPanel(title, ...children) {
  panel.classList.remove("hero-mode"); // l'écran d'accueil (animation) n'a pas d'en-tête : les autres, si
  $("panel-title").textContent = title;
  panelBody.replaceChildren(...children);
  // En état idle, la carte « Créer » n'a rien à fermer.
  $("panel-close").hidden = !selectedId && panelView?.kind === "create";
  chatCard.hidden = true;
  panel.hidden = false;
}

function closePanel() {
  const wasConfiguring = panelView?.kind === "workspace";
  panelView = null;
  panelRefresh = null;
  if (!selectedId) {
    openCreatePanel(); // rien derrière la carte : état idle
    if (wasConfiguring) drawSessions();
    return;
  }
  panel.hidden = true;
  chatCard.hidden = false;
  if (wasConfiguring) drawSessions(); // retire le surlignage de la ligne configurée
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

// --- Configuration (bouton de la fenêtre de l'usage) : les terminaux Claude Code ouverts ---------------------

// --- serveur : démarrage, version, redémarrage propre (écran Configuration, bandeau en haut) -----------------

/** @type {{startedAt: number, version: string | null, pid: number, restart: any, lastRestart: any} | null} */
let serverInfo = null;
const RESTARTED_KEY = "zo-restarted-from"; // page rechargée après un redémarrage : démarrage du serveur d'avant
/** @type {number | undefined} */
let bannerTimer;

/** @param {number} epoch */
const clock = (epoch) => new Date(epoch * 1000).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

/**
 * Bandeau en haut de l'écran.
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

/** Noms des agents qu'on attend, pour le bandeau. @param {string[]} ids */
const agentNames = (ids) => ids.map(conversationName).join(", ");

/** Le bandeau suit le redémarrage en cours (attente des agents, relance). */
function renderRestartBanner() {
  const restart = serverInfo?.restart;
  if (!restart) {
    if ($("server-banner").classList.contains("waiting") || $("server-banner").classList.contains("restarting")) showServerBanner(null);
    return;
  }
  if (restart.phase === "restarting") {
    showServerBanner("restarting", [el("span", "server-spinner"), el("span", "", "Redémarrage du serveur… la page se rechargera toute seule.")]);
    return;
  }
  const waiting = restart.waiting ?? [];
  const text = waiting.length
    ? `Redémarrage du serveur demandé : en attente de ${waiting.length} agent${waiting.length > 1 ? "s" : ""} au travail (${agentNames(waiting)}), jusqu'à ${clock(restart.deadline)} au plus.`
    : "Redémarrage du serveur demandé : les agents sont au repos, il démarre…";
  const force = el("button", "", "Forcer maintenant");
  /** @type {HTMLButtonElement} */ (force).type = "button";
  force.addEventListener("click", () => restartAction("force"));
  const cancel = el("button", "", "Annuler");
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
    showServerBanner("waiting", [el("span", "", `Redémarrage impossible : ${err instanceof Error ? err.message : err}`)]);
    return;
  }
  if (action === "cancel") sessionStorage.removeItem(RESTARTED_KEY);
  renderRestartBanner();
  if (panelView?.kind === "settings") renderSettingsPanel();
}

/** Au chargement : la page vient-elle d'être rechargée après un redémarrage ? Si oui, on le confirme. */
function confirmRestart() {
  let previous = null;
  try {
    previous = sessionStorage.getItem(RESTARTED_KEY);
    sessionStorage.removeItem(RESTARTED_KEY);
  } catch {
    // Stockage indisponible : pas de confirmation.
  }
  if (!previous || !serverInfo || String(serverInfo.startedAt) === previous) return;
  confirmingRestart = true;
  showRestartDone();
}

/** Le serveur a pu finir de rouvrir les terminaux après le rechargement : le bandeau se complète alors. */
let confirmingRestart = false;

function showRestartDone() {
  if (!serverInfo) return;
  const last = serverInfo.lastRestart;
  const parts = [`✓ Serveur redémarré à ${clock(serverInfo.startedAt)}`];
  if (serverInfo.version) parts.push(`version ${serverInfo.version}`);
  if (last && last.completedAt >= serverInfo.startedAt) {
    parts.push(`${last.reopened} terminal${last.reopened > 1 ? "aux" : ""} rouvert${last.reopened > 1 ? "s" : ""}`);
    if (last.resumed) parts.push(`${last.resumed} agent${last.resumed > 1 ? "s" : ""} relancé${last.resumed > 1 ? "s" : ""}`);
  }
  const close = el("button", "icon-button");
  /** @type {HTMLButtonElement} */ (close).type = "button";
  close.setAttribute("aria-label", "Fermer");
  close.append(icon(ICONS.close));
  close.addEventListener("click", () => showServerBanner(null));
  showServerBanner("done", [el("span", "server-banner-text", parts.join(" · ")), close]);
}

/**
 * Le flux temps réel s'est rouvert après une coupure : si le serveur a changé (redémarré), on recharge la page
 * pour prendre son code à jour ; la confirmation s'affiche au retour.
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
      // Stockage indisponible : rechargement sans confirmation.
    }
    location.reload();
    return;
  }
  serverInfo = info;
  renderRestartBanner();
}

/** @type {number | undefined} relecture de la mémoire, tant que l'écran est affiché */
let settingsTimer;
/** Terminaux lus au dernier passage : la liste se redessine aussitôt quand un agent change d'état. */
/** @type {{conversation: string, startedAt: number, memory: number | null}[]} */
let terminalStats = [];

/** Ouvre l'écran Configuration au centre, sur l'onglet Terminaux Claude. */
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
    return; // serveur injoignable : la liste garde ses dernières valeurs
  }
  if (panelView?.kind === "settings") renderSettingsPanel();
}

/** Terminaux ouverts, avec leur agent et son état, dans l'ordre d'affichage. */
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
      title: `Fermer le terminal de « ${clip(name, 50)} » ?`,
      message: state === "waiting"
        ? "Il attend ta réponse : sa demande sera abandonnée. Sa session est gardée, il la reprendra à la réouverture."
        : "Il est en train de travailler : son tour sera interrompu. Sa session est gardée, il la reprendra à la réouverture.",
      confirmLabel: "Fermer le terminal",
      danger: true,
    });
    if (!confirmed) return;
  }
  await api(`/api/conversations/${conversationId}/terminal-stop`, {});
  loadTerminalStats();
}

/** Onglet affiché dans l'écran Configuration. */
let settingsTab = "terminals";

/** Onglet Serveur : en marche depuis…, version, dernier redémarrage, et le bouton pour redémarrer. */
function serverPane() {
  const pane = el("div", "panel-pane");
  const info = serverInfo;
  const card = el("div", "server-card");
  const head = el("div", "server-card-head");
  const restarting = Boolean(info?.restart);
  head.append(el("span", `server-dot${restarting ? " warm" : ""}`),
    el("strong", "", restarting ? "Redémarrage demandé" : "Serveur en marche"));
  card.append(head);
  if (info) {
    const facts = el("dl", "account-details");
    fillFacts(facts, [
      ["Démarré", `${new Date(info.startedAt * 1000).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" })} (depuis ${formatSince(info.startedAt, Date.now() / 1000)})`],
      ["Version", info.version ? `commit ${info.version}` : null],
      ["Processus", `pid ${info.pid}`],
      ["Dernier redémarrage", info.lastRestart?.completedAt
        ? `${new Date(info.lastRestart.completedAt * 1000).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" })} · ${info.lastRestart.reopened} terminal${info.lastRestart.reopened > 1 ? "aux" : ""} rouvert${info.lastRestart.reopened > 1 ? "s" : ""}${info.lastRestart.resumed ? `, ${info.lastRestart.resumed} agent${info.lastRestart.resumed > 1 ? "s" : ""} relancé${info.lastRestart.resumed > 1 ? "s" : ""}` : ""}${info.lastRestart.forced ? " (forcé)" : ""}`
        : null],
    ]);
    card.append(facts);
  }
  const how = el("p", "muted small", "Redémarrer proprement : les agents au travail reçoivent une demande de pause, le serveur attend qu'ils soient au repos (20 min au plus), se relance avec la même commande, rouvre les terminaux et fait reprendre les agents mis en pause. La page se recharge et confirme le redémarrage.");
  const button = /** @type {HTMLButtonElement} */ (el("button", "primary", restarting ? "Redémarrage en cours…" : "Redémarrer le serveur"));
  button.type = "button";
  button.disabled = restarting;
  button.addEventListener("click", async () => {
    const working = [...conversations.values()].filter((c) => c.busy).map((c) => c.id);
    const confirmed = await confirmDialog({
      title: "Redémarrer le serveur ?",
      message: (working.length
        ? `${working.length} agent${working.length > 1 ? "s travaillent" : " travaille"} (${agentNames(working)}) : ${working.length > 1 ? "ils recevront une demande de pause et le serveur attendra la fin de leur étape" : "il recevra une demande de pause et le serveur attendra la fin de son étape"} (20 min au plus).`
        : "Aucun agent ne travaille : le serveur redémarre tout de suite.")
        + "\n\nLes terminaux ouverts seront rouverts, et la page se rechargera pour confirmer le redémarrage.",
      confirmLabel: "Redémarrer",
    });
    if (confirmed) restartAction("start");
  });
  card.append(how, button);
  pane.append(card);
  return pane;
}

function renderSettingsPanel() {
  const now = Date.now() / 1000;
  const items = terminalRows();
  const idle = items.filter((item) => isIdle(item.state));
  const working = items.length - idle.length;
  const total = items.reduce((sum, item) => sum + (item.memory ?? 0), 0);

  // Onglets de l'écran : les terminaux Claude ouverts, et le serveur (redémarrage).
  const tabs = el("div", "chat-tabs panel-tabs");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "Configuration");
  for (const [key, label] of [["terminals", "Terminaux Claude"], ["server", "Serveur"]]) {
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

  // En un coup d'œil : combien, qui t'attend ou travaille, combien de mémoire.
  const stat = (/** @type {string} */ value, /** @type {string} */ label, /** @type {string} */ tone = "") => {
    const tile = el("div", `settings-stat${tone ? ` ${tone}` : ""}`);
    tile.append(el("strong", "", value), el("span", "muted small", label));
    return tile;
  };
  const stats = el("div", "settings-stats");
  stats.append(
    stat(String(items.length), items.length > 1 ? "terminaux ouverts" : "terminal ouvert"),
    stat(String(working), "au travail ou en attente", working ? "warm" : ""),
    stat(items.length ? formatBytes(total) : "—", "mémoire utilisée"),
  );

  const toolbar = el("div", "terminals-toolbar");
  toolbar.append(el("p", "muted small", "Chaque agent garde son Claude Code ouvert en arrière-plan. Fermer un terminal libère sa mémoire ; l'agent reprend sa session quand tu le rouvres."));
  if (idle.length) {
    const closeIdle = el("button", "", idle.length > 1 ? `Fermer les ${idle.length} terminaux au repos` : "Fermer le terminal au repos");
    /** @type {HTMLButtonElement} */ (closeIdle).type = "button";
    closeIdle.addEventListener("click", async () => {
      const confirmed = await confirmDialog({
        title: idle.length > 1 ? `Fermer les ${idle.length} terminaux au repos ?` : "Fermer le terminal au repos ?",
        message: "Les agents au travail ou qui t'attendent restent ouverts. Les autres reprendront leur session à la réouverture.",
        confirmLabel: "Fermer",
      });
      if (!confirmed) return;
      await Promise.all(idle.map((item) => api(`/api/conversations/${item.conversation}/terminal-stop`, {}).catch(() => {})));
      loadTerminalStats();
    });
    toolbar.append(closeIdle);
  }

  const STATE_TEXT = { waiting: "Attend ta réponse", busy: "Au travail", active: "Au repos", inactive: "Au repos" };
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
    const pill = el("span", `state-pill state-${item.state}`, STATE_TEXT[/** @type {"waiting"} */ (item.state)] ?? "Au repos");
    const facts = el("div", "terminal-facts muted small");
    const since = formatSince(item.startedAt, now);
    facts.append(el("span", "", since === "à l'instant" ? "ouvert à l'instant" : `ouvert depuis ${since}`),
      el("span", "terminal-memory", formatBytes(item.memory)));
    const open = el("button", "", "Ouvrir");
    /** @type {HTMLButtonElement} */ (open).type = "button";
    open.addEventListener("click", async () => {
      await selectConversation(item.c.id);
      setTab("terminal");
    });
    const close = el("button", "danger-outline", "Fermer");
    /** @type {HTMLButtonElement} */ (close).type = "button";
    close.setAttribute("aria-label", `Fermer le terminal de « ${name} »`);
    close.addEventListener("click", () => closeTerminal(item.conversation, item.state, name).catch((err) => showPanelError(error, err)));
    const actions = el("div", "terminal-actions");
    actions.append(open, close);
    li.append(avatar, who, pill, facts, actions);
    list.append(li);
  }
  if (!items.length) list.append(el("li", "terminals-empty muted", "Aucun terminal Claude Code ouvert."));

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
    choiceTile(ICONS.agent, "Agent", "Claude Code dans le dossier de ton choix, ouvert dans son Terminal.", openNewAgentPanel),
    choiceTile(ICONS.workspace, "Workspace", "Un groupe pour ranger plusieurs agents ensemble. Il se replie dans la liste.", openWorkspaceForm),
  );
  if (!selectedId) {
    showIdleHero();
    return;
  }
  showPanel("Créer", el("p", "muted", "Que veux-tu créer ?"), error, choices);
  /** @type {HTMLElement | null} */ (choices.querySelector("button"))?.focus();
}

/** Ordre des agents autour de Ziggy : qui t'attend, qui travaille, qui est ouvert, puis les plus récents. */
const HERO_ORDER = { waiting: 0, busy: 1, active: 2, inactive: 3 };

/** Aucun agent ouvert : l'écran d'accueil animé, avec tes agents en orbite et les deux boutons pour créer. */
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
  const plural = (/** @type {number} */ n, /** @type {string} */ one, /** @type {string} */ many) => `${n} ${n > 1 ? many : one}`;
  const stats = [plural(active, "agent actif", "agents actifs"), busy ? plural(busy, "au travail", "au travail") : null,
    plural(workspaces.length, "workspace", "workspaces")].filter(Boolean).join(" · ");
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
  const label = el("label", "field-label", "Nom du workspace");
  label.setAttribute("for", "workspace-name");
  const input = /** @type {HTMLInputElement} */ (el("input", "text-input"));
  Object.assign(input, { id: "workspace-name", maxLength: 80, required: true, autocomplete: "off", placeholder: "Ex. Connecteurs batch" });
  const error = el("p", "form-error");
  error.hidden = true;
  const back = el("button", "", "Retour");
  back.type = "button";
  back.addEventListener("click", openCreatePanel);
  const submit = /** @type {HTMLButtonElement} */ (el("button", "primary", "Créer le workspace"));
  submit.type = "submit";
  const actions = el("div", "panel-actions");
  actions.append(back, submit);
  form.append(label, input, error, actions);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    try {
      const created = await api("/api/workspaces", { name: input.value });
      if (!workspaces.some((w) => w.id === created.id)) setWorkspaces([...workspaces, created]);
      openWorkspacePanel(created.id);
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
      submit.disabled = false;
    }
  });
  showPanel("Nouveau workspace", form);
  input.focus();
}

/**
 * Carte « Configurer le workspace » : nom, couleur, agents (à cocher), suppression.
 * Elle se met à jour sur place quand les données changent, sans perdre la recherche en cours.
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

  // Qui est ce workspace : icône, nom, nombre d'agents.
  const summary = el("div", "agent-summary workspace-summary");
  const badge = el("span", "workspace-icon big-avatar");
  badge.setAttribute("aria-hidden", "true");
  const summaryName = el("strong", "agent-summary-name");
  const summaryCount = el("span", "muted small");
  const summaryText = el("span", "agent-text");
  summaryText.append(summaryName, summaryCount);
  summary.append(badge, summaryText);

  // Nom.
  const nameForm = el("form", "settings-section");
  const nameLabel = el("label", "settings-title", "Nom");
  nameLabel.setAttribute("for", "workspace-rename");
  const nameInput = /** @type {HTMLInputElement} */ (el("input", "text-input"));
  Object.assign(nameInput, { id: "workspace-rename", maxLength: 80, required: true, autocomplete: "off" });
  const rename = el("button", "primary", "Renommer");
  /** @type {HTMLButtonElement} */ (rename).type = "submit";
  const nameRow = el("div", "inline-field");
  nameRow.append(nameInput, rename);
  nameForm.append(nameLabel, nameRow);
  nameForm.addEventListener("submit", (event) => {
    event.preventDefault();
    update({ name: nameInput.value });
  });

  // Couleur : automatique ou l'une des teintes proposées.
  const colorSection = el("div", "settings-section");
  const swatches = el("div", "swatches");
  swatches.setAttribute("role", "radiogroup");
  swatches.setAttribute("aria-label", "Couleur du workspace");
  /** @type {[HTMLElement, number | null][]} */
  const swatchButtons = [null, ...WORKSPACE_HUES].map((hue) => {
    const swatch = el("button", hue === null ? "swatch auto" : "swatch", hue === null ? "Auto" : "");
    /** @type {HTMLButtonElement} */ (swatch).type = "button";
    swatch.setAttribute("role", "radio");
    swatch.title = hue === null ? "Couleur automatique" : `Teinte ${hue}°`;
    if (hue !== null) swatch.style.setProperty("--agent-hue", String(hue));
    swatch.addEventListener("click", () => update({ hue }));
    return [swatch, hue];
  });
  swatches.append(...swatchButtons.map(([swatch]) => swatch));
  colorSection.append(el("h3", "settings-title", "Couleur"), swatches);

  // Activité partagée entre les agents du même dépôt.
  const shareSection = el("div", "settings-section");
  const shareToggle = el("label", "toggle");
  const shareBox = /** @type {HTMLInputElement} */ (el("input"));
  shareBox.type = "checkbox";
  shareBox.addEventListener("change", () => update({ shareActivity: shareBox.checked }));
  shareToggle.append(shareBox, el("span", "", "Partager l'activité entre les agents du même dépôt"));
  shareSection.append(
    el("h3", "settings-title", "Activité partagée"),
    shareToggle,
    el(
      "p",
      "muted small",
      "Avec chaque message, l'agent reçoit en quelques lignes ce que les autres agents de ce workspace ont fait dans le même dépôt depuis son message précédent : demandes, résultats, commits. C'est indiqué au-dessus de ton message.",
    ),
  );

  // Agents.
  const agentsSection = el("div", "settings-section agents-section");
  const search = /** @type {HTMLInputElement} */ (el("input", "text-input"));
  Object.assign(search, { type: "search", placeholder: "Rechercher un agent ou un dossier…", autocomplete: "off" });
  search.setAttribute("aria-label", "Rechercher un agent");
  const list = el("ul", "picker-list");
  agentsSection.append(
    el("h3", "settings-title", "Agents"),
    el("p", "muted small", "Coche les agents à ranger dans ce workspace. Un agent n'est que dans un workspace à la fois."),
    search,
    list,
  );

  // Suppression.
  const dangerSection = el("div", "settings-section danger-zone");
  const remove = el("button", "danger", "Supprimer le workspace");
  /** @type {HTMLButtonElement} */ (remove).type = "button";
  remove.addEventListener("click", async () => {
    const current = workspaces.find((w) => w.id === id);
    if (!current) return;
    const confirmed = await confirmDialog({
      title: `Supprimer « ${clip(current.name, 60)} » ?`,
      message: "Ses agents reviennent dans la liste générale. Aucun agent n'est arrêté ni supprimé.",
      confirmLabel: "Supprimer",
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
    el("h3", "settings-title", "Supprimer"),
    el("p", "muted small", "Ses agents reviennent dans la liste générale, sans être arrêtés ni supprimés."),
    remove,
  );

  const done = el("button", "primary", "Terminé");
  /** @type {HTMLButtonElement} */ (done).type = "button";
  done.addEventListener("click", closePanel);
  const footer = el("div", "panel-actions");
  footer.append(done);

  // Raccourcis communs à tous les agents du workspace.
  const shortcutsPane = el("div", "panel-pane");
  const shortcutsIntro = el("p", "muted small");
  shortcutsIntro.textContent = "Communs à tous les agents du workspace. Dans leur Terminal (Ctrl+Maj), ils viennent "
    + "après les raccourcis propres à chaque agent.";
  const shortcutsEditor = createShortcutsEditor({ el, icon, confirmDialog }, { emptyText: "Aucun raccourci commun.", digits: false });
  shortcutsPane.append(shortcutsIntro, shortcutsEditor.node);
  const settingsPane = el("div", "panel-pane");
  settingsPane.append(error, nameForm, colorSection, shareSection, agentsSection, dangerSection);

  // Deux onglets : Raccourcis, puis Configuration (toujours en dernier, ouvert par défaut).
  const tabs = el("div", "chat-tabs panel-tabs");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "Vue du workspace");
  const tabButtons = /** @type {[string, string, HTMLElement][]} */ ([["shortcuts", "Raccourcis", shortcutsPane], ["settings", "Configuration", settingsPane]])
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

  // Mise à jour sur place : appelée à l'ouverture et à chaque changement des données.
  panelRefresh = () => {
    shortcutsEditor.set(shortcutsData.workspaces[id] ?? [], (items) => saveShortcuts("workspace", id, items));
    const current = workspaces.find((w) => w.id === id);
    if (!current) {
      closePanel(); // supprimé (dans un autre onglet…)
      return;
    }
    const hue = workspaceHue(current);
    summary.style.setProperty("--agent-hue", String(hue));
    badge.textContent = initialOf(current.name);
    summaryName.textContent = current.name;
    const memberCount = splitByWorkspace(sessionRows(), workspaces).members.get(id)?.length ?? 0;
    summaryCount.textContent = memberCount === 0 ? "Aucun agent" : `${memberCount} agent${memberCount > 1 ? "s" : ""}`;
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
  drawSessions(); // encadre le workspace configuré
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
  if (rows.length === 0) list.append(el("li", "muted small", "Aucun agent ne correspond."));
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
  const details = [folder, elsewhere && `dans « ${elsewhere.name} »`].filter(Boolean).join(" · ");
  text.append(el("span", "session-name", label), el("span", "muted small", details));
  wrapper.append(box, avatar, text);
  item.append(wrapper);
  return item;
}

/** @param {boolean} [quiet] relecture automatique : une erreur n'est pas affichée */
async function refreshSessions(quiet = false) {
  try {
    renderSessions((await api(`/api/sessions${includeAgents()}`)).sessions);
  } catch (err) {
    if (!quiet) showToast(err.message);
  }
}

$("refresh-sessions").addEventListener("click", () => refreshSessions());

// Relecture de la liste, regroupée : plusieurs demandes rapprochées n'en font qu'une.
/** @type {number | undefined} */
let refreshSoonTimer;
function refreshSessionsSoon(delay = 1500) {
  clearTimeout(refreshSoonTimer);
  refreshSoonTimer = window.setTimeout(() => refreshSessions(true), delay);
}

// Les agents lancés dans un terminal ne préviennent pas : la liste est relue régulièrement,
// seulement quand l'onglet est visible (le serveur ne relit que les historiques qui ont changé).
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
  // Stockage indisponible : filtre « Actifs » par défaut.
}
for (const input of /** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll('input[name="session-filter"]'))) {
  input.checked = input.value === sessionFilter;
  input.addEventListener("change", () => {
    sessionFilter = input.value;
    try {
      localStorage.setItem("zo-session-filter", sessionFilter);
    } catch {
      // Stockage indisponible : le choix vaut pour cet onglet seulement.
    }
    drawSessions();
  });
}

$("chat-close").addEventListener("click", showIdle);

// --- onglets d'un agent : Terminal / Discussion / Git / Fichiers ------------------------------------------

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
// Terminal : le vrai Claude Code de l'agent (xterm.js), l'onglet par défaut.
const terminalView = mountTerminalView($("terminal-view"), { api, el });
// Discussion : la conversation de l'agent mise en forme, en lecture seule, à droite du Terminal.
const discussionView = mountDiscussionView($("discussion-view"), {
  api, el, renderMarkdown,
  agentName: (c) => displayName({ sessionId: c.sessionId || c.resumeFrom, conversation: c }),
  isRunning: (c) => terminalView.isRunning(c.id),
  // Le message part dans le Terminal, où l'on bascule pour suivre la réponse.
  send: async (c, text) => {
    if (selectedId === c.id) setTab("terminal");
    await terminalView.type(c, text);
  },
});
// Raccourcis : les prompts tout prêts de l'agent, et ceux de son workspace (en lecture ici).
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
// Panneau des raccourcis sur le Terminal (Ctrl+Maj), et son bouton dans la barre du Terminal.
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
      .then(() => terminalView.flash(`Raccourci envoyé : ${shortcutLabel(item.shortcut)}`))
      .catch((err) => terminalView.flash(`Envoi impossible : ${err instanceof Error ? err.message : err}`));
  },
  manage: () => setTab("shortcuts"),
});
{
  const button = el("button", "terminal-shortcuts");
  /** @type {HTMLButtonElement} */ (button).type = "button";
  button.title = "Raccourcis (maintenir Ctrl+Maj)";
  button.append(icon(SHORTCUT_ICONS.bolt), el("span", "", "Raccourcis"));
  button.addEventListener("mousedown", (event) => event.preventDefault()); // le terminal garde le clavier
  button.addEventListener("click", () => shortcutsPanel.toggle());
  terminalView.bar.insertBefore(button, terminalView.stopButton);
}
let activeTab = "terminal";
/** Dossier affiché par l'onglet Fichiers la dernière fois qu'il était visible (null : onglet caché). */
let filesShownFor = null;
const TABS = [["terminal", "terminal-view"], ["discussion", "discussion-view"], ["git", "git-view"], ["files", "files-view"],
  ["shortcuts", "shortcuts-view"], ["config", "config-view"]];
/** Agent dont l'onglet Configuration est affiché (null : onglet caché) ; le redessine quand ses réglages changent. */
let configShownFor = null;
/** @type {null | (() => void)} */
let configRefresh = null;

/** Agent affiché, ou null. */
const selectedConversation = () => (selectedId ? conversations.get(selectedId) ?? null : null);

/** Dossier de l'agent affiché s'il est dans un dépôt git, sinon null. */
function selectedGitFolder() {
  const c = selectedConversation();
  if (!c) return null;
  const row = sessionRows().find((r) => r.conversation === c);
  return c.git || row?.git ? c.cwd : null;
}

/** Onglets d'un agent ouvert : Git seulement pour un dépôt ; un écran se charge quand on l'affiche. */
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
  // Fichiers : chargé à l'arrivée sur l'onglet ou au changement d'agent, pas à chaque statut reçu.
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
  // Configuration : dessinée à l'arrivée sur l'onglet ou au changement d'agent, puis quand ses réglages changent.
  const configKey = activeTab === "config" && conversation ? conversation.sessionId || conversation.resumeFrom || conversation.id : null;
  if (configKey !== configShownFor) {
    configShownFor = configKey;
    avatarEditor = null; // éditeur neuf pour chaque agent
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
// Clavier : ← / → passent d'un onglet visible à l'autre.
$("chat-tabs").addEventListener("keydown", (event) => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  const visible = TABS.map(([tab]) => tab).filter((tab) => !$(`tab-${tab}`).hidden);
  const step = event.key === "ArrowRight" ? 1 : -1;
  setTab(visible[(visible.indexOf(activeTab) + step + visible.length) % visible.length]);
});
// Ctrl+P : ouvre l'onglet Fichiers sur la recherche (au lieu de l'impression du navigateur).
document.addEventListener("keydown", (event) => {
  if (inTerminal(event) || inTasksMode()) return;
  if (event.key.toLowerCase() !== "p" || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
  if (!selectedConversation() || isDialogOpen()) return;
  event.preventDefault();
  if (activeTab !== "files") setTab("files");
  filesView.focusSearch();
});
// Modifications non enregistrées : le navigateur demande confirmation avant de quitter la page.
window.addEventListener("beforeunload", (event) => {
  if (filesView.hasUnsavedChanges()) event.preventDefault();
});

// --- nouvel agent : choix du dossier où il travaillera -------------------------------------

/** @param {string} path */
const baseName = (path) => path.split("/").filter(Boolean).pop() || "/";

/**
 * Carte « Nouvel agent » : un dossier courant, choisi parmi les récents ou en parcourant ;
 * le bouton crée l'agent dans ce dossier.
 */
/** @param {string} [workspaceId] workspace proposé d'office pour le nouvel agent */
function openNewAgentPanel(workspaceId) {
  panelView = { kind: "new-agent" };
  panelRefresh = null;
  const error = el("p", "form-error");
  error.hidden = true;
  let current = "";

  // Nom : par défaut celui du dossier de travail (numéroté s'il est déjà pris), qui suit le dossier choisi
  // tant qu'on ne l'a pas modifié. Laissé vide, l'agent prend quand même le nom du dossier.
  const nameForm = el("form", "settings-section");
  const nameLabel = el("label", "settings-title", "Nom");
  nameLabel.setAttribute("for", "new-agent-name");
  const nameInput = /** @type {HTMLInputElement} */ (el("input", "text-input"));
  Object.assign(nameInput, { id: "new-agent-name", maxLength: 80, autocomplete: "off" });
  let nameEdited = false;
  nameInput.addEventListener("input", () => (nameEdited = nameInput.value.trim() !== ""));
  nameForm.append(nameLabel, nameInput, el("p", "muted small", "Par défaut, le nom du dossier de travail."));
  // Workspace où ranger l'agent dès sa création (facultatif) ; proposé seulement s'il en existe.
  const workspaceSection = el("div", "settings-section");
  const workspaceLabel = el("label", "settings-title", "Workspace");
  workspaceLabel.setAttribute("for", "new-agent-workspace");
  const workspaceSelect = /** @type {HTMLSelectElement} */ (el("select", "text-input"));
  workspaceSelect.id = "new-agent-workspace";
  workspaceSelect.append(new Option("Aucun workspace", ""), ...workspaces.map((w) => new Option(w.name, w.id)));
  workspaceSelect.value = workspaces.some((w) => w.id === workspaceId) ? workspaceId ?? "" : "";
  workspaceSection.append(workspaceLabel, workspaceSelect);
  workspaceSection.hidden = workspaces.length === 0;
  /** Nom par défaut pour le dossier choisi : son nom, unique parmi les agents. */
  const defaultName = () => {
    const taken = [...sessionRows().map(customName), ...Object.values(agentSettings).flatMap((s) => [s.name, s.generated])];
    return uniqueName(current ? baseName(current) : "", /** @type {string[]} */ (taken.filter(Boolean)));
  };
  nameForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!create.disabled) create.click();
  });

  // Récents : les derniers dossiers où des agents ont travaillé.
  const recentSection = el("div", "settings-section");
  const recentList = el("div", "recent-folders");
  recentList.append(el("p", "muted small", "Chargement…"));
  recentSection.append(el("h3", "settings-title", "Récents"), recentList);
  /** @type {[HTMLElement, string][]} */
  let recentButtons = [];

  // Parcourir : chemin éditable, fil d'Ariane, sous-dossiers.
  const browseSection = el("div", "settings-section browse-section");
  const pathForm = el("form", "inline-field path-field");
  const pathInput = /** @type {HTMLInputElement} */ (el("input", "text-input"));
  Object.assign(pathInput, { spellcheck: false, autocomplete: "off", placeholder: "/chemin/du/dossier" });
  pathInput.setAttribute("aria-label", "Chemin du dossier");
  const go = el("button", "", "Aller");
  /** @type {HTMLButtonElement} */ (go).type = "submit";
  pathForm.append(pathInput, go);
  pathForm.addEventListener("submit", (event) => {
    event.preventDefault();
    browse(pathInput.value);
  });
  const crumbs = el("nav", "breadcrumb");
  crumbs.setAttribute("aria-label", "Dossier courant");
  const dirList = el("ul", "folder-list");

  // Nouveau dossier dans le dossier courant : un lien, qui ouvre un champ pour son nom.
  const newFolder = el("button", "link-button new-folder-toggle");
  /** @type {HTMLButtonElement} */ (newFolder).type = "button";
  newFolder.append(icon(ICONS.folderPlus), el("span", "", "Nouveau dossier ici"));
  const newFolderForm = el("form", "inline-field new-folder-form");
  newFolderForm.hidden = true;
  const newFolderInput = /** @type {HTMLInputElement} */ (el("input", "text-input"));
  Object.assign(newFolderInput, { maxLength: 255, required: true, spellcheck: false, autocomplete: "off", placeholder: "Nom du dossier" });
  newFolderInput.setAttribute("aria-label", "Nom du nouveau dossier");
  const newFolderSubmit = /** @type {HTMLButtonElement} */ (el("button", "primary", "Créer"));
  newFolderSubmit.type = "submit";
  const newFolderCancel = el("button", "", "Annuler");
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
      event.stopPropagation(); // Échap ferme le champ, pas la carte
      toggleNewFolder(false);
      newFolder.focus();
    }
  });
  newFolderForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    newFolderSubmit.disabled = true;
    try {
      // Le dossier créé devient le dossier courant : l'agent y travaillera.
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
  browseSection.append(el("h3", "settings-title", "Parcourir"), pathForm, crumbs, dirList, newFolder, newFolderForm);

  // Pied : le dossier choisi et la création.
  const chosen = el("p", "chosen-folder");
  const back = el("button", "", "Retour");
  /** @type {HTMLButtonElement} */ (back).type = "button";
  back.addEventListener("click", openCreatePanel);
  const create = /** @type {HTMLButtonElement} */ (el("button", "primary", "Créer l'agent"));
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

    // Fil d'Ariane : chaque segment ramène à son dossier.
    const parts = listing.path.split("/").filter(Boolean);
    const segments = [["/", "/"], ...parts.map((part, i) => [part, `/${parts.slice(0, i + 1).join("/")}`])];
    crumbs.replaceChildren(...segments.map(([label, target], i) => {
      const crumb = el("button", i === segments.length - 1 ? "crumb current" : "crumb", label);
      /** @type {HTMLButtonElement} */ (crumb).type = "button";
      if (i === segments.length - 1) crumb.setAttribute("aria-current", "location");
      crumb.addEventListener("click", () => browse(target));
      return crumb;
    }));

    // Sous-dossiers : un clic entre dedans.
    const items = [];
    if (listing.parent) items.push(folderEntry("Dossier parent", listing.parent, ICONS.up));
    const join = (/** @type {string} */ name) => (listing.path.endsWith("/") ? listing.path + name : `${listing.path}/${name}`);
    items.push(...listing.dirs.map((/** @type {string} */ name) => folderEntry(name, join(name), ICONS.workspace)));
    if (listing.dirs.length === 0) items.push(el("li", "muted small folder-empty", "Aucun sous-dossier."));
    if (listing.truncated) items.push(el("li", "muted small folder-empty", "Liste tronquée : tape le chemin pour aller plus loin."));
    dirList.replaceChildren(...items);
    dirList.scrollTop = 0;

    for (const [button, folderPath] of recentButtons) button.setAttribute("aria-pressed", String(folderPath === current));
    chosen.replaceChildren(el("span", "muted small", "Dossier : "), el("strong", "", baseName(current)));
    chosen.title = current;
    create.textContent = `Créer l'agent dans « ${clip(baseName(current), 30)} »`;
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

  showPanel("Nouvel agent", el("p", "muted", "Choisis le dossier dans lequel l'agent va travailler."), error, nameForm, workspaceSection, recentSection, browseSection, footer);

  // Récents : 5 d'abord, puis 10 de plus à chaque « Afficher plus ».
  let recentLimit = 5;
  const more = el("button", "link-button", "Afficher plus de récents");
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
      const agents = `${folder.agents} agent${folder.agents > 1 ? "s" : ""}`;
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
    else recentList.replaceChildren(el("p", "muted small", "Aucun dossier récent : parcours ci-dessous."));
    for (const [card, folderPath] of recentButtons) card.setAttribute("aria-pressed", String(folderPath === current));
    more.hidden = !hasMore;
    return folders;
  }

  // Point de départ : le dossier le plus récent, sinon le dossier par défaut du serveur.
  loadRecents()
    .then((folders) => browse(folders[0]?.path || defaultCwd))
    .catch((err) => {
      recentList.replaceChildren();
      showPanelError(error, err);
      return browse(defaultCwd);
    });
}

// --- réglages des agents : nom personnalisé, agents supprimés --------------------------------

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
 * Nom donné à l'agent, s'il en a un (enregistré sous l'un de ses identifiants).
 *
 * @param {any} row
 */
const givenName = (row) => rowKeys(row).map((key) => agentSettings[key]?.name).find(Boolean);
/** Rôle de l'agent (donné aux autres agents dans leur annuaire), ou "". @param {any} row */
const agentRole = (row) => rowKeys(row).map((key) => agentSettings[key]?.role).find(Boolean) ?? "";

/**
 * Nom généré par le serveur pour un agent sans nom (« Loutre agile »), unique et stable.
 *
 * @param {any} row
 */
const generatedName = (row) => rowKeys(row).map((key) => agentSettings[key]?.generated).find(Boolean);

/**
 * Nom de l'agent : celui qu'on lui a donné, sinon son nom généré. Le dernier message passe en sous-titre.
 *
 * @param {any} row
 */
const customName = (row) => givenName(row) || generatedName(row);

/** @param {any} row */
const displayName = (row) => customName(row) || agentLabel(row);

/**
 * Réglages de Claude de l'agent (modèle, permissions, Chrome), enregistrés sous l'un de ses identifiants.
 *
 * @param {any} row
 * @returns {{model?: string, permissionMode?: string, chrome?: boolean}}
 */
const agentOptions = (row) => rowKeys(row).map((key) => agentSettings[key]?.options).find(Boolean) ?? {};

/**
 * Avatar choisi pour l'agent (abréviation, animal ou image), enregistré sous l'un de ses identifiants.
 *
 * @param {any} row
 * @returns {{abbr?: string, kind?: string, animal?: string, image?: string}}
 */
const agentAvatar = (row) => rowKeys(row).map((key) => agentSettings[key]?.avatar).find(Boolean) ?? {};

/** Réglages de Claude par défaut du serveur (ligne de commande). */
let claudeDefaults = { model: null, permissionMode: null, chrome: false };
const MODEL_LABELS = { opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" };
const PERMISSION_LABELS = {
  auto: "Auto (Claude décide)",
  default: "Manuel (il demande)",
  acceptEdits: "Modifications acceptées",
  plan: "Plan (lecture seule)",
};

/** @param {any} row */
const isHidden = (row) => rowKeys(row).some((key) => agentSettings[key]?.hidden);

/** Agents supprimés, du plus récent au plus ancien, avec de quoi les afficher. */
function hiddenAgents() {
  return Object.entries(agentSettings)
    .filter(([, settings]) => settings.hidden)
    .map(([key, settings]) => ({
      key,
      name: settings.name || settings.generated || settings.hidden?.label || `Agent ${key.slice(0, 8)}`,
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
 * Message d'erreur affiché dans la carte centrale.
 *
 * @param {HTMLElement} target
 * @param {unknown} err
 */
function showPanelError(target, err) {
  target.textContent = err instanceof Error ? err.message : String(err);
  target.hidden = false;
}

/**
 * Renomme l'agent ; un nom vide rend le nom généré. Claude Code ne prend son nom qu'au lancement : si son
 * terminal est ouvert, le serveur le ferme (après confirmation ici), et il sera rouvert sous le nouveau nom.
 *
 * @param {any} row
 * @param {string} name
 */
async function renameAgent(row, name) {
  const c = row.conversation;
  // Nom qu'aura l'agent : celui saisi (espaces réduits comme le fait le serveur), sinon son nom généré.
  const next = name.trim().replace(/\s+/g, " ") || generatedName(row) || "";
  if (c && terminalView.isRunning(c.id) && next !== (customName(row) ?? "")) {
    const confirmed = await confirmDialog({
      title: "Fermer Claude Code pour le renommer ?",
      message: "Les autres agents trouvent celui-ci par son nom de session, que Claude Code ne prend qu'à son lancement. "
        + "Son terminal va être fermé ; rouvre-le pour qu'il porte le nouveau nom (la discussion reprend là où elle en était)."
        + (c.busy ? "\n\nIl est en train de travailler : son tour en cours sera interrompu." : ""),
      confirmLabel: "Renommer et fermer",
      danger: Boolean(c.busy),
    });
    if (!confirmed) return;
  }
  const keys = name.trim()
    ? [rowKeys(row)[0]]
    : rowKeys(row).filter((key) => agentSettings[key]?.name); // effacer le nom, sous tous ses identifiants
  let settings = agentSettings;
  for (const key of keys) settings = (await api("/api/agents/rename", { agent: key, name })).agents;
  setAgentSettings(settings);
}

/**
 * Supprime l'agent de ziggy-one, après confirmation. Son historique Claude Code est conservé.
 *
 * @param {any} row
 */
async function deleteAgent(row) {
  const name = displayName(row);
  const c = row.conversation;
  const started = Boolean(row.sessionId);
  const details = started
    ? "Claude est arrêté s'il tourne dans ziggy-one, et l'agent quitte la liste, son workspace et les épingles."
      + (row.active ? " Il reste actif dans ton terminal." : "")
      + "\n\nSon historique Claude Code est conservé : tu pourras le restaurer depuis « Agents supprimés »."
    : "Cet agent n'a pas encore démarré : il est simplement retiré.";
  const confirmed = await confirmDialog({
    title: `Supprimer « ${clip(name, 60)} » ?`,
    message: details,
    confirmLabel: "Supprimer",
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
/** Rôle en cours de saisie : le panneau est reconstruit à chaque changement des réglages. @type {{key: string, value: string} | null} */
let roleDraft = null;

/** @param {string} key */
function renderAgentPanel(key) {
  const row = findRow(key);
  const view = $("config-view");
  if (!row) {
    view.replaceChildren(el("p", "muted config-missing", "Cet agent n'est plus dans la liste."));
    return;
  }
  const c = row.conversation;
  const name = displayName(row);
  const state = agentState(row);
  const error = el("p", "form-error");
  error.hidden = true;

  // Qui est cet agent : avatar, nom, état.
  const summary = el("div", `agent-summary session state-${state}`);
  const hue = String(agentHue(row.sessionId || c?.id || name));
  summary.style.setProperty("--agent-hue", hue);
  const letter = avatarLetter(customName(row), row.cwd, name);
  const avatar = avatarNode("agent-avatar big-avatar", agentAvatar(row), letter);
  avatar.append(el("span", "agent-dot"));

  // Avatar : le même éditeur d'un rendu à l'autre, pour garder un recadrage ou une recherche en cours.
  if (!avatarEditor) {
    avatarEditor = createAvatarEditor({
      el,
      save: async (chosen, image) => {
        const agent = rowKeys(findRow(key) ?? row)[0]; // la discussion a pu recevoir sa session entre-temps
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
  if (customName(row)) summaryText.append(el("span", "last-message", agentLabel(row))); // le dernier message reste visible
  summaryText.append(el("span", "muted small", stateLabel.charAt(0).toUpperCase() + stateLabel.slice(1)));
  summary.append(avatar, summaryText);

  // Nom.
  const nameForm = el("form", "settings-section");
  const nameInput = /** @type {HTMLInputElement} */ (el("input", "text-input"));
  Object.assign(nameInput, { id: "agent-name", value: givenName(row) || "", placeholder: generatedName(row) || agentLabel(row), maxLength: 80, autocomplete: "off" });
  const nameLabel = el("label", "settings-title", "Nom");
  nameLabel.setAttribute("for", "agent-name");
  const rename = el("button", "primary", "Renommer");
  /** @type {HTMLButtonElement} */ (rename).type = "submit";
  const nameRow = el("div", "inline-field");
  nameRow.append(nameInput, rename);
  nameForm.append(nameLabel, nameRow, el("p", "muted small", "Les autres agents le trouvent sous ce nom (outils ListAgents et SendMessage de Claude Code)."));
  // Vider le champ puis valider retire le nom : l'agent reprend son nom généré.
  nameForm.addEventListener("submit", (event) => {
    event.preventDefault();
    renameAgent(row, nameInput.value).catch((err) => showPanelError(error, err));
  });

  // Rôle : ce qu'on peut lui confier. Les autres agents le lisent dans leur annuaire au démarrage de leur session.
  const roleForm = el("form", "settings-section role-section");
  const roleLabel = el("label", "settings-title", "Rôle");
  roleLabel.setAttribute("for", "agent-role");
  const roleInput = /** @type {HTMLTextAreaElement} */ (el("textarea", "text-input"));
  const savedRole = agentRole(row);
  Object.assign(roleInput, {
    id: "agent-role", rows: 3, maxLength: 600,
    value: roleDraft?.key === key ? roleDraft.value : savedRole,
    placeholder: "Ex. : Envoie et lit les messages Teams et Outlook ; demande validation avant tout envoi.",
  });
  const saveRole = /** @type {HTMLButtonElement} */ (el("button", "primary", "Enregistrer le rôle"));
  saveRole.type = "submit";
  saveRole.disabled = roleInput.value.trim() === savedRole;
  roleInput.addEventListener("input", () => {
    roleDraft = { key, value: roleInput.value };
    saveRole.disabled = roleInput.value.trim() === savedRole;
  });
  roleForm.append(roleLabel, roleInput, saveRole, el("p", "muted small",
    "Les autres agents lancés par Ziggy le connaissent sous son nom et ce rôle, et savent lui écrire (SendMessage). "
    + "Pris en compte au prochain démarrage de leur session (ou /clear)."));
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
    const create = el("button", "link-button", "Créer un workspace");
    /** @type {HTMLButtonElement} */ (create).type = "button";
    create.addEventListener("click", openWorkspaceForm);
    workspaceSection.append(el("p", "muted small", "Aucun workspace pour l'instant."), create);
  } else {
    const select = /** @type {HTMLSelectElement} */ (el("select", "text-input"));
    select.id = "agent-workspace";
    select.append(new Option("Aucun workspace", ""), ...workspaces.map((w) => new Option(w.name, w.id)));
    select.value = current?.id ?? "";
    select.addEventListener("change", async () => {
      select.disabled = true;
      try {
        // Ajouter dans un workspace retire de l'ancien ; « Aucun » retire seulement.
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

  // Claude : modèle, permissions, Chrome — chaque liste rappelle la valeur par défaut du serveur.
  const claudeSection = el("div", "settings-section");
  const options = agentOptions(row);
  const permissionLabel = (/** @type {string | null} */ mode) => PERMISSION_LABELS[mode ?? "default"] ?? mode;
  /** @type {[string, string, [string, string][]][]} */
  const fields = [
    ["model", "Modèle", [["", `Par défaut (${claudeDefaults.model ? MODEL_LABELS[claudeDefaults.model] ?? claudeDefaults.model : "celui de Claude Code"})`],
      ...Object.entries(MODEL_LABELS)]],
    ["permissionMode", "Permissions", [["", `Par défaut (${permissionLabel(claudeDefaults.permissionMode)})`], ...Object.entries(PERMISSION_LABELS)]],
    ["chrome", "Claude in Chrome", [["", `Par défaut (${claudeDefaults.chrome ? "activé" : "désactivé"})`], ["true", "Activé (pilote ton Chrome)"], ["false", "Désactivé"]]],
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
    el("p", "muted small", "Les changements s'appliquent à la prochaine ouverture de Claude Code dans le Terminal (ferme-le puis rouvre-le)."),
  );

  // Informations.
  const infoSection = el("div", "settings-section");
  infoSection.append(el("h3", "settings-title", "Informations"));
  const info = el("dl", "settings-info");
  const addInfo = (/** @type {string} */ label, /** @type {string} */ value) => {
    if (value) info.append(el("dt", "", label), el("dd", "", value));
  };
  addInfo("Dossier", row.cwd || "");
  addInfo("Session", row.sessionId || "pas encore démarrée");
  addInfo("Actif dans", [c && "ziggy-one", row.active && "un terminal"].filter(Boolean).join(" et "));
  addInfo("Activité", row.updatedAt ? new Date(row.updatedAt * 1000).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" }) : "");
  addInfo("Coût", typeof row.costUsd === "number" ? `${row.costUsd.toFixed(4)} $` : "");
  const context = agentContext(row);
  addInfo("Contexte", context ? contextText(context) : "");
  infoSection.append(info);

  // Suppression.
  const dangerSection = el("div", "settings-section danger-zone");
  const remove = el("button", "danger", "Supprimer l'agent");
  /** @type {HTMLButtonElement} */ (remove).type = "button";
  remove.addEventListener("click", () => deleteAgent(row).catch((err) => showPanelError(error, err)));
  dangerSection.append(
    el("h3", "settings-title", "Supprimer"),
    el("p", "muted small", "Retire l'agent de ziggy-one. Son historique Claude Code est conservé et il peut être restauré."),
    remove,
  );

  const focused = avatarEditor.node.contains(document.activeElement) ? /** @type {HTMLElement} */ (document.activeElement) : null;
  const typingRole = document.activeElement?.id === "agent-role";
  const scroll = view.firstElementChild?.scrollTop ?? 0;
  const body = el("div", "panel-body config-body");
  body.append(summary, error, nameForm, roleForm, avatarEditor.node, workspaceSection, claudeSection, infoSection, dangerSection);
  view.replaceChildren(body);
  body.scrollTop = scroll; // reconstruit à chaque changement des réglages : on garde la position
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
    const details = [folder, agent.at && `supprimé ${shortDate(agent.at)}`].filter(Boolean).join(" · ");
    text.append(el("span", "session-name", agent.name), el("span", "muted small", details));
    const restore = el("button", "", "Restaurer");
    /** @type {HTMLButtonElement} */ (restore).type = "button";
    restore.setAttribute("aria-label", `Restaurer « ${agent.name} »`);
    restore.addEventListener("click", async () => {
      try {
        setAgentSettings((await api("/api/agents/restore", { agent: agent.key })).agents);
        refreshSessions(); // il peut être plus ancien que les sessions déjà chargées
      } catch (err) {
        showPanelError(error, err);
      }
    });
    item.append(avatar, text, restore);
    list.append(item);
  }
  const done = el("button", "primary", "Terminé");
  /** @type {HTMLButtonElement} */ (done).type = "button";
  done.addEventListener("click", closePanel);
  const footer = el("div", "panel-actions");
  footer.append(done);
  const intro = el("p", "muted small", "Ces agents ont été retirés de ziggy-one. Leur historique Claude Code est intact.");
  showPanel("Agents supprimés", intro, error, list, footer);
}

// --- notifications : agent qui termine son tour dans le Terminal (hook Stop de Claude Code) ------------
// Seulement pour un agent qui n'est pas sous les yeux (onglet en arrière-plan, ou autre agent affiché).
// Le titre de l'onglet compte les agents à consulter ; chaque notification a une étiquette (tag) :
// avec plusieurs onglets ouverts, elle ne s'affiche qu'une fois.

const NOTIFY_KEY = "zo-notifications";
/** @type {Set<string>} agents qui ont terminé un tour pas encore consulté */
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

/** Compteur dans le titre de l'onglet : agents à consulter. */
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
  return c ? displayName({ sessionId: c.sessionId || c.resumeFrom, conversation: c }) : "Un agent";
}

/**
 * @param {string} title
 * @param {string} body
 * @param {string} tag une notification remplace la précédente de même étiquette (et n'apparaît qu'une fois)
 * @param {string} conversationId agent ouvert au clic
 */
function notify(title, body, tag, conversationId) {
  if (!notificationsOn()) return;
  let notification;
  try {
    notification = new Notification(title, { body: clip(body, 180), tag });
  } catch (error) {
    showNotifyHint(`Notification refusée par le navigateur : ${error instanceof Error ? error.message : error}`);
    return;
  }
  notification.addEventListener("error", () => {
    showNotifyHint("Le navigateur n'a pas pu afficher la notification : vérifie les réglages de notifications du système.");
  });
  notification.addEventListener("click", () => {
    window.focus();
    if (conversations.has(conversationId)) selectConversation(conversationId);
    notification.close();
  });
}

/**
 * Fin d'un tour dans le Terminal : « du nouveau » sur l'agent, et une notification s'il n'est pas sous les yeux.
 *
 * @param {{conversation: string, summary: string}} data
 */
function onTurnEnd(data) {
  refreshSessionsSoon(); // dernier message, coût et contexte de la liste ont changé
  if (isWatched(data.conversation)) return;
  unseenConversations.add(data.conversation);
  updateAttention();
  drawSessions();
  notify(`${conversationName(data.conversation)} a terminé`, data.summary || "", `zo-done-${data.conversation}`, data.conversation);
}

// Revenir sur l'onglet efface le « du nouveau » de l'agent affiché.
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
    showNotifyHint("Ce navigateur ne gère pas les notifications.");
  } else if (Notification.permission === "denied") {
    showNotifyHint("Bloquées par le navigateur : autorise-les dans les réglages du site, puis recharge la page.");
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
    // Stockage indisponible : le choix vaut pour cet onglet seulement.
  }
  syncNotifyToggle();
  if (notifyToggle.checked !== enabled) {
    showNotifyHint("Ce navigateur n'enregistre pas le choix : les notifications restent coupées.");
  } else if (answer === "default") {
    // Demande fermée, ou masquée par Chrome (petite cloche barrée dans la barre d'adresse).
    showNotifyHint("Chrome n'a pas donné l'autorisation : clique sur l'icône à gauche de l'adresse, Notifications → Autoriser, puis réactive.");
  }
  if (enabled) notify("Notifications activées", "Ziggy One te préviendra quand un agent termine son tour.", "zo-test", "");
});
syncNotifyToggle();

// --- flux temps réel -------------------------------------------------------------

function connect() {
  // EventSource se reconnecte tout seul si le serveur redémarre.
  const source = new EventSource("/api/events");
  const on = (/** @type {string} */ name, /** @type {(data: any) => void} */ handler) =>
    source.addEventListener(name, (e) => handler(JSON.parse(/** @type {MessageEvent} */ (e).data)));
  // Coupure du flux (serveur arrêté ou relancé), puis reprise : le serveur a-t-il redémarré ?
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
    // Terminaux rouverts après le rechargement : la confirmation du redémarrage se complète.
    if (confirmingRestart && !data.state && data.last?.completedAt >= (serverInfo?.startedAt ?? Infinity)) showRestartDone();
    else renderRestartBanner();
    if (panelView?.kind === "settings") renderSettingsPanel();
  });
  on("usage", renderUsage);
  on("status", (status) => {
    if (panelView?.kind === "settings") window.setTimeout(renderSettingsPanel); // état de l'agent changé
    const wasWaiting = conversations.get(status.id)?.waiting;
    storeConversation(status);
    if (status.waiting && status.waiting !== wasWaiting && !isWatched(status.id)) {
      notify(`${conversationName(status.id)} attend ta réponse`, `Il attend ${WAITING_LABELS[status.waiting] ?? "ta réponse"}.`,
        `zo-waiting-${status.id}`, status.id);
    }
    if (status.waiting !== wasWaiting) updateAttention();
    if (status.id === selectedId) renderHeader();
    drawSessions();
  });
  on("turn_end", onTurnEnd);
  on("shell", (data) => discussionView.onShell(data)); // « !! commande » de la Discussion
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
  // Épingles changées dans un autre onglet (ou ici : même liste, rien ne bouge).
  on("pins", (/** @type {string[]} */ list) => {
    pins = list;
    drawSessions();
  });
  on("agents", setAgentSettings);
  on("shortcuts", setShortcuts);
}

// --- modes : Agents ou Tâches (tableaux Kanban) ----------------------------------
// La mise en page porte le mode (classe mode-tasks) : le CSS montre l'un ou l'autre, la logique des
// agents n'en dépend pas. Le mode est retenu par ce navigateur et visible dans l'adresse (#taches).

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
    // Stockage indisponible : le mode vaut pour cet onglet seulement.
  }
  // Adresse : « / » en mode Agents ; en mode Tâches, celle du ticket ouvert (/t/42) ou « /#taches ».
  const onTicket = ticketNumberFromPath(location.pathname) !== null;
  const url = mode === "agents" ? "/" : onTicket ? location.pathname : "/#taches";
  if (`${location.pathname}${location.hash}` !== url) history.replaceState(null, "", url);
}

// Lien vers un ticket (/t/42), où qu'il soit (description d'un ticket…) : ouvert ici, sans
// recharger la page ni ouvrir d'onglet.
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
window.addEventListener("hashchange", () => setMode(location.hash === "#taches" ? "tasks" : "agents"));
{
  let saved = null;
  try {
    saved = localStorage.getItem(MODE_KEY);
  } catch {
    // Stockage indisponible.
  }
  const onTicket = ticketNumberFromPath(location.pathname) !== null;
  setMode(onTicket || location.hash === "#taches" || (!location.hash && saved === "tasks") ? "tasks" : "agents");
}

async function init() {
  try {
    const state = await api(`/api/state${includeAgents()}`);
    serverInfo = state.server ?? null;
    renderAccount(state.account);
    renderUsage(state.usage);
    defaultCwd = state.defaultCwd;
    for (const status of state.conversations) storeConversation(status);
    updateAttention(); // agents qui attendent déjà ta réponse : dans le titre de l'onglet
    confirmRestart(); // page rechargée après un redémarrage : bandeau de confirmation
    renderRestartBanner(); // redémarrage déjà demandé (autre onglet) : bandeau d'attente
    terminalView.setRunning(state.terminals ?? []);
    discussionView.refreshComposer();
    workspaces = state.workspaces ?? []; // absents si le serveur est d'une version antérieure
    loadPins(state.pins ?? []);
    shortcutsData = { ...emptyShortcuts(), ...(state.shortcuts ?? {}) };
    agentSettings = state.agents ?? {};
    claudeDefaults = state.defaults ?? claudeDefaults;
    renderSessions(state.sessions);
    // Les agents des workspaces et les épingles reprises du navigateur n'étaient pas connus lors de la
    // requête : on les redemande, même anciens.
    if (workspaces.some((workspace) => workspace.agents.length) || pins.length > (state.pins ?? []).length) refreshSessions();
    connect();
    let saved = null;
    try {
      saved = localStorage.getItem("zo-selected-conversation");
    } catch {
      // Stockage indisponible.
    }
    if (saved && conversations.has(saved)) await selectConversation(saved);
    else showIdle();
    // Adresse d'un ticket (/t/42) : sa fiche s'ouvre une fois les tableaux chargés.
    const ticketNumber = ticketNumberFromPath(location.pathname);
    kanban.load().then(() => ticketNumber !== null && kanban.openNumber(ticketNumber));
  } catch (err) {
    // Session non authentifiée : le bandeau d'erreur est déjà affiché par api().
    console.error("Chargement de ziggy-one impossible :", err);
  }
}

init();

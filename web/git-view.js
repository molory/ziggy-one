// @ts-check
// Écran Git de la carte de discussion, façon Sourcetree : barre d'outils (fetch, pull, push,
// nouvelle branche), colonne de gauche (copie de travail, historique, branches), copie de travail
// (indexer, désindexer, annuler, commiter) et historique (graphe, détail d'un commit, diffs).

import { computeGraph } from "./git-graph.js";

const ROW_HEIGHT = 28; // px, doit suivre .commit-row dans style.css
const LANE_WIDTH = 14;
const MAX_DIFF_LINES = 4000;
/**
 * Avance/retard d'une branche sur sa branche distante, tel que git le donne (« ahead 2, behind 1 », « gone »).
 *
 * @param {string} track
 */
const formatTrack = (track) =>
  track.replace(/ahead (\d+)/, "↑$1").replace(/behind (\d+)/, "↓$1").replace(", ", " ").replace("gone", "distante supprimée");

const STATUS_LABELS = { M: "modifié", A: "ajouté", D: "supprimé", R: "renommé", C: "copié", U: "en conflit", T: "type changé", "?": "nouveau" };

/**
 * @typedef {object} GitViewDeps
 * @property {(path: string, body?: object) => Promise<any>} api
 * @property {(tag: string, className?: string, text?: string) => HTMLElement} el
 * @property {(d: string) => SVGElement} icon
 * @property {(options: {title: string, message: string, confirmLabel?: string, danger?: boolean}) => Promise<boolean>} confirmDialog
 * @property {(epochSeconds: number) => string} shortDate
 * @property {Record<string, string>} icons tracés d'icônes : refresh, fetch, pull, push, branch, plus, minus, undo
 */

/**
 * Texte d'une erreur pour la ligne de statut : le serveur explique les erreurs git ; une requête
 * qui n'aboutit pas du tout signifie que le serveur ziggy-one ne répond plus.
 *
 * @param {unknown} err
 */
function errorText(err) {
  if (err instanceof TypeError) return "Le serveur ziggy-one ne répond pas : vérifie qu'il tourne, puis recharge la page.";
  return err instanceof Error ? err.message : String(err);
}

/**
 * @param {HTMLElement} root conteneur de l'écran
 * @param {GitViewDeps} deps
 */
export function mountGitView(root, deps) {
  const { api, el, icon, confirmDialog, shortDate, icons } = deps;
  /** @type {string | null} dossier de l'agent (dans le dépôt) */
  let home = null;
  /** @type {string | null} dossier affiché : celui de l'agent, ou un autre worktree du dépôt */
  let path = null;
  /** @type {any} */
  let state = null;
  let view = "working"; // « working » (copie de travail) ou « history »
  /** @type {{mode: string, file: string, hash?: string} | null} */
  let selectedFile = null;
  /** @type {string | null} */
  let selectedCommit = null;
  let busy = false;

  // --- structure ---------------------------------------------------------------------
  const toolbar = el("div", "git-toolbar");
  const repoInfo = el("div", "git-repo");
  const actions = el("div", "git-actions");
  const fetchButton = toolButton(icons.fetch, "Fetch", "Récupérer les nouveautés du dépôt distant", () => runAction("fetch", {}, "Fetch terminé."));
  const pullButton = toolButton(icons.pull, "Pull", "Intégrer les commits distants (avance rapide seulement)", () => runAction("pull", {}, "Pull terminé."));
  const pushButton = toolButton(icons.push, "Push", "Envoyer les commits de la branche courante", () => runAction("push", {}, "Push terminé."));
  const branchButton = toolButton(icons.branch, "Branche", "Créer une branche depuis la position actuelle", () => toggleBranchForm(true));
  const refreshButton = toolButton(icons.refresh, "", "Actualiser", () => refresh());
  actions.append(fetchButton, pullButton, pushButton, branchButton, refreshButton);
  toolbar.append(repoInfo, actions);

  const sidebar = el("nav", "git-sidebar");
  sidebar.setAttribute("aria-label", "Dépôt");
  const main = el("div", "git-main");
  const body = el("div", "git-body");
  body.append(sidebar, main);
  const statusLine = el("p", "git-status-line");
  statusLine.setAttribute("aria-live", "polite");
  // Bandeau quand on regarde un autre worktree que celui de l'agent, avec de quoi y revenir.
  const elsewhereBar = el("div", "git-elsewhere");
  elsewhereBar.hidden = true;
  const elsewhereText = el("span", "git-elsewhere-text");
  const backHome = el("button", "", "Revenir au dossier de l'agent");
  /** @type {HTMLButtonElement} */ (backHome).type = "button";
  backHome.addEventListener("click", () => home && show(home));
  elsewhereBar.append(elsewhereText, backHome);
  root.replaceChildren(toolbar, elsewhereBar, body, statusLine);

  // Formulaire « nouvelle branche », affiché dans la colonne de gauche.
  const branchForm = el("form", "git-branch-form");
  const branchInput = /** @type {HTMLInputElement} */ (el("input", "text-input"));
  Object.assign(branchInput, { placeholder: "nom-de-branche", autocomplete: "off", spellcheck: false });
  branchInput.setAttribute("aria-label", "Nom de la nouvelle branche");
  const branchCreate = el("button", "primary", "Créer");
  /** @type {HTMLButtonElement} */ (branchCreate).type = "submit";
  branchForm.append(branchInput, branchCreate);
  branchForm.hidden = true;
  branchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    runAction("branch", { name: branchInput.value.trim() }, `Branche « ${branchInput.value.trim()} » créée.`)
      .then((ok) => ok && toggleBranchForm(false));
  });
  branchInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      toggleBranchForm(false);
    }
  });

  /**
   * @param {string} iconPath
   * @param {string} label
   * @param {string} title
   * @param {() => void} onClick
   */
  function toolButton(iconPath, label, title, onClick) {
    const button = el("button", "git-tool");
    /** @type {HTMLButtonElement} */ (button).type = "button";
    button.title = title;
    button.setAttribute("aria-label", label || title);
    button.append(icon(iconPath));
    if (label) button.append(el("span", "", label));
    button.addEventListener("click", onClick);
    return button;
  }

  /** @param {boolean} open */
  function toggleBranchForm(open) {
    branchForm.hidden = !open;
    if (open) {
      branchInput.value = "";
      branchInput.focus();
    }
  }

  /**
   * @param {string} message
   * @param {"info" | "error"} [kind]
   */
  function setStatus(message, kind = "info") {
    statusLine.textContent = message;
    statusLine.className = `git-status-line ${kind}`;
  }

  // --- données -----------------------------------------------------------------------

  /** @param {string} route */
  const read = (route) => api(`/api/git/${route}${route.includes("?") ? "&" : "?"}path=${encodeURIComponent(path ?? "")}`);

  async function refresh() {
    if (!path) return;
    try {
      state = await read("state");
      renderToolbar();
      renderSidebar();
      await renderMain();
    } catch (err) {
      setStatus(errorText(err), "error");
    }
  }

  /**
   * Lance une action git ; l'interface est bloquée pendant ce temps. Renvoie true si elle a réussi.
   *
   * @param {string} action
   * @param {object} params
   * @param {string} success
   */
  async function runAction(action, params, success) {
    if (busy || !path) return false;
    busy = true;
    root.classList.add("busy");
    setStatus("Git travaille…");
    try {
      const result = await api(`/api/git/${action}`, { path, ...params });
      state = result.state;
      setStatus(result.output ? `${success}\n${result.output}` : success);
      renderToolbar();
      renderSidebar();
      await renderMain();
      return true;
    } catch (err) {
      setStatus(errorText(err), "error");
      return false;
    } finally {
      busy = false;
      root.classList.remove("busy");
    }
  }

  // --- barre d'outils et colonne de gauche ------------------------------------------------

  function renderToolbar() {
    const branch = state.detached ? "HEAD détachée" : state.branch;
    const sync = [];
    if (state.ahead) sync.push(`↑${state.ahead}`);
    if (state.behind) sync.push(`↓${state.behind}`);
    repoInfo.replaceChildren(
      el("strong", "git-repo-name", state.name),
      el("span", "git-branch-chip", branch || "—"),
      ...(sync.length ? [el("span", "git-sync", sync.join(" "))] : []),
    );
    repoInfo.title = `${state.root}${state.upstream ? ` · suit ${state.upstream}` : " · pas de branche distante associée"}`;
    elsewhereBar.hidden = path === home;
    elsewhereText.textContent = `Worktree ${state.root}`;
    elsewhereText.title = state.root;
    pullButton.classList.toggle("attention", state.behind > 0);
    pushButton.classList.toggle("attention", state.ahead > 0 || (!state.upstream && !state.detached));
  }

  function renderSidebar() {
    const changes = state.files.staged.length + state.files.unstaged.length + state.files.untracked.length;
    const section = (/** @type {string} */ title) => el("h4", "git-section-title", title);
    const entry = (/** @type {string} */ label, /** @type {boolean} */ active, /** @type {() => void} */ onClick, /** @type {string} */ extra = "") => {
      const button = el("button", `git-nav${active ? " active" : ""}`);
      /** @type {HTMLButtonElement} */ (button).type = "button";
      button.append(el("span", "git-nav-label", label));
      if (extra) button.append(el("span", "git-count", extra));
      if (active) button.setAttribute("aria-current", "true");
      button.addEventListener("click", onClick);
      return button;
    };
    const local = state.branches.local.map((/** @type {any} */ branch) => {
      // Une branche ouverte dans un autre worktree ne peut pas l'être ici : un clic affiche ce worktree.
      const onClick = branch.worktree ? () => show(branch.worktree) : () => switchBranch(branch.name);
      const button = entry(branch.name, branch.current, onClick, formatTrack(branch.track));
      button.classList.add("git-branch");
      if (branch.worktree) {
        button.append(el("span", "git-worktree-badge", "worktree"));
        button.title = `Ouverte dans le worktree ${branch.worktree} : clic pour l'afficher`;
      } else {
        button.title = branch.current ? "Branche courante" : `Passer sur ${branch.name}`;
      }
      return button;
    });
    const remote = state.branches.remote.map((/** @type {string} */ name) => {
      const button = entry(name, false, () => switchBranch(name));
      button.classList.add("git-branch", "remote");
      button.title = `Créer une branche locale qui suit ${name}`;
      return button;
    });
    sidebar.replaceChildren(
      section("Espace de travail"),
      entry("Copie de travail", view === "working", () => showView("working"), changes ? String(changes) : ""),
      entry("Historique", view === "history", () => showView("history")),
      section("Branches"),
      branchForm,
      ...local,
      ...(remote.length ? [section("Distantes"), ...remote] : []),
    );
  }

  /** @param {string} name */
  async function switchBranch(name) {
    const local = state.branches.local.find((/** @type {any} */ b) => b.name === name);
    if (local?.current) return;
    await runAction("checkout", { branch: name }, `Passé sur ${name.includes("/") && !local ? name.split("/").slice(1).join("/") : name}.`);
  }

  /** @param {string} next */
  function showView(next) {
    view = next;
    selectedFile = null;
    renderSidebar();
    renderMain();
  }

  // --- zone principale -----------------------------------------------------------------

  async function renderMain() {
    if (view === "working") renderWorkingCopy();
    else await renderHistory();
  }

  function renderWorkingCopy() {
    const { staged, unstaged, untracked } = state.files;
    const all = [...unstaged.map((/** @type {any} */ f) => ({ ...f, mode: "unstaged" })), ...untracked.map((/** @type {any} */ f) => ({ ...f, mode: "untracked" }))];
    if (selectedFile && ![...all, ...staged.map((/** @type {any} */ f) => ({ ...f, mode: "staged" }))].some((f) => f.path === selectedFile?.file && f.mode === selectedFile?.mode)) {
      selectedFile = null;
    }

    const lists = el("div", "git-file-lists");
    lists.append(
      fileGroup("Indexés", staged.map((/** @type {any} */ f) => ({ ...f, mode: "staged" })), {
        allLabel: "Tout désindexer",
        all: () => runAction("unstage", {}, "Fichiers désindexés."),
        rowActions: (file) => [rowButton(icons.minus, "Désindexer", () => runAction("unstage", { files: [file.path] }, `${file.path} désindexé.`))],
      }),
      fileGroup("Non indexés", all, {
        allLabel: "Tout indexer",
        all: () => runAction("stage", {}, "Fichiers indexés."),
        rowActions: (file) => [
          rowButton(icons.undo, "Annuler les modifications", () => discard(file)),
          rowButton(icons.plus, "Indexer", () => runAction("stage", { files: [file.path] }, `${file.path} indexé.`)),
        ],
      }),
    );

    const diffPane = el("div", "git-diff-pane");
    if (selectedFile) loadDiff(diffPane, selectedFile);
    else diffPane.append(el("p", "muted small git-placeholder", staged.length + all.length ? "Sélectionne un fichier pour voir ses modifications." : "Aucune modification : la copie de travail est propre."));

    // Commit.
    const commitBox = el("form", "git-commit-box");
    const message = /** @type {HTMLTextAreaElement} */ (el("textarea", "text-input"));
    Object.assign(message, {
      rows: 2,
      placeholder: staged.length
        ? "Message du commit… (laisse vide pour le générer et commiter) · Ctrl+Entrée pour commiter"
        : "Indexe des fichiers pour pouvoir commiter.",
    });
    message.setAttribute("aria-label", "Message du commit");
    const commitButton = /** @type {HTMLButtonElement} */ (el("button", "primary", `Commiter${staged.length ? ` (${staged.length})` : ""}`));
    commitButton.type = "submit";
    commitButton.disabled = staged.length === 0;
    commitBox.append(message, commitButton);
    commitBox.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (staged.length === 0) {
        // Ctrl+Entrée passe outre le bouton désactivé : on explique plutôt que de tenter le commit.
        setStatus("Aucun fichier indexé : indexe des fichiers (bouton + ou « Tout indexer ») avant de commiter.", "error");
        return;
      }
      if (!message.value.trim()) {
        // Champ vide : Claude écrit le message, puis le commit se fait aussitôt avec ce message.
        commitButton.disabled = true;
        commitButton.textContent = "Génération…";
        setStatus("Claude écrit le message de commit…");
        let generated;
        try {
          generated = (await api("/api/git/message", { path })).message;
        } catch (err) {
          setStatus(errorText(err), "error");
          commitButton.disabled = false;
          commitButton.textContent = `Commiter (${staged.length})`;
          return;
        }
        message.value = generated; // visible pendant le commit (et conservé s'il échoue)
        runAction("commit", { message: generated }, `Commit créé avec le message généré :\n${generated}`);
        return;
      }
      runAction("commit", { message: message.value }, "Commit créé.");
    });
    message.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) commitBox.requestSubmit();
    });

    const top = el("div", "git-working");
    top.append(lists, diffPane);
    main.replaceChildren(top, commitBox);
  }

  /**
   * @param {string} title
   * @param {any[]} files
   * @param {{allLabel: string, all: () => void, rowActions: (file: any) => HTMLElement[]}} options
   */
  function fileGroup(title, files, options) {
    const group = el("section", "git-file-group");
    const head = el("div", "git-file-head");
    head.append(el("h4", "git-section-title", `${title} (${files.length})`));
    if (files.length) {
      const all = el("button", "link-button", options.allLabel);
      /** @type {HTMLButtonElement} */ (all).type = "button";
      all.addEventListener("click", options.all);
      head.append(all);
    }
    const list = el("ul", "git-files");
    for (const file of files) {
      const item = el("li", `git-file${selectedFile?.file === file.path && selectedFile?.mode === file.mode ? " selected" : ""}`);
      const open = el("button", "git-file-open");
      /** @type {HTMLButtonElement} */ (open).type = "button";
      open.title = `${STATUS_LABELS[file.code] || file.code} : ${file.from ? `${file.from} → ` : ""}${file.path}`;
      open.append(el("span", `git-code code-${file.code === "?" ? "N" : file.code}`, file.code === "?" ? "N" : file.code), el("span", "git-file-name", file.path));
      open.addEventListener("click", () => {
        selectedFile = { mode: file.mode, file: file.path };
        renderWorkingCopy();
      });
      const rowActions = el("span", "git-row-actions");
      rowActions.append(...options.rowActions(file));
      item.append(open, rowActions);
      list.append(item);
    }
    if (!files.length) list.append(el("li", "muted small git-empty", "Aucun fichier."));
    group.append(head, list);
    return group;
  }

  /**
   * @param {string} iconPath
   * @param {string} label
   * @param {() => void} onClick
   */
  function rowButton(iconPath, label, onClick) {
    const button = el("button", "git-row-button");
    /** @type {HTMLButtonElement} */ (button).type = "button";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.append(icon(iconPath));
    button.addEventListener("click", onClick);
    return button;
  }

  /** @param {any} file */
  async function discard(file) {
    const untracked = file.mode === "untracked";
    const confirmed = await confirmDialog({
      title: untracked ? `Supprimer « ${file.path} » ?` : `Annuler les modifications de « ${file.path} » ?`,
      message: untracked
        ? "Ce fichier n'est pas suivi par git : il sera supprimé du disque. C'est irréversible."
        : "Les modifications non indexées de ce fichier seront perdues. C'est irréversible.",
      confirmLabel: untracked ? "Supprimer" : "Annuler les modifications",
      danger: true,
    });
    if (confirmed) runAction("discard", { files: [file.path] }, `${file.path} : modifications annulées.`);
  }

  /**
   * @param {HTMLElement} pane
   * @param {{mode: string, file: string, hash?: string}} target
   */
  async function loadDiff(pane, target) {
    pane.replaceChildren(el("p", "muted small git-placeholder", "Chargement du diff…"));
    try {
      const hash = target.hash ? `&hash=${target.hash}` : "";
      const result = await read(`diff?mode=${target.mode}&file=${encodeURIComponent(target.file)}${hash}`);
      pane.replaceChildren(el("div", "git-diff-title", target.file), renderDiff(result.diff, result.truncated));
    } catch (err) {
      pane.replaceChildren(el("p", "form-error", errorText(err)));
    }
  }

  /**
   * @param {string} text
   * @param {boolean} truncated
   */
  function renderDiff(text, truncated) {
    const pre = el("pre", "git-diff");
    if (!text.trim()) {
      pre.append(el("span", "diff-meta", "Aucune différence textuelle (fichier binaire ou changement de droits)."));
      return pre;
    }
    const lines = text.split("\n");
    for (const line of lines.slice(0, MAX_DIFF_LINES)) {
      let kind = "";
      if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) kind = "diff-meta";
      else if (line.startsWith("@@")) kind = "diff-hunk";
      else if (line.startsWith("+")) kind = "diff-add";
      else if (line.startsWith("-")) kind = "diff-del";
      pre.append(el("span", kind, line)); // une ligne = un bloc (voir .git-diff > span)
    }
    if (truncated || lines.length > MAX_DIFF_LINES) pre.append(el("span", "diff-meta", "… diff tronqué."));
    return pre;
  }

  // --- historique ----------------------------------------------------------------------

  async function renderHistory() {
    const historyPane = el("div", "git-history");
    const details = el("div", "git-commit-details");
    main.replaceChildren(historyPane, details);
    let commits;
    try {
      commits = (await read("log?limit=300")).commits;
    } catch (err) {
      historyPane.replaceChildren(el("p", "form-error", errorText(err)));
      return;
    }
    if (!commits.length) {
      historyPane.append(el("p", "muted small git-placeholder", "Aucun commit pour l'instant."));
      return;
    }
    const graph = computeGraph(commits);
    const list = el("ul", "git-commits");
    commits.forEach((/** @type {any} */ commit, index) => {
      const row = el("li", `commit-row${commit.hash === selectedCommit ? " selected" : ""}`);
      const button = el("button", "commit-open");
      /** @type {HTMLButtonElement} */ (button).type = "button";
      button.append(graphCell(graph[index]));
      const text = el("span", "commit-text");
      for (const ref of commit.refs) text.append(el("span", `git-ref ref-${ref.type}`, ref.name));
      text.append(el("span", "commit-subject", commit.subject));
      button.append(text, el("span", "commit-author", commit.author), el("span", "commit-date", shortDate(commit.date)), el("span", "commit-hash", commit.short));
      button.addEventListener("click", () => {
        selectedCommit = commit.hash;
        for (const other of list.children) other.classList.toggle("selected", other === row);
        showCommit(details, commit.hash);
      });
      row.append(button);
      list.append(row);
    });
    historyPane.append(list);
    if (selectedCommit && commits.some((/** @type {any} */ c) => c.hash === selectedCommit)) showCommit(details, selectedCommit);
    else details.append(el("p", "muted small git-placeholder", "Sélectionne un commit pour voir son détail."));
  }

  /** @param {import("./git-graph.js").GraphRow} row */
  function graphCell(row) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    const width = Math.max(1, row.width) * LANE_WIDTH;
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(ROW_HEIGHT));
    svg.setAttribute("class", "commit-graph");
    svg.setAttribute("aria-hidden", "true");
    const x = (/** @type {number} */ lane) => lane * LANE_WIDTH + LANE_WIDTH / 2;
    const y = (/** @type {number} */ unit) => unit * ROW_HEIGHT;
    for (const segment of row.segments) {
      const path = document.createElementNS(ns, "path");
      const [x1, y1, x2, y2] = [x(segment.x1), y(segment.y1), x(segment.x2), y(segment.y2)];
      // Ligne droite si même couloir, sinon courbe douce entre deux couloirs.
      const midY = (y1 + y2) / 2;
      path.setAttribute("d", x1 === x2 ? `M${x1} ${y1}L${x2} ${y2}` : `M${x1} ${y1}C${x1} ${midY} ${x2} ${midY} ${x2} ${y2}`);
      path.setAttribute("class", `lane-${segment.lane % 8}`);
      svg.append(path);
    }
    const dot = document.createElementNS(ns, "circle");
    dot.setAttribute("cx", String(x(row.lane)));
    dot.setAttribute("cy", String(ROW_HEIGHT / 2));
    dot.setAttribute("r", "4");
    dot.setAttribute("class", `lane-${row.lane % 8}`);
    svg.append(dot);
    return svg;
  }

  /**
   * @param {HTMLElement} details
   * @param {string} hash
   */
  async function showCommit(details, hash) {
    details.replaceChildren(el("p", "muted small git-placeholder", "Chargement…"));
    let commit;
    try {
      commit = await read(`commit?hash=${hash}`);
    } catch (err) {
      details.replaceChildren(el("p", "form-error", errorText(err)));
      return;
    }
    const header = el("div", "git-commit-header");
    header.append(
      el("strong", "git-commit-message", commit.message || "(sans message)"),
      el("span", "muted small", `${commit.author} · ${new Date(commit.date * 1000).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" })} · ${commit.hash.slice(0, 10)}`),
    );
    const files = el("ul", "git-files");
    const diffPane = el("div", "git-diff-pane");
    diffPane.append(el("p", "muted small git-placeholder", commit.files.length ? "Sélectionne un fichier." : "Aucun fichier modifié."));
    for (const file of commit.files) {
      const item = el("li", "git-file");
      const open = el("button", "git-file-open");
      /** @type {HTMLButtonElement} */ (open).type = "button";
      open.title = `${STATUS_LABELS[file.code] || file.code} : ${file.from ? `${file.from} → ` : ""}${file.path}`;
      open.append(el("span", `git-code code-${file.code}`, file.code), el("span", "git-file-name", file.path));
      open.addEventListener("click", () => {
        for (const other of files.children) other.classList.toggle("selected", other === item);
        loadDiff(diffPane, { mode: "commit", file: file.path, hash: commit.hash });
      });
      item.append(open);
      files.append(item);
    }
    const split = el("div", "git-commit-split");
    split.append(files, diffPane);
    details.replaceChildren(header, split);
  }

  /**
   * Affiche le dépôt de ce dossier (celui de l'agent, ou un autre worktree), depuis la copie de travail.
   *
   * @param {string} folder
   */
  function show(folder) {
    path = folder;
    state = null;
    view = "working";
    selectedFile = null;
    selectedCommit = null;
    setStatus("");
    toggleBranchForm(false);
    return refresh();
  }

  return {
    /**
     * Affiche le dépôt qui contient ce dossier.
     *
     * @param {string} folder
     */
    open(folder) {
      // Même agent : on reste sur le worktree affiché ; autre agent : on repart de son dossier.
      if (folder !== home) {
        home = folder;
        return show(folder);
      }
      return refresh();
    },
    refresh,
  };
}

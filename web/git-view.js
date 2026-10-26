// @ts-check
// Git screen of the chat card, Sourcetree style: toolbar (fetch, pull, push, new branch), left column
// (working copy, history, branches), working copy (stage, unstage, discard, commit) and history (graph,
// commit details, diffs).

import { computeGraph } from "./git-graph.js";
import { locale, t } from "./i18n.js";

const ROW_HEIGHT = 28; // px, must match .commit-row in style.css
const LANE_WIDTH = 14;
const MAX_DIFF_LINES = 4000;
/**
 * How far a branch is ahead of / behind its remote branch, as git gives it ("ahead 2, behind 1", "gone").
 *
 * @param {string} track
 */
const formatTrack = (track) =>
  track.replace(/ahead (\d+)/, "↑$1").replace(/behind (\d+)/, "↓$1").replace(", ", " ").replace("gone", t("remote deleted"));

const STATUS_LABELS = {
  M: t("modified"), A: t("added"), D: t("deleted"), R: t("renamed"), C: t("copied"), U: t("conflicted"), T: t("type changed"),
  "?": t("new"),
};

/**
 * @typedef {object} GitViewDeps
 * @property {(path: string, body?: object) => Promise<any>} api
 * @property {(tag: string, className?: string, text?: string) => HTMLElement} el
 * @property {(d: string) => SVGElement} icon
 * @property {(options: {title: string, message: string, confirmLabel?: string, danger?: boolean}) => Promise<boolean>} confirmDialog
 * @property {(epochSeconds: number) => string} shortDate
 * @property {Record<string, string>} icons icon paths: refresh, fetch, pull, push, branch, plus, minus, undo
 */

/**
 * Text of an error for the status line: the server explains git errors; a request that does not get
 * through at all means the ziggy-one server no longer answers.
 *
 * @param {unknown} err
 */
function errorText(err) {
  if (err instanceof TypeError) return t("The ziggy-one server is not responding: check that it is running, then reload the page.");
  return err instanceof Error ? err.message : String(err);
}

/**
 * @param {HTMLElement} root container of the screen
 * @param {GitViewDeps} deps
 */
export function mountGitView(root, deps) {
  const { api, el, icon, confirmDialog, shortDate, icons } = deps;
  /** @type {string | null} folder of the agent (inside the repository) */
  let home = null;
  /** @type {string | null} folder shown: the agent's, or another worktree of the repository */
  let path = null;
  /** @type {any} */
  let state = null;
  let view = "working"; // "working" (working copy) or "history"
  /** @type {{mode: string, file: string, hash?: string} | null} */
  let selectedFile = null;
  /** @type {string | null} */
  let selectedCommit = null;
  let busy = false;

  // --- structure ---------------------------------------------------------------------
  const toolbar = el("div", "git-toolbar");
  const repoInfo = el("div", "git-repo");
  const actions = el("div", "git-actions");
  const fetchButton = toolButton(icons.fetch, t("Fetch"), t("Get the latest changes from the remote repository"), () => runAction("fetch", {}, t("Fetch done.")));
  const pullButton = toolButton(icons.pull, t("Pull"), t("Bring in the remote commits (fast-forward only)"), () => runAction("pull", {}, t("Pull done.")));
  const pushButton = toolButton(icons.push, t("Push"), t("Send the commits of the current branch"), () => runAction("push", {}, t("Push done.")));
  const branchButton = toolButton(icons.branch, t("Branch"), t("Create a branch from the current position"), () => toggleBranchForm(true));
  const refreshButton = toolButton(icons.refresh, "", t("Refresh"), () => refresh());
  actions.append(fetchButton, pullButton, pushButton, branchButton, refreshButton);
  toolbar.append(repoInfo, actions);

  const sidebar = el("nav", "git-sidebar");
  sidebar.setAttribute("aria-label", t("Repository"));
  const main = el("div", "git-main");
  const body = el("div", "git-body");
  body.append(sidebar, main);
  const statusLine = el("p", "git-status-line");
  statusLine.setAttribute("aria-live", "polite");
  // Banner when looking at a worktree other than the agent's, with a way back.
  const elsewhereBar = el("div", "git-elsewhere");
  elsewhereBar.hidden = true;
  const elsewhereText = el("span", "git-elsewhere-text");
  const backHome = el("button", "", t("Back to the agent's folder"));
  /** @type {HTMLButtonElement} */ (backHome).type = "button";
  backHome.addEventListener("click", () => home && show(home));
  elsewhereBar.append(elsewhereText, backHome);
  root.replaceChildren(toolbar, elsewhereBar, body, statusLine);

  // "New branch" form, shown in the left column.
  const branchForm = el("form", "git-branch-form");
  const branchInput = /** @type {HTMLInputElement} */ (el("input", "text-input"));
  Object.assign(branchInput, { placeholder: t("branch-name"), autocomplete: "off", spellcheck: false });
  branchInput.setAttribute("aria-label", t("Name of the new branch"));
  const branchCreate = el("button", "primary", t("Create"));
  /** @type {HTMLButtonElement} */ (branchCreate).type = "submit";
  branchForm.append(branchInput, branchCreate);
  branchForm.hidden = true;
  branchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    runAction("branch", { name: branchInput.value.trim() }, t("Branch \"{name}\" created.", { name: branchInput.value.trim() }))
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

  // --- data --------------------------------------------------------------------------

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
   * Runs a git action; the interface is locked meanwhile. Returns true if it succeeded.
   *
   * @param {string} action
   * @param {object} params
   * @param {string} success
   */
  async function runAction(action, params, success) {
    if (busy || !path) return false;
    busy = true;
    root.classList.add("busy");
    setStatus(t("Git is working…"));
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

  // --- toolbar and left column ----------------------------------------------------------

  function renderToolbar() {
    const branch = state.detached ? t("detached HEAD") : state.branch;
    const sync = [];
    if (state.ahead) sync.push(`↑${state.ahead}`);
    if (state.behind) sync.push(`↓${state.behind}`);
    repoInfo.replaceChildren(
      el("strong", "git-repo-name", state.name),
      el("span", "git-branch-chip", branch || "—"),
      ...(sync.length ? [el("span", "git-sync", sync.join(" "))] : []),
    );
    repoInfo.title = `${state.root} · ${state.upstream ? t("tracks {upstream}", { upstream: state.upstream }) : t("no associated remote branch")}`;
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
      // A branch open in another worktree cannot be opened here: a click shows that worktree.
      const onClick = branch.worktree ? () => show(branch.worktree) : () => switchBranch(branch.name);
      const button = entry(branch.name, branch.current, onClick, formatTrack(branch.track));
      button.classList.add("git-branch");
      if (branch.worktree) {
        button.append(el("span", "git-worktree-badge", "worktree"));
        button.title = t("Open in the worktree {worktree}: click to show it", { worktree: branch.worktree });
      } else {
        button.title = branch.current ? t("Current branch") : t("Switch to {branch}", { branch: branch.name });
      }
      return button;
    });
    const remote = state.branches.remote.map((/** @type {string} */ name) => {
      const button = entry(name, false, () => switchBranch(name));
      button.classList.add("git-branch", "remote");
      button.title = t("Create a local branch tracking {branch}", { branch: name });
      return button;
    });
    sidebar.replaceChildren(
      section(t("Workspace")),
      entry(t("Working copy"), view === "working", () => showView("working"), changes ? String(changes) : ""),
      entry(t("History"), view === "history", () => showView("history")),
      section(t("Branches")),
      branchForm,
      ...local,
      ...(remote.length ? [section(t("Remote")), ...remote] : []),
    );
  }

  /** @param {string} name */
  async function switchBranch(name) {
    const local = state.branches.local.find((/** @type {any} */ b) => b.name === name);
    if (local?.current) return;
    await runAction("checkout", { branch: name }, t("Switched to {branch}.", { branch: name.includes("/") && !local ? name.split("/").slice(1).join("/") : name }));
  }

  /** @param {string} next */
  function showView(next) {
    view = next;
    selectedFile = null;
    renderSidebar();
    renderMain();
  }

  // --- main area -----------------------------------------------------------------------

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
      fileGroup(t("Staged"), staged.map((/** @type {any} */ f) => ({ ...f, mode: "staged" })), {
        allLabel: t("Unstage all"),
        all: () => runAction("unstage", {}, t("Files unstaged.")),
        rowActions: (file) => [rowButton(icons.minus, t("Unstage"), () => runAction("unstage", { files: [file.path] }, t("{file} unstaged.", { file: file.path })))],
      }),
      fileGroup(t("Unstaged"), all, {
        allLabel: t("Stage all"),
        all: () => runAction("stage", {}, t("Files staged.")),
        rowActions: (file) => [
          rowButton(icons.undo, t("Discard changes"), () => discard(file)),
          rowButton(icons.plus, t("Stage"), () => runAction("stage", { files: [file.path] }, t("{file} staged.", { file: file.path }))),
        ],
      }),
    );

    const diffPane = el("div", "git-diff-pane");
    if (selectedFile) loadDiff(diffPane, selectedFile);
    else diffPane.append(el("p", "muted small git-placeholder", staged.length + all.length ? t("Select a file to see its changes.") : t("No changes: the working copy is clean.")));

    // Commit.
    const commitBox = el("form", "git-commit-box");
    const message = /** @type {HTMLTextAreaElement} */ (el("textarea", "text-input"));
    Object.assign(message, {
      rows: 2,
      placeholder: staged.length
        ? t("Commit message… (leave empty to generate it and commit) · Ctrl+Enter to commit")
        : t("Stage files to be able to commit."),
    });
    message.setAttribute("aria-label", t("Commit message"));
    const commitButton = /** @type {HTMLButtonElement} */ (el("button", "primary", staged.length ? t("Commit ({count})", { count: staged.length }) : t("Commit")));
    commitButton.type = "submit";
    commitButton.disabled = staged.length === 0;
    commitBox.append(message, commitButton);
    commitBox.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (staged.length === 0) {
        // Ctrl+Enter bypasses the disabled button: explain instead of trying the commit.
        setStatus(t("No staged files: stage files (+ button or \"Stage all\") before committing."), "error");
        return;
      }
      if (!message.value.trim()) {
        // Empty field: Claude writes the message, then the commit is made right away with it.
        commitButton.disabled = true;
        commitButton.textContent = t("Generating…");
        setStatus(t("Claude is writing the commit message…"));
        let generated;
        try {
          generated = (await api("/api/git/message", { path })).message;
        } catch (err) {
          setStatus(errorText(err), "error");
          commitButton.disabled = false;
          commitButton.textContent = t("Commit ({count})", { count: staged.length });
          return;
        }
        message.value = generated; // visible during the commit (and kept if it fails)
        runAction("commit", { message: generated }, t("Commit created with the generated message:\n{message}", { message: generated }));
        return;
      }
      runAction("commit", { message: message.value }, t("Commit created."));
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
      open.title = t("{status}: {path}", { status: STATUS_LABELS[file.code] || file.code, path: `${file.from ? `${file.from} → ` : ""}${file.path}` });
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
    if (!files.length) list.append(el("li", "muted small git-empty", t("No files.")));
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
      title: untracked ? t("Delete \"{file}\"?", { file: file.path }) : t("Discard the changes to \"{file}\"?", { file: file.path }),
      message: untracked
        ? t("This file is not tracked by git: it will be deleted from the disk. This cannot be undone.")
        : t("The unstaged changes to this file will be lost. This cannot be undone."),
      confirmLabel: untracked ? t("Delete") : t("Discard changes"),
      danger: true,
    });
    if (confirmed) runAction("discard", { files: [file.path] }, t("{file}: changes discarded.", { file: file.path }));
  }

  /**
   * @param {HTMLElement} pane
   * @param {{mode: string, file: string, hash?: string}} target
   */
  async function loadDiff(pane, target) {
    pane.replaceChildren(el("p", "muted small git-placeholder", t("Loading the diff…")));
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
      pre.append(el("span", "diff-meta", t("No text difference (binary file or permission change).")));
      return pre;
    }
    const lines = text.split("\n");
    for (const line of lines.slice(0, MAX_DIFF_LINES)) {
      let kind = "";
      if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) kind = "diff-meta";
      else if (line.startsWith("@@")) kind = "diff-hunk";
      else if (line.startsWith("+")) kind = "diff-add";
      else if (line.startsWith("-")) kind = "diff-del";
      pre.append(el("span", kind, line)); // one line = one block (see .git-diff > span)
    }
    if (truncated || lines.length > MAX_DIFF_LINES) pre.append(el("span", "diff-meta", t("… diff truncated.")));
    return pre;
  }

  // --- history -------------------------------------------------------------------------

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
      historyPane.append(el("p", "muted small git-placeholder", t("No commits yet.")));
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
    else details.append(el("p", "muted small git-placeholder", t("Select a commit to see its details.")));
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
      // Straight line within a lane, otherwise a smooth curve between two lanes.
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
    details.replaceChildren(el("p", "muted small git-placeholder", t("Loading…")));
    let commit;
    try {
      commit = await read(`commit?hash=${hash}`);
    } catch (err) {
      details.replaceChildren(el("p", "form-error", errorText(err)));
      return;
    }
    const header = el("div", "git-commit-header");
    header.append(
      el("strong", "git-commit-message", commit.message || t("(no message)")),
      el("span", "muted small", `${commit.author} · ${new Date(commit.date * 1000).toLocaleString(locale(), { dateStyle: "medium", timeStyle: "short" })} · ${commit.hash.slice(0, 10)}`),
    );
    const files = el("ul", "git-files");
    const diffPane = el("div", "git-diff-pane");
    diffPane.append(el("p", "muted small git-placeholder", commit.files.length ? t("Select a file.") : t("No files changed.")));
    for (const file of commit.files) {
      const item = el("li", "git-file");
      const open = el("button", "git-file-open");
      /** @type {HTMLButtonElement} */ (open).type = "button";
      open.title = t("{status}: {path}", { status: STATUS_LABELS[file.code] || file.code, path: `${file.from ? `${file.from} → ` : ""}${file.path}` });
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
   * Shows the repository of this folder (the agent's, or another worktree), starting from the working copy.
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
     * Shows the repository that contains this folder.
     *
     * @param {string} folder
     */
    open(folder) {
      // Same agent: stay on the worktree shown; another agent: start again from its folder.
      if (folder !== home) {
        home = folder;
        return show(folder);
      }
      return refresh();
    },
    refresh,
  };
}

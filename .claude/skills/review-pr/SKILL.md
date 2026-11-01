---
name: review-pr
description: 'Review a GitHub pull request of Ziggy One (Python standard-library server + vanilla JS ES modules, no dependencies). Fetches the PR, checks compliance, reviews the diff with project-specific rules, outputs up to 20 comments ordered by importance. Usage: /review-pr <PR_URL_or_number>'
---

# Review a Ziggy One pull request

You are a senior Python and vanilla-JavaScript developer who knows local developer tools and AI-agent security,
reviewing a pull request of Ziggy One (github.com/molory/ziggy-one).

Ziggy One is a single-user web app on `127.0.0.1` that runs the user's Claude Code agents in real terminals, with
Kanban boards, workspaces, a Files and a Git tab, and an MCP server for the agents. Agents act **with the user's
permissions**: a hole in the HTTP boundary, a path that escapes a folder, or untrusted text that reaches the DOM or
an agent as an instruction turns into command execution on the user's machine. `SECURITY.md` is the threat
model: a malicious web page, another local user, or content read by an agent (file, ticket, web page) must not
bypass the protections. The project has **no third-party dependencies** on purpose, and every visible text is
translated into 6 languages.

## Input

`$ARGUMENTS` is a full PR URL (`https://github.com/molory/ziggy-one/pull/<N>`) or a PR number of the current repo.

## Steps

1. Parse the reference (owner/repo, number). Default repo: `molory/ziggy-one`.
2. Metadata: `gh pr view <N> -R molory/ziggy-one --json number,title,body,author,baseRefName,headRefName,headRefOid,files,commits,statusCheckRollup,url,createdAt`.
3. Existing discussions, so the review does not repeat points already raised or resolved:
   `gh pr view <N> -R molory/ziggy-one --comments` and
   `gh api repos/molory/ziggy-one/pulls/<N>/comments --jq '.[]|{path,line,body}'` (inline comments).
4. Compliance check (below).
5. Diff: `gh pr diff <N> -R molory/ziggy-one --color=never`. If it is large or more context is needed:
   `gh pr checkout <N>` (or `git fetch origin pull/<N>/head:pr-<N>`), then `git diff origin/main...pr-<N>` and read
   the full touched files. A change can only be judged against its surrounding code.
6. Review (below). When in doubt about behaviour, run the suites locally:
   `python3 -m unittest discover -s tests`, `node --test tests/*.test.mjs`, `ruff check .`.
7. Write `.reviews/pr-review-<N>.md` (create the folder; add `.reviews/` to `.gitignore` if missing).
8. Present the review, ask which comments to post (numbers or "all"), and output them formatted for copy-paste.
   Never post to GitHub automatically.

## Compliance check

- **Target branch**: `main`. Anything else: FAIL.
- **Required checks** (ruleset on `main`): `Lint`, `Front-end tests (Node)`, `Server tests (Python 3.10, ubuntu-latest)`,
  `Server tests (Python 3.14, ubuntu-latest)`, `Server tests (Python 3.14, macos-latest)`, `Analyze (python)`,
  `Analyze (javascript-typescript)`. From `statusCheckRollup`: a failing one is FAIL, pending is WARN. A flaky
  macOS terminal test is still a failure until explained.
- **PR description**: the template `.github/pull_request_template.md` has `## What and why`, `## How it was tested`,
  `## Checklist`. Judge the content, not the headings: a description that says what/why and how it was tested in
  its own words passes. WARN only if one of the two is really missing. Ticked checklist items that the diff
  contradicts (e.g. "No new third-party dependency" with a new import): FAIL.
- **Issue link**: optional. CONTRIBUTING asks for an issue first "for anything bigger than a small fix": a large
  feature without one is WARN, never FAIL.
- **CHANGELOG.md**: a change users can notice (feature, fix, UI text, a security fix that changes behaviour) needs
  an entry under `## [Unreleased]` at the top, in the existing style (`- **Short name:** sentence…`). Missing: WARN.
  Internal hardening with no visible effect, refactors, tests, CI and docs need none. Never under a released
  `## [X.Y.Z]` heading (the release workflow publishes that section as notes). Test-, CI- or docs-only PRs need none.
- **Docs**: a new feature or a changed behaviour updates `README.md` or `docs/GUIDE.md` (in English). Missing: WARN.
- **Scope**: "one feature or fix per pull request, with tests" (CONTRIBUTING). A second feature or fix mixed in:
  WARN. Small related housekeeping (a badge, a typo next to the change) is fine.
- Branch names have no convention (`fix/…`, `codeql-fixes`, `oss-quality`): do not check them.

Verdict: **FAIL** if any FAIL, else **WARN** if any WARN, else **PASS**. The PR can be merged with rebase or
squash only (ruleset) and review threads must be resolved.

## Review focus, in priority order

### 1. HTTP boundary (`server.py`, `login_links.py`, `browser_sessions.py`)
- Every new `GET /api/…` route sits after the `_authenticated()` check in `do_GET`; every new POST goes through
  `do_POST`, which checks `_host_ok()` + `_origin_ok()` + `_authenticated()`. A route matched **before** those checks
  (like `/hooks/…`, `/mcp`, `/t/<n>`) must authenticate itself with its own secret via `same_secret()`
  (constant time), never `==`. CRITICAL if missing.
- Request bodies go through `_read_json(limit)` with a size limit (`MAX_BODY` or a dedicated `MAX_*_BODY`); never
  `rfile.read()` of an unbounded length.
- Responses use `_send()` / `_json()`, which add `SECURITY_HEADERS` and refuse `\r`/`\n` in header values.
  Exception: `_send_file()` and `_stream_events()` write headers with `send_header` directly, so they skip that
  check; a new route copied from them must sanitize every value built from data (`_send_file` uses
  `quote(name, safe="")`). Files opened in a tab use `RAW_FILE_HEADERS` (sandboxing CSP). Any CSP change must keep `default-src 'self'` and no inline
  script; styles only via the per-load nonce.
- Secrets: the browser token is never printed, logged, put in a URL or a command line. Login goes through single-use
  links (`login_links.py`); `/?token=` must not sign in again. Hooks and MCP keys stay in `0600` files
  (`write_private`, `agent_mcp.agent_key`), never in `argv` (visible in `ps`).
- Server listens on `127.0.0.1` only; `allowed_hosts` / `allowed_origins` are not widened.

### 2. Untrusted content reaching the DOM (`web/*.js`)
- Never `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, `new Function` with anything that
  is not a literal: content from Claude, transcripts, tickets, file names, branch names, agent names is untrusted.
  Build nodes with the file's `el(tag, class, text)` / `textContent`. Existing exceptions are literals (`hero.js`
  SVG defs) or our own rendered tree (`discussion-view.js` PDF export): a new one needs the same justification.
- Markdown goes through `web/markdown.js` (parse then build nodes), never a regex-to-HTML shortcut.
- Links: only `http(s)` URLs become clickable (terminal links, Markdown); `javascript:` / `data:` must not.
- Inline `style` attributes are allowed (xterm.js needs them) but values from data are set with
  `style.setProperty`, not string-built `style` attributes.

### 3. Agents, files and processes (`agent_mcp.py`, `files.py`, `folders.py`, `gitops.py`, `terminal.py`, `shell.py`)
- **Prompt injection**: text written by people (ticket content, activity, transcripts) passed to an agent is labelled
  as information, not instructions (see the tool descriptions in `agent_mcp.py`). New MCP tools keep that wording and
  do not let one agent widen another's permissions.
- **MCP tool scope**: tools are gated by the caller's key (`check_key`); privileged tools are restricted like
  `server_restart` (only for agents in Ziggy One's own folder, `_in_home`). A new tool that deletes data, changes
  settings or launches processes needs the same kind of gate and a test that other agents cannot call it.
- **Paths**: anything built from request data is resolved with `os.path.realpath` and checked with `files._inside()`
  / `Path.is_relative_to()` against its root; `files._is_protected` folders (Ziggy's data dir, `~/.ssh`, `~/.gnupg`,
  `~/.aws`) are never listed, read or written. Folder input goes through `folders.resolve_dir`.
- **Subprocesses**: argument lists only, never `shell=True` / `os.system`; `stdin=subprocess.DEVNULL` and a
  `timeout` for short commands. Git calls go through `gitops.run()` which forces `core.fsmonitor=false` and
  `--no-ext-diff --no-textconv` (opening a repo must not run its code). Branch names go through `_check_branch_name`.
- Claude Code is launched with `--settings` (hooks + `deny` rules on the data folder) and `--mcp-config` from `0600`
  files; `--allowedTools` is variadic and must stay last in `start_terminal`.
- Agent ids are validated with `storage.is_agent_key` / `CONVERSATION_ID_RE` before use in paths or lookups.

### 4. Data on disk (`storage.py` and every `*.json` / `.jsonl` in the data folder)
- Writes go through `storage.write_json` / `write_private` (atomic, `0600` file, `0700` folder), never `open(…, "w")`.
- Reads go through `storage.read_json(path, default)` and each loader validates every field (see
  `kanban.Kanban._load_ticket`): a damaged or old file must give defaults, never crash the server at start.
- A new field in a stored record must load from files written by the previous version (missing key = default);
  removed fields must not break old files. No migration framework exists: compatibility is in the loaders.
- Shared state is mutated under the class's `self._lock`, and changes are published on the `Bus`
  (`self._bus.publish(...)`) so every open tab updates.

### 5. Bugs and correctness
- Threading: `ThreadingHTTPServer` with daemon threads; code called from handlers and from the hook/terminal
  threads must not hold one lock while taking another in the opposite order elsewhere.
- Terminal and PTY code (`terminal.py`): macOS and Linux differ (CI runs both); signal handlers must stay
  async-safe (no `print`, see `tests/fakes.py`), every fd is closed on error paths.
- Front end: `// @ts-check` + JSDoc types are expected on modules; event handlers re-entered by SSE updates
  (`on("…")` in `app.js`) must be idempotent; optimistic UI updates roll back on API error (see `cornersSection`).
- Python 3.10 is the floor (`ruff.toml target-version = "py310"`, CI matrix): no 3.11+ syntax or stdlib API
  (`tomllib`, `except*`, `typing.Self`…) without a fallback.

### 6. i18n (`i18n.py`, `web/i18n.js`, `locales/*.json`, `web/locales/*.js`)
- Every visible UI text is in `t("English")` / `tn(n, "one", "other")`; server messages shown in the UI in
  `tr("English")`. Texts for agents (hooks, MCP, prompts) stay plain English, not translated.
- New keys are added to all five catalogs (`fr`, `es`, `zh`, `hi`, `ar`) with identical `{placeholders}`; the tests
  enforce same keys. A sentence is one key with placeholders, never concatenated fragments (word order differs in
  Hindi/Chinese).
- Arabic is RTL (`i18n.RTL`): new CSS uses logical properties (`margin-inline-start`, `inset-inline-end`…), code and
  paths stay `direction: ltr`.

### 7. No dependencies, vendored code
- No new import outside the Python standard library; no npm, bundler, CDN or external font/script URL in `web/`.
  Vendored code lives in `web/vendor/<name>/` with a README giving version, date and sha256 (like
  `web/vendor/xterm/README.md`). Dev tools (ruff, zizmor) stay CI-only and pinned.
- Workflows: actions pinned by full SHA with a version comment, `persist-credentials: false`, least `permissions`
  (zizmor runs in CI, but check new `permissions:` blocks by eye).

### 8. Tests
- Server features: `tests/test_<module>.py` (unittest); HTTP routes end to end against a real server on a random
  port (see `tests/test_server.py`); the fake interactive `claude` lives in `tests/fakes.py` (no quota spent).
- Front end: pure logic in DOM-free modules (`web/*-logic.js`) tested with `node --test tests/*.test.mjs`. Logic
  added inside a DOM module that could be pure: SUGGESTION to move it.
- A security fix comes with a test that fails without it. A new route without a test: WARNING.

### 9. Style (only what ruff does not catch)
- Matches the code around it: comment density, naming, English everywhere; line length 120 (`.editorconfig`,
  `ruff.toml`). Comments explain why, not what.

## Per-comment format

`file:line` (from the diff) — **SEVERITY** (CRITICAL / WARNING / SUGGESTION / NITPICK)
Explanation (why it matters here), then the concrete fix (code when useful).

## Output template

```
# Review of PR #<N>: <title>
<url> · by <author> · <head> → <base> · <date>

## Compliance: <PASS|WARN|FAIL>
- Target branch: …
- Required checks: …
- Description (template): …
- Issue link: …
- CHANGELOG: …
- Docs: …
- Scope: …

## Comments (<n>)
1. `file:line` — **CRITICAL** — …

## Summary
<1–3 sentences: risk level, what must change before merge.>
```

## Important rules

- Compliance first, then the review. At most 20 comments, the most important ones, ordered by severity.
- Weigh `server.py` (routes, headers, CSP), `agent_mcp.py`, `files.py`, `gitops.py`, `terminal.py`, `shell.py`,
  `storage.py`, `login_links.py`, `browser_sessions.py` and any DOM insertion in `web/` higher than the rest.
- Constructive: say why, not just what. Refer to CONTRIBUTING.md and SECURITY.md when a rule comes from there.
- Don't flag what is clearly intentional in this codebase (inline style attributes, `hero.js` literal SVG,
  `l` and short lambdas allowed by `ruff.toml`, long lines left to review).
- Don't repeat points from existing PR discussions. On a huge diff, start with the security-boundary files above.

# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

- **Agents can create agents:** the "ziggy" MCP server gets `agents_list`, `agents_create` (name, folder, role,
  workspace) and `agents_set_workspace`. A created agent appears pinned in the sidebar but does not start: its Claude
  Code opens when you open it. A workspace named by an agent is created if missing.
- **Logo color is also the accent color:** buttons, selection, links, toggles and the home screen take the color
  chosen in Configuration › General (a lighter gray in the dark theme).
- **Terminal (macOS):** a click above Claude Code's input no longer fills it with a previous prompt (the click was
  sent as Option + click, which xterm.js turns into arrow keys to move the cursor).
- **Logo color:** Configuration › General picks the color of the Z logo and of the favicon (orange, red, pink,
  purple, blue, teal, green or gray), to tell several Ziggy One apart at a glance (one per computer). The server
  draws both in that color (`logo.py`, no image library); open tabs follow at once.
- **Home screen:** the animation always shows at least 8 agents orbiting the emblem: yours first, then random
  extras (never shown as working) when you have fewer.
- **First launch:** a start with no agent (a fresh install, or every agent closed) creates **ZiggyBoss**, a pinned agent working in Ziggy One's own folder,
  whose role is to customize Ziggy One and fix its bugs. The page opens its Claude Code right away and shows a large
  loading screen until it has introduced itself. An empty
  Kanban also gets a first board, "Board", with a `WELCOME/ Onboarding todo` ticket: a checklist to discover
  Ziggy One, once (`onboarding.json`); an existing install keeps its agents and only gets the board if it has none.
- **Six languages:** the interface and the server messages are now also in Chinese, Hindi, Spanish and Arabic,
  next to English and French (Configuration › General). Arabic is shown right to left; code, terminals and paths
  stay left to right. Plurals follow each language's rules.
- **Claude Code not ready screen:** when `claude` is not installed (or not on Ziggy One's PATH) or not signed in,
  an animated full screen explains it in one line and hands the fix to an AI agent: copy the prompt, paste it into
  Claude or any agent, then "Check again" (no restart needed). "Continue without Claude Code" explains that an AI agent can adapt
  Ziggy One to another coding agent of your choice (a prompt to copy), or goes on to the Tasks mode.
- **Archived tickets:** the "Done" column of a board (by its name, otherwise the last one) gets an archive button on each card and one in its
  header to archive all its tickets at once. Archived tickets leave the board; the board settings now have two
  tabs, Settings and Archive, which lists them (click to open, "Restore" to put one back at the end of its
  column). The ticket window also has Archive / Restore.
- **Sound when an agent finishes its turn** (by default a short chime, `sounds/done.mp3`). The speaker button next to the
  plan usage turns it on or off for this browser; Configuration › General plays it, replaces it with a file of
  your own (MP3, WAV, OGG, M4A, AAC or FLAC, 2 MB max) or goes back to the default. With several tabs open, only
  one plays it.
- **Ticket window:** a long description no longer covers the files, the history and the buttons; task lists
  (`- [ ]`) can be ticked in Preview (saved at once); static badges (`img.shields.io/badge/…`, `badgen.net/badge/…`)
  are shown in Markdown, any other image stays a link (it could make the browser call any server).
- **`/?token=…` no longer signs in**: the token stayed in the browser's history and address bar. Such an address
  now just goes back to `/` (an old bookmark still works in a browser that is signed in). Scripts sign in with
  a single-use link from `ziggy --link`.
- **Security hardening** (from an internal audit):
  - agents' terminals get Claude Code `deny` rules on Ziggy One's data folder (token, sessions, keys);
  - the Files tab refuses Ziggy One's data, `~/.ssh`, `~/.gnupg` and `~/.aws`, even inside an agent's folder;
  - Ziggy One's git calls force `core.fsmonitor=false` and show diffs with `--no-ext-diff --no-textconv`: a
    repository's config cannot run a program through them;
  - terminal: Claude Code's clipboard copies (OSC 52) are accepted only within 5 s of your last input in that
    terminal (no more silent clipboard replacement, also on page reload); output links open only `http(s)`;
  - used sign-in links are remembered across a restart; the cookie header is parsed by hand (another local site's
    cookie no longer signs you out); the data folder is forced to `0700` at start-up;
  - raw files are served with a CSP `sandbox`; the PDF export removes `<meta>`, `<base>`, `<iframe>`… tags;
  - `--name=<agent name>` in one argument; `/mcp` rejects a negative `Content-Length`; idle connections close
    after 60 s.
- **Signed-in browsers, with sign-out.** The cookie no longer holds the access token: each sign-in creates a
  session for that browser only (random id, the server keeps its SHA-256 in `browser-sessions.json`, 0600). The
  account window lists the signed-in browsers with **Sign out** for each one and **Sign out the others**; a session
  unused for 30 days ends, and `--new-token` signs every browser out. Tabs signed in before this version have to
  sign in again once (`ziggy`).
- **Closed terminal**: when Claude Code stops, its last screen fades behind a card with **Reopen Claude Code**
  (the exit code shows only if it stopped by itself); **See the last output** sets the card aside and leaves **Reopen**
  in the bar.
- **Sign in from another browser**: `ziggy --link` prints a single-use login link instead of opening the default
  browser, and the account window has **Sign in another browser**, which copies one (`POST /api/login-link`).
  After opening the browser, `ziggy` says to run `ziggy --link` if nothing showed up (with `--port N` when needed).
- **A real screen when the tab is not signed in**, instead of a red banner: Ziggy One is running, only this browser
  lacks the sign-in. It shows, animated, how to get back in (`ziggy` in a terminal opens a signed-in tab, nothing
  restarts), with the command to copy (`ziggy --port N` when not on 6767) and a reload button.
- **New interface font: Plus Jakarta Sans**, a variable font served by the server itself (`web/vendor/plus-jakarta-sans/`,
  SIL Open Font License). Code and terminals stay monospaced. The server now serves `.woff2` files.
- **Logo orange as the accent colour** (`#EA580C`, with a new peach `#F6B492` in the logo) in light and dark themes. Welcome screen redone around it: plain
  white background, solid orange title and buttons, a soft grey haze behind the logo instead of the spinning ring and
  the coloured aurora; agents in orbit without a white border.
- **The logo goes home**: a click on the logo, top left, shows the welcome screen (from Tasks mode too).
- **New logo and favicon**: the logo (`web/logo.svg`) in the sidebar and the welcome screen; favicon as SVG with a
  32 px `favicon.ico` fallback, an Apple touch icon and a web manifest (192 and 512 px icons).
- **Delivery dates on Kanban tickets**: set, change or remove a date in the ticket card; the card shows the days
  left in a badge that turns redder over the last 14 days, solid red once late. Recorded in the ticket history,
  readable and settable by agents (`kanban_update_ticket` › `due`).
- **Search in the sidebar**: above the agent list, and above the boards in Tasks mode. It finds agents hidden by
  the filters (Active, pinned only, collapsed workspaces), boards, and tickets by number or title. Accents and case
  do not count; Esc clears it.
- **Tags in Kanban card titles**: a title starting with UPPERCASE words separated by "/" (`/SMYNO/FEATURE Fix login`)
  shows them as coloured chips on the card. The same text always gets the same colour.
- **Drag and drop in the agent list**: reorder pinned agents and workspaces, reorder unpinned workspaces, move agents
  into, inside and out of workspaces (Alt + ↑/↓ with the keyboard). Pinned items stay pinned. New workspace routes
  `place` (an agent before another) and `move` (a workspace before another).
- **Corner style setting** (Configuration › General): square, slightly rounded, rounded (default) or very rounded,
  for every card, avatar and button, in every browser.
- **New agents and workspaces are pinned by default**, so they stay visible in the left panel; unpin them as usual.
  Resuming a past session does not pin it.
- **macOS support.** Terminals no longer need util-linux `setsid --ctty` or `/proc`: `claude` starts in its own
  session and takes the pseudo-terminal through `TIOCSCTTY`, and terminal memory is read with `ps` where `/proc`
  is missing. `ziggy` now runs on Linux and macOS.
- **English by default, French available.** Every text of the interface and every server message shown in it is
  translatable (`web/i18n.js`, `i18n.py`, dictionaries in `web/locales/` and `locales/`). The language is a global
  setting in Configuration › General, saved by the server (`settings.json`); changing it reloads the page.
  Texts given to the agents (agent directory, shared activity, MCP tools) are always in English.
- Code comments and the detailed guide (`docs/GUIDE.md`, formerly `docs/GUIDE.fr.md`) are now in English.
- New generated agent names are English ("Agile Otter"); existing names and French animal avatars keep working.
- New Kanban boards start with "To do", "In progress", "Done" in the chosen language.
- The Tasks mode address is now `/#tasks` (`/#taches` still works).
- Fix: the floating buttons of an empty Discussion had no icon.

- Vendored the xterm.js source map (`web/vendor/xterm/xterm.js.map`): the full original TypeScript source is in
  the repository and shown by the browser developer tools.
- `ziggy` command: starts Ziggy One for the current folder and opens it in the browser, already logged in, or
  just opens it when it is already running (`ziggy.cmd` on Windows, where it only reports that Linux or macOS is needed).
- Single-use login links (`/?login=…`, 5 minutes) replace the access token in the startup output: the token is
  no longer printed. `--open` opens the interface in the browser. `/?token=…` still works.
- Fixed: starting the server on a port already in use now reports "Address already in use" instead of an
  `AttributeError` raised while closing the half-built server.

## [0.1.0] - 2026-10-26

First public release.

- Real Claude Code terminals in the browser (xterm.js), one per agent, resumed on their session.
- Agent list with workspaces, pins, names, avatars, live status, "waiting for you" alerts and notifications.
- Discussion view with Markdown rendering, copy/PDF export, a composer and a `!!` shell console.
- Prompt shortcuts per agent and per workspace (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+digit in the terminal).
- Agent roles and a directory given to every session through a `SessionStart` hook.
- Shared activity between agents of a workspace working in the same repository.
- Kanban boards with history, attachments, numbered links and MCP tools for the agents.
- Files and Git tabs, plan usage and context window indicators, clean server restarts.

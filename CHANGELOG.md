# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

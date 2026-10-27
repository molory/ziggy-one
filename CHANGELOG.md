# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

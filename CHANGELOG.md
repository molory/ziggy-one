# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

- Vendored the xterm.js source map (`web/vendor/xterm/xterm.js.map`): the full original TypeScript source is in
  the repository and shown by the browser developer tools.
- `ziggy` command: starts Ziggy One for the current folder and opens it in the browser, already logged in, or
  just opens it when it is already running (`ziggy.cmd` on Windows, where it only reports that Linux is needed).
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

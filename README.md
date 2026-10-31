# Ziggy One

**Organise your agent teams.** Boost the productivity of your [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
agents: run them side by side, see who needs you, and hand out work on a shared board. Free, open source, and it
runs on your machine.

[![CI](https://github.com/molory/ziggy-one/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/molory/ziggy-one/actions/workflows/ci.yml)
[![CodeQL](https://github.com/molory/ziggy-one/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/molory/ziggy-one/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/molory/ziggy-one/badge)](https://scorecard.dev/viewer/?uri=github.com/molory/ziggy-one)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Python 3.10+](https://img.shields.io/badge/python-3.10%2B-blue.svg)
![Linux | macOS](https://img.shields.io/badge/platform-Linux%20%7C%20macOS-lightgrey.svg)

[Website](https://ziggy-one.smyno.com) · [Quick start](#quick-start) · [Guide](docs/GUIDE.md) ·
[Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md)

![Ziggy One: organise your agent teams. A workspace of Claude Code agents with their live status.](docs/images/og.png)

## Why Ziggy One

**One agent is an assistant. Several agents are a team.** A team needs a place to work together, and a terminal
per agent is not one: you lose track of who is working, who is stuck on a permission prompt, and who is doing what.
Ziggy One gives your agents that place.

- **See the whole team.** Every agent on one page with its live status. Know at once who is working, who is idle and
  who is waiting for you.
- **Hand out the work.** A shared Kanban board your agents use themselves: they take a ticket, update it and move it
  to Done.
- **Agents that work together.** Give each agent a role. Every agent knows who else is on the team and how to reach
  them, and sees what teammates did in the same repository.
- **Shaped to your workflow.** Ask an agent to change Ziggy One itself, restart from the interface, and use your
  change.
- **Your machine, your account, your data.** No cloud, no account, no dependency: one page served on `127.0.0.1`,
  using your existing Claude Code login.

## What it is

Each agent is the real, interactive Claude Code running in its own terminal, in the browser. Ziggy One keeps them
organised (workspaces, pins, names, avatars), shows what they are doing (live status, context usage, a readable
view of the conversation), lets them coordinate (shared activity, an agent directory, a Kanban board they can use
through MCP), and tracks your plan usage, all from one page served on `127.0.0.1`.

> **Zero third-party dependencies.** The server is the Python standard library; the front end is vanilla
> HTML/CSS/JS with no npm and no build step. The only vendored code is [xterm.js](https://xtermjs.org/) (MIT), pinned
> and checksummed, with its full TypeScript source in the published source map, plus 42 [Twemoji](https://github.com/jdecked/twemoji) SVGs (CC-BY 4.0) used as avatars.

> The interface is in **English** by default and also available in **Chinese, Hindi, Spanish, Arabic and French**
> (Configuration › General).
> More languages are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). Every module is described in the
> [detailed guide](docs/GUIDE.md).

## Features

- **Real Claude Code terminals.** Every agent runs `claude` in a pseudo-terminal (xterm.js in the page), so every
  command, slash command and permission prompt works exactly as in your own terminal. Closing the browser tab does
  not stop the agent.
- **Many agents at once.** Start, resume, pin, rename, group into **workspaces**, give avatars; the list shows
  who is working, who is idle and who is **waiting for you** (permission or question), with desktop notifications.
- **Discussion view.** A clean, read-only rendering of the session (Markdown answers, folded tool calls,
  sub-agents), with copy/PDF export, a composer that types into the terminal, and a `!!` shell console.
- **Prompt shortcuts.** Ready-made prompts per agent and per workspace. Hold <kbd>Ctrl</kbd>+<kbd>Shift</kbd> in the
  terminal to show them, press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>1</kbd>…<kbd>0</kbd> to send one.
- **Agent roles and directory.** Give an agent a role ("sends and reads Teams messages"). Every session started by
  Ziggy One learns, through a `SessionStart` hook, which agents exist and how to reach them (`SendMessage`).
- **Shared activity.** Agents of the same workspace working in the same repository get a short digest of what the
  others did since their last message (no model call, about 400 tokens at most, can be turned off).
- **Kanban boards.** Boards, columns, tickets with Markdown and attachments, full history, numbered links. Agents
  get a local MCP server (`kanban_*` tools) to read, create, update and move tickets, and (`agents_*` tools) to list
  agents, create new ones (they start only when you open them) and group them into workspaces.
- **Files and Git tabs.** Browse, search and edit the agent's folder; stage, commit, branch, pull and push.
- **Usage and context.** Your plan's 5-hour and weekly usage, and each agent's context window fill.
- **Clean restarts.** Restarting the server pauses working agents, waits for them, then reopens every terminal and
  lets them resume.

## Requirements

- **Linux or macOS.** Terminals rely on `pty` and a controlling terminal per agent. Windows is not supported yet:
  there, `ziggy` only says so and exits.
- **Python 3.10+.** Nothing to install: standard library only.
- **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)** installed and logged in (`claude` on your
  `PATH`). Ziggy One uses your existing Claude Code account and never sees your credentials.
- A recent Chromium-based browser or Firefox. Optional: `git` (Git tab), Chrome/Chromium (PDF export), Node.js 22+
  (front-end tests only).

## Quick start

```bash
git clone https://github.com/molory/ziggy-one.git
cd ziggy-one
ln -s "$PWD/ziggy" ~/.local/bin/ziggy   # once: the `ziggy` command, from any folder
```

`~/.local/bin` must be on your `PATH` (it usually is on Linux; on macOS, create it and add it to your shell profile if needed):

```bash
mkdir -p ~/.local/bin && echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc   # macOS, then open a new terminal
```

Then, in the folder you want your agents to work in:

```bash
ziggy                            # or: ziggy --permission-mode auto, any option below
```

- Ziggy One starts with that folder as the default for new agents and opens in your browser, **already logged in**.
- If it is **already running**, `ziggy` does not start a second one: it just opens the interface (from any folder).
- If the port is taken by another program, `ziggy` says so: choose another one with `--port`.

Whenever Ziggy One starts with no agent (first launch included), the sidebar gets **ZiggyBoss**: the agent that customizes Ziggy One and fixes its bugs
(open it, it introduces itself); on the first launch, Tasks also has a "Board" with a welcome checklist. Then click **New agent**. Stop Ziggy One with <kbd>Ctrl</kbd>+<kbd>C</kbd> in its terminal; agents' terminals are
closed cleanly.

### Logging in without exposing the token

The access token never shows up: not in the terminal, not in the browser's address bar or history, not on a
command line, not in a cookie. `ziggy` opens the browser on a **single-use login link** (`/?login=…`), signed with
the token, that expires after 5 minutes and is exchanged for a **session of that browser only**. Once used, the
link is worthless wherever it was copied: shell scrollback, `ps`, browser history, a log file.

- **Another browser** (Firefox next to Chrome, a private window…): `ziggy --link` prints a fresh single-use link
  instead of opening the default browser; paste it into the other one. From a browser that is already logged in,
  the account window (click your avatar) has **Sign in another browser**: it copies such a link, no terminal needed.
- **No browser at hand?** Started as `python3 server.py` (no `--open`), or when no browser can be opened, the server
  prints the login link instead. Run `ziggy --link` for a fresh one.
- **Signed-in browsers**: Configuration › Server lists them (browser, system, sign-in date, last activity), with
  **Sign out** for each one and **Sign out the others**. A session unused for 30 days ends by itself; sessions
  survive a restart of Ziggy One.
- **Bookmark** `http://127.0.0.1:6767/`, never a login link. If the browser is signed out (cookie lost, session
  ended), the page says so and shows how to get back in: run `ziggy` again.
- **Token leaked anyway?** Restart once with `--new-token`: every browser is signed out, ticket links and agent
  keys are invalidated.
- The token never goes in an address: `/?token=…` no longer signs in (it only goes back to `/`). A script
  signs in with a single-use link, then uses the cookie jar:
  `curl -c jar "$(ziggy --link | grep -o 'http[^ ]*login=[^ ]*')"`. The token is in `~/.local/share/ziggy-one/token` (`0600`).

| Option | Meaning |
|---|---|
| `--port 6767` | Port to listen on (always `127.0.0.1`). |
| `--cwd DIR` | Default folder for new agents (default: current directory). |
| `--model MODEL` | Default model of the agents (default: Claude Code's own). |
| `--permission-mode MODE` | Default permission mode: `default`, `acceptEdits`, `plan`, `auto` or `dontAsk`. |
| `--allowed-tools "Bash(git status)" Edit …` | Tools allowed without asking. |
| `--chrome` | Enable Claude in Chrome for the agents. |
| `--open` | Open the interface in the browser with a login link (`ziggy` always passes it). |
| `--link` | Print a single-use login link instead of opening the browser, to paste into another browser. |
| `--new-token` | Generate a new access token (invalidates open tabs, ticket links and agent keys). |

Every agent can override the model, permission mode and Chrome setting in its **Configuration** tab.

## Where data lives

Everything stays on your machine, in `~/.local/share/ziggy-one/` (or `$XDG_DATA_HOME/ziggy-one/`), with `0700`
directories and `0600` files: agents and their settings, workspaces, pins, shortcuts, Kanban boards and their
attachments, the activity journal and the access token. Ziggy One only **reads** Claude Code's own files
(`~/.claude/sessions/`, `~/.claude/projects/`) to list sessions and render discussions.

## Security model

Ziggy One is a single-user tool for your own machine.

- Listens on `127.0.0.1` only and checks the `Host` header (DNS rebinding protection).
- Access requires a random token, which only signs browsers in: each one gets its own session id in an
  `HttpOnly; SameSite=Strict` cookie (the server keeps only its SHA-256), which can be signed out alone and ends
  after 30 days unused. Every `POST` must carry a local `Origin` (CSRF protection).
- The token itself is never printed: logging in goes through single-use login links (HMAC of the token, 5-minute
  expiry, rejected once used), so a link found in a log or a browser history cannot be replayed.
- Strict Content Security Policy: no inline scripts, no CDN, no `innerHTML` with untrusted content.
- Claude Code hooks and the agents' MCP server use their own secrets, stored in `0600` files and never passed on a
  command line.
- Agents act with **your** permissions: review Claude Code's permission prompts as you would in a terminal, and
  choose permission modes carefully.
- Each agent's terminal gets Claude Code `deny` rules on Ziggy One's data folder (token, sessions, keys): its file
  tools cannot read or change them. This does not stop a shell command you approve, which runs as you.
- The Files tab never opens Ziggy One's data, `~/.ssh`, `~/.gnupg` or `~/.aws`, even inside an agent's folder.
- Ziggy One's own git calls (Git and Files tabs, activity) ignore a repository's `core.fsmonitor`, external diff and
  textconv programs: opening a repository does not run its code.
- Claude Code can copy to your clipboard (`/copy`) only within 5 seconds of something you did in that terminal;
  terminal links open only `http(s)` addresses.
- An agent with **Chrome** enabled drives your real browser, where Ziggy One is signed in: it can use the interface
  as you would. Enable it only for agents you trust with that.

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## How it works

```
browser (vanilla JS + xterm.js) ── HTTP + Server-Sent Events ── server.py (Python stdlib, 127.0.0.1)
                                                                   │
                                     pty (own session) ────────────┼──> claude  (one per agent)
                                     hooks (ziggy_hook.py) <───────┤      ├─ SessionStart / UserPromptSubmit / Stop …
                                     MCP over HTTP (/mcp)  <───────┘      └─ kanban_* / agents_* tools
```

- `server.py` serves the page, the JSON API and an SSE stream; `terminal.py` runs `claude` in a pseudo-terminal
  and streams its screen; `ziggy_hook.py` is the Claude Code hook that reports turns and injects context.
- Claude Code's session files are an undocumented format: `transcripts.py` reads them defensively, so a format
  change can at worst make the Discussion view incomplete. The terminal itself never depends on it.

The [detailed guide](docs/GUIDE.md) describes every module and behaviour.

## Development

```bash
python3 -m unittest discover -s tests     # server tests (use a fake `claude`, no quota spent)
node --test tests/*.test.mjs              # front-end logic tests (Node 22+)
ruff check .                              # lint (optional locally, enforced by CI: pipx install ruff)
```

CI runs both suites on Linux (Python 3.10 to 3.14) and macOS, the linters, and CodeQL. Releases are published from
a `vX.Y.Z` tag with that version's notes from [CHANGELOG.md](CHANGELOG.md).

Contributions are welcome: please read [CONTRIBUTING.md](CONTRIBUTING.md) first, especially the
**no-dependency** rule.

## License

[MIT](LICENSE) © 2026 Marc Olory. Third-party components keep their own licenses, see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Ziggy One is an independent project, not affiliated with or endorsed by Anthropic. "Claude" and "Claude Code" are
trademarks of Anthropic.

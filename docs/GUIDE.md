# Ziggy One — detailed guide

A local dashboard to drive your Claude Code agents (each in its own Terminal, with the account signed in on this
machine), follow the usage of your plan (5-hour window and week) and organise your work in Kanban boards.

**Zero third-party dependencies**: Python (standard library) + vanilla HTML/CSS/JS, no npm and no build step. Two
exceptions, copied and frozen, served locally (version, checksums and checks in their `README.md`): the terminal
emulator of the Terminal tab, xterm.js (`web/vendor/xterm/`, loaded only when the tab is opened), and the animal
images of the avatars, 42 Twemoji SVGs (`web/vendor/twemoji/`).

## Running

```bash
python3 server.py                     # working folder = current folder
python3 server.py --permission-mode auto     # default permission mode of the agents
python3 server.py --cwd ~/Developer/my-project --permission-mode acceptEdits
python3 server.py --chrome            # enables Claude in Chrome for the agents
```

Or, simpler, `ziggy` in the working folder (once: `ln -s "$PWD/ziggy" ~/.local/bin/ziggy`): the server starts with
this folder as default and opens the interface in the browser, already signed in; if it is already running, `ziggy`
only opens the interface. The token is never displayed: the browser receives a one-time sign-in link, valid for
5 minutes. Without a browser, this link is printed in the terminal. For another browser, `ziggy --link` prints a fresh
link instead of opening the default browser; from a signed-in tab, the account window offers **Sign in another
browser**, which copies one (`POST /api/login-link`, signed-in browsers only). A tab that is not signed in (cookie
lost, `--new-token`) shows a full screen explaining this, with the `ziggy` command to copy.
When Claude Code is not ready (`claude` not found on the server's PATH, not signed in, or `claude auth status`
failing), another full screen (`web/claude-setup.js`) hands the fix to an AI agent: "Copy the prompt" copies what
is wrong, Ziggy One's folder and the PATH where it looks for `claude`; once fixed, "Check again"
(`POST /api/account/check`) runs `claude auth status` again, without restarting. "Continue without Claude Code"
opens a second view: Ziggy One is open source, so an AI agent can adapt it to another coding agent (name it, copy
the prompt: read the code, propose a plan, then implement without breaking Claude Code support), or "Continue to
Tasks" hides the screen for this page (the Tasks mode works without any agent).
Each sign-in gives the browser its own session (cookie `zo_<port>`, never the token); the server keeps their
SHA-256 in `browser-sessions.json` (0600), so open tabs stay signed in after a restart. A session unused for 30 days
ends. The account window lists the **signed-in browsers** (`GET /api/browsers`) with **Sign out** for each one
(`POST /api/browsers/sign-out`, which also clears the cookie when it is this browser) and **Sign out the others**
(`POST /api/browsers/sign-out-others`); a signed-out browser's event stream stops too.
The token is kept from one start to the next (`~/.local/share/ziggy-one/token`, 0600). `--new-token` generates a
new one and signs every browser out.

Options: `--port`, `--cwd`, `--model`, `--permission-mode`, `--allowed-tools "Bash(git status)" Edit …`, `--chrome`,
`--link`.

## Tests

```bash
python3 -m unittest discover -s tests -v
node --test tests/*.test.mjs        # front-end logic (optional, Node ≥ 22)
```

The tests use a fake `claude` executable (interactive, in a real pseudo-terminal): they use no quota.

## How it works

- **Agents** (`conversations.py`): an agent = a folder and a Claude Code session, used in its Terminal tab. Clicking
  a session opens its agent without launching anything; "Open Claude Code" resumes it (`--resume`). A new agent opens
  Claude Code right away. Several agents work in parallel, each in its own terminal. The cross in the header closes
  the agent (Claude Code keeps running in its terminal); its configuration is the last tab, "Configuration". With no
  agent open, the centre shows the animated home screen (`web/hero.js`): the Z emblem, your agents orbiting around
  it (colours, initials, the working ones pulse; with fewer than 8, random extras fill the orbits) linked by beams, the title and the "New agent" / "New workspace"
  buttons; without animation if the system asks for reduced motion.
- **Usage**: read by a minimal Haiku call (about $0.001, without tools or MCP) at startup, with the "Refresh"
  button, and at the end of an agent's turn, at most every 5 minutes.
- **Configuration** (`web/terminals-logic.js`, `GET /api/terminals`): the "Configuration" button at the bottom of the
  usage window opens the global configuration in the centre. The "Claude terminals" tab: open terminals, agents
  working or waiting for you, total memory; one row per terminal (agent, folder, state, open since, memory of all
  the processes of its session) with "Open" and "Close" (confirmation if the agent is working or waiting for you),
  and a button that closes all idle terminals at once. Updated live, memory read again every 10 s.
  "Server" tab (`restart.py`): started when, version (commit), last restart, and "Restart the server".
  The restart is clean: working agents receive a pause request, the server waits until they are idle (20 min at
  most; "Force now" or "Cancel" in the banner at the top), notes what must be reopened (`restart.json`), restarts
  itself with the same command (same process), reopens the terminals and makes the paused agents resume. The page
  reloads by itself and a green banner confirms: time, version, reopened terminals.
- **Language** (`settings.py`, `i18n.py`, `web/i18n.js`): the interface is in English by default; Chinese,
  Hindi, Spanish, Arabic and French are available (the most spoken languages). Arabic is shown right to left
  (`<html dir="rtl">`, logical CSS properties; code, terminals and paths stay left to right). The language is chosen in the global Configuration ("General" tab) and saved by the server in
  `settings.json` (0600): it applies to the interface in every browser and to the server's messages (errors,
  statuses, default Kanban columns). The texts given to the agents (hooks, MCP tools) are always in English.
- **Corners** (`settings.py`, `--corners` in `web/style.css`): the same "General" tab sets the roundness of every
  card, avatar and button: square, slightly rounded, rounded (default) or very rounded. Saved in `settings.json`,
  written on `<html data-corners>` when the page is served, and applied at once in every open browser.
- **Logo color** (`logo.py`, `settings.py`): the same tab picks the color of the Z logo and of the favicon, to tell
  several Ziggy One apart (one per computer). `/logo.svg` and `/favicon.png` are drawn by the server in that color
  (the PNG with a small polygon rasterizer, standard library only); the page links them with `?c=<color>`, changed
  in every open tab when the setting changes, so the browser fetches them again. The interface's accent (`--accent`: buttons, selection, links, toggles, home
  screen) follows: `app.js` sets `--brand` on `<html>` (a lighter tone for gray in the dark theme). Home-screen icons stay orange.
- **Sessions**: a session = a Claude Code conversation, started from a terminal or from ziggy-one.
  The list merges the open sessions (read-only access to `~/.claude/sessions/*.json`, the `.key` files are never
  read), the 50 most recent sessions of all folders and the agents open in ziggy-one, from newest to oldest, with an
  Active / All filter. Each agent has an avatar (green dot: active, flickering orange: thinking, grey: inactive) and
  the label of its folder. A pinned agent stays at the top of the list, whatever the filter (pins saved by the
  server in `pins.json`: they survive a restart and apply to every browser). A new agent is pinned by default;
  unpin it to let it go down the list.
  **Search** (`web/sidebar-search.js`): the field above the list looks through all the agents it knows, even those
  hidden by the Active filter, by "pinned only" or in a collapsed workspace, by name, last message, folder and
  workspace name. Case and accents do not count; every word must be found, in any order. Esc clears it. In Tasks
  mode, the same field finds boards (name, workspace) and tickets (number, title, board); a ticket opens its card.
  **Drag and drop** (`web/sidebar-order.js` for the rules, `web/sidebar-drag.js` for the pointer) reorganizes the
  list, keeping each item pinned or not: reorder the pinned agents and workspaces, reorder the unpinned workspaces,
  move an agent into a workspace (between two of its agents, or onto its header), reorder inside a workspace, or
  drop a workspace's agent on the general list to take it out. An accent line shows where the item lands; the
  outlined workspace is the one it goes into. With the keyboard: Alt + ↑/↓ on a row.
  The pin button, next to the filter, shows only the pinned agents outside workspaces; the others are summarised in
  one line ("12 unpinned agents hidden · show all"). Each workspace shows its pinned agents out of its total
  ("2/5 pinned") and, on the right, its own toggle: off (list icon), all its agents; on (pin icon), only its pinned
  ones.

- **Context** (`context.py`): each agent shows a pie chart and the percentage of its context window that is filled
  (green, orange from 50 %, red from 80 %), with the token details on hover, in the header and in its configuration.
  The tokens are those of the last message of the main agent (input + cache), reset to zero by a compaction.
  The window size is kept per model in `~/.local/share/ziggy-one/context-windows.json`; failing that, 200,000 tokens,
  or one million for a model already seen beyond that.

- **First launch** (`onboarding.py`): at every start that finds no agent (`conversations.json` empty), `main()` opens
  **ZiggyBoss**: pinned, named, in Ziggy One's folder, with the role "customizes Ziggy One and fixes its bugs". Its
  conversation keeps a first message (`intro`, saved in `conversations.json`) passed to `claude` as its prompt the
  first time its terminal starts without a session: it introduces itself. The intro is then used (`intro` emptied) and
  the agent is `introducing` until the end of that first turn (or its terminal closes). On load, the page selects an
  agent with an intro (or introducing) and opens its terminal; while `introducing`, a loading screen covers the
  terminal, except when it waits for your reply, after "Show the terminal", or if it has not started working
  after 15 s (a question such as "trust this folder?"). If the Kanban has no board, a "Board" is
  created with a `WELCOME/ Onboarding todo` ticket (a Markdown checklist). The board is created once
  (`onboarding.json`): deleting it does not bring it back; deleting every agent brings ZiggyBoss back at the next start.

- **New agent** (`folders.py`, `web/agent-names.js`): "+" then "Agent" asks for the folder it will work in and
  suggests the folder's name as its name ("project 2" if it is already taken), editable, and a workspace to put it
  in from its creation (optional) — the last 5 folders used by agents as shortcuts, or browsing (editable path,
  breadcrumb, subfolders). The server returns only folder names (not hidden ones), never the content of files, and
  checks the chosen folder. "New folder here" creates a subfolder of the current folder (one level only, name
  without "/" or a leading "."), which becomes the agent's folder.

- **Workspaces** (`workspaces.py`): groups of agents, created with the "+" (which offers Agent or Workspace).
  A workspace is shown in the list as a collapsible block with its agents; agents are added or removed there
  (checkboxes, or from the agent's configuration). An agent is in only one workspace at a time.
  A workspace can be pinned like an agent (pinned agents and workspaces are mixed at the top, in pin order; a new
  workspace is pinned by default), and
  clicking it opens its card on the Configuration tab (after Shortcuts): name, colour (12 hues or automatic),
  agents, deletion; the arrow on the right collapses or expands it. Saved by the server in
  `~/.local/share/ziggy-one/workspaces.json` (0600); the collapsed state is a browser preference.

- **Tasks mode** (`kanban.py`, `web/kanban*.js`): the "Agents | Tasks" switch at the top of the sidebar toggles
  between the agents and Kanban boards (remembered by the browser, `#tasks` in the address). Boards are shown like
  agents: pins, collapsible workspaces of boards, settings gear, with the distribution of tickets per column. A board
  has customisable columns (name, colour, order; "To do, In progress, Done" at first; deleting a non-empty column
  asks where to send its tickets). Finished tickets can be archived from the "Done" column (by its name, otherwise the last column): one by one
  (button on the card, or "Archive" in the ticket window) or all at once (button in the column header). Archived
  tickets leave the board but stay in their column (`archivedAt`); the board settings list them in the Archive tab,
  where a click opens one and "Restore" (also in the ticket window) puts it back at the end of its column. Moving
  an archived ticket also restores it; the agents' `kanban_list_tickets` leaves archived tickets out. A ticket has a title, a Markdown description (Write / Preview) and attached files
  (button, drag or paste; 25 MB per file, kept as long as the ticket exists, in `kanban-files/` with 0700/0600).
  A ticket can have a delivery date (ticket card › "Delivery date", saved as soon as it is picked; "Remove" takes
  it off; `due`, `YYYY-MM-DD`). The card then shows a badge with the days left ("5 days", "Tomorrow", "Today"),
  redder over the last 14 days, and solid red with the delay once late ("2 days late"). Days are counted in
  calendar days of the browser's time zone. Changes are in the ticket history; agents read the date in the
  ticket and set or remove it with `kanban_update_ticket` (`due`).
  Tags at the start of a title (UPPERCASE words separated by "/", with a leading or trailing "/": `/SMYNO/FEATURE Fix
  login` or `SMYNO/FEATURE/ Fix login`) show as coloured chips on the card; the colour comes from the tag's text, so a
  tag always has the same one. The ticket editor shows the title as typed.
  Tickets are moved by native drag and drop (no library), or with the keyboard: Alt + arrows on a card. Everything is
  saved by the server (`kanbans.json`, `kanban-workspaces.json`, `kanban-pins.json`) and published on the real-time
  stream: several tabs stay in sync. An `agent` field is reserved on tickets to hand them to an agent later.
  Ticket history (`kanban_history.py`): creation, title (before → after), description (before / after), column
  change, files attached or removed, deletion. One JSON line per change in `kanban-history.jsonl` (0600),
  append-only: never rewritten, an interrupted write costs only its own line. Names (columns, files) are kept there
  as they were. The ticket card shows it, from newest to oldest.
  Numbers: each ticket has a unique number across all boards (#1, #2…), never reused (`nextNumber` counter in
  `kanbans.json`; tickets created before that are numbered on load, oldest first). Its address `/t/<number>` opens
  its card ("Copy link" in the card). In a description, "#42" becomes a link to ticket 42 (outside code).
  Link readable by an agent (`ticket_links.py`): "Copy link" gives `/t/42?k=<key>`. With the cookie (your browser),
  the card opens; without a cookie but with the key (an agent: curl, WebFetch), the server returns the ticket as
  Markdown text (board, column, description, attached files and referenced tickets with their own links, history).
  The key is an HMAC of the number with the server's token: it opens only this ticket, read-only, and `--new-token`
  invalidates all links.

- **Kanban for the agents** (`agent_mcp.py`, `POST /mcp`): each Claude Code launched in a terminal receives a "ziggy"
  MCP server (`--mcp-config <0600 file>`) with six tools: `kanban_boards`, `kanban_list_tickets` (column / text
  filters), `kanban_get_ticket`, `kanban_create_ticket`, `kanban_update_ticket` (title, description, or `append` to
  add a note) and `kanban_move_ticket`. Boards and columns are referred to by name, tickets by number (`#42`). No
  deletion for the agents. Each agent has its own key (HMAC of its identifier with the server's token), in the
  configuration file and never on the command line: it tells who is acting, and the ticket history records "by
  <agent name>". `/mcp` accepts neither a cookie nor a request from a web page (origin refused); `--new-token`
  invalidates all keys. Like any MCP tool, each call goes through Claude Code's permissions (`mcp__ziggy__kanban_*`
  tools).
  The same server has three agent tools: `agents_list` (open agents: name, folder, workspace, role, running or not),
  `agents_create` (name, absolute folder, optional role and workspace) and `agents_set_workspace` (an agent, the
  caller included, by its name). A workspace named there is created if missing. A created agent is pinned like one
  made by the user, but its Claude Code does not start: it opens when the user opens the agent, with the user's
  permission settings. Refused: a name already used by an open agent, a missing folder, Ziggy One's data folder.

- **Terminal** (`terminal.py`, `web/terminal-view.js`): the default tab of an agent. It opens the real Claude Code
  (interactive) in the agent's folder, on its session (`--resume`), with its settings (model, permissions, Chrome).
  The server launches `claude` itself, never a shell, in a pseudo-terminal (its own session with the terminal as controlling
  terminal: resizing, Ctrl+C); the screen goes out on the SSE stream (numbered bytes), keystrokes come in by POST,
  and the last 512 KB are kept to redraw the screen of a tab that opens. Every Claude Code command works there and
  depends on no internal format: it is a terminal. If Claude Code switches session (new, `/clear`, `/resume`), the
  agent follows it thanks to the session registry, which also tells whether it is working.
  Keys typed in the terminal (Ctrl+B, Ctrl+P…) are for Claude Code, not for Ziggy's shortcuts.
  Shift+Enter adds a line to the message (sends Esc+Enter); Enter sends it.
  Your messages stand out: their grey background turns into an orange tint and their "❯" orange
  (`web/terminal-colors.js`, recoloured as the screen arrives; if Claude Code changes this grey, the display stays
  as it originally was).
  Closing the browser tab does not close Claude Code; restarting the server does.

- **Discussion** (`web/discussion-view.js`, `web/discussion-logic.js`): tab to the right of Terminal. The
  conversation of the agent's session, formatted: your messages in bubbles (`/…` and `!…` commands included), the
  agent's replies in Markdown, its actions grouped and collapsed ("3 actions · Bash, Read", with their result), its
  subagents and command outputs. Two floating buttons, at the bottom right against the messages: collapse / expand
  ("My messages" keeps only what you sent, each reply expanding on demand), and go to the top / bottom of the
  discussion. Read again every 2 s while the tab is shown (`/api/transcript?since=`: the server reads the session
  again only if its file has changed); the last 500 messages at most.
  Console mode: "!!" at the start of the input turns it into a shell command (dark background, "$"); Enter runs it
  with `$SHELL -c` in the agent's folder (`shell.py`, without a terminal or input, 10 min at most), without Claude
  Code and without sending anything to the agent. The command and its output are shown after the discussion, as they
  come, with the exit code and the duration; "Stop" kills the command. ↑ / ↓ recall the commands; Esc (or Backspace
  at the start) goes back to writing to the agent.
  Under each of your messages, the "⋯" button opens a menu (`web/dropdown.js`, reusable): copy the question and the
  reply or the reply only (as Markdown, without the actions), or download them as PDF. The PDF is made by the server
  (`pdf.py`, `POST /api/pdf`) with Chrome or Chromium in headless mode, without network and with a CSP that forbids
  any script; without Chrome on the machine, the browser's print dialog takes over.
  At the bottom, an input box: Enter sends the message into the Terminal, which it switches to (it is typed there as
  on a keyboard, each line separated by Esc+Enter, `web/terminal-input.js`); Shift+Enter adds a line. One draft per
  agent. Claude Code must be open in the Terminal.

- **Shortcuts** (`shortcuts.py`, `web/shortcuts-*.js`): a tab of an agent, and a tab of a workspace's view (its
  gear: Settings | Shortcuts). Ready-made prompts, with an optional title: add, edit, reorder, delete. An agent's
  shortcuts are its own; a workspace's shortcuts are shared by all its agents and come after the agent's own. In the
  Terminal, holding Ctrl+Shift shows the shortcuts panel; the first ten have a digit (1…9, 0): Ctrl+Shift+digit
  sends the prompt (typed as on a keyboard, then Enter). Ctrl+digit alone is taken by the browser (tab switching).
  The "Shortcuts" button in the Terminal bar keeps the panel open: a click, or the digit alone, sends; Esc closes it.
  Saved by the server (`shortcuts.json`, 0600, `POST /api/shortcuts` with the full list); an agent's shortcuts follow
  its discussion to its session, a workspace's shortcuts go with it.
- **Roles and agent directory**: each agent can have a role (Configuration › Role: what it can be trusted with, e.g.
  "Sends and reads Teams messages"). At the start of each session launched by Ziggy (start, resume, `/clear`,
  compaction), the `SessionStart` hook gives the agent its own role and the list of the other agents that have one:
  name (that of their session), role, open or not, and how to reach them (ListAgents then SendMessage). Nothing is
  added if nobody has a role; a deleted agent is not listed.
- **Hooks** (`ziggy_hook.py`): each terminal is launched with `--settings <0600 file>` which declares five Claude
  Code hooks. `SessionStart` gives the agent directory (above). `UserPromptSubmit` (start of a turn) marks the agent
  as working and adds the shared activity to the context of its message; `Stop` (end of the turn) triggers the
  notification, records the summary of the turn and reads the usage again; `Notification` tells when the agent is
  waiting for your answer (permission requested, question asked): red "!" badge on its avatar and on its workspace,
  ⏳ counter in the tab title, browser notification; `PostToolUse` (the tool has run, so you have answered) clears
  this wait, like your message or the end of the turn. The script talks to the server on `/hooks/<event>` with its
  own token (0600 file, renewed at every start); if the server is stopped or fails, it stays silent: it never gets
  in Claude Code's way.

- **Shared activity** (`activity.py`): with each message, an agent receives in a few lines what the other agents of
  its workspace working in the same repository (worktrees included) have done since its previous message: request,
  start of the final reply, commits of the turn, then the state of its folder (branch, uncommitted files). No model
  call; 1,500 characters at most (≈ 400 tokens), and nothing if there is nothing new. The block is presented to the
  agent as information, not a request. A workspace option, enabled by default. Log and what each agent has already
  received: `~/.local/share/ziggy-one/activity.json` (0600). Only the agents open in Ziggy's Terminal take part
  (they are the ones that have the hooks).

- **Configuring an agent** (`agents.py`): the pin is on the right of each agent (even in a workspace, where the
  agent stays at the top). The Configuration tab, always the last one, lets you rename it (or go back to the
  generated name), choose its workspace, see its information, delete it. Deleting removes the agent from ziggy-one
  (Claude Code closed, removed from its workspace and from the pins) without touching its Claude Code history:
  "Deleted agents" at the bottom of the list lets you restore it (an agent without history gets a discussion back, in
  its folder). Open agents are saved (`conversations.json`): they stay in the list after a server restart, even
  without any message, until they are deleted. A Claude Code session is attached to the agent only once its history
  is written; if Claude Code switches session (`/clear`, `/resume`), name, pin and workspace follow it.
  The "Claude" section sets, for this agent, the model (Opus, Sonnet, Haiku), the permission mode (auto, manual,
  accept edits, plan) and Claude in Chrome; otherwise it follows the command-line options. A change applies the next
  time Claude Code is opened in the Terminal (same session).
  Claude Code is launched with `--name <agent name>`: the other agents find it under this name (Claude Code's
  ListAgents and SendMessage tools) instead of "folder-xx". As the session takes its name only at launch, renaming
  an agent whose terminal is open closes that terminal (after confirmation): reopened, it bears the new name.
  An agent created here takes its folder's name by default; an agent without a name (a session opened elsewhere)
  gets a generated name (`names.py`), an adjective and an animal such as "Agile Otter", unique among the agents and
  saved in `agents.json`: it does not change from one message to the next, its initial makes the avatar, and the
  last message becomes the subtitle.
  The "Avatar" section chooses what its circle shows: an abbreviation of 1 or 2 characters (letters, digits or an
  emoji; empty, the initial of the name), an animal (the one of its name as a shortcut, or one of the 68, with a
  search; about twenty have no emoji and use the image of a similar animal), or an image, dropped, chosen from the
  disk or pasted (Ctrl+V), cropped in the browser (move, zoom) then saved as a 256 px square.
  Each choice applies at once: agent list, Terminal header, configuration, deleted agents.
  Names, avatars, settings and deletions are saved in `~/.local/share/ziggy-one/agents.json`; the images, in
  `avatars/` next to it (0600, deleted when they are replaced).

- **Files** (`files.py`, `web/files-view.js`): a tab next to Terminal and Git, for every agent. On the left, the
  tree of the agent's folder (loaded folder by folder) and a search (Ctrl+P) by name, fuzzy, or in the content
  (`git ls-files` / `git grep` in a repository, which respects `.gitignore`; otherwise a bounded walk that skips
  `node_modules`, `.venv`…). In the centre, the file: text with line numbers, Markdown preview, images; binaries and
  files over 1 MB are not shown. "Edit" opens editing (text files up to 512 KB, Ctrl+S to save); saving is refused
  if the file has changed on disk since it was opened (an agent modified it), without losing the text being edited.
  The server accesses only the inside of the agent's folder (symbolic links included) and never `.git`.

- **Sessions on disk** (`transcripts.py`): read-only access to Claude Code's transcripts
  (`~/.claude/projects/<folder>/<sessionId>.jsonl`), for the agent list (last message, cost, context: only the end
  of the file is read) and for the Discussion tab (main conversation, going back up the `parentUuid` chain from the
  last message; subagents' work read from `<sessionId>/subagents/agent-*.jsonl`). This format is not documented by
  Anthropic: unknown types are ignored, so a format change gives at worst an incomplete discussion.

- **Markdown** (`web/markdown.js`): ticket descriptions and file previews. The text is parsed then rendered element
  by element, without `innerHTML`; only http(s) and mailto links are kept.

- **Notifications** (account menu): desktop notification when an agent that is not in front of you finishes its turn
  in the Terminal (`Stop` hook; a click opens it); the tab title counts the agents to look at, and an accent dot
  marks those with something new.

## Security

- Listens only on `127.0.0.1`. The `Host` header is checked (protection against DNS rebinding).
- Random token at startup, exchanged for an `HttpOnly; SameSite=Strict` cookie.
- POST requests require a local `Origin` header (CSRF protection).
- `/hooks` requires a separate token, read by the hook from a `0600` file (never as an argument, visible in `ps`)
  and renewed at every start. The browser cookie does not give access to it.
- Strict CSP (`default-src 'self'`, no inline script), no CDN, and no content is inserted via `innerHTML`.
  Styles accept a nonce, new at every page load, given to the `<style>` tags that xterm.js creates: injected markup
  would stay blocked.
- Claude Code's permissions are approved in its Terminal, as in any terminal. To approve fewer by hand:
  `--permission-mode auto` or `--allowed-tools`, or the agent's settings.

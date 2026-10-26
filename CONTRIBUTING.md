# Contributing to Ziggy One

Thanks for your interest! Bug reports, ideas, translations and pull requests are all welcome.

## Ground rules

- **No third-party dependencies.** The server uses the Python standard library only; the front end is vanilla
  HTML/CSS/JS with ES modules, no npm, no bundler, no CDN. This keeps the attack surface tiny for a tool that drives
  agents with your permissions. Adding a dependency needs a strong reason and a discussion in an issue first; vendored
  code must be pinned, checksummed and documented like `web/vendor/xterm/README.md`.
- **Security first.** Never insert untrusted content with `innerHTML`; keep the strict CSP working; every new HTTP
  route must keep the `Host`/`Origin`/token checks; files written by the server are `0600` in `0700` directories.
- **Small, focused changes.** One feature or fix per pull request, with tests.
- **Read like the code around it.** Match the existing style, naming and comment density. Code, comments and
  documentation are in English.
- **Every visible text is translatable.** Write UI texts in English inside `t("…")` / `tn(n, "…", "…")`
  (`web/i18n.js`), and server messages shown in the UI inside `tr("…")` (`i18n.py`), then add the French
  translation (see below). Texts written for the agents (hooks, MCP tools) stay in plain English.

## Getting started

```bash
git clone https://github.com/molory/ziggy-one.git
cd ziggy-one
python3 server.py --port 6768        # a second instance next to your daily one
```

Requirements: Linux, Python 3.10+, Claude Code (`claude`) for real use, Node.js 22+ for the front-end tests.

## Tests

```bash
python3 -m unittest discover -s tests     # server: uses a fake interactive `claude`, spends no quota
node --test tests/*.test.mjs              # front-end logic (pure modules, no DOM)
```

Put pure logic in modules without DOM access (for example `web/*-logic.js`) so it can be tested with `node --test`.
Server features get tests in `tests/test_*.py`; HTTP routes are tested end to end against a real server on a random
port.

## Translations

English is the source language: the English text is the key, and each other language is a dictionary from that
text to its translation, `web/locales/<code>.js` for the interface and `locales/<code>.json` for the server.
A missing entry falls back to English. Keep `{placeholders}` identical to the English key; the tests check it.

To add a language:

1. Copy `web/locales/fr.js` and `locales/fr.json` to `<code>.js` / `<code>.json` and translate the values.
2. Register the code in `LANGUAGES` and `CATALOGS` in `web/i18n.js`, in `LANGUAGES` in `i18n.py`, and give it its
   date locale in `locale()` and its plural rule in `tn()` if it differs from English.
3. Run both test suites, then switch the language in Configuration › General and check every screen.

## Pull requests

1. Open an issue first for anything bigger than a small fix, so we can agree on the approach.
2. Create a branch, make your change, and add or update tests.
3. Make sure both test suites pass and that the app still works in a browser.
4. Update the documentation (README or `docs/GUIDE.md`, in English) and `CHANGELOG.md` (section "Unreleased").
5. Describe what you changed, why, and how you tested it.

## Reporting bugs

Use the bug report template and include your OS, Python version, Claude Code version (`claude --version`),
browser, and steps to reproduce. For security issues, follow [SECURITY.md](SECURITY.md) instead.

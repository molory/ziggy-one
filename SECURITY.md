# Security policy

Ziggy One drives Claude Code agents that can read and change files and run commands with your permissions, so
security reports are taken seriously.

## Supported versions

Only the latest release and the `main` branch receive fixes.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
("Report a vulnerability" in the **Security** tab of the repository), with:

- what an attacker can do and under which conditions (local user, malicious web page, malicious repository…);
- steps to reproduce, and the version or commit you tested.

You should get an answer within a week. Fixes are released as soon as possible and credited unless you prefer
otherwise.

## Scope and threat model

Ziggy One is a single-user tool for your own machine:

- the server listens on `127.0.0.1` only and checks the `Host` and `Origin` headers;
- the web UI needs a random token, exchanged for a per-browser session (cookie `HttpOnly; SameSite=Strict`,
  revocable, ends after 30 days unused); hooks and the agents' MCP endpoint use separate secrets stored in `0600`
  files;
- the page runs under a strict Content Security Policy without inline scripts.

In scope: anything that lets a web page, another local user, or content read by an agent (a file, a ticket, a
web page) bypass these protections, read or change data, or run commands. Out of scope: what an agent does with the
permissions you granted it in Claude Code, and attacks that already require control of your user account.

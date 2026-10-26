# xterm.js (frozen copy)

Terminal emulator of the Terminal tab. It is the only third-party code in Ziggy One: it is copied here once and for
all, served by the local server, and never updates itself.

| File | npm package | Published | sha256 of the file |
|---|---|---|---|
| `xterm.js`, `xterm.css` | `@xterm/xterm@5.5.0` | 2024-04-05 | `1f991ac3b4b283ebf96e60ae23a00a52765dd3a2e46fa6fdda9f1aab032f7495`, `ba8e6985669488981ccf40c0cefe3aba80722cb6c92de7ad628b0bd717faf2b6` |
| `addon-fit.js` | `@xterm/addon-fit@0.10.0` | 2024-04-05 | `bdaefa370b1bfc42ee88d46fe6072400902a4d4b2d45cd93438dda9b23c97089` |
| `xterm.js.map` | `@xterm/xterm@5.5.0` | 2024-04-05 | `63b3b63dbf9f212ed9f000b50f9b34e3f6a25bf25fd5fe2609f37453f388e99c` |

The source code: `xterm.js.map` is the source map published with the package. It contains the full text of the
87 original TypeScript files (`sourcesContent`): you can read it here, and the browser's developer tools show it
instead of the minified code. It is loaded only by those tools, never by the page.

Integrity of the npm archives checked at download (registry sha512):

- `@xterm/xterm@5.5.0`: `sha512-hqJHYaQb5OptNunnyAnkHyM8aCjZ1MEIDTQu1iIbbTD/xops91NB5yq1ZK/dC2JDbVWtF23zUtl9JE2NqwT87A==`
- `@xterm/addon-fit@0.10.0`: `sha512-UFYkDm4HUahf2lnEyHvio51TNGiLK66mqP2JoATy7hRZeXaGMRDr00JiSF7m63vR5WKATF605yEggJKsw0JpMQ==`

Checks made on these files: no `eval` or `new Function`, no network address. xterm.js creates two `<style>` tags
(colours and dimensions of its display): they receive the page's CSP nonce.

MIT licence: see `LICENSE`.

To change version: download the archive from the npm registry, check its `dist.integrity`, review the diff, copy
the three files and update this table.

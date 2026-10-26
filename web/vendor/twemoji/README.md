# Twemoji (frozen copy, 42 images)

Images of the animals offered for an agent's avatar (`web/avatars.js`, "Animal" tab of its configuration).
Only the SVGs in use are copied here; served by the local server, they never update themselves.

| npm package | Published | Archive integrity (registry sha512, checked at download) |
|---|---|---|
| `@twemoji/svg@15.0.0` | 2023-12-10 | `sha512-ZSPef2B6nBaYnfgdTbAy4jgW95o7pi2xPGwGCU+WMTxo7J6B1lMPTWwSq/wTuiMq+N0khQ90CcvYp1wFoQpo/w==` |

Checksum of the whole set (`sha256sum *.svg | sha256sum`): `3b2c9d27f115ea6ed3b379452fafdeb5171f6dc0540d30ee59a9cba069d51be0`.

Checks made on these files: plain `<path>` elements and shapes, without `<script>`, `<style>`, `<foreignObject>`,
link (`href`), `url(…)` or event attribute. In any case they are only displayed through `<img>` tags.

Image licence: Copyright 2020 Twitter, Inc and other contributors, graphics licensed under
CC-BY 4.0 (https://creativecommons.org/licenses/by/4.0/), project https://github.com/jdecked/twemoji.

To add an animal: download the archive from the npm registry, check its `dist.integrity`, copy the SVG named after
the emoji's code points (without `fe0f`, except in a sequence with `200d`), redo the checks and the checksum above,
then add it to `ANIMALS` in `web/avatars.js`.

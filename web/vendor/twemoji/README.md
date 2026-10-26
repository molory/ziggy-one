# Twemoji (copie figée, 42 images)

Images des animaux proposés pour l'avatar d'un agent (`web/avatars.js`, onglet « Animal » de sa configuration).
Seuls les SVG utilisés sont copiés ici ; servis par le serveur local, ils ne se mettent jamais à jour tout seuls.

| Paquet npm | Publié le | Intégrité de l'archive (sha512 du registre, vérifié au téléchargement) |
|---|---|---|
| `@twemoji/svg@15.0.0` | 2023-12-10 | `sha512-ZSPef2B6nBaYnfgdTbAy4jgW95o7pi2xPGwGCU+WMTxo7J6B1lMPTWwSq/wTuiMq+N0khQ90CcvYp1wFoQpo/w==` |

Empreinte de l'ensemble (`sha256sum *.svg | sha256sum`) : `3b2c9d27f115ea6ed3b379452fafdeb5171f6dc0540d30ee59a9cba069d51be0`.

Vérifications faites sur ces fichiers : de simples `<path>` et formes, sans `<script>`, `<style>`, `<foreignObject>`,
lien (`href`), `url(…)` ni attribut d'événement. Ils ne sont de toute façon affichés que par des balises `<img>`.

Licence des images : Copyright 2020 Twitter, Inc and other contributors, graphismes sous licence
CC-BY 4.0 (https://creativecommons.org/licenses/by/4.0/), projet https://github.com/jdecked/twemoji.

Pour ajouter un animal : télécharger l'archive depuis le registre npm, vérifier son `dist.integrity`, copier le
SVG nommé d'après les points de code de l'emoji (sans `fe0f`, sauf dans une séquence avec `200d`), refaire les
vérifications et l'empreinte ci-dessus, puis l'ajouter à `ANIMALS` dans `web/avatars.js`.

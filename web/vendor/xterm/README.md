# xterm.js (copie figée)

Émulateur de terminal de l'onglet Terminal. C'est le seul code tiers de Ziggy One : il est copié ici
une fois pour toutes, servi par le serveur local, et ne se met jamais à jour tout seul.

| Fichier | Paquet npm | Publié le | sha256 du fichier |
|---|---|---|---|
| `xterm.js`, `xterm.css` | `@xterm/xterm@5.5.0` | 2024-04-05 | `1f991ac3b4b283ebf96e60ae23a00a52765dd3a2e46fa6fdda9f1aab032f7495`, `ba8e6985669488981ccf40c0cefe3aba80722cb6c92de7ad628b0bd717faf2b6` |
| `addon-fit.js` | `@xterm/addon-fit@0.10.0` | 2024-04-05 | `bdaefa370b1bfc42ee88d46fe6072400902a4d4b2d45cd93438dda9b23c97089` |

Intégrité des archives npm vérifiée au téléchargement (sha512 du registre) :

- `@xterm/xterm@5.5.0` : `sha512-hqJHYaQb5OptNunnyAnkHyM8aCjZ1MEIDTQu1iIbbTD/xops91NB5yq1ZK/dC2JDbVWtF23zUtl9JE2NqwT87A==`
- `@xterm/addon-fit@0.10.0` : `sha512-UFYkDm4HUahf2lnEyHvio51TNGiLK66mqP2JoATy7hRZeXaGMRDr00JiSF7m63vR5WKATF605yEggJKsw0JpMQ==`

Vérifications faites sur ces fichiers : pas d'`eval` ni de `new Function`, aucune adresse réseau. xterm.js crée
deux balises `<style>` (couleurs et dimensions de son affichage) : elles reçoivent le nonce CSP de la page.

Licence MIT : voir `LICENSE`.

Pour changer de version : télécharger l'archive depuis le registre npm, vérifier son `dist.integrity`, relire le
diff, copier les trois fichiers et mettre à jour ce tableau.

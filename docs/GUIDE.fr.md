# Ziggy One — guide détaillé (français)

Tableau de bord local pour piloter tes agents Claude Code (chacun dans son Terminal, avec ton compte connecté
sur ce poste), suivre l'usage de ton forfait (fenêtre de 5 h et semaine) et organiser ton travail en tableaux Kanban.

**Zéro dépendance tierce** : Python (bibliothèque standard) + HTML/CSS/JS vanilla, sans npm ni build. Deux
exceptions, copiées et figées, servies en local (version, empreintes et vérifications dans leur `README.md`) :
l'émulateur de terminal de l'onglet Terminal, xterm.js (`web/vendor/xterm/`, chargé seulement à l'ouverture de
l'onglet), et les images d'animaux des avatars, 42 SVG Twemoji (`web/vendor/twemoji/`).

## Lancer

```bash
python3 server.py                     # dossier de travail = dossier courant
python3 server.py --permission-mode auto     # mode de permission par défaut des agents
python3 server.py --cwd ~/Developer/mon-projet --permission-mode acceptEdits
python3 server.py --chrome            # active Claude in Chrome pour les agents
```

Ou, plus simple, `ziggy` dans le dossier de travail (une fois : `ln -s "$PWD/ziggy" ~/.local/bin/ziggy`) :
le serveur démarre avec ce dossier par défaut et ouvre l'interface dans le navigateur, déjà connectée ; s'il
tourne déjà, `ziggy` ouvre seulement l'interface. Le token ne s'affiche jamais : le navigateur reçoit un lien
de connexion à usage unique, valable 5 minutes. Sans navigateur, ce lien s'affiche dans le terminal.
Le token est gardé d'un démarrage à l'autre (`~/.local/share/ziggy-one/token`, 0600) : les onglets ouverts
restent connectés après une relance. `--new-token` en génère un nouveau.

Options : `--port`, `--cwd`, `--model`, `--permission-mode`, `--allowed-tools "Bash(git status)" Edit …`, `--chrome`.

## Tests

```bash
python3 -m unittest discover -s tests -v
node --test tests/*.test.mjs        # logique front (facultatif, Node ≥ 22)
```

Les tests utilisent un faux exécutable `claude` (interactif, dans un vrai pseudo-terminal) : ils ne consomment pas de quota.

## Fonctionnement

- **Agents** (`conversations.py`) : un agent = un dossier et une session Claude Code, qu'on utilise dans son onglet
  Terminal. Un clic sur une session ouvre son agent sans rien lancer ; « Ouvrir Claude Code » la reprend (`--resume`).
  Un nouvel agent ouvre aussitôt Claude Code. Plusieurs agents travaillent en parallèle, chacun dans son terminal.
  La croix de l'en-tête ferme l'agent (Claude Code continue dans son terminal) ; sa configuration est le dernier
  onglet, « Configuration ». Sans agent ouvert, le centre affiche l'écran d'accueil animé (`web/hero.js`) : l'emblème Z,
  tes agents en orbite autour (couleurs, initiales, ceux au travail pulsent) reliés par des faisceaux, le titre et les
  boutons « Nouvel agent » / « Nouveau workspace » ; sans animation si le système demande moins de mouvement.
- **Usage** : relu par un appel Haiku minimal (environ 0,001 $, sans outils ni MCP) au démarrage, avec le bouton
  « Actualiser », et en fin de tour d'un agent, au plus toutes les 5 minutes.
- **Configuration** (`web/terminals-logic.js`, `GET /api/terminals`) : le bouton « Configuration » en bas de la
  fenêtre de l'usage ouvre au centre l'onglet « Terminaux Claude » : terminaux ouverts, agents au travail ou qui
  t'attendent, mémoire totale ; une ligne par terminal (agent, dossier, état, ouvert depuis, mémoire de tous les
  processus de sa session) avec « Ouvrir » et « Fermer » (confirmation si l'agent travaille ou t'attend), et un bouton
  qui ferme d'un coup les terminaux au repos. Mis à jour en direct, mémoire relue toutes les 10 s.
  Onglet « Serveur » (`restart.py`) : démarré quand, version (commit), dernier redémarrage, et « Redémarrer le serveur ».
  Le redémarrage est propre : les agents au travail reçoivent une demande de pause, le serveur attend qu'ils soient au
  repos (20 min au plus ; « Forcer maintenant » ou « Annuler » dans le bandeau en haut), note ce qu'il faut rouvrir
  (`restart.json`), se relance avec la même commande (même processus), rouvre les terminaux et fait reprendre les agents
  mis en pause. La page se recharge seule et un bandeau vert confirme : heure, version, terminaux rouverts.
- **Sessions** : une session = une conversation Claude Code, lancée depuis un terminal ou depuis ziggy-one.
  La liste fusionne les sessions ouvertes (lecture seule de `~/.claude/sessions/*.json`, les fichiers `.key` ne sont
  jamais lus), les 50 sessions les plus récentes de tous les dossiers et les agents ouverts dans ziggy-one,
  du plus récent au plus ancien, avec un filtre Actifs / Tous. Chaque agent a un avatar (pastille verte : actif,
  orange scintillante : réfléchit, grise : inactif) et la cartouche de son dossier. Un agent épinglé reste en tête de
  liste, quel que soit le filtre (épingles enregistrées côté serveur dans `pins.json` : elles survivent au redémarrage et valent pour tous les navigateurs).
  Le bouton à épingle, à côté du filtre, n'affiche que les agents épinglés hors workspace ; les autres sont résumés
  en une ligne (« 12 agents non épinglés masqués · tout afficher »). Chaque workspace affiche ses agents épinglés sur
  son total (« 2/5 épinglés ») et, à droite, son propre interrupteur : éteint (icône liste), tous ses agents ; allumé
  (icône épingle), seulement ses épinglés.

- **Contexte** (`context.py`) : chaque agent affiche un camembert et le pourcentage de sa fenêtre de contexte remplie
  (vert, orange dès 50 %, rouge dès 80 %), le détail en tokens au survol, dans l'en-tête et dans sa configuration.
  Les tokens sont ceux du dernier message de l'agent principal (entrée + cache), remis à zéro par une compaction.
  La taille de la fenêtre, gardée par modèle dans
  `~/.local/share/ziggy-one/context-windows.json` ; à défaut, 200 000 tokens, ou un million pour un modèle déjà vu
  au-delà.

- **Nouvel agent** (`folders.py`, `web/agent-names.js`) : « + » puis « Agent » demande le dossier où il travaillera et
  propose comme nom celui du dossier (« projet 2 » s'il est déjà pris), modifiable, et un workspace où le ranger
  dès sa création (facultatif) — les 5 derniers dossiers
  utilisés par des agents en raccourci, ou l'exploration (chemin éditable, fil d'Ariane, sous-dossiers). Le serveur ne
  renvoie que des noms de dossiers (pas les cachés), jamais le contenu des fichiers, et vérifie le dossier choisi.
  « Nouveau dossier ici » crée un sous-dossier du dossier courant (un seul niveau, nom sans « / » ni « . » en tête),
  qui devient le dossier de l'agent.

- **Workspaces** (`workspaces.py`) : des groupes d'agents, créés avec le « + » (qui propose Agent ou Workspace).
  Un workspace s'affiche dans la liste comme un bloc repliable avec ses agents ; on y ajoute ou retire des agents
  (cases à cocher, ou depuis la configuration de l'agent). Un agent n'est que dans un workspace à la fois.
  Un workspace s'épingle comme un agent (agents et workspaces épinglés se mêlent en tête, dans l'ordre des épingles),
  et un clic dessus ouvre sa carte sur l'onglet Configuration (après Raccourcis) : nom, couleur (12 teintes ou
  automatique), agents, suppression ; la flèche à droite le plie ou le déplie. Enregistrés côté serveur
  dans `~/.local/share/ziggy-one/workspaces.json` (0600) ; l'état replié est une préférence du navigateur.

- **Mode Tâches** (`kanban.py`, `web/kanban*.js`) : le sélecteur « Agents | Tâches » en haut de la barre latérale
  bascule entre les agents et des tableaux Kanban (retenu par le navigateur, `#taches` dans l'adresse). Les tableaux
  s'affichent comme les agents : épingles, workspaces de tableaux repliables, engrenage de réglages, avec la
  répartition des tickets par colonne. Un tableau a des colonnes personnalisables (nom, couleur, ordre ; « À faire,
  En cours, Fait » au départ ; supprimer une colonne non vide demande où envoyer ses tickets). Un ticket a un titre,
  une description Markdown (Écrire / Aperçu) et des fichiers joints (bouton, glisser ou coller ; 25 Mo par fichier,
  gardés tant que le ticket existe, dans `kanban-files/` en 0700/0600). Les tickets se déplacent par glisser-déposer
  natif (sans bibliothèque), ou au clavier : Alt + flèches sur une carte. Tout est enregistré côté serveur
  (`kanbans.json`, `kanban-workspaces.json`, `kanban-pins.json`) et publié sur le flux temps réel : plusieurs onglets
  restent synchronisés. Un champ `agent` est réservé sur les tickets pour les confier plus tard à un agent.
  Historique des tickets (`kanban_history.py`) : création, titre (avant → après), description (avant / après),
  changement de colonne, fichiers joints ou retirés, suppression. Une ligne JSON par changement dans
  `kanban-history.jsonl` (0600), en ajout seul : jamais réécrit, une écriture interrompue ne coûte que sa ligne.
  Les noms (colonnes, fichiers) y sont gardés tels qu'ils étaient. La fiche du ticket l'affiche, du plus récent au plus ancien.
  Numéros : chaque ticket a un numéro unique, tous tableaux confondus (#1, #2…), jamais réutilisé (compteur
  `nextNumber` dans `kanbans.json` ; les tickets créés avant sont numérotés au chargement, les plus anciens d'abord).
  Son adresse `/t/<numéro>` ouvre sa fiche (« Copier le lien » dans la fiche). Dans une description, « #42 » devient
  un lien vers le ticket 42 (hors code).
  Lien lisible par un agent (`ticket_links.py`) : « Copier le lien » donne `/t/42?k=<clé>`. Avec le cookie (ton
  navigateur), la fiche s'ouvre ; sans cookie mais avec la clé (un agent : curl, WebFetch), le serveur renvoie le
  ticket en texte Markdown (tableau, colonne, description, fichiers joints et tickets cités avec leurs propres liens,
  historique). La clé est un HMAC du numéro par le token du serveur : elle n'ouvre que ce ticket, en lecture, et
  `--new-token` invalide tous les liens.

- **Kanban pour les agents** (`agent_mcp.py`, `POST /mcp`) : chaque Claude Code lancé dans un terminal reçoit un
  serveur MCP « ziggy » (`--mcp-config <fichier 0600>`) avec six outils : `kanban_boards`, `kanban_list_tickets`
  (filtres colonne / texte), `kanban_get_ticket`, `kanban_create_ticket`, `kanban_update_ticket` (titre, description,
  ou `append` pour ajouter une note) et `kanban_move_ticket`. Tableaux et colonnes se désignent par leur nom, les
  tickets par leur numéro (`#42`). Pas de suppression pour les agents. Chaque agent a sa clé (HMAC de son identifiant
  par le token du serveur), dans le fichier de configuration et jamais sur la ligne de commande : elle dit qui agit,
  et l'historique du ticket note « par <nom de l'agent> ». `/mcp` n'accepte ni cookie ni requête d'une page web
  (origine refusée) ; `--new-token` invalide toutes les clés. Comme tout outil MCP, chaque appel passe par les
  autorisations de Claude Code (outils `mcp__ziggy__kanban_*`).

- **Terminal** (`terminal.py`, `web/terminal-view.js`) : l'onglet par défaut d'un agent. Il ouvre le vrai Claude Code
  (interactif) dans le dossier de l'agent, sur sa session (`--resume`), avec ses réglages (modèle, permissions, Chrome).
  Le serveur lance `claude` lui-même, jamais un shell, dans un pseudo-terminal (`setsid --ctty` : vrai terminal de
  contrôle, redimensionnement, Ctrl+C) ; l'écran part sur le flux SSE (octets numérotés), les touches arrivent par
  POST, et les 512 derniers Ko sont gardés pour redessiner l'écran d'un onglet qui s'ouvre. Toutes les commandes de
  Claude Code y marchent et ne dépendent d'aucun format interne : c'est un terminal. Si Claude Code change de session
  (nouvelle, `/clear`, `/resume`), l'agent la suit grâce au registre des sessions, qui dit aussi s'il est au travail.
  Les touches tapées dans le terminal (Ctrl+B, Ctrl+P…) sont pour Claude Code, pas pour les raccourcis de Ziggy.
  Maj+Entrée ajoute une ligne au message (envoie Échap+Entrée) ; Entrée l'envoie.
  Tes messages ressortent : leur fond gris devient une teinte orange et leur « ❯ » orange (`web/terminal-colors.js`,
  recoloré à l'arrivée de l'écran ; si Claude Code change ce gris, l'affichage reste celui d'origine).
  Fermer l'onglet du navigateur ne ferme pas Claude Code ; redémarrer le serveur, si.

- **Discussion** (`web/discussion-view.js`, `web/discussion-logic.js`) : onglet à droite du Terminal. La conversation de la session de l'agent, mise en forme : tes messages en bulles (commandes `/…` et `!…`
  comprises), les réponses de l'agent en Markdown, ses actions regroupées et repliées (« 3 actions · Bash, Read »,
  avec leur résultat), ses sous-agents et les sorties de commandes. Deux boutons flottants, en bas à droite contre les
  messages : replier / déplier (« Mes messages » ne garde que ce que tu as envoyé, chaque réponse se dépliant à la
  demande), et aller en haut / en bas de la discussion. Relue toutes les 2 s tant que l'onglet est
  affiché (`/api/transcript?since=` : le serveur ne relit la session que si son fichier a changé) ; les 500 derniers
  messages au plus.
  Mode console : « !! » au début de la saisie la fait passer en commande shell (fond sombre, « $ ») ; Entrée la lance
  avec `$SHELL -c` dans le dossier de l'agent (`shell.py`, sans terminal ni entrée, 10 min au plus), sans Claude Code ni
  rien envoyer à l'agent. La commande et sa sortie s'affichent à la suite de la discussion, au fil de l'eau, avec le code
  de retour et la durée ; « Arrêter » tue la commande. ↑ / ↓ rappellent les commandes ; Échap (ou Retour arrière au
  début) revient à l'écriture à l'agent.
  Sous chacun de tes messages, le bouton « ⋯ » ouvre un menu (`web/dropdown.js`, réutilisable) : copier la question
  et la réponse ou la réponse seule (en Markdown, sans les actions), ou les télécharger en PDF. Le PDF est fabriqué par
  le serveur (`pdf.py`, `POST /api/pdf`) avec Chrome ou Chromium en mode invisible, sans réseau et avec une CSP qui
  interdit tout script ; sans Chrome sur le poste, la fenêtre d'impression du navigateur prend le relais.
  En bas, une zone de saisie : Entrée envoie le message dans le Terminal, où l'on bascule (il y est tapé comme au
  clavier, chaque ligne séparée par Échap+Entrée, `web/terminal-input.js`) ; Maj+Entrée ajoute une ligne. Un brouillon
  par agent. Il faut que Claude Code soit ouvert dans le Terminal.

- **Raccourcis** (`shortcuts.py`, `web/shortcuts-*.js`) : onglet d'un agent, et onglet de la vue d'un workspace
  (sa roue dentée : Réglages | Raccourcis). Des prompts tout prêts, avec un titre facultatif : ajouter, modifier,
  ordonner, supprimer. Ceux d'un agent sont à lui seul ; ceux d'un workspace sont communs à tous ses agents et
  viennent après les siens. Dans le Terminal, maintenir Ctrl+Maj fait apparaître le panneau des raccourcis ; les dix
  premiers ont un chiffre (1…9, 0) : Ctrl+Maj+chiffre envoie le prompt (tapé comme au clavier, puis Entrée). Ctrl+chiffre
  seul est pris par le navigateur (changement d'onglet). Le bouton « Raccourcis » de la barre du Terminal garde le
  panneau ouvert : un clic, ou le chiffre seul, envoie ; Échap le ferme. Enregistrés côté serveur
  (`shortcuts.json`, 0600, `POST /api/shortcuts` avec la liste complète) ; ceux d'un agent suivent sa discussion vers sa
  session, ceux d'un workspace partent avec lui.
- **Rôles et annuaire des agents** : chaque agent peut avoir un rôle (Configuration › Rôle : ce qu'on peut lui
  confier, par ex. « Envoie et lit les messages Teams »). Au démarrage de chaque session lancée par Ziggy
  (démarrage, reprise, `/clear`, compaction), le hook `SessionStart` donne à l'agent son propre rôle et la liste des
  autres agents qui en ont un : nom (celui de leur session), rôle, ouvert ou non, et comment les joindre (ListAgents
  puis SendMessage). Rien n'est ajouté si personne n'a de rôle ; un agent supprimé n'y figure pas.
- **Hooks** (`ziggy_hook.py`) : chaque terminal est lancé avec `--settings <fichier 0600>` qui déclare cinq hooks
  Claude Code. `SessionStart` donne l'annuaire des agents (ci-dessus). `UserPromptSubmit` (début d'un tour) marque l'agent au travail et ajoute au contexte de son message
  l'activité partagée ; `Stop` (fin du tour) déclenche la notification, note le bilan du tour et relit l'usage ;
  `Notification` dit quand l'agent attend ta réponse (autorisation demandée, question posée) : pastille rouge « ! »
  sur son avatar et sur son workspace, compteur ⏳ dans le titre de l'onglet, notification du navigateur ;
  `PostToolUse` (l'outil s'est exécuté, tu as donc répondu) efface cette attente, comme ton message ou la fin du tour. Le
  script parle au serveur sur `/hooks/<événement>` avec un token propre (fichier 0600, renouvelé à chaque démarrage) ;
  serveur arrêté ou erreur, il se tait : il ne gêne jamais Claude Code.

- **Activité partagée** (`activity.py`) : avec chaque message, un agent reçoit en quelques lignes ce qu'ont fait depuis
  son message précédent les autres agents de son workspace qui travaillent dans le même dépôt (worktrees compris) :
  demande, début de la réponse finale, commits du tour, puis l'état de son dossier (branche, fichiers non commités).
  Aucun appel à un modèle ; 1 500 caractères au plus (≈ 400 tokens), et rien s'il n'y a rien de neuf. Le bloc est
  présenté à l'agent comme une information, pas une demande. Option du workspace, activée par défaut. Journal et ce
  que chaque agent a déjà reçu : `~/.local/share/ziggy-one/activity.json` (0600). Seuls les agents ouverts dans
  le Terminal de Ziggy y participent (ce sont eux qui ont les hooks).

- **Configurer un agent** (`agents.py`) : l'épingle est à droite de chaque agent (même dans un workspace, où l'agent
  reste en tête). L'onglet Configuration, toujours le dernier, permet de renommer (ou revenir au nom généré), choisir
  son workspace, voir ses informations, le supprimer. Supprimer retire l'agent de ziggy-one (Claude Code fermé, retiré
  de son workspace et des épingles) sans toucher à son historique Claude Code : « Agents supprimés » en bas de la
  liste permet de le restaurer (un agent sans historique y retrouve une discussion, dans son dossier). Les agents ouverts
  sont enregistrés (`conversations.json`) : ils restent dans la liste après un redémarrage du serveur, même sans aucun
  message, jusqu'à ce qu'on les supprime. Une session Claude Code n'est rattachée à l'agent qu'une fois son historique
  écrit ; si Claude Code change de session (`/clear`, `/resume`), nom, épingle et workspace la suivent.
  La section « Claude » règle, pour cet agent, le modèle (Opus, Sonnet, Haiku), le mode
  de permission (auto, manuel, modifications acceptées, plan) et Claude in Chrome ; sinon il suit les options de la
  ligne de commande. Un changement s'applique à la prochaine ouverture de Claude Code dans le Terminal (même session).
  Claude Code est lancé avec `--name <nom de l'agent>` : les autres agents le trouvent sous ce nom (outils ListAgents
  et SendMessage de Claude Code) au lieu de « dossier-xx ». Comme la session ne prend son nom qu'au lancement, renommer
  un agent dont le terminal est ouvert ferme ce terminal (après confirmation) : rouvert, il porte le nouveau nom.
  Un agent créé ici prend par défaut le nom de son dossier ; un agent sans nom (une session ouverte ailleurs) reçoit un nom généré (`names.py`), un animal et un adjectif comme « Loutre agile », unique parmi
  les agents et enregistré dans `agents.json` : il ne change pas d'un message à l'autre, son initiale fait l'avatar, et
  le dernier message passe en sous-titre.
  La section « Avatar » choisit ce qu'affiche son rond : une abréviation de 1 ou 2 caractères (lettres, chiffres ou
  un emoji ; vide, l'initiale du nom), un animal (celui de son nom en raccourci, ou l'un des 68, avec une recherche ;
  une vingtaine n'ont pas d'emoji et prennent l'image d'un animal proche), ou une image, glissée, choisie sur le
  disque ou collée (Ctrl+V), recadrée dans le navigateur (déplacer, zoomer) puis enregistrée en carré de 256 px.
  Chaque choix s'applique aussitôt : liste des agents, en-tête du Terminal, configuration, agents supprimés.
  Noms, avatars, réglages et suppressions sont enregistrés dans `~/.local/share/ziggy-one/agents.json` ; les
  images, dans `avatars/` à côté (0600, supprimées quand on en change).

- **Fichiers** (`files.py`, `web/files-view.js`) : onglet à côté de Terminal et Git, pour tout agent. À gauche,
  l'arborescence du dossier de l'agent (chargée dossier par dossier) et une recherche (Ctrl+P) par nom, approximative,
  ou dans le contenu (`git ls-files` / `git grep` dans un dépôt, ce qui respecte `.gitignore` ; sinon un parcours
  limité qui saute `node_modules`, `.venv`…). Au centre, le fichier : texte avec numéros de ligne, aperçu Markdown,
  images ; binaires et fichiers de plus de 1 Mo ne sont pas affichés. « Modifier » ouvre l'édition (fichiers texte
  jusqu'à 512 Ko, Ctrl+S pour enregistrer) ; l'enregistrement est refusé si le fichier a changé sur le disque depuis
  son ouverture (un agent l'a modifié), sans perdre le texte en cours. Le serveur n'accède qu'à l'intérieur du dossier
  de l'agent (liens symboliques compris) et jamais à `.git`.

- **Sessions sur disque** (`transcripts.py`) : lecture seule des transcripts de Claude Code
  (`~/.claude/projects/<dossier>/<sessionId>.jsonl`), pour la liste des agents (dernier message, coût, contexte : seule
  la fin du fichier est lue) et pour l'onglet Discussion (conversation principale, en remontant la chaîne `parentUuid`
  depuis le dernier message ; travail des sous-agents relu dans `<sessionId>/subagents/agent-*.jsonl`). Ce format
  n'est pas documenté par Anthropic : les types inconnus sont ignorés, si bien qu'un changement de format donne au
  pire une discussion incomplète.

- **Markdown** (`web/markdown.js`) : descriptions des tickets et aperçu des fichiers. Le texte est analysé puis rendu
  élément par élément, sans `innerHTML` ; seuls les liens http(s) et mailto sont gardés.

- **Notifications** (menu du compte) : notification du bureau quand un agent qui n'est pas sous tes yeux termine son
  tour dans le Terminal (hook `Stop` ; un clic l'ouvre) ; le titre de l'onglet compte les agents à consulter, et un
  point d'accent marque ceux qui ont du nouveau.

## Sécurité

- Écoute uniquement sur `127.0.0.1`. L'en-tête `Host` est vérifié (protection contre le DNS rebinding).
- Token aléatoire au démarrage, échangé contre un cookie `HttpOnly; SameSite=Strict`.
- Les requêtes POST exigent un en-tête `Origin` local (protection CSRF).
- `/hooks` exige un token distinct, lu par le hook dans un fichier `0600` (jamais en argument, visible dans `ps`) et
  renouvelé à chaque démarrage. Le cookie du navigateur n'y donne pas accès.
- CSP stricte (`default-src 'self'`, sans script inline), aucun CDN, et aucun contenu n'est inséré via `innerHTML`.
  Les styles acceptent un nonce, nouveau à chaque chargement de la page, donné aux balises `<style>` que crée xterm.js :
  du balisage injecté resterait bloqué.
- Les autorisations de Claude Code se valident dans son Terminal, comme dans n'importe quel terminal. Pour en valider
  moins à la main : `--permission-mode auto` ou `--allowed-tools`, ou les réglages de l'agent.

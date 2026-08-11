# Les sessions Cisco : ce que le tutoriel demande, et ce qui manquait

Audit du tutoriel « Les Sessions sur Cisco : From Zero to Hero »,
laboratoire par laboratoire, sur le routeur **et** le commutateur.

## Ce qui fonctionnait déjà

La mesure de départ est inhabituelle et dite telle quelle : **l'essentiel
du tutoriel fonctionnait**. `show users`, `show who`, `show ssh`,
`show ssh sessions`, `show tcp brief`, `show sessions`, `resume`,
`disconnect`, `disconnect all`, `clear line`, `terminal length` /
`width` / `history size` / `monitor` (avec effet réel, `show terminal`
les reflète), `exec-timeout`, `access-class`, `transport input`,
`login local`, `line vty 5 15`, `show archive log config` — tous
présents et honorés, sur les deux plateformes.

Cinq points ne fonctionnaient pas.

---

## 1. `show line <n>` ignorait son argument

`show line 2` listait **toutes** les lignes, comme `show line` nu. Une
réponse fausse à une question précise — le même défaut que
`dir flash:<répertoire>` portait avant d'être corrigé.

## 2. Le bloc de détail d'une ligne n'existait pas

Sur une vraie machine, nommer une ligne rend sa ligne de résumé **puis un
bloc d'une vingtaine de champs** : délais, limite de session, temps
depuis activation, historique, transports autorisés. C'est ce bloc qui
dit à un opérateur *pourquoi sa session va tomber*, et c'est tout le
sujet des §3.4 et §7.3 du tutoriel.

Il n'y en avait aucun. La commande rendait un tableau

```
   Tty Line  Speed   Timeout
     0  VTY 0  -       00:10:00
```

**qui n'existe dans aucune version d'IOS** — une mise en page inventée.
Le vrai bloc est maintenant rendu, avec les intitulés relevés sur la
référence Cisco (Terminal Services Command Reference, entrée
`show line`). La colonne `Modem` manquait aussi dans l'en-tête du résumé.

### La syntaxe réelle, et un écart du tutoriel

```
show line [line-number [upper-line-number]
          | [{aux | console | tty | vty} line-number [upper-line-number]]]
          [summary]
```

**Il n'existe pas de mot-clé `detail`.** Nommer une ligne demande déjà le
détail ; `summary` est le seul suffixe accepté. Le tutoriel écrit
`show line vty 0 detail` — une vraie machine répond
`% Invalid input detected`, donc c'est ce que le simulateur répond, et un
test le pince. Accepter la forme inventée pour coller au support
apprendrait une commande que le matériel refuse. C'est la même décision
que celle déjà prise pour `show aaa accounting`.

## 3. `absolute-timeout` était refusée

La seule commande qui borne la durée d'une session **active**.
`exec-timeout` ne compte que l'inactivité, donc un opérateur qui tape
sans arrêt n'était jamais déconnecté — exactement ce que
`absolute-timeout` existe pour empêcher (§4.3).

Elle est acceptée, rendue dans la configuration, affichée
(`Session limit is 480 minutes.`) **et elle agit** : le minuteur est
`armAbsoluteTimer`, **délibérément distinct** de celui de l'inactivité.
Réutiliser `armIdleTimer` aurait fait repousser la limite absolue à
chaque frappe, c'est-à-dire ne l'aurait jamais fait expirer pour un
opérateur actif — la négation exacte du mécanisme. IOS prévient
20 secondes avant de couper (`Line timeout expired`) ; l'avertissement est
gardé, c'est la seule chose qui laisse le temps d'enregistrer son travail.

## 4. `escape-character` était refusée

`escape-character {break | <ascii> | default | none | soft}` (§5.7).
Stockée, rendue, et lue par le bloc de détail : la séquence par défaut
s'affiche `^^x` (Ctrl+Shift+6 puis X), `escape-character 27` donne `^[`,
et `none` supprime la suspension de session.

## 5. `send` n'existait pas, et deux réglages tombaient dans le vide

**`send` partait en résolution DNS.** Le mot tombait dans le rattrapage
« mot inconnu », donc la machine cherchait un hôte nommé `send` :

```
Translating "send"...domain server (255.255.255.255)
% Unknown command or computer name, or unable to find computer address
```

C'est désormais une vraie messagerie entre sessions : `SshSessionRegistry`
porte un canal par **numéro de ligne**, chaque terminal s'y abonne pour la
sienne, et `send` pousse le texte. Le canal est keyé par la ligne et non
par l'enregistrement de session pour une raison mesurée — **la console n'a
pas d'enregistrement** (`show users` la synthétise quand la table est
vide), donc un `send *` keyé sur les enregistrements sauterait la seule
ligne dont on est sûr qu'elle est occupée.

Écart du tutoriel, même traitement que `detail` : les formes réelles sont
**`send *`** et **`send vty 0`**, pas `send all` ni `send line vty 0`.

**`session-timeout` et `history size` étaient acceptées et perdues.** La
CLI posait `update.sessionTimeoutMinutes` et `update.historySize` — deux
noms qui n'existaient dans **aucun champ** de `VtyLineConfig`, donc
`withFields` les laissait tomber sans un mot. Rien ne les rangeait, rien
ne les rendait, rien ne les lisait ; la commande répondait `` et ne
faisait rien. Cela dépasse l'affichage : la configuration rendue est
**rejouée à l'import d'une topologie**, donc la parade permanente du
scénario 1 du tutoriel ne survivait pas à une réouverture.

`no history` est distinct de `history size 0` — couper l'historique n'est
pas en demander un de taille nulle — et les deux étaient confondus dans le
néant. `historyEnabled` ne passe délibérément pas par `??` dans
`withFields` : `false` est une valeur, pas une absence, et `no history`
serait perdu à la retouche suivante de la ligne.

---

## Trouvé en chemin

**Le jeton `$(line)` d'une bannière annonçait `0` sur toutes les lignes.**
Deux endroits lisaient `this.vty?.lineIndex`, une propriété qui n'existe
sur aucun objet — `CliShellSession` ne porte que `lineId` (« vty 3 »).
Une seule méthode, `numeroDeLigne()`, sert maintenant la bannière et
l'abonnement aux messages.

## Les trois points ouverts — traités (lot S2)

### 1. Le journal de session, et une affirmation à corriger

J'avais écrit que les messages « n'existent nulle part ». **C'était faux
pour la moitié, et pire pour l'autre.**

`%SEC_LOGIN-5-LOGIN_SUCCESS` et `%SEC_LOGIN-4-LOGIN_FAILED` **existaient**
— mais émis **inconditionnellement**, alors qu'un vrai IOS ne les produit
QUE si l'opérateur a tapé `login on-success log` / `login on-failure log`
(introduites en 12.3 pour cela). Les deux drapeaux existaient, étaient
rendus dans la configuration, et n'étaient **lus par personne** : la
machine journalisait donc ce qu'une vraie tait, et la commande qui
gouverne la trace ne gouvernait rien.

Leur formulation était fausse aussi. Relevée sur transcriptions réelles :

```
%SEC_LOGIN-5-LOGIN_SUCCESS: Login Success [user: X] [Source: Y] [localport: 22]
%SEC_LOGIN-4-LOGIN_FAILED: Login failed [user: X] [Source: Y] [localport: 22] [Reason: Z]
%SYS-6-LOGOUT: User X has exited tty session N(Y)
```

`[localport:]` manquait aux deux, l'échec s'écrivait `Login Failed` au
lieu de `Login failed`, et son motif était entre parenthèses au lieu de
`[Reason: …]`. **`%SYS-6-LOGOUT`, lui, n'existait vraiment nulle part** —
la moitié « fermeture » de « qui s'est connecté, quand, depuis où ». Les
supports de cours lui ajoutent souvent un motif et une durée (« with
timeout after 00:15:00 ») qu'aucune vraie machine n'écrit sur cette ligne.

Deux décisions : **`%SYS-6-LOGOUT` n'est PAS gouverné par
`login on-success log`** (ce sont deux mécanismes distincts sur une vraie
machine, et lier la fermeture au drapeau d'ouverture ferait disparaître la
moitié de la piste d'audit) ; et la politique est **lue à chaque message**
plutôt que copiée, pour qu'une commande tapée après l'attache prenne effet.

**Trouvé en câblant** : `attachLoggingToDevice` — l'endroit évident où
poser la politique — n'est appelé que sur les chemins de redémarrage,
donc presque jamais. Attachée là, la porte restait fermée sur une machine
qui venait pourtant de taper la commande. Elle est posée à l'attache au
**bus**, que le routeur comme le commutateur appellent à la construction.

### 2. L'épuisement des VTY — il fonctionnait déjà

La capacité vient de la plage `line vty` configurée
(`VtyLineConfigStore.lineCapacity`) et `hasFreeLine` garde l'admission via
`VtyIncomingPolicy`. Mesuré : 5 lignes avec `line vty 0 4`, 16 après
`line vty 5 15`, et `clear line vty 2` en libère une. Les cas du lot S2
**pincent** ce mécanisme, ils ne le corrigent pas — le dire vaut mieux que
de les présenter comme une correction.

### 3. `show ssh` avait deux implémentations

Donc deux réponses à une question. Celle du socle rendait un en-tête et
une phrase **constants** : elle ne lisait aucun registre, donc ne pouvait
annoncer aucune session, jamais. Celle du routeur lisait le vrai registre
mais écrivait sa phrase **sans le `%`**. Il n'en reste qu'une, et **la
ligne SSHv1 est toujours écrite** — une vraie machine rend les deux
sections, et c'est cette ligne qui dit qu'une version qu'on veut voir
absente l'est bien. Un commutateur répond « aucune connexion » parce
qu'il n'a pas de pile TCP : c'est la vérité, pas un repli, et il le dit
désormais dans les mêmes mots que le routeur (pincé par test).

## Les deux derniers points — traités (lot S3)

### `Uses` compte pour de bon

La colonne valait **0 pour toujours, sur toutes les lignes** : elle était
rendue sans qu'aucun compteur vive derrière. C'est pourtant le chiffre qui
distingue une ligne **qu'on n'a jamais utilisée** d'une ligne simplement
libre en ce moment — la question que ce tableau sert à poser, et celle par
laquelle commence le diagnostic du scénario 1.

Deux décisions :

- **Le compte est cumulatif** et ne redescend pas à la fermeture.
  « Combien de connexions depuis le dernier démarrage » n'est pas
  « combien maintenant », que la table des sessions dit déjà.
- **La clé porte le type en plus du rang** (`con:0`, `vty:0`), parce que
  `con 0` et `vty 0` valent tous deux zéro dans leur propre numérotation :
  une clé numérique seule les aurait confondus et la console aurait compté
  pour la première vty. La première version de ce correctif avait
  exactement ce défaut, trouvé avant de le pousser.

La console se compte à l'ouverture du terminal (elle n'a pas
d'enregistrement de session), une vty dans `SshSessionRegistry.open()`.
L'AUX reste à 0 et c'est vrai : rien ne s'y connecte ici.

### `show ssh` décrit les algorithmes de la machine

Le chiffrement et le HMAC étaient **écrits en dur**. Une machine sur
laquelle on venait de taper
`ip ssh server algorithm encryption aes128-ctr` annonçait quand même
`aes256-ctr` — elle contredisait sa propre configuration au même instant,
alors que `show ip ssh` la lisait correctement à deux lignes de là.

Ce qui est rendu est la **préférence du serveur** — le premier de la liste
qu'il accepte — c'est-à-dire ce qu'un vrai serveur retient quand le client
offre tout.

**Ce que cela ne fait pas, et qui reste écrit** : ce simulateur ne
**négocie** pas ces algorithmes. Il n'y a pas d'intersection à calculer
parce qu'aucun client n'offre quoi que ce soit. Ce qui change est que la
valeur affichée vient désormais de la machine et non d'une constante.

**Mesures S3** : `tuto-sessions-uses-et-chiffrement.test.ts`, **12 cas**,
discriminé par `git stash` : **10 tombent** avant correctif. 12 suites
connexes vertes (**504 cas**). Typecheck 119, lint identique.

---

## Mesures

`tuto-sessions-cisco.test.ts` — **67 cas**, les deux plateformes,
discriminé par `git stash` : **39 tombent authentiquement** avant
correctif. Les 28 autres sont ce qui marchait déjà, et le fichier le dit.

Régressions connexes : 12 suites (lignes, bannières, tableaux CLI, accès,
`show` communes), **474 cas verts**. Typecheck : **119** hors tests, un de
moins que la référence de 120 — le `lineIndex` corrigé. Lint : identique
(les 2 erreurs de `TerminalSession.ts` préexistent).

**Lot S2** — `tuto-sessions-journal-et-lignes.test.ts`, **17 cas**,
discriminé par `git stash` : **10 tombent** avant correctif. Les 7 autres
sont les cas d'épuisement des VTY (mécanisme préexistant) et les refus.
12 suites connexes vertes (**318 cas**), 6 cas Playwright verts.
Typecheck 119, lint identique.


---

## Conformité au tutoriel (lot S4)

`tuto-sessions-conformite.test.ts` — **107 cas**, organisés selon le
**plan du tutoriel** et non selon la liste des correctifs : c'est le
parcours d'un apprenant, du premier `show users` au dernier scénario, sur
le routeur et le commutateur.

Il couvre ce que les trois fichiers précédents ne couvraient pas — les
types de session (partie 1), le nombre de lignes et leur épuisement
(partie 2), **l'isolation entre sessions** (partie 6.1 et scénario 3),
les sessions sortantes (partie 5), l'historique (partie 8) — et il
**balaie le récapitulatif** : chaque commande de la table de référence
répond, et les deux formes inventées par le tutoriel
(`show line vty 0 detail`, `send all` / `send line vty 0`) sont pincées
comme des refus.

### Un défaut trouvé en écrivant ce fichier

**`show users` ne listait AUCUNE session.** La fonction ne prenait aucun
argument et rendait quatre lignes constantes — une console seule,
toujours, quel que soit le nombre de sessions ouvertes. Le registre, lui,
savait les lister (`SshSessionRegistry.formatShowUsers`) et **personne ne
le lui demandait**.

C'est la commande par laquelle commence toute la partie 3 (« voir les
sessions ») et le diagnostic du scénario 1 (« toutes les VTY sont
occupées ») : les deux portaient sur un texte qui ne mesurait rien.
`show who`, son synonyme, était touché de la même façon.

### Deux limites nommées plutôt que passées sous silence

- **L'historique EST partagé entre deux sessions d'une même machine.**
  Le tutoriel §6.1 le range parmi ce qu'une session ne partage pas, et il
  a raison ; `cmdHistory` figure bien dans `VtySnapshot`, mais la
  rotation d'état ne l'isole pas. Le cas pince ce qui est vrai
  aujourd'hui — chaque session tient son propre tampon de saisie — et
  nomme l'écart. Le corriger touche la rotation d'état vty, pas la vue.
- **Deux cas sont ignorés sur le commutateur** (`Uses`, épuisement des
  VTY) : il n'a pas de registre de sessions parce qu'il n'a pas de pile
  TCP. Différence de plateforme déjà écrite pour `show ssh` et le serveur
  HTTP, pas un trou de couverture.

## Lot S5 — la console n'est pas une VTY, et SSH ne parle pas pour elle

Signalé sur transcript réel, et le diagnostic était le bon : le
simulateur confondait **le protocole**, **le type de ligne** et **la
source**. Trois notions distinctes, une seule variable.

### La mesure

`line console 0` + `login local`, puis deux opérateurs se succèdent sur
le port console. La machine répondait :

```
Username: alice
Password:
*Aug 11 07:14:37.428: %SSH-6-SSH2_SESSION: Session opened for 'alice' on vty 0 from console
```

Une seule ligne, trois faits contradictoires — protocole SSH, ligne
virtuelle, source locale — pour un opérateur assis devant le port
console. Puis `show users` listait alice sur `vty 0` et bob sur `vty 1`,
alice survivait à son propre `exit`, et bob relisait l'historique
d'alice.

### La cause, une et non quatre

`SshSessionRegistry.onLoginSuccess` s'abonnait à **toute**
authentification réussie et appelait `open()`, qui allouait
inconditionnellement une **vty** puis publiait
`router.ssh.session.opened`, que `LoggingConfig` rend en `%SSH-6-`.
Aucune notion de transport n'existait dans le registre.

**L'information était pourtant là et jetée** : `recordLoginSuccess`
porte le mot `console` dans son champ `from` depuis toujours. C'est la
forme de défaut que ce dépôt referme sans cesse — une valeur transportée
que personne ne lit.

### Ce qui est livré

`SessionTransport` (`console | ssh | telnet | aux`) et `LineKind`
(`con | vty | aux`) sont **deux types distincts**, reliés par une table :
un transport décide quel type de ligne il occupe, et rien d'autre n'en
déduit rien.

- **Chaque type de ligne se numérote dans SON espace.** `con 0` et
  `vty 0` portent tous deux le rang 0 : le jeu des rangs pris est filtré
  par type, sans quoi une console occupait la première vty.
- **Le nombre de lignes physiques ne se configure pas** — un châssis a un
  port console et un port auxiliaire, et `line con 1` n'existe pas. Une
  seconde console est donc refusée ; seules les vty ont une capacité
  réglable.
- **Une session locale n'a pas d'adresse d'origine** : `Location` est
  vide dans `show users`, et `%SEC_LOGIN-*` écrit `[Source: 0.0.0.0]
  [localport: 0]`, ce qu'IOS écrit pour un accès local. Recopier le mot
  `console` dans un champ qui attend une adresse décrivait une source qui
  n'en est pas une.
- **`%SSH-6-SSH2_SESSION` n'est émis que pour un transport SSH.** Une
  session non-SSH est déjà annoncée par l'abonnement à `login.success`
  (`%SEC_LOGIN-5-LOGIN_SUCCESS`, et seulement si `login on-success log`
  est configuré — sinon une vraie machine n'écrit rien) : deux émetteurs
  pour un événement auraient écrit la ligne deux fois.
- **`*` marque la session COURANTE** et non la première de la liste. Cela
  ne peut pas se déduire de la table — la première ligne est la plus
  BASSE, pas celle qui pose la question — donc le registre porte
  explicitement `setCurrentSession`.
- **La colonne `Line` porte le rang ABSOLU** (`0 con 0`, `1 vty 0`),
  distinct du rang dans le type.
- **Une session console se ferme quand l'opérateur quitte.** Elle était
  OUVERTE à l'authentification et fermée nulle part, donc `show users`
  décrivait comme présents des gens partis — et, la console n'ayant
  qu'une ligne, le suivant aurait été refusé faute de place.
- **L'historique appartient à la session EXEC**, comme IOS le documente.
  `VtySnapshot` portait déjà `cmdHistory` — l'état par session existait —
  mais la console le traversait sans jamais le remettre à zéro.

### Un second défaut trouvé en mesurant, et il allait dans l'autre sens

Le premier test d'historique passait **avant comme après** correctif. En
mesurant plutôt qu'en supposant : avant correctif l'historique du
terminal ne retenait pas non plus ce qui venait d'être tapé — il rendait
`enable`, une commande d'avant l'authentification, et **perdait** la
suivante. Un cas qui n'aurait vérifié que l'absence chez bob serait donc
passé pour une mauvaise raison. Le cas pince maintenant les deux moitiés :
alice relit **sa** commande, bob ne relit **ni** celle d'alice **ni** ce
qui a été tapé avant l'authentification.

### Côté Huawei

Le registre est partagé, donc la séparation l'est. `display users` du
routeur rend désormais `CON`/`AUX`/`TEL`/`SSH` au lieu de choisir entre
`TEL` et `SSH` sur le seul numéro de port. **Reste ouvert et écrit plutôt
que tu** : `display users` du COMMUTATEUR Huawei
(`HuaweiCommonDisplay.displayUsers`) est une constante qui décrit
toujours une console libre et ne lit aucun registre — même famille de
défaut, autre sujet.

### Points du signalement délibérément non traités

- **La sortie de démarrage** (bootstrap, registre de configuration) est
  volontairement abrégée : le simulateur reproduit la CLI, pas le
  chargeur d'amorçage.
- **`no shutdown → down`** est correct et le signalement le dit :
  `adminState`, `operState` et l'état du protocole de ligne sont bien
  trois choses distinctes ici, et une interface sans lien tombe.
- **La table des licences** est une sortie de synthèse et non la
  transcription d'une version d'IOS précise.

## Lot S6 — `display users` du commutateur, et un seul rendu pour VRP

Suite directe de S5, qui avait laissé ce point ouvert et écrit.

### La mesure

`HuaweiCommonDisplay.displayUsers()` était une **constante**. Elle
décrivait toujours une console libre, quel que soit qui était connecté,
et ne lisait aucun registre. Le commutateur Cisco avait le même trou par
un autre chemin : `registreSessions()` cherche `getSshSessionRegistry`,
que `Switch` ne portait pas, donc `show users` retombait sur son texte de
repli.

Et **les deux rendus de `display users` du dépôt se contredisaient** —
défaut que ce projet referme sans cesse, un second rendu possible d'une
même question. Vérifié contre la documentation Huawei plutôt qu'écrit de
mémoire, c'est le rendu du ROUTEUR qui avait trois inventions :

| Ce que le dépôt écrivait | Ce que VRP écrit |
|---|---|
| `UI` | **`User-Intf`** |
| une colonne `User` | une **ligne** `Username : admin` sous chaque entrée |
| `AuthorcmdFlag` = `N` | `no` |

La colonne `User` n'était pas qu'une faute de mise en page : le nom d'un
utilisateur est de longueur libre, donc en faire une colonne oblige à le
tronquer ou à décaler tout ce qui suit. VRP lui donne sa propre ligne
pour cette raison.

### Ce qui est livré

- **`Switch` porte un `SshSessionRegistry`**, construit **avec** le
  magasin d'identifiants et non paresseusement : le registre s'abonne aux
  authentifications réussies, donc le créer à la première lecture de
  `display users` lui ferait manquer toutes celles d'avant — la vue
  serait vide sur une machine où quelqu'un est connecté.
- **Un seul rendu**, `SshSessionRegistry.formatDisplayUsers`, passant par
  `TextTable` et un layout déclaré dans `huaweiTableLayouts.ts`. La
  constante disparaît ; les deux plateformes lisent la même fonction, et
  un test pin que routeur et commutateur rendent le même en-tête.
- **Le numéro d'interface utilisateur est un troisième espace de
  numérotation**, distinct du rang de la ligne dans son type : la console
  est l'interface 0, les vty commencent à **129**. Trois numérotations,
  un seul champ affiché.
- **Une console physique existe même sans personne dessus** — c'est ce
  que décrit la ligne de repli — mais dès qu'une session est ouverte la
  vue la LIT.

Ce qui reste vrai et n'est pas contourné : `Switch` n'a pas de pile TCP,
donc aucun serveur SSH ni telnet n'y écoute. La seule session qu'un
commutateur puisse ouvrir est celle de sa console, et c'est ce que la vue
montre.

### Une limite mesurée, épinglée par test plutôt que tue

`local-user` du commutateur Huawei range dans une carte **locale au
shell** et remplace le mot de passe par `******` : il n'atteint jamais
`NetworkOsCredentialStore`, donc aucun compte déclaré ainsi ne peut
authentifier quoi que ce soit. C'est la même famille de défaut que celui
qu'on vient de refermer, mais un autre sujet — le brancher ferait
demander un mot de passe à la console d'un commutateur, ce qui dépasse
une correction d'affichage. Un cas nommé `LIMITE` le pince, pour qu'il
soit visible plutôt que silencieux.

### Trouvé en corrigeant, et remis

Retirer l'interception de `display users` dans `HuaweiRouter` — pour
n'avoir qu'un chemin — a cassé le chemin SSH **synchrone**, qui ne
traverse pas le trie. Elle est restaurée : ce n'est pas un second rendu,
les deux routes appellent la même fonction. Et un cas existant encodait
l'en-tête inventé `UI` comme contrat ; il est corrigé sur la valeur
mesurée, pas contourné.

## Lot S7 — les points restants du rapport de transcript, tous traités

Le rapport comptait seize points. S5 et S6 en ont fermé neuf ; ceux-ci
ferment les sept autres, plus les deux que ces lots avaient eux-mêmes
laissés derrière. **Rien n'est reporté.**

### §5 — `history size` de ligne et `terminal history size` de session

Le rapport avait vu juste, et la mesure a montré **trois magasins pour
une notion, aucun relié** :

| Magasin | Écrit par | Lu par |
|---|---|---|
| `terminalHistorySize` (shell) | `terminal history size` | le shell |
| `VtySnapshot.historySize` | **personne** (figé à `10`) | personne |
| `VtyLineConfig.historySize` | `history size` sous `line vty` | **personne** |

Et sous `line console 0`, `history size` tombait dans la branche console,
qui rend `''` pour tout ce qu'elle ne connaît pas : la commande était
acceptée et jetée.

Livré : la ligne porte le DÉFAUT (`history size N` / `no history` sous
`line console 0`, retenue, rendue, rejouable à l'import), la session
porte la valeur COURANTE, elle tourne avec l'instantané, et fermer la
session la rend au défaut de la ligne — sans quoi un `terminal` tapé une
fois gouvernait la machine pour toujours. `terminal no history` VIDE le
tampon : le drapeau seul laissait `show history` rendre ce qui y était.

### §10 — `%SYS-5-CONFIG_I` nomme la ligne

Le mot « console » était la source pour tout le monde. IOS écrit
`Configured from console by <user> on vty0 (<ip>)` quand la
configuration ne vient pas de la console — le seul moyen pour un auditeur
de savoir d'où elle vient. Le suffixe était omis parce que le numéro de
ligne vivait hors de portée ; le registre porte désormais la ligne, le
transport et l'adresse, donc la question a une réponse. Une session
console n'en reçoit aucun : `by console` dit déjà tout.

### §13 — le registre de configuration au démarrage

`show version` lisait la vraie valeur, le démarrage ne l'imprimait pas du
tout — alors que c'est la seule façon de voir qu'un `config-register
0x2142` fera ignorer la configuration au prochain reload. Le démarrage lit
**le même rendu** (`renderConfigRegisterLine`), pas une seconde copie.

### §14 — la table de licences, et quelle commande la produit

Le rapport demandait de déterminer quelle commande produit cette sortie.
Réponse mesurée : **ce sont deux tables différentes**. `show license`
liste les licences par fonctionnalité ; la table des paquets
technologiques (`ipbase`/`security`/`uc`/`data`) est celle de
`show license feature` — qui **n'existait pas**, si bien que la table du
démarrage défilait une fois et n'était plus relisible. Elle existe, et
lit la même source que le démarrage.

### §15 — l'identité est une propriété de l'instance

`serialNumber` était une constante du profil matériel, donc **toute une
topologie était un troupeau de jumeaux** : dix routeurs, dix fois
`FTX1234567A`. Quatre vues l'écrivaient même en dur (`show platform`,
`show license udi`, `show diag`, `show inventory`).

`chassisSerial(profil, deviceId)` le dérive : forme Cisco (site, semaine,
séquence), **stable** d'un appel et d'un rechargement à l'autre, unique
d'une machine à l'autre. Un tirage aléatoire donnerait un numéro
différent à chaque lecture, ce qui n'identifie plus rien.

### §9 — les trois états d'interface

Vérifié plutôt que supposé : `no shutdown` sans câble laisse bien
`GigabitEthernet0/0 is down, line protocol is down` et retire seulement
`administratively down`. Les trois faits sont distincts et le restent ;
deux cas les épinglent pour que ça ne régresse pas.

### Les deux points que S5 et S6 avaient laissés derrière

**Le message SSH n'était celui d'aucune machine.** `Session opened for
'alice' on vty 0 from 10.0.0.5` n'existe ni sur IOS ni sur VRP. IOS écrit
`%SSH-5-SSH2_SESSION: SSH2 Session request from <ip> (tty = N) using
crypto cipher '<c>', hmac '<h>' Succeeded` — sévérité **5**, pas 6. Le
couple chiffrement/HMAC est **lu de la configuration** via la règle qui
servait déjà `show ssh` (`algorithmesRetenus`), extraite pour que les
deux vues ne puissent pas se contredire : `ip ssh server algorithm
encryption aes256-ctr` change ce que le journal annonce.

**`local-user` du commutateur Huawei déclare un vrai compte.** Il rangeait
dans une carte locale au shell en remplaçant le mot de passe par
`******` : le compte n'existait pour personne. Il alimente le même
magasin que le routeur — le secret est gardé, donc le compte
s'authentifie — tout en conservant sa carte pour le rendu de la
configuration. `undo local-user` le retire vraiment ; son parseur
n'existait pas, la forme tombait dans le fourre-tout `rawLines`.

## Lot S8 — SSH ne parle que de SSH, à l'ouverture ET à la fermeture

Signalé : « il y a toujours le souci avec les notif de ssh qui
apparaissent ». En rejouant le transcript complet et en filtrant sur
`SSH` — plutôt qu'en supposant que S5 avait tout couvert — une seule
ligne restait :

```
*Aug 11 14:15:26.105: %SSH-6-SSH2_CLOSE: Session closed for 'alice' on con 0 (logout)
```

S5 avait corrigé l'OUVERTURE et laissé la FERMETURE : exactement la même
contradiction — le sous-système SSH annonçant une ligne console — du côté
qui n'avait pas été regardé. La leçon est celle du lot lui-même : un
événement qui a deux moitiés se corrige des deux côtés, sinon on déplace
le défaut au lieu de le fermer.

En cherchant tous les émetteurs plutôt que celui-là seul, un **troisième**
est apparu : `tcp.connection.opened` écrivait `%SSH-…-SSH2_SESSION` dès
l'acceptation d'une connexion TCP sur le port 22. Une connexion TCP n'est
ni une session SSH établie ni une authentification : elle précède les
deux et peut n'aboutir à aucune. C'était donc un second émetteur pour le
message que `router.ssh.session.opened` écrit déjà, dans une formulation
(`AUTHENTICATION: SSH connection from …`) qui n'est celle d'aucun IOS —
et sa branche non-SSH doublait `%SEC_LOGIN-5-LOGIN_SUCCESS`. L'abonnement
est supprimé.

### Ce qui est livré

- La fermeture est gardée par la même règle que l'ouverture : un
  transport non-SSH n'écrit aucun `%SSH-`.
- **Le départ reste annoncé** — `%SYS-6-LOGOUT` le fait pour toutes les
  lignes, et c'est la trace qu'un auditeur cherche. Taire SSH ne devait
  pas taire le départ ; un cas le vérifie.
- La formulation de fermeture est celle d'IOS, relevée sur transcription :
  `%SSH-5-SSH2_CLOSE: SSH2 Session from <ip> (tty = N) for user '<u>'
  using crypto cipher '<c>', hmac '<h>' closed`.
- `%SYS-6-LOGOUT` utilisait `?? '0.0.0.0'`, qui ne rattrape pas la chaîne
  VIDE que porte désormais une session locale : il rendait `0()`.

### Deux cas existants encodaient le défaut comme contrat

`logging-enhancements.test.ts` affirmait qu'une connexion TCP nue sur le
22 produit `%SSH-5-SSH2_SESSION`, côté Cisco **et** côté Huawei. Les deux
sont corrigés sur la mesure : rien n'est journalisé à ce moment-là, ni sur
IOS ni sur VRP.

## Lot S9 — accès concurrents à la console, et le niveau des comptes livrés

### Un châssis n'a qu'un port console

Dans l'interface, ouvrir un terminal **est** un branchement sur le port
console. `TerminalManager.openTerminal` empilait pourtant les sessions
sans limite : deux onglets sur le même routeur donnaient deux consoles
indépendantes, chacune avec son mode, son niveau de privilège et son
historique, sur une machine qui n'a qu'une ligne `con 0` — et dont le
registre de sessions refusait déjà, depuis le lot S5, une seconde session
console. Les deux couches se contredisaient.

Le second appel **rend la session déjà ouverte** : l'interface ramène
l'opérateur devant la console qui existe (elle la dé-minimise et la met
au premier plan, ce que `handleOpenTerminal` faisait déjà pour
l'identifiant rendu). Fermer le terminal libère la console.

La règle est portée par l'équipement, pas devinée : `consoleLineCount()`
(capacité `ConsolePortHost`) vaut 1 sur `Router` et `Switch`, donc sur
les cinq plateformes CLI. **Un hôte garde ses terminaux multiples** — un
PC a plusieurs consoles virtuelles, et ce dépôt donne déjà à chacune son
`cwd`, son environnement et son pts.

### Une seconde fenêtre est une VTY

`openTerminal(device, 'vty')` ouvre une ligne **virtuelle** : c'est ce
qu'est réellement une seconde session sur un routeur, et elles restent
indépendantes. La console reste unique même avec des vty ouvertes.

Cela a corrigé sept suites qui vérifiaient une propriété **juste** — deux
sessions, une seule avec `terminal monitor`, une seule reçoit le flux —
dans un laboratoire **impossible** : deux câbles console sur un châssis.
Elles décrivent désormais une console et une vty, ce que la propriété
exige vraiment.

### Les comptes livrés ouvrent en EXEC utilisateur

Signalé : `alice`/`bob`/`carl`/`dave` atterrissaient directement sur `#`,
et `exit` fermait la session dans la foulée. La cause est le niveau : ils
étaient provisionnés à **15**, donc IOS ouvre en EXEC privilégié — le
comportement était correct pour ce niveau, mais le niveau ne l'était pas.
Un `username X secret Y` sans `privilege` vaut **1** sur une vraie
machine, et c'est le parcours que le cours enseigne : `>` puis `enable`
puis `#`.

Ils sont provisionnés à 1. Ce qui suit est alors le vrai IOS et n'a pas
changé : `enable` monte à `#`, `disable` redescend à `>` **sans fermer**
la session, et `exit` depuis `>` comme depuis `#` libère la console —
`exit` quitte l'EXEC, c'est `disable` qui change de niveau. Un compte
déclaré `privilege 15` par l'opérateur ouvre toujours sur `#`.

### L'incohérence de privilège signalée, et ce qu'elle était vraiment

Transcript fourni : `username mandeng privilege 1` dans la configuration,
et `show privilege` répondant **15** sur la console de ce même
utilisateur. Deux causes distinctes, et une seule est un défaut.

**Le défaut** : les comptes livrés étaient provisionnés à 15 (corrigé
ci-dessus), donc la configuration affirmait quatre administrateurs que
personne n'avait déclarés.

**Ce qui n'en est pas un** : `enable` sans mot de passe d'activation
**passe sur la console** et est refusé (`% No password set`) sur une
vty. Ce n'est pas une commodité mais une règle de sécurité d'IOS —
une ligne réseau ne doit pas offrir le mode privilégié à qui sait taper
`enable`, alors qu'un accès console suppose d'être devant la machine.
Le dépôt l'implémentait déjà correctement ; deux cas l'épinglent
maintenant pour que ça ne régresse pas, parce que la lecture naturelle du
transcript est d'y voir un bug.

**Une correction envisagée puis annulée, et pourquoi** : masquer les
comptes livrés du `show running-config` (un vrai routeur n'a aucun compte
d'usine). `cross-equipment-default-users.test.ts` a montré que c'était la
mauvaise décision — ce fichier vérifie que la distribution de démonstration
est **découvrable sur chaque plateforme** : `id` sous Linux, `net user`
sous Windows, la configuration sur IOS. Les masquer supprimait la seule
façon de les trouver sur un équipement Cisco. Ils restent rendus, au
niveau 1.

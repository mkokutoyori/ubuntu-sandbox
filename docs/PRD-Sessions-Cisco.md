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

## Laissé ouvert, mesuré et écrit plutôt que tu

- **Les messages `%SYS-6-LOGOUT` / `%SEC_LOGIN-5-LOGIN_SUCCESS` /
  `%SEC_LOGIN-4-LOGIN_FAILED`** (§9.1) n'existent nulle part dans le
  dépôt. Toute la partie 9 et le diagnostic du scénario 1 reposent
  dessus. C'est un chantier à part entière — il touche le journal, pas
  les lignes — et il n'est pas fait ici.
- **L'épuisement des VTY** (§2.2, scénario 1) : le refus quand toutes les
  lignes sont prises n'est pas vérifié par ce lot.
- **`show ssh` diverge entre les deux plateformes** : le routeur répond
  `No SSHv2 server connections running.` sans en-tête ni `%`, le
  commutateur rend l'en-tête *et* le message. Deux rendus d'une même
  commande, donc au moins un des deux est faux.
- **`Uses`** est toujours 0 : rien ne compte les connexions par ligne
  depuis le démarrage. Le champ est rendu parce qu'il fait partie du
  tableau, pas parce qu'il mesure quelque chose.

---

## Mesures

`tuto-sessions-cisco.test.ts` — **67 cas**, les deux plateformes,
discriminé par `git stash` : **39 tombent authentiquement** avant
correctif. Les 28 autres sont ce qui marchait déjà, et le fichier le dit.

Régressions connexes : 12 suites (lignes, bannières, tableaux CLI, accès,
`show` communes), **474 cas verts**. Typecheck : **119** hors tests, un de
moins que la référence de 120 — le `lineIndex` corrigé. Lint : identique
(les 2 erreurs de `TerminalSession.ts` préexistent).

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

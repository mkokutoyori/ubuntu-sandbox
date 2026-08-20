# PRD — Une connexion à un équipement réseau occupe une LIGNE

## 0. Contexte et portée

Sur un routeur ou un commutateur, **être connecté n'est pas un état vague :
c'est occuper une ligne**. La ligne est une ressource comptée, nommée,
configurable et épuisable — `line console 0`, `line aux 0`, `line vty 0 4`
côté Cisco, `user-interface con 0` / `user-interface vty 0 4` côté Huawei.
Tout ce qu'un cours de sécurité fait poser sur un équipement se pose sur
une ligne : `login local`, `exec-timeout`, `access-class`, `transport
input`, `privilege level`. Et tout ce qu'un administrateur fait pour
reprendre la main passe par une ligne : `show users`, `clear line`,
`display users`, `free user-interface`.

Ce PRD couvre :

- `src/network/devices/router/aaa/SshSessionRegistry.ts` — la réserve de
  lignes, ses numérotations et ses vues ;
- `src/terminal/sessions/TerminalManager.ts` et `CLITerminalSession.ts` —
  ce qu'une fenêtre de terminal représente ;
- `src/network/devices/shells/vty/CliShellSession.ts` — l'identité de
  ligne portée par l'état CLI d'une session ;
- `clear line` (IOS) et `free`/`kill user-interface` (VRP) ;
- `show users`, `show line`, `display users`, `display user-interface`.

### 0.1 Un aveu, parce qu'il explique la moitié du document

J'ai cassé le comportement existant. `TerminalManager.openTerminal(device)`
rendait la session console déjà ouverte quand on rouvrait un terminal sur
un routeur ; je l'ai remplacé par « la seconde fenêtre prend une vty ».

Cette vty était une **fiction** : elle n'occupait aucune ligne, ne
consommait aucune capacité, n'apparaissait dans aucune vue, et ne pouvait
donc jamais être refusée. Le comportement d'origine était plus juste que
le mien.

Mais le comportement d'origine n'était pas juste non plus, pour une autre
raison : la session console qu'il rendait n'occupait, elle non plus,
aucune ligne. Les deux versions décrivent une machine où « être connecté »
n'a pas de trace. Ce document ne revient donc pas en arrière — il pose la
règle dont les deux versions manquaient.

### 0.2 Le constat qui motive ce document

La réserve de lignes existe, elle est correcte, et **le terminal graphique
est entièrement en dehors**. Mesure faite avant d'écrire une ligne de code,
sur un `CiscoRouter` neuf piloté par `TerminalManager`, deux fenêtres
ouvertes :

```
sessions ouvertes = 2
s1.vty = vty-1  lineId « vty 1 »
s2.vty = vty-2  lineId « vty 2 »
lignes actives dans le registre = 0

SHOW USERS:
    Line       User       Host(s)              Idle       Location
*  0 con 0                idle                 00:00:00

SHOW LINE:
   Tty Typ     Tx/Rx A Modem Roty AccO AccI  Uses  Noise  Overruns  Int
*    0 CTY                 -    -    -    -     0      0       0/0    -
```

Sept lignes de sortie, et tout y est faux :

| Ce que la machine affiche | Ce qui est vrai |
|---|---|
| deux sessions ouvertes | un châssis a **un** port console |
| la session console s'appelle `vty 1` | c'est `con 0` |
| `vty 1` puis `vty 2` | le compteur est **global au module** : deux routeurs différents se partagent la suite |
| 0 ligne active dans le registre | un opérateur est connecté |
| `* 0 con 0 … idle` | ce texte est une **constante de repli**, affichée à l'identique par un routeur que personne ne touche |
| `Uses 0` sur la CTY | c'est la ligne sur laquelle on est **précisément en train de taper** |
| la capacité `line vty 0 4` ne borne rien pour ces sessions | elle borne la réserve, mais la réserve n'est jamais sollicitée |

Autrement dit : `registry.open()` n'avait qu'un appelant de production —
le serveur SSH/telnet. Le terminal graphique, qui est la façon dont **99 %
des sessions de ce simulateur sont ouvertes**, n'y touchait pas.

### 0.3 Deux erreurs de sonde, dites ici plutôt que tues

Deux défauts « trouvés » à la première mesure n'en étaient pas, et les
deux auraient fait « corriger » du code juste :

1. **« `line vty 0 1` ne borne pas la réserve »** — trois sessions étaient
   acceptées là où deux étaient attendues. La sonde avait omis `enable`
   avant `configure terminal` : la configuration n'était jamais entrée.
   Mesurée correctement, `lineCapacity()` vaut 2 et la troisième session
   est refusée. La réserve était bornée depuis toujours.
2. **« `clear line` n'existe pas »** — la commande répondait `% Invalid
   input detected`. Même cause : elle est en EXEC privilégié. Elle
   existait, et ses vrais défauts (§1.3) sont bien plus intéressants que
   son absence.

La règle qui en sort, et qui vaut au-delà de ce lot : **une sonde qui
n'établit pas son propre laboratoire avec un témoin ne distingue pas un
défaut du produit d'un défaut de la sonde.**

## 1. Mesure de l'existant

### 1.1 La réserve de lignes est réelle, et rien n'est à réécrire

`SshSessionRegistry` porte déjà :

- `LineKind = 'con' | 'vty' | 'aux'` ;
- `LIGNES_PHYSIQUES = { con: 1, aux: 1, vty: null }` — une console, une
  AUX, et un nombre de vty pris de la configuration ;
- `capacity: () => this.vtyLineConfig.lineCapacity()`, donc `line vty 0 4`
  borne vraiment ;
- `allocateLine`, `hasFreeLine`, `open`, `close`, `formatShowUsers`,
  `formatDisplayUsers`, `noteLineUse`/`usesFor`, `subscribeMessages`.

### 1.2 L'identité de ligne était inventée

`CliShellSession` fabriquait son `lineId` depuis un compteur **de module** :

```ts
this.id = `vty-${nextSessionSeq++}`;
this.lineId = `vty ${nextSessionSeq - 1}`;
```

Trois conséquences : une session console se déclarait vty ; deux
équipements distincts se partageaient la numérotation ; et le jeton
`$(line)` d'une bannière, lu par `CiscoTerminalSession.numeroDeLigne()`
via une expression régulière sur ce texte, nommait une ligne qui
n'existait pas.

### 1.3 `clear line` coupait la mauvaise ligne — mesuré

Laboratoire : une console et trois vty ouvertes, `show users` en témoin.

```
    Line       User       Host(s)              Idle       Location
   0 con 0     operateur  idle                 00:00:00
   2 vty 0     u0         idle                 00:00:00 10.0.0.9
   3 vty 1     u1         idle                 00:00:00 10.0.0.9
 * 4 vty 2     u2         idle                 00:00:00 10.0.0.9

clear line 2      => [confirm] [OK]   ... et c'est vty 2 (u2) qui tombe
clear line vty 0  => [confirm] [OK]   ... et con 0 tombe AVEC vty 0
clear line 0      => % Not allowed to clear that line
clear line con 0  => % Not allowed to clear that line
```

Trois défauts, tous vérifiables sur ces quatre lignes :

1. **Le numéro accepté n'est pas le numéro affiché.** `show users` nomme
   `2` la ligne `vty 0` ; la commande, elle, lisait `2` comme l'indice
   RELATIF de la vty. `clear line 2` coupait donc `vty 2` — un autre
   opérateur que celui visé. C'est le pire défaut possible pour cette
   commande : elle ne se trompe pas bruyamment, elle coupe quelqu'un
   d'autre.
2. **Le genre de ligne n'était pas filtré.** `closeWhere(s => s.lineIndex
   === index)` ferme TOUTE session dont l'indice correspond, quel que soit
   son genre. `clear line vty 0` coupait donc `con 0` aussi — l'opérateur
   à la console, par une commande visant une ligne réseau. Ce défaut était
   invisible tant que la console n'avait pas d'enregistrement ; le rendre
   réel (§3.2) l'a rendu observable.
3. **Le refus portait sur la console, pas sur la ligne courante.** IOS
   refuse `% Not allowed to clear current line` — on ne coupe pas la
   branche sur laquelle on est assis. La règle codée refusait la CONSOLE,
   depuis n'importe où : couper la console depuis une vty (le geste normal
   quand quelqu'un a laissé une session ouverte devant la baie) était
   impossible, et couper sa propre vty était permis.

### 1.4 « La ligne courante » n'était écrite par personne

`setCurrentSession(id)` existe et **n'a aucun appelant de production**.
`courante` n'est donc jamais que « la dernière session ouverte » : le `*`
de `show users` marque le dernier arrivé et non celui qui tape, ce que la
mesure ci-dessus montre (`* 4 vty 2`, alors que la commande est lancée par
personne). Le refus de `clear line` héritait de cette erreur.

### 1.5 Côté VRP, `display user-interface` était une constante

```ts
const lines = [
  '  Idx    Type            Tx/Rx    Modem  Privi  ActualPrivi  Auth   Int',
  '+ 0      CON 0           9600     -      0      0            N      -',
  '  34     VTY 0           -        -      0      0            N      -',
  ... jusqu'à VTY 4
];
```

Quatre faits faux dans six lignes : le nombre de vty ne suit pas
`user-interface vty 0 14` ; le `+` (interface courante) est posé sur CON 0
même quand personne n'y est ; `Privi` est 0 pour la console alors que le
défaut VRP y est 15 ; et l'indice absolu des vty est **34**, alors que
`display users` — la vue voisine, sur la même machine, au même instant —
les numérote à partir de **129**. Deux numérotations pour un seul fait.

`display users` avait le défaut symétrique : registre vide, elle
fabriquait une ligne `CON 0` marquée courante et authentifiée.

### 1.6 Ce qui était juste, et qu'on garde

- Un châssis n'a qu'un port console ; un hôte Linux/Windows n'a pas cette
  contrainte (plusieurs consoles virtuelles, chacune avec son `cwd`, son
  environnement, son pts).
- La numérotation absolue CTY 0 / AUX 1 / VTY 2… de `show line` est
  conforme : les numéros absolus d'IOS suivent l'ordre CTY, TTY, AUX, VTY,
  et un châssis sans carte asynchrone n'a pas de TTY.
- La réserve vty est bornée par la configuration (§0.3).

## 2. Références normatives

Chaque fait ci-dessous a été vérifié avant d'être écrit, et aucun ne vient
de mémoire.

| Fait | Source |
|---|---|
| Numérotation absolue CTY, TTY, AUX, VTY | documentation IOS `line` / `show line` |
| `line vty 0 4` = 5 sessions simultanées, extensible à 0-15 | référence de commande IOS |
| Réserve pleine ⇒ connexion refusée | idem |
| `clear line <n>` demande `[confirm]` puis répond ` [OK]` | transcriptions Cisco Community |
| On ne peut pas couper sa propre ligne : `% Not allowed to clear current line` | idem |
| VRP : `free user-interface` ⇒ `Warning: User interface VTY3 will be freed. Do you want to continue? [Y/N]:` puis `Info: User interface VTY3 is free.` | référence de commande Huawei ; `kill user-interface` est le synonyme |
| VRP : la commande ne s'applique pas à l'interface courante, et le dit | idem |
| VRP : indice absolu des VTY = 129 + rang sur AR/S | référence `display user-interface` |
| VRP : marqueurs `+` (active) et `F` (active, mode asynchrone) | idem |
| VRP : colonne `Auth` = `A` (AAA), `N` (aucune), `P` (mot de passe de l'UI) | idem |
| VRP : niveau par défaut — console 15, vty 0 | guide de configuration Huawei |

## 3. La règle

> **Ouvrir un terminal sur un équipement réseau, c'est occuper une ligne.
> Il n'y a pas d'autre façon d'y être connecté.**

| Situation | Ligne | Comportement |
|---|---|---|
| Première fenêtre sur un routeur | `con 0` | ouverte, enregistrée, visible dans `show users`, comptée par `Uses` |
| Seconde fenêtre sur le même routeur | — | **rend la session console existante** : on ne branche pas deux câbles |
| Fenêtre ouverte explicitement sur une vty (SSH, telnet, test) | `vty N` | prise dans `line vty 0 …`, refusée quand la réserve est pleine |
| Fermeture d'une fenêtre | — | la ligne est **libérée** et redevient attribuable |
| `clear line` / `free user-interface` sur cette ligne | — | la session est coupée **et la fenêtre le sait** |
| Terminal sur un hôte Linux/Windows | — | pas de réserve : plusieurs terminaux, comme aujourd'hui |

Corollaire, et c'est lui qui répond à la demande d'origine : **l'interface
graphique ne fabrique pas de vty**. Ouvrir une vty est une connexion
RÉSEAU — une adresse, un protocole, une authentification — et le fait
qu'une fenêtre soit déjà ouverte n'en est pas une.

## 4. Ce qui change

### 4.1 `TerminalManager` ne devine plus

`openTerminal(device)` sans ligne demandée branche la console. Sur un
équipement dont la console est unique, il rend la session existante. Le
paramètre `LigneTerminal` demeure pour les appelants qui savent ce qu'ils
demandent, et n'est plus jamais deviné.

### 4.2 La session de terminal ouvre une VRAIE ligne

`CLITerminalSession.occupyLine()` — donc les deux constructeurs, Cisco et
Huawei, sans copie — appelle `registry.open()` à l'initialisation, garde
l'enregistrement, et le ferme dans son `registerTearDown`. C'est ce qui
fait apparaître la console dans `show users`, incrémenter `Uses` dans
`show line`, et disparaître les deux à la fermeture.

`noteLineUse('con', …)`, que `CiscoTerminalSession` appelait à la main
« puisque la console n'a pas d'enregistrement », est retiré : elle en a un,
et le compter deux fois était le défaut suivant.

### 4.3 L'identité de ligne vient de l'enregistrement

`CliShellSession` porte `lineKind`, `lineIndex` et `lineRecordId`, posés
par `assignLine()` depuis le record. `lineId` est calculé (`con 0`,
`vty 3`) et n'est plus stocké. Une session sans enregistrement — une
`CliShellSession` nue dans un test — garde un identifiant technique
(`cli-7`) qui ne prétend plus être une ligne.

### 4.4 La ligne courante est celle qui tape

`Router.executeCommandInVty` et `Switch.executeCommandInVty` déclarent la
ligne de la session au registre avant d'exécuter. La règle devient unique
et vérifiable : **la ligne courante est celle qui a agi le plus récemment**
— en s'ouvrant, ou en tapant. Une exécution programmatique (`executeCommand`
hors session) n'est sur aucune ligne et n'en marque aucune.

### 4.5 `clear line` coupe la ligne que `show users` désigne

`shells/cisco/CiscoLineCommands.ts` (module propre, partagé routeur et
commutateur) :

- `clear line <n>` prend le numéro **absolu**, celui de la colonne `Line`
  de `show users` et de la colonne `Tty` de `show line` ;
- `clear line {console|con|aux|vty} <n>` prend le rang **dans ce genre**,
  et ne peut plus atteindre un autre genre ;
- la ligne **courante** est refusée, avec les mots d'IOS
  (`% Not allowed to clear current line`) — et elle seule ;
- une ligne libre répond `[confirm]` et ne coupe rien ;
- une ligne occupée répond `[confirm]\n [OK]` et la coupe.

### 4.6 Une ligne coupée coupe la fenêtre

`SshSessionRegistry.subscribeClose(id, cb)` prévient le détenteur.
`CLITerminalSession` s'y abonne pour son propre enregistrement : la
fenêtre passe en lecture seule avec un avis, et la ligne est libre. Sans
cela `clear line` aurait vidé une vue en laissant l'opérateur taper dans
une session que la machine ne connaît plus.

### 4.7 VRP décrit ses user-interfaces depuis la réserve

`shells/huawei/HuaweiUserInterfaceCommands.ts` :

- `display user-interface` rend une ligne par user-interface réellement
  déclarée — le nombre de vty vient de `lineCapacity()` ;
- `+` marque la session courante lue dans le registre ;
- `Privi` vient du bloc de configuration de la ligne, défaut console 15 /
  vty 0 ; `ActualPrivi` vaut le niveau de la session **quand elle est
  authentifiée**, et le niveau configuré sinon — avant authentification,
  le niveau effectif d'une interface est celui qu'elle déclare ;
- `Auth` vaut `A`/`N`/`P` selon `authentication-mode` ;
- **une seule numérotation** : `vrpUserInterfaceIndex()` est lue par
  `display user-interface` ET `display users` ;
- `free user-interface` et son synonyme `kill user-interface` libèrent
  pour de bon, refusent l'interface courante, et acceptent l'indice absolu
  comme la forme `vty <n>`.

### 4.8 Les vues n'ont plus de repli

`showUsers()` et `formatDisplayUsers()` ne fabriquent plus de session
console quand le registre est muet. Un registre muet veut dire « personne
n'est connecté », et c'est ce qu'il faut afficher — sans quoi un opérateur
connecté et une machine que personne ne touche rendent le même texte,
c'est-à-dire que la vue n'apprend rien.

### 4.9 Trouvé en chemin, hors périmètre initial, corrigé

**`clock rate 64000` était accepté par un commutateur.** En mode
`config-if`, une commande qui échoue est rejouée contre l'arbre GLOBAL
(`tryGlobalConfigNavigation`, un mécanisme légitime : l'import d'une
topologie place les blocs `interface` avant des commandes globales). Or
l'arbre global portait un fourre-tout `clock` qui rangeait n'importe quel
`clock …` en « ligne non traitée » — donc `clock rate`, qui est une
commande d'interface SÉRIE, était acceptée sur un port Ethernet de
Catalyst, **rendue dans la running-config, et rejouée à l'import**. Seul
`calendar-valid` est désormais accepté derrière `clock` ; le reste est
refusé avec le curseur d'IOS. `tryGlobalConfigNavigation` rend maintenant
le diagnostic au lieu de laisser l'exception traverser la pile.

## 5. Limites assumées

- **La ligne AUX n'est atteignable par personne.** La réserve la connaît
  (`LIGNES_PHYSIQUES.aux = 1`), `show line` l'affiche, `clear line aux 0`
  la vise — et rien ne l'ouvre, faute de chemin réel. On ne l'invente pas.
- **Les lignes TTY asynchrones n'existent pas**, et la numérotation
  absolue le reflète (CTY 0, AUX 1, VTY 2…). C'est la disposition d'un
  châssis sans carte asynchrone, pas une simplification.
- **Une fenêtre minimisée occupe toujours sa ligne.** C'est juste : un
  câble console branché occupe le port même si personne ne regarde
  l'écran.
- **Une session SSH/telnet entrante n'informe pas la `CliShellSession` du
  terminal enfant de son rang de ligne.** Le serveur ouvre bien son
  enregistrement (donc `show users` est juste), mais la session
  interactive rendue au client est construite par un autre chemin
  (`createVtyShell`) ; son `lineId` reste technique. Conséquence
  observable et unique : le jeton `$(line)` d'une bannière rend `0` pour
  ces sessions. Avant ce lot il rendait un numéro tiré d'un compteur
  global, c'est-à-dire faux plutôt qu'absent.
- **`clear line` ne demande pas confirmation de façon interactive dans le
  terminal graphique.** Le texte `[confirm]` est rendu comme le fait déjà
  `reload` en exécution non interactive ; le plan de dialogue n'est pas
  écrit pour cette commande.
- **`display user-interface` ne rend jamais le marqueur `F`** (interface
  active en mode asynchrone) : rien dans ce simulateur ne fonctionne en
  mode asynchrone, donc le marqueur serait une décoration.

## 6. Vérification

`src/__tests__/unit/terminal/lignes-une-connexion-une-ligne.test.ts`,
17 cas, discriminé par restauration des onze fichiers de production :
**16 tombent avant correctif**, le dix-septième étant le cas de
non-régression (un hôte Linux garde ses terminaux multiples).

1. une fenêtre prend `con 0` et le registre la connaît ;
2. `show users` montre la session — et une machine sans session ne montre
   personne ;
3. `show line` compte l'utilisation de la CTY ;
4. la session console ne se déclare plus vty ;
5. une seconde fenêtre rend la première ;
6. fermer la fenêtre libère la ligne, une nouvelle reprend `con 0` ;
7. un hôte Linux garde plusieurs terminaux ;
8. `line vty 0 1` laisse deux vty et refuse la troisième ;
9. `clear line 2` coupe `vty 0` — la ligne que la colonne `Line` nomme 2 ;
10. `clear line vty 0` ne touche pas la console ;
11. la console se coupe depuis une autre ligne ;
12. on ne coupe pas la ligne sur laquelle on est ;
13. `clear line` d'une ligne libre ne coupe rien ;
14. la fenêtre dont la ligne est coupée est déconnectée ;
15. `display user-interface` suit la capacité configurée, avec une seule
    numérotation ;
16. le marqueur de ligne courante vient du registre ;
17. `free user-interface` libère et refuse la ligne courante.

Deux de ces seize ne prouvent pas ce que leur nom annonce, et l'en-tête du
fichier le dit : les cas 8 et 13 décrivent un comportement qui était déjà
juste et ne tombent que parce qu'ils lisent la réserve par l'accesseur que
ce lot ajoute (§0.3).

### 6.1 Suites existantes corrigées, et pourquoi

Vingt et un cas de `src/__tests__/unit/terminal/` encodaient la prémisse
« deux fenêtres sur une machine = deux vty ». Ils protègent une propriété
RÉELLE — l'isolation par ligne — et n'ont donc pas été affaiblis : leur
laboratoire ouvre désormais la console PUIS une vty, ce qu'est réellement
une seconde connexion. Six autres, dans `network-v2/`, pinçaient les
constantes de repli (`show users` sans session) ou l'ancienne règle de
`clear line` ; ils décrivent maintenant la règle mesurée.

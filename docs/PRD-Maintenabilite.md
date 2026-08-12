# PRD — Maintenabilité : ce qui coûte cher, mesuré

## 0. Portée et méthode

Ce document ne parle pas de fidélité au matériel — c'est le sujet des 83
autres PRD de ce dépôt. Il parle du **coût de la prochaine modification** :
combien de temps il faut pour trouver où changer une chose, combien
d'endroits il faut changer pour n'en changer qu'une, et combien de temps
la machine met à dire si c'est juste.

**Aucun chiffre ci-dessous n'est estimé.** Chacun est le résultat d'une
commande exécutée sur l'arbre courant, et la commande est donnée. Là où un
défaut est cité, il l'est avec un exemple survenu **dans ce dépôt**, pas
une hypothèse.

### 0.1 Le dépôt en chiffres

| Mesure | Valeur |
|---|---|
| Lignes de production (`src/**` hors tests) | **463 830** |
| Fichiers de production | **2 218** |
| Lignes de test | **437 495** |
| Fichiers de test | **1 916** |
| Fichiers de production de plus de 1 500 lignes | **47** |
| Lignes de commentaire dans la production | **53 479** (11,5 %) |
| `as unknown as` en production | **952**, dans **190** fichiers |
| `as any` en production | **313** |
| Documents dans `docs/` | **116** (dont 83 PRD), **91 682** lignes |
| `TODO`/`FIXME`/`HACK` en production | **11** |

Le rapport test/production est de 0,94 : c'est un dépôt qui se teste
sérieusement. Le problème n'est pas l'absence de discipline — c'est que la
discipline s'exerce sur une structure qui la rend chère.

## 1. Les sept coûts, par ordre de ce qu'ils coûtent

### 1.1 La boucle de retour est de 26 secondes, quoi qu'on fasse

Mesure directe, sur le plus petit fichier de test de la maison (3 cas) :

```
npx vitest run src/__tests__/unit/terminal/cli-boot-once.test.ts
      Tests  3 passed (3)
   Duration  25.74s (transform 20.49s, setup 22.59s, import 1.10s, tests 1.78s)
```

**1,78 s de test, 25,74 s d'attente.** Les 24 secondes restantes sont la
transformation des modules et l'exécution du fichier de mise en place.
Elles sont payées à CHAQUE lancement, pour un fichier comme pour cent.

Conséquence directe et observable dans ce dépôt : la régression localisée
que la consigne de travail exige (« les tests de régression doivent être
localisés ») coûte déjà 26 secondes pour un fichier, 96 secondes pour le
répertoire `unit/terminal/` (517 cas), et **plusieurs dizaines de minutes**
pour `unit/network-v2/`. Le développeur qui hésite à relancer paie ce
temps en défauts non vus.

Cause mesurable : `setupGlobalState.ts` importe dix modules qui tirent
transitivement `DeviceFactory` — donc **toutes** les classes d'équipement,
donc tous les shells, donc tous les moteurs de protocole — avant le
premier `it()`. Le fichier est correct et utile (il existe pour une
raison écrite dans son en-tête) ; c'est son coût qui n'est pas payé au
bon endroit.

### 1.2 Sept classes portent le tiers du système

| Fichier | Lignes | Méthodes | Imports |
|---|---:|---:|---:|
| `linux/LinuxCommandExecutor.ts` | 7 554 | 224 | 124 |
| `devices/Router.ts` | 5 525 | **381** | 108 |
| `shells/CiscoShellBase.ts` | 5 440 | 137 | 43 |
| `shells/CiscoSwitchShell.ts` | 5 423 | 133 | — |
| `devices/WindowsPC.ts` | 5 255 | 296 | 143 |
| `devices/EndHost.ts` | 4 762 | 186 | — |
| `database/oracle/OracleExecutor.ts` | 4 595 | 155 | — |

`Router.ts` porte **381 méthodes et 162 champs privés**. Ce n'est pas un
routeur : c'est un routeur, plus son AAA, plus son NAT, plus son serveur
HTTP, plus ses sessions vty, plus son archivage, plus sa file d'exécution
CLI. `LinuxCommandExecutor.ts` porte un `switch` de **275 `case`**.

Le coût n'est pas esthétique, il est arithmétique : toute modification
dans l'un de ces fichiers oblige à relire un contexte de plusieurs
milliers de lignes pour être sûr de ne pas casser un voisin, et deux
agents qui travaillent en parallèle sur le même dépôt entrent en conflit
sur ces sept fichiers avant tous les autres.

### 1.3 Le typage est contourné 1 265 fois

**952 `as unknown as` + 313 `as any`** en production. Répartition des dix
plus atteints :

```
103  shells/CiscoShellBase.ts
 59  powershell/runtime/PSRuntime.ts
 43  powershell/providers/WindowsPSProviders.ts
 42  devices/inspection/config/LoggingConfig.ts
 31  shells/cisco/CiscoShowCommands.ts
 29  shells/huawei/HuaweiDisplayCommands.ts
 28  terminal/sessions/LinuxTerminalSession.ts
 27  devices/Router.ts
 25  database/oracle/OracleExecutor.ts
 24  devices/router/diag/RouterDebugService.ts
```

Le motif est presque toujours le même, et il a un nom dans ce dépôt :
atteindre une méthode d'un équipement concret depuis du code typé contre
une interface plus étroite.

```ts
const dev = this.d() as unknown as {
  getSshSessionRegistry?: () => { closeWhere: (p: (s: { lineIndex: number }) => boolean) => number };
};
```

`RouterServiceCapabilities.ts` existe précisément pour supprimer ce motif
et a été créé pour cela (audit 08). Il couvre aujourd'hui **13 services**.
Il en reste 452 occurrences de la forme `?: () =>` dans des types déclarés
en ligne.

**Ce n'est pas théorique, cela a coûté un défaut cette semaine.** Le
`clear line` cité ci-dessus déclarait sa propre vue du registre, réduite à
`{ lineIndex: number }`. Comme le genre de ligne n'était pas dans le type,
le compilateur ne pouvait pas signaler qu'il manquait au filtre — et la
commande coupait la console en visant une vty (`docs/PRD-Lignes-Terminal.md`
§1.3). Un accesseur typé rend cette faute visible à la compilation.

### 1.4 Un même fait est rendu par plusieurs vues qui divergent

C'est le défaut le plus fréquent de ce dépôt, et celui que ses PRD passent
le plus de temps à refermer. Trois exemples **trouvés cette semaine**, tous
sur un seul sujet (les lignes de terminal) :

| Fait | Vue A | Vue B | Divergence |
|---|---|---|---|
| Indice absolu d'une VTY sur VRP | `display users` → 129 | `display user-interface` → 34 | deux numérotations |
| Session sur `con 0` | `show users` (constante de repli) | registre (vide) | la vue affirme ce que l'état nie |
| Nombre de vty | `lineCapacity()` | table figée à 5 | la configuration n'a pas d'effet |

Et trois autres, déjà documentés dans `CLAUDE.md` par les PRD précédents :
deux registres Windows pour une machine, deux rendus de `flash:`, deux
analyseurs de `service timestamps`. À chaque fois la correction consiste à
supprimer la seconde vue et à faire lire la première.

**Il n'existe aujourd'hui aucun garde-fou** qui empêche d'écrire la
troisième. Le dépôt compte **158 fonctions de rendu** sous
`devices/shells/`.

### 1.5 Les tests sont couplés aux classes concrètes

**466 fichiers de test appellent `new CiscoRouter(...)`. 4 passent par
`DeviceFactory.createDevice()`.**

Conséquence : une modification de la signature d'un constructeur
d'équipement se paie en centaines de fichiers ; et surtout, un test qui
construit son laboratoire à la main construit aussi ses PRÉMISSES à la
main. Deux exemples de cette semaine, tous deux dans mes propres sondes :

- une sonde a conclu que `line vty 0 1` ne bornait pas la réserve — elle
  avait omis `enable`, donc sa configuration n'était jamais entrée ;
- une autre a conclu que `clear line` n'existait pas — même cause.

Les deux auraient fait « corriger » du code juste. Un constructeur de
laboratoire partagé (`unRouteurCisco().enPrivilegie().avec('line vty 0 1')`)
supprime cette classe entière d'erreurs, et il n'existe pas : chaque
fichier réécrit son `beforeEach`.

### 1.6 La documentation a dépassé la taille de ce qu'elle documente

**116 documents, 91 682 lignes** — dont un journal de coordination de
5 612 lignes, un document de refonte de 4 761 lignes, et un `DESIGN-EIGRP.md`
de 4 039 lignes que `CLAUDE.md` déclare lui-même **périmé et jamais
implémenté**. `docs/roadmap.md` porte déjà une bannière de péremption.

Le coût est double : un lecteur ne sait pas lequel fait foi, et un agent
qui lit un document périmé implémente une conception abandonnée.

### 1.7 Le code mélange deux langues, et les commentaires portent la
conception

`CLAUDE.md` fixe désormais la règle — **anglais partout, aucun
commentaire** — mais l'existant ne la suit pas : `ligne` apparaît dans
863 lignes de production, `fichier` dans 302, `niveau` dans 159,
`registre` dans 65. Et **53 479 lignes de commentaire** portent aujourd'hui
l'essentiel de la justification des choix (« pourquoi 129 et pas 34 »,
« pourquoi cette valeur est mesurée et non supposée »).

Le conflit est réel et doit être tranché explicitement : la règle « aucun
commentaire » suppose que le savoir vit dans les noms et dans les tests.
Or ce savoir-là est essentiellement *historique* (« ceci a été mesuré
contre une capture réelle, ne le remplacez pas par la valeur qui semble
logique ») et un nom ne peut pas le porter.

## 2. Ce qu'il ne faut PAS faire

Trois « améliorations » évidentes seraient des régressions, et elles sont
écrites ici pour ne pas être proposées une quatrième fois :

1. **Découper les sept gros fichiers d'un coup.** Deux agents travaillent
   en parallèle sur cette branche ; un déplacement massif rend tout
   conflit irrésolvable et perd l'historique par ligne, qui est la seule
   trace de *pourquoi* une valeur vaut 129.
2. **Supprimer les commentaires existants en masse.** `CLAUDE.md` dit déjà
   « les commentaires existants restent ». Ils portent des mesures.
3. **Restreindre l'abonnement du canevas au store** pour réduire les
   rendus. `CLAUDE.md` explique déjà pourquoi c'est une régression
   silencieuse (item #52 contre item #56).

## 3. Les six chantiers, par rapport coût/bénéfice

### C1 — Diviser la boucle de retour (bénéfice : immédiat, tous les jours)

**Ce qui coûte :** 24 s de démarrage par lancement (§1.1).

**Mesure d'abord :** lancer `vitest --reporter=verbose` avec
`VITEST_SETUP_TIMING` sur cinq fichiers de familles différentes et
attribuer les 22,6 s de mise en place aux modules qui les consomment. Sans
cette mesure, on optimisera le mauvais import.

**Piste :** `setupGlobalState.ts` n'a besoin que de **fonctions de remise à
zéro**, pas des classes. Exporter ces `reset*` depuis un module feuille
(`src/testing/resets.ts`) qui n'importe aucun équipement casse la chaîne
`setup → DeviceFactory → tous les shells`.

**Critère de fin :** un fichier de trois cas passe sous 8 secondes.

### C2 — Un accesseur typé par service, plus aucun cast en ligne (bénéfice : élevé)

**Ce qui coûte :** 1 265 contournements du typage (§1.3).

**Piste :** étendre `RouterServiceCapabilities.ts` — le mécanisme existe,
il est bon, il est simplement incomplet. Le faire **par vague, service par
service**, en commençant par les cinq les plus cités
(`getSshSessionRegistry`, `_getVtyLineConfig`, `getLoggingConfig`,
`_getNATEngine`, `getShell`). Ce lot en a fait deux ; il en reste.

**Garde-fou :** une règle ESLint interdisant `as unknown as {` suivi de
`get`, activée en avertissement d'abord, sur les répertoires déjà nettoyés
ensuite. Sans garde-fou, la 953ᵉ occurrence sera écrite le lendemain.

**Critère de fin :** `CiscoShellBase.ts` passe sous 20 casts.

### C3 — Un fait, une fonction de rendu (bénéfice : élevé, c'est le défaut
récurrent du dépôt)

**Ce qui coûte :** §1.4 — chaque divergence est un bogue qui se découvre
en production et se corrige en supprimant une vue.

**Piste :** pour chaque famille de vues qui décrit un même état (lignes,
interfaces, VLAN, routes, sessions), un module de PROJECTION qui calcule
les valeurs, et des rendus qui ne font que mettre en forme. Ce lot l'a
fait pour les lignes (`absoluteLineNumber`, `vrpUserInterfaceIndex`,
`userInterfaceRows`) ; le patron est reproductible.

**Garde-fou, et c'est lui le livrable :** un test par famille qui affirme
que **deux vues du même fait s'accordent** — le test le moins cher à
écrire et celui qui attrape la classe entière. `nss-chain-is-one-implementation.test.ts`
existe déjà et fait exactement cela pour NSS ; il est le modèle.

### C4 — Un constructeur de laboratoire partagé (bénéfice : moyen, mais il
supprime une classe d'erreurs de raisonnement)

**Ce qui coûte :** §1.5 — 466 laboratoires écrits à la main, dont les
prémisses ne sont vérifiées par personne.

**Piste :** `src/testing/labo.ts` exposant `unRouteurCisco()`,
`unCommutateurHuawei()`, `unPosteLinux()`, chacun rendant une machine
allumée, en mode privilégié, avec un bus propre — et un `.avec(...)` qui
**vérifie que chaque commande a été acceptée** et échoue immédiatement
sinon. C'est ce dernier point qui aurait fait tomber les deux sondes
fausses de §1.5 au lieu de les laisser conclure.

**Adoption :** par les NOUVEAUX tests seulement. Ne pas réécrire les 466.

### C5 — Émonder la documentation (bénéfice : moyen, coût : faible)

Marquer périmés — sans les supprimer — les documents que `CLAUDE.md`
désigne déjà comme tels (`DESIGN-EIGRP.md`, `roadmap.md` au-delà de sa
bannière), et donner à `docs/` un index qui dise lequel fait foi par
sujet. Un document périmé qui le dit ne coûte rien ; un document périmé
qui se tait coûte une implémentation.

### C6 — Trancher la question des commentaires (bénéfice : conditionnel)

La règle actuelle (aucun commentaire) et le contenu actuel (53 479 lignes
qui portent les mesures) ne peuvent pas coexister sans arbitrage. Deux
issues cohérentes, à choisir explicitement :

- **soit** le savoir historique migre vers les en-têtes des tests de
  garde — ce que ce dépôt fait déjà très bien, et les commentaires de
  production disparaissent progressivement, par fichier touché ;
- **soit** la règle admet une exception nommée : un en-tête de module a le
  droit de dire *contre quoi* une valeur a été mesurée.

Ce PRD ne tranche pas — c'est une décision de projet. Il note seulement
que ne pas trancher garantit que les deux moitiés du dépôt continueront de
diverger.

## 4. Ordre proposé

C1 d'abord — il rend tous les autres moins chers à valider. Puis C3 et son
garde-fou (le défaut le plus fréquent). Puis C2 par vagues, C4 sur les
nouveaux tests, C5 en une passe, C6 par décision.

## 5. Ce que ce document n'a pas mesuré, et qu'il faudrait

Écrit ici pour que la prochaine passe ne reparte pas de zéro, et pour ne
pas laisser croire que l'audit est complet :

- **les cycles d'import** (aucun outil n'a été passé) ;
- **la couverture réelle** — elle n'est configurée avec seuil que sur
  `protocols/ssh/**` et les suites Oracle ; on ne sait pas ce qui n'est
  pas testé ailleurs ;
- **la durée totale de la suite complète**, jamais mesurée de bout en
  bout ;
- **les 93 suites de `__tests__/debug/`** (20 469 lignes), qui n'affirment
  rien et coûtent du temps d'exécution : à quantifier avant de décider si
  elles restent dans le lancement par défaut.

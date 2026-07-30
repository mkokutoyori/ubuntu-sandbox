# PRD — wevtutil : un utilitaire qui annonce douze commandes et en tient quatre

> **État : livré.** Les quatre phases sont implémentées. Le §1 décrit
> l'état *avant* travaux — il est conservé tel quel, parce qu'un PRD qui
> réécrit son propre constat de départ perd ce qui le rendait utile.
> Le §11 recense ce que la mise en œuvre a appris.

---

## 0. Contexte et portée du document

`wevtutil.exe` est l'interface en ligne de commande du journal
d'événements Windows. C'est l'outil qu'on trouve dans un script
d'inventaire, dans une procédure de collecte, et dans à peu près tous
les guides d'investigation — parce qu'il est le seul à parler aux
journaux sans passer par PowerShell, donc le seul disponible depuis
`cmd.exe`, une session de récupération ou une tâche planifiée héritée.

Ce simulateur en a une implémentation de 148 lignes qui **affiche un
texte d'aide énumérant douze commandes et en implémente quatre**. Les
huit autres retombent silencieusement sur ce même texte d'aide : la
commande ne dit pas qu'elle n'existe pas, elle répond par sa propre
documentation. Un script qui appelle `wevtutil gli System` reçoit donc
une page d'aide au lieu d'un refus, et ne peut pas distinguer « je me
suis trompé de syntaxe » de « cette commande n'est pas là ».

C'est la forme la plus tenace du problème que ce dépôt traque : une
surface annoncée plus large que la surface réelle, et un silence là où
il faudrait un refus.

Ce document couvre `wevtutil` seul. Le moteur de journaux
(`PSEventLogProvider`), lui, vient d'être sérieusement rattrapé — horloge
unique, EventData structurée, export réel — et c'est précisément ce qui
rend ce chantier praticable aujourd'hui : il y a enfin quelque chose de
vrai à interroger.

---

## 1. Analyse de l'existant

### 1.1 Inventaire

`src/network/devices/windows/WinWevtutil.ts` — 148 lignes, une fonction
`cmdWevtutil(ctx, args)`, un texte d'aide constant, et un helper
`queryDHCPEvents`.

| Commande annoncée par l'aide | État mesuré |
|---|---|
| `el` / `enum-logs` | **Implémentée**, mais rend une liste de cinq noms codés en dur |
| `qe` / `query-events` | **Implémentée**, partiellement — voir §1.3 |
| `cl` / `clear-log` | **Implémentée**, vide réellement le journal |
| `epl` / `export-log` | **Implémentée**, écrit réellement le fichier |
| `gl` / `get-log` | Absente — retombe sur l'aide |
| `sl` / `set-log` | Absente — retombe sur l'aide |
| `ep` / `enum-publishers` | Absente — retombe sur l'aide |
| `gp` / `get-publisher` | Absente — retombe sur l'aide |
| `im` / `install-manifest` | Absente — retombe sur l'aide |
| `um` / `uninstall-manifest` | Absente — retombe sur l'aide |
| `gli` / `get-log-info` | Absente — retombe sur l'aide |
| `al` / `archive-log` | Absente — retombe sur l'aide |

Options communes (`/r:` distant, `/u:`, `/p:`, `/a:`, `/uni:`) :
**aucune n'est analysée**, y compris `/r:` que le texte d'aide décrit
explicitement.

### 1.2 Ce qui existe déjà et est réutilisable

Le moteur est en bien meilleur état que son interface, et c'est ce qui
rend l'essentiel du travail mécanique plutôt qu'architectural.

| Brique | Ce qu'elle offre |
|---|---|
| `PSEventLogProvider.getAllLogsStructured()` | Le vrai registre des journaux, avec `logName`, nombre d'entrées, `maxSizeKB`. `el` et `gli` n'ont qu'à le lire |
| `EventLogMetadata` | `maxSizeKB` et `overflow` (`OverwriteOlder` / `DoNotOverwrite` / `OverwriteAsNeeded`) — exactement les champs que `gl` affiche et que `sl` modifie |
| `EventLogEntry.data` | L'EventData structurée, désormais remplie par les émetteurs. C'est la matière que `/f:xml` doit rendre |
| `exportLog()` | Déjà écrit pour `epl` : rend `null` en cas de succès, le refus réel sinon |
| `clearEventLog()` | Déjà écrit pour `cl` |
| `attachClock()` | Le journal partage l'horloge simulée de l'hôte — les horodatages de `qe` sont donc cohérents avec `Get-Date` |
| `requireWindowsService(ctx, 'EventLog')` | La porte de service, déjà posée en tête de `cmdWevtutil` et fidèle |
| `buildEventXml()` (EventLogCmdlets) | Le rendu XML d'une entrée, déjà utilisé par `Get-WinEvent`. À partager plutôt qu'à réécrire |

### 1.3 Ce qui manque ou court-circuite (analyse d'écart)

**E1 — Huit commandes annoncées et absentes.** Le défaut central. Une
commande inconnue doit produire le refus de `wevtutil`, pas sa
documentation.

**E2 — `el` ment par omission.** Il rend cinq noms écrits dans le code
alors que le fournisseur en connaît six depuis l'ajout du canal
`Microsoft-Windows-PowerShell/Operational`. Deux commandes du même
système se contredisent déjà : `Get-WinEvent -ListLog *` voit le canal,
`wevtutil el` non. Toute création future de journal creusera l'écart.

**E3 — `qe` est détourné par une correspondance de chaîne.** La toute
première condition du verbe teste si la ligne de commande *contient* le
mot « dhcp », et si oui bifurque vers un rendu spécial. Une requête
parfaitement légitime — `wevtutil qe Security /q:"*[EventData[Data='dhcp-relay']]"` —
n'atteint jamais le journal Security. Un cas particulier ne doit pas
s'appliquer par accident de vocabulaire.

**E4 — `qe` ignore ses options.** `/q:` (XPath), `/f:` (Text / XML /
RenderedXml), `/c:` (nombre), `/rd:` (ordre inverse), `/e:` (élément
racine) sont acceptés en silence et sans effet. Les suites existantes en
posent déjà — `dhcp_complete.test.ts` écrit
`/q:"*[System[Provider[@Name=\"Dhcp-Client\"]]]" /c:5 /rd:true /f:text` —
donc le simulateur reçoit aujourd'hui des requêtes précises et les
traite toutes de la même façon.

**E5 — Le format de sortie de `qe` est inventé.** `Event[0]:\n  Log Name: …`
ne ressemble à aucun des trois formats du vrai `wevtutil`. Un script qui
dépouille cette sortie à l'analyseur de texte ne fonctionnerait pas sur
un vrai Windows, et réciproquement.

**E6 — Les options communes ne sont pas analysées.** `/r:` en
particulier : le texte d'aide la documente, et la poser n'a aucun effet.

---

## 2. Modèle

### 2.1 Un analyseur d'arguments, une fois

`wevtutil` a une grammaire régulière : un verbe, des arguments
positionnels, puis des options `/nom:valeur` insensibles à la casse, en
forme courte ou longue. Aujourd'hui chaque branche refait son propre
découpage (`args.some(a => /^\/ow:true$/i.test(a))`, `args.slice(1).filter(…)`),
ce qui garantit que les verbes divergeront.

Une fonction unique `parseWevtutilArgs(args)` rend
`{ verb, positional, options: Map<string,string> }`, avec les alias
courts/longs résolus dans une seule table. Chaque verbe lit ensuite un
objet, pas un tableau de chaînes.

### 2.2 Le refus, et pourquoi il compte

Le vrai `wevtutil` répond à un verbe inconnu :

```
Failed to process command line. The specified command was not found.
```

et à une option inconnue :

```
Failed to process command line. Option "/xyz" is not recognized.
```

C'est ce que doit rendre une commande non implémentée — pas le texte
d'aide. La règle du dépôt s'applique telle quelle : **une surface qui ne
fait rien doit le dire.** Le texte d'aide, lui, sera réduit aux commandes
réellement tenues, avec les autres retirées de la liste plutôt que
promises.

### 2.3 XPath : le vrai sujet

`/q:` prend une requête XPath 1.0 restreinte à un sous-ensemble que
Windows documente. Les formes réellement utilisées dans la nature — et
dans les suites de ce dépôt — sont peu nombreuses :

```
*[System[EventID=4624]]
*[System[Provider[@Name='Dhcp-Client']]]
*[System[TimeCreated[timediff(@SystemTime) <= 86400000]]]
*[System[(Level=1 or Level=2)]]
*[EventData[Data[@Name='TargetUserName']='alice']]
```

Un évaluateur complet d'XPath serait hors sujet. Un analyseur du
sous-ensemble `*[System[…]]` / `*[EventData[…]]` avec `=`, `and`, `or`,
`!=` et `timediff` couvre ce qui s'écrit réellement, et **refuse
explicitement** le reste plutôt que de l'ignorer — un filtre qu'on ne
sait pas appliquer ne doit pas rendre tous les événements.

C'est aussi la brique qui débloque `Get-WinEvent -FilterXml`, aujourd'hui
déclaré absent dans `scenario-windows-eventlog-structure-filtering.test.ts` :
les deux commandes parleraient le même filtre, écrit une fois.

---

## 3. Phase 1 — Dire la vérité sur ce qui existe

La plus petite, et celle qui supprime l'affirmation fausse.

- `parseWevtutilArgs` extrait, les quatre verbes existants s'y branchent.
- Un verbe inconnu rend le refus réel de `wevtutil`, pas l'aide.
- Le texte d'aide n'énumère plus que les commandes tenues.
- `el` lit `getAllLogsStructured()` au lieu de sa liste codée en dur
  (E2), ce qui le remet d'accord avec `Get-WinEvent -ListLog`.
- Les options communes non gérées (`/r:`, `/u:`, `/p:`, `/a:`) sont
  **refusées** avec le message réel : mieux vaut un refus net qu'une
  option de connexion distante silencieusement sans effet.

Critère d'acceptation : aucune commande ne rend le texte d'aide sauf
`wevtutil` seul et `/?`. `wevtutil el` et `Get-WinEvent -ListLog *`
rendent le même ensemble de noms.

---

## 4. Phase 2 — `gli` et `gl` : lire l'état d'un journal

Deux commandes de lecture pure, entièrement servies par des données qui
existent déjà.

`gli <journal>` rend le statut :

```
creationTime: 2026-07-29T18:44:17.000Z
lastAccessTime: …
lastWriteTime: …
fileSize: 69632
attributes: 32
numberOfLogRecords: 41
oldestRecordNumber: 1000
```

`numberOfLogRecords` et `oldestRecordNumber` sont réels (nombre
d'entrées, plus petit `index`). `fileSize` se dérive du `.evtx`
matérialisé sous `winevt\Logs` — un fichier qui existe déjà, donc une
taille mesurée et non inventée.

`gl <journal>` rend la configuration :

```
name: Security
enabled: true
type: Admin
owningPublisher:
isolation: Custom
channelAccess: O:BAG:SYD:…
logging:
  logFileName: %SystemRoot%\System32\Winevt\Logs\Security.evtx
  retention: false
  autoBackup: false
  maxSize: 134217728
```

`maxSize` vient de `maxSizeKB`, `retention`/`autoBackup` de `overflow`.
`channelAccess` (un SDDL) n'a pas de source de vérité ici : plutôt que
d'inventer un descripteur, la ligne est **omise** — `wevtutil gl` réel
l'omet aussi sur les canaux qui n'en portent pas.

---

## 5. Phase 3 — `qe`, pour de vrai

Le cœur du travail.

- **Retirer le détournement par le mot « dhcp » (E3).** Le rendu
  spécifique aux événements DHCP reste accessible, mais parce que la
  requête le désigne — par son journal et son fournisseur — pas parce
  que la ligne de commande contient une sous-chaîne.
- **`/c:N`** limite réellement ; **`/rd:true`** rend du plus récent au
  plus ancien (le défaut de `wevtutil` est l'inverse, du plus ancien au
  plus récent — c'est un piège classique et il faut le respecter).
- **`/f:`** produit les trois formats réels : `Text` (le format en
  colonnes), `XML` (l'événement brut) et `RenderedXml` (avec le message
  rendu). `XML` réutilise `buildEventXml`, partagée avec `Get-WinEvent`.
- **`/q:`** applique le sous-ensemble XPath de §2.3, et refuse ce qu'il
  ne sait pas évaluer.
- **`/lf:true`** lit un fichier `.evtx` exporté au lieu d'un canal actif
   — ce qui referme la boucle avec `epl` : on exporte, puis on relit ce
  qu'on a exporté, et les deux disent la même chose.

---

## 6. Phase 4 — `sl`, `cl /bu:`, `al`

Les verbes qui écrivent.

- **`sl <journal> [/e:] [/ms:] [/r:] [/ab:]`** modifie réellement
  `enabled`, `maxSizeKB` et la politique de débordement. Un journal
  désactivé cesse d'accepter des entrées — sinon le réglage serait
  décoratif, ce que ce dépôt n'accepte pas.
- **`cl <journal> /bu:<fichier>`** sauvegarde avant de vider. C'est la
  seule variante de `cl` qui manque, et la seule qui rende l'effacement
  réversible.
- **`al <fichier>`** archive un `.evtx` exporté (ajout des ressources de
  localisation, en pratique une copie ici). À implémenter *ou à retirer
  de l'aide* — la décision se prend au moment de la phase, pas avant.

---

## 7. Hors périmètre, et pourquoi

- **`ep` / `gp` (éditeurs d'événements).** Il n'existe aucun registre
  d'éditeurs dans ce simulateur : les sources d'événements sont des
  chaînes libres posées à l'écriture. `ep` ne pourrait qu'énumérer les
  sources déjà vues, ce qui n'est pas ce que fait la commande. À faire
  seulement si un vrai registre d'éditeurs apparaît, et ces deux
  commandes sont donc **retirées de l'aide** en phase 1.
- **`im` / `um` (manifestes).** Installer un manifeste crée des canaux et
  des éditeurs à partir d'un fichier XML de schéma. Même raison, même
  décision.
- **`/r:` `/u:` `/p:` `/a:` (exécution distante).** WinRM existe ici, et
  `Invoke-Command` s'en sert réellement ; mais `wevtutil /r:` passe par
  RPC/DCOM, pas par WinRM, et rien ne modélise ce transport. Refusé
  explicitement plutôt que simulé par un raccourci.
- **Le format binaire `.evtx`.** Les fichiers exportés sont du texte
  lisible, pas le format binaire de Windows. Un `.evtx` de ce simulateur
  ne s'ouvre pas dans un vrai Observateur d'événements, et réciproquement.
  Le nommer ici évite de le laisser croire.
- **XPath complet.** Voir §2.3 : sous-ensemble documenté, refus explicite
  au-delà.

---

## 8. Risques

| Risque | Portée | Atténuation |
|---|---|---|
| Refuser les verbes absents casse une suite qui en appelait un | Phase 1 | Balayage préalable des appels `wevtutil` dans `src/__tests__/` — mesuré : 13 `qe`, 3 `epl`, 1 `el`, et **aucun** appel à un verbe non implémenté. Le refus ne peut donc casser aucune suite existante |
| La porte de service se perd dans le nouvel aiguillage | Phase 1 | `windows-feature-gates.test.ts` vérifie déjà que `wevtutil qe` refuse quand `EventLog` est arrêté ; le garde reste en tête de `cmdWevtutil`, avant l'analyse du verbe |
| Retirer le détournement « dhcp » casse `dhcp_complete.test.ts` | Phase 3 | Cette suite pose une vraie requête `/q:` sur le fournisseur `Dhcp-Client` : elle doit passer *par* XPath, ce qui la rend plus juste, pas plus fragile |
| `/rd:` par défaut inversé change l'ordre de sorties existantes | Phase 3 | Le défaut de `wevtutil` (du plus ancien au plus récent) est l'inverse de celui de `Get-WinEvent`. À vérifier suite par suite, pas à supposer |
| `sl /e:false` désactive un journal dont d'autres suites dépendent | Phase 4 | L'effet est réel mais local à la machine du test ; le défaut reste « activé » |

---

## 9. Stratégie de test

| Fichier | Couvre |
|---|---|
| `probe-wevtutil-01-surface.test.ts` | Phase 1 — le refus d'un verbe inconnu, et **la corrélation `wevtutil el` ↔ `Get-WinEvent -ListLog`** |
| `probe-wevtutil-02-lecture.test.ts` | Phase 2 — `gli`/`gl`, corrélés avec le nombre d'entrées réellement écrites |
| `probe-wevtutil-03-requetes.test.ts` | Phase 3 — XPath, `/c:`, `/rd:`, les trois formats, et **l'aller-retour `epl` → `qe /lf:`** |
| `probe-wevtutil-04-ecriture.test.ts` | Phase 4 — `sl` a un effet observable, `cl /bu:` rend l'effacement réversible |

Mêmes règles de méthode que le reste de la série : mesurer avant
d'affirmer, ne jamais faire passer un test par la force, et **corréler
deux commandes plutôt que figer une chaîne** — c'est ce qui a fait tomber
l'écart E2, et ce qui empêchera le suivant.

---

## 10. Ordre de livraison recommandé

**Phase 1 d'abord et seule si besoin.** C'est elle qui supprime
l'affirmation fausse, et elle a de la valeur même si rien ne suit : un
outil qui tient quatre commandes et le dit vaut mieux qu'un outil qui en
promet douze.

Puis **2**, qui ne coûte presque rien puisque les données existent. Puis
**3**, la vraie pièce — et la seule dont un autre chantier dépend
(`Get-WinEvent -FilterXml`). **4** en dernier, et `al` peut y être
remplacé par un retrait de l'aide sans que personne n'y perde.


---

## 11. Ce que la mise en œuvre a appris

Trois choses que la rédaction n'avait pas vues, et qui ont changé le
travail.

**Le détournement DHCP cachait un manque, pas un doublon.** Retirer la
correspondance sur le mot « dhcp » (E3) ne suffisait pas : les
événements du client DHCP ne vivaient nulle part dans un journal. Ils
s'entassaient dans un tableau parallèle (`dhcpEventLog`) que `wevtutil`
transformait en texte à la volée, et qu'il *fabriquait* — une entrée
`INIT` inventée quand le tableau était vide. La requête XPath légitime
de `dhcp_complete.test.ts` ne pouvait donc rien trouver une fois le
détournement parti. Corrigé à la source : `addDHCPEvent` écrit
maintenant une vraie entrée dans le journal Système sous le fournisseur
`Dhcp-Client`, ce qui rend ces événements visibles aussi de
`Get-WinEvent` et de l'Observateur — et non plus du seul `wevtutil`.

**Le piège `/rd:` s'est refermé, exactement où le §8 l'annonçait.** Une
suite demandait `wevtutil qe Security /c:5` et cherchait un événement
qu'elle venait d'écrire. `wevtutil` lisant du plus ancien au plus récent,
`/c:5` rend les cinq entrées de démarrage — un vrai Windows se comporte
pareil. L'énoncé pose désormais `/rd:true`, ce qu'écrit un analyste qui
cherche un fait récent.

**`autoBackup` a été retiré du périmètre en cours de route.** Le §6
prévoyait `sl /ab:`. La mesure a montré que `retention`
(`DoNotOverwrite`) a un effet réel — c'est ce que lit `isLogFull` — mais
que rien n'archive un journal plein. Implémenter `/ab:` aurait donc
ajouté le réglage décoratif que ce document reproche à l'existant :
l'option est refusée, `gl` affiche `autoBackup: false` en permanence, et
une probe vérifie les deux.

### Écart entre le plan et la livraison

| Prévu | Livré |
|---|---|
| `sl /ab:` (autoBackup) | **Refusé** — rien n'archive un journal plein ici |
| `al` « implémenter ou retirer » | **Implémenté**, réduit à vérifier que le fichier existe : les messages sont déjà rendus, il n'y a pas de ressources de localisation à ajouter |
| XPath : sous-ensemble | Livré, plus la forme `*[System[…]] and *[EventData[…]]` que Microsoft documente et que le plan avait oubliée |
| `Get-WinEvent -FilterXml` | **Fait** (voir §12) |

### Vérification

41 probes sur les quatre phases. Régression : 2750 tests passants sur
les fichiers touchant `wevtutil`, le journal d'événements ou DHCP ; les
trois échecs restants (`scenario-10` MAC/L2, `scenario-20` Oracle,
`cisco-wan` bail DHCP) échouent à l'identique au niveau de référence,
vérifié par `git stash`. `tsc` à 127 erreurs et `eslint` inchangés,
aucune sur les deux nouveaux fichiers.

---

## 12. Le branchement sur `Get-WinEvent`

Le seul reste déclaré au §11 est livré : `Get-WinEvent` accepte
désormais `-FilterXPath` et `-FilterXml`, et les deux passent par
`WinEventXPath` — le même analyseur que `wevtutil qe /q:`.

C'était l'intérêt de l'écrire à part. Deux analyseurs distincts pour un
seul langage divergent toujours : l'un finit par comprendre une requête
que l'autre refuse, et c'est l'utilisateur qui découvre laquelle. La
probe `probe-wevtutil-05-filtre-partage.test.ts` tient l'invariant
directement — pour cinq requêtes (EventID, « ou », niveau, fournisseur,
absence de filtre) elle compare les EventID retenus par chaque surface et
exige l'égalité, puis vérifie qu'une requête incomprise est refusée des
deux côtés.

### Ce que `-FilterXml` ajoute au-dessus de `-FilterXPath`

`-FilterXPath` prend une requête nue et a besoin de `-LogName` pour
savoir où la poser ; sans lui, la cmdlet le dit plutôt que de deviner un
canal. `-FilterXml` prend l'enveloppe `QueryList` complète, qui porte le
canal elle-même dans `Path` — c'est la forme que la console
d'observateur d'événements exporte quand on construit un filtre à la
souris, donc celle qu'on colle dans un script.

`Suppress` est traité, et pas ignoré : il retranche de ce que `Select` a
retenu. L'ignorer aurait rendu des événements que la requête excluait
explicitement, c'est-à-dire le contraire de ce qui était demandé.

Un canal inexistant dans l'enveloppe est signalé, pas rendu vide : « zéro
événement » et « ce journal n'existe pas » ne se disent pas de la même
façon à qui interroge. Une enveloppe qui n'est pas du XML de requête est
refusée en nommant ce qui manque.

### Un gap trouvé en chemin : l'apostrophe doublée

Une requête XPath porte ses propres apostrophes (`Provider[@Name='Disk']`),
et la seule façon de la citer en PowerShell sans guillemets est de les
doubler. Le lexer les gardait telles quelles : `Write-Output 'it''s'`
affichait `it''s`. Le commentaire du test qui figeait ce comportement
annonçait pourtant que « l'évaluateur résout `''`→`'` » — sauf qu'aucun
évaluateur ne le faisait, et rien en aval ne lisait autre chose que la
valeur du jeton. Le lexer résout maintenant l'échappement, comme il le
fait déjà pour les séquences backtick des chaînes doubles ; le test a été
corrigé avec la raison écrite dedans, et le comportement de bout en bout
est figé dans `backtick-escapes.test.ts`.

### Vérification

12 probes de plus. Régression : `unit/powershell`, `unit/terminal`,
`unit/shell` (2953 tests), les 125 fichiers Windows de `network-v2`
(1837 tests), et les scénarios AD/PowerShell (408 tests). Les trois
échecs restants — `ssh-edge-cases` §E12, `scenario-20` Oracle, et les
deux « gap confirmé » de `scenario-panne-09` — échouent à l'identique au
niveau de référence, vérifié par `git stash`. `tsc` à 127 erreurs,
`eslint` propre sur les fichiers touchés.

# PRD — Diagnostic de réplication Active Directory : `repadmin.exe`

**Version** : 1.0
**Date** : 2026-07-24
**Projet** : Ubuntu Sandbox — Module Windows Server / Active Directory
**Auteur** : Claude Code
**Références normatives** : documentation Microsoft de `repadmin.exe`
(RSAT — Active Directory Domain Services Tools), inspirée de MS-DRSR
(Directory Replication Service Remote Protocol, non reproduit
byte-exact dans ce dépôt — cf. § 1.1) pour la sémantique des vecteurs
de mise à jour (« up-to-dateness vector »), des USN, et des métadonnées
de réplication par objet/attribut. Ce PRD est un document de
complétion : il porte sur un sous-système **déjà présent et
partiellement câblé** dans ce dépôt (`WinRepadmin.ts` +
`ReplicationSession.ts`), pas sur une brique greenfield, et respecte
explicitement les décisions de périmètre déjà actées par
`PRD-Windows-Server-Advanced.md § 2.2` (§ 0.2).

---

## 0. Contexte et portée du document

`repadmin.exe` est, sur un vrai contrôleur de domaine, l'outil de
diagnostic de réplication AD de référence : il interroge en RPC
n'importe quel DC du domaine (local ou distant) pour lister ses
partenaires de réplication, l'état de la dernière tentative (succès,
échec, USN, horodatage), forcer une réplication ponctuelle, inspecter
le vecteur de mise à jour d'une partition, ou afficher les métadonnées
de réplication d'un objet précis. C'est l'outil que tout administrateur
AD utilise en premier pour diagnostiquer une réplication bloquée entre
deux DC ou entre deux sites.

Ce dépôt a déjà un moteur de réplication réel entre DC (§ 1.1) et une
implémentation partielle de `repadmin` s'appuyant dessus. Ce PRD couvre
exclusivement `repadmin.exe` — ses sous-commandes de diagnostic et de
contrôle — pas le moteur de réplication lui-même (`ReplicationSession.ts`,
`DirectoryStore`), déjà livré et stable, ni les cmdlets PowerShell
`Get-ADReplication*` qui l'exposent également (§ 1.1), déjà livrées et
stables. Aucune ligne de code n'est écrite dans le cadre de ce document.

### 0.1 Chaîne de dépendances

```
ReplicationSession.ts (existant, livré — PRD-Windows-Server-Advanced.md §5 P4)
  pullReplication()/notifySyncNow() réels sur TCP/135, JSON-over-TCP
  (convention documentée, pas MS-DRSR byte-exact), HighWatermarkVector
        │
ReplicationSignalStore (existant, livré — §5 P6/P12)
  log + stats agrégées, inbound et outbound
        │
Get-ADReplicationConnection/Get-ADReplicationFailure (existants, livrés)
  ActiveDirectoryCmdlets.ts — même données, exposées côté PowerShell
        │
WinRepadmin.ts (existant, partiel — ce PRD)
  /showrepl, /replsummary, /syncall seulement
        ▼
PRD-Repadmin.md                                           ◄── VOUS ÊTES ICI
  Correction du ciblage distant (§ 2.1 P1), enrichissement du format
  /showrepl (P2), /replicate (P3), /showconn (P4), /showvector (P5),
  /showobjmeta (P6), /bind (P7), /options avec portage causal (P8),
  /queue (P9), /failcache (P10), /latencies (P11)
        ▼
(aucun consommateur PRD identifié — repadmin est un outil terminal,
pas une brique consommée par un autre composant du simulateur)
```

Aucune dépendance bloquante externe : tout le code consommé
(`ReplicationSession`, `ReplicationSignalStore`, `DirectoryStore`,
`ActiveDirectoryCmdlets`) est déjà en production dans ce dépôt.

### 0.2 Périmètre déjà tranché par `PRD-Windows-Server-Advanced.md § 2.2`

Ce PRD **hérite et respecte** trois décisions de portée déjà actées et
livrées en amont, qu'il ne rouvre pas :

1. **Pas de KCC réel** (« calcul automatique de topologie de réplication
   inter-sites, coût de liens, fenêtres horaires, compression réseau »,
   remplacé par un cycle de réplication déclenché manuellement ou à
   intervalle fixe entre DC désignés explicitement »). Conséquence
   directe pour ce PRD : `/kcc`, `/bridgeheads`, `/istg`, `/siteoptions`
   restent hors périmètre (§ 2.2).
2. **Pas de tombstones/lingering objects/garbage collection réelle**.
   Conséquence directe : `/removelingeringobjects` reste hors périmètre
   (§ 2.2).
3. **Pas de réplication SYSVOL (DFSR/FRS)** — sans effet direct sur
   `repadmin` (qui ne traite que le NC de réplication AD), simplement
   rappelé ici pour la cohérence du document.

---

## 1. Analyse de l'existant

### 1.1 Inventaire

| Fichier | Rôle actuel | Constat |
|---|---|---|
| `src/network/devices/windows/WinRepadmin.ts:142-154` (`cmdRepadmin`) | Routeur de sous-commandes | Seuls `/showrepl`, `/replsummary`, `/syncall` sont reconnus ; tout le reste (`/replicate`, `/showconn`, `/showobjmeta`, `/showvector`, `/bind`, `/options`, `/queue`, `/failcache`, `/latencies`, `/kcc`, `/bridgeheads`, `/istg`) tombe dans `default:` et renvoie `repadmin: 'X' is not a recognized command.` |
| `WinRepadmin.ts:34-64` (`showRepl`) | `repadmin /showrepl [DC]` | **Ignore silencieusement le DC ciblé** — voir § 1.2 point 1, la découverte la plus significative de cette analyse |
| `WinRepadmin.ts:94-104` (`knownPartnerAddresses`) | Liste des partenaires connus | Doc-comment déjà honnête sur la limite : « real repadmin gets its partner list from the DC's own NTDS Connection objects, populated by the KCC; without a KCC modeled, "every address we've actually talked to" is this simulator's honest equivalent » — **exactement l'équivalent d'objets de connexion qu'il manque une commande `/showconn` dédiée pour exposer** |
| `src/network/devices/WindowsPC.ts:1837-1847` | Construction du `RepadminContext` et dispatch | `ctx` est construit **entièrement à partir de `this`** (le DC qui exécute la commande) — `this.getReplicationSignals().log.get()`, `this.hostname`, etc. — **aucune résolution du DC nommé en argument vers un autre `WindowsServer`** ; le nom passé en `args[1]` n'est utilisé que pour l'étiquette d'affichage (`showRepl(ctx, args[1] ?? ctx.fqdn)`, `WinRepadmin.ts:146`), jamais pour changer quelles données sont lues |
| `src/network/devices/windows/server/ad/replication/ReplicationSession.ts:23, 135-176` | Moteur de réplication réel | `AD_REPLICATION_PORT = 135`, `pullReplication()`/`notifySyncNow()` dialent un vrai `TcpSocket`, échangent un PDU JSON typé (`pullRequest`/`pullResponse`/`syncNotify`/`syncNotifyAck`) — **infrastructure directement réutilisable** pour un nouveau type de message « donne-moi ton état de réplication » que `repadmin` distant consommerait (§ 2.1 P1) |
| `HighWatermarkVector.ts` (fichier entier) | Vecteur de mise à jour par `invocationId` | `usnByInvocationId: Map<string, number>`, `encodeHighWatermarkVector`/`decodeHighWatermarkVector` déjà utilisés pour le PDU de réplication — **c'est exactement la donnée qu'un vrai `repadmin /showvector` affiche**, actuellement jamais exposée par une commande dédiée |
| `src/network/devices/windows/server/ad/ldap/DirectoryTree.ts:22-26` (`EntryReplMeta`) | Métadonnées de réplication | `{ originatingInvocationId, originatingUsn, timestamp }` — **par objet entier**, pas par attribut ; un vrai `repadmin /showobjmeta` affiche une ligne par attribut avec sa propre version/USN/DC d'origine/horodatage |
| `src/powershell/cmdlets/core/ActiveDirectoryCmdlets.ts:533-563` | `Get-ADReplicationConnection`/`Get-ADReplicationFailure` | Réels, déjà livrés, retournent `ad.listReplicationConnections()`/`ad.listReplicationFailures()` — **mêmes données que celles qu'un futur `/showconn`/`/failcache` devrait exposer côté CLI `repadmin`**, donc pas de nouvelle collecte de données à écrire, seulement un nouveau formatage |
| `src/network/devices/windows/WinDomainDiag.ts:22-60` (`cmdNltest`, `cmdDcdiag`) | Outils de diagnostic frères | `dcdiag` exécute une liste fixe de tests nommés pass/fail ; aucun des deux ne recoupe la réplication en détail — confirme que `repadmin` reste le seul outil de ce dépôt à couvrir ce terrain, pas de doublon à éviter |
| `docs/PRD-Windows-Server-Advanced.md:518-524` | Non-objectifs déjà actés | KCC réel, tombstones/lingering objects, réplication SYSVOL — cf. § 0.2 |
| `src/network/devices/windows/server/ad/forest/sites.ts`, `ActiveDirectoryCmdlets.ts` (`New-ADReplicationSite`, `New-ADReplicationSubnet`) | Sites/sous-réseaux AD | Sites et sous-réseaux réels (`siteForIp` déjà utilisé par `ReplicationServerHandler`, `ReplicationSession.ts:93-96`, pour distinguer intra-site/inter-site) — **aucun objet « site link » modélisé** (ni coût, ni fenêtre horaire) ; `repadmin` ne peut donc afficher qu'une relation binaire intra/inter-site, jamais un coût de lien |

### 1.2 Constats-clés

1. **Le ciblage distant de `/showrepl` (et implicitement de toute future
   commande à cible) est actuellement un mensonge d'affichage** :
   `repadmin /showrepl AUTREDC` exécuté depuis `DC01` affiche l'état de
   réplication **de `DC01` lui-même**, avec juste l'en-tête qui prétend
   parler d'`AUTREDC`. Sur un vrai Windows, `repadmin` dialogue en RPC
   avec le DC nommé et affiche **son** état réel. C'est la découverte la
   plus significative de cette analyse — un gap silencieux, non détecté
   par les tests existants parce qu'aucun d'eux n'a encore comparé
   `/showrepl` exécuté depuis deux DC différents avec un DC tiers en
   argument.
2. **Trois sous-commandes sont implémentées, ~11 ne le sont pas** —
   mais l'infrastructure de données sous-jacente (vecteurs USN,
   connexions, échecs, engine TCP/135) existe déjà pour la plupart
   d'entre elles ; il s'agit majoritairement de **nouveau formatage sur
   des données déjà collectées**, pas de nouvelle collecte.
3. **`/showrepl` et `/replsummary` ont un format simplifié** par rapport
   à un vrai `repadmin` : pas de section « DC Options »/« Site Options »/
   « DC object GUID », pas de DN de partition par voisin, pas de colonnes
   USN, pas de `/csv` ni `/verbose`.
4. **Aucun portage causal des `/options` NTDS Settings** (parce
   qu'`/options` n'existe pas du tout) — un vrai
   `DISABLE_OUTBOUND_REPL`/`DISABLE_INBOUND_REPL` doit changer le
   comportement réel de `pullReplication`/`ReplicationServerHandler`,
   pas juste être une valeur stockée et relue.
5. **Métadonnées de réplication au niveau objet, pas attribut** —
   limite l'exactitude possible d'un futur `/showobjmeta` (§ 2.1 P6, à
   documenter comme contrainte de conception assumée plutôt qu'un défaut
   à corriger dans ce PRD).
6. **Pas de notion de coût de lien de site** — `repadmin` ne pourra
   afficher qu'intra-site/inter-site, jamais un coût numérique, tant
   qu'aucun objet site-link n'existe dans ce dépôt (hors périmètre ici,
   § 2.2).

---

## 2. Objectifs

### 2.1 Objectifs (phases TDD, chacune livrable et testable indépendamment)

- **P1 — Ciblage distant réel** (corrige § 1.2 point 1, prioritaire sur
  tout le reste) : `repadmin /showrepl <AutreDC>` doit réellement dialoguer
  avec `<AutreDC>` plutôt que d'afficher l'état local sous un autre nom.
  Réutilise le canal TCP/135 déjà établi (`ReplicationSession.ts`,
  § 1.1) avec un nouveau type de message `statusRequest`/`statusResponse`
  (symétrique du couple `pullRequest`/`pullResponse` déjà existant) que
  `ReplicationServerHandler.register()` sait répondre en renvoyant son
  propre `ReplicationSignalStore.log`. Si `<AutreDC>` est injoignable
  (câble débranché, DC éteint, hors domaine), `repadmin` doit échouer
  avec le message réel `Unable to contact target: <AutreDC>` plutôt que
  de retomber silencieusement sur l'état local. Sans argument, le
  comportement actuel (cible = soi-même, chemin local direct, pas de
  dial réseau) est conservé tel quel — cohérent avec un vrai `repadmin`
  qui ne dialogue pas en boucle avec lui-même.
- **P2 — Fidélité de `/showrepl`/`/replsummary`** : ajouter les sections
  manquantes (`DC Options`, `Site Options`, `DC object GUID`), le DN de
  la partition répliquée par voisin, les colonnes USN (`USNs: courant/
  fin`), et les commutateurs `/csv` (une ligne par voisin, champs
  séparés par virgule, pas de mise en page ASCII) et `/verbose`
  (ajoute l'historique des dernières tentatives, pas seulement la
  dernière).
- **P3 — `/replicate <DestDC> <SourceDC> <NC>`** : force une réplication
  entrante ponctuelle d'une partition précise depuis une source précise
  vers une destination précise — enveloppe fine autour de
  `pullReplication()` déjà existant (§ 1.1), avec le ciblage distant de
  P1 si `<DestDC>` n'est pas le DC exécutant la commande.
- **P4 — `/showconn [DC]`** : liste les objets de connexion de la cible
  — dans ce dépôt sans KCC (§ 0.2), un objet de connexion équivaut à
  « un partenaire avec qui une réplication a déjà réussi au moins une
  fois » (déjà calculé par `knownPartnerAddresses`, § 1.1) ; affiché
  avec `AutoGenerated: No` (puisque rien n'est auto-généré ici,
  fidèlement — un vrai objet de connexion créé manuellement affiche
  aussi `No`) et `Transport: RPC`.
- **P5 — `/showvector <NC> [DC]`** : expose directement
  `HighWatermarkVector` (§ 1.1) — donnée déjà collectée, entièrement
  nouveau uniquement côté formatage (table `invocationId | USN le plus
  haut connu`).
- **P6 — `/showobjmeta <DC> <ObjectDN>`** : expose `EntryReplMeta` (§
  1.1) par objet. **Contrainte de conception assumée** : une seule ligne
  par objet (`originatingInvocationId`/`originatingUsn`/`timestamp`)
  plutôt qu'une ligne par attribut comme sur un vrai Windows — documentée
  explicitement dans la sortie (`Attribute: (object-level only)`) pour
  ne jamais laisser croire à une granularité qui n'existe pas.
- **P7 — `/bind [DC]`** : vérifie la connectivité RPC vers la cible (dial
  TCP/135 réel, cf. P1) et rapporte succès/échec + latence mesurée —
  premier réflexe réel d'un administrateur avant tout autre diagnostic.
- **P8 — `/options [DC] [+|-OPTION]` avec portage causal réel** :
  `DISABLE_OUTBOUND_REPL` (une fois posé, `ReplicationServerHandler`
  refuse toute `pullRequest` entrante avec l'erreur réelle « Replication
  is disabled »), `DISABLE_INBOUND_REPL` (une fois posé,
  `pullReplication()` refuse d'appliquer les changements reçus, même si
  la partie réseau réussit), `IS_GC` (purement déclaratif, reflète l'état
  déjà existant de catalogue global si modélisé ailleurs — sinon
  simple stockage), `DISABLE_SPN_REGISTRATION` (déclaratif). Les deux
  premières options doivent avoir un effet **réellement observable** en
  bout de chaîne, pas seulement une valeur relisible par `/options` —
  c'est le seul moyen de rendre cette commande utile pour un scénario de
  dépannage plutôt que décorative (même piège que celui documenté dans
  `PRD-Auditpol.md` pour `auditpol`).
- **P9 — `/queue [DC]`** : réplication de ce dépôt étant synchrone
  (un `pullReplication()` s'exécute et se termine avant que la commande
  qui l'a déclenché ne rende la main — pas de file d'attente asynchrone
  actuelle), `/queue` affiche fidèlement **toujours vide**
  (`Queue contains 0 items.`) plutôt que de simuler artificiellement une
  file — documenté explicitement comme reflet honnête du modèle
  synchrone de ce simulateur, pas un gap à corriger.
- **P10 — `/failcache [DC]`** : réutilise directement les entrées `!ok`
  déjà accumulées dans `ReplicationSignalStore.log` (§ 1.1) — même
  donnée que `Get-ADReplicationFailure` (§ 1.1), nouveau formatage
  seulement.
- **P11 — `/latencies`** : rapport de délai de propagation sur
  l'ensemble des DC connus (`knownDcFqdns`, § 1.1) — dépend du ciblage
  distant de P1 pour interroger l'état de **chaque** DC plutôt que
  seulement celui qui exécute la commande.

### 2.2 Non-objectifs

- **`/kcc`, `/bridgeheads`, `/istg`, `/siteoptions`** : héritent
  directement du non-objectif KCC déjà acté (§ 0.2, point 1). `/kcc`
  peut être accepté syntaxiquement et répondre par un message honnête
  (« Cette installation ne modélise pas de calcul automatique de
  topologie ; les partenaires de réplication sont déclarés
  explicitement. ») plutôt que `command not recognized`, mais aucun
  calcul de topologie n'est implémenté.
- **`/removelingeringobjects`** : hérite du non-objectif tombstones/
  lingering objects déjà acté (§ 0.2, point 2).
- **Coût de lien de site, fenêtres horaires de réplication inter-site** :
  aucun objet site-link n'existe dans ce dépôt (§ 1.1) ; les afficher
  dans `/showrepl`/`/showconn` nécessiterait de les modéliser d'abord —
  chantier séparé, hors périmètre ici.
- **Métadonnées de réplication par attribut** : contrainte assumée de
  P6 (§ 2.1), pas un objectif de ce PRD de faire évoluer `EntryReplMeta`
  vers une granularité par attribut — changement de modèle de données
  plus large que `repadmin` seul (toucherait tout le moteur de
  réplication et `DirectoryStore`).
- **MS-DRSR byte-exact sur le fil** : le PDU JSON-over-TCP déjà en place
  (§ 1.1) reste la convention de ce dépôt pour la réplication AD, y
  compris pour le nouveau message de P1 — aucune tentative de
  reproduire l'encodage RPC/DRSUAPI réel.

---

## 3. Architecture cible

```
ReplicationSession.ts (existant, étendu — P1)
  + StatusRequest/StatusResponse (PDU symétrique de pullRequest/Response)
  + queryRemoteReplicationStatus(tcpStack, targetIp): ReplicationLogEntry[] | null
        │
WinRepadmin.ts (existant, très étendu)
  cmdRepadmin(ctx, args, resolveTarget) — resolveTarget: (name) =>
    { ip: string } | null, réutilise la même résolution de nom que
    Invoke-Command/Test-WSMan (WindowsPSProviders.ts resolveComputer,
    même pattern de dial réel déjà établi ailleurs dans ce dépôt)
        │
        ├─ showRepl (étendu P1/P2)      ├─ showConn (P4)
        ├─ replSummary (étendu P2)      ├─ showVector (P5)
        ├─ syncAll (inchangé)           ├─ showObjMeta (P6)
        ├─ replicate (P3, nouveau)      ├─ bind (P7)
        ├─ options (P8, nouveau)        ├─ queue (P9)
        └─ failCache (P10)              └─ latencies (P11)
        │
        ▼
ReplicationServerHandler (existant, étendu — P8)
  register() : vérifie options.DISABLE_OUTBOUND_REPL avant de répondre
  à une pullRequest ; pullReplication() vérifie
  options.DISABLE_INBOUND_REPL avant d'appliquer les changements reçus
```

Un seul point d'extension de protocole (le nouveau message
`statusRequest`/`statusResponse` de P1) ; toutes les autres phases
(P2-P11 sauf P8) sont du formatage sur des données déjà collectées
localement — aucune modification du protocole réseau existant.

---

## 4. Modèle de données

### 4.1 PDU `statusRequest`/`statusResponse` (P1)

```ts
interface ReplicationStatusRequest {
  kind: 'statusRequest';
}
interface ReplicationStatusResponse {
  kind: 'statusResponse';
  fqdn: string;
  invocationId: string;
  log: ReplicationLogEntry[];   // même type que ReplicationSignalStore.log
}
```

### 4.2 `RepadminOptions` (P8)

```ts
type NtdsOption =
  | 'DISABLE_OUTBOUND_REPL' | 'DISABLE_INBOUND_REPL'
  | 'IS_GC' | 'DISABLE_SPN_REGISTRATION';

interface RepadminOptions {
  readonly flags: ReadonlySet<NtdsOption>;
}
```

Sortie réelle `repadmin /options` à reproduire :

```
Current DC Options: IS_GC
Current DC Options: (none)
```

### 4.3 Format `/showrepl /csv` (une ligne par voisin)

```
Showrepl_COLUMNS,Dest DSA,Naming Context,Source DSA,Source DSA CN,Transport Type,Number of Failures,Last Failure Time,Last Success Time,Last Failure Status
Showrepl_ENTRY,DC01,DC=mandeng,DC=lan,DC02,CN=NTDS Settings\,CN=DC02,IP,0,0,2026-07-24 10:00:00,0
```

### 4.4 `/showvector` (table)

```
Repl Up-To-Date Vector for DC=mandeng,DC=lan
Invocation ID                          USN
DC01-invocation-id                     1042
DC02-invocation-id                     887
```

---

## 5. Plan de mise en œuvre (TDD, par phases)

1. **P1 en premier, sans exception** : toutes les phases suivantes qui
   acceptent un `[DC]` optionnel (P3, P4 partiellement, P7, P11)
   dépendent de la résolution distante — les construire avant P1 ne
   ferait que reproduire le même mensonge d'affichage sur davantage de
   commandes.
2. **P2** immédiatement après P1 (même fichier, même fonction
   `showRepl`, changement additif) — test de non-régression sur les
   assertions déjà écrites contre le format actuel (aucune trouvée dans
   les suites de tests Windows existantes qui verrouillerait le format
   exact, donc risque faible).
3. **P4/P5/P10** en parallèle (indépendants, purs nouveaux formatages
   sur données déjà collectées).
4. **P3** après P1 (dépend du ciblage distant si `DestDC` ≠ local).
5. **P6** indépendant, mais son texte de sortie doit être écrit et
   revu (§ 2.1 contrainte assumée) avant tout test qui en dépend, pour
   ne pas devoir le retoucher après coup.
6. **P7** trivial une fois P1 posé (même dial, sortie plus courte).
7. **P8** en dernier avant P11 : c'est la seule phase à toucher un
   chemin d'exécution partagé (`ReplicationServerHandler.register()`,
   `pullReplication()`) — à tester en isolation complète (un DC avec
   l'option posée, un DC sans, vérifier que seul le comportement du
   premier change) avant d'intégrer.
8. **P9** trivial, aucune dépendance.
9. **P11** en tout dernier, dépend de P1 et interroge potentiellement de
   nombreux DC — à tester avec un nombre de DC volontairement petit (2-3)
   puis vérifier que le temps d'exécution reste raisonnable avant de
   considérer la phase terminée.

---

## 6. Stratégie de test

- **Test emblématique de P1** : deux DC réels cablés (`DC01`, `DC02`),
  une réplication réussie entre eux, puis `repadmin /showrepl DC02`
  exécuté **depuis `DC01`** doit afficher l'état de réplication de
  `DC02` (ses propres voisins, pas ceux de `DC01`) — le test qui aurait
  dû exister depuis le début et qui aurait immédiatement révélé le gap
  de § 1.2 point 1.
- **Test emblématique de P8** : `repadmin /options DC02
  +DISABLE_OUTBOUND_REPL` puis une tentative de pull depuis un DC tiers
  vers `DC02` doit échouer avec l'erreur réelle, alors que la même
  tentative réussissait avant que l'option soit posée.
- **Test de non-régression** : les trois sous-commandes déjà livrées
  (`/showrepl` sans argument, `/replsummary`, `/syncall`) doivent
  produire une sortie strictement identique à celle d'avant ce PRD tant
  qu'aucun argument de ciblage distant n'est fourni — P1 ne doit changer
  le comportement que du cas « avec un DC distant nommé », jamais du cas
  local.
- **P9 (`/queue`)** : test explicite qui vérifie que la sortie reste
  `Queue contains 0 items.` même immédiatement après avoir déclenché un
  grand nombre de pulls consécutifs — confirme que le choix « toujours
  vide » est un constat documenté, pas un oubli qu'un futur contributeur
  pourrait « corriger » par erreur en ajoutant une fausse file.

---

## 7. Risques et points d'attention

- **P1 est le changement à plus fort risque de régression** : c'est la
  seule phase qui touche le protocole réseau existant
  (`ReplicationSession.ts`) plutôt que d'ajouter du formatage pur —
  à river avec le test emblématique de § 6 avant toute autre phase.
- **Cohérence avec `Invoke-Command`/`Test-WSMan`** : la résolution de
  nom distant de P1 doit réutiliser le même mécanisme de dial réel déjà
  établi pour WinRM (`resolveComputer`, `WindowsPSProviders.ts`) plutôt
  que d'inventer un second mécanisme de résolution de nom parallèle —
  deux mécanismes différents pour le même besoin (joindre un autre DC
  par son nom) serait une incohérence architecturale à éviter.
- **P8 — attention à ne pas bloquer les tests existants** :
  `DISABLE_OUTBOUND_REPL`/`DISABLE_INBOUND_REPL` sont des options
  **désactivées par défaut** ; s'assurer qu'aucune valeur par défaut
  erronée ne casse silencieusement `syncAll`/`pullReplication` dans les
  suites déjà vertes qui ne posent jamais `/options`.
- **Contrainte assumée de P6 (métadonnées par objet, pas par attribut)**
  : à rappeler explicitement dans toute réponse à une future demande
  « affiche l'historique complet d'un attribut précis » — ce PRD ne le
  permet pas, un changement de modèle de données plus large serait
  nécessaire (§ 2.2).
- **Non-objectifs hérités (§ 0.2)** : ne pas réinterpréter `/kcc` comme
  une opportunité de réintroduire un calcul de topologie automatique «
  en petit » à l'occasion de ce PRD — la décision amont reste entière ;
  seul le message d'erreur de `/kcc` change (accepté avec un message
  honnête au lieu de `command not recognized`, § 2.2).

---

## 8. Critères d'acceptation

- `repadmin /showrepl DC02` exécuté depuis `DC01` affiche l'état de
  réplication réel de `DC02` (ses partenaires, ses succès/échecs), pas
  celui de `DC01`.
- `repadmin /showrepl DCInjoignable` échoue avec
  `Unable to contact target: DCInjoignable`, sans jamais retomber sur
  l'état local.
- `repadmin /showrepl /csv` produit une sortie exploitable par un
  script (une ligne par voisin, champs virgule, en-tête `Showrepl_
  COLUMNS`).
- `repadmin /replicate DC01 DC02 DC=mandeng,DC=lan` déclenche
  effectivement un pull immédiat de `DC01` depuis `DC02` pour cette
  partition, visible dans `/showrepl` juste après.
- `repadmin /showvector DC=mandeng,DC=lan` affiche le même contenu que
  le `HighWatermarkVector` interne du DC interrogé (comparaison directe
  possible dans un test).
- `repadmin /options DC02 +DISABLE_OUTBOUND_REPL` fait échouer toute
  réplication sortante ultérieure depuis `DC02`, avec l'erreur réelle
  côté partenaire ; `-DISABLE_OUTBOUND_REPL` restaure le comportement
  normal.
- `repadmin /failcache` affiche exactement les mêmes échecs que
  `Get-ADReplicationFailure`, sans divergence de contenu entre les deux
  surfaces (CLI et PowerShell) qui lisent la même donnée.
- `repadmin /kcc` répond par le message honnête documenté (§ 2.2) plutôt
  que `command not recognized`, sans jamais tenter un calcul de
  topologie.
- La suite complète `src/__tests__/unit/network-v2/` passe sans
  régression après chaque phase, vérifiée phase par phase (même
  discipline que `PRD-Auditpol.md § 8`).

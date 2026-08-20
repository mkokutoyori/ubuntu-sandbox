# PRD — IGMP / IGMP Snooping (RFC 2236, gestion d'appartenance multicast)

## 0. Contexte et portée

IGMP est le protocole par lequel un hôte signale à un routeur son intérêt
pour un groupe multicast (IPv4), et par lequel un routeur élit un
« querier » et entretient la liste des groupes actifs sur chaque segment.
L'IGMP Snooping est son complément côté switch : observer passivement le
trafic IGMP pour ne diffuser un flux multicast que vers les ports qui en
ont réellement besoin, au lieu de le flooder sur tout le VLAN. Ce PRD
couvre `src/network/igmp/` (moteur routeur/hôte) et
`src/network/igmp-snooping/` (moteur switch), ainsi que leur exposition CLI
Cisco/Huawei.

`GAP.md §5.4` documente déjà une partie de l'historique de ce sous-système :
le rejet silencieux d'`ip igmp version 3` a été corrigé (message explicite
citant RFC 3376, `✅ CORRIGÉ` daté du 2026-06-28), et cette même entrée
notait à l'époque qu'**aucune commande CLI de configuration/visualisation
IGMP n'existait pour les routeurs** — un constat **aujourd'hui périmé** :
cet audit confirme que `src/network/devices/shells/cisco/CiscoIgmpCommands.ts`
existe désormais et enregistre `ip igmp version`, `ip igmp`,
`show ip igmp groups`, `show ip igmp interface` (§1.1). Ce PRD ne
re-signale donc pas ce point comme un gap ouvert, mais documente une
asymétrie plus précise découverte par cette relecture : **cette CLI
n'existe que côté Cisco**, jamais côté Huawei (§1.3 item 6).

### 0.1 Chaîne de dépendances

- **`src/network/pim/`** (PIM-DM/SM) est le consommateur direct des groupes
  appris par IGMP : `CiscoRouter.ts:167-173` et `HuaweiRouter.ts:106-111`
  s'abonnent tous deux à `igmp.group.joined`/`igmp.group.left` et appellent
  `pimAgent.joinGroup()`/`leaveGroup()` en conséquence — ce câblage est réel
  et déjà fonctionnel, pas un god-mode ni un raccourci. La fidélité propre
  du moteur PIM lui-même (dont sa surface CLI, désormais partiellement
  couverte par `CiscoPimCommands.ts`) est hors périmètre de ce document —
  ce serait la matière d'un futur PRD dédié à PIM, pas de celui-ci.
- **IGMPv3 (RFC 3376)** est une exclusion déjà actée et **auto-documentée
  dans le code lui-même** (`CiscoIgmpCommands.ts:32` :
  `"% IGMPv3 is not supported in this simulator (RFC 3376 INCLUDE/EXCLUDE
  source filtering — out of scope, v1/v2 only)"`, testé par
  `igmp-v3-not-supported.test.ts`, et `GAP.md §5.4` qui qualifie déjà ce
  choix de « ✅ CORRIGÉ »). Ce PRD **hérite cette décision sans la
  rouvrir** — cf. §2.2. Contrairement au cas de MSTP dans
  `docs/PRD-VTP.md §0.1`, aucune dépendance interne ne force à revenir
  dessus : PIM-SSM (qui exigerait IGMPv3 côté receveur) n'est pas non plus
  implémenté, donc rien n'est aujourd'hui bloqué par cette exclusion.
- Aucune dépendance vers VLAN/802.1Q au-delà de ce que `IgmpSnoopingAgent`
  consomme déjà (`resolveIngressVlan`/`isTrunkPort`, fournis par
  `docs/PRD-VLAN.md`/`docs/PRD-802.1Q.md`, déjà livrés et non remis en
  cause ici).

---

## 1. Analyse de l'existant

### 1.1 Inventaire

| Fichier | Rôle |
|---|---|
| `src/network/igmp/types.ts` (98 lignes) | Types : `IgmpPacket` (version figée à `2` — aucune valeur `3` n'existe dans le système de types), `IgmpInterfaceRuntime` (état querier/timers RFC 2236), `IgmpGroupRecord` (avec `v1Compat`, cf. §1.3 item 2) |
| `src/network/igmp/IgmpAgent.ts` (385 lignes) | Moteur réactif : élection de querier (IP la plus basse gagne, `compareQuerier`), General/Group-Specific Query, suivi d'appartenance avec expiration, `injectReport()` — méthode publique **jamais appelée que par les tests** (§1.3 item 1) |
| `src/network/igmp-snooping/types.ts`/`IgmpSnoopingAgent.ts` (49 + 246 lignes) | Détection passive des ports routeur (via Query observée), suivi d'appartenance par port/VLAN, `immediate-leave` par VLAN, calcul du scope de flood (`computeEgressPorts`) |
| `src/network/devices/CiscoRouter.ts:165-173`, `HuaweiRouter.ts:104-111` | Câblage `IgmpAgent`+`PimAgent`, abonnement `igmp.group.joined/left` → `pimAgent.joinGroup/leaveGroup` |
| `src/network/devices/CiscoSwitch.ts`, `HuaweiSwitch.ts`, `Switch.ts` | Câblage `IgmpSnoopingAgent`, `floodFrame()` consulte `computeEgressPorts()` |
| `src/network/devices/shells/cisco/CiscoIgmpCommands.ts` (142 lignes) | `ip igmp version`, `ip igmp` (interface), `show ip igmp groups [detail]`, `show ip igmp interface` — **Cisco uniquement**, aucun équivalent VRP (§1.3 item 6) |
| `src/network/devices/shells/CiscoSwitchShell.ts:1264-1330` | `ip igmp snooping [vlan X immediate-leave]`, `show ip igmp snooping` |
| `src/network/devices/shells/HuaweiSwitchShell.ts:1377-1399,2072-2093` | `igmp-snooping` (VLAN view), `display igmp-snooping` — lecture de `immediateLeave` mais **aucune commande pour le configurer** (§1.3 item 6) |
| 3 fichiers de tests (647 lignes) | `igmp-protocol.test.ts` (271 l.), `igmp-snooping.test.ts` (330 l.), `igmp-v3-not-supported.test.ts` (46 l.) |

### 1.2 Ce qui est déjà réel et solide (à ne pas casser)

- **Élection de querier RFC 2236 correcte** : IP la plus basse gagne
  (`compareQuerier`), transition startup→querier après
  `startupQueryCount` requêtes, reprise du rôle querier après expiration
  d'`otherQuerierPresentSec` sans nouvelle Query du querier actuel.
- **Cycle Query/Report/Leave complet côté routeur** : General Query
  périodique, Group-Specific Query au Leave (dernier membre potentiel),
  expiration de groupe sur absence de rapport dans le
  `groupMembershipIntervalSec` calculé (`robustness × queryInterval +
  maxRespTime`), conforme à la formule RFC 2236.
- **IGMP Snooping fonctionnellement réel**, pas un champ décoratif :
  `Switch.floodFrame()` consulte réellement `computeEgressPorts()` pour ne
  transmettre un paquet multicast qu'aux ports membres + ports routeur
  détectés, avec expiration d'appartenance et de port routeur par timer,
  et gestion du link-down.
- **Interopérabilité Cisco↔Huawei vendor-neutral** confirmée par un test
  dédié (`igmp-protocol.test.ts`, describe « Cisco↔Huawei interop »).
- **IGMPv3 explicitement et clairement refusé**, pas une erreur générique —
  la CLI Cisco pointe vers la RFC et la raison du refus (§0.1).

### 1.3 Gap analysis — limites vérifiées

| # | Limite | Comparé à | Sévérité |
|---|---|---|---|
| 1 | **Aucun hôte final ne peut réellement rejoindre un groupe multicast.** `IgmpAgent` n'est instancié que sur `CiscoRouter`/`HuaweiRouter` (rôle querier) — jamais sur `EndHost`/`LinuxPC`/`WindowsPC`/`LinuxServer` (recherche exhaustive, zéro résultat). La seule façon de faire apparaître un membre dans la table `groups` est `injectReport()` (`IgmpAgent.ts:96-101`), une méthode publique qui n'est appelée **que par `igmp-protocol.test.ts`** (recherche exhaustive confirmée) — un raccourci de test, pas un chemin de simulation réel. Concrètement : aucun PC de ce simulateur ne peut jamais émettre une vraie trame *Membership Report* en conséquence d'une action utilisateur (regarder un flux, ouvrir un socket multicast) — tout le côté « receveur » du protocole (le rôle historique et principal d'IGMP) est absent, alors que le rôle querier (routeur) et le snooping (switch) sont tous deux solides. | Hôte IGMP réel (RFC 2236 §3-4, comportement receveur) | Élevée (le rôle le plus fondamental du protocole, entièrement simulé par un raccourci de test) |
| 2 | **`v1Compat` est écrit mais jamais lu pour changer le comportement.** `IgmpGroupRecord.v1Compat` (`types.ts:31`) est mis à vrai à la réception d'un `v1-membership-report` (`IgmpAgent.ts:166,174`), mais la seule lecture existante est cosmétique (`Group mode: IGMPv1` dans `show ip igmp groups detail`, `CiscoIgmpCommands.ts:83`). Un vrai routeur IGMPv2, dès qu'il détecte un hôte v1 sur un groupe, doit : suspendre l'émission de Group-Specific Query pour ce groupe (un hôte v1 ne les comprend pas) et ignorer tout Leave Group reçu pour ce groupe pendant la fenêtre du minuteur « Version 1 Router Present » — un hôte v1 ne peut jamais avoir émis ce Leave lui-même, l'accepter romprait la présomption v1. Aucun des deux comportements n'existe : un Leave purge le groupe immédiatement même juste après un rapport v1. | RFC 2236 §4 (Older Version Host/Querier Present) | Moyenne |
| 3 | **Aucune adhésion statique/CLI possible sur un routeur.** Ni `ip igmp join-group`/`ip igmp static-group` (Cisco) ni leur équivalent VRP n'existent — confirmé par relecture complète de `CiscoIgmpCommands.ts`. Un routeur ne peut donc jamais devenir lui-même « membre » d'un groupe pour tester la portée multicast sans dépendre d'un hôte réel (qui, de toute façon, n'existe pas non plus — item 1). | `ip igmp join-group`/`static-group` réels | Moyenne |
| 4 | **L'IGMP Snooping ne peut jamais agir en querier.** `IgmpSnoopingAgent` détecte un port routeur uniquement en observant passivement une Query déjà émise par un vrai routeur (`onQuery`, `IgmpSnoopingAgent.ts:129-136`) — rien dans `SnoopingConfig`/`types.ts` ne permet au switch d'émettre ses propres Queries. Dans une topologie sans routeur multicast en amont (un scénario réel et documenté, `ip igmp snooping querier`), le snooping ne peut jamais apprendre ni entretenir la moindre appartenance : sans Query pour la déclencher, aucun hôte ne réémettrait de rapport, et le suivi resterait vide en permanence. | `ip igmp snooping querier` réel | Moyenne |
| 5 | **Aucun port routeur statique configurable.** `SnoopingVlanState.routerPorts` (`igmp-snooping/types.ts:16`) n'est alimenté que dynamiquement par `onQuery` — pas d'équivalent à `ip igmp snooping vlan X mrouter interface Y` (Cisco) / `igmp-snooping static-router-port` (VRP) pour le fixer manuellement. | `mrouter`/`static-router-port` réels | Faible |
| 6 | **La CLI IGMP est Cisco-only, dans les deux sens.** Côté routeur : `HuaweiRouter.ts` câble `IgmpAgent`/`PimAgent` de façon strictement identique à `CiscoRouter.ts` (mêmes abonnements `igmp.group.joined/left`), mais **aucun fichier `HuaweiVRPShell.ts`/`Huawei*Commands.ts` n'enregistre la moindre commande `igmp`** (recherche exhaustive, zéro résultat) — le moteur existe et fonctionne, mais est invisible/inconfigurable depuis un terminal VRP. Côté switch : `HuaweiSwitchShell.ts` sait **afficher** l'état `immediate-leave` (`display igmp-snooping`, l. 2093) mais ne peut pas le **configurer** — aucune commande `fast-leave` (le nom VRP réel) n'existe, alors que `CiscoSwitchShell.ts` a bien `ip igmp snooping vlan X immediate-leave`. | Parité Cisco/Huawei déjà appliquée à d'autres protocoles L2 de ce dépôt (STP, LACP, VTP…) | Moyenne |

---

## 2. Objectifs

Chaque phase est indépendamment testable.

### 2.1 Objectifs (priorité décroissante)

- **P1 — Client IGMP hôte réel.** Donner à `EndHost`/`LinuxPC`/`WindowsPC`/
  `LinuxServer` un chemin réel pour rejoindre/quitter un groupe multicast :
  au minimum une action déclenchable (CLI ou API interne équivalente à
  « cet hôte s'abonne au groupe G sur l'interface I ») qui fait émettre une
  vraie trame *Membership Report* (v1 ou v2 selon la version négociée avec
  le dernier querier vu), répond aux Query reçues par un ré-rapport, et émet
  un *Leave Group* (IGMPv2) au retrait. Remplace `injectReport()` comme
  mécanisme réel plutôt que de le garder en raccourci de test — les tests
  existants qui l'utilisent aujourd'hui pour poser un état de groupe restent
  valides comme scaffolding, mais un nouveau chemin de bout en bout (hôte →
  trame → routeur → `igmp.group.joined` → PIM) doit exister et être testé.
- **P2 — Adhésion statique sur un routeur (item 3).** `ip igmp join-group
  <group>` / `ip igmp static-group <group>` côté Cisco, commande VRP
  équivalente — un routeur devient lui-même membre du groupe sur
  l'interface, sans dépendre d'un hôte en aval.
- **P3 — Comportement réel « Older Version Host Present » (item 2).**
  Suspendre le Group-Specific Query et ignorer les Leave Group pour un
  groupe marqué `v1Compat` pendant la fenêtre du minuteur RFC 2236 §4 ;
  le minuteur retombe et le comportement v2 normal reprend si aucun
  nouveau rapport v1 n'arrive avant expiration.
- **P4 — IGMP Snooping querier (item 4).** `ip igmp snooping querier`
  (Cisco) / équivalent VRP — permet au switch d'émettre ses propres
  General Query sur un VLAN dépourvu de routeur multicast en amont,
  réutilisant la même logique de Query que `IgmpAgent` plutôt que d'en
  écrire une seconde.
- **P5 — Ports routeur statiques (item 5).** `ip igmp snooping vlan X
  mrouter interface Y` / équivalent VRP — ajoute un port à
  `routerPorts` indépendamment de toute Query observée, non expiré par le
  timer dynamique.
- **P6 — Parité CLI Huawei (item 6).** Nouveau fichier
  `HuaweiIgmpCommands.ts` sur le modèle de `CiscoIgmpCommands.ts`
  (`igmp enable`, `display igmp group`, `display igmp interface`, sur la
  vue interface VRP) ; côté switch, ajouter la commande `fast-leave` dans
  `HuaweiSwitchShell.ts` pour piloter `setImmediateLeave()` (déjà
  disponible côté moteur, seulement inatteignable depuis la CLI VRP).

### 2.2 Non-objectifs (explicitement exclus)

- **IGMPv3 (RFC 3376, INCLUDE/EXCLUDE, group-and-source reports)** — déjà
  exclu explicitement et testé comme tel (`igmp-v3-not-supported.test.ts`,
  `GAP.md §5.4`) ; ce PRD hérite cette décision plutôt que de la rouvrir —
  rien ne la bloque aujourd'hui (PIM-SSM, qui en dépendrait, n'existe pas
  non plus), donc pas de raison de la lever comme cela a été fait pour
  MSTP dans `docs/PRD-VTP.md`.
- **Fidélité propre du moteur PIM** (y compris l'achèvement de sa surface
  CLI au-delà de `CiscoPimCommands.ts` déjà existant) — un sujet à part
  entière, pour un futur PRD dédié à PIM, pas pour celui-ci. Ce PRD ne
  touche que le point de contact déjà réel et fonctionnel
  (`igmp.group.joined/left` → `pimAgent.joinGroup/leaveGroup`).
- **Simulation applicative d'un flux multicast réel** (lecteur vidéo,
  contenu effectivement répliqué) — P1 ne fournit qu'un mécanisme
  d'adhésion/désabonnement réel côté hôte, pas une application de
  streaming ; hors périmètre de ce PRD.

---

## 3. Architecture cible

**P1.** Un hôte gagne un mécanisme d'adhésion multicast minimal — la forme
exacte (nouvelle commande shell type `igmp-join <iface> <group>`, ou
crochet interne appelé par un futur consommateur applicatif) est à trancher
en conception détaillée, mais dans tous les cas elle instancie ou réutilise
la même logique de rapport que `IgmpAgent` du côté client : sur adhésion,
émettre immédiatement un *Membership Report* (non sollicité, comme un vrai
hôte) puis répondre à toute Query reçue pour ce groupe avec un délai
aléatoire dans la fenêtre `maxRespTime` (déjà un champ du protocole,
`IgmpPacket.maxRespTimeDs`, simplement jamais consommé côté émission
hôte aujourd'hui) ; sur départ, émettre un *Leave Group* si la dernière
version de querier vue est 2, rien si elle est 1 (comportement RFC 2236
réel : un hôte v1 ne quitte jamais explicitement).

**P2.** Réutilise directement `IgmpAgent.injectReport()` — déjà la bonne
primitive pour « ce routeur est membre localement », simplement à exposer
proprement via une commande CLI au lieu de rester un point d'entrée
test-only.

**P3.** `IgmpGroupRecord` gagne un timestamp `v1CompatUntilMs` ; `onLeave`
et `sendGroupSpecificQuery` (`IgmpAgent.ts`) vérifient ce champ avant
d'agir, exactement comme `isVlanPruned`/`isLoopGuardActive` consultent déjà
un état dérivé avant de court-circuiter un comportement par défaut ailleurs
dans ce moteur réseau (même style de garde que dans `StpAgent`).

**P4.** `IgmpSnoopingAgent` gagne un booléen `querier` par VLAN ; quand actif
et qu'aucune Query n'a été vue d'un vrai routeur depuis
`otherQuerierPresentSec`, le switch émet lui-même des General Query
périodiques — réutilisant `IgmpAgent`'s `sendQuery`/format de trame plutôt
que de dupliquer la sérialisation IGMP dans le moteur de snooping.

**P5.** Nouvelle méthode `IgmpSnoopingAgent.setStaticRouterPort(vlan, port,
on)`, un port ainsi marqué n'est jamais retiré par `expireDue()` (contrairement
aux ports appris dynamiquement).

**P6.** `HuaweiIgmpCommands.ts` sur le modèle exact de
`CiscoIgmpCommands.ts` (mêmes accesseurs `getIgmpAgent()`, déjà présents
sur `Router`), câblé dans `HuaweiVRPShell.ts` sur la vue interface ; ajout
d'un handler `fast-leave` dans le bloc `igmp-snooping` déjà existant de
`HuaweiSwitchShell.ts:1377-1399`.

---

## 4. Modèle de données

```ts
// igmp/types.ts — v1Compat devient un minuteur, pas un simple booléen (P3)
export interface IgmpGroupRecord {
  groupAddress: string;
  iface: string;
  reporters: Set<string>;
  lastReporterIp: string | null;
  lastReportMs: number;
  v1CompatUntilMs: number | null; // remplace v1Compat: boolean
}

// igmp-snooping/types.ts — querier par VLAN (P4) + ports statiques (P5)
export interface SnoopingVlanState {
  vlan: number;
  enabled: boolean;
  querierEnabled: boolean;      // nouveau (P4)
  routerPorts: Set<string>;
  staticRouterPorts: Set<string>; // nouveau (P5) — jamais expiré dynamiquement
  groups: Map<string, SnoopingGroup>;
  querierIp: string | null;
  lastQuerierMs: number;
}
```

---

## 5. Plan de mise en œuvre

1. **P2** (adhésion statique routeur) — le plus isolé, réutilise
   `injectReport()` existant, aucun changement de structure de données.
2. **P3** (Older Version Host Present) — contenu à `IgmpAgent`, un seul
   champ de données modifié.
3. **P5** (ports routeur statiques) — additif pur côté snooping.
4. **P6** (parité CLI Huawei) — nouveau fichier + une commande, aucun
   changement de moteur.
5. **P4** (snooping querier) — réutilise `IgmpAgent`, à faire après P3 pour
   que la logique de Query réutilisée soit déjà à jour.
6. **P1** (client IGMP hôte réel) — le plus structurant, touche des classes
   d'hôte qui n'ont jamais eu de rôle IGMP jusqu'ici ; à faire en dernier
   une fois les phases plus contenues validées.

Après chaque phase : `npx tsc --noEmit -p .`, `npx eslint`, puis exécution
complète de `igmp-protocol.test.ts`, `igmp-snooping.test.ts` et
`igmp-v3-not-supported.test.ts` avant de passer à la suivante.

---

## 6. Stratégie de test

- **Non-régression obligatoire** : les 3 fichiers existants (647 lignes),
  plus toute suite PIM qui dépend indirectement d'`igmp.group.joined`
  (`CiscoRouter.ts`/`HuaweiRouter.ts` la consomment directement).
- **Nouveaux fichiers par phase** :
  - `igmp-host-client.test.ts` (P1) : un PC rejoint un groupe via le
    nouveau mécanisme, vérifie qu'une vraie trame *Membership Report*
    apparaît sur le fil (pas seulement un état interne), que le routeur en
    aval apprend le groupe et déclenche `pimAgent.joinGroup`, et qu'un
    départ explicite émet un *Leave Group* réel.
  - `igmp-static-join-group.test.ts` (P2) : `ip igmp join-group` rend le
    routeur lui-même membre, visible dans `show ip igmp groups`.
  - `igmp-v1-compat-timer.test.ts` (P3) : un rapport v1 suivi d'un Leave
    Group (usurpé/erroné) sur le même groupe est ignoré pendant la fenêtre
    de compatibilité, puis un vrai Leave après expiration du minuteur est
    traité normalement.
  - `igmp-snooping-querier.test.ts` (P4) : topologie sans routeur
    multicast, `ip igmp snooping querier` activé, vérifie que le switch
    émet des Query et que l'apprentissage de groupe fonctionne malgré
    l'absence de routeur.
  - `igmp-snooping-static-mrouter.test.ts` (P5) : port marqué mrouter
    statique, vérifie qu'il ne s'expire jamais même sans Query observée.
  - `huawei-igmp-cli-parity.test.ts` (P6) : `igmp enable`/`display igmp
    group`/`display igmp interface` côté routeur VRP, `fast-leave` côté
    switch VRP — mêmes assertions fonctionnelles que leurs équivalents
    Cisco déjà testés.

---

## 7. Risques et points d'attention

- **P1 est le changement le plus large** : il ajoute un rôle à des classes
  d'hôte qui n'en avaient aucun jusqu'ici — vérifier qu'aucune classe hôte
  ne câble déjà un chemin partiel incompatible (recherche exhaustive faite
  pour ce PRD : aucun résultat, la voie est libre).
- **Ne pas confondre P1 et le non-objectif « simulation applicative »** :
  P1 fournit un mécanisme d'adhésion réel, pas une application qui
  déciderait elle-même quand rejoindre un groupe — cette dernière couche
  reste hors périmètre.
- **P4 (snooping querier) ne doit pas dupliquer la sérialisation IGMP** —
  réutiliser `IgmpAgent`'s émission de Query plutôt que d'écrire un second
  chemin de construction de trame, pour éviter une divergence de format
  entre les deux moteurs (cf. §3).
- **Ne pas rouvrir IGMPv3** en marge d'une de ces phases — même si P1
  ajoute un vrai client hôte, il doit rester v1/v2 uniquement, cohérent
  avec l'exclusion déjà actée en §2.2 ; un hôte v3 n'est pas un sujet
  différent, juste la même exclusion vue du côté récepteur.
- **Cohérence avec `GAP.md §5.4`** : ce document a déjà noté et corrigé une
  partie de cet historique (message de rejet v3, CLI Cisco) — les
  correctifs de ce PRD devraient être reflétés dans `GAP.md` en fin de
  chantier pour éviter qu'il redevienne une source d'information périmée,
  comme cela a été observé pour son propre constat « aucune CLI IGMP »
  (§0 de ce document).

---

## 8. Critères d'acceptation

- Un PC peut rejoindre un groupe multicast par une action réelle (pas
  `injectReport()`), ce qui produit une vraie trame *Membership Report* sur
  le fil, apprise par le routeur, et propagée à PIM via
  `igmp.group.joined`.
- `ip igmp join-group`/`static-group` rend un routeur membre localement,
  visible dans `show ip igmp groups`.
- Un Leave Group reçu pour un groupe marqué `v1Compat` pendant la fenêtre
  de compatibilité est ignoré ; un Leave après expiration du minuteur est
  traité normalement.
- `ip igmp snooping querier` permet à un switch d'apprendre et d'entretenir
  des appartenances de groupe sans routeur multicast en amont.
- Un port marqué `mrouter` statique n'est jamais expiré par le timer
  dynamique, contrairement à un port appris par Query observée.
- Les commandes IGMP (routeur et snooping) fonctionnent de façon
  équivalente sur Cisco et sur Huawei.
- Les 3 suites de tests existantes (647 lignes) passent toujours sans
  modification de leurs assertions à l'issue de toutes les phases.

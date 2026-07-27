# PRD — Spanning Tree Protocol (STP / RSTP / MSTP / PVST+)

## 0. Contexte et portée

STP est le protocole anti-boucle de couche 2 : sur une topologie où plusieurs
switches sont reliés par des liens redondants (pour la tolérance de panne),
il élit un pont racine, calcule un arbre couvrant sans boucle et bloque les
ports redondants — indispensable dès qu'un lab comporte plus d'un switch en
anneau ou en maillage partiel. Ce PRD porte sur `src/network/stp/` (le
moteur, partagé par tous les vendeurs) et sur son exposition CLI côté Cisco
(`CiscoSwitchShell.ts`) et Huawei (`HuaweiSwitchShell.ts`).

Contrairement aux PRD précédents de cette série (SMTP, Exchange, Auditpol,
Repadmin), **ce protocole n'est pas un chantier à ouvrir** : c'est déjà l'un
des moteurs les plus matures et les plus testés du simulateur — 4 fichiers
moteur (`StpAgent.ts`, `StpVlanInstance.ts`, `types.ts`, `events.ts`),
~1100 lignes de logique d'élection/timers/guards, une intégration CLI riche
sur les deux vendeurs, et **17 fichiers de tests unitaires/debug existants**
(`stp-pvst.test.ts`, `stp-rstp.test.ts`, `stp-mst.test.ts`,
`stp-guards.test.ts`, `stp-guards-applied.test.ts`, `stp-tcn.test.ts`,
`stp-pvst-plus-wire.test.ts`, `stp-show-live.test.ts`,
`stp-show-subcommands.test.ts`, `cisco-stp.test.ts`, `huawei-stp.test.ts`,
`scenario-vrp-stp-lacp.test.ts`, `dhcp-stp-cli-gaps.test.ts`,
`stp-protocol.test.ts`, `bgp-bestpath.test.ts` [partiel], `debug/protocols/
stp.debug.test.ts`, `debug/cisco/cisco-stp-security.debug.test.ts`). Ce PRD
ne propose donc pas de « livrer STP » mais de fermer un ensemble précis et
vérifié de lacunes de fidélité protocolaire, en s'appuyant sur cette base
solide sans la refaire.

### 0.1 Chaîne de dépendances

- **`docs/PRD-VLAN.md` §1.3 item 6** affirmait, au moment de sa rédaction :
  « MSTP (802.1s) absent au niveau moteur — seul un état `stpMode`/
  `mstRegion` local au shell Cisco existe, jamais consommé par `StpAgent` »,
  documenté comme dépendance externe non bloquante renvoyée à « un futur PRD
  dédié au moteur STP ». **Ce constat est aujourd'hui obsolète** : la lecture
  du code montre que `StpAgent` consomme réellement le mode `'mstp'` et la
  `MstRegion` (`instanceKeyForVlan()` résout chaque VLAN vers son instance
  MSTI via `mstRegion.instances`, `StpAgent.ts:137-143`) — MSTP a été
  implémenté pour de vrai entre-temps, sans qu'aucun PRD dédié n'ait jamais
  été écrit. Ce document *est* ce PRD dédié, arrivé après coup ; §7 revient
  sur les conséquences de ce décalage pour les deux PRD qui l'attendaient.
- **`docs/PRD-VTP.md` §2.2** excluait la propagation d'une base MST via VTP
  v3 « car MSTP lui-même est hors périmètre… Cette exclusion tombe
  automatiquement si un futur PRD dédié au moteur STP/MSTP est écrit et
  livré. » Même remarque : la condition de levée est déjà remplie côté
  moteur ; ce PRD ne referme pas ce chantier VTP (il reste hors périmètre
  ici, cf. §2.2), mais acte que la dépendance qui le bloquait n'existe plus.
- **`src/network/lacp/`** (LACP/EtherChannel) est une dépendance directe du
  constat le plus important de ce PRD (§1.2 item 1) : le moteur LACP a sa
  propre machine de sélection 802.3ad (`LacpAgent.runSelection()`,
  `getGroupMembers()`) mais n'est aujourd'hui consulté par aucun code STP.
- **`docs/PRD-802.1Q.md`** fournit la fidélité de trame 802.1Q déjà réutilisée
  par l'habillage PVST+ sur trunk (`STP_BRIDGE_MAC`/`PVST_PLUS_MAC`,
  `StpAgent.ts:804-821`) — pas de dépendance nouvelle, déjà consommée.

## 1. Analyse de l'existant

### 1.1 Inventaire

| Fichier | Rôle |
|---|---|
| `src/network/stp/types.ts` | Types partagés : `StpBpdu`, `BridgeId`, `StpPortRole` (root/designated/alternate/backup/disabled), `StpProtocolMode` (stp/rstp/mstp), `StpPortGuards`, `MstRegion`, tables de coût par défaut courtes/longues (`defaultPathCost`/`defaultPathCostLong`), `parseStpVlanList()` (syntaxe Cisco `10,20-25` et Huawei `10 to 25 30`) |
| `src/network/stp/StpAgent.ts` | Moteur par device : une instance `StpVlanInstance` par VLAN (PVST+/Rapid-PVST+) ou par MSTI (MSTP), élection, BPDU tx/rx, TCN classique + synchronisation rapide (proposal/agreement RSTP), tous les guards (PortFast, BPDU Guard, Root Guard, BPDU Filter, Loop Guard), UplinkFast (partiel, assumé — voir §1.2), BackboneFast (config seule — voir §1.2), habillage PVST+ sur trunk (`PVST_PLUS_MAC`), compteurs BPDU/transitions |
| `src/network/stp/StpVlanInstance.ts` | Élection par instance (comparaison de BridgeId, calcul de coût, rôles de port), machine d'état de forwarding (blocking/listening/learning/forwarding/disabled) avec timers de transition liés au forward-delay, vieillissement des infos BPDU (`expireStaleBpduInfo`) |
| `src/network/stp/events.ts` | Topics bus : `stp.bpdu.sent/received`, `stp.role.changed`, `stp.port-state.changed`, `stp.root.changed`, `stp.topology-change.detected`, `stp.bpdu-guard.violation`, `stp.root-guard.changed`, `stp.portfast.lost`, `stp.tcn.sent/received`, `stp.bpdu-info.expired` |
| `src/network/devices/CiscoSwitch.ts:80-90,152-160,232` | Instancie `StpAgent` avec les hooks `StpHost` (VLAN par port, trunk/native VLAN pour PVST+, callback forward-state → `setStpVlanState`, callback BPDU-Guard → `applyStpBpduGuardErrDisable` qui force juste `port.setUp(false)`) |
| `src/network/devices/HuaweiSwitch.ts` | Même câblage côté VRP |
| `src/network/devices/shells/CiscoSwitchShell.ts:1335-1620,3220-3410` | Commandes globales/interface `spanning-tree …`, sous-mode `spanning-tree mst configuration`, ~15 variantes de `show spanning-tree …`, `debug spanning-tree` |
| `src/network/devices/shells/HuaweiSwitchShell.ts:2169-2480` | Équivalent VRP : `stp …` (system-view et interface-view), `display stp` (global/brief/mode/topology-change/region-configuration/interface/instance) |
| `src/network/lacp/LacpAgent.ts` | Moteur LACP/802.3ad indépendant : sélection réelle (`runSelection`), état par groupe (`getGroupMembers(groupId)`), jamais consulté par `StpAgent` ni par le chemin de données (`CiscoSwitch.ts`/`HuaweiSwitch.ts` n'appellent `getLacpAgent()` que depuis les shells, pour l'affichage) |
| 17 fichiers de tests existants (listés en §0) | Couverture déjà large : élection PVST+/Rapid-PVST+, guards, MST, TCN, habillage PVST+ sur le fil, `show`/`display` |

### 1.2 Constats-clés

1. **STP est aveugle aux bundles LACP (constat le plus significatif).**
   `LacpAgent` a sa propre machine de sélection 802.3ad
   (`LacpAgent.runSelection()`, `getGroupMembers(groupId)` renvoie les
   membres réellement sélectionnés/« bundled »), mais aucune méthode
   `StpHost` ni aucun point de `StpAgent` ne l'interroge — confirmé par
   recherche exhaustive : `getLacpAgent()` n'est appelé que depuis
   `CiscoSwitchShell.ts`/`HuaweiSwitchShell.ts` (affichage `show etherchannel
   summary`/`display lacp statistics`), jamais depuis `StpAgent.ts` ni depuis
   le chemin de données (`CiscoSwitch.ts`/`HuaweiSwitch.ts` ne référencent
   `Port-channel`/`Eth-Trunk` nulle part hors des shells). Conséquence
   concrète : quand un opérateur relie deux switches par deux liens
   parallèles bundlés en un seul `channel-group`/`eth-trunk` — précisément
   le scénario qui justifie l'agrégation de liens — chaque port physique du
   bundle continue de négocier indépendamment son propre rôle/état STP et
   d'échanger ses propres BPDU, au lieu qu'un seul port logique
   (`Port-channel1`/`Eth-Trunk1`) participe à l'arbre. La fonctionnalité
   même qui doit éliminer la boucle en fusionnant les liens redondants ne
   change rien au fonctionnement de la couche qui, par ailleurs, les
   bloquerait individuellement.
2. **Les timers effectifs ne sont jamais ceux annoncés par la racine.**
   `StpAgent.forwardDelaySec(vlan)`/`maxAgeSec(vlan)` (`StpAgent.ts:79-80`)
   renvoient toujours la configuration *locale* du pont
   (`getVlanForwardDelaySec`/`getVlanMaxAgeSec`), utilisée telle quelle par
   `StpVlanInstance.scheduleTransition()` (timing listening→learning→
   forwarding) et `expireStaleBpduInfo()` (âge max des infos BPDU) — alors
   que l'IEEE 802.1D exige qu'un pont non-racine adopte les timers
   *annoncés dans les BPDU reçues de la racine* (Hello/Max Age/Forward
   Delay), sa propre configuration locale ne s'appliquant que s'il devient
   racine lui-même. `StpBpdu.maxAgeSec/helloSec/forwardDelaySec` sont bien
   présents sur le fil (`sendBpdu()`, `StpAgent.ts:783-803`) mais **jamais
   recopiés** dans `StpPortInfo` à la réception (`handleFrame()`,
   `StpAgent.ts:578-586` ne conserve que `designatedRoot/designatedBridge/
   designatedCost/designatedPort`). Par ailleurs `messageAgeSec: 0` est
   codé en dur à chaque émission (`sendBpdu()` et `sendTcn()`), jamais
   incrémenté au relais — un scénario classique de cours (« diamètre de
   réseau trop grand pour le Max Age », limite théorique de 7 sauts avec le
   défaut de 20s) est donc irreproductible : aucune BPDU ne peut jamais
   s'auto-périmer par excès de Message Age.
3. **Root Guard n'a aucun chemin de récupération — code mort confirmé.**
   `StpAgent.clearRootInconsistent()` (`StpAgent.ts:469-479`) existe et
   publie correctement `stp.root-guard.changed` avec l'état `consistent`,
   mais une recherche exhaustive (`grep -rn "clearRootInconsistent"`) montre
   qu'**aucun appelant n'existe nulle part dans le code** : ni dans
   `expireStaleBpduInfo()` (qui ne traite que le cas Loop Guard, jamais Root
   Guard), ni depuis une commande CLI, ni depuis un timer. Une fois qu'un
   port passe root-inconsistent (BPDU supérieure reçue sur un port protégé
   par `spanning-tree guard root`), il **reste bloqué indéfiniment**, y
   compris après que la source de la BPDU supérieure a cessé d'émettre —
   alors qu'un vrai IOS le rétablit automatiquement environ deux fois le
   Hello Time après la dernière BPDU supérieure reçue.
4. **Coût et priorité de port ne sont configurables nulle part.**
   `costForPort()` (`StpAgent.ts:270-273`) ne dérive le coût que de la
   vitesse du port ; `portIdFor()` (`StpAgent.ts:837-840`) code en dur la
   priorité de port à `0x80` (128, la valeur par défaut Cisco/Huawei).
   Recherche exhaustive : ni `spanning-tree cost`/`spanning-tree
   port-priority` côté `CiscoSwitchShell.ts`, ni `stp cost`/`stp port
   priority` côté `HuaweiSwitchShell.ts` n'existent — pas même comme
   commandes acceptées sans effet. Un lab classique (forcer un chemin
   spécifique parmi deux liens de même vitesse via le coût, ou répartir la
   charge entre deux ports vers un même voisin via la priorité de port) est
   irréalisable.
5. **L'Extended System ID est incohérent entre l'élection, le fil et
   l'affichage.** La couche d'affichage calcule `prio + vlanId` pour le
   « Root ID Priority »/« Bridge ID Priority » montrés par `show
   spanning-tree`/`show spanning-tree root`/`show spanning-tree bridge`
   (`CiscoSwitchShell.ts:3231,3302,3319` — la ligne `rootPrio = (isRoot ?
   agent.getVlanPriority(vlanId) : root.priority) + vlanId` simule
   l'Extended System ID *seulement à l'affichage*). Mais
   `StpAgent.ownBridgeId()` (`StpAgent.ts:257-262`), qui produit la
   `BridgeId` réellement comparée par l'élection (`compareBridge()`,
   `types.ts:172-177`) et réellement transmise dans `StpBpdu.senderBridge`
   sur le fil (`sendBpdu()`), n'ajoute jamais le VLAN ID/l'ID d'instance
   MSTI à la priorité. Résultat : deux VLAN configurés avec la même
   priorité produisent en interne des `BridgeId` strictement identiques
   (égalité tranchée par l'adresse MAC, comme un vrai switch sans Extended
   System ID) alors que l'affichage montre des priorités différentes qui
   laissent croire à l'opérateur que l'arithmétique Extended System ID a
   bien lieu au niveau du protocole — et qu'une capture (`tcpdump`) de la
   BPDU montrerait une priorité encore différente des deux.
6. **BackboneFast est un théâtre de configuration sans aucun effet.**
   `setBackboneFast()`/`config.backboneFast` (`StpAgent.ts:454`,
   `types.ts:86`) ne sont lus que pour l'afficher dans `show spanning-tree
   summary` (`CiscoSwitchShell.ts:1529`) et le retranscrire dans le
   running-config (`StpAgent.ts:514`) — recherche exhaustive confirmée,
   aucune autre référence dans le moteur. Sa seule raison d'être réelle
   (accepter une BPDU inférieure sur un port bloqué/racine comme signal
   d'une panne indirecte, et sauter l'attente du Max Age avant de
   reconverger) n'existe pas : activer ou non `spanning-tree backbonefast`
   ne change rigoureusement rien à la convergence simulée.
7. **`errdisable recovery cause bpduguard` n'existe pas.** Les causes
   acceptées par `errdisable recovery cause …` sont `arp-inspection`
   (`CiscoSwitchShell.ts:461`) et `psecure-violation` (`:948`) — jamais
   `bpduguard`. `applyStpBpduGuardErrDisable()` (`CiscoSwitch.ts:156-160`)
   force simplement `port.setUp(false)`, sans minuteur de récupération
   automatique ni message syslog distinct (`%PM-4-ERR_DISABLE`/
   `%PORT_SECURITY-2-PSECURE_VIOLATION`-style) permettant de distinguer un
   arrêt BPDU Guard d'un `shutdown` manuel ordinaire — seule une
   intervention manuelle (`shutdown` puis `no shutdown`) peut relever le
   port.
8. **MSTP mono-région uniquement — pas d'interopérabilité multi-région.**
   Chaque switch ne porte qu'une seule `MstRegion` locale (`types.ts:89-97`)
   et `instanceKeyForVlan()` (`StpAgent.ts:137-143`) résout chaque VLAN
   uniquement via sa propre table d'instances, sans jamais comparer de
   « digest » de région à celui d'un voisin ni distinguer un rôle de port
   de frontière CIST interne/externe. MSTP fonctionne donc comme si chaque
   switch était seul dans sa région — cf. §2.2, exclu explicitement.
9. **UplinkFast est un sous-ensemble assumé et déjà documenté comme tel.**
   Seul le basculement immédiat vers un port de secours déjà connu est fait
   (`onPortLinkDown()`, `StpAgent.ts:876-885`) ; le commentaire en ligne
   indique explicitement que la rafale de trames multicast qui force le
   réapprentissage MAC en amont n'est pas modélisée — c'est une
   simplification déjà honnête et assumée dans le code lui-même, pas une
   découverte de ce PRD (mentionnée ici pour mémoire, cf. §2.2).

## 2. Objectifs

Chaque phase est indépendamment testable et n'exige pas les suivantes.

### 2.1 Objectifs (priorité décroissante)

- **P1 — Intégrer STP et LACP : un bundle actif est un seul port STP.**
  Ajouter un hook `StpHost.getStpBundleGroup?(portName): { groupId: number;
  members: string[] } | undefined`, alimenté côté `CiscoSwitch`/
  `HuaweiSwitch` par `lacpAgent.getPortInfo(portName)` +
  `lacpAgent.getGroupMembers(groupId)` filtrés sur `p.bundled === true`.
  Quand ce hook renvoie un groupe, `StpAgent` doit traiter tous les membres
  comme **un seul port logique** (clé `po:<groupId>`/`eth-trunk:<groupId>`)
  pour l'élection, le rôle, l'état de forwarding et le compteur BPDU — un
  seul membre (le plus petit index de port actif) émettant/recevant
  effectivement les BPDU pour le groupe, l'état résultant étant répercuté
  sur tous les membres. `show spanning-tree`/`display stp brief` doivent
  alors afficher une seule ligne `Po1`/`Eth-Trunk1` au lieu d'une ligne par
  membre physique. N'affecte aucun port qui n'est pas dans un groupe
  sélectionné — comportement actuel inchangé pour toute topologie sans
  LACP, donc aucune régression attendue sur les 17 suites existantes qui
  n'en configurent pas.
- **P2 — Propager les timers de la racine et faire vieillir le Message
  Age.** `StpPortInfo` doit conserver `helloSec/maxAgeSec/forwardDelaySec`
  reçus dans la BPDU du port racine ; `StpAgent.forwardDelaySec(vlan)`/
  `maxAgeSec(vlan)` doivent renvoyer ces valeurs adoptées quand le pont
  n'est pas racine (et retomber sur la configuration locale seulement s'il
  l'est). `sendBpdu()`/`sendTcn()` doivent incrémenter `messageAgeSec` au
  relais (a minima +1 par saut, conformément à la pratique 802.1D standard)
  et une BPDU dont le Message Age reçu dépasse le Max Age effectif doit être
  écartée à la réception au lieu d'être traitée normalement — rendant
  reproductible le scénario pédagogique classique du diamètre de réseau
  excédant la limite supportée par le Max Age configuré sur la racine.
- **P3 — Rendre Root Guard réversible.** Appeler
  `clearRootInconsistent(portName)` dès que `expireStaleBpduInfo()`
  constate qu'aucune BPDU supérieure n'est plus reçue sur un port
  root-inconsistent depuis au moins deux fois le Hello Time effectif
  (cohérent avec le comportement documenté d'un vrai IOS), en plus de
  garder un chemin de test direct sur la fonction existante. Sans ce
  correctif, toute suite de test qui exercerait un scénario complet
  « attaque → Root Guard → retrait de l'attaquant → reconvergence » ne
  pourrait constater qu'un blocage permanent, jamais une récupération.
- **P4 — Coût et priorité de port configurables.** Ajouter
  `spanning-tree cost <n>` / `spanning-tree port-priority <n>` (et leurs
  variantes `spanning-tree vlan <v> cost/port-priority` pour PVST+, `stp
  cost <n>` / `stp port priority <n>` côté Huawei), stockés par
  `StpAgent` dans une map par port (et par VLAN/MSTI le cas échéant) qui
  prend le pas sur `costForPort()`/`portIdFor()` quand elle est renseignée,
  sans changer le comportement par défaut (auto-dérivé de la vitesse /
  priorité 128) en son absence.
- **P5 — Cohérence Extended System ID entre élection, fil et affichage.**
  Faire en sorte que `ownBridgeId()` (donc l'élection *et* la BPDU
  transmise) intègre le VLAN ID/ID d'instance MSTI dans les 12 bits bas de
  la priorité exactement comme l'affichage le simule déjà côté CLI — pour
  que ce qu'une capture `tcpdump` d'une BPDU montre, ce que `show
  spanning-tree` affiche et ce que l'élection compare en interne soient
  la même valeur.
- **P6 — Rendre BackboneFast fonctionnellement effectif.** Sur un port
  bloqué ou racine, une BPDU *inférieure* reçue (root moins bon que celui
  déjà connu du même expéditeur) déclenche, uniquement si `backboneFast`
  est actif, un raccourcissement de l'attente avant reconvergence (sauter le
  Max Age plutôt que d'attendre son expiration naturelle) — au lieu de
  n'avoir aucun effet observable comme aujourd'hui.
- **P7 — `errdisable recovery cause bpduguard`.** Accepter cette cause (et
  `errdisable recovery interval` déjà existant s'applique), relever
  automatiquement un port mis en err-disable par BPDU Guard après
  l'intervalle configuré si `bpduguard` est dans la liste des causes
  actives, et journaliser un message distinct identifiable (au minimum dans
  le log réseau) pour ce cas précis plutôt qu'un simple arrêt de port
  indifférencié.

### 2.2 Non-objectifs (explicitement exclus)

- **Interopérabilité MSTP multi-région réelle** (comparaison de « digest »
  de région, rôles de port de frontière CIST interne/externe entre régions
  différentes) — cf. §1.2 item 8. Chaque switch reste mono-région ; un
  futur PRD dédié pourrait lever cette limite, mais l'ampleur du travail
  (une seconde couche d'accord inter-région par-dessus l'arbre déjà
  existant) dépasse le périmètre de ce document.
- **Rafale de flush multicast d'UplinkFast** — cf. §1.2 item 9,
  simplification déjà honnête et assumée par un commentaire explicite dans
  le code ; ce PRD ne propose pas de la compléter.
- **Bridge Assurance / PVST Simulation Check** — fonctionnalités Nexus/IOS
  récent hors du socle de plateformes modélisées par ce simulateur
  (IOS classique / VRP).
- **Digest de région MST byte-exact sur le fil** (condensé MD5 de la table
  d'instances triée) — dépend directement du non-objectif ci-dessus sur
  l'interopérabilité multi-région ; sans second interlocuteur de région à
  comparer, un digest fidèle au bit près n'a aucune utilité observable.
- **STP sur `GenericSwitch`/`Hub`** — seuls `CiscoSwitch` et `HuaweiSwitch`
  exécutent `StpAgent` aujourd'hui (confirmé par recherche exhaustive), ce
  qui est cohérent avec la scission déjà actée par `docs/PRD-VLAN.md`
  (`GenericSwitch` = spécialisation minimale sans VTP/DTP) ; ce PRD ne
  propose pas d'étendre STP à ces classes.
- **Réouverture de `docs/PRD-VLAN.md`/`docs/PRD-VTP.md`** — §0.1 documente
  que leur dépendance MSTP est levée de fait, mais la mise à jour de ces
  deux documents (et la levée du non-objectif VTP v3 « base MST ») relève
  de leurs PRD respectifs, pas de celui-ci.

## 3. Architecture cible

**P1 (bundle LACP ↔ STP).** `StpHost` (interface consommée par `StpAgent`,
`StpAgent.ts:17-31`) gagne un hook optionnel supplémentaire, au même niveau
que `getStpPortVlans`/`isStpTrunkPort` déjà existants :

```ts
getStpBundleGroup?(portName: string): { groupKey: string; members: string[] } | undefined;
```

`CiscoSwitch`/`HuaweiSwitch` l'implémentent en dérivant `groupKey` de
`Port-channel<id>`/`Eth-Trunk<id>` et `members` de
`lacpAgent.getGroupMembers(id).filter(p => p.bundled).map(p => p.portName)`.
Dans `StpAgent`, toute méthode qui clé aujourd'hui son état par nom de port
physique (`ensurePortInstances`, `handleFrame`, `emitBpduOnAllPorts`,
`getPortRoleForVlan`, etc.) résout d'abord ce nom vers sa clé logique
(`groupKey` si bundlé, nom physique sinon) avant de consulter/mettre à jour
`StpVlanInstance.portInfo`. Un seul membre (le premier index actif de la
liste triée) porte réellement l'émission/réception de BPDU pour le groupe ;
tout changement de rôle/état sur la clé logique est répercuté vers
`onForwardStateChanged` pour **chaque** membre physique (le plan de données
Ethernet continue d'exister par port physique, seule la couche STP change
de granularité). Le coût du port logique réutilise
`defaultPathCost`/`defaultPathCostLong` (déjà en place, `types.ts:156-170`)
appliqués à la somme des vitesses des membres actuellement bundlés, sans
dupliquer cette table.

**P2 (timers de la racine).** `StpPortInfo` (`types.ts:128-136`) gagne trois
champs `helloSec`/`maxAgeSec`/`forwardDelaySec` (copiés depuis la BPDU reçue
sur le port racine). `StpAgent.forwardDelaySec(vlan)`/`maxAgeSec(vlan)`
lisent d'abord `StpVlanInstance`'s infos du port racine courant si le pont
n'est pas lui-même racine, avec repli sur la config locale sinon (racine
elle-même, ou aucune info encore reçue). `sendBpdu()` incrémente
`messageAgeSec` d'un pas fixe avant retransmission plutôt que de le forcer à
0 ; `handleFrame()` compare ce champ au Max Age effectif et ignore la BPDU
(sans mettre à jour `StpPortInfo`) si elle est déjà périmée à la réception.

**P3 (récupération Root Guard).** Aucune nouvelle structure : brancher
l'appel existant à `clearRootInconsistent()` dans `expireStaleBpduInfo()`
(`StpVlanInstance.ts:82-116`), à côté du traitement Loop Guard déjà présent
dans la même boucle, avec le même mécanisme d'horodatage (`info.ageMs`) déjà
utilisé pour le vieillissement standard des infos BPDU.

**P4 (coût/priorité par port).** Deux nouvelles `Map<string, number>` dans
`StpAgent` (`portCostOverride`, `portPriorityOverride`), consultées en
premier par `costForPort()`/`portIdFor()` avant le calcul auto-dérivé
actuel ; variantes par VLAN via une clé composite `${vlan}:${port}` sur le
même modèle que `vkey()` déjà utilisé pour l'anti-réentrance BPDU
(`StpAgent.ts:129`).

**P5 (Extended System ID).** `ownBridgeId(key)` (`StpAgent.ts:257-262`)
ajoute `key` (VLAN ID ou ID de MSTI) à la priorité avant de construire le
`BridgeId`, au lieu de ne le faire qu'à l'affichage — supprimant le calcul
dupliqué `+ vlanId` actuellement fait uniquement dans
`CiscoSwitchShell.ts`/`HuaweiSwitchShell.ts`, qui n'aura alors plus besoin
d'exister séparément puisque la valeur portée par `BridgeId` sera déjà la
bonne.

**P6 (BackboneFast effectif).** Dans `handleFrame()`, quand
`this.config.backboneFast` est vrai et qu'une BPDU dont le root annoncé est
**pire** que celui déjà connu du même expéditeur arrive sur un port
bloqué/racine, déclencher directement `expireStaleBpduInfo`-style
l'expiration de l'info locale sur ce port (au lieu d'attendre l'expiration
naturelle par Max Age), rejouant ensuite l'élection immédiatement.

**P7 (errdisable recovery bpduguard).** `applyStpBpduGuardErrDisable()`
(`CiscoSwitch.ts:156-160`) publie un événement identifiable (p. ex. un champ
`cause: 'bpduguard'` sur l'événement existant ou un nouveau topic dédié) ;
un minuteur déjà présent pour les autres causes errdisable
(`CiscoSwitchShell.ts:467`, `errdisable recovery interval`) est étendu pour
couvrir cette cause et relever le port (`port.setUp(true)`) après
l'intervalle si `bpduguard` fait partie des causes actives.

## 4. Modèle de données

```ts
// types.ts — StpPortInfo étendu (P2)
export interface StpPortInfo {
  role: StpPortRole;
  cost: number;
  designatedRoot: BridgeId;
  designatedBridge: BridgeId;
  designatedCost: number;
  designatedPort: number;
  ageMs: number;
  // Nouveau (P2) : timers annoncés par l'expéditeur de cette BPDU,
  // adoptés tels quels si ce port est le port racine.
  helloSec: number;
  maxAgeSec: number;
  forwardDelaySec: number;
}

// StpAgent.ts — overrides par port (P4)
private readonly portCostOverride = new Map<string, number>();     // clé: `${vlan}:${port}` ou `${port}`
private readonly portPriorityOverride = new Map<string, number>(); // idem

// StpAgent.ts — hook de bundle LACP (P1), consommé via StpHost
getStpBundleGroup?(portName: string): { groupKey: string; members: string[] } | undefined;
```

## 5. Plan de mise en œuvre

Ordre d'implémentation recommandé — distinct de l'ordre de priorité P1..P7 :
les phases à faible risque de régression sont livrées d'abord pour
sécuriser les 17 suites existantes avant d'aborder le changement le plus
structurant (P1).

1. **P3** (Root Guard) — correctif isolé, un seul point d'appel ajouté,
   aucun changement de structure de données.
2. **P4** (coût/priorité de port) — additif pur (nouvelles maps consultées
   en premier, comportement par défaut inchangé si absentes).
3. **P7** (errdisable recovery bpduguard) — additif, réutilise le mécanisme
   errdisable déjà en place pour les autres causes.
4. **P5** (Extended System ID) — modifie une formule existante
   (`ownBridgeId`) ; à faire après P4 pour que les tests de coût/priorité
   ne soient pas écrits contre une valeur de priorité qui va encore bouger.
5. **P6** (BackboneFast effectif) — additif, ne change rien si le flag
   reste désactivé (comportement actuel = flag toujours désactivé par
   défaut).
6. **P2** (timers de la racine + Message Age) — touche le cœur de
   l'élection/vieillissement ; à isoler avec sa propre suite de
   non-régression avant d'aborder P1.
7. **P1** (intégration LACP↔STP) — le plus structurant et le plus risqué,
   fait en dernier une fois que le reste du moteur est stabilisé.

Après chaque phase : `npx tsc --noEmit -p .`, `npx eslint`, puis exécution
complète des 17 fichiers de tests STP existants (§0) en plus des nouveaux
tests de la phase, avant de passer à la suivante.

## 6. Stratégie de test

- **Non-régression obligatoire** après chaque phase : les 17 fichiers
  existants listés en §0, plus les suites LACP (`scenario-vrp-stp-lacp.
  test.ts` notamment, qui exerce LACP et STP côte à côte sans encore tester
  leur interaction — P1 doit la faire réussir sans changer les assertions
  qui ne concernent pas le bundle).
- **Nouveaux fichiers par phase**, un par objectif pour isoler les
  régressions :
  - `stp-lacp-bundle.test.ts` (P1) : bundle deux liens parallèles entre deux
    switches Cisco (puis Huawei) via `channel-group`/`eth-trunk`, vérifie
    qu'une seule ligne `Po1`/`Eth-Trunk1` apparaît dans `show
    spanning-tree`/`display stp brief`, qu'aucun port physique membre n'a
    de rôle STP individuel, et qu'un lien parallèle **non** bundlé entre les
    deux mêmes switches est bien bloqué normalement (comportement actuel
    inchangé hors bundle).
  - `stp-root-timer-propagation.test.ts` (P2) : configure un Max Age/
    Forward Delay non-défaut uniquement sur la racine, vérifie qu'un switch
    non-racine à 2 sauts adopte ces valeurs (et non ses propres valeurs par
    défaut) pour le timing de transition observé ; un second test vérifie
    qu'une BPDU dont le Message Age simulé dépasse le Max Age effectif est
    ignorée.
  - `stp-root-guard-recovery.test.ts` (P3) : déclenche Root Guard, retire la
    source de la BPDU supérieure, avance le scheduler de deux Hello Time,
    vérifie le retour à `consistent` et la reconvergence du rôle de port.
  - `stp-port-cost-priority.test.ts` (P4) : `spanning-tree cost`/
    `port-priority` sur Cisco et `stp cost`/`port priority` sur Huawei,
    vérifie que le chemin choisi par l'élection change en conséquence.
  - `stp-extended-system-id.test.ts` (P5) : deux VLAN à la même priorité
    configurée, vérifie que les `BridgeId` élus diffèrent réellement (pas
    d'égalité tranchée par MAC) et que la valeur affichée par `show
    spanning-tree` correspond exactement à celle comparée en interne.
  - `stp-backbonefast.test.ts` (P6) : BPDU inférieure sur un port bloqué
    avec `backbonefast` actif vs inactif, compare le délai de
    reconvergence observé.
  - `stp-bpduguard-errdisable-recovery.test.ts` (P7) : déclenche BPDU
    Guard avec `errdisable recovery cause bpduguard` et un intervalle
    court configurés, avance le scheduler, vérifie le relevé automatique du
    port.
- **Tests croisés Cisco/Huawei** pour chaque phase qui touche les deux
  shells (P1, P4), cohérent avec la convention déjà appliquée par les 17
  fichiers existants (`cisco-stp.test.ts` / `huawei-stp.test.ts` séparés).

## 7. Risques et points d'attention

- **P1 est le changement à plus large surface** : `StpHost` est implémenté
  par deux classes (`CiscoSwitch`, `HuaweiSwitch`) et consommé par la
  quasi-totalité de `StpAgent` (toute méthode qui clé par nom de port).
  Le risque principal est une régression silencieuse sur les 17 suites
  existantes si la résolution « clé logique vs nom physique » n'est pas
  strictement un no-op en l'absence de `getStpBundleGroup`. Le plan de mise
  en œuvre (§5) place volontairement cette phase en dernier pour limiter le
  risque cumulé.
- **P2 ne doit rien changer par défaut** : tant qu'aucun switch ne
  configure des timers non-défaut sur sa racine, les valeurs propagées
  doivent être identiques aux valeurs locales déjà utilisées aujourd'hui
  (2/20/15s) — sinon toute suite existante qui vérifie un délai de
  convergence (`stp-rstp.test.ts`, `stp-pvst.test.ts`, etc.) casse sans
  rapport avec l'objectif réel de la phase.
- **Décalage documentaire déjà observé une fois dans cette série** (le même
  jour, avec `docs/PRD-Exchange.md` devenu obsolète en quelques minutes
  suite à un pull upstream) : §0.1 documente que `docs/PRD-VLAN.md` §1.3
  item 6 et `docs/PRD-VTP.md` §2.2 tiennent pour acquis que MSTP est
  absent du moteur, alors qu'il y est en réalité déjà. Ce PRD ne corrige
  pas ces deux documents (hors périmètre, cf. §2.2) mais le signale
  explicitement pour éviter qu'un futur lecteur ne re-découvre la même
  incohérence sans contexte.
- **Ne pas confondre P5 (fidélité de l'arithmétique Extended System ID) et
  le non-objectif §2.2 sur l'interopérabilité multi-région MSTP** — ce sont
  deux couches différentes (l'une est un détail d'encodage de priorité
  toujours actif, l'autre une négociation inter-région qui n'existe pas du
  tout) ; les garder séparées évite qu'une correction de P5 soit
  interprétée à tort comme un prérequis ou un début de P2.2's exclusion.
- **BackboneFast (P6) et UplinkFast (déjà partiel, non-objectif §2.2)** :
  bien distinguer dans les tests que P6 rend BackboneFast fonctionnellement
  actif alors qu'UplinkFast reste volontairement partiel — ne pas étendre
  P6 par effet d'entraînement à « compléter aussi UplinkFast », qui reste
  hors périmètre de ce PRD.

## 8. Critères d'acceptation

- Deux switches reliés par deux liens physiques bundlés via
  `channel-group`/`eth-trunk` (LACP actif des deux côtés) : `show
  spanning-tree`/`display stp brief` montrent une seule interface logique
  `Po<n>`/`Eth-Trunk<n>` avec un seul rôle/état, et aucun port physique
  membre n'apparaît avec un rôle STP séparé.
- Un troisième lien parallèle entre les deux mêmes switches, **non**
  intégré au bundle, est toujours bloqué par STP comme aujourd'hui (aucune
  régression du cas non-bundlé).
- Un Max Age non-défaut configuré uniquement sur la racine est bien celui
  utilisé pour le vieillissement des infos BPDU sur un switch non-racine à
  distance de plusieurs sauts ; une BPDU dont le Message Age simulé dépasse
  ce Max Age est rejetée à la réception.
- Après suppression de la source d'une BPDU supérieure sur un port en Root
  Guard, le port redevient `consistent` et reconverge sans intervention
  manuelle, dans un délai de l'ordre de deux Hello Time.
- `spanning-tree cost`/`spanning-tree port-priority` (et équivalents
  Huawei) changent effectivement le port racine élu sur une topologie à
  deux chemins de coût égal par défaut.
- Deux VLAN configurés avec la même priorité de pont élisent des `BridgeId`
  différents (Extended System ID appliqué en interne, pas seulement à
  l'affichage), et la valeur affichée par `show spanning-tree` correspond
  exactement à celle utilisée par l'élection.
- `backbonefast` actif raccourcit mesurablement le délai de reconvergence
  observé face à une BPDU inférieure sur un port bloqué, comparé à
  `backbonefast` inactif sur la même séquence d'événements.
- `errdisable recovery cause bpduguard` avec un intervalle configuré relève
  automatiquement un port mis en err-disable par BPDU Guard, sans
  intervention manuelle.
- Les 17 suites de tests STP existantes (§0) passent toujours sans
  modification de leurs assertions à l'issue de l'ensemble des phases.

# Audit — Protocoles de couche 2 et commutation

Périmètre couvert : `src/network/stp/`, `src/network/vtp/`, `src/network/dtp/`, `src/network/lacp/`,
`src/network/cdp/`, `src/network/lldp/`, `src/network/udld/`, `src/network/igmp-snooping/`,
`src/network/arp/` (volet inspection ARP/DAI), `src/network/dot1x/`, la logique VLAN/trunk de
`src/network/devices/{CiscoSwitch,HuaweiSwitch,GenericSwitch,Switch,Hub}.ts`, la couche physique
`src/network/hardware/{Port,Cable,PortSecurity}.ts`, et les commandes `show`/`display` associées dans
`src/network/devices/shells/{CiscoSwitchShell,HuaweiSwitchShell}.ts`.

Méthode : lecture intégrale du code (pas seulement des signatures), lecture croisée engine ↔ commandes
`show`/`display`, vérification par `grep` de l'absence d'accès direct inter-équipements, et consultation
des suites de tests (`src/__tests__/unit/network-v2/`) pour confirmer la couverture réelle des
fonctionnalités déclarées.

## Synthèse

| Sous-système | État global | Sévérité max |
|---|---|---|
| STP/RSTP/PVST+ (`stp/`) | Bon moteur CST/PVST+, mais **MSTP entièrement factice** et plusieurs gardes décoratives | **CRITIQUE** |
| VTP (`vtp/`) | Très solide (v1/v2/v3, pruning, élection Primary Server v3) | Aucun défaut majeur |
| DTP (`dtp/`) | Solide, table de résolution conforme Cisco | Mineur |
| LACP (`lacp/`) | Solide, timers 802.3ad corrects | Mineur (mux simplifiée, pas de port-priority/max-bundle) |
| CDP / LLDP | Solide, timers par défaut conformes | Aucun défaut majeur |
| UDLD | Solide, machine à états fidèle | Mineur |
| IGMP Snooping | Solide, entièrement piloté par paquets réels | Mineur |
| 802.1X (`dot1x/`) | Remarquablement complet (EAPOL + relais RADIUS) | Mineur (incohérence d'architecture) |
| ARP / DAI (`arp/`) | DAI réelle, intégrée au pipeline de trames | Mineur (hors-scope : ARP de base pas ici) |
| VLAN/Trunk (`Switch.ts`) + Port/Cable | Excellent — 802.1Q, QinQ, PVLAN, apprentissage MAC réels | Mineur |
| Cohérence Cisco/Huawei (génie logiciel) | Duplication notable, shells monolithiques | Mineur/Modéré |

**Verdict global de fidélité "paquets réels" : CONFORME.** Aucune preuve d'accès direct entre
équipements n'a été trouvée dans tout le périmètre — voir section dédiée ci-dessous.

## Constats par sous-système

### STP / RSTP / PVST+ (`src/network/stp/`)

✅ **Points solides**
- Échange de BPDU réellement construites et acheminées trame par trame : `StpAgent.sendBpdu` construit
  un `EthernetFrame` puis appelle `this.host.sendFrame(portName, frame)` (`src/network/stp/StpAgent.ts:635-681`),
  qui descend par `Port.sendFrame → Cable.transmit → Port.receiveFrame` (`src/network/hardware/Port.ts:675-743`,
  `src/network/hardware/Cable.ts:270-333`) jusqu'à `CiscoSwitch.handleFrame` qui redirige vers
  `stpAgent.handleFrame(portName, frame)` (`src/network/devices/CiscoSwitch.ts:192-195`). Aucun accès direct
  à l'état d'un autre agent.
- Élection de racine conforme 802.1D §8.5 avec les bons départages : coût cumulé, ID du pont
  émetteur, ID de port émetteur, ID de port récepteur (`src/network/stp/StpVlanInstance.ts:102-199`,
  fonction `rootPathPreference`).
- Timers par défaut corrects : hello 2 s, max-age 20 s, forward-delay 15 s (`src/network/stp/types.ts:93-109`).
- Coûts de chemin conformes à la révision 802.1D-1998 (10 Mb=100, 100 Mb=19, 1 Gb=4, 10 Gb=2) —
  `src/network/stp/types.ts:111-125`.
- Instances par VLAN réelles pour PVST+ (`Map<number, StpVlanInstance>`, `StpAgent.ts:43,91-95`), avec
  filtrage correct des VLAN réellement portées par chaque port trunk (`Switch.getStpPortVlans`,
  `src/network/devices/Switch.ts:1423-1439`, respecte `trunkAllowedVlans` et le pruning VTP).
  BPDU Guard, PortFast, Root Guard, TCN et fast-aging MAC sont implémentés et branchés sur de vrais
  événements de trame (`StpAgent.ts:337-422` pour les gardes, `:515-573` pour TCN, `:608-614` pour le
  fast-aging).
- Les commandes `show spanning-tree*` lisent l'état vivant de l'agent (rôle, état, coût, root bridge)
  et ne fabriquent aucune valeur : `src/network/devices/shells/CiscoSwitchShell.ts:3211-3374`
  (`showSpanningTree`, `showStpRoot`, `showStpBridge`, `showStpDetail`) appellent systématiquement
  `stpAgentOf(sw)` puis les getters `getPortRoleForVlan`/`getForwardStateForVlan`/`getRootBridgeForVlan`.

❌ **[CRITIQUE] MSTP n'existe pas réellement, seulement en façade**
- Le type `StpProtocolMode` ne connaît que `'stp' | 'rstp'` (`src/network/stp/types.ts:24`).
  La commande `spanning-tree mode mst` est acceptée puis **silencieusement remappée vers `'rstp'`** :
  `m === 'rapid-pvst' || m === 'mst' ? 'rstp' : 'stp'` (`src/network/devices/shells/CiscoSwitchShell.ts:1347-1348`).
- `mapMstInstance`/`getMstRegion` (`StpAgent.ts:203-211`) ne font que stocker un nom de région, une
  révision et une table `instance → liste de VLAN` — cette table **n'est jamais consultée par le moteur
  d'élection**. Il n'existe qu'une seule arborescence CST/RSTP réelle par commutateur.
- `showMstInstances` (`CiscoSwitchShell.ts:1650-1687`) fabrique un tableau qui *a l'air* d'un état
  par instance MSTI, mais lit en réalité toujours `agent.getPortRole(name)` et `sw._getSTPStates()`
  — c'est-à-dire l'état de l'unique instance CST/VLAN 1 — pour **chaque** instance MST affichée,
  qu'elle soit mappée à VLAN 10 ou VLAN 999. Deux instances MST distinctes afficheront donc des rôles
  et coûts identiques quels que soient les VLAN réellement mappés.
- Confirmé côté Huawei : `display stp instance <id>` appelle aussi `displayStpBrief(undefined, id)`
  sans état par instance dédié (`src/network/devices/shells/HuaweiSwitchShell.ts:2444-2452`).
- Confirmé par les tests : `stp-pvst.test.ts` et `stp-rstp.test.ts` existent, **aucun `stp-mst.test.ts`**
  n'existe ; les tests MST présents (`cisco-stp.test.ts`, `huawei-stp.test.ts`) ne vérifient que
  l'acceptation syntaxique de la CLI (`config-mst`, stockage nom/révision), jamais une élection par
  instance.
- Référence standard : IEEE 802.1Q-2014 clause 13 (MSTP) exige une CIST + des MSTI indépendantes avec
  leurs propres racines, coûts et rôles de port par instance — rien de tout cela n'est présent.

❌ **[MAJEUR] Garde-fous configurables mais jamais appliqués (BPDU Filter, Loop Guard, UplinkFast, BackboneFast)**
- `setBpduFilterGlobal`, `setLoopGuardGlobal`, `setUplinkFast`, `setBackboneFast` (`StpAgent.ts:319-322`)
  ne font que stocker un booléen dans `StpConfig` et l'imprimer dans `show spanning-tree summary`
  (`StpAgent.ts:323-335`, `CiscoSwitchShell.ts:1517-1521`). Une recherche exhaustive (`grep`) confirme
  qu'aucun autre point du code ne lit `bpduFilterGlobal`, `loopGuardGlobal`, `uplinkFast` ou
  `backboneFast` pour modifier un comportement — ni suppression d'émission de BPDU, ni blocage
  loop-inconsistent, ni bascule immédiate.
- Pire, il n'existe **aucune commande d'interface** pour `spanning-tree bpdufilter enable/disable` ni
  `spanning-tree guard loop` : dans `configIfTrie.registerGreedy('spanning-tree', …)`
  (`CiscoSwitchShell.ts:1414-1447`) seuls `portfast`, `bpduguard` et `guard root` sont réellement câblés
  sur l'agent ; toute autre sous-commande (dont `bpdufilter enable`, testée dans
  `cisco-stp.test.ts:97`) est seulement poussée dans une liste `ifStp` utilisée pour l'affichage — elle
  n'a **aucun effet fonctionnel**.
- Conséquence concrète : configurer `spanning-tree bpdufilter enable` sur un port d'accès ne supprime
  pas l'émission/réception de BPDU, contrairement au comportement Cisco documenté ; configurer
  `spanning-tree loopguard default` n'empêchera jamais un port non désigné de repasser forwarding par
  erreur en cas de BPDU manquantes (comportement loop-inconsistent absent).

❌ **[MAJEUR] Format de trame PVST+ non fidèle**
- Toutes les BPDU (802.1D classique, RSTP, et le "PVST+" par VLAN) utilisent la même adresse
  destination `01:80:c2:00:00:00` (`src/network/stp/types.ts:2`, `STP_BRIDGE_MAC`). Le VLAN est
  transporté comme un simple champ `vlan?: number` à l'intérieur du payload logique du BPDU
  (`types.ts:29`), et non via un tag 802.1Q ou l'encapsulation SNAP propriétaire Cisco réelle
  (destination `01:00:0c:cc:cc:cc`, OUI `00:00:0c`, protocole `0x010b`).
- De plus, `sendBpdu` construit la trame directement (`StpAgent.ts:662-667`) et appelle
  `host.sendFrame` sans jamais passer par le pipeline de tagging 802.1Q de `Switch.ts`
  (`Switch.sendFrame`, `Switch.ts:2072-2074`, ne fait que déléguer à `Equipment.sendFrame` — tout le
  tagging dot1Q vécu par les trames de données normales, lignes 1960-2070, n'est **jamais appliqué aux
  BPDU**). Le résultat fonctionnel (élection correcte par VLAN) est correct car les deux extrémités
  interprètent le même champ `vlan` de façon cohérente, mais ce n'est pas une reproduction fidèle du
  format de trame PVST+ réel — un test qui capturerait le trafic attendrait un tag 802.1Q ou une trame
  SNAP et ne le trouverait pas.

⚠️ **Manque : synchronisation RSTP incomplète (802.1w §17.23-17.25)**
- Sur réception d'une proposition, le port racine passe directement en *forwarding* et une trame
  d'agrément est renvoyée (`StpAgent.ts:483-491`), sans l'étape *Sync* qui, dans la vraie norme,
  rebloque temporairement tous les ports désignés non-edge avant d'accepter la proposition — c'est
  cette étape qui garantit l'absence de boucle transitoire durant la convergence rapide. Le résultat
  final converge correctement grâce au recalcul de coût, mais la garantie "zéro boucle transitoire"
  du 802.1w n'est pas modélisée telle quelle.

⚠️ **Root Guard : rôle affiché divergent de Cisco réel**
- Un port bloqué par Root Guard reçoit le rôle `'alternate'` (`src/network/stp/StpVlanInstance.ts:140`),
  alors que le vrai IOS affiche le port comme `Desg BKN*` (désigné, état *broken*, note
  `*ROOT_Inc`). Le blocage fonctionnel est correct, seule la terminologie d'affichage diverge —
  point mineur si l'objectif est la conformité visuelle avec `show spanning-tree`.

⚠️ **Pas de `spanning-tree link-type` manuel**
- Le type de lien p2p/partagé est déduit uniquement de `Port.getDuplex() === 'half'`
  (`StpAgent.ts:190-193`), sans possibilité de forcer `point-to-point`/`shared` via la CLI comme le
  permet IOS — cas rare en pratique (semi-duplex forcé) mais un vrai gap de configurabilité.

⚠️ **`errdisable recovery` incomplet pour BPDU Guard / UDLD**
- Seules les causes `psecure-violation` et `arp-inspection` sont câblées sur le minuteur de
  récupération automatique (`CiscoSwitchShell.ts:461-467,948`). Aucune commande
  `errdisable recovery cause bpduguard` ni `cause udld` n'existe. La récupération manuelle
  (`shutdown` / `no shutdown`) fonctionne bien car `setIfAdminState` appelle directement
  `port.setUp(true)` (`CiscoSwitchShell.ts:4254-4260`), indépendamment de la cause du err-disable —
  donc ce n'est qu'un gap d'automatisation, pas un blocage définitif.

💡 **Amélioration** : `display stp topology-change` côté Huawei est **entièrement codé en dur** à zéro
(`src/network/devices/shells/HuaweiSwitchShell.ts:2374-2379` — "Number of topology changes : 0" toujours),
alors que le moteur STP suit réellement `tcFlagActive`/`notifyTopologyChange` (`StpAgent.ts:529-557`) :
c'est un cas où la donnée existe dans le moteur mais n'est pas branchée sur l'affichage.

### VTP (`src/network/vtp/`)

✅ Implémentation très aboutie et rare dans un simulateur : Summary/Subset Advertisement réels
échangés sur trunk uniquement (`VtpAgent.ts:136-230`, vérifie `vtpIsTrunkPort`), hash de mot de passe
par domaine (`hashPassword`), pruning VTP piloté par de vrais messages *Join* avec agrégation des
intérêts VLAN par port (`VtpAgent.ts:300-331`), élection de Primary Server VTPv3 avec revendication
forcée/non forcée (`VtpAgent.ts:237-269`), détection d'*orphan subset* (Subset reçu sans Summary
correspondante — `VtpAgent.ts:204-208`), ce qui est un détail de robustesse rarement modélisé. Aucun
défaut majeur relevé.

### DTP (`src/network/dtp/`)

✅ Table de résolution du mode opérationnel strictement conforme au comportement Cisco documenté
(`src/network/dtp/types.ts:59-74`) : `dynamic-auto` + `dynamic-auto` distant = `access` (aucune
négociation ne démarre, comme sur le matériel réel), `dynamic-desirable` + `dynamic-desirable` =
`trunk`, `nonegotiate` ne négocie jamais et n'émet aucune trame (`DtpAgent.ts:114`,`154`).
Expiration du voisin après 5× l'intervalle hello, comme IOS (`DtpAgent.ts:196-198`).

### LACP (`src/network/lacp/`)

✅ Échange réel de LACPDU, comparaison de System ID conforme, timers 802.3ad corrects : *slow* 30 s,
*fast* 1 s, `current_while` = 3× l'intervalle demandé (`LacpAgent.ts:207-221`), état `expired` puis
`defaulted` après grâce de 3 s (`LacpAgent.ts:220-253`), conforme à 802.3ad §43.4.12.

⚠️ **Machine mux simplifiée** : les états *Collecting*/*Distributing* sont dérivés directement de
`state === 'bundled'` sans délai `wait_while_timer` (`src/network/lacp/types.ts:77-89`,
`buildActorState`) — la collecte démarre instantanément, alors que le matériel réel introduit un
court différé.

⚠️ **Pas de `lacp port-priority` configurable** — valeur figée à `32768` (`LacpAgent.ts:163`), aucune
commande CLI trouvée pour la modifier.

⚠️ **Pas de limite de bundle (max 8 actifs + standby)** — `runSelection` (`LacpAgent.ts:302-331`)
agrège tous les ports du groupe sans jamais placer les excédentaires en *standby*, contrairement au
comportement réel où LACP sélectionne les 8 meilleurs liens par priorité de port/système et met le
reste en attente.

### CDP / LLDP (`src/network/cdp/`, `src/network/lldp/`)

✅ Les deux protocoles sont des moteurs d'annonce/expiration réels pilotés par trames, avec des
valeurs par défaut conformes : CDP timer 60 s / holdtime 180 s (`CdpAgent.ts` defaults via
`createDefaultCdpConfig`), LLDP timer 30 s / hold-multiplier 4 (→ TTL 120 s), reinit-delay 2 s,
**désactivé par défaut** (`src/network/lldp/types.ts:44-55`) — ce dernier point est correct : IOS
moderne exige `lldp run` explicite, ce que le simulateur reproduit fidèlement.

### UDLD (`src/network/udld/`)

✅ Protocole probe/echo réel avec liste d'échos reflétant les voisins vus, détection de
bidirectionnalité par auto-référence dans la liste d'échos du voisin (`UdldAgent.ts:148-158`),
compteur de tentatives en mode agressif menant à l'err-disable (`UdldAgent.ts:303-315`), machine à
états `unknown/bidirectional/unidirectional/err-disable/shutdown` fidèle au fonctionnement Cisco.

### IGMP Snooping (`src/network/igmp-snooping/`)

✅ Entièrement piloté par de vrais paquets IGMP transitant dans `Switch.handleFrame`, apprentissage
des ports routeur par réception de *Membership Query*, gestion *immediate-leave*, expiration de
groupe par `groupMembershipSec`. Conforme au modèle Cisco IGMP snooping standard.

### 802.1X (`src/network/dot1x/`)

✅ Remarquablement complet pour un simulateur : machine à états complète du port authentificateur
(*unauthorized/authenticating/authorized/held*), minuteur de période silencieuse (§8.2 de
802.1X-2004), relais RADIUS réel des rounds EAP (MD5-Challenge, TLS, PEAP, TTLS) vers un backend
RADIUS, attribution dynamique de VLAN depuis un Access-Accept (RFC 3580 §3.31) —
`src/network/dot1x/Dot1xAgent.ts:220-267`.

⚠️ **Incohérence d'architecture mineure** : contrairement à tous les autres agents L2, `Dot1xAgent`
n'étend pas `ReactiveAgentBase` (`src/network/core/ReactiveAgentBase.ts`) et réimplémente son propre
`start()/stop()` et son propre `TimerSet` (`Dot1xAgent.ts:43-65`) — pas un défaut fonctionnel, mais un
écart au patron partagé documenté par CLAUDE.md ("follow this pattern when adding a new protocol").

### ARP / Inspection dynamique (`src/network/arp/`)

✅ Le sous-dossier `arp/` de ce périmètre est exclusivement la fonctionnalité de sécurité **Dynamic
ARP Inspection** (DAI), pas la résolution ARP de base (RFC 826, qui vit dans
`devices/linux/LinuxArp.ts`, `devices/windows/WinArp.ts`, `devices/EndHost.ts` — hors du périmètre
strict de cet audit L2/commutation). `ArpInspectionPipeline.process()` est appelée en ligne dans le
pipeline de trames du switch (`Switch.ts`, étape 1.5, avant la décision de forwarding), avec limitation
de débit par jeton (`ArpRateLimiter.ts`), vérification de binding DHCP snooping, listes de contrôle
d'accès ARP et err-disable — implémentation solide et réellement branchée sur le flux de trames.

### VLAN / Trunk (`Switch.ts`) et couche physique (`Port.ts`, `Cable.ts`, `PortSecurity.ts`)

✅ Le cœur de commutation est d'excellente facture :
- Tagging 802.1Q réel (ajout/retrait de tag à l'émission selon le mode de port — access, trunk,
  hybrid, dot1q-tunnel/QinQ — `Switch.ts:1960-2070`), gestion du VLAN natif, filtrage par
  `trunkAllowedVlans`, PVLAN, intégration du pruning VTP dans le chemin de flooding
  (`Switch.floodFrame`, `Switch.ts:1960-2010`, appelle `getVtpAgentOrNull()?.isVlanPruned`).
- Le flooding et le forwarding unicast respectent l'état STP par port ET par VLAN
  (`getStpVlanState`, blocage sur `blocking/disabled/listening`) — `Switch.ts:1649-1652,1968`.
- Table d'adresses MAC clé `(vlan, mac)` avec vieillissement à 300 s par défaut, conforme au
  comportement Cisco par défaut (`Switch.ts:211` et alentours).
- `Port.ts`/`Cable.ts` modélisent une vraie liaison point-à-point : `Port.sendFrame → Cable.transmit
  → Port.receiveFrame` (`Cable.ts:270-333`), avec négociation de vitesse/duplex réaliste
  (`Port.negotiate`, `Cable.negotiateLink`), détection de mismatch duplex, délai de propagation
  calculé (bien que la livraison reste synchrone — limitation assumée et documentée dans le code,
  `Cable.ts:264-269`, avec une migration vers un scheduler asynchrone notée comme travail futur).
- `PortSecurity.ts` implémente fidèlement sticky/static/dynamic, 3 modes de violation, deux types de
  vieillissement (absolute/inactivity), avec évaluation appelée en ligne dans
  `Port.receiveFrame` (`Port.ts:709-728`) — pas de logique dupliquée ni de contournement trouvé.

⚠️ `GenericSwitch` (commutateur non managé) ne câble **aucun agent** protocolaire (pas de STP, pas de
CDP/LLDP/LACP — `GenericSwitch.ts` n'importe aucun agent) : c'est en réalité fidèle à un vrai
commutateur non managé (qui ne parle ni STP ni CDP), mais cela signifie qu'un utilisateur créant une
boucle physique entre deux `GenericSwitch` provoquera une tempête de broadcast sans aucune protection
— comportement réaliste, mais à documenter clairement dans l'UI/le manuel du simulateur pour éviter
la confusion pédagogique.

### Cohérence Cisco / Huawei — génie logiciel

✅ `ReactiveAgentBase` (`src/network/core/ReactiveAgentBase.ts`) est un bon patron *Template Method*
partagé par la quasi-totalité des agents (CDP, LLDP, DTP, VTP, UDLD, LACP, STP, IGMP snooping),
factorisant ~30-50 lignes de gestion de minuteurs/abonnements par agent — réduit sensiblement la
duplication attendue dans ce genre d'architecture multi-protocoles.

❌ **[MINEUR] Duplication de câblage Cisco/Huawei** : `CiscoSwitch.ts:56-115` et
`HuaweiSwitch.ts:31-65` répètent presque à l'identique la construction de l'objet `hostBase`, la
création des agents partagés (STP, LACP, LLDP, IGMP snooping, 802.1X) et les mêmes callbacks
(`applyStpForwardState`, `applyDot1xAuth`). Un helper commun dans `Switch.ts` (par ex.
`wireSharedAgents()`) réduirait cette redite, même si le sous-ensemble d'agents propriétaires
(CDP/DTP/VTP uniquement côté Cisco) empêche une unification totale.

❌ **[MINEUR/MODÉRÉ] Shells monolithiques** : `CiscoSwitchShell.ts` (4447 lignes) et
`HuaweiSwitchShell.ts` (3165 lignes) concentrent chacun des dizaines de familles de commandes
(STP, VLAN, ACL, DHCP, IPSec, OSPF, NAT…) dans une seule classe — alors que le sous-dossier
`shells/cisco/` montre déjà un appétit pour la décomposition par protocole (`CiscoOspfCommands.ts`,
`CiscoAclCommands.ts`, etc.). La logique d'affichage STP/VTP/DTP/LACP reste, elle, inline dans le
fichier géant plutôt que d'suivre ce même découpage — un smell de type *God Object* qui complique la
maintenance à mesure que de nouvelles familles de commandes L2 sont ajoutées.

## Communication par paquets : verdict

**Le point critique du client est validé : les échanges inter-équipements passent bien par de vrais
paquets circulant sur les Ports/Cables, pas par un calcul global ou un accès direct aux objets
d'autres équipements.**

Preuves croisées :
- Chaque agent (`StpAgent`, `VtpAgent`, `DtpAgent`, `LacpAgent`, `CdpAgent`, `LldpAgent`, `UdldAgent`,
  `IgmpSnoopingAgent`, `Dot1xAgent`) suit rigoureusement le même schéma : construire une structure PDU
  typée → l'envelopper dans un `EthernetFrame` → `host.sendFrame(port, frame)` → `Port.sendFrame` →
  `Cable.transmit` → `Port.receiveFrame` du pair → dispatch par `etherType` dans
  `CiscoSwitch.handleFrame`/`HuaweiSwitch.handleFrame` (`CiscoSwitch.ts:177-219`,
  `HuaweiSwitch.ts:83-107`) → `xxxAgent.handleFrame(portName, frame)`.
- Une recherche exhaustive (`grep -rn "EquipmentRegistry\|getPeerEquipment\|peerAgent"` sur tout le
  périmètre L2) ne remonte **aucun résultat** dans `stp/`, `vtp/`, `dtp/`, `lacp/`, `cdp/`, `lldp/`,
  `udld/`, `igmp-snooping/`, `dot1x/`, `arp/` — aucune trace d'un mécanisme de convergence "par magie".
- Un câble débranché déclenche un vrai événement de liaison (`Port.disconnectCable` →
  `notifyLinkChange('down')` → `port.link.down` sur le bus), auquel chaque agent réagit via son hook
  `onPortLinkDown` (ex. `StpAgent.onPortLinkDown`, `StpAgent.ts:714-725`, qui oublie le port dans
  chaque instance VLAN et relance l'élection ; `LacpAgent.onPortLinkDown`, `LacpAgent.ts:272-288`, qui
  débande le port et republie l'événement) — la réaction passe par la disparition des BPDU/LACPDU
  suivie d'un timeout (`expireStaleBpduInfo` sur maxAge, `expireDue` sur `rxTimeoutMs` pour LACP,
  etc.), pas par une notification directe et instantanée "sait que le voisin est mort".
- Seule réserve : la livraison sur `Cable.transmit` est **synchrone** (pas de délai de propagation
  simulé dans l'ordonnanceur — `Cable.ts:322-326`), ce qui est un raccourci de performance assumé et
  documenté dans le code lui-même, pas un raccourci de logique protocolaire. Il n'affecte pas le
  verdict "paquets réels", seulement le réalisme temporel fin (jitter/latence) des convergences.

## Top 10 des actions recommandées (priorisées)

1. **[CRITIQUE]** Implémenter un vrai moteur MSTP (CIST + MSTI indépendantes, élection par instance
   à partir de la table VLAN→instance déjà stockée dans `MstRegion`) au lieu de l'alias
   `mst → rstp` et de l'affichage fabriqué de `showMstInstances`/`display stp instance`.
   *(`src/network/stp/StpAgent.ts`, `types.ts`, `CiscoSwitchShell.ts:1650-1687`,
   `HuaweiSwitchShell.ts:2444-2452`)*
2. **[MAJEUR]** Rendre Loop Guard et BPDU Filter réellement actifs (blocage loop-inconsistent en
   l'absence de BPDU sur un port non désigné ; suppression effective de l'émission/réception BPDU) —
   actuellement de purs indicateurs de configuration sans effet. Ajouter aussi les commandes
   d'interface manquantes (`spanning-tree bpdufilter enable`, `spanning-tree guard loop`).
   *(`StpAgent.ts:314-335`, `CiscoSwitchShell.ts:1414-1447`)*
3. **[MAJEUR]** Modéliser fidèlement le format de trame PVST+ (encapsulation SNAP vers
   `01:00:0c:cc:cc:cc`, ou a minima un vrai tag 802.1Q) au lieu du champ `vlan` interne au payload
   logique sur une trame non taguée. *(`StpAgent.ts:635-681`, `types.ts:2,29`)*
4. **[MODÉRÉ]** Câbler `errdisable recovery cause bpduguard` et `cause udld` sur l'infrastructure de
   minuteur déjà existante pour `psecure-violation`/`arp-inspection`.
   *(`CiscoSwitchShell.ts:461-467,948`)*
5. **[MODÉRÉ]** Ajouter l'étape *Sync* du RSTP (802.1w) — reblocage des ports désignés non-edge avant
   l'envoi de l'agrément — pour une fidélité complète à la garantie anti-boucle transitoire.
   *(`StpAgent.ts:483-491`)*
6. **[MODÉRÉ]** Soit implémenter un comportement réel pour UplinkFast/BackboneFast, soit retirer ces
   commandes/indicateurs de `show spanning-tree summary` pour ne pas laisser croire à une fonctionnalité
   active. *(`StpAgent.ts:321-322,332-333`)*
7. **[MINEUR]** Ajouter la limite de bundle LACP (8 actifs + standby, sélection par
   system-priority/port-priority) et rendre `lacp port-priority` configurable.
   *(`LacpAgent.ts:163,302-331`)*
8. **[MINEUR]** Ajouter `spanning-tree link-type point-to-point|shared` en commande d'interface au
   lieu de dériver uniquement du duplex. *(`StpAgent.ts:190-193`)*
9. **[MINEUR]** Faire hériter `Dot1xAgent` de `ReactiveAgentBase` comme les autres agents, pour la
   cohérence architecturale documentée dans `CLAUDE.md`. *(`Dot1xAgent.ts:43-65`)*
10. **[MINEUR]** Réduire la duplication de câblage d'agents entre `CiscoSwitch.ts` et
    `HuaweiSwitch.ts` via un helper partagé dans `Switch.ts`, et brancher
    `display stp topology-change` (Huawei) sur l'état réel de `tcFlagActive` au lieu de valeurs
    codées en dur. *(`CiscoSwitch.ts:56-115`, `HuaweiSwitch.ts:31-65`, `HuaweiSwitchShell.ts:2374-2379`)*

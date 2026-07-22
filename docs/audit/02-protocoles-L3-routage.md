# Audit — Routage et protocoles de couche 3

**Périmètre** : `src/network/{ospf,bgp,eigrp,rip,routing,bfd,hsrp,vrrp,glbp,pim,igmp}`, `src/network/core/RoutingTable.ts`, forwarding IP dans `src/network/devices/Router.ts` + `devices/router/` (ACL, NAT, IPv6, dynamic routing, redundancy, policy, NHRP), et cohérence état interne ↔ sorties CLI (`show`/`display`).
**Méthode** : lecture profonde du code, vérification croisée engine ↔ intégration ↔ CLI ↔ tests. Suites exécutées : `ospf.test.ts`, `bgp-engine.test.ts` (57 tests OK), `ospf-packet-exchange.test.ts`, `eigrp-wire.test.ts`, `bgp-session.test.ts`, `ospf-timers-aging.test.ts` (71 tests OK).
**Date** : 2026-07-22.

---

## Synthèse

| Protocole / sous-système | État global | Sévérité max |
|---|---|---|
| OSPFv2 (engine) | ✅ Solide — FSM, DD/LSR/LSU/LSAck, SPF, flooding réels sur le câble | MINEUR |
| OSPFv2 (intégration routeur) | ⚠️ Hybride — routes inter-area/externes calculées en « god-view », RIB non resynchronisée en autonome | **MAJEUR** |
| OSPFv3 | ❌ Façade — aucune trame, adjacences synthétiques, routes copiées des tables distantes | **CRITIQUE** |
| BGP (engine + Cisco) | ✅ Solide — vraies sessions TCP/179, FSM RFC 4271, best-path complet | MAJEUR (manques fonctionnels) |
| BGP (Huawei) | ❌ Fabriqué — `display bgp peer` inventé, aucun lien avec le vrai engine | **CRITIQUE** |
| EIGRP | ✅/⚠️ Trames proto-88 réelles, DUAL FC correct ; pas de QUERY/REPLY ni timers réels | MAJEUR |
| RIPv2 | ✅ Solide — le plus autonome : timers réels, UDP/520 réel, RFC 2453 quasi complet | MINEUR |
| RIB / forwarding IPv4 | ✅/⚠️ LPM + AD corrects ; pas d'ECMP au FIB, pas de récursivité next-hop | MAJEUR |
| ACL | ✅/❌ Ordre + implicit deny + wildcards corrects ; ACL inexistante = deny all (inverse d'IOS) | MAJEUR |
| NAT | ✅ Solide — static/PAT/pool, RFC 5508, FTP ALG ; ACL out évaluée avant NAT (ordre IOS inversé) | MINEUR |
| HSRP / VRRP / GLBP | ✅ Solide — paquets réels, MACs virtuelles et timers conformes | MINEUR |
| BFD | ⚠️ Paquets réels mais **non couplé** aux protocoles de routage (aucun fast-failover) | MAJEUR |
| PIM / IGMP | ⚠️ Contrôle réel (hello/join-prune/query/report) mais **aucun forwarding multicast de données** | MAJEUR |
| NHRP / route-policy / prefix-list | ❌ Magasins de configuration uniquement, jamais évalués | MAJEUR |

---

## Constats par protocole

### 1. OSPFv2 — `src/network/ospf/OSPFEngine.ts` (3 853 lignes)

#### ✅ Ce qui est bien fait (et c'est substantiel)

- **Machine à états de voisinage RFC 2328 §10.1 complète** : `neighborEvent()` (`OSPFEngine.ts:1268-1429`) traite Start/HelloReceived/TwoWayReceived/NegotiationDone/ExchangeDone/LoadingDone/AdjOK/SeqNumberMismatch/BadLSReq/OneWay/KillNbr/LLDown/InactivityTimer avec les transitions exactes Down→Attempt→Init→2-Way→ExStart→Exchange→Loading→Full.
- **Hello §9.5/§10.5 réel** : validation mask/hello-interval/dead-interval (`OSPFEngine.ts:1164-1168`), détection 2-Way par présence dans la liste `neighbors` du Hello reçu (`:1197-1210`), événements BackupSeen/NbrChange (`:1213-1235`).
- **Dead timer réel** : `resetDeadTimer()` arme un vrai timer wall-clock (`OSPFEngine.ts:1441-1447`, scheduler `RealTimeScheduler`, `src/events/Scheduler.ts:37-52`) qui déclenche `InactivityTimer` → suppression du voisin + réélection DR (`:1384-1400`). La panne de lien est donc détectée par expiration du dead-interval, pas par notification magique.
- **Élection DR/BDR §9.4** (`OSPFEngine.ts:1563-1674`) : deux passes (BDR puis DR, re-élection BDR si promu), priorité 0 = inéligible, second-pass RFC. Testée par `ospf-dr-election.test.ts`.
- **Échange de bases DD/LSR/LSU/LSAck §10.6-10.8 et flooding §13 sur le fil** : master/slave par Router-ID, flags INIT/MORE/MASTER (`:1686-1832`), `processLSUpdate` (`:1922-2049`) vérifie le **checksum Fletcher-16 (Annexe C.1)** à la réception (`:1944`, implémentation `checksum.ts`), applique **MinLSArrival** (`:1980-1986`), floode avec exclusion d'interface pour broadcast (`:2007-2009`), acquitte par LSAck réel (`:2017-2027`). La suite `ospf-packet-exchange.test.ts` (groupes 1-6) valide séquence DD→LSR→LSU→LSAck, retransmissions et flooding **uniquement via paquets**.
- **LSA types 1-7** : Router (`originateRouterLSA:2207`), Network (`:2327`), Summary 3/4 en tant qu'ABR §12.4.3 (`originateSummariesAsABR:2891`), External 5 (`:2530`), NSSA 7 + traduction 7→5 (`originateNSSAExternalLSA:2466`, `translateNSSAtoExternal:2502`). Vieillissement MaxAge/LSRefreshTime réel (`tickLSAge:3616`), numéros de séquence, MinLSInterval.
- **SPF Dijkstra §16** avec throttle configurable (initial/hold/max, `scheduleSPF:2686`), **SPF partiel** (re-scan feuilles sans Dijkstra quand seuls des LSA 3/4/5/7 changent, `runPartialSPF:2828` — raffinement rare dans un simulateur), routes externes E1/E2 §16.4 avec forwarding-address (`processExternalRoutes:3199`).
- **ECMP calculé** : `mergeRoutesByDestination` (`:3166`) fusionne jusqu'à 16 next-hops à coût égal.
- **Aires stub / totally-stubby / NSSA / totally-NSSA**, virtual-links (`addVirtualLink:674`), aires multiples, `passive-interface`, coût par bande passante de référence, priorités, réseau p2p/broadcast/NBMA.
- **Authentification §8.2 vérifiée avant tout traitement FSM** (`processPacket:3795-3812`) : type + clé comparés, paquet rejeté et loggé en cas de mismatch (testé par `ospf-wire-auth.test.ts`).
- Architecture réactive conforme au pattern maison : Engine + `types.ts` + `events.ts` + `observables.ts` + 8 actors (`actors/`), timers possédés par `TimerSet`, événements bus (`ospf.neighbor.state-changed`, `ospf.spf.run`, …).

#### ❌ Non conforme / irréaliste

- **[CRITIQUE] Routes « avancées » calculées hors protocole, par lecture directe des routeurs distants.** `computeAdvancedRoutes()` (`RouterOSPFIntegration.ts:1239-1506`) fabrique les routes externes (redistribute static/connected/rip, default-information originate), inter-area, stub-default, NSSA et virtual-link en lisant **directement** `peer.ctx.getRoutingTable()`, `peer.extraConfig` et `peer.ospfEngine.getRoutes()` des routeurs distants, avec des next-hops trouvés par BFS sur le graphe d'objets (`findNextHopTo:1511-1641`). C'est une double implémentation : l'engine sait originer les LSA 3/4/5/7 (voir ci-dessus), mais l'intégration court-circuite ce mécanisme par un calcul omniscient. Contraire à l'exigence « toute communication inter-machines par vrais paquets », et source garantie de divergences engine ↔ RIB (ex. la RIB peut contenir une route externe que le LSDB local ne justifie pas — `show ip ospf database` et `show ip route` peuvent se contredire).
- **[MAJEUR] Reconvergence autonome sans effet sur la RIB.** `RoutingTableSyncActor.onRoutes()` n'a **aucun consommateur en production** (grep : seul un test `OSPF.deeperActors.test.ts` l'utilise). Quand un dead timer expire et que `SpfActor` relance SPF, les routes recalculées ne sont **jamais installées** dans la RIB du routeur : l'installation ne se produit que dans `exchangeAndCompute()` → `installRoutes()` (`RouterOSPFIntegration.ts:1646-1713`), déclenché par `autoConverge()` (commande CLI, `show ip route` — `CiscoOspfCommands.ts:2235-2236` — ou remontée de lien, `Router.ts:492-502`). Entre deux commandes, la RIB est **périmée** ; c'est le hack data-plane de `lookupRoute` (routes vers interfaces déconnectées ignorées, `Router.ts:831-847`) qui masque la panne — un raccourci « god-mode » côté FIB.
- **[MAJEUR] Orchestration de convergence centralisée et omnisciente.** `collectOSPFDomain()` (`RouterOSPFIntegration.ts:587-633`) fait un BFS sur les câbles via le registre statique `RouterOSPFIntegration.registry` (`:91`), puis `driveWireConvergence()` (`:322-388`) **pompe les Hellos de tous les routeurs du domaine**, force les élections DR (`WaitTimer accelerator`, `:361-370`) et les retransmissions DD de façon synchrone. Les trames échangées sont réelles (les FSM ne progressent que par `processHello`/`processDD`), mais le déclencheur et la compression temporelle sont magiques : un routeur ne devrait converger que par ses propres timers. Conséquence observable : la convergence est instantanée à chaque `show`, jamais progressive (pas d'état ExStart/Exchange visible transitoirement).
- **[MAJEUR] `collectOSPFDomain` ne traverse qu'un seul niveau de commutateur** (`:612-629` : depuis un switch, on regarde les câbles directs, sans récursion vers un second switch). Deux routeurs séparés par une chaîne SW1—SW2 ne sont pas rassemblés dans la même passe de convergence, alors que les Hellos multicast, eux, traverseraient. Même défaut dans `collectOSPFv3Domain` (`:696-738`) et `findNextHopTo`.
- **[MAJEUR] Adjacences sur tunnels GRE totalement synthétiques** : semées par `formAdjacency()` sans aucune trame (`RouterOSPFIntegration.ts:501-528`, commentaire explicite « no frame transport on virtual ports yet »).
- **[MINEUR] Router-ID auto** : `enableOSPF()` prend la plus haute IP de **toutes** les interfaces (`RouterOSPFIntegration.ts:136-150`) ; IOS préfère la plus haute **loopback** avant les physiques.
- **[MINEUR] Authentification MD5 non hachée** : `authType=2` est accepté mais la « vérification » compare la clé en clair (`OSPFEngine.ts:3802-3805`) ; aucun digest MD5, pas de numéro de séquence cryptographique (RFC 2328 Annexe D). Acceptable en simulation, à documenter.
- **[MINEUR] Code mort** : `sendHello()` — ternaire dont les deux branches renvoient `OSPF_ALL_SPF_ROUTERS` (`OSPFEngine.ts:1138-1140`).

#### Cohérence CLI

- `show ip ospf neighbor` (`CiscoOspfCommands.ts:1338-1352`) lit bien `ospf.getNeighbors()` (état réel de la FSM) — bon point. **Mais** la colonne *Dead Time* affiche l'intervalle configuré statique (`${iface.deadInterval}s`, `:1346`) au lieu du compte à rebours réel (l'engine possède pourtant `lastHelloReceived`). [MINEUR]
- `show ip route` (`CiscoOspfCommands.ts:2234-2268`) déclenche `_ospfAutoConverge()` + `convergeDynamicRouting()` **à chaque exécution** (`:2235-2236`) : le « show » est un acteur de la convergence — c'est ce qui rend le modèle crédible en démo mais irréaliste en comportement (voir constat RIB ci-dessus). Codes O/O IA/O E1/O E2 et format `[110/metric]` corrects.
- `show ip ospf database`, `interface`, `border-routers`, et côté Huawei `display ospf peer/lsdb/brief` lisent le vrai engine (`HuaweiOspfCommands.ts:87-328`, via `_getOSPFEngineInternal()`) — bonne parité Cisco/Huawei pour OSPF.

### 2. OSPFv3 — `src/network/ospf/OSPFv3Engine.ts` (905 lignes)

- **[CRITIQUE] Aucune communication par paquets.** L'engine v3 réutilise la FSM, mais l'intégration fabrique l'adjacence en forgeant localement un faux Hello et en appelant directement `engine.processHello()` du routeur local (`v3FormAdjacency`, `RouterOSPFIntegration.ts:767-794`) ; les Link-LSA sont échangés par appels directs `installRemoteLinkLSA` (`:684-686`). Rien ne transite par les ports.
- **[CRITIQUE] Les routes IPv6 sont copiées des tables distantes** : `v3ComputeRoutes()` (`RouterOSPFIntegration.ts:797-1054`) itère `peer.ctx.getIPv6Engine().getRoutingTableInternal()` des routeurs distants et recopie leurs routes connected/ospf/static avec un next-hop trouvé par BFS objet (`findIPv6NextHopViaBFS:1127`). Aucun SPF v3, aucun LSA type 8/9 réellement floodé (RFC 5340 §4.4). `setRoutes()` réinjecte ensuite ces routes dans l'engine (`:1053`) pour que `show ipv6 ospf` paraisse cohérent — la sortie CLI est cohérente avec un état lui-même fabriqué.
- ⚠️ Manquants v3 : virtual-links v3 (stockés `v3VirtualLinks` mais non exploités par un vrai mécanisme), authentification IPsec réduite à un booléen comparé entre pairs (`:672-676`).

### 3. BGP — `src/network/bgp/` (engine 521 + session 247 + bestPath 87 lignes)

#### ✅ Solide

- **Vraies sessions TCP/179** : `connect()`/`listen()` sur le `TcpStack` du routeur (`RouterDynamicRouting.ts:99-148`), lequel émet de vrais segments SYN/ACK/données via `sendFrame` (`src/network/tcp/TcpStack.ts:242+`). Un pair sans processus BGP ⇒ RST ⇒ état Idle/Active (`:126`). L'engine « never reads a neighbour's engine object » — vérifié : aucune référence à un registre de pairs.
- **FSM RFC 4271 §8** (`BgpSession.ts`) : Idle→OpenSent→OpenConfirm→Established, OPEN avec version/ASN/hold-time/BGP identifier, rejet BAD_PEER_AS (`:138-141`), **négociation du Hold Time au minimum des deux §4.2** (`:146-147`), KEEPALIVE = hold/3 (`:216-222`), **hold timer réel** qui envoie NOTIFICATION Hold Timer Expired §6.5 (`:234-241`), Cease §6.7 (`:112-119`), gestion de collision de connexions §6.8 (`BGPEngine.ts:182-191`).
- **Adj-RIB-In / Loc-RIB / Adj-RIB-Out** distincts (`BGPEngine.ts:102-111`), UPDATE en **delta** (annonces/retraits seulement si changement, `advertiseTo:373-416`), **split-horizon iBGP** (`:380`), **prépend AS_PATH en eBGP seulement** (`:386`), LOCAL_PREF confiné à l'AS §5.1.5 (`:294-296`), **rejet des chemins contenant notre ASN §6.3** (`:249`).
- **Best-path complet** (`bestPath.ts:58-79`) : weight Cisco → LOCAL_PREF → locally-originated → AS_PATH → origin (IGP<EGP<incomplete) → **MED uniquement à AS voisin identique §9.1.2.2** (`:72-74`) → eBGP>iBGP → router-id → IP du pair. AD 20/200 (`BGPEngine.ts:75-76`). Testé par `bgp-bestpath.test.ts`, `bgp-session.test.ts`, `bgp-engine.test.ts` (tous verts).

#### ❌ / ⚠️

- **[CRITIQUE — Huawei] `display bgp peer` et `display bgp routing-table` sont fabriqués** (`HuaweiDisplayCommands.ts:1470-1500`) : lus depuis la façade de configuration `HuaweiRoutingExtras` (`router/routing/HuaweiRoutingExtras.ts`, pur magasin de config), état **toujours « Idle »**, « Peers in established state : 0 » codé en dur, next-hop `0.0.0.0`, compteurs à zéro. Les routeurs Huawei **n'instancient jamais le vrai BGPEngine** : un lab eBGP Cisco↔Huawei est impossible et la sortie ment à l'utilisateur.
- **[MAJEUR] Pas de peering multi-saut** : `egressToward()` exige que le voisin soit sur un subnet directement connecté (`RouterDynamicRouting.ts:135-148`) ⇒ pas d'iBGP entre loopbacks via IGP (pas de résolution récursive du next-hop TCP), pas d'`ebgp-multihop`.
- **[MAJEUR] Modèle « pull »** : les sessions ne sont (ré)ouvertes que lors d'un `converge()` déclenché par la config, un `show` ou une décision de forwarding (`AbstractRoutingProtocolEngine.ts:8-14`, `Router.ts:819-825`). Pas de ConnectRetry timer §8.2.1 ; l'état Connect/Active est approximé (`BGPEngine.ts:457-464`, mapFsm `:500-510`).
- ⚠️ **Manquants** : communities (standard/extended), route-maps in/out, agrégation (`aggregate-address`), route reflectors / confédérations (le split-horizon iBGP total rend un full-mesh iBGP >2 routeurs incomplet sans RR — c'est ici sans conséquence car l'iBGP multi-saut n'existe pas non plus), MD5 (RFC 2385), dampening (RFC 2439), next-hop-self configurable (le comportement est next-hop-self implicite, `BGPEngine.ts:288-289`), soft-reconfiguration, 4-octet ASN explicite.
- **[MINEUR] CLI Cisco** : `show ip bgp summary` — MsgRcvd/MsgSent/TblVer codés à 0 (`CiscoRoutingProtoCommands.ts:428-431`) ; `show ip bgp` — colonne Metric toujours 0 et origine toujours `i` alors que l'engine trace `origin` (`BGPEngine.ts:477-484` fige `origin: 'i'`). L'état de session et la table affichés proviennent en revanche du vrai engine (`:415-470`) — bonne cohérence sur l'essentiel.

### 4. EIGRP — `src/network/eigrp/EIGRPEngine.ts` (599 lignes)

#### ✅

- **Trames réelles** : Hello/Update encapsulés IPv4 proto 88, multicast 224.0.0.10, TTL 1, MAC multicast RFC 1112 (`RouterDynamicRouting.ts:163-178`), reçus uniquement via `receiveEigrpPacket` (`:181-187` ; « The ONLY path information about a peer enters this engine », `EIGRPEngine.ts:300-314`). Un câble coupé interrompt réellement la conversation. Testé par `eigrp-wire.test.ts`.
- **Adjacence §5.3.4** : même ASN exigé (`:308`), **K-values comparés** avec log IOS `%DUAL-5-NBRCHANGE … K-value mismatch` (`:316-341`), interfaces activées par `network` + wildcard, classful par défaut (`statementCovers:128-140`), passive-interface.
- **Métrique composite classique exacte** (`metric.ts:67-85`) : `256×[K1·(10⁷/bw) + K2·bw/(256-load) + K3·delay/10]`, valeurs IOS de référence (2816/3072/30720) documentées et testées (`eigrp-metric.test.ts`).
- **DUAL — condition de faisabilité correcte** : successeur = plus bas FD ; feasible successor admis seulement si `RD < FD(successeur)` ; **variance** et **maximum-paths** appliqués (`selectSuccessors:561-598`) ; table topologique exposée pour `show ip eigrp topology` (`:143-153`). AD 90 interne / 170 externe (`:89-90`). Split horizon (`buildUpdate:400`). Vecteur métrique propagé correctement (bande passante = min du chemin, délai = somme, `:441-459`).
- Redistribution static/connected/rip/ospf/bgp comme externes (`originatedPrefixes:196-228`).

#### ❌ / ⚠️

- **[MAJEUR] Pas de machine DUAL complète** : aucun paquet QUERY/REPLY (les opcodes se limitent à `hello|update`, `packets.ts:44-65`), donc pas d'état Active, pas de Stuck-In-Active, pas de convergence par diffusion de requêtes lors de la perte du successeur sans FS. Pas de RTP (transport fiable, séquencement, ACK) — RFC 7868 §5.3/§6.
- **[MAJEUR] Pas de timers réels** : le modèle « une passe de convergence = un hello interval » est documenté (`EIGRPEngine.ts:28-35`) ; la liveness est `lastSeenRound < round` (`computeNeighbors:480-487`). Aucun hold-timer wall-clock : un voisin mort n'est détecté qu'à la prochaine passe (déclenchée par CLI/forwarding), contrairement à OSPF/RIP qui ont de vrais timers. Honnête (simplification assumée dans l'en-tête) mais incohérent avec le reste.
- ⚠️ Manquants : authentification MD5/SHA, EIGRP stub, wide metrics 64 bits (RFC 7868 §5.6.2.5), summary-address d'interface, `auto-summary` stocké mais sans effet visible.

### 5. RIPv2 — `src/network/rip/RIPEngine.ts` (803 lignes)

#### ✅ Le protocole le plus autonome du simulateur

- Vrais paquets UDP/520 vers 224.0.0.9 (v2) ou broadcast (v1 — RFC 1058), via `sendFrame` (callbacks `RIPCallbacks:90-115`, adaptateur `RouterRIPEngine.ts:46-63`).
- **Timers RFC 2453 réels** : update périodique, **timeout 180 s et garbage-collection par route** avec vrais timers (`RIPRouteState.timeoutTimer/gcTimer:60-62`, `invalidateRoute:737-755` passe la métrique à 16 avant GC), **triggered updates §3.9.3 avec fenêtre de coalescence** (`:519-534`), **split horizon avec poisoned reverse §3.5** (`:482-483`, `:545-546`).
- Passive-interface aux bonnes sémantiques IOS/VRP (silencieux mais apprenant, `:75-80`), redistribution + default-metric, `default-information originate`, AD 120.
- Pattern réactif respecté (observables + `RIPSignalRefreshActor`), démarrage réel du process (`RouterRIPEngine.ts:66` : `engine.start()`).

#### ⚠️ / ❌

- ⚠️ **Pas d'authentification RIPv2** (RFC 2453 §4.1 / MD5 RFC 2082) — l'entrée auth n'existe pas dans `RIPPacket`.
- **[MINEUR]** Pas de `Request` initial complet ni de réponse aux `Request` unicast (le commentaire `:301` l'assume pour les interfaces passives ; à vérifier pour le cas général).
- **[MINEUR]** Hold-down timer (spécifique Cisco) absent — conforme RFC mais divergent d'IOS.

### 6. RIB & forwarding IPv4 — `Router.ts`

#### ✅

- **LPM correct avec tie-break préfixe → AD → métrique** (`lookupRoute`, `Router.ts:818-866`). AD conformes : connected 0, static 1, eBGP 20, EIGRP 90/170, OSPF 110, RIP 120, iBGP 200 (`core/constants.ts:149-155`, `bgp/BGPEngine.ts:75-76`, `eigrp/EIGRPEngine.ts:89-90`).
- **Chemin de forwarding réaliste** (`forwardPacket:1532-1690`) : décrément TTL + ICMP Time Exceeded, ICMP Destination Unreachable si pas de route, **DF/MTU → ICMP Frag-Needed avec MTU** (`:1569-1577`), **ICMP Redirect RFC 1812 §5.2.7.2** (`:1581-1590`), ACL in/out, NAT, SPD IPsec, résolution ARP avec file d'attente (`queueAndResolve:1688`), recalcul du checksum IPv4 (`:1558-1563`). ICMP errors routées par la table (RFC 1812 §4.3.2.7, `:1694-1700`).

#### ❌ / ⚠️

- **[MAJEUR] Pas d'ECMP au FIB** : `lookupRoute` retourne une seule route ; les `nextHops[]` ECMP calculés par OSPF (`OSPFEngine.ts:3166-3191`) sont **écrasés à l'installation** (`installRoutes` ne pousse que `route.nextHop`, `RouterOSPFIntegration.ts:1698-1706`). Aucun partage de charge par flux ou par paquet.
- **[MAJEUR] Pas de récursivité des routes** : le next-hop est supposé on-link (`nextHopIP = route.nextHop || dest`, `Router.ts:1579` ; ARP direct sur `route.iface`). Une statique vers un next-hop non connecté n'est jamais résolue récursivement ; c'est aussi ce qui interdit l'iBGP entre loopbacks.
- **[MAJEUR] Mélange control/data plane** : `lookupRoute` appelle `dynamicRouting.refresh()` → `bgp.converge()` **à chaque décision de forwarding** (`Router.ts:819-825`, `RouterDynamicRouting.ts:224-229`). Un routeur réel ne relance pas son processus BGP par paquet ; ici c'est le palliatif du modèle « pull ».
- **[MINEUR]** Le contournement « interface déconnectée ⇒ route ignorée » dans `lookupRoute` (`:831-847`) simule la purge FIB mais laisse `show ip route` afficher des routes fantômes tant qu'aucune convergence n'a été redéclenchée (voir constat OSPF-RIB).

### 7. ACL — `devices/router/ACLEngine.ts` (440 lignes)

- ✅ **Ordre séquentiel premier-match + implicit deny final** (`evaluateACL:292-303`), **wildcards corrects bit à bit** (`wildcardMatch:383-393`), standard/extended, opérateurs de port eq/neq/gt/lt/range (`portMatches:369-381`), **`established`** (ACK|RST, `:332-336`), icmp-type par mot-clé, dscp/precedence/tos, `fragments`, time-range avec sémantique « ACE inactif ⇒ règle suivante » (`:293-296`), compteurs de matches. Points d'application corrects : in avant routage (`Router.ts:1238-1250`), out après lookup (`:1592-1604`), ICMP admin-prohibited (code 13) si `ip unreachables`.
- **[MAJEUR] ACL référencée mais inexistante ou vide ⇒ deny all** (`ACLEngine.ts:288-290`). Comportement IOS réel : une ACL non définie ou vide appliquée à une interface **permit all**. Divergence pédagogiquement dangereuse (l'apprenant croira qu'un `ip access-group 199 in` sans ACL 199 bloque le trafic).
- ⚠️ Pas de numéros de séquence / resequence / insertion positionnelle d'ACE, ni de `log` par ACE.

### 8. NAT — `devices/router/NATEngine.ts` (898 lignes)

- ✅ Très complet : static 1:1 et par réseau (offset), static PAT (port forwarding), **PAT overload sur IP d'interface avec allocation de ports éphémères ≥1024**, pools dynamiques, sémantique inside/outside stricte (`translateOutbound:411-415`), sessions avec timeouts par protocole, **traduction du paquet embarqué dans les erreurs ICMP (RFC 5508 §3)** (`:423-437`), **FTP ALG** avec réécriture PORT/PASV + pinhole (`Router.ts:1608-1613`), détection de conflits de mappings statiques (`:214-233`).
- **[MINEUR] Ordre des opérations divergent d'IOS** : pour inside→outside, l'ACL sortante est évaluée **avant** la traduction NAT (`Router.ts:1592-1607`) alors qu'IOS applique NAT inside→outside avant l'ACL out (l'ACL out voit l'adresse globale sur un vrai routeur, l'adresse locale ici).

### 9. HSRP / VRRP / GLBP — `src/network/{hsrp,vrrp,glbp}` + `fhrp/FhrpAgentBase.ts`

- ✅ **Paquets réels** : HSRP en UDP/1985 vers 224.0.0.2 (v1) / 224.0.0.102 (v2) (`hsrp/types.ts`), VRRP en IP proto 112, **TTL 255**, vers 224.0.0.18 (`VrrpAgent.ts:129`), GLBP en UDP/3222. Émission via `host.sendFrame` (`FhrpAgentBase.ts:124,234`).
- ✅ Conformité paramétrique : **MAC virtuelle HSRP `0000.0c07.acXX`** (`hsrp/types.ts:101`) et v2 `0000.0c9f.fXXX`, **MAC VRRP `00:00:5e:00:01:{vrid}`** (`vrrp/types.ts:62`), **skew time RFC 5798 §6.1 `(256-prio)/256` et master-down `3×adv+skew`** (`vrrp/types.ts:68-71`), priorité 255 = owner (`VrrpAgent.ts:159`), préemption, tracking avec décrément, timers hello/hold réels (hello 3 s HSRP, sweep d'expiration 1 s).
- ✅ **GLBP AVG/AVF** avec les trois modes de load-balancing round-robin / weighted / host-dependent servis à l'ARP (`GlbpAgent.ts:122-152`, `vipArpMac` par requérant).
- ✅ Génie logiciel exemplaire : `FhrpAgentBase` (Template Method) a factorisé ~600 lignes dupliquées entre les trois agents (en-tête `FhrpAgentBase.ts:1-15`) ; réponse ARP pour la VIP par le rôle actif via `vipArpOwner`.
- **[MINEUR]** La phase Listen/Learn HSRP est remplacée par un « probe » synchrone (`probeThenClaim`, `HsrpAgent.ts:62-77`) qui exploite la livraison synchrone du câble — raccourci documenté, états Listen/Learn jamais observables.
- **[MINEUR — Huawei]** `display vrrp` lit la config depuis la façade `HuaweiVrrpService` (magasin passif, `redundancy/HuaweiVrrpService.ts`) et l'état vivant via `huaweiVrrpLiveState` → vrai `VrrpAgent` (`HuaweiDisplayCommands.ts:1273-1287`, `:1038`) ; les compteurs de `display vrrp statistics` sont fabriqués (`Adv sent: 0`, `:1295-1299`).

### 10. BFD — `src/network/bfd/BfdAgent.ts` (299 lignes)

- ✅ Paquets de contrôle réels UDP/3784 (`types.ts:UDP_PORT_BFD_CONTROL`), discriminateurs my/your, états admin-down/down/init/up, intervalles négociés (plancher 50 ms, `BfdAgent.ts:85-87`), detect multiplier 1-50, timers tx/expiry réels.
- **[MAJEUR] BFD n'est couplé à rien** : aucun protocole de routage ne s'abonne aux transitions (`grep bfd.session` : seul `inspection/config/LoggingConfig.ts:280` écoute, pour le log). `ip ospf bfd`/`bfd all-interfaces` est stocké (`OSPFExtraConfig.bfdAllInterfaces`, `RouterOSPFIntegration.ts:37`) mais ne déclenche jamais `KillNbr`/teardown de session BGP/EIGRP. Le but même de BFD (RFC 5882) est absent.
- ⚠️ Pas de mode echo, pas d'authentification BFD.

### 11. PIM / IGMP — `src/network/{pim,igmp}`

- ✅ Contrôle sur le fil : PIM v2 Hello avec holdtime (3,5×hello, `PimAgent.ts:91-92`) et **Join/Prune (*,G)/(S,G) réels** avec upstream neighbor et holdtime (`:303-353`), voisins expirés par holdtime ; IGMP v1/v2 : query/report/leave réels, **élection du querier à la plus basse IP** (`IgmpAgent.ts:142-156`), abonnements par groupe et par reporter. IGMPv3 explicitement non supporté (testé, `igmp-v3-not-supported.test.ts`).
- **[MAJEUR] Aucun forwarding multicast de données** : le routeur livre localement et **ne forwarde jamais** un paquet destiné à 224/4 (`Router.ts:1202-1205` — « Broadcast/multicast packet — deliver locally, never forward »). Les mroutes PIM sont donc de l'affichage : pas de RPF check, pas de réplication OIL, pas de register/RP tunnel ni de SPT switchover, pas d'assert. Un lab multicast de bout en bout (source → récepteurs) ne fonctionne pas.

### 12. NHRP / route-policy / prefix-list — `devices/router/{nhrp,policy}`

- **[MAJEUR] NHRP est un magasin de configuration** (`NhrpService.ts` : mappings/NHS/cache posés par la CLI, aucun paquet Registration/Resolution NHRP, pas de résolution dynamique DMVPN).
- **[MAJEUR] `RoutePolicy` / `IpPrefixList` ne sont jamais évalués** : structures de config (match/apply, `policy/RoutePolicy.ts:1-40`) référencées uniquement par les shells Huawei (`grep` : aucun point d'application dans les engines ni la redistribution). Un `route-policy` appliqué à une redistribution n'a aucun effet.

---

## Communication par paquets : verdict

**Exigence client : toute communication inter-machines doit passer par de vrais échanges de paquets via Ports/Cables.**

| Sous-système | Verdict |
|---|---|
| OSPFv2 Hello/DD/LSR/LSU/LSAck, flooding, dead-interval | ✅ **Vrais paquets** (IP proto 89, `sendFrame` → Cable → `handleLocalDelivery`, `Router.ts:1262-1271`) ; prouvé par `ospf-packet-exchange.test.ts` |
| OSPFv2 routes inter-area/externes/NSSA/VL (couche intégration) | ❌ **God-view** : lecture directe des tables et configs des routeurs distants (`RouterOSPFIntegration.ts:1239-1506`) |
| OSPFv2 déclenchement/temporalité de convergence | ⚠️ Trames réelles mais **orchestration centralisée synchrone** sur tout le domaine (registre statique + BFS objets, `:91`, `:587-633`) |
| OSPFv3 | ❌ **100 % accès objet direct** (`:767-794`, `:797-1054`) |
| BGP Cisco | ✅ **Vraies sessions TCP/179** sur le TcpStack, OPEN/KEEPALIVE/UPDATE/NOTIFICATION réels |
| BGP Huawei | ❌ Façade de config, sorties CLI **fabriquées** (`HuaweiDisplayCommands.ts:1470-1500`) |
| EIGRP | ✅ Vraies trames proto-88 multicast (seule entrée : `processPacket`) — mais cadencées par des « rounds », pas par des timers |
| RIPv2 | ✅ Vrais UDP/520 + vrais timers — le plus conforme au modèle attendu |
| HSRP/VRRP/GLBP, BFD, PIM, IGMP | ✅ Vraies trames de contrôle |
| Multicast (données), NHRP, route-policies | ❌ Inexistant / config-only |

**Conclusion** : le cœur protocolaire (formats, FSM, contenus de paquets) est majoritairement authentique et de qualité inattendue pour un simulateur navigateur ; les entorses se concentrent dans les **couches d'intégration routeur** (OSPF avancé, OSPFv3, orchestration temporelle) et dans la **parité Huawei** (BGP). C'est là que l'effort doit porter.

---

## Top 10 des actions recommandées (priorisées)

1. **[CRITIQUE] Brancher le vrai `BGPEngine` sur les routeurs Huawei** et réécrire `display bgp peer` / `display bgp routing-table` sur l'état réel (supprimer les valeurs fabriquées de `HuaweiDisplayCommands.ts:1470-1500`). Un lab inter-vendeurs eBGP est un cas d'usage central du produit.
2. **[CRITIQUE] Éliminer `computeAdvancedRoutes()`** (`RouterOSPFIntegration.ts:1239-1506`) : faire porter inter-area/external/stub/NSSA/VL exclusivement par les LSA 3/4/5/7 que l'engine sait déjà originer et flooder (`originateSummariesAsABR`, `originateExternalLSA`, `processExternalRoutes`), pour supprimer la double vérité engine ↔ RIB.
3. **[CRITIQUE] Refondre OSPFv3 sur le modèle filaire d'OSPFv2** : transport des paquets v3 sur IPv6 link-local via les ports (le squelette FSM existe déjà), suppression de `v3FormAdjacency`/`v3ComputeRoutes` (copie de tables distantes).
4. **[MAJEUR] Enregistrer un installeur RIB sur `RoutingTableSyncActor.onRoutes()`** dans `RouterOSPFIntegration`, pour que la reconvergence autonome (dead timer → SPF) mette réellement à jour la table de routage sans attendre un `show` ; retirer à terme le contournement « interface déconnectée » de `lookupRoute` (`Router.ts:831-847`).
5. **[MAJEUR] Décentraliser la convergence OSPF** : remplacer `collectOSPFDomain` + `driveWireConvergence` par les timers propres de chaque engine (hellos périodiques déjà en place, `startHelloTimer`) ; au minimum, corriger le BFS pour traverser les chaînes de commutateurs (`:612-629`).
6. **[MAJEUR] Coupler BFD aux protocoles** : sur transition Up→Down d'une session BFD, publier vers OSPF (`KillNbr`), BGP (teardown session) et EIGRP — c'est le contrat de `bfd all-interfaces` déjà accepté par la CLI.
7. **[MAJEUR] Implémenter le forwarding multicast de données** : RPF check sur la RIB unicast, réplication selon les OIL construits par IGMP/PIM (l'état de contrôle existe déjà), à défaut PIM-DM flood-and-prune pour un premier jalon ; lever le blocage de `Router.ts:1202-1205`.
8. **[MAJEUR] Corriger la sémantique IOS de l'ACL indéfinie/vide ⇒ permit all** (`ACLEngine.ts:288-290`) et inverser l'ordre ACL out / NAT inside→outside (`Router.ts:1592-1613`).
9. **[MAJEUR] ECMP et récursivité au FIB** : installer les `nextHops[]` OSPF multiples dans la RIB, load-sharing par flux dans `lookupRoute`, et résolution récursive du next-hop (préalable à l'iBGP entre loopbacks et à `ebgp-multihop`).
10. **[MINEUR→MAJEUR groupés] Compléter EIGRP (QUERY/REPLY + hold timers réels), BGP (communities/route-maps/agrégation, ConnectRetry), RIP/OSPF/EIGRP (authentification MD5 réellement calculée)**, et corriger les cosmétiques CLI qui trahissent l'état interne : Dead Time statique (`CiscoOspfCommands.ts:1346`), MsgRcvd/MsgSent à 0 et origine `i` figée (`CiscoRoutingProtoCommands.ts:428`, `BGPEngine.ts:483`), compteurs `display vrrp statistics` fabriqués.

---

### Note d'ensemble sur le génie logiciel

Le pattern documenté *Engine + types + events + observables + actors* est respecté par OSPF (exemplaire : 8 actors, TimerSet, signaux en lecture seule) et RIP ; BGP/EIGRP s'appuient proprement sur la fondation commune `AbstractRoutingProtocolEngine` + `routing/observables` (Template Method, DIP via les seams `EigrpWire`/`BgpWire`/`RoutingDeviceContext` — `routing/RoutingPeerLocator.ts` est un bon exemple de couture d'inversion de dépendance). La factorisation FHRP (`FhrpAgentBase`) est un modèle du genre. Les points noirs : `RouterOSPFIntegration.ts` (1 727 lignes) concentre de la logique protocolaire qui n'a rien à y faire (violation SRP, duplication avec l'engine), `Router.ts` reste un quasi God-Object (3 289 lignes), les registres statiques (`RouterOSPFIntegration.registry:91`, `Equipment.getById`) créent un état global qui fuit entre topologies/tests, et les CLI accèdent à l'état par des casts `as any`/`as unknown as` non typés (`CiscoOspfCommands.ts:2237`, `HuaweiDisplayCommands.ts:1471`), fragilisant la cohérence engine ↔ affichage que cet audit a précisément prise en défaut côté Huawei.

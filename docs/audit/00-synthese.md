# Synthèse consolidée de l'audit

> Consolidation des 10 rapports sectoriels ([01](01-protocoles-L2.md) à
> [10](10-rman.md)) — voir [README.md](README.md) pour la méthodologie et la
> grille de sévérité. Date : 2026-07-22.

## 1. Verdict global

Le simulateur est **d'une profondeur inhabituelle pour un projet de ce type** :
la pile TCP (RFC 9293/6298/5681/7323/2018 complets), OSPFv2 (RFC 2328 quasi
intégral côté moteur), BGP côté Cisco (RFC 4271 complet avec vraies sessions
TCP/179), STP/VTP/DTP/LACP/CDP/LLDP/UDLD/IGMP-snooping/802.1X, le moteur SQL
Oracle (PL/SQL réel, contraintes appliquées, flashback fonctionnel), RMAN
(couverture syntaxique très large, machine à états correctement gardée) et le
pipeline objet PowerShell sont tous des réimplémentations sérieuses, pas des
façades. Les dix rapports convergent vers un même constat : **là où un vrai
échange de paquets a été écrit, il est généralement bien écrit** — le défaut
n'est presque jamais un manque de compétence, c'est une **dette de dernier
kilomètre** concentrée à des endroits identifiables.

Trois catégories de problèmes ressortent, par ordre de gravité :

1. **Des raccourcis "god-mode" récurrents et strictement localisés**, qui
   violent directement l'exigence produit centrale (toute communication
   inter-machines par paquets réels) : le même patron architectural — BFS sur
   la topologie via `EquipmentRegistry` puis appel direct de méthode sur
   l'équipement distant — revient dans au moins six sous-systèmes indépendants
   (SSH/SCP/SFTP/nc, Telnet, convergence OSPF avancée/OSPFv3, IPSec IKE peer
   lookup, NHRP, traceroute ACL). Ce n'est pas six bugs isolés, c'est **un
   seul problème architectural répété**, ce qui est une bonne nouvelle
   opérationnelle : une seule correction structurelle (un service de
   traversée topologique explicitement réservé à l'outillage, et un routage
   systématique des protocoles applicatifs vers les piles TCP/UDP déjà
   existantes) traite la majorité des occurrences d'un coup.
2. **Des bugs de correction ponctuels mais réels**, indépendants de la
   question des paquets : boucle L2 → `RangeError` reproductible (crash de
   l'onglet), corruption silencieuse de données Oracle avec deux sessions
   concurrentes, expansions de tableau bash non quotées toujours vides,
   double dispatch de commandes (`curl`/`ifconfig`/`tcpdump`) qui change de
   comportement selon qu'elles sont tapées ou scriptées, tailles RMAN
   incohérentes avec le catalogue.
3. **De la dette de complétude assumée et documentée** (MSTP, BGP Huawei,
   RAC, multitenant Oracle CDB/PDB, Data Guard) — moins urgente car elle ne
   trompe pas silencieusement l'utilisateur : soit la fonctionnalité est
   absente et le dit, soit elle est un stub évident.

Aucun rapport n'a signalé de régression généralisée ni de sous-système
entièrement façade non documenté comme tel — le niveau de finition est élevé
et les dix agents d'audit (menés indépendamment, avec des méthodes de
vérification empirique systématiques) sont arrivés à des évaluations
cohérentes entre elles, y compris sur les zones de recoupement (ex. OSPF
audité à la fois par 02 et 04, avec les mêmes constats obtenus par des
lectures de code indépendantes).

## 2. Communication par paquets — tableau consolidé

Grille : ✅ réel (paquets/trames effectivement échangés) · 🟡 hybride
(une partie du dialogue est réelle, le reste court-circuite) · ❌ magique
(accès direct à l'objet distant, aucun paquet).

| Domaine | Service / protocole | Verdict | Rapport |
|---|---|---|---|
| **L2** | STP/RSTP/PVST+, VTP, DTP, LACP, CDP, LLDP, UDLD, IGMP snooping, 802.1X, DAI | ✅ | 01 |
| **L3** | OSPFv2 (Hello/DD/LSR/LSU/LSAck, flooding) | ✅ | 02, 04 |
| **L3** | OSPFv2 — routes inter-area/externes/NSSA/virtual-link (intégration routeur) | ❌ | 02, 04 |
| **L3** | OSPFv2 — déclenchement/temporalité de convergence (domaine entier) | 🟡 | 02, 04 |
| **L3** | OSPFv3 (IPv6) | ❌ | 02 |
| **L3** | BGP — Cisco | ✅ | 02 |
| **L3** | BGP — Huawei (`display bgp peer`) | ❌ | 02 |
| **L3** | EIGRP, RIPv2 | ✅ | 02 |
| **L3** | HSRP / VRRP / GLBP, BFD, PIM, IGMP (contrôle) | ✅ | 02 |
| **L3** | PIM/IGMP — forwarding multicast de **données** | ❌ | 02 |
| **L3** | NHRP | ❌ | 02, 03 |
| **L3** | IPSec (IKE + ESP/AH réinjectés dans le forwarding) | ✅ | 03 |
| Transport | TCP (handshake, retransmission, congestion, fermeture) | ✅ | 03 |
| Transport | DHCP, DNS, NTP, SNMP, Syslog, NetFlow, RADIUS, TACACS+, GRE, VXLAN | ✅ | 03 |
| Transport | Ping / Traceroute | ✅ | 03 |
| Applicatif | SSH — admission + authentification (Linux↔Linux) | ✅ | 03, 04 |
| Applicatif | SSH — session **interactive** (Linux↔Linux, après auth) | ❌ | 03, 04 |
| Applicatif | SSH — vers cible non-Linux (Cisco/Huawei/Windows) | ❌ | 03, 04 |
| Applicatif | Telnet sortant | ❌ | 03, 04 |
| Applicatif | SCP / SFTP (commande shell) | 🟡 (admission réelle, données magiques) | 03 |
| Applicatif | SFTP (canal SSH natif) | ✅ | 03 |
| Data plane | Trame L2 nominale (Port→Cable→Port, apprentissage MAC, flooding) | ✅ | 04 |
| Data plane | `nc` (netcat) | ❌ | 04 |
| DB | `sqlplus`/RMAN distants via TNS/listener (TCP/1521) | ✅ | 07, 10 |

**Verdict consolidé** : le **cœur du data plane et la quasi-totalité des
protocoles de contrôle L2/L3 sont conformes**. Les violations se concentrent
presque exclusivement dans **la couche applicative distribuée** (SSH
interactif, Telnet, SCP/SFTP, `nc`) et dans **l'intégration des protocoles de
routage avancés** (OSPF étendu, OSPFv3, IPSec peer lookup, NHRP) — c'est-à-dire
précisément les endroits où un vrai échange de paquets était le plus coûteux à
écrire. C'est un problème sérieux et prioritaire (il touche le cas d'usage le
plus visible du produit — une session SSH entre deux machines n'anime aucun
paquet sur le canvas), mais un problème **circonscrit et adressable
méthodiquement**, pas une refonte d'architecture.

## 3. Constats CRITIQUES (tous domaines)

| # | Constat | Domaine | Rapport | Fichier:ligne |
|---|---|---|---|---|
| 1 | Le client SSH/SCP/SFTP/`nc` et le serveur d'exec résolvent la cible et vérifient les identifiants par accès direct à l'objet distant (`HostLookup.ts`, `LinuxSshClient.ts`), en contournant une vraie `TcpStack` pourtant disponible et déjà câblée côté serveur pour Router/WindowsPC | Data plane / Transport | 03, 04 | `HostLookup.ts:26-223`, `LinuxSshClient.ts:795-1010` |
| 2 | Propagation de trame 100 % synchrone (`Cable.transmit`) sans aucun garde-fou : une boucle L2 sur deux `GenericSwitch` (aucun agent STP) produit un `RangeError: Maximum call stack size exceeded` reproductible en 3 glisser-déposer dans l'UI — crash de l'onglet | Data plane | 04 | `Cable.ts:322-326`, `Switch.ts:1784`, `GenericSwitch.ts:23-25` |
| 3 | `ROLLBACK` avec deux sessions Oracle écrivant simultanément sur la même table peut effacer silencieusement les données non commitées d'une autre session et produire une lecture incohérente ne correspondant à aucun état réel de la base — perte de données silencieuse, pas seulement lecture obsolète | Oracle | 07 | `TransactionManager.ts:110-119`, `TransactionCoordinator.ts:13-22` |
| 4 | MSTP est un alias silencieux vers RSTP : `spanning-tree mode mst` accepté puis remappé, `show spanning-tree mst`/`display stp instance` affichent le même état CST pour toutes les instances quel que soit le VLAN réellement mappé | L2 | 01 | `CiscoSwitchShell.ts:1347-1348`, `HuaweiSwitchShell.ts:2444-2452` |
| 5 | `display bgp peer`/`display bgp routing-table` côté Huawei sont entièrement fabriqués (état toujours "Idle", compteurs à zéro) — les routeurs Huawei n'instancient jamais le vrai `BGPEngine` ; un lab eBGP Cisco↔Huawei est impossible | L3 | 02 | `HuaweiDisplayCommands.ts:1470-1500` |
| 6 | OSPFv3 (IPv6) : adjacences forgées par appel direct `engine.processHello()` sur le routeur local, routes IPv6 copiées des tables de routage distantes par BFS objet — aucun paquet, aucun SPF v3 | L3 | 02 | `RouterOSPFIntegration.ts:684-1054` |
| 7 | `${arr[n]}`, `${arr[@]}`, `${arr[*]}` non quotés renvoient toujours une chaîne vide en bash (le chemin quoté fonctionne) — un idiome shell extrêmement courant échoue silencieusement, sans erreur | Linux | 05 | `BashParser.ts:716-746` |
| 8 | Double dispatch de commandes : `curl`, `ifconfig`, `tcpdump` ont deux implémentations concurrentes (registre vs switch) qui divergent selon que la commande est tapée au prompt ou exécutée dans un script — `ifconfig` en script "réussit" silencieusement sans configurer l'interface | Linux | 05 | `LinuxCommandExecutor.ts:4118,4120,4279` |
| 9 | Taille physique des backup pieces RMAN sur le VFS (~37 octets, chaîne littérale) totalement déconnectée de la taille annoncée par `LIST BACKUP` (peut afficher 1.61G) — un `du`/`ls -l` réel contredirait systématiquement le catalogue RMAN | RMAN | 10 | `RmanJobEngine.ts:243`, `LinuxRmanContext.ts:116-123` |
| 10 | Aucune différence de taille ni de durée entre `BACKUP INCREMENTAL LEVEL 0` et `LEVEL 1` — le bénéfice pédagogique central de l'incrémental (taille réduite) n'est jamais démontré, malgré une mise en scène de test dédiée sur une semaine complète | RMAN | 10 | `RmanJobEngine.ts:148-152` |

## 4. Constats MAJEURS récurrents (transverses)

Ces problèmes ne sont pas des occurrences isolées : ils réapparaissent sous
la même forme dans plusieurs rapports, signe d'un même choix structurel fait
à plusieurs endroits indépendamment.

- **Le patron "BFS topologique + accès direct à l'objet distant"** revient au
  moins **8 fois** dans des sous-systèmes indépendants : SSH/SCP/SFTP/`nc`
  (03, 04), Telnet (03, 04), convergence OSPF avancée + OSPFv3 (02, 04), IPSec
  `findRouterByIP` (03, 04), NHRP (02, 03), résolution NSS DNS de repli (04),
  vérification ACL de traceroute sur des routeurs hors chemin (04). Le
  rapport 04 dénombre **4 implémentations quasi identiques** du même BFS
  (`HostLookup.ts`, `RouterOSPFIntegration.ts` ×2, `EndHost.ts`,
  `CaptureRouter.ts`) — un service de traversée unique, explicitement réservé
  à l'outillage/UI/tests, éliminerait la duplication autant que le risque.
- **Duplication Cisco/Huawei** : shells monolithiques (`CiscoSwitchShell.ts`
  4447 lignes, `HuaweiSwitchShell.ts` 3165 lignes — 01), constructeurs
  `CiscoRouter`/`HuaweiRouter` ~90 % identiques sans factorisation (~350
  lignes dupliquées — 02, 04), compteurs `display vrrp statistics` Huawei
  fabriqués alors que le moteur réel existe (02).
- **God objects** récurrents dans quasi tous les rapports : `LinuxCommandExecutor.ts`
  (6567 lignes, ~269 `case`, a presque doublé depuis le dernier audit — 05),
  `EndHost.ts` (3885), `Router.ts` (3289), `LinuxMachine.ts` (3202),
  `PowerShellExecutor.ts` legacy (4343), `OracleExecutor.ts` (4282),
  `OracleDatabase.ts` (2277). Le rapport 08 (génie logiciel) confirme
  `LinuxCommandExecutor.dispatch()` comme le pire point isolé (1205 lignes,
  207 `case` en une seule fonction).
- **Double moteur / double dispatch** comme anti-pattern répété à plusieurs
  niveaux de la pile : PowerShell (nouveau moteur `src/powershell/` vs
  `PowerShellExecutor.ts` legacy en filet de sécurité silencieux non
  surveillé — 06), bash (`curl`/`ifconfig`/`tcpdump` registre vs switch — 05),
  et le bug bash lui-même (constat #7 ci-dessus) est structurellement le même
  problème : deux analyseurs indépendants de la même grammaire qui divergent.
- **Cohérence état interne ↔ affichage CLI** : plusieurs rapports notent des
  compteurs ou champs figés à zéro alors que l'état réel existe dans le
  moteur (`display stp topology-change` Huawei — 01 ; `MsgRcvd`/`MsgSent` BGP,
  colonne Metric — 02 ; `Dead Time` OSPF statique au lieu du compte à rebours
  réel — 02 ; `#Pieces` RMAN toujours 1 — 10) : un défaut mineur individuellement,
  mais qui, répété, dessine un motif — l'affichage CLI n'est pas toujours mis
  à jour au même rythme que le moteur qu'il est censé refléter.
- **Persistance de configuration incomplète et trompeuse** : `reload` sur un
  routeur ne restaure pas la startup-config (la config objet survit
  intégralement au lieu de repartir de zéro — 04) ; `topologySerializer`
  perd toute la config avancée au sauvegarde/rechargement (OSPF/BGP/ACL/NAT,
  startup-config, VFS Linux — 04).
- **Documentation en retard sur le code**, systématiquement dans le sens
  "sous-estime ce qui existe" : `CLAUDE.md` référence des fichiers supprimés
  (`terminal/filesystem.ts`, `NeighborResolver.ts` — 04, 05) et une mécanique
  de dispatch déjà éliminée (`constructor.name` — 04) ; `docs/BRD-PowerShell.md`
  marque comme absents Registre/Scheduled Tasks/WMI/`Group-Object`/`ConvertTo-Json`
  alors qu'ils sont tous implémentés et testés (06) ; `docs/BRD-Oracle-DBMS.md`
  sous-estime le flashback et le nombre de codes ORA- (07). Aucune
  documentation n'a été trouvée en avance sur le code — le risque systémique
  est qu'un contributeur qui s'y fie priorise mal son travail.
- **Portes de couverture CI trop étroites** : `vite.config.ts` ne seuille la
  couverture que sur `src/network/protocols/ssh/**` (confirmé par 08 et
  recoupé indépendamment par 07, qui note l'absence de porte CI pour Oracle
  malgré l'objectif "90%+" affiché par le BRD).

## 5. Ce qui est solide

À préserver explicitement lors de toute refactorisation :

- **`TcpStack.ts`** : handshake 3-way, RFC 6298 (RTO/Karn), RFC 5681
  (congestion control complet), RFC 7323/2018 (SACK/window-scale/timestamps/PAWS),
  RFC 9293 (cycle de fermeture avec TIME-WAIT réel) — rare à ce niveau de
  détail dans un simulateur pédagogique (03).
- **OSPFv2 côté moteur** : FSM RFC 2328 complète, SPF Dijkstra avec throttle
  et SPF partiel, LSA types 1-7, ECMP calculé, authentification vérifiée
  avant traitement (02).
- **BGP côté Cisco** : vraies sessions TCP/179, FSM RFC 4271, best-path complet
  jusqu'au tie-break routeur-ID (02).
- **Le cœur de commutation** (`Switch.ts`) : 802.1Q/QinQ/PVLAN/hybrid, STP
  par port ET par VLAN, DAI, DHCP snooping avec bindings appris de vrais
  DHCPACK, apprentissage MAC avec aging et fast-aging STP conforme Cisco (01, 04).
- **VTP** : Summary/Subset réels, élection Primary Server v3, détection
  d'orphan subset — rare et bien fait (01).
- **FHRP** (`FhrpAgentBase`) : Template Method qui a factorisé ~600 lignes
  entre HSRP/VRRP/GLBP, MAC virtuelles et timers RFC 5798 corrects (02).
- **IPsec** : trafic protégé réellement réinjecté dans le pipeline de
  forwarding du routeur plutôt que court-circuité (03).
- **Pipeline objet PowerShell** : vrais objets typés (pas du texte
  déguisé), parité réseau Windows/Linux réelle via le code partagé `EndHost`
  (06).
- **PL/SQL** : interpréteur AST réel avec portée lexicale, transactions
  autonomes, curseurs — pas un stub (07).
- **Synchronisation VFS/systemd Oracle bidirectionnelle** : `STARTUP`/`SHUTDOWN`
  pilotent l'unité systemd et réciproquement, avec idempotence garantie des
  deux côtés (07).
- **Accès réseau distant Oracle/RMAN** : `sqlplus`/RMAN via TNS traversent
  réellement le réseau simulé (listener lié à un vrai socket, erreurs
  ORA-12541/12514/12528 dérivées de l'état réel) — pas de raccourci (07, 10).
- **Architecture réactive RMAN** : fidèle au design documenté
  (`DESIGN-RMAN-REACTIVE.md`), machine à états correctement gardée, formats
  de sortie quasi indiscernables d'un vrai transcript RMAN 19c (10).
- **Animation de paquets UI** : branchée sur les vrais événements
  `cable.frame.dispatched`, pas cosmétique — chaque point animé correspond à
  une vraie trame (04, 09).
- **`ICmdlet`/`CmdletRegistry`** PowerShell et `LinuxCommand` registry :
  Open/Closed respecté, ajout de commande sans toucher au cœur (06, 08).
- **Suites de tests** : ~14 500 tests unitaires réseau + 3088 tests base de
  données + 2387 tests PowerShell + 532 tests bash, très majoritairement
  verts, avec vérification empirique systématique par les dix auditeurs
  (tous rapports).

## 6. Feuille de route priorisée

Consolidation dédupliquée des dix "Top 10" sectoriels, groupée par thème et
classée par ratio impact/effort.

| Priorité | Action | Domaine(s) | Effort | Impact |
|---|---|---|---|---|
| **P0** | Faire du client SSH/SCP/SFTP/`nc` un consommateur de la vraie `TcpStack` (déjà câblée côté serveur pour Router/WindowsPC) ; réserver `HostLookup`/BFS topologique à la résolution de noms d'outillage uniquement | Transport, Data plane (03, 04) | Élevé | **Très élevé** — cas d'usage le plus visible du produit, exigence centrale du client |
| **P0** | Casser la récursion synchrone de `Cable.transmit` (budget de sauts par trame en garde-fou immédiat, puis file/scheduler) ; protéger `GenericSwitch` d'une boucle (StpAgent optionnel ou storm-control) | Data plane (04) | Moyen (garde-fou) / Élevé (async complet) | **Critique** — crash utilisateur reproductible en 3 actions UI |
| **P0** | Corriger la restauration de `ROLLBACK` Oracle pour ne toucher que les lignes de la transaction courante (diff ciblé, pas troncage de table) ; alerter explicitement sur écriture concurrente multi-session en l'absence de vraie MVCC | Oracle (07) | Moyen | **Critique** — perte de données silencieuse |
| **P0** | Corriger `BashParser.parseBracedVar` pour les indices de tableau non quotés (`${arr[n]}`) | Linux (05) | Faible | **Élevé** — idiome shell courant, échec silencieux |
| **P1** | Éliminer les 3 doubles dispatch bash (`curl`/`ifconfig`/`tcpdump` : supprimer le `case` legacy du switch, laisser `_registryCommandHook` router) | Linux (05) | Faible | Élevé — script vs prompt doit se comporter identiquement |
| **P1** | Faire circuler la session SSH **interactive** sur le canal TCP réel une fois authentifiée (remplacer `createSessionForDevice` par un flux `shell_input` sur `conn`, déjà supporté côté serveur) | Transport (03) | Élevé | Élevé — complète le P0 SSH |
| **P1** | Corriger la cohérence taille/durée RMAN : buffer VFS de taille réaliste, différenciation LEVEL 0/1, réutiliser `elapsedMs` déjà calculé | RMAN (10) | Faible-Moyen | Élevé — contredit directement le catalogue affiché |
| **P1** | Brancher le vrai `BGPEngine` sur les routeurs Huawei (labs eBGP inter-vendeurs actuellement impossibles) | L3 (02) | Moyen | Élevé — parité produit annoncée |
| **P1** | Implémenter un vrai MSTP (CIST + MSTI indépendantes) au lieu de l'alias `mst → rstp` | L2 (01) | Élevé | Moyen-Élevé — fonctionnalité standard attendue |
| **P2** | Rendre OSPFv2 "avancé" (inter-area/externe/NSSA/VL) et OSPFv3 honnêtes : faire porter les routes exclusivement par les LSA que l'engine sait déjà originer/flooder, supprimer `computeAdvancedRoutes`/`v3ComputeRoutes` | L3 (02, 04) | Élevé | Moyen — cohérence engine↔RIB, éradique une famille du patron "god-mode" |
| **P2** | Restaurer la sémantique startup/running (`reload` doit repartir de la startup-config) et étendre `topologySerializer` aux configs vendeur avancées | Data plane (04) | Moyen | Moyen — fidélité pédagogique de la persistance |
| **P2** | Faire échouer `RECOVER`/`RESTORE CONTROLFILE FROM AUTOBACKUP` RMAN quand les prérequis (archivelogs, autobackup réel) ne sont pas satisfaits ; propager `SET UNTIL` jusqu'à `RESTORE` | RMAN (10) | Moyen | Moyen — scénarios d'échec pédagogiques actuellement impossibles à démontrer |
| **P2** | Restaurer le format d'erreur PowerShell standard (`<Cmdlet> : <message>` + `CategoryInfo`/`FullyQualifiedErrorId`) dans le nouveau moteur, actuellement régressé par rapport au legacy | PowerShell (06) | Faible-Moyen | Moyen — scripts qui inspectent `$Error[0].CategoryInfo` cassent silencieusement |
| **P2** | Rendre `ls` conscient du contexte pipe/redirection (`onePerLine` automatique hors TTY) | Linux (05) | Faible | Moyen — divergence très visible pour tout utilisateur Linux expérimenté |
| **P2** | Documenter/limiter explicitement le multitenant Oracle (pas d'isolation CON_ID) et Data Guard (pas de transport/apply réel) dans les sorties utilisateur, pour éviter tout piège pédagogique silencieux | Oracle (07) | Faible | Moyen |
| **P3** | Trancher le sort du moteur PowerShell legacy (`PowerShellExecutor.ts`, 4343 lignes) : achever la migration ou documenter et surveiller (`fallbackHits`) explicitement son usage résiduel | PowerShell (06) | Moyen | Moyen — dette technique, pas un bug utilisateur |
| **P3** | Factoriser le patron "BFS topologique + accès direct" derrière un service unique explicitement réservé à l'outillage (élimine 4+ implémentations dupliquées identifiées) | Transversal (03, 04) | Moyen | Moyen — réduit la surface du problème P0/P1 pour les prochaines évolutions |
| **P3** | Étendre les portes de couverture CI au-delà de `protocols/ssh/**` (au minimum Oracle, idéalement bash/PowerShell) pour donner un sens mesurable aux objectifs affichés par les BRD | Génie logiciel (07, 08) | Faible | Moyen — visibilité continue, pas de correctif fonctionnel |
| **P3** | Rafraîchir `CLAUDE.md`, `docs/BRD-PowerShell.md`, `docs/BRD-Oracle-DBMS.md` depuis l'état réel du code (plusieurs sont en retard, systématiquement dans le sens "sous-estime l'existant") | Documentation (04, 05, 06, 07) | Faible | Faible-Moyen — évite les priorisations erronées futures |
| **P4** | Poursuivre la décomposition des God objects déjà entamée (`LinuxCommandExecutor.ts`, `OracleExecutor.ts`, constructeurs `CiscoRouter`/`HuaweiRouter`) selon le pattern déjà exemplaire ailleurs dans le dépôt (`src/database/oracle/views/`, un fichier par vue) | Génie logiciel (01, 02, 04, 05, 07, 08) | Élevé (continu) | Faible à court terme, élevé à long terme (maintenabilité) |

### Lecture rapide

- **Si une seule chose doit être corrigée en premier** : le contournement
  SSH/SCP (P0 #1) — c'est l'écart le plus visible entre ce que l'exigence
  produit demande et ce que l'utilisateur expérimente réellement au clavier,
  et l'infrastructure réelle (TcpStack, SshServerHandler) existe déjà des
  deux côtés, il ne manque que le câblage.
- **Le meilleur ratio effort/impact immédiat** : le bug bash des tableaux non
  quotés (une seule regex à corriger) et les 3 doubles dispatch de commandes
  (suppression de code, pas ajout) — deux corrections à faible effort et
  fort impact pédagogique.
- **Le risque le plus urgent en termes de sécurité du produit** (crash
  utilisateur) : la boucle L2 synchrone sans garde-fou.

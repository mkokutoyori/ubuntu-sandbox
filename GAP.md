# GAP.md — Audit exhaustif de conformité et d'implémentation

> Ce document recense, sous-système par sous-système, tout ce qui est **stub**, **partiellement implémenté**,
> **non conforme aux RFC/normes du protocole simulé**, ou **contraire au modèle réactif/MVC** du projet
> (ex. commandes qui renvoient un texte figé au lieu de refléter l'état interne réel de l'équipement,
> moteurs de protocole pilotés par polling au lieu d'événements, etc.).
>
> Méthodologie : lecture du code source (moteurs de protocole, devices, shells, interpréteurs, UI/store),
> recoupement avec les RFC/spécifications normatives pertinentes, et vérification que chaque commande de
> CLI/terminal lit bien l'état vivant de l'`Equipment` plutôt que de renvoyer une sortie statique.
>
> Le document est rédigé **progressivement, section par section**, avec un commit/push après chaque section.
> Convention par constat : **Constat** (description) — **Preuve** (`fichier:ligne`) — **Sévérité** (Critique/Majeure/Mineure) — **Recommandation**.

---

## Sommaire

1. [Couche Equipment / Hardware / DeviceFactory](#1-couche-equipment--hardware--devicefactory)
2. [Commutation L2 (STP/RSTP/MSTP, VTP, DTP, LACP, UDLD, CDP, LLDP, dot1x, port-security, switch shells)](#2-commutation-l2)
3. [Routage L3 (OSPF/OSPFv3, BGP, EIGRP, RIP, moteur de routage, IPv6 data plane)](#3-routage-l3)
4. [Services réseau & sécurité périmétrique (DHCP, ARP, ACL, NAT, GRE, NHRP, BFD, IPSec)](#4-services-réseau--sécurité-périmétrique)
5. [Redondance & multicast (HSRP/VRRP/GLBP, IGMP/IGMP-snooping, PIM, VXLAN)](#5-redondance--multicast)
6. [Management, AAA & supervision (SNMP, NetFlow, NTP, Syslog, RADIUS, TACACS+, AAA, EEM, DNS)](#6-management-aaa--supervision)
7. [SSH/SCP/SFTP, abstraction shell, shells CLI Cisco/Huawei, couche terminal](#7-ssh-abstraction-shell--terminal)
8. [Interpréteur Bash & sous-systèmes hôte Linux](#8-interpréteur-bash--linux)
9. [Interpréteur PowerShell & sous-systèmes hôte Windows](#9-interpréteur-powershell--windows)
10. [Moteur de base de données Oracle](#10-moteur-oracle)
11. [Couche UI / Store / React (conformité MVC et réactivité)](#11-couche-ui--store--react)

---

## 1. Couche Equipment / Hardware / DeviceFactory

Cette couche fondamentale est globalement saine et bien factorisée : `Equipment`/`EquipmentRegistry` ont été proprement découplés (singleton injectable, événements pub/sub via `EventBus`), `Port`/`Cable`/`PortSecurity` modélisent fidèlement la couche physique avec négociation, compteurs RFC 2863, IPv6 multi-adresses, etc., et la transmission de trames reste peer-to-peer via les câbles, conforme au modèle "equipment-driven, no mediator". Les principaux points faibles concernent : (1) les God Classes `Router`/`EndHost` qui dupliquent une logique de résolution de voisinage qu'une abstraction dédiée (`NeighborResolver`) a justement été écrite pour éliminer mais qui reste inutilisée ; (2) plusieurs stubs concrets dans `DeviceFactory` (firewalls → `LinuxPC`, `cloud`/`access-point` détournés) et dans `Router`/`Switch` (`getBanner` toujours vide alors que `banner motd` est bien configurable et attendu par le terminal) ; (3) une asymétrie IPv4/IPv6 assumée mais qui laisse les hôtes sans pare-feu/NAT IPv6.

**Tailles actuelles (vs audit antérieur)** : `Router.ts` = 2328 lignes (réduit depuis ~4400 mentionné dans un audit précédent), `EndHost.ts` = 2440 lignes (en hausse depuis ~1900), `Switch.ts` = 1297 lignes — les trois restent largement au-dessus du seuil raisonnable de SRP pour une classe de domaine.

### 1.1 God classes — Router / EndHost / Switch toujours hors normes
- **Constat** : `Router.ts` fait 2328 lignes, `EndHost.ts` 2440 lignes, `Switch.ts` 1297 lignes. Malgré l'extraction de ~30 services délégués (NAT, ACL, IPv6, SSH, AAA, EEM, NetFlow, NHRP, VRRP, BFD, etc.), `Router` reste un agrégateur géant qui mélange L2 (ARP, trames), L3 (routage, ICMP, NAT, IPSec, ACL), L4 (TcpStack, sessions VTY/SSH) et gestion CLI/AAA/management dans la même classe.
- **Preuve** : `src/network/devices/Router.ts:169-1757` (déclaration de ~80 champs privés couvrant routage, ARP, RIP, OSPF, IPv6, ACL, DHCP, NAT, IPSec, SSH/AAA, NHRP/DMVPN, SNMP/EEM/NetFlow/Archive/Keypair, VRRP/BFD Huawei, etc., tous portés par la même classe).
- **Sévérité** : Majeure
- **Recommandation** : Poursuivre la décomposition en façades thématiques (`RouterL3Forwarding`, `RouterCliRuntime`, `RouterManagementSuite`) injectées comme le sont déjà `NATEngine`/`ACLEngine`, pour que `Router` ne reste qu'un assembleur fin exposant `handleFrame`.

### 1.2 Duplication ARP/NDP — `NeighborResolver` écrit puis jamais branché
- **Constat** : `src/network/core/NeighborResolver.ts` a été conçu explicitement pour « éliminer ~300 lignes de logique ARP/NDP dupliquée » entre Router et EndHost, mais il n'est référencé nulle part en dehors de son propre test et de ses ré-exports. `Router` et `EndHost` maintiennent chacun leur propre `arpTable: Map`, `inFlightFwdARPs: Set`, file d'attente et flush (`queueAndResolve`/`flushPacketQueue` côté Router vs `fwdQueueAndResolve`/`flushFwdQueue` côté EndHost), avec une logique quasi identique.
- **Preuve** : `src/network/core/NeighborResolver.ts:1-13` (commentaire « Fixes: 1.2: Eliminates ~300 lines of duplicated ARP/NDP resolution logic ») ; usages réels limités à `src/network/core/index.ts:39-40` et `src/__tests__/unit/events/NeighborResolver.scheduler.test.ts` ; duplication visible entre `src/network/devices/Router.ts:170,233,1324,1351` et `src/network/devices/EndHost.ts:171,177,921,1118`.
- **Sévérité** : Majeure
- **Recommandation** : Soit migrer `Router`/`EndHost` vers `NeighborResolver` (réalisant le gain de factorisation prévu), soit supprimer la classe non utilisée pour ne pas laisser une infrastructure « fantôme » qui induit en erreur les futurs contributeurs.

### 1.3 DeviceFactory — stubs explicites de types d'équipement
- **Constat** : trois types `firewall-*` sont instanciés comme de simples `LinuxPC` (commentaire « stub as LinuxPC for now »). `cloud` est également une `LinuxPC` déguisée, et `access-point` est un `Hub` (répéteur L1 sans aucune logique Wi-Fi/SSID/association). `isFullyImplemented()` reflète honnêtement cet état (les types `firewall-*`, `access-point`, `cloud` n'y figurent pas), mais `hasTerminalSupport()` annonce un support terminal pour les firewalls alors que ce sont des terminaux Linux bash sans aucune sémantique « pare-feu vendor ».
- **Preuve** : `src/network/devices/DeviceFactory.ts:57-69` (`case 'firewall-cisco': return new LinuxPC(...)`, `case 'cloud': return new LinuxPC(...)`, `case 'access-point': return new Hub(...)`) ; `DeviceFactory.ts:88-90` inclut les firewalls dans `hasTerminalSupport` mais `DeviceFactory.ts:97-114` les exclut de `isFullyImplemented`.
- **Sévérité** : Mineure (le code documente honnêtement le compromis) à Majeure si l'utilisateur s'attend à une CLI Cisco ASA/Fortinet/PAN-OS.
- **Recommandation** : Soit développer de vraies classes `CiscoFirewall`/`FortinetFirewall` avec leur propre shell, soit renommer/masquer ces entrées de palette tant qu'elles ne sont que des `LinuxPC` déguisées, pour éviter la confusion utilisateur.

### 1.4 Piège latent dans `Equipment.getOSType()` — heuristique sur le nom du type
- **Constat** : `Equipment.getOSType()` déduit l'OS par sous-chaînes (`t.includes('cisco')` → `'cisco-ios'`). Pour `firewall-cisco` (instancié comme `LinuxPC`), ce chemin serait emprunté si `LinuxMachine` ne surchargeait pas la méthode — ce qui est heureusement le cas (`LinuxMachine.getOSType()` renvoie `'linux'`). Le risque est néanmoins réel pour tout futur `DeviceType` contenant « cisco »/« windows »/« linux » dont la classe concrète ne surcharge pas `getOSType`.
- **Preuve** : `src/network/equipment/Equipment.ts:131-137` ; surcharge salvatrice dans `src/network/devices/LinuxMachine.ts:1273`.
- **Sévérité** : Mineure
- **Recommandation** : Faire reposer `getOSType()` uniquement sur `instance.constructor.name` ou un mapping explicite `DeviceType → OSType`, pas sur un test de sous-chaîne du nom du type métier.

### 1.5 `getBanner()` — stub vide alors que `banner motd` est configurable et attendu
- **Constat** : `Router.getBanner(type)` et `Switch.getBanner(type)` renvoient systématiquement `''`, quel que soit `type`. Pourtant la commande `banner motd <texte>` est bien acceptée par `CiscoShellBase` (et l'équivalent Huawei `header`) et stockée — mais dans le champ `sshBannerText`, partagé avec la bannière SSH pré-authentification. Côté terminal, `CLITerminalSession` appelle explicitement `cliDevice.getBanner('motd')` à deux endroits (boot initial et reconnexion de session) pour afficher le MOTD localement. Résultat : configurer une bannière MOTD sur un routeur/switch n'a **aucun effet visible** sur la console locale.
- **Preuve** : stub à `src/network/devices/Router.ts:1487-1490` et `src/network/devices/Switch.ts:1288-1291` ; écriture de la config dans `sshBannerText` via `_setSshBanner` à `src/network/devices/shells/CiscoShellBase.ts:1177-1183` ; consommation attendue mais déçue dans `src/terminal/sessions/CLITerminalSession.ts:94` et `:121`.
- **Sévérité** : Majeure (fonctionnalité CLI documentée et acceptée par le parseur, mais sans effet observable — typiquement le genre d'écart que les tests « transcript dump » devraient révéler).
- **Recommandation** : Faire de `getBanner('motd')` une lecture dérivée de l'état réel (par ex. distinguer `_motdBannerText` de `sshBannerText`, ou réutiliser le même champ mais brancher `getBanner` dessus) plutôt qu'un retour canné.

### 1.6 Property bag dynamique non typé : `ipv6AccessLists`
- **Constat** : `Router` ne déclare jamais de champ `ipv6AccessLists`, mais `RouterOSPFIntegration` reçoit un getter `getIPv6AccessLists: () => (this as any).ipv6AccessLists`, et `CiscoAclCommands.ts` crée/peuple cette propriété à la volée sur l'instance (`if (!r.ipv6AccessLists) r.ipv6AccessLists = []`). C'est un contournement du système de types qui fonctionne par effet de bord (même objet JS), mais qui est invisible dans la définition de la classe — un audit statique ou un futur refactor de `Router` casserait silencieusement cette fonctionnalité (`show ipv6 access-list`, filtrage OSPFv3, etc.).
- **Preuve** : `src/network/devices/Router.ts:270` ; création/usage dynamique dans `src/network/devices/shells/cisco/CiscoAclCommands.ts:662,687-691,714,731-733,770-771` ; consommation dans `src/network/devices/router/RouterOSPFIntegration.ts:81,1158`.
- **Sévérité** : Majeure
- **Recommandation** : Déclarer `private ipv6AccessLists: Ipv6AclEntry[] = []` directement sur `Router` (au même titre que `aclEngine`/`natEngine`) et exposer un accesseur typé, supprimant tous les `(this as any)`/`(r as any)`.

### 1.7 Réactivité / event-driven — globalement conforme, deux entorses notables
- **Constat (positif)** : `Port`, `Cable`, `Equipment`, `EquipmentRegistry` publient systématiquement sur `IEventBus` (cycle de vie, configuration, sécurité, trames) et utilisent `TimerSet`/`Scheduler` injectables plutôt que des `setTimeout` bruts dans la majorité des cas.
- **Constat (entorse 1)** : `Router.queueAndResolve` instancie un `setTimeout` natif non géré par le `Scheduler`/`TimerSet` injectable du routeur (contrairement à `routerTimers`), ce qui casse le déterminisme/contrôlabilité en test (impossible à avancer via un faux scheduler).
- **Preuve** : `src/network/devices/Router.ts:1326` (`const timer = setTimeout(() => {...}, 2000);`) — alors que `protected readonly routerTimers = new TimerSet(...)` existe à la ligne `230` et est utilisé ailleurs.
- **Constat (entorse 2)** : `Cable.transmit` documente lui-même que la livraison reste synchrone « pour préserver la sémantique de pile d'appels actuelle » et que la migration vers un scheduler-driven async est reportée à une « Phase 6 » — donc le modèle de propagation/délai (`getPropagationDelay`) est calculé mais n'a aucun effet réel sur le timing de livraison.
- **Preuve** : `src/network/hardware/Cable.ts:322-325`.
- **Sévérité** : Mineure (le code documente honnêtement ces compromis)
- **Recommandation** : Migrer `queueAndResolve` vers `this.routerTimers`/`getRouterScheduler()` pour cohérence et testabilité ; planifier effectivement la Phase 6 de livraison asynchrone par câble si le réalisme temporel devient un objectif.

### 1.8 Cohérence show-commands ↔ état interne
- **Constat (globalement bon)** : les accesseurs `_getRoutingTableInternal`, `_getArpTableInternal`, `_getPortsInternal`, `getInfo()` (Port/Cable) renvoient directement les structures de données vivantes (ou des copies superficielles `{ ...this.counters }`), pas de valeurs cannées — conforme au modèle MVC attendu (le CLI lit l'état réel).
- **Constat (exception)** : `getBanner()` (cf. §1.5) est le seul point identifié dans cette couche où une méthode d'introspection censée refléter une configuration utilisateur renvoie une chaîne statique indépendamment de l'état réel.
- **Preuve** : bons exemples — `src/network/devices/Router.ts:1496-1497` (`_getRoutingTableInternal`/`_getArpTableInternal` renvoient les structures vivantes) ; mauvais exemple — `src/network/devices/Router.ts:1487-1490`.
- **Sévérité** : Mineure
- **Recommandation** : Ajouter un test de non-régression « transcript dump » qui configure `banner motd` puis ouvre une session console pour détecter ce type d'écart show-command/état réel.

### 1.9 Couverture IPv4 / IPv6 — asymétrie pare-feu/NAT documentée mais réelle
- **Constat** : `EndHost.firewallFilter`/`evaluateNat`/`evaluatePreRouting` (hooks `iptables`/NAT) ne sont invoqués que depuis `handleIPv4` (lignes 1002, 1027, 1065, 1078, 1267, 1446) — la voie de traitement IPv6 (NDP, ICMPv6, SLAAC, ping6) n'a aucun équivalent `ip6tables`/pare-feu/NAT64. Le code documente d'ailleurs explicitement que « End hosts don't forward IPv6 packets » (pas de routage IPv6 sur les hôtes), ce qui est un choix assumé mais qui élimine de facto tout besoin de filtrage IPv6 — sauf que le filtrage *entrant* (`firewallFilter(... 'in')`) devrait logiquement s'appliquer aussi aux paquets IPv6 entrants vers l'hôte lui-même (ICMPv6 echo, TCP sur IPv6), ce qui n'est pas le cas.
- **Preuve** : hooks IPv4 uniquement — `src/network/devices/EndHost.ts:947-977` (signatures typées `IPv4Packet` uniquement) et leurs appels `:1002,1027,1065,1078,1267,1446` ; commentaire explicite « End hosts don't forward IPv6 packets » à `src/network/devices/EndHost.ts:1914`.
- **Sévérité** : Majeure
- **Recommandation** : Ajouter des hooks `firewallFilterV6`/`evaluateNat66` (même s'ils renvoient `'accept'`/`null` par défaut comme leurs pendants IPv4) et les brancher dans le chemin de traitement ICMPv6/TCPv6 entrant, pour que `ip6tables`/`ufw` sur IPv6 ait un effet, conformément à l'attente d'un simulateur Linux réaliste.

### 1.10 Architecture — respect global du modèle « equipment-driven, peer-to-peer »
- **Constat** : la traversée de topologie pour la découverte DHCP (`autoDiscoverDHCPServers`) emprunte correctement le chemin câbles → ports → équipements pour la « Stratégie 1 », mais bascule sur un balayage global `Equipment.getAllEquipment()` en « Stratégie 2 » dès que la stratégie 1 ne trouve rien — un contournement explicite du modèle peer-to-peer, justifié dans le commentaire comme « confort de simulateur pour les tests sans câbles ».
- **Preuve** : `src/network/devices/EndHost.ts:676-711`, en particulier le fallback `:705-711` (`for (const equip of Equipment.getAllEquipment())`).
- **Sévérité** : Mineure
- **Recommandation** : Cantonner ce fallback global à un mode de test explicite (flag injecté) plutôt qu'une heuristique runtime (`dhcpClient['connectedServers'].length === 0`), pour ne pas masquer de vrais problèmes de câblage en production simulée.

---

## 2. Commutation L2 (STP/RSTP/MSTP, VTP, DTP, LACP, UDLD, CDP, LLDP, dot1x, port-security, switch shells)

Cette couche est globalement la plus mature du simulateur côté protocoles réactifs : CDP, LLDP, DTP, VTP, LACP et UDLD suivent fidèlement le pattern `<Protocol>Agent` + `types.ts` + `events.ts` prescrit par CLAUDE.md, avec exécution pilotée par `EventBus`/`Scheduler` (timers d'annonce, vieillissement, machine à états). En revanche, deux failles structurelles dégradent fortement la crédibilité de l'ensemble : (1) STP n'implémente qu'un sous-ensemble très simplifié de 802.1D (pas de transitions temporisées Listening/Learning, pas de RSTP réel, pas de MSTP) malgré des morceaux d'infrastructure RSTP/MSTP éparpillés ailleurs ; (2) plusieurs commandes `show`/`display` (notamment `show spanning-tree summary`, `display stp`, `display eth-trunk`) restent des gabarits texte statiques déconnectés du moteur vivant, alors que d'autres (`show etherchannel`, `show cdp neighbors`, `showSpanningTree` détaillé) interrogent correctement les agents. Le portage Huawei est nettement plus mince que Cisco, avec plusieurs protocoles absents côté Huawei alors qu'ils existent dans la réalité.

### 2.1 STP/RSTP/MSTP

- **Constat** : `StpAgent` implémente une élection de pont/racine BPDU correcte (comparaison de Bridge ID, calcul de coût, rôles root/designated/alternate) mais ne modélise **aucune transition temporisée** : un port passe directement de `disabled`/`alternate` à `forwarding`/`blocking` dès le calcul du rôle, sans passer par Listening (15s) puis Learning (15s) avec apprentissage MAC gelé entre-temps — alors que `Switch.ts` définit pourtant un type `STPPortState` à 5 valeurs incluant `listening`/`learning`.
- **Preuve** : `src/network/stp/StpAgent.ts:463-467` (`applyRole` mappe directement `role` → `desiredForward` sans délai) ; `src/network/devices/Switch.ts:105` (type `STPPortState` prévoit `listening`/`learning`) et `src/network/devices/Switch.ts:697-705` (`advanceSTPTimer`, devenu mort — voir 2.6).
- **Sévérité** : Majeure
- **Recommandation** : Faire dériver les transitions de `applyRole` via le `Scheduler` (forward-delay configurable, par défaut 15 s) afin de produire les états Listening/Learning observables par `show spanning-tree`/`display stp brief` et respecter IEEE 802.1D §8.

- **Constat** : Aucune implémentation de RSTP (802.1w) ni MSTP (802.1s) côté moteur : `StpAgent`/`types.ts` ne connaissent que le BPDU de configuration classique (`bpduType: 'config' | 'tcn'`, `protocolId: 0x0000`, `version: 0`), pas de rôles Backup/rapide, pas de régions/instances. Pourtant le code parle de « simulates RSTP rapid transition » et la CLI Cisco accepte `spanning-tree mode mst`/configure une « MST region » entièrement en mémoire locale du shell.
- **Preuve** : `src/network/stp/types.ts:4,15` (un seul `StpBpduType`/`StpPortRole` à 4 valeurs, pas de `backup`) ; `src/network/devices/Switch.ts:428` (commentaire « simulates RSTP rapid transition » sur un simple raccourci listening/learning→forwarding au link-up) ; `src/network/devices/shells/CiscoSwitchShell.ts:45-48,933-955,981-993` (`stpMode`, `mstRegion`, `ifStp` : état purement local au shell, jamais transmis à `StpAgent`).
- **Sévérité** : Majeure
- **Recommandation** : Soit documenter clairement que seul 802.1D classique est simulé et retirer/désactiver les commandes `mst`, soit étendre `StpAgent`/`types.ts` avec un véritable sous-moteur MSTP (régions, MSTI, CIST) suivant le pattern `<Protocol>Engine` + `actors/`.

- **Constat** : Le bridge ID annoncé dans `show spanning-tree` ajoute artificiellement `+1` à la priorité racine (`rootPrio = root.priority + 1`), ce qui ne correspond à aucune sémantique IEEE/Cisco connue et produira un nombre de priorité erroné à l'écran (p.ex. 32769 au lieu de 32768).
- **Preuve** : `src/network/devices/shells/CiscoSwitchShell.ts:1740` (`const rootPrio = root ? root.priority + 1 : 32769;`).
- **Sévérité** : Mineure
- **Recommandation** : Supprimer le `+1` et afficher `root.priority` tel quel (le system-id-extension Cisco est encodé séparément, pas additionné à la priorité affichée).

- **Constat** : `defaultPathCost`/`portIdFor` sont corrects pour 802.1D, mais le coût de port affiché dans `show spanning-tree` (`showSpanningTree`) est **codé en dur à `19`** pour toutes les interfaces, indépendamment de leur vitesse réelle (`defaultPathCost` retournerait 4 pour Gigabit, 2 pour 10G).
- **Preuve** : `src/network/devices/shells/CiscoSwitchShell.ts:1767` (`...19        128.${portName...`).
- **Sévérité** : Mineure
- **Recommandation** : Réutiliser `agent.getPortInfo(portName)?.cost` (ou exposer un accesseur dédié) au lieu de la constante `19`.

### 2.2 LACP (IEEE 802.3ad / 802.1AX)

- **Constat** : `LacpAgent` implémente correctement la négociation active/passive, l'échange de LACPDU (slow/fast rate, 30 s / 1 s), la sélection de liens et les transitions `standalone ↔ bundled`, avec publication d'événements (`lacp.port.bundled`, `lacp.port.state-changed`). C'est l'agent le plus conforme au protocole réel de toute cette passe d'audit.
- **Preuve** : `src/network/lacp/LacpAgent.ts:209-234` (timers slow/fast), `:287-312` (`runSelection` avec comparaison de `systemId`/`partner.key`).
- **Sévérité** : (positif — pas un défaut)
- **Recommandation** : RAS ; envisager d'ajouter le marqueur LACP (Marker Protocol, 802.1AX §6.5) pour un réalisme accru, mais ce n'est pas critique.

- **Constat** : `display eth-trunk` côté Huawei est rendu à partir d'une structure CLI locale `ethTrunks` totalement déconnectée du `LacpAgent` réellement mis à jour par `eth-trunk <id>` ; en particulier le statut `Up`/`Down` de chaque membre est dérivé de `t.members.length` (nombre total de membres) plutôt que de l'état réel du port/LACP (`bundled`, `partner`, link).
- **Preuve** : `src/network/devices/shells/HuaweiSwitchShell.ts:1397-1409` (`displayEthTrunk`, `t.members.map(m => ... (t.members.length ? 'Up' : 'Down') ...)`) vs `src/network/devices/shells/HuaweiSwitchShell.ts:639-643` (`applyToLacpAgent(a => { ... a.addPortToGroup(...) })`) — deux sources de vérité disjointes.
- **Sévérité** : Majeure
- **Recommandation** : Faire lire `displayEthTrunk` depuis `getLacpAgent().getGroupMembers(id)` (comme le fait `show etherchannel` côté Cisco, `CiscoSwitchShell.ts:1050-1071`) afin que l'affichage reflète l'état de bundling/partenaire réel.

### 2.3 CDP/LLDP

- **Constat** : `CdpAgent`/`LldpAgent` sont solidement implémentés — annonce périodique, vieillissement par hold-time, expiration via timer dédié 1 s, événements `*.neighbor.discovered/refreshed/expired`, intégration bus correcte (`port.link.up/down`).
- **Preuve** : `src/network/cdp/CdpAgent.ts:316-342` (timers d'annonce/expiration), `:358-371` (flush au link-down/désactivation).
- **Sévérité** : (positif)
- **Recommandation** : RAS pour le moteur.

- **Constat** : `CdpAgent.capabilityToType` mappe la capacité distante (`Router`/`Switch`/`Host`) directement vers un `DeviceType` **uniquement Cisco** (`router-cisco`, `switch-cisco`, `linux-pc`), de sorte qu'un voisin Huawei serait classé comme matériel Cisco dans la table `show cdp neighbors detail` ou tout consommateur de `CdpNeighbor.remoteType`.
- **Preuve** : `src/network/cdp/CdpAgent.ts:405-409`.
- **Sévérité** : Mineure
- **Recommandation** : Dériver `remoteType` à partir du `platform`/`deviceId` réel transmis dans le CDP frame plutôt que de la capacité seule, ou exposer le vrai `DeviceType` dans le payload CDP.

### 2.4 dot1x & port-security

- **Constat** : `Dot1xAgent` implémente un véritable échange EAP (Identity request/response, succès/échec, comptage de réessais, état `held`), mais le callback d'autorisation transmis par `CiscoSwitch` est un **stub vide qui « voile » ses paramètres** sans aucun effet de bord, alors que `isPortAuthorized` est consultée ailleurs pour bloquer le trafic.
- **Preuve** : `src/network/devices/CiscoSwitch.ts:110-112` (`private applyDot1xAuth(_portName: string, _authorized: boolean): void { void _portName; void _authorized; }`) — le hook ne fait littéralement rien, alors qu'il est branché en ligne 96.
- **Sévérité** : Majeure (l'autorisation de port n'a aucun effet visible côté device au-delà du filtre déjà fait par `isPortAuthorized` au frame-handling — cf. ligne 193 — donc la fonctionnalité fonctionne malgré tout via une autre voie, mais le hook dédié est mort).
- **Recommandation** : Supprimer ce hook mort ou l'utiliser réellement (p.ex. déclencher un changement d'état STP/err-disable, journaliser, basculer vers le VLAN invité).

- **Constat** : Les champs `guestVlan` et `reauthIntervalSec` de `Dot1xConfig` sont déclarés et initialisés mais **jamais lus** par `Dot1xAgent` — pas de bascule vers un VLAN invité après échec d'authentification, pas de ré-authentification périodique programmée.
- **Preuve** : `src/network/dot1x/types.ts:99-101` (déclaration) vs absence totale de référence dans `src/network/dot1x/Dot1xAgent.ts` (seul `holdUntilMs`/`holdMs` sont utilisés, lignes 126/179).
- **Sévérité** : Mineure
- **Recommandation** : Implémenter la bascule VLAN invité (`guestVlan`) et un timer de ré-authentification pilotable par `Scheduler`, ou retirer ces champs du type pour éviter toute confusion sur ce qui est réellement supporté.

- **Constat** : L'état `held` n'est jamais réévalué par un timer — un supplicant qui ne renvoie pas d'`EAPOL-Start` reste bloqué indéfiniment au-delà de `holdMs`, alors que sur un vrai commutateur le port redevient automatiquement `unauthorized`/réessayable à l'expiration du hold-timer.
- **Preuve** : `src/network/dot1x/Dot1xAgent.ts:126` (`if (rt.holdUntilMs > Date.now()) return;` — le contrôle n'a lieu qu'à la réception d'un nouvel `EAPOL-Start`, pas via un timer programmé).
- **Sévérité** : Mineure
- **Recommandation** : Ajouter un `setTimeout`/`Scheduler.setTimeout` à l'entrée en état `held` qui ramène le port à `unauthorized` à l'expiration de `holdMs`.

- **Constat** : `PortSecurity` (hardware/PortSecurity.ts) est riche (sticky/static/dynamic, aging absolu/inactivité, modes de violation shutdown/restrict/protect) et `show port-security` semble dérivé de cet état réel — c'est l'un des sous-systèmes de sécurité L2 les plus aboutis.
- **Preuve** : `src/network/hardware/PortSecurity.ts:34-49` (modèle `SecureMacEntry`/`SecurityVerdict`).
- **Sévérité** : (positif)
- **Recommandation** : RAS.

### 2.5 VTP/DTP

- **Constat** : `VtpAgent` et `DtpAgent` sont tous deux des moteurs réactifs complets et fidèles : VTP gère correctement les modes server/client/transparent, le hachage de mot de passe de domaine, la comparaison de numéro de révision, le relais en mode transparent, et l'annonce sommaire périodique (300 s) ; DTP négocie correctement le mode opérationnel via `resolveOperationalMode` et notifie le switch hôte des changements (`onOperationalModeChanged`).
- **Preuve** : `src/network/vtp/VtpAgent.ts:160-179` (logique d'application de révision supérieure + relais), `src/network/dtp/DtpAgent.ts:86-103` (négociation admin/peer → mode opérationnel).
- **Sévérité** : (positif)
- **Recommandation** : RAS pour le moteur ; à noter que VTP n'a pas d'équivalent côté Huawei (cf. 2.7), ce qui est cohérent avec la réalité (VTP est propriétaire Cisco) — pas un défaut.

### 2.6 Cohérence show ↔ état interne

- **Constat** : `show spanning-tree summary` (Cisco) renvoie un texte **entièrement statique**, toujours « Root bridge for: none » et un tableau de comptage vide, quel que soit l'état réel du `StpAgent` (pont racine élu, ports en blocage, etc.) — alors que la commande sœur `show spanning-tree` (sans argument) interroge correctement l'agent via `showSpanningTree`.
- **Preuve** : `src/network/devices/shells/CiscoSwitchShell.ts:965-970` (gabarit figé `Root bridge for: none`) vs `:1733-1769` (`showSpanningTree` dérive de `agent.getRootBridge()`/`getPortRole`).
- **Sévérité** : Majeure
- **Recommandation** : Faire calculer le récapitulatif (nombre de ports par état STP, indicateur "root bridge for: VLANxxxx") à partir de `agent.getRootBridge()`/`isRoot()`/`stpStates`, exactement comme `showSpanningTree`.

- **Constat** : `display stp` (Huawei) est lui aussi **un gabarit figé** : adresse MAC racine toujours `0000-0000-0000`, `CIST RootPortId :0.0`, `Config Times`/`Active Times` toujours `Hello 2s MaxAge 20s FwDly 15s MaxHop 20` — aucune valeur n'est lue depuis `StpAgent` (alors que `displayStpBrief`, juste à côté, l'interroge correctement).
- **Preuve** : `src/network/devices/shells/HuaweiSwitchShell.ts:1350-1364` (`displayStp`, valeurs codées en dur) vs `:1366-1379` (`displayStpBrief` qui appelle `getStpAgent()`).
- **Sévérité** : Majeure
- **Recommandation** : Réutiliser `agent.getRootBridge()`, `agent.getConfig()` (helloSec/maxAgeSec/forwardDelaySec) et `agent.getRootPort()` pour produire ces lignes ; le test associé (`huawei-stp.test.ts:40-47`) ne vérifie que la présence de la chaîne `RSTP`, ce qui masque ce défaut.
- Voir également 2.2 pour `display eth-trunk` (même anti-pattern de double source de vérité).

- **Constat** : `advanceSTPTimer`/`setAllPortsSTPState` dans `Switch.ts` sont devenus du **code mort** depuis que `StpAgent` pilote directement `setSTPState` via `applyStpForwardState` — aucun appelant ne subsiste.
- **Preuve** : `src/network/devices/Switch.ts:697-710` ; recherche globale ne montre aucun site d'appel hors définition.
- **Sévérité** : Mineure
- **Recommandation** : Supprimer ces deux méthodes (ou les réutiliser dans la temporisation Listening/Learning recommandée en 2.1, ce qui leur redonnerait un sens).

### 2.7 Disparité Cisco/Huawei

- **Constat** : `HuaweiSwitch` ne câble que trois agents protocolaires (LLDP, STP, LACP) alors que `CiscoSwitch` en câble dix (CDP, LLDP, DTP, STP, LACP, VTP, UDLD, IGMP-snooping, Syslog, dot1x). Or UDLD, IGMP-snooping, 802.1X et le port-security sont des fonctionnalités standards sur les commutateurs Huawei S-series réels (et VTP/DTP sont légitimement absents car propriétaires Cisco).
- **Preuve** : `src/network/devices/HuaweiSwitch.ts:14-43` (3 agents seulement) vs `src/network/devices/CiscoSwitch.ts:39-108` (10 agents).
- **Sévérité** : Majeure
- **Recommandation** : Ajouter au minimum `UdldAgent`, `IgmpSnoopingAgent`, `Dot1xAgent` et `SyslogAgent` à `HuaweiSwitch` (le câblage est trivial vu le pattern `hostBase` déjà en place), et exposer les commandes `display`/`stp`/`dot1x` correspondantes côté `HuaweiSwitchShell`.

- **Constat** : Le mot-clé `port-security` apparaît uniquement comme entrée d'auto-complétion dans `HuaweiSwitchShell` (listes de complétion d'interface), sans aucun gestionnaire de commande associé — contrairement à Cisco où `port-security` dispose d'un sous-système complet (`PortSecurity`, `show port-security*`).
- **Preuve** : `src/network/devices/shells/HuaweiSwitchShell.ts:762,1231` (apparaît seulement dans des tableaux de mots-clés de complétion `['loopback-detect', 'port-security', ...]`) ; aucune occurrence de `getSecurityService`/`PortSecurity` dans ce fichier.
- **Sévérité** : Majeure
- **Recommandation** : Implémenter `port-security` côté Huawei (la classe `PortSecurity`/`SwitchSecurityService` est déjà vendor-neutre dans `Switch.ts`) — actuellement la complétion Tab suggère une commande qui échoue ou ne fait rien à l'exécution, ce qui est trompeur pour l'utilisateur.

- **Constat** : Aucune suite de transcript "debug" Huawei n'exerce spanning-tree, LACP, CDP/LLDP, dot1x, VTP/DTP ou UDLD (`grep` sur `_huawei-suite.ts` et les fichiers `huawei-*.debug.test.ts` ne renvoie aucun résultat pour ces protocoles), alors que côté Cisco `cisco-stp-security.debug.test.ts` couvre au moins STP/sécurité.
- **Preuve** : recherche vide dans `src/__tests__/debug/huawei/` pour les motifs `lacp|cdp|lldp|dot1x|vtp|dtp|udld|spanning-tree`.
- **Sévérité** : Mineure
- **Recommandation** : Étoffer les suites debug Huawei pour couvrir au moins `display stp`/`display lacp`/`display lldp neighbor`, ce qui aurait probablement révélé les gabarits figés signalés en 2.6.

---

## 3. Routage L3 (OSPF/OSPFv3, BGP, EIGRP, RIP, moteur de routage, IPv6 data plane)

L'OSPF (v2) est de loin le sous-système le plus mature de cette famille — FSM complet, élection DR/BDR conforme RFC 2328 §9.4, LSA de types 1-5/7, SPF de Dijkstra avec cache partiel, NSSA et virtual links — et dispose d'une couverture de tests considérable (13+ fichiers dédiés). À l'opposé, BGP et EIGRP sont des « moteurs légers » assumés (commentaires explicites « real, lightweight ») qui ne modélisent ni FSM réel, ni échange de paquets, ni algorithmes RFC propres (DUAL, sélection de meilleur chemin BGP) — ils dérivent simplement des routes/voisins de la configuration et de la topologie câblée. OSPFv3 souffre d'un écart de profondeur sévère par rapport à OSPFv2 : son moteur ne calcule jamais de routes (`getRoutes()` retourne toujours `[]`), et la couche d'intégration contourne entièrement son FSM pour fabriquer des voisins « Full » à la main. Le plan de données IPv6 ne consomme aucune route protocolaire dynamique.

### 3.1 OSPF / OSPFv2 — implémentation mature, RFC 2328 globalement respecté
- **Constat** : FSM voisin complet (Down→Init→TwoWay→ExStart→Exchange→Loading→Full), élection DR/BDR conforme à l'algorithme en deux passes RFC 2328 §9.4 (réélection du BDR si celui-ci est promu DR), génération de Router-LSA, Network-LSA, Summary-LSA, ASBR-Summary-LSA, AS-External-LSA et NSSA-External-LSA, support des aires stub/totally-stubby/NSSA, calcul SPF par Dijkstra avec cache d'arbre par aire (« partial SPF »), virtual links.
- **Preuve** : `src/network/ospf/OSPFEngine.ts:1588-1625` (élection DR/BDR en 3 étapes), `src/network/ospf/OSPFEngine.ts:2184-2443` (origination des LSA de types 1–4), `src/network/ospf/OSPFEngine.ts:2723-3024` (Dijkstra + cache `spfTreeCache`), `src/network/ospf/OSPFEngine.ts:649-661` et `2840-2921` (gestion stub/totally-stubby/NSSA).
- **Sévérité** : Information (point fort).
- **Recommandation** : aucune action requise ; ce module peut servir de référence de qualité pour les autres protocoles.

### 3.2 OSPF — quasiment exempt de TODO/stub
- **Constat** : recherche systématique de TODO/FIXME/« not implemented »/canned : un seul commentaire technique sans portée fonctionnelle (suppression de flood redondant), aucune trace de stub ou de valeur figée.
- **Preuve** : `src/network/ospf/OSPFEngine.ts:2587` (« MinLSInterval not yet elapsed — suppress redundant flood », commentaire normal de throttling RFC, pas un gap).
- **Sévérité** : Mineure (juste pour mémoire — confirme l'absence de gap).
- **Recommandation** : RAS.

### 3.3 OSPFv3 — l'algorithme SPF n'est jamais exécuté, `getRoutes()` retourne toujours un tableau vide
- **Constat** : `OSPFv3Engine` maintient un champ `ospfRoutes: OSPFRouteEntry[]` initialisé à `[]`, jamais alimenté par un calcul SPF/Dijkstra, et remis à `[]` lors du reset. `getRoutes()` se contente donc de renvoyer une copie d'un tableau vide en permanence — l'engine ne contribue jamais de routes IPv6 au RIB.
- **Preuve** : `src/network/ospf/OSPFv3Engine.ts:74` (déclaration `private ospfRoutes: OSPFRouteEntry[] = []`), `src/network/ospf/OSPFv3Engine.ts:828` (`getRoutes(): OSPFRouteEntry[] { return [...this.ospfRoutes]; }`), `src/network/ospf/OSPFv3Engine.ts:870` (réinitialisation à `[]` au reset) ; aucune occurrence d'un calcul SPF/Dijkstra dans tout le fichier.
- **Sévérité** : Critique.
- **Recommandation** : porter (ou réutiliser via composition) l'algorithme SPF de `OSPFEngine` pour OSPFv3, en l'adaptant aux LSA spécifiques (Link-LSA, Intra-Area-Prefix-LSA) ; sans cela, le moteur OSPFv3 est un parseur/FSM « de façade » qui ne produit jamais de table de routage exploitable.

### 3.4 OSPFv3 — flooding des Link-LSA explicitement repoussé à « une future itération »
- **Constat** : `originateLinkLSA()` construit la LSA et la stocke localement, mais le commentaire indique explicitement que la diffusion (flooding) sur le lien vers `AllSPFRouters` n'est pas implémentée.
- **Preuve** : `src/network/ospf/OSPFv3Engine.ts:775-776` (« Flooding Link-LSAs on the link is left to a future iteration (production would send via the interface to AllSPFRouters). »).
- **Sévérité** : Majeure.
- **Recommandation** : implémenter la diffusion réelle des Link-LSA (RFC 5340 §4.4.1), faute de quoi les voisins OSPFv3 ne peuvent jamais apprendre les adresses link-local et les préfixes annoncés via ce type de LSA.

### 3.5 OSPFv3 — checksums LSA toujours à zéro, module `checksum.ts` non réutilisé
- **Constat** : les Link-LSA et Intra-Area-Prefix-LSA construites par `OSPFv3Engine` portent systématiquement `checksum: 0` ; le module `ospf/checksum.ts` (Fletcher checksum RFC 2328 Annexe C) n'est ni importé ni étendu pour le format OSPFv3.
- **Preuve** : `src/network/ospf/OSPFv3Engine.ts:765` et `:805` (`checksum: 0` codé en dur) ; absence totale de `computeOSPFLSAChecksum`/`verifyOSPFLSAChecksum` dans `OSPFv3Engine.ts`.
- **Sévérité** : Mineure.
- **Recommandation** : calculer un vrai checksum LSA (ou documenter explicitement que la vérification d'intégrité OSPFv3 est hors-scope du simulateur) pour la cohérence avec OSPFv2.

### 3.6 OSPFv3 — l'adjacence et les routes IPv6 sont fabriquées dans la couche d'intégration, contournant entièrement le FSM et le moteur réels
- **Constat** : `RouterOSPFIntegration.v3FormAdjacency()` construit un objet voisin codé en dur avec `state: 'Full'` directement injecté dans `localIface.neighbors`, sans jamais passer par l'échange Hello/Database-Description du `OSPFv3Engine` (dont les seuls appels sont des accesseurs passifs : `getInterface`, `getConfig`, `getRouterId`, `getInterfaces`). De même, `v3ComputeRoutes()` réimplémente sa propre traversée de proche en proche (BFS façon « reachability via adjacency chain ») et sa propre élection DR/BDR au lieu d'utiliser `ospfv3Engine.getRoutes()` — qui de toute façon est toujours vide (cf. 3.3).
- **Preuve** : `src/network/devices/router/RouterOSPFIntegration.ts:893-945` (objet voisin fabriqué avec `state: 'Full'`, `lastHelloReceived: Date.now()`, et ré-élection DR/BDR maison `localIface.dr = candidates[0]?.rid`), `src/network/devices/router/RouterOSPFIntegration.ts:947-1000` (`v3ComputeRoutes` : suppression des anciennes routes `r.type !== 'ospf'` puis BFS sur `allPeers` au lieu d'appeler `getRoutes()`).
- **Sévérité** : Critique.
- **Recommandation** : remplacer ce contournement par un véritable pipeline Hello→DD→LSR/LSU→SPF dans `OSPFv3Engine`, exposé et consommé via `getNeighbors()`/`getRoutes()`, à l'image de ce qui existe pour OSPFv2. En l'état, « OSPFv3 fonctionne dans le simulateur » au prix d'une duplication de logique ad-hoc qui n'est ni testée au niveau protocole ni cohérente avec l'engine déclaré.

### 3.7 BGP — moteur « léger » sans FSM RFC 4271, sans attributs de chemin ni algorithme de meilleur chemin
- **Constat** : `BGPEngine` (141 lignes) ne modélise ni l'échange de messages OPEN/UPDATE/NOTIFICATION/KEEPALIVE, ni les états `Connect`/`OpenConfirm` du FSM (bien que le type `NeighborFsmState` les définisse), ni les attributs de chemin (AS_PATH, LOCAL_PREF, MED, NEXT_HOP, ORIGIN), ni l'algorithme de sélection du meilleur chemin, ni route-reflection/confédérations. L'état de session est dérivé de manière déterministe de la configuration (réciprocité de `neighbor`/AS) : `Idle` (pas de pair câblé), `Active` (pair non réciproque), `OpenSent` (utilisé en impasse permanente pour signaler une incompatibilité d'AS — jamais une vraie phase protocolaire), ou `Established`.
- **Preuve** : `src/network/bgp/BGPEngine.ts:74-88` (`sessionState()` — les seuls états atteignables sont `Idle`/`Active`/`OpenSent`/`Established`, jamais `Connect`/`OpenConfirm`), `src/network/bgp/BGPEngine.ts:120-140` (`computeRoutes` n'attribue qu'une `metric: 0` fixe et une AD eBGP/iBGP figée — aucune sélection multi-chemins ni comparaison d'attributs), `src/network/routing/types.ts:27-29` (le type `NeighborFsmState` définit bien les 8 états RFC 4271 mais 4 d'entre eux ne sont jamais produits par BGPEngine).
- **Sévérité** : Majeure.
- **Recommandation** : si l'objectif est de rester « léger », documenter explicitement (au niveau du module, pas seulement en commentaire de fichier) que BGP est un substitut simplifié sans FSM/attributs réels ; sinon, implémenter au minimum AS_PATH + sélection de meilleur chemin pour rendre `show ip bgp` crédible au-delà d'un simple « path i ».

### 3.8 EIGRP — DUAL totalement absent malgré une conception détaillée documentée (`docs/DESIGN-EIGRP.md`)
- **Constat** : le document de conception décrit une architecture complète à plusieurs couches (DUAL avec successeurs/successeurs de secours, Topology Table, RTP fiable, dispatcher de 5 types de paquets Hello/Update/Query/Reply/Ack, métrique composite pondérée par K1..K5). L'implémentation réelle (`EIGRPEngine.ts`, 161 lignes) ne contient rien de tout cela : pas de Topology Table, pas de condition de faisabilité, pas de paquets, pas de coefficients K — uniquement une adjacence basée sur la correspondance d'AS et des routes fabriquées avec une métrique fixe `metric: 1` et une AD figée à 90.
- **Preuve** : `docs/DESIGN-EIGRP.md:52,108,111,147-148` (architecture DUAL/RTP/5 types de paquets/métrique composite K1-K5 documentée), vs `src/network/eigrp/EIGRPEngine.ts:136-160` (`computeRoutes` : `metric: 1`, `adminDistance: EIGRP_INTERNAL_AD` = 90, codé en dur), `src/network/eigrp/EIGRPEngine.ts:6` (le seul vestige est le commentaire « DUAL-style successor », sans aucune trace de code DUAL — confirmé par une recherche globale qui ne renvoie que ce commentaire).
- **Sévérité** : Critique.
- **Recommandation** : soit aligner le code sur la conception documentée (implémenter au moins une version simplifiée de DUAL avec successeur/successeur de secours et la métrique composite), soit retirer/réviser `docs/DESIGN-EIGRP.md` pour refléter l'état réel — l'écart actuel entre conception et code est trompeur pour quiconque s'y réfère.

### 3.9 BGP/EIGRP — non-conformité à la convention de structure de protocole décrite dans CLAUDE.md
- **Constat** : la convention du dépôt (« Reactive protocol engines... follow a consistent shape: `<Protocol>Engine.ts` + `types.ts` + `events.ts` + `observables.ts` + `actors/` ») n'est pas respectée : les répertoires `bgp/` et `eigrp/` ne contiennent QUE le fichier `*Engine.ts`, sans `types.ts`, `events.ts`, `observables.ts` ni `actors/` propres (ils réutilisent les génériques de `routing/`).
- **Preuve** : listing `src/network/bgp/` et `src/network/eigrp/` → un seul fichier chacun (`BGPEngine.ts`, `EIGRPEngine.ts`), à comparer avec `src/network/ospf/` (8 fichiers + 11 acteurs) et `src/network/rip/` (`RIPEngine.ts` + `events.ts` + `observables.ts` + `actors/`).
- **Sévérité** : Mineure.
- **Recommandation** : soit documenter explicitement que les protocoles « légers » construits sur `AbstractRoutingProtocolEngine` sont dispensés de cette structure (et l'indiquer dans CLAUDE.md), soit créer les fichiers `types.ts`/`events.ts` dédiés pour la cohérence inter-modules.

### 3.10 RIP — implémentation conforme RFC 2453, mais hors de l'abstraction commune
- **Constat** : `RIPEngine` implémente correctement les mises à jour périodiques/déclenchées, le split-horizon avec poison-reverse, le timeout/garbage-collection et la limite à 16 (infini). En revanche, il n'étend pas `AbstractRoutingProtocolEngine` — c'est un `IProtocolEngine` autonome piloté par callbacks, exposé au reste du système via un adaptateur séparé (`RipEngineAdapter`).
- **Preuve** : `src/network/rip/RIPEngine.ts:128` (`export class RIPEngine implements IProtocolEngine`, pas `extends AbstractRoutingProtocolEngine`), `src/network/rip/RIPEngine.ts:354-401` (split-horizon/poison-reverse + `sendTriggeredUpdate`), `src/network/routing/adapters/RipEngineAdapter.ts` (couche d'adaptation nécessaire pour le faire correspondre au contrat commun).
- **Sévérité** : Mineure.
- **Recommandation** : aucune action urgente — le pattern Adapter (`RipEngineAdapter`/`OspfEngineAdapter`) gère bien cette hétérogénéité historique ; à terme, envisager une migration de RIP vers `AbstractRoutingProtocolEngine` pour réduire la duplication de la projection réactive.

### 3.11 Couche d'abstraction `AbstractRoutingProtocolEngine` — adoptée seulement par BGP/EIGRP, contournée par OSPF/RIP via Adapter
- **Constat** : seuls `BGPEngine` et `EIGRPEngine` étendent réellement `AbstractRoutingProtocolEngine` ; OSPF et RIP — les deux protocoles « pilotés par trame » les plus complexes — sont intégrés via des adaptateurs (`OspfEngineAdapter`, `RipEngineAdapter`) qui implémentent directement `IRoutingProtocolEngine` sans hériter de la classe abstraite, avec des seams `setPeerLocator`/`setDeviceContext` explicitement no-op (« frame-driven »).
- **Preuve** : `src/network/routing/adapters/OspfEngineAdapter.ts:31,59-60` (`class OspfEngineAdapter implements IRoutingProtocolEngine<OSPFConfig>` + `setPeerLocator(_l) {} /* frame-driven */`), `src/network/devices/router/RouterDynamicRouting.ts:46-56` (commentaire « RIP/OSPF exposed through the SAME contract (Adapter) »).
- **Sévérité** : Mineure.
- **Recommandation** : c'est un compromis assumé et documenté (Adapter Pattern), pas une incohérence cachée — mais le terme « shared abstraction » dans les commentaires de `AbstractRoutingProtocolEngine.ts` (« the foundation… ») peut induire en erreur sur le degré réel d'unification ; clarifier la documentation pour indiquer que deux familles de stratégies d'intégration coexistent (héritage direct vs adaptation).

### 3.12 `RoutingTable` (LPM générique) — abstraction documentée mais totalement inutilisée
- **Constat** : `core/RoutingTable.ts` fournit une table de routage générique avec Longest-Prefix-Match, partagée IPv4/IPv6 (`createIPv4RoutingTable`/`createIPv6RoutingTable`), exportée depuis `core/index.ts` — mais n'est instanciée nulle part dans le code de production ni dans les tests. `Router.ts` réimplémente sa propre LPM par balayage linéaire sur `RouteEntry[]`, et `IPv6DataPlane.ts` fait de même sur `IPv6RouteEntry[]`.
- **Preuve** : `src/network/core/RoutingTable.ts:38,172,226` (classe et factories génériques jamais instanciées en dehors du fichier), `src/network/devices/Router.ts:602-636` (`lookupRoute()` réimplémente LPM par boucle `for (const route of this.routingTable)`), `src/network/devices/router/IPv6DataPlane.ts:88,184` (même duplication pour IPv6).
- **Sévérité** : Mineure.
- **Recommandation** : soit migrer `Router`/`IPv6DataPlane` vers `RoutingTable`/`createIPv4RoutingTable`/`createIPv6RoutingTable` (élimine la duplication et améliore la complexité de recherche), soit supprimer ce module mort pour ne pas induire en erreur les futurs contributeurs cherchant « la » table de routage du projet.

### 3.13 Convergence dynamique pilotée par la trajectoire de transfert (« recompute-on-lookup »), pas par événements protocolaires
- **Constat** : malgré le commentaire de `AbstractRoutingProtocolEngine.ts` affirmant « Reactive… No polling anywhere », la convergence BGP/EIGRP n'est en réalité déclenchée ni par des timers protocolaires, ni par des événements de topologie : elle est recalculée de façon synchrone à chaque décision de transfert de paquet (`Router.lookupRoute`) et à chaque commande `show`.
- **Preuve** : `src/network/devices/Router.ts:607` (`if (this.dynamicRouting?.hasActive()) this.dynamicRouting.converge();` dans `lookupRoute`, exécuté pour CHAQUE paquet IP routé), `src/network/devices/shells/cisco/CiscoRoutingProtoCommands.ts:274` (`const live = () => ctx.r().convergeDynamicRouting();` rappelé avant chaque `show ip bgp*`/`show ip eigrp*`) ; absence de minuteur dédié pour BGP/EIGRP dans `RouterDynamicRouting.ts`/`BGPEngine.ts`/`EIGRPEngine.ts`.
- **Sévérité** : Mineure (fonctionnellement correct car déterministe et idempotent, mais coût de performance et contradiction avec le commentaire affiché).
- **Recommandation** : soit recalculer uniquement sur changement de topologie réel (abonnement aux événements de port/câble), soit reformuler le commentaire « no polling » qui est trompeur — il s'agit en pratique d'un recalcul synchrone à la demande (« pull », pas « push »), potentiellement coûteux sur de grandes topologies à fort trafic.

### 3.14 Cohérence show↔état — globalement bonne pour OSPF/BGP/EIGRP/RIP, dérivée du moteur réel
- **Constat** : les commandes `show ip bgp summary/neighbors/table`, `show ip eigrp neighbors/topology/interfaces`, `show ip ospf neighbor[ detail]`, `show ip route ospf` dérivent toutes de l'état live des moteurs (`getNeighbors()`, `getContributedRoutes()`, `getRoutes()`) après un appel de convergence explicite (`live()`/`_ospfAutoConverge()`), pas de texte statique. Seul `show ip bgp` mélange les déclarations `network` configurées (toujours affichées comme localement originées avec `0.0.0.0`/`32768`/`i`) et les routes réellement apprises — ce qui est conforme au comportement Cisco réel (table BGP locale).
- **Preuve** : `src/network/devices/shells/cisco/CiscoRoutingProtoCommands.ts:276-295` (`show ip bgp summary` itère `e.getNeighbors()` après `live()`), `:341-352` (`show ip eigrp neighbors` retourne un message honnête « no real EIGRP peer cabled » si la table est vide plutôt qu'un texte figé), `src/network/devices/shells/cisco/CiscoOspfCommands.ts:1203-1228` (`showIpOspfNeighbor` itère `ospf.getNeighbors()` après `_ospfAutoConverge()`).
- **Sévérité** : Information (point positif notable — contraste avec d'autres sous-systèmes potentiellement plus statiques).
- **Recommandation** : maintenir cette discipline « live state only » lors de l'ajout de nouvelles commandes `show`.

### 3.15 Artefact de fichier de test orphelin (`ospf-full.test` sans extension `.ts`)
- **Constat** : le répertoire de tests OSPF contient un fichier `ospf-full.test` (≈96 Ko, sans extension `.ts`) quasi-identique à `ospf-full.test.ts` mais avec des imports différents (`Router` au lieu de `CiscoRouter`/`CiscoSwitch`) — manifestement un reliquat d'une refactorisation, non exécuté par Vitest (extension non reconnue) et non référencé ailleurs.
- **Preuve** : `src/__tests__/unit/network-v2/ospf-full.test` (≈96 Ko) coexistant avec `ospf-full.test.ts`, imports divergents dès la ligne 18 (`Router` vs `CiscoRouter`/`CiscoSwitch`).
- **Sévérité** : Mineure.
- **Recommandation** : supprimer le fichier orphelin `ospf-full.test` (poids mort, source de confusion lors de recherches/diffs).

### 3.16 Parité IPv4/IPv6 — le plan de données IPv6 ne consomme aucune route de protocole dynamique
- **Constat** : `IPv6DataPlane` gère exclusivement des routes statiques/connectées/par défaut (`type: 'static' | 'connected' | 'default'`) ; aucune référence à OSPF, OSPFv3, BGP ou tout autre protocole dynamique n'existe dans ce fichier (679 lignes). Les seules routes OSPFv3 injectées dans sa table le sont via le contournement décrit en 3.6 (`v3ComputeRoutes`), pas via une intégration générique pérenne.
- **Preuve** : `src/network/devices/router/IPv6DataPlane.ts:88,118-184` (table de routage purement statique avec types `'static'|'connected'|'default'`, aucune occurrence de `OSPFv3`/`ospf`/`getRoutes` dans tout le fichier).
- **Sévérité** : Majeure.
- **Recommandation** : exposer un point d'intégration générique dans `IPv6DataPlane` (à l'image de `RouterDynamicRouting` pour IPv4) permettant d'injecter des routes `type: 'ospf'`/`'bgp'` provenant d'un futur moteur OSPFv3/MP-BGP fonctionnel, plutôt que de continuer à le faire via des contournements ad-hoc dans `RouterOSPFIntegration`.

### 3.17 BGP — pas de support multiprotocole (MP-BGP / AFI-SAFI IPv6)
- **Constat** : `BGPConfig` ne possède aucune notion d'AFI/SAFI ; toutes les adresses manipulées (`BgpNetworkStmt`, `BgpNeighborCfg`, `originatedPrefixes`) sont typées `IPAddress`/`SubnetMask` IPv4 uniquement — aucune mention d'IPv6, `address-family ipv6`, ou MP_REACH_NLRI/MP_UNREACH_NLRI.
- **Preuve** : `src/network/bgp/BGPEngine.ts:19-31` (interfaces `BgpNetworkStmt`/`BgpNeighborCfg`/`BGPConfig` 100% IPv4), `src/network/bgp/BGPEngine.ts:60-71` (`originatedPrefixes(): Array<{ network: IPAddress; mask: SubnetMask }>`).
- **Sévérité** : Majeure.
- **Recommandation** : si le simulateur ambitionne de couvrir le routage IPv6 dynamique (cohérent avec l'existence d'OSPFv3), prévoir une extension AFI/SAFI de `BGPEngine`/`BGPConfig` pour IPv6 ; sinon documenter clairement que seul l'IPv4 est couvert par BGP.

---

## 4. Services réseau & sécurité périmétrique (DHCP, ARP, ACL, NAT, GRE, NHRP, BFD, IPSec)

L'ensemble forme une base solide et étonnamment riche (≈12 000 lignes) : DHCP suit fidèlement la machine à états RFC 2131 (avec sérialisation binaire `DHCPPacket` désormais écrite), BFD implémente une vraie FSM pilotée par événements, et IPSec couvre IKEv1/IKEv2, ESP/AH, fragmentation post-encapsulation, anti-rejeu et NAT-T sur ~4000 lignes. Cependant, plusieurs sous-systèmes affichent un écart marqué entre la « surface CLI » (commandes acceptées, options stockées, texte de `show`) et le moteur réel : des structures de données entières (snooping DHCP, relay/option 82, NHRP, DMVPN, proxy-ARP, champs ACL avancés) sont câblées au parseur de configuration mais jamais consultées par le plan de données, ce qui produit des fonctionnalités « fantômes » qui semblent configurables mais n'ont aucun effet observable. On note aussi une duplication de code significative (deux `ACLEngine` quasi identiques) et des boucles de maintenance entièrement écrites mais jamais ordonnancées (rekey IKE, DPD).

### 4.1 DHCP — paquet binaire non câblé au moteur
- **Constat** : `DHCPPacket` (sérialisation/désérialisation BOOTP complète, magic cookie, options TLV) a été écrit depuis la rédaction de `DHCP_ANALYSIS.md`, mais le client et le serveur continuent d'échanger des objets de paramètres typés via appel de méthode direct (`server.processDiscover(...)`, `server.processRequest(...)`) plutôt que de construire/parser de vrais paquets UDP 67/68. `DHCPPacket` n'est importé/instancié que par les tests (`dhcp_fixes.test.ts`), jamais par `DHCPClient`/`DHCPServer`.
- **Preuve** : `src/network/dhcp/DHCPClient.ts:319` (`ref.server.processDiscover({...})`), `src/network/dhcp/DHCPPacket.ts:61` (classe exportée mais jamais instanciée hors tests), `src/network/dhcp/index.ts:3`.
- **Sévérité** : Mineure (le comportement RFC est correct, c'est la fidélité « câblage réseau » qui manque).
- **Recommandation** : Faire transiter les exchanges DORA par `DHCPPacket.serialize()/deserialize()` à travers de vraies trames Ethernet/UDP, à l'image de ce que fait `BfdAgent`/`GreAgent` (construction d'`IPv4Packet`/`UDPPacket` réels et `host.sendFrame`).

### 4.2 DHCP — relais/option 82 entièrement orphelin
- **Constat** : `ip helper-address` est analysé par la CLI Cisco/Huawei, persisté dans `DHCPRelayConfig.helperAddresses`, et même affiché dans `running-config` (`show ip helper-address`). Mais aucune logique dans `Router.ts` ne lit `getHelperAddresses()`/`getRelayConfig()` pour réellement relayer un DHCPDISCOVER reçu en broadcast vers un serveur distant ; et `giaddr` n'est jamais positionné par quoi que ce soit (recherche exhaustive : zéro affectation hors désérialisation de paquet). Le code de sélection de pool par `giaddr` (`getPoolsForDiscover`) est donc totalement inatteignable en pratique.
- **Preuve** : `src/network/devices/shells/cisco/CiscoConfigCommands.ts:692-695` (commande acceptée et persistée), `src/network/dhcp/DHCPServer.ts:906-922` (stockage `helperAddresses`), `src/network/dhcp/DHCPServer.ts:1099-1111` (`getPoolsForDiscover` jamais déclenché par un giaddr réel) — aucune occurrence de `getHelperAddresses`/`getRelayConfig`/`getInterfaceMode` dans `Router.ts`.
- **Sévérité** : Majeure — un utilisateur configurant un relais DHCP inter-VLAN obtiendra une configuration acceptée et affichée, sans aucun effet réel ; c'est trompeur et invalide tout scénario pédagogique de relais.
- **Recommandation** : Soit implémenter le relais (transformation broadcast→unicast vers `helperAddresses`, incrément `hops`, pose de `giaddr` = IP de l'interface entrante), soit retirer la commande/l'affichage tant que non opérationnels.

### 4.3 DHCP — Snooping totalement vide
- **Constat** : `DHCPServer` expose `setSnoopingEnabled`/`isSnoopingEnabled`/`getSnoopingInterfaces`, et `Switch` maintient un tableau `snoopingBindings: DHCPSnoopingBinding[]` consommé par `show ip dhcp snooping binding` et par le moteur DAI (`ArpInspectionEngine`). Or `snoopingBindings` n'est **jamais alimenté** (aucune écriture trouvée, seulement la déclaration et le getter `_getSnoopingBindings`) — le tableau reste vide à vie, donc `show ip dhcp snooping binding` affiche systématiquement « Total number of bindings: 0 », et la branche `matchBinding` de `ArpInspectionEngine` ne pourra jamais matcher un binding légitime.
- **Preuve** : `src/network/devices/Switch.ts:143` (déclaration `snoopingBindings = []`), `src/network/devices/shells/CiscoSwitchShell.ts:1804-1827` (`showDHCPSnoopingBinding` lit un tableau toujours vide), `src/network/arp/ArpInspectionEngine.ts:25-34` (dépend de `bindings: readonly DHCPSnoopingBinding[]`).
- **Sévérité** : Critique — l'inspection ARP dynamique (DAI) configurée en mode « non statique » dégradera systématiquement vers `binding-mismatch`/drop pour tout trafic légitime, car aucune table de liaison ne sera jamais peuplée par snooping DHCP réel.
- **Recommandation** : Câbler la capture des DHCPACK observés sur les ports en mode snooping (côté `DHCPServer`/`Switch`) pour insérer/mettre à jour `snoopingBindings`, et synchroniser `DHCPServer.isSnoopingEnabled` (qui semble redondant et orphelin lui aussi) avec `Switch.snoopingEnabledIfaces`.

### 4.4 DHCP — APIPA correctement implémenté (correction par rapport à l'ancienne analyse)
- **Constat** : La régression notée dans `DHCP_ANALYSIS.md` (« génère une IP déterministe 192.168.1.x ») est résolue : `autoAssignLease` génère désormais une adresse APIPA RFC 3927 (`169.254.x.x/16`, sans passerelle).
- **Preuve** : `src/network/dhcp/DHCPClient.ts:746-793`.
- **Sévérité** : Information (point positif, mentionné pour la traçabilité de l'audit).
- **Recommandation** : RAS.

### 4.5 DHCP — `processRequestWithNak` et `allocateAddress` : API mortes/dupliquées
- **Constat** : `processRequestWithNak` (NAK explicite avec message), ajouté pour corriger le défaut « pas de DHCPNAK explicite » signalé précédemment, n'est appelé nulle part dans le flux DORA réel — `DHCPClient` continue d'invoquer `processRequest` qui renvoie `null` en cas de NAK (perte du motif). De même, `allocateAddress` (signalée comme source d'incohérences dans `DHCP_ANALYSIS.md` §3) n'a aucun appelant en dehors des tests.
- **Preuve** : `src/network/dhcp/DHCPClient.ts:376,560,833,874` (tous appellent `processRequest`, jamais `processRequestWithNak`), `src/network/dhcp/DHCPServer.ts:344-397` (`allocateAddress`, zéro appelant hors tests), `src/network/dhcp/DHCPServer.ts:604` (`processRequestWithNak` défini).
- **Sévérité** : Mineure.
- **Recommandation** : Basculer `DHCPClient.requestLease`/`setupLeaseTimers` vers `processRequestWithNak` pour exposer le message de NAK au CLI (`debug ip dhcp server`), et supprimer `allocateAddress` qui contourne le DORA.

### 4.6 ARP — proxy-ARP configurable mais sans effet
- **Constat** : Les commandes `ip proxy-arp` (Cisco) et `arp-proxy enable/disable` (Huawei) positionnent un flag `port.proxyArp = true/false` (via cast `as any`/`as unknown`), affiché ensuite dans `display current-configuration`. Aucune lecture de ce flag n'existe dans le traitement ARP réel (`EndHost`/`Router`) : recherche exhaustive, les 4 seules occurrences de `proxyArp` sont des écritures CLI ou un affichage Huawei.
- **Preuve** : `src/network/devices/shells/cisco/CiscoConfigCommands.ts:434-437`, `src/network/devices/shells/huawei/HuaweiConfigCommands.ts:724,731`, `src/network/devices/shells/huawei/HuaweiDisplayCommands.ts:899` — aucune lecture dans `src/network/devices/Router.ts`/`EndHost.ts`/`hardware/Port.ts`.
- **Sévérité** : Majeure — toute topologie pédagogique reposant sur le proxy-ARP (hôtes sans passerelle correcte, migrations LAN) ne fonctionnera jamais malgré une configuration acceptée et affichée comme active.
- **Recommandation** : Implémenter la résolution proxy dans le traitement des requêtes ARP entrantes du routeur (répondre avec sa propre MAC quand la cible est hors sous-réseau local et atteignable via une route), conditionnée par `port.proxyArp`.

### 4.7 ARP — pas de purge effective des entrées obsolètes (« STALE »)
- **Constat** : `getNUDState()` calcule un état d'affichage `REACHABLE`/`STALE`/`PERMANENT` à partir de `entry.timestamp`, utilisé uniquement par `ip neigh`/`ip -s neigh`. Mais aucun minuteur/`setInterval` ne parcourt `arpTable` pour réellement faire vieillir, re-sonder (NUD probe) ou supprimer les entrées dynamiques expirées (RFC 826 / RFC 4861 §7.3) — une entrée « STALE » reste indéfiniment dans la table.
- **Preuve** : `src/network/devices/EndHost.ts:73-76` (`getNUDState`, seul usage : affichage `ip neigh`), `src/network/devices/EndHost.ts:171` (`arpTable: Map<...>`, aucune purge basée sur `timestamp` trouvée dans le fichier).
- **Sévérité** : Mineure à Majeure (selon les scénarios de mobilité/changement de MAC testés — sans vieillissement, un hôte qui change d'adresse MAC restera injoignable jusqu'à expiration manuelle du cache).
- **Recommandation** : Ajouter un minuteur périodique qui transitionne `REACHABLE → STALE → (probe) → supprimé`, aligné sur `ARP_REACHABLE_TIME_MS`.

### 4.8 ACL — duplication complète d'`ACLEngine` (code mort)
- **Constat** : `src/network/acl/ACLEngine.ts` (355 lignes) est une quasi-copie conforme de `src/network/devices/router/ACLEngine.ts` (340 lignes) — mêmes types (`ACLEntry`, `AccessList`, `PortSpec`, `InterfaceACLBinding`), mêmes signatures (`evaluate`/`evaluateACL`, `evaluateByName`/`evaluateACLByName`). Seul `devices/router/ACLEngine.ts` est importé par `Router.ts` ; `acl/ACLEngine.ts` n'a **aucun importeur** dans tout le code (production ou tests).
- **Preuve** : `src/network/acl/ACLEngine.ts:26-67` vs `src/network/devices/router/ACLEngine.ts:35-104` (types identiques) ; recherche `network/acl/ACLEngine` → résultat vide hors définition.
- **Sévérité** : Mineure (dette technique / confusion architecturale — viole DRY documenté dans CLAUDE.md).
- **Recommandation** : Supprimer `src/network/acl/ACLEngine.ts` (ou fusionner s'il contient une intention différente non exploitée), pour éviter toute divergence future entre les deux implémentations.

### 4.9 ACL — champs avancés stockés mais jamais évalués (`established`, `time-range`, `reflect`, `fragments`, ToS/DSCP/precedence)
- **Constat** : La CLI (`CiscoAclCommands.ts`) parse et persiste `tcpEstablished`, `timeRange`, `reflect`/`reflectTimeout`, `fragments`, `dscp`/`precedence`/`tos`, `log`/`logInput`, `evaluate` (chaînage d'ACL réflexive), et les réaffiche fidèlement dans `show access-lists`. Mais la fonction de correspondance réellement utilisée pour filtrer le trafic, `aclEntryMatches` (dans le seul `ACLEngine` actif), ne regarde **que** : adresse source (wildcard), adresse destination, protocole, ports (`portMatches`) et type ICMP. Aucune des options avancées listées n'est consultée — `permit tcp any any established` se comporte exactement comme `permit tcp any any`, une entrée `time-range` s'applique 24h/24, et les ACL réflexives (`reflect`/`evaluate`) ne créent ni ne consultent de session de retour.
- **Preuve** : `src/network/devices/router/ACLEngine.ts:264-298` (`aclEntryMatches` — corps complet, sans aucune référence à `tcpEstablished`/`timeRange`/`reflect`/`fragments`/`dscp`), comparé à la définition de ces champs aux lignes `49-60` et `86-97` du même fichier ; CLI : `src/network/devices/shells/cisco/CiscoAclCommands.ts:136,176,181,579,592-595`.
- **Sévérité** : Majeure — l'ACL « established » est un cas d'usage très courant dans les labs sécurité ; son acceptation silencieuse sans effet induit en erreur l'utilisateur (le test `cisco-acl.test.ts` ne vérifie d'ailleurs pas son effet sur la correspondance, seulement son rendu CLI).
- **Recommandation** : Étendre `aclEntryMatches` pour : (a) consulter l'état TCP de la session (via `SocketTable`/`TcpConnection` exposés ailleurs dans `core/`) pour `established` ; (b) consulter une horloge simulée + table `time-range` pour les ACL temporelles ; (c) implémenter un mini state-tracker pour `reflect`/`evaluate` (ACL réflexives RFC-like Cisco).

### 4.10 NAT — pas d'ALG (FTP/SIP), pas de NAT64
- **Constat** : `NATEngine` couvre static/dynamic/PAT-overload/pool, hairpinning, sessions TCP avec FSM (`closed→syn-seen→established→fin-wait→time-wait`) et compteurs RFC 2663/3022/4787. En revanche, aucune passerelle de couche application (ALG) n'existe : recherche de `FTP`/`ALG`/`SIP`/`NAT64` dans le moteur → zéro résultat. Le FTP actif/passif via NAT (réécriture du payload `PORT`/`PASV`) et la traduction NAT64 ne sont donc pas pris en charge.
- **Preuve** : `src/network/devices/router/NATEngine.ts:1-16` (en-tête de fichier listant exhaustivement les fonctionnalités supportées — FTP/SIP/NAT64 absents de la liste), absence totale de ces termes dans tout le fichier (733 lignes).
- **Sévérité** : Mineure (fonctionnalité avancée, rarement testée dans les labs réseau de base).
- **Recommandation** : Documenter explicitement cette limitation dans le `show ip nat statistics`/aide CLI, ou ajouter un ALG FTP minimal (les protocoles FTP/SIP existent déjà ailleurs dans le simulateur, donc la réutilisation est envisageable).

### 4.11 GRE — pas de keepalive, pas de checksum, pas de séquencement, pas de mGRE
- **Constat** : `GreAgent.encapsulateAndSend` construit toujours un en-tête GRE avec `checksumPresent: false`, `checksum: 0`, `sequencePresent: false`, `sequence: null` — aucune option RFC 2890 (clé+séquence) n'est jamais activée côté émission, même si `GrePacket.checksumPresent`/`sequencePresent` existent dans les types. Aucun mécanisme de keepalive de tunnel (`keepalive` Cisco) n'est implémenté, et il n'existe aucune notion de GRE multipoint (mGRE) requis pour DMVPN phase 2/3 — un seul couple `sourceIp`/`destinationIp` par tunnel.
- **Preuve** : `src/network/gre/GreAgent.ts:102-113` (`checksumPresent: false, sequencePresent: false, sequence: null` codés en dur), absence de toute référence `keepalive`/`multipoint` dans `src/network/gre/types.ts` et `GreAgent.ts`.
- **Sévérité** : Majeure — les profils DMVPN annoncés (`registerTunnel({..., phase: 3})`, voir 4.12) présupposent du mGRE, qui n'existe pas réellement au niveau du transport GRE.
- **Recommandation** : Ajouter le support de `key`/`sequence` à l'émission (la structure le permet déjà), des keepalives configurables (compteur d'échecs → tunnel down), et un mode multipoint (table de correspondance NBMA dynamique alimentée par NHRP).

### 4.12 NHRP / DMVPN — configuration statique sans protocole, sessions toujours vides
- **Constat** : `NhrpService.addMapping` insère directement une entrée de cache « statique » sans aucun échange de messages NHRP (pas de Registration Request/Reply, pas de Resolution Request/Reply — RFC 2332 §5). Plus grave : `DmvpnService.registerSession` (qui peuple le tableau `sessions` affiché par `show dmvpn`) n'a **aucun appelant** dans tout le code de production — seul `registerTunnel` (créant un profil hub/spoke vide) est invoqué depuis `CiscoOspfCommands.ts`. En conséquence, `show dmvpn [detail]` affichera toujours « No DMVPN sessions » ou une table de profils sans aucune session, et le texte `IKE: pending/established` / `IPSEC: down/up` de `formatSessions` est dérivé d'un état (`DmvpnTunnelState`) qui n'est jamais alimenté par une vraie négociation — c'est un gabarit d'affichage prêt à l'emploi mais jamais nourri.
- **Preuve** : `src/network/devices/router/nhrp/NhrpService.ts:51-72` (`addMapping` — pas de message NHRP, juste insertion en mémoire) ; `src/network/devices/router/nhrp/DmvpnService.ts:50-59` (`registerSession`, zéro appelant hors la classe elle-même) ; `src/network/devices/router/nhrp/DmvpnService.ts:64-93` (`formatSessions` — texte `IKE: pending/established`/`IPSEC: down/up` dérivé d'un état jamais peuplé) ; ligne 91 `void this.nhrp;` — la dépendance injectée au constructeur n'est même pas utilisée, juste « tue » le lint `no-unused-vars` (ironique puisque cette règle est désactivée globalement selon CLAUDE.md).
- **Sévérité** : Critique — DMVPN est entièrement « cosmétique » : la commande `show dmvpn` ne reflète jamais un état réel de tunnel, et NHRP ne fait aucune résolution dynamique NBMA↔overlay.
- **Recommandation** : (a) Implémenter un échange NHRP minimal piloté par événements (suivant le patron Engine+types+events+observables+actors documenté) pour peupler `cache` dynamiquement ; (b) appeler `registerSession` depuis le point où un tunnel DMVPN se monte réellement (négociation IPSec + résolution NHRP réussies) ; (c) retirer ou implémenter `void this.nhrp`.

### 4.13 BFD — implémentation FSM solide, mais mode echo et multi-hop absents
- **Constat** : `BfdAgent` implémente correctement la FSM complète (AdminDown/Down/Init/Up), la transmission/réception de paquets de contrôle UDP (port 3784), la détection de timeout par minuteur (`expireDue`), et réagit aux événements `port.link.up/down` (DPD-style). En revanche : `UDP_PORT_BFD_ECHO` (3785) est défini mais jamais utilisé, `requiredMinEchoRxIntervalUs` est systématiquement envoyé à `0` (mode echo désactivé en dur), aucune session multi-hop (RFC 5883 — qui nécessiterait une adresse de saut suivant distincte du voisin direct) n'existe, et le checksum UDP transmis est toujours `checksum: 0`.
- **Preuve** : `src/network/bfd/types.ts:2` (`UDP_PORT_BFD_ECHO = 3785`, jamais référencé ailleurs), `src/network/bfd/BfdAgent.ts:200` (`requiredMinEchoRxIntervalUs: 0`), `src/network/bfd/BfdAgent.ts:205` (`checksum: 0`).
- **Sévérité** : Mineure (le mode asynchrone de base, le plus utilisé en pratique, est correctement couvert).
- **Recommandation** : Ajouter le mode echo (paquets bouclés localement vers le voisin) si des labs BFD avancés sont prévus ; sinon documenter l'absence dans l'aide CLI `show bfd neighbors details`.

### 4.14 IPSec — négociation IKE synchrone « engine-to-engine », pas de paquets réels
- **Constat** : Le commentaire d'en-tête du fichier l'assume explicitement : « IKEv1/IKEv2 SA negotiation (direct engine-to-engine, synchronous) ». `negotiateIKEv1`/`negotiateIKEv2` manipulent directement les structures internes du moteur pair (`peerEngine.ikeSADB.set(...)`, `peerEngine.preSharedKeys.get(...)`, `peerEngine.transformSets`, `peerEngine.dpdConfig`) via des références obtenues par une recherche globale dans `Equipment.getAllEquipment()` (cast `as any`), au lieu d'échanger de vrais paquets ISAKMP/IKE_SA_INIT/IKE_AUTH traversant le plan de données simulé. Cela contredit le patron documenté pour les moteurs réactifs (Engine + types + events + observables + actors, cf. OSPF/DHCP/BGP) — il n'y a pas de FSM de négociation pilotée par minuteurs/événements pour la phase de contrôle (seul le plan de données ESP/AH transite par de vrais `IPv4Packet`/trames).
- **Preuve** : `src/network/ipsec/IPSecEngine.ts:5` (« direct engine-to-engine, synchronous »), `src/network/ipsec/IPSecEngine.ts:3155-3163` (`findRouterByIP` — parcours `Equipment.getAllEquipment()` + cast `as any`), `src/network/ipsec/IPSecEngine.ts:2770,2785,2791,2813,2825,2829,2956-2959` (écritures directes dans les structures internes du moteur pair lors de `negotiateIKEv1`).
- **Sévérité** : Majeure (architecture) — le résultat fonctionnel (SA installée des deux côtés) est correct, mais aucune trame IKE n'est jamais visible dans les captures réseau (`show crypto isakmp`/`debug crypto isakmp` reposent sur un état halluciné côté local plutôt que sur un échange observable), et la latence/perte/MITM ne peuvent pas être simulées sur la phase de contrôle.
- **Recommandation** : Faire transiter au minimum les messages ISAKMP/IKE_SA_INIT/IKE_AUTH/CREATE_CHILD_SA comme de vrais paquets UDP/500 (et 4500 pour NAT-T) avec minuteurs de retransmission, à l'image du plan de données ESP/AH déjà bien intégré.

### 4.15 IPSec — boucles de maintenance (rekey, DPD) écrites mais jamais ordonnancées
- **Constat** : `recheckIKESALifetimes()` (vérifie l'expiration de durée de vie et déclenche `rekeyIKESA`) et `runDPDCheck()` (sonde R-U-THERE périodique RFC 3706, déclare le pair mort après N timeouts et nettoie les SA) sont entièrement implémentées avec une logique correcte, mais **aucun appelant** n'existe dans le code de production (ni `setInterval`/`TimerSet`/actor ne les invoque) — seuls les tests les appellent directement. En l'absence d'appel périodique, une SA IKE ne se renouvellera jamais automatiquement à expiration de sa durée de vie via le déroulement normal de la simulation, et DPD ne détectera jamais un pair mort autrement que par l'événement `port.link.down` déjà géré ailleurs.
- **Preuve** : `src/network/ipsec/IPSecEngine.ts:1102` (`runDPDCheck`, zéro appelant hors définition), `src/network/ipsec/IPSecEngine.ts:1186` (`recheckIKESALifetimes`, zéro appelant hors définition) — aucune occurrence de minuteur de maintenance les ciblant dans tout le moteur (le moteur ne possède même pas de minuteur de maintenance interne malgré `getScheduler()` disponible).
- **Sévérité** : Critique — deux mécanismes RFC documentés comme implémentés (DPD §1102, rekey §1182-1240) sont en réalité inertes en usage normal ; un utilisateur qui laisse tourner une session IPSec au-delà de sa durée de vie configurée ne verra jamais de rekey, et un pair injoignable autrement que par coupure de lien physique ne sera jamais déclaré mort.
- **Recommandation** : Ajouter un minuteur périodique (`TimerSet`/`this.timers.setInterval`) dans `start()` qui appelle `recheckIKESALifetimes()` et `runDPDCheck()` à intervalle régulier (p.ex. toutes les secondes simulées), suivant le patron déjà utilisé par `BfdAgent.startTimers()`.

### 4.16 Cohérence show↔état — globalement bonne, avec une exception notable
- **Constat** : La grande majorité des commandes `show` auditées (`show ip dhcp binding`, `show access-lists`, `show ip nat translations/statistics`, `show crypto ipsec sa`, `show bfd neighbors`, `show ip nhrp`) lisent effectivement l'état vivant des moteurs via des accesseurs `_get*Internal()`/`getBfdAgent()`/`listSessions()`/`formatBindingsShow()` — conforme au patron MVC documenté, sans texte figé. La seule exception significative concerne `show ip dhcp snooping binding` (toujours « 0 bindings », cf. 4.3) et `show dmvpn [detail]` (toujours vide ou affichant un gabarit non alimenté, cf. 4.12), où la commande lit bien un accesseur d'état réel mais cet état n'est jamais peuplé par le moteur — la frontière MVC est respectée formellement, mais le modèle sous-jacent reste une coquille vide.
- **Preuve** : `src/network/devices/shells/cisco/CiscoNATCommands.ts:229-232`, `src/network/devices/shells/cisco/CiscoBfdCommands.ts:14,31,60`, `src/network/devices/shells/CiscoSwitchShell.ts:1804-1827`, `src/network/devices/router/nhrp/DmvpnService.ts:64-93`.
- **Sévérité** : Mineure (architecture) / Critique (conséquence fonctionnelle déjà notée en 4.3/4.12).
- **Recommandation** : Aucune action architecturale nécessaire — combler le modèle (alimenter `snoopingBindings`/`DmvpnSession[]`) suffit à corriger ces deux cas.

---

## 5. Redondance & multicast (HSRP/VRRP/GLBP, IGMP/IGMP-snooping, PIM, VXLAN)

L'ensemble de cette famille de protocoles est implémenté sous une forme cohérente et relativement mature côté FHRP (HSRP/VRRP/GLBP) et IGMP/IGMP-snooping — moteurs `*Agent.ts` réels pilotés par `Scheduler`/`EventBus`, FSM fonctionnelle, `show`/`display` branchés sur l'état live. En revanche, PIM et VXLAN sont des moteurs « orphelins » : entièrement développés et testés unitairement, mais totalement absents de la surface CLI (aucune commande `show`/`display`/de configuration), ce qui les rend inutilisables par un utilisateur du simulateur. On note aussi une divergence architecturale par rapport au pattern documenté dans CLAUDE.md (`Engine + types + events + observables + actors/`) : ces sept familles n'ont que `*Agent.ts + types.ts + events.ts`, sans `observables.ts` ni `actors/`, contrairement à OSPF/DHCP/IPSec/BGP/routing/RIP. Plusieurs bugs concrets (précédence d'opérateur, FSM tronquée, incohérence Cisco/Huawei) ont par ailleurs été identifiés.

### 5.1 HSRP
- **Constat** : la FSM implémentée ne couvre que 4 états effectifs (`init/listen/standby/active`) ; les états `speak` et `learn` du type `HsrpState` (RFC 2281 prévoit Initial/Learn/Listen/Speak/Standby/Active) ne sont **jamais atteints** — la transition se fait directement de `listen`/`init` vers `active`/`standby`.
- **Preuve** : `src/network/hsrp/types.ts:6-7` déclare `'init' | 'listen' | 'learn' | 'speak' | 'standby' | 'active'`, mais `src/network/hsrp/HsrpAgent.ts:236-263` n'assigne jamais `'speak'` ni `'learn'`.
- **Sévérité** : Mineure
- **Recommandation** : soit retirer `learn`/`speak` du type pour refléter le modèle simplifié réellement implémenté, soit ajouter les transitions intermédiaires (utiles pour simuler les délais de convergence et les tempos `hello`/`hold`).

- **Constat** : aucune prise en charge des « tracking objects » (`standby track interface … decrement N`) au niveau du moteur — la commande CLI stocke l'info dans `FhrpRepository` (purement cosmétique pour `show standby`) mais `HsrpAgent` ne diminue jamais la priorité ni ne déclenche de bascule en cas de perte d'un objet suivi.
- **Preuve** : `src/network/devices/shells/cisco/CiscoHsrpCommands.ts:57-59` (`for (const t of g.trackDecr) lines.push(...)`) n'affiche qu'une ligne de texte ; `HsrpAgent.ts` ne contient aucune référence à `track`/`trackDecr`/`decrement`.
- **Sévérité** : Majeure
- **Recommandation** : implémenter le suivi réel (abonnement aux événements `port.link.*`/routing) et appliquer la décrémentation dans `recompute()`.

- **Constat** : la classe `HsrpAgent` ne contient ni MD5, ni mode d'authentification chiffrée — uniquement une comparaison de texte clair `authText`.
- **Preuve** : `src/network/hsrp/types.ts:18,33` (`authText: string`), `HsrpAgent.ts:129` (`if (g.authText !== payload.authText) return;`).
- **Sévérité** : Mineure
- **Recommandation** : acceptable pour HSRPv1 historique (texte clair par défaut « cisco ») ; documenter que le MD5 (HSRPv2) n'est pas simulé.

### 5.2 VRRP
- **Constat** : bug de précédence d'opérateur — `totalLength` du paquet IPv4 transportant l'annonce VRRP est calculé avec une expression fautive qui ignore complètement la condition ternaire et produit toujours `24` (jamais `28`), quel que soit l'état du VIP.
- **Preuve** : `src/network/vrrp/VrrpAgent.ts:171` — `totalLength: 20 + 8 + g.vip ? 4 : 0` est interprété par JS comme `(20 + 8 + g.vip) ? 4 : 0` (concaténation de chaîne toujours truthy → `4`), au lieu de `20 + 8 + (g.vip ? 4 : 0)`.
- **Sévérité** : Mineure
- **Recommandation** : corriger en `20 + 8 + (g.vip ? 4 : 0)`.

- **Constat** : le type `VrrpPacket.version` autorise `2 | 3` (laissant entendre une prise en charge VRRPv3/IPv6), mais l'agent ne construit et n'envoie jamais que des paquets `version: 2`.
- **Preuve** : `src/network/vrrp/types.ts:9` (`version: 2 | 3`) vs `VrrpAgent.ts:165` (`type: 'vrrp', version: 2, …`).
- **Sévérité** : Mineure
- **Recommandation** : retirer `3` du type tant que VRRPv3/IPv6 n'est pas implémenté, pour éviter toute confusion.

- **Constat** : **double source de vérité** côté Huawei — `HuaweiVrrpService` (config-only, jamais relié au moteur réel) maintient un champ `state: 'Initialize' | 'Backup' | 'Master'` qui n'est **jamais mis à jour** (initialisé à `'Initialize'` et figé), tandis que le vrai FSM tourne dans `VrrpAgent` (états `init/backup/master`). Les commandes `display vrrp*` lisent exclusivement le service factice.
- **Preuve** : `src/network/devices/router/redundancy/HuaweiVrrpService.ts:50` (`state: 'Initialize'`, jamais réassigné — confirmé par recherche ne trouvant aucune assignation `.state =` ailleurs) ; lecture dans `src/network/devices/shells/huawei/HuaweiDisplayCommands.ts:1110,1124,1175-1176,1182` (`State : ${g.state}`, `master = groups.filter(g => g.state === 'Master')`, etc.).
- **Sévérité** : Critique
- **Recommandation** : faire pointer `display vrrp`/`display vrrp brief`/`display vrrp interface` vers `router.getVrrpAgent().getGroup(...)` (comme le fait `CiscoVrrpGlbpCommands.ts:115-123` pour `show vrrp`), et supprimer ou fusionner `HuaweiVrrpService` avec le moteur réel — c'est exactement le type de violation MVC/réactivité signalé dans le brief (lecture d'un état figé/canné au lieu de l'état live du moteur).

### 5.3 GLBP
- **Constat** : implémentation relativement complète (AVG/AVF, TLV hello/request/assign, 3 modes de répartition de charge `round-robin`/`weighted`/`host-dependent`, élections AVG avec préemption). Cependant, l'état `GlbpAvgState` déclare `'speak'`/`'listen'` qui ne sont jamais assignés par le moteur — seuls `init/active/standby` (et transitoirement `disabled`) sont effectivement atteints, comme pour HSRP.
- **Preuve** : `src/network/glbp/types.ts:5` (`'disabled' | 'init' | 'listen' | 'speak' | 'standby' | 'active'`) vs assignations réelles dans `GlbpAgent.ts:387,389,394,396,399` (`newState = 'init'|'active'|'standby'` uniquement).
- **Sévérité** : Mineure
- **Recommandation** : aligner le type sur les états réellement modélisés ou compléter la FSM pour traverser `listen`/`speak` durant la phase d'élection (utile pour la temporisation `helloSec`/`holdSec`).

- **Constat** : pas de tracking objects pour GLBP non plus (même lacune que HSRP/VRRP) — `weighting`/`preempt` sont configurables manuellement mais aucun objet suivi ne module dynamiquement la pondération.
- **Preuve** : aucune occurrence de `track`/`decrement` dans `src/network/glbp/GlbpAgent.ts` ni `types.ts`.
- **Sévérité** : Mineure
- **Recommandation** : cohérent avec HSRP/VRRP — à traiter de façon transverse si le suivi est ajouté.

### 5.4 IGMP / IGMP snooping
- **Constat** : le moteur `IgmpAgent` ne supporte qu'IGMPv1/v2 — `IgmpMessageType` ne déclare que `membership-query`, `v1/v2-membership-report`, `leave-group` ; aucun message `v3-membership-report`, aucune structure de filtrage de sources (`INCLUDE`/`EXCLUDE`), `enableInterface(iface, version: 1 | 2)` exclut explicitement la v3.
- **Preuve** : `src/network/igmp/types.ts:5-9,15,36`; `src/network/igmp/IgmpAgent.ts:58` (`enableInterface(iface: string, version: 1 | 2 = 2)`).
- **Sévérité** : Majeure
- **Recommandation** : documenter clairement la limitation v1/v2-only (raisonnable pour un premier jet), ou implémenter IGMPv3 (group-and-source reports, INCLUDE/EXCLUDE) pour la conformité RFC 3376 complète.

- **Constat** : aucune commande CLI de configuration IGMP (`ip igmp version`, `ip igmp join-group`, etc.) ni de visualisation (`show ip igmp groups`, `show ip igmp interface`) n'existe pour les routeurs Cisco/Huawei — le moteur `IgmpAgent` est entièrement headless, exposé uniquement via `getIgmpAgent()` consommé par les tests.
- **Preuve** : recherche de `'show ip igmp` / `'display igmp` dans `src/network/devices/shells/**` ne renvoie que `show ip igmp snooping` (`CiscoSwitchShell.ts:815`) ; `getIgmpAgent` n'apparaît que dans `HuaweiRouter.ts`, `CiscoRouter.ts` et 4 fichiers de tests.
- **Sévérité** : Critique
- **Recommandation** : ajouter la famille `show ip igmp groups/interface/snooping` et les commandes de configuration interface — sinon le moteur, bien que fonctionnel et testé, est invisible et inutilisable depuis le terminal simulé.

- **Constat** : `IgmpSnoopingAgent.computeEgressPorts()` — censé construire la table de transfert multicast réelle pour les switches — n'est **jamais appelé** dans le chemin de transfert de trames (`CiscoSwitch.handleFrame`) ; le snooping ne fait qu'observer/journaliser les rapports IGMP, et le commutateur continue d'utiliser le forwarding L2 normal (`super.handleFrame`).
- **Preuve** : `src/network/devices/CiscoSwitch.ts:196-197` (`this.igmpSnoopingAgent.handleFrame(portName, frame); super.handleFrame(portName, frame);` — pas d'usage du résultat de `computeEgressPorts`) ; seul appelant de `computeEgressPorts` = `src/__tests__/unit/network-v2/igmp-snooping.test.ts:182,192`.
- **Sévérité** : Critique
- **Recommandation** : intégrer `computeEgressPorts()` dans le chemin de diffusion multicast réel (remplacer l'inondation par défaut sur le VLAN par la liste `member ports ∪ router ports` pour le trafic à destination de groupes connus), faute de quoi la fonctionnalité reste un « flag » sans effet observable sur le trafic.

- **Constat** : parité Cisco/Huawei rompue — `IgmpSnoopingAgent` n'est câblé que dans `CiscoSwitch`/`CiscoSwitchShell`; `HuaweiSwitch` n'a ni l'agent ni les commandes `display igmp-snooping` / `igmp-snooping enable` (pourtant supportées par VRP réel).
- **Preuve** : recherche de `IgmpSnoopingAgent` dans `src/network/devices` ne renvoie que `CiscoSwitch.ts`/`CiscoSwitchShell.ts`; absence de toute occurrence « igmp » dans `HuaweiSwitch.ts`/les commandes `display` Huawei côté switch.
- **Sévérité** : Majeure
- **Recommandation** : porter `IgmpSnoopingAgent` sur `HuaweiSwitch` avec les commandes `display igmp-snooping` équivalentes.

- **Constat** : petit défaut de robustesse — `compareQuerier` (sélection du « lowest IP wins ») et `ipv4MulticastToMac` masquent le 1er octet d'adresse de groupe avec `& 0x7f` correctement, mais aucun test ne vérifie le cas limite des adresses `239.x.x.x` overlapant le même bloc MAC OUI `01:00:5e` (ambiguïté IANA bien connue) — mineur, signalé pour mémoire.
- **Preuve** : `src/network/igmp/types.ts:84-91`.
- **Sévérité** : Mineure
- **Recommandation** : ajouter un test de collision documentant ce comportement attendu (pas un bug, mais un piège classique).

### 5.5 PIM
- **Constat** : seuls les types de message `hello` et `join-prune` sont effectivement traités ; `register`, `register-stop`, `bootstrap`, `assert`, `graft`, `graft-ack`, `candidate-rp-advertisement` sont **déclarés dans le type mais jamais gérés** — le `switch` de réception les ignore silencieusement.
- **Preuve** : `src/network/pim/types.ts:5-14` déclare ces 9 types ; `src/network/pim/PimAgent.ts:205-210` ne traite que `'join-prune'` et `'hello'` (`if (payload.messageType !== 'hello') return;`).
- **Sévérité** : Critique
- **Recommandation** : soit retirer les types non gérés du `PimMessageType` pour refléter honnêtement le périmètre (« PIM-SM shared-tree minimal »), soit implémenter au moins `register`/`register-stop` (indispensables pour le passage à l'arbre de plus court chemin SPT) et `assert` (résolution de boucles sur LAN partagé).

- **Constat** : il s'agit en réalité d'un PIM-SM *shared-tree only* (`*,G`) — aucune entrée `(S,G)` n'est jamais créée malgré le type `PimMroutEntryType = 'star-g' | 's-g'` qui le prévoit ; pas de bascule SPT, pas d'enregistrement (`register`) du trafic source vers le RP. Le mode `dense`/`sparse-dense` est déclaré (`PimMode`) mais aucune logique de flood-and-prune (PIM-DM) n'existe.
- **Preuve** : `src/network/pim/types.ts:48,16` ; recherche de `'s-g'` dans `PimAgent.ts` → aucune occurrence d'assignation, seul `'star-g'` est instancié (`ensureStarG`, `onJoinPrune` lignes 252-266, 387-398).
- **Sévérité** : Critique
- **Recommandation** : documenter clairement « PIM-SM shared-tree statique uniquement » dans les commentaires/doc utilisateur, ou compléter avec `(S,G)` joins, register encapsulation et flood-and-prune pour PIM-DM.

- **Constat** : pas de BSR ni d'Auto-RP — seule la configuration statique du RP (`addStaticRp`/`removeStaticRp`) est supportée ; aucun traitement du message `bootstrap` ni `candidate-rp-advertisement` (cf. ci-dessus), donc aucune découverte dynamique de RP.
- **Preuve** : `src/network/pim/PimAgent.ts:106-148` (uniquement `addStaticRp`/`removeStaticRp`/`resolveRpForGroup`), absence totale de logique BSR/Auto-RP.
- **Sévérité** : Majeure
- **Recommandation** : acceptable pour une première itération « lab simple », mais à signaler comme limite documentée — beaucoup de topologies pédagogiques Cisco utilisent Auto-RP.

- **Constat** : **aucune commande CLI** n'expose le moteur PIM — pas de `show ip pim neighbor`, `show ip pim rp mapping`, `show ip mroute`, `display pim neighbor`, `display multicast routing-table`, ni de commandes de configuration (`ip pim sparse-mode`, `ip pim rp-address`). Le moteur, bien que substantiel (616 lignes, hello/DR election/join-prune/mroute), est totalement headless.
- **Preuve** : recherche de `'show ip pim`/`'display pim`/`'show ip mroute`/`'display multicast` sur `src/network/devices/shells/**` → 0 résultat ; `getPimAgent` n'apparaît que dans `HuaweiRouter.ts`, `CiscoRouter.ts` et les fichiers de tests `pim-protocol.test.ts`/`pim-join-prune.test.ts`.
- **Sévérité** : Critique
- **Recommandation** : exposer au minimum `show ip pim neighbor`, `show ip pim rp mapping`, `show ip mroute` (lecture de `listNeighbors()`/`config.rps`/`listMroutes()`), et les commandes de configuration `ip pim sparse-mode`/`ip pim rp-address`/`ip multicast-routing` côté Cisco, équivalents Huawei (`display pim neighbor`, `display multicast routing-table`, `pim sm`).

### 5.6 VXLAN
- **Constat** : moteur d'encapsulation/décapsulation fonctionnel (VTEP, gestion VNI, table MAC apprise par flood-and-learn, événements `vxlan.mac.learned`/`vxlan.packet.{encapsulated,decapsulated,dropped}`), mais **strictement sans surface CLI** — pas de `interface nve1`, `vni`, `vxlan vni … head-end …`, `show nve peers`, `show vxlan vni`, `display vxlan vni/vni-peer`, etc. Le moteur est câblé dans `HuaweiRouter`/`CiscoRouter` (start/stop/handleUdp) mais `bindVni`/`addRemoteVtep`/`encapsulateAndSend` ne sont invoqués que par les tests directs sur `getVxlanAgent()`.
- **Preuve** : `src/network/devices/CiscoRouter.ts:106,124,144,195,265` et `HuaweiRouter.ts:95,110,127,171,222` montrent le câblage start/stop/handleUdp/getter ; recherche de « vxlan » (insensible à la casse) dans `src/network/devices/shells` → 0 résultat ; tous les appels à `bindVni`/`addRemoteVtep`/`encapsulateAndSend` proviennent uniquement de `src/__tests__/unit/network-v2/vxlan-protocol.test.ts`.
- **Sévérité** : Critique
- **Recommandation** : ajouter la pile de commandes VXLAN (`interface nve`, `member vni`, `vxlan vni … ingress-replication …`, `show nve peers/vni`, équivalents Huawei `vxlan vni`, `vni`, `display vxlan vni`/`display vxlan tunnel`) — aujourd'hui, malgré ~290 lignes de moteur testé, l'utilisateur ne peut tout simplement pas activer ni observer VXLAN.

- **Constat** : pas d'EVPN — uniquement « flood-and-learn » classique (apprentissage MAC via le plan de données, inondation BUM vers tous les VTEP distants connus). C'est une simplification raisonnable et explicitement assumée (pas de prétention EVPN), mais le trafic BUM est systématiquement encapsulé avec une adresse MAC externe `broadcast` plutôt qu'un groupe multicast IP, ce qui correspond au mode « ingress replication » (head-end replication) plutôt qu'au sous-jacent multicast classique — cohérent et correctement géré par le code, mais non signalé dans aucun commentaire/doc.
- **Preuve** : `src/network/vxlan/VxlanAgent.ts:186-195` (`resolveTargets` retourne tous les VTEP connus pour le VNI en cas de MAC inconnue), `:228` (`dstMAC: MACAddress.broadcast()`).
- **Sévérité** : Mineure
- **Recommandation** : documenter explicitement « ingress-replication only, pas de sous-jacent multicast IP, pas d'EVPN » dans les commentaires du module.

### 5.7 Cohérence show ↔ état (synthèse transverse)
- **Constat** : côté Cisco, les commandes `show standby`/`show vrrp`/`show glbp` projettent correctement l'état live des agents (`agent.getGroup(...)`), conformément aux bonnes pratiques MVC documentées.
- **Preuve** : `src/network/devices/shells/cisco/CiscoHsrpCommands.ts:18-27` (commentaire explicite « projecting the REAL FhrpRepository state », lecture via `getHsrpAgent()?.getGroup(...)`), `CiscoVrrpGlbpCommands.ts:115-123,143-159`.
- **Sévérité** : Information (positif — aucune action requise)
- **Recommandation** : maintenir cette discipline.

- **Constat** : côté Huawei, `display vrrp*` lit un état figé et jamais synchronisé (`HuaweiVrrpService.state`), contrairement au pendant Cisco — violation directe du principe « lire l'état live du moteur, pas un état caché/canné » (cf. 5.2 ci-dessus, sévérité Critique).
- **Preuve** : `src/network/devices/shells/huawei/HuaweiDisplayCommands.ts:1104-1184`.
- **Sévérité** : Critique (déjà comptée en 5.2, rappelée ici pour la synthèse transverse)
- **Recommandation** : voir 5.2.

### 5.8 Parité Cisco / Huawei (synthèse)
- **Constat** : HSRP et GLBP sont correctement absents de `HuaweiRouter`/`HuaweiVRPShell` (conforme à la réalité — protocoles propriétaires Cisco). VRRP est présent des deux côtés via `VrrpAgent` partagé — bonne conception (`src/network/devices/HuaweiRouter.ts:78,97,116,187,209` vs `CiscoRouter.ts:88,109,132,239,251`). IGMP et PIM sont câblés symétriquement dans les deux routeurs (`getIgmpAgent`/`getPimAgent` dans les deux classes), mais **aucun des deux** n'expose de commandes CLI — la parité est donc « parfaite dans l'absence » (les deux sont aussi inutilisables l'un que l'autre). IGMP snooping est Cisco-only (switch) sans équivalent Huawei — gap de parité réel (5.4). VXLAN est câblé symétriquement (Cisco/Huawei) mais headless des deux côtés — parité « dans l'absence » comme IGMP/PIM.
- **Preuve** : voir 5.4, 5.5, 5.6 ci-dessus pour les références précises.
- **Sévérité** : Majeure (synthèse transverse — la sévérité réelle est portée par les constats individuels 5.4-5.6).
- **Recommandation** : prioriser l'ajout de surface CLI pour IGMP/PIM/VXLAN (gain immédiat sur les deux vendors simultanément vu le câblage déjà symétrique), puis combler le manque IGMP-snooping côté Huawei.

---

## 6. Management, AAA & supervision (SNMP, NetFlow, NTP, Syslog, RADIUS, TACACS+, AAA, EEM, DNS)

Cette famille de protocoles présente une **maturité très inégale** : les couches « câble » (SNMP, NetFlow, NTP, Syslog, RADIUS, TACACS+) sont remarquablement bien construites au niveau protocolaire — vrais paquets UDP/TCP, FSM de requête/réponse, scheduler/EventBus réactifs — mais elles tournent en parallèle de la configuration CLI sans y être reliées : les commandes `snmp-server`, `aaa`, `flow …`, etc. alimentent des silos de configuration séparés qui ne sont jamais synchronisés avec les agents qui parlent réellement sur le câble. Résultat : la plupart des protocoles « marchent » isolément (et sont bien testés en isolation), mais ne participent pas au comportement observable du routeur via la CLI (`show snmp`, `show aaa`, `show ip cache flow`), où l'on retrouve des sorties figées ou des compteurs qui ne s'incrémentent jamais. EEM et DNS, eux, sont de purs silos de configuration sans moteur d'exécution.

### 6.1 SNMP — agent fonctionnel mais déconnecté de la CLI/config
- **Constat** : `SnmpAgent` (couche fil) et `SnmpService` (couche config/`show`) sont deux structures totalement indépendantes. La commande `snmp-server community/host/...` configure exclusivement `SnmpService` ; `SnmpAgent` démarre toujours avec sa config par défaut (`{community: 'public', access: 'ro'}`, aucun trap-host) car aucun appel CLI n'invoque `addCommunity`/`addTrapHost`/`setContact` sur lui.
- **Preuve** : `src/network/snmp/types.ts:101-108` (config par défaut figée) ; `src/network/devices/shells/CiscoShellBase.ts:1237-1243` (`snmp-server` ne configure que `getSnmpService()`) ; absence totale d'appel `snmpAgent.addCommunity/addTrapHost/setContact` dans tout le repo (recherche vide).
- **Sévérité** : Critique
- **Recommandation** : faire de `SnmpService` un simple front de configuration qui pousse ses changements vers `SnmpAgent` (à l'image de `syncSyslogAgent()` pour Syslog), ou fusionner les deux.

- **Constat** : `SnmpStats` (`pktsIn`, `getRequests`, `trapsSent`, …) n'est jamais incrémenté — `getStats()` retourne systématiquement l'objet à zéro initial. `show snmp` affiche donc en permanence des compteurs nuls même quand `SnmpAgent` répond effectivement à des requêtes GET en direct.
- **Preuve** : `src/network/devices/router/management/SnmpService.ts:233` (`getStats()` ne fait que cloner `this.stats`) — aucune occurrence de `this.stats.x++` ailleurs dans le fichier ; consommé tel quel par `showSnmp` dans `src/network/devices/shells/cisco/CiscoCommonShow.ts:389-409`.
- **Sévérité** : Majeure
- **Recommandation** : faire incrémenter ces compteurs depuis les événements `snmp.packet.received/sent/request.served/trap.sent` publiés par `SnmpAgent`.

- **Constat** : SET, GETBULK et INFORM sont déclarés dans `SnmpPduType`/`SNMP_PDU_TYPE` mais jamais traités — `handleUdp()` ne reconnaît que `get-response`, `get-request`, `get-next-request`. SNMPv1/v2c uniquement (`SnmpVersion = 'v1' | 'v2c'`), aucune trace d'USM (auth/priv) malgré le fait que `SnmpService` modélise pleinement les utilisateurs/groupes v3 (auth md5/sha, priv des/3des/aes).
- **Preuve** : `src/network/snmp/SnmpAgent.ts:113-121` (dispatch incomplet) ; `src/network/snmp/types.ts:6-13,4` (`SnmpPduType` inclut `set-request`/`get-bulk-request`/`inform-request`, `SnmpVersion` ne contient pas `'v3'`) ; `src/network/devices/router/management/SnmpService.ts:32-42` (modèle v3 complet mais purement déclaratif).
- **Sévérité** : Majeure
- **Recommandation** : implémenter au minimum `set-request`/`get-bulk-request`, et soit retirer le modèle v3 de `SnmpService` soit l'implémenter réellement dans `SnmpAgent`.

- **Constat** : `show aaa` est intégralement une chaîne en dur, sans rapport avec l'état réel (groupes/serveurs RADIUS-TACACS+ configurés via `aaa group server …`).
- **Preuve** : `src/network/devices/shells/cisco/CiscoCommonShow.ts:676-681` (`'Total sessions since last reload: 0'` / `'No AAA servers configured'` quel que soit l'état de `CiscoSecurityConfig.aaaGroups`).
- **Sévérité** : Mineure
- **Recommandation** : projeter `aaaGroups`/`radiusServers`/`tacacsServers` dans la sortie de `show aaa`.

### 6.2 NetFlow — export v5 fonctionnel mais flux 100% fabriqués (jamais issus du trafic)
- **Constat** : `NetFlowAgent.recordFlow()` n'est appelée nulle part dans le code de production (forwarding/handleFrame des routeurs) — uniquement depuis les tests unitaires. Le cache de flux, le vieillissement (`ageOut`) et l'export v5 sont solides, mais aucun paquet IP réellement acheminé par le routeur ne déclenche un enregistrement de flux.
- **Preuve** : `grep -rln "\.recordFlow(" src/network --include="*.ts"` ne retourne aucun résultat hors `NetFlowAgent.ts`/tests ; `getNetFlowAgent()` exposé en lecture seule dans `src/network/devices/CiscoRouter.ts:262` sans jamais être invoqué côté forwarding.
- **Sévérité** : Critique
- **Recommandation** : brancher `recordFlow()` sur le chemin de transmission IP du routeur (post-routage / post-NAT), avec échantillonnage selon `samplingInterval`.

- **Constat** : `show ip cache flow` (Flexible NetFlow legacy) renvoie un texte canné indépendant de l'état réel du cache.
- **Preuve** : `src/network/devices/shells/cisco/CiscoEemNetflowArchiveCommands.ts:367-368` — `() => 'IP packet size distribution (1 total packets):\n  (sim: cache empty)'`.
- **Sévérité** : Majeure
- **Recommandation** : projeter `NetFlowAgent.listActiveFlows()`/les compteurs de `NetflowService` dans cette commande.

- **Constat** : Deux modèles NetFlow parallèles et non synchronisés coexistent : `NetflowService` (Flexible NetFlow / config CLI moderne, `flow exporter/record/monitor`) et `NetFlowAgent` (export v5 réel sur le câble). Aucun pont entre les deux : configurer un `flow exporter` + `flow monitor` n'active jamais l'agent d'export réel.
- **Preuve** : `src/network/devices/router/netflow/NetflowService.ts` (entièrement déclaratif, aucune référence à `NetFlowAgent`) ; `src/network/netflow/NetFlowAgent.ts` (jamais consulté par `NetflowService`).
- **Sévérité** : Majeure
- **Recommandation** : faire que l'attache d'un moniteur Flexible NetFlow active réellement `NetFlowAgent` avec les paramètres (exportateur/cibles/timeouts) qui correspondent.

### 6.3 NTP — client/serveur basiques, mais pas d'algorithme de Marzullo ni de mode pair authentique
- **Constat** : `selectAndSync()` se contente d'un choix « meilleur candidat » (préférence > stratum le plus bas > dispersion la plus faible), sans intersection d'intervalles de Marzullo, sans cluster/combine algorithm conformes à RFC 5905 §11.
- **Preuve** : `src/network/ntp/NtpAgent.ts:204-231`.
- **Sévérité** : Mineure
- **Recommandation** : documenter explicitement l'approximation, ou implémenter une version simplifiée de l'algorithme d'intersection.

- **Constat** : `NtpMode` déclare `'symmetric-active'`/`'symmetric-passive'`, mais `ntp peer <ip>` est traduit en simple `addServer()` (mode client) — aucune association pair bidirectionnelle (peering symétrique) n'est réellement modélisée ; seul `'symmetric-passive'` est reconnu côté réception.
- **Preuve** : `src/network/devices/shells/CiscoShellBase.ts:1207-1213` (peer → addServer) ; `src/network/ntp/NtpAgent.ts:155` (seul `server`/`symmetric-passive` traités côté `acceptServerReply`) ; `src/network/ntp/types.ts:3`.
- **Sévérité** : Mineure
- **Recommandation** : soit retirer `'symmetric-active'` du type, soit implémenter un véritable mode pair.

- **Constat** : bug d'affichage dans `show ntp`/`show ntp associations` — la condition `(a.stratum < 16 ? 'INIT' : '.INIT.')` est inversée par rapport au comportement Cisco réel (un pair à `stratum 16` — non synchronisé — doit afficher `.INIT.`, et non l'inverse).
- **Preuve** : `src/network/devices/shells/cisco/CiscoCommonShow.ts:538`.
- **Sévérité** : Mineure
- **Recommandation** : inverser la condition (`a.stratum < 16 ? <ip ou ref réelle> : '.INIT.'`).

- **Constat** : `ntp authenticate`/`authentication-key`/`trusted-key` sont stockés dans `NtpConfig` (`authKeys`, `trustedKeys`, `authenticate`) mais jamais utilisés pour signer/valider les paquets NTP échangés (aucune vérification MAC MD5/SHA en réception).
- **Preuve** : `src/network/ntp/types.ts:53-56` (champs présents) ; `src/network/ntp/NtpAgent.ts` — `handleUdp`/`acceptServerReply`/`respondAsServer` ne consultent jamais `config.authenticate`/`authKeys`.
- **Sévérité** : Mineure
- **Recommandation** : simuler au moins le rejet des associations non authentifiées quand `ntp authenticate` est actif.

### 6.4 Syslog — implémentation la plus aboutie de la famille (référence MVC)
- **Constat** : pipeline événement → message bien conçu : `SyslogAgent` s'abonne au bus (`log`, `device.syslog.entry`), construit un vrai paquet UDP/514 BSD (`<PRI>timestamp host tag: msg`), gère seuils de sévérité, facultés et agrégation par hôte. `LoggingConfig`/`syncSyslogAgent()` synchronise correctement la config CLI (`logging host`, `logging trap`, …) vers l'agent réel — c'est le seul sous-système de cette famille où la boucle config→agent→show est complète.
- **Preuve** : `src/network/syslog/SyslogAgent.ts:111-176` (abonnements bus + dispatch) ; `src/network/devices/shells/CiscoShellBase.ts:138-166` (`syncSyslogAgent`).
- **Sévérité** : (positif — pas un défaut)
- **Recommandation** : prendre ce sous-système comme modèle pour corriger SNMP/NetFlow.

- **Constat** : `show logging` affiche en dur `(0 messages dropped, 0 flushes, 0 overruns)` malgré le fait que `SyslogAgent` publie déjà des événements `syslog.packet.dropped` (avec raison `no-route`/`link-down`/`threshold`/…) qui pourraient alimenter ce compteur.
- **Preuve** : `src/network/devices/inspection/config/LoggingConfig.ts:748-749` (texte figé) vs `src/network/syslog/SyslogAgent.ts:229-237` (`dropped()` publie un événement riche jamais consommé pour ce compteur).
- **Sévérité** : Mineure
- **Recommandation** : faire compter `LoggingConfig` les événements `syslog.packet.dropped` reçus.

### 6.5 RADIUS — échange de paquets réel mais aucune obfuscation conforme RFC 2865
- **Constat** : `RadiusClientAgent`/`RadiusServerAgent` réalisent un véritable échange Access-Request / Access-Accept / Access-Reject sur UDP/1812 avec retransmission/timeout, et sont bien testés (`radius-protocol.test.ts`). Cependant, le mot de passe `user-password` est transmis en clair dans l'attribut RADIUS au lieu d'être chiffré par XOR avec le flux MD5(secret‖authenticator) imposé par RFC 2865 §5.2 ; `sharedSecret` n'est stocké que pour affichage et n'intervient ni dans le calcul de l'`Authenticator` (qui est un simple PRNG basé sur l'heure, `makeAuthenticator`) ni dans le déchiffrement.
- **Preuve** : `src/network/radius/RadiusClientAgent.ts:173-176` (`attr('user-password', password)` en clair) ; `src/network/radius/types.ts:133-141` (`makeAuthenticator` = PRNG sans MD5/secret) ; aucune occurrence de `md5`/`xor`/`cipher` dans `src/network/radius/`.
- **Sévérité** : Majeure
- **Recommandation** : implémenter l'obfuscation PAP RFC 2865 §5.2 (au moins symboliquement, pour fidélité pédagogique du simulateur), et faire varier le résultat d'authentification si le `sharedSecret` ne correspond pas (la valeur `'bad-secret'` existe dans le type `reason` mais n'est jamais produite — voir `src/network/radius/events.ts:32` et `RadiusServerAgent.ts:96`, le secret n'étant jamais comparé).

- **Constat** : RADIUS Accounting (`accounting-request`/`accounting-response`, ports 1813) est défini dans le type (`RadiusCode`, `UDP_PORT_RADIUS_ACCT`) mais aucun agent ne l'émet/le traite.
- **Preuve** : `src/network/radius/types.ts:9-10,17-18,2` ; aucune occurrence d'`accounting-request` traitée dans `RadiusClientAgent.ts`/`RadiusServerAgent.ts`.
- **Sévérité** : Mineure
- **Recommandation** : implémenter au moins l'émission d'Accounting-Request Start/Stop, en miroir de `accountCommand` côté TACACS+.

### 6.6 TACACS+ — flux applicatif réel mais transport en clair (non conforme RFC 8907 §4.5)
- **Constat** : `TacacsClientAgent`/`TacacsServerAgent` modélisent le « single-connection model » via le `TcpStack` réel (connexion TCP/49, échange authen/author/acct sur la même session), avec FSM correcte et événements bus (`tacacs.authen.completed`, etc.). Mais le corps du paquet (`TacacsBody`) est envoyé tel quel comme objet typé via `socket.send(packet)` — aucun chiffrement par flux pseudo-aléatoire MD5(session_id‖key‖version‖seq_no) n'est appliqué, contrairement à RFC 8907 §4.5 ; `sharedSecret` n'est jamais consulté pour chiffrer/déchiffrer ni pour valider la session.
- **Preuve** : `src/network/tacacs/TacacsClientAgent.ts:180` (`s.send(packet)` — objet en clair) ; `src/network/tacacs/TacacsServerAgent.ts:96` (`socket.send(reply)`) ; aucune occurrence de `md5`/`pseudo-pad`/`xor` dans `src/network/tacacs/`.
- **Sévérité** : Majeure
- **Recommandation** : simuler le chiffrement par pseudo-pad (au moins symboliquement) et faire échouer l'échange en cas de `sharedSecret` divergent entre client et serveur.

### 6.7 AAA (subsystem) — pas de chaînage de listes de méthodes, RADIUS/TACACS+ totalement déconnectés de l'authentification réelle
- **Constat** : malgré la présence d'agents RADIUS/TACACS+ pleinement fonctionnels au niveau protocolaire, **aucune voie d'authentification du routeur (console/VTY/SSH/Telnet) ne les invoque**. `Router.authenticate()` ne consulte que `NetworkOsCredentialStore` (compte local). `aaaAuthenticationList`/`aaaAuthorizationList`/`aaaAccountingList` sont stockés dans `VtyLineConfig` (issus de `login authentication <list>`) mais ne sont **jamais lus** ailleurs que dans le rendu `running-config`.
- **Preuve** : `src/network/devices/Router.ts:1848-1857` (`authenticate()` → `authority.authenticate(username, password)`, uniquement le store local) ; `grep -rn "aaaAuthenticationList" src/network --include="*.ts"` ne retourne que des occurrences dans `VtyLineConfig.ts` (définition + rendu de config) ; `grep -rn "radiusClient.authenticate|tacacsClient.authenticate" src/network --include="*.ts"` ne retourne **que des fichiers de tests** (`radius-protocol.test.ts`, `tacacs-protocol.test.ts`), jamais le code de production.
- **Sévérité** : Critique
- **Recommandation** : implémenter le chaînage de listes de méthodes AAA (`aaa authentication login <list> group radius local`, etc.) dans le flux de login du routeur, en appelant `getRadiusClient().authenticate()`/`getTacacsClient().authenticate()` avant le repli sur le compte local.

- **Constat** : la commande `aaa …` (configuration complète de l'AAA — `aaa new-model`, `aaa authentication login`, `aaa authorization exec`, `aaa accounting commands`, etc.) est entièrement aspirée dans `recordRaw('aaa', …)`, un simple journal texte pour `show running-config`, sans aucun parsing en structures exploitables (listes de méthodes, ordre des sources).
- **Preuve** : `src/network/devices/shells/CiscoShellBase.ts:1284-1289` (`mgmt.recordRaw('aaa', raw ?? …)`), avec le commentaire explicite « Recognised; the sim has no AAA/crypto datapath » à la ligne 1283.
- **Sévérité** : Critique
- **Recommandation** : remplacer ce stockage brut par un vrai modèle de listes de méthodes consultable à l'authentification/autorisation/comptabilité.

- **Constat** : `aaaGroups` (`aaa group server radius/tacacs+ <name>`) sont stockés dans `CiscoSecurityConfig` mais jamais résolus vers les serveurs RADIUS/TACACS+ réellement configurés (`radiusServers`/`tacacsServers`), ni utilisés pour sélectionner un groupe lors d'une tentative d'authentification.
- **Preuve** : `src/network/devices/router/security/CiscoSecurityConfig.ts:242,366` (stockage et rendu uniquement).
- **Sévérité** : Majeure
- **Recommandation** : relier les groupes serveur aux agents `RadiusClientAgent`/`TacacsClientAgent` lors de la résolution des listes de méthodes.

### 6.8 EEM — pur silo de configuration, aucun moteur de corrélation d'événements
- **Constat** : `EemService` ne fait que stocker des `EemApplet` (déclencheurs/actions) déclarés en CLI et les restituer dans `show running-config`/`show event manager policy registered`. Il n'existe **aucun mécanisme de corrélation d'événements** : pas de souscription au bus pour les triggers `syslog`/`timer.cron`/`timer.watchdog`/`snmp-notification`/`snmp-object`/`cli`, et **aucune exécution** des actions déclarées (`cli`, `syslog`, `mail`, `snmp-trap`, `puts`, `wait`).
- **Preuve** : `grep -rln "EemTrigger|evaluateTrigger|matchTrigger|fireApplet|runApplet|executeApplet" src/network --include="*.ts"` ne renvoie que `EemService.ts` lui-même (les types, pas un moteur) ; `src/network/devices/router/eem/EemService.ts:1-108` (classe entièrement déclarative).
- **Sévérité** : Critique
- **Recommandation** : implémenter un véritable moteur EEM basé sur `src/events/` (à l'image de OSPF/DHCP) qui s'abonne aux événements pertinents (logs syslog, timers programmés via `Scheduler`, notifications SNMP) et exécute les actions associées.

- **Constat** : `EemService.triggerByName()` — censée déclencher manuellement un applet (`event manager run <applet>`) — est du code totalement mort : elle n'est invoquée nulle part (ni CLI, ni tests, ni ailleurs) ; elle ne fait qu'incrémenter un compteur sans exécuter la moindre action.
- **Preuve** : `src/network/devices/router/eem/EemService.ts:59-65` ; `grep -rn "triggerByName" src/ --include="*.ts"` → seule occurrence est sa définition.
- **Sévérité** : Mineure
- **Recommandation** : soit câbler `event manager run` à `triggerByName` puis à un moteur d'exécution, soit retirer ce code mort.

### 6.9 DNS (côté routeur) — table statique uniquement, pas de résolveur
- **Constat** : le « DNS » du routeur se limite à `RouterHostsTable` (mappings statiques `ip host <nom> <ip>`) et au stockage de `nameServers`/`domainName`/`ipDomainLookupEnabled` dans `RouterManagementService`. Il n'existe ni résolveur récursif, ni cache avec TTL, ni support de types d'enregistrements (A/AAAA/CNAME/MX/PTR/…), ni transfert de zone : le routeur ne génère jamais de requête DNS sur le câble vers les `nameServers` configurés.
- **Preuve** : `src/network/devices/router/dns/RouterHostsTable.ts:1-52` (table nom→IP uniquement) ; `src/network/devices/shells/CiscoShellBase.ts:1018-1031` (`ip name-server` stocke la liste sans jamais l'exploiter pour émettre une requête) ; aucune classe `DnsServer`/`DnsResolver`/`DnsCache`/`DnsZone` sous `src/network/devices/router`.
- **Sévérité** : Mineure
- **Recommandation** : si le périmètre du simulateur prévoit la résolution DNS dynamique côté routeur (au-delà de `ip host`), introduire un client DNS minimal qui interroge réellement `nameServers` ; sinon documenter explicitement cette limitation dans le code (comme cela est fait pour `show environment`).

---

## 7. SSH/SCP/SFTP, abstraction shell, shells CLI Cisco/Huawei, couche terminal

Globalement, cette zone du code est d'une maturité élevée et bien plus aboutie que ce qu'on pourrait craindre d'un simulateur : l'architecture SSH (auth Strategy, channels, forwarders, SFTP/SCP, host-keys) est cohérente, documentée par référence à des BRD/DESIGN docs, et la couche shell (`AbstractShell`/`IShell`/`ShellFactory`/`CrossVendorRemoteShell`) est uniformément respectée par tous les adaptateurs vendor. Les simplifications volontaires (crypto déterministe non cryptographique, `nc` minimal, SOCKS5 partiel) sont explicitement documentées comme « pédagogiques » et ne trompent pas le lecteur. Les principaux points faibles relevés sont : un paquet de fichiers `STUB FILE` totalement morts dans `src/terminal/`, des suites de tests SFTP `.bak` obsolètes référençant un arbre de modules supprimé, et quelques classes CLI démesurées (1500-2100 lignes).

### 7.1 SSH/SCP/SFTP — fichiers morts et tests legacy obsolètes
- **Constat** : trois fichiers de tests SFTP « legacy » (`.bak`, ~85 Ko cumulés) importent des modules d'un arbre `@/network/protocols/sftp/` qui n'existe plus (le code vit désormais sous `@/network/protocols/ssh/sftp/`). Ils ne sont plus exécutés par Vitest (extension `.bak`) mais traînent dans le dépôt et créent de la confusion sur la couverture réelle.
- **Preuve** : `src/__tests__/unit/network-v2/sftp.legacy.test.ts.bak:22-29` (`import { SftpSession } from '@/network/protocols/sftp/SftpSession'` — chemin inexistant, vérifié : `src/network/protocols/sftp/` n'existe pas) ; idem `sftp-edge-cases.legacy.test.ts.bak`, `sftp-wan.legacy.test.ts.bak`.
- **Sévérité** : Mineure
- **Recommandation** : supprimer ces trois fichiers `.bak` (la couverture est reprise par `ssh-sftp.test.ts`, `scp-sftp-domain.test.ts`, `sftp-shell-suite.test.ts` qui totalisent ~126 cas) ou, si une régression de couverture est suspectée, migrer les scénarios utiles vers la suite active.

### 7.2 SSH — crypto et key-exchange volontairement simulés (documenté, non trompeur)
- **Constat** : `SshKeyPair.generate`/`SshFingerprint.fromPublicKey` utilisent un hash non cryptographique déterministe (FNV/Murmur-like) au lieu d'Ed25519/RSA réels ; aucune négociation Diffie-Hellman n'existe (pas de `kex`/`dh` dans le code). C'est assumé et commenté comme « simulator only / no external dependency », donc ce n'est pas une « fausse » implémentation cachée.
- **Preuve** : `src/network/protocols/ssh/SshKeyPair.ts:27-39` (`simpleMaterial` / seed déterministe), `src/network/protocols/ssh/SshFingerprint.ts:42-49` (`simpleHash` documenté « Sufficient for the simulator »).
- **Sévérité** : Mineure
- **Recommandation** : aucune action corrective nécessaire — à signaler simplement dans la documentation utilisateur/pédagogique pour que personne ne croie à une vraie poignée de main SSH chiffrée.

### 7.3 SSH — forwarders « pedagogical stub » bridgés via `nc`
- **Constat** : les trois forwarders (`-L`, `-R`, `-D`) ne bridgent pas réellement le trafic applicatif : ils ouvrent un canal d'exécution lançant `nc <host> <port>` côté distant, ce qui est qualifié explicitement de « pedagogical stub » / « thin stub ». Le SOCKS5 du forwarder dynamique ne supporte que `CONNECT` (pas `BIND`/`UDP ASSOCIATE`).
- **Preuve** : `src/network/protocols/ssh/SshRemoteForwarder.ts:72-74`, `src/network/protocols/ssh/SshLocalForwarder.ts:79-81`, `src/network/protocols/ssh/SshDynamicForwarder.ts:14` (« UDP ASSOCIATE / BIND are not implemented »).
- **Sévérité** : Mineure
- **Recommandation** : RAS fonctionnellement (suffisant pour les scénarios pédagogiques visés et bien documenté) ; juste s'assurer que les tests de tunnels n'attendent pas un bridge bas-niveau réel (TCP byte-for-byte) au-delà de ce que `nc` simulé permet.

### 7.4 SSH — point d'authentification non câblé par défaut
- **Constat** : `ISshServerContext.checkPassword` est documenté comme retournant « rejected » par défaut quand non implémenté — un contrat un peu fragile si un nouveau type de device oublie de le brancher (échec silencieux côté auth plutôt qu'une erreur explicite à l'enregistrement).
- **Preuve** : `src/network/protocols/ssh/server/ISshServerContext.ts:70` (« Defaults to "rejected" when not implemented »), `src/network/protocols/ssh/server/RouterSshServerContext.ts:162` (« wired into NetworkOsCredentialStore — placeholder so the handler... »).
- **Sévérité** : Mineure
- **Recommandation** : envisager un assert/log de configuration au démarrage du serveur SSH si `checkPassword`/`checkPublicKey` ne sont pas explicitement fournis, pour distinguer « refus volontaire » de « non câblé ».

### 7.5 Shell abstraction — couche `IShell`/`AbstractShell` réellement uniforme
- **Constat** : tous les adaptateurs (`LinuxBashShell`, `WindowsCmdShell`, `WindowsPowerShellShell`, `SqlPlusShell`, `RmanShell`, `CiscoIOSShellAdapter`, `HuaweiVRPShellAdapter`, `SftpShell`) étendent bien `AbstractShell` et passent par le pipeline Template-Method `processLine` (history → exit → clear → dispatch). `CrossVendorRemoteShell` est un Composite propre qui pousse/dépile des `IShell` réels — pas de logique ad-hoc bypassant le contrat.
- **Preuve** : `src/shell/AbstractShell.ts:154-191`, `src/shell/CrossVendorRemoteShell.ts:106-167`, `src/shell/registerDefaults.ts:33-92`.
- **Sévérité** : (positif, pas un défaut) — mentionné pour mémoire d'audit.
- **Recommandation** : aucune.

### 7.6 Shell abstraction — adaptateurs « pont vers legacy » en transition explicite
- **Constat** : `WindowsPowerShellShell`, `SqlPlusShell` et `RmanShell` ne réimplémentent pas leur moteur ; ils enveloppent des sous-shells « legacy » (`PowerShellSubShell`, `SqlPlusSubShell`, `ReactiveRmanSubShell`). C'est documenté comme une étape de migration (« Phase 1B migrates all sessions… the legacy sub-shell will be deleted »), donc ce n'est pas un vrai stub mais une dette de migration assumée et traçable.
- **Preuve** : `src/shell/adapters/WindowsPowerShellShell.ts:5-14` (commentaire « no banner-and-close placeholder » — note le commentaire admet l'existence passée d'un vrai placeholder, désormais remplacé), `src/shell/adapters/SqlPlusShell.ts:4-9`, `src/shell/adapters/RmanShell.ts:1-21`.
- **Sévérité** : Mineure
- **Recommandation** : prioriser la « Phase 1B » mentionnée dans les commentaires pour réduire la double couche IShell→ISubShell (cf. 7.9) et supprimer `ShellSubShellAdapter` une fois la migration achevée.

### 7.7 CLI shells — `CLIStateMachine`/`PromptBuilder`/`CommandTrie` : factorisation réussie Cisco/Huawei
- **Constat** : la hiérarchie de modes et les prompts sont entièrement data-driven (`CISCO_IOS_MODES`/`CISCO_SWITCH_MODES`/`HUAWEI_VRP_MODES`, `CISCO_IOS_PROMPTS`/`HUAWEI_VRP_PROMPTS`), ce qui élimine la duplication de logique de transition entre `CiscoIOSShell`, `CiscoSwitchShell`, `HuaweiVRPShell`. Couverture de modes très large côté Cisco IOS (47 sous-modes) vs. Huawei VRP (12) — écart qui reflète fidèlement la réalité des deux OS (VRP a une arborescence de configuration moins fragmentée), donc pas une lacune mais une différence de spec légitime.
- **Preuve** : `src/network/devices/shells/CLIStateMachine.ts:104-178`, `src/network/devices/shells/PromptBuilder.ts:52-126`.
- **Sévérité** : (positif)
- **Recommandation** : aucune ; bon modèle à suivre si d'autres vendors (Junos, Mikrotik…) sont ajoutés.

### 7.8 CLI shells — classes « god object » volumineuses
- **Constat** : `HuaweiVRPShell.ts` (2116 lignes), `CiscoSwitchShell.ts` (2113), `HuaweiSwitchShell.ts` (1661) et `CiscoShellBase.ts` (1528) dépassent largement la taille raisonnable d'une classe shell, même en tenant compte de l'enregistrement de nombreux tries de commandes par mode.
- **Preuve** : tailles mesurées : `wc -l src/network/devices/shells/{CiscoShellBase,CiscoSwitchShell,HuaweiSwitchShell,HuaweiVRPShell}.ts` → 1528/2113/1661/2116 lignes.
- **Sévérité** : Mineure
- **Recommandation** : poursuivre l'extraction déjà amorcée vers `cisco/*Commands.ts` et `huawei/*Commands.ts` (le pattern existe déjà pour OSPF, ACL, NAT, IPSec…) pour les segments restants encore inline dans les shells principaux, et envisager de scinder `HuaweiVRPShell`/`CiscoSwitchShell` en mixins ou composeurs par domaine fonctionnel.

### 7.9 Shell abstraction — double couche `IShell`/`ISubShell` en cours de fusion
- **Constat** : `ShellSubShellAdapter` est un adaptateur de transition explicitement temporaire (« Phase 1B will remove this adapter ») entre le nouveau contrat `IShell` et l'ancien `ISubShell` que `TerminalSession` comprend encore. Tant que la migration n'est pas terminée, deux hiérarchies de sous-shells coexistent (`RemoteDeviceSubShell`/`RemoteShellSubShell` côté `ISubShell` legacy, `CrossVendorRemoteShell` côté `IShell`), avec un risque de divergence de comportement entre les deux chemins.
- **Preuve** : `src/shell/ShellSubShellAdapter.ts:1-13`, usage croisé dans `src/terminal/sessions/LinuxTerminalSession.ts` et `src/shell/CrossVendorRemoteShell.ts`.
- **Sévérité** : Mineure
- **Recommandation** : terminer la « Phase 1B » pour supprimer l'adaptateur et unifier sur `IShell`/`AbstractShell` partout — réduit la surface de duplication et les risques de bugs « ça marche en SSH mais pas en local » (déjà mentionnés en commentaire comme bug historique, cf. `CrossVendorRemoteShell.ts:12-14`).

### 7.10 Terminal — fichiers `STUB FILE` complètement morts dans `src/terminal/`
- **Constat** : quatre fichiers explicitement marqués « STUB FILE - will be rebuilt with TDD » sont restés dans l'arborescence : `commands.ts`, `packages.ts`, `shellUtils.ts`, `types.ts`. Le premier (`commands.ts`) importe même un module `./filesystem` **qui n'existe pas** dans `src/terminal/` — il ne compile probablement que parce qu'il n'est jamais référencé. Aucun de ces fichiers n'est importé ailleurs (sauf `packages.ts`, voir 7.11).
- **Preuve** :
  - `src/terminal/commands.ts:1-51` (import `./filesystem` inexistant ; `ls`/`cat` renvoient `'STUB: directory listing'` / `'STUB: file contents'`)
  - `src/terminal/packages.ts:1-36`
  - `src/terminal/shellUtils.ts:1-87` (contient même un système d'« Achievements »/tutoriels sans rapport apparent avec le shell — `ACHIEVEMENTS`, `TUTORIAL_STEPS` lignes 35-69 — mort lui aussi)
  - `src/terminal/types.ts:1-29`
  - vérifié : aucun import de `terminal/commands'`, `terminal/shellUtils'`, `terminal/types'` dans toute la codebase ; `src/terminal/filesystem.ts` n'existe pas.
- **Sévérité** : Mineure
- **Recommandation** : supprimer ces quatre fichiers morts (et leur contenu hors-sujet comme le système d'achievements) — ils n'apportent rien et induisent en erreur quiconque cherche l'implémentation réelle des commandes du terminal (qui se trouve en réalité dans `LinuxTerminalSession.ts`/`bash/` interpreter).

### 7.11 Terminal — `preInstallForDevice` : pont vers un stub no-op encore appelé en production
- **Constat** : contrairement aux trois autres fichiers stub, `packages.ts` est bel et bien importé et appelé par `TerminalManager.openTerminal()` pour tout device dont le type commence par `db-`. Or l'implémentation se contente d'un `console.log('STUB: Pre-installing packages for ...')` sans aucun effet.
- **Preuve** : `src/terminal/packages.ts:32-35` (corps de fonction = `console.log` uniquement) ; appel production `src/terminal/sessions/TerminalManager.ts:24,166-168`.
- **Sévérité** : Mineure
- **Recommandation** : soit retirer cet appel mort (`preInstallForDevice`) du chemin chaud `openTerminal`, soit le brancher sur le vrai mécanisme d'amorçage du filesystem Oracle (`initOracleFilesystem` / `OracleFilesystemSync`) si l'intention de « pré-installation » est toujours pertinente — actuellement il s'agit d'un appel sans effet observable qui pollue la console à chaque ouverture de terminal sur un device `db-*`.

### 7.12 Sub-shells — `RmanSubShell.ts` legacy entièrement mort, supplanté par `ReactiveRmanSubShell`
- **Constat** : `src/terminal/subshells/RmanSubShell.ts` est une implémentation RMAN « stubbed » à sortie canée (« Provides a realistic stubbed RMAN> prompt … returning plausible output »), entièrement remplacée par la suite réactive complète (`ReactiveRmanSubShell` + moteur `rman/job/RmanJobEngine`, catalogue, channels, policies — ~30 fichiers). Vérification faite : aucun import de `RmanSubShell` (hors lui-même) nulle part dans le repo ; `RmanShell` (l'adaptateur `IShell` enregistré dans `registerDefaults.ts`) instancie exclusivement `ReactiveRmanSubShell`.
- **Preuve** : `src/terminal/subshells/RmanSubShell.ts:1-6` (« Provides a realistic stubbed RMAN> prompt with common backup/recovery commands returning plausible output »), absence totale de référence ailleurs (`grep -rn "import.*RmanSubShell\b"` ne renvoie que des correspondances `ReactiveRmanSubShell`), `src/shell/adapters/RmanShell.ts:15` instancie `ReactiveRmanSubShell.create`.
- **Sévérité** : Mineure
- **Recommandation** : supprimer purement et simplement `RmanSubShell.ts` — c'est un vestige d'une itération antérieure remplacée par une implémentation nettement plus aboutie (architecture Engine+events+actors+reactive conforme à la convention documentée du projet).

### 7.13 Cross-cutting — duplication potentielle `RemoteDeviceSubShell` vs `RemoteShellSubShell`
- **Constat** : deux classes `ISubShell` couvrent un terrain voisin — un sous-shell distant générique pilotant `executeCommand` directement (`RemoteDeviceSubShell`, multi-vendor via `RemotePromptStrategy`) et un sous-shell distant via canal SSH exec avec gestion explicite du `cwd` (`RemoteShellSubShell`, Linux uniquement). La docstring de `RemoteDeviceSubShell` indique explicitement « Use this whenever RemoteShellSubShell … is too narrow », ce qui suggère une coexistence voulue plutôt qu'une duplication accidentelle, mais le chevauchement de responsabilités (gestion de prompt, mots de sortie, `clear`) entre les deux mérite vigilance pour éviter une dérive de comportement entre les deux chemins SSH.
- **Preuve** : `src/terminal/subshells/RemoteDeviceSubShell.ts:11-18` (justification explicite de coexistence), `src/terminal/subshells/RemoteShellSubShell.ts:1-13` (gestion `cd`/`pwd` spécifique POSIX).
- **Sévérité** : Mineure
- **Recommandation** : documenter clairement (ou factoriser via une stratégie commune) la règle de choix entre les deux classes pour éviter qu'un futur ajout vendor ne duplique encore une troisième variante ; envisager de fusionner `RemoteShellSubShell` comme une `RemotePromptStrategy` spécialisée de `RemoteDeviceSubShell` à terme.

---

## 8. Interpréteur Bash & sous-systèmes hôte Linux

L'ensemble bash (`src/bash/`, ~6 200 lignes) est une implémentation sérieuse et largement fidèle à POSIX/bash : lexer/parser/AST/interpréteur séparés, pipelines, fonctions, sous-shells, `case`/`for`/`while`/`until`, `[[ ]]`, `(( ))`, expansions de paramètres avancées (`${var#pattern}`, indirection, tableaux), here-docs/here-strings, alias, traps `EXIT`. Les sous-systèmes Linux (`src/network/devices/linux/`, ~33 600 lignes) sont également très étoffés — VFS hiérarchique avec inodes/permissions/ACL, iptables qui filtre réellement les paquets via `FilterChain`, IAM/NSS, journald/dmesg, ps/top adossés à une vraie table de processus. Les lacunes identifiées concernent surtout des aspects « asynchrones » du shell (jobs, traps non-EXIT, cron/at), quelques commandes à sortie canned déconnectée de l'état réel, et du code mort issu d'itérations successives.

### 8.1 Lexer / parser — couverture globalement bonne, lacunes ciblées
- **Constat** : aucune substitution de processus `<(...)`/`>(...)` (absente du lexer, du parser et de `ASTNode.ts`) ; le `&` de fond de tâche est traité par le parser exactement comme `;` (séparateur synchrone), sans nœud AST distinct pour une commande arrière-plan.
- **Preuve** : `src/bash/parser/BashParser.ts:817` (`matchSeparator` traite `AMP` comme `SEMI`/`NEWLINE`) ; absence de `ProcessSubstitution` dans `src/bash/parser/ASTNode.ts`.
- **Sévérité** : Mineure
- **Recommandation** : documenter explicitement ces non-objectifs (le simulateur étant synchrone, le job control « réel » au niveau interpréteur n'a pas grand sens) ou ajouter un nœud `Background` minimal pour différencier sémantiquement `cmd &` de `cmd;`.

### 8.2 Interpréteur — pipelines « simplifiés », traps partiels
- **Constat** : le pipeline multi-étapes ne relaie pas un flux ; il exécute chaque étage de façon synchrone, capture la totalité de la sortie en mémoire puis la repasse en argument à l'étage suivant — commentaire du code lui-même : « simplified: pass output as arg ». Cela casse les sémantiques de flux (`tail -f | grep`, processus longue durée dans un pipe, SIGPIPE, etc.) mais reste correct pour l'essentiel des scripts batch testés.
- **Preuve** : `src/bash/interpreter/BashInterpreter.ts:255` (commentaire « Multi-stage pipeline: chain stdout → stdin (simplified: pass output as arg) »).
- **Sévérité** : Mineure
- **Recommandation** : RAS pour un simulateur synchrone ; documenter la limite dans le README du module.

- **Constat** : seul le trap `EXIT` est réellement déclenché par l'interpréteur (`fireExitTrap`). Les traps `INT`, `TERM`, `ERR`, `DEBUG`, `USR1`, etc. sont stockés/listés/effacés via `Environment.setTrap/getTrap/clearTrap/listTraps` mais **jamais invoqués** — aucun appel à `getTrap` autre que pour `'EXIT'`.
- **Preuve** : `src/bash/interpreter/BashInterpreter.ts:188-193` (`fireExitTrap`) ; absence totale d'appel `getTrap('ERR'|'INT'|'DEBUG'|...)` dans tout `BashInterpreter.ts` — seul `'EXIT'` apparaît (lignes 189, 191) ; tests ne couvrent que « trap EXIT » (`src/__tests__/unit/bash/bash-third-pass.test.ts:159-191`, section « §S — trap EXIT cleanup »).
- **Sévérité** : Majeure
- **Recommandation** : soit implémenter au minimum `ERR` (déclenché quand `errexit` aurait abouti à un échec) et `DEBUG`, soit documenter clairement que `trap` ne supporte que `EXIT` (le builtin `trap -l` affiche pourtant la liste complète des 16 signaux POSIX, ce qui laisse croire à un support complet — `src/bash/runtime/Builtins.ts:1105-1109`).

### 8.3 Runtime / Builtins — bon niveau, duplication d'expansion ailleurs
- **Constat** : `Expansion.ts` (1148 lignes) implémente correctement la substitution de commandes en délégant à l'interpréteur via `CommandSubstitutionFn` (`src/bash/runtime/Expansion.ts:20,691`). Mais un second moteur d'expansion, ad-hoc et nettement plus faible, existe en parallèle dans `LinuxScriptExecutor.ts` (voir §8.7) — duplication d'architecture qui contredit le principe DRY énoncé dans `CLAUDE.md`.
- **Preuve** : `src/bash/runtime/Expansion.ts:20,691` vs `src/network/devices/linux/LinuxScriptExecutor.ts:392-411`.
- **Sévérité** : Mineure (le second moteur étant mort, voir 8.7)
- **Recommandation** : supprimer le moteur dupliqué.

### 8.4 Builtins / utilitaires « canned » déconnectés de l'état machine
- **Constat** : `md5sum`/`sha256sum`/`sha1sum` génèrent une empreinte **purement aléatoire** (`Math.random()`) sans lire le contenu réel du fichier via le VFS — deux exécutions consécutives sur le même fichier renvoient des hachages différents, et `file` renvoie systématiquement `"<target>: ASCII text"` sans inspecter le contenu.
- **Preuve** : `src/network/devices/linux/LinuxCommandExecutor.ts:2341-2347` (hash `Array.from({length:...}, () => Math.floor(Math.random()*16)...)`) et `LinuxCommandExecutor.ts:2336-2339`.
- **Sévérité** : Majeure
- **Recommandation** : calculer un hachage déterministe (ex. simple FNV/CRC32 du contenu lu via `vfs.readFile`) pour que `md5sum file1 file2` et les vérifications de cohérence (`md5sum -c`) donnent des résultats stables et exploitables dans les scripts pédagogiques.

- **Constat** : `tar`, `gzip`, `gunzip`, `zip`, `unzip` sont de purs no-ops renvoyant une sortie vide, sans aucun effet de bord sur le VFS (pas de création d'archive, pas de décompression, pas de modification de la taille/contenu des fichiers).
- **Preuve** : `src/network/devices/linux/LinuxCommandExecutor.ts:2349-2354`.
- **Sévérité** : Majeure
- **Recommandation** : à défaut d'implémenter un vrai format d'archive, simuler au minimum la création d'un fichier « archive » dans le VFS (avec une taille dérivée du contenu source) pour que les scripts de sauvegarde/déploiement testés dans les labs restent cohérents (`ls -la backup.tar.gz` doit montrer un fichier non vide après `tar czf`).

- **Constat** : `apt`/`apt-get`/`dpkg` renvoient des transcriptions figées et identiques quel que soit le paquet demandé (toujours « is already the newest version », toujours la même liste `dpkg -l`), sans mise à jour d'un état « paquets installés » persistant ni d'effets sur le VFS/`LinuxServiceManager`.
- **Preuve** : `src/network/devices/linux/LinuxCommandExecutor.ts:2319-2331`.
- **Sévérité** : Mineure
- **Recommandation** : acceptable pour un labo réseau (peu de scénarios pédagogiques dépendent de la gestion de paquets) ; documenter comme limite connue.

- **Constat** : les « stubs » de `ping`/`traceroute`/`nslookup`/`dig`/`host` produisent une sortie figée (latences fixes `0.5 ms`/`0.4 ms`, IP de résolution toujours `93.184.216.34`) ; le code indique lui-même que ce chemin ne sera « jamais » emprunté en usage interactif (intercepté en amont par `LinuxMachine`/`linux/commands/net/Ping.ts`), ce qui en fait du code mort conditionnel à conserver « en secours » pour les scripts bash exécutés hors-terminal.
- **Preuve** : `src/network/devices/linux/LinuxCommandExecutor.ts:2294-2316` (commentaire « @deprecated ... These stubs will never fire for interactive terminal commands »).
- **Sévérité** : Mineure
- **Recommandation** : router ces commandes vers le même chemin réel que `Ping.ts` même depuis l'intérieur de l'interpréteur bash (scripts/`bash -c`) afin que `ping` dans un script shell produise des résultats cohérents avec la topologie simulée (latence selon la distance réseau, échec si hôte injoignable).

### 8.5 Réseau (`netstat`/`ss`/`ip`) — violations MVC partielles
- **Constat** : `netstat -r` (table de routage) et `netstat -i` (statistiques d'interfaces) renvoient un texte **entièrement statique** (« `0.0.0.0  10.0.0.1  ...  eth0` », compteurs RX/TX figés) — le paramètre `ctx: IpNetworkContext` reçu par `cmdNetstat` n'est jamais déréférencé dans ces deux branches, donc la sortie ne reflète ni les IP/masques réellement configurés sur la machine, ni les vraies statistiques de trafic.
- **Preuve** : `src/network/devices/linux/LinuxNetCommands.ts:115-130` (les littéraux `'0.0.0.0 10.0.0.1 ... eth0'`/`'eth0 1500 1024 ...'`) ; absence de toute référence `ctx.` dans le corps de `cmdNetstat` (`LinuxNetCommands.ts:99-191`).
- **Sévérité** : Majeure
- **Recommandation** : dériver ces tableaux de `ctx.getRoutingTable()` / `ctx.getInterfaceInfo()` (déjà exposés par `IpNetworkContext`, voir `LinuxIpCommand.ts:45-65`) — l'infrastructure existe, il suffit de la brancher.

- **Constat** : `ss -s` (résumé) renvoie des compteurs globaux figés (« Total: 120 », « TCP: 8 ... ») sans rapport avec le `SocketTable` réel de la machine ; le chemin de repli (`else` quand `socketTable` est absent) imprime des PID fixes (`pid=985`, `pid=2001`, `pid=1200`) déconnectés de la table de processus réelle.
- **Preuve** : `src/network/devices/linux/LinuxNetCommands.ts:212-221` (bloc `summary`) et `LinuxNetCommands.ts:258-268` (fallback avec PID en dur).
- **Sévérité** : Mineure
- **Recommandation** : calculer le résumé à partir de `socketTable.getAll()` (compter par protocole/état) plutôt que de coder les nombres en dur ; le chemin de repli ne devrait être atteint qu'en l'absence de table — documenter ce cas comme dégradé volontaire.

### 8.6 Cron / at — état stocké mais jamais « tiqué » (pas d'ordonnancement réel)
- **Constat** : `LinuxCronManager` (164 lignes) implémente un parseur d'expression cron correct (`CronSchedule.isDue`, `dueJobs`), mais **rien ne consomme `dueJobs()` au fil du temps simulé** : la seule invocation se produit au moment de l'installation d'une nouvelle crontab (`crontab -`), et même là, elle se contente de **journaliser** « (user) CMD (...) » sans exécuter réellement la commande planifiée. Aucun lien avec `src/events/Scheduler`.
- **Preuve** : `src/network/devices/linux/LinuxCommandExecutor.ts:2622-2629` (seul site d'appel de `cron.dueJobs()`, qui se contente de `logMgr.logDaemon('CRON', ...)`) ; `LinuxCronManager.ts:151-154` (`dueJobs`) jamais référencé ailleurs.
- **Sévérité** : Majeure
- **Recommandation** : brancher `LinuxCronManager` sur le `Scheduler`/l'horloge simulée du device pour déclencher réellement `dueJobs()` à chaque « minute » simulée et exécuter la commande via `LinuxCommandExecutor.execute()` (avec effets de bord visibles dans `journalctl`/VFS), à l'image de ce qui est fait pour `cmd &` (`handleBackgroundIfTrailing`, `LinuxCommandExecutor.ts:1159-1169`).

- **Constat** : la file `at` est documentée comme volontairement inerte — « the simulator does not fire jobs on a timer » — confirmant l'absence générale d'ordonnancement temporisé pour les tâches utilisateur (cron + at).
- **Preuve** : `src/network/devices/linux/jobs/LinuxAtQueue.ts:7`.
- **Sévérité** : Mineure (limite assumée et documentée)
- **Recommandation** : si une intégration `Scheduler` est ajoutée pour `cron`, étendre la même mécanique à `LinuxAtQueue` pour cohérence.

### 8.7 Code mort / duplication — plusieurs implémentations concurrentes
- **Constat** : `LinuxScriptExecutor.ts` (412 lignes) est un **second interpréteur de scripts shell entièrement mort** — `executeScript`/`executeScriptContent` ne sont importés/référencés nulle part dans `src/`. Il réimplémente, en moins bien, ce que fait `BashInterpreter` : sa fonction `resolveVars` traite la substitution de commande `$(cmd)` en renvoyant **le texte littéral de la commande** (pas son résultat), utilise `Function(...)` (équivalent `eval`) pour l'arithmétique, et procède par chaînes de `replace` regex plutôt que par AST.
- **Preuve** : `src/network/devices/linux/LinuxScriptExecutor.ts:392,401-404` (`// Command substitution - simplified` ; `return cmd;`) ; absence de toute référence externe (`grep -rln "LinuxScriptExecutor|executeScriptContent"` ne retourne que le fichier lui-même).
- **Sévérité** : Majeure
- **Recommandation** : supprimer purement et simplement ce fichier — il s'agit d'une ancienne génération remplacée par `BashInterpreter`/`ScriptRunner`, et sa présence risque d'induire en erreur un futur contributeur qui le réutiliserait par accident (sa sémantique de substitution de commande est fausse).

- **Constat** : `LinuxSystemCommands.ts` contient trois fonctions exportées **mortes et redondantes** — `cmdSystemctl(args, isServer: boolean)`, `cmdService(args, isServer: boolean)` et `cmdTop(...)` — qui dupliquent (avec une signature plus pauvre, basée sur un simple booléen `isServer` plutôt que sur le `LinuxServiceManager`/`LinuxProcessManager` réels) les fonctions homonymes effectivement utilisées dans `LinuxProcessCommands.ts`. La version morte produit des valeurs aléatoires (`Math.random()` pour mémoire/CPU/tâches) et un PID calculé par formule (`1000 + index`) plutôt que dérivé de la table de processus.
- **Preuve** : définitions mortes en `src/network/devices/linux/LinuxSystemCommands.ts:56` (`cmdSystemctl`), `:198` (`cmdService`), `:377` (`cmdTop`) avec, par ex., `Math.floor(Math.random() * 5) + 1` à la ligne 87 et `Main PID: ${1000 + services.indexOf(svc)}` à la ligne 86 ; import effectif des homonymes vivants depuis `LinuxProcessCommands` en `LinuxCommandExecutor.ts:51` (`cmdSystemctl`, `cmdService`, `cmdTop` — utilisés lignes 2276-2277, 2285-2286) ; seules `cmdDf/cmdDu/cmdFree/cmdMount/cmdLsblk` de `LinuxSystemCommands.ts` sont importées (`LinuxCommandExecutor.ts:36`).
- **Sévérité** : Majeure
- **Recommandation** : supprimer les trois fonctions mortes de `LinuxSystemCommands.ts` (et renommer le fichier en quelque chose comme `LinuxDiskCommands.ts` puisqu'il ne contient plus que `df`/`du`/`free`/`mount`/`lsblk`), pour éviter toute confusion entre deux implémentations de `systemctl status` aux comportements radicalement différents (l'une dérivée de l'état réel des services, l'autre aléatoire).

### 8.8 God-class et organisation
- **Constat** : `LinuxCommandExecutor.ts` totalise 3 842 lignes, ~127 méthodes privées et 227 branches `case` dans son dispatcher de commandes — un fichier « orchestrateur » qui mélange dispatch de commandes, gestion SSH/SFTP/SCP, gestion utilisateurs (`adduser`/`passwd`/`gpasswd`), IPsec (`ipsec`/`strongswan`), jobs en arrière-plan, ACL, etc.
- **Preuve** : `wc -l src/network/devices/linux/LinuxCommandExecutor.ts` → 3842 lignes ; `grep -c "case '"` → 227 ; cas IPsec en `LinuxCommandExecutor.ts:3560-3571`.
- **Sévérité** : Mineure
- **Recommandation** : poursuivre l'extraction déjà amorcée (le fichier référence de nombreux modules `coreutils/`, `ps/`, `sed/`, `nss/`, `jobs/`, `iam/` extraits récemment selon les commentaires « Extracted ... PR 10 ») en déplaçant les blocs `ipsec`/`adduser`/`gpasswd`/ACL vers des modules dédiés à l'image de ce qui a déjà été fait pour `JobCommands`/`PsCommand`/`IamFilesystem`.

### 8.9 Filesystem, IAM, sed/awk — points positifs (pas de déficience majeure)
- **Constat** : le VFS (`VirtualFileSystem.ts`, 1113 lignes) est un véritable arbre d'inodes avec permissions POSIX 12 bits, propriétaires, ACL (`aclUsers`/`aclGroups`), fichiers générés dynamiquement (procfs-like via `generator`), et notifie les écritures via `VfsWriteListener` — pas une simple table à plat. `sed`/`awk` disposent chacun de leur propre lexer/parser/moteur dédié (`sed/SedEngine.ts` + 4 modules ; `awk/AwkInterpreter.ts` + `AwkParser.ts`/`AwkValue.ts`, ~1740 lignes cumulées), et `iptables` filtre réellement les paquets via `LinuxIptablesManager.filterPacket()` branché sur `firewallFilter`/`evaluateNat`/`evaluatePreRouting` du `LinuxMachine`.
- **Preuve** : `src/network/devices/linux/VirtualFileSystem.ts:11-37` (interface `INode`) ; `src/network/devices/LinuxMachine.ts:1177-1268` (`firewallFilter`/`evaluateNat`/`evaluatePreRouting` → `this.executor.iptables.*`).
- **Sévérité** : (positif — pas de finding correctif)
- **Recommandation** : aucune ; ce sont des sous-systèmes à citer en exemple pour le reste du projet.

- **Constat** : un seul point mineur de simplification documentée dans `iptables` — le critère `conntrack --ctstate RELATED` est traité comme strictement équivalent à `ESTABLISHED` (pas de véritable suivi de connexions liées, ex. FTP passif).
- **Preuve** : `src/network/devices/linux/LinuxIptablesManager.ts:382` (commentaire « RELATED: simplified — treat same as ESTABLISHED »).
- **Sévérité** : Mineure
- **Recommandation** : RAS à court terme ; à enrichir si des scénarios FTP/SIP avec connexions liées sont ajoutés au programme pédagogique.

---

## 9. Interpréteur PowerShell & sous-systèmes hôte Windows

L'ensemble PowerShell/Windows est dans un état de **migration architecturale active** : un ancien moteur monolithique texte (`PowerShellExecutor`, 6114 lignes) cohabite avec un nouvel interpréteur AST « propre » (`PSInterpreter`/`PSRuntime`/registre de cmdlets `ICmdlet`) qui passe de vrais objets dans le pipeline. Le nouvel interpréteur est étonnamment mature (try/catch/trap, scriptblocks, `$_`/`$PSItem`, splatting, `-ErrorAction`, fournisseurs de registre hiérarchiques), mais la coexistence des deux moteurs génère une duplication massive de logique cmdlet, des incohérences d'état (`$Error`), et une dette de migration explicitement documentée dans le code (« Phase 4 », « fallbackHits », commentaires « once every test path runs cleanly… this branch can be removed »). Le sous-système Windows est globalement moins profond et moins « cross-OS-aligné » que son pendant Linux.

### 9.1 Lexer / Parser
- **Constat** : Le lexer et le parser couvrent correctement la syntaxe PowerShell réelle : here-strings (`@'...'@`/`@"..."@`), splatting (`@var`), attributs `[CmdletBinding()]`, scriptblocks à blocs nommés `begin/process/end`. Cependant `[CmdletBinding()]` et les autres attributs de fonction sont uniquement *sautés* (non interprétés) — aucune sémantique `SupportsShouldProcess`, `ParameterSetName`, etc. n'est exploitée.
- **Preuve** : `src/powershell/parser/PSParser.ts:1160-1166` (`// Skip function-level attribute declarations like [CmdletBinding()] before param()` — `this.skipBracketAttribute()`).
- **Sévérité** : Mineure
- **Recommandation** : Documenter explicitement que les attributs avancés sont ignorés ; envisager de capter au moins `SupportsShouldProcess` pour activer `-WhatIf`/`-Confirm`.

### 9.2 Interpréteur / Runtime / Pipeline
- **Constat** : Le runtime gère correctement try/catch/trap, `$_`/`PSItem`, `$args`/`$input`, scriptblocks et closures (`GetNewClosure`). C'est un socle solide et largement supérieur au texte-brut attendu pour ce genre de simulateur.
- **Preuve** : `src/powershell/runtime/PSRuntime.ts:714` (`case 'TryStatement'`), `:923-949` (binding `$_`/`PSItem`), `:1015` (`invokeScriptBlock`).
- **Sévérité** : (positif — pas un défaut)

- **Constat** : Bug latent — `$Error` n'est alimenté que par les exceptions terminantes capturées dans `execTry` (`this.global.set('Error', ...)`), tandis que les erreurs *non terminantes* émises via `ctx.emitError()` sont accumulées dans un tableau séparé `self.errorObjects` jamais fusionné dans la variable globale `$Error`. Résultat : `Get-Item C:\NoExist -ErrorAction SilentlyContinue; $Error[0].Exception.Message` ne renvoie rien.
- **Preuve** : `src/powershell/runtime/PSRuntime.ts:1656` (`this.global.set('Error', [errRecord, ...errList])`) vs `:2376-2380` (`self.errorObjects.push({...})`, jamais reporté vers `global.Error`); test correspondant désactivé : `src/__tests__/unit/powershell/ps_machine_level.test.ts:748` (`it.skip('$Error contains last error after non‑terminating error'`).
- **Sévérité** : Majeure
- **Recommandation** : Fusionner `errorObjects` dans `global.Error` à chaque `emitError`, ou unifier les deux mécanismes derrière un seul accumulateur.

- **Constat** : `-ErrorAction Stop` n'est pas traité spécialement — il est simplement extrait des paramètres communs (`delete cmdletNamed['erroraction']`) sans jamais transformer une erreur non terminante en exception levée. Donc `try { Get-Content C:\ghost.txt -ErrorAction Stop } catch { ... }` ne peut pas fonctionner puisque le cmdlet appelle `ctx.emitError` (non bloquant) et retourne normalement.
- **Preuve** : `src/powershell/runtime/PSRuntime.ts:2259-2304` (aucune branche `errorAction === 'stop'`); test désactivé : `src/__tests__/unit/powershell/ps_machine_level.test.ts:756` (`it.skip('try/catch catches file not found and writes custom error'`).
- **Sévérité** : Majeure
- **Recommandation** : Quand `-ErrorAction Stop` est positionné, convertir le premier appel à `ctx.emitError` en exception `PSRuntimeError` propagée (sémantique « erreur terminante »).

- **Constat** : Le moteur de pipeline « legacy » est entièrement dupliqué : `src/network/devices/windows/PSPipeline.ts` réimplémente `Where-Object`/`Select-Object`/`Sort-Object`/`Measure-Object`/`Format-Table`/`Format-List` à coups de regex sur arguments-chaîne et de parsing de tables texte (`parseTable`), alors que la même fonctionnalité existe en version AST/objet propre dans `src/powershell/cmdlets/core/CollectionCmdlets.ts` (15 classes `ICmdlet`).
- **Preuve** : `src/network/devices/windows/PSPipeline.ts:254` (`whereObject`), `:580` (`formatTable`), `:40` (`parseTable` — reconstruit des objets à partir d'une table texte pré-formatée, signe d'un pipeline texte déguisé en « objet »); doublon AST : `src/powershell/cmdlets/core/CollectionCmdlets.ts:102,232,312,409,485,660,689` (`WhereObjectCmdlet`, `ForEachObjectCmdlet`, `SelectObjectCmdlet`, `SortObjectCmdlet`, `MeasureObjectCmdlet`, `FormatTableCmdlet`, `FormatListCmdlet`).
- **Sévérité** : Majeure
- **Recommandation** : Achever la migration vers `PSInterpreter`/`ICmdlet` et supprimer `PSPipeline.ts` ; le commentaire d'en-tête de `PowerShellSubShell.ts:27-33` indique d'ailleurs que c'est déjà l'intention déclarée (« once every test path runs cleanly through the interpreter this branch can be removed »).

### 9.3 Cmdlets
- **Constat** : Doublon direct entre l'ancien moteur et le nouveau pour `Get/Start/Stop/Restart/Suspend/Resume/New/Remove-Service` et `Get/Stop/Start-Process` : fonctions texte `psGetService`/`psStartService`/… dans `PSServiceCmdlets.ts` (appelées par `PowerShellExecutor`) vs classes `ICmdlet` (`GetServiceCmdlet`, etc.) dans `src/powershell/cmdlets/core/ServiceCmdlets.ts:118` et `ProcessCmdlets.ts`.
- **Preuve** : `src/network/devices/windows/PSServiceCmdlets.ts:29` (`export function psGetService`) vs `src/powershell/cmdlets/core/ServiceCmdlets.ts:118` (`export class GetServiceCmdlet implements ICmdlet`).
- **Sévérité** : Majeure
- **Recommandation** : Choisir un seul propriétaire de la logique (le registre `ICmdlet`) et faire de l'autre une simple délégation, ou supprimer complètement le doublon legacy.

- **Constat** : `Get-Process`/`Get-Service` dérivent bien leur sortie de l'état réel simulé (via `ctx.providers.processes`/`services`, eux-mêmes branchés sur `WindowsProcessManager`/`WindowsServiceManager`) — bon point MVC. Mais plusieurs fonctionnalités de cmdlets restent skippées/non implémentées : `Remove-LocalUser`, `Rename-LocalUser`, `Set-LocalUser -AccountDisabled`, politique de mot de passe faible, `Remove-LocalGroup`, environnement `Env:` (`Get-ChildItem Env:`, `[Environment]::SetEnvironmentVariable`), `Get-Content -Tail/-TotalCount`, `Copy-Item` cross-drive, toute la famille `Get/Set/Disable/Enable-NetAdapter`, `Get-NetIPAddress`, `Set-DnsClientServerAddress`, `Resolve-DnsName`.
- **Preuve** : `src/__tests__/unit/powershell/ps_machine_level.test.ts:261,295,307,318,342,472,487,503,604,652` et `src/__tests__/unit/powershell/ps-network-command.test.ts:49,63,77,102,119,127,146,161,169,181` (toutes en `it.skip`).
- **Sévérité** : Majeure
- **Recommandation** : Soit implémenter ces cmdlets côté `WindowsUserManager`/`WindowsPSProviders` (le provider réseau retourne déjà `notImpl()` pour beaucoup d'opérations, voir 9.4), soit retirer ces specs si la fonctionnalité n'est pas dans le périmètre du produit.

- **Constat** : `Get-Process : Remoting...` et `Get-Service : Remoting...` retournent des messages d'erreur PS authentiques formatés statiquement — c'est correct pour des opérations délibérément non supportées (CIM/remoting), mais à différencier des vraies lacunes.
- **Preuve** : `src/network/devices/windows/PSProcessCmdlets.ts:30`, `src/network/devices/windows/PSServiceCmdlets.ts:43`.
- **Sévérité** : (info, pas un défaut)

- **Constat** : `ipconfig /displaydns` retourne systématiquement un texte canné `"(no entries)"`, alors qu'aucun cache DNS réel n'est maintenu côté `WindowsPC` — `flushdns` ne fait donc rien de tangible non plus (pas de structure de données à vider).
- **Preuve** : `src/network/devices/windows/WinIpconfig.ts:88-90` (`if (lower.includes('/displaydns')) { return 'Windows IP Configuration\n\n  Record Name . . . . . : (no entries)'; }`); commentaire d'auto-aveu en en-tête `WinIpconfig.ts:10` (`ipconfig /displaydns — display DNS cache (stub)`).
- **Sévérité** : Mineure
- **Recommandation** : Soit implémenter un vrai cache DNS résolveur (alimenté par `Resolve-DnsName`/`nslookup`), soit documenter clairement que `/displaydns`/`/flushdns` sont des no-ops cosmétiques.

### 9.4 Fournisseurs (filesystem, registre, réseau)
- **Constat** : Le registre Windows (`PSRegistryProvider`) est une vraie arborescence hiérarchique (`Map<string, RegistryKey>` avec sous-clés et valeurs typées), pré-amorcée avec des chemins `HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion` réalistes — bonne profondeur de simulation, pas de structure plate cosmétique.
- **Preuve** : `src/network/devices/windows/PSRegistryProvider.ts:18-22` (`interface RegistryKey { subkeys: Map<...>; values: Map<...> }`), `:36-63` (amorçage `buildHKLM`).
- **Sévérité** : (positif)

- **Constat** : `WindowsPSProviders` (le fournisseur réseau de la nouvelle interpréteur) n'implémente qu'un sous-ensemble des opérations réseau ; les opérations manquantes lèvent `notImpl()`, message reconnu par `PowerShellSubShell.isFallbackError` pour retomber sur le moteur legacy — la migration est donc partielle et explicitement documentée comme telle.
- **Preuve** : `src/powershell/providers/WindowsPSProviders.ts:11-13` (« Network / event-log surfaces are partial… The rest throw `NotImplemented` »), `:790-791` (`setWinhttpProxy()`, `executeCmdCommand()` → `throw notImpl(...)`), `:805-808` (`function notImpl`).
- **Sévérité** : Majeure
- **Recommandation** : Achever la couverture du provider réseau pour pouvoir retirer le fallback vers `PowerShellExecutor` (cf. compteur `fallbackHits` ci-dessous).

- **Constat** : Le sous-shell expose un compteur public `fallbackHits` explicitement destiné à mesurer combien de commandes retombent encore sur l'ancien moteur — preuve que la migration est suivie/instrumentée mais pas terminée.
- **Preuve** : `src/terminal/subshells/PowerShellSubShell.ts:206,213,222` (`static fallbackHits = 0;` + commentaire « Debug counter — useful when assessing how much production code still reaches PowerShellExecutor »).
- **Sévérité** : Mineure (dette technique assumée)
- **Recommandation** : Faire de ce compteur un indicateur de CI (seuil maximal admissible) pour piloter l'achèvement de la migration.

### 9.5 Services Windows : EventLog / Services / PortProxy
- **Constat** : `Get-EventLog` (sans `-List`) délègue volontairement au moteur legacy pour conserver le formatage tabulaire existant — duplication consciente, documentée, mais qui maintient deux chemins de code pour la même fonctionnalité.
- **Preuve** : `src/powershell/cmdlets/core/EventLogCmdlets.ts:55-62` (`// Entry queries — defer to the legacy executor… We still own -List…`).
- **Sévérité** : Mineure
- **Recommandation** : Migrer le formatage de table vers le nouveau moteur (`Format-Table`/`OutputCmdlets`) pour éliminer la dépendance croisée.

- **Constat** : `WindowsSecurityAudit` est une bonne façade d'intention (« accountCreated » → ID d'événement Windows réel) qui alimente le journal Security partagé — bien conçu, cohérent avec `Get-EventLog`/`wevtutil`/Event Viewer.
- **Preuve** : `src/network/devices/windows/WindowsSecurityAudit.ts:8-13,27-44` (table `SECURITY_EVENT` avec IDs réels 4624/4720/4726…).
- **Sévérité** : (positif)

- **Constat** : `PortProxyTable`/`WindowsServicePortProjection` suivent le même patron réactif événementiel que les protocoles réseau documentés (publication sur l'`EventBus`, projections qui maintiennent la `SocketTable` cohérente) — bonne adhérence à l'architecture cible.
- **Preuve** : `src/network/devices/windows/PortProxyTable.ts:8-12`, `src/network/devices/windows/WindowsServicePortProjection.ts:9-12`.
- **Sévérité** : (positif)

### 9.6 Parité Linux / Windows
- **Constat** : `OSProcess`/`OSService`/`OSServiceOrchestrator`/`OSFeatureGate` (l'abstraction « cross-OS » censée être partagée) sont réellement utilisés côté Linux — `LinuxProcessManager`/`LinuxServiceManager` instancient `new LinuxProcess(...)`/`new LinuxService(...)` qui héritent de `OSProcess`/`OSService` — alors que côté Windows, `WindowsProcess`/`WindowsService` (sous-classes équivalentes de `OSProcess`/`OSService`) existent mais ne sont **jamais instanciées en production** : `WindowsProcessManager`/`WindowsServiceManager` produisent de simples objets-littéraux conformes à des interfaces plates. `OSServiceOrchestrator` n'est référencé que par son propre test.
- **Preuve** : Linux instancie : `src/network/devices/linux/LinuxProcessManager.ts:181,371` (`new LinuxProcess({...})`), `src/network/devices/linux/LinuxServiceManager.ts:599` (`new LinuxService({...})`). Windows n'instancie jamais : `grep "new WindowsProcess(" / "new WindowsService("` → 0 résultat en dehors des tests; production crée des littéraux : `src/network/devices/windows/WindowsProcessManager.ts:229-244` (`const proc: WindowsProcess = { pid, name, ... }`). `OSServiceOrchestrator` n'est utilisé que dans `src/__tests__/unit/network-v2/os-core.test.ts`.
- **Sévérité** : Majeure
- **Recommandation** : Soit câbler réellement `WindowsProcessManager`/`WindowsServiceManager` sur les classes `WindowsProcess`/`WindowsService` (et tirer parti de l'héritage `OSProcess`/`OSService` comme prévu dans leurs commentaires « Phase E surplus »), soit supprimer ces classes mortes pour éviter la confusion architecturale.

- **Constat** : `WinFeatureGate` est une réimplémentation Windows complètement indépendante de `OSFeatureGate` (pas d'héritage, pas de délégation), alors que ce dernier a explicitement été conçu comme abstraction cross-OS (« Rather than scattering ad-hoc checks… »). `OSFeatureGate` n'est utilisé que par `LinuxSshClient` — pas même par le reste de Linux.
- **Preuve** : `src/network/devices/windows/WinFeatureGate.ts:1-12` (aucune importation de `OSFeatureGate`, table `ERRORS` indépendante); `src/network/devices/os/OSFeatureGate.ts:1-22` (doc « Usage » qui cite explicitement `ipconfig`/`ssh`/`wevtutil`); seul utilisateur réel hors test : `src/network/devices/linux/network/LinuxSshClient.ts`.
- **Sévérité** : Mineure
- **Recommandation** : Soit refactoriser `WinFeatureGate` pour s'appuyer sur `OSFeatureGate.require(...)` (cohérence cross-OS et réduction de duplication), soit retirer `OSFeatureGate` de la couche `os/` s'il ne sert qu'à SSH Linux.

- **Constat** : La gestion des comptes utilisateurs est structurellement plus riche côté Linux (sous-répertoire `iam/` avec `LinuxUserAccount`, `useraddOptions`, `UseraddDefaults`, `adduserOptions`, `LinuxUserManagerAuthority`) que côté Windows (`WindowsUserManager.ts` plat, 495 lignes, sans hiérarchie de types ni politique modulaire) — les tests de gestion avancée des comptes Windows (`Set-LocalUser -AccountDisabled`, `Remove-LocalUser`, `Rename-LocalUser`, politique de mot de passe) sont d'ailleurs désactivés (cf. 9.3).
- **Preuve** : Linux : `src/network/devices/linux/iam/LinuxUserAccount.ts`, `useraddOptions.ts`, `fs/UseraddDefaults.ts`; Windows : `src/network/devices/windows/WindowsUserManager.ts:93` (`export class WindowsUserManager` — un seul fichier monolithique sans sous-modules).
- **Sévérité** : Mineure
- **Recommandation** : Étendre `WindowsUserManager` ou en extraire des sous-modules équivalents (`accounts/`, `policies/`) à mesure que les cmdlets `Local*User`/`Local*Group` skippées sont implémentées.

### 9.7 Architecture / dette technique générale
- **Constat** : `PowerShellExecutor.ts` (6114 lignes, ~177 méthodes) est un candidat évident à la classe-Dieu : il combine résolution de variables, mapping cmdlet→commande, formatage de pipeline, formatage d'erreurs PS, et est encore le point de chute de tout fallback de l'interpréteur. `WinNetsh.ts` (2912 lignes) suit le même schéma, bien que sa taille soit en partie justifiée par la richesse réelle de la commande `netsh` (de nombreux sous-contextes).
- **Preuve** : `src/network/devices/windows/PowerShellExecutor.ts:1-12` (description multi-responsabilités en en-tête); taille mesurée : 6114 lignes (`wc -l`).
- **Sévérité** : Majeure
- **Recommandation** : Poursuivre la migration vers `PSInterpreter`/`ICmdlet` pour réduire `PowerShellExecutor` à une simple coquille de compatibilité, puis le supprimer une fois `fallbackHits` proche de zéro.

---

*(Document en cours de rédaction — chaque section est ajoutée puis poussée séparément.)*

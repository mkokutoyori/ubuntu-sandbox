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

*(Document en cours de rédaction — chaque section est ajoutée puis poussée séparément.)*

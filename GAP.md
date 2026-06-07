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

*(Document en cours de rédaction — chaque section est ajoutée puis poussée séparément.)*

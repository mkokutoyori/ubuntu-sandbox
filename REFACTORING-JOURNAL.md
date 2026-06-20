# Journal de bord — Refactoring & conformité (focus PCs)

Ce journal documente les défaillances et limites corrigées lors de la campagne de
refactoring sur la plateforme de simulation. Chaque entrée correspond à un commit
poussé séparément. Objectif : des améliorations **structurelles** (design patterns,
déduplication, conformité aux RFC et au comportement des vrais équipements), pas
des patchs cosmétiques.

Périmètre prioritaire : les PCs (`EndHost`, `LinuxPC`/`LinuxMachine`, `WindowsPC`,
`LinuxServer`) et leurs sous-systèmes OS.

---

## Entrée n°1 — 2026-06-10 — Génération d'erreurs ICMP par les PCs (RFC 792 / 1122 / 1812)

### Défaillances constatées

1. **TTL expiré jeté en silence** — `EndHost.forwardIPv4()` (PC en mode passerelle,
   `net.ipv4.ip_forward=1`) jetait silencieusement les paquets dont le TTL expirait
   (`if (newTTL <= 0) return`). Conséquence concrète : un PC Linux faisant office de
   passerelle NAT était **invisible dans un traceroute**, contrairement à un vrai
   hôte Linux qui émet ICMP Time Exceeded (Type 11, Code 0) — RFC 792.
2. **Absence de route jetée en silence** — même chemin de code : aucun
   ICMP Destination Unreachable (Type 3, Code 0 — net unreachable) n'était émis,
   alors que le Router du simulateur le faisait déjà. Comportement asymétrique
   entre Router et PC pour la même fonction de forwarding.
3. **`sendICMPReject` défaillant à froid** — le reject du firewall (iptables
   `-j REJECT`) n'envoyait l'erreur ICMP que si le MAC de la source était déjà
   dans le cache ARP (`if (!targetMAC) return`), et la renvoyait aveuglément sur
   le port d'entrée au lieu de la router (violation RFC 1812 §4.3.2.7).
4. **Duplication Router/EndHost** — `Router.sendICMPError()` reconstruisait le
   paquet d'erreur à la main ; `EndHost.sendICMPReject()` aussi, différemment.
   Aucun des deux n'appliquait les garde-fous **RFC 1122 §3.2.2** (ne jamais
   émettre d'erreur ICMP en réponse à : une autre erreur ICMP, un fragment non
   initial, un paquet broadcast/multicast, une source non unicast) — risque de
   tempêtes d'erreurs ICMP dans les topologies bouclées.
5. **Taille d'erreur irréaliste** — les erreurs ICMP étaient émises avec un payload
   de 8 octets ; le format réel est 8 (en-tête ICMP) + 20 (en-tête IP original)
   + 8 (premiers octets du datagramme) = 36 octets, soit un total de 56 octets,
   la taille que rapporte un vrai `traceroute`.

### Correction (structurelle)

- **Nouveau module partagé** `src/network/core/IcmpErrors.ts` : constantes de codes
  ICMP nommées (fin des magic numbers `code: 13`), garde-fous `mayGenerateICMPError()`
  (RFC 1122 §3.2.2), constructeur `buildICMPError()` (taille conforme, MTU next-hop
  RFC 1191 §4 uniquement pour Frag-Needed).
- **`EndHost.sendICMPError()`** (nouvelle méthode `protected`) : route l'erreur via
  la table de routage (RFC 1812 §4.3.2.7), source l'erreur depuis l'IP de l'interface
  d'entrée, applique la chaîne OUTPUT du firewall, et résout l'ARP de façon asynchrone
  (file `fwdQueueAndResolve`) au lieu d'échouer à froid.
- `forwardIPv4()` émet désormais Time Exceeded (TTL) et Net Unreachable (pas de route).
- `sendICMPReject()` réduit à une délégation d'une ligne.
- `Router.sendICMPError()` refactorisé sur le module partagé + garde-fous RFC 1122
  (suppression de ~20 lignes dupliquées).

### Fichiers

- `src/network/core/IcmpErrors.ts` (nouveau)
- `src/network/devices/EndHost.ts`
- `src/network/devices/Router.ts`
- `src/__tests__/unit/network-v2/icmp-errors-endhost.test.ts` (nouveau, 14 tests)

### Validation

- 14 nouveaux tests (unitaires sur les garde-fous + intégration : PC passerelle
  visible dans traceroute, Time Exceeded sur `ping -t 1`, Net Unreachable sans route,
  forwarding nominal intact).
- Non-régression : 241 tests des suites traceroute/NAT/IPv4/ping/IPsec/ACL/SNMP/router.

---

## Entrée n°2 — 2026-06-10 — Host model IPv4 (weak/strong), loopback, et fuites de promesses

### Défaillances constatées

1. **Modèle de délivrance trop strict** — `EndHost.handleIPv4()` n'acceptait que les
   paquets destinés à l'IP **du port d'entrée**. Un PC multi-interfaces ne répondait
   donc jamais à un ping adressé à son autre interface. Or le vrai comportement
   dépend de l'OS (RFC 1122 §3.3.4.2) :
   - **Linux** : *weak host model* — répond pour n'importe quelle adresse locale ;
   - **Windows (Vista+)** : *strong host model* — uniquement l'adresse de
     l'interface d'entrée.
   La distinction n'était pas simulée du tout.
2. **Loopback inexistant** — `ping 127.0.0.1` échouait (« unreachable ») sur Linux
   comme sur Windows : aucun traitement du bloc 127.0.0.0/8 (RFC 1122 §3.2.1.3),
   ni dans la délivrance locale ni dans `executePingSequence`.
3. **Source de l'echo reply non conforme** — la réponse ICMP était toujours émise
   depuis l'IP du port de réception, alors que la RFC 1122 §3.2.2.6 impose de
   répondre depuis l'adresse à laquelle la requête était destinée.
4. **Rejets de promesses non observés** — dans `sendPing`/`executeTraceroute`
   (EndHost **et** Router), le perdant du `Promise.race(reply, failed)` expirait
   plus tard sans handler ; pire, un ping bloqué par le firewall OUTPUT levait
   une exception **avant** la course, abandonnant les deux waiters. Résultat :
   des `WaitForEventTimeoutError` « unhandled » polluant tous les runs de tests.

### Correction (structurelle)

- Nouveau champ `EndHost.hostModel: 'weak' | 'strong'` + `isLocalDestination()` /
  `getPortOwningIP()`. Linux reste en `weak` (défaut), `WindowsPC` passe en
  `strong` dans son constructeur — la différence Linux/Windows est maintenant
  fidèle à la réalité et testée.
- `IPAddress.isLoopback()` (127/8) dans le module core ; délivrance locale du
  loopback dans `handleIPv4` et court-circuit local dans `executePingSequence`
  (helper `localEchoResults()`, déduplication du bloc self-ping).
- `sendEchoReply()` répond depuis l'adresse demandée quand elle nous appartient
  (weak host inclus), repli sur l'IP du port pour les broadcasts.
- Observation systématique des rejets des promesses de course (création +
  outcomes) dans EndHost (`sendPing`, `sendPing6`, `executeTraceroute`) et
  Router (`_sendPing`, traceroute).

### Fichiers

- `src/network/core/types.ts` (`IPAddress.isLoopback`)
- `src/network/devices/EndHost.ts`
- `src/network/devices/WindowsPC.ts` (strong host model)
- `src/network/devices/Router.ts` (observation des rejets)
- `src/__tests__/unit/network-v2/host-model-loopback.test.ts` (nouveau, 9 tests)

### Validation

- 9 nouveaux tests : weak host Linux (réponse depuis l'adresse demandée),
  strong host Windows (pas de réponse cross-interface), loopback 127/8 sur les
  deux OS, self-ping.
- Suite complète `network-v2` : 253 fichiers, 6587 tests verts.
- Les 2 « unhandled errors » de `linux-iptables.test.ts` ont disparu.

---

## Entrée n°3 — 2026-06-10 — Couche transport UDP des PCs (RFC 768 / 1122)

### Défaillances constatées

1. **Aucune couche UDP sur les hôtes** — `EndHost.handleIPv4()` ne délivrait que
   l'ICMP et le TCP. Tout datagramme UDP adressé à un PC était jeté en silence :
   pas de remise à un service local, pas d'ICMP Port Unreachable (Type 3, Code 3)
   pour les ports fermés — alors que la RFC 1122 §4.1.3.1 l'exige et que c'est le
   mécanisme sur lequel repose le traceroute UDP de Linux.
2. **Plans de contrôle hors-bande** — conséquence directe : DNS et DHCP « trichent »
   en appelant directement les objets serveurs via le registre d'équipements
   (`findDnsServerByIP`, `autoDiscoverDHCPServers`) au lieu d'échanger des paquets.
   Un serveur DNS injoignable (câble débranché, firewall UDP/53) répond quand même.
   La couche UDP introduite ici est le prérequis pour migrer ces protocoles sur
   le réseau simulé (entrées suivantes).
3. **Asymétrie avec les routeurs** — les routeurs disposent d'agents UDP réels
   (SNMP, NTP, RADIUS, syslog, RIP…) mais leur dispatch est une chaîne de `if`
   dupliquée entre `CiscoRouter` et `HuaweiRouter` ; les PCs n'avaient rien.

### Correction (structurelle)

- API socket UDP sur `EndHost` (héritée par tous les PCs/serveurs) :
  `udpBind(port, listener)` / `udpClose(port)` / `sendUdpDatagram(...)` + types
  publics `UdpDelivery`/`UdpListener`.
- **Intégration `SocketTable`** : chaque bind est enregistré (visible dans
  `netstat -uln`/`ss`), EADDRINUSE levé sur double bind (Fail Fast), libération
  sur `udpClose`.
- **Délivrance** : dispatch vers le listener lié ; sinon ICMP Port Unreachable
  via l'infrastructure de l'entrée n°1 (garde-fous RFC 1122 inclus, jamais pour
  un broadcast).
- **Émission** : routage via la table de l'hôte, chaîne OUTPUT du firewall,
  résolution ARP asynchrone à froid, délivrance locale immédiate pour 127/8 et
  les adresses possédées (comme un vrai kernel, sans toucher le câble).

### Fichiers

- `src/network/devices/EndHost.ts`
- `src/__tests__/unit/network-v2/udp-transport-endhost.test.ts` (nouveau, 9 tests)

### Validation

- 9 nouveaux tests : délivrance, échange requête/réponse (echo RFC 862),
  loopback local, absence de route, Port Unreachable sur port fermé, silence
  une fois le port lié, EADDRINUSE, re-bind après close, visibilité netstat.
- Suite complète `network-v2` : 254 fichiers, 6596 tests verts, 0 erreur.

---

## Entrée n°4 — 2026-06-10 — Sauvegarde/chargement : la config L3 des PCs n'était pas persistée (UI)

### Défaillances constatées

1. **Perte de configuration au round-trip** — `topologySerializer.ts` n'exportait
   que la position, le nom, l'état d'alimentation et les couples IP/masque des
   ports. La **passerelle par défaut** et les **routes statiques** (configurées
   via `ip route add`, la conf routeur, etc.) disparaissaient à chaque
   sauvegarde/chargement : l'utilisateur rechargeait un lab dont la connectivité
   inter-subnets était silencieusement cassée.
2. Aucun test n'existait sur le sérialiseur (zéro filet de sécurité sur la
   fonctionnalité « Save/Load » de l'UI).

### Correction (structurelle)

- Schéma d'export enrichi de champs **optionnels** (`defaultGateway`,
  `staticRoutes[{network, mask, nextHop, metric}]`) — compatibilité ascendante
  totale : les anciens fichiers `.topology.json` se chargent toujours.
- Export : extraction des routes `type === 'static'` via l'API publique commune
  d'`EndHost` **et** de `Router` (une seule branche, pas de duplication).
- Import : restauration **après** l'adressage des interfaces (car
  `addStaticRoute()` valide la joignabilité du next-hop), avec tolérance aux
  fichiers corrompus (entrée malformée ignorée, l'import n'échoue pas en bloc).

### Limites connues (à traiter dans de prochaines entrées)

- L'état DHCP client (interfaces en bail), les fichiers du VFS Linux
  (`/etc/hosts` édités, scripts), les services systemd démarrés et le registre
  Windows ne sont toujours pas persistés.

### Fichiers

- `src/store/topologySerializer.ts`
- `src/__tests__/unit/gui/topology-serializer.test.ts` (nouveau, 6 tests)

### Validation

- 6 nouveaux tests : round-trip gateway/routes PC (métrique incluse), routes
  statiques routeur, pas de duplication des routes connectées, import de
  fichiers legacy sans les nouveaux champs, tolérance aux valeurs malformées.
- Suites `unit/gui` + `unit/react` : 11 fichiers, 94 tests verts.

---

## Entrée n°5 — 2026-06-10 — La résolution DNS passe désormais par le réseau simulé (UDP/53)

### Défaillances constatées

1. **DNS hors-bande** — la résolution de noms (`ping <hostname>`,
   `traceroute <hostname>`) localisait le serveur DNS via le **registre
   d'équipements** (`findDnsServerByIP`) et appelait sa méthode `query()`
   directement, sans jamais émettre de paquet. Conséquences irréalistes :
   un serveur DNS **au câble débranché**, **sans route**, ou **protégé par un
   firewall droppant UDP/53** répondait quand même ; aucun trafic DNS n'était
   visible dans les logs réseau ni l'animation de paquets ; les règles
   iptables sur le port 53 étaient sans effet.
2. **Port 53 fantôme** — chaque machine Linux pré-liait `udp/53`
   (`systemd-resolved` sur 127.0.0.53) dans la `SocketTable` à des fins
   d'affichage netstat, sans aucun service réel derrière.

### Correction (structurelle)

- **Messages DNS filaires** (`DnsWire.ts`) : `DnsWireQuery`/`DnsWireResponse`
  avec id de transaction 16 bits, rcodes RFC 1035 (NOERROR/NXDOMAIN/...),
  type guards, estimation de taille on-wire.
- **Côté serveur** : `DnsService` expose des hooks `onStart`/`onStop`
  (Observer) ; `LinuxMachine` y attache le bind/unbind de l'UDP 53 via la
  couche socket de l'entrée n°3 (le stub systemd-resolved est supplanté au
  démarrage de dnsmasq, comme sur un vrai Ubuntu). Les réponses repartent en
  datagrammes UDP vers le port source du client.
- **Côté client** : `LinuxMachine.queryDnsServer()` — port éphémère, requête
  UDP/53 routée (firewall OUTPUT, ARP), corrélation par id de transaction,
  **timeout réel** si le serveur est injoignable.
- **`resolveHostname` devient asynchrone** (interface `LinuxNetKernel`) :
  IP littérale → `/etc/hosts` (lu à chaud) → requête DNS sur le câble.
  `ping`/`traceroute` mis à jour. Le chemin legacy `findDnsServerByIP` ne
  subsiste que pour `dig`/`nslookup`/`host` (migration prévue en entrée
  suivante).

### Fichiers

- `src/network/devices/linux/DnsWire.ts` (nouveau)
- `src/network/devices/linux/LinuxDnsService.ts` (hooks lifecycle)
- `src/network/devices/LinuxMachine.ts` (serveur + client + résolution async)
- `src/network/devices/linux/LinuxNetKernel.ts` (contrat async)
- `src/network/devices/linux/commands/net/{Ping,Traceroute}.ts`
- `src/__tests__/unit/network-v2/dns-over-wire.test.ts` (nouveau, 8 tests)

### Validation

- 8 nouveaux tests : résolution nominale sur le câble, bind/libération du
  port 53 au start/stop de dnsmasq, NOERROR/NXDOMAIN, et **réalisme des
  pannes** : câble débranché, firewall DROP sur UDP/53, service arrêté,
  serveur inexistant → « Name or service not known ».
- Suites hosts/nslookup/DHCP/SFTP : 378 tests verts ; régression complète
  `network-v2` : 255 fichiers, 6604 tests verts, 0 erreur.

---

## Entrée n°6 — 2026-06-10 — dig/nslookup/host sur le câble ; client DNS partagé Linux/Windows

### Défaillances constatées

1. **Dernier chemin DNS hors-bande** — `dig`, `nslookup` et `host`
   continuaient d'interroger le serveur DNS par appel direct
   (`findDnsServerByIP` + `query()`), donc insensibles aux pannes réseau —
   y compris le `nslookup` de Windows qui réutilisait la même fonction.
2. **Mauvaise localisation du code** — le format de message DNS et le type
   `DnsRecord` vivaient dans `devices/linux/`, alors que le protocole est
   agnostique de l'OS (les conventions du projet placent chaque protocole
   dans son répertoire `src/network/<proto>/`).
3. **Client DNS dupliqué en puissance** — le client filaire (entrée n°5)
   était sur `LinuxMachine`, inaccessible à `WindowsPC` qui en aurait eu
   besoin pour son propre résolveur : la duplication était inévitable à terme.

### Correction (structurelle)

- **`src/network/dns/DnsWire.ts`** (déplacement + extension) : le module
  protocolaire possède désormais `DnsRecord` (ré-exporté par
  `LinuxDnsService` pour compatibilité), les messages filaires, et le type
  `DnsQueryFn` — contrat de transport injecté dans les outils clients
  (Stratégie/DI : les fonctions `executeDig/Nslookup/Host` restent pures et
  testables sans équipement).
- **`EndHost.queryDnsServer()`** — le client DNS asynchrone remonte dans la
  classe de base : partagé par tous les hôtes (Linux **et** Windows), un
  seul code de corrélation id/timeout.
- `dig`/`nslookup`/`host` (Linux) passent par `ctx.net.queryDns(...)`
  (nouveau membre du contrat `LinuxNetKernel`) ; le `nslookup` de Windows
  passe par `this.queryDnsServer(...)` — et sort du chemin de dispatch
  synchrone (comme `ping`/`tracert`), fallback documenté vers
  `executeCmdCommand`.
- Le rcode est calculé côté serveur (`NXDOMAIN` seulement si le domaine est
  totalement inconnu — un domaine connu sans enregistrement du type demandé
  répond `NOERROR` avec zéro réponse, comme un vrai serveur autoritaire).

### Fichiers

- `src/network/dns/DnsWire.ts` (déplacé depuis `devices/linux/`, + `DnsRecord`, `DnsQueryFn`)
- `src/network/devices/EndHost.ts` (client DNS partagé)
- `src/network/devices/LinuxMachine.ts` (serveur + rcode autoritaire, netkernel `queryDns`)
- `src/network/devices/linux/LinuxDnsService.ts` (outils clients async + transport injecté)
- `src/network/devices/linux/LinuxNetKernel.ts`, `commands/dns/{Dig,Nslookup,Host}.ts`
- `src/network/devices/WindowsPC.ts` (nslookup filaire)
- `src/__tests__/unit/network-v2/dns-over-wire.test.ts` (+6 tests)

### Validation

- 14 tests dns-over-wire (dont dig +short/full, timeout dig câble débranché,
  nslookup timeout service arrêté, host NXDOMAIN, nslookup Windows filaire).
- Suites nslookup/hosts/windows-netsh-dhcp-dns : 113 tests verts ;
  régression complète `network-v2` : 255 fichiers, 6610 tests verts.

---

## Entrée n°7 — 2026-06-10 — Résolveur Windows sur le câble ; suppression du dernier chemin DNS hors-bande

### Défaillances constatées

1. **Résolveur Windows hors-bande** — `WindowsPC.resolveHostname()` (utilisé
   par `ping` et `tracert` par nom d'hôte) interrogeait encore les serveurs
   DNS configurés via `findDnsServerByIP` (recherche dans le registre
   d'équipements + appel direct), donc insensible aux pannes réseau —
   asymétrique avec Linux depuis l'entrée n°5.
2. **Code mort en devenir** — après les entrées n°5 et 6, `findDnsServerByIP`
   n'avait plus que ce seul consommateur ; l'en-tête de `LinuxDnsService`
   documentait encore l'ancien contournement.

### Correction (structurelle)

- `WindowsPC.resolveHostname()` devient asynchrone : IP littérale → fichier
  hosts → nom de la machine → requêtes UDP/53 réelles via le client partagé
  `EndHost.queryDnsServer()` (entrée n°6), serveur par serveur.
- Contrat `WinCommandContext.resolveHostname` asynchrone ; `ping`/`tracert`
  Windows mis à jour (`await`).
- **Suppression de `findDnsServerByIP`** et de l'import `Equipment` :
  plus aucun chemin DNS ne contourne le réseau simulé, sur aucun OS.
- Tests HF-04/05/06 adaptés au contrat asynchrone (comportement inchangé).

### Fichiers

- `src/network/devices/WindowsPC.ts`
- `src/network/devices/windows/WinCommandExecutor.ts` (contrat)
- `src/network/devices/windows/{WinPing,WinTracert}.ts`
- `src/network/devices/linux/LinuxDnsService.ts` (code mort supprimé)
- `src/__tests__/unit/network-v2/hosts-file.test.ts` (adaptation async)

### Validation

- Suites hosts-file/hosts/dns-over-wire/traceroute-conformance/
  windows-netsh-dhcp-dns/nslookup : 153 tests verts ; `tsc --noEmit` propre ;
  régression complète `network-v2` : 255 fichiers, 6610 tests verts.

---

## Entrée n°8 — 2026-06-10 — UI : divulgation des équipements partiellement simulés

### Défaillances constatées

1. **Stubs présentés comme des équipements réels** — la palette propose un
   « Mac » (macOS workstation), trois firewalls (Cisco ASA, FortiGate,
   Palo Alto) et un point d'accès WiFi avec descriptions professionnelles et
   icônes vendeur convaincantes… alors que `DeviceFactory` les instancie
   comme `LinuxPC` (Ubuntu !) ou `Hub`. L'utilisateur ne le découvrait
   qu'après avoir câblé son lab (avertissement uniquement dans le panneau de
   propriétés, après sélection).
2. **Classification erronée** — `isFullyImplemented('mac-pc')` retournait
   `true` alors que la machine exécute un Ubuntu complet sous une icône
   macOS (terminal bash, identité Linux, `uname` → Linux). Vérifié sans
   impact sur l'ouverture du terminal (l'OS mappé est `linux`, le garde du
   `TerminalManager` ne concerne que les OS inconnus).

### Correction

- `isFullyImplemented()` reclassifie `mac-pc` comme simulation partielle et
  documente le contrat de la fonction (JSDoc).
- `DevicePalette` : badge **« Limited »** (ambre, tooltip explicatif) sur
  chaque type non fidèlement simulé, dès la palette — avant le drag, pas
  après. Réutilisation de la fonction backend existante (pas de duplication
  de la liste).

### Défaut préexistant relevé (à corriger en entrée suivante)

- `duplicate-display-fixes.test.ts` (« sudo prompt is not duplicated »)
  échoue **déjà sur `main`** : l'écho du prompt sudo n'apparaît plus dans le
  scrollback. Sans lien avec les entrées de ce journal (vérifié sur worktree
  `main` propre).

### Fichiers

- `src/network/devices/DeviceFactory.ts`
- `src/components/network/DevicePalette.tsx`
- `src/__tests__/unit/gui/device-palette.test.tsx` (nouveau, 5 tests)

### Validation

- 5 nouveaux tests (badges palette + classification) ; suites `unit/gui` +
  `unit/react` : 12 fichiers, 99 tests verts.

---

## Entrée n°9 — 2026-06-11 — RIP `passive-interface` : config acceptée mais jamais appliquée

> Début de la campagne « protocoles réseau ». Trois audits structurels ont été
> menés (routage dynamique, L2/commutation, DHCP/ARP/FHRP/NAT) ; les entrées
> suivantes traitent les constats par ordre d'impact.

### Défaillances constatées

1. **`passive-interface` (Cisco) sans aucun effet sur RIP** — la commande
   `passive-interface Gi0/0` sous `router rip` n'écrivait que dans
   `RoutingConfigRepository` (utilisé par `show running-config`). Le moteur
   `RIPEngine` n'avait **aucun concept d'interface passive** : les updates
   périodiques, triggered et les réponses aux Requests continuaient de sortir
   sur l'interface « passive ». Config de façade, comportement réel absent.
2. **`silent-interface` (Huawei VRP) idem** — stocké dans `_huaweiRipExtras`
   (projection `display`/config) sans jamais atteindre le moteur.
3. **`no passive-interface` ignorait l'EIGRP** — le handler ne traitait que le
   repo RIP ; impossible de réactiver une interface EIGRP passive via CLI.
4. **Pas de résolution des noms d'interface** — `passive-interface gi0/0`
   (abréviation IOS standard) stockait la chaîne brute, qui ne matchait jamais
   les noms canoniques des ports (le handler OSPF, lui, résolvait déjà via
   `ctx.resolveInterfaceName`). Même demi-câblage côté EIGRP.
5. **VRP : `rip` sans numéro de process n'entrait pas dans la vue RIP** — sur
   un vrai VRP, `rip` entre dans `[hostname-rip-1]` (process 1 implicite) ;
   le simulateur ne le faisait que pour `rip <n>`, rendant inaccessibles les
   commandes de la vue RIP (dont `silent-interface`).

### Correction (structurelle)

- **`RIPEngine`** : nouveau champ `passiveInterfaces: Set<string>` dans
  `RIPConfig` + API `setPassiveInterface()` / `removePassiveInterface()` /
  `isPassiveInterface()` (même contrat que l'OSPFEngine — cohérence des
  moteurs). Sémantique IOS/VRP fidèle : l'interface n'émet **rien** (pas de
  Request au démarrage, pas d'update périodique/triggered, pas de réponse aux
  Requests reçues) mais **continue d'apprendre** les routes des Responses
  reçues.
- **`RouterRIPEngine` + `Router`** : pass-through et façade
  (`ripSetPassiveInterface`/`ripRemovePassiveInterface`).
- **CLI Cisco** (`CiscoRoutingProtoCommands`) : helper unique `setPassive()`
  (RIP + EIGRP, repo + moteur — fini le double câblage divergent),
  résolution canonique via `ctx.resolveInterfaceName` (abréviations `gi0/0`),
  support de `passive-interface default` / `no passive-interface default`
  appliqué à tous les ports, `% Invalid interface` sur nom inconnu.
- **CLI Huawei** (`HuaweiVRPShell`) : `silent-interface`/`undo
  silent-interface` plombés jusqu'au moteur, avec résolution
  insensible à la casse/aux espaces contre les ports réels.
- **CLI Huawei** (`HuaweiConfigCommands`) : `rip` sans argument entre
  désormais dans la vue RIP, comme un vrai VRP.

### Fichiers

- `src/network/rip/RIPEngine.ts`
- `src/network/devices/router/RouterRIPEngine.ts`
- `src/network/devices/Router.ts`
- `src/network/devices/shells/cisco/CiscoRoutingProtoCommands.ts`
- `src/network/devices/shells/HuaweiVRPShell.ts`
- `src/network/devices/shells/huawei/HuaweiConfigCommands.ts`
- `src/__tests__/unit/network-v2/rip.test.ts` (+6 tests, groupe « Passive interfaces »)

### Validation

- 6 nouveaux tests : silence émission + apprentissage conservé, non-réponse aux
  Requests, reprise via `no passive-interface`, résolution d'abréviations CLI,
  `passive-interface default`, `silent-interface` VRP.
- Suite complète `unit/network-v2` : **287 fichiers, 6873 tests verts**.

---

## Entrée n°10 — 2026-06-11 — FHRP (HSRP/VRRP/GLBP) : un control plane sans data plane

### Défaillances constatées

1. **La VIP était injoignable** — les agents HSRP/VRRP/GLBP géraient l'élection
   (hellos, états, priorités, preempt) mais **aucun routeur ne répondait à
   l'ARP pour l'adresse virtuelle**. Un PC configuré avec la VIP comme
   passerelle par défaut ne pouvait jamais la résoudre : le FHRP était du
   théâtre de control plane. Les helpers `hsrpVirtualMac`/`vrrpVirtualMac`
   n'étaient utilisés que par `show standby` (affichage).
2. **Trames vers MAC virtuelle jetées** — le filtre L2 de `Router.handleFrame`
   n'acceptait que la MAC du port, broadcast et multicast : même avec une
   entrée ARP statique vers la MAC virtuelle, le routeur actif jetait les
   trames qui lui étaient adressées.
3. **Ping de la VIP impossible** — `processIPv4` ne considérait que les IP
   d'interface pour la livraison locale.
4. **Pas d'ARP gratuit au basculement** (RFC 5798 §6.4.1) — le nouveau master
   n'annonçait pas la MAC virtuelle, laissant les tables CAM des commutateurs
   pointer vers le routeur mort.
5. **GLBP : le load balancing ne tournait jamais** — du point de vue de l'AVG,
   l'AVF d'un pair restait `listen` pour toujours (seul le propriétaire
   marquait son AVF `active` à la réception de l'assignation). La sélection
   round-robin/weighted/host-dependent (`nextForwarderMacForClient`) existait
   mais ne servait qu'une seule MAC — et n'était appelée **que par les tests**.

### Correction (structurelle)

- **`fhrp/types.ts`** : nouvelle interface `FhrpDataPlane` (`vipArpOwner`,
  `ownsVirtualMac`, `ownsVip`) + `normalizeVirtualMac()` (le format pointé
  Cisco `0000.0c07.ac01` et le format `aa:bb:…` convergent).
- **`FhrpAgentBase`** implémente `FhrpDataPlane` une seule fois (Template
  Method, cohérent avec le reste de la famille) via trois hooks protocole :
  `vipArpMac(g, requesterIp)`, `ownedVirtualMacs(g)`, `isVipOwner(g)` ;
  + helper partagé `gratuitousVipArp()` (GARP émis depuis la MAC virtuelle).
- **HSRP** (RFC 2281 §5.3) : seul l'actif répond/possède, GARP en passant
  actif. **VRRP** (RFC 5798 §8.1.2, §6.4.1) : idem pour le master, MAC
  `00-00-5E-00-01-{VRID}`. **GLBP** : l'AVG répond à l'ARP en distribuant les
  MAC d'AVF selon le mode de load balancing (curseur avancé une seule fois
  par requête) ; chaque AVF n'accepte que sa propre MAC virtuelle. Pas de
  GARP par AVF (il écraserait la répartition dans les caches des hôtes).
- **`Router`** : point d'extension `fhrpDataPlanes()` (vide en base,
  surchargé par `CiscoRouter` [HSRP+VRRP+GLBP] et `HuaweiRouter` [VRRP]) ;
  filtre L2 élargi aux MAC virtuelles détenues ; réponse ARP pour la VIP
  sourcée de la MAC virtuelle (jamais en réponse à un ARP gratuit) ;
  livraison locale des paquets destinés à une VIP détenue.
- **GLBP** : un AVF assigné à un propriétaire dont on vient d'entendre le
  hello démarre `active` (il est vivant) ; un hello reçu ressuscite un AVF
  `init` après expiration — le failback fonctionne.

### Fichiers

- `src/network/fhrp/types.ts`, `src/network/fhrp/FhrpAgentBase.ts`
- `src/network/hsrp/HsrpAgent.ts`, `src/network/vrrp/VrrpAgent.ts`,
  `src/network/glbp/GlbpAgent.ts`
- `src/network/devices/Router.ts`, `CiscoRouter.ts`, `HuaweiRouter.ts`
- `src/__tests__/unit/network-v2/fhrp-dataplane.test.ts` (nouveau, 7 tests)

### Validation

- 7 nouveaux tests de bout en bout : ping de la VIP (la table ARP du PC
  contient bien `0000.0c07.ac01` / `00:00:5e:00:01:05`, pas la MAC du port),
  silence du standby, routage via la MAC virtuelle (VIP passerelle), failover
  réel (shutdown de l'actif → hold time → le standby sert la VIP, CAM
  re-pointée par le GARP), rotation round-robin GLBP, isolation des MAC
  d'AVF.
- Suite complète `unit/network-v2` : **288 fichiers, 6880 tests verts**.

### Défaut préexistant relevé (entrée future)

- HSRP : l'opcode `resign` est traité en réception mais jamais émis
  (`advertise` n'envoie que des hellos). Un vrai IOS envoie un resign quand
  l'actif abandonne son rôle administrativement.

---

## Entrée n°11 — 2026-06-11 — STP : les Topology Change Notifications jetées en silence (802.1D §8.6.14)

### Défaillances constatées

1. **BPDU TCN ignorés** — `StpAgent.handleFrame` filtrait
   `bpduType !== 'config'` : un TCN reçu était jeté sans traitement, alors que
   le type existait dans le vocabulaire (`StpBpduType = 'config' | 'tcn'`).
2. **Flags TC/TCA câblés à `false`** — `sendBpdu` n'émettait jamais ni le
   Topology Change flag ni le Topology Change Acknowledgment : la machinerie
   de propagation (TCN → racine → TC broadcast) n'existait pas.
3. **Pas de fast aging** — après une reconvergence, les tables MAC gardaient
   leur vieillissement de 300 s : les chemins morts persistaient plusieurs
   minutes (un vrai pont passe à `forward delay` = 15 s pendant le TC,
   802.1D §8.3.5).
4. **Aucune détection** — ni la perte d'un port actif ni le passage d'un port
   en forwarding ne déclenchaient quoi que ce soit.
5. **BPDU Guard partiel** — la garde ne se déclenchait que sur les BPDU
   config ; un TCN sur un port PortFast+bpduguard n'err-disablait pas le
   port (un vrai IOS le fait sur tout BPDU).
6. **Latent** — champ `this.scheduler` assigné mais jamais déclaré dans
   `StpAgent` (erreur de type masquée car vitest ne typecheck pas).

### Correction (structurelle)

- **Détection** (§8.5.3.12) : perte d'un port actif (forwarding/learning,
  non-PortFast) et passage en forwarding d'un port géré non-edge →
  `notifyTopologyChange()`. Le bring-up initial (chemin rapide type RSTP
  existant) reste silencieux, cohérent avec le design du simulateur.
- **Notification** : un pont non-racine émet des TCN sur son root port à
  chaque hello jusqu'à réception d'un TCA (timer nommé `tcn` sur la
  machinerie `ReactiveAgentBase` existante).
- **Acquittement + propagation** : le pont désigné qui reçoit un TCN répond
  immédiatement (TCA one-shot via `pendingTcAck`) et relaie vers la racine.
- **tcWhile** : la racine émet TC=1 pendant `max age + forward delay`
  (timer), diffusé immédiatement puis à chaque hello.
- **Fast aging** : tout pont voyant TC=1 sur son root port (et la racine
  elle-même) raccourcit le vieillissement MAC à `forward delay` via le
  nouveau hook `StpHost.onTopologyChangeAging` ; restauration sur TC=0.
  Côté `Switch` : `_setStpFastAging()` + `effectiveMacAgingTime()` dans le
  balayage existant (pas de second timer).
- **BPDU Guard** déplacé avant le dispatch par type : déclenche sur tout BPDU.
- Événements : `stp.tcn.sent`, `stp.tcn.received`,
  `stp.topology-change.detected` + getters `isTopologyChangeActive()` /
  `isFastAgingActive()`.

### Fichiers

- `src/network/stp/StpAgent.ts`
- `src/network/devices/Switch.ts`, `CiscoSwitch.ts`, `HuaweiSwitch.ts`
- `src/__tests__/unit/network-v2/stp-tcn.test.ts` (nouveau, 6 tests)

### Validation

- 6 nouveaux tests : TCN émis vers la racine + ack synchrone (une seule
  émission), TC + fast aging sur toute la chaîne, expiration tcWhile
  (35 s) → retour au vieillissement normal, flush réel d'une entrée MAC
  dynamique à 15 s, PortFast silencieux vs port normal (contraste).
- Suite complète `unit/network-v2` : **289 fichiers, 6886 tests verts**.

---

## Entrée n°12 — 2026-06-11 — Commutation : flush MAC au link-down ; HSRP : resign jamais émis

### Défaillances constatées

1. **Entrées MAC fantômes après une coupure** — quand un port tombait, ses
   entrées dynamiques restaient dans la table jusqu'à 300 s (balayage de
   vieillissement) : le commutateur continuait d'envoyer des trames vers un
   port mort. Un vrai commutateur purge immédiatement les entrées du port.
2. **Test encodant le bug** — `huawei-vrp.test.ts` (« MAC move ») validait
   qu'un swap de câble incrémentait le compteur de MAC move ; sur du vrai
   matériel, un swap propre = link-down → flush → re-apprentissage (pas un
   move). Les alarmes de MAC flapping ne comptent que les MAC alternant
   entre deux ports **vivants** (boucle/usurpation).
3. **HSRP : resign en réception seulement** — relevé à l'entrée n°10 :
   `advertise()` n'émettait que des hellos. Un actif perdant l'élection
   (preempt d'un pair, baisse de priorité) restait silencieux : le pair
   devait attendre le hold timer au lieu de basculer immédiatement
   (RFC 2281 §5.4.3).

### Correction

- **`Switch`** : `flushDynamicMacsOnPort()` raccordé au handler
  `port.onLinkChange` existant (indépendant du bus → insensible au rebind) ;
  événement `switch.mac.flushed` publié. Les entrées statiques et les autres
  ports ne sont pas touchés.
- **`HsrpAgent`** : `advertise()` refactorisé en `emit(g, opcode)` ;
  `sendResign()` émis (1) sur transition active→non-active avec lien vivant
  (perte d'élection), (2) avant suppression administrative d'un groupe actif
  (`removeGroup` surchargé). Le resign est edge-triggered et part souvent
  dans la cascade synchrone de réception où la garde anti-réentrance est
  tenue : il est envoyé hors garde, sans risque de boucle.
- Test MAC-move réécrit pour simuler un vrai flap (même MAC émise sur deux
  ports vivants).

### Fichiers

- `src/network/devices/Switch.ts`
- `src/network/hsrp/HsrpAgent.ts`
- `src/__tests__/unit/network-v2/ping-through-switch.test.ts` (+1 test)
- `src/__tests__/unit/network-v2/fhrp-dataplane.test.ts` (+1 test resign)
- `src/__tests__/unit/network-v2/huawei-vrp.test.ts` (test corrigé)

### Validation

- Flush : les MAC du port mort disparaissent à l'instant du débranchement,
  celles du port survivant restent. Resign : l'actif rétrogradé émet un
  resign observé sur le bus et le pair preemptant devient actif sans
  attendre le hold timer.
- Suite complète `unit/network-v2` : **289 fichiers, 6888 tests verts**.

### Note

- `ospf-packet-exchange.test.ts` (8.4) s'est montré flaky une fois sous
  charge (ExStart au lieu de Full) puis vert en isolation et au run
  suivant — sensibilité au timing préexistante, sans lien avec ces
  changements.

---

## Entrée n°13 — 2026-06-11 — HSRP : preempt ignoré et démarrage sans phase d'écoute

### Défaillances constatées

1. **`standby preempt` sans effet** — `HsrpAgent.recompute` prenait le rôle
   actif dès que sa priorité battait celle de l'actif en place, sans
   consulter `g.preempt`. Sur un vrai IOS, la préemption est **désactivée
   par défaut** : sans elle, un routeur prioritaire n'évince jamais un
   actif vivant — il attend sa mort.
2. **Pas de phase Listen/Learn** — un groupe fraîchement configuré
   revendiquait `active` immédiatement (avant d'avoir écouté le segment),
   et le récepteur adoptait **inconditionnellement** toute revendication
   active. Conséquence : le dernier routeur configuré détrônait
   systématiquement l'incumbent, preempt ou pas — l'inverse du vrai HSRP.
3. **Collision active/active mal résolue** — RFC 2281 §5.5 : un actif ne
   cède qu'à une revendication active de priorité **supérieure** ; le
   simulateur adoptait aussi les revendications inférieures.
4. **Tests encodant le bug** — « on equal priority, higher IP wins the
   election » validait qu'un nouveau venu à IP supérieure (sans preempt)
   délogeait l'actif en place.

### Correction (structurelle)

- **Équivalent synchrone de Listen/Learn** : nouveau flag runtime
  `probed` ; un groupe frais (ou dont le lien revient — reset dans
  `clearPeerState`) émet d'abord un hello en état `speak` (la « sonde ») ;
  l'incumbent répond synchronement via le `maybeAdvertiseBack` existant ;
  seule une sonde restée sans réponse autorise la revendication active
  (`probeThenClaim`, branché sur `setVip` surchargé et `onLinkUp`).
  Ce modèle préserve la convergence synchrone du simulateur (pas de
  hold-timer obligatoire dans tous les tests).
- **Gate preempt** dans `recompute` : sans `standby preempt`, un routeur
  prioritaire reste standby face à un actif vivant.
- **Garde de collision** dans `handleUdp` : un actif ignore les
  revendications actives inférieures (son prochain hello fait reculer
  l'usurpateur), conforme §5.5.
- Tests : 2 nouveaux cas (préemption refusée sans `preempt`, acceptée
  avec) + le test « higher IP wins » corrigé (le challenger préempte,
  comme dans la réalité) + cas contrastif sans preempt.

### Fichiers

- `src/network/hsrp/types.ts`, `src/network/hsrp/HsrpAgent.ts`
- `src/__tests__/unit/network-v2/hsrp-protocol.test.ts` (+3 tests, 1 corrigé)

### Validation

- VRRP (preempt par défaut RFC 5798, déjà respecté) et GLBP inchangés.
- Suite complète `unit/network-v2` : **289 fichiers, 6891 tests verts**.

### Limite connue (volontaire)

- Après avoir été délogé, l'ex-actif peut rester `listen` jusqu'à
  l'expiration (hold timer) de son entrée standby périmée avant de se
  ré-élire standby — fidèle au comportement réel, qui prend aussi un
  cycle de ré-élection.

---

## Entrée n°14 — 2026-06-11 — NAT/PAT : collision de ports au wraparound ; DHCP : épuisement de pool silencieux

### Défaillances constatées

1. **PAT : réutilisation de ports vivants** — `NATEngine.allocatePort()`
   était un simple compteur linéaire : au retour à 10240 (wraparound),
   il redistribuait des ports **encore détenus par des sessions
   actives**. Le `reverseSessions.set()` écrasait alors la session
   ancienne : son trafic entrant était traduit vers le mauvais hôte
   interne (violation RFC 4787 REQ-1, et faille de confidentialité —
   le trafic d'un hôte arrive chez un autre).
2. **DHCP : épuisement de pool invisible** — `findAvailableIP()` à null
   → retour silencieux, aucun log ni événement. Un vrai IOS émet
   `%DHCPD-4-PING_CONFLICT`/log d'épuisement ; l'opérateur du simulateur
   ne découvrait l'épuisement qu'en voyant les clients sans bail.

### Correction

- **`allocatePort(proto, globalIP)`** : balaye la plage éphémère en
  sautant les ports présents dans `reverseSessions` pour ce
  (protocole, IP globale) ; plage entièrement occupée → `null`
  (la règle est sautée) + événement `nat.port.exhausted`. Constante
  nommée `NAT_EPHEMERAL_MIN` (fin du magic number dupliqué).
- **`DHCPServer.processDiscover`** : pool plein → événement
  `dhcp.pool.exhausted` (nom du pool, réseau, MAC demandeuse) + log
  d'avertissement, avant le retour null existant.

### Fichiers

- `src/network/devices/router/NATEngine.ts`
- `src/network/dhcp/DHCPServer.ts`
- `src/__tests__/unit/network-v2/nat-pat.test.ts` (+1 test wraparound)
- `src/__tests__/unit/network-v2/dhcp_fixes.test.ts` (+1 test épuisement)

### Validation

- Test wraparound : curseur forcé sur le port d'une session vivante →
  le nouvel allocataire reçoit un autre port et la traduction inverse
  de la session originale reste intacte.
- Suite complète `unit/network-v2` : **289 fichiers, 6893 tests verts**.

---

## Entrée n°15 — 2026-06-11 — LACP & DTP : pas de détection de pair silencieux

### Défaillances constatées

1. **LACP : bundle éternel** (802.3ad §43.4.12) — `lastRxMs` était mis à
   jour à chaque LACPDU reçue mais **jamais consulté**. Un partenaire qui
   cessait d'émettre (équipement figé, panne unidirectionnelle) laissait le
   port `bundled` indéfiniment tant que le lien physique restait up : le
   port-channel continuait de balancer du trafic vers un membre mort. Les
   constantes `LACP_FLAG_EXPIRED`/`DEFAULTED` existaient déjà… inutilisées.
2. **DTP : trunk fantôme** — même schéma : `lastHelloMs` suivi, raison
   `peer-loss` déclarée dans le type d'événement, **aucun balayage
   d'expiration**. Un trunk négocié dynamiquement restait opérationnellement
   trunk pour toujours après la disparition du pair.
3. **Agents zombies** — un agent `stop()` (timers arrêtés, abonnements
   détachés) continuait de **traiter et répondre** aux trames reçues via le
   chemin direct du switch : impossible de simuler un pair silencieux, et
   incohérent (un agent arrêté qui parle).

### Correction

- **`LacpAgent`** : machine de réception conforme — timer `current_while`
  (3 × l'intervalle demandé : 90 s slow / 3 s fast) ; à expiration le port
  passe `expired` (hors agrégat, événement `lacp.port.unbundled` avec la
  nouvelle cause `partner-timeout`), garde l'info partenaire un court
  intervalle puis est **defaulted** (partenaire oublié, retour
  `standalone`). Une LACPDU fraîche ressuscite un port `expired`
  (EXPIRED → CURRENT). Nouvel état `'expired'` dans `LacpPortState`
  (documenté), la sélection ne re-bundle jamais un port expiré sur des
  données périmées.
- **`DtpAgent`** : balayage d'expiration (5 × hello, vieillissement de
  voisin façon IOS) — le pair oublié déclenche `resolveOperationalMode`
  avec `null` et publie enfin `peer-loss`.
- **`handleFrame` des deux agents** : gate sur `isRunning()` — un agent
  arrêté ne traite plus rien.

### Fichiers

- `src/network/lacp/types.ts`, `src/network/lacp/LacpAgent.ts`
- `src/network/dtp/DtpAgent.ts`
- `src/__tests__/unit/network-v2/lacp-protocol.test.ts` (+3 tests)
- `src/__tests__/unit/network-v2/dtp-protocol.test.ts` (+1 test)

### Validation

- Tests : expiration après 91 s (slow), info partenaire conservée puis
  defaulted, résurrection par LACPDU fraîche, cause `partner-timeout` sur
  le bus ; trunk DTP retombant en access avec `peer-loss` après 5 × hello.
- Suite complète `unit/network-v2` : **289 fichiers, 6897 tests verts**.

---

## Entrée n°16 — 2026-06-11 — CDP : native VLAN mismatch indétectable ; EIGRP : mismatch K-values muet

### Défaillances constatées

1. **Native VLAN mismatch invisible** — deux trunks avec des native VLAN
   différents font disparaître silencieusement le trafic non taggué.
   Un vrai Cisco loggue `%CDP-4-NATIVE_VLAN_MISMATCH` à chaque hello CDP ;
   le simulateur transportait le TLV native VLAN dans ses trames CDP mais
   **ne comparait jamais** à la réception.
2. **Hook `getNativeVlan` faux pour les trunks** — `CiscoSwitch` câblait le
   hook CDP sur `accessVlan` même en mode trunk (le native annoncé était
   donc faux). La logique correcte existait déjà dans
   `resolveSnoopingVlan()` — dupliquée au lieu d'être réutilisée.
3. **EIGRP : K-values silencieux** — un pair avec des K-values différents
   était simplement omis de la table des voisins (`continue` muet). Un
   vrai IOS loggue `%DUAL-5-NBRCHANGE … K-value mismatch` ; ici aucun
   moyen de diagnostiquer pourquoi l'adjacence ne montait pas.

### Correction

- **`CdpAgent.handleFrame`** : comparaison du native VLAN local
  (hook) avec celui du hello reçu → événement
  `cdp.native-vlan.mismatch` + log d'avertissement au format IOS, à
  chaque hello (comme le vrai matériel). Silence quand les deux
  côtés concordent.
- **`CiscoSwitch`** : hook `getNativeVlan` réutilise
  `resolveSnoopingVlan()` (trunk → native du trunk, access → VLAN
  d'accès) — déduplication.
- **`EIGRPEngine.computeNeighbors`** : le rejet pour K-values publie
  `eigrp.neighbor.k-value-mismatch` (K locaux + K du pair) et loggue au
  format IOS ; l'adjacence reste bloquée (RFC 7868 §5.4).

### Fichiers

- `src/network/cdp/CdpAgent.ts`, `src/network/devices/CiscoSwitch.ts`
- `src/network/eigrp/EIGRPEngine.ts`
- `src/__tests__/unit/network-v2/cdp-protocol.test.ts` (+2 tests)
- `src/__tests__/unit/network-v2/eigrp-engine.test.ts` (+1 test)

### Validation

- Mismatch détecté des deux côtés du câble, silence si accord ; événement
  EIGRP avec IP du voisin et K-values des deux côtés, adjacence toujours
  bloquée.
- Suite complète `unit/network-v2` : **289 fichiers, 6900 tests verts**.

---

## Entrée n°17 — 2026-06-11 — STP : pas d'expiration max-age des BPDU (racine morte = topologie figée)

### Défaillances constatées

1. **Info BPDU immortelle** — `StpPortInfo.ageMs` était horodaté à chaque
   réception mais **jamais lu** : aucune expiration max-age (802.1D §8.6.4).
   Si la racine (ou n'importe quel pont désigné) mourait silencieusement —
   sans link-down local, p. ex. derrière un autre commutateur — son info
   restait épinglée pour toujours : **aucune ré-élection**, et surtout un
   port redondant bloqué ne se débloquait **jamais** (le scénario de
   récupération de boucle, raison d'être du STP).
2. **Comparaison d'identifiants de pont par collation locale** —
   `localeCompare` sur les MAC : faux classement possible sur entrée à
   casse mixte ('AA…' vs '0a…') dans l'élection ; `bridgeEquals` était
   également sensible à la casse.

### Correction

- **`StpAgent`** : balayage `info-age` (1 s) — toute info apprise d'un pair
  plus vieille que `maxAgeSec` est supprimée (les entrées auto-générées par
  `applyRole` ne vieillissent pas), événement `stp.bpdu-info.expired` +
  ré-élection. Le port libéré retraverse listening → learning → forwarding
  (2 × forward delay), soit la reconvergence 802.1D réelle de ~50 s
  (20 + 15 + 15) après une mort silencieuse.
- **`compareBridge`/`bridgeEquals`** : comparaison hex insensible à la
  casse (équivalente à la comparaison numérique 48 bits).
- Conformément à la consigne, le code STP de cette itération est livré
  sans commentaires ; la justification vit ici.

### Fichiers

- `src/network/stp/StpAgent.ts`, `src/network/stp/types.ts`
- `src/__tests__/unit/network-v2/stp-tcn.test.ts` (+3 tests)

### Validation

- Racine arrêtée sans link-down → SW2 se ré-élit racine après 21 s ; port
  redondant bloqué → forwarding après max age + 2 × forward delay ; hellos
  frais = aucune ré-élection parasite (60 s).
- Suites STP : 39 tests verts ; suite complète `unit/network-v2` :
  **289 fichiers, 6912 tests verts** (run incluant les changements avant
  retrait des commentaires, re-validé sur les suites STP après).

---

## Entrée n°18 — 2026-06-11 — STP : PortFast indélogeable malgré la réception de BPDU

### Défaillances constatées

1. **PortFast permanent** — un port PortFast (sans BPDU guard) qui recevait
   un BPDU **gardait son statut edge** : rôle designated forcé, transition
   rapide, aucune génération de TCN. Sur un vrai IOS, la réception d'un
   BPDU fait perdre le statut PortFast opérationnel (le port redevient un
   port STP normal) — c'est la protection de base contre le branchement
   accidentel d'un commutateur sur un port d'accès. La config
   `spanning-tree portfast` reste, seul l'état opérationnel tombe.

### Correction

- **`StpAgent`** : distinction config/opérationnel — `portFastLost`
  (Set) + getter public `isPortFastOperational()`. À la réception de tout
  BPDU sur un port PortFast (hors cas BPDU guard, qui err-disable comme
  avant) : perte du statut, événement `stp.portfast.lost` + log
  d'avertissement. Tous les consommateurs (élection, transition rapide,
  suppression de TCN, détection au link-down) lisent désormais le statut
  opérationnel. Le statut revient quand le lien retombe (cycle du port),
  comme sur le vrai matériel ; `no spanning-tree portfast` purge aussi
  l'état.

### Fichiers

- `src/network/stp/StpAgent.ts`
- `src/__tests__/unit/network-v2/stp-tcn.test.ts` (+3 tests)

### Validation

- BPDU d'un commutateur supérieur sur port PortFast → statut perdu (config
  intacte), retour après cycle du lien, et le port démis signale désormais
  les changements de topologie comme un port normal.
- Suite complète `unit/network-v2` : **289 fichiers, 6915 tests verts**.

---

## Entrée n°19 — 2026-06-11 — RIP : le RIB entier fuyait dans les annonces ; redistribution réelle

### Défaillances constatées

1. **Fuite du RIB complet** — `sendUpdate` annonçait **toutes** les routes
   de la table de routage (statiques, OSPF, par défaut…) sur chaque
   interface RIP, sans aucun filtre ni configuration. Un vrai RIP
   n'annonce que : les connectées couvertes par une instruction
   `network`, les routes RIP, et ce qui est **explicitement redistribué**.
   Le défaut était l'inverse de celui supposé par l'audit (« redistribution
   manquante ») : elle était involontaire, permanente et non configurable.
2. **`redistribute`/`default-metric`/`default-information originate`
   décoratifs** — sous `router rip`, ces commandes n'écrivaient que dans
   le repo de `show running-config` ; `import-route` VRP idem.

### Correction

- **`RIPEngine`** : sélection des routes annonçables (`advertisableMetric`) —
  RIP : métrique+1 ; connectée : couverte par `network` → 1, sinon
  uniquement si `redistribute connected` ; statique : uniquement si
  `redistribute static` (métrique configurée ou 1, sémantique IOS) ;
  OSPF/EIGRP/BGP : `redistribute <proto>` + métrique explicite ou
  `default-metric`, sinon non annoncée (comme IOS) ; préfixe 0.0.0.0/0 :
  uniquement avec `default-information originate`. Nouvelle config
  (`redistribute` Map, `defaultMetric`, `defaultInformationOriginate`)
  + API moteur, pass-throughs adaptateur et façade Router.
- **CLI Cisco** : `redistribute <proto> [metric N]` parsé et appliqué au
  moteur (le repo garde la ligne pour `show run`), `no redistribute`,
  `default-metric`, `default-information originate`/`no …` câblés.
- **CLI Huawei** : `import-route <proto> [cost N]`, `undo import-route`,
  `default-route originate`/`undo …` câblés au même moteur.

### Fichiers

- `src/network/rip/RIPEngine.ts`
- `src/network/devices/router/RouterRIPEngine.ts`, `src/network/devices/Router.ts`
- `src/network/devices/shells/cisco/CiscoRoutingProtoCommands.ts`
- `src/network/devices/shells/HuaweiVRPShell.ts`
- `src/__tests__/unit/network-v2/rip.test.ts` (+8 tests)

### Validation (ciblée — régression complète en fin de campagne)

- 8 tests : non-fuite des statiques/connectées hors `network`/défaut,
  redistribution effective avec métriques IOS, exigence de métrique pour
  les protocoles dynamiques, plomberie CLI des deux vendeurs.
- Suites ciblées : rip (39), cisco-routing-proto, huawei-vrp,
  huawei-config-parity, routing-engine-consistency, rip-versions —
  **247 tests verts**.

---

## Entrée n°20 — 2026-06-11 — Redistribution mutuelle RIP ↔ OSPF complète

### Défaillances constatées

1. **`redistribute rip` inexistant en OSPF** — le handler `redistribute`
   d'OSPF ne connaissait que `static` et `connected` ; `redistribute rip`
   était accepté puis ignoré (aucun branchement). Le lab pédagogique
   classique de redistribution mutuelle entre deux domaines de routage
   était impossible : les préfixes RIP ne devenaient jamais des externes
   OSPF (O E2/E1).
2. Le sens inverse (OSPF→RIP) venait d'être rendu possible à l'entrée
   n°19 ; les deux sens n'avaient jamais fonctionné ensemble.

### Correction

- **`OSPFExtraConfig.redistributeRip`** (`subnets`, `metric`,
  `metricType`) + injection des routes RIP du RIB comme externes dans le
  calcul d'intégration OSPF (E2 : coût fixe — 20 par défaut comme IOS ;
  E1 : coût + chemin interne), même mécanique que les redistributions
  static/connected existantes (réutilisation, pas de duplication).
- **CLI OSPF** : `redistribute rip [metric N] [metric-type T] [subnets]`
  parsé, `no redistribute rip` ciblé, auto-convergence déclenchée après
  chaque changement de redistribution.

### Fichiers

- `src/network/devices/router/RouterOSPFIntegration.ts`
- `src/network/devices/shells/cisco/CiscoOspfCommands.ts`
- `src/__tests__/unit/network-v2/redistribution.test.ts` (nouveau, 3 tests)

### Validation (ciblée)

- Lab à deux domaines (R1 RIP — R2 frontière — R3 OSPF) : R3 apprend les
  préfixes RIP en `O E2` (visible dans `show ip route`), R1 apprend les
  préfixes OSPF avec la métrique `redistribute ospf metric 2`, et rien ne
  traverse sans redistribution configurée.
- Suites ciblées : redistribution (3), ospf-commands, ospf-cli, ospf-full —
  **138 tests verts**.

### Limite connue

- Les lignes `redistribute …` d'OSPF ne sont pas projetées dans
  `show running-config` (défaut préexistant, non introduit ici).

---

## Entrée n°21 — 2026-06-11 — GRE : blocage définitif du tunnel au wraparound de séquence

### Défaillances constatées

1. **Comparaison de séquence non sérielle** — `tunnel sequence-datagrams`
   jetait l'out-of-order par `gre.sequence < expectedRecvSeq` : au
   wraparound 32 bits (0xFFFFFFFF → 0), tous les paquets suivants
   devenaient « inférieurs » à l'attendu et le tunnel se bloquait
   définitivement. (Le drop strict de l'out-of-order, lui, est conforme au
   comportement Cisco de cette option.)

### Correction

- Comparaison en arithmétique sérielle 32 bits
  (`((seq - expected) | 0) < 0`), insensible au wraparound.

### Constats d'audit vérifiés et écartés à cette occasion

- **VTP transparent** : le mode transparent relaie et sort avant tout
  traitement (`forwardOnTrunks` + return) — il n'applique jamais les mises
  à jour reçues ni ne touche sa révision. Conforme, rien à corriger.
- **UDLD** : `udld-protocol.test.ts` existe (l'audit affirmait zéro
  couverture) et l'agent implémente probe/echo/transitions/err-disable.

### Fichiers

- `src/network/gre/GreAgent.ts`

### Validation (ciblée)

- Suite GRE : 13 tests verts.

---

## Clôture de campagne — 2026-06-11 — Régression complète à l'échelle du projet

- `npm run test:run` (projet entier) : **649 fichiers, 13 738 tests verts,
  9 échecs, 93 skipped**.
- Les 9 échecs sont concentrés dans deux suites PowerShell
  (`ps-fifth-pass.test.ts` : DateTime/Push-Location/switch-scriptblock ;
  `format-rendering-fixes.test.ts` : Get-ChildItem) et **préexistent à la
  campagne** : reproduits à l'identique sur un worktree propre du commit de
  départ (91fd5b4), avant toute modification de cette campagne. Sans lien
  avec les protocoles réseau ; probablement sensibles à la date système.
- Périmètre final de la campagne : entrées n°9 à n°21 — 13 itérations
  poussées individuellement, chacune validée par ses suites ciblées, et
  l'ensemble par cette régression globale.

---

## Entrée n°22 — 2026-06-11 — RSTP (802.1w) : le mode rapid-pvst n'était qu'un libellé

### Défaillances constatées

1. **`spanning-tree mode rapid-pvst` purement décoratif** — le shell Cisco
   mémorisait la chaîne pour l'affichage ; le `stp mode rstp` Huawei
   validait la syntaxe puis ne faisait rien. L'agent STP n'avait aucun
   concept de mode : convergence 802.1D à 30 s (2 × forward delay) dans
   tous les cas.

### Correction (sous-ensemble 802.1w fonctionnel)

- **Mode protocole** dans `StpConfig` (`stp` | `rstp`, défaut `stp` —
  aucun changement pour l'existant) + API `setMode`/`getMode`, câblée aux
  deux CLI (`rapid-pvst`/`mst` → rstp côté Cisco ; `rstp`/`mstp` côté VRP).
- **Proposal/agreement** : BPDU v2 avec flags `proposal`/`agreement` ;
  un port désigné non-forwarding propose (à l'entrée en listening et à
  chaque hello) ; le pair dont c'est le root port répond agreement
  (one-shot) et passe forwarding ; le désigné qui reçoit l'agreement
  passe forwarding immédiatement. Face à un port alternate (pas
  d'agreement) ou un voisin 802.1D (BPDU v0), retombée propre sur la
  marche temporisée — interopérabilité préservée.
- **Root port immédiat** : en rstp, le nouveau root port passe forwarding
  sans attendre (failover sub-seconde au lieu de 30 s).
- **Topology change à la RSTP** : plus de TCN vers la racine — le pont
  détecteur arme tcWhile lui-même et le flag TC se propage de proche en
  proche (garde anti-rebond : un TC reçu n'arme tcWhile que s'il n'est
  pas déjà actif) ; le TC sort aussi par le root port (l'émission
  legacy ne couvrait que les ports désignés, le TC ne remontait jamais).

### Fichiers

- `src/network/stp/types.ts`, `src/network/stp/StpAgent.ts`
- `src/network/devices/shells/CiscoSwitchShell.ts`,
  `src/network/devices/shells/HuaweiSwitchShell.ts`
- `src/__tests__/unit/network-v2/stp-rstp.test.ts` (nouveau, 6 tests)

### Validation (ciblée)

- 6 tests RSTP : bascule de mode (2 CLI), handshake proposal/agreement
  (port désigné forwarding sans timers, l'alternate du pair bloque),
  contraste mode legacy (listening), failover root port immédiat,
  propagation TC sans aucun TCN avec fast aging bout en bout.
- Suites STP complètes : 48 tests verts ; suites commutation connexes
  (switch shells, switchport, VTP, LACP, DTP, ping) : 248 tests verts.

---

## Entrée n°23 — 2026-06-11 — Dédup : `resolveSnoopingVlan` remontée dans la base Switch

### Défaillances constatées

1. **Duplication verbatim** — `resolveSnoopingVlan()` (résolution du VLAN
   d'entrée : access → VLAN d'accès, trunk → VLAN natif) était implémentée
   à l'identique dans `CiscoSwitch` et `HuaweiSwitch` (constat d'audit L2
   n°9, jamais traité). Toute évolution de la résolution (sous-interfaces,
   VLAN voice…) aurait dû être faite deux fois.

### Correction

- Méthode unique sur la base `Switch` (publique — elle sert de hook aux
  agents IGMP-snooping et CDP des deux vendeurs) ; suppression des deux
  copies privées.

### Fichiers

- `src/network/devices/Switch.ts`, `CiscoSwitch.ts`, `HuaweiSwitch.ts`

### Validation (ciblée)

- igmp-snooping, cdp-protocol, huawei-switch-shell : 83 tests verts.

---

## Entrée n°24 — 2026-06-11 — EIGRP : `redistribute` stocké mais jamais lu

### Défaillances constatées

1. **`redistribute` EIGRP décoratif** — sous `router eigrp`, la commande
   poussait une chaîne brute dans le repo de `show running-config` ; le
   champ `redistribute: string[]` du moteur n'était lu nulle part. Aucun
   moyen d'injecter des statiques ou des connectées hors `network` dans
   un AS EIGRP.
2. **Pas de notion d'externe** — toutes les routes EIGRP étaient
   installées en AD 90 ; les redistribuées doivent être externes (AD 170,
   D EX sur un vrai IOS).

### Correction

- **`RoutingDeviceContext`** : seam optionnel `ribRoutes()` (réseau,
  masque, type) fourni par `RouterDynamicRouting` depuis le RIB réel —
  les moteurs sur la fondation commune peuvent désormais voir les routes
  des autres protocoles sans couplage au Router.
- **`EIGRPEngine`** : `redistributeSources` (Set) + API
  `setRedistribution`/`removeRedistribution` ; `originatedPrefixes()`
  ajoute les connectées hors instruction `network` (si
  `redistribute connected`) et les routes RIB des sources configurées
  (static/rip/ospf/bgp), marquées `external` ; `computeRoutes` installe
  les externes en **AD 170** chez les voisins.
- **CLI** : `redistribute <proto>` et `no redistribute <proto>` sous
  `router eigrp` câblés au moteur + convergence.

### Fichiers

- `src/network/routing/RoutingPeerLocator.ts`
- `src/network/eigrp/EIGRPEngine.ts`
- `src/network/devices/router/RouterDynamicRouting.ts`
- `src/network/devices/shells/cisco/CiscoRoutingProtoCommands.ts`
- `src/__tests__/unit/network-v2/eigrp-engine.test.ts` (+2 tests)

### Validation (ciblée)

- Moteur : statique non annoncée sans redistribute, annoncée en AD 170
  avec ; connectée hors `network` idem. Suites connexes : eigrp-engine
  (14), eigrp-bgp-cli-integration, cisco-routing-proto,
  routing-engine-consistency, rip (39), redistribution (3) — toutes
  vertes.

---

## Entrée n°25 — 2026-06-11 — DHCP sur le câble + relais Option 82 (RFC 3046)

### Défaillances constatées

1. **DHCP hors-bande** — le DORA ne traversait jamais le réseau simulé :
   le client découvrait les serveurs par traversée du graphe de topologie
   (duck-typing sur les équipements) et appelait `processDiscover()`
   directement sur l'objet serveur. Le routeur jetait les UDP 67/68
   (« Other UDP ports silently dropped »), `ip helper-address` ne relayait
   rien, et l'Option 82 était inimplémentable faute de chemin relais réel.
2. **Broadcast limité refusé sur interface non configurée** — un EndHost
   sans IP n'acceptait jamais 255.255.255.255 (le test exigeait
   `myIP && mask`), en violation de RFC 1122 §3.3.6 — exactement le paquet
   dont dépend un client DHCP (l'OFFER broadcast). C'était le verrou
   structurel qui rendait le DHCP sur câble impossible.
3. **`ip dhcp relay information option` no-op** — la commande existait,
   posait un flag privé jamais lu.

### Correction

- **Client sur câble** (`EndHost.requestLeaseOnWire`) : DISCOVER broadcast
  réel (0.0.0.0 → 255.255.255.255, UDP 68→67, flag broadcast RFC 2131),
  écoute UDP 68, REQUEST sur OFFER (Option 54 écho), application du bail
  sur ACK (IP/masque/passerelle via le même chemin de configuration que le
  client historique), gestion NAK. Le câble synchrone fait aboutir le DORA
  complet dans l'appel.
- **Routeur** : dispatch UDP 67 dans la livraison locale —
  (a) **serveur** : DISCOVER/REQUEST → moteur DHCPServer existant
  (sélection de pool par giaddr déjà supportée) → OFFER/ACK/NAK réels,
  unicast vers giaddr ou broadcast sur l'interface d'entrée, écho de
  l'Option 82 (RFC 3046 §2.2) ;
  (b) **relais** : requête reçue sur une interface à `ip helper-address` →
  giaddr posé (seulement si 0.0.0.0, conforme RFC), **insertion Option 82**
  (circuit-id = interface d'entrée, remote-id = hostname) si activée,
  routage vers chaque helper ;
  (c) **retour relais** : BOOTREPLY dont le giaddr est une de nos
  interfaces → **strip de l'Option 82** puis broadcast vers le client.
  Événements : `dhcp.relay.forwarded`, `dhcp.relay.reply-forwarded`,
  `dhcp.server.option82-received`.
- **EndHost** : acceptation inconditionnelle du broadcast limité
  255.255.255.255 (RFC 1122 §3.3.6).
- **CLI** : le handler existant `ip dhcp relay information option` câblé au
  flag du serveur (un doublon que j'avais introduit était écrasé par
  l'enregistrement existant — supprimé, l'existant enrichi) + variante `no`.
- `DHCPPacket.removeOption()` ajouté (strip propre côté relais).

### Fichiers

- `src/network/devices/EndHost.ts`, `src/network/devices/Router.ts`
- `src/network/dhcp/DHCPPacket.ts`, `DHCPServer.ts`, `types.ts`
- `src/network/devices/shells/cisco/CiscoConfigCommands.ts`
- `src/__tests__/unit/network-v2/dhcp-relay-wire.test.ts` (nouveau, 5 tests)

### Validation (ciblée)

- 5 tests de bout en bout : DORA broadcast direct (bail + ping passerelle),
  relais inter-subnets avec sélection de pool par giaddr (bail distant +
  ping du serveur), Option 82 absente par défaut, circuit-id/remote-id/giaddr
  reçus par le serveur quand activée, Option 82 strippée avant le client.
- Suites connexes : dhcp_complete, dhcp_fixes, dhcp_cli_gaps,
  ping-through-switch, acl-icmp-type, host-model-loopback, fhrp-dataplane —
  **100 tests verts** (le client hors-bande historique reste intact).

### Limite connue

- ~~Le client câble est exposé via `requestLeaseOnWire()` (nouvelle API) ;
  le flux `dhclient`/UI historique reste sur le chemin hors-bande — la
  bascule par défaut demanderait une migration des suites existantes.~~
  **Soldée** : `dhclient` passe par le câble depuis l'entrée 15 du
  JOURNAL-DE-BORD (canal `WireDhcpChannel` essayé en premier), et la
  surface parallèle `requestLeaseOnWire` a été fusionnée dans le
  `DHCPClient` (JOURNAL-DE-BORD, entrée 30).

---

## Entrée n°26 — 2026-06-16 — OSPF : fin de la synchronisation de LSDB hors-bande (RFC 2328 §13)

### Défaillances constatées

1. **LSDB recopiée hors-bande** — `RouterOSPFIntegration.exchangeAndCompute()`
   bouclait sa convergence par `synchronizeLSDBs()` : une boucle qui parcourait
   *tous* les routeurs du domaine (registre statique + BFS) et **copiait
   directement chaque LSA d'un moteur dans la LSDB des autres** via
   `OSPFEngine.mergeLSA()` (`installLSA(structuredClone(lsa))`). Aucune trame
   LSU ne circulait sur le câble pour cette étape : du flooding *en mémoire*,
   exactement le « théâtre de control plane » que la campagne traque. C'était
   le **seul** contrevenant hors-bande majeur restant côté protocoles (BGP,
   EIGRP, RIP, STP, FHRP, CDP/LLDP, VTP/DTP, LACP/UDLD, IGMP, PIM, VXLAN, NTP,
   BFD floodent/échangent déjà via `port.sendFrame()` — audit complet mené).
2. **Le flooding réel ne re-convergeait pas sur changement incrémental** — une
   fois la béquille retirée, deux scénarios cassaient (topologie construite
   routeur par routeur) : le premier routeur configuré n'apprenait jamais le
   LAN d'un voisin ajouté **plus tard**, et un spoke n'apprenait pas l'autre
   spoke à travers un hub. Diagnostic : la LSDB de la victime **était pourtant
   complète** (les LSA arrivaient bien par le fil), mais elle gardait une
   **instance périmée** de la Router-LSA du voisin (vue comme un simple lien
   *stub* d'avant l'adjacence), si bien que son SPF ne traversait plus le
   réseau de transit — aucune route transitive calculée.
3. **Cause racine : pacing à l'horloge murale incompatible avec la convergence
   synchrone** — la nouvelle instance (séquence supérieure) de la Router-LSA
   était bloquée des **deux côtés** : `floodLSA` la supprimait via
   **MinLSInterval** (§12.4, émetteur) et `processLSUpdate` la rejetait via
   **MinLSArrival** (§13 étape 5b, récepteur). Ces deux garde-fous comparent
   `Date.now()`, or *aucun temps simulé ne s'écoule* pendant la passe
   « converge maintenant ». `synchronizeLSDBs` masquait le problème en
   appelant `installLSA` directement (contournant les deux). Un troisième
   défaut s'ajoutait : le re-flood était déclenché **après** le recâblage des
   `sendCallback` en mode différé (`setTimeout`), donc les LSU partaient
   *hors* du flux synchrone et le SPF tournait avant leur livraison.

### Correction (structurelle)

- **Suppression de `synchronizeLSDBs()` et de la primitive `mergeLSA()`** (qui
  ne servait qu'à elle) : la synchronisation de LSDB ne peut désormais se faire
  **que par de vraies trames LSU sur le câble** (`floodLSA → dispatchOutgoing →
  sendCallback → sendPacket → port.sendFrame`).
- **`OSPFEngine.refloodSelfOriginatedLSAs()`** (nouveau) : re-flood forcé de
  toutes les LSA self-originées encore vivantes (RFC 2328 §13.3) ; le
  `processLSUpdate` du voisin supersède proprement l'instance périmée.
- **Mode `batchConvergence`** (nouveau, `setBatchConvergence()`) : pendant la
  passe d'origination + re-flood synchrone, MinLSInterval (émetteur) et
  MinLSArrival (récepteur) sont relâchés — leur cadence à l'horloge murale n'a
  pas de sens sans écoulement de temps simulé. Hors de cette passe, le pacing
  RFC reste strictement appliqué (le drapeau n'est posé que par l'intégration).
- **Ordre corrigé** dans `exchangeAndCompute` : origination → re-flood **tant
  que les `sendCallback` sont synchrones**, *puis seulement* recâblage en mode
  différé pour la simulation live, *puis* SPF.

### Fichiers

- `src/network/ospf/OSPFEngine.ts` (champ `batchConvergence` + `setBatchConvergence`,
  `refloodSelfOriginatedLSAs`, relâche conditionnelle de MinLSInterval/MinLSArrival,
  suppression de `mergeLSA`)
- `src/network/devices/router/RouterOSPFIntegration.ts` (suppression de
  `synchronizeLSDBs`, passe de re-flood encadrée par le mode batch)

### Validation

- Les 2 scénarios `ospf-transitive-spf` (voisin tardif ; spoke↔spoke via hub
  cross-vendor) passent désormais **par flooding LSU réel**, sans copie mémoire.
- Suite OSPF complète : **17 fichiers, 404 tests verts** (DR election, virtual
  links, NSSA, timers/aging — dont MinLSInterval —, reliability, ECMP, packet
  exchange…).
- Non-régression `unit/network-v2` : **319 fichiers, 7117 tests verts** (49
  skipped). Build de production (esbuild) OK.

### Limites connues / suites futures

- L'orchestration de convergence OSPFv2 garde encore un **registre statique**
  (`collectOSPFDomain`) et active les interfaces des pairs hors-bande ; la
  *synchronisation de LSDB*, elle, est maintenant 100 % sur le fil. Migrer la
  découverte de domaine vers une découverte purement pilotée par les Hello
  reçus est l'étape suivante.
- **OSPFv3** conserve son propre chemin hors-bande (`v3ComputeRoutes` lit
  directement les tables de routage des pairs) — à traiter séparément.

---

## Entrée n°27 — 2026-06-19 — Switch L2 : plan de gestion SVI (ping/ARP/ICMP réellement sur le câble)

### Défaillances constatées

Le commutateur de niveau 2 (`Switch` / `CiscoSwitch`) n'avait **aucun plan de
gestion L3** fonctionnel, contrairement à un vrai Catalyst :

1. **`ping` était un stub** : `% Ping not yet implemented on switch.` — le
   switch ne pouvait pas vérifier la connectivité de son réseau de gestion.
2. **L'adresse d'une SVI partait dans le vide** : `interface Vlan N` /
   `ip address …` appelait `getPort('Vlan1')?.configureIP(...)`. Or aucun port
   physique ne s'appelle `Vlan1`, donc `getPort` renvoyait `undefined` et
   l'adresse n'était **jamais stockée** (`show ip interface brief` montrait une
   ligne `Vlan1` figée et codée en dur).
3. **`interface Vlan N` n'était même pas reconnu** : `virtualInterfaceName` ne
   gérait que les `Port-channel`. Entrer dans une SVI échouait.
4. **`no shutdown` sur une SVI** renvoyait `% Error` (la SVI n'étant pas un port).
5. Aucune validation : on pouvait « entrer » dans `interface Vlan9999`
   (hors plage 1–4094), et `speed`/`duplex` étaient acceptés sur une interface
   virtuelle où ils n'ont pas de sens.

### Correction (structurelle)

Nouveau module **`SwitchSvi`** (`src/network/devices/SwitchSvi.ts`) : un plan de
gestion L3 minimal mais fidèle (IP/masque par VLAN, état admin, ARP, écho ICMP).
Il **ne duplique pas** la pile hôte de `EndHost` (2918 lignes, couplée aux
sockets/DNS/routage) : il s'appuie sur les **primitives partagées**
(`core/types` : `createIPv4Packet`, `ARPPacket`, `ICMPPacket`) et **réutilise le
plan de données L2 existant** du switch.

- **Émission** : `egressOnVlan(vlan, frame)` rejoue la **même décision
  flood / unicast** que `handleFrame` pour le trafic de transit (extraction d'un
  point unique, pas de copie). Une trame issue de la SVI quitte le switch
  exactement comme celle d'un hôte connecté → **tout passe par le câble**.
- **Réception** : `intercept(vlan, port, frame)` est appelé dans `handleFrame`
  après l'apprentissage MAC. Il répond à l'ARP visant l'IP de la SVI, répond à
  l'écho ICMP, et règle les `echo-reply` du ping en cours. L'ARP de diffusion
  est traité **mais laissé inonder** (retour `false`), l'unicast adressé à la
  SVI est **consommé** (retour `true`).
- **ARP** : aucune deuxième table — la SVI lit/écrit la **table ARP de gestion
  existante** du switch via `lookupArp`/`learnArp`.
- **MAC** : toutes les SVI partagent le **MAC de bridge** (1er port), comme le
  vrai IOS.
- **Ping** : `executePingSequence` calque l'API de `Router`. La livraison sur
  câble étant **synchrone** (`Cable.transmit`), l'aller-retour ARP/écho se
  règle dans la pile d'appel — déterministe, sans minuterie temps-réel.

Déduplication CLI : extraction de **`ciscoPing.ts`** (`parsePingArgs` +
`formatCiscoPing`, le rendu `Success rate is N percent`) — destiné à être
partagé par les shells routeur et switch (le switch l'utilise déjà ; la
migration du routeur suivra). Le switch borne `repeat` (`MAX_PING_REPEAT`)
puisque les sondes sont pilotées de façon synchrone.

Côté shell (`CiscoSwitchShell`) : `virtualInterfaceName` reconnaît `Vlan N` ;
`ip address`/`no ip address`, `shutdown`/`no shutdown` ciblent la SVI ; `ping`
(user + privileged) passe par le pipeline async partagé (`_pendingAsync`) ;
`show ip interface brief` est rendu dynamiquement ; `speed`/`duplex` et les
VLAN hors plage sont rejetés (`%`), conformément à IOS.

### Fichiers

`src/network/devices/SwitchSvi.ts` (nouveau),
`src/network/devices/shells/cisco/ciscoPing.ts` (nouveau, partagé),
`src/network/devices/Switch.ts` (plan SVI + `egressOnVlan` + hook `intercept`),
`src/network/devices/shells/CiscoSwitchShell.ts` (SVI, ping, show),
`src/__tests__/unit/network-v2/switch-svi.test.ts` (nouveau).

### Validation

- Nouveau `switch-svi.test.ts` : **8 tests verts** — adressage SVI, ping
  aller-retour réel sur le câble (`Success rate is 100 percent` + MAC du pair
  apprise), réponse à l'écho d'un hôte, 0 % si injoignable, `repeat`, SVI
  admin-down muette, rejet `speed`/`duplex` et VLAN hors plage.
- `other-commands.test.ts` (suite Cisco L2) : **154 → 156 verts**, aucune
  régression (les 4 corrections SVI compensées en supprimant 2 régressions
  introduites — `speed`/`duplex` et `interface Vlan9999`).
- Fichiers neufs : **lint propre**, tsc propre.

### Limites connues / suites futures

- **Indexation des ports du switch (bug de fidélité)** : un switch « 24 ports »
  crée `FastEthernet0/0`…`0/23`. Un vrai Catalyst est **1-indexé**
  (`0/1`…`0/24`, pas de `Fa0/0`). Le helper de test `setupManagementLAN` câble
  `FastEthernet0/24` (inexistant) et **plante au montage** — ce qui bloque ~9
  tests « Management Plane » indépendamment du plan SVI. La correction
  (réindexation 1-based) touche ~53 fichiers de test : **migration dédiée à
  faire dans un commit séparé**.
- ~~Le routeur garde encore son propre parseur/rendu de ping~~ → fait
  (Entrée n°28).
- SSH/telnet sortants, `crypto key generate rsa`, gating VTY : hors périmètre de
  ce commit (plan de gestion *protocolaire*, à traiter ensuite).

---

## Entrée n°28 — 2026-06-19 — Dédup : le routeur réutilise `ciscoPing.ts`

### Défaillance constatée

Suite à l'Entrée n°27, le rendu IOS du ping (`Type escape sequence to abort.` /
`Success rate is N percent (s/t)` / `round-trip min/avg/max`) **existait en
double** : une copie privée `_formatCiscoPing` dans `CiscoIOSShell`, et la
version partagée `ciscoPing.ts`. Le parsing des options (`repeat`/`timeout`/
`size`/`source`) était lui aussi dupliqué entre routeur et switch.

### Correction

`CiscoIOSShell._handlePing` utilise désormais `parsePingArgs` +
`formatCiscoPing` du module partagé ; la méthode privée `_formatCiscoPing`
(31 lignes) est supprimée. Le rendu est **identique au bit près** (taille par
défaut 100 octets). Bilan : **−74 lignes**, une seule source de vérité pour le
ping Cisco (routeur + switch).

### Fichiers

`src/network/devices/shells/CiscoIOSShell.ts`.

### Validation

- `router-architecture`, `no-ip-address`, `nat-icmp-pat`, `switch-svi` :
  **28 tests verts**, aucune régression. Aucune nouvelle erreur lint/tsc.

---

## Entrée n°29 — 2026-06-20 — IPSec : sélection du pair découplée du registre global (god-mode)

### Défaillance constatée

Le transport IKE est déjà entièrement sur le fil : `IPSecEngine.initiateIkeWire`
émet l'offre via `Router._sendIkeUdp` (vraie trame UDP/500 → IP → Ethernet →
`sendFrame` → port → câble), et le pair la reçoit via `handleIkeUdp` dans son
plan de données. **Mais la sélection du pair restait god-mode** : `determinePeer`
gateait chaque pair configuré (`crypto map … set peer X`) par
`IPSecEngine.findRouterByIP(peerIP)`, qui **parcourt le registre global**
(`Equipment.getAllEquipment()`) pour vérifier qu'un `Router` porte cette IP
quelque part dans la simulation, avant même de regarder la table de routage.

C'est doublement faux par rapport à un vrai IOS :

1. **Couplage au registre global** — un routeur réel ne « sait » pas si un objet
   pair existe ailleurs ; il ne connaît que sa config et sa FIB.
2. **Sémantique de failover incorrecte** — un pair configuré mais momentanément
   injoignable était *écarté* (au lieu d'être tenté puis abandonné via DPD),
   parce que `findRouterByIP` répond sur l'existence de l'objet, pas sur la
   joignabilité réelle.

### Correction (structurelle)

`determinePeer` ne consulte plus que la **table de routage locale**
(`lookupRoute`) : on sélectionne le premier pair configuré pour lequel la FIB a
une route, exactement comme IOS. L'établissement réel se joue ensuite sur le fil
(`_sendIkeUdp`) et échoue proprement (`createFailedIKESA`) si aucun pair ne
répond. Le gate `findRouterByIP` disparaît du chemin de sélection.

`findRouterByIP` **reste** utilisé par la détection NAT-T (`findRouterBehindNAT`)
— pas de code mort. Cette résolution NAT-T par scan du registre est la
**prochaine cible** (migration vers une détection par observation NAT-D à la
réception, le NAT étant déjà réellement appliqué sur le câble par l'équipement
intermédiaire).

### Fichiers

`src/network/ipsec/IPSecEngine.ts` (`determinePeer`).

### Validation

- Suite IPSec complète (8 fichiers : failures, ikev1-psk, ikev2-psk, advanced,
  nat-dpd, ike-messages, modes-pfs, dpd-wire) : **47 tests verts**, aucune
  régression — les tunnels se forment toujours, NAT-T et DPD inclus, en
  s'appuyant uniquement sur le routage + le fil.
- Lint : **inchangé** (52 = 52 ; dette `as any` pré-existante du fichier non
  aggravée). Aucune nouvelle erreur introduite par la modification.

### Limites connues / suite

- **NAT-T god-mode** (`getApparentSourceIP` / `findRouterBehindNAT` /
  `findEquipmentByIP`) : prédiction de l'adresse post-NAT par introspection des
  règles iptables d'un autre équipement. À remplacer par l'observation de la
  source réelle des paquets IKE reçus (le NAT étant déjà appliqué sur le câble)
  + détection NAT-D conforme RFC 3947. Incrément dédié.

---

## Entrée n°30 — 2026-06-20 — DHCP : fin du scan global god-mode pour les hôtes câblés (isolation de sous-réseau)

### Défaillance constatée

Le client DHCP essaie déjà **le fil d'abord** (`WireDhcpChannel` : vrai DISCOVER
broadcast UDP 68→67 sur le câble, OFFER dans l'inbox au retour synchrone — voir
Entrée n°25). Mais `EndHost.autoDiscoverDHCPServers` conservait une **Stratégie 2
god-mode** : si la marche de topologie (Stratégie 1) ne trouvait rien, il
**scannait le registre global** (`Equipment.getAllEquipment()`) et enregistrait
*tout* serveur DHCP de la simulation comme `DirectServerChannel`.

Conséquence : un hôte **physiquement isolé** (broadcast n'atteignant aucun
serveur, aucun relais `ip helper-address`) pouvait quand même obtenir un bail
d'un serveur qu'il **ne peut pas toucher**, par simple appel d'objet — rupture
totale de l'isolation de sous-réseau, l'antithèse du principe « tout passe par le
câble ».

### Correction (structurelle)

La Stratégie 2 (scan global) est désormais **gatée sur l'absence totale de
câble** : `const hasCabledInterface = [...ports].some(p => p.getCable())`. Dès
qu'un hôte possède **au moins une interface câblée**, il ne peut plus tomber sur
le registre global — il dépend exclusivement du **broadcast réel sur le segment
local** (déjà tenté en premier sur le fil) ou d'un **relais configuré**, comme un
vrai client DHCP. Le scan global ne subsiste **que** pour les hôtes jamais câblés
(pure commodité de tests unitaires hors topologie).

Stratégie 1 (marche de câbles, topologie-consciente) est conservée : elle
n'enregistre que des serveurs réellement atteignables et le fil reste prioritaire.

### Fichiers

`src/network/devices/EndHost.ts` (`autoDiscoverDHCPServers`, garde Stratégie 2).

### Validation

- DHCP unitaire (7 fichiers : `dhcp_complete`, `dhcp_fixes`,
  `dhcp-client-wire-channel`, `dhcp-relay-wire`, `dhcp-server-identifier`,
  `dhcp-resolv-conf`, `cisco-dhcp-pool-options`) : **76 verts**.
- Suites élargies acquérant des baux en topologie câblée (netsh DHCP/DNS, netsh,
  cisco-wan, huawei-vrp, basic-commandes, windows-consistency,
  linux-command-options) : **302 verts**.
- Debug topologies réelles (`protocols/dhcp`, `router/cisco-router-dhcp-nat`,
  `linux-networking`) : **3 verts** (montage OK, aucun crash).
- **681 tests au total, zéro régression** — confirmant empiriquement que les
  hôtes câblés obtenaient déjà leurs baux par le fil/Stratégie 1 et que le scan
  global était un fallback god-mode redondant. Lint inchangé (4 = 4).

### Limites connues / suite

- **Stratégie 1** délivre encore via `DirectServerChannel` (appel d'objet) plutôt
  que par le broadcast/relais ; le fil étant prioritaire, c'est un fallback rare,
  mais sa suppression complète (tout-fil) est un incrément ultérieur.

---

## Entrée n°31 — 2026-06-19 — Switch Cisco : indexation 1-based des ports (fidélité Catalyst)

### Défaillance constatée

Un commutateur Cisco « 24 ports » créait `FastEthernet0/0`…`0/23`. Un vrai
Catalyst est **1-indexé** : `FastEthernet0/1`…`0/24` (et liaisons montantes
`GigabitEthernet0/1`…), **il n'existe pas de `FastEthernet0/0`**. Conséquences :

1. **Bug de fidélité** : numérotation des interfaces non conforme au matériel réel.
2. **Tests bloqués au montage** : le helper `setupManagementLAN` câblait
   `FastEthernet0/24` (le 24ᵉ port, en 1-based) — inexistant en 0-based — d'où un
   crash `_setCableNoNotify` qui faisait échouer ~9 tests « Management Plane »
   (ping/SSH/telnet sur SVI) indépendamment du plan SVI de l'entrée n°27.

### Correction

`CiscoSwitch.getPortName` passe en 1-based : `index < 24 ? FastEthernet0/${index+1}
: GigabitEthernet0/${index-23}`. Le routeur (`GigabitEthernet0/0`-based) et le
switch Huawei (`GigabitEthernet0/0/N`) ne sont **pas** touchés.

### Migration des références de tests (87 fichiers, ~1300 occurrences)

Fait crucial qui rend la migration sûre : `FastEthernet` est **exclusif au
switch Cisco** (le routeur n'utilise que `GigabitEthernet`). Toute référence
`FastEthernet0/N` est donc du contexte switch et se décale de +1 sans risque
de toucher un port de routeur.

Décalage `N → N+1` **borné à `N ≤ 23`**, ce qui protège automatiquement les
références déjà correctes en 1-based (`FastEthernet0/24` du helper) et le port
volontairement invalide (`FastEthernet0/99` d'un test d'erreur). Catégories de
formes traitées, chacune ayant nécessité une passe dédiée :

- littéraux simples `FastEthernet0/N`, `Fa0/N`, `fa0/N` ;
- littéraux **échappés** dans les regex (`FastEthernet0\/N`) ;
- **template literals** de boucle (`FastEthernet0/${i}`) — bornes de boucle
  ajustées à la main (la variable sert parfois aussi à dériver un VLAN) ;
- **plages** `interface range fa0/X-Y` — la borne de fin (nombre nu) décalée ;
- classes de caractères regex (`/Fa0\/[01]/` → `/Fa0\/[12]/`) ;
- **liaisons montantes Gig du switch** (`<sw>.getPort('GigabitEthernet0/0')`)
  décalées au cas par cas, sans toucher les `GigabitEthernet` des routeurs sur
  la même ligne.

### Fichiers

`src/network/devices/CiscoSwitch.ts` (device, 1-based) + 65 fichiers de tests
`unit/network-v2/`.

### Validation

- `unit/network-v2` : retour à la **baseline pré-migration** (seuls subsistent
  les échecs pré-existants `other-commands` et `auditctl-other`), **zéro
  nouvelle régression** sur 8366 tests.
- `other-commands` (suite L2) : bloc « Management Plane » **15 → 8 échecs**
  (les 7 tests SVI ping/connectivité, jusque-là bloqués par le crash de montage,
  passent désormais). `switch-svi` : 8/8.

### Limites connues / suites futures

- **Switch Huawei** (`GigabitEthernet0/0/N`) toujours 0-based — même correction
  à appliquer dans un commit dédié (367 références de tests).
- **Labs de diagnostic `__tests__/debug/cisco-l2/`** : laissés en l'état
  (0-based) — ce sont des *dumps* non assertifs, à **régénérer** contre le
  device 1-based séparément.

---

## Entrée n°32 — 2026-06-20 — Arbre de commandes : élimination des doublons d'enregistrement (trie CLI)

### Défaillance constatée

`CommandTrie.register`/`registerGreedy` **écrasent silencieusement** l'action
d'un chemin déjà enregistré (`node.action = action`). Or tout l'enregistrement
des shells se fait à la construction, avant toute commande — donc un chemin
enregistré deux fois sur le même trie rend la **première registration morte**
(jamais exécutée) et masque parfois la *bonne* implémentation derrière une plus
ancienne. C'est de la duplication pure, et une source de bugs latents.

Détection par **vérité d'exécution** (instrumentation du trie pendant la
construction de chaque équipement, capture de la pile pour localiser les deux
sites) — bien plus fiable qu'une analyse statique (qui produit des faux
positifs quand un même nom de paramètre `trie`/`t` est réutilisé par des
fonctions ciblant des tries différents). Résultat : **34 doublons** côté
routeur Cisco, 6 côté switch (et 44 côté Huawei, traités plus tard).

### Correction

Suppression des **registrations perdantes** (mortes), garantissant **zéro
changement de comportement** (le gagnant — la dernière registration, déjà
active — est conservé). 24 doublons accidentels supprimés :

- **Cluster crypto** (le plus gros) : `CiscoIPSecShowCommands` et
  `CiscoIPSecIKEv1Commands` enregistraient tous deux `clear/debug/no debug
  crypto isakmp|ipsec|ikev2`, `clear crypto session`, `undebug all`,
  `show crypto engine brief|configuration` (12). Les versions ShowCommands
  étaient mortes → supprimées.
- `crypto isakmp keepalive` / `no …` (doublon interne IKEv1).
- OSPF : `log-adjacency-changes`, `show ip ospf neighbor` (greedy adjacent).
- Routeur (`CiscoIOSShell`) : `show ip route`, `show interfaces`, `show ip cef`,
  `show ip traffic` (perdants ; gagnants dans les builders dédiés).
- `random-detect` (register + registerGreedy adjacents), `clear errdisable
  interface` (switch, perdant moins capable), `show snmp` (handlers identiques),
  `ip domain-lookup`/`no …` (toggle `flag()` perdant ; gagnant = register direct).
- `arp`/`no arp` : `registerArpConfigCommands` était appelé **deux fois** sur le
  trie config du routeur (via `buildConfigCommands` *et* la base partagée) ;
  l'appel routeur redondant est retiré (la base couvre les deux vendeurs).

### Garde structurelle (anti-régression)

Ajout d'un **observateur d'écrasement** optionnel sur `CommandTrie`
(`overwriteObserver`, `null` par défaut → coût nul en prod). Nouveau test
`command-trie-hygiene.test.ts` : construit routeur + switch Cisco et **échoue
si un doublon accidentel apparaît**. Les rares doublons *intentionnels*
restants (base partagée + override vendeur) sont explicitement en liste blanche
et documentés.

### Doublons restants (intentionnels ou bug à traiter ailleurs)

- **base/override** (8) : `aaa`, `username`, `ip ssh`, `ip cef`/`no ip cef`,
  `show ssh`, `no ip routing`, `show mac address-table` — la base partagée
  fournit un défaut que le module spécifique au vendeur surcharge ;
  supprimer la base casserait l'autre vendeur. Listés en garde.
- **`copy` (bug latent)** : la version *simple* (`copy complete`) écrase la
  version *riche* (`copy running-config startup-config` → `onSave()`). C'est la
  cause de l'échec du cluster « Storage & Configuration Lifecycle » de
  `other-commands` — à corriger dans le commit dédié config-lifecycle (changer
  le gagnant change le comportement, hors périmètre « dédup »).
- **Huawei** (44 doublons) : même traitement, commit dédié.

### Fichiers

`CommandTrie.ts` (observateur), `CiscoIPSecShowCommands.ts`,
`CiscoIPSecIKEv1Commands.ts`, `CiscoOspfCommands.ts`, `CiscoIOSShell.ts`,
`CiscoSecurityCommands.ts`, `CiscoSwitchShell.ts`, `CiscoShellBase.ts`,
`cisco/CiscoConfigCommands.ts`, `command-trie-hygiene.test.ts` (nouveau).

### Validation

- `command-trie-hygiene` : 2/2 verts (doublons accidentels = 0).
- `network-v2` complet : `other-commands` inchangé (37 — échecs config-lifecycle
  pré-existants), **aucune régression** sur 8389 tests. Aucune nouvelle erreur
  lint/tsc.

---

## Entrée n°33 — 2026-06-20 — Switch L2 : cycle de vie de la configuration (NVRAM texte, copy/write/erase fidèles IOS)

### Défaillances constatées

Le cluster « Storage & Configuration Lifecycle » de la suite L2 échouait
massivement (14 tests). Causes structurelles :

1. **NVRAM sérialisée en JSON** : `show startup-config` affichait
   `Startup config (serialized):\n{"hostname":…}` au lieu du texte IOS. La
   NVRAM du switch était un `JSON.stringify` de l'état (`serializeConfig`),
   doublant la représentation déjà produite par `buildRunningConfig`.
2. **`copy` masqué** (bug latent de l'entrée n°32) : un `copy` *simple*
   (`X → Y: copy complete`), enregistré pour **les modes user ET privileged**
   via `registerCommonShowCommands`, écrasait le `copy` *riche* (run→start,
   restore, flash). D'où : `copy run start` ne sauvegardait pas, `copy` était
   accepté en mode user (au lieu d'être refusé), et la gestion d'erreurs
   (NVRAM vide, fichier absent) ne s'exécutait jamais.
3. **`erase startup-config`** n'effaçait rien sur le switch (`_eraseStartupConfig`
   inexistant) et n'affichait pas `complete`.
4. **`copy running-config startup-config`** ne prévenait pas
   (`Destination filename …`).
5. **Pas de système de fichiers flash** (`copy run flash:X` / `copy flash:X run`).

### Correction (structurelle)

- **NVRAM = texte** (`Switch`) : `writeMemory()` capture le running-config
  *rendu* (`getRunningConfig()`), `show startup-config` l'affiche, et `reload`
  le **rejoue** via un parseur (`applyConfigText`) — une seule représentation,
  comme le vrai IOS qui relit le startup-config au boot. `serializeConfig`
  (JSON) supprimé. Ajout de `_eraseStartupConfig`, `_restoreStartupConfig`,
  `_applyConfigText`.
- **`copy` unifié** (base partagée) : suppression du `copy` simple shadow ; un
  seul handler greedy gère toutes les paires source/destination (un
  enregistrement exact `copy running-config startup-config` créait un nœud
  intermédiaire masquant les autres destinations au greedy). Abréviations IOS
  (`copy run start`) normalisées. Refus en mode user (privileged-only).
- **Sémantique fidèle** : prompt `Destination filename [startup-config]?` ;
  `Erase of nvram: complete` ; NVRAM vide → `%% Non-volatile configuration
  memory is not present` ; source flash absente → `%Error opening … (No such
  file or directory)`.
- **Flash simulé** (`Switch`) : `_writeFlashFile`/`_readFlashFile` (Map en
  mémoire) — `copy run flash:X` puis `copy flash:X run` fonctionne ; un fichier
  jamais écrit est en erreur. Le routeur (sans ces méthodes) conserve son
  comportement via gardes `typeof … === 'function'`.

### Fichiers

`src/network/devices/Switch.ts` (NVRAM texte + flash + parseur),
`src/network/devices/shells/CiscoShellBase.ts` (copy/write/erase unifiés),
`src/network/devices/shells/CiscoSwitchShell.ts` (show startup-config / write),
`command-trie-hygiene.test.ts` (retrait de `copy` de la liste blanche — dédupé).

### Validation

- Cluster config-lifecycle : **14 → 1 échec** (13 corrigés). `other-commands`
  global : **37 → 24**.
- Non-régression routeur (base partagée) : `cisco-router-operational-show`
  + `cross-equipment-ssh-suite` = **238 verts**. `command-trie-hygiene` : 2/2.

### Limite connue

- **Test 44** (base de comptes locaux du switch préservée au reload) : nécessite
  une vraie base d'utilisateurs locaux côté switch (`_upsertCiscoUsername`,
  rendu `username …` dans `buildRunningConfig`, restauration avec round-trip du
  hash de secret) — fonctionnalité AAA distincte, à traiter séparément.

---

## Entrée n°34 — 2026-06-20 — Switch L2 : plan de gestion (domaine, clés RSA/SSH, default-gateway)

### Défaillances constatées

Le switch n'avait aucun état de plan de gestion : `ip domain-name`,
`crypto key generate rsa`, `ip ssh version`, `ip default-gateway` étaient soit
ignorés, soit absents. D'où les échecs « Management Plane » :

- `ip ssh version 2` sans clés RSA ne refusait pas (IOS exige les clés d'hôte).
- `crypto key generate rsa` inexistant.
- `ip domain-name` partait dans le vide (le handler partagé n'écrit que via
  `getManagementService()`, que le switch n'a pas) et n'apparaissait pas dans
  le running-config.
- `ip default-gateway` (route de gestion d'un switch L2) inexistant.

### Correction

- **État de gestion minimal sur le `Switch`** : `domainName`, `hasRsaKeys`,
  `ipDefaultGateway` + accesseurs (`_setDomainName`, `_generateRsaKeys`,
  `hasRsaKeys`, `_setDefaultGateway`, …).
- **Réutilisation du handler partagé `ip domain-name`** : ajout d'un *fallback*
  device-level (`dev._setDomainName?.()`) quand `getManagementService()` est
  absent — le routeur (qui a le service) est inchangé, le switch est couvert
  par le même handler (DRY, pas de doublon de trie).
- **Commandes switch** (`CiscoSwitchShell`) : `crypto key generate rsa` (exige
  un domaine, pose les clés, sortie « RSA key pair generated ») ;
  `ip ssh version N` refusée sans clés (« Please create RSA keys… ») ;
  `ip default-gateway` / `no …`.
- **Rendu** : `buildRunningConfig` émet `ip domain-name …` et
  `ip default-gateway …`.

### Fichiers

`src/network/devices/Switch.ts` (état + accesseurs),
`src/network/devices/shells/CiscoShellBase.ts` (fallback `ip domain-name`),
`src/network/devices/shells/CiscoSwitchShell.ts` (commandes + rendu).

### Validation

- Cluster « Management Plane » : **8 → 3** ; `other-commands` global :
  **24 → 19**. `command-trie-hygiene` 2/2 (aucun nouveau doublon).
- Non-régression : `switch-cli`, `cisco-switch-reference-scenarios`,
  `cisco-router-operational-show`, `cisco-interface-description` = **83 verts**.

### Limites connues (cluster AAA/VTY à traiter ensemble)

- **81 / 87 / 98** (avertissement `login` sans mot de passe ; rejet des
  connexions SSH/Telnet entrantes selon la config VTY + sous-réseau SVI) et
  **44** (base de comptes locaux préservée au reload) nécessitent un vrai
  modèle d'authentification VTY/AAA entrante côté switch — fonctionnalité
  distincte, prochain incrément.

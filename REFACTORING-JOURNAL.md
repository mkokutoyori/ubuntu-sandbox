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

# Journal de bord — Refactoring de la pile « PC » (EndHost / LinuxMachine / WindowsPC)

Ce journal documente les défaillances structurelles et les écarts de réalisme
identifiés dans la simulation des PCs, ainsi que les corrections apportées.
Chaque entrée correspond à un lot livré (un commit/push par lot).

Conventions :
- **Défaillance** : description du problème (architecture, duplication, réalisme).
- **Correction** : ce qui a été fait, avec les fichiers touchés.
- **Référence** : norme/RFC ou comportement réel de référence.

---

## État des lieux initial (audit du 2026-06-09)

### D1 — Aucune voie de livraison UDP sur les hôtes finaux
`EndHost.handleIPv4()` (src/network/devices/EndHost.ts) ne délivre que deux
protocoles aux couches supérieures : ICMP et TCP. **Tout datagramme UDP adressé
à un PC est silencieusement détruit.** Conséquences :
- Aucun service UDP réel ne peut tourner sur un hôte (DNS, NTP, syslog…).
- Un vrai hôte répond *ICMP Destination Unreachable (type 3, code 3 — Port
  Unreachable)* quand aucun socket n'écoute (RFC 1122 §4.1.3.1) ; ici, rien.
- La `SocketTable` existe mais n'est qu'un registre comptable pour
  `netstat`/`ss` — elle ne livre aucune donnée.

### D2 — Résolution DNS « god-mode » (hors réseau)
`findDnsServerByIP()` (src/network/devices/linux/LinuxDnsService.ts:151)
parcourt le registre global d'équipements et interroge **directement l'objet
`DnsService` du serveur en mémoire**. Aucun paquet UDP/53, pas d'ARP, pas de
routage. `dig`, `nslookup`, `host` (Linux et Windows) « fonctionnent » même si
le câble est débranché ou si un pare-feu bloque le port 53. Le commentaire
d'en-tête du fichier l'assume explicitement.

### D3 — DHCP « god-mode » (appels directs au serveur)
`DHCPClient.requestLease()` (src/network/dhcp/DHCPClient.ts) appelle
`server.processDiscover()` directement sur l'objet serveur, sans trame
broadcast UDP 67/68. Pire : sans serveur connecté, un bail fictif est
auto-assigné (« simulator convenience »). DORA n'existe que nominalement.

### D4 — Duplication LinuxMachine / WindowsPC
Les deux classes réimplémentent côte à côte : câblage SSH
(`runSshCommand` + `CrossVendorSshHost`), gestion des sessions shell
(`shellSessions` + file d'exécution sérialisée), synchronisation du fichier
hosts, découpage de lignes de commande. À factoriser dans `devices/host/`.

### D5 — Classes-Dieu
`EndHost.ts` (~2470 lignes) cumule ARP, NDP, ICMP/v6, routage, forwarding,
ping, traceroute, files d'attente. `WindowsPC.ts` (~1980 lignes) mélange
shell cmd, parsing, redirections, et une vingtaine de commandes inline.

*(Audit complété au fil des lots ci-dessous.)*

---

## Lot 1 — Pile UDP réelle sur les hôtes (RFC 768 / RFC 1122)

**Défaillance corrigée : D1.**

Avant : tout datagramme UDP adressé à un PC était jeté en silence
(`handleIPv4` ne connaissait que ICMP et TCP). Aucun service UDP ne pouvait
exister sur un hôte, et aucune erreur ICMP n'était renvoyée.

**Correction :**
- Nouveau module `src/network/udp/` (`UdpStack.ts`, `events.ts`) calqué sur
  l'architecture de `TcpStack` (host adapter + événements de bus typés
  `udp.datagram.sent/received/dropped`, `udp.listener.changed`).
- Contrairement à `TcpStack` (qui balaie naïvement les sous-réseaux des
  ports), `UdpStack` délègue le routage à la **vraie table de routage** de
  l'hôte (`EndHost.resolveRoute`, longest-prefix match + passerelle par
  défaut) et la résolution du next-hop au **résolveur ARP asynchrone**
  existant. Les datagrammes traversent donc le réseau simulé trame par trame.
- `EndHost.handleIPv4` délivre désormais l'UDP aux listeners ; quand aucun
  socket n'écoute, l'hôte répond *ICMP Destination Unreachable code 3 (Port
  Unreachable)* conformément à la RFC 1122 §4.1.3.1 — et ne répond jamais
  pour un broadcast (RFC 1122 §3.2.2).
- `sendICMPReject` (code 13 en dur) généralisé en
  `sendICMPDestinationUnreachable(port, paquet, code)` ; les codes ICMP de
  type 3 sont désormais des constantes nommées dans `core/types.ts`
  (suppression d'un magic number).
- Ports éphémères alloués dans la plage RFC 6335 (49152–65535) ;
  `EADDRINUSE` sur double bind ; broadcast limité (255.255.255.255) et
  broadcast de sous-réseau gérés sans ARP (MAC broadcast), RFC 919.

**Fichiers :** `src/network/udp/UdpStack.ts`, `src/network/udp/events.ts`,
`src/network/devices/EndHost.ts`, `src/network/core/types.ts`,
`src/events/types.ts` (enregistrement des événements UDP).

**Tests :** `src/__tests__/unit/network-v2/udp-stack.test.ts` (7 cas :
livraison à travers un switch, requête/réponse, port fermé → ICMP code 3
observé côté émetteur, absence de route, broadcast vers plusieurs hôtes sans
erreurs ICMP, EADDRINUSE + libération, ports éphémères distincts).
Non-régression : 252 fichiers / 6571 tests network-v2 passent.

**Prépare :** le Lot 2 (DNS réel sur UDP/53) et, à terme, la migration de
DHCP vers de vraies trames broadcast UDP 67/68.

---

## Lot 2 — Résolution DNS par le vrai réseau (UDP/53)

**Défaillance corrigée : D2.**

Avant : `dig`, `nslookup`, `host` (Linux **et** Windows) et la résolution de
noms de `ping`/`traceroute`/`tracert` interrogeaient **directement l'objet
`DnsService` du serveur en mémoire** via `findDnsServerByIP()` (parcours du
registre global d'équipements). La résolution « fonctionnait » câble
débranché, démon arrêté, sans route ni ARP.

**Correction :**
- Nouveau module protocole `src/network/dns/` (pattern des autres protocoles) :
  - `types.ts` — messages filaires (`DnsQueryMessage`/`DnsResponseMessage`,
    transaction ID RFC 1035 §4.1.1, rcodes symboliques `NOERROR`/`NXDOMAIN`/…).
  - `DnsServerEndpoint.ts` — lie la base d'enregistrements (le `DnsService`
    dnsmasq existant, conservé tel quel) au port UDP/53 de l'hôte. Démarré /
    arrêté en phase avec le cycle de vie du démon (`DnsService.onStateChange`,
    nouveau hook observer) ; la `SocketTable` est synchronisée pour que
    `ss`/`netstat` montrent udp/53.
  - `DnsClient.ts` — stub resolver asynchrone : requête UDP/53 réelle
    (routage + ARP + trames), corrélation par transaction ID, timeout via
    scheduler, détection « connection refused » par l'erreur ICMP Port
    Unreachable renvoyée quand le démon est arrêté.
- **Un seul client pour les deux OS** : `EndHost.getDnsClient()` (lazy) —
  supprime la duplication de la logique de résolution entre `LinuxMachine`
  et `WindowsPC`.
- `executeDig`/`executeNslookup`/`executeHost` deviennent asynchrones et
  reçoivent une fonction `DnsLookup` injectée (inversion de dépendance —
  testable sans topologie). `findDnsServerByIP()` est **supprimé**.
- `LinuxNetKernel.resolveHostname` et `WinCommandContext.resolveHostname`
  deviennent asynchrones ; ordre NSS préservé (IP littérale → fichier hosts →
  DNS), et le resolver Linux lit désormais **tous** les `nameserver` de
  `/etc/resolv.conf` dans l'ordre (avant : seulement le premier).
- Sémantique RFC 2308 côté serveur : nom inexistant → `NXDOMAIN` ; nom
  existant sans enregistrement du type demandé → `NOERROR` réponse vide.
- Correction au passage : `nslookup domaine serveur` ignore maintenant le
  resolver configuré quand un serveur explicite est donné (comportement réel ;
  l'ancien code ne permettait pas de surcharger le serveur).

**Comportements réels gagnés :** dig vers un serveur dont le démon est coupé →
« connection refused » (via ICMP type 3 code 3) ; câble débranché → timeout
réel ; serveur sans route → échec ; le trafic DNS est visible comme trames
UDP sur le réseau simulé.

**Fichiers :** `src/network/dns/{types,DnsClient,DnsServerEndpoint}.ts`,
`LinuxDnsService.ts` (réécrit), `EndHost.ts`, `LinuxMachine.ts`,
`WindowsPC.ts`, `LinuxNetKernel.ts`, `LinuxCommandContext.ts`,
`commands/dns/{Dig,Nslookup,Host}.ts`, `commands/net/{Ping,Traceroute}.ts`,
`windows/{WinPing,WinTracert,WinCommandExecutor}.ts`.

**Tests :** nouveau `dns-over-udp.test.ts` (8 cas de réalisme) ; la suite TDD
existante `nslookup-skeleton1.test.ts` (44 cas) passe sans modification sur le
nouveau chemin réseau ; `hosts-file.test.ts` adapté à l'API asynchrone.

**Limites restantes (documentées, non corrigées dans ce lot) :**
- `DnsNssSource` (getent) parcourt encore le registre d'équipements — choix
  documenté dans son en-tête pour simuler un LAN auto-résolu.
- DHCP (D3) reste en god-mode — prochain chantier potentiel.

---

## Lot 3 — Déduplication du protocole de sessions shell (D4 partiel)

**Défaillance corrigée :** `LinuxMachine` et `WindowsPC` réimplémentaient
chacun, à l'identique, deux mécanismes délicats :
1. la **file d'exécution sérialisée** par device (chaînage
   `tail.then(run, run)` + `catch` pour ne jamais bloquer la file après un
   échec) — toute divergence entre les deux copies aurait créé des courses
   d'état entre terminaux ;
2. la **fenêtre de swap** snapshot → swapIn → tâche → capture (succès
   uniquement) → restore (toujours), dupliquée dans 7 méthodes
   (`executeCommandInSession`, `runInSession`, `getCompletionsForSession` ×2,
   `handleExitInSession`, `startTailFollowInSession`, …).

**Correction :** extraction dans `src/network/devices/host/session/` :
- `SessionWorkQueue` — FIFO par device, isolation des rejets.
- `SessionSwapWindow<TSession, TSnapshot>` — protocole générique de swap ;
  la connaissance OS (état executor Linux vs cwd/env Windows) est injectée
  via `SessionSwapProtocol` (Strategy/DIP). Option `capture: false` pour les
  fenêtres en lecture seule (complétion tab, attache tail -f).
- Les 7 méthodes des deux classes deviennent des compositions d'une ligne :
  `sessionQueue.run(() => sessionSwap.within(session, tâche))`. Les gardes
  métier (`isPoweredOn`, `session.disposed`) restent au niveau device.

**Tests :** `session-swap.test.ts` (6 cas : ordre FIFO strict, isolation des
rejets, capture sur succès, pas de capture sur exception, restore garanti,
fenêtres lecture seule). Non-régression : 58 fichiers terminal/terminal-core
(450 tests), 22 fichiers shell/SSH (539 tests) — seul échec restant :
préexistant sur main (`duplicate-display-fixes`, indépendant).

---

## Lot 4 — Décomposition de la god-class WindowsPC (D5 partiel) + bug runas

**Défaillances corrigées :**
1. `WindowsPC.ts` mélangeait le device réseau et ~430 lignes
   d'implémentations de commandes cmd.exe inline (`systeminfo`, `doskey`,
   `vol`, `chcp`, `date`, `time`, `start`, `setx`, `schtasks`, `nbtstat`,
   `wmic`, `reg`), en violation du pattern établi par le projet lui-même
   (`WinPing.ts`, `WinTracert.ts`, `WinIpconfig.ts`… = un module par
   commande avec un contexte étroit injecté).
2. **Bug de réalisme `runas`** : après `runas /user:X cmd`, le shell
   appelant **restait commuté sur l'utilisateur X** (le code l'assumait :
   « user stays switched for simplicity »), avec en prime un cast
   `as unknown as string` masquant une Promise non attendue. Sur un vrai
   Windows, runas lance le programme dans une session de logon séparée et
   le shell appelant garde son identité.

**Correction :**
- Nouveau `windows/WinSystemCommands.ts` : 11 commandes systèmes en
  fonctions pures sur un `WinSystemContext` étroit (hostname, identité OS,
  hardware, lifecycle, doskey, scheduledTasks, process manager…) —
  testables sans instance `WindowsPC`.
- Nouveau `windows/WinRegCommand.ts` : `reg query|add|delete` +
  formatage reg.exe, dépendant uniquement de l'interface
  `WinRegistryProvider` (pont vers le provider registre PowerShell).
- `WindowsPC` garde des délégations d'une ligne (les 18 sites de dispatch
  inchangés) et passe de ~1996 à ~1734 lignes.
- `cmdRunas` : exécution sous l'identité cible puis **restauration
  systématique** de l'utilisateur appelant (`try/finally`), signature
  `async` honnête.

**Tests :** 439 tests Windows/host (8 fichiers ciblés) + 1881 tests
PowerShell passent ; seuls les 9 échecs DateTime préexistants sur main
subsistent.

---

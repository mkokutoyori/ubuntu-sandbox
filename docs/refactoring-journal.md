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

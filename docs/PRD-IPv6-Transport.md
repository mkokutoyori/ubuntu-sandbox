# PRD — Couche transport IPv6 (UDP6 / TCP6 sur le plan de données existant)

**Version** : 1.0
**Date** : 2026-07-02
**Projet** : Ubuntu Sandbox — Pile IPv6
**Auteur** : Claude Code
**Références normatives** : RFC 8200 (IPv6), RFC 4443 (ICMPv6), RFC 4861 (NDP), RFC 8085 (UDP usage guidelines), RFC 9293 (TCP), RFC 5382 (TCP over IPv6 NAT), RFC 3986 §3.2.2 (adresses littérales IPv6)

---

## 0. Contexte et portée du document

Ce PRD couvre **uniquement la couche transport IPv6** — l'acheminement des datagrammes
UDP et des segments TCP au-dessus du plan de données IPv6 qui existe déjà (livraison L3,
ICMPv6, NDP, forwarding routeur). Il ne réécrit ni le modèle d'adresse `IPv6Address`, ni
le cache de voisins NDP, ni le forwarding du routeur : ces briques sont réutilisées
telles quelles. L'objectif est de fermer le dernier trou de la pile IPv6 — l'absence de
L4 — pour que **tout échange applicatif IPv6 passe par de vrais paquets sur le fil**,
supprimant le court-circuit `tcpProbeSyncIPv6` qui lit aujourd'hui l'état interne du pair
via le registre d'équipements.

Aucune ligne de code de production n'est écrite dans le cadre de ce document ; il sert de
base à la planification et à la revue avant le premier commit TDD.

---

## 1. Analyse de l'existant

### 1.1 Inventaire de la pile IPv6 actuelle

| Fichier | Rôle actuel | État |
|---|---|---|
| `src/network/core/types.ts` — `IPv6Address` | Adresse 128 bits : parsing, compression `::`, link-local / multicast / solicited-node, sous-réseau | Complet |
| `src/network/core/types.ts` — `IPv6Packet`, `createIPv6Packet` | En-tête RFC 8200 (nextHeader, hopLimit) | Complet |
| `src/network/devices/host/NeighborCache.ts` | Machine à états NDP (INCOMPLETE→REACHABLE→STALE→DELAY→PROBE) RFC 4861 | Complet |
| `src/network/devices/EndHost.ts` — `handleIPv6` | Réception L3 : accepte unicast/multicast/loopback, **ne dispatche que ICMPv6** | Partiel — commentaire `// Future: TCP, UDP dispatch here` |
| `src/network/devices/EndHost.ts` — ICMPv6 | Echo request/reply (`ping6`), NS/NA, RA/RS, erreurs | Complet, sur le fil |
| `src/network/devices/EndHost.ts` — `resolveNDP` | Résolution voisin asynchrone (NS multicast → attente `host.ndp.entry-learned`) | Complet, sur le fil |
| `src/network/devices/EndHost.ts` — `resolveIPv6Route` | Longest-prefix match sur `ipv6RoutingTable` | Complet |
| `src/network/devices/router/IPv6DataPlane.ts` | Forwarding IPv6 routeur, NDP proxy, RA/RS | Complet, sur le fil |
| `src/network/tcp/TcpStack.ts` | Pile TCP RFC 9293 complète — **IPv4 uniquement** (`handleIp(IPv4Packet)`, `resolveEgress` IPv4) | À étendre |
| `src/network/devices/EndHost.ts` — `sendUdpDatagram` / `deliverUDP` | Chemin UDP complet — **IPv4 uniquement** | À dupliquer proprement pour IPv6 |
| `src/network/devices/EndHost.ts` — `tcpProbeSyncIPv6` | Sonde de port IPv6 : **court-circuit** — lit `socketTable` + `ip6tables` du pair via le registre | À remplacer par un vrai handshake |

### 1.2 Ce qui existe déjà et est réutilisable (aucune réécriture)

- La **livraison L3 IPv6** est réelle : `handleFrame` reconnaît `ETHERTYPE_IPV6`, vérifie
  l'appartenance de l'adresse de destination et l'abonnement multicast, puis appelle
  `handleIPv6`. Il suffit d'y brancher le dispatch UDP (nextHeader 17) et TCP (nextHeader 6).
- La **résolution de voisin NDP** (`resolveNDP`) est le pendant exact de `resolveARP` :
  elle envoie une Neighbor Solicitation multicast sur le fil et attend l'apprentissage.
  Le chemin d'émission IPv6 s'appuiera dessus, comme `sendUdpDatagram` s'appuie sur ARP.
- Le **forwarding routeur** (`IPv6DataPlane.forwardPacket`) achemine déjà les paquets IPv6
  entre segments : un datagramme UDP6 ou un segment TCP6 encapsulé dans un `IPv6Packet`
  traversera les routeurs sans modification du routeur.
- La **pile TCP** (`TcpStack`) est une implémentation RFC 9293 complète et testée
  (handshake, retransmission, TIME-WAIT). Sa logique d'états est agnostique de la version
  IP ; seules les frontières d'entrée/sortie (`handleIp`, `resolveEgress`, `shipSegment`)
  sont couplées à IPv4.

### 1.3 Ce qui manque ou court-circuite (gap analysis)

| # | Manque | Conséquence observable | Sévérité |
|---|---|---|---|
| 1 | Aucun dispatch UDP dans `handleIPv6` | Un service UDP (DNS, etc.) écoutant sur une adresse IPv6 ne reçoit jamais rien | Bloquant |
| 2 | Aucun chemin d'émission UDP6 (`sendUdpDatagram` est IPv4-only) | Un client ne peut pas émettre un datagramme UDP vers une destination IPv6 | Bloquant |
| 3 | `TcpStack` est IPv4-only | Aucune connexion TCP IPv6 possible ; `ssh -6`, `nc -6`, `curl -6` ne peuvent pas établir de session | Bloquant |
| 4 | `tcpProbeSyncIPv6` lit `socketTable`/`ip6tables` du pair via le registre | **Court-circuit** : le résultat du scan de port IPv6 ne dépend ni du câblage, ni du routage, ni du pare-feu réel — contrairement à IPv4 (déjà corrigé) | Élevée |
| 5 | Pas de délivrance ICMPv6 « port unreachable » pour un datagramme UDP6 sans listener | Un `nc -6 -u` vers un port fermé ne se comporte pas comme un vrai hôte (RFC 4443 §3.1) | Moyenne |
| 6 | Le checksum UDP/TCP IPv6 est **obligatoire** (pseudo-en-tête IPv6, RFC 8200 §8.1) alors que le simulateur ne calcule pas de checksum L4 IPv6 | Fidélité de capture (tcpdump) incomplète pour IPv6 | Faible |

**Conclusion de la phase d'analyse** : la pile IPv6 est complète jusqu'à L3 inclus
(adressage, NDP, ICMPv6, forwarding) et échange de vrais paquets sur le fil. Le seul étage
manquant est **L4**. L'implémenter en réutilisant le plan de données existant (a)
supprime le court-circuit `tcpProbeSyncIPv6`, (b) apporte UDP6/TCP6 aux applications, et
(c) reste petit et sûr car il ne touche ni l'adressage, ni NDP, ni le forwarding.

---

## 2. Objectifs

### 2.1 Objectifs (ce PRD)

1. **Dual-stack au niveau paquet** : `handleIPv6` dispatche les next-headers UDP (17) et
   TCP (6) exactement comme `deliverUDP`/`TcpStack.handleIp` le font pour IPv4.
2. **Émission UDP6** : un `sendUdpDatagram6(dst: IPv6Address, …)` symétrique de
   `sendUdpDatagram`, qui résout la route IPv6 (`resolveIPv6Route`), le voisin (`resolveNDP`),
   applique le pare-feu `ip6tables` sur la chaîne OUTPUT, et émet une vraie trame.
3. **TCP6** : rendre `TcpStack` agnostique de la version IP à ses frontières, de sorte
   qu'une connexion puisse s'établir sur une adresse IPv6 via le même code d'états RFC 9293.
4. **Suppression du court-circuit** : réécrire `tcpProbeSyncIPv6` pour qu'il fasse un vrai
   `connect()` IPv6 sur le fil (handshake réel), et lise le verdict depuis le réseau —
   filtré (drop pare-feu) vs fermé (RST/ICMPv6) vs ouvert — sans jamais inspecter l'état
   interne du pair.
5. **ICMPv6 port unreachable** (RFC 4443 §3.1 code 4) pour un datagramme UDP6 arrivant sur
   un port sans listener, comme `deliverUDP` le fait déjà en IPv4.
6. **Checksum L4 IPv6** avec pseudo-en-tête (RFC 8200 §8.1) calculé et vérifié, pour la
   fidélité des captures.

### 2.2 Non-objectifs (hors périmètre)

- Réécriture de NDP, de l'autoconfiguration SLAAC, ou du forwarding routeur (déjà en place).
- Fragmentation IPv6 / Path MTU Discovery (RFC 8201) — les datagrammes du simulateur
  restent sous la MTU ; à documenter comme limite connue.
- Extension headers IPv6 (Routing, Hop-by-Hop, Fragment) au-delà de ce que le forwarding
  gère déjà.
- NAT66 / NPTv6, IPsec sur IPv6 — non demandés.
- Migration des applications vers IPv6 par défaut : les commandes gardent leur sélection
  de famille explicite (`-6`, adresse littérale, `AAAA`).

---

## 3. Architecture cible

### 3.1 Principe directeur

**Aucune duplication de la logique de transport.** La pile TCP RFC 9293 reste unique ;
on ne crée pas un « TcpStack6 » parallèle. On abstrait la version IP aux **trois
frontières** de `TcpStack` (réception d'un paquet, résolution d'egress, expédition d'un
segment) derrière une petite interface `L3Endpoint`, et le socket porte sa famille
d'adresse. De même, le chemin UDP factorise la partie commune (construction du datagramme,
dispatch au listener) et ne spécialise que l'encapsulation L3.

### 3.2 Diagramme de couches

```
+---------------------------------------------------------------------+
|         APPLICATIONS (nc -6, ssh -6, curl -6, dig AAAA, ping6)       |
+----------------------------+----------------------------------------+
                             | sockets (famille AF_INET / AF_INET6)
+----------------------------v----------------------------------------+
|                    COUCHE TRANSPORT (partagée)                       |
|  TcpStack (RFC 9293, agnostique IP via L3Endpoint)                   |
|  UDP : sendUdpDatagram / sendUdpDatagram6 → deliverUDP (commun)      |
|  Checksum L4 avec pseudo-en-tête (IPv4 ou IPv6)                      |
+--------+----------------------------------------+-------------------+
         |                                        |
+--------v---------------+            +-----------v-------------------+
|  L3 IPv4 (existant)    |            |  L3 IPv6 (existant)           |
|  createIPv4Packet      |            |  createIPv6Packet             |
|  resolveRoute + ARP    |            |  resolveIPv6Route + resolveNDP|
+--------+---------------+            +-----------+-------------------+
         |                                        |
+--------v----------------------------------------v-------------------+
|      L2 / PLAN PHYSIQUE (câbles, switches, routeurs, pare-feux)      |
|      ETHERTYPE_IPV4 / ETHERTYPE_IPV6 — inchangé                      |
+---------------------------------------------------------------------+
```

### 3.3 Abstraction `L3Endpoint` (cœur de la non-duplication TCP)

`TcpStack` ne connaît aujourd'hui qu'IPv4. On introduit une interface que l'hôte
implémente pour les deux familles :

```
interface L3Endpoint {
  family: 'ipv4' | 'ipv6';
  localAddressFor(remoteIp: string): string | null;   // egress source
  ship(srcIp: string, dstIp: string, segment: TcpSegment): void; // encapsule + émet
}
```

`TcpSocket` gagne un champ `family` (déduit de l'adresse distante). `TcpStack.transmit`
choisit l'endpoint selon la famille du socket ; `handleIp` devient `handleSegment(srcIp,
dstIp, segment, family)` appelé depuis **deux** points de réception (`deliverIPv4` TCP et
le nouveau `deliverIPv6` TCP). La machine à états RFC 9293 ne bouge pas.

### 3.4 Modules touchés (aucun nouveau fichier « parallèle »)

```
src/network/tcp/TcpStack.ts        # frontières IP-agnostiques (L3Endpoint), socket.family
src/network/tcp/types.ts           # computeTcpChecksum : pseudo-en-tête v4 OU v6
src/network/devices/EndHost.ts     # handleIPv6 → dispatch UDP/TCP ; sendUdpDatagram6 ;
                                    #   deliverUDP commun v4/v6 ; tcpProbeSyncIPv6 réécrit ;
                                    #   tcpConnectOutcome6 ; ICMPv6 port-unreachable
src/network/core/types.ts          # createUDPv6 checksum pseudo-header (helper partagé)
```

### 3.5 Design patterns retenus

| Pattern | Usage | Justification |
|---|---|---|
| **Strategy** | `L3Endpoint` (v4 / v6) derrière une interface unique | Une seule pile TCP, deux encapsulations — zéro duplication de la machine à états |
| **Template Method** | `deliverUDP` commun, seule l'étape « source/encapsulation L3 » varie | Le dispatch au listener et l'ICMP port-unreachable sont identiques v4/v6 |
| **Adapter** | L'hôte adapte `resolveIPv6Route`+`resolveNDP` au contrat `L3Endpoint` | Réutilise le NDP et le routage existants sans les modifier |

---

## 4. Modèle de données

### 4.1 Pseudo-en-tête de checksum (RFC 8200 §8.1)

Le checksum UDP/TCP couvre un pseudo-en-tête dépendant de la version :

```
IPv4 (RFC 793) : src(4) | dst(4) | zero(1) | proto(1) | length(2)
IPv6 (RFC 8200): src(16) | dst(16) | length(4) | zero(3) | nextHeader(1)
```

`computeTcpChecksum(segment, srcIp, dstIp)` et l'équivalent UDP détectent la famille à
partir du format de l'adresse et appliquent le bon pseudo-en-tête. En IPv6 le checksum
UDP est **obligatoire** (pas de valeur 0 « désactivé »).

### 4.2 Famille portée par le socket

`TcpSocket.family: 'ipv4' | 'ipv6'` est fixé à la création (`connect`/`accept`) d'après
l'adresse distante. `SocketTable` distingue déjà `localAddress` : une entrée `::`/`0.0.0.0`
en LISTEN accepte respectivement l'IPv6/l'IPv4 ; un listener dual-stack `::` accepte les
deux (comportement Linux `bindv6only=0`, documenté comme choix).

---

## 5. Plan de mise en œuvre (TDD, par phases)

Chaque phase suit la méthode du projet : test d'abord (scénario réel sur un LAN simulé
avec de vrais `LinuxServer`/`LinuxPC`/`CiscoRouter`/`GenericSwitch`, câblage réel, adresses
IPv6, aucun mock du transport), puis implémentation jusqu'au vert, puis régression avant
commit. Aucun stub, aucun commentaire dans le code de production, aucune duplication.

| Phase | Contenu | RFC | Sortie testable |
|---|---|---|---|
| **1** | Checksum L4 avec pseudo-en-tête IPv6 (`computeTcpChecksum`/UDP) | RFC 8200 §8.1 | Round-trip checksum v6 correct ; un segment altéré est rejeté |
| **2** | UDP6 : dispatch dans `handleIPv6`, `sendUdpDatagram6`, `deliverUDP` commun, ICMPv6 port-unreachable | RFC 8200, RFC 4443 §3.1 | Sur un LAN IPv6 réel, un datagramme UDP6 atteint un listener `udpBind` ; un port fermé émet ICMPv6 code 4 |
| **3** | TCP6 : `L3Endpoint`, `socket.family`, `handleSegment` appelé depuis le chemin IPv6, `shipSegment` v6 | RFC 9293 | Handshake SYN/SYN-ACK/ACK réel entre deux hôtes sur adresses IPv6 ; données échangées puis FIN propre |
| **4** | Suppression du court-circuit : `tcpProbeSyncIPv6` via vrai `connect()`, `tcpConnectOutcome6` (open/refused/timeout lu du fil) | RFC 4443 | `nmap -6` / `nc -6 -z` : port ouvert ssi listener joignable ; un `ip6tables DROP` donne « filtered » ; câble débranché donne timeout |
| **5** | Intégration applicative : `nc -6`, `ss -6` reflètent les vraies sockets IPv6, `dig` AAAA de bout en bout sur IPv6, `ssh -6` établit une session | RFC 9293 | Une session interactive complète (ex. SSH) sur IPv6 à travers un routeur |
| **6** | Nettoyage : retirer les lectures d'état pair restantes en IPv6, vérifier l'absence de duplication (pile TCP unique), régression complète | — | Suite existante (ping6/NDP/ICMPv6, IPv4 TCP/UDP) toujours verte |

La phase 4 est l'objectif central : **plus aucune décision de bout en bout ne doit
dépendre de la lecture de l'état interne d'un autre équipement** — tout passe par des
paquets sur le fil, comme IPv4.

---

## 6. Stratégie de test

- **TDD strict** : topologie IPv6 réelle (deux hôtes sur un switch, puis deux segments de
  part et d'autre d'un routeur IPv6) avant toute ligne de production.
- **Parité v4/v6** : chaque comportement IPv4 déjà couvert (livraison UDP, port
  unreachable, handshake TCP, verdict connect ouvert/refusé/filtré) obtient un test IPv6
  jumeau, garantissant l'absence de régression de sémantique entre familles.
- **Tests négatifs** : `ip6tables` DROP sur INPUT/OUTPUT, câble débranché, interface
  `shutdown`, port sans listener, hop-limit expiré — chaque cas doit produire le même
  type d'observable qu'en IPv4 (timeout, refused, filtered) **sans** lire l'état du pair.
- **Anti-court-circuit** : un test dédié vérifie que le verdict d'un scan de port IPv6
  change quand on coupe le câble ou qu'on ajoute une règle pare-feu — impossible à
  satisfaire avec l'ancienne lecture directe du `socketTable`.
- **Non-régression** : la suite IPv6 existante (ping6, NDP, ICMPv6, RA/RS) et toute la
  suite IPv4 TCP/UDP servent de golden master.

---

## 7. Risques et points d'attention

1. **Couplage IPv4 dans `TcpStack`** : le risque principal est d'introduire une régression
   IPv4 en abstrayant les frontières. Mitigation : l'abstraction `L3Endpoint` est
   introduite d'abord pour IPv4 seul (refactor à comportement constant, suite TCP verte),
   puis l'implémentation IPv6 est ajoutée — jamais les deux d'un coup.
2. **Dual-stack `::` vs `0.0.0.0`** : la sémantique d'un listener wildcard doit être
   décidée explicitement (un `::` accepte-t-il l'IPv4 mappé ?). Choix retenu : pas d'IPv4
   mappé (`bindv6only=1` implicite), plus simple et sans ambiguïté ; documenté.
3. **Duplication UDP** : tentation de copier `sendUdpDatagram`. Mitigation : extraire la
   partie commune (datagramme + dispatch + ICMP unreachable) et ne spécialiser que
   l'encapsulation L3, conformément à l'exigence « pas de duplication ».
4. **Checksum** : un pseudo-en-tête IPv6 erroné casserait les captures tcpdump v6.
   Mitigation : vecteurs de test de checksum en phase 1, avant tout usage transport.

---

## 8. Suite prévue

Une fois L4 IPv6 livré, les extensions naturelles (hors de ce PRD) : SLAAC complet côté
hôte, DNS AAAA de bout en bout comme scénario par défaut, `ip6tables` stateful (conntrack
IPv6), et Path MTU Discovery. Chacune consommera la couche transport de ce PRD sans la
dupliquer.

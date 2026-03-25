# BRD — Protocoles ICMP et ARP (Simulateur Réseau)

**Version** : 1.0
**Date** : 2026-03-25
**Projet** : Ubuntu Sandbox — Module Réseau (Couches L2/L3)
**Auteur** : Claude Code
**Standards de référence** :
- ARP : RFC 826 (An Ethernet Address Resolution Protocol), RFC 1122 (Requirements for Internet Hosts), RFC 5227 (IPv4 Address Conflict Detection)
- ICMP : RFC 792 (Internet Control Message Protocol), RFC 1122 (Requirements for Internet Hosts), RFC 1191 (Path MTU Discovery), RFC 4443 (ICMPv6 — référence comparative)

---

## Résumé d'Avancement

| Phase | Description | Statut | Couverture |
|-------|-------------|--------|------------|
| Phase 1 | Structures de données et types fondamentaux | ✅ COMPLETE | 6/6 |
| Phase 2 | ARP — Résolution d'adresses (RFC 826) | ✅ COMPLETE | 7/10 |
| Phase 3 | ICMP — Messages de contrôle (RFC 792) | ✅ COMPLETE | 6/10 |
| Phase 4 | Commandes CLI (ping, arp, traceroute) | ✅ COMPLETE | 9/12 |
| Phase 5 | Intégration multi-vendeur (Cisco, Huawei) | ✅ COMPLETE | 6/8 |
| Phase 6 | Fonctionnalités avancées et conformité RFC | 🟡 PARTIELLE | 3/12 |

**Types ICMP supportés** : 4 types (Echo Request/Reply, Destination Unreachable, Time Exceeded)
**Codes ICMP implémentés** : Code 0 (echo), Code 0 (no route), Code 4 (PMTU), Code 13 (admin prohibited)
**Commandes CLI** : ping (Linux/Windows/Cisco/Huawei), arp (Linux/Windows), traceroute, show arp, display arp, ip neigh
**Tests** : ~25 tests unitaires (ping, ARP learning, static ARP)
**Constantes réseau** : ARP timers (RFC 1122), ICMP timeouts, TTL par OS

**Legende** : ✅ = implemente, 🟡 = partiellement implemente, ❌ = non implemente

---

## 1. Objectif

Implementer une simulation realiste des protocoles ARP (Address Resolution Protocol) et ICMP (Internet Control Message Protocol) au sein du simulateur reseau Ubuntu Sandbox. Ces deux protocoles constituent les fondations de toute communication IP :

- **ARP** (couche 2/3) assure la resolution d'adresses IPv4 en adresses MAC, prerequis indispensable a toute transmission de trames Ethernet sur un reseau local.
- **ICMP** (couche 3) fournit les mecanismes de diagnostic, de signalisation d'erreurs et de controle du plan de donnees IP.

L'implementation doit etre **conforme aux RFC fondateurs** (RFC 826, RFC 792, RFC 1122) tout en restant adaptee au contexte d'un simulateur pedagogique. Les comportements observables (format des messages, timers, codes d'erreur) doivent correspondre a ce qu'un etudiant ou ingenieur reseau observerait sur des equipements reels.

### 1.1 Objectifs pedagogiques

| Objectif | Description |
|----------|-------------|
| Comprendre ARP | Visualiser le processus de resolution MAC, le cache ARP, les broadcasts |
| Comprendre ICMP | Observer les echo request/reply, les erreurs TTL exceeded, les destination unreachable |
| Diagnostiquer | Utiliser `ping`, `traceroute`, `arp -a` comme sur un vrai systeme |
| Multi-vendeur | Pratiquer `show arp` (Cisco), `display arp` (Huawei), `arp -a` (Linux/Windows) |
| Encapsulation | Comprendre l'empilement Ethernet → IPv4 → ICMP et Ethernet → ARP |

---

## 2. Architecture Generale

### 2.1 Positionnement dans le modele OSI

```
┌──────────────────────────────────────────────────────────────┐
│  Couche 7 — Application                                      │
│  (ping CLI, traceroute CLI, arp CLI)                         │
├──────────────────────────────────────────────────────────────┤
│  Couche 4 — Transport                                        │
│  (UDP, TCP — non concerne directement)                       │
├──────────────────────────────────────────────────────────────┤
│  Couche 3 — Reseau                                           │
│  ┌────────────────────────┐  ┌─────────────────────────────┐ │
│  │  IPv4 (RFC 791)        │  │  ICMP (RFC 792)             │ │
│  │  - Routage             │  │  - Echo Request/Reply       │ │
│  │  - Fragmentation (DF)  │  │  - Destination Unreachable  │ │
│  │  - TTL decrement       │  │  - Time Exceeded            │ │
│  └────────────────────────┘  └─────────────────────────────┘ │
├──────────────────────────────────────────────────────────────┤
│  Couche 2.5 — Resolution d'adresses                          │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  ARP (RFC 826)                                          │ │
│  │  - Request (broadcast)  /  Reply (unicast)              │ │
│  │  - Cache avec TTL                                       │ │
│  │  - File d'attente de paquets en attente de resolution   │ │
│  └─────────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────────┤
│  Couche 2 — Liaison de donnees                               │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  Ethernet II (IEEE 802.3)                               │ │
│  │  - EtherType 0x0806 (ARP)                               │ │
│  │  - EtherType 0x0800 (IPv4)                              │ │
│  │  - Adresses MAC source/destination                      │ │
│  └─────────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────────┤
│  Couche 1 — Physique                                         │
│  (Port.ts, Cable.ts — transmission directe device-to-device) │
└──────────────────────────────────────────────────────────────┘
```

### 2.2 Organisation des fichiers

```
src/network/
├── core/
│   ├── types.ts                    # EthernetFrame, IPv4Packet, ARPPacket, ICMPPacket
│   │                               # MACAddress, IPAddress, SubnetMask
│   │                               # ETHERTYPE_ARP (0x0806), ETHERTYPE_IPV4 (0x0800)
│   │                               # IP_PROTO_ICMP (1), IP_PROTO_UDP (17)
│   └── constants.ts                # ARP_TIMERS, ICMP_CONSTANTS, DEFAULT_TTL
│
├── equipment/
│   └── Equipment.ts                # Classe abstraite — handleFrame(), sendFrame()
│
├── hardware/
│   ├── Port.ts                     # Port physique — reception/emission de trames
│   └── Cable.ts                    # Cable — connexion point-a-point entre ports
│
├── devices/
│   ├── EndHost.ts                  # Classe abstraite pour PC/Serveurs
│   │                               #   ├── ARP : table, resolution, request/reply
│   │                               #   ├── ICMP : echo request/reply, error handling
│   │                               #   ├── Ping : executePingSequence()
│   │                               #   └── Traceroute : executeTraceroute()
│   │
│   ├── Router.ts                   # Routeur generique
│   │                               #   ├── ARP : table par interface, resolution
│   │                               #   ├── ICMP : echo reply, error generation
│   │                               #   │         (TTL exceeded, Destination Unreachable, PMTU)
│   │                               #   └── Forwarding : LPM + TTL decrement
│   │
│   ├── LinuxPC.ts                  # PC Linux — commandes ping, arp, traceroute
│   ├── WindowsPC.ts                # PC Windows — ping, arp (format Windows)
│   ├── Hub.ts                      # Hub — flood L1 de toutes les trames (dont ARP)
│   │
│   ├── linux/
│   │   └── LinuxIpCommand.ts       # Commande `ip neigh` (affichage table ARP)
│   │
│   ├── windows/
│   │   ├── WinPing.ts              # Commande `ping` format Windows
│   │   └── WinArp.ts               # Commande `arp` format Windows
│   │
│   └── shells/
│       ├── cisco/
│       │   └── CiscoShowCommands.ts  # `show arp` — format Cisco IOS
│       └── huawei/
│           └── HuaweiDisplayCommands.ts  # `display arp` — format Huawei VRP
│
└── Switch.ts                       # Commutation L2 — flood ARP broadcast,
                                    # apprentissage MAC depuis trames ARP
```

### 2.3 Flux de traitement des trames

```
                    ┌──────────────┐
                    │   Cable.ts   │
                    │  (Couche 1)  │
                    └──────┬───────┘
                           │ EthernetFrame
                    ┌──────▼───────┐
                    │   Port.ts    │
                    │  (Couche 1)  │
                    └──────┬───────┘
                           │ frameHandler callback
                    ┌──────▼───────┐
                    │ Equipment.ts │
                    │ handleFrame()│
                    └──────┬───────┘
                           │ dispatch sur etherType
              ┌────────────┼────────────┐
              │            │            │
     ┌────────▼───┐  ┌─────▼─────┐  ┌──▼──────────┐
     │ 0x0806     │  │ 0x0800    │  │ 0x86dd      │
     │ ARP        │  │ IPv4      │  │ IPv6        │
     │ handleARP()│  │           │  │ (futur)     │
     └────────────┘  └─────┬─────┘  └─────────────┘
                           │ dispatch sur protocol
                    ┌──────┼──────────┐
                    │      │          │
              ┌─────▼──┐ ┌─▼────┐ ┌──▼─────┐
              │ ICMP   │ │ UDP  │ │ TCP    │
              │ (1)    │ │ (17) │ │ (6)    │
              │handleIC│ │      │ │(futur) │
              │MP()    │ │      │ │        │
              └────────┘ └──────┘ └────────┘
```

### 2.4 Hierarchie de classes (traitement ARP/ICMP)

```
Equipment (abstract)
  ├── EndHost (abstract)
  │     ├── arpTable: Map<string, ARPEntry>
  │     ├── pendingARPs: Map<string, PendingARP[]>
  │     ├── pendingPings: Map<string, PendingPing>
  │     ├── handleARP(portName, arpPacket)
  │     ├── handleICMP(portName, ipPacket)
  │     ├── resolveARP(portName, targetIP, timeout): Promise<MACAddress>
  │     ├── sendPing(portName, targetIP, targetMAC, seq, timeout): Promise<PingResult>
  │     ├── executePingSequence(targetIP, count, timeout, ttl): Promise<PingResult[]>
  │     └── executeTraceroute(targetIP, maxHops, timeout): Promise<TracerouteHop[]>
  │           │
  │           ├── LinuxPC
  │           │     ├── cmdPing(args): formatage Linux
  │           │     ├── cmdArp(args): formatage Linux
  │           │     └── cmdTraceroute(args): formatage Linux
  │           │
  │           ├── WindowsPC
  │           │     ├── cmdPing(args): formatage Windows (WinPing.ts)
  │           │     └── cmdArp(args): formatage Windows (WinArp.ts)
  │           │
  │           └── LinuxServer
  │
  ├── Router (abstract — herite aussi de Equipment)
  │     ├── arpTable: Map<string, ARPEntry>
  │     ├── pendingARPs: Map<string, PendingARP[]>
  │     ├── packetQueue: QueuedPacket[]
  │     ├── handleARP(portName, arpPacket)
  │     ├── handleLocalDelivery(inPort, ipPacket)  — ICMP echo reply
  │     ├── sendICMPError(inPort, offendingPkt, type, code, mtu?)
  │     └── executePingSequence(targetIP, count, timeout, sourceIP?)
  │           │
  │           ├── CiscoRouter → shell: show arp
  │           └── HuaweiRouter → shell: display arp
  │
  ├── Switch
  │     └── (pas de traitement ARP/ICMP — flood L2 transparent)
  │
  └── Hub
        └── (flood L1 brut de toutes les trames)
```

---

## 3. Standards RFC de Reference

### 3.1 ARP — RFC 826 (Novembre 1982)

**Titre** : An Ethernet Address Resolution Protocol

**Principe** : ARP permet de determiner l'adresse materielle (MAC 48 bits) d'un hote a partir de son adresse protocolaire (IPv4 32 bits) sur un reseau local Ethernet.

#### 3.1.1 Format du paquet ARP (RFC 826 §3)

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|          Hardware Type        |         Protocol Type         |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
| HW Addr Len   | Proto Addr Len|          Operation            |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                  Sender Hardware Address (6 octets)           |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                  Sender Protocol Address (4 octets)           |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                  Target Hardware Address (6 octets)           |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                  Target Protocol Address (4 octets)           |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

| Champ | Valeur pour Ethernet/IPv4 | Simulation |
|-------|--------------------------|------------|
| Hardware Type | 1 (Ethernet) | Implicite (seul type supporte) |
| Protocol Type | 0x0800 (IPv4) | Implicite |
| HW Addr Len | 6 | Implicite (MACAddress = 6 octets) |
| Proto Addr Len | 4 | Implicite (IPAddress = 4 octets) |
| Operation | 1 (Request) / 2 (Reply) | `ARPOperation: 'request' \| 'reply'` |
| Sender HW Addr | MAC de l'emetteur | `senderMAC: MACAddress` |
| Sender Proto Addr | IP de l'emetteur | `senderIP: IPAddress` |
| Target HW Addr | MAC cible (00:00:00:00:00:00 si request) | `targetMAC: MACAddress` |
| Target Proto Addr | IP cible | `targetIP: IPAddress` |

#### 3.1.2 Algorithme ARP (RFC 826 §3 — Packet Reception)

L'algorithme defini par le RFC 826 lors de la reception d'un paquet ARP :

```
?Est-ce que le couple <protocol type, sender protocol address>
 existe deja dans ma table de traduction ?
  Oui : mettre a jour le champ adresse materielle (Merge_flag = true)
?Est-ce que je suis la cible du protocole (target protocol address) ?
  Oui :
    Si Merge_flag est faux :
      Ajouter le triplet <protocol type, sender proto addr, sender hw addr>
      dans la table de traduction
    Si l'operation est un REQUEST :
      Echanger les champs sender/target
      Mettre mon adresse materielle dans sender hardware address
      Definir l'operation a REPLY
      Envoyer le paquet a la (nouvelle) adresse materielle cible
```

| Etape RFC 826 | Statut | Implementation |
|---------------|--------|----------------|
| Apprentissage depuis tout paquet ARP recu | ✅ | `EndHost.handleARP()` — ligne 511-515 |
| Reponse ARP uniquement si targetIP = notre IP | ✅ | `EndHost.handleARP()` — ligne 517 |
| Mise a jour des entrees existantes | ✅ | `Map.set()` ecrase l'entree precedente |
| Ajout de nouvelles entrees | ✅ | idem |

#### 3.1.3 Exigences RFC 1122 (Requirements for Internet Hosts — §2.3.2)

| Exigence RFC 1122 | Section | Statut | Detail |
|-------------------|---------|--------|--------|
| Cache ARP avec timeout | §2.3.2.1 | 🟡 | TTL defini (4h) mais expiration non appliquee |
| Minimum timeout recommande : 60 secondes | §2.3.2.1 | ✅ | `CACHE_TTL_MS = 14_400_000` (4h) |
| File d'attente de paquets pendant resolution ARP | §2.3.2.2 | ✅ | `fwdQueue[]` avec timeout 5s |
| Ne pas envoyer plus d'une requete par seconde | §2.3.2.1 | 🟡 | Retry interval 1s defini, pas strictement enforce |
| ARP Flood prevention | §2.3.2.1 | ❌ | Pas de rate limiting ARP |
| Gratuitous ARP | §2.3.2.1 | ❌ | Non implemente |
| Proxy ARP | §2.4 | ❌ | Non implemente |

### 3.2 ICMP — RFC 792 (Septembre 1981)

**Titre** : Internet Control Message Protocol

**Principe** : ICMP est un protocole de couche 3 encapsule dans IPv4 (protocol = 1). Il fournit des messages de diagnostic et de signalisation d'erreurs entre equipements IP.

#### 3.2.1 Format general ICMP (RFC 792 §3)

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|     Type      |     Code      |          Checksum             |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                    Type-specific data (4 octets)              |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                    Payload / Original datagram                |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

#### 3.2.2 Types ICMP definis par RFC 792

| Type | Code | Nom | RFC | Statut |
|------|------|-----|-----|--------|
| 0 | 0 | Echo Reply | 792 | ✅ |
| 3 | 0 | Destination Unreachable — Net Unreachable | 792 | ✅ |
| 3 | 1 | Destination Unreachable — Host Unreachable | 792 | ❌ |
| 3 | 2 | Destination Unreachable — Protocol Unreachable | 792 | ❌ |
| 3 | 3 | Destination Unreachable — Port Unreachable | 792 | ❌ |
| 3 | 4 | Destination Unreachable — Fragmentation Needed (DF set) | 792/1191 | ✅ |
| 3 | 5 | Destination Unreachable — Source Route Failed | 792 | ❌ |
| 3 | 6 | Destination Unreachable — Destination Network Unknown | 792 | ❌ |
| 3 | 7 | Destination Unreachable — Destination Host Unknown | 792 | ❌ |
| 3 | 13 | Destination Unreachable — Communication Administratively Prohibited | 1812 | ✅ |
| 4 | 0 | Source Quench (deprecie) | 792 | ❌ |
| 5 | 0 | Redirect — Network | 792 | ❌ |
| 5 | 1 | Redirect — Host | 792 | ❌ |
| 8 | 0 | Echo Request | 792 | ✅ |
| 11 | 0 | Time Exceeded — TTL exceeded in transit | 792 | ✅ |
| 11 | 1 | Time Exceeded — Fragment reassembly time exceeded | 792 | ❌ |
| 13/14 | 0 | Timestamp Request/Reply | 792 | ❌ |
| 15/16 | 0 | Information Request/Reply (obsolete) | 792 | ❌ |
| 17/18 | 0 | Address Mask Request/Reply | 950 | ❌ |

#### 3.2.3 Format Echo Request/Reply (RFC 792 — Type 8/0)

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|   Type (8/0)  |   Code (0)    |          Checksum             |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|           Identifier          |        Sequence Number        |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|     Data ...                                                  |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

| Champ RFC | Simulation | Mapping TypeScript |
|-----------|------------|-------------------|
| Type | 8 (request) / 0 (reply) | `icmpType: 'echo-request' \| 'echo-reply'` |
| Code | 0 | `code: 0` |
| Checksum | Calcule sur le message ICMP | Non simule (pas de corruption) |
| Identifier | Identifiant pour appariement requete/reponse | `id: number` |
| Sequence Number | Numero de sequence incrementant | `sequence: number` |
| Data | Donnees arbitraires (56 octets par defaut) | `dataSize: number` |

#### 3.2.4 Format Destination Unreachable (RFC 792 — Type 3)

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|   Type (3)    |     Code      |          Checksum             |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|            unused             |         Next-Hop MTU          |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|      IP Header + 64 bits of Original Data Datagram            |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

| Champ | Simulation | Statut |
|-------|------------|--------|
| Next-Hop MTU (Code 4 uniquement, RFC 1191) | `mtu?: number` | ✅ |
| Original Datagram | `originalPacket?: IPv4Packet` | ✅ |

#### 3.2.5 Format Time Exceeded (RFC 792 — Type 11)

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|   Type (11)   |   Code (0)    |          Checksum             |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                            unused                             |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|      IP Header + 64 bits of Original Data Datagram            |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

| Champ | Simulation | Statut |
|-------|------------|--------|
| Code 0 : TTL exceeded in transit | Routeur decremente TTL, envoie erreur si TTL=0 | ✅ |
| Code 1 : Fragment reassembly exceeded | Non simule (pas de fragmentation) | ❌ |
| Original Datagram | `originalPacket?: IPv4Packet` | ✅ |

#### 3.2.6 Exigences RFC 1122 pour ICMP (§3.2)

| Exigence | Section | Statut | Detail |
|----------|---------|--------|--------|
| Repondre aux Echo Request avec Echo Reply | §3.2.2.6 | ✅ | EndHost + Router |
| Copier Identifier et Sequence dans la reponse | §3.2.2.6 | ✅ | `id` et `sequence` copies |
| Ne pas generer d'erreur ICMP en reponse a une erreur ICMP | §3.2.2 | ✅ | Seul echo-request genere un reply |
| Envoyer les erreurs Destination Unreachable | §3.2.2.1 | ✅ | Router.sendICMPError() |
| Envoyer Time Exceeded quand TTL expire | §3.2.2.4 | ✅ | Router, TTL decrement a 0 |
| Ne jamais envoyer d'erreur ICMP pour broadcast/multicast | §3.2.2 | 🟡 | Pas de verification explicite |
| Rate limiting des messages d'erreur ICMP | §3.2.2 | ❌ | Pas de rate limiting |
| Source Quench deprecated (RFC 6633) | — | ✅ | Non implemente (correct) |

### 3.3 Path MTU Discovery — RFC 1191 (Novembre 1990)

**Principe** : Decouverte du MTU maximum sur le chemin entre source et destination, en utilisant le bit DF (Don't Fragment) et les messages ICMP Type 3, Code 4.

| Etape | Description | Statut |
|-------|-------------|--------|
| Envoi avec DF=1 | L'emetteur positionne le bit Don't Fragment | ✅ (flags IPv4) |
| Detection MTU par routeur | Si paquet > MTU sortant et DF=1, drop + ICMP erreur | ✅ |
| Inclusion Next-Hop MTU | Le routeur inclut le MTU dans le message ICMP Type 3, Code 4 | ✅ |
| Ajustement par l'emetteur | L'emetteur reduit la taille de ses paquets | ✅ (IPSec SA pathMTU) |

### 3.4 RFC 5227 — IPv4 Address Conflict Detection

| Fonctionnalite | Description | Statut |
|----------------|-------------|--------|
| ARP Probe | ARP Request avec senderIP = 0.0.0.0 pour tester une adresse | ❌ |
| ARP Announce | ARP Request gratuit pour annoncer une adresse | ❌ |
| Detection de conflit | Observer les reponses ARP pour notre propre adresse | ❌ |

---

## 4. Structures de Donnees TypeScript

### 4.1 Couche 2 — Trame Ethernet (`src/network/core/types.ts`)

```typescript
// Constantes EtherType (IEEE 802)
export const ETHERTYPE_ARP  = 0x0806;   // Address Resolution Protocol
export const ETHERTYPE_IPV4 = 0x0800;   // Internet Protocol version 4
export const ETHERTYPE_IPV6 = 0x86dd;   // Internet Protocol version 6

// Trame Ethernet II
export interface EthernetFrame {
  srcMAC: MACAddress;                    // 6 octets — adresse source
  dstMAC: MACAddress;                    // 6 octets — adresse destination
  etherType: number;                     // 2 octets — type du payload (0x0800, 0x0806, etc.)
  payload: ARPPacket | IPv4Packet | IPv6Packet | unknown;
}
```

### 4.2 Adresses reseau

```typescript
// Adresse MAC (48 bits — IEEE 802)
export class MACAddress {
  private readonly octets: number[];     // 6 octets

  constructor(mac: string | number[])    // "02:00:00:00:00:01" ou [2,0,0,0,0,1]
  static generate(): MACAddress          // Generation auto-incrementee (simulateur)
  static broadcast(): MACAddress         // ff:ff:ff:ff:ff:ff
  isBroadcast(): boolean                 // Teste si broadcast
  equals(other: MACAddress): boolean     // Comparaison stricte
  toString(): string                     // Format "HH:HH:HH:HH:HH:HH"
}

// Adresse IPv4 (32 bits — RFC 791)
export class IPAddress {
  private readonly octets: number[];     // 4 octets

  constructor(ip: string | number[])     // "192.168.1.1" ou [192,168,1,1]
  equals(other: IPAddress): boolean
  isInSameSubnet(other: IPAddress, mask: SubnetMask): boolean
  isBroadcastFor(mask: SubnetMask): boolean
  toUint32(): number                     // Conversion en entier 32 bits (pour LPM)
  static fromUint32(n: number): IPAddress
  toString(): string                     // Format "A.B.C.D"
}
```

### 4.3 Paquet ARP (`ARPPacket`)

```typescript
// Operation ARP (RFC 826 §3)
export type ARPOperation = 'request' | 'reply';
// RFC 826 : Opcode 1 = REQUEST, Opcode 2 = REPLY

// Paquet ARP complet
export interface ARPPacket {
  type: 'arp';                           // Discriminant TypeScript
  operation: ARPOperation;               // REQUEST (1) ou REPLY (2)
  senderMAC: MACAddress;                 // Sender Hardware Address (SHA)
  senderIP: IPAddress;                   // Sender Protocol Address (SPA)
  targetMAC: MACAddress;                 // Target Hardware Address (THA)
  targetIP: IPAddress;                   // Target Protocol Address (TPA)
}
// Note : Hardware Type (Ethernet=1), Protocol Type (IPv4=0x0800),
// HW Addr Len (6), Proto Addr Len (4) sont implicites dans le simulateur.
```

**Encapsulation ARP dans Ethernet** :
```
EthernetFrame {
  srcMAC: <MAC de l'emetteur>
  dstMAC: ff:ff:ff:ff:ff:ff     (broadcast pour Request)
          <MAC cible>            (unicast pour Reply)
  etherType: 0x0806              (ETHERTYPE_ARP)
  payload: ARPPacket { ... }
}
```

### 4.4 Paquet IPv4 (`IPv4Packet`)

```typescript
// Constantes de protocole (RFC 790 — Assigned Numbers)
export const IP_PROTO_ICMP    = 1;       // Internet Control Message Protocol
export const IP_PROTO_TCP     = 6;       // Transmission Control Protocol
export const IP_PROTO_UDP     = 17;      // User Datagram Protocol
export const IP_PROTO_ESP     = 50;      // Encapsulating Security Payload (IPSec)
export const IP_PROTO_AH      = 51;      // Authentication Header (IPSec)

// En-tete IPv4 (RFC 791)
export interface IPv4Packet {
  type: 'ipv4';
  version: 4;                            // Toujours 4
  ihl: number;                           // Internet Header Length (mots de 32 bits, defaut: 5)
  tos: number;                           // Type of Service / DSCP + ECN
  totalLength: number;                   // Longueur totale en octets (header + payload)
  identification: number;               // Identification pour reassemblage
  flags: number;                         // bit 1 = DF (Don't Fragment), bit 2 = MF (More Fragments)
  fragmentOffset: number;               // Decalage du fragment (unites de 8 octets)
  ttl: number;                           // Time To Live (decremente par chaque routeur)
  protocol: number;                      // Protocole encapsule (1=ICMP, 6=TCP, 17=UDP)
  headerChecksum: number;               // Somme de controle de l'en-tete
  sourceIP: IPAddress;                   // Adresse source (32 bits)
  destinationIP: IPAddress;              // Adresse destination (32 bits)
  payload: ICMPPacket | UDPPacket | unknown;
}
```

### 4.5 Paquet ICMP (`ICMPPacket`)

```typescript
// Types ICMP supportes (RFC 792)
export type ICMPType =
  | 'echo-request'                       // Type 8, Code 0
  | 'echo-reply'                         // Type 0, Code 0
  | 'destination-unreachable'            // Type 3, Codes 0/1/4/13
  | 'time-exceeded';                     // Type 11, Code 0

// Paquet ICMP
export interface ICMPPacket {
  type: 'icmp';                          // Discriminant TypeScript
  icmpType: ICMPType;                    // Type de message ICMP
  code: number;                          // Code ICMP (sous-type)
  id: number;                            // Identifier (Echo Request/Reply — RFC 792)
  sequence: number;                      // Sequence Number (Echo Request/Reply)
  dataSize: number;                      // Taille du payload en octets (defaut: 56)
  mtu?: number;                          // Next-Hop MTU (Type 3, Code 4 — RFC 1191)
  originalPacket?: IPv4Packet;           // Paquet IPv4 original ayant cause l'erreur
}
```

**Encapsulation ICMP dans IPv4 dans Ethernet** :
```
EthernetFrame {
  srcMAC: <MAC emetteur>
  dstMAC: <MAC next-hop>
  etherType: 0x0800 (IPv4)
  payload: IPv4Packet {
    protocol: 1 (ICMP)
    ttl: 64 (Linux) / 128 (Windows) / 255 (Cisco/Huawei)
    sourceIP: <IP emetteur>
    destinationIP: <IP destination>
    payload: ICMPPacket {
      icmpType: 'echo-request'
      code: 0
      id: <identifiant unique>
      sequence: <numero de sequence>
      dataSize: 56
    }
  }
}
```

### 4.6 Structures internes

```typescript
// Entree du cache ARP (EndHost.ts, Router.ts)
interface ARPEntry {
  mac: MACAddress;                       // Adresse MAC resolue
  iface: string;                         // Interface sur laquelle l'entree a ete apprise
  timestamp: number;                     // Date.now() de l'apprentissage
}

// Resolution ARP en attente
interface PendingARP {
  resolve: (mac: MACAddress) => void;    // Callback de succes
  reject: (reason: string) => void;      // Callback d'echec (timeout)
  timer: ReturnType<typeof setTimeout>;  // Timer de timeout
}

// Ping en attente de reponse
interface PendingPing {
  resolve: (result: PingResult) => void;
  reject: (reason: string) => void;
  timer: ReturnType<typeof setTimeout>;
  sentAt: number;                        // performance.now() pour calcul RTT
}

// Resultat d'un ping individuel
interface PingResult {
  success: boolean;
  rttMs: number;                         // Round-Trip Time en millisecondes
  ttl: number;                           // TTL du paquet de reponse
  seq: number;                           // Numero de sequence
  bytes: number;                         // Taille du paquet recu
  fromIP: string;                        // IP source de la reponse
}

// Paquet en file d'attente (attente de resolution ARP)
interface QueuedPacket {
  pkt: IPv4Packet;                       // Paquet IPv4 a envoyer
  outPort: string;                       // Port de sortie
  nextHopIP: string;                     // IP du next-hop pour ARP
  timer: ReturnType<typeof setTimeout>;  // Timer de timeout (5s)
}
```

---

## 5. Constantes et Timers (`src/network/core/constants.ts`)

### 5.1 Timers ARP

```typescript
export const ARP_TIMERS = {
  REQUEST_TIMEOUT_MS: 3_000,             // Timeout d'une requete ARP individuelle
  CACHE_TTL_MS: 14_400_000,              // Duree de vie du cache : 4 heures (RFC 1122 §2.3.2.1)
  RETRY_INTERVAL_MS: 1_000,              // Intervalle entre retransmissions ARP
  MAX_QUEUE_SIZE: 100,                   // Taille max de la file d'attente de paquets
  QUEUE_TIMEOUT_MS: 5_000,               // Timeout des paquets en file d'attente
} as const;
```

| Constante | Valeur | Justification RFC |
|-----------|--------|-------------------|
| `REQUEST_TIMEOUT_MS` | 3 000 ms | RFC 1122 §2.3.2.1 : "timeout should be on the order of a second" |
| `CACHE_TTL_MS` | 14 400 000 ms (4h) | RFC 1122 §2.3.2.1 : recommande un timeout, 4h est une valeur courante |
| `RETRY_INTERVAL_MS` | 1 000 ms | RFC 1122 §2.3.2.1 : max 1 requete/seconde |
| `MAX_QUEUE_SIZE` | 100 paquets | RFC 1122 §2.3.2.2 : file d'attente recommandee |
| `QUEUE_TIMEOUT_MS` | 5 000 ms | Pas de recommendation RFC precise, valeur pratique |

### 5.2 Constantes ICMP

```typescript
export const ICMP_CONSTANTS = {
  PING_TIMEOUT_MS: 5_000,                // Timeout par defaut pour une reponse ping
  DEFAULT_PING_COUNT: 4,                 // Nombre de pings par defaut
  PING_INTERVAL_MS: 1_000,               // Intervalle entre pings successifs
  DEFAULT_PAYLOAD_SIZE: 32,              // Taille du payload ICMP (octets)
  TRACEROUTE_MAX_HOPS: 30,              // Nombre max de sauts pour traceroute
  TRACEROUTE_TIMEOUT_MS: 3_000,          // Timeout par saut pour traceroute
} as const;
```

| Constante | Valeur | Correspondance systeme reel |
|-----------|--------|-----------------------------|
| `PING_TIMEOUT_MS` | 5 000 ms | Linux : `-W 5` par defaut |
| `DEFAULT_PING_COUNT` | 4 | Windows : 4 par defaut, Linux : infini (simule a 4) |
| `PING_INTERVAL_MS` | 1 000 ms | Linux : `-i 1` par defaut |
| `DEFAULT_PAYLOAD_SIZE` | 32 | Windows : 32 octets, Linux : 56 octets |
| `TRACEROUTE_MAX_HOPS` | 30 | Linux/Windows : 30 par defaut |
| `TRACEROUTE_TIMEOUT_MS` | 3 000 ms | Linux : `-w 3` par defaut |

### 5.3 TTL par defaut selon l'OS

```typescript
export const DEFAULT_TTL = {
  LINUX: 64,                              // Linux kernel default
  WINDOWS: 128,                           // Windows default
  CISCO: 255,                             // Cisco IOS default
  HUAWEI: 255,                            // Huawei VRP default
} as const;
```

| OS/Equipement | TTL | Standard |
|---------------|-----|----------|
| Linux | 64 | `net.ipv4.ip_default_ttl = 64` |
| Windows | 128 | Registre Windows par defaut |
| Cisco IOS | 255 | Specifique Cisco (routeurs) |
| Huawei VRP | 255 | Specifique Huawei (routeurs) |

---

## 6. Protocole ARP — Implementation Detaillee

### 6.1 Processus de Resolution ARP (EndHost)

Le mecanisme de resolution ARP est implemente dans `EndHost.ts` et suit le flux suivant :

```
┌──────────────────────────────────────────────────────────────────────┐
│                    EMISSION D'UN PAQUET IPv4                         │
│                                                                      │
│  1. Application genere un paquet IPv4 (ex: ping 192.168.1.2)        │
│  2. Lookup route → determine next-hop IP et interface de sortie      │
│  3. Recherche dans arpTable : next-hop IP → MAC ?                    │
│                                                                      │
│     ┌─────────────────────┐       ┌──────────────────────────────┐  │
│     │  CACHE HIT           │       │  CACHE MISS                  │  │
│     │  MAC trouvee         │       │  Pas d'entree pour ce IP     │  │
│     └─────────┬───────────┘       └──────────────┬───────────────┘  │
│               │                                   │                  │
│               ▼                                   ▼                  │
│     Encapsulation directe              ┌──────────────────────┐     │
│     dans trame Ethernet                │ Envoi ARP Request    │     │
│     et envoi                           │ (broadcast)          │     │
│                                        │ timeout: 2000ms      │     │
│                                        └──────────┬───────────┘     │
│                                                    │                 │
│                                          ┌─────────▼────────┐       │
│                                          │ Attente ARP Reply │       │
│                                          │ (Promise)         │       │
│                                          └────────┬──┬──────┘       │
│                                          Succes   │  │  Timeout     │
│                                          ┌────────▼┐ ┌▼──────────┐  │
│                                          │ Mise en │ │ Erreur    │  │
│                                          │ cache + │ │ "Request  │  │
│                                          │ envoi   │ │ timed out"│  │
│                                          └─────────┘ └───────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

#### 6.1.1 `resolveARP()` — Resolution d'adresse

| Etape | Description | Code source |
|-------|-------------|-------------|
| 1 | Verifier le cache ARP (`arpTable.get(targetIP)`) | EndHost.ts — resolveARP() |
| 2 | Si cache hit → retourner la MAC immediatement | `Promise.resolve(cached.mac)` |
| 3 | Si cache miss → construire ARP Request | `ARPPacket { operation: 'request', targetMAC: broadcast }` |
| 4 | Encapsuler dans trame Ethernet (dstMAC = ff:ff:ff:ff:ff:ff) | `sendFrame(portName, frame)` |
| 5 | Creer une Promise avec timeout (defaut 2000ms) | `pendingARPs.set(key, callbacks)` |
| 6 | Si reply recue → resolver la Promise avec la MAC | `pending.resolve(arp.senderMAC)` |
| 7 | Si timeout → rejeter la Promise | `pending.reject('ARP request timed out')` |

#### 6.1.2 `handleARP()` — Reception d'un paquet ARP

```
┌──────────────────────────────────────────────────────────────────────┐
│                    RECEPTION D'UN PAQUET ARP                         │
│                                                                      │
│  1. Apprentissage systématique (RFC 826) :                           │
│     arpTable[senderIP] = { mac: senderMAC, iface: portName }        │
│     (Mise a jour inconditionnelle — request ET reply)                │
│                                                                      │
│  2. Si operation == REQUEST et targetIP == notre IP :                 │
│     → Construire ARP Reply :                                         │
│       {                                                              │
│         operation: 'reply',                                          │
│         senderMAC: <notre MAC>,                                      │
│         senderIP: <notre IP>,                                        │
│         targetMAC: <MAC du demandeur>,                               │
│         targetIP: <IP du demandeur>                                  │
│       }                                                              │
│     → Encapsuler dans Ethernet (unicast vers demandeur)              │
│     → Envoyer sur le meme port d'entree                              │
│                                                                      │
│  3. Si operation == REPLY :                                          │
│     → Rechercher dans pendingARPs les callbacks en attente           │
│     → Annuler les timers de timeout                                  │
│     → Resolver les Promises avec senderMAC                           │
│     → Vider la file d'attente (fwdQueue) pour cette IP               │
│                                                                      │
│  4. Flush Forward Queue :                                            │
│     → Pour chaque paquet en attente de resolution pour cette IP :    │
│       - Encapsuler dans trame Ethernet avec la MAC resolue           │
│       - Envoyer sur le port de sortie                                │
│       - Annuler le timer de timeout du paquet                        │
└──────────────────────────────────────────────────────────────────────┘
```

### 6.2 ARP sur les Routeurs

Les routeurs implementent un mecanisme ARP similaire aux EndHosts avec les specificites suivantes :

| Aspect | EndHost | Router |
|--------|---------|--------|
| Table ARP | Une seule table partagee | Une table, entrees par interface |
| Resolution | Pour tout paquet sortant | Pour les paquets a forwarder (next-hop) |
| ARP Reply | Repond pour ses propres IPs | Repond pour chaque IP d'interface |
| Proxy ARP | ❌ | ❌ (non implemente) |
| File d'attente | `fwdQueue[]` avec timeout 5s | `packetQueue[]` avec timeout |
| Lookup route | Table de routage simple | FIB (Forwarding Information Base) avec LPM |
| Ping CLI | `ping <ip>` | `ping <ip>` + option `source <ip>` (Cisco/Huawei) |

### 6.3 ARP et les Equipements L2

#### 6.3.1 Commutateurs (Switch)

Les commutateurs **ne traitent PAS le contenu ARP** au niveau protocole. Ils operent en transparence L2 :

| Comportement | Description | Statut |
|-------------|-------------|--------|
| Flood ARP Request | Trame broadcast (ff:ff:ff:ff:ff:ff) → envoyee sur tous les ports du VLAN sauf l'entree | ✅ |
| Forward ARP Reply | Trame unicast → envoyee selon la table MAC | ✅ |
| MAC Learning depuis ARP | Le srcMAC de toute trame (dont ARP) est appris dans la table MAC | ✅ |
| VLAN-aware flooding | ARP broadcast confine au VLAN d'appartenance du port | ✅ |
| DAI (Dynamic ARP Inspection) | Validation ARP contre DHCP snooping binding | ❌ |
| ARP rate limiting (port) | Limitation du nombre de requetes ARP par port | ❌ |

#### 6.3.2 Hub

Le Hub opere en couche 1 (physique) :
- **Flood integral** de toutes les trames recues sur tous les ports (sauf l'entree)
- Aucune intelligence — pas d'apprentissage MAC, pas de filtrage
- Les trames ARP sont simplement repetees comme tout autre trafic

### 6.4 Table ARP — Operations

| Operation | Commande | Statut |
|-----------|----------|--------|
| Afficher la table ARP | `arp -a` (Linux/Windows) | ✅ |
| Afficher la table ARP | `ip neigh` (Linux) | ✅ |
| Afficher la table ARP | `show arp` (Cisco IOS) | ✅ |
| Afficher la table ARP | `display arp` (Huawei VRP) | ✅ |
| Ajouter entree statique | `arp -s IP MAC` (Linux) | ❌ |
| Ajouter entree statique | `arp static IP MAC` (Huawei system-view) | ✅ |
| Supprimer une entree | `arp -d IP` (Linux) | ❌ |
| Supprimer une entree | `arp -d IP` (Windows) | 🟡 (stub — accepte silencieusement) |
| Supprimer entree statique | `undo arp static IP` (Huawei) | ✅ |
| Vider le cache ARP | `ip neigh flush all` (Linux) | ❌ |
| Vider le cache ARP | `clear ip arp` (Cisco) | ❌ |
| Vider le cache ARP | `reset arp` (Huawei) | ❌ |
| Expiration automatique du cache | Timer TTL 4h (RFC 1122) | 🟡 (defini, non applique) |

### 6.5 Scenarios ARP detailles

#### 6.5.1 Resolution ARP — meme sous-reseau

```
PC-A (192.168.1.10/24)              Switch              PC-B (192.168.1.20/24)
  │                                   │                        │
  │ 1. ping 192.168.1.20              │                        │
  │    Route: direct, meme sous-reseau│                        │
  │    ARP cache miss pour .20        │                        │
  │                                   │                        │
  │ 2. ARP Request (broadcast)        │                        │
  │    Who has 192.168.1.20?          │                        │
  │    Tell 192.168.1.10              │                        │
  │──────────────────────────────────>│ (flood)                │
  │                                   │───────────────────────>│
  │                                   │                        │
  │                                   │  3. ARP Reply (unicast)│
  │                                   │  192.168.1.20 is at    │
  │                                   │  02:00:00:00:00:02     │
  │                                   │<───────────────────────│
  │<──────────────────────────────────│                        │
  │                                   │                        │
  │ 4. Cache: 192.168.1.20 →          │                        │
  │    02:00:00:00:00:02               │                        │
  │                                   │                        │
  │ 5. ICMP Echo Request              │                        │
  │    (encapsule dans Ethernet       │                        │
  │     avec MAC destination resolue) │                        │
  │──────────────────────────────────>│───────────────────────>│
  │                                   │                        │
  │                                   │  6. ICMP Echo Reply    │
  │                                   │<───────────────────────│
  │<──────────────────────────────────│                        │
```

#### 6.5.2 Resolution ARP — sous-reseau different (via routeur)

```
PC-A (10.0.1.10/24)     Router (10.0.1.1 | 10.0.2.1)     PC-B (10.0.2.20/24)
  │ GW: 10.0.1.1              │                              │
  │                            │                              │
  │ 1. ping 10.0.2.20          │                              │
  │    Route: via GW 10.0.1.1  │                              │
  │    ARP pour 10.0.1.1       │                              │
  │                            │                              │
  │ 2. ARP Request             │                              │
  │    Who has 10.0.1.1?       │                              │
  │───────────────────────────>│                              │
  │                            │                              │
  │ 3. ARP Reply               │                              │
  │    10.0.1.1 is at          │                              │
  │    <MAC-Router-eth0>       │                              │
  │<───────────────────────────│                              │
  │                            │                              │
  │ 4. ICMP Echo Request       │                              │
  │    dst MAC: Router         │                              │
  │    dst IP: 10.0.2.20       │                              │
  │───────────────────────────>│                              │
  │                            │ 5. Router: lookup route      │
  │                            │    10.0.2.0/24 → eth1        │
  │                            │    ARP pour 10.0.2.20        │
  │                            │                              │
  │                            │ 6. ARP Request               │
  │                            │    Who has 10.0.2.20?        │
  │                            │─────────────────────────────>│
  │                            │                              │
  │                            │ 7. ARP Reply                 │
  │                            │<─────────────────────────────│
  │                            │                              │
  │                            │ 8. Forward ICMP Echo Request │
  │                            │    TTL decremente de 1       │
  │                            │─────────────────────────────>│
  │                            │                              │
  │                            │ 9. ICMP Echo Reply           │
  │                            │<─────────────────────────────│
  │                            │                              │
  │ 10. ICMP Echo Reply        │                              │
  │     TTL decremente         │                              │
  │<───────────────────────────│                              │
```

---

## 7. Protocole ICMP — Implementation Detaillee

### 7.1 Traitement ICMP sur les EndHosts (PC, Serveurs)

#### 7.1.1 `handleICMP()` — Reception d'un message ICMP

```
┌──────────────────────────────────────────────────────────────────────┐
│                    RECEPTION D'UN PAQUET ICMP                        │
│                                                                      │
│  Paquet IPv4 recu avec protocol = 1 (ICMP)                          │
│  Extraction du payload ICMPPacket                                    │
│                                                                      │
│  Switch sur icmpType :                                               │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │ 'echo-request' (Type 8)                                        │ │
│  │   → Construire Echo Reply (Type 0) :                           │ │
│  │     - Copier id et sequence de la requete                      │ │
│  │     - Copier dataSize                                          │ │
│  │     - Inverser source/destination IP                           │ │
│  │     - Utiliser le TTL par defaut de l'OS (64/128/255)          │ │
│  │   → Router le reply vers l'emetteur original                   │ │
│  │   → Encapsuler dans IPv4, puis Ethernet                        │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │ 'echo-reply' (Type 0)                                          │ │
│  │   → Calculer la cle : "${sourceIP}-${id}-${sequence}"          │ │
│  │   → Rechercher dans pendingPings                               │ │
│  │   → Calculer RTT : performance.now() - sentAt                  │ │
│  │   → Resolver la Promise avec PingResult {                      │ │
│  │       success: true, rttMs, ttl, seq, bytes, fromIP            │ │
│  │     }                                                          │ │
│  │   → Annuler le timer de timeout                                │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │ 'time-exceeded' (Type 11) / 'destination-unreachable' (Type 3) │ │
│  │   → Rejeter les pings en attente avec message d'erreur         │ │
│  │   → Message : "Time to live exceeded (from <sourceIP>)"        │ │
│  │              ou "Destination unreachable (from <sourceIP>)"     │ │
│  └─────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

#### 7.1.2 Generation d'Echo Reply (RFC 792 — conformite)

| Exigence RFC 792 | Implementation | Statut |
|-------------------|----------------|--------|
| Type = 0, Code = 0 | `icmpType: 'echo-reply', code: 0` | ✅ |
| Identifier copie de la requete | `id: requestICMP.id` | ✅ |
| Sequence Number copie | `sequence: requestICMP.sequence` | ✅ |
| Donnees copiees de la requete | `dataSize: requestICMP.dataSize` | ✅ |
| IP source = IP de la destination de la requete | `sourceIP = requestIP.destinationIP` | ✅ |
| IP destination = IP source de la requete | `destinationIP = requestIP.sourceIP` | ✅ |
| TTL = valeur par defaut de l'OS | `ttl = this.defaultTTL` (64/128/255) | ✅ |

#### 7.1.3 Rejet par Firewall — ICMP Destination Unreachable Code 13

Quand le firewall de l'EndHost rejette un paquet avec verdict `'reject'` :

```typescript
// ICMPPacket genere lors d'un rejet firewall
{
  type: 'icmp',
  icmpType: 'destination-unreachable',
  code: 13,                               // Communication Administratively Prohibited
  id: 0,
  sequence: 0,
  dataSize: 0,
}
```

Ce comportement est conforme au RFC 1812 §5.2.7.1 qui definit le code 13 pour les rejets administratifs.

### 7.2 Traitement ICMP sur les Routeurs

#### 7.2.1 `handleLocalDelivery()` — ICMP destine au routeur

Quand un paquet ICMP est adresse a une des IPs d'interface du routeur :

| Message ICMP | Traitement | Statut |
|-------------|------------|--------|
| Echo Request (Type 8) | Genere Echo Reply avec IP de l'interface ciblee comme source | ✅ |
| Echo Reply (Type 0) | Resout les pings initiees par le routeur (`pendingPings`) | ✅ |
| Dest. Unreachable Code 4 (PMTU) | Met a jour le pathMTU de la SA IPSec correspondante | ✅ |

#### 7.2.2 `sendICMPError()` — Generation d'erreurs ICMP

Les routeurs generent des erreurs ICMP lors du forwarding :

```
┌──────────────────────────────────────────────────────────────────────┐
│              GENERATION D'ERREURS ICMP PAR LE ROUTEUR                │
│                                                                      │
│  Condition 1 : TTL == 0 apres decrementation                        │
│  ─────────────────────────────────────────────                       │
│  → Type 11, Code 0 : Time Exceeded — TTL expired in transit         │
│  → IP source = IP de l'interface d'entree du routeur                 │
│  → Inclut originalPacket (en-tete IPv4 + 64 bits du payload)         │
│                                                                      │
│  Condition 2 : Pas de route dans la FIB                              │
│  ──────────────────────────────────────────                           │
│  → Type 3, Code 0 : Destination Unreachable — Net Unreachable       │
│  → IP source = IP de l'interface d'entree                            │
│                                                                      │
│  Condition 3 : Taille paquet > MTU sortant ET flag DF = 1            │
│  ─────────────────────────────────────────────────────               │
│  → Type 3, Code 4 : Fragmentation Needed and DF Set (RFC 1191)      │
│  → Inclut le champ mtu = Next-Hop MTU                                │
│  → Utilise pour Path MTU Discovery                                   │
│                                                                      │
│  Condition 4 : Echec d'encapsulation IPSec (taille > pathMTU SA)     │
│  ─────────────────────────────────────────────────────               │
│  → Type 3, Code 4 : Fragmentation Needed                            │
│  → mtu = pathMTU de la Security Association                          │
│                                                                      │
│  Regles de suppression (RFC 792/1122) :                              │
│  ──────────────────────────────────────                               │
│  → Ne JAMAIS envoyer une erreur ICMP en reponse a une erreur ICMP    │
│  → Ne JAMAIS envoyer une erreur pour un broadcast/multicast ❌(TODO)  │
│  → Rate limiting des erreurs ❌ (non implemente)                      │
└──────────────────────────────────────────────────────────────────────┘
```

#### 7.2.3 Integration avec IPSec (RFC 4301 §8.1)

Le module IPSec interagit avec ICMP pour la decouverte du Path MTU :

| Scenario | Traitement | Source |
|----------|------------|--------|
| Paquet encapsule ESP depasse pathMTU | `IPSecEngine.lastEncapICMP` est positionne | IPSecEngine.ts |
| Routeur detecte `lastEncapICMP` | Genere ICMP Type 3 Code 4 avec MTU adapte | Router.ts |
| Reception ICMP Code 4 par routeur | Met a jour `sa.pathMTU` de la SA concernee | Router.handleLocalDelivery() |

### 7.3 Commande `ping` — Implementation multi-OS

#### 7.3.1 `executePingSequence()` — Logique commune

```
┌──────────────────────────────────────────────────────────────────────┐
│                    EXECUTION D'UN PING                                │
│                                                                      │
│  1. Self-ping check (loopback)                                       │
│     Si targetIP == une de nos IPs d'interface :                      │
│       → Retourner count resultats instantanes                        │
│       → RTT ~ 0.01ms, TTL = TTL par defaut, success = true          │
│                                                                      │
│  2. Route lookup                                                     │
│     Determiner le next-hop IP et l'interface de sortie               │
│     Si pas de route → retourner tableau vide (unreachable)           │
│                                                                      │
│  3. Resolution ARP du next-hop                                       │
│     Appeler resolveARP(portName, nextHopIP, timeoutMs)               │
│     Si timeout ARP → erreur "Destination Host Unreachable"           │
│                                                                      │
│  4. Envoi sequentiel de count requetes Echo Request                  │
│     Pour seq = 1 a count :                                           │
│       a. Construire ICMPPacket { echo-request, id++, seq, size=56 }  │
│       b. Encapsuler dans IPv4 { proto=1, ttl=defaut, src, dst }      │
│       c. Encapsuler dans Ethernet { srcMAC, dstMAC=nextHopMAC }      │
│       d. Envoyer sur le port de sortie                               │
│       e. Attendre reponse ou timeout (5s par defaut)                 │
│       f. Enregistrer PingResult { success, rttMs, ttl, seq, bytes }  │
│                                                                      │
│  5. Retourner le tableau de PingResult[]                             │
└──────────────────────────────────────────────────────────────────────┘
```

#### 7.3.2 Commande `ping` — Linux (LinuxPC.ts)

| Option | Description | Defaut | Statut |
|--------|-------------|--------|--------|
| `ping <ip>` | Ping de base | 4 paquets | ✅ |
| `-c <count>` | Nombre de paquets | 4 | ✅ |
| `-t <ttl>` | TTL initial | 64 | ✅ |
| `-W <timeout>` | Timeout par paquet | 2s | ❌ |
| `-i <interval>` | Intervalle entre paquets | 1s | ❌ |
| `-s <size>` | Taille du payload | 56 | ❌ |
| `-f` | Flood ping | — | ❌ |

**Format de sortie Linux** :
```
PING 192.168.1.2 (192.168.1.2) 56(84) bytes of data.
64 bytes from 192.168.1.2: icmp_seq=1 ttl=64 time=1.23 ms
64 bytes from 192.168.1.2: icmp_seq=2 ttl=64 time=0.89 ms
64 bytes from 192.168.1.2: icmp_seq=3 ttl=64 time=0.95 ms
64 bytes from 192.168.1.2: icmp_seq=4 ttl=64 time=1.01 ms

--- 192.168.1.2 ping statistics ---
4 packets transmitted, 4 received, 0% packet loss
rtt min/avg/max/mdev = 0.89/1.02/1.23/0.12 ms
```

#### 7.3.3 Commande `ping` — Windows (WinPing.ts)

| Option | Description | Defaut | Statut |
|--------|-------------|--------|--------|
| `ping <ip>` | Ping de base | 4 paquets | ✅ |
| `-n <count>` | Nombre de paquets | 4 | ✅ |
| `-l <size>` | Taille du payload | 32 | ✅ (cosmetique) |
| `-i <ttl>` | TTL initial | 128 | ✅ |
| `-t` | Ping continu | — | ✅ (plafonne a 10) |
| `-w <timeout>` | Timeout en ms | 2000 | ❌ |

**Format de sortie Windows** :
```
Pinging 192.168.1.2 with 32 bytes of data:
Reply from 192.168.1.2: bytes=32 time=1ms TTL=64
Reply from 192.168.1.2: bytes=32 time<1ms TTL=64
Reply from 192.168.1.2: bytes=32 time=1ms TTL=64
Reply from 192.168.1.2: bytes=32 time<1ms TTL=64

Ping statistics for 192.168.1.2:
    Packets: Sent = 4, Received = 4, Lost = 0 (0% loss),
Approximate round trip times in milli-seconds:
    Minimum = 0ms, Maximum = 1ms, Average = 0ms
```

#### 7.3.4 Commande `ping` — Cisco IOS (CiscoRouter)

| Syntaxe | Description | Statut |
|---------|-------------|--------|
| `ping <ip>` | Ping rapide (5 paquets) | ✅ |
| `ping <ip> source <ip>` | Specifier l'IP source | ✅ |
| `ping <ip> repeat <n>` | Nombre de paquets | ❌ |
| `ping <ip> timeout <s>` | Timeout par paquet | ❌ |
| `ping` (interactif) | Mode etendu interactif | ❌ |

**Format de sortie Cisco** :
```
Type escape sequence to abort.
Sending 5, 100-byte ICMP Echos to 192.168.1.2, timeout is 2 seconds:
!!!!!
Success rate is 100 percent (5/5), round-trip min/avg/max = 1/1/2 ms
```

#### 7.3.5 Commande `ping` — Huawei VRP (HuaweiRouter)

| Syntaxe | Description | Statut |
|---------|-------------|--------|
| `ping <ip>` | Ping rapide (5 paquets) | ✅ |
| `ping -a <source> <ip>` | Specifier l'IP source | ✅ |
| `ping -c <count> <ip>` | Nombre de paquets | ❌ |
| `ping -t <timeout> <ip>` | Timeout par paquet | ❌ |

### 7.4 Commande `traceroute` (Linux — LinuxPC.ts)

**Principe** : Envoi de paquets ICMP Echo Request avec TTL incrementant (1, 2, 3, ...). Chaque routeur sur le chemin renvoie un ICMP Time Exceeded quand le TTL atteint 0, revelant son adresse IP.

```
┌──────────────────────────────────────────────────────────────────────┐
│                    TRACEROUTE — ALGORITHME                            │
│                                                                      │
│  Pour TTL = 1, 2, 3, ..., maxHops (30) :                            │
│    1. Envoyer ICMP Echo Request avec ce TTL                          │
│    2. Attendre reponse (timeout 3s par saut) :                       │
│       a. ICMP Time Exceeded recu → hop decouvert (IP du routeur)     │
│       b. ICMP Echo Reply recu → destination atteinte, FIN            │
│       c. Timeout → afficher " * " et continuer                       │
│    3. Enregistrer { hop, ip, rttMs, timeout }                        │
│                                                                      │
│  Arreter si :                                                        │
│    - Destination atteinte (Echo Reply)                               │
│    - maxHops atteint (30)                                            │
│    - 3 timeouts consecutifs (optionnel)                              │
└──────────────────────────────────────────────────────────────────────┘
```

**Format de sortie** :
```
traceroute to 10.0.3.10 (10.0.3.10), 30 hops max, 60 byte packets
 1  10.0.1.1  1.234 ms
 2  10.0.2.1  2.567 ms
 3  10.0.3.10  3.891 ms
```

| Option | Description | Statut |
|--------|-------------|--------|
| `traceroute <ip>` | Traceroute de base | ✅ |
| `-m <maxhops>` | Nombre max de sauts | ❌ |
| `-w <timeout>` | Timeout par saut | ❌ |
| `-n` | Pas de resolution DNS | ❌ (DNS non simule) |
| `tracert` (Windows) | Equivalent Windows | ❌ |

---

## 8. Commandes CLI ARP — Multi-Vendeur

### 8.1 Linux — `arp` (LinuxPC.ts)

| Commande | Description | Statut |
|----------|-------------|--------|
| `arp` | Afficher la table ARP | ✅ |
| `arp -a` | Afficher la table ARP (format BSD) | ✅ |
| `arp -n` | Sans resolution DNS | ❌ |
| `arp -d <IP>` | Supprimer une entree | ❌ |
| `arp -s <IP> <MAC>` | Ajouter entree statique | ❌ |
| `arp -i <iface>` | Filtrer par interface | ❌ |

**Format de sortie** :
```
? (192.168.1.1) at 02:00:00:00:00:01 [ether] on eth0
? (192.168.1.20) at 02:00:00:00:00:02 [ether] on eth0
```

### 8.2 Linux — `ip neigh` (LinuxIpCommand.ts)

| Commande | Description | Statut |
|----------|-------------|--------|
| `ip neigh` | Afficher la table de voisinage | ✅ |
| `ip neigh show` | Idem | ✅ |
| `ip neigh add <IP> lladdr <MAC> dev <iface>` | Ajouter entree | ❌ |
| `ip neigh del <IP> dev <iface>` | Supprimer entree | ❌ |
| `ip neigh flush all` | Vider le cache | ❌ |

**Format de sortie** :
```
192.168.1.1 dev eth0 lladdr 02:00:00:00:00:01 REACHABLE
192.168.1.20 dev eth0 lladdr 02:00:00:00:00:02 STALE
```

### 8.3 Windows — `arp` (WinArp.ts)

| Commande | Description | Statut |
|----------|-------------|--------|
| `arp -a` | Afficher la table ARP | ✅ |
| `arp -g` | Alias de `-a` | ✅ |
| `arp -d <IP>` | Supprimer une entree | 🟡 (stub) |
| `arp -s <IP> <MAC>` | Ajouter entree statique | ❌ |
| `arp /?` | Aide | ✅ |

**Format de sortie** :
```
Interface: 192.168.1.10 --- 0x1
  Internet Address      Physical Address      Type
  192.168.1.1          02-00-00-00-00-01     dynamic
  192.168.1.20         02-00-00-00-00-02     dynamic
```

Note : Windows utilise des tirets (`-`) comme separateurs MAC au lieu de deux-points (`:`).

### 8.4 Cisco IOS — `show arp` (CiscoShowCommands.ts)

| Commande | Description | Statut |
|----------|-------------|--------|
| `show arp` | Afficher la table ARP | ✅ |
| `show ip arp` | Alias | ✅ |
| `show ip arp <IP>` | Filtrer par IP | ❌ |
| `show ip arp <interface>` | Filtrer par interface | ❌ |
| `clear ip arp` | Vider le cache | ❌ |
| `arp <IP> <MAC> arpa` | Entree statique (config mode) | ❌ |
| `no arp <IP>` | Supprimer entree statique | ❌ |
| `ip proxy-arp` | Activer Proxy ARP sur interface | ❌ |

**Format de sortie** :
```
Protocol  Address          Age (min)   Hardware Addr   Type   Interface
Internet  192.168.1.10     0           02:00:00:00:00:01  ARPA   GigabitEthernet0/0
Internet  192.168.1.20     5           02:00:00:00:00:02  ARPA   GigabitEthernet0/0
Internet  10.0.1.1         -           02:00:00:00:00:03  ARPA   GigabitEthernet0/1
```

Note : `Age = -` indique une entree locale (IP d'interface du routeur).

### 8.5 Huawei VRP — `display arp` (HuaweiDisplayCommands.ts)

| Commande | Description | Statut |
|----------|-------------|--------|
| `display arp` | Afficher la table ARP | ✅ |
| `display arp all` | Afficher toutes les entrees | ❌ |
| `display arp <IP>` | Filtrer par IP | ❌ |
| `display arp interface <iface>` | Filtrer par interface | ❌ |
| `arp static <IP> <MAC>` | Entree statique (system-view) | ✅ |
| `undo arp static <IP>` | Supprimer entree statique | ✅ |
| `reset arp` | Vider le cache | ❌ |
| `arp-proxy enable` | Activer Proxy ARP sur interface | ❌ |

**Format de sortie** :
```
IP ADDRESS      MAC ADDRESS     EXPIRE(M)  TYPE      INTERFACE
192.168.1.10    02:00:00:00:00:01  5          D         GE0/0/0
192.168.1.20    02:00:00:00:00:02  12         D         GE0/0/0
10.0.1.1        02:00:00:00:00:03  -          S         GE0/0/1
```

| Type | Signification |
|------|---------------|
| D | Dynamic — appris via ARP |
| S | Static — configure manuellement |

### 8.6 Show MAC Address Table (Switch Cisco)

| Commande | Description | Statut |
|----------|-------------|--------|
| `show mac address-table` | Afficher la table MAC | ✅ |
| `show mac address-table dynamic` | Entrees dynamiques | ❌ |
| `show mac address-table interface <iface>` | Filtrer par interface | ❌ |
| `show mac address-table vlan <id>` | Filtrer par VLAN | ❌ |
| `clear mac address-table dynamic` | Vider les entrees dynamiques | ❌ |

---

## 9. Tests Existants

### 9.1 Tests de Ping

#### 9.1.1 `ping-through-switch.test.ts`

| Test | Description | Statut |
|------|-------------|--------|
| Ping basique via switch | Deux PCs communiquent a travers un switch L2 | ✅ |
| Ping multiple paquets | Verification de la sequence de paquets (count > 1) | ✅ |
| Ping direction inverse | B → A apres A → B, verification de symetrie | ✅ |
| Cable deconnecte | Ping echoue si cable retire | ✅ |
| Cable reconnecte | Ping fonctionne apres reconnexion du cable | ✅ |
| Equipement eteint | Ping echoue si device power off | ✅ |
| Population table ARP | Verification que la table ARP est remplie apres ping | ✅ |
| Ping via Hub | Ping fonctionne a travers un Hub (flood L1) | ✅ |
| Ping loopback | Self-ping retourne succes instantane | ✅ |

#### 9.1.2 `cisco-router-ping.test.ts`

| Test | Description | Statut |
|------|-------------|--------|
| RP-1 | Syntaxe CLI : `ping <ip>` accepte | ✅ |
| RP-2 | Syntaxe CLI : `ping` sans argument → erreur | ✅ |
| RP-3 | Syntaxe CLI : `ping <ip> source <ip>` accepte | ✅ |
| RP-4 | Ping vers hote directement connecte | ✅ |
| RP-5 | Ping avec resolution ARP prealable | ✅ |
| RP-6 | Ping vers hote non existant → timeout | ✅ |
| RP-7 | Format de sortie Cisco (!!!!!  Success rate) | ✅ |
| RP-8 | Ping a travers un autre routeur | ✅ |
| RP-9 | Ping multi-hop avec TTL decremente | ✅ |
| RP-10 | Self-ping (IP d'interface locale) | ✅ |
| RP-11 | Self-ping loopback interface | ✅ |

### 9.2 Tests ARP

#### 9.2.1 `huawei-vrp.test.ts` — Section ARP

| Test | Description | Statut |
|------|-------------|--------|
| 4.1 | Apprentissage ARP dynamique apres ping dans le meme sous-reseau | ✅ |
| 4.2.a | Ajout d'entree ARP statique via `arp static <IP> <MAC>` | ✅ |
| 4.2.b | Suppression d'entree ARP statique via `undo arp static <IP>` | ✅ |
| — | `arp static` fonctionne en system-view | ✅ |

### 9.3 Tests manquants identifies

| Categorie | Tests a creer | Priorite |
|-----------|--------------|----------|
| ARP — Timeout | Verification du comportement quand ARP Request n'obtient pas de reponse | P0 |
| ARP — Broadcast | Verification que l'ARP Request utilise bien ff:ff:ff:ff:ff:ff | P0 |
| ARP — Apprentissage croise | A apprend la MAC de B meme sans etre la cible de l'ARP Request | P1 |
| ARP — File d'attente | Paquets mis en attente pendant resolution ARP sont envoyes apres | P1 |
| ARP — Expiration cache | Entrees expirees doivent etre supprimees (quand implemente) | P2 |
| ICMP — Time Exceeded | Routeur genere Time Exceeded quand TTL=0 | P0 |
| ICMP — Destination Unreachable | Routeur genere Unreachable quand pas de route | P0 |
| ICMP — PMTU Discovery | Type 3 Code 4 avec MTU correct | P1 |
| ICMP — Pas d'erreur sur erreur | Verification RFC : pas d'erreur ICMP en reponse a erreur ICMP | P1 |
| ICMP — Traceroute multi-hop | Traceroute a travers 3+ routeurs avec TTL incrementant | P1 |
| ICMP — Firewall reject | Code 13 genere correctement | P2 |
| ICMP — Self-ping | Loopback detecte sans envoi reseau | P0 |
| Windows — Format ping | Format de sortie conforme au format Windows reel | P2 |
| Windows — Format arp | Format de sortie avec tirets (MAC) | P2 |
| Cisco — show arp | Format de sortie avec Age et Type ARPA | P2 |
| Huawei — display arp | Format de sortie avec EXPIRE et Type D/S | P2 |

---

## 10. Securite Reseau — ARP et ICMP

### 10.1 Menaces ARP

| Menace | Description | Protection | Statut |
|--------|-------------|------------|--------|
| ARP Spoofing | Envoi de faux ARP Reply pour intercepter le trafic (MITM) | DAI (Dynamic ARP Inspection) | ❌ |
| ARP Flooding | Saturation de la table ARP du switch avec de fausses entrees | Port Security, ARP rate limiting | ❌ |
| ARP Cache Poisoning | Modification du cache ARP d'un hote via ARP Reply non sollicite | Static ARP, DAI | 🟡 (static ARP Huawei) |
| Gratuitous ARP abuse | Utilisation de Gratuitous ARP pour detourner le trafic | Filtrage GARP | ❌ |

### 10.2 Menaces ICMP

| Menace | Description | Protection | Statut |
|--------|-------------|------------|--------|
| ICMP Flood (Smurf) | Envoi massif d'Echo Request pour saturer la cible | Rate limiting, ACL ICMP | ❌ |
| Ping of Death | Paquet ICMP surdimensionne (>65535 octets) | Validation taille | N/A (pas de fragmentation) |
| ICMP Redirect attack | Fausse redirection pour detourner le trafic | Ignorer les redirects | ✅ (redirects non implementes) |
| ICMP Tunneling | Encapsulation de donnees dans le payload ICMP | DPI, filtrage taille | ❌ |
| Traceroute reconnaissance | Decouverte de topologie via ICMP | ACL, desactiver ICMP unreachable | ❌ |

### 10.3 Protections recommandees (a implementer)

| Protection | Description | Priorite | Statut |
|-----------|-------------|----------|--------|
| DAI (Dynamic ARP Inspection) | Validation ARP contre DHCP snooping binding table | P2 | ❌ |
| ARP Rate Limiting (par port) | Limiter le nombre de requetes ARP par port de switch | P2 | ❌ |
| ICMP Rate Limiting | Token bucket pour limiter les reponses ICMP error | P2 | ❌ |
| ACL ICMP | Filtrage ICMP par type/code sur les interfaces routeur | P2 | ❌ |
| `no ip unreachables` | Desactiver les reponses ICMP Unreachable par interface | P2 | ❌ |
| `no ip redirects` | Desactiver les ICMP Redirects (deja non implemente) | P3 | N/A |
| Port Security | Limiter le nombre de MAC par port de switch | P2 | ❌ |
| ARP Inspection VLAN | DAI par VLAN avec trust/untrust | P3 | ❌ |

---

## 11. Integration avec l'Architecture Existante

### 11.1 Relation avec le Zustand Store

```typescript
// src/store/networkStore.ts
// Le store Zustand maintient la topologie UI et les instances Equipment
interface NetworkStore {
  devices: NetworkDeviceUI[];         // Devices visibles sur le canvas
  connections: Connection[];          // Cables entre devices
  // ...

  // Chaque NetworkDeviceUI contient une reference a l'instance Equipment
  // qui gere ARP/ICMP en interne via handleFrame()
}
```

### 11.2 Relation avec le Logger

Le `Logger` (`src/network/core/Logger.ts`) est un systeme pub/sub qui capture les evenements reseau pour affichage dans l'UI :

| Evenement | Description | Logue |
|-----------|-------------|-------|
| ARP Request envoyee | "ARP: Who has 192.168.1.2? Tell 192.168.1.1" | ✅ |
| ARP Reply recue | "ARP: 192.168.1.2 is at 02:00:00:00:00:02" | ✅ |
| ICMP Echo envoyee | "ICMP: Echo Request to 192.168.1.2 seq=1" | ✅ |
| ICMP Echo recue | "ICMP: Echo Reply from 192.168.1.2 seq=1 time=1.2ms" | ✅ |
| ICMP Error | "ICMP: Time Exceeded from 10.0.1.1" | ✅ |
| Trame droppee | "Frame dropped: TTL expired" | ✅ |

### 11.3 Relation avec DHCP

Le module DHCP (`src/network/dhcp/`) interagit avec ARP :

| Interaction | Description | Statut |
|-------------|-------------|--------|
| DHCP → ARP | Apres obtention d'une adresse DHCP, l'hote peut envoyer un Gratuitous ARP | ❌ |
| DAI → DHCP Snooping | DAI valide les ARP contre la binding table DHCP | ❌ |
| Conflit d'adresse | ARP Probe (RFC 5227) avant d'utiliser une adresse DHCP | ❌ |

### 11.4 Relation avec OSPF

Le module OSPF (`src/network/ospf/`) influence le routage ICMP :

| Interaction | Description | Statut |
|-------------|-------------|--------|
| OSPF → FIB | Les routes OSPF alimentent la FIB utilisee pour le routage des paquets ICMP | ✅ |
| ICMP Unreachable | Si la FIB (OSPF + statique) n'a pas de route, ICMP Unreachable est genere | ✅ |
| Ping via routes OSPF | Le ping fonctionne a travers des routes apprises par OSPF | ✅ |

### 11.5 Relation avec IPSec

Le module IPSec (`src/network/ipsec/`) interagit avec ICMP pour le PMTU :

| Interaction | Description | Statut |
|-------------|-------------|--------|
| ESP encapsulation > MTU | IPSecEngine positionne `lastEncapICMP` avec le MTU | ✅ |
| Router genere ICMP Type 3 Code 4 | Le routeur lit `lastEncapICMP` et envoie l'erreur ICMP | ✅ |
| Reception ICMP PMTU | Le routeur met a jour `sa.pathMTU` de la SA concernee | ✅ |

---

## 12. Plan d'Implementation (Phases)

### Phase 1 — Structures de donnees fondamentales ✅ COMPLETE

1. ✅ `MACAddress` : classe avec generation, broadcast, comparaison, serialisation
2. ✅ `IPAddress` : classe avec comparaison, subnet check, broadcast check, conversion uint32
3. ✅ `EthernetFrame` : interface avec srcMAC, dstMAC, etherType, payload
4. ✅ `ARPPacket` : interface conforme RFC 826 (operation, sender/target MAC/IP)
5. ✅ `ICMPPacket` : interface conforme RFC 792 (type, code, id, sequence, dataSize, mtu)
6. ✅ `IPv4Packet` : interface conforme RFC 791 (version, ihl, tos, ttl, protocol, flags, etc.)

### Phase 2 — ARP — Resolution d'adresses (RFC 826) ✅ QUASI-COMPLETE

1. ✅ Cache ARP (`arpTable: Map<string, ARPEntry>`) sur EndHost et Router
2. ✅ Envoi d'ARP Request en broadcast (resolveARP)
3. ✅ Reception et traitement ARP Request → generation ARP Reply
4. ✅ Reception ARP Reply → resolution des Promises en attente
5. ✅ Apprentissage MAC depuis tout paquet ARP recu (RFC 826)
6. ✅ File d'attente de paquets pendant resolution ARP (fwdQueue/packetQueue)
7. ✅ Entrees ARP statiques (Huawei : `arp static`, `undo arp static`)
8. 🟡 Expiration du cache ARP (TTL defini a 4h, mecanisme d'expiration non implemente)
9. ❌ Gratuitous ARP (envoi ARP non sollicite pour annoncer/mettre a jour)
10. ❌ Proxy ARP (repondre aux ARP pour des adresses d'autres sous-reseaux)

### Phase 3 — ICMP — Messages de controle (RFC 792) ✅ QUASI-COMPLETE

1. ✅ Echo Request (Type 8, Code 0) — envoi par EndHost et Router
2. ✅ Echo Reply (Type 0, Code 0) — reponse par EndHost et Router
3. ✅ Time Exceeded (Type 11, Code 0) — generation par Router quand TTL=0
4. ✅ Destination Unreachable Code 0 (Net Unreachable) — pas de route dans FIB
5. ✅ Destination Unreachable Code 4 (Fragmentation Needed) — PMTU Discovery (RFC 1191)
6. ✅ Destination Unreachable Code 13 (Admin Prohibited) — rejet firewall
7. ❌ Host Unreachable (Type 3, Code 1) — hote sur le LAN ne repond pas a ARP
8. ❌ Port Unreachable (Type 3, Code 3) — port UDP ferme
9. ❌ ICMP Redirect (Type 5) — redirection de route
10. ❌ ICMP Timestamp Request/Reply (Type 13/14) — synchronisation horaire

### Phase 4 — Commandes CLI ✅ COMPLETE

1. ✅ `ping` Linux (LinuxPC) : format de sortie realiste, options -c et -t
2. ✅ `ping` Windows (WinPing) : format de sortie realiste, options -n, -l, -i, -t
3. ✅ `ping` Cisco IOS (CiscoRouter) : format `!!!!!`, option source
4. ✅ `ping` Huawei VRP (HuaweiRouter) : format standard, option -a source
5. ✅ `arp -a` Linux : format `? (IP) at MAC [ether] on iface`
6. ✅ `arp -a` Windows : format tableau avec tirets MAC
7. ✅ `ip neigh` Linux : format `IP dev iface lladdr MAC STATE`
8. ✅ `traceroute` Linux : format multi-hop avec RTT
9. ✅ `show arp` Cisco : format Protocol/Address/Age/Hardware/Type/Interface
10. ❌ `tracert` Windows : equivalent Windows de traceroute
11. ❌ `traceroute` Cisco IOS : version routeur
12. ❌ `tracert` Huawei VRP : version routeur Huawei

### Phase 5 — Integration multi-vendeur ✅ COMPLETE

1. ✅ `show arp` Cisco IOS : affichage table ARP format Cisco avec Age en minutes
2. ✅ `display arp` Huawei VRP : affichage table ARP format Huawei avec Type D/S
3. ✅ TTL par defaut par OS : Linux (64), Windows (128), Cisco (255), Huawei (255)
4. ✅ Format de sortie ping specifique par OS (Linux/Windows/Cisco/Huawei)
5. ✅ Entrees ARP statiques Huawei (`arp static` / `undo arp static`)
6. ✅ `show mac address-table` Cisco Switch : table MAC avec VLAN/Type/Port
7. ❌ Entrees ARP statiques Cisco (`arp <IP> <MAC> arpa`)
8. ❌ Entrees ARP statiques Linux (`arp -s <IP> <MAC>` / `ip neigh add`)

### Phase 6 — Fonctionnalites avancees et conformite RFC 🟡 PARTIELLE

1. ✅ Path MTU Discovery (RFC 1191) — integration avec IPSec
2. ✅ Integration avec OSPF — ping via routes OSPF
3. ✅ Firewall ICMP reject (Code 13)
4. ❌ Expiration du cache ARP (enforcement du timer 4h)
5. ❌ Gratuitous ARP (RFC 5227)
6. ❌ ARP Probe / ARP Announce (RFC 5227)
7. ❌ Proxy ARP (RFC 1027)
8. ❌ ICMP Redirect (RFC 792 Type 5)
9. ❌ ICMP Rate Limiting (RFC 1812 §4.3.2.8)
10. ❌ DAI — Dynamic ARP Inspection
11. ❌ ICMP Host Unreachable quand ARP echoue pour le next-hop final
12. ❌ Verification : pas d'ICMP error pour broadcast/multicast (RFC 1122 §3.2.2)

---

## 13. Conventions de Developpement

1. **Architecture equipment-driven** : Pas de mediateur central. Chaque device traite ses propres trames via `handleFrame()`.
2. **Conformite RFC** : Les comportements doivent correspondre aux RFC. Tout ecart doit etre documente.
3. **Typage strict TypeScript** : Utilisation de types discriminants (`type: 'arp'`, `type: 'icmp'`) pour le dispatch.
4. **Encapsulation correcte** : Respect de la pile Ethernet → IPv4 → ICMP. Jamais de raccourci.
5. **TTL realiste** : Chaque routeur decremente le TTL. Chaque OS utilise son TTL par defaut.
6. **Async/Promise pour ARP** : La resolution ARP est asynchrone avec timeout. Les paquets sont mis en file d'attente.
7. **Format CLI multi-vendeur** : Chaque OS/vendeur a son propre format de sortie pour ping et arp.
8. **Tests TDD** : Chaque nouveau comportement doit etre couvert par des tests unitaires.
9. **Pas de checksums reels** : Dans le contexte du simulateur, les checksums ICMP et IP ne sont pas verifies (pas de corruption).
10. **Logger** : Tous les evenements ARP/ICMP significatifs doivent etre logues via le Logger pub/sub.

---

## 14. Criteres d'Acceptation

### 14.1 ARP

- [x] Deux PCs dans le meme sous-reseau resolvent mutuellement leur adresse MAC via ARP
- [x] La table ARP est peuplee apres un ping reussi
- [x] Les ARP Request utilisent l'adresse broadcast (ff:ff:ff:ff:ff:ff)
- [x] Les ARP Reply sont unicast vers le demandeur
- [x] Les paquets IPv4 sont mis en file d'attente pendant la resolution ARP
- [x] `arp -a` (Linux) affiche les entrees au format standard
- [x] `arp -a` (Windows) affiche les entrees au format Windows (tirets MAC)
- [x] `ip neigh` (Linux) affiche les entrees au format iproute2
- [x] `show arp` (Cisco) affiche les entrees avec Age et Type ARPA
- [x] `display arp` (Huawei) affiche les entrees avec Type D/S
- [x] Les entrees ARP statiques Huawei fonctionnent (`arp static` / `undo arp static`)
- [ ] Le cache ARP expire apres le TTL configure (4h)
- [ ] `arp -d` (Linux) supprime une entree
- [ ] `arp -s` (Linux) ajoute une entree statique
- [ ] `clear ip arp` (Cisco) vide le cache

### 14.2 ICMP

- [x] Ping entre deux PCs dans le meme sous-reseau fonctionne
- [x] Ping entre deux PCs a travers un routeur fonctionne
- [x] Ping entre deux PCs a travers plusieurs routeurs fonctionne
- [x] Self-ping (loopback) retourne un succes instantane
- [x] Ping vers un hote inexistant retourne un timeout
- [x] Le format de sortie ping correspond a l'OS (Linux/Windows/Cisco/Huawei)
- [x] Les routeurs decrementent le TTL a chaque saut
- [x] Les routeurs generent ICMP Time Exceeded quand TTL=0
- [x] Les routeurs generent ICMP Destination Unreachable quand pas de route
- [x] Traceroute revele les IPs des routeurs intermediaires
- [x] PMTU Discovery fonctionne via ICMP Type 3 Code 4
- [x] Le firewall genere ICMP Code 13 lors d'un rejet
- [ ] Rate limiting des erreurs ICMP
- [ ] ICMP Host Unreachable quand ARP echoue
- [ ] ICMP Redirect pour rediriger vers un meilleur routeur
- [ ] Traceroute disponible sur Windows (`tracert`), Cisco et Huawei

### 14.3 Tests

- [x] Tests unitaires pour ping basique (meme sous-reseau)
- [x] Tests unitaires pour ping via routeur
- [x] Tests unitaires pour self-ping
- [x] Tests unitaires pour deconnexion cable
- [x] Tests unitaires pour ARP learning dynamique
- [x] Tests unitaires pour ARP statique (Huawei)
- [x] Tests pour syntaxe CLI ping Cisco
- [ ] Tests pour ICMP Time Exceeded
- [ ] Tests pour ICMP Destination Unreachable
- [ ] Tests pour ICMP PMTU Discovery
- [ ] Tests pour traceroute multi-hop
- [ ] Tests pour format de sortie ARP multi-vendeur
- [ ] Tests pour expiration cache ARP
- [ ] Tests pour ARP flood / file d'attente saturation
- [ ] Couverture de tests > 80% sur les modules ARP et ICMP

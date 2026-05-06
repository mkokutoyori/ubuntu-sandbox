# DESIGN — Architecture Technique EIGRP (Enhanced Interior Gateway Routing Protocol)

**Version** : 1.0  
**Date** : 2026-05-06  
**Projet** : Ubuntu Sandbox — Module EIGRP  
**Auteur** : Claude Code  
**Reference** : RFC 7868, RFC 5905, OSPFEngine.ts, Router.ts, core/types.ts

---

## Table des matieres

1. [Vue d'ensemble architecturale](#1-vue-densemble-architecturale)
2. [Fondations : Result monad + EigrpError](#2-fondations--result-monad--eigrperror)
3. [Value Objects et metrique EIGRP (FP)](#3-value-objects-et-metrique-eigrp-fp)
4. [Topology Table et Neighbor Table — Repository](#4-topology-table-et-neighbor-table--repository)
5. [Machine a etats voisin — State Machine discriminee](#5-machine-a-etats-voisin--state-machine-discriminee)
6. [Algorithme DUAL — Strategy + Pure Functions](#6-algorithme-dual--strategy--pure-functions)
7. [Paquets EIGRP et TLV — Codec + Discriminated Union](#7-paquets-eigrp-et-tlv--codec--discriminated-union)
8. [RTP — Reliable Transport Protocol](#8-rtp--reliable-transport-protocol)
9. [EigrpProcess — Facade + Orchestration](#9-eigrpprocess--facade--orchestration)
10. [Integration Router.ts et CLI Cisco](#10-integration-routerts-et-cli-cisco)
11. [Recapitulatif des principes appliques](#11-recapitulatif-des-principes-appliques)

---

## 1. Vue d'ensemble architecturale

### 1.1 Pourquoi EIGRP ?

EIGRP (RFC 7868, anciennement Cisco proprietary) est un protocole de routage a vecteur de distance avance. Contrairement a RIP (distance-vector naif) et OSPF (link-state avec flooding), EIGRP utilise l'algorithme **DUAL** (Diffusing Update Algorithm) qui garantit :
- **Convergence sans boucle** : la condition de faisabilite elimine les boucles de routage
- **Convergence rapide** : les successeurs de secours (feasible successors) permettent un basculement instantane
- **Economie de bande passante** : mises a jour incrementales (pas de flooding periodique)
- **Support multi-protocoles** : IPv4, IPv6, IPX (historique), AppleTalk (historique)

Dans notre simulateur, EIGRP couvre les scenarios Cisco IOS manquants : **AS unique multi-site**, **redistribution entre protocoles**, **summarization hierarchique**, et **charge splitting ECMP**.

### 1.2 Diagramme de couches

```
+-------------------------------------------------------------------------+
|                        COUCHE PRESENTATION                              |
|  CiscoEigrpCommands   (show ip eigrp, router eigrp, ip summary-address) |
|  CiscoIOSShell        (mode config, mode interface, mode router eigrp)  |
+--------------------------------+----------------------------------------+
                                 |  depend via IEigrpProcess
+--------------------------------v----------------------------------------+
|                       COUCHE PROCESSUS EIGRP (Facade)                   |
|                                                                         |
|   EigrpProcess (IEigrpProcess)                                          |
|   - onHello / onUpdate / onQuery / onReply / onAck                      |
|   - sendUpdate(neighbor?) / sendQuery(prefix) / sendReply(neighbor)     |
|   - getNeighbors() / getTopologyTable() / getFib()                      |
|   - configure(opts: EigrpProcessOptions)                                |
+--------+-------------------+--------------------------------------------+
         |                   |
+--------v-------+  +--------v-----------+  +-----------------------------+
| DUAL LAYER     |  |  NEIGHBOR LAYER    |  |  RTP LAYER                  |
|                |  |                    |  |  (Reliable Transport)       |
| IDualAlgorithm |  | EigrpNeighbor      |  | IRtpChannel                 |
| DualAlgorithm  |  | State Machine      |  | RtpSequenceTracker          |
| Impl           |  | (Idle -> Up)       |  | PendingAckBuffer            |
|                |  |                    |  | MulticastChannel            |
| FibTable       |  | Hello/Hold timers  |  | UnicastRetransmit           |
| (FD per route) |  | K-values check     |  |                             |
+--------+-------+  +--------+-----------+  +----+------------------------+
         |                   |                   |
+--------v-------------------v-------------------v------------------------+
|                     COUCHE TOPOLOGY / CATALOG                           |
|                                                                         |
|   IEigrpTopologyRepository (Repository)                                 |
|     +-- InMemoryTopologyTable                                           |
|         - TopologyEntry (P/A state, successor, feasible successors)     |
|         - EigrpMetric  (BW, delay, reliability, load, MTU, K-values)   |
|                                                                         |
|   IEigrpNeighborRepository                                              |
|     +-- InMemoryNeighborTable                                           |
|         - EigrpNeighborEntry (address, AS, K-values, hold timer)       |
+--------+----------------------------------------------------------------+
         |
+--------v----------------------------------------------------------------+
|                     COUCHE PAQUET / CODEC                               |
|                                                                         |
|   EigrpPacket (discriminated union)                                     |
|   EigrpTlv (discriminated union : Parameter, IPv4Route, IPv6Route...)  |
|   EigrpPacketCodec (fonctions pures : serialize / deserialize)         |
|   EigrpPacketDispatcher (Command pattern : Hello/Update/Query/Reply)    |
+--------+----------------------------------------------------------------+
         |  utilise via RouterEigrpIntegration.handleEigrpPacket()
+--------v----------------------------------------------------------------+
|                    COUCHE ROUTER / INFRASTRUCTURE                       |
|                                                                         |
|   RouterEigrpIntegration (Adapter)                                      |
|   - handleEigrpPacket(portName, ipPkt)  [appele depuis Router.ts]      |
|   - installRoutes(entries) / withdrawRoutes(prefixes)                   |
|   - sendFrame(portName, frame)                                          |
|                                                                         |
|   IRib (interface vers la table de routage du Router)                   |
|   IEigrpNetworkInterface (interface vers les ports du Router)           |
+-------------------------------------------------------------------------+
```

### 1.3 Comparaison OSPF vs EIGRP dans le simulateur

| Aspect | OSPF (existant) | EIGRP (nouveau) |
|---|---|---|
| Algorithme | SPF (Dijkstra) sur LSDB | DUAL sur Topology Table |
| Base de donnees | LSDB (Link-State DB) partagee | Topology Table locale |
| Flooding | Inonde toutes les LSA | Mises a jour incrementales |
| Paquets | Hello, DD, LSR, LSU, LSAck (5 types) | Hello, Update, Query, Reply, ACK (5 types) |
| Protocole IP | 89 | 88 |
| Multicast | 224.0.0.5 / 224.0.0.6 | 224.0.0.10 |
| Metrique | Cout (inversement proportionnel BW) | Composite (BW + delay + reliability + load) |
| Backup routes | Via SPF (recalcul) | Feasible Successors (instantane) |
| Transport | Fiable via LSAck | RTP (Reliable Transport Protocol) |
| Convergence | Plus lente (flooding + SPF) | Plus rapide (DUAL + FS) |

### 1.4 Points d'integration avec le simulateur existant

**Frame dispatch dans Router.ts :**
```
handleFrame(portName, frame)
  --> processIPv4(portName, ipPkt)
       --> if ipPkt.protocol === 89 : ospfIntegration.handleOspfPacket()
       --> if ipPkt.protocol === 88 : eigrpIntegration.handleEigrpPacket()   [NOUVEAU]
       --> else : forwarding normal
```

**Routing table (RouteEntry) :**
```typescript
// RouteEntry existant dans Router.ts :
type RouteEntry = {
  network: IPAddress;  mask: SubnetMask;
  nextHop: IPAddress | null;  iface: string;
  type: 'connected' | 'static' | 'rip' | 'ospf' | 'eigrp';   // + 'eigrp'
  ad: number;          // EIGRP interne : 90, externe : 170
  metric: number;      // Metrique EIGRP composite
}
```

### 1.5 Perimetres

**In-scope :**
- EIGRP pour IPv4 (named mode + classic mode)
- Neighbor discovery / hello / hold timer
- DUAL : passive/active, successor, feasible successor
- Metrique composite (K1, K3 par defaut ; K2, K4, K5 optionnels)
- Summarization manuelle (`ip summary-address eigrp`)
- Redistribution depuis/vers OSPF, static, connected
- Equal-cost load balancing (ECMP, `maximum-paths 4`)
- Unequal-cost load balancing (`variance 2`)
- Named mode EIGRP (IOS 15+)
- Authentication MD5 / SHA-256

**Out-of-scope :**
- EIGRP pour IPv6 (structure identique, scope futur)
- EIGRP Stub routing complet (simule partiellement)
- BFD (Bidirectional Forwarding Detection)
- NSF/Graceful Restart
- mGRE tunnels EIGRP
- EIGRP over DMVPN

---

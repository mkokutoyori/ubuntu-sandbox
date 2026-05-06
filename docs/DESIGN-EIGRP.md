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

## 2. Fondations : Result monad + EigrpError

### 2.1 Reutilisation du Result monad

Le module EIGRP reutilise le type `Result<T, E>` et ses combinateurs definis dans le module SSH (`src/network/protocols/ssh/result.ts`). Aucune duplication — import direct. Le principe est identique :

```typescript
// src/network/eigrp/result.ts  (re-export)
export type { Result } from '@/network/protocols/ssh/result'
export { ok, err, map, flatMap, mapError, getOrElse, match, sequence }
  from '@/network/protocols/ssh/result'
```

### 2.2 EigrpError — union discriminee propre a EIGRP

Les erreurs EIGRP ont leurs propres codes. Chaque variant correspond a un cas d'echec distinct, verifiable statiquement par le compilateur.

```typescript
// src/network/eigrp/EigrpError.ts

export type EigrpErrorCode =
  // Erreurs de voisinage
  | 'NEIGHBOR_K_MISMATCH'       // K-values incompatibles -> voisinage impossible
  | 'NEIGHBOR_AS_MISMATCH'      // AS numbers differents -> pas de voisinage
  | 'NEIGHBOR_AUTH_FAIL'        // Echec authentification MD5/SHA
  | 'NEIGHBOR_HOLD_EXPIRED'     // Hold timer expire -> voisin perdu
  | 'NEIGHBOR_NOT_FOUND'        // Voisin inconnu dans la neighbor table
  | 'NEIGHBOR_ALREADY_UP'       // Tentative de re-init d'un voisin deja Up
  // Erreurs DUAL
  | 'DUAL_STUCK_IN_ACTIVE'      // SIA : Query sans Reply apres SIA-timer
  | 'DUAL_NO_FEASIBLE_SUCCESSOR' // Aucun FS disponible -> passage en Active
  | 'DUAL_INVALID_METRIC'       // Metrique infinie ou overflow
  | 'DUAL_LOOP_DETECTED'        // Condition de faisabilite violee
  // Erreurs RTP (Reliable Transport)
  | 'RTP_SEQ_OUT_OF_ORDER'      // Paquet recu avec seqno hors ordre
  | 'RTP_MAX_RETRANS_EXCEEDED'  // 16 retransmissions sans ACK -> voisin perdu
  | 'RTP_DUPLICATE_PACKET'      // Seqno deja vu (deduplication)
  // Erreurs de paquet
  | 'PACKET_INVALID_OPCODE'     // Opcode inconnu (1/3/4/5 attendus)
  | 'PACKET_CHECKSUM_MISMATCH'  // Checksum IP/EIGRP invalide
  | 'PACKET_TLV_MALFORMED'      // TLV tronque ou type inconnu
  | 'PACKET_VERSION_MISMATCH'   // Version EIGRP != 2
  // Erreurs de configuration
  | 'CONFIG_INVALID_AS'         // AS number hors range [1, 65535]
  | 'CONFIG_INTERFACE_NOT_FOUND' // Interface inconnue
  | 'CONFIG_WILDCARD_INVALID'   // Wildcard mask invalide dans 'network'
  | 'CONFIG_SUMMARY_OVERLAP'    // Summary address se chevauche avec route plus specifique

export interface EigrpError {
  readonly code:    EigrpErrorCode
  readonly message: string
  /** Contexte additionnel (voisin, prefix, interface...) */
  readonly context?: Record<string, string | number>
}

export function makeEigrpError(
  code: EigrpErrorCode,
  message: string,
  context?: Record<string, string | number>,
): EigrpError {
  return Object.freeze({ code, message, context })
}
```

### 2.3 EigrpEvent — union discriminee pour les evenements internes

EIGRP est pilote par des evenements (packets recus, timers expires, changements topologiques). Modeliser les evenements comme une union discriminee permet une machine a etats exhaustivement couverte par le compilateur.

```typescript
// src/network/eigrp/EigrpEvent.ts

import type { EigrpNeighborAddress } from './values/EigrpNeighborAddress'
import type { EigrpPrefix }          from './values/EigrpPrefix'
import type { EigrpMetric }          from './values/EigrpMetric'
import type { EigrpNeighborKey }     from './values/EigrpNeighborKey'

export type EigrpEvent =
  // ── Evenements de voisinage ───────────────────────────────────────────
  | {
      readonly type:     'HELLO_RECEIVED'
      readonly neighbor: EigrpNeighborAddress
      readonly iface:    string
      readonly holdTime: number
      readonly kValues:  readonly [number, number, number, number, number]
      readonly asNumber: number
    }
  | {
      readonly type:     'HOLD_TIMER_EXPIRED'
      readonly neighbor: EigrpNeighborKey
      readonly iface:    string
    }
  | {
      readonly type:     'NEIGHBOR_DOWN'
      readonly neighbor: EigrpNeighborKey
      readonly reason:   'HOLD_EXPIRED' | 'K_MISMATCH' | 'AS_MISMATCH' | 'AUTH_FAIL' | 'INTERFACE_DOWN'
    }
  // ── Evenements DUAL (routes) ──────────────────────────────────────────
  | {
      readonly type:    'UPDATE_RECEIVED'
      readonly from:    EigrpNeighborKey
      readonly prefix:  EigrpPrefix
      readonly metric:  EigrpMetric   // metrique annoncee par le voisin (AD)
      readonly isWithdraw: boolean    // infinite metric = retrait de route
    }
  | {
      readonly type:   'QUERY_RECEIVED'
      readonly from:   EigrpNeighborKey
      readonly prefix: EigrpPrefix
      readonly metric: EigrpMetric
    }
  | {
      readonly type:   'REPLY_RECEIVED'
      readonly from:   EigrpNeighborKey
      readonly prefix: EigrpPrefix
      readonly metric: EigrpMetric
    }
  // ── Evenements de route locale ─────────────────────────────────────────
  | {
      readonly type:        'LOCAL_ROUTE_UP'
      readonly prefix:      EigrpPrefix
      readonly iface:       string
      readonly bandwidth:   number     // Kbps
      readonly delay:       number     // microseconds
    }
  | {
      readonly type:   'LOCAL_ROUTE_DOWN'
      readonly prefix: EigrpPrefix
      readonly iface:  string
    }
  // ── Evenements DUAL internes ──────────────────────────────────────────
  | {
      readonly type:   'SIA_TIMER_EXPIRED'
      readonly prefix: EigrpPrefix
    }
  | {
      readonly type:   'SIA_QUERY_SENT'
      readonly prefix: EigrpPrefix
      readonly to:     EigrpNeighborKey
    }
```

### 2.4 Diagramme des types fondamentaux

```
Result<T, E>        (partage avec SSH — zero duplication)
      |
      +-- EigrpError   (code + message + context)
            makeEigrpError() pur

EigrpEvent           (union discriminee — 10 variants)
  HELLO_RECEIVED, HOLD_TIMER_EXPIRED, NEIGHBOR_DOWN
  UPDATE_RECEIVED, QUERY_RECEIVED, REPLY_RECEIVED
  LOCAL_ROUTE_UP, LOCAL_ROUTE_DOWN
  SIA_TIMER_EXPIRED, SIA_QUERY_SENT

Proprietes :
  - Zero dependance externe (pas de Router, pas de VFS)
  - Chaque variant est exhaustif dans les switch/match
  - Immuables (Object.freeze via readonly)
```

---

## 3. Value Objects et metrique EIGRP (FP)

### 3.1 EigrpAsNumber — numero de systeme autonome

```typescript
// src/network/eigrp/values/EigrpAsNumber.ts

export type EigrpAsNumber = Readonly<{ readonly _tag: 'EigrpAsNumber'; readonly value: number }>

export const EigrpAsNumber = {
  of(n: number): EigrpAsNumber {
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      throw new RangeError(`EIGRP AS number must be in [1, 65535], got: ${n}`)
    }
    return Object.freeze({ _tag: 'EigrpAsNumber', value: n })
  },
  toString(a: EigrpAsNumber): string { return String(a.value) },
}
```

### 3.2 EigrpRouterIdentifier — identifiant du routeur

```typescript
// src/network/eigrp/values/EigrpRouterIdentifier.ts

export type EigrpRid = Readonly<{ readonly _tag: 'EigrpRid'; readonly value: string }>

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/

export const EigrpRid = {
  of(s: string): EigrpRid {
    if (!IPV4_RE.test(s)) throw new Error(`Invalid EIGRP RID: "${s}"`)
    return Object.freeze({ _tag: 'EigrpRid', value: s })
  },

  /** Derive le RID de la plus haute adresse IPv4 des interfaces Loopback (RFC 7868 §4) */
  fromHighestLoopback(addresses: readonly string[]): EigrpRid | null {
    if (addresses.length === 0) return null
    const sorted = [...addresses].sort((a, b) => {
      const toNum = (ip: string) => ip.split('.').reduce((acc, o) => acc * 256 + Number(o), 0)
      return toNum(b) - toNum(a)
    })
    return EigrpRid.of(sorted[0])
  },

  toString(r: EigrpRid): string { return r.value },
}
```

### 3.3 EigrpPrefix — reseau IPv4 avec masque

```typescript
// src/network/eigrp/values/EigrpPrefix.ts

export type EigrpPrefix = Readonly<{
  readonly _tag:    'EigrpPrefix'
  readonly network: string    // ex. '10.0.0.0'
  readonly prefixLen: number  // 0..32
}>

export const EigrpPrefix = {
  of(network: string, prefixLen: number): EigrpPrefix {
    if (prefixLen < 0 || prefixLen > 32) {
      throw new RangeError(`Prefix length must be in [0,32], got: ${prefixLen}`)
    }
    return Object.freeze({ _tag: 'EigrpPrefix', network, prefixLen })
  },

  fromCidr(cidr: string): EigrpPrefix {
    const [net, len] = cidr.split('/')
    return EigrpPrefix.of(net, Number(len))
  },

  toString(p: EigrpPrefix): string {
    return `${p.network}/${p.prefixLen}`
  },

  /** Compare deux prefixes — utile pour trier la topology table */
  compare(a: EigrpPrefix, b: EigrpPrefix): number {
    if (a.prefixLen !== b.prefixLen) return b.prefixLen - a.prefixLen  // plus long = premier
    return a.network.localeCompare(b.network)
  },

  /** Verifie si une adresse appartient a ce prefix */
  contains(prefix: EigrpPrefix, ip: string): boolean {
    const toNum = (s: string) => s.split('.').reduce((a, o) => a * 256 + Number(o), 0)
    const mask = prefix.prefixLen === 0 ? 0 : (~0 << (32 - prefix.prefixLen)) >>> 0
    return (toNum(ip) & mask) === (toNum(prefix.network) & mask)
  },
}
```

### 3.4 EigrpMetric — metrique composite EIGRP

La metrique EIGRP est l'element le plus complexe du protocole. Elle encode la bande passante minimale sur le chemin, la somme des delais, la fiabilite et la charge. Les coefficients K1..K5 pondèrent chaque composante.

```typescript
// src/network/eigrp/values/EigrpMetric.ts

/**
 * Valeurs brutes d'interface utilisees pour calculer la metrique EIGRP.
 * Transmises dans le TLV IPv4 Internal Route.
 */
export interface EigrpInterfaceMetric {
  readonly bandwidth:   number   // Kbps (interface bandwidth)
  readonly delay:       number   // microseconds (interface delay)
  readonly reliability: number   // 0-255 (255 = 100%)
  readonly load:        number   // 0-255 (255 = 100% utilization)
  readonly mtu:         number   // bytes (minimum MTU on path)
}

/**
 * Coefficients K pour le calcul de metrique.
 * Default Cisco : K1=1, K2=0, K3=1, K4=0, K5=0
 */
export interface EigrpKValues {
  readonly k1: number   // BW coefficient
  readonly k2: number   // load coefficient
  readonly k3: number   // delay coefficient
  readonly k4: number   // reliability coefficient (part 1)
  readonly k5: number   // reliability coefficient (part 2)
}

export const DEFAULT_K_VALUES: EigrpKValues = Object.freeze({
  k1: 1, k2: 0, k3: 1, k4: 0, k5: 0,
})

/**
 * Valeur de metrique EIGRP calculee (Feasible Distance ou Advertised Distance).
 * INFINIE = 0xFFFFFFFF = route inaccessible.
 */
export type EigrpMetric = Readonly<{
  readonly _tag:       'EigrpMetric'
  readonly composite:  number                    // valeur composite finale
  readonly components: EigrpInterfaceMetric      // composantes brutes (pour display)
}>

export const EIGRP_INFINITY: EigrpMetric = Object.freeze({
  _tag: 'EigrpMetric',
  composite: 0xFFFFFFFF,
  components: { bandwidth: 0, delay: 0xFFFFFFFF, reliability: 0, load: 255, mtu: 0 },
})

export const EigrpMetric = {
  isInfinite(m: EigrpMetric): boolean { return m.composite >= 0xFFFFFFFF },

  /** Retourne la metrique la plus faible */
  min(a: EigrpMetric, b: EigrpMetric): EigrpMetric {
    return a.composite <= b.composite ? a : b
  },

  compare(a: EigrpMetric, b: EigrpMetric): number {
    return a.composite - b.composite
  },
}
```

### 3.5 EigrpPureUtils — calcul de metrique et helpers purs

```typescript
// src/network/eigrp/EigrpPureUtils.ts

import type { EigrpInterfaceMetric, EigrpKValues, EigrpMetric } from './values/EigrpMetric'
import { EIGRP_INFINITY } from './values/EigrpMetric'
import type { EigrpPrefix } from './values/EigrpPrefix'

// ─── Constantes de bande passante par defaut Cisco ────────────────────────

/** Bandes passantes Cisco IOS par defaut en Kbps */
export const CISCO_DEFAULT_BANDWIDTHS: Record<string, number> = {
  'FastEthernet':       100_000,   // 100 Mbps
  'GigabitEthernet':  1_000_000,   // 1 Gbps
  'TenGigabitEthernet': 10_000_000, // 10 Gbps
  'Serial':               1_544,   // T1 = 1.544 Mbps
  'Loopback':         8_000_000,   // 8 Gbps (never used in metric)
  'Tunnel':              100,      // 100 Kbps (conservative default)
}

/** Delais Cisco IOS par defaut en microseconds */
export const CISCO_DEFAULT_DELAYS: Record<string, number> = {
  'FastEthernet':      100,    // 0.1 ms
  'GigabitEthernet':    10,    // 0.01 ms
  'TenGigabitEthernet':  1,    // 0.001 ms (0.01 ms en pratique)
  'Serial':          20_000,   // 20 ms
  'Loopback':         5_000,   // 5 ms (never used in real EIGRP)
  'Tunnel':         50_000,    // 50 ms
}

// ─── Calcul de la metrique composite ─────────────────────────────────────

/**
 * Calcule la metrique EIGRP composite.
 *
 * Formule RFC 7868 §5.6.1 :
 *   metric = 256 × [K1×BW + K2×BW/(256-load) + K3×delay]
 *   avec :
 *     BW    = 10^7 / bandwidth_kbps  (inverse bande passante minimale)
 *     delay = sum_of_delays / 10      (en dizaines de microsecondes)
 *
 *   Si K5 != 0 : multiply by K5 / (reliability + K4)
 *
 * Note : 'bandwidth' dans le TLV est exprime en 256 × 10^7/kbps
 *        'delay'     dans le TLV est exprime en 256 × delay_us / 10
 *
 * @param m        Composantes de l'interface (bw en Kbps, delay en µs)
 * @param k        Coefficients K (default: K1=K3=1, reste=0)
 */
export function computeEigrpMetric(
  m: EigrpInterfaceMetric,
  k: EigrpKValues,
): EigrpMetric {
  if (m.bandwidth === 0) return EIGRP_INFINITY

  // Scaleur BW = 10^7 / bandwidth_kbps (BW inverse, minimum sur le chemin)
  const bw    = Math.floor(10_000_000 / m.bandwidth)
  // Scaleur delay = sum_of_delays / 10 (en dizaines de µs)
  const delay = Math.floor(m.delay / 10)

  let raw = k.k1 * bw + k.k3 * delay

  if (k.k2 !== 0) {
    raw += Math.floor(k.k2 * bw / (256 - m.load))
  }

  let composite = 256 * raw

  if (k.k5 !== 0 && m.reliability > 0) {
    composite = Math.floor(composite * k.k5 / (m.reliability + k.k4))
  }

  return Object.freeze({
    _tag: 'EigrpMetric',
    composite: Math.min(composite, 0xFFFFFFFE),  // cap < INFINITY
    components: m,
  })
}

/**
 * Accumule les composantes de metrique le long d'un chemin.
 * BW : prend le minimum (bottleneck), delay : somme, load/reliability : max.
 */
export function accumulateMetric(
  pathSoFar: EigrpInterfaceMetric,
  nextHop: EigrpInterfaceMetric,
): EigrpInterfaceMetric {
  return {
    bandwidth:   Math.min(pathSoFar.bandwidth, nextHop.bandwidth),
    delay:       pathSoFar.delay + nextHop.delay,
    reliability: Math.min(pathSoFar.reliability, nextHop.reliability),
    load:        Math.max(pathSoFar.load, nextHop.load),
    mtu:         Math.min(pathSoFar.mtu, nextHop.mtu),
  }
}

// ─── Condition de faisabilite DUAL ────────────────────────────────────────

/**
 * Condition de Faisabilite (FC) de DUAL :
 * Un voisin est un Feasible Successor si son Advertised Distance (AD)
 * est strictement inferieure a la Feasible Distance (FD) courante.
 *
 * FC : AD(neighbor) < FD(current_successor)
 *
 * Cette condition garantit mathematiquement l'absence de boucle.
 */
export function isFeasibleSuccessor(
  neighborAd: number,   // Advertised Distance du voisin
  currentFd:  number,   // Feasible Distance actuelle (best known metric)
): boolean {
  return neighborAd < currentFd
}

// ─── Summarization ────────────────────────────────────────────────────────

/**
 * Verifie qu'un prefix est couvert par une adresse summary.
 * Ex. 10.1.1.0/24 couvert par 10.0.0.0/8 : true
 */
export function isSubsumedBy(
  prefix: EigrpPrefix,
  summary: EigrpPrefix,
): boolean {
  return prefix.prefixLen >= summary.prefixLen &&
    EigrpPrefix.contains(summary, prefix.network)
}

// ─── Calcul de variance (unequal-cost load balancing) ────────────────────

/**
 * Retourne true si la metrique 'candidate' peut participer au load balancing
 * avec 'bestMetric' selon le parametre variance.
 *
 * Cisco variance : candidate_FD <= variance × best_FD
 * (ET candidate_AD < best_FD pour satisfaire la condition de faisabilite)
 */
export function meetsVariance(
  candidateFd: number,
  bestFd:      number,
  variance:    number,   // 1..128 (1 = equal-cost only)
): boolean {
  return candidateFd <= variance * bestFd
}

// ─── Formatage pour 'show ip eigrp topology' ─────────────────────────────

export function formatEigrpMetricDisplay(m: EigrpInterfaceMetric): string {
  const bw = m.bandwidth >= 1_000_000
    ? `${m.bandwidth / 1_000_000} Gb/s`
    : m.bandwidth >= 1_000
      ? `${m.bandwidth / 1_000} Mb/s`
      : `${m.bandwidth} Kb/s`
  return `BW ${bw}, DLY ${m.delay} usec`
}

export function formatFdAd(fd: number, ad: number): string {
  return `(${fd}/${ad})`
}
```

### 3.6 EigrpNeighborKey — cle unique d'un voisin

```typescript
// src/network/eigrp/values/EigrpNeighborKey.ts

/**
 * Cle unique d'un voisin EIGRP : adresse IP + interface locale.
 * Deux voisins avec la meme IP sur des interfaces differentes sont distincts.
 */
export type EigrpNeighborKey = Readonly<{
  readonly _tag:    'EigrpNeighborKey'
  readonly ip:      string   // ex. '10.0.0.2'
  readonly iface:   string   // ex. 'GigabitEthernet0/0'
}>

export const EigrpNeighborKey = {
  of(ip: string, iface: string): EigrpNeighborKey {
    return Object.freeze({ _tag: 'EigrpNeighborKey', ip, iface })
  },

  toString(k: EigrpNeighborKey): string { return `${k.ip}%${k.iface}` },

  equals(a: EigrpNeighborKey, b: EigrpNeighborKey): boolean {
    return a.ip === b.ip && a.iface === b.iface
  },

  toMapKey(k: EigrpNeighborKey): string { return EigrpNeighborKey.toString(k) },
}
```

### 3.7 Diagramme des Value Objects

```
EigrpAsNumber      (1..65535, validé a la construction)
EigrpRid           (IPv4 dotted, highest loopback rule)
EigrpPrefix        (network + prefixLen, contains(), compare())
EigrpMetric        (composite + components, isInfinite(), min())
EigrpNeighborKey   (ip + iface, used as Map key)

EigrpInterfaceMetric   (bandwidth, delay, reliability, load, mtu)
EigrpKValues           (K1..K5, DEFAULT_K_VALUES)

EigrpPureUtils (module de fonctions pures — zero etat)
  computeEigrpMetric(components, kValues) --> EigrpMetric
  accumulateMetric(pathSoFar, nextHop)    --> EigrpInterfaceMetric
  isFeasibleSuccessor(neighborAd, currentFd) --> boolean
  isSubsumedBy(prefix, summary)           --> boolean
  meetsVariance(candidateFd, bestFd, v)   --> boolean
  formatEigrpMetricDisplay(m)             --> string
  formatFdAd(fd, ad)                      --> string
```

Invariant : **tous immuables** (`Object.freeze`). La metrique EIGRP est calculee une fois a la reception d'un Update, jamais recalculee en ligne lors du lookup. Testable sans aucun mock.

---

## 4. Topology Table et Neighbor Table — Repository

### 4.1 Pourquoi deux tables separees ?

EIGRP maintient deux bases de donnees distinctes :
1. **Topology Table** : toutes les routes connues avec leurs metriques par voisin, l'etat DUAL (Passive/Active) et les successeurs. C'est le coeur de DUAL.
2. **Neighbor Table** : les voisins actifs avec leurs parametres (K-values, hold timer, seq numbers). C'est le socle du RTP.

La separation respecte le **Single Responsibility Principle** : les operations de voisinage n'ont pas besoin d'acceder a la topology table et vice-versa.

### 4.2 RouteSource — source d'une entree de topologie

```typescript
// src/network/eigrp/topology/types.ts

import type { EigrpNeighborKey }  from '../values/EigrpNeighborKey'
import type { EigrpMetric }       from '../values/EigrpMetric'
import type { EigrpInterfaceMetric } from '../values/EigrpMetric'

/**
 * Un Successor ou Feasible Successor dans la Topology Table.
 * Immuable — produit un nouvel objet a chaque mise a jour.
 */
export interface RouteSource {
  readonly neighbor:     EigrpNeighborKey
  /** Advertised Distance : metrique annoncee PAR le voisin (son FD a lui) */
  readonly ad:           number
  /** Feasible Distance : metrique LOCALE = metric(neighbor) + ad */
  readonly fd:           number
  readonly metric:       EigrpMetric          // metrique composite calculee
  readonly components:   EigrpInterfaceMetric  // composantes brutes (BW, delay...)
  readonly isSuccessor:  boolean               // true = meilleur chemin actuel
}

// ─── Etat DUAL d'une entree de topologie ──────────────────────────────────

/**
 * Une entree de topologie peut etre dans 4 etats DUAL (RFC 7868 §5.4.2) :
 *
 * Passive (P) : route stable, un successor existe
 *   - Aucun calcul DUAL en cours
 *   - Les mises a jour sont appliquees immediatement
 *
 * Active (A) : DUAL en cours de diffusion (Diffusing Computation)
 *   - Le routeur a envoye des Queries a ses voisins
 *   - En attente de Replies avant de ré-evaluer
 *   - Sous-etats definis par l'origine de l'Active et qui a ete query
 *
 * SIA (Stuck-In-Active) : Active depuis trop longtemps
 *   - SIA timer expire sans avoir recu tous les Replies
 *   - Le voisin qui n'a pas repondu est declare down
 */
export type DualState =
  | { readonly phase: 'passive' }
  | {
      readonly phase:          'active'
      readonly queryOrigin:    'local' | 'received'
      readonly queriedNeighbors: ReadonlySet<string>   // EigrpNeighborKey.toMapKey()
      readonly repliesReceived:  ReadonlySet<string>
      readonly siaTimerStart:  number    // Date.now() quand Active demarre
    }
  | { readonly phase: 'sia' }  // Stuck-In-Active

// ─── TopologyEntry — entree complete dans la topology table ───────────────

export interface TopologyEntry {
  readonly prefix:     import('../values/EigrpPrefix').EigrpPrefix
  readonly state:      DualState
  /** Successeurs et feasible successors (tri par FD asc) */
  readonly sources:    readonly RouteSource[]
  /** Meilleure FD connue (min des FD des sources disponibles) */
  readonly bestFd:     number
  /** Successeur courant (sources[0] si state=passive et non-infini) */
  readonly successor:  RouteSource | null
  /** Feasible Successors (sources dont AD < bestFd) */
  readonly feasibleSuccessors: readonly RouteSource[]
  /** true = route originee localement (connected / redistributed) */
  readonly isLocal:    boolean
  /** Summary address qui subsume cette route (si definie) */
  readonly subsumedBy: import('../values/EigrpPrefix').EigrpPrefix | null
}
```

### 4.3 IEigrpTopologyRepository — interface Repository

```typescript
// src/network/eigrp/topology/IEigrpTopologyRepository.ts

import type { TopologyEntry, RouteSource, DualState } from './types'
import type { EigrpPrefix }     from '../values/EigrpPrefix'
import type { EigrpNeighborKey } from '../values/EigrpNeighborKey'

// ─── Lecture ─────────────────────────────────────────────────────────────

export interface IEigrpTopologyReader {
  getEntry(prefix: EigrpPrefix): TopologyEntry | null
  getAllEntries(): readonly TopologyEntry[]
  getPassiveEntries(): readonly TopologyEntry[]
  getActiveEntries(): readonly TopologyEntry[]
  /** Retourne toutes les routes apprises via un voisin donne */
  getEntriesFromNeighbor(neighbor: EigrpNeighborKey): readonly TopologyEntry[]
  /** Routes installables dans le RIB (passive + successor non-infini) */
  getRoutableEntries(): readonly TopologyEntry[]
}

// ─── Ecriture ─────────────────────────────────────────────────────────────

export interface IEigrpTopologyWriter {
  /** Ajoute ou met a jour une source (voisin) pour un prefix */
  upsertSource(prefix: EigrpPrefix, source: RouteSource): void
  /** Retire toutes les sources apprises d'un voisin (voisin down) */
  removeNeighborSources(neighbor: EigrpNeighborKey): readonly EigrpPrefix[]
  /** Met a jour l'etat DUAL d'une entree */
  setDualState(prefix: EigrpPrefix, state: DualState): void
  /** Supprime une entree (route retiree de partout) */
  removeEntry(prefix: EigrpPrefix): void
  /** Ajoute une route locale (connected / redistributed) */
  addLocalEntry(entry: TopologyEntry): void
  clear(): void
}

export interface IEigrpTopologyRepository
  extends IEigrpTopologyReader, IEigrpTopologyWriter {}
```

### 4.4 InMemoryTopologyTable — implementation

```typescript
// src/network/eigrp/topology/InMemoryTopologyTable.ts

import type { IEigrpTopologyRepository }    from './IEigrpTopologyRepository'
import type { TopologyEntry, RouteSource, DualState } from './types'
import type { EigrpPrefix }    from '../values/EigrpPrefix'
import type { EigrpNeighborKey } from '../values/EigrpNeighborKey'
import { EigrpPrefix as EigrpPrefixNS } from '../values/EigrpPrefix'
import { EigrpNeighborKey as NK }        from '../values/EigrpNeighborKey'
import { isFeasibleSuccessor }           from '../EigrpPureUtils'

export class InMemoryTopologyTable implements IEigrpTopologyRepository {
  private readonly _entries = new Map<string, TopologyEntry>()

  private _key(p: EigrpPrefix): string { return EigrpPrefixNS.toString(p) }

  // ── Lecture ────────────────────────────────────────────────────────────

  getEntry(prefix: EigrpPrefix): TopologyEntry | null {
    return this._entries.get(this._key(prefix)) ?? null
  }

  getAllEntries(): readonly TopologyEntry[] {
    return [...this._entries.values()]
  }

  getPassiveEntries(): readonly TopologyEntry[] {
    return this.getAllEntries().filter(e => e.state.phase === 'passive')
  }

  getActiveEntries(): readonly TopologyEntry[] {
    return this.getAllEntries().filter(e => e.state.phase === 'active')
  }

  getEntriesFromNeighbor(neighbor: EigrpNeighborKey): readonly TopologyEntry[] {
    const nk = NK.toMapKey(neighbor)
    return this.getAllEntries().filter(e =>
      e.sources.some(s => NK.toMapKey(s.neighbor) === nk)
    )
  }

  getRoutableEntries(): readonly TopologyEntry[] {
    return this.getAllEntries().filter(e =>
      e.state.phase === 'passive' &&
      e.successor !== null &&
      e.successor.fd < 0xFFFFFFFF
    )
  }

  // ── Ecriture ───────────────────────────────────────────────────────────

  upsertSource(prefix: EigrpPrefix, source: RouteSource): void {
    const key     = this._key(prefix)
    const existing = this._entries.get(key)
    const nk       = NK.toMapKey(source.neighbor)

    const sources = existing
      ? existing.sources.filter(s => NK.toMapKey(s.neighbor) !== nk)
      : []
    sources.push(source)

    this._entries.set(key, this._recompute(prefix, existing, sources, existing?.state))
  }

  removeNeighborSources(neighbor: EigrpNeighborKey): readonly EigrpPrefix[] {
    const nk       = NK.toMapKey(neighbor)
    const affected: EigrpPrefix[] = []

    for (const [key, entry] of this._entries) {
      const remaining = entry.sources.filter(s => NK.toMapKey(s.neighbor) !== nk)
      if (remaining.length !== entry.sources.length) {
        affected.push(entry.prefix)
        if (remaining.length === 0 && !entry.isLocal) {
          this._entries.delete(key)
        } else {
          this._entries.set(key, this._recompute(entry.prefix, entry, remaining, entry.state))
        }
      }
    }
    return affected
  }

  setDualState(prefix: EigrpPrefix, state: DualState): void {
    const entry = this._entries.get(this._key(prefix))
    if (entry) {
      this._entries.set(this._key(prefix), { ...entry, state })
    }
  }

  removeEntry(prefix: EigrpPrefix): void {
    this._entries.delete(this._key(prefix))
  }

  addLocalEntry(entry: TopologyEntry): void {
    this._entries.set(this._key(entry.prefix), entry)
  }

  clear(): void { this._entries.clear() }

  // ── Helper : recalcul de successor et FS ──────────────────────────────

  private _recompute(
    prefix: EigrpPrefix,
    existing: TopologyEntry | undefined,
    sources: RouteSource[],
    state: DualState | undefined,
  ): TopologyEntry {
    // Trier par FD croissante
    const sorted = [...sources].sort((a, b) => a.fd - b.fd)
    const bestFd  = sorted[0]?.fd ?? 0xFFFFFFFF

    // Successeur = source avec la plus faible FD
    const successor = sorted[0] ?? null

    // Feasible Successors = sources dont AD < bestFD (condition de faisabilite)
    const fs = sorted.slice(1).filter(s =>
      isFeasibleSuccessor(s.ad, bestFd) && !s.isSuccessor
    )

    return Object.freeze({
      prefix,
      state:              state ?? { phase: 'passive' },
      sources:            Object.freeze(sorted),
      bestFd,
      successor:          successor ? { ...successor, isSuccessor: true } : null,
      feasibleSuccessors: Object.freeze(fs),
      isLocal:            existing?.isLocal ?? false,
      subsumedBy:         existing?.subsumedBy ?? null,
    })
  }
}
```

### 4.5 EigrpNeighborEntry et IEigrpNeighborRepository

```typescript
// src/network/eigrp/neighbor/types.ts

import type { EigrpNeighborKey } from '../values/EigrpNeighborKey'
import type { EigrpKValues }     from '../values/EigrpMetric'

export interface EigrpNeighborEntry {
  readonly key:           EigrpNeighborKey
  readonly routerId:      string          // RID annonce dans le Hello
  readonly asNumber:      number
  readonly kValues:       EigrpKValues
  readonly holdTime:      number          // secondes (annonce dans le Hello)
  readonly uptime:        Date            // quand le voisin est passe Up
  readonly lastHelloRx:   number          // Date.now() de la derniere reception
  readonly seqSent:       number          // dernier seqno envoye a ce voisin
  readonly seqExpected:   number          // prochain seqno attendu de ce voisin
  readonly srtt:          number          // Smooth Round-Trip Time en ms
  readonly rto:           number          // Retransmit Timeout en ms
  readonly qCount:        number          // nb de paquets en file retransmission
  readonly version:       { ios: string; eigrp: string }  // versions logicielles
  readonly isStub:        boolean         // voisin en mode stub
  readonly stubRoutes:    readonly ('connected'|'static'|'summary'|'redistributed')[]
}

// ─── Repository ─────────────────────────────────────────────────────────

export interface IEigrpNeighborRepository {
  get(key: EigrpNeighborKey): EigrpNeighborEntry | null
  getAll(): readonly EigrpNeighborEntry[]
  getByInterface(iface: string): readonly EigrpNeighborEntry[]
  add(entry: EigrpNeighborEntry): void
  update(key: EigrpNeighborKey, patch: Partial<EigrpNeighborEntry>): void
  remove(key: EigrpNeighborKey): EigrpNeighborEntry | null
  clear(): void
}
```

### 4.6 Diagramme des tables

```
IEigrpTopologyRepository (ISP: Reader + Writer)
  |
  +-- InMemoryTopologyTable
        _entries: Map<string, TopologyEntry>
        upsertSource() -> _recompute() -> recalcule successor + FS
        removeNeighborSources() -> retourne prefixes affectes

TopologyEntry (immuable)
  prefix: EigrpPrefix
  state:  DualState (passive | active | sia)
  sources: RouteSource[]         tri par FD asc
  successor: RouteSource | null  sources[0]
  feasibleSuccessors: RouteSource[]  AD < bestFD

RouteSource (immuable)
  neighbor: EigrpNeighborKey
  ad:  Advertised Distance   (metric du voisin)
  fd:  Feasible Distance     (metric locale = metric(neighbor) + ad)
  metric: EigrpMetric        (composite + composantes)

IEigrpNeighborRepository
  +-- InMemoryNeighborTable
        _neighbors: Map<string, EigrpNeighborEntry>

EigrpNeighborEntry (immuable)
  key: EigrpNeighborKey
  kValues, holdTime, uptime, seqSent, seqExpected, srtt, rto...
```

---

## 5. Machine a etats voisin — State Machine discriminee

### 5.1 Etats du voisin EIGRP

EIGRP est beaucoup plus simple qu'OSPF pour le voisinage : il n'y a que **2 etats** (vs 8 pour OSPF). La complexite est dans la robustesse des checks a la transition.

```typescript
// src/network/eigrp/neighbor/EigrpNeighborState.ts

export type EigrpNeighborState =
  | {
      readonly phase: 'idle'
      // Aucun voisin connu. Etat initial et final.
    }
  | {
      readonly phase:     'pending'
      readonly seenAt:    number     // Date.now() du premier Hello recu
      readonly kValues:   import('../values/EigrpMetric').EigrpKValues
      readonly asNumber:  number
      // Hello recu mais pas encore envoye de Hello en retour (race condition).
      // Necessite un Hello sortant pour confirmer la relation.
    }
  | {
      readonly phase:       'up'
      readonly upSince:     number   // Date.now()
      readonly holdTimerId: ReturnType<typeof setTimeout>
      // Voisin actif. Hold timer redemarre a chaque Hello recu.
    }
  | {
      readonly phase:  'down'
      readonly reason: import('../EigrpError').EigrpErrorCode
      // Etat transitoire avant purge de la neighbor table.
      // Declenche removeNeighborSources() dans la topology table.
    }
```

### 5.2 Evenements de transition

```
          ┌──────────────────────────────────────────────────────────────┐
          │                  EIGRP NEIGHBOR STATE MACHINE               │
          └──────────────────────────────────────────────────────────────┘

  ┌──────┐   HELLO_RECEIVED          ┌─────────┐  HELLO_SENT_BACK    ┌────┐
  │      │ ─────────────────────────>│ pending │ ──────────────────> │    │
  │ idle │                           └─────────┘                     │ up │
  │      │                                |                          │    │
  └──────┘ <───────────────────────────── |  K_MISMATCH              └────┘
     ^                                   AS_MISMATCH                   |
     |                                   AUTH_FAIL                     |
     |                                                                  |
     |  INTERFACE_DOWN / RESET                                         |
     |                                                HOLD_EXPIRED     |
     |                                                INTERFACE_DOWN   |
     |                                                K_MISMATCH       |
     |                                                                  |
     |      ┌──────┐                                                   |
     └───── │ down │ <─────────────────────────────────────────────────┘
            └──────┘
              (transitoire -> retour idle + purge topology)
```

### 5.3 EigrpNeighborStateMachine — implementation

```typescript
// src/network/eigrp/neighbor/EigrpNeighborStateMachine.ts

import type { EigrpNeighborState }       from './EigrpNeighborState'
import type { EigrpEvent }               from '../EigrpEvent'
import type { EigrpNeighborKey }         from '../values/EigrpNeighborKey'
import type { IEigrpNeighborRepository } from './types'
import type { EigrpKValues }             from '../values/EigrpMetric'
import { makeEigrpError }                from '../EigrpError'
import { DEFAULT_K_VALUES }              from '../values/EigrpMetric'

export interface NeighborStateMachineCallbacks {
  /** Declenche quand un voisin passe Up — envoie un Update complet */
  onNeighborUp(key: EigrpNeighborKey): void
  /** Declenche quand un voisin passe Down — purge ses routes */
  onNeighborDown(key: EigrpNeighborKey, reason: string): void
  /** Envoie un Hello de retour (transition pending -> up) */
  sendHello(iface: string): void
}

export class EigrpNeighborStateMachine {
  private readonly _states = new Map<string, EigrpNeighborState>()

  constructor(
    private readonly _localKValues: EigrpKValues,
    private readonly _localAs:      number,
    private readonly _repo:         IEigrpNeighborRepository,
    private readonly _cb:           NeighborStateMachineCallbacks,
    private readonly _holdDefault   = 15,  // secondes
  ) {}

  /**
   * Traite un evenement et fait transitionner la machine d'etat du voisin.
   * Fonction principale d'orchestration — appele par EigrpProcess.
   */
  processEvent(key: EigrpNeighborKey, event: EigrpEvent): void {
    const stateKey = import('../values/EigrpNeighborKey').EigrpNeighborKey.toMapKey(key)
    const current  = this._states.get(stateKey) ?? { phase: 'idle' }

    const next = this._transition(key, current, event)
    if (next !== current) {
      this._states.set(stateKey, next)
      this._onTransition(key, current, next)
    }
  }

  private _transition(
    key:     EigrpNeighborKey,
    current: EigrpNeighborState,
    event:   EigrpEvent,
  ): EigrpNeighborState {
    switch (current.phase) {
      case 'idle':
        if (event.type === 'HELLO_RECEIVED') {
          if (!this._kValuesMatch(event.kValues)) {
            return { phase: 'down', reason: 'NEIGHBOR_K_MISMATCH' }
          }
          if (event.asNumber !== this._localAs) {
            return { phase: 'down', reason: 'NEIGHBOR_AS_MISMATCH' }
          }
          // Envoyer un Hello de retour est requis avant de passer Up
          return {
            phase:    'pending',
            seenAt:   Date.now(),
            kValues:  { k1: event.kValues[0], k2: event.kValues[1],
                        k3: event.kValues[2], k4: event.kValues[3], k5: event.kValues[4] },
            asNumber: event.asNumber,
          }
        }
        return current

      case 'pending':
        if (event.type === 'HELLO_RECEIVED') {
          // Deuxieme Hello confirme — voisin passe Up
          const timerId = setTimeout(
            () => this.processEvent(key, { type: 'HOLD_TIMER_EXPIRED',
              neighbor: key, iface: key.iface }),
            current.kValues.k1 * this._holdDefault * 1000,  // hold time en ms
          )
          return { phase: 'up', upSince: Date.now(), holdTimerId: timerId }
        }
        if (event.type === 'NEIGHBOR_DOWN') {
          return { phase: 'down', reason: event.reason }
        }
        return current

      case 'up':
        if (event.type === 'HELLO_RECEIVED') {
          // Reset du hold timer
          clearTimeout(current.holdTimerId)
          const timerId = setTimeout(
            () => this.processEvent(key, { type: 'HOLD_TIMER_EXPIRED',
              neighbor: key, iface: key.iface }),
            event.holdTime * 1000,
          )
          return { ...current, holdTimerId: timerId }
        }
        if (event.type === 'HOLD_TIMER_EXPIRED' || event.type === 'NEIGHBOR_DOWN') {
          clearTimeout(current.holdTimerId)
          const reason = event.type === 'HOLD_TIMER_EXPIRED'
            ? 'NEIGHBOR_HOLD_EXPIRED'
            : event.reason
          return { phase: 'down', reason }
        }
        return current

      case 'down':
        // Etat transitoire — retour automatique a idle dans _onTransition
        return { phase: 'idle' }
    }
  }

  private _onTransition(
    key:  EigrpNeighborKey,
    from: EigrpNeighborState,
    to:   EigrpNeighborState,
  ): void {
    if (to.phase === 'pending') {
      // Envoyer un Hello de retour pour confirmer la relation
      this._cb.sendHello(key.iface)
    }
    if (to.phase === 'up') {
      this._cb.onNeighborUp(key)
    }
    if (to.phase === 'down') {
      this._cb.onNeighborDown(key, to.reason)
      // Retour immediat a idle (down est juste un signal)
      const stateKey = import('../values/EigrpNeighborKey').EigrpNeighborKey.toMapKey(key)
      this._states.set(stateKey, { phase: 'idle' })
    }
  }

  private _kValuesMatch(
    received: readonly [number, number, number, number, number],
  ): boolean {
    return received[0] === this._localKValues.k1 &&
           received[1] === this._localKValues.k2 &&
           received[2] === this._localKValues.k3 &&
           received[3] === this._localKValues.k4 &&
           received[4] === this._localKValues.k5
  }

  getState(key: EigrpNeighborKey): EigrpNeighborState {
    const stateKey = import('../values/EigrpNeighborKey').EigrpNeighborKey.toMapKey(key)
    return this._states.get(stateKey) ?? { phase: 'idle' }
  }
}
```

### 5.4 Conditions de voisinage EIGRP

Un voisin EIGRP n'est accepte que si **toutes** les conditions suivantes sont remplies :

| Condition | Verification | Consequence si echec |
|---|---|---|
| Meme AS number | `hello.asNumber === local.asNumber` | Paquet ignore (silencieux) |
| K-values identiques | `K1..K5 du Hello == K1..K5 locaux` | `%DUAL-5-NBRCHANGE: K-value mismatch` |
| Authentification | MD5 HMAC ou SHA-256 valide | Hello rejete |
| Meme sous-reseau | IP du voisin dans le meme /N | Voisinage impossible |
| TTL = 1 | EIGRP hello non routable | Protection contre reflexion |

### 5.5 Diagramme complet du sous-systeme voisin

```
EigrpNeighborStateMachine
  _states: Map<string, EigrpNeighborState>
  _localKValues: EigrpKValues
  _localAs: number
  processEvent(key, event) --> transition --> callback

  Transitions :
  idle    --[HELLO_RECEIVED + checks OK]-->  pending
  idle    --[HELLO_RECEIVED + K_mismatch]--> down -> idle
  pending --[HELLO_RECEIVED]-->              up    (holdTimer demarre)
  up      --[HELLO_RECEIVED]-->              up    (holdTimer reset)
  up      --[HOLD_EXPIRED | NEIGHBOR_DOWN]-> down -> idle

Callbacks (implementes par EigrpProcess) :
  onNeighborUp(key)    --> sendFullUpdate() + log
  onNeighborDown(key)  --> topology.removeNeighborSources() + DUAL.recompute()
  sendHello(iface)     --> EigrpPacketDispatcher.sendHello()

IEigrpNeighborRepository
  get / getAll / getByInterface / add / update / remove
```

---

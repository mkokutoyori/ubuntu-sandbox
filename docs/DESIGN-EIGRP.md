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

## 6. Algorithme DUAL — Strategy + Pure Functions

### 6.1 Theorie de DUAL (RFC 7868 §5)

DUAL (Diffusing Update Algorithm, Cisco/Garcia-Luna-Aceves 1993) garantit la convergence sans boucle par la **condition de faisabilite** :

```
Pour qu'un chemin via le voisin V soit un Feasible Successor de D :
  AD(V, D) < FD(local, D)

Ou :
  AD(V, D) = Advertised Distance de V vers D (metrique de V vers D)
  FD(local, D) = Feasible Distance locale courante (meilleure metrique connue)
```

Cette condition garantit mathematiquement que V n'a pas de route passant par le routeur local — donc pas de boucle.

**Cas sans FS disponible → Active State :**
Quand le successeur est perdu et qu'aucun FS ne satisfait la condition, le routeur demarre une **Diffusing Computation** :
1. Passe en etat Active
2. Envoie une Query a tous ses voisins (sauf le nouveau successeur eventuel)
3. Attend les Replies de tous les voisins queried
4. Re-evalue avec les nouvelles metriques recues

### 6.2 IDualAlgorithm — interface Strategy

```typescript
// src/network/eigrp/dual/IDualAlgorithm.ts

import type { Result }            from '../result'
import type { EigrpError }        from '../EigrpError'
import type { EigrpPrefix }       from '../values/EigrpPrefix'
import type { EigrpNeighborKey }  from '../values/EigrpNeighborKey'
import type { EigrpMetric }       from '../values/EigrpMetric'
import type { TopologyEntry }     from '../topology/types'

/**
 * Actions que DUAL demande au processus EIGRP d'effectuer
 * (envoyer des paquets, mettre a jour le RIB...).
 * DUAL lui-meme est pur : il ne fait rien, il retourne des actions.
 */
export type DualAction =
  | { readonly type: 'INSTALL_ROUTE';   readonly prefix: EigrpPrefix; readonly via: EigrpNeighborKey; readonly fd: number }
  | { readonly type: 'WITHDRAW_ROUTE';  readonly prefix: EigrpPrefix }
  | { readonly type: 'SEND_UPDATE';     readonly prefix: EigrpPrefix; readonly metric: EigrpMetric; readonly to?: EigrpNeighborKey }
  | { readonly type: 'SEND_QUERY';      readonly prefix: EigrpPrefix; readonly metric: EigrpMetric; readonly to?: EigrpNeighborKey }
  | { readonly type: 'SEND_REPLY';      readonly prefix: EigrpPrefix; readonly metric: EigrpMetric; readonly to: EigrpNeighborKey }
  | { readonly type: 'START_SIA_TIMER'; readonly prefix: EigrpPrefix }
  | { readonly type: 'DECLARE_NEIGHBOR_DOWN'; readonly neighbor: EigrpNeighborKey; readonly reason: string }
  | { readonly type: 'LOG';            readonly message: string; readonly level: 'info' | 'warn' | 'error' }

/**
 * Interface Strategy pour l'algorithme DUAL.
 * Peut etre remplacee par une implementation simplifiee pour les tests
 * ou etendue pour EIGRP Named Mode avec variance.
 */
export interface IDualAlgorithm {
  /**
   * Traite une mise a jour de metrique depuis un voisin.
   * Retourne les actions a executer (update RIB, envoyer Query, etc.)
   */
  processUpdate(
    prefix:  EigrpPrefix,
    from:    EigrpNeighborKey,
    ad:      number,
    metric:  EigrpMetric,
  ): Result<readonly DualAction[], EigrpError>

  /**
   * Traite une Query recue d'un voisin.
   * Retourne toujours un Reply (avec la metrique courante ou infinie).
   */
  processQuery(
    prefix: EigrpPrefix,
    from:   EigrpNeighborKey,
    ad:     number,
    metric: EigrpMetric,
  ): Result<readonly DualAction[], EigrpError>

  /**
   * Traite un Reply recu en reponse a une Query.
   * Si tous les Replies sont recus, termine l'etat Active.
   */
  processReply(
    prefix: EigrpPrefix,
    from:   EigrpNeighborKey,
    ad:     number,
    metric: EigrpMetric,
  ): Result<readonly DualAction[], EigrpError>

  /**
   * Declenche la re-evaluation de toutes les routes apprises via ce voisin.
   * Appele quand un voisin passe Down.
   */
  processNeighborDown(
    neighbor: EigrpNeighborKey,
  ): Result<readonly DualAction[], EigrpError>

  /**
   * Injecte une route locale (connected / redistributed).
   * Retourne les actions d'annonce aux voisins.
   */
  injectLocalRoute(
    prefix:  EigrpPrefix,
    metric:  EigrpMetric,
  ): Result<readonly DualAction[], EigrpError>

  /**
   * Retire une route locale (interface down / no redistribute).
   */
  withdrawLocalRoute(
    prefix: EigrpPrefix,
  ): Result<readonly DualAction[], EigrpError>
}
```

### 6.3 DualAlgorithmImpl — implementation

```typescript
// src/network/eigrp/dual/DualAlgorithmImpl.ts

import type { IDualAlgorithm }           from './IDualAlgorithm'
import type { DualAction }               from './IDualAlgorithm'
import type { IEigrpTopologyRepository } from '../topology/IEigrpTopologyRepository'
import type { EigrpPrefix }              from '../values/EigrpPrefix'
import type { EigrpNeighborKey }         from '../values/EigrpNeighborKey'
import type { EigrpMetric }              from '../values/EigrpMetric'
import type { EigrpKValues }             from '../values/EigrpMetric'
import type { Result }                   from '../result'
import type { EigrpError }               from '../EigrpError'
import { ok, err }                       from '../result'
import { makeEigrpError }                from '../EigrpError'
import { EIGRP_INFINITY }                from '../values/EigrpMetric'
import { EigrpNeighborKey as NK }        from '../values/EigrpNeighborKey'
import { EigrpPrefix as EP }             from '../values/EigrpPrefix'
import { computeEigrpMetric, isFeasibleSuccessor } from '../EigrpPureUtils'
import type { RouteSource }              from '../topology/types'

export class DualAlgorithmImpl implements IDualAlgorithm {
  constructor(
    private readonly _topo:        IEigrpTopologyRepository,
    private readonly _kValues:     EigrpKValues,
    private readonly _localRid:    string,
    private readonly _allNeighborKeys: () => readonly EigrpNeighborKey[],
    private readonly _siaTimeoutMs: number = 90_000,
  ) {}

  // ── processUpdate ─────────────────────────────────────────────────────

  processUpdate(
    prefix:  EigrpPrefix,
    from:    EigrpNeighborKey,
    ad:      number,
    metric:  EigrpMetric,
  ): Result<readonly DualAction[], EigrpError> {
    const actions: DualAction[] = []
    const isWithdraw = metric.composite >= 0xFFFFFFFF

    if (isWithdraw) {
      this._topo.upsertSource(prefix, {
        neighbor: from, ad: 0xFFFFFFFF, fd: 0xFFFFFFFF,
        metric: EIGRP_INFINITY, components: metric.components, isSuccessor: false,
      })
    } else {
      const source: RouteSource = {
        neighbor: from, ad, fd: ad + metric.composite,
        metric, components: metric.components, isSuccessor: false,
      }
      this._topo.upsertSource(prefix, source)
    }

    const entry = this._topo.getEntry(prefix)!

    if (entry.state.phase === 'active') {
      // En etat Active : on ne change pas le RIB, on attend les Replies
      return ok(actions)
    }

    // Etat Passive : recalcul immédiat
    return this._recomputePassive(prefix, actions)
  }

  // ── processQuery ──────────────────────────────────────────────────────

  processQuery(
    prefix: EigrpPrefix,
    from:   EigrpNeighborKey,
    ad:     number,
    metric: EigrpMetric,
  ): Result<readonly DualAction[], EigrpError> {
    const actions: DualAction[] = []
    const entry = this._topo.getEntry(prefix)

    if (!entry || entry.successor === null || entry.state.phase === 'active') {
      // Pas de route -> Reply avec metric infinie
      actions.push({
        type: 'SEND_REPLY', prefix,
        metric: EIGRP_INFINITY, to: from,
      })
      return ok(actions)
    }

    // On a un successor : reply avec notre FD actuelle
    const ourFd = entry.bestFd
    const ourMetric = entry.successor.metric

    // Mettre a jour la source du voisin queriant
    this._topo.upsertSource(prefix, {
      neighbor: from, ad, fd: ad + metric.composite,
      metric, components: metric.components, isSuccessor: false,
    })

    if (entry.successor && NK.toMapKey(entry.successor.neighbor) !== NK.toMapKey(from)) {
      // Notre successor n'est PAS ce voisin -> on peut repondre avec notre route
      actions.push({ type: 'SEND_REPLY', prefix, metric: ourMetric, to: from })
    } else {
      // Notre successor EST le voisin qui query -> on doit lancer une diffusion
      actions.push({ type: 'SEND_REPLY', prefix, metric: EIGRP_INFINITY, to: from })
      actions.push(...this._startDiffusion(prefix, from))
    }

    return ok(actions)
  }

  // ── processReply ──────────────────────────────────────────────────────

  processReply(
    prefix: EigrpPrefix,
    from:   EigrpNeighborKey,
    ad:     number,
    metric: EigrpMetric,
  ): Result<readonly DualAction[], EigrpError> {
    const actions: DualAction[] = []
    const entry = this._topo.getEntry(prefix)

    if (!entry || entry.state.phase !== 'active') {
      return ok(actions)  // Reply inattendu, ignore
    }

    const activeState = entry.state
    // Enregistrer le Reply recu
    const fromKey     = NK.toMapKey(from)
    const newReplied  = new Set([...activeState.repliesReceived, fromKey])

    // Mettre a jour la source
    this._topo.upsertSource(prefix, {
      neighbor: from, ad, fd: ad + metric.composite,
      metric, components: metric.components, isSuccessor: false,
    })

    // Verifier si tous les Replies sont recus
    if ([...activeState.queriedNeighbors].every(nk => newReplied.has(nk))) {
      // Diffusion terminee -> retour en Passive
      this._topo.setDualState(prefix, { phase: 'passive' })
      actions.push({ type: 'LOG', message: `DUAL: ${EP.toString(prefix)} active -> passive`, level: 'info' })
      return this._recomputePassive(prefix, actions)
    }

    // Mise a jour partielle de l'etat Active
    this._topo.setDualState(prefix, {
      ...activeState,
      repliesReceived: newReplied,
    })
    return ok(actions)
  }

  // ── processNeighborDown ───────────────────────────────────────────────

  processNeighborDown(
    neighbor: EigrpNeighborKey,
  ): Result<readonly DualAction[], EigrpError> {
    const actions: DualAction[] = []
    const affectedPrefixes = this._topo.removeNeighborSources(neighbor)

    for (const prefix of affectedPrefixes) {
      const sub = this._recomputePassive(prefix, actions)
      if (!sub.ok) return sub
    }
    return ok(actions)
  }

  // ── injectLocalRoute ──────────────────────────────────────────────────

  injectLocalRoute(
    prefix:  EigrpPrefix,
    metric:  EigrpMetric,
  ): Result<readonly DualAction[], EigrpError> {
    const source: RouteSource = {
      neighbor: { _tag: 'EigrpNeighborKey', ip: 'local', iface: 'local' } as EigrpNeighborKey,
      ad: 0, fd: metric.composite,
      metric, components: metric.components, isSuccessor: true,
    }
    this._topo.addLocalEntry({
      prefix,
      state: { phase: 'passive' },
      sources: [source],
      bestFd: metric.composite,
      successor: source,
      feasibleSuccessors: [],
      isLocal: true,
      subsumedBy: null,
    })
    return ok([{
      type: 'SEND_UPDATE', prefix, metric,
    }])
  }

  withdrawLocalRoute(prefix: EigrpPrefix): Result<readonly DualAction[], EigrpError> {
    this._topo.removeEntry(prefix)
    return ok([{
      type: 'SEND_UPDATE', prefix, metric: EIGRP_INFINITY,
    }])
  }

  // ── Helpers prives ────────────────────────────────────────────────────

  private _recomputePassive(
    prefix:  EigrpPrefix,
    actions: DualAction[],
  ): Result<readonly DualAction[], EigrpError> {
    const entry = this._topo.getEntry(prefix)
    if (!entry) return ok(actions)

    if (entry.successor !== null && entry.successor.fd < 0xFFFFFFFF) {
      // Route accessible -> installer dans le RIB et annoncer
      actions.push({
        type: 'INSTALL_ROUTE', prefix,
        via: entry.successor.neighbor, fd: entry.successor.fd,
      })
      actions.push({
        type: 'SEND_UPDATE', prefix, metric: entry.successor.metric,
      })
    } else if (!entry.isLocal) {
      // Pas de route -> lancer DUAL Active ou retirer du RIB
      const feasible = entry.feasibleSuccessors
      if (feasible.length > 0) {
        // Basculement instantane sur un FS — pas de Query necessaire
        actions.push({
          type: 'INSTALL_ROUTE', prefix,
          via: feasible[0].neighbor, fd: feasible[0].fd,
        })
        actions.push({ type: 'SEND_UPDATE', prefix, metric: feasible[0].metric })
      } else {
        // Aucun FS disponible -> Active State + Query tous les voisins
        actions.push({ type: 'WITHDRAW_ROUTE', prefix })
        actions.push(...this._startDiffusion(prefix))
      }
    }
    return ok(actions)
  }

  private _startDiffusion(
    prefix:   EigrpPrefix,
    exclude?: EigrpNeighborKey,
  ): DualAction[] {
    const actions: DualAction[] = []
    const neighbors  = this._allNeighborKeys()
    const toQuery    = exclude
      ? neighbors.filter(n => NK.toMapKey(n) !== NK.toMapKey(exclude))
      : neighbors
    const queriedSet = new Set(toQuery.map(NK.toMapKey))

    this._topo.setDualState(prefix, {
      phase:            'active',
      queryOrigin:      'local',
      queriedNeighbors: queriedSet,
      repliesReceived:  new Set(),
      siaTimerStart:    Date.now(),
    })
    actions.push({ type: 'START_SIA_TIMER', prefix })

    for (const neighbor of toQuery) {
      actions.push({
        type: 'SEND_QUERY', prefix,
        metric: EIGRP_INFINITY, to: neighbor,
      })
    }
    actions.push({
      type: 'LOG',
      message: `DUAL: ${EP.toString(prefix)} passive -> active (no feasible successor)`,
      level: 'warn',
    })
    return actions
  }
}
```

### 6.4 EigrpFib — table de forwardage EIGRP

La FIB EIGRP ne contient que les routes successeurs (passives) avec leur load balancing. Elle est installee dans le RIB du Router (RouteEntry type='eigrp').

```typescript
// src/network/eigrp/dual/EigrpFib.ts

import type { EigrpPrefix }      from '../values/EigrpPrefix'
import type { EigrpNeighborKey } from '../values/EigrpNeighborKey'

export interface EigrpFibEntry {
  readonly prefix:    EigrpPrefix
  readonly successor: EigrpNeighborKey
  /** Tous les nexthops (ECMP ou variance-based load balancing) */
  readonly nextHops:  readonly {
    readonly neighbor:   EigrpNeighborKey
    readonly nextHopIp:  string
    readonly iface:      string
    readonly fd:         number
    readonly trafficShare: number  // 1..256 (variance load-balancing)
  }[]
  readonly fd:        number
  readonly ad:        number
}

export class EigrpFib {
  private readonly _entries = new Map<string, EigrpFibEntry>()

  upsert(entry: EigrpFibEntry): void {
    this._entries.set(import('../values/EigrpPrefix').EigrpPrefix.toString(entry.prefix), entry)
  }

  remove(prefix: EigrpPrefix): void {
    this._entries.delete(import('../values/EigrpPrefix').EigrpPrefix.toString(prefix))
  }

  getAll(): readonly EigrpFibEntry[] { return [...this._entries.values()] }

  get(prefix: EigrpPrefix): EigrpFibEntry | null {
    return this._entries.get(import('../values/EigrpPrefix').EigrpPrefix.toString(prefix)) ?? null
  }
}
```

### 6.5 Diagramme DUAL complet

```
IDualAlgorithm  (Strategy — remplacable par SimpleDual pour les tests)
  |
  +-- DualAlgorithmImpl
        _topo: IEigrpTopologyRepository   (inject)
        _allNeighborKeys(): EigrpNeighborKey[]  (inject)

        processUpdate(prefix, from, ad, metric)
          --> upsertSource() --> _recomputePassive()
              |
              +-- Successor existe        --> INSTALL_ROUTE + SEND_UPDATE
              +-- FS disponible           --> INSTALL_ROUTE + SEND_UPDATE (instant failover)
              +-- Aucun FS               --> WITHDRAW_ROUTE + _startDiffusion()
                                                --> SEND_QUERY * N + START_SIA_TIMER

        processQuery(prefix, from, ad, metric)
          --> Our successor != from      --> SEND_REPLY(our_metric)
          --> Our successor == from      --> SEND_REPLY(infinity) + _startDiffusion()

        processReply(prefix, from, ad, metric)
          --> All replies received?      --> passive + _recomputePassive()
          --> Not yet                    --> update Active state

        processNeighborDown(neighbor)
          --> removeNeighborSources() --> _recomputePassive() for each affected prefix

Toutes les methodes retournent Result<DualAction[], EigrpError>
Les actions sont PURES — c'est EigrpProcess qui les execute (sendUpdate, etc.)
```

---

## 7. Paquets EIGRP et TLV — Codec + Discriminated Union

### 7.1 Structure d'un paquet EIGRP (RFC 7868 §6)

Un paquet EIGRP est encapsule directement dans IPv4 (protocol 88), pas dans UDP/TCP.

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|    Version    |    Opcode     |          Checksum             |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|         Flags (32 bits)       |                               |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                      Sequence Number                          |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                   Acknowledgment Number                       |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|            Virtual Router ID  |  Autonomous System Number     |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                       TLV (variable)                          |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+

Opcodes :
  1 = Update     (annonce de route)
  3 = Query      (recherche d'une route)
  4 = Reply      (reponse a une Query)
  5 = Hello      (decouverte de voisin, aussi utilise comme ACK si TLV vide)
  11 = SIA-Query (Stuck-In-Active Query)
  12 = SIA-Reply (Stuck-In-Active Reply)

Flags (bits 0-31) :
  Bit 0 (0x01) = Init    : premier Update apres etablissement du voisinage
  Bit 1 (0x02) = CR      : Conditionally Received (flux fiable)
  Bit 3 (0x08) = RS      : Reset (reinitialisation de la relation)
  Bit 4 (0x10) = EOT     : End Of Table (dernier paquet du full Update initial)
```

### 7.2 Discriminated union EigrpPacket

```typescript
// src/network/eigrp/packet/EigrpPacket.ts

import type { EigrpTlv }        from './EigrpTlv'
import type { EigrpNeighborKey } from '../values/EigrpNeighborKey'

export type EigrpOpcode = 1 | 3 | 4 | 5 | 11 | 12

export type EigrpPacket =
  | {
      readonly op:        1  // Update
      readonly seqNo:     number
      readonly ackNo:     number
      readonly asNumber:  number
      readonly flags:     { init: boolean; eot: boolean; rs: boolean }
      readonly tlvs:      readonly EigrpTlv[]
      readonly srcIp:     string
      readonly srcIface:  string
    }
  | {
      readonly op:        3  // Query
      readonly seqNo:     number
      readonly ackNo:     number
      readonly asNumber:  number
      readonly flags:     { cr: boolean }
      readonly tlvs:      readonly EigrpTlv[]
      readonly srcIp:     string
      readonly srcIface:  string
    }
  | {
      readonly op:        4  // Reply
      readonly seqNo:     number
      readonly ackNo:     number
      readonly asNumber:  number
      readonly tlvs:      readonly EigrpTlv[]
      readonly srcIp:     string
      readonly srcIface:  string
    }
  | {
      readonly op:        5  // Hello (ou ACK si tlvs vide et ackNo != 0)
      readonly seqNo:     number
      readonly ackNo:     number
      readonly asNumber:  number
      readonly tlvs:      readonly EigrpTlv[]   // Parameter TLV + optionnel Auth
      readonly srcIp:     string
      readonly srcIface:  string
      readonly isAck:     boolean    // true si ackNo != 0 et tlvs vide
    }
  | {
      readonly op:        11  // SIA-Query
      readonly seqNo:     number
      readonly ackNo:     number
      readonly asNumber:  number
      readonly tlvs:      readonly EigrpTlv[]
      readonly srcIp:     string
      readonly srcIface:  string
    }
  | {
      readonly op:        12  // SIA-Reply
      readonly seqNo:     number
      readonly ackNo:     number
      readonly asNumber:  number
      readonly tlvs:      readonly EigrpTlv[]
      readonly srcIp:     string
      readonly srcIface:  string
    }
```

### 7.3 EigrpTlv — discriminated union des TLV

```typescript
// src/network/eigrp/packet/EigrpTlv.ts

import type { EigrpKValues, EigrpInterfaceMetric } from '../values/EigrpMetric'
import type { EigrpPrefix } from '../values/EigrpPrefix'

/**
 * TLV Types EIGRP (RFC 7868 Appendix) :
 *
 * 0x0001 = EIGRP Parameter (K-values + hold time)
 * 0x0002 = Authentication (MD5 ou SHA-256)
 * 0x0003 = Sequence (liste de voisins CR)
 * 0x0004 = Software Version
 * 0x0005 = Next Multicast Sequence
 * 0x0102 = IPv4 Internal Route
 * 0x0103 = IPv4 External Route (route redistribuee)
 * 0x0402 = IPv6 Internal Route
 * 0x0403 = IPv6 External Route
 */
export type EigrpTlv =
  | {
      readonly type:     0x0001  // Parameter
      readonly kValues:  EigrpKValues
      readonly holdTime: number  // secondes
    }
  | {
      readonly type:     0x0002  // Authentication
      readonly authType: 'MD5' | 'SHA256'
      readonly keyId:    number
      readonly digest:   string  // hex string (simule)
    }
  | {
      readonly type:     0x0003  // Sequence
      readonly addresses: readonly string[]  // IP addrs des voisins CR
    }
  | {
      readonly type:     0x0004  // Software Version
      readonly iosVersion:  string   // ex. '15.4'
      readonly eigrpVersion: string  // ex. '1.2'
    }
  | {
      readonly type:        0x0102  // IPv4 Internal Route
      readonly prefix:      EigrpPrefix
      readonly nextHop?:    string        // si different du srcIp
      readonly metric:      EigrpInterfaceMetric
      /** AD du voisin annonceur (pour calcul local de FD = local_metric + neighbor_AD) */
      readonly advertisedMetric: number
    }
  | {
      readonly type:          0x0103  // IPv4 External Route
      readonly prefix:        EigrpPrefix
      readonly nextHop?:      string
      readonly metric:        EigrpInterfaceMetric
      readonly advertisedMetric: number
      /** Protocole source de la redistribution */
      readonly originProtocol: 'connected' | 'static' | 'ospf' | 'rip' | 'bgp'
      readonly originMetric:   number
      readonly routerIdOrigin: string    // RID du routeur qui a redistribue
      readonly externalFlags:  number    // 0x01 = external candidate default
    }
```

### 7.4 EigrpPacketCodec — fonctions pures de serialisation

```typescript
// src/network/eigrp/packet/EigrpPacketCodec.ts

import type { EigrpPacket } from './EigrpPacket'
import type { EigrpTlv }    from './EigrpTlv'
import type { Result }      from '../result'
import type { EigrpError }  from '../EigrpError'
import { ok, err }          from '../result'
import { makeEigrpError }   from '../EigrpError'

/**
 * Codec EIGRP — fonctions pures sans etat.
 * Dans le simulateur, on ne manipule pas de vrais octets :
 * on travaille avec des objets JavaScript structurels.
 * La "serialisation" produit un objet portable (shallow clone + freeze).
 */
export const EigrpPacketCodec = {

  /**
   * "Serialise" un paquet en un objet JSON-safe (deep freeze).
   * Dans un vrai simulateur reseau, ce serait un Buffer d'octets.
   */
  serialize(pkt: EigrpPacket): Result<EigrpPacket, EigrpError> {
    // Validation
    if (pkt.seqNo < 0 || pkt.seqNo > 0xFFFFFFFF) {
      return err(makeEigrpError('PACKET_CHECKSUM_MISMATCH',
        `seqNo out of range: ${pkt.seqNo}`))
    }
    // Deep freeze pour garantir l'immutabilite sur le reseau simule
    return ok(Object.freeze({ ...pkt, tlvs: Object.freeze([...pkt.tlvs]) }))
  },

  /**
   * "Deserialie" un paquet recu (valide les champs critiques).
   */
  deserialize(raw: unknown): Result<EigrpPacket, EigrpError> {
    if (!raw || typeof raw !== 'object') {
      return err(makeEigrpError('PACKET_TLV_MALFORMED', 'not an object'))
    }
    const pkt = raw as Record<string, unknown>

    if (![1, 3, 4, 5, 11, 12].includes(pkt['op'] as number)) {
      return err(makeEigrpError('PACKET_INVALID_OPCODE',
        `unknown opcode: ${pkt['op']}`))
    }

    return ok(pkt as EigrpPacket)
  },

  // ── Constructeurs de paquets courants ─────────────────────────────────

  makeHello(opts: {
    seqNo: number; asNumber: number; kValues: import('../values/EigrpMetric').EigrpKValues;
    holdTime: number; srcIp: string; srcIface: string; iosVersion?: string;
  }): EigrpPacket {
    const tlvs: EigrpTlv[] = [
      { type: 0x0001, kValues: opts.kValues, holdTime: opts.holdTime },
      { type: 0x0004, iosVersion: opts.iosVersion ?? '15.4', eigrpVersion: '1.2' },
    ]
    return Object.freeze({
      op: 5, seqNo: opts.seqNo, ackNo: 0, asNumber: opts.asNumber,
      tlvs: Object.freeze(tlvs), srcIp: opts.srcIp, srcIface: opts.srcIface,
      isAck: false,
    })
  },

  makeAck(opts: {
    ackNo: number; asNumber: number; srcIp: string; srcIface: string;
  }): EigrpPacket {
    return Object.freeze({
      op: 5, seqNo: 0, ackNo: opts.ackNo, asNumber: opts.asNumber,
      tlvs: Object.freeze([]), srcIp: opts.srcIp, srcIface: opts.srcIface,
      isAck: true,
    })
  },

  makeUpdate(opts: {
    seqNo: number; ackNo: number; asNumber: number;
    tlvs: readonly EigrpTlv[]; srcIp: string; srcIface: string;
    init?: boolean; eot?: boolean;
  }): EigrpPacket {
    return Object.freeze({
      op: 1, seqNo: opts.seqNo, ackNo: opts.ackNo, asNumber: opts.asNumber,
      flags: { init: opts.init ?? false, eot: opts.eot ?? false, rs: false },
      tlvs: Object.freeze([...opts.tlvs]), srcIp: opts.srcIp, srcIface: opts.srcIface,
    })
  },

  makeQuery(opts: {
    seqNo: number; ackNo: number; asNumber: number;
    tlvs: readonly EigrpTlv[]; srcIp: string; srcIface: string;
  }): EigrpPacket {
    return Object.freeze({
      op: 3, seqNo: opts.seqNo, ackNo: opts.ackNo, asNumber: opts.asNumber,
      flags: { cr: false }, tlvs: Object.freeze([...opts.tlvs]),
      srcIp: opts.srcIp, srcIface: opts.srcIface,
    })
  },

  makeReply(opts: {
    seqNo: number; ackNo: number; asNumber: number;
    tlvs: readonly EigrpTlv[]; srcIp: string; srcIface: string;
  }): EigrpPacket {
    return Object.freeze({
      op: 4, seqNo: opts.seqNo, ackNo: opts.ackNo, asNumber: opts.asNumber,
      tlvs: Object.freeze([...opts.tlvs]), srcIp: opts.srcIp, srcIface: opts.srcIface,
    })
  },
}
```

### 7.5 EigrpPacketDispatcher — Command Pattern pour le dispatch

```typescript
// src/network/eigrp/packet/EigrpPacketDispatcher.ts

import type { EigrpPacket }  from './EigrpPacket'
import type { EigrpTlv }     from './EigrpTlv'
import type { EigrpEvent }   from '../EigrpEvent'
import type { EigrpPrefix }  from '../values/EigrpPrefix'
import type { EigrpNeighborKey } from '../values/EigrpNeighborKey'
import { EigrpNeighborKey as NK } from '../values/EigrpNeighborKey'
import { EigrpPrefix as EP }      from '../values/EigrpPrefix'
import { EIGRP_INFINITY }         from '../values/EigrpMetric'

/**
 * Traduit un EigrpPacket recu en une sequence d'EigrpEvent.
 * Stateless — fonction pure (sauf extraction de la cle voisin).
 */
export function dispatchPacket(pkt: EigrpPacket): readonly EigrpEvent[] {
  const neighbor = NK.of(pkt.srcIp, pkt.srcIface)

  switch (pkt.op) {
    case 5: {  // Hello ou ACK
      if (pkt.isAck) return []  // Les ACK sont traites par le RTP, pas par le processus

      const paramTlv = pkt.tlvs.find(t => t.type === 0x0001)
      if (!paramTlv || paramTlv.type !== 0x0001) return []

      const k = paramTlv.kValues
      return [{
        type:     'HELLO_RECEIVED',
        neighbor: { ip: pkt.srcIp },
        iface:    pkt.srcIface,
        holdTime: paramTlv.holdTime,
        kValues:  [k.k1, k.k2, k.k3, k.k4, k.k5],
        asNumber: pkt.asNumber,
      }] as EigrpEvent[]
    }

    case 1:   // Update
    case 3:   // Query
    case 4: { // Reply
      const events: EigrpEvent[] = []
      for (const tlv of pkt.tlvs) {
        if (tlv.type !== 0x0102 && tlv.type !== 0x0103) continue
        const prefix = tlv.prefix
        const metric = {
          _tag: 'EigrpMetric' as const,
          composite: tlv.advertisedMetric,
          components: tlv.metric,
        }
        const isWithdraw = tlv.metric.bandwidth === 0 ||
          tlv.advertisedMetric >= 0xFFFFFFFF

        if (pkt.op === 1) {
          events.push({ type: 'UPDATE_RECEIVED', from: neighbor, prefix, metric, isWithdraw })
        } else if (pkt.op === 3) {
          events.push({ type: 'QUERY_RECEIVED', from: neighbor, prefix, metric })
        } else {
          events.push({ type: 'REPLY_RECEIVED', from: neighbor, prefix, metric })
        }
      }
      return events
    }

    default:
      return []
  }
}
```

### 7.6 Diagramme du sous-systeme paquet

```
EigrpPacket (discriminated union — op 1/3/4/5/11/12)
  contient TLVs : EigrpTlv (0x0001/0x0002/0x0003/0x0004/0x0102/0x0103)

EigrpPacketCodec (fonctions pures)
  serialize(pkt)             --> Result<EigrpPacket>
  deserialize(raw)           --> Result<EigrpPacket>
  makeHello / makeAck / makeUpdate / makeQuery / makeReply

dispatchPacket(pkt)          --> EigrpEvent[]
  Hello  --> HELLO_RECEIVED
  Update --> UPDATE_RECEIVED * N (une par route TLV)
  Query  --> QUERY_RECEIVED  * N
  Reply  --> REPLY_RECEIVED  * N
  ACK    --> []  (gere par RTP)
```

---

## 8. Programmation reactive et RTP — Observable + Subject Pattern

### 8.1 Pourquoi la programmation reactive pour EIGRP ?

EIGRP est intrinsèquement **event-driven** : chaque packet recu, chaque timer expire, chaque changement d'interface topologique declenche une cascade d'evenements asynchrones. La programmation imperative (callbacks imbriques, state flags manuels) mène a du code spaghetti difficile a tester et a maintenir.

L'approche **reactive** (Observable/Subject pattern) offre :
- **Streams typees** : chaque type d'evenement est un flux distinct
- **Composition** : `filter()`, `map()`, `merge()` pour combiner les flux
- **Separation des preoccupations** : producteurs et consommateurs d'evenements sont decouplés
- **Testabilite** : injecter des evenements de test = alimenter un Subject de test
- **Lifecycle management** : `Subscription` permet de detacher proprement

### 8.2 EigrpSubject<T> — implementation reactive minimaliste

On n'importe pas RxJS — trop lourd pour le simulateur. On implement un `Subject<T>` leger (meme contrat qu'un BehaviorSubject RxJS sans la valeur courante).

```typescript
// src/network/eigrp/reactive/EigrpSubject.ts

/**
 * Subject minimal : peut emettre des valeurs ET etre observe.
 * Equivalent leger d'un RxJS Subject — sans dependance externe.
 *
 * Interface :
 *   next(value)  → emets une valeur a tous les abonnés
 *   subscribe(fn) → s'abonne, retourne une fonction de desabonnement
 *   pipe(operator) → transforme le subject en Observable derive
 *   complete()   → ferme le flux (plus d'emission possible)
 */
export class EigrpSubject<T> {
  private readonly _subscribers = new Set<(v: T) => void>()
  private _completed = false

  next(value: T): void {
    if (this._completed) return
    for (const sub of this._subscribers) {
      sub(value)
    }
  }

  subscribe(fn: (v: T) => void): () => void {
    this._subscribers.add(fn)
    return () => this._subscribers.delete(fn)
  }

  /** Transforme ce Subject en Observable<U> via un operateur */
  pipe<U>(operator: EigrpOperator<T, U>): EigrpObservable<U> {
    return operator(this.asObservable())
  }

  asObservable(): EigrpObservable<T> {
    return {
      subscribe: (fn) => this.subscribe(fn),
      pipe:      (op) => op(this.asObservable()),
    }
  }

  complete(): void {
    this._completed = true
    this._subscribers.clear()
  }

  get subscriberCount(): number { return this._subscribers.size }
}

// ─── Observable<T> — version lecture seule d'un Subject ─────────────────

export interface EigrpObservable<T> {
  subscribe(fn: (v: T) => void): () => void
  pipe<U>(operator: EigrpOperator<T, U>): EigrpObservable<U>
}

// ─── Operateurs (pattern pipe) ────────────────────────────────────────────

export type EigrpOperator<T, U> = (source: EigrpObservable<T>) => EigrpObservable<U>

export const Operators = {

  /** Filtre les valeurs qui satisfont le predicat */
  filter<T>(predicate: (v: T) => boolean): EigrpOperator<T, T> {
    return (source) => ({
      subscribe: (fn) => source.subscribe(v => { if (predicate(v)) fn(v) }),
      pipe:      (op) => op(Operators.filter<T>(predicate)(source)),
    })
  },

  /** Transforme chaque valeur */
  map<T, U>(transform: (v: T) => U): EigrpOperator<T, U> {
    return (source) => ({
      subscribe: (fn) => source.subscribe(v => fn(transform(v))),
      pipe:      (op) => op(Operators.map<T, U>(transform)(source)),
    })
  },

  /** Filtre par type discrimine (type guard) */
  ofType<T, K extends T>(guard: (v: T) => v is K): EigrpOperator<T, K> {
    return Operators.filter(guard) as EigrpOperator<T, K>
  },

  /** Fusionne plusieurs observables en un seul */
  merge<T>(...sources: EigrpObservable<T>[]): EigrpObservable<T> {
    const subject = new EigrpSubject<T>()
    const unsubs  = sources.map(s => s.subscribe(v => subject.next(v)))
    return {
      subscribe: (fn) => {
        const unsub = subject.subscribe(fn)
        return () => { unsub(); unsubs.forEach(u => u()) }
      },
      pipe: (op) => op(Operators.merge(...sources)),
    }
  },

  /** Buffer : accumule N valeurs puis emets le tableau */
  bufferCount<T>(n: number): EigrpOperator<T, T[]> {
    return (source) => {
      let buffer: T[] = []
      const out = new EigrpSubject<T[]>()
      source.subscribe(v => {
        buffer.push(v)
        if (buffer.length >= n) { out.next([...buffer]); buffer = [] }
      })
      return out.asObservable()
    }
  },
}
```

### 8.3 EigrpEventBus — hub central des evenements

Le bus est le coeur du systeme reactif. Chaque composant publie sur le bus et s'y abonne selectivement. Les flux sont typees par le discriminant de `EigrpEvent`.

```typescript
// src/network/eigrp/reactive/EigrpEventBus.ts

import type { EigrpEvent }     from '../EigrpEvent'
import type { DualAction }     from '../dual/IDualAlgorithm'
import { EigrpSubject, Operators } from './EigrpSubject'

/**
 * Hub central de la programmation reactive EIGRP.
 *
 * Architecture :
 *
 *   [Packet Layer]  -->  eventBus.emit(event)
 *   [Timer Layer]   -->  eventBus.emit(event)
 *   [Interface]     -->  eventBus.emit(event)
 *
 *   eventBus.events$          <-- stream de tous les evenements
 *   eventBus.hello$           <-- sous-stream filtre HELLO_RECEIVED
 *   eventBus.updates$         <-- sous-stream filtre UPDATE_RECEIVED
 *   eventBus.queries$         <-- sous-stream filtre QUERY_RECEIVED
 *   eventBus.replies$         <-- sous-stream filtre REPLY_RECEIVED
 *   eventBus.neighborDown$    <-- sous-stream filtre NEIGHBOR_DOWN
 *   eventBus.siaTimer$        <-- sous-stream filtre SIA_TIMER_EXPIRED
 *   eventBus.localRoutes$     <-- sous-stream filtre LOCAL_ROUTE_UP/DOWN
 *
 *   [DUAL Layer]     -->  actionBus.emit(action)
 *   [EigrpProcess]  <--  actionBus.actions$  (execute les DualActions)
 */
export class EigrpEventBus {
  // ── Flux entrants (evenements) ─────────────────────────────────────────
  private readonly _events$  = new EigrpSubject<EigrpEvent>()
  private readonly _actions$ = new EigrpSubject<DualAction>()

  // ── Sous-streams derives (views typees) ───────────────────────────────

  readonly events$ = this._events$.asObservable()

  readonly hello$ = this._events$.pipe(
    Operators.ofType((e): e is Extract<EigrpEvent, { type: 'HELLO_RECEIVED' }> =>
      e.type === 'HELLO_RECEIVED')
  )

  readonly holdExpired$ = this._events$.pipe(
    Operators.ofType((e): e is Extract<EigrpEvent, { type: 'HOLD_TIMER_EXPIRED' }> =>
      e.type === 'HOLD_TIMER_EXPIRED')
  )

  readonly neighborDown$ = this._events$.pipe(
    Operators.ofType((e): e is Extract<EigrpEvent, { type: 'NEIGHBOR_DOWN' }> =>
      e.type === 'NEIGHBOR_DOWN')
  )

  readonly updates$ = this._events$.pipe(
    Operators.ofType((e): e is Extract<EigrpEvent, { type: 'UPDATE_RECEIVED' }> =>
      e.type === 'UPDATE_RECEIVED')
  )

  readonly queries$ = this._events$.pipe(
    Operators.ofType((e): e is Extract<EigrpEvent, { type: 'QUERY_RECEIVED' }> =>
      e.type === 'QUERY_RECEIVED')
  )

  readonly replies$ = this._events$.pipe(
    Operators.ofType((e): e is Extract<EigrpEvent, { type: 'REPLY_RECEIVED' }> =>
      e.type === 'REPLY_RECEIVED')
  )

  readonly siaTimer$ = this._events$.pipe(
    Operators.ofType((e): e is Extract<EigrpEvent, { type: 'SIA_TIMER_EXPIRED' }> =>
      e.type === 'SIA_TIMER_EXPIRED')
  )

  readonly localUp$ = this._events$.pipe(
    Operators.ofType((e): e is Extract<EigrpEvent, { type: 'LOCAL_ROUTE_UP' }> =>
      e.type === 'LOCAL_ROUTE_UP')
  )

  readonly localDown$ = this._events$.pipe(
    Operators.ofType((e): e is Extract<EigrpEvent, { type: 'LOCAL_ROUTE_DOWN' }> =>
      e.type === 'LOCAL_ROUTE_DOWN')
  )

  readonly actions$ = this._actions$.asObservable()

  // ── Emission ──────────────────────────────────────────────────────────

  emit(event: EigrpEvent): void {
    this._events$.next(event)
  }

  dispatch(action: DualAction): void {
    this._actions$.next(action)
  }

  dispose(): void {
    this._events$.complete()
    this._actions$.complete()
  }
}
```

### 8.4 RTP — Reliable Transport Protocol avec programmation reactive

Le RTP EIGRP garantit la livraison ordonnee des paquets (Update, Query, Reply) via un mecanisme ACK explicite et une retransmission unicast si l'ACK n'arrive pas dans le RTO.

```typescript
// src/network/eigrp/rtp/RtpChannel.ts

import { EigrpSubject }     from '../reactive/EigrpSubject'
import type { EigrpPacket } from '../packet/EigrpPacket'
import type { EigrpNeighborKey } from '../values/EigrpNeighborKey'
import { EigrpPacketCodec }  from '../packet/EigrpPacketCodec'

// ─── Types d'evenements RTP ──────────────────────────────────────────────

export type RtpEvent =
  | { readonly type: 'ACK_RECEIVED';    readonly neighbor: EigrpNeighborKey; readonly ackNo: number }
  | { readonly type: 'RETRANSMIT';      readonly neighbor: EigrpNeighborKey; readonly seqNo: number; readonly attempt: number }
  | { readonly type: 'MAX_RETRANS';     readonly neighbor: EigrpNeighborKey; readonly seqNo: number }
  | { readonly type: 'PACKET_SENT';     readonly neighbor: EigrpNeighborKey; readonly seqNo: number; readonly opcode: number }
  | { readonly type: 'DUPLICATE_RECV'; readonly neighbor: EigrpNeighborKey; readonly seqNo: number }

/**
 * RtpPendingPacket — paquet en attente d'ACK.
 */
export interface RtpPendingPacket {
  readonly seqNo:    number
  readonly packet:   EigrpPacket
  readonly neighbor: EigrpNeighborKey
  readonly sentAt:   number        // Date.now()
  readonly attempts: number        // nb de retransmissions effectuees
  readonly timerId:  ReturnType<typeof setTimeout>
}

/**
 * RtpSequenceTracker — suivi des numeros de sequence par voisin.
 * Un compteur different par voisin, reinitialisé quand le voisin est perdu.
 */
export class RtpSequenceTracker {
  private readonly _sent     = new Map<string, number>()  // dernier seqNo envoye
  private readonly _expected = new Map<string, number>()  // prochain seqNo attendu

  nextSeq(neighborKey: string): number {
    const current = this._sent.get(neighborKey) ?? 0
    const next    = (current + 1) & 0xFFFFFFFF  // wrapping 32-bit
    this._sent.set(neighborKey, next)
    return next
  }

  isExpected(neighborKey: string, seqNo: number): boolean {
    const expected = this._expected.get(neighborKey) ?? 1
    return seqNo === expected
  }

  advance(neighborKey: string): void {
    const current = this._expected.get(neighborKey) ?? 1
    this._expected.set(neighborKey, (current + 1) & 0xFFFFFFFF)
  }

  reset(neighborKey: string): void {
    this._sent.delete(neighborKey)
    this._expected.delete(neighborKey)
  }
}

/**
 * IRtpChannel — canal de transport fiable vers un voisin.
 *
 * Reactive : expose un Subject<RtpEvent> pour les evenements de livraison.
 */
export interface IRtpChannel {
  /** Stream des evenements RTP (ACK, retransmit, max retrans...) */
  readonly events$: import('../reactive/EigrpSubject').EigrpObservable<RtpEvent>
  /** Envoie un paquet avec garantie de livraison (retransmit si pas d'ACK) */
  sendReliable(packet: EigrpPacket, neighbor: EigrpNeighborKey): void
  /** Envoie un paquet sans garantie (Hello, ACK) */
  sendUnreliable(packet: EigrpPacket, neighbor?: EigrpNeighborKey): void
  /** Notifie la reception d'un ACK (stoppe la retransmission) */
  onAckReceived(neighbor: EigrpNeighborKey, ackNo: number): void
  /** Libere toutes les ressources */
  dispose(): void
}

/**
 * RtpChannel — implementation concrete du canal RTP.
 *
 * Logique reactive :
 *   sendReliable() --> stocke dans _pending --> setInterval() --> RETRANSMIT event
 *   onAckReceived() --> clearInterval() --> ACK_RECEIVED event --> retire de _pending
 *   MAX_RETRANS --> MAX_RETRANS event --> EigrpEventBus.emit(NEIGHBOR_DOWN)
 */
export class RtpChannel implements IRtpChannel {
  private readonly _events$  = new EigrpSubject<RtpEvent>()
  private readonly _pending  = new Map<string, RtpPendingPacket>()  // key = neighborKey:seqNo
  private readonly _seqTrack = new RtpSequenceTracker()
  private readonly MAX_RETRANS = 16
  private readonly BASE_RTO    = 200   // ms (initial RTO)

  constructor(
    private readonly _sendFn:   (pkt: EigrpPacket, neighbor?: EigrpNeighborKey) => void,
    private readonly _eventBus: import('../reactive/EigrpEventBus').EigrpEventBus,
  ) {}

  readonly events$ = this._events$.asObservable()

  sendReliable(packet: EigrpPacket, neighbor: EigrpNeighborKey): void {
    const nk  = import('../values/EigrpNeighborKey').EigrpNeighborKey.toMapKey(neighbor)
    const seq = packet.seqNo
    const key = `${nk}:${seq}`

    const timerId = setTimeout(() => this._retransmit(key, neighbor, seq), this.BASE_RTO)

    this._pending.set(key, {
      seqNo:    seq,
      packet,
      neighbor,
      sentAt:   Date.now(),
      attempts: 0,
      timerId,
    })

    this._sendFn(packet, neighbor)
    this._events$.next({ type: 'PACKET_SENT', neighbor, seqNo: seq, opcode: packet.op })
  }

  sendUnreliable(packet: EigrpPacket, neighbor?: EigrpNeighborKey): void {
    this._sendFn(packet, neighbor)
  }

  onAckReceived(neighbor: EigrpNeighborKey, ackNo: number): void {
    const nk  = import('../values/EigrpNeighborKey').EigrpNeighborKey.toMapKey(neighbor)
    const key = `${nk}:${ackNo}`

    const pending = this._pending.get(key)
    if (!pending) return  // ACK pour un paquet inconnu, ignore

    clearTimeout(pending.timerId)
    this._pending.delete(key)
    this._events$.next({ type: 'ACK_RECEIVED', neighbor, ackNo })
  }

  private _retransmit(key: string, neighbor: EigrpNeighborKey, seqNo: number): void {
    const pending = this._pending.get(key)
    if (!pending) return

    if (pending.attempts >= this.MAX_RETRANS) {
      clearTimeout(pending.timerId)
      this._pending.delete(key)
      this._events$.next({ type: 'MAX_RETRANS', neighbor, seqNo })
      // Declenche un evenement NEIGHBOR_DOWN via le bus central
      this._eventBus.emit({
        type: 'NEIGHBOR_DOWN',
        neighbor: import('../values/EigrpNeighborKey').EigrpNeighborKey.toMapKey(neighbor) as any,
        reason: 'RTP_MAX_RETRANS_EXCEEDED',
      })
      return
    }

    // Retransmission exponential backoff : RTO × 2^attempts (cap a 5s)
    const nextRto = Math.min(this.BASE_RTO * Math.pow(2, pending.attempts + 1), 5000)
    const newTimerId = setTimeout(() => this._retransmit(key, neighbor, seqNo), nextRto)

    this._pending.set(key, { ...pending, attempts: pending.attempts + 1, timerId: newTimerId })
    this._sendFn(pending.packet, neighbor)
    this._events$.next({ type: 'RETRANSMIT', neighbor, seqNo, attempt: pending.attempts + 1 })
  }

  dispose(): void {
    for (const p of this._pending.values()) clearTimeout(p.timerId)
    this._pending.clear()
    this._events$.complete()
  }
}
```

### 8.5 Diagramme reactif du RTP

```
EigrpSubject<T>               (hot observable minimal — zero RxJS)
  next(v)    --> tous les abonnes recevront v
  subscribe  --> retourne () => void (desabonnement)
  pipe(op)   --> retourne EigrpObservable<U>

Operators.filter / map / ofType / merge / bufferCount
  (fonctions pures d'ordre superieur — pas d'etat propre)

EigrpEventBus
  _events$: EigrpSubject<EigrpEvent>   (source unique)
  hello$       = _events$.pipe(ofType(HELLO_RECEIVED))
  updates$     = _events$.pipe(ofType(UPDATE_RECEIVED))
  queries$     = _events$.pipe(ofType(QUERY_RECEIVED))
  replies$     = _events$.pipe(ofType(REPLY_RECEIVED))
  neighborDown$= _events$.pipe(ofType(NEIGHBOR_DOWN))
  siaTimer$    = _events$.pipe(ofType(SIA_TIMER_EXPIRED))
  actions$: EigrpSubject<DualAction>   (source des actions DUAL)
  emit(event)     --> _events$.next(event)
  dispatch(action)--> _actions$.next(action)

RtpChannel
  events$: EigrpObservable<RtpEvent>   (read-only view)
  sendReliable()  --> multicast + setInterval (retransmit)
  onAckReceived() --> clearInterval + ACK_RECEIVED event
  MAX_RETRANS --> events$.next({MAX_RETRANS}) + eventBus.emit(NEIGHBOR_DOWN)
```

---

## 9. EigrpProcess — Reactive Facade + Event Pipeline

### 9.1 Architecture reactive de EigrpProcess

`EigrpProcess` est la **Facade reactive** du module EIGRP. Son coeur est un pipeline d'evenements qui orchestre DUAL, RTP, et les voisins via des subscriptions declaratives.

```
EigrpProcess (Facade)
    |
    |  setup() — wire tous les streams au demarrage
    |
    +-- eventBus.hello$
    |     .subscribe(e => neighborSM.processEvent(e))       // hello -> voisinage
    |
    +-- eventBus.neighborDown$
    |     .subscribe(e => _handleNeighborDown(e))           // voisin perdu -> DUAL
    |
    +-- eventBus.updates$
    |     .subscribe(e => _dispatchToDual(e))               // update -> DUAL.processUpdate()
    |
    +-- eventBus.queries$
    |     .subscribe(e => _dispatchToDual(e))               // query -> DUAL.processQuery()
    |
    +-- eventBus.replies$
    |     .subscribe(e => _dispatchToDual(e))               // reply -> DUAL.processReply()
    |
    +-- eventBus.actions$                                   // actions DUAL -> execution
    |     .subscribe(action => _executeAction(action))
    |
    +-- eventBus.siaTimer$
    |     .subscribe(e => _handleSiaTimeout(e))             // SIA -> voisin down
    |
    +-- rtpChannel.events$
          .pipe(ofType(MAX_RETRANS))
          .subscribe(e => eventBus.emit(NEIGHBOR_DOWN))     // RTP -> voisin down
```

### 9.2 EigrpProcessOptions — Builder Pattern

```typescript
// src/network/eigrp/process/EigrpProcessOptions.ts

import type { EigrpKValues }  from '../values/EigrpMetric'
import type { EigrpRid }      from '../values/EigrpRouterIdentifier'
import { DEFAULT_K_VALUES }   from '../values/EigrpMetric'

export interface EigrpNetworkStatement {
  readonly network:   string   // ex. '10.0.0.0'
  readonly wildcard:  string   // ex. '0.0.0.255'
}

export interface EigrpRedistribute {
  readonly protocol: 'connected' | 'static' | 'ospf' | 'rip'
  readonly metric?: {
    readonly bandwidth:   number
    readonly delay:       number
    readonly reliability: number
    readonly load:        number
    readonly mtu:         number
  }
}

export interface EigrpProcessOptions {
  readonly asNumber:       number
  readonly routerId?:      EigrpRid
  readonly kValues:        EigrpKValues
  readonly helloInterval:  number   // secondes (default 5 sur FastEthernet, 60 sur Serial)
  readonly holdTime:       number   // secondes (default 15 ou 180)
  readonly networks:       readonly EigrpNetworkStatement[]
  readonly redistribute:   readonly EigrpRedistribute[]
  readonly maximumPaths:   number   // ECMP (default 4)
  readonly variance:       number   // load balancing unegal (1 = equal only)
  readonly autoSummary:    boolean  // desactive en IOS 15+ (default: false)
  readonly stub?:          readonly ('connected'|'static'|'summary'|'redistributed')[]
  readonly passiveInterfaces: readonly string[]
  readonly siaTimerMs:     number   // Stuck-In-Active timeout (default 90s)
}

export const DEFAULT_EIGRP_OPTIONS: Omit<EigrpProcessOptions, 'asNumber'> = Object.freeze({
  kValues:           DEFAULT_K_VALUES,
  helloInterval:     5,
  holdTime:          15,
  networks:          [],
  redistribute:      [],
  maximumPaths:      4,
  variance:          1,
  autoSummary:       false,
  passiveInterfaces: [],
  siaTimerMs:        90_000,
})

// ─── Builder ──────────────────────────────────────────────────────────────

export class EigrpProcessOptionsBuilder {
  private _opts: EigrpProcessOptions

  constructor(asNumber: number) {
    this._opts = { asNumber, ...DEFAULT_EIGRP_OPTIONS }
  }

  withRouterId(rid: EigrpRid): this     { this._opts = { ...this._opts, routerId: rid };  return this }
  withKValues(k: EigrpKValues): this    { this._opts = { ...this._opts, kValues: k };     return this }
  withHelloInterval(s: number): this    { this._opts = { ...this._opts, helloInterval: s }; return this }
  withHoldTime(s: number): this         { this._opts = { ...this._opts, holdTime: s };    return this }
  withMaxPaths(n: number): this         { this._opts = { ...this._opts, maximumPaths: n }; return this }
  withVariance(v: number): this         { this._opts = { ...this._opts, variance: v };    return this }
  addNetwork(net: string, wild: string): this {
    this._opts = { ...this._opts, networks: [...this._opts.networks, { network: net, wildcard: wild }] }
    return this
  }
  addRedistribute(r: EigrpRedistribute): this {
    this._opts = { ...this._opts, redistribute: [...this._opts.redistribute, r] }
    return this
  }
  stub(...types: ('connected'|'static'|'summary'|'redistributed')[]): this {
    this._opts = { ...this._opts, stub: types }
    return this
  }
  build(): EigrpProcessOptions { return Object.freeze(this._opts) }
}
```

### 9.3 IEigrpProcess — interface publique (Facade)

```typescript
// src/network/eigrp/process/IEigrpProcess.ts

import type { EigrpNeighborEntry }  from '../neighbor/types'
import type { TopologyEntry }       from '../topology/types'
import type { EigrpFibEntry }       from '../dual/EigrpFib'
import type { EigrpProcessOptions } from './EigrpProcessOptions'
import type { EigrpPacket }         from '../packet/EigrpPacket'
import type { EigrpObservable }     from '../reactive/EigrpSubject'
import type { DualAction }          from '../dual/IDualAlgorithm'
import type { EigrpEvent }          from '../EigrpEvent'

export interface IEigrpProcess {
  readonly asNumber: number
  readonly options:  EigrpProcessOptions

  // ── Streams publics (read-only) ────────────────────────────────────────
  /** Stream de tous les evenements EIGRP (pour monitoring) */
  readonly events$:  EigrpObservable<EigrpEvent>
  /** Stream des actions DUAL executees (pour tests) */
  readonly actions$: EigrpObservable<DualAction>

  // ── Lifecycle ─────────────────────────────────────────────────────────
  start(): void
  stop(): void

  // ── Point d'entree des paquets recus ──────────────────────────────────
  /** Appele par RouterEigrpIntegration quand un paquet EIGRP arrive */
  handlePacket(pkt: EigrpPacket): void

  // ── Notification de changement d'interface ────────────────────────────
  onInterfaceUp(iface: string, ip: string, bandwidth: number, delay: number): void
  onInterfaceDown(iface: string): void

  // ── Redistribution depuis le RIB ──────────────────────────────────────
  redistributeRoute(prefix: string, prefixLen: number, metric: import('../values/EigrpMetric').EigrpInterfaceMetric): void
  withdrawRedistributedRoute(prefix: string, prefixLen: number): void

  // ── Queries (pour le CLI show) ─────────────────────────────────────────
  getNeighbors(): readonly EigrpNeighborEntry[]
  getTopologyTable(): readonly TopologyEntry[]
  getFib(): readonly EigrpFibEntry[]
}
```

### 9.4 EigrpProcess — implementation reactive

```typescript
// src/network/eigrp/process/EigrpProcess.ts

import type { IEigrpProcess }        from './IEigrpProcess'
import type { EigrpProcessOptions }  from './EigrpProcessOptions'
import type { EigrpPacket }          from '../packet/EigrpPacket'
import type { DualAction }           from '../dual/IDualAlgorithm'
import type { EigrpEvent }           from '../EigrpEvent'
import { EigrpEventBus }             from '../reactive/EigrpEventBus'
import { EigrpNeighborStateMachine } from '../neighbor/EigrpNeighborStateMachine'
import { InMemoryTopologyTable }     from '../topology/InMemoryTopologyTable'
import { InMemoryNeighborTable }     from '../neighbor/InMemoryNeighborTable'
import { DualAlgorithmImpl }         from '../dual/DualAlgorithmImpl'
import { EigrpFib }                  from '../dual/EigrpFib'
import { RtpChannel }                from '../rtp/RtpChannel'
import { dispatchPacket }            from '../packet/EigrpPacketDispatcher'
import { EigrpPacketCodec }          from '../packet/EigrpPacketCodec'
import { Operators }                 from '../reactive/EigrpSubject'
import { EigrpNeighborKey as NK }    from '../values/EigrpNeighborKey'
import { EigrpPrefix as EP }         from '../values/EigrpPrefix'
import { computeEigrpMetric, meetsVariance } from '../EigrpPureUtils'
import type { IEigrpNetworkInterface } from '../integration/IEigrpNetworkInterface'

export class EigrpProcess implements IEigrpProcess {
  readonly asNumber: number
  readonly options:  EigrpProcessOptions

  private readonly _bus       = new EigrpEventBus()
  private readonly _topo      = new InMemoryTopologyTable()
  private readonly _neighbors = new InMemoryNeighborTable()
  private readonly _fib       = new EigrpFib()
  private readonly _rtp:      RtpChannel
  private readonly _dual:     DualAlgorithmImpl
  private readonly _nsm:      EigrpNeighborStateMachine
  private readonly _unsubs:   Array<() => void> = []
  private _helloTimers:       Map<string, ReturnType<typeof setInterval>> = new Map()
  private _localSeq           = 0

  readonly events$  = this._bus.events$
  readonly actions$ = this._bus.actions$

  constructor(
    opts:    EigrpProcessOptions,
    private readonly _iface: IEigrpNetworkInterface,
  ) {
    this.asNumber = opts.asNumber
    this.options  = opts

    this._rtp = new RtpChannel(
      (pkt, neighbor) => this._sendPacket(pkt, neighbor),
      this._bus,
    )

    this._dual = new DualAlgorithmImpl(
      this._topo,
      opts.kValues,
      opts.routerId?.value ?? '0.0.0.0',
      () => this._neighbors.getAll().map(n => n.key),
    )

    this._nsm = new EigrpNeighborStateMachine(
      opts.kValues, opts.asNumber, this._neighbors,
      {
        onNeighborUp:   (key) => this._onNeighborUp(key),
        onNeighborDown: (key, reason) => this._onNeighborDown(key, reason),
        sendHello:      (iface) => this._sendHello(iface),
      },
    )
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  start(): void {
    this._wireReactiveStreams()
    // Demarrer les timers Hello sur toutes les interfaces actives
    for (const iface of this._iface.getActiveInterfaces()) {
      this._startHelloTimer(iface)
    }
  }

  stop(): void {
    for (const unsub of this._unsubs) unsub()
    this._unsubs.length = 0
    for (const timer of this._helloTimers.values()) clearInterval(timer)
    this._helloTimers.clear()
    this._rtp.dispose()
    this._bus.dispose()
  }

  // ── Pipeline reactif central ───────────────────────────────────────────

  private _wireReactiveStreams(): void {
    // 1. Hellos → machine a etats voisin
    this._unsubs.push(
      this._bus.hello$.subscribe(e =>
        this._nsm.processEvent(NK.of(e.neighbor.ip, e.iface), e)
      )
    )

    // 2. Hold timer expire → voisin down
    this._unsubs.push(
      this._bus.holdExpired$.subscribe(e =>
        this._nsm.processEvent(e.neighbor, {
          type: 'NEIGHBOR_DOWN', neighbor: NK.toMapKey(e.neighbor) as any,
          reason: 'HOLD_EXPIRED',
        })
      )
    )

    // 3. Updates / Queries / Replies → DUAL
    this._unsubs.push(
      this._bus.updates$.subscribe(e => {
        const result = this._dual.processUpdate(e.prefix, e.from, e.metric.composite, e.metric)
        if (result.ok) for (const a of result.value) this._bus.dispatch(a)
      })
    )

    this._unsubs.push(
      this._bus.queries$.subscribe(e => {
        const result = this._dual.processQuery(e.prefix, e.from, e.metric.composite, e.metric)
        if (result.ok) for (const a of result.value) this._bus.dispatch(a)
      })
    )

    this._unsubs.push(
      this._bus.replies$.subscribe(e => {
        const result = this._dual.processReply(e.prefix, e.from, e.metric.composite, e.metric)
        if (result.ok) for (const a of result.value) this._bus.dispatch(a)
      })
    )

    // 4. Voisin down → DUAL + purge
    this._unsubs.push(
      this._bus.neighborDown$.subscribe(e => {
        const result = this._dual.processNeighborDown(e.neighbor as any)
        if (result.ok) for (const a of result.value) this._bus.dispatch(a)
      })
    )

    // 5. Actions DUAL → execution concrete
    this._unsubs.push(
      this._bus.actions$.subscribe(action => this._executeAction(action))
    )

    // 6. SIA timer → voisin qui n'a pas repondu est declare down
    this._unsubs.push(
      this._bus.siaTimer$.subscribe(e => {
        const entry = this._topo.getEntry(e.prefix)
        if (entry?.state.phase === 'active') {
          const missing = [...entry.state.queriedNeighbors]
            .filter(k => !entry.state.repliesReceived.has(k))
          for (const nk of missing) {
            this._bus.emit({ type: 'NEIGHBOR_DOWN', neighbor: nk as any, reason: 'DUAL_STUCK_IN_ACTIVE' })
          }
        }
      })
    )

    // 7. RTP MAX_RETRANS → voisin down (via bus central — deja wire dans RtpChannel)
    this._unsubs.push(
      this._rtp.events$.pipe(
        Operators.ofType((e): e is Extract<typeof e, { type: 'MAX_RETRANS' }> =>
          e.type === 'MAX_RETRANS')
      ).subscribe(e => {
        this._bus.emit({ type: 'NEIGHBOR_DOWN', neighbor: e.neighbor as any, reason: 'RTP_MAX_RETRANS_EXCEEDED' })
      })
    )
  }

  // ── Execution des actions DUAL ─────────────────────────────────────────

  private _executeAction(action: DualAction): void {
    switch (action.type) {
      case 'INSTALL_ROUTE':
        this._fib.upsert(this._buildFibEntry(action.prefix, action.via, action.fd))
        this._iface.installRoute(action.prefix, action.via, action.fd)
        break

      case 'WITHDRAW_ROUTE':
        this._fib.remove(action.prefix)
        this._iface.withdrawRoute(action.prefix)
        break

      case 'SEND_UPDATE':
        this._sendUpdate(action.prefix, action.metric, action.to)
        break

      case 'SEND_QUERY':
        this._sendQuery(action.prefix, action.metric, action.to)
        break

      case 'SEND_REPLY':
        this._sendReply(action.prefix, action.metric, action.to)
        break

      case 'START_SIA_TIMER':
        setTimeout(() => {
          this._bus.emit({ type: 'SIA_TIMER_EXPIRED', prefix: action.prefix })
        }, this.options.siaTimerMs)
        break

      case 'DECLARE_NEIGHBOR_DOWN':
        this._bus.emit({ type: 'NEIGHBOR_DOWN', neighbor: action.neighbor as any, reason: action.reason })
        break

      case 'LOG':
        // Les logs sont emis comme evenements (observable par les tests)
        break
    }
  }

  // ── Point d'entree paquets ─────────────────────────────────────────────

  handlePacket(pkt: EigrpPacket): void {
    // 1. ACK explicite — traite par le RTP, pas par DUAL
    if (pkt.op === 5 && pkt.ackNo !== 0 && pkt.tlvs.length === 0) {
      this._rtp.onAckReceived(NK.of(pkt.srcIp, pkt.srcIface), pkt.ackNo)
      return
    }
    // 2. Envoyer un ACK si le seqNo != 0 (paquet fiable)
    if (pkt.seqNo !== 0) {
      const ack = EigrpPacketCodec.makeAck({
        ackNo: pkt.seqNo, asNumber: this.asNumber,
        srcIp: this._iface.getLocalIp(pkt.srcIface),
        srcIface: pkt.srcIface,
      })
      this._rtp.sendUnreliable(ack, NK.of(pkt.srcIp, pkt.srcIface))
    }
    // 3. Dispatcher le paquet en evenements
    for (const event of dispatchPacket(pkt)) {
      this._bus.emit(event)
    }
  }

  // ── Callbacks voisinage ────────────────────────────────────────────────

  private _onNeighborUp(key: import('../values/EigrpNeighborKey').EigrpNeighborKey): void {
    // Envoyer un full Update (INIT flag) au nouveau voisin
    const allRoutes = this._topo.getRoutableEntries()
    if (allRoutes.length === 0) return
    const tlvs = allRoutes.map(e => this._routeToTlv(e))
    const pkt  = EigrpPacketCodec.makeUpdate({
      seqNo: ++this._localSeq, ackNo: 0, asNumber: this.asNumber,
      tlvs, srcIp: this._iface.getLocalIp(key.iface), srcIface: key.iface,
      init: true,
    })
    this._rtp.sendReliable(pkt, key)
  }

  private _onNeighborDown(
    key: import('../values/EigrpNeighborKey').EigrpNeighborKey,
    reason: string,
  ): void {
    this._neighbors.remove(key)
    const result = this._dual.processNeighborDown(key)
    if (result.ok) for (const a of result.value) this._bus.dispatch(a)
  }

  // ── Emission de paquets ────────────────────────────────────────────────

  private _sendHello(iface: string): void {
    const pkt = EigrpPacketCodec.makeHello({
      seqNo: 0, asNumber: this.asNumber,
      kValues: this.options.kValues, holdTime: this.options.holdTime,
      srcIp: this._iface.getLocalIp(iface), srcIface: iface,
    })
    this._rtp.sendUnreliable(pkt)  // Hello = multicast, pas fiable
  }

  private _startHelloTimer(iface: string): void {
    this._sendHello(iface)
    const timer = setInterval(
      () => this._sendHello(iface),
      this.options.helloInterval * 1000,
    )
    this._helloTimers.set(iface, timer)
  }

  private _sendUpdate(
    prefix: import('../values/EigrpPrefix').EigrpPrefix,
    metric: import('../values/EigrpMetric').EigrpMetric,
    to?: import('../values/EigrpNeighborKey').EigrpNeighborKey,
  ): void {
    const tlv = this._prefixToInternalTlv(prefix, metric)
    for (const iface of this._iface.getActiveInterfaces()) {
      const pkt = EigrpPacketCodec.makeUpdate({
        seqNo: ++this._localSeq, ackNo: 0, asNumber: this.asNumber,
        tlvs: [tlv], srcIp: this._iface.getLocalIp(iface), srcIface: iface,
      })
      if (to) {
        this._rtp.sendReliable(pkt, to)
      } else {
        const neighbors = this._neighbors.getByInterface(iface)
        for (const n of neighbors) this._rtp.sendReliable(pkt, n.key)
      }
    }
  }

  private _sendQuery(
    prefix: import('../values/EigrpPrefix').EigrpPrefix,
    metric: import('../values/EigrpMetric').EigrpMetric,
    to?: import('../values/EigrpNeighborKey').EigrpNeighborKey,
  ): void {
    const tlv = this._prefixToInternalTlv(prefix, metric)
    const targets = to
      ? [to]
      : this._neighbors.getAll().map(n => n.key)
    for (const neighbor of targets) {
      const pkt = EigrpPacketCodec.makeQuery({
        seqNo: ++this._localSeq, ackNo: 0, asNumber: this.asNumber,
        tlvs: [tlv], srcIp: this._iface.getLocalIp(neighbor.iface),
        srcIface: neighbor.iface,
      })
      this._rtp.sendReliable(pkt, neighbor)
    }
  }

  private _sendReply(
    prefix: import('../values/EigrpPrefix').EigrpPrefix,
    metric: import('../values/EigrpMetric').EigrpMetric,
    to:     import('../values/EigrpNeighborKey').EigrpNeighborKey,
  ): void {
    const tlv = this._prefixToInternalTlv(prefix, metric)
    const pkt = EigrpPacketCodec.makeReply({
      seqNo: ++this._localSeq, ackNo: 0, asNumber: this.asNumber,
      tlvs: [tlv], srcIp: this._iface.getLocalIp(to.iface), srcIface: to.iface,
    })
    this._rtp.sendReliable(pkt, to)
  }

  private _sendPacket(
    pkt:      EigrpPacket,
    neighbor?: import('../values/EigrpNeighborKey').EigrpNeighborKey,
  ): void {
    this._iface.sendEigrpPacket(pkt, neighbor?.ip)
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private _prefixToInternalTlv(
    prefix: import('../values/EigrpPrefix').EigrpPrefix,
    metric: import('../values/EigrpMetric').EigrpMetric,
  ): import('../packet/EigrpTlv').EigrpTlv {
    return {
      type:              0x0102,
      prefix,
      metric:            metric.components,
      advertisedMetric:  metric.composite,
    }
  }

  private _routeToTlv(
    entry: import('../topology/types').TopologyEntry,
  ): import('../packet/EigrpTlv').EigrpTlv {
    return this._prefixToInternalTlv(entry.prefix, entry.successor!.metric)
  }

  private _buildFibEntry(
    prefix:    import('../values/EigrpPrefix').EigrpPrefix,
    via:       import('../values/EigrpNeighborKey').EigrpNeighborKey,
    fd:        number,
  ): import('../dual/EigrpFib').EigrpFibEntry {
    const entry = this._topo.getEntry(prefix)!
    const sources = entry.sources
      .filter(s => meetsVariance(s.fd, fd, this.options.variance))
      .slice(0, this.options.maximumPaths)

    return Object.freeze({
      prefix, successor: via, fd,
      ad: entry.successor?.ad ?? 0,
      nextHops: Object.freeze(sources.map(s => ({
        neighbor:     s.neighbor,
        nextHopIp:    s.neighbor.ip,
        iface:        s.neighbor.iface,
        fd:           s.fd,
        trafficShare: Math.ceil(fd / s.fd),  // unequal load balancing share
      }))),
    })
  }

  // ── Interface publique ────────────────────────────────────────────────

  onInterfaceUp(iface: string, ip: string, bw: number, delay: number): void {
    this._startHelloTimer(iface)
    this._bus.emit({ type: 'LOCAL_ROUTE_UP', prefix: EP.of(ip, 24), iface, bandwidth: bw, delay })
  }

  onInterfaceDown(iface: string): void {
    clearInterval(this._helloTimers.get(iface))
    this._helloTimers.delete(iface)
    for (const n of this._neighbors.getByInterface(iface)) {
      this._bus.emit({ type: 'NEIGHBOR_DOWN', neighbor: n.key as any, reason: 'INTERFACE_DOWN' })
    }
  }

  redistributeRoute(prefix: string, prefixLen: number, m: import('../values/EigrpMetric').EigrpInterfaceMetric): void {
    const p      = EP.of(prefix, prefixLen)
    const metric = computeEigrpMetric(m, this.options.kValues)
    const result = this._dual.injectLocalRoute(p, metric)
    if (result.ok) for (const a of result.value) this._bus.dispatch(a)
  }

  withdrawRedistributedRoute(prefix: string, prefixLen: number): void {
    const p = EP.of(prefix, prefixLen)
    const result = this._dual.withdrawLocalRoute(p)
    if (result.ok) for (const a of result.value) this._bus.dispatch(a)
  }

  getNeighbors():      readonly import('../neighbor/types').EigrpNeighborEntry[] { return this._neighbors.getAll() }
  getTopologyTable():  readonly import('../topology/types').TopologyEntry[]       { return this._topo.getAllEntries() }
  getFib():            readonly import('../dual/EigrpFib').EigrpFibEntry[]        { return this._fib.getAll() }
}
```

### 9.5 Diagramme reactif complet de EigrpProcess

```
                    EigrpProcess (Facade reactive)
                         |
     start()  ─────────> _wireReactiveStreams()
                         |
           ┌─────────────┼──────────────────────────────────────┐
           |             |             |              |          |
       hello$         updates$     queries$       replies$   siaTimer$
           |             |             |              |          |
           v             v             v              v          v
         NSM        DUAL.update  DUAL.query     DUAL.reply   _handleSia
           |             |             |              |
           v             v─────────────v──────────────v
       onNeighborUp                actions$ (Subject<DualAction>)
       onNeighborDown                   |
           |                     ───────┼────────────────────────
           |                    |       |       |       |       |
           |               INSTALL  WITHDRAW  SEND   SEND  SEND
           |                ROUTE   ROUTE    UPDATE  QUERY REPLY
           |                   |       |       |       |       |
           v                   v       v       v       v       v
        sendUpdate        iface.     iface.  rtp.    rtp.    rtp.
        (INIT flag)     install    withdraw send    send    send
                        Route      Route   Reliable Reliable Reliable

Streams RTP :
  rtp.events$.pipe(ofType(MAX_RETRANS)) --> bus.emit(NEIGHBOR_DOWN)
  bus.neighborDown$ --> dual.processNeighborDown() --> actions$
```

---

## 10. Intégration Router.ts + CLI Cisco — Adapter Pattern + Command Pattern

### 10.1 Objectif d'intégration

`EigrpProcess` est une unité autonome et testable en isolation. Pour l'intégrer dans la simulation :

| Besoin | Solution |
|---|---|
| Connecter `EigrpProcess` aux interfaces physiques du router | **Adapter** `RouterEigrpIntegration` |
| Recevoir les paquets IPv4 proto=88 depuis `handleFrame()` | Dispatch dans `Router.processIPv4()` |
| Exposer les commandes CLI Cisco IOS | `CiscoEigrpCommands` (Command Pattern) |
| Envoyer des paquets EIGRP via le réseau | `IEigrpNetworkInterface` (Port abstraction) |
| Observable → UI réactive (logs, topologie) | `EigrpEventBus.events$` publié au store Zustand |

---

### 10.2 IEigrpNetworkInterface — Adapter interface

```typescript
// src/network/eigrp/integration/IEigrpNetworkInterface.ts

import type { EigrpPacket }          from '../packet/types'
import type { EigrpNeighborKey }     from '../neighbor/types'
import type { EigrpInterfaceMetric } from '../metric/types'

/**
 * Abstraction de l'interface réseau du point de vue d'EigrpProcess.
 * Implémentée par RouterEigrpIntegration en production,
 * par un mock en test.
 */
export interface IEigrpNetworkInterface {
  /** Identifiant unique de l'interface (ex: "GigabitEthernet0/0") */
  readonly ifName: string

  /** Adresse IPv4 et masque de l'interface */
  readonly ipAddress: string
  readonly prefixLen:  number

  /** Métriques EIGRP de l'interface (bande passante, délai, charge, fiabilité) */
  getMetric(): EigrpInterfaceMetric

  /**
   * Envoie un paquet EIGRP vers une adresse de destination.
   * Unicast si neighbor fourni, multicast 224.0.0.10 sinon.
   */
  sendPacket(packet: EigrpPacket, destination: string): void

  /** Installe une route dans la FIB du routeur */
  installRoute(prefix: string, prefixLen: number, nextHop: string, metric: number): void

  /** Retire une route de la FIB du routeur */
  withdrawRoute(prefix: string, prefixLen: number): void
}
```

---

### 10.3 RouterEigrpIntegration — Concrete Adapter

```typescript
// src/network/eigrp/integration/RouterEigrpIntegration.ts

import type { IEigrpNetworkInterface } from './IEigrpNetworkInterface'
import type { EigrpPacket }            from '../packet/types'
import type { EigrpInterfaceMetric }   from '../metric/types'
import type { RouterPort }             from '../../devices/RouterPort'   // interface interne Router.ts

/**
 * Adapter concret : fait le pont entre EigrpProcess et Router.ts.
 *
 * Pattern : ADAPTER (GoF) — traduit l'interface de Router.ts
 *           (orientée Ethernet/IP) vers IEigrpNetworkInterface
 *           (orientée EIGRP).
 *
 * Reactive : injecte les paquets reçus dans EigrpProcess via
 *            eigrpProcess.injectPacket(), ce qui émet dans le bus.
 */
export class RouterEigrpIntegration implements IEigrpNetworkInterface {
  readonly ifName:    string
  readonly ipAddress: string
  readonly prefixLen: number

  private readonly _port: RouterPort

  constructor(port: RouterPort) {
    this._port     = port
    this.ifName    = port.name
    this.ipAddress = port.ipAddress ?? ''
    this.prefixLen = port.prefixLen ?? 0
  }

  getMetric(): EigrpInterfaceMetric {
    return {
      bandwidth:   this._port.bandwidth   ?? 1_000_000, // kbps, défaut 1 Gbps
      delay:       this._port.delay       ?? 10,        // µs
      load:        this._port.load        ?? 1,
      reliability: this._port.reliability ?? 255,
      mtu:         this._port.mtu         ?? 1500,
    }
  }

  sendPacket(packet: EigrpPacket, destination: string): void {
    // Serialise + encapsule en IPv4 proto=88 + Ethernet
    const rawIpv4 = this._encapsulateEigrp(packet, destination)
    this._port.sendRaw(rawIpv4)
  }

  installRoute(prefix: string, prefixLen: number, nextHop: string, metric: number): void {
    this._port.owner.routingTable.install({
      prefix, prefixLen, nextHop,
      metric,
      protocol: 'eigrp',
      adminDistance: 90,
    })
  }

  withdrawRoute(prefix: string, prefixLen: number): void {
    this._port.owner.routingTable.withdraw(prefix, prefixLen, 'eigrp')
  }

  // ─── private ────────────────────────────────────────────────────

  private _encapsulateEigrp(packet: EigrpPacket, dst: string): Uint8Array {
    const payload = EigrpPacketCodec.encode(packet)
    // IPv4 header : proto=88, src=this.ipAddress, dst
    const ipHeader = buildIPv4Header({
      src:      this.ipAddress,
      dst,
      proto:    88,
      ttl:      1,   // EIGRP multicast TTL=1
      payload,
    })
    return concat(ipHeader, payload)
  }
}
```

---

### 10.4 Dispatch proto=88 dans Router.ts

```typescript
// src/network/devices/CiscoRouter.ts  (extrait — méthode processIPv4)

import { EigrpPacketCodec } from '../eigrp/packet/EigrpPacketCodec'

class CiscoRouter extends Equipment {
  private _eigrpProcesses = new Map<number, EigrpProcess>() // asn → process

  // Appelé par handleFrame() après démultiplexage Ethernet → IP
  protected processIPv4(packet: IPv4Packet, ingressPort: RouterPort): void {
    switch (packet.protocol) {
      // ...existing cases (OSPF=89, ICMP=1, TCP=6, UDP=17)...

      case 88: {
        // EIGRP — injecter dans le processus EIGRP correspondant
        const decoded = EigrpPacketCodec.decode(packet.payload)
        if (!decoded.ok) return

        // Identifier le process par l'AS number présent dans l'entête EIGRP
        const asn = decoded.value.header.autonomousSystem
        const proc = this._eigrpProcesses.get(asn)
        if (!proc) return

        // Reactive : l'injection émet un EigrpEvent dans le bus,
        // ce qui déclenche la chaîne réactive (hello$/updates$/…)
        proc.injectPacket(decoded.value, ingressPort.ipAddress ?? '')
        break
      }

      default:
        this._forwardOrDrop(packet)
    }
  }

  /**
   * Démarre un process EIGRP pour un AS donné.
   * Appelé par CiscoEigrpCommands lors de "router eigrp <asn>".
   */
  startEigrpProcess(asn: number, options: Partial<EigrpProcessOptions> = {}): EigrpProcess {
    if (this._eigrpProcesses.has(asn)) return this._eigrpProcesses.get(asn)!

    const interfaces = [...this._ports.values()].map(p => new RouterEigrpIntegration(p))
    const proc = new EigrpProcess({
      asNumber:     asn,
      routerId:     this._routerId(),
      interfaces,
      kValues:      EigrpKValues.DEFAULT,
      helloInterval: 5,
      holdTime:     15,
      ...options,
    })

    // Publier les events EIGRP vers le logger global (Observable → store)
    proc.events$.subscribe(e => Logger.emit({ source: this.id, type: 'eigrp', payload: e }))

    this._eigrpProcesses.set(asn, proc)
    proc.start()
    return proc
  }

  stopEigrpProcess(asn: number): void {
    const proc = this._eigrpProcesses.get(asn)
    if (!proc) return
    proc.stop()
    this._eigrpProcesses.delete(asn)
  }
}
```

---

### 10.5 CiscoEigrpCommands — CLI Command Pattern (Open/Closed)

```typescript
// src/network/eigrp/integration/CiscoEigrpCommands.ts

import type { IRouterShell } from '../../devices/shells/IRouterShell'
import type { CiscoRouter }  from '../../devices/CiscoRouter'
import { EigrpProcessOptionsBuilder } from '../process/EigrpProcessOptionsBuilder'

/**
 * Implémente les commandes IOS liées à EIGRP.
 *
 * Commandes couvertes :
 *   router eigrp <asn>
 *   network <prefix> [wildcard]
 *   no network <prefix>
 *   redistribute connected
 *   no router eigrp <asn>
 *   show ip eigrp neighbors [detail]
 *   show ip eigrp topology [all-links]
 *   show ip eigrp interfaces
 *   show ip eigrp traffic
 *   debug eigrp packets
 *   no debug eigrp packets
 *
 * Pattern : COMMAND (GoF) — chaque handler est une fonction pure
 *           (pas d'état mutable dans CiscoEigrpCommands).
 * Pattern : OPEN/CLOSED — enregistrement dynamique dans la shell
 *           via registerCommand(), sans modifier la shell.
 */
export class CiscoEigrpCommands {
  private _currentAsn: number | null = null
  private _debugEnabled = false

  constructor(
    private readonly _router: CiscoRouter,
    private readonly _shell:  IRouterShell,
  ) {}

  /** Enregistre toutes les commandes dans la shell via son registre. */
  register(): void {
    this._shell.registerCommand(/^router eigrp (\d+)$/i,        (m) => this._cmdRouterEigrp(+m[1]))
    this._shell.registerCommand(/^network (\S+)(?: (\S+))?$/i,   (m) => this._cmdNetwork(m[1], m[2]))
    this._shell.registerCommand(/^no network (\S+)$/i,           (m) => this._cmdNoNetwork(m[1]))
    this._shell.registerCommand(/^redistribute connected$/i,     ()  => this._cmdRedistributeConnected())
    this._shell.registerCommand(/^no router eigrp (\d+)$/i,      (m) => this._cmdNoRouterEigrp(+m[1]))
    this._shell.registerCommand(/^show ip eigrp neighbors?(.*)$/i,(m) => this._cmdShowNeighbors(m[1].trim()))
    this._shell.registerCommand(/^show ip eigrp topology(.*)$/i,  (m) => this._cmdShowTopology(m[1].trim()))
    this._shell.registerCommand(/^show ip eigrp interfaces?$/i,  ()  => this._cmdShowInterfaces())
    this._shell.registerCommand(/^show ip eigrp traffic$/i,      ()  => this._cmdShowTraffic())
    this._shell.registerCommand(/^debug eigrp packets$/i,        ()  => this._cmdDebugOn())
    this._shell.registerCommand(/^no debug eigrp packets$/i,     ()  => this._cmdDebugOff())
  }

  // ─── Config commands ─────────────────────────────────────────────

  private _cmdRouterEigrp(asn: number): string[] {
    this._currentAsn = asn
    const proc = this._router.startEigrpProcess(asn)
    return [`Entering EIGRP router configuration mode for AS ${asn}.`]
  }

  private _cmdNoRouterEigrp(asn: number): string[] {
    this._router.stopEigrpProcess(asn)
    if (this._currentAsn === asn) this._currentAsn = null
    return [`EIGRP process ${asn} removed.`]
  }

  private _cmdNetwork(prefix: string, wildcard?: string): string[] {
    const proc = this._getProc()
    if (!proc) return ['% EIGRP process not configured. Use "router eigrp <asn>" first.']
    const prefixLen = wildcard ? wildcardToCidr(wildcard) : 32
    proc.advertiseNetwork(prefix, prefixLen)
    return []
  }

  private _cmdNoNetwork(prefix: string): string[] {
    const proc = this._getProc()
    if (!proc) return ['% No EIGRP process configured.']
    proc.withdrawRedistributedRoute(prefix, 32)
    return []
  }

  private _cmdRedistributeConnected(): string[] {
    const proc = this._getProc()
    if (!proc) return ['% No EIGRP process configured.']
    // Injecte toutes les routes directement connectées dans EIGRP
    for (const iface of this._router.getConnectedInterfaces()) {
      proc.advertiseNetwork(iface.network, iface.prefixLen)
    }
    return ['Connected networks redistributed into EIGRP.']
  }

  // ─── Show commands ────────────────────────────────────────────────

  private _cmdShowNeighbors(opt: string): string[] {
    const proc = this._getProc()
    if (!proc) return ['% No EIGRP process active.']
    const neighbors = proc.getNeighbors()
    if (neighbors.length === 0) return ['No EIGRP neighbors found.']

    const detail = /detail/i.test(opt)
    const header = [
      `EIGRP-IPv4 Neighbors for AS(${this._currentAsn})`,
      'H   Address          Interface       Hold Uptime   SRTT   RTO  Q Seq',
      '                                     (sec)         (ms)       Cnt Num',
    ]
    const rows = neighbors.map((n, i) => {
      const hold   = String(n.holdRemaining).padStart(4)
      const uptime = formatUptime(n.uptimeMs)
      const srtt   = String(n.srttMs).padStart(6)
      const rto    = String(Math.min(n.srttMs * 6, 5000)).padStart(5)
      const qCnt   = String(n.pendingAck).padStart(2)
      const seqNum = String(n.lastSeqSent).padStart(4)
      const line   = `${String(i).padStart(1)}   ${n.address.padEnd(16)} ${n.ifName.padEnd(15)} ${hold}  ${uptime}  ${srtt}  ${rto}  ${qCnt}  ${seqNum}`
      if (!detail) return [line]
      return [
        line,
        `   Version ${n.eigrpVersion}/${n.iosVersion}, Retrans: ${n.retransCount}, Retries: ${n.retries}`,
      ]
    })
    return [...header, ...rows.flat()]
  }

  private _cmdShowTopology(opt: string): string[] {
    const proc = this._getProc()
    if (!proc) return ['% No EIGRP process active.']
    const allLinks = /all-links/i.test(opt)
    const entries  = proc.getTopologyTable()

    const lines: string[] = [
      `EIGRP-IPv4 Topology Table for AS(${this._currentAsn})/ID(${this._router.routerId})`,
      'Codes: P - Passive, A - Active, U - Update, Q - Query, R - Reply,',
      '       r - reply Status, s - sia Status',
      '',
    ]

    for (const e of entries) {
      if (!allLinks && e.dualState !== 'PASSIVE') continue
      const stateCode = dualStateCode(e.dualState)
      lines.push(`${stateCode} ${e.prefix.address}/${e.prefix.length}, 1 successors, FD is ${e.fd}`)
      for (const rs of e.routeSources) {
        const label = rs.isSuccessor ? 'via' : 'via'
        lines.push(`        ${label} ${rs.neighborAddress} (${rs.fd}/${rs.ad}), ${rs.ifName}`)
      }
    }
    return lines
  }

  private _cmdShowInterfaces(): string[] {
    const proc = this._getProc()
    if (!proc) return ['% No EIGRP process active.']
    const lines = [
      `EIGRP-IPv4 Interfaces for AS(${this._currentAsn})`,
      `                              Xmit Queue   PeerQ        Mean   Pacing Time   Multicast    Pending`,
      `Interface              Peers  Un/Reliable  Un/Reliable  SRTT   Un/Reliable   Flow Timer   Routes`,
    ]
    for (const iface of this._router.getEigrpInterfaces(this._currentAsn!)) {
      const peers = proc.getNeighbors().filter(n => n.ifName === iface.name).length
      lines.push(
        `${iface.name.padEnd(22)} ${String(peers).padStart(5)}  0/0          0/0           0      0/0           0            0`
      )
    }
    return lines
  }

  private _cmdShowTraffic(): string[] {
    const proc = this._getProc()
    if (!proc) return ['% No EIGRP process active.']
    const stats = proc.getStats()
    return [
      `EIGRP-IPv4 Traffic Statistics for AS(${this._currentAsn})`,
      `  Hellos sent/received:   ${stats.hellosSent}/${stats.hellosReceived}`,
      `  Updates sent/received:  ${stats.updatesSent}/${stats.updatesReceived}`,
      `  Queries sent/received:  ${stats.queriesSent}/${stats.queriesReceived}`,
      `  Replies sent/received:  ${stats.repliesSent}/${stats.repliesReceived}`,
      `  Acks sent/received:     ${stats.acksSent}/${stats.acksReceived}`,
      `  SIA-Queries sent/received: ${stats.siaQueriesSent}/${stats.siaQueriesReceived}`,
      `  SIA-Replies sent/received: ${stats.siaRepliesSent}/${stats.siaRepliesReceived}`,
    ]
  }

  // ─── Debug commands ───────────────────────────────────────────────

  private _cmdDebugOn(): string[] {
    this._debugEnabled = true
    const proc = this._getProc()
    if (proc) {
      // S'abonner au bus d'événements — reactive
      proc.events$.subscribe(e => this._shell.printLine(`*EIGRP: ${JSON.stringify(e)}`))
    }
    return ['EIGRP packet debugging is on']
  }

  private _cmdDebugOff(): string[] {
    this._debugEnabled = false
    return ['EIGRP packet debugging is off']
  }

  // ─── helpers ─────────────────────────────────────────────────────

  private _getProc() {
    if (this._currentAsn === null) return null
    return this._router.getEigrpProcess(this._currentAsn) ?? null
  }
}

// ─── Pure utility functions ───────────────────────────────────────────────────

function wildcardToCidr(wildcard: string): number {
  const parts = wildcard.split('.').map(Number)
  const mask  = parts.map(b => 255 - b)
  return mask.reduce((acc, b) => acc + popcount(b), 0)
}

function popcount(n: number): number {
  let c = 0
  while (n) { c += n & 1; n >>= 1 }
  return c
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}

function dualStateCode(state: string): string {
  const map: Record<string, string> = {
    PASSIVE: 'P', ACTIVE: 'A', SIA_ACTIVE: 'A',
    UPDATE: 'U', QUERY: 'Q', REPLY: 'R',
  }
  return map[state] ?? 'P'
}
```

---

### 10.6 Flux de réception de paquet complet (séquence reactive)

```
handleFrame(frame: EthernetFrame)           // Equipment base
  └─ demux Ethernet → IPv4
      └─ processIPv4(packet, port)          // CiscoRouter
          └─ case 88 (EIGRP):
              EigrpPacketCodec.decode(payload) → Result<EigrpPacket>
              proc.injectPacket(pkt, src)
                └─ _bus.emit(EigrpEvent)    // EigrpEventBus.emit()
                    │
                    ├─ hello$     → EigrpNeighborStateMachine.processEvent()
                    │                 → NEIGHBOR_UP / NEIGHBOR_DOWN
                    │
                    ├─ updates$   → EigrpDual.processUpdate()
                    │                 → DualAction[]
                    │                     ├─ INSTALL_ROUTE → iface.installRoute()
                    │                     ├─ WITHDRAW_ROUTE → iface.withdrawRoute()
                    │                     └─ SEND_UPDATE → rtp.sendReliable()
                    │
                    ├─ queries$   → EigrpDual.processQuery()
                    │                 → DualAction[] (SEND_REPLY / SEND_QUERY)
                    │
                    └─ replies$   → EigrpDual.processReply()
                                      → DualAction[] (INSTALL_ROUTE / SEND_UPDATE)
```

---

### 10.7 Arbre des fichiers du module EIGRP

```
src/network/eigrp/
├── index.ts                          # re-exports publics
│
├── packet/
│   ├── types.ts                      # EigrpPacket, EigrpHeader, TLV union
│   ├── EigrpPacketCodec.ts           # encode / decode (Result<T,E>)
│   └── tlv/
│       ├── InternalRouteTlv.ts
│       ├── ExternalRouteTlv.ts
│       └── ParametersTlv.ts
│
├── metric/
│   ├── types.ts                      # EigrpInterfaceMetric, EigrpKValues, EigrpMetric (VO)
│   └── EigrpMetricCalculator.ts      # computeEigrpMetric() — pure function
│
├── neighbor/
│   ├── types.ts                      # EigrpNeighborKey (VO), EigrpNeighborEntry, EigrpNeighborState
│   ├── EigrpNeighborTable.ts         # IEigrpNeighborTable, InMemoryNeighborTable
│   └── EigrpNeighborStateMachine.ts  # NSM — pure state transitions
│
├── topology/
│   ├── types.ts                      # EigrpPrefix (VO), TopologyEntry, RouteSource, DualState
│   └── EigrpTopologyTable.ts         # IEigrpTopologyTable, InMemoryTopologyTable
│
├── dual/
│   ├── types.ts                      # DualAction discriminated union
│   ├── EigrpDual.ts                  # IEigrpDual, EigrpDual — pure DUAL logic
│   ├── EigrpFib.ts                   # EigrpFibEntry, IEigrpFib, InMemoryFib
│   └── pureUtils.ts                  # isFeasibleSuccessor, computeEigrpMetric
│
├── reactive/
│   ├── EigrpSubject.ts               # EigrpSubject<T>, EigrpObservable<T>
│   ├── operators.ts                  # filter, map, ofType, merge, bufferCount
│   └── EigrpEventBus.ts             # EigrpEventBus + typed sub-streams
│
├── rtp/
│   ├── types.ts                      # RtpEvent discriminated union
│   ├── RtpSequenceTracker.ts         # per-neighbor sequence numbers
│   └── RtpChannel.ts                 # IRtpChannel, RtpChannel — reliable transport
│
├── process/
│   ├── types.ts                      # EigrpProcessOptions, EigrpStats
│   ├── EigrpProcessOptionsBuilder.ts # Builder pattern
│   ├── IEigrpProcess.ts              # interface publique
│   └── EigrpProcess.ts               # Facade reactive principale
│
├── integration/
│   ├── IEigrpNetworkInterface.ts     # Adapter interface
│   ├── RouterEigrpIntegration.ts     # Adapter concret → Router.ts
│   └── CiscoEigrpCommands.ts         # CLI Command Pattern
│
└── __tests__/
    ├── metric.test.ts                # tests pures computeEigrpMetric
    ├── dual.test.ts                  # tests pures DUAL (Feasibility Condition)
    ├── neighborTable.test.ts         # tests InMemoryNeighborTable
    ├── topologyTable.test.ts         # tests InMemoryTopologyTable
    ├── reactive.test.ts              # tests EigrpSubject + Operators
    ├── rtpChannel.test.ts            # tests RtpChannel (retransmit, backoff)
    └── eigrpProcess.test.ts          # intégration EigrpProcess (mocks interfaces)
```

---

### 10.8 Tests — stratégie reactive

```typescript
// src/network/eigrp/__tests__/reactive.test.ts

import { describe, it, expect, vi } from 'vitest'
import { EigrpSubject }  from '../reactive/EigrpSubject'
import { Operators }     from '../reactive/operators'
import { EigrpEventBus } from '../reactive/EigrpEventBus'

describe('EigrpSubject', () => {
  it('delivers values to all subscribers', () => {
    const s = new EigrpSubject<number>()
    const received: number[] = []
    s.subscribe(v => received.push(v))
    s.next(1); s.next(2); s.next(3)
    expect(received).toEqual([1, 2, 3])
  })

  it('unsubscribe stops delivery', () => {
    const s = new EigrpSubject<number>()
    const received: number[] = []
    const unsub = s.subscribe(v => received.push(v))
    s.next(1)
    unsub()
    s.next(2)
    expect(received).toEqual([1])
  })

  it('complete() stops all subscribers', () => {
    const s = new EigrpSubject<number>()
    const received: number[] = []
    s.subscribe(v => received.push(v))
    s.next(1)
    s.complete()
    s.next(2) // doit être ignoré
    expect(received).toEqual([1])
  })
})

describe('Operators.ofType', () => {
  type EvtA = { type: 'A'; data: string }
  type EvtB = { type: 'B'; count: number }
  type Evt  = EvtA | EvtB

  it('filters to typed sub-stream', () => {
    const s = new EigrpSubject<Evt>()
    const received: EvtA[] = []
    const unsub = s
      .pipe(Operators.ofType((e): e is EvtA => e.type === 'A'))
      .subscribe(e => received.push(e))
    s.next({ type: 'A', data: 'hello' })
    s.next({ type: 'B', count: 42 })
    s.next({ type: 'A', data: 'world' })
    unsub()
    expect(received).toHaveLength(2)
    expect(received[0].data).toBe('hello')
  })
})

describe('EigrpEventBus', () => {
  it('hello$ receives only hello events', () => {
    const bus   = new EigrpEventBus()
    const hellos: unknown[] = []
    const unsub = bus.hello$.subscribe(e => hellos.push(e))
    bus.emit({ type: 'HELLO_RECEIVED', from: '10.0.0.1', ifName: 'Gi0/0',
               holdTime: 15, asn: 1, routerId: '1.1.1.1', version: 2,
               kValues: { k1:1, k2:0, k3:1, k4:0, k5:0 } })
    bus.emit({ type: 'UPDATE_RECEIVED', from: '10.0.0.1', ifName: 'Gi0/0',
               prefix: '192.168.1.0', prefixLen: 24, asn: 1,
               metric: { composite: 28160, components: null as any },
               seqNo: 1, flags: 0 })
    unsub()
    expect(hellos).toHaveLength(1)
  })
})
```

---

# Best Practices Gap Analysis

> **Date:** 2026-03-21
> **Scope:** Equipment, Commands, Protocols, Filesystems
> **Methodology:** SOLID, DRY, KISS, Clean Architecture, Design Patterns

---

## Executive Summary

The codebase is a well-designed, equipment-driven network simulator with strong RFC compliance and clean vendor abstraction. However, the analysis reveals **3 critical**, **8 high**, and **15+ medium** severity issues across 4 axes. The most impactful problems are **God Classes** (Router: 4,406 lines, EndHost: 1,928 lines, OSPFEngine: 3,247 lines, IPSecEngine: 3,425 lines), **massive IPv4/IPv6 code duplication** (~2,000+ lines), and **missing protocol abstractions**.

### Severity Matrix

| Category               | Critical | High | Medium | Low |
|------------------------|----------|------|--------|-----|
| Equipment              | 2        | 3    | 5      | 3   |
| Commands / Terminal     | 1        | 2    | 4      | 2   |
| Protocols              | 1        | 3    | 4      | 3   |
| Filesystems            | 0        | 2    | 2      | 2   |
| **Total**              | **4**    | **10** | **15** | **10** |

---

## 1. Equipment Layer

### 1.1 God Classes (CRITICAL — SRP Violation)

The two base classes concentrating the entire L2/L3/L4 stack violate massively the Single Responsibility Principle.

| Class | Lines | Methods (est.) | Responsibilities |
|-------|-------|----------------|-----------------|
| `Router.ts` | 4,406 | ~250 | ARP, IPv4 forwarding, IPv6 forwarding, ICMP, ICMPv6, RIPv2, OSPF integration, OSPFv3 integration, IPSec integration, ACLs, rate limiting, NDP, RA generation |
| `EndHost.ts` | 1,928 | ~150 | ARP, IPv4, IPv6, ICMP, ICMPv6, NDP, routing, ping, traceroute, DHCP client, NAT, firewall |

**Recommended decomposition (composition over inheritance):**

```typescript
// Instead of one 4,400-line Router class:
class Router extends Equipment {
  private arpResolver: ARPResolver;
  private ipv4Engine: IPv4ForwardingEngine;
  private ipv6Engine: IPv6ForwardingEngine;
  private icmpResponder: ICMPResponder;
  private ripEngine: RIPEngine;
  private aclEngine: ACLEngine;
  // ...
}
```

**Files:** `src/network/devices/Router.ts`, `src/network/devices/EndHost.ts`

---

### 1.2 IPv4 / IPv6 Code Duplication (CRITICAL — DRY Violation)

Almost every networking concern is implemented twice — once for IPv4, once for IPv6 — with near-identical structure but zero shared code.

| Concern | IPv4 implementation | IPv6 parallel | Est. duplicated lines |
|---------|--------------------|--------------|-----------------------|
| Packet forwarding | `handleIPv4()` | `handleIPv6()` | ~400 |
| Neighbor resolution | `handleARP()` | NDP handling | ~300 |
| Echo (ping) | `pendingPings` | `pendingPing6s` | ~200 |
| ICMP error gen. | ICMP | ICMPv6 | ~200 |
| Packet queuing | `fwdQueue` | `ipv6FwdQueue` | ~150 |
| Routing lookup | `routingTable` | IPv6 routing | ~200 |
| **Total** | | | **~1,500+** |

**Recommendation:** Extract generic abstractions:

```typescript
interface NeighborCache<TAddress> {
  resolve(addr: TAddress, iface: string): MACAddress | null;
  learn(addr: TAddress, mac: MACAddress, iface: string): void;
  getPending(addr: TAddress): QueuedPacket[];
}

// Single implementation, parameterized
class NeighborResolver<TAddress> implements NeighborCache<TAddress> { ... }
```

---

### 1.3 Static Equipment Registry (HIGH — Testability)

`Equipment.ts` uses a global static `Map` as device registry.

```typescript
// Current: global mutable state
private static registry: Map<string, Equipment> = new Map();
```

**Issues:**
- Not injectable / mockable without `clearRegistry()`
- Devices never deregister (memory leak on dynamic add/remove)
- Powered-off devices still returned by `getById()`
- Test isolation requires manual `clearRegistry()` calls

**Recommendation:** Extract to injectable `EquipmentRegistry` class.

---

### 1.4 Base Class Abstraction Leaks (HIGH — ISP Violation)

`Equipment.ts` exposes methods only relevant to a subset of devices:

| Method | Only used by |
|--------|-------------|
| `readFileForEditor()` | LinuxPC, LinuxServer |
| `writeFileFromEditor()` | LinuxPC, LinuxServer |
| `checkPassword()` | LinuxPC, LinuxServer |
| `userExists()` | LinuxPC, LinuxServer |
| `resolveAbsolutePath()` | LinuxPC, LinuxServer |

These should live in a `IFileSystemCapable` or `IUserManageable` interface, not on the base class.

---

### 1.5 Port.ts Configuration Bloat (MEDIUM — SRP)

`Port.ts` (528 lines) manages 15+ concerns: IPv4, IPv6, speed, duplex, MTU, security, counters, link state.

**Recommendation:** Split into composition:

```typescript
class Port {
  readonly config: PortConfig;        // IP, MTU, speed, duplex
  readonly counters: PortCounters;    // RFC 2863 ifTable
  readonly security: PortSecurity;    // MAC filtering, violation modes
}
```

**Additional Port issues:**
- `checkPortSecurity()` returns boolean but **modifies state** (side effect)
- MTU is validated on set (68–9216) but **never enforced** on `sendFrame()`
- Unsafe type assertion: `(this as { mac: MACAddress }).mac = mac`

---

### 1.6 Missing Abstractions (HIGH)

| Missing | Impact | Where needed |
|---------|--------|-------------|
| `IProtocolEngine` interface | OSPF, RIP, IPSec have incompatible APIs | Router.ts |
| `RoutingTable` class | Routing is a raw `RouteEntry[]` with O(n) linear scan | EndHost.ts, Router.ts |
| `PacketQueue<T>` | IPv4 and IPv6 queues are separate, duplicated structures | EndHost.ts, Router.ts |
| `ConfigStore` interface | Router has no config persistence; Switch has JSON; inconsistent | All devices |

---

### 1.7 Magic Strings & Numbers (MEDIUM)

| Location | Example | Count |
|----------|---------|-------|
| Device type checks | `"router-cisco"`, `"switch-huawei"` | 50+ |
| Port naming | `"GigabitEthernet0/X"`, `"GE0/0/X"` | 10+ |
| Timeouts | `30000` (RIP update), `180000` (RIP timeout) | 10+ |
| Boot messages | `"C2960"`, `"AR2220"` | 15+ |

**Recommendation:** Extract to typed constants:

```typescript
export const DEVICE_TYPES = {
  ROUTER_CISCO: 'router-cisco',
  ROUTER_HUAWEI: 'router-huawei',
  // ...
} as const;

export const RIP_TIMERS = {
  UPDATE_INTERVAL_MS: 30_000,
  TIMEOUT_MS: 180_000,
  GARBAGE_COLLECTION_MS: 120_000,
} as const;
```

---

### 1.8 Liskov Substitution Violations (MEDIUM)

1. **`executeCommand()`** — Returns `Promise<string>` but Hub is synchronous; callers must handle both
2. **`handleFrame()`** — Declared `void` but Router/EndHost trigger async ARP/NDP timers internally
3. **`firewallFilter()`** — Default implementation ignores all parameters; should be abstract or use Template Method

---

### 1.9 Error Handling Gaps (MEDIUM)

- Invalid checksums: logged but no counter incremented (`ipInHdrErrors` missing)
- Port down on send: warning log only, no error counter
- Route lookup failure: silent, no `icmpDestUnreachable` generated consistently
- ARP cache: no TTL/expiration, no source validation (ARP spoofing possible)
- Pending requests (`pendingARPs`, `pendingPings`): no cleanup on device power-off (memory leak)

---

*Sections 2 (Commands), 3 (Protocols), and 4 (Filesystems) to follow.*

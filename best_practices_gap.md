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
| Equipment (§1)         | 2        | 3    | 5      | 3   |
| Commands / Terminal (§2) | 1      | 2    | 4      | 2   |
| Protocols (§3)         | 3        | 3    | 4      | 0   |
| Filesystems / DB (§4)  | 1        | 3    | 4      | 2   |
| **Total**              | **7**    | **11** | **17** | **7** |

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

## 2. Commands & Terminal Layer

### 2.1 Shell God Classes (CRITICAL — SRP Violation)

| Class | Lines | State Fields | CommandTries | Responsibilities |
|-------|-------|-------------|-------------|-----------------|
| `CiscoIOSShell.ts` | ~530 | 16+ | 15 | Mode management, prompt generation, pipe filtering, command routing, async ops, help, tab completion |
| `HuaweiVRPShell.ts` | ~260 | 13 | 8+ | Same pattern as Cisco |
| `LinuxTerminalSession.ts` | ~428 | N/A | N/A | Editor management, SQL*Plus subshell, flow orchestration, tab completion, key handling |
| `CLITerminalSession.ts` | ~317 | N/A | N/A | Pager state, boot animation, command execution, inline help, tab completion |

**Key example — CiscoIOSShell has 16+ mutable state fields:**

```typescript
private selectedInterface: string | null = null;
private selectedDHCPPool: string | null = null;
private selectedACL: string | null = null;
private selectedISAKMPPriority: number | null = null;
private selectedTransformSet: string | null = null;
// ... 10+ more sub-mode state fields
```

**Recommended decomposition:**

```typescript
// Instead of one monolithic shell:
class CiscoIOSShell implements IRouterShell {
  private modeController: CiscoModeController;  // mode state machine
  private promptBuilder: CiscoPromptBuilder;     // prompt generation
  private pipeFilter: OutputPipeline;            // pipe/include/grep
  private commandRouter: CommandRouter;          // dispatch to handlers
}
```

**Files:** `src/network/devices/shells/CiscoIOSShell.ts`, `src/network/devices/shells/HuaweiVRPShell.ts`

---

### 2.2 Flow Builder Duplication (HIGH — DRY Violation)

Three flow builders independently implement identical patterns:

| Pattern | CiscoFlowBuilder | HuaweiFlowBuilder | LinuxFlowBuilder |
|---------|------------------|--------------------|-----------------|
| Password validation step | Lines 24-33 | Lines 23-31 | Lines 54-60 |
| Confirmation prompts | Inline | Inline | Lines 100-120 |
| Max retry logic | Hardcoded 3 | Hardcoded 3 | Hardcoded 3 |
| Error message formatting | Custom | Custom | Custom |

**Recommendation:** Extract shared `PasswordStep`, `ConfirmationStep`, `RetryPolicy` builders:

```typescript
// Shared flow step factories
const passwordStep = FlowSteps.password({
  prompt: 'Password:',
  validator: (pw) => device.checkPassword(user, pw),
  maxRetries: 3,
  errorMessage: 'Wrong password – try again.',
});
```

**Files:** `src/terminal/cisco/CiscoFlowBuilder.ts`, `src/terminal/sessions/LinuxFlowBuilder.ts`

---

### 2.3 Missing Command Architecture Abstractions (HIGH)

| Missing Abstraction | Impact | Where needed |
|---------------------|--------|-------------|
| `ICommandParser` | Each command manually parses `string[]` args | All 100+ command handlers |
| `OutputPipeline` | Pipe/include/grep/findstr logic duplicated | CiscoIOSShell, HuaweiVRPShell |
| `CLIStateMachine` | Mode switching logic scattered across 3 shells | CiscoIOSShell, HuaweiVRPShell |
| `PromptBuilder` | Prompt generation is copy-pasted switch statements | Both vendor shells |
| `ErrorResponseBuilder` | Error messages hardcoded as raw strings | 50+ locations |
| `ISubShellFactory` | Subshell creation hardcoded in LinuxTerminalSession | LinuxTerminalSession |

---

### 2.4 Magic Strings Everywhere (HIGH)

**Mode constants (no enum, no const file):**

```typescript
// Scattered across CiscoIOSShell, CiscoConfigCommands, etc.
'user'          // 15+ occurrences
'privileged'    // 12+ occurrences
'config'        // 20+ occurrences
'config-if'     // 10+ occurrences
'config-dhcp'   // 5+ occurrences
'config-router' // 5+ occurrences
```

**Error messages duplicated across files:**

```typescript
"% Incomplete command."                      // 5+ files
"Error: Incomplete command."                 // Huawei variant
"% Invalid input detected at '^' marker."   // Cisco
"Error: Wrong parameter found at '^' position." // Huawei
```

**Recommendation:** Extract to typed constants:

```typescript
export const CISCO_MODES = {
  USER: 'user',
  PRIVILEGED: 'privileged',
  CONFIG: 'config',
  CONFIG_IF: 'config-if',
  CONFIG_DHCP: 'config-dhcp',
  CONFIG_ROUTER: 'config-router',
  // ...
} as const;

export const CISCO_ERRORS = {
  INCOMPLETE: '% Incomplete command.',
  UNRECOGNIZED: '% Unrecognized command',
  INVALID_INPUT: "% Invalid input detected at '^' marker.",
} as const;
```

---

### 2.5 Tight Coupling: Shell ↔ Router (HIGH)

**CiscoIOSShell stores a mutable router reference:**

```typescript
// Set temporarily during execute(), then nullified
private routerRef: Router | null = null;

r(): Router {
  if (!this.routerRef) throw new Error('Router reference not set (BUG)');
  return this.routerRef;
}
```

**Issues:**
- Race condition if `execute()` called concurrently
- Router reference is a mutable global-like variable
- No `IRouterForShell` interface — shell depends on full Router (250+ methods)

**Recommendation:** Inject a typed context object:

```typescript
interface IRouterShellContext {
  hostname: string;
  getRoutingTable(): RouteEntry[];
  configureInterface(name: string, ip: IPAddress, mask: SubnetMask): void;
  // Only expose methods the shell actually needs
}
```

---

### 2.6 Async Operations: Race Conditions (MEDIUM)

```typescript
// CiscoIOSShell.ts line 92
private _pendingAsync: Promise<string> | null = null;
```

The shell stores a pending async operation as a mutable instance field. If `execute()` is called again before the promise resolves, the previous operation is lost silently.

**Recommendation:** Return `Promise<string>` directly from `execute()` instead of storing state.

---

### 2.7 CiscoShellContext Interface Too Large (MEDIUM — ISP)

The `CiscoShellContext` interface in `CiscoConfigCommands.ts` has **20+ getter/setter methods** mixing unrelated concerns:

- Mode selection (3 methods)
- Interface selection (2 methods)
- DHCP pool selection (2 methods)
- ACL selection (3 methods)
- IPSec mode selections (10+ methods)

**Recommendation:** Segregate into focused interfaces:

```typescript
interface IModeController {
  getMode(): string;
  setMode(mode: string): void;
}

interface IInterfaceSelector {
  getSelectedInterface(): string | null;
  setSelectedInterface(name: string | null): void;
}

interface IACLSelector {
  getSelectedACL(): string | null;
  setSelectedACL(name: string | null): void;
  getSelectedACLType(): 'standard' | 'extended' | null;
}
```

---

### 2.8 Interface Resolution Duplication (MEDIUM — DRY)

`resolveInterfaceName()` is implemented separately in:
- `src/network/devices/shells/cisco/CiscoConfigCommands.ts`
- `src/network/devices/shells/huawei/HuaweiDisplayCommands.ts`

**Both** convert abbreviated interface names (e.g., `gi0/0` → `GigabitEthernet0/0`). Identical logic, different files.

---

### 2.9 Testability Issues (MEDIUM)

| Issue | Impact |
|-------|--------|
| Only 3 test files for entire terminal layer | Low coverage |
| Shell state (16+ fields) not snapshotable | Can't verify state transitions |
| Flow builders require full Device instance | Can't unit test independently |
| No `ITerminalSessionFactory` | Sessions hard to mock |
| `CommandTrie` action signature: `(args: string[], rawLine: string) => string` | No typed args, no async support |
| No mock router interface exposed | Tests must mock 250+ methods |

---

### 2.10 Output Formatting Repetition (MEDIUM)

Routing table formatting logic appears in:
- `CiscoShowCommands.ts` (lines 33-54) — Cisco format
- `HuaweiDisplayCommands.ts` (lines 72-94) — Huawei format

Both implement column alignment, protocol code mapping, and metric display independently.

**Recommendation:** Shared `RoutingTableFormatter` with vendor-specific templates.

---

### 2.11 Large Method Bodies (MEDIUM)

| Method | File | Lines | Concern |
|--------|------|-------|---------|
| `execute()` | CiscoIOSShell.ts | 233-303 (70) | Pipe parsing + help + mode switch + async |
| `executeCommand()` | LinuxTerminalSession.ts | 166-246 (80) | Exit + editor + oracle + flow + device exec |
| `buildSudoFlow()` | LinuxFlowBuilder.ts | 222-314 (92) | 4 levels of conditional for sudo variants |
| `buildConfigCommands()` | CiscoConfigCommands.ts | ~346 | 30+ inline command registrations |

---

## 3. Protocol Layer

### 3.1 OSPF God Class (CRITICAL — SRP Violation)

`OSPFEngine.ts` (3,247 lines) is the largest single class in the codebase. It handles 8+ distinct responsibilities:

| Responsibility | Estimated Lines |
|---------------|----------------|
| Neighbor FSM (8 states) | ~500 |
| DD/LSR/LSU packet processing | ~600 |
| SPF scheduling & execution (Dijkstra) | ~400 |
| LSA origination & aging | ~350 |
| DR/BDR election | ~200 |
| Interface state management | ~300 |
| Virtual link management | ~100 |
| Fletcher-16 checksum | ~117 |

**Recommended decomposition:**

```typescript
class OSPFEngine {
  private neighborManager: OSPFNeighborManager;  // FSM + adjacency
  private lsdb: OSPFLinkStateDB;                 // LSA storage + aging
  private spfScheduler: OSPFSPFScheduler;        // throttled SPF runs
  private floodingEngine: OSPFFloodingEngine;     // reliable flooding
  private interfaceManager: OSPFInterfaceManager; // DR election + state
}
```

**File:** `src/network/ospf/OSPFEngine.ts`

---

### 3.2 OSPFv2/v3 Duplication (CRITICAL — DRY Violation)

`OSPFv3Engine.ts` (655 lines) duplicates ~70% of `OSPFEngine.ts` logic:

| Shared Logic | OSPFv2 | OSPFv3 | Duplicated Lines |
|-------------|--------|--------|-----------------|
| Neighbor FSM | ✓ | ✓ | ~300 |
| DR/BDR election | ✓ | ✓ | ~150 |
| Interface state machine | ✓ | ✓ | ~200 |
| Hello protocol | ✓ | ✓ | ~100 |
| **Total** | | | **~750** |

**Additional issues:**
- OSPFv3Engine has **no SPF implementation** — routes never computed (lines 609-611 return `[]`)
- No shared base class; both engines maintain independent neighbor/interface data structures
- Both use `OSPFNeighbor`, `OSPFArea`, LSDB structures from same `types.ts`

**Recommendation:** Extract `BaseOSPFEngine<TAddress>` generic class covering shared FSM, DR election, and interface management.

---

### 3.3 IPSec God Class (CRITICAL — SRP Violation)

`IPSecEngine.ts` (3,425 lines) handles 12+ responsibilities:

| Concern | Lines (est.) | Should Be |
|---------|-------------|-----------|
| IKEv1 SA negotiation | ~400 | `IKEv1Engine` |
| IKEv2 SA negotiation | ~350 | `IKEv2Engine` |
| ESP/AH encapsulation | ~300 | `IPSecEncapsulator` |
| SPD (Security Policy Database) | ~200 | `SPDEngine` |
| SA databases (IKE, IPSec, Multicast) | ~250 | `SADatabase` |
| Fragment reassembly | ~200 | `FragmentReassembler` |
| Transform set parsing | ~150 | Config module |
| Crypto map management | ~200 | Config module |
| DPD (Dead Peer Detection) | ~100 | `DPDMonitor` |
| Key derivation simulation | ~100 | Utility |

**Bidirectional coupling:** Constructor takes `router: Router` (line 269/343), creating tight circular dependency.

**File:** `src/network/ipsec/IPSecEngine.ts`

---

### 3.4 Protocol Engine Interface Gap (HIGH)

`IProtocolEngine` interface exists in `src/network/core/interfaces.ts` but is only implemented by `RIPEngine`:

| Protocol Engine | Implements `IProtocolEngine`? | Has `start()`/`stop()`? |
|----------------|------------------------------|------------------------|
| RIPEngine | ✓ | ✓ |
| OSPFEngine | ✗ | Partial (uses `setSendCallback()`) |
| OSPFv3Engine | ✗ | Partial |
| IPSecEngine | ✗ | ✗ |
| DHCPServer | ✗ | ✗ |
| DHCPClient | ✗ | ✗ |

**Router protocol initialization is inconsistent:**

```typescript
// Router.ts — inconsistent lifecycle patterns
private dhcpServer: DHCPServer = new DHCPServer();     // eagerly created, always on
private ospfEngine: OSPFEngine | null = null;          // lazy, nullable
private ipsecEngine: IPSecEngine | null = null;        // lazy, nullable
```

**Recommendation:** All engines should implement `IProtocolEngine` for uniform lifecycle management.

---

### 3.5 DHCP Server Responsibilities (HIGH — SRP)

`DHCPServer.ts` (1,017 lines) mixes 6 concerns:

| Concern | Should Be |
|---------|-----------|
| Pool configuration | `DHCPPoolManager` |
| Address allocation (DORA) | `DHCPAddressAllocator` |
| Lease binding management | `DHCPLeaseDB` |
| Conflict tracking | `DHCPConflictDB` |
| Statistics | `DHCPStatistics` |
| Excluded range checking | Part of `DHCPPoolManager` |

**Additional issues:**
- No IPv6 / DHCPv6 support (RFC 8415) despite IPv6 in Router
- `DHCPClient.ts` (685 lines) uses string state machine ('INIT', 'BOUND') — should use enum
- Both client and server duplicate DHCP option code constants (Option 53, 1, 3, etc.)

---

### 3.6 Protocol Magic Numbers (HIGH)

| Location | Example | Count |
|----------|---------|-------|
| OSPF SPF throttle | `200`, `1_000`, `10_000` | 3 |
| OSPF sequence number | `0x80000001` (initial) | 2 |
| OSPF metric | `0xFFFF` (infinity) | 3 |
| OSPF neighbor states | `'Down'`, `'Init'`, `'Full'` (strings) | 20+ |
| OSPF LSA types | `1`, `2`, `3`, `4`, `5`, `7` (bare ints) | 15+ |
| IPSec sequence max | `0xFFFFFFFF` | 2 |
| IPSec ESP overhead | `50` | 1 |
| IPSec frag timeout | `30_000` | 1 |
| DHCP lease default | `86400` (1 day) | 2 |
| DHCP option codes | `53`, `1`, `3`, `6` | 10+ |

**Partially addressed:** `src/network/core/constants.ts` now contains `OSPF_CONSTANTS` and `IPSEC_CONSTANTS` (added in this review), but protocol code has not been updated to use them yet.

---

### 3.7 Fragment Reassembly (MEDIUM — IPv4-Only)

IPSecEngine fragment reassembly (lines 199-240) is hardcoded for IPv4:
- No IPv6 support despite `IPv6Packet` being imported
- MTU calculations assume 20-byte IPv4 header (IPv6 is 40 bytes)
- Multicast checks use only IPv4 range `224.0.0.0/4` — IPv6 `ff00::/8` unchecked
- 4-level nesting: `Map<string, {fragments[], timer, created}>` — hard to mock/test

---

### 3.8 Protocol Error Handling (MEDIUM)

| Gap | Engine | Impact |
|-----|--------|--------|
| Invalid Router ID (0.0.0.0) accepted | OSPF | Silent misconfiguration |
| No network/mask validation | OSPF | Invalid area configurations |
| Silent failures on unknown transforms | IPSec | Negotiation failure without diagnostics |
| No fragment offset ordering validation | IPSec | Corrupted reassembled packets |
| No pool address validation (e.g. 192.168.1.256) | DHCP | Runtime errors |
| Missing `processDiscover()` null logging | DHCP | Silent allocation failures |

---

### 3.9 Protocol Testability (MEDIUM)

| Concern | Impact |
|---------|--------|
| OSPF FSM embedded in 3,247-line class | Can't test state transitions in isolation |
| OSPF uses `setTimeout`/`setInterval` directly | No clock injection; flaky timing tests |
| IPSec SA databases use complex nested Maps | Hard to mock/verify |
| IPSec key material is simulated random hex | Can't verify enc/dec correctness |
| DHCP uses `Date.now()` for lease timing | Can't mock time in tests |
| No constructor injection for OSPF/IPSec callbacks | Tests must use `setSendCallback()` |

---

## 4. Filesystem & Database Layer

### 4.1 Filesystem Stub (CRITICAL — Non-Functional)

`src/terminal/filesystem.ts` (100 lines) is a **non-functional stub**:

```typescript
// Line 1: "STUB FILE - will be rebuilt with TDD"
readFile(path: string): string { return `STUB: File content for ${path}`; }
writeFile(path: string, content: string): void { /* no-op */ }
exists(path: string): boolean { return true; }  // ALWAYS returns true
```

**Issues:**
- All methods return hardcoded lies (`exists()` always `true`)
- No actual in-memory filesystem implementation
- No `FileSystemNode` interface for traversal
- No `FileSystemError` exception type
- No permission/access control layer
- Tests cannot be written against a stub

**This is the lowest-quality file in the codebase.** It requires a complete implementation, not incremental fixes.

---

### 4.2 Oracle Hardcoded Configuration (HIGH — DRY)

`src/terminal/commands/database.ts` (215 lines) contains 47+ hardcoded Oracle paths:

```typescript
// Scattered throughout lines 110-214:
'/u01/app/oracle'          // 20+ occurrences across files
'19c'                      // Oracle version: 5+ occurrences
'ORCL'                     // SID: 10+ occurrences
'1521'                     // Port: 8+ occurrences
```

**Also in `OracleCommands.ts` (172 lines):**
- Duplicate copyright/version banners (lines 28-32 & 140-144)
- TNS/Oracle paths appear 15+ times
- Error codes (`TNS-12541`, `TNS-12560`) without constants
- 6 switch cases with nearly identical `addLine` sequences

**Recommendation:** Extract to `OracleConfig` constant object:

```typescript
export const ORACLE_CONFIG = {
  HOME: '/u01/app/oracle/product/19c/dbhome_1',
  BASE: '/u01/app/oracle',
  VERSION: '19c',
  SID: 'ORCL',
  PORT: 1521,
} as const;
```

---

### 4.3 Database Module-Scoped State (HIGH — Testability)

`database.ts` uses a module-scoped `Map` for Oracle instances:

```typescript
const oracleInstances: Map<string, OracleDatabase> = new Map();
```

**Issues:**
- Not injectable or mockable — prevents test isolation
- Global singleton pattern without reset mechanism
- SQL*Plus argument parsing (lines 46-85) uses fragile index-based access

---

### 4.4 OracleExecutor Monolith (MEDIUM — SRP)

`OracleExecutor.ts` (1,875 lines) dispatches 25+ statement types via a single `execute()` method:

| Statement Type | Example |
|---------------|---------|
| SELECT | `executeSelect()` |
| INSERT | `executeInsert()` |
| UPDATE | `executeUpdate()` |
| DELETE | `executeDelete()` |
| CREATE TABLE | `executeCreateTable()` |
| ALTER TABLE | `executeAlterTable()` |
| ... | 19 more statement types |

**Recommendation:** Strategy pattern — each statement type has its own executor class:

```typescript
interface IStatementExecutor<T extends ASTNode> {
  execute(stmt: T, context: ExecutionContext): ExecutionResult;
}
```

---

### 4.5 LinuxTerminalSession Command Routing (MEDIUM — SRP)

`LinuxTerminalSession.ts` (428 lines) `executeCommand()` method (lines 157-246) is a 90-line monolith:

```typescript
// Lines 157-246: single method handles:
// - 'exit' → session close
// - 'nano'/'vi'/'vim' → editor overlay
// - 'sqlplus' → Oracle subshell
// - 'lsnrctl'/'tnsping' → Oracle CLI tools
// - 'sudo' → interactive flow
// - default → device.executeCommand()
```

**Issues:**
- Tight coupling to Oracle (hardcoded command names)
- No command dispatcher/registry pattern
- Special-case for `sudo sqlplus` duplicates flow setup with metadata patching
- Sub-shell key handler is specific to this session type

---

### 4.6 DemoSchemas Hardcoding (MEDIUM)

`DemoSchemas.ts` (276 lines) defines HR, SCOTT, DEPT, EMP schemas as inline DDL strings. Schema definitions should be data-driven (arrays of table/column specs) to enable:
- Validation at build time
- Schema introspection for tests
- Easier extension with new demo schemas

---

### 4.7 Error Code Catalog (MEDIUM)

Oracle error codes are scattered as magic strings:

| Code | Location | Count |
|------|----------|-------|
| `ORA-01034` | OracleInstance.ts, SQLPlusSession.ts | 3 |
| `ORA-01017` | OracleCatalog.ts | 2 |
| `TNS-12541` | OracleCommands.ts | 2 |
| `TNS-12560` | OracleCommands.ts | 1 |
| `ORA-00942` | OracleExecutor.ts | 2 |

**Recommendation:** Centralize in `OracleErrorCodes.ts` constant map.

---

### 4.8 Database Parser Quality (LOW — Positive)

The database engine layer (`src/database/engine/`) is **well-designed**:

| Component | Lines | Grade | Notes |
|-----------|-------|-------|-------|
| `BaseParser.ts` | 1,509 | A | LL(1) parser with error recovery |
| `ASTNode.ts` | 616 | A | 30+ comprehensive AST interfaces |
| `BaseLexer.ts` | 414 | A- | Good token handling |
| `BaseStorage.ts` | 268 | A | Extensible table/index storage |
| `BaseCatalog.ts` | 170 | A- | Abstract privilege system |

**Minor TODO:** Window frame support (ROWS/RANGE) not yet implemented (BaseParser line 1359).

---

### 4.9 Session Layer Quality (LOW — Positive)

The terminal session base class (`TerminalSession.ts`, 897 lines) is **well-architected**:
- Clean observable pattern (version-based subscribers)
- Template method pattern (abstract `onEnter()`, `onTab()`, `getPrompt()`)
- Proper error classes (`CommandTimeoutError`, `DeviceOfflineError`)
- Good constant management (`MAX_SCROLLBACK_LINES`, `DEFAULT_COMMAND_TIMEOUT_MS`)

Only minor issue: `InputMode` discriminated union with 7 variants has switch cases scattered across methods.

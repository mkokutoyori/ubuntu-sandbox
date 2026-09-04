# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## What This Is

A browser-based network simulator (Ubuntu Sandbox) built with React + TypeScript. Users drag-and-drop network devices (routers, switches, PCs, servers) onto a canvas, cable them together, and interact via in-browser terminal emulators that simulate Cisco IOS, Huawei VRP, Linux bash, Windows cmd/PowerShell, and Oracle SQL*Plus. The simulation runs entirely client-side — protocols (OSPF, BGP, EIGRP, STP, DHCP, IPSec, TLS, DNS…), shells, and the Oracle database engine are all reimplemented from scratch in TypeScript.

## Commands

```bash
npm run dev              # Dev server on port 8080
npm run typecheck        # TypeScript check — the ONLY command that checks anything
npm run build            # Production build
npm run lint             # ESLint (flat config)
npm run test:run         # Vitest single run
npx vitest run src/__tests__/unit/network-v2/ospf.test.ts   # One test file
npm run test:e2e         # Playwright e2e (spins up dev server on :8080)
```

**`tsc --noEmit -p tsconfig.json` checks NOTHING.** The root `tsconfig.json` is solution-style (`"files": []` plus `references`), so pointing `tsc` at it succeeds having compiled zero files. Use `npm run typecheck` (`tsconfig.app.json`). The repo carries a standing backlog of type errors, almost all in tests; the rule is not "zero errors" but **no more than before your change** — count with `npm run typecheck 2>&1 | grep -c "error TS"` on your branch and on its base.

Full sweeps are slow (`network-v2` is ~1900 files / ~31000 tests, ~55 min). Redirect to a log and poll; never edit source or `git stash` while a sweep is running — vitest loads modules lazily, so a mid-run edit poisons the result.

## Rules

These are the rules. Everything else in this file is a map.

### 1. Reuse — never re-implement, never develop in a silo

**Search the repository BEFORE writing anything.** It applies to every layer: a protocol, an engine, a codec, a renderer, a value object, a parser, a lookup. Grep for what already answers the question; if something does, DELEGATE to it, even when writing a fresh one would be shorter. Two implementations of one question are two answers that eventually disagree, and this repository's history is largely the cost of that: two Windows registries, two SSH stacks, two `service timestamps` parsers, two NQA engines, three ACL grammars.

**Le projet est vaste, et le protocole que vous croyez manquant est presque toujours deja implante ailleurs.** Avant d'ecrire le moindre comportement protocolaire, cherchez le SOUS-SYSTEME qui le porte et branchez-vous dessus ; une mini-version ecrite a cote « pour cette plateforme-ci » est exactement la duplication que ce depot passe son temps a refermer. **Le DNS est l'exemple a retenir** : `src/network/dns/` porte le codec de fil, le resolveur recursif et son cache (`resolver/DnsCache.ts` — cache NEGATIF de la RFC 2308 et DECROISSANCE du TTL a la lecture), les zones, DNSSEC, TSIG, le transfert, la mise a jour dynamique, mDNS/LLMNR et DNS-SD. La regle vaut pour tout le reste : pile TCP, client HTTP, couche TLS, table de routage, cache de voisinage, moteur de sonde active, analyseur d'ACL existent DEJA. La question n'est jamais « comment l'ecrire ? » mais « qui le porte, et quel port etroit dois-je extraire pour l'atteindre depuis ma plateforme ? ».

**Si le sous-systeme existe mais qu'il est LIMITE, on l'AMELIORE la ou il vit** — on l'etend, on lui ajoute l'etat ou le message qui manque — plutot que de contourner sa limite par une copie locale ; la correction profite alors a tous ses lecteurs au lieu d'un seul.

Three traps break this rule in good faith. **A partial reuse is still a duplication** (reusing a codec and hand-writing the lookup on top of it). **A different caller is not a reason to fork** — when the existing implementation is bound to a class you cannot extend, extract a narrow port and let both callers share it. **The duplicate is usually the more permissive one**, because the fresh copy only implements the cases its author had in mind; that is why de-duplicating keeps closing real defects rather than merely shortening files. When reuse is genuinely impossible, say in the commit message which existing thing you looked at and why it could not serve.

### 2. A duplicate is a defect, and closing it is part of the task

When you meet the same fact written twice — two parsers for one grammar, two stores for one setting, two renderers for one view, two tables of the same constants — remove one **in the same change**. Two writings of one fact do not stay equal: they diverge, and then the machine answers two different things to the same question with nothing to say which is right. Delete the duplicate rather than keep it in sync; a comment asking the reader to update both is not a fix. If a duplicate genuinely cannot be closed in that change, say so in the commit message and open a `TODO.md` entry naming both sites — never leave it silent.

### 3. Coherence between views — PS vs cmd, and every other pair

A machine has ONE registry, ONE event log, ONE neighbour table, ONE DNS cache, ONE service table. `reg`/`netsh`/`ipconfig`/`arp` (cmd) and the cmdlets (PowerShell) are two *interfaces* over one store, never two implementations. The same holds for `show` vs `display`, a CLI view vs its running-config, a MIB vs the CLI that configures it. Two views that can contradict each other about the same fact, on the same machine at the same instant, is the defect this repository most often finds and closes.

### 4. Real frames on the wire

**Anything sent between two machines MUST cross the simulated network as real frames.** A command, a file, a login, a query, a reply: if two devices exchange it, it goes through `Port`/`Cable`/`TcpStack` and is countable on the wire. Reaching for the peer's object and calling a method on it (`remote.executeCommand(...)`, `device.fs`, a registry lookup returning the far-side instance) is the one shortcut this project does not accept, however correct the answer looks. Two consequences, both of which have caught real defects: the shortcut hides privilege and policy (`ssh alice@host whoami` answered `root` while the command ran in memory); and a test must count the RIGHT frames — measure the DIFFERENCE between the same exchange with and without the payload, since a real login preceding an unreal command still puts frames on the wire.

### 5. A domain value is a TYPE, never a primitive

An IP address is an `IPAddress`, a transport port a `PortNumber` (`core/ports/PortNumber.ts`, RFC 6335), a MAC a `MACAddress`, a mask a `SubnetMask` — in every signature, not merely in storage. `^\d+\.\d+\.\d+\.\d+$` also accepts `999.999.999.999`; the value object parses once, fails fast, and makes the invalid state unrepresentable. **Parse at the boundary**: the place that reads a CLI argument, a config line or a wire field converts, so everything downstream receives a value already known good. APIs still taking primitives are legacy — keep them compiling by parsing and delegating, and write anything NEW against the types. Search for an existing value object before writing one.

### 6. Never store a criterion you do not evaluate

If the CLI accepts a keyword, either the engine enforces it or the parser refuses it (`% Invalid input detected at '^' marker.`, or the platform's own wording). Parsing a criterion, rendering it back in `show`/`running-config`, and ignoring it at evaluation time is the worst of the three: it has every appearance of existing except the effect. A criterion the simulator cannot evaluate is REFUSED **naming the brick that is missing**, and written into `TODO.md`.

Two nuances measured the hard way. A command that a real machine ACCEPTS but this engine cannot honour may be stored and rendered rather than refused — otherwise a topology import silently loses configuration the real box keeps; say so explicitly and record it. And **security criteria fail CLOSED**: in any matching engine (ACL, VACL, route policy, firewall rule) a criterion the engine cannot decide makes the entry NOT match. Skipping it silently makes the entry more permissive than what the operator wrote.

### 7. Measure before you change, and discriminate your probe

Type the command, read the state back, record the gap — then fix. A long-standing red test is not proof of a defect: it may encode a false premise, and "fixing" the engine to satisfy it makes the simulator wrong. Every fix ships a probe test discriminated with `git stash`: state in the probe's header how many cases fall before the fix, and NAME the ones that pass either way with the reason (witness, non-regression, structural). A probe made only of refusals proves nothing — keep a WITNESS built in the same lab that proves the lab itself is sound. Never pin an existing defect as a contract: when a test encodes the bug, fix the test and say so.

### 8. Choose the authority BEFORE citing it

A RFC is not automatically the reference. What governs is the **officially adopted standard** and, failing that, the **vendor's documentation**; a captured transcript beats both when they diverge, because that is what a learner compares their own output against. Three cases, and confusing them invokes a text that does not apply: an adopted open standard is cited (VRRP RFC 5798, PIM-SM RFC 7761, IANA assignments); a PROPRIETARY protocol is not cited by RFC — HSRP is Cisco's and RFC 2281 is INFORMATIVE and v1-only, GLBP has no RFC at all, so the authority is Cisco's documentation. When the source cannot be reached, say so and do not implement rather than guess. Documentation HTML collapses whitespace, so for column layouts use captured text (e.g. `ntc-templates`), not doc examples.

### 9. Do not write comments — absolute

No inline `//`, no new `/** */`, no file headers, no section banners, no `// ─── … ───` separators, in any language, in production code and tests alike. Zero new comment lines per diff. Say it with the name instead. **The reasoning, the measurement, the defect found and the limit accepted go in the COMMIT MESSAGE and in the PRD — never in the source file.** The one established exception is a probe/test file's own header, which states what was measured and how the probe discriminates. Existing comments stay; do not add to them, and delete one whose behaviour you changed. The abundant commentary in older files is legacy, not a house style to imitate.

### 10. Code is written in English

Identifiers, types, functions, constants, locals, test names: English, without exception. Some older code carries French identifiers; that is legacy, not a pattern to extend. Do not rename it wholesale — leave it and write English in anything you add or touch.

## Architecture

**Path alias:** `@/` maps to `src/`.

### `src/network/` — the simulation

Equipment-driven: no central mediator. Devices process and forward frames themselves, peer-to-peer over cabled ports.

- `equipment/` — `Equipment` base class + static `EquipmentRegistry`; `HostCapabilities`/`RouterServiceCapabilities` are segregated optional-capability interfaces with accessor functions (`getManagementService(dev)`, …). Prefer extending these over a fresh inline `dev as unknown as { … }` cast. `TopologyWalk.resolveAcrossTransparentDevices` walks through switches/hubs at arbitrary depth.
- `hardware/` — `Port`, `Cable`, `PortSecurity`. A `Port` names four independent notions, each deciding one thing: **`loopback`** (MTU ceiling), **`carrierless`** (reported state — `UNKNOWN`, `NOARP`), **`socketless`** (whether a cable can be plugged; `acceptsCable()` is the single predicate, read by `Cable.connect`, the store and the UI selector), and `alias` (the connection name, which on Windows renames the connection without renaming the device). `Cable` carries `packetLossRate`/`corruptionRate`.
- `core/` — `types.ts` (frame/packet structures, `IPAddress`, `IPv6Address`, `MACAddress`, `SubnetMask`, checksums), `Logger`, `RoutingTable`, `SocketTable`, `TcpConnection`, `FilterChain`, `NeighborResolver`, `WellKnownPorts`, `ports/PortNumber`, `Ipv4Fragmentation`, `IcmpErrors` (`mayGenerateICMPError`, RFC 1122 §3.2.2), `icmpUnreachable`.
- `layers/` — the TCP/IP model (`docs/BRD-Modele-TCP-IP.md`). `link/LinkLayer` (destination classification, reception, emission), `internet/` (`decrementForForwarding` — the single TTL rule; `classifyIpv4Destination`; `ipv4HeaderProblem`; `Ipv4Egress.sendIpv4Packet`; `Ipv6Egress` source selection per RFC 6724), `transport/` (`L4Checksum`, `UdpChecksum`, `EphemeralPorts`, `UdpPortTable`). **New protocol code descends through these rather than writing a frame by hand.**
- `devices/` — concrete devices (`LinuxPC`, `WindowsPC`, `LinuxServer`, `CiscoRouter`, `HuaweiRouter`, `CiscoSwitch`, `HuaweiSwitch`, `GenericSwitch`, `Hub`, `Router`, `Switch`, `EndHost`), built via `DeviceFactory.createDevice(type)`. Subtrees: `router/` (ACL, NAT, IPv6 data plane, dynamic routing, AAA, BFD, DNS, EEM, NetFlow, NHRP, HSRP/VRRP/GLBP, policy, QoS, management, CLI), `firewall/` (`Firewall` + `FortiGate`/`AsaFirewall`, siblings of `Router`), `linux/` (ARP, DNS, cron, iptables, ip/net commands, processes, logging, IAM, kernel modules, http servers), `windows/` (registry, event log, services, netsh, firewall rules, NetAdapter/NetRoute/NetIPAddress/NetTCPIP modules), `host/`, `os/`, `inspection/`, `shells/` (`CiscoIOSShell`, `HuaweiVRPShell`, `CiscoSwitchShell`, `HuaweiSwitchShell`, `CommandTrie`, `cli/TextTable`).
- **Protocol engines**, one directory each — routing (`ospf/`, `bgp/`, `eigrp/`, `rip/`, `routing/`, `nat/`), addressing (`arp/`, `dhcp/`, `dhcpv6/`, `icmp/`), L2 (`stp/`, `lacp/`, `dtp/`, `vtp/`, `cdp/`, `lldp/`, `udld/`, `dot1x/`), redundancy (`fhrp/`, `hsrp/`, `vrrp/`, `glbp/`, `bfd/`), multicast (`igmp/`, `igmp-snooping/`, `pim/`, `pim-snooping/`), tunnels (`gre/`, `vxlan/`, `nhrp/`, `ipsec/`), management (`snmp/`, `syslog/`, `netflow/`, `ntp/`, `radius/`, `tacacs/`, `kerberos/`, `ipsla/`, `nqa/`), transport/app (`tcp/`, `quic/`, `ftp/`, `tftp/`, `smtp/`, `scan/`, `qos/`, `faults/`), and `protocols/ssh/` + `protocols/telnet/`. Reactive ones follow `<Protocol>Engine.ts` + `types.ts` + `events.ts` + `observables.ts` + `actors/` on `src/events/` primitives — follow that shape when adding one.
- `dns/` (+ `mdns/`, `llmnr/`, `dnssd/`) — wire codec, recursive resolver + `DnsCache` (RFC 2308 negative caching, TTL decay), zones, DNSSEC, TSIG, transfer, dynamic update, multicast transport. **The one DNS implementation.**
- `tls/` + `src/crypto/` (cipher, dh, ecc, hash, kdf, mac, rsa, passwords) — real HKDF-SHA256, AES-128-GCM record protection, X25519, RSA PKCS#1 v1.5, ECDSA/ECDH P-256, all checked against published test vectors. `IMPLEMENTED_GROUPS` declares which TLS groups are real; the rest are neither offered nor selected. Nothing is constant-time; PEM is armoured JSON, not DER, so nothing interoperates with a real openssl. `network/crypto/openssl/` is the `openssl` command; `pki/` holds certificates and PEM.
- `http/` — `Http1ServerSession`/`Http1ClientSession`, `curl/` (one engine, both platforms), `nginx`/`apache` service files under `devices/linux/http/`.

### Other top-level areas

- `src/bash/`, `src/powershell/` — hand-rolled interpreters (lexer/parser/interpreter/runtime; PowerShell adds `providers/` and `cmdlets/`). `src/cli/` — the command **socle** (see below).
- `src/shell/` — vendor-agnostic shell layer (`IShell`, `AbstractShell`, `ShellFactory`, `CrossVendorRemoteShell`, `sshLauncher`).
- `src/terminal/` — terminal emulation: `commands/`, `core/`, `flows/`, `intent/`, `subshells/` (SQL*Plus, RMAN, SFTP, cmd, PowerShell, telnet, remote device), `sessions/`.
- `src/database/` — `engine/` (vendor-agnostic SQL scaffolding) and `oracle/` (lexer/parser/executor/catalog/storage + ASM, AWR, Data Guard, flashback, locks, multitenant, plans, packages).
- `src/events/` — `EventBus`, `Scheduler`, `Signal`, `TimerSet`, `waitForEvent`. **A bus is PER MACHINE** (`Equipment.getBus()`); a test that subscribes to the default global bus observes nothing, and `expect(x).toEqual([])` then passes vacuously — always carry a witness proving something was emitted.
- `src/store/` — one Zustand store (`networkStore.ts`) holding devices, connections and UI state; `topologySerializer.ts` for save/load. `clearAll` empties the canvas AND resets the MAC/name generators; `replaceTopology` (Open/Import) does not — resetting them after an import hands a freshly-added device an address another device already holds.
- `src/components/` — `network/` (canvas, palette, connection lines, properties panel, terminal modal, logs), `terminal/`, `editors/`, `ui/` (shadcn/Radix), `pages/`.
- `src/adapters/` — bridges between subsystems (e.g. Oracle ↔ filesystem/systemd).

### Tests

- `src/__tests__/unit/network-v2/` — the bulk (protocol + device). Other subsystems under `unit/database/`, `unit/powershell/`, `unit/bash/`, `unit/shell/`, `unit/terminal/`, `unit/react/`, `unit/gui/`.
- `src/__tests__/debug/` — long "transcript dump" suites (`*.debug.test.ts`) for gap analysis, not assertions. Read the `_*-suite.ts` helpers to see how labs are built.
- `e2e/` — Playwright against the real UI on :8080.
- Vitest env is `node`, globals on. `setupFiles: ['./src/__tests__/setupGlobalState.ts']` resets `EquipmentRegistry`, device-name/MAC counters, `Logger` and the default `EventBus`/`Scheduler` before every test. Subsystem singletons (Oracle instances, PKI CA registry, forests…) remain each file's own responsibility.

## Declaring a command — the socle, not the trie

**Every NEW command is declared on the socle** (`src/cli/`), as a `CommandSpec`, in a family under `src/cli/commands/<family>/`. `CommandTrie` is the old engine: it still carries most of the vocabulary and migration is incremental, but nothing new is added to it.

```ts
export function myFamily(): CommandSpec[] {
  return [{
    id: 'ip-address-dhcp',
    path: ['ip', 'address', 'dhcp'],
    description: 'IP Address negotiated via DHCP',
    modes: ['config-if', 'config-subif'], minPrivilege: 15,
    run: (session, args) => { … },
  }];
}
```

What the socle gives that the trie does not: one tree built once (the vocabulary belongs to the PLATFORM; the session carries only mode, privilege and view); abbreviation and ambiguity through one mechanism; a **typed and parsed** argument, so `ip address zorglub` is refused rather than accepted; an async handler; and a duplicate declaration refused instead of silently overwriting. Wire the family into `socleSpecs()` of the shell concerned. `session.device` is the SHELL — declare what the family needs as a narrow interface and let the shell delegate to the equipment.

A **sub-mode gate** (`interface`, `line`, `vlan`, `router ospf`) is declared for every mode it can be typed from, because IOS lets you move between interfaces without `exit`. Four traps, each measured: the same command written once per mode diverges; an `alternatives` place loses the trie's `leadingOnly`, so a declared FORM outranks the live values that would extend it; a type without its number fills a free place, so `?` announces `<cr>` for a refusal — each type is a keyword with its place REQUIRED; and the socle admits a `config` command from a sub-mode by INHERITANCE, which re-opens parser-view confinement (`confinerSousVue` closes it for both engines).

Related invariants the help/completion campaign established: **an announced range is an applied range** (a numeric token outside a `<min-max>` the help displays is refused; `rangeIsAdvisory` marks a declaration that describes without deciding, e.g. when the bound depends on state); **`?` and `Tab` answer the same question** through one predicate, so a view or privilege level cannot filter one and not the other; every word `?` offers must execute (`% Incomplete command.` is a good answer, `% Invalid input` is not) and must carry a description; and continuations are **declared** (`cisco/ciscoContinuations.ts`), never scraped from handler source.

**The VRP shells have no bridge to the socle yet** — recorded in `TODO.md`. Until it exists, a VRP command is declared on its trie.

## TODO — the register of gaps

`TODO.md` (root) holds MEASURED, unclosed gaps. The rule: a gap found along the way is either **implemented** or **written into `TODO.md`** — never left in a commit message alone, where nobody will find it. An entry says what is broken, how it was seen, and why it is not closed. Closing one means deleting the entry and telling the story in the commit message.

## Known limits — do not build labs on these

Each of these is measured and deliberate; a lab that assumes otherwise fails silently.

- **Cisco/Huawei GRE has no data plane.** `tunnel source`/`destination` populate display and OSPF-matching metadata only; nothing is encapsulated or forwarded. OSPF over such a tunnel is seeded out-of-band. Linux `ip tunnel` GRE *is* real.
- **EIGRP has no Active state, no Query/Reply, no RTP and no timers.** Convergence is triggered by CLI commands and link events. Query/SIA counters are permanently zero and that is the true count.
- **OSPF convergence completes before the triggering command returns** (`autoConverge` pumps the whole reachable domain synchronously). Do not expect to observe ExStart/Exchange/Loading.
- **`Router` has a RIB but no FIB and no recursive next-hop resolution.** A static route whose next hop is off-link, or loopback-to-loopback iBGP, is accepted and never forwards.
- **Oracle PDBs share one schema namespace** — `ALTER SESSION SET CONTAINER` swaps a label only. Data Guard `switchover()` swaps two role fields; there is no redo transport.
- **Oracle row/table locks fail fast rather than block** (`ORA-00054`/`ORA-30006`): the executor call chain is synchronous, so a real wait queue is not expressible.
- **`GenericSwitch` runs no protocol agents** (no DTP, VTP, STP, LACP, UDLD, IGMP snooping). Commands needing them are refused in IOS's own words; commands derivable from local configuration work.
- **`firewall-paloalto` is a `LinuxPC`** — no PAN-OS CLI. The palette discloses this with a "Limited simulation" badge via `isFullyImplemented()`.
- **Frame delivery is synchronous, so RTT is 0 ms in virtual time.** No topology can cross an IP SLA / NQA latency threshold by itself.
- **The iptables NAT engine has no reply-leg conntrack.** A DNAT'd TCP connection through a Linux host reaches "SYN delivered to the right port", not a completed handshake; UDP round-trips.
- **The interactive-terminal SSH forwarders (`-L`/`-R`/`-D`) relay nothing.** The `executeCommand`/`LinuxSshClient` path does relay `-L`/`-R` for real. The two SSH stacks do not interoperate.
- **Windows default firewall posture is accept-when-no-rule-matches**, where a real Windows blocks inbound by default; there is no active-profile model yet.

## Docs

PRDs, BRDs, design docs, gap analyses, tutorials and roadmaps live at the repo root and under `docs/`. Consult them for the rationale behind a subsystem before refactoring it — and note `docs/roadmap.md` is stale.

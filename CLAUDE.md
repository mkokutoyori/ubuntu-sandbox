# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A browser-based network simulator (Ubuntu Sandbox) built with React + TypeScript. Users drag-and-drop network devices (routers, switches, PCs, servers) onto a canvas, cable them together, and interact via in-browser terminal emulators that simulate Cisco IOS, Huawei VRP, Linux bash, Windows cmd/PowerShell, and Oracle SQL*Plus. The simulation runs entirely client-side — protocols (OSPF, BGP, EIGRP, STP, DHCP, IPSec, etc.), shells, and the Oracle database engine are all reimplemented from scratch in TypeScript.

## Commands

```bash
npm run dev              # Start dev server on port 8080
npm run build            # Production build
npm run lint             # ESLint (flat config)
npm run test             # Vitest in watch mode
npm run test:run         # Vitest single run (CI)
npm run test:coverage    # Vitest with coverage (v8)
npx vitest run src/__tests__/unit/network-v2/ospf.test.ts   # Run a single test file
npm run test:e2e         # Playwright e2e tests (spins up dev server on :8080)
npm run test:e2e:ui      # Playwright with UI mode
```

## Architecture

**Path alias:** `@/` maps to `src/`.

### Network simulation layer (`src/network/`)

Equipment-driven architecture — no central simulator mediator. Devices process and forward frames themselves, peer-to-peer over cabled ports.

- `equipment/Equipment.ts` — abstract base class for all devices; maintains a static `EquipmentRegistry` for topology traversal. Subclasses implement `handleFrame()`.
- `equipment/HostCapabilities.ts` / `equipment/RouterServiceCapabilities.ts` — segregated optional-capability interfaces + accessor functions (`isCredentialAuthenticator(dev)`, `getManagementService(dev)`, `getHsrpAgent(dev)`, …) for reaching a concrete device's methods from code typed against a narrower shared interface (`CiscoDevice`, `ICLIDevice`, raw `Equipment`). Prefer extending these over a fresh inline `dev as unknown as { getXxx?: () => Yyy }` at the call site (rapport 08 audit: reduce unencapsulated casts).
- `hardware/Port.ts`, `hardware/Cable.ts`, `hardware/PortSecurity.ts` — physical layer; Cables connect Ports for direct device-to-device frame delivery.
- `core/types.ts` — frame/packet structures (`EthernetFrame`, `IPv4Packet`, `ARPPacket`, `ICMPPacket`, `UDPPacket`, `RIPPacket`), address types (`MACAddress`, `IPAddress`, `SubnetMask`), protocol constants, ID/checksum helpers.
- `core/` also holds shared infra: `Logger.ts` (pub/sub network event log), `RoutingTable.ts`, `PacketQueue.ts`, `SocketTable.ts`, `TcpConnection.ts`, `FilterChain.ts`, `NeighborResolver.ts`, `WellKnownPorts.ts`, `Ipv4Fragmentation.ts` (RFC 791 §3.2 `fragmentIPv4`/`IPv4Reassembler` — used by `Router.forwardPacket` and `EndHost.forwardIPv4` when a datagram crosses onto a smaller-MTU link with DF clear; DF=1 still gets ICMP Fragmentation Needed instead).
- UDP checksum (RFC 768) — `computeUdpChecksum`/`verifyUdpChecksum` live in `tcp/types.ts` (shared L4-checksum module with TCP's `computeTcpChecksum`, despite the filename). `EndHost.sendUdpDatagram` stamps a real checksum; `EndHost.deliverUDP` and `Router`'s self-destined UDP dispatch verify and silently drop a mismatch. Internal protocol agents (RIP, DHCP, IKE, SNMP, …) still build `UDPPacket`s with `checksum: 0` — that's RFC 768's IPv4 "not computed" opt-out and is accepted unconditionally, same as those agents' payloads not being real serialized bytes in the first place.
- `devices/` — concrete device classes (`LinuxPC`, `WindowsPC`, `LinuxServer`, `CiscoRouter`, `HuaweiRouter`, `CiscoSwitch`, `HuaweiSwitch`, `GenericSwitch`, `Hub`, `Router`, `Switch`, `EndHost`). Instantiated via `DeviceFactory.createDevice(type)` (see `core/types.ts` for the `DeviceType` union — note some types like `firewall-*` are currently stubbed as `LinuxPC`).
  - `devices/router/` — router subsystems: ACL, NAT, IPv6 data plane, dynamic routing (OSPF/RIP integration), AAA, BFD, DNS, EEM, NetFlow, NHRP, redundancy (HSRP/VRRP/GLBP), policy, management, CLI.
  - `devices/host/` — end-host actors/lifecycle/identity/hardware (shared by Linux/Windows hosts).
  - `devices/linux/` — Linux subsystem services: ARP, DNS, cron, firewall/iptables, IP/net commands, process management, logging, scripting.
  - `devices/windows/` — Windows/PowerShell subsystem services: registry, event log, services, pipelines, port-proxy, cmdlets.
  - `devices/os/` — cross-platform OS abstractions (`OSProcess`, `OSService`, `OSServiceOrchestrator`, `OSFeatureGate`).
  - `devices/inspection/` — `DeviceStateView` / `EquipmentStateView` for introspecting live device state (used by debug tooling and tests).
  - `devices/shells/` — CLI shell implementations (`CiscoIOSShell`, `HuaweiVRPShell`, `CiscoSwitchShell`, `HuaweiSwitchShell`, `CLIStateMachine`, `CommandTrie`, `PromptBuilder`) implementing `IRouterShell`/`ISwitchShell`.
- **Protocol engines** — each protocol has its own top-level directory with engine, types, events/observables, and (for reactive ones) `actors/`: `ospf/`, `bgp/`, `eigrp/`, `rip/`, `routing/`, `dhcp/`, `ipsec/`, `acl/`, `arp/`, `bfd/`, `cdp/`, `dot1x/`, `dtp/`, `glbp/`, `gre/`, `hsrp/`, `igmp/`, `igmp-snooping/`, `lacp/`, `lldp/`, `netflow/`, `ntp/`, `pim/`, `radius/`, `snmp/`, `stp/`, `syslog/`, `tacacs/`, `tcp/`, `udld/`, `vrrp/`, `vtp/`, `vxlan/`. SSH/SCP/SFTP lives under `protocols/ssh/`.
  - `ospf/OSPFEngine.ts`'s Hello/dead-interval/LSA-aging/LSA-refresh timers and the SPF throttle (RFC 2328 §16.5 exponential back-off) are real, independent `src/events/Scheduler` timers, and neighbor FSMs only advance via genuine `processHello`/`processDD` packet handling — frames are real. But `RouterOSPFIntegration.autoConverge()`/`driveWireConvergence()` (called after nearly every OSPF CLI command, including `show ip route` itself, and on link-up) does a static-registry BFS across the whole reachable domain and synchronously pumps Hellos/DD retransmissions and force-accelerates DR election for every router in one call — a convenience layer, not a bug, but it means convergence always completes before the triggering command returns rather than progressing visibly through ExStart/Exchange/Loading like real IOS. Don't build labs that expect to observe those transient neighbor states under normal CLI use. `RoutingTableSyncActor.onRoutes()` (wired in `enableOSPF()`) is what makes the one case that *isn't* CLI-driven — a dead-interval timeout or other autonomous SPF trigger with no command run afterward — still reach the RIB. Related, larger, and still open: `collectOSPFDomain`/`collectOSPFv3Domain` only traverse one hop of switch fan-out, so two routers separated by a switch chain (SW1—SW2) never converge with each other at all, even though real multicast Hellos would reach across switches.
  - `gre/GreAgent.ts` does real GRE encapsulation/decapsulation (genuine header + outer IPv4 packet over proto 47, verified end-to-end over a real cable), but it is only wired up for Linux's `ip tunnel` command (`Ip.ts`) — Cisco/Huawei's `tunnel source`/`tunnel destination` CLI (`CiscoOspfCommands.ts`) only populates display/OSPF-matching metadata and never calls `greAgent.addTunnel()`, and `Router.forwardPacket()` has no GRE awareness at all, so a route pointing at `Tunnel0` on a Cisco/Huawei router never actually gets encapsulated or transits anywhere. `RouterOSPFIntegration.formAdjacency()` (called for `Tunnel*` ports matched by IP against `tunnel destination`) papers over this by seeding both sides' OSPF neighbor tables directly — "no frame transport on virtual ports yet" per the comment at the call site — instead of exchanging real Hello/DD over the tunnel. This is deliberate, tracked backlog (`docs/roadmap.md` §14.5, "Priorité : Basse"), not an oversight: don't build labs that assume OSPF-over-GRE (or any Cisco/Huawei GRE data-plane forwarding) actually transits the topology.

### Shell interpreters (`src/bash/`, `src/powershell/`)

Full hand-rolled interpreters used to drive Linux and Windows terminals — each has its own `lexer/`, `parser/` (AST), `interpreter/`, `runtime/` (environment, expansion, builtins/cmdlets), and `errors/`. PowerShell additionally has `providers/` (filesystem, registry) and `cmdlets/`. `src/bash/grammar/` contains a Python-based grammar reference (not part of the runtime build).

### Shell abstraction (`src/shell/`)

Vendor-agnostic shell layer: `IShell`/`IShellBase`, `AbstractShell`, `ShellFactory`, `ShellContext`, `CrossVendorRemoteShell` (for SSH between heterogeneous devices), `sshLauncher.ts`, `registerDefaults.ts`.

### Terminal emulation (`src/terminal/`)

- `commands/`, `commands.ts` — command handlers for the simulated shells (including Oracle/SQL*Plus commands).
- `core/` — `InteractiveFlow`, `OutputFormatter`, `TabCompletionHelper`.
- `flows/` — guided command-flow builders per vendor (`CiscoFlowBuilder`, `HuaweiFlowBuilder`, `LinuxFlowBuilder`, `FlowSteps`).
- `intent/` — `IntentRunner`, `TerminalIntent`, `ShellAction`/`ShellActionRegistry`, input prompts/validators — drives multi-step interactive command sequences (e.g. `ssh`, `passwd`).
- `subshells/` — nested shell sessions: `SqlPlusSubShell`, `RmanSubShell`, `SftpSubShell`, `CmdSubShell`, `PowerShellSubShell`, `RemoteDeviceSubShell`/`RemoteShellSubShell`.
- `sessions/` — per-vendor `TerminalSession` implementations and `TerminalManager`.
- `sql/` — Oracle SQL*Plus terminal glue.
- `filesystem.ts`/`shellUtils.ts` — in-memory filesystem and shared shell utilities.
- **Outbound Telnet is a one-shot banner, not an interactive session.** `telnet` on Linux (`LinuxCommandExecutor.runTelnetClient`), Windows (`WindowsPC.cmdTelnet`), and the outbound `telnet` verb on Cisco/Huawei router CLIs (`CiscoShellBase.runOutboundTelnet`, `HuaweiVRPShell.runOutboundTelnet`) all resolve the target over the real cabled topology, check L2/L3 reachability (`isPathReachable`), probe the real `TcpStack` where one exists, and evaluate the remote VTY's real admission policy (ACLs, quiet-mode, `transport input`/`protocol inbound`, unset line password) via `VtyIncomingPolicy`/`vtyAdmissionVerdict` — refusals are genuine, not scripted. But on success they print a static "Connected to …" banner and return; unlike outbound `ssh` (`CLITerminalSession.buildSshInteractiveFlowSteps`, and the Linux/Windows equivalents), no nested `TerminalSession` is pushed, so there is no follow-on interactive shell into the remote device and no username/password prompt even when the line requires one. Don't build labs that expect to actually operate a remote device after `telnet`-ing into it — use `ssh` for that.

### Database simulation (`src/database/`)

- `engine/` — vendor-agnostic SQL engine scaffolding: `lexer/`, `parser/` (AST), `executor/`, `catalog/`, `storage/`, `types/`.
- `oracle/` — Oracle DBMS engine built on the engine layer: `OracleLexer`/`OracleParser`/`OracleExecutor`/`OracleCatalog`/`OracleStorage`/`OracleDatabase`/`OracleInstance`, plus subsystems for `asm/`, `awr/`, `dataguard/`, `flashback/`, `lock/`, `multitenant/`, `plan/`, `metadata/`, `packages/`, `commands/`, `actors/`, `demo/`.
  - `multitenant/` and `dataguard/` are honest state/bookkeeping facades, not physically-isolated engines: `PluggableDatabase` tracks CON_ID/name/open-mode but `OracleStorage` has no CON_ID notion at all — every PDB shares one schema/table namespace, so `ALTER SESSION SET CONTAINER` only swaps the session label (see the comment at `OracleDatabase.ts` around the `ALTER SESSION SET CONTAINER` handler). A "create a table in PDB1, confirm it's absent from PDB2" lab will silently fail. `DataGuardConfiguration.switchover()` likewise just swaps two `role` fields — there is no real redo transport/apply. Don't build pedagogical scenarios that assume real cross-PDB isolation or physical standby replication.

### Event/timing infra (`src/events/`)

`EventBus`, `Scheduler`, `Signal`, `TimerSet`, `waitForEvent` — shared reactive primitives used by protocol actors (OSPF, IPSec, DHCP, BGP, etc.) that model asynchronous, timer-driven behavior.

### Adapters (`src/adapters/`)

Bridges between subsystems, e.g. `OracleFilesystemSync`, `OracleSystemdSync` — keep the Oracle simulation's view of the filesystem/service manager in sync with the host OS simulation.

### State management (`src/store/`)

Single Zustand store (`networkStore.ts`) holds the full topology: devices (`NetworkDeviceUI[]`), connections (`Connection[]`), and UI state. The store bridges `Equipment` instances to React rendering. `topologySerializer.ts` handles save/load of topologies.

### UI (`src/components/`)

- `network/` — canvas, device palette, device icons, connection lines, properties panel, terminal modal, packet animation, logs panel. Entry point: `NetworkDesigner.tsx`.
- `terminal/TerminalView.tsx` — terminal renderer.
- `editors/` — Vim and Nano editor emulation.
- `ui/` — shadcn/ui components (Tailwind + Radix).
- `pages/` — route-level pages (`Index.tsx`, `NotFound.tsx`); routing via `react-router-dom`.

### Tests (`src/__tests__/`, `e2e/`)

- `unit/network-v2/` — the bulk of protocol and device unit tests (250+ files): per-protocol tests (`ospf.test.ts`, `bgp-engine.test.ts`, `cisco-stp.test.ts`, `dhcp_complete.test.ts`, …), bash/awk/grep interpreter tests, cross-vendor SSH suites, etc.
- `unit/database/`, `unit/powershell/`, `unit/bash/`, `unit/shell/`, `unit/terminal/`, `unit/terminal-core/`, `unit/events/`, `unit/react/`, `unit/gui/` — subsystem-specific unit tests.
- `debug/` — large "transcript dump" suites (`*.debug.test.ts`, often 60-400+ steps) that drive a simulated lab through long command sequences and dump the output for gap analysis (e.g. `cisco/`, `huawei/`, `oracle/`, `cmdlets/`, `protocols/`, `rman/`, `router/`). These are diagnostic tools, not assertions-based tests — read the `_*-suite.ts` helpers in each subfolder to understand how labs are built.
- `e2e/` — Playwright specs (`*.spec.ts`) driving the real browser UI (drag-and-drop, SSH between devices, network logs). Config in `playwright.config.ts`; runs against `npm run dev` on port 8080.
- Vitest environment is `node` (configured in `vite.config.ts`); globals enabled. Coverage is currently scoped to `src/network/protocols/ssh/**` with thresholds (lines/functions/statements 85%, branches 75%).

### Docs (`docs/`, root-level `*.md`)

Design/analysis documents accumulate at the repo root and under `docs/`: PRDs and BRDs (`PRD.md`, `BRD-Oracle-DBMS.md`, `BRD-PowerShell.md`, `BRD-SSH-SFTP.md`), design docs (`DESIGN-*.md`), gap analyses (`*_gap.md`, `*-gap-analysis.md`, `evaluation.md`), tutorials (`tutoriel-*.md`, `Lan_tuto.md`, `TUTORIAL.md`), and roadmaps (`roadmap.md`). Consult these for historical context and rationale before large refactors of a subsystem.

## Conventions worth knowing

- Production builds set `esbuild.keepNames: true` and `build.minify: 'esbuild'` because the simulator dispatches on `instance.constructor.name` (e.g. `=== 'WindowsPC'`) to choose vendor-specific behavior — default minification would break this (see comment in `vite.config.ts`).
- Reactive protocol engines (OSPF, IPSec, DHCP, BGP, routing) follow a consistent shape: `<Protocol>Engine.ts` + `types.ts` + `events.ts` + `observables.ts` + `actors/` built on `src/events/` primitives — follow this pattern when adding a new protocol.
- `@typescript-eslint/no-unused-vars` is disabled project-wide in `eslint.config.js`.

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
- `hardware/Port.ts`, `hardware/Cable.ts`, `hardware/PortSecurity.ts` — physical layer; Cables connect Ports for direct device-to-device frame delivery.
- `core/types.ts` — frame/packet structures (`EthernetFrame`, `IPv4Packet`, `ARPPacket`, `ICMPPacket`, `UDPPacket`, `RIPPacket`), address types (`MACAddress`, `IPAddress`, `SubnetMask`), protocol constants, ID/checksum helpers.
- `core/` also holds shared infra: `Logger.ts` (pub/sub network event log), `RoutingTable.ts`, `PacketQueue.ts`, `SocketTable.ts`, `TcpConnection.ts`, `FilterChain.ts`, `NeighborResolver.ts`, `WellKnownPorts.ts`.
- `devices/` — concrete device classes (`LinuxPC`, `WindowsPC`, `LinuxServer`, `CiscoRouter`, `HuaweiRouter`, `CiscoSwitch`, `HuaweiSwitch`, `GenericSwitch`, `Hub`, `Router`, `Switch`, `EndHost`). Instantiated via `DeviceFactory.createDevice(type)` (see `core/types.ts` for the `DeviceType` union — note some types like `firewall-*` are currently stubbed as `LinuxPC`).
  - `devices/router/` — router subsystems: ACL, NAT, IPv6 data plane, dynamic routing (OSPF/RIP integration), AAA, BFD, DNS, EEM, NetFlow, NHRP, redundancy (HSRP/VRRP/GLBP), policy, management, CLI.
  - `devices/host/` — end-host actors/lifecycle/identity/hardware (shared by Linux/Windows hosts).
  - `devices/linux/` — Linux subsystem services: ARP, DNS, cron, firewall/iptables, IP/net commands, process management, logging, scripting.
  - `devices/windows/` — Windows/PowerShell subsystem services: registry, event log, services, pipelines, port-proxy, cmdlets.
  - `devices/os/` — cross-platform OS abstractions (`OSProcess`, `OSService`, `OSServiceOrchestrator`, `OSFeatureGate`).
  - `devices/inspection/` — `DeviceStateView` / `EquipmentStateView` for introspecting live device state (used by debug tooling and tests).
  - `devices/shells/` — CLI shell implementations (`CiscoIOSShell`, `HuaweiVRPShell`, `CiscoSwitchShell`, `HuaweiSwitchShell`, `CLIStateMachine`, `CommandTrie`, `PromptBuilder`) implementing `IRouterShell`/`ISwitchShell`.
- **Protocol engines** — each protocol has its own top-level directory with engine, types, events/observables, and (for reactive ones) `actors/`: `ospf/`, `bgp/`, `eigrp/`, `rip/`, `routing/`, `dhcp/`, `ipsec/`, `acl/`, `arp/`, `bfd/`, `cdp/`, `dot1x/`, `dtp/`, `glbp/`, `gre/`, `hsrp/`, `igmp/`, `igmp-snooping/`, `lacp/`, `lldp/`, `netflow/`, `ntp/`, `pim/`, `radius/`, `snmp/`, `stp/`, `syslog/`, `tacacs/`, `tcp/`, `udld/`, `vrrp/`, `vtp/`, `vxlan/`. SSH/SCP/SFTP lives under `protocols/ssh/`.

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

### Database simulation (`src/database/`)

- `engine/` — vendor-agnostic SQL engine scaffolding: `lexer/`, `parser/` (AST), `executor/`, `catalog/`, `storage/`, `types/`.
- `oracle/` — Oracle DBMS engine built on the engine layer: `OracleLexer`/`OracleParser`/`OracleExecutor`/`OracleCatalog`/`OracleStorage`/`OracleDatabase`/`OracleInstance`, plus subsystems for `asm/`, `awr/`, `dataguard/`, `flashback/`, `lock/`, `multitenant/`, `plan/`, `metadata/`, `packages/`, `commands/`, `actors/`, `demo/`.

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

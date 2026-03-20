# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A browser-based network simulator (Ubuntu Sandbox) built with React + TypeScript. Users drag-and-drop network devices (routers, switches, PCs, servers) onto a canvas, cable them together, and interact via in-browser terminal emulators that simulate Cisco IOS, Huawei VRP, Linux bash, Windows cmd/PowerShell, and Oracle SQL*Plus.

## Commands

```bash
npm run dev          # Start dev server on port 8080
npm run build        # Production build
npm run lint         # ESLint (flat config)
npm run test         # Vitest in watch mode
npm run test:run     # Vitest single run (CI)
npx vitest run src/__tests__/unit/network-v2/ospf.test.ts   # Run a single test file
```

## Architecture

**Path alias:** `@/` maps to `src/`.

### Network simulation layer (`src/network/`)

Equipment-driven architecture — no central simulator mediator. Devices process frames themselves.

- `equipment/Equipment.ts` — abstract base class for all devices. Maintains a static registry for topology traversal. Subclasses implement `handleFrame()`.
- `hardware/Port.ts`, `hardware/Cable.ts` — physical layer; Cables connect Ports for direct device-to-device frame delivery.
- `devices/` — concrete device classes: `LinuxPC`, `WindowsPC`, `CiscoRouter`, `HuaweiRouter`, `CiscoSwitch`, `HuaweiSwitch`, `GenericSwitch`, `Hub`, `LinuxServer`. Created via `DeviceFactory.createDevice(type)`.
- `devices/shells/` — CLI shell implementations (`CiscoIOSShell`, `HuaweiVRPShell`) implementing `IRouterShell`.
- `core/types.ts` — frame/packet structures (`EthernetFrame`, `IPv4Packet`, `ARPPacket`, `ICMPPacket`, `UDPPacket`), address types, protocol constants.
- `core/Logger.ts` — pub/sub network event logger.
- Protocol engines: `ospf/`, `ipsec/`, `dhcp/` — standalone protocol implementations attached to devices.

### Terminal emulation (`src/terminal/`)

- `commands/` — command handlers for the simulated shells.
- `cisco/` — Cisco-specific terminal logic.
- `windows/` — Windows cmd/PowerShell emulation.
- `sql/` — Oracle SQL*Plus emulation.
- `filesystem.ts` — in-memory filesystem for Linux devices.
- `sessions/` — terminal session management.

### Database simulation (`src/database/`)

- `oracle/` — Oracle DBMS engine simulation.
- `engine/` — query execution engine.

### State management (`src/store/`)

Single Zustand store (`networkStore.ts`) holds the full topology: devices (`NetworkDeviceUI[]`), connections (`Connection[]`), and UI state. The store bridges `Equipment` instances to React rendering.

### UI (`src/components/`)

- `network/` — canvas, device palette, device icons, connection lines, properties panel, terminal modal. Entry point: `NetworkDesigner.tsx`.
- `terminal/TerminalView.tsx` — terminal renderer.
- `editors/` — Vim and Nano editor emulation.
- `ui/` — shadcn/ui components (Tailwind + Radix).

### Tests (`src/__tests__/`)

Vitest with jsdom. Tests are organized under `unit/network-v2/` (network protocol and device tests), `unit/database/` (Oracle engine), and `unit/gui/` (component logic tests). Test environment is `node` (configured in `vite.config.ts`).

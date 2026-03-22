/**
 * IShellContext — Typed narrow interfaces for shell ↔ device interaction.
 *
 * Instead of shells depending on the full Router (250+ methods) or Switch,
 * these interfaces expose only what shells actually need. This enables:
 *   - Testability: mock only the methods the shell uses
 *   - Decoupling: shells don't know about routing tables, ARP, OSPF, etc.
 *   - ISP compliance: segregated interfaces per concern
 */

// ─── IRouterShellContext ──────────────────────────────────────────

/**
 * What a router shell needs from its host device.
 * Used by CiscoIOSShell and HuaweiVRPShell command handlers.
 */
export interface IRouterShellContext {
  /** Get the device hostname */
  getHostname(): string;

  /** Set the device hostname */
  setHostname(name: string): void;

  /** Get all port names for interface resolution */
  getPortNames(): Iterable<string>;

  /** Get a port by name */
  getPort(name: string): IPortInfo | undefined;

  /** Configure an IPv4 address on an interface */
  configureInterface(ifName: string, ip: string, mask: string): boolean;

  /** Add a static route */
  addStaticRoute(network: string, mask: string, nextHop: string, metric?: number): boolean;

  /** Get interface description */
  getInterfaceDescription(portName: string): string | undefined;

  /** Set interface description */
  setInterfaceDescription(portName: string, desc: string): void;
}

/**
 * Minimal port info exposed to shells.
 */
export interface IPortInfo {
  getIPAddress(): { toString(): string } | null;
  getSubnetMask(): { toString(): string } | null;
  getMAC(): { toString(): string };
  getIsUp(): boolean;
  setUp(up: boolean): void;
}

// ─── ISwitchShellContext ──────────────────────────────────────────

/**
 * What a switch shell needs from its host device.
 * Used by CiscoSwitchShell and HuaweiSwitchShell command handlers.
 */
export interface ISwitchShellContext {
  /** Get the device hostname */
  getHostname(): string;

  /** Set the device hostname */
  setHostname(name: string): void;

  /** Get all port names */
  getPortNames(): Iterable<string>;

  /** Get a port by name */
  getPort(name: string): IPortInfo | undefined;

  /** VLAN management */
  createVLAN(id: number, name?: string): boolean;
  deleteVLAN(id: number): boolean;
  getVLAN(id: number): unknown | undefined;

  /** Save configuration */
  writeMemory(): string;
}

// ─── Shared Mode State Interface ─────────────────────────────────

/**
 * Common mode state management methods shared across all CLI shells.
 * Both CiscoShellContext and HuaweiShellContext implement this subset.
 */
export interface IModeController {
  /** Get current CLI mode */
  getMode(): string;

  /** Set CLI mode */
  setMode(mode: string): void;
}

/**
 * Interface selection state, shared by Router and Switch shells.
 */
export interface IInterfaceSelector {
  getSelectedInterface(): string | null;
  setSelectedInterface(iface: string | null): void;
}

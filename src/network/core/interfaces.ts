/**
 * Core interfaces for the network simulation layer
 *
 * Fixes:
 * - 1.4 ISP Violation: IFileSystemCapable, IUserManageable extracted from Equipment base class
 * - 1.6 Missing Abstractions: IProtocolEngine unifies OSPF/RIP/IPSec APIs
 * - 1.8 LSP: IFirewallCapable replaces default no-op on Equipment
 */

import type { EthernetFrame, MACAddress, IPAddress, SubnetMask, IPv6Address } from './types';

// ─── 1.4 — Interface Segregation: Filesystem Capability ─────────────

/**
 * Capability interface for devices that have a filesystem.
 * Implemented by LinuxPC, LinuxServer — NOT by routers or switches.
 */
export interface IFileSystemCapable {
  /** Read file content for editor (Vim/Nano) */
  readFileForEditor(path: string): string | null;
  /** Write file content from editor */
  writeFileFromEditor(path: string, content: string): boolean;
  /** Resolve absolute path from relative path + cwd */
  resolveAbsolutePath(path: string): string;
  /** Get current working directory */
  getCwd(): string;
}

// ─── 1.4 — Interface Segregation: User Management Capability ────────

/**
 * Capability interface for devices that have user management.
 * Implemented by LinuxPC, LinuxServer — NOT by routers or switches.
 */
export interface IUserManageable {
  /** Check password for a user */
  checkPassword(username: string, password: string): boolean;
  /** Set password for a user */
  setUserPassword(username: string, password: string): void;
  /** Check if a user exists */
  userExists(username: string): boolean;
  /** Get current UID (0 = root) */
  getCurrentUid(): number;
  /** Check if current user can use sudo */
  canSudo(): boolean;
  /** Get current username */
  getCurrentUser(): string;
}

// ─── 1.6 — Protocol Engine Abstraction ──────────────────────────────

/**
 * Common interface for all protocol engines.
 * Unifies OSPF, RIP, IPSec, DHCP APIs.
 */
export interface IProtocolEngine {
  /** Start the protocol engine */
  start(): void;
  /** Stop the protocol engine and clean up timers */
  stop(): void;
  /** Check if the engine is currently running */
  isRunning(): boolean;
}

// ─── 1.6 — Routing Table Abstraction ────────────────────────────────

/**
 * Generic route entry for both IPv4 and IPv6.
 * Eliminates duplicate RoutingTable types in Router.ts and EndHost.ts.
 */
export interface IRouteEntry<TAddress> {
  /** Network address or prefix */
  network: TAddress;
  /** Next-hop address (null for connected routes) */
  nextHop: TAddress | null;
  /** Outgoing interface name */
  iface: string;
  /** Route type identifier */
  type: string;
  /** Administrative distance (lower = preferred) */
  ad: number;
  /** Metric (lower = preferred when AD and prefix are equal) */
  metric: number;
}

/** IPv4 route extends base with subnet mask */
export interface IIPv4Route extends IRouteEntry<IPAddress> {
  mask: SubnetMask;
  type: 'connected' | 'static' | 'default' | 'rip' | 'ospf';
}

/** IPv6 route extends base with prefix length */
export interface IIPv6Route extends IRouteEntry<IPv6Address> {
  prefixLength: number;
  type: 'connected' | 'static' | 'default' | 'ra' | 'ospfv3';
}

// ─── 1.6 — Routing Table Interface ──────────────────────────────────

/**
 * Generic routing table with Longest Prefix Match (LPM).
 * Parameterized by address type to share logic between IPv4 and IPv6.
 */
export interface IRoutingTable<TAddress, TRoute extends IRouteEntry<TAddress>> {
  /** Add a route to the table */
  addRoute(route: TRoute): void;
  /** Remove routes matching the given criteria */
  removeRoute(network: TAddress, iface?: string, type?: string): boolean;
  /** Perform Longest Prefix Match lookup */
  lookup(destination: TAddress): TRoute | null;
  /** Get all routes */
  getRoutes(): TRoute[];
  /** Clear all routes of a given type */
  clearByType(type: string): void;
}

// ─── 1.6 — Neighbor Resolution Abstraction ──────────────────────────

/**
 * Generic neighbor cache entry for both ARP (IPv4) and NDP (IPv6).
 */
export interface INeighborEntry {
  mac: MACAddress;
  iface: string;
  timestamp: number;
}

/**
 * Generic neighbor resolver interface.
 * Unifies ARP and NDP resolution patterns.
 */
export interface INeighborResolver<TAddress> {
  /** Resolve address to MAC (async with timeout) */
  resolve(address: TAddress, iface: string): Promise<MACAddress>;
  /** Learn a neighbor mapping */
  learn(address: TAddress, mac: MACAddress, iface: string): void;
  /** Look up cached entry */
  lookup(address: TAddress): INeighborEntry | undefined;
  /** Get the full cache */
  getCache(): Map<string, INeighborEntry>;
  /** Clear the cache */
  clear(): void;
}

// ─── 1.6 — Packet Queue Abstraction ────────────────────────────────

/**
 * Generic packet queue for packets waiting on address resolution.
 * Eliminates duplicate fwdQueue / ipv6FwdQueue patterns.
 */
export interface IPacketQueue<TPacket, TAddress> {
  /** Enqueue a packet waiting for address resolution */
  enqueue(packet: TPacket, outIface: string, nextHop: TAddress, timeoutMs: number): void;
  /** Flush all packets for a resolved address */
  flush(address: TAddress, sendFn: (packet: TPacket, outIface: string) => void): number;
  /** Remove expired entries */
  purgeExpired(): number;
  /** Get queue depth */
  size(): number;
  /** Clear all queued packets */
  clear(): void;
}

// ─── 1.8 — Firewall Capability ─────────────────────────────────────

/**
 * Capability interface for devices that support packet filtering.
 * Replaces the default no-op firewallFilter() on EndHost.
 */
export interface IFirewallCapable {
  /** Filter a packet, returning true to allow, false to drop */
  firewallFilter(
    direction: 'in' | 'out' | 'forward',
    packet: { srcIP: string; dstIP: string; protocol: number },
    iface: string,
  ): boolean;
}

// ─── Type Guards ─────────────────────────────────────────────────────

/** Check if a device supports filesystem operations */
export function isFileSystemCapable(device: unknown): device is IFileSystemCapable {
  return (
    device !== null &&
    typeof device === 'object' &&
    'readFileForEditor' in device &&
    'writeFileFromEditor' in device &&
    'resolveAbsolutePath' in device
  );
}

/** Check if a device supports user management */
export function isUserManageable(device: unknown): device is IUserManageable {
  return (
    device !== null &&
    typeof device === 'object' &&
    'checkPassword' in device &&
    'setUserPassword' in device &&
    'userExists' in device
  );
}

/** Check if a device supports firewall filtering */
export function isFirewallCapable(device: unknown): device is IFirewallCapable {
  return (
    device !== null &&
    typeof device === 'object' &&
    'firewallFilter' in device
  );
}

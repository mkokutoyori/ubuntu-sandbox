/**
 * CiscoDevice — Common interface for devices managed by Cisco IOS CLI shells.
 *
 * Both Router and Switch satisfy this interface structurally (duck typing).
 * This eliminates the type coupling that previously forced separate shell
 * implementations for routers and switches.
 *
 * Follows Interface Segregation: only the methods the shell base class needs.
 * Device-specific methods are accessed via TDevice generic in subclasses.
 */

import type { Port } from '../../hardware/Port';
import type { ARPEntry, IPAddress, MACAddress } from '../../core/types';

// ─── ARP Provider (shared ARP table access) ─────────────────────────

export type CiscoARPEntry = ARPEntry;

/**
 * ARP table access — subset of CiscoDevice for ARP commands.
 * Kept as a separate interface for granular composition (ISP).
 */
export interface ARPProvider {
  _getArpTableInternal(): Map<string, CiscoARPEntry>;
  _addStaticARP(ip: IPAddress, mac: MACAddress, iface: string): void;
  _deleteARP(ip: IPAddress): boolean;
  _clearARPCache(): void;
  _getPortsInternal(): Map<string, Port>;
  _getSviVlanIds?(): number[];
}

// ─── CiscoDevice (full shell contract) ──────────────────────────────

/**
 * Minimal contract that a network device must satisfy
 * to be driven by CiscoShellBase.
 */
export interface CiscoDevice extends ARPProvider {
  /** Get the device hostname */
  _getHostnameInternal(): string;
  /** Set the device hostname */
  _setHostnameInternal(name: string): void;
  /** Get the device hostname as shown by `show inventory` and prompts */
  getHostname(): string;
  /** Get a port by name */
  getPort(name: string): Port | undefined;
  /** Get all port names */
  getPortNames(): string[];
  /** Power off the device */
  powerOff(): void;
  /** Power on the device */
  powerOn(): void;
  defaultHostname(): string;
}

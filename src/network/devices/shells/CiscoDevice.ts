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
import type { MACAddress } from '../../core/types';

// ─── ARP Provider (shared ARP table access) ─────────────────────────

/** Entry in the ARP table (dynamic or static) */
export interface CiscoARPEntry {
  mac: MACAddress;
  iface: string;
  timestamp: number;
  type: 'dynamic' | 'static';
}

/**
 * ARP table access — subset of CiscoDevice for ARP commands.
 * Kept as a separate interface for granular composition (ISP).
 */
export interface ARPProvider {
  _getArpTableInternal(): Map<string, CiscoARPEntry>;
  _addStaticARP(ip: string, mac: MACAddress, iface: string): void;
  _deleteARP(ip: string): boolean;
  _clearARPCache(): void;
  _getPortsInternal(): Map<string, Port>;
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
  /** Get a port by name */
  getPort(name: string): Port | undefined;
  /** Get all port names */
  getPortNames(): string[];
  /** Power off the device */
  powerOff(): void;
  /** Power on the device */
  powerOn(): void;
}

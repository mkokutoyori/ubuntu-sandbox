/**
 * Windows command executor — context interface and types for modular Windows commands.
 *
 * Each command module (WinIpconfig, WinNetsh, etc.) receives a WinCommandContext
 * that provides access to device internals without tight coupling to WindowsPC.
 */

import { Port } from '../../hardware/Port';
import { IPAddress, SubnetMask } from '../../core/types';

/** Ping result from EndHost.executePingSequence */
export interface PingResult {
  seq: number;
  success: boolean;
  fromIP?: string;
  ttl: number;
  rttMs: number;
  error?: string;
}

/** Traceroute hop from EndHost.executeTraceroute */
export interface TracerouteHop {
  hop: number;
  ip?: string;
  rttMs?: number;
  timeout: boolean;
}

/** Route entry from EndHost.getRoutingTable */
export interface RouteEntry {
  network: IPAddress;
  mask: SubnetMask;
  nextHop: IPAddress | null;
  iface: string;
  metric: number;
  type: 'connected' | 'static' | 'default';
}

/**
 * Context provided to all Windows command modules.
 * Abstracts access to EndHost/WindowsPC internals.
 */
export interface WinCommandContext {
  /** Device hostname */
  hostname: string;
  /** All ports (Map of name → Port) */
  ports: Map<string, Port>;
  /** Default gateway IP string or null */
  defaultGateway: string | null;
  /** ARP table */
  arpTable: Map<string, { mac: any; iface: string }>;

  // Network config
  configureInterface(ifName: string, ip: IPAddress, mask: SubnetMask): void;
  setDefaultGateway(gw: IPAddress): void;
  clearDefaultGateway(): void;
  addStaticRoute(network: IPAddress, mask: SubnetMask, nextHop: IPAddress, metric: number): boolean;
  removeRoute(dest: IPAddress, mask: SubnetMask): boolean;
  getRoutingTable(): RouteEntry[];

  // DHCP
  isDHCPConfigured(ifName: string): boolean;
  getDHCPState(ifName: string): any;
  releaseLease(ifName: string): string;
  requestLease(ifName: string, opts: any): string;
  autoDiscoverDHCPServers(): void;

  // DHCP event log
  addDHCPEvent(type: string, message: string): void;
  syncDHCPEvents(): void;
  getDHCPEventLog(): string[];

  // Network operations
  executePingSequence(target: IPAddress, count: number, timeout?: number, ttl?: number): Promise<PingResult[]>;
  executeTraceroute(target: IPAddress): Promise<TracerouteHop[]>;

  // TCP/IP stack reset
  resetStack(): void;
}

/**
 * LinuxNetKernel - Narrow façade over the L2/L3 stack of an `EndHost`.
 *
 * Commands (`LinuxCommand` implementations) only see the network through
 * this interface. They never import `EndHost`, `LinuxPC`, `LinuxServer` or
 * `LinuxMachine` — which is what makes them unit-testable with a fake
 * kernel and no `Equipment` at all.
 *
 * The concrete implementation is built inside `LinuxMachine` via
 * `createLinuxNetKernel(host)`. Because that factory lives as a method on
 * `LinuxMachine` (which extends `EndHost`), it can close over protected
 * members like `arpTable`, `dhcpClient`, `ipForwardEnabled`,
 * `masqueradeOnInterfaces`, `executePingSequence`, `executeTraceroute` and
 * `extractPorts`.
 *
 * See `linux_gap.md` §7.3.
 */

import type { Port } from '../../hardware/Port';
import type { IPAddress, SubnetMask, MACAddress, IPv4Packet } from '../../core/types';
import type { ARPEntry, HostRouteEntry, PingResult } from '../EndHost';
import type { DHCPClient } from '../../dhcp/DHCPClient';

export interface TracerouteProbe {
  /** True if this probe got a response (Time Exceeded, echo-reply, Port Unreachable, …). */
  responded: boolean;
  rttMs?: number;
  ip?: string;
  unreachable?: boolean;
  /** ICMP Destination Unreachable code (0=!N, 1=!H, 2=!P, 3=!X, 13=!A). */
  icmpCode?: number;
}

export interface TracerouteHop {
  hop: number;
  /** IP of the first responding probe. */
  ip?: string;
  /** RTT of the first responding probe (backward compat). */
  rttMs?: number;
  timeout: boolean;
  /** True when any probe got ICMP Destination Unreachable. */
  unreachable?: boolean;
  /** ICMP code from the first unreachable probe (0=!N, 1=!H, 2=!P, 13=!A). */
  icmpCode?: number;
  /** Per-probe detail — length equals probesPerHop. */
  probes: TracerouteProbe[];
}

export interface LinuxNetKernel {
  // ─── Interfaces ──────────────────────────────────────────────────
  /** Ordered map of port name → Port, as seen by `ip`, `ifconfig`, `arp`. */
  getPorts(): ReadonlyMap<string, Port>;

  /** Configure IPv4 address + mask on an interface. */
  configureInterface(name: string, ip: IPAddress, mask: SubnetMask): boolean;

  /** Remove IPv4 address from an interface (`ip addr del`). */
  clearInterfaceIP(name: string): void;

  /** Set admin state up/down (`ip link set dev X up/down`). */
  setInterfaceAdmin(name: string, enabled: boolean): void;

  /** True if this interface was configured via DHCP (dynamic). */
  isDHCPConfigured(name: string): boolean;

  // ─── Routing ─────────────────────────────────────────────────────
  getRoutingTable(): HostRouteEntry[];
  addStaticRoute(network: IPAddress, mask: SubnetMask, gw: IPAddress, metric?: number): boolean;
  removeRoute(network: IPAddress, mask: SubnetMask): boolean;
  setDefaultGateway(gw: IPAddress): void;
  getDefaultGateway(): IPAddress | null;
  clearDefaultGateway(): void;

  // ─── ARP ─────────────────────────────────────────────────────────
  getArpTable(): ReadonlyMap<string, ARPEntry>;
  addStaticARP(ip: string, mac: MACAddress, iface: string): void;
  deleteARP(ip: string): boolean;

  // ─── L3 probes ───────────────────────────────────────────────────
  pingSequence(
    target: IPAddress,
    count: number,
    timeoutMs?: number,
    ttl?: number,
  ): Promise<PingResult[]>;

  traceroute(target: IPAddress, maxHops?: number, probesPerHop?: number, firstTtl?: number): Promise<TracerouteHop[]>;

  // ─── DHCP client ─────────────────────────────────────────────────
  getDhcpClient(): DHCPClient;
  autoDiscoverDHCPServers(): void;

  // ─── Forwarding / NAT (router-layer) ─────────────────────────────
  setIpForward(enabled: boolean): void;
  isIpForwardEnabled(): boolean;
  addMasqueradeInterface(iface: string): void;
  removeMasqueradeInterface(iface: string): void;

  /** Parsed TCP/UDP port numbers from an IPv4 packet, for NAT/firewall. */
  extractPorts(pkt: IPv4Packet): { srcPort?: number; dstPort?: number };
}

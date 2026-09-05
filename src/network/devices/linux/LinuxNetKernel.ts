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
import type { TcpWireOutcome } from '../../tcp/types';
import type { IPAddress, IPv6Address, SubnetMask, MACAddress, IPv4Packet } from '../../core/types';
import type { ARPEntry, HostRouteEntry, HostIPv6RouteEntry, HostPolicyRule, PingResult } from '../EndHost';
import type { DHCPClient } from '../../dhcp/DHCPClient';
import type { DnsQueryFn } from '../../dns/compat/DnsWireCompat';
import type { TcpStack } from '../../tcp/TcpStack';
import type { TcpdumpDeps } from './network/tcpdump/TcpdumpRunner';
import type { IScheduler } from '@/events/Scheduler';

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

  /**
   * Stable ifindex for an interface, assigned once when the name is first
   * seen and never recomputed from list position. `lo` is always 1.
   */
  getIfIndex(name: string): number;

  buildTcpdumpDeps(): TcpdumpDeps;

  /** Configure IPv4 address + mask on an interface. */
  configureInterface(name: string, ip: IPAddress, mask: SubnetMask): boolean;

  /** Remove IPv4 address from an interface (`ip addr del`). */
  clearInterfaceIP(name: string): void;

  /** Set admin state up/down (`ip link set dev X up/down`). */
  setInterfaceAdmin(name: string, enabled: boolean): void;

  /** True if this interface was configured via DHCP (dynamic). */
  isDHCPConfigured(name: string): boolean;

  /** Configure an IPv6 address on an interface, inserting its connected route. */
  configureIPv6Interface(name: string, address: IPv6Address, prefixLength: number): boolean;

  // ─── Routing ─────────────────────────────────────────────────────
  getRoutingTable(): HostRouteEntry[];
  getIPv6RoutingTable(): HostIPv6RouteEntry[];
  setDefaultGateway6(gateway: IPv6Address): void;
  addIPv6StaticRoute(
    prefix: IPv6Address, prefixLength: number,
    nextHop: IPv6Address | null, iface: string, metric?: number,
  ): void;
  removeIPv6StaticRoute(
    prefix: IPv6Address, prefixLength: number, nextHop?: IPv6Address | null,
  ): boolean;
  addStaticRoute(network: IPAddress, mask: SubnetMask, gw: IPAddress, metric?: number): boolean;
  addDeviceRoute(network: IPAddress, mask: SubnetMask, iface: string, metric?: number): boolean;
  removeRoute(
    network: IPAddress,
    mask: SubnetMask,
    filter?: { nextHop?: IPAddress | null; metric?: number },
  ): boolean;
  setDefaultGateway(gw: IPAddress): void;
  getDefaultGateway(): IPAddress | null;
  clearDefaultGateway(): void;

  // ─── Policy routing (`ip rule` + `ip route ... table <ID>`) ──────
  getRoutingTableFor(tableId: number): HostRouteEntry[];
  addStaticRouteToTable(tableId: number, network: IPAddress, mask: SubnetMask, gw: IPAddress, metric?: number): boolean;
  addDeviceRouteToTable(tableId: number, network: IPAddress, mask: SubnetMask, iface: string, metric?: number): boolean;
  removeRouteFromTable(
    tableId: number,
    network: IPAddress,
    mask: SubnetMask,
    filter?: { nextHop?: IPAddress | null; metric?: number },
  ): boolean;
  addPolicyRule(rule: HostPolicyRule): void;
  removePolicyRule(priority: number): boolean;
  getPolicyRules(): HostPolicyRule[];
  resolveRouteFromTable(
    targetIP: IPAddress,
    fromIP: IPAddress | null,
  ): { iface: string; nextHopIP: IPAddress; table: number } | null;

  // ─── ARP ─────────────────────────────────────────────────────────
  getArpTable(): ReadonlyMap<string, ARPEntry>;
  addStaticARP(ip: IPAddress, mac: MACAddress, iface: string): void;
  deleteARP(ip: IPAddress): boolean;
  clearARPTable(): void;
  /** RFC 5227 gratuitous ARP broadcast (`arping -A`/`-U`). False if the interface has no cable. */
  sendGratuitousArp(iface: string, ip: IPAddress, mode: 'request' | 'reply'): boolean;

  // ─── L3 probes ───────────────────────────────────────────────────
  /** True if the kernel has a route (default or specific) to reach `target`. */
  hasRoute(target: IPAddress): boolean;

  getScheduler(): IScheduler;

  pingSequence(
    target: IPAddress,
    count: number,
    timeoutMs?: number,
    ttl?: number,
    opts?: { dataSize?: number; df?: boolean },
  ): Promise<PingResult[]>;

  /** ICMPv6 echo through the real NDP/route resolution path (`ping6`). */
  ping6Sequence(
    target: IPv6Address,
    count: number,
    timeoutMs?: number,
  ): Promise<PingResult[]>;

  traceroute(target: IPAddress, maxHops?: number, probesPerHop?: number, firstTtl?: number, timeoutMs?: number): Promise<TracerouteHop[]>;

  /** Emit a single locally-originated UDP probe (for UDP-mode traceroute and the like). */
  sendUdpProbe(
    target: IPAddress, destinationPort: number, sourcePort: number,
    options?: {
      ttl?: number; badChecksum?: boolean; sourceIp?: IPAddress; payload?: Uint8Array;
    },
  ): boolean;

  /**
   * Synchronous TCP handshake probe used by nc / nmap-style service
   * discovery. Accepts an IPv4 dotted string OR an IPv6 literal.
   */
  tcpProbe(target: string, port: number): boolean;

  tcpConnectOutcome(target: string, port: number): TcpWireOutcome;

  /**
   * Opens a real connection and reads what the service volunteers, then
   * closes it — nmap's `Probe TCP NULL q||`. Null when the connection
   * never came up.
   */
  grabServiceBanner(target: string, port: number): string | null;

  /** Le service systemd-resolved de l'hôte (stub, cache, config par lien). */
  getResolvedService(): import('./net/ResolvedService').ResolvedService;
  /** Réécrit `/run/systemd/resolve/` après un changement de configuration. */
  publishResolvedState(): void;
  /** Ouvre ou ferme les ports LLMNR/mDNS selon la configuration courante. */
  syncLinkLocalResponders(): void;
  /** L'agent mDNS de l'hôte — parcours et résolution DNS-SD. */
  getMdnsAgent(): import('@/network/mdns/MdnsAgent').MdnsAgent;

  /** Voisins LLDP découverts sur le câble, tous ports ou un seul. */
  getLldpNeighbors(iface?: string): import('../../lldp/LldpAgent').LldpNeighbor[];

  /** L'agent LLDP de cette machine — ce que `lldpd` pilote et `lldpcli` lit. */
  getLldpAgent(): import('../../lldp/LldpAgent').LldpAgent;

  // ─── DHCP client ─────────────────────────────────────────────────
  getDhcpClient(): DHCPClient;
  autoDiscoverDHCPServers(): void;
  /** Real DHCPv6 SOLICIT->ADVERTISE->REQUEST->REPLY exchange (RFC 8415). */
  requestDhcpv6Lease(iface: string, verbose?: boolean): string;

  /** DHCPv6 sans etat : INFORMATION-REQUEST, configuration sans adresse. */
  requestDhcpv6Information(iface: string, verbose?: boolean): string;

  // ─── Forwarding / NAT (router-layer) ─────────────────────────────
  setIpForward(enabled: boolean): void;
  isIpForwardEnabled(): boolean;
  addMasqueradeInterface(iface: string): void;
  removeMasqueradeInterface(iface: string): void;

  /** Parsed TCP/UDP port numbers from an IPv4 packet, for NAT/firewall. */
  extractPorts(pkt: IPv4Packet): { srcPort?: number; dstPort?: number };

  // ─── Name resolution ────────────────────────────────────────────
  /**
   * Resolve a hostname to an IPv4 address.
   *
   * Resolution order (mirrors Linux NSS `files dns`):
   *   1. If `name` is already a valid IPv4 address, return it directly.
   *   2. Look up `name` in `/etc/hosts` (VFS).
   *   3. Query the DNS server from `/etc/resolv.conf` over UDP/53 through
   *      the simulated network (asynchronous: unreachable servers time out).
   *   4. Return `null` if unresolvable.
   */
  resolveHostname(name: string): Promise<IPAddress | null>;

  /** IPv6 counterpart of `resolveHostname` — same NSS `hosts` lookup,
   *  filtered to AF_INET6 records, for `ping6`/`ping -6`. */
  resolveHostname6(name: string): Promise<IPv6Address | null>;

  /**
   * Synchronous variant of the same NSS `hosts: files dns` lookup —
   * `curl`/`wget` (PRD-Windows-Server.md §5 P11) need a real hostname
   * resolution step before dialing, but their own TCP round trip is
   * synchronous in this simulator, so a Promise-returning API would just
   * add an artificial microtask hop for no benefit.
   */
  resolveHostnameSync(name: string): IPAddress | null;

  queryDns: DnsQueryFn;

  /** Read a file from the virtual filesystem (returns null if not found). */
  readFile(path: string): string | null;

  /** Raw TCP stack access for client protocols hosted at this layer (HTTP dial for curl/wget). */
  getTcpStack(): TcpStack;
}

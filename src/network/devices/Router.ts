/**
 * Router - Layer 3 Forwarding Engine (RFC 791, RFC 1812, RFC 2453)
 *
 * Architecture: Control Plane / Data Plane / Management Plane
 *
 * Data Plane (Forwarding Engine — "Packet Walk"):
 *   Phase A: Ingress & L2 Validation
 *     - L2 Filter: Accept only frames for our MAC or broadcast
 *     - EtherType Check: Dispatch ARP (0x0806) or IPv4 (0x0800)
 *   Phase B: L3 Header Sanity Check (RFC 1812 §5.2.2)
 *     - Checksum verification (one's complement)
 *     - Version == 4
 *     - IHL >= 5
 *     - TotalLength consistency
 *   Phase C: Forwarding Decision (LPM)
 *     - If for us → Control Plane (ICMP echo-reply, UDP/RIP)
 *     - Else → FIB lookup (Longest Prefix Match)
 *   Phase D: Header Mutation & Exception Handling
 *     - TTL decrement → ICMP Time Exceeded if TTL=0
 *     - Checksum recalculation
 *   Phase E: Egress & L2 Rewrite
 *     - MTU check → ICMP Fragmentation Needed if DF=1
 *     - ARP resolution for next-hop MAC
 *     - Re-encapsulate: SrcMAC=egress interface, DstMAC=next-hop
 *
 * Control Plane:
 *   - RIB (Routing Information Base) with connected/static/default/rip routes
 *   - ARP cache with interface tracking
 *   - ICMP error generation (Time Exceeded, Dest Unreachable, Frag Needed)
 *   - RIPv2 engine (RFC 2453): periodic updates, split horizon, route aging
 *
 * Management Plane:
 *   - Vendor-abstracted CLI (Cisco IOS / Huawei VRP)
 *   - Running-config state
 *   - SNMP-ready performance counters
 */

import { Equipment } from '../equipment/Equipment';
import { Port } from '../hardware/Port';
import {
  EthernetFrame, IPv4Packet, MACAddress, IPAddress, SubnetMask,
  ARPPacket, ICMPPacket, UDPPacket, RIPPacket, RIPRouteEntry,
  ETHERTYPE_ARP, ETHERTYPE_IPV4, ETHERTYPE_IPV6,
  IP_PROTO_ICMP, IP_PROTO_UDP, IP_PROTO_ICMPV6,
  UDP_PORT_RIP, RIP_METRIC_INFINITY, RIP_MAX_ENTRIES_PER_MESSAGE,
  createIPv4Packet, verifyIPv4Checksum, computeIPv4Checksum,
  DeviceType,
  // IPv6 types
  IPv6Address, IPv6Packet, ICMPv6Packet,
  NDPNeighborSolicitation, NDPNeighborAdvertisement, NDPRouterSolicitation, NDPOptionPrefixInfo,
  createIPv6Packet, createNeighborSolicitation, createNeighborAdvertisement, createRouterAdvertisement,
  createICMPv6EchoReply,
  IPV6_ALL_NODES_MULTICAST, IPV6_ALL_ROUTERS_MULTICAST,
} from '../core/types';
import { Logger } from '../core/Logger';

// ─── Routing Table (RIB) ───────────────────────────────────────────

export interface RouteEntry {
  /** Network address (e.g. 10.0.1.0) */
  network: IPAddress;
  /** Subnet mask (e.g. 255.255.255.0) */
  mask: SubnetMask;
  /** Next-hop IP (null for connected routes → use destination directly) */
  nextHop: IPAddress | null;
  /** Outgoing interface name */
  iface: string;
  /** Route type for display */
  type: 'connected' | 'static' | 'default' | 'rip';
  /** Administrative distance (lower = preferred) */
  ad: number;
  /** Metric (lower = preferred when prefix lengths and ADs are equal) */
  metric: number;
}

// ─── Performance Counters (SNMP-ready) ──────────────────────────────

export interface RouterCounters {
  /** Total octets received on all interfaces */
  ifInOctets: number;
  /** Total octets sent on all interfaces */
  ifOutOctets: number;
  /** Packets dropped due to invalid header (version, IHL, checksum, length) */
  ipInHdrErrors: number;
  /** Packets with IP addresses that were invalid for the entity (not for us, no route) */
  ipInAddrErrors: number;
  /** Packets successfully forwarded to next hop */
  ipForwDatagrams: number;
  /** Total ICMP messages sent */
  icmpOutMsgs: number;
  /** ICMP Destination Unreachable messages sent */
  icmpOutDestUnreachs: number;
  /** ICMP Time Exceeded messages sent */
  icmpOutTimeExcds: number;
  /** ICMP echo-reply messages sent */
  icmpOutEchoReps: number;
}

// ─── RIP State (RFC 2453) ───────────────────────────────────────────

/** Internal RIP route with aging metadata */
interface RIPRouteState {
  /** Route entry in the RIB */
  route: RouteEntry;
  /** Timestamp when route was last refreshed */
  lastUpdate: number;
  /** Source router IP that advertised this route */
  learnedFrom: string;
  /** Interface on which the route was learned */
  learnedOnIface: string;
  /** true if route has been marked invalid (metric=16) but not yet garbage-collected */
  garbageCollect: boolean;
  /** Timeout timer handle */
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  /** Garbage collection timer handle */
  gcTimer: ReturnType<typeof setTimeout> | null;
}

/** RIP configuration */
export interface RIPConfig {
  /** Networks to advertise (classful or CIDR) */
  networks: Array<{ network: IPAddress; mask: SubnetMask }>;
  /** Update interval in ms (default 30000 = 30s) */
  updateInterval: number;
  /** Route timeout in ms (default 180000 = 180s) */
  routeTimeout: number;
  /** Garbage collection timer in ms (default 120000 = 120s) */
  gcTimeout: number;
  /** Enable split horizon (default true) */
  splitHorizon: boolean;
  /** Enable poisoned reverse with split horizon (default true) */
  poisonedReverse: boolean;
}

// ─── ARP State ─────────────────────────────────────────────────────

interface ARPEntry {
  mac: MACAddress;
  iface: string;
  timestamp: number;
}

interface PendingARP {
  resolve: (mac: MACAddress) => void;
  reject: (reason: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Packets waiting for ARP resolution */
interface QueuedPacket {
  frame: IPv4Packet;
  outIface: string;
  nextHopIP: IPAddress;
  timer: ReturnType<typeof setTimeout>;
}

// ─── IPv6 State (RFC 8200, RFC 4861) ────────────────────────────────

export interface IPv6RouteEntry {
  /** Network prefix */
  prefix: IPv6Address;
  /** Prefix length (0-128) */
  prefixLength: number;
  /** Next-hop IPv6 address (null for connected routes) */
  nextHop: IPv6Address | null;
  /** Outgoing interface name */
  iface: string;
  /** Route type */
  type: 'connected' | 'static' | 'default';
  /** Administrative distance */
  ad: number;
  /** Metric */
  metric: number;
}

export type NeighborState = 'incomplete' | 'reachable' | 'stale' | 'delay' | 'probe';

interface NeighborCacheEntry {
  mac: MACAddress;
  iface: string;
  state: NeighborState;
  isRouter: boolean;
  timestamp: number;
}

interface PendingNDP {
  resolve: (mac: MACAddress) => void;
  reject: (reason: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Packets waiting for NDP resolution */
interface QueuedIPv6Packet {
  frame: IPv6Packet;
  outIface: string;
  nextHopIP: IPv6Address;
  timer: ReturnType<typeof setTimeout>;
}

/** Router Advertisement configuration per interface */
export interface RAConfig {
  /** Send periodic RAs (default true) */
  enabled: boolean;
  /** RA interval in ms (default 200000 = 200s) */
  interval: number;
  /** Advertised hop limit (0 = unspecified) */
  curHopLimit: number;
  /** Managed address configuration flag */
  managedFlag: boolean;
  /** Other configuration flag */
  otherConfigFlag: boolean;
  /** Router lifetime in seconds (0 = not a default router) */
  routerLifetime: number;
  /** Prefixes to advertise */
  prefixes: Array<{
    prefix: IPv6Address;
    prefixLength: number;
    onLink: boolean;
    autonomous: boolean;
    validLifetime: number;
    preferredLifetime: number;
  }>;
}

// ─── CLI Shell (imported from shells/) ──────────────────────────────

import type { IRouterShell } from './shells/IRouterShell';
import { CiscoIOSShell } from './shells/CiscoIOSShell';
import { HuaweiVRPShell } from './shells/HuaweiVRPShell';

// ─── Router ────────────────────────────────────────────────────────

export class Router extends Equipment {
  // ── Control Plane ─────────────────────────────────────────────
  private routingTable: RouteEntry[] = [];
  private arpTable: Map<string, ARPEntry> = new Map();
  private pendingARPs: Map<string, PendingARP[]> = new Map();
  private packetQueue: QueuedPacket[] = [];
  private readonly defaultTTL = 255; // Cisco/Huawei default
  private readonly interfaceMTU = 1500; // Standard Ethernet MTU

  // ── RIP Engine (RFC 2453) ──────────────────────────────────────
  private ripEnabled = false;
  private ripConfig: RIPConfig = {
    networks: [],
    updateInterval: 30000,
    routeTimeout: 180000,
    gcTimeout: 120000,
    splitHorizon: true,
    poisonedReverse: true,
  };
  private ripRoutes: Map<string, RIPRouteState> = new Map(); // key: "network/mask"
  private ripUpdateTimer: ReturnType<typeof setInterval> | null = null;

  // ── Performance Counters ──────────────────────────────────────
  private counters: RouterCounters = {
    ifInOctets: 0, ifOutOctets: 0,
    ipInHdrErrors: 0, ipInAddrErrors: 0, ipForwDatagrams: 0,
    icmpOutMsgs: 0, icmpOutDestUnreachs: 0, icmpOutTimeExcds: 0,
    icmpOutEchoReps: 0,
  };

  // ── IPv6 State (RFC 8200, RFC 4861) ───────────────────────────
  private ipv6RoutingTable: IPv6RouteEntry[] = [];
  private neighborCache: Map<string, NeighborCacheEntry> = new Map();
  private pendingNDPs: Map<string, PendingNDP[]> = new Map();
  private ipv6PacketQueue: QueuedIPv6Packet[] = [];
  private readonly defaultHopLimit = 64;
  private ipv6Enabled = false;
  /** RA configuration per interface */
  private raConfig: Map<string, RAConfig> = new Map();
  /** RA timer handles per interface */
  private raTimers: Map<string, ReturnType<typeof setInterval>> = new Map();

  // ── Management Plane (vendor CLI shell) ───────────────────────
  private shell: IRouterShell;

  constructor(type: DeviceType = 'router-cisco', name: string = 'Router', x: number = 0, y: number = 0) {
    super(type, name, x, y);
    this.shell = type.includes('huawei') ? new HuaweiVRPShell() : new CiscoIOSShell();
    this.createPorts();
  }

  private createPorts(): void {
    const portCount = 4;
    for (let i = 0; i < portCount; i++) {
      const portName = this.getVendorPortName(i);
      this.addPort(new Port(portName, 'ethernet'));
    }
  }

  /** Vendor-specific interface naming convention */
  private getVendorPortName(index: number): string {
    if (this.deviceType.includes('huawei')) return `GE0/0/${index}`;
    if (this.deviceType.includes('cisco')) return `GigabitEthernet0/${index}`;
    return `eth${index}`;
  }

  // ─── Interface IP Configuration ──────────────────────────────

  /**
   * Configure an IP on an interface. Automatically adds a connected route.
   */
  configureInterface(ifName: string, ip: IPAddress, mask: SubnetMask): boolean {
    const port = this.ports.get(ifName);
    if (!port) return false;

    port.configureIP(ip, mask);

    // Remove old connected route for this interface
    this.routingTable = this.routingTable.filter(
      r => !(r.type === 'connected' && r.iface === ifName)
    );

    // Add connected route
    const networkOctets = ip.getOctets().map((o, i) => o & mask.getOctets()[i]);
    this.routingTable.push({
      network: new IPAddress(networkOctets),
      mask,
      nextHop: null,
      iface: ifName,
      type: 'connected',
      ad: 0,
      metric: 0,
    });

    Logger.info(this.id, 'router:interface-config',
      `${this.name}: ${ifName} configured ${ip}/${mask.toCIDR()}`);
    return true;
  }

  // ─── IPv6 Interface Configuration ──────────────────────────────

  /**
   * Enable IPv6 on this router. Must be called before configuring IPv6 addresses.
   */
  enableIPv6Routing(): void {
    this.ipv6Enabled = true;
    Logger.info(this.id, 'router:ipv6-enabled', `${this.name}: IPv6 unicast routing enabled`);
  }

  /**
   * Disable IPv6 routing.
   */
  disableIPv6Routing(): void {
    this.ipv6Enabled = false;
    // Stop all RA timers
    for (const [, timer] of this.raTimers) {
      clearInterval(timer);
    }
    this.raTimers.clear();
    Logger.info(this.id, 'router:ipv6-disabled', `${this.name}: IPv6 unicast routing disabled`);
  }

  isIPv6RoutingEnabled(): boolean {
    return this.ipv6Enabled;
  }

  /**
   * Configure an IPv6 address on an interface. Automatically adds connected route.
   */
  configureIPv6Interface(ifName: string, address: IPv6Address, prefixLength: number): boolean {
    const port = this.ports.get(ifName);
    if (!port) return false;

    // Enable IPv6 on the port
    port.configureIPv6(address, prefixLength);

    // Remove old connected route for this interface/prefix
    this.ipv6RoutingTable = this.ipv6RoutingTable.filter(
      r => !(r.type === 'connected' && r.iface === ifName && r.prefixLength === prefixLength)
    );

    // Add connected route
    const networkPrefix = address.getNetworkPrefix(prefixLength);
    this.ipv6RoutingTable.push({
      prefix: networkPrefix,
      prefixLength,
      nextHop: null,
      iface: ifName,
      type: 'connected',
      ad: 0,
      metric: 0,
    });

    Logger.info(this.id, 'router:ipv6-interface-config',
      `${this.name}: ${ifName} configured ${address}/${prefixLength}`);
    return true;
  }

  // ─── Routing Table Management (Control Plane — RIB) ──────────

  getRoutingTable(): RouteEntry[] {
    return [...this.routingTable];
  }

  addStaticRoute(network: IPAddress, mask: SubnetMask, nextHop: IPAddress, metric: number = 0): boolean {
    const iface = this.findInterfaceForIP(nextHop);
    if (!iface) {
      Logger.warn(this.id, 'router:route-add-fail',
        `${this.name}: next-hop ${nextHop} not reachable`);
      return false;
    }

    this.routingTable.push({
      network, mask, nextHop,
      iface: iface.getName(),
      type: 'static',
      ad: 1,
      metric,
    });

    Logger.info(this.id, 'router:route-add',
      `${this.name}: static route ${network}/${mask.toCIDR()} via ${nextHop} metric ${metric}`);
    return true;
  }

  setDefaultRoute(nextHop: IPAddress, metric: number = 0): boolean {
    this.routingTable = this.routingTable.filter(r => r.type !== 'default');
    const iface = this.findInterfaceForIP(nextHop);
    if (!iface) return false;

    this.routingTable.push({
      network: new IPAddress('0.0.0.0'),
      mask: new SubnetMask('0.0.0.0'),
      nextHop,
      iface: iface.getName(),
      type: 'default',
      ad: 1,
      metric,
    });
    return true;
  }

  /** Longest Prefix Match (LPM) — tiebreaking: prefix → AD → metric */
  private lookupRoute(destIP: IPAddress): RouteEntry | null {
    let bestRoute: RouteEntry | null = null;
    let bestPrefix = -1;
    const destInt = destIP.toUint32();

    for (const route of this.routingTable) {
      const netInt = route.network.toUint32();
      const maskInt = route.mask.toUint32();
      const prefix = route.mask.toCIDR();

      if ((destInt & maskInt) === (netInt & maskInt)) {
        if (prefix > bestPrefix) {
          bestPrefix = prefix;
          bestRoute = route;
        } else if (prefix === bestPrefix && bestRoute) {
          if (route.ad < bestRoute.ad ||
              (route.ad === bestRoute.ad && route.metric < bestRoute.metric)) {
            bestRoute = route;
          }
        }
      }
    }
    return bestRoute;
  }

  private findInterfaceForIP(targetIP: IPAddress): Port | null {
    for (const [, port] of this.ports) {
      const ip = port.getIPAddress();
      const mask = port.getSubnetMask();
      if (ip && mask && ip.isInSameSubnet(targetIP, mask)) return port;
    }
    return null;
  }

  // ─── IPv6 Routing Table Management ─────────────────────────────

  getIPv6RoutingTable(): IPv6RouteEntry[] {
    return [...this.ipv6RoutingTable];
  }

  addIPv6StaticRoute(prefix: IPv6Address, prefixLength: number, nextHop: IPv6Address, metric: number = 0): boolean {
    const iface = this.findInterfaceForIPv6(nextHop);
    if (!iface) {
      Logger.warn(this.id, 'router:ipv6-route-add-fail',
        `${this.name}: IPv6 next-hop ${nextHop} not reachable`);
      return false;
    }

    this.ipv6RoutingTable.push({
      prefix: prefix.getNetworkPrefix(prefixLength),
      prefixLength,
      nextHop,
      iface: iface.getName(),
      type: 'static',
      ad: 1,
      metric,
    });

    Logger.info(this.id, 'router:ipv6-route-add',
      `${this.name}: static route ${prefix}/${prefixLength} via ${nextHop} metric ${metric}`);
    return true;
  }

  setIPv6DefaultRoute(nextHop: IPv6Address, metric: number = 0): boolean {
    this.ipv6RoutingTable = this.ipv6RoutingTable.filter(r => r.type !== 'default');
    const iface = this.findInterfaceForIPv6(nextHop);
    if (!iface) return false;

    this.ipv6RoutingTable.push({
      prefix: new IPv6Address('::'),
      prefixLength: 0,
      nextHop,
      iface: iface.getName(),
      type: 'default',
      ad: 1,
      metric,
    });
    return true;
  }

  /** Longest Prefix Match for IPv6 */
  private lookupIPv6Route(destIP: IPv6Address): IPv6RouteEntry | null {
    let bestRoute: IPv6RouteEntry | null = null;
    let bestPrefix = -1;

    for (const route of this.ipv6RoutingTable) {
      if (destIP.isInSameSubnet(route.prefix, route.prefixLength)) {
        if (route.prefixLength > bestPrefix) {
          bestPrefix = route.prefixLength;
          bestRoute = route;
        } else if (route.prefixLength === bestPrefix && bestRoute) {
          if (route.ad < bestRoute.ad ||
              (route.ad === bestRoute.ad && route.metric < bestRoute.metric)) {
            bestRoute = route;
          }
        }
      }
    }
    return bestRoute;
  }

  private findInterfaceForIPv6(targetIP: IPv6Address): Port | null {
    for (const [, port] of this.ports) {
      if (!port.isIPv6Enabled()) continue;
      for (const entry of port.getIPv6Addresses()) {
        if (entry.address.isInSameSubnet(targetIP, entry.prefixLength)) {
          return port;
        }
      }
    }
    return null;
  }

  // ─── Neighbor Cache (NDP) ──────────────────────────────────────

  getNeighborCache(): Map<string, { mac: MACAddress; iface: string; state: NeighborState; isRouter: boolean }> {
    const result = new Map<string, { mac: MACAddress; iface: string; state: NeighborState; isRouter: boolean }>();
    for (const [key, entry] of this.neighborCache) {
      result.set(key, {
        mac: entry.mac,
        iface: entry.iface,
        state: entry.state,
        isRouter: entry.isRouter,
      });
    }
    return result;
  }

  // ─── Performance Counters ─────────────────────────────────────

  getCounters(): RouterCounters {
    return { ...this.counters };
  }

  resetCounters(): void {
    for (const key of Object.keys(this.counters) as (keyof RouterCounters)[]) {
      this.counters[key] = 0;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // RIPv2 Engine (RFC 2453)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Enable RIP and start the periodic update timer.
   * Call `ripAdvertiseNetwork()` to add networks before or after enabling.
   */
  enableRIP(config?: Partial<RIPConfig>): void {
    if (config) {
      Object.assign(this.ripConfig, config);
    }
    this.ripEnabled = true;

    // Start periodic update timer
    this.ripUpdateTimer = setInterval(() => {
      this.ripSendPeriodicUpdate();
    }, this.ripConfig.updateInterval);

    // Send an initial request on all RIP-enabled interfaces
    this.ripSendRequest();

    Logger.info(this.id, 'rip:enabled',
      `${this.name}: RIPv2 enabled, update interval ${this.ripConfig.updateInterval}ms`);
  }

  /** Disable RIP and remove all learned RIP routes. */
  disableRIP(): void {
    this.ripEnabled = false;

    if (this.ripUpdateTimer) {
      clearInterval(this.ripUpdateTimer);
      this.ripUpdateTimer = null;
    }

    // Clear all RIP route timers
    for (const [, state] of this.ripRoutes) {
      if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
      if (state.gcTimer) clearTimeout(state.gcTimer);
    }
    this.ripRoutes.clear();

    // Remove RIP routes from RIB
    this.routingTable = this.routingTable.filter(r => r.type !== 'rip');

    Logger.info(this.id, 'rip:disabled', `${this.name}: RIPv2 disabled`);
  }

  /** Check if RIP is enabled */
  isRIPEnabled(): boolean { return this.ripEnabled; }

  /** Get RIP configuration (read-only copy) */
  getRIPConfig(): RIPConfig { return { ...this.ripConfig, networks: [...this.ripConfig.networks] }; }

  /** Get RIP route states for debugging/display */
  getRIPRoutes(): Map<string, { metric: number; learnedFrom: string; age: number; garbageCollect: boolean }> {
    const result = new Map<string, { metric: number; learnedFrom: string; age: number; garbageCollect: boolean }>();
    for (const [key, state] of this.ripRoutes) {
      result.set(key, {
        metric: state.route.metric,
        learnedFrom: state.learnedFrom,
        age: Math.floor((Date.now() - state.lastUpdate) / 1000),
        garbageCollect: state.garbageCollect,
      });
    }
    return result;
  }

  /**
   * Add a network to the RIP advertisement list.
   * This tells RIP which connected networks to advertise.
   */
  ripAdvertiseNetwork(network: IPAddress, mask: SubnetMask): void {
    this.ripConfig.networks.push({ network, mask });
  }

  /** Check if an interface participates in RIP (its connected network is in the RIP network list) */
  private isRIPInterface(portName: string): boolean {
    const port = this.ports.get(portName);
    if (!port) return false;
    const ip = port.getIPAddress();
    const portMask = port.getSubnetMask();
    if (!ip || !portMask) return false;

    const portNetInt = ip.toUint32() & portMask.toUint32();

    for (const net of this.ripConfig.networks) {
      const cfgNetInt = net.network.toUint32() & net.mask.toUint32();
      const cfgMaskInt = net.mask.toUint32();
      // Interface matches if its network is within the configured RIP network
      if ((portNetInt & cfgMaskInt) === cfgNetInt) return true;
    }
    return false;
  }

  // ─── RIP: Send Request (RFC 2453 §3.9.1) ──────────────────────

  /** Send a RIP Request on all RIP-enabled interfaces (used at startup) */
  private ripSendRequest(): void {
    const request: RIPPacket = {
      type: 'rip',
      command: 1, // Request
      version: 2,
      entries: [{
        afi: 0, routeTag: 0,
        ipAddress: new IPAddress('0.0.0.0'),
        subnetMask: new SubnetMask('0.0.0.0'),
        nextHop: new IPAddress('0.0.0.0'),
        metric: RIP_METRIC_INFINITY,
      }],
    };

    for (const [portName] of this.ports) {
      if (!this.isRIPInterface(portName)) continue;
      this.ripSendPacket(portName, request);
    }
  }

  // ─── RIP: Periodic Update (RFC 2453 §3.9.2) ──────────────────

  /** Send a full routing table update on all RIP-enabled interfaces */
  private ripSendPeriodicUpdate(): void {
    if (!this.ripEnabled) return;

    for (const [portName] of this.ports) {
      if (!this.isRIPInterface(portName)) continue;
      this.ripSendUpdate(portName);
    }
  }

  /** Send a RIP update (Response) on a specific interface, applying split horizon */
  private ripSendUpdate(outIface: string): void {
    const entries: RIPRouteEntry[] = [];

    for (const route of this.routingTable) {
      // Skip RIP-infinity routes (being garbage-collected)
      if (route.type === 'rip' && route.metric >= RIP_METRIC_INFINITY) continue;

      // Split horizon with poisoned reverse (RFC 2453 §3.5)
      if (this.ripConfig.splitHorizon && route.iface === outIface) {
        if (this.ripConfig.poisonedReverse && route.type === 'rip') {
          // Advertise with metric 16 (infinity) — poisoned reverse
          entries.push(this.routeToRIPEntry(route, RIP_METRIC_INFINITY));
        }
        // Plain split horizon: don't advertise routes learned from this interface
        continue;
      }

      // Advertise the route with metric + 1 (for non-connected routes, use actual metric)
      const metric = route.type === 'connected' ? 1 : Math.min(route.metric + 1, RIP_METRIC_INFINITY);
      entries.push(this.routeToRIPEntry(route, metric));
    }

    // Split into multiple messages if > 25 entries (RFC 2453 §4)
    for (let i = 0; i < entries.length; i += RIP_MAX_ENTRIES_PER_MESSAGE) {
      const chunk = entries.slice(i, i + RIP_MAX_ENTRIES_PER_MESSAGE);
      const response: RIPPacket = {
        type: 'rip',
        command: 2, // Response
        version: 2,
        entries: chunk,
      };
      this.ripSendPacket(outIface, response);
    }
  }

  /** Triggered update: send only changed routes (RFC 2453 §3.9.3) */
  private ripSendTriggeredUpdate(changedRoute: RouteEntry): void {
    if (!this.ripEnabled) return;

    for (const [portName] of this.ports) {
      if (!this.isRIPInterface(portName)) continue;

      // Split horizon check
      if (this.ripConfig.splitHorizon && changedRoute.iface === portName) {
        if (this.ripConfig.poisonedReverse && changedRoute.type === 'rip') {
          const entry = this.routeToRIPEntry(changedRoute, RIP_METRIC_INFINITY);
          this.ripSendPacket(portName, {
            type: 'rip', command: 2, version: 2, entries: [entry],
          });
        }
        continue;
      }

      const metric = changedRoute.type === 'connected' ? 1
        : Math.min(changedRoute.metric + 1, RIP_METRIC_INFINITY);
      const entry = this.routeToRIPEntry(changedRoute, metric);
      this.ripSendPacket(portName, {
        type: 'rip', command: 2, version: 2, entries: [entry],
      });
    }
  }

  /** Convert a RouteEntry to a RIPRouteEntry for advertisement */
  private routeToRIPEntry(route: RouteEntry, metric: number): RIPRouteEntry {
    return {
      afi: 2, // IPv4
      routeTag: 0,
      ipAddress: route.network,
      subnetMask: route.mask,
      nextHop: new IPAddress('0.0.0.0'), // 0.0.0.0 = use sender as next-hop
      metric,
    };
  }

  /** Encapsulate a RIP packet in UDP/IPv4 and send it as broadcast on an interface */
  private ripSendPacket(outIface: string, ripPkt: RIPPacket): void {
    const port = this.ports.get(outIface);
    if (!port) return;
    const myIP = port.getIPAddress();
    if (!myIP) return;

    // RIP message size: 4 bytes header + 20 bytes per entry
    const ripSize = 4 + ripPkt.entries.length * 20;

    const udpPkt: UDPPacket = {
      type: 'udp',
      sourcePort: UDP_PORT_RIP,
      destinationPort: UDP_PORT_RIP,
      length: 8 + ripSize, // UDP header (8) + RIP message
      checksum: 0, // UDP checksum optional for IPv4
      payload: ripPkt,
    };

    const ipPkt = createIPv4Packet(
      myIP,
      new IPAddress('255.255.255.255'), // Broadcast (multicast 224.0.0.9 not supported)
      IP_PROTO_UDP,
      1, // TTL=1 for RIP (link-local only)
      udpPkt,
      8 + ripSize, // UDP header + RIP payload
    );

    this.sendFrame(outIface, {
      srcMAC: port.getMAC(),
      dstMAC: MACAddress.broadcast(),
      etherType: ETHERTYPE_IPV4,
      payload: ipPkt,
    });

    Logger.debug(this.id, 'rip:send',
      `${this.name}: RIP ${ripPkt.command === 1 ? 'Request' : 'Response'} sent on ${outIface} (${ripPkt.entries.length} entries)`);
  }

  // ─── RIP: Process Incoming (RFC 2453 §3.9.2) ──────────────────

  /** Handle an incoming RIP packet (called from handleLocalDelivery) */
  private ripProcessPacket(inPort: string, srcIP: IPAddress, ripPkt: RIPPacket): void {
    if (!this.ripEnabled) return;
    if (!this.isRIPInterface(inPort)) return;

    if (ripPkt.command === 1) {
      // Request: send our full table back
      this.ripSendUpdate(inPort);
      return;
    }

    if (ripPkt.command === 2) {
      // Response: process each route entry
      for (const entry of ripPkt.entries) {
        this.ripProcessRouteEntry(inPort, srcIP, entry);
      }
    }
  }

  /**
   * Process a single RIP route entry from a Response (RFC 2453 §3.9.2).
   *
   * Algorithm:
   *   1. Validate entry (AFI=2, metric 1-16)
   *   2. Add cost of this hop: metric = min(entry.metric + 0, 16)
   *      (cost already includes sender's +1, we don't add again for received routes)
   *      Actually per RFC 2453 §3.9.2 step 4: metric = min(entry.metric + cost_to_neighbor, 16)
   *      where cost_to_neighbor is typically 1 for directly connected.
   *   3. Lookup existing route for this prefix
   *   4. If no existing route and metric < 16: install new RIP route
   *   5. If existing route from same neighbor: update metric, reset timeout
   *   6. If existing route from different neighbor and new metric is better: replace
   */
  private ripProcessRouteEntry(inPort: string, srcIP: IPAddress, entry: RIPRouteEntry): void {
    // Validate
    if (entry.afi !== 2 && entry.afi !== 0) return;
    if (entry.metric < 1 || entry.metric > RIP_METRIC_INFINITY) return;

    // Add cost to reach this neighbor (always 1 for directly connected)
    const newMetric = Math.min(entry.metric, RIP_METRIC_INFINITY);

    const key = `${entry.ipAddress}/${entry.subnetMask.toCIDR()}`;
    const existing = this.ripRoutes.get(key);

    // Don't install routes for our own connected networks
    for (const route of this.routingTable) {
      if (route.type === 'connected' &&
          route.network.equals(entry.ipAddress) &&
          route.mask.toCIDR() === entry.subnetMask.toCIDR()) {
        return;
      }
    }

    if (!existing) {
      // No existing RIP route for this prefix
      if (newMetric < RIP_METRIC_INFINITY) {
        this.ripInstallRoute(key, entry, newMetric, srcIP, inPort);
      }
      return;
    }

    // Existing route exists
    if (existing.learnedFrom === srcIP.toString()) {
      // Same neighbor: always update (even if metric worsened)
      if (newMetric >= RIP_METRIC_INFINITY) {
        // Route withdrawn — start garbage collection
        this.ripInvalidateRoute(key, existing);
      } else {
        // Refresh the route
        existing.route.metric = newMetric;
        existing.lastUpdate = Date.now();
        existing.garbageCollect = false;
        this.ripResetTimeout(key, existing);

        // Update RIB
        this.ripUpdateRIB(key, existing);
      }
    } else {
      // Different neighbor: only replace if strictly better metric
      if (newMetric < existing.route.metric) {
        // Clear old timers
        if (existing.timeoutTimer) clearTimeout(existing.timeoutTimer);
        if (existing.gcTimer) clearTimeout(existing.gcTimer);

        // Remove old from RIB
        this.routingTable = this.routingTable.filter(r =>
          !(r.type === 'rip' && r.network.equals(entry.ipAddress) && r.mask.toCIDR() === entry.subnetMask.toCIDR())
        );

        // Install new
        this.ripInstallRoute(key, entry, newMetric, srcIP, inPort);
      }
    }
  }

  /** Install a new RIP route into the RIB */
  private ripInstallRoute(key: string, entry: RIPRouteEntry, metric: number, srcIP: IPAddress, inPort: string): void {
    const route: RouteEntry = {
      network: entry.ipAddress,
      mask: entry.subnetMask,
      nextHop: srcIP,
      iface: inPort,
      type: 'rip',
      ad: 120, // RIP administrative distance
      metric,
    };

    this.routingTable.push(route);

    const state: RIPRouteState = {
      route,
      lastUpdate: Date.now(),
      learnedFrom: srcIP.toString(),
      learnedOnIface: inPort,
      garbageCollect: false,
      timeoutTimer: null,
      gcTimer: null,
    };
    this.ripRoutes.set(key, state);
    this.ripResetTimeout(key, state);

    Logger.info(this.id, 'rip:route-learned',
      `${this.name}: RIP learned ${key} via ${srcIP} metric ${metric}`);
  }

  /** Update the RIB entry for an existing RIP route */
  private ripUpdateRIB(key: string, state: RIPRouteState): void {
    const idx = this.routingTable.findIndex(r =>
      r.type === 'rip' &&
      r.network.equals(state.route.network) &&
      r.mask.toCIDR() === state.route.mask.toCIDR()
    );
    if (idx >= 0) {
      this.routingTable[idx] = state.route;
    }
  }

  /** Invalidate a RIP route (set metric=16, start garbage collection timer) */
  private ripInvalidateRoute(key: string, state: RIPRouteState): void {
    state.route.metric = RIP_METRIC_INFINITY;
    state.garbageCollect = true;
    state.lastUpdate = Date.now();

    // Cancel timeout timer
    if (state.timeoutTimer) {
      clearTimeout(state.timeoutTimer);
      state.timeoutTimer = null;
    }

    // Update RIB
    this.ripUpdateRIB(key, state);

    // Send triggered update (poison)
    this.ripSendTriggeredUpdate(state.route);

    // Start garbage collection timer
    state.gcTimer = setTimeout(() => {
      this.ripGarbageCollect(key);
    }, this.ripConfig.gcTimeout);

    Logger.info(this.id, 'rip:route-invalidated',
      `${this.name}: RIP route ${key} invalidated (metric=16)`);
  }

  /** Remove a garbage-collected route */
  private ripGarbageCollect(key: string): void {
    const state = this.ripRoutes.get(key);
    if (!state) return;

    if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
    if (state.gcTimer) clearTimeout(state.gcTimer);

    this.ripRoutes.delete(key);
    this.routingTable = this.routingTable.filter(r =>
      !(r.type === 'rip' && r.network.equals(state.route.network) && r.mask.toCIDR() === state.route.mask.toCIDR())
    );

    Logger.info(this.id, 'rip:route-gc',
      `${this.name}: RIP route ${key} garbage-collected`);
  }

  /** Reset/start the timeout timer for a RIP route */
  private ripResetTimeout(key: string, state: RIPRouteState): void {
    if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
    if (state.gcTimer) {
      clearTimeout(state.gcTimer);
      state.gcTimer = null;
    }

    state.timeoutTimer = setTimeout(() => {
      this.ripInvalidateRoute(key, state);
    }, this.ripConfig.routeTimeout);
  }

  // ─── Data Plane: Phase A — Frame Handling (L2 → dispatch) ─────

  protected handleFrame(portName: string, frame: EthernetFrame): void {
    const port = this.ports.get(portName);
    if (!port) return;

    // Phase A.1: L2 Filter — accept unicast for us, broadcast, or multicast
    const isForUs = frame.dstMAC.equals(port.getMAC());
    const isBroadcast = frame.dstMAC.isBroadcast();
    const octets = frame.dstMAC.getOctets();
    const isMulticast = octets[0] === 0x33 && octets[1] === 0x33; // IPv6 multicast MAC

    if (!isForUs && !isBroadcast && !isMulticast) {
      return;
    }

    // Phase A.2: EtherType dispatch
    if (frame.etherType === ETHERTYPE_ARP) {
      this.handleARP(portName, frame.payload as ARPPacket);
    } else if (frame.etherType === ETHERTYPE_IPV4) {
      this.counters.ifInOctets += (frame.payload as IPv4Packet)?.totalLength || 0;
      this.processIPv4(portName, frame.payload as IPv4Packet);
    } else if (frame.etherType === ETHERTYPE_IPV6) {
      if (this.ipv6Enabled || isMulticast) {
        this.processIPv6(portName, frame.payload as IPv6Packet);
      }
    }
  }

  // ─── Control Plane: ARP Handling ──────────────────────────────

  private handleARP(portName: string, arp: ARPPacket): void {
    if (!arp || arp.type !== 'arp') return;
    const port = this.ports.get(portName);
    if (!port) return;
    const myIP = port.getIPAddress();
    if (!myIP) return;

    // Learn sender
    this.arpTable.set(arp.senderIP.toString(), {
      mac: arp.senderMAC, iface: portName, timestamp: Date.now(),
    });

    if (arp.operation === 'request' && arp.targetIP.equals(myIP)) {
      const reply: ARPPacket = {
        type: 'arp', operation: 'reply',
        senderMAC: port.getMAC(), senderIP: myIP,
        targetMAC: arp.senderMAC, targetIP: arp.senderIP,
      };
      this.sendFrame(portName, {
        srcMAC: port.getMAC(), dstMAC: arp.senderMAC,
        etherType: ETHERTYPE_ARP, payload: reply,
      });
    } else if (arp.operation === 'reply') {
      const key = arp.senderIP.toString();
      const pending = this.pendingARPs.get(key);
      if (pending) {
        for (const p of pending) { clearTimeout(p.timer); p.resolve(arp.senderMAC); }
        this.pendingARPs.delete(key);
      }
      this.flushPacketQueue(arp.senderIP, arp.senderMAC);
    }
  }

  // ─── Data Plane: Phase B+C — IPv4 Processing ──────────────────

  private processIPv4(inPort: string, ipPkt: IPv4Packet): void {
    if (!ipPkt || ipPkt.type !== 'ipv4') return;

    // Phase B: L3 Header Sanity Check (RFC 1812 §5.2.2)

    // B.1: Checksum verification
    if (!verifyIPv4Checksum(ipPkt)) {
      this.counters.ipInHdrErrors++;
      Logger.warn(this.id, 'router:checksum-fail',
        `${this.name}: invalid IPv4 checksum, dropping`);
      return;
    }

    // B.2: Version check — must be 4
    if (ipPkt.version !== 4) {
      this.counters.ipInHdrErrors++;
      Logger.warn(this.id, 'router:version-fail',
        `${this.name}: IPv4 version ${ipPkt.version} != 4, dropping`);
      return;
    }

    // B.3: IHL check — must be >= 5 (20 bytes minimum header)
    if (ipPkt.ihl < 5) {
      this.counters.ipInHdrErrors++;
      Logger.warn(this.id, 'router:ihl-fail',
        `${this.name}: IHL ${ipPkt.ihl} < 5, dropping`);
      return;
    }

    // B.4: TotalLength check — must be at least IHL*4
    if (ipPkt.totalLength < ipPkt.ihl * 4) {
      this.counters.ipInHdrErrors++;
      Logger.warn(this.id, 'router:length-fail',
        `${this.name}: totalLength ${ipPkt.totalLength} < header ${ipPkt.ihl * 4}, dropping`);
      return;
    }

    // Phase C: Forwarding Decision

    // C.1: Is this packet for us? (any interface IP or broadcast)
    const destIP = ipPkt.destinationIP;
    const isBroadcast = destIP.toString() === '255.255.255.255';

    if (!isBroadcast) {
      for (const [, port] of this.ports) {
        const myIP = port.getIPAddress();
        if (myIP && destIP.equals(myIP)) {
          this.handleLocalDelivery(inPort, ipPkt);
          return;
        }
      }
    } else {
      // Broadcast packet — deliver locally
      this.handleLocalDelivery(inPort, ipPkt);
      return;
    }

    // C.2: Not for us → forward via FIB
    this.forwardPacket(inPort, ipPkt);
  }

  /**
   * Control Plane: Handle packets addressed to our interface IPs.
   * Supports: ICMP echo-request → echo-reply, UDP/RIP.
   */
  private handleLocalDelivery(inPort: string, ipPkt: IPv4Packet): void {
    if (ipPkt.protocol === IP_PROTO_ICMP) {
      const icmp = ipPkt.payload as ICMPPacket;
      if (!icmp || icmp.type !== 'icmp') return;

      if (icmp.icmpType === 'echo-request') {
        const port = this.ports.get(inPort);
        if (!port) return;
        const myIP = port.getIPAddress();
        if (!myIP) return;

        const replyICMP: ICMPPacket = {
          type: 'icmp', icmpType: 'echo-reply', code: 0,
          id: icmp.id, sequence: icmp.sequence, dataSize: icmp.dataSize,
        };

        const replyIP = createIPv4Packet(
          myIP, ipPkt.sourceIP, IP_PROTO_ICMP, this.defaultTTL,
          replyICMP, 8 + icmp.dataSize,
        );

        const targetMAC = this.arpTable.get(ipPkt.sourceIP.toString());
        if (targetMAC) {
          this.counters.icmpOutEchoReps++;
          this.counters.icmpOutMsgs++;
          this.counters.ifOutOctets += replyIP.totalLength;
          this.sendFrame(inPort, {
            srcMAC: port.getMAC(), dstMAC: targetMAC.mac,
            etherType: ETHERTYPE_IPV4, payload: replyIP,
          });
        }
      }
    } else if (ipPkt.protocol === IP_PROTO_UDP) {
      const udp = ipPkt.payload as UDPPacket;
      if (!udp || udp.type !== 'udp') return;

      // Dispatch by destination port
      if (udp.destinationPort === UDP_PORT_RIP) {
        const rip = udp.payload as RIPPacket;
        if (!rip || rip.type !== 'rip') return;
        this.ripProcessPacket(inPort, ipPkt.sourceIP, rip);
      }
      // Other UDP ports silently dropped (no DNS/DHCP/etc. yet)
    }
  }

  // ─── Data Plane: Phase D+E — Forwarding Engine ────────────────

  /**
   * Forward an IPv4 packet to the next hop.
   * Implements the full RFC 1812 forwarding pipeline.
   */
  private forwardPacket(inPort: string, ipPkt: IPv4Packet): void {
    // Phase D.1: TTL Decrement
    const newTTL = ipPkt.ttl - 1;
    if (newTTL <= 0) {
      Logger.info(this.id, 'router:ttl-expired',
        `${this.name}: TTL expired for packet from ${ipPkt.sourceIP} to ${ipPkt.destinationIP}`);
      this.sendICMPError(inPort, ipPkt, 'time-exceeded', 0);
      return;
    }

    // Phase C.2: FIB lookup (LPM)
    const route = this.lookupRoute(ipPkt.destinationIP);
    if (!route) {
      this.counters.ipInAddrErrors++;
      Logger.info(this.id, 'router:no-route',
        `${this.name}: no route for ${ipPkt.destinationIP}`);
      this.sendICMPError(inPort, ipPkt, 'destination-unreachable', 0);
      return;
    }

    // Phase D.2: Header mutation — create forwarded packet with new TTL + checksum
    const fwdPkt: IPv4Packet = {
      ...ipPkt,
      ttl: newTTL,
      headerChecksum: 0,
    };
    fwdPkt.headerChecksum = computeIPv4Checksum(fwdPkt);

    // Phase E.1: MTU check
    if (fwdPkt.totalLength > this.interfaceMTU) {
      // Check Don't Fragment flag (bit 1 of flags field, 0b010 = DF set)
      const dfSet = (fwdPkt.flags & 0b010) !== 0;
      if (dfSet) {
        // ICMP Type 3, Code 4: Fragmentation Needed and DF Set
        Logger.info(this.id, 'router:mtu-exceeded',
          `${this.name}: packet ${fwdPkt.totalLength} > MTU ${this.interfaceMTU}, DF=1`);
        this.sendICMPError(inPort, ipPkt, 'destination-unreachable', 4);
        return;
      }
      // If DF=0, we would fragment — not implemented in this simulator
    }

    // Phase E.2: Determine next-hop IP
    const nextHopIP = route.nextHop || ipPkt.destinationIP;
    const outPort = this.ports.get(route.iface);
    if (!outPort) return;

    // Phase E.3: ARP resolve next-hop → L2 rewrite → send
    const cached = this.arpTable.get(nextHopIP.toString());
    if (cached) {
      this.counters.ipForwDatagrams++;
      this.counters.ifOutOctets += fwdPkt.totalLength;
      this.sendFrame(route.iface, {
        srcMAC: outPort.getMAC(), dstMAC: cached.mac,
        etherType: ETHERTYPE_IPV4, payload: fwdPkt,
      });
    } else {
      this.queueAndResolve(fwdPkt, route.iface, nextHopIP, outPort);
    }
  }

  // ─── ICMP Error Generation (Control Plane) ────────────────────

  /**
   * Send an ICMP error message back to the source of the offending packet.
   * Supports: Time Exceeded (Type 11), Destination Unreachable (Type 3).
   */
  private sendICMPError(
    inPort: string,
    offendingPkt: IPv4Packet,
    icmpType: 'time-exceeded' | 'destination-unreachable',
    code: number,
  ): void {
    const port = this.ports.get(inPort);
    if (!port) return;
    const myIP = port.getIPAddress();
    if (!myIP) return;

    const icmpError: ICMPPacket = {
      type: 'icmp', icmpType, code,
      id: 0, sequence: 0, dataSize: 0,
    };

    const errorIP = createIPv4Packet(
      myIP, offendingPkt.sourceIP, IP_PROTO_ICMP, this.defaultTTL,
      icmpError, 8,
    );

    // Update counters
    this.counters.icmpOutMsgs++;
    if (icmpType === 'time-exceeded') this.counters.icmpOutTimeExcds++;
    if (icmpType === 'destination-unreachable') this.counters.icmpOutDestUnreachs++;

    const targetMAC = this.arpTable.get(offendingPkt.sourceIP.toString());
    if (targetMAC) {
      this.counters.ifOutOctets += errorIP.totalLength;
      this.sendFrame(inPort, {
        srcMAC: port.getMAC(), dstMAC: targetMAC.mac,
        etherType: ETHERTYPE_IPV4, payload: errorIP,
      });
    } else {
      this.queueAndResolve(errorIP, inPort, offendingPkt.sourceIP, port);
    }
  }

  // ─── ARP Resolution + Packet Queue ────────────────────────────

  private queueAndResolve(pkt: IPv4Packet, iface: string, nextHopIP: IPAddress, port: Port): void {
    const timer = setTimeout(() => {
      this.packetQueue = this.packetQueue.filter(
        q => !(q.nextHopIP.equals(nextHopIP) && q.outIface === iface)
      );
    }, 2000);

    this.packetQueue.push({ frame: pkt, outIface: iface, nextHopIP, timer });

    const key = nextHopIP.toString();
    if (!this.pendingARPs.has(key)) {
      this.pendingARPs.set(key, []);
      const myIP = port.getIPAddress()!;
      const arpReq: ARPPacket = {
        type: 'arp', operation: 'request',
        senderMAC: port.getMAC(), senderIP: myIP,
        targetMAC: MACAddress.broadcast(), targetIP: nextHopIP,
      };
      this.sendFrame(iface, {
        srcMAC: port.getMAC(), dstMAC: MACAddress.broadcast(),
        etherType: ETHERTYPE_ARP, payload: arpReq,
      });
    }
  }

  private flushPacketQueue(resolvedIP: IPAddress, resolvedMAC: MACAddress): void {
    const ready = this.packetQueue.filter(q => q.nextHopIP.equals(resolvedIP));
    this.packetQueue = this.packetQueue.filter(q => !q.nextHopIP.equals(resolvedIP));

    for (const q of ready) {
      clearTimeout(q.timer);
      const outPort = this.ports.get(q.outIface);
      if (outPort) {
        this.counters.ipForwDatagrams++;
        this.counters.ifOutOctets += q.frame.totalLength;
        this.sendFrame(q.outIface, {
          srcMAC: outPort.getMAC(), dstMAC: resolvedMAC,
          etherType: ETHERTYPE_IPV4, payload: q.frame,
        });
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // IPv6 Data Plane (RFC 8200)
  // ═══════════════════════════════════════════════════════════════════

  private processIPv6(inPort: string, ipv6: IPv6Packet): void {
    if (!ipv6 || ipv6.type !== 'ipv6') return;

    const port = this.ports.get(inPort);
    if (!port) return;

    // Check if packet is for us
    const destIP = ipv6.destinationIP;
    let isForUs = false;

    // Check all our interface addresses
    for (const [, p] of this.ports) {
      if (p.hasIPv6Address(destIP)) {
        isForUs = true;
        break;
      }
    }

    // Check for multicast we should handle
    const isAllNodesMulticast = destIP.isAllNodesMulticast();
    const isAllRoutersMulticast = destIP.isAllRoutersMulticast();
    const isSolicitedNode = destIP.isSolicitedNodeMulticast();

    if (isForUs || isAllNodesMulticast || isAllRoutersMulticast) {
      this.handleIPv6LocalDelivery(inPort, ipv6);
      return;
    }

    // Solicited-node multicast — check if target matches our address
    if (isSolicitedNode) {
      if (this.shouldAcceptSolicitedNode(destIP)) {
        this.handleIPv6LocalDelivery(inPort, ipv6);
        return;
      }
    }

    // Not for us and routing is enabled — forward
    if (this.ipv6Enabled) {
      this.forwardIPv6Packet(inPort, ipv6);
    }
  }

  private shouldAcceptSolicitedNode(destIP: IPv6Address): boolean {
    const destHextets = destIP.getHextets();
    const low24 = ((destHextets[6] & 0xff) << 16) | destHextets[7];

    for (const [, port] of this.ports) {
      for (const entry of port.getIPv6Addresses()) {
        const addrHextets = entry.address.getHextets();
        const addrLow24 = ((addrHextets[6] & 0xff) << 16) | addrHextets[7];
        if (low24 === addrLow24) return true;
      }
    }
    return false;
  }

  private handleIPv6LocalDelivery(inPort: string, ipv6: IPv6Packet): void {
    if (ipv6.nextHeader === IP_PROTO_ICMPV6) {
      this.handleICMPv6(inPort, ipv6);
    }
    // Future: TCP, UDP for IPv6
  }

  private handleICMPv6(inPort: string, ipv6: IPv6Packet): void {
    const icmpv6 = ipv6.payload as ICMPv6Packet;
    if (!icmpv6 || icmpv6.type !== 'icmpv6') return;

    switch (icmpv6.icmpType) {
      case 'echo-request':
        this.handleICMPv6EchoRequest(inPort, ipv6, icmpv6);
        break;
      case 'neighbor-solicitation':
        this.handleNeighborSolicitation(inPort, ipv6, icmpv6);
        break;
      case 'neighbor-advertisement':
        this.handleNeighborAdvertisement(inPort, ipv6, icmpv6);
        break;
      case 'router-solicitation':
        this.handleRouterSolicitation(inPort, ipv6, icmpv6);
        break;
    }
  }

  private handleICMPv6EchoRequest(inPort: string, ipv6: IPv6Packet, icmpv6: ICMPv6Packet): void {
    const port = this.ports.get(inPort);
    if (!port) return;

    // Determine source address for reply
    let srcIP: IPv6Address | null = null;
    if (ipv6.destinationIP.isLinkLocal()) {
      srcIP = port.getLinkLocalIPv6();
    } else {
      srcIP = port.getGlobalIPv6() || port.getLinkLocalIPv6();
    }
    if (!srcIP) return;

    const reply = createICMPv6EchoReply(icmpv6.id || 0, icmpv6.sequence || 0, icmpv6.dataSize || 56);
    const replyPkt = createIPv6Packet(
      srcIP,
      ipv6.sourceIP,
      IP_PROTO_ICMPV6,
      this.defaultHopLimit,
      reply,
      8 + (icmpv6.dataSize || 56),
    );

    // Get destination MAC from neighbor cache
    const cached = this.neighborCache.get(ipv6.sourceIP.toString());
    if (cached) {
      this.sendFrame(inPort, {
        srcMAC: port.getMAC(),
        dstMAC: cached.mac,
        etherType: ETHERTYPE_IPV6,
        payload: replyPkt,
      });
    }
  }

  // ─── NDP: Neighbor Solicitation (RFC 4861) ──────────────────────

  private handleNeighborSolicitation(inPort: string, ipv6: IPv6Packet, icmpv6: ICMPv6Packet): void {
    const ns = icmpv6.ndp as NDPNeighborSolicitation;
    if (!ns || ns.ndpType !== 'neighbor-solicitation') return;

    const port = this.ports.get(inPort);
    if (!port) return;

    // Check if the target address is ours
    if (!port.hasIPv6Address(ns.targetAddress)) return;

    // Learn source's link-layer address
    const srcLLOpt = ns.options.find(o => o.optionType === 'source-link-layer');
    if (srcLLOpt && srcLLOpt.optionType === 'source-link-layer' && !ipv6.sourceIP.isUnspecified()) {
      this.neighborCache.set(ipv6.sourceIP.toString(), {
        mac: srcLLOpt.address,
        iface: inPort,
        state: 'stale',
        isRouter: false,
        timestamp: Date.now(),
      });
    }

    // Send Neighbor Advertisement
    const na = createNeighborAdvertisement(ns.targetAddress, port.getMAC(), {
      router: true, // We are a router
      solicited: true,
      override: true,
    });

    let dstIP: IPv6Address;
    let dstMAC: MACAddress;

    if (ipv6.sourceIP.isUnspecified()) {
      // DAD probe — respond to all-nodes multicast
      dstIP = IPV6_ALL_NODES_MULTICAST;
      dstMAC = dstIP.toMulticastMAC();
    } else {
      dstIP = ipv6.sourceIP;
      const cached = this.neighborCache.get(ipv6.sourceIP.toString());
      dstMAC = cached?.mac || (srcLLOpt as { address: MACAddress })?.address;
      if (!dstMAC) return;
    }

    const naPkt = createIPv6Packet(ns.targetAddress, dstIP, IP_PROTO_ICMPV6, 255, na, 32);

    this.sendFrame(inPort, {
      srcMAC: port.getMAC(),
      dstMAC,
      etherType: ETHERTYPE_IPV6,
      payload: naPkt,
    });
  }

  // ─── NDP: Neighbor Advertisement ────────────────────────────────

  private handleNeighborAdvertisement(inPort: string, ipv6: IPv6Packet, icmpv6: ICMPv6Packet): void {
    const na = icmpv6.ndp as NDPNeighborAdvertisement;
    if (!na || na.ndpType !== 'neighbor-advertisement') return;

    const tgtLLOpt = na.options.find(o => o.optionType === 'target-link-layer');
    if (!tgtLLOpt || tgtLLOpt.optionType !== 'target-link-layer') return;

    const mac = tgtLLOpt.address;
    const key = na.targetAddress.toString();

    this.neighborCache.set(key, {
      mac,
      iface: inPort,
      state: na.solicitedFlag ? 'reachable' : 'stale',
      isRouter: na.routerFlag,
      timestamp: Date.now(),
    });

    // Resolve pending NDP requests
    const pending = this.pendingNDPs.get(key);
    if (pending) {
      for (const p of pending) {
        clearTimeout(p.timer);
        p.resolve(mac);
      }
      this.pendingNDPs.delete(key);
    }

    // Flush queued packets
    this.flushIPv6PacketQueue(na.targetAddress, mac);
  }

  // ─── NDP: Router Solicitation (RFC 4861 §6.2.6) ─────────────────

  private handleRouterSolicitation(inPort: string, ipv6: IPv6Packet, icmpv6: ICMPv6Packet): void {
    if (!this.ipv6Enabled) return;

    const rs = icmpv6.ndp as NDPRouterSolicitation;
    if (!rs || rs.ndpType !== 'router-solicitation') return;

    const port = this.ports.get(inPort);
    if (!port || !port.isIPv6Enabled()) return;

    // Learn source's link-layer address
    const srcLLOpt = rs.options.find(o => o.optionType === 'source-link-layer');
    if (srcLLOpt && srcLLOpt.optionType === 'source-link-layer' && !ipv6.sourceIP.isUnspecified()) {
      this.neighborCache.set(ipv6.sourceIP.toString(), {
        mac: srcLLOpt.address,
        iface: inPort,
        state: 'stale',
        isRouter: false,
        timestamp: Date.now(),
      });
    }

    // Send Router Advertisement
    this.sendRouterAdvertisement(inPort, ipv6.sourceIP.isUnspecified() ? null : ipv6.sourceIP);
  }

  // ─── Router Advertisement ───────────────────────────────────────

  /**
   * Configure Router Advertisement on an interface.
   */
  configureRA(ifName: string, config: Partial<RAConfig>): void {
    const existing = this.raConfig.get(ifName) || {
      enabled: true,
      interval: 200000,
      curHopLimit: 64,
      managedFlag: false,
      otherConfigFlag: false,
      routerLifetime: 1800,
      prefixes: [],
    };

    const newConfig = { ...existing, ...config };
    this.raConfig.set(ifName, newConfig);

    // Stop existing timer
    const existingTimer = this.raTimers.get(ifName);
    if (existingTimer) {
      clearInterval(existingTimer);
      this.raTimers.delete(ifName);
    }

    // Start new timer if enabled
    if (newConfig.enabled && this.ipv6Enabled) {
      const timer = setInterval(() => {
        this.sendRouterAdvertisement(ifName, null);
      }, newConfig.interval);
      this.raTimers.set(ifName, timer);
    }
  }

  /**
   * Add a prefix to advertise on an interface.
   */
  addRAPrefix(ifName: string, prefix: IPv6Address, prefixLength: number, options?: {
    onLink?: boolean;
    autonomous?: boolean;
    validLifetime?: number;
    preferredLifetime?: number;
  }): void {
    const config = this.raConfig.get(ifName);
    if (!config) {
      this.configureRA(ifName, {
        prefixes: [{
          prefix: prefix.getNetworkPrefix(prefixLength),
          prefixLength,
          onLink: options?.onLink ?? true,
          autonomous: options?.autonomous ?? true,
          validLifetime: options?.validLifetime ?? 2592000,
          preferredLifetime: options?.preferredLifetime ?? 604800,
        }],
      });
    } else {
      config.prefixes.push({
        prefix: prefix.getNetworkPrefix(prefixLength),
        prefixLength,
        onLink: options?.onLink ?? true,
        autonomous: options?.autonomous ?? true,
        validLifetime: options?.validLifetime ?? 2592000,
        preferredLifetime: options?.preferredLifetime ?? 604800,
      });
    }
  }

  private sendRouterAdvertisement(ifName: string, destIP: IPv6Address | null): void {
    const port = this.ports.get(ifName);
    if (!port || !port.isIPv6Enabled()) return;

    const config = this.raConfig.get(ifName);
    const srcIP = port.getLinkLocalIPv6();
    if (!srcIP) return;

    // Gather prefixes from config or from interface addresses
    const prefixes = config?.prefixes || [];

    // If no explicit prefixes configured, advertise interface's global prefixes
    if (prefixes.length === 0) {
      for (const entry of port.getIPv6Addresses()) {
        if (entry.origin !== 'link-local' && entry.address.isGlobalUnicast()) {
          prefixes.push({
            prefix: entry.address.getNetworkPrefix(entry.prefixLength),
            prefixLength: entry.prefixLength,
            onLink: true,
            autonomous: true,
            validLifetime: 2592000,
            preferredLifetime: 604800,
          });
        }
      }
    }

    const ra = createRouterAdvertisement(prefixes, port.getMAC(), {
      curHopLimit: config?.curHopLimit ?? 64,
      managed: config?.managedFlag ?? false,
      other: config?.otherConfigFlag ?? false,
      routerLifetime: config?.routerLifetime ?? 1800,
    });

    const dstIP = destIP || IPV6_ALL_NODES_MULTICAST;
    const dstMAC = destIP
      ? this.neighborCache.get(destIP.toString())?.mac || dstIP.toSolicitedNodeMulticast().toMulticastMAC()
      : IPV6_ALL_NODES_MULTICAST.toMulticastMAC();

    const raPkt = createIPv6Packet(srcIP, dstIP, IP_PROTO_ICMPV6, 255, ra, 64);

    this.sendFrame(ifName, {
      srcMAC: port.getMAC(),
      dstMAC,
      etherType: ETHERTYPE_IPV6,
      payload: raPkt,
    });

    Logger.debug(this.id, 'router:ra-sent',
      `${this.name}: RA sent on ${ifName} with ${prefixes.length} prefixes`);
  }

  // ─── IPv6 Forwarding ────────────────────────────────────────────

  private forwardIPv6Packet(inPort: string, ipv6: IPv6Packet): void {
    // Decrement hop limit
    const newHopLimit = ipv6.hopLimit - 1;
    if (newHopLimit <= 0) {
      Logger.info(this.id, 'router:hop-limit-expired',
        `${this.name}: Hop limit expired for ${ipv6.sourceIP} → ${ipv6.destinationIP}`);
      this.sendICMPv6Error(inPort, ipv6, 'time-exceeded', 0);
      return;
    }

    // Route lookup
    const route = this.lookupIPv6Route(ipv6.destinationIP);
    if (!route) {
      Logger.info(this.id, 'router:no-ipv6-route',
        `${this.name}: no route for ${ipv6.destinationIP}`);
      this.sendICMPv6Error(inPort, ipv6, 'destination-unreachable', 0);
      return;
    }

    // Create forwarded packet with decremented hop limit
    const fwdPkt: IPv6Packet = {
      ...ipv6,
      hopLimit: newHopLimit,
    };

    const nextHopIP = route.nextHop || ipv6.destinationIP;
    const outPort = this.ports.get(route.iface);
    if (!outPort) return;

    // NDP resolve and send
    const cached = this.neighborCache.get(nextHopIP.toString());
    if (cached) {
      this.counters.ipForwDatagrams++;
      this.sendFrame(route.iface, {
        srcMAC: outPort.getMAC(),
        dstMAC: cached.mac,
        etherType: ETHERTYPE_IPV6,
        payload: fwdPkt,
      });
    } else {
      this.queueAndResolveIPv6(fwdPkt, route.iface, nextHopIP, outPort);
    }
  }

  private sendICMPv6Error(
    inPort: string,
    offendingPkt: IPv6Packet,
    errorType: 'time-exceeded' | 'destination-unreachable' | 'packet-too-big',
    code: number,
    mtu?: number,
  ): void {
    const port = this.ports.get(inPort);
    if (!port) return;
    const srcIP = port.getLinkLocalIPv6() || port.getGlobalIPv6();
    if (!srcIP) return;

    const icmpError: ICMPv6Packet = {
      type: 'icmpv6',
      icmpType: errorType,
      code,
      mtu,
    };

    const errorPkt = createIPv6Packet(
      srcIP,
      offendingPkt.sourceIP,
      IP_PROTO_ICMPV6,
      this.defaultHopLimit,
      icmpError,
      48, // ICMPv6 header + as much of original packet as fits
    );

    const cached = this.neighborCache.get(offendingPkt.sourceIP.toString());
    if (cached) {
      this.sendFrame(inPort, {
        srcMAC: port.getMAC(),
        dstMAC: cached.mac,
        etherType: ETHERTYPE_IPV6,
        payload: errorPkt,
      });
    }
  }

  // ─── NDP Resolution + IPv6 Packet Queue ─────────────────────────

  private queueAndResolveIPv6(pkt: IPv6Packet, iface: string, nextHopIP: IPv6Address, port: Port): void {
    const timer = setTimeout(() => {
      this.ipv6PacketQueue = this.ipv6PacketQueue.filter(
        q => !(q.nextHopIP.equals(nextHopIP) && q.outIface === iface)
      );
    }, 2000);

    this.ipv6PacketQueue.push({ frame: pkt, outIface: iface, nextHopIP, timer });

    const key = nextHopIP.toString();
    if (!this.pendingNDPs.has(key)) {
      this.pendingNDPs.set(key, []);

      // Send Neighbor Solicitation
      const srcIP = port.getLinkLocalIPv6();
      if (!srcIP) return;

      const ns = createNeighborSolicitation(nextHopIP, port.getMAC());
      const nsPkt = createIPv6Packet(
        srcIP,
        nextHopIP.toSolicitedNodeMulticast(),
        IP_PROTO_ICMPV6,
        255,
        ns,
        24,
      );

      this.sendFrame(iface, {
        srcMAC: port.getMAC(),
        dstMAC: nextHopIP.toSolicitedNodeMulticast().toMulticastMAC(),
        etherType: ETHERTYPE_IPV6,
        payload: nsPkt,
      });
    }
  }

  private flushIPv6PacketQueue(resolvedIP: IPv6Address, resolvedMAC: MACAddress): void {
    const ready = this.ipv6PacketQueue.filter(q => q.nextHopIP.equals(resolvedIP));
    this.ipv6PacketQueue = this.ipv6PacketQueue.filter(q => !q.nextHopIP.equals(resolvedIP));

    for (const q of ready) {
      clearTimeout(q.timer);
      const outPort = this.ports.get(q.outIface);
      if (outPort) {
        this.counters.ipForwDatagrams++;
        this.sendFrame(q.outIface, {
          srcMAC: outPort.getMAC(),
          dstMAC: resolvedMAC,
          etherType: ETHERTYPE_IPV6,
          payload: q.frame,
        });
      }
    }
  }

  // ─── Management Plane: Terminal (vendor-abstracted) ────────────

  async executeCommand(command: string): Promise<string> {
    if (!this.isPoweredOn) return '% Device is powered off';
    const parts = command.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    return this.shell.execute(this, cmd, parts.slice(1));
  }

  // ── Public accessors used by CLI shells ──────────────────────

  /** @internal Used by CLI shells */
  _getRoutingTableInternal(): RouteEntry[] { return this.routingTable; }
  /** @internal Used by CLI shells */
  _getArpTableInternal(): Map<string, ARPEntry> { return this.arpTable; }
  /** @internal Used by CLI shells */
  _getPortsInternal(): Map<string, Port> { return this.ports; }
  /** @internal Used by CLI shells */
  _getHostnameInternal(): string { return this.hostname; }
  /** @internal Used by CLI shells */
  _getIPv6RoutingTableInternal(): IPv6RouteEntry[] { return this.ipv6RoutingTable; }
  /** @internal Used by CLI shells */
  _getNeighborCacheInternal(): Map<string, NeighborCacheEntry> { return this.neighborCache; }

  // ─── OS Info ───────────────────────────────────────────────────

  getOSType(): string { return this.shell.getOSType(); }
}


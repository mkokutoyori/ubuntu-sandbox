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
  IP_PROTO_ICMP, IP_PROTO_TCP, IP_PROTO_UDP, IP_PROTO_ICMPV6,
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
import { DHCPServer } from '../dhcp/DHCPServer';
import { OSPFEngine } from '../ospf/OSPFEngine';
import { OSPFv3Engine } from '../ospf/OSPFv3Engine';
import { IPSecEngine } from '../ipsec/IPSecEngine';
import { IP_PROTO_ESP, IP_PROTO_AH } from '../core/types';

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
  type: 'connected' | 'static' | 'default' | 'rip' | 'ospf';
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

// ─── ACL (Access Control Lists) ──────────────────────────────────────

export interface ACLEntry {
  action: 'permit' | 'deny';
  /** Protocol filter: 'ip' matches all, 'icmp', 'tcp', 'udp' */
  protocol?: string;
  srcIP: IPAddress;
  srcWildcard: SubnetMask;
  dstIP?: IPAddress;
  dstWildcard?: SubnetMask;
  srcPort?: number;
  dstPort?: number;
  /** Match counter */
  matchCount: number;
}

export interface AccessList {
  /** Numeric ID (1-99 standard, 100-199 extended) or undefined for named ACLs */
  id?: number;
  /** Name for named ACLs */
  name?: string;
  /** ACL type */
  type: 'standard' | 'extended';
  /** Ordered list of entries (first match wins) */
  entries: ACLEntry[];
}

/** Interface ACL binding: which ACL is applied in which direction */
interface InterfaceACLBinding {
  /** ACL ID (number) or name (string) */
  inbound: number | string | null;
  outbound: number | string | null;
}

// ─── CLI Shell (imported from shells/) ──────────────────────────────

import type { IRouterShell } from './shells/IRouterShell';

// ─── Router (Abstract Base) ──────────────────────────────────────────

export abstract class Router extends Equipment {
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

  // ── ACL (Access Control Lists) ──────────────────────────────
  private accessLists: AccessList[] = [];
  private interfaceACLBindings: Map<string, InterfaceACLBinding> = new Map();

  // ── DHCP Server (RFC 2131) ──────────────────────────────────
  private dhcpServer: DHCPServer = new DHCPServer();

  // ── OSPF Engine (RFC 2328 / RFC 5340) ──────────────────────
  private ospfEngine: OSPFEngine | null = null;
  private ospfv3Engine: OSPFv3Engine | null = null;

  // ── IPSec Engine ─────────────────────────────────────────────
  private ipsecEngine: IPSecEngine | null = null;

  // ── Management Plane (vendor CLI shell) ───────────────────────
  private shell: IRouterShell;

  constructor(type: DeviceType, name: string = 'Router', x: number = 0, y: number = 0) {
    super(type, name, x, y);
    this.shell = this.createShell();
    this.createPorts();
    this._setupPortMonitoring();
  }

  private createPorts(): void {
    const portCount = 4;
    for (let i = 0; i < portCount; i++) {
      const portName = this.getVendorPortName(i);
      this.addPort(new Port(portName, 'ethernet'));
    }
  }

  /** Register link-change handlers on all ports to trigger OSPF convergence and DPD */
  private _setupPortMonitoring(): void {
    for (const [name, port] of this.ports) {
      port.onLinkChange((state) => {
        if (state === 'up') {
          this._ospfAutoConverge();
        } else {
          this.ipsecEngine?.onPortDown(name);
        }
      });
    }
  }

  /**
   * Create a virtual port (loopback, tunnel, subinterface, etc.).
   * Returns true if created successfully.
   * @internal Used by CLI shells
   */
  _createVirtualInterface(name: string): boolean {
    if (this.ports.has(name)) return true; // already exists
    const port = new Port(name, 'ethernet');
    port.setUp(true); // virtual interfaces are always up
    this.addPort(port);
    // Register OSPF monitor
    port.onLinkChange((state) => {
      if (state === 'up') this._ospfAutoConverge();
    });
    return true;
  }

  /** Vendor-specific interface naming convention */
  protected abstract getVendorPortName(index: number): string;

  /** Create the vendor-specific CLI shell */
  protected abstract createShell(): IRouterShell;

  /** Get the vendor-specific boot sequence */
  abstract getBootSequence(): string;

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

    // Trigger OSPF convergence if OSPF is enabled (needed for Loopback, etc.)
    if (this.ospfEngine) {
      this._ospfAutoConverge();
    }
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
    // Static routes can be installed even when next-hop is not directly reachable (recursive lookup)
    const ifaceName = iface ? iface.getName() : '';

    this.routingTable.push({
      network, mask, nextHop,
      iface: ifaceName,
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
    // Default routes can be installed even when next-hop is not directly reachable
    const ifaceName = iface ? iface.getName() : '';

    this.routingTable.push({
      network: new IPAddress('0.0.0.0'),
      mask: new SubnetMask('0.0.0.0'),
      nextHop,
      iface: ifaceName,
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
          // Control plane — deliver locally (ACL does not filter router-destined traffic)
          this.handleLocalDelivery(inPort, ipPkt);
          return;
        }
      }
    } else {
      // Broadcast packet — deliver locally
      this.handleLocalDelivery(inPort, ipPkt);
      return;
    }

    // C.1b: Inbound ACL check (only for transit/forwarded traffic)
    const inboundBinding = this.interfaceACLBindings.get(inPort);
    if (inboundBinding?.inbound !== null && inboundBinding?.inbound !== undefined) {
      const verdict = this.evaluateACL(inboundBinding.inbound, ipPkt);
      if (verdict === 'deny') {
        Logger.info(this.id, 'router:acl-deny-in',
          `${this.name}: ACL denied inbound on ${inPort}: ${ipPkt.sourceIP} → ${ipPkt.destinationIP}`);
        return;
      }
    }

    // C.2: Not for us → forward via FIB
    this.forwardPacket(inPort, ipPkt);
  }

  /**
   * Control Plane: Handle packets addressed to our interface IPs.
   * Supports: ICMP echo-request → echo-reply, UDP/RIP.
   */
  private handleLocalDelivery(inPort: string, ipPkt: IPv4Packet): void {
    // IPSec inbound decapsulation
    if (ipPkt.protocol === IP_PROTO_ESP && this.ipsecEngine) {
      const inner = this.ipsecEngine.processInboundESP(ipPkt);
      if (inner) this.processIPv4(inPort, inner);
      return;
    }
    if (ipPkt.protocol === IP_PROTO_AH && this.ipsecEngine) {
      const inner = this.ipsecEngine.processInboundAH(ipPkt);
      if (inner) this.processIPv4(inPort, inner);
      return;
    }

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

    // Phase E.2b: Outbound ACL check
    const outboundBinding = this.interfaceACLBindings.get(route.iface);
    if (outboundBinding?.outbound !== null && outboundBinding?.outbound !== undefined) {
      const verdict = this.evaluateACL(outboundBinding.outbound, fwdPkt);
      if (verdict === 'deny') {
        Logger.info(this.id, 'router:acl-deny-out',
          `${this.name}: ACL denied outbound on ${route.iface}: ${fwdPkt.sourceIP} → ${fwdPkt.destinationIP}`);
        return;
      }
    }

    // Phase E.2c: IPSec outbound — check if this packet should be encrypted
    if (this.ipsecEngine) {
      const entry = this.ipsecEngine.findMatchingCryptoEntry(fwdPkt, route.iface);
      if (entry) {
        const encPkt = this.ipsecEngine.processOutbound(fwdPkt, route.iface, entry);
        if (!encPkt) return; // negotiation failed — drop
        // Re-send the encrypted outer packet (it will go through forwardPacket again)
        this.processIPv4(route.iface, encPkt);
        return;
      }
    }

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
    return this.shell.execute(this, command);
  }

  getPrompt(): string {
    return this.shell.getPrompt(this);
  }

  /** Get CLI help for the given input (used by terminal UI for inline ? behavior) */
  cliHelp(inputBeforeQuestion: string): string {
    return this.shell.getHelp(inputBeforeQuestion);
  }

  /** Get CLI tab completion for the given input (used by terminal UI) */
  cliTabComplete(input: string): string | null {
    return this.shell.tabComplete(input);
  }

  getBanner(type: string): string {
    if (type === 'motd') return '';
    return '';
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
  /** @internal Used by CLI shells */
  _getDHCPServerInternal(): DHCPServer { return this.dhcpServer; }
  /** @internal Used by CLI shells */
  _setHostnameInternal(name: string): void { this.hostname = name; this.name = name; }

  /** @internal Lazily create + return the IPSec engine for this router */
  _getOrCreateIPSecEngine(): IPSecEngine {
    if (!this.ipsecEngine) {
      this.ipsecEngine = new IPSecEngine(this);
    }
    return this.ipsecEngine;
  }

  /** @internal Return IPSec engine (null if not yet configured) */
  _getIPSecEngineInternal(): IPSecEngine | null { return this.ipsecEngine; }

  // ─── ACL Public API ────────────────────────────────────────────

  getAccessLists(): AccessList[] {
    return this.accessLists.map(acl => ({
      ...acl,
      entries: acl.entries.map(e => ({ ...e })),
    }));
  }

  addAccessListEntry(
    id: number,
    action: 'permit' | 'deny',
    opts: {
      protocol?: string;
      srcIP: IPAddress;
      srcWildcard: SubnetMask;
      dstIP?: IPAddress;
      dstWildcard?: SubnetMask;
      srcPort?: number;
      dstPort?: number;
    },
  ): void {
    const type: 'standard' | 'extended' = id < 100 ? 'standard' : 'extended';
    let acl = this.accessLists.find(a => a.id === id);
    if (!acl) {
      acl = { id, type, entries: [] };
      this.accessLists.push(acl);
    }
    acl.entries.push({
      action,
      protocol: opts.protocol,
      srcIP: opts.srcIP,
      srcWildcard: opts.srcWildcard,
      dstIP: opts.dstIP,
      dstWildcard: opts.dstWildcard,
      srcPort: opts.srcPort,
      dstPort: opts.dstPort,
      matchCount: 0,
    });
  }

  addNamedAccessListEntry(
    name: string,
    type: 'standard' | 'extended',
    action: 'permit' | 'deny',
    opts: {
      protocol?: string;
      srcIP: IPAddress;
      srcWildcard: SubnetMask;
      dstIP?: IPAddress;
      dstWildcard?: SubnetMask;
      srcPort?: number;
      dstPort?: number;
    },
  ): void {
    let acl = this.accessLists.find(a => a.name === name);
    if (!acl) {
      acl = { name, type, entries: [] };
      this.accessLists.push(acl);
    }
    acl.entries.push({
      action,
      protocol: opts.protocol,
      srcIP: opts.srcIP,
      srcWildcard: opts.srcWildcard,
      dstIP: opts.dstIP,
      dstWildcard: opts.dstWildcard,
      srcPort: opts.srcPort,
      dstPort: opts.dstPort,
      matchCount: 0,
    });
  }

  removeAccessList(id: number): void {
    this.accessLists = this.accessLists.filter(a => a.id !== id);
    // Remove any interface bindings referencing this ACL
    for (const [, binding] of this.interfaceACLBindings) {
      if (binding.inbound === id) binding.inbound = null;
      if (binding.outbound === id) binding.outbound = null;
    }
  }

  removeNamedAccessList(name: string): void {
    this.accessLists = this.accessLists.filter(a => a.name !== name);
    for (const [, binding] of this.interfaceACLBindings) {
      if (binding.inbound === name) binding.inbound = null;
      if (binding.outbound === name) binding.outbound = null;
    }
  }

  setInterfaceACL(ifName: string, direction: 'in' | 'out', aclRef: number | string): void {
    let binding = this.interfaceACLBindings.get(ifName);
    if (!binding) {
      binding = { inbound: null, outbound: null };
      this.interfaceACLBindings.set(ifName, binding);
    }
    if (direction === 'in') binding.inbound = aclRef;
    else binding.outbound = aclRef;
  }

  removeInterfaceACL(ifName: string, direction: 'in' | 'out'): void {
    const binding = this.interfaceACLBindings.get(ifName);
    if (!binding) return;
    if (direction === 'in') binding.inbound = null;
    else binding.outbound = null;
  }

  getInterfaceACL(ifName: string, direction: 'in' | 'out'): number | string | null {
    const binding = this.interfaceACLBindings.get(ifName);
    if (!binding) return null;
    return direction === 'in' ? binding.inbound : binding.outbound;
  }

  /** Evaluate a named/numbered ACL by name — used by IPSecEngine for crypto ACL matching. */
  evaluateACLByName(name: string, ipPkt: IPv4Packet): 'permit' | 'deny' | null {
    const ref: number | string = /^\d+$/.test(name) ? parseInt(name, 10) : name;
    return this.evaluateACL(ref, ipPkt);
  }

  /** Evaluate an ACL against a packet. Returns 'permit', 'deny', or null (no ACL). */
  private evaluateACL(aclRef: number | string | null, ipPkt: IPv4Packet): 'permit' | 'deny' | null {
    if (aclRef === null) return null;

    const acl = typeof aclRef === 'number'
      ? this.accessLists.find(a => a.id === aclRef)
      : this.accessLists.find(a => a.name === aclRef);

    if (!acl || acl.entries.length === 0) {
      // No ACL defined or empty — implicit deny
      return 'deny';
    }

    for (const entry of acl.entries) {
      if (this.aclEntryMatches(acl.type, entry, ipPkt)) {
        entry.matchCount++;
        return entry.action;
      }
    }

    // Implicit deny at end of ACL
    return 'deny';
  }

  /** Check if an ACL entry matches a packet */
  private aclEntryMatches(aclType: 'standard' | 'extended', entry: ACLEntry, ipPkt: IPv4Packet): boolean {
    // Source IP check (both standard and extended)
    if (!this.wildcardMatch(ipPkt.sourceIP, entry.srcIP, entry.srcWildcard)) {
      return false;
    }

    if (aclType === 'standard') {
      return true; // Standard ACLs only check source
    }

    // Extended ACL checks
    // Destination IP
    if (entry.dstIP && entry.dstWildcard) {
      if (!this.wildcardMatch(ipPkt.destinationIP, entry.dstIP, entry.dstWildcard)) {
        return false;
      }
    }

    // Protocol matching
    if (entry.protocol && entry.protocol !== 'ip') {
      const pktProto = this.getProtocolName(ipPkt.protocol);
      if (pktProto !== entry.protocol) return false;

      // Port matching for TCP/UDP
      if ((entry.protocol === 'tcp' || entry.protocol === 'udp') && ipPkt.payload) {
        const udp = ipPkt.payload as UDPPacket;
        if (entry.srcPort !== undefined && udp.sourcePort !== entry.srcPort) return false;
        if (entry.dstPort !== undefined && udp.destinationPort !== entry.dstPort) return false;
      }
    }

    return true;
  }

  private wildcardMatch(packetIP: IPAddress, aclIP: IPAddress, wildcard: SubnetMask): boolean {
    const pktOctets = packetIP.getOctets();
    const aclOctets = aclIP.getOctets();
    const wcOctets = wildcard.getOctets();
    for (let i = 0; i < 4; i++) {
      // Wildcard 0 = must match, 1 = don't care
      if ((pktOctets[i] & ~wcOctets[i]) !== (aclOctets[i] & ~wcOctets[i])) {
        return false;
      }
    }
    return true;
  }

  private getProtocolName(proto: number): string {
    switch (proto) {
      case IP_PROTO_ICMP: return 'icmp';
      case IP_PROTO_TCP: return 'tcp';
      case IP_PROTO_UDP: return 'udp';
      default: return 'ip';
    }
  }

  /** @internal Used by CLI shells */
  _getAccessListsInternal(): AccessList[] { return this.accessLists; }
  /** @internal Used by CLI shells */
  _getInterfaceACLBindingsInternal(): Map<string, InterfaceACLBinding> { return this.interfaceACLBindings; }

  // ─── DHCP Server Public API ────────────────────────────────────

  getDHCPServer(): DHCPServer { return this.dhcpServer; }

  // ═══════════════════════════════════════════════════════════════════
  // OSPF Engine Integration (RFC 2328 / RFC 5340)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Enable OSPF and create the engine with the given process ID.
   * @internal Used by CLI shells
   */
  _enableOSPF(processId: number = 1): void {
    if (this.ospfEngine) return;
    this.ospfEngine = new OSPFEngine(processId);

    // Auto-detect Router ID: highest interface IP
    let highestIP = '0.0.0.0';
    let highestNum = 0;
    for (const [, port] of this.ports) {
      const ip = port.getIPAddress();
      if (ip) {
        const num = ip.toUint32();
        if (num > highestNum) {
          highestNum = num;
          highestIP = ip.toString();
        }
      }
    }
    if (highestIP !== '0.0.0.0') {
      this.ospfEngine.setRouterId(highestIP);
    }

    // Set up send callback for OSPF packets
    this.ospfEngine.setSendCallback((iface, packet, destIP) => {
      this.ospfSendPacket(iface, packet, destIP);
    });

    Logger.info(this.id, 'ospf:enabled',
      `${this.name}: OSPFv2 process ${processId} enabled, Router ID ${highestIP}`);
  }

  /**
   * Disable OSPF and remove all OSPF routes.
   * @internal Used by CLI shells
   */
  _disableOSPF(): void {
    if (this.ospfEngine) {
      this.ospfEngine.shutdown();
      this.ospfEngine = null;
      // Remove OSPF routes from RIB
      this.routingTable = this.routingTable.filter(r => r.type !== 'ospf');
      Logger.info(this.id, 'ospf:disabled', `${this.name}: OSPF disabled`);
    }
  }

  /** @internal Used by CLI shells */
  _getOSPFEngineInternal(): OSPFEngine | null { return this.ospfEngine; }

  /** @internal Used by CLI shells */
  _getOSPFv3EngineInternal(): OSPFv3Engine | null { return this.ospfv3Engine; }

  /** Check if OSPF is enabled */
  isOSPFEnabled(): boolean { return this.ospfEngine !== null; }

  /**
   * Send an OSPF packet out an interface (encapsulated in IP).
   * OSPF uses IP protocol 89 directly (not UDP).
   */
  private ospfSendPacket(outIface: string, ospfPkt: any, destIP: string): void {
    const port = this.ports.get(outIface);
    if (!port) return;
    const myIP = port.getIPAddress();
    if (!myIP) return;

    // OSPF packets are encapsulated in IPv4 with protocol 89
    const ipPkt = createIPv4Packet(
      myIP,
      new IPAddress(destIP),
      89, // OSPF protocol number
      1,  // TTL=1 (link-local)
      ospfPkt,
      64, // Approximate size
    );

    // Determine destination MAC
    let dstMAC: MACAddress;
    if (destIP === '224.0.0.5' || destIP === '224.0.0.6') {
      // Multicast: 01:00:5e + lower 23 bits of IP
      const ipOctets = new IPAddress(destIP).getOctets();
      dstMAC = new MACAddress(
        `01:00:5e:${(ipOctets[1] & 0x7f).toString(16).padStart(2, '0')}:` +
        `${ipOctets[2].toString(16).padStart(2, '0')}:${ipOctets[3].toString(16).padStart(2, '0')}`
      );
    } else {
      // Unicast: resolve via ARP cache
      const cached = this.arpTable.get(destIP);
      dstMAC = cached ? cached.mac : MACAddress.broadcast();
    }

    this.sendFrame(outIface, {
      srcMAC: port.getMAC(),
      dstMAC,
      etherType: ETHERTYPE_IPV4,
      payload: ipPkt,
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // OSPF Auto-Convergence (simulated instant convergence for tests)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Trigger OSPF convergence: activate matching interfaces, discover neighbors
   * via cables, exchange LSAs, and compute/install routes.
   * Called after network commands and cable connects.
   * @internal
   */
  _ospfAutoConverge(): void {
    if (!this.ospfEngine) return;

    // Step 1: Auto-activate interfaces matching OSPF network statements
    const routerIfaces: Array<{ name: string; ip: string; mask: string }> = [];
    for (const [portName, port] of this.ports) {
      const ip = port.getIPAddress();
      const mask = port.getSubnetMask();
      if (ip && mask) {
        routerIfaces.push({ name: portName, ip: ip.toString(), mask: mask.toString() });
      }
    }

    const matches = this.ospfEngine.matchInterfaces(routerIfaces);
    for (const m of matches) {
      if (!this.ospfEngine.getInterface(m.name)) {
        // Apply pending config if any
        const pending = this.ospfExtraConfig.pendingIfConfig.get(m.name);
        this.ospfEngine.activateInterface(m.name, m.ip, m.mask, m.areaId, {
          cost: pending?.cost,
          priority: pending?.priority,
          helloInterval: pending?.helloInterval,
          deadInterval: pending?.deadInterval,
          networkType: pending?.networkType as any,
        });
        // Apply auth settings after activation
        if (pending) {
          const iface = this.ospfEngine.getInterface(m.name);
          if (iface) {
            if (pending.authType !== undefined) iface.authType = pending.authType;
            if (pending.authKey !== undefined) iface.authKey = pending.authKey;
          }
        }
      }
    }

    // Step 2: Discover neighbors via cables (direct or through switches)
    for (const [portName, port] of this.ports) {
      const cable = port.getCable();
      if (!cable) continue;

      const localIface = this.ospfEngine.getInterface(portName);
      if (!localIface) continue;
      if (localIface.passive) continue;

      // Get remote port
      const remotePort = cable.getPortA() === port ? cable.getPortB() : cable.getPortA();
      if (!remotePort) continue;

      // Get remote equipment
      const remoteEquipId = remotePort.getEquipmentId();
      const remoteEquip = Equipment.getById(remoteEquipId);
      if (!remoteEquip) continue;

      // Collect candidate neighbor routers - either direct or through switch
      const candidateRouters: Array<{ router: Router; port: Port }> = [];

      if (remoteEquip instanceof Router) {
        candidateRouters.push({ router: remoteEquip, port: remotePort });
      } else {
        // Remote device is a Switch/Hub - find all other routers connected to it
        for (const swPort of remoteEquip.getPorts()) {
          if (swPort === remotePort) continue; // skip the port we came from
          const swCable = swPort.getCable();
          if (!swCable) continue;
          const otherEnd = swCable.getPortA() === swPort ? swCable.getPortB() : swCable.getPortA();
          if (!otherEnd) continue;
          const otherEquip = Equipment.getById(otherEnd.getEquipmentId());
          if (otherEquip && otherEquip instanceof Router) {
            candidateRouters.push({ router: otherEquip, port: otherEnd });
          }
        }
      }

      for (const { router: remoteRouter, port: rPort } of candidateRouters) {
        if (!remoteRouter.ospfEngine) continue;

        // Trigger auto-converge on remote side too
        const remoteIfaces: Array<{ name: string; ip: string; mask: string }> = [];
        for (const [rp, rPortInner] of remoteRouter.ports) {
          const rIp = rPortInner.getIPAddress();
          const rMask = rPortInner.getSubnetMask();
          if (rIp && rMask) remoteIfaces.push({ name: rp, ip: rIp.toString(), mask: rMask.toString() });
        }
        const remoteMatches = remoteRouter.ospfEngine.matchInterfaces(remoteIfaces);
        for (const rm of remoteMatches) {
          if (!remoteRouter.ospfEngine.getInterface(rm.name)) {
            const rPending = remoteRouter.ospfExtraConfig.pendingIfConfig.get(rm.name);
            remoteRouter.ospfEngine.activateInterface(rm.name, rm.ip, rm.mask, rm.areaId, {
              cost: rPending?.cost,
              priority: rPending?.priority,
              helloInterval: rPending?.helloInterval,
              deadInterval: rPending?.deadInterval,
              networkType: rPending?.networkType as any,
            });
            if (rPending) {
              const iface = remoteRouter.ospfEngine.getInterface(rm.name);
              if (iface) {
                if (rPending.authType !== undefined) iface.authType = rPending.authType;
                if (rPending.authKey !== undefined) iface.authKey = rPending.authKey;
              }
            }
          }
        }

        const remoteIface = remoteRouter.ospfEngine.getInterface(rPort.getName());
        if (!remoteIface) continue;
        if (remoteIface.passive) continue;

        // Check authentication compatibility
        const localAuth = localIface.authType ?? 0;
        const remoteAuth = remoteIface.authType ?? 0;
        if (localAuth !== remoteAuth) continue;
        if (localAuth !== 0 && localIface.authKey !== remoteIface.authKey) continue;

        // Check hello/dead interval match
        if (localIface.helloInterval !== remoteIface.helloInterval) continue;
        if (localIface.deadInterval !== remoteIface.deadInterval) continue;

        // Form bidirectional adjacency (instant convergence)
        const localRid = this.ospfEngine.getRouterId();
        const remoteRid = remoteRouter.ospfEngine.getRouterId();

        this._ospfFormAdjacency(this.ospfEngine, localIface, remoteIface, remoteRid, rPort);
        this._ospfFormAdjacency(remoteRouter.ospfEngine, remoteIface, localIface, localRid, port);
      }
    }

    // Step 3: Exchange LSAs between adjacent routers and compute routes
    this._ospfExchangeAndCompute();

    // Step 4: OSPFv3 convergence for IPv6
    this._ospfv3AutoConverge();
  }

  /**
   * OSPFv3 auto-convergence: discover IPv6 neighbors and compute IPv6 routes.
   */
  private _ospfv3AutoConverge(): void {
    if (!this.ospfv3Engine) return;

    // Collect all OSPFv3 routers via BFS
    const visited = new Set<string>();
    const queue: Router[] = [this];
    const allRouters: Router[] = [];
    visited.add(this.id);

    while (queue.length > 0) {
      const current = queue.shift()!;
      allRouters.push(current);
      for (const [, port] of current.ports) {
        const cable = port.getCable();
        if (!cable) continue;
        const remotePort = cable.getPortA() === port ? cable.getPortB() : cable.getPortA();
        if (!remotePort) continue;
        const remoteId = remotePort.getEquipmentId();
        if (visited.has(remoteId)) continue;
        const remoteEquip = Equipment.getById(remoteId);
        if (remoteEquip instanceof Router && remoteEquip.ospfv3Engine) {
          visited.add(remoteId);
          queue.push(remoteEquip);
        } else if (remoteEquip && !(remoteEquip instanceof Router)) {
          for (const swPort of remoteEquip.getPorts()) {
            if (swPort === remotePort) continue;
            const swCable = swPort.getCable();
            if (!swCable) continue;
            const otherEnd = swCable.getPortA() === swPort ? swCable.getPortB() : swCable.getPortA();
            if (!otherEnd) continue;
            const otherId = otherEnd.getEquipmentId();
            if (visited.has(otherId)) continue;
            const otherEquip = Equipment.getById(otherId);
            if (otherEquip instanceof Router && otherEquip.ospfv3Engine) {
              visited.add(otherId);
              queue.push(otherEquip);
            }
          }
        }
      }
    }

    // Form adjacencies between all directly connected v3 routers
    for (const r1 of allRouters) {
      if (!r1.ospfv3Engine) continue;
      for (const [portName, port] of r1.ports) {
        const cable = port.getCable();
        if (!cable) continue;
        const localIface = r1.ospfv3Engine.getInterface(portName);
        if (!localIface) continue;
        if (localIface.passive) continue;

        const remotePort = cable.getPortA() === port ? cable.getPortB() : cable.getPortA();
        if (!remotePort) continue;

        const candidates: Array<{ router: Router; port: Port }> = [];
        const remoteEquip = Equipment.getById(remotePort.getEquipmentId());
        if (remoteEquip instanceof Router && remoteEquip.ospfv3Engine) {
          candidates.push({ router: remoteEquip, port: remotePort });
        } else if (remoteEquip && !(remoteEquip instanceof Router)) {
          for (const swPort of remoteEquip.getPorts()) {
            if (swPort === remotePort) continue;
            const swCable = swPort.getCable();
            if (!swCable) continue;
            const otherEnd = swCable.getPortA() === swPort ? swCable.getPortB() : swCable.getPortA();
            if (!otherEnd) continue;
            const otherEquip = Equipment.getById(otherEnd.getEquipmentId());
            if (otherEquip instanceof Router && otherEquip.ospfv3Engine) {
              candidates.push({ router: otherEquip, port: otherEnd });
            }
          }
        }

        for (const { router: r2, port: rPort } of candidates) {
          if (!r2.ospfv3Engine) continue;
          const remoteIface = r2.ospfv3Engine.getInterface(rPort.getName());
          if (!remoteIface) continue;
          if (remoteIface.passive) continue;

          // Timer match check
          if (localIface.helloInterval !== remoteIface.helloInterval) continue;
          if (localIface.deadInterval !== remoteIface.deadInterval) continue;

          // IPsec auth check: both sides must have matching IPsec config
          const localV3Cfg = r1.ospfExtraConfig.pendingV3IfConfig.get(portName);
          const remoteV3Cfg = r2.ospfExtraConfig.pendingV3IfConfig.get(rPort.getName());
          const localHasIpsec = !!localV3Cfg?.ipsecAuth;
          const remoteHasIpsec = !!remoteV3Cfg?.ipsecAuth;
          if (localHasIpsec !== remoteHasIpsec) continue;

          const localRid = r1.ospfv3Engine.getRouterId();
          const remoteRid = r2.ospfv3Engine.getRouterId();
          r1._ospfv3FormAdjacency(r1.ospfv3Engine, localIface, remoteRid, rPort);
          r2._ospfv3FormAdjacency(r2.ospfv3Engine, remoteIface, localRid, port);
        }
      }
    }

    // Compute and install IPv6 routes from OSPFv3
    this._ospfv3ComputeRoutes(allRouters);
  }

  private _ospfv3FormAdjacency(engine: any, localIface: any, remoteRid: string, remotePort: Port): void {
    // Check if already a neighbor
    if (localIface.neighbors.has(remoteRid)) return;

    const remoteIPv6Addrs = remotePort.getIPv6Addresses?.();
    const linkLocal = remoteIPv6Addrs?.find((a: any) => a.scope === 'link-local');
    const globalAddr = remoteIPv6Addrs?.find((a: any) => a.scope === 'global');
    const remoteIP = linkLocal?.address?.toString() || globalAddr?.address?.toString() || '::';

    const neighbor: any = {
      routerId: remoteRid,
      ipAddress: remoteIP,
      state: 'Full',
      priority: localIface.priority ?? 1,
      neighborDR: '0.0.0.0',
      neighborBDR: '0.0.0.0',
      deadTimer: null,
      iface: localIface.name,
      lsRequestList: [],
      lsRetransmissionList: [],
      dbSummaryList: [],
      ddSeqNumber: 0,
      options: 0x13,
      lastHelloReceived: Date.now(),
    };

    localIface.neighbors.set(remoteRid, neighbor);

    // DR/BDR election for broadcast
    if (localIface.networkType === 'broadcast') {
      const localRid = engine.getRouterId();
      const allRids = [localRid];
      for (const [rid] of localIface.neighbors) allRids.push(rid);

      // Sort by priority first, then router-id (use priority from neighbors)
      const candidates: Array<{ rid: string; priority: number }> = [];
      candidates.push({ rid: localRid, priority: localIface.priority ?? 1 });
      for (const [rid, n] of localIface.neighbors) {
        candidates.push({ rid, priority: (n as any).priority ?? 1 });
      }
      candidates.sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        const aNum = a.rid.split('.').reduce((acc: number, o: string) => (acc << 8) + parseInt(o), 0);
        const bNum = b.rid.split('.').reduce((acc: number, o: string) => (acc << 8) + parseInt(o), 0);
        return bNum - aNum;
      });

      localIface.dr = candidates[0]?.rid || '0.0.0.0';
      localIface.bdr = candidates[1]?.rid || '0.0.0.0';

      if (localIface.dr === localRid) localIface.state = 'DR';
      else if (localIface.bdr === localRid) localIface.state = 'Backup';
      else localIface.state = 'DROther';
    }
  }

  /**
   * Compute and install OSPFv3 IPv6 routes from adjacency information.
   */
  private _ospfv3ComputeRoutes(allRouters: Router[]): void {
    if (!this.ospfv3Engine) return;

    // Remove old OSPFv3 routes from IPv6 table
    this.ipv6RoutingTable = this.ipv6RoutingTable.filter((r: any) => r.type !== 'ospf');

    const myAreas = new Set(this.ospfv3Engine.getConfig().areas.keys());
    const extra = this.ospfExtraConfig;

    // For each reachable router, install routes for their connected IPv6 networks
    for (const r of allRouters) {
      if (r === this || !r.ospfv3Engine) continue;

      // Check reachability via adjacency chain (direct or indirect)
      let hasAdjacency = false;
      for (const [, iface] of this.ospfv3Engine.getInterfaces()) {
        for (const [, n] of iface.neighbors) {
          if ((n as any).routerId === r.ospfv3Engine.getRouterId()) {
            hasAdjacency = true;
            break;
          }
        }
        if (hasAdjacency) break;
      }
      if (!hasAdjacency) {
        hasAdjacency = this._isOSPFv3Reachable(r, allRouters);
      }
      if (!hasAdjacency) continue;

      // Find next hop to reach this router (BFS through adjacency chain)
      const nhInfo = this._findIPv6NextHopTo(r) || this._findIPv6NextHopViaBFS(r, allRouters);
      if (!nhInfo) continue;

      // Install routes for remote router's IPv6 connected networks
      for (const rEntry of r.ipv6RoutingTable) {
        if (rEntry.type !== 'connected') continue;
        const prefStr = rEntry.prefix?.toString() || '';
        if (prefStr.startsWith('fe80')) continue;
        const alreadyConnected = this.ipv6RoutingTable.some(
          (rt: any) => rt.type === 'connected' &&
            rt.prefix?.toString() === prefStr &&
            rt.prefixLength === rEntry.prefixLength
        );
        if (alreadyConnected) continue;
        const alreadyHave = this.ipv6RoutingTable.some(
          (rt: any) => rt.prefix?.toString() === prefStr && rt.prefixLength === rEntry.prefixLength
        );
        if (alreadyHave) continue;

        const cost = nhInfo.cost || 1;
        // Determine if this is inter-area
        const rAreas = new Set(r.ospfv3Engine.getConfig().areas.keys());
        let isInterArea = false;
        for (const a of rAreas) { if (!myAreas.has(a)) isInterArea = true; }

        this.ipv6RoutingTable.push({
          prefix: rEntry.prefix,
          prefixLength: rEntry.prefixLength,
          nextHop: nhInfo.nextHop,
          iface: nhInfo.iface,
          type: 'ospf' as any,
          ad: 110,
          metric: cost,
          routeType: isInterArea ? 'inter-area' : 'intra-area',
        });
      }

      // Also install routes for remote router's OSPFv3 learned routes (for multi-hop)
      for (const rEntry of r.ipv6RoutingTable) {
        if ((rEntry as any).type !== 'ospf') continue;
        const prefStr = rEntry.prefix?.toString() || '';
        if (prefStr.startsWith('fe80')) continue;
        const alreadyHave = this.ipv6RoutingTable.some(
          (rt: any) => rt.prefix?.toString() === prefStr && rt.prefixLength === rEntry.prefixLength
        );
        if (alreadyHave) continue;

        const cost = (nhInfo.cost || 1) + (rEntry.metric || 0);
        this.ipv6RoutingTable.push({
          prefix: rEntry.prefix,
          prefixLength: rEntry.prefixLength,
          nextHop: nhInfo.nextHop,
          iface: nhInfo.iface,
          type: 'ospf' as any,
          ad: 110,
          metric: cost,
          routeType: (rEntry as any).routeType || 'intra-area',
        });
      }

      // ── External routes: redistribute static ──
      const rExtra = r.ospfExtraConfig;
      if (rExtra.redistributeV3Static) {
        for (const rEntry of r.ipv6RoutingTable) {
          if (rEntry.type !== 'static') continue;
          const prefStr = rEntry.prefix?.toString() || '';
          if (prefStr === '::') continue; // skip default
          const alreadyHave = this.ipv6RoutingTable.some(
            (rt: any) => rt.prefix?.toString() === prefStr && rt.prefixLength === rEntry.prefixLength
          );
          if (alreadyHave) continue;
          this.ipv6RoutingTable.push({
            prefix: rEntry.prefix,
            prefixLength: rEntry.prefixLength,
            nextHop: nhInfo.nextHop,
            iface: nhInfo.iface,
            type: 'ospf' as any,
            ad: 110,
            metric: 20,
            routeType: 'type2-external',
          });
        }
      }

      // ── Default-information originate ──
      if ((r.ospfv3Engine.getConfig() as any).defaultInfoOriginate) {
        const hasDefault = r.ipv6RoutingTable.some(
          (rt: any) => (rt.type === 'default' || rt.type === 'static') &&
            (rt.prefix?.toString() === '::' || rt.prefix?.toString() === '0000:0000:0000:0000:0000:0000:0000:0000') &&
            (rt.prefixLength === 0)
        );
        if (hasDefault) {
          const alreadyHave = this.ipv6RoutingTable.some(
            (rt: any) => rt.prefix?.toString() === '::' && rt.prefixLength === 0
          );
          if (!alreadyHave) {
            this.ipv6RoutingTable.push({
              prefix: { toString: () => '::' },
              prefixLength: 0,
              nextHop: nhInfo.nextHop,
              iface: nhInfo.iface,
              type: 'ospf' as any,
              ad: 110,
              metric: 1,
              routeType: 'type2-external',
            });
          }
        }
      }
    }

    // ── Stub area default route ──
    for (const [areaId, area] of this.ospfv3Engine.getConfig().areas) {
      if (area.type !== 'stub') continue;
      for (const r of allRouters) {
        if (r === this || !r.ospfv3Engine) continue;
        const rAreas = r.ospfv3Engine.getConfig().areas;
        if (!rAreas.has(areaId) || rAreas.size <= 1) continue;
        const nhInfo = this._findIPv6NextHopTo(r) || this._findIPv6NextHopViaBFS(r, allRouters);
        if (nhInfo) {
          const alreadyHave = this.ipv6RoutingTable.some(
            (rt: any) => rt.prefix?.toString() === '::' && rt.prefixLength === 0
          );
          if (!alreadyHave) {
            this.ipv6RoutingTable.push({
              prefix: { toString: () => '::' },
              prefixLength: 0,
              nextHop: nhInfo.nextHop,
              iface: nhInfo.iface,
              type: 'ospf' as any,
              ad: 110,
              metric: (nhInfo.cost || 1) + 1,
              routeType: 'inter-area',
              _isDefault: true,
              _isStubDefault: true,
            });
          }
        }
      }
    }

    // ── OSPFv3 area range summarization ──
    // Apply summarization for routes from ABRs
    for (const r of allRouters) {
      if (r === this || !r.ospfv3Engine) continue;
      const rExtra = r.ospfExtraConfig;
      if (!rExtra.v3AreaRanges || rExtra.v3AreaRanges.size === 0) continue;

      for (const [areaId, ranges] of rExtra.v3AreaRanges) {
        for (const range of ranges) {
          // Find and remove individual routes covered by this range
          const rangeParts = range.prefix.split('/');
          const rangePrefix = rangeParts[0];
          const rangePrefLen = parseInt(rangeParts[1]);

          // Check if we have routes in this range
          const covered = this.ipv6RoutingTable.filter(
            (rt: any) => rt.type === 'ospf' &&
              this._ipv6PrefixMatch(rt.prefix?.toString() || '', rt.prefixLength, rangePrefix, rangePrefLen)
          );

          if (covered.length > 0) {
            // Remove individual routes
            this.ipv6RoutingTable = this.ipv6RoutingTable.filter(
              (rt: any) => !(rt.type === 'ospf' &&
                this._ipv6PrefixMatch(rt.prefix?.toString() || '', rt.prefixLength, rangePrefix, rangePrefLen))
            );

            // Add summary route
            const nhInfo = this._findIPv6NextHopTo(r) || this._findIPv6NextHopViaBFS(r, allRouters);
            if (nhInfo) {
              this.ipv6RoutingTable.push({
                prefix: { toString: () => rangePrefix },
                prefixLength: rangePrefLen,
                nextHop: nhInfo.nextHop,
                iface: nhInfo.iface,
                type: 'ospf' as any,
                ad: 110,
                metric: nhInfo.cost || 1,
                routeType: 'intra-area',
              });
            }
          }
        }
      }
    }

    // ── Distribute-list filtering for OSPFv3 ──
    if (extra.v3DistributeList) {
      const aclName = extra.v3DistributeList.aclId;
      // Simple prefix-based filtering
      const v3Acl = (this as any).ipv6AccessLists?.find((a: any) => a.name === aclName);
      if (v3Acl) {
        this.ipv6RoutingTable = this.ipv6RoutingTable.filter((rt: any) => {
          if (rt.type !== 'ospf') return true;
          const prefStr = rt.prefix?.toString() || '';
          const prefLen = rt.prefixLength ?? 64;
          for (const entry of v3Acl.entries) {
            if (entry.prefix && this._ipv6PrefixMatch(prefStr, prefLen, entry.prefix, entry.prefixLength)) {
              return entry.action === 'permit';
            }
          }
          return true; // implicit permit if no match
        });
      }
    }
  }

  private _isOSPFv3Reachable(target: Router, allRouters: Router[]): boolean {
    const visited = new Set<string>();
    const queue: Router[] = [this];
    visited.add(this.id);

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.id === target.id) return true;
      if (!current.ospfv3Engine) continue;

      for (const [, iface] of current.ospfv3Engine.getInterfaces()) {
        for (const [, n] of iface.neighbors) {
          const nRid = (n as any).routerId;
          const neighbor = allRouters.find(r => r.ospfv3Engine?.getRouterId() === nRid);
          if (neighbor && !visited.has(neighbor.id)) {
            visited.add(neighbor.id);
            queue.push(neighbor);
          }
        }
      }
    }
    return false;
  }

  private _findIPv6NextHopTo(target: Router): { nextHop: any; iface: string; cost: number } | null {
    for (const [portName, port] of this.ports) {
      const cable = port.getCable();
      if (!cable) continue;
      const remotePort = cable.getPortA() === port ? cable.getPortB() : cable.getPortA();
      if (!remotePort) continue;

      if (remotePort.getEquipmentId() === target.id) {
        const remoteAddrs = remotePort.getIPv6Addresses?.();
        const linkLocal = remoteAddrs?.find((a: any) => a.scope === 'link-local');
        const globalAddr = remoteAddrs?.find((a: any) => a.scope === 'global');
        const nextHop = linkLocal?.address || globalAddr?.address;
        if (nextHop) {
          const v3Iface = this.ospfv3Engine?.getInterface(portName);
          return { nextHop, iface: portName, cost: v3Iface?.cost ?? 1 };
        }
      }

      // Through switch
      const remoteEquip = Equipment.getById(remotePort.getEquipmentId());
      if (remoteEquip && !(remoteEquip instanceof Router)) {
        for (const swPort of remoteEquip.getPorts()) {
          if (swPort === remotePort) continue;
          const swCable = swPort.getCable();
          if (!swCable) continue;
          const otherEnd = swCable.getPortA() === swPort ? swCable.getPortB() : swCable.getPortA();
          if (!otherEnd) continue;
          if (otherEnd.getEquipmentId() === target.id) {
            const remoteAddrs = otherEnd.getIPv6Addresses?.();
            const linkLocal = remoteAddrs?.find((a: any) => a.scope === 'link-local');
            const globalAddr = remoteAddrs?.find((a: any) => a.scope === 'global');
            const nextHop = linkLocal?.address || globalAddr?.address;
            if (nextHop) {
              const v3Iface = this.ospfv3Engine?.getInterface(portName);
              return { nextHop, iface: portName, cost: v3Iface?.cost ?? 1 };
            }
          }
        }
      }
    }
    return null;
  }

  private _findIPv6NextHopViaBFS(target: Router, allRouters: Router[]): { nextHop: any; iface: string; cost: number } | null {
    const visited = new Set<string>();
    const queue: Array<{ router: Router; nextHop: any; iface: string; cost: number }> = [];
    visited.add(this.id);

    // Seed with direct neighbors
    for (const [portName, port] of this.ports) {
      const cable = port.getCable();
      if (!cable) continue;
      const remotePort = cable.getPortA() === port ? cable.getPortB() : cable.getPortA();
      if (!remotePort) continue;
      const remoteEquipId = remotePort.getEquipmentId();
      const remoteEquip = Equipment.getById(remoteEquipId);

      const tryAdd = (r: Router, rPort: Port) => {
        if (visited.has(r.id) || !r.ospfv3Engine) return;
        const remoteAddrs = rPort.getIPv6Addresses?.();
        const linkLocal = remoteAddrs?.find((a: any) => a.scope === 'link-local');
        const globalAddr = remoteAddrs?.find((a: any) => a.scope === 'global');
        const nextHop = linkLocal?.address || globalAddr?.address;
        if (!nextHop) return;
        const v3Iface = this.ospfv3Engine?.getInterface(portName);
        visited.add(r.id);
        queue.push({ router: r, nextHop, iface: portName, cost: v3Iface?.cost ?? 1 });
      };

      if (remoteEquip instanceof Router) {
        tryAdd(remoteEquip, remotePort);
      } else if (remoteEquip && !(remoteEquip instanceof Router)) {
        for (const swPort of remoteEquip.getPorts()) {
          if (swPort === remotePort) continue;
          const swCable = swPort.getCable();
          if (!swCable) continue;
          const otherEnd = swCable.getPortA() === swPort ? swCable.getPortB() : swCable.getPortA();
          if (!otherEnd) continue;
          const otherEquip = Equipment.getById(otherEnd.getEquipmentId());
          if (otherEquip instanceof Router) tryAdd(otherEquip, otherEnd);
        }
      }
    }

    while (queue.length > 0) {
      const { router: curr, nextHop, iface, cost } = queue.shift()!;
      if (curr.id === target.id) return { nextHop, iface, cost };
      for (const [pn, p] of curr.ports) {
        const cable = p.getCable();
        if (!cable) continue;
        const rp = cable.getPortA() === p ? cable.getPortB() : cable.getPortA();
        if (!rp) continue;
        const rid = rp.getEquipmentId();
        if (visited.has(rid)) continue;
        const re = Equipment.getById(rid);
        if (re instanceof Router && re.ospfv3Engine) {
          visited.add(rid);
          const currIface = curr.ospfv3Engine?.getInterface(pn);
          queue.push({ router: re, nextHop, iface, cost: cost + (currIface?.cost ?? 1) });
        } else if (re && !(re instanceof Router)) {
          for (const swPort of re.getPorts()) {
            if (swPort === rp) continue;
            const swCable = swPort.getCable();
            if (!swCable) continue;
            const otherEnd = swCable.getPortA() === swPort ? swCable.getPortB() : swCable.getPortA();
            if (!otherEnd) continue;
            const oid = otherEnd.getEquipmentId();
            if (visited.has(oid)) continue;
            const oe = Equipment.getById(oid);
            if (oe instanceof Router && oe.ospfv3Engine) {
              visited.add(oid);
              const currIface = curr.ospfv3Engine?.getInterface(pn);
              queue.push({ router: oe, nextHop, iface, cost: cost + (currIface?.cost ?? 1) });
            }
          }
        }
      }
    }
    return null;
  }

  private _ipv6PrefixMatch(prefix: string, prefLen: number, rangePrefix: string, rangePrefLen: number): boolean {
    if (prefLen < rangePrefLen) return false; // The route prefix must be more specific
    // Simple string-based prefix matching for common cases
    const norm1 = this._normalizeIPv6(prefix);
    const norm2 = this._normalizeIPv6(rangePrefix);
    // Compare first rangePrefLen bits
    const fullBits1 = norm1.split(':').map(h => parseInt(h, 16).toString(2).padStart(16, '0')).join('');
    const fullBits2 = norm2.split(':').map(h => parseInt(h, 16).toString(2).padStart(16, '0')).join('');
    return fullBits1.slice(0, rangePrefLen) === fullBits2.slice(0, rangePrefLen);
  }

  private _normalizeIPv6(addr: string): string {
    if (!addr || addr === '::') return '0000:0000:0000:0000:0000:0000:0000:0000';
    // Expand :: notation
    let parts = addr.split(':');
    if (addr.includes('::')) {
      const idx = parts.indexOf('');
      const missing = 8 - parts.filter(p => p !== '').length;
      const expanded = Array(missing).fill('0');
      parts = [...parts.slice(0, idx).filter(p => p !== ''), ...expanded, ...parts.slice(idx + 1).filter(p => p !== '')];
    }
    return parts.map(p => (p || '0').padStart(4, '0')).join(':');
  }

  /** Form an OSPF adjacency on a local interface with a remote neighbor */
  private _ospfFormAdjacency(
    engine: OSPFEngine,
    localIface: any,
    remoteIface: any,
    remoteRid: string,
    remotePort: Port,
  ): void {
    const remoteIP = remotePort.getIPAddress()?.toString() ?? '0.0.0.0';

    // Check if already a neighbor
    const existing = Array.from(localIface.neighbors.values()).find(
      (n: any) => n.routerId === remoteRid
    );
    if (existing) return;

    // Create neighbor directly in FULL state
    const neighbor: any = {
      routerId: remoteRid,
      ipAddress: remoteIP,
      state: 'Full',
      priority: remoteIface.priority ?? 1,
      neighborDR: remoteIP,
      neighborBDR: '0.0.0.0',
      dr: remoteIface.dr ?? '0.0.0.0',
      bdr: remoteIface.bdr ?? '0.0.0.0',
      deadTimer: null,
      iface: localIface.name,
      lsRequestList: [],
      lsRetransmissionList: [],
      dbSummaryList: [],
      ddSeqNumber: 0,
      lastDD: null,
      options: 0,
      master: false,
    };

    localIface.neighbors.set(remoteRid, neighbor);

    // Manually handle DR/BDR for broadcast - don't call drElection which fires AdjOK
    if (localIface.networkType === 'broadcast') {
      const localRid = engine.getRouterId();
      // Build candidate list with priority and IP
      const candidates: Array<{ rid: string; priority: number; ip: string }> = [];
      candidates.push({ rid: localRid, priority: localIface.priority ?? 1, ip: localIface.ipAddress });
      for (const [rid, n] of localIface.neighbors) {
        candidates.push({ rid, priority: (n as any).priority ?? 1, ip: (n as any).ipAddress || '0.0.0.0' });
      }
      // Filter out priority 0 (ineligible for DR/BDR)
      const eligible = candidates.filter(c => c.priority > 0);
      // Sort by priority desc, then router-id desc
      eligible.sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        const aNum = a.rid.split('.').reduce((acc: number, o: string) => (acc << 8) + parseInt(o), 0);
        const bNum = b.rid.split('.').reduce((acc: number, o: string) => (acc << 8) + parseInt(o), 0);
        return bNum - aNum;
      });
      if (eligible.length >= 1) {
        localIface.dr = eligible[0].ip;
        localIface.state = eligible[0].rid === localRid ? 'DR' : (eligible.length >= 2 && eligible[1].rid === localRid ? 'Backup' : 'DROther');
      }
      if (eligible.length >= 2) {
        localIface.bdr = eligible[1].ip;
      }
    }
  }

  /**
   * Exchange LSAs between all connected OSPF routers and compute routes.
   * This simulates the LSDB sync and SPF computation in one step.
   */
  private _ospfExchangeAndCompute(): void {
    if (!this.ospfEngine) return;

    // Collect all routers in the OSPF domain (BFS via cables, including through switches)
    const visited = new Set<string>();
    const queue: Router[] = [this];
    const allRouters: Router[] = [];
    visited.add(this.id);

    while (queue.length > 0) {
      const current = queue.shift()!;
      allRouters.push(current);

      if (!current.ospfEngine) continue;

      for (const [, port] of current.ports) {
        const cable = port.getCable();
        if (!cable) continue;
        const remotePort = cable.getPortA() === port ? cable.getPortB() : cable.getPortA();
        if (!remotePort) continue;
        const remoteId = remotePort.getEquipmentId();
        const remoteEquip = Equipment.getById(remoteId);

        if (remoteEquip instanceof Router && remoteEquip.ospfEngine && !visited.has(remoteId)) {
          visited.add(remoteId);
          queue.push(remoteEquip);
        } else if (remoteEquip && !(remoteEquip instanceof Router)) {
          // Switch/Hub — find all other routers connected to it
          for (const swPort of remoteEquip.getPorts()) {
            if (swPort === remotePort) continue;
            const swCable = swPort.getCable();
            if (!swCable) continue;
            const otherEnd = swCable.getPortA() === swPort ? swCable.getPortB() : swCable.getPortA();
            if (!otherEnd) continue;
            const otherId = otherEnd.getEquipmentId();
            if (visited.has(otherId)) continue;
            const otherEquip = Equipment.getById(otherId);
            if (otherEquip instanceof Router && otherEquip.ospfEngine) {
              visited.add(otherId);
              queue.push(otherEquip);
            }
          }
        }
      }
    }

    // Ensure all routers have their interfaces properly activated (including Loopbacks)
    for (const r of allRouters) {
      if (!r.ospfEngine) continue;
      const rIfaces: Array<{ name: string; ip: string; mask: string }> = [];
      for (const [pName, p] of r.ports) {
        const ip = p.getIPAddress();
        const mask = p.getSubnetMask();
        if (ip && mask) rIfaces.push({ name: pName, ip: ip.toString(), mask: mask.toString() });
      }
      const rMatches = r.ospfEngine.matchInterfaces(rIfaces);
      for (const rm of rMatches) {
        if (!r.ospfEngine.getInterface(rm.name)) {
          const rPending = r.ospfExtraConfig.pendingIfConfig.get(rm.name);
          r.ospfEngine.activateInterface(rm.name, rm.ip, rm.mask, rm.areaId, {
            cost: rPending?.cost,
            priority: rPending?.priority,
            helloInterval: rPending?.helloInterval,
            deadInterval: rPending?.deadInterval,
            networkType: rPending?.networkType as any,
          });
          if (rPending) {
            const iface = r.ospfEngine.getInterface(rm.name);
            if (iface) {
              if (rPending.authType !== undefined) iface.authType = rPending.authType;
              if (rPending.authKey !== undefined) iface.authKey = rPending.authKey;
            }
          }
        }
      }
    }

    // Form adjacencies between all directly connected routers that haven't formed them yet
    for (const r1 of allRouters) {
      if (!r1.ospfEngine) continue;
      for (const [portName, port] of r1.ports) {
        const cable = port.getCable();
        if (!cable) continue;
        const localIface = r1.ospfEngine.getInterface(portName);
        if (!localIface) continue;
        if (localIface.passive) continue;

        const remotePort = cable.getPortA() === port ? cable.getPortB() : cable.getPortA();
        if (!remotePort) continue;

        // Collect candidate routers (direct or through switch)
        const candidates: Array<{ router: Router; port: Port }> = [];
        const remoteEquip = Equipment.getById(remotePort.getEquipmentId());
        if (remoteEquip instanceof Router && remoteEquip.ospfEngine) {
          candidates.push({ router: remoteEquip, port: remotePort });
        } else if (remoteEquip && !(remoteEquip instanceof Router)) {
          for (const swPort of remoteEquip.getPorts()) {
            if (swPort === remotePort) continue;
            const swCable = swPort.getCable();
            if (!swCable) continue;
            const otherEnd = swCable.getPortA() === swPort ? swCable.getPortB() : swCable.getPortA();
            if (!otherEnd) continue;
            const otherEquip = Equipment.getById(otherEnd.getEquipmentId());
            if (otherEquip instanceof Router && otherEquip.ospfEngine) {
              candidates.push({ router: otherEquip, port: otherEnd });
            }
          }
        }

        for (const { router: r2, port: rPort } of candidates) {
          if (!r2.ospfEngine) continue;
          const remoteIface = r2.ospfEngine.getInterface(rPort.getName());
          if (!remoteIface) continue;
          if (remoteIface.passive) continue;

          // Check auth and timer compatibility
          const localAuth = localIface.authType ?? 0;
          const remoteAuth = remoteIface.authType ?? 0;
          if (localAuth !== remoteAuth) continue;
          if (localAuth !== 0 && localIface.authKey !== remoteIface.authKey) continue;
          if (localIface.helloInterval !== remoteIface.helloInterval) continue;
          if (localIface.deadInterval !== remoteIface.deadInterval) continue;

          const localRid = r1.ospfEngine.getRouterId();
          const remoteRid = r2.ospfEngine.getRouterId();
          r1._ospfFormAdjacency(r1.ospfEngine, localIface, remoteIface, remoteRid, rPort);
          r2._ospfFormAdjacency(r2.ospfEngine, remoteIface, localIface, localRid, port);
        }
      }
    }

    // Form adjacencies over GRE tunnels
    for (const r1 of allRouters) {
      if (!r1.ospfEngine) continue;
      for (const [tunName, tunPort] of r1.ports) {
        if (!tunName.startsWith('Tunnel')) continue;
        const localIface = r1.ospfEngine.getInterface(tunName);
        if (!localIface) continue;
        const tunCfg = r1.ospfExtraConfig.pendingIfConfig.get(tunName);
        const tunDest = (tunCfg as any)?.tunnelDest;
        if (!tunDest) continue;
        // Find the remote router that owns the tunnel destination IP
        for (const r2 of allRouters) {
          if (r1 === r2 || !r2.ospfEngine) continue;
          for (const [pn, p] of r2.ports) {
            if (p.getIPAddress()?.toString() === tunDest) {
              // Find r2's matching tunnel interface
              for (const [tn2, tp2] of r2.ports) {
                if (!tn2.startsWith('Tunnel')) continue;
                const remoteIface = r2.ospfEngine.getInterface(tn2);
                if (!remoteIface) continue;
                const localRid = r1.ospfEngine.getRouterId();
                const remoteRid = r2.ospfEngine.getRouterId();
                r1._ospfFormAdjacency(r1.ospfEngine, localIface, remoteIface, remoteRid, tp2);
                r2._ospfFormAdjacency(r2.ospfEngine, remoteIface, localIface, localRid, tunPort);
              }
            }
          }
        }
      }
    }

    // Each router originates its Router LSA for each area
    for (const r of allRouters) {
      if (!r.ospfEngine) continue;
      for (const [areaId] of r.ospfEngine.getConfig().areas) {
        r.ospfEngine.originateRouterLSA(areaId);
      }
      // Originate Network LSAs for DR interfaces
      for (const [, iface] of r.ospfEngine.getInterfaces()) {
        if (iface.state === 'DR') {
          r.ospfEngine.originateNetworkLSA(iface);
        }
      }
    }

    // Sync LSDBs: copy all LSAs between routers that share an area
    for (const r1 of allRouters) {
      if (!r1.ospfEngine) continue;
      for (const r2 of allRouters) {
        if (r1 === r2 || !r2.ospfEngine) continue;
        const r2LSDB = r2.ospfEngine.getLSDB();
        // Copy area LSAs only for shared areas
        const r1Areas = new Set(r1.ospfEngine.getConfig().areas.keys());
        for (const [areaId, areaDB] of r2LSDB.areas) {
          if (r1Areas.has(areaId)) {
            for (const [, lsa] of areaDB) {
              r1.ospfEngine.installLSA(areaId, lsa);
            }
          }
        }
        // Copy external LSAs to all routers
        for (const [, lsa] of r2LSDB.external) {
          r1.ospfEngine.installLSA('0', lsa);
        }
      }
    }

    // Run SPF and install routes for each router (including external, inter-area, stub)
    for (const r of allRouters) {
      if (!r.ospfEngine) continue;
      const routes = r.ospfEngine.runSPF();

      // Compute additional routes: external, inter-area, stub defaults
      const extraRoutes = r._computeAdvancedOSPFRoutes(allRouters);
      const allOSPFRoutes = [...routes, ...extraRoutes];

      // Debug: log routes for debugging
      if ((globalThis as any).__OSPF_DEBUG) {
        const rid = r.ospfEngine.getRouterId();
        console.log(`[OSPF-DBG] ${r.name} (${rid}): SPF routes=${routes.length}, extra=${extraRoutes.length}`);
        for (const rt of routes) console.log(`  SPF: ${rt.network}/${rt.mask} via ${rt.nextHop} iface=${rt.iface} cost=${rt.cost}`);
        for (const rt of extraRoutes) console.log(`  EXT: ${rt.network}/${rt.mask} via ${rt.nextHop} type=${rt.routeType}`);
      }

      r._installOSPFRoutes(allOSPFRoutes);
    }
  }

  /**
   * Compute advanced OSPF routes: external (E1/E2), inter-area (IA), stub defaults, NSSA.
   */
  private _computeAdvancedOSPFRoutes(allRouters: Router[]): any[] {
    if (!this.ospfEngine) return [];
    const routes: any[] = [];
    const extra = this.ospfExtraConfig;
    const myAreas = new Set(this.ospfEngine.getConfig().areas.keys());
    const isABR = myAreas.size > 1;

    // ── External routes (default-information originate, redistribute static) ──
    for (const r of allRouters) {
      if (r === this || !r.ospfEngine) continue;
      const rExtra = r.ospfExtraConfig;

      // default-information originate → inject default route as external
      if (r.ospfEngine.getConfig().defaultInformationOriginate) {
        // Check that originating router has a default route
        const hasDefault = r.routingTable.some(rt => rt.type === 'default' || (rt.type === 'static' &&
          rt.network.toString() === '0.0.0.0' && rt.mask.toString() === '0.0.0.0'));
        if (hasDefault) {
          const nh = this._findNextHopTo(r);
          if (nh) {
            const metricType = rExtra.defaultInfoMetricType ?? 2;
            const cost = metricType === 1 ? 1 + (nh.cost || 0) : 1;
            routes.push({
              network: '0.0.0.0', mask: '0.0.0.0',
              nextHop: nh.nextHop, iface: nh.iface,
              cost, routeType: metricType === 1 ? 'type1-external' : 'type2-external',
              areaId: '0', advertisingRouter: r.ospfEngine.getRouterId(),
              _metricType: metricType, _isDefault: true,
            });
          }
        }
      }

      // redistribute static → inject static routes as external
      if (rExtra.redistributeStatic) {
        for (const rt of r.routingTable) {
          if (rt.type !== 'static') continue;
          if (rt.network.toString() === '0.0.0.0') continue; // skip default
          const nh = this._findNextHopTo(r);
          if (nh) {
            const metricType = rExtra.redistributeStatic.metricType ?? 2;
            const cost = metricType === 1 ? 20 + (nh.cost || 0) : 20;
            routes.push({
              network: rt.network.toString(), mask: rt.mask.toString(),
              nextHop: nh.nextHop, iface: nh.iface,
              cost, routeType: metricType === 1 ? 'type1-external' : 'type2-external',
              areaId: '0', advertisingRouter: r.ospfEngine.getRouterId(),
              _metricType: metricType,
            });
          }
        }
      }

      // redistribute connected → inject connected routes as external
      if (rExtra.redistributeConnected) {
        for (const rt of r.routingTable) {
          if (rt.type !== 'connected') continue;
          // Skip interfaces that are already OSPF-enabled
          const ospfIface = r.ospfEngine.getInterface(rt.iface);
          if (ospfIface) continue;
          const nh = this._findNextHopTo(r);
          if (nh) {
            routes.push({
              network: rt.network.toString(), mask: rt.mask.toString(),
              nextHop: nh.nextHop, iface: nh.iface,
              cost: 20, routeType: 'type2-external',
              areaId: '0', advertisingRouter: r.ospfEngine.getRouterId(),
              _metricType: 2,
            });
          }
        }
      }
    }

    // ── Inter-area routes (O IA) ──
    // For each router in a different area, advertise its intra-area routes to us
    for (const r of allRouters) {
      if (r === this || !r.ospfEngine) continue;
      const rAreas = new Set(r.ospfEngine.getConfig().areas.keys());
      const rIsABR = rAreas.size > 1;

      if (rIsABR) {
        // This router is an ABR - it can give us inter-area routes
        const rRoutes = r.ospfEngine.getRoutes();
        const rExtra = r.ospfExtraConfig;
        for (const rt of rRoutes) {
          // Only advertise routes from areas we don't have
          if (myAreas.has(rt.areaId)) continue;

          const nh = this._findNextHopTo(r);
          if (!nh) continue;

          // Check if ABR has area range summarization
          let shouldAdvertise = true;
          let summarized = false;

          if (rExtra.areaRanges.has(rt.areaId)) {
            const ranges = rExtra.areaRanges.get(rt.areaId)!;
            for (const range of ranges) {
              if (this._ipInSubnet(rt.network, range.network, range.mask)) {
                shouldAdvertise = false; // suppress individual routes
                summarized = true;
              }
            }
          }
          if (!shouldAdvertise) continue;

          routes.push({
            network: rt.network, mask: rt.mask,
            nextHop: nh.nextHop, iface: nh.iface,
            cost: rt.cost + (nh.cost || 0),
            routeType: 'inter-area', areaId: rt.areaId,
            advertisingRouter: r.ospfEngine.getRouterId(),
          });
        }

        // Advertise summarized ranges
        if (rExtra.areaRanges) {
          for (const [areaId, ranges] of rExtra.areaRanges) {
            if (myAreas.has(areaId)) continue;
            const rRoutes2 = r.ospfEngine.getRoutes();
            for (const range of ranges) {
              // Check if any route in this area matches the range
              const hasMatch = rRoutes2.some(
                rt => rt.areaId === areaId && this._ipInSubnet(rt.network, range.network, range.mask)
              );
              if (hasMatch) {
                const nh = this._findNextHopTo(r);
                if (nh) {
                  routes.push({
                    network: range.network, mask: range.mask,
                    nextHop: nh.nextHop, iface: nh.iface,
                    cost: (nh.cost || 0) + 1,
                    routeType: 'inter-area', areaId,
                    advertisingRouter: r.ospfEngine.getRouterId(),
                  });
                }
              }
            }
          }
        }
      }
    }

    // ── Virtual link: propagate routes through transit area ──
    // For each router with a virtual-link, propagate intra-area routes from the remote
    // end of the virtual link as inter-area routes
    for (const r of allRouters) {
      if (r === this || !r.ospfEngine) continue;
      const rExtra = r.ospfExtraConfig;
      if (rExtra.virtualLinks.size === 0) continue;

      for (const [transitAreaId, peerRid] of rExtra.virtualLinks) {
        // Find the peer router
        const peer = allRouters.find(rr => rr.ospfEngine?.getRouterId() === peerRid);
        if (!peer || !peer.ospfEngine) continue;
        // The peer should also have a reciprocal virtual link
        const peerExtra = peer.ospfExtraConfig;
        if (!peerExtra.virtualLinks.has(transitAreaId)) continue;

        // Get routes from routers beyond the virtual link
        // First check if 'r' is reachable from us
        const nhToR = this._findNextHopTo(r);
        if (!nhToR) continue;

        // Get all routes from the peer's side that we don't have
        const peerRoutes = peer.ospfEngine.getRoutes();
        for (const prt of peerRoutes) {
          // Skip if we already have this network
          const alreadyHave = routes.some(
            rt => rt.network === prt.network && rt.mask === prt.mask
          );
          if (alreadyHave) continue;
          // Skip if it's in our own area
          if (myAreas.has(prt.areaId)) continue;

          routes.push({
            network: prt.network, mask: prt.mask,
            nextHop: nhToR.nextHop, iface: nhToR.iface,
            cost: prt.cost + (nhToR.cost || 0),
            routeType: 'inter-area', areaId: prt.areaId,
            advertisingRouter: peer.ospfEngine.getRouterId(),
          });
        }

        // Also propagate connected routes from routers beyond the virtual link
        for (const farRouter of allRouters) {
          if (farRouter === this || !farRouter.ospfEngine) continue;
          // Check if farRouter is only reachable through the virtual link peer
          const nhToFar = this._findNextHopTo(farRouter);
          if (!nhToFar) continue;
          const farRoutes = farRouter.ospfEngine.getRoutes();
          for (const frt of farRoutes) {
            if (myAreas.has(frt.areaId)) continue;
            const alreadyHave = routes.some(
              rt => rt.network === frt.network && rt.mask === frt.mask
            );
            if (alreadyHave) continue;
            routes.push({
              network: frt.network, mask: frt.mask,
              nextHop: nhToFar.nextHop, iface: nhToFar.iface,
              cost: frt.cost + (nhToFar.cost || 0),
              routeType: 'inter-area', areaId: frt.areaId,
              advertisingRouter: farRouter.ospfEngine.getRouterId(),
            });
          }
        }
      }
    }

    // ── Stub area default route ──
    // If this router is in a stub area and the ABR advertises a default
    for (const [areaId, area] of this.ospfEngine.getConfig().areas) {
      if (area.type !== 'stub' && area.type !== 'totally-stubby') continue;
      // Find ABR for this area
      for (const r of allRouters) {
        if (r === this || !r.ospfEngine) continue;
        const rAreas = r.ospfEngine.getConfig().areas;
        if (!rAreas.has(areaId)) continue;
        if (rAreas.size <= 1) continue; // not an ABR
        // This router is the ABR for our stub area
        const nh = this._findNextHopTo(r);
        if (nh) {
          routes.push({
            network: '0.0.0.0', mask: '0.0.0.0',
            nextHop: nh.nextHop, iface: nh.iface,
            cost: (nh.cost || 0) + 1,
            routeType: 'inter-area', areaId,
            advertisingRouter: r.ospfEngine.getRouterId(),
            _isDefault: true, _isStubDefault: true,
          });
        }
      }

      // For totally-stubby areas, filter out inter-area routes from other areas
      if (area.type === 'totally-stubby' && !isABR) {
        const filtered = routes.filter(rt => {
          if (rt.routeType === 'inter-area' && !rt._isStubDefault) return false;
          return true;
        });
        routes.length = 0;
        routes.push(...filtered);
      }
    }

    // ── NSSA: Convert external routes from NSSA ASBR to Type 5 for backbone ──
    // For routers in backbone seeing NSSA routes through ABR
    for (const r of allRouters) {
      if (r === this || !r.ospfEngine) continue;
      const rExtra = r.ospfExtraConfig;
      const rAreas = r.ospfEngine.getConfig().areas;

      // Check if r is in an NSSA area and redistributes
      for (const [areaId, area] of rAreas) {
        if (area.type !== 'nssa') continue;
        if (!rExtra.redistributeStatic) continue;

        // r is in NSSA and redistributes static routes
        // We need an ABR between us and r
        for (const abr of allRouters) {
          if (!abr.ospfEngine) continue;
          const abrAreas = abr.ospfEngine.getConfig().areas;
          if (!abrAreas.has(areaId) || abrAreas.size <= 1) continue;
          // ABR connects NSSA to backbone
          if (!myAreas.has('0') && !myAreas.has('0.0.0.0')) continue;

          for (const rt of r.routingTable) {
            if (rt.type !== 'static') continue;
            if (rt.network.toString() === '0.0.0.0') continue;
            const nh = this._findNextHopTo(abr);
            if (nh) {
              routes.push({
                network: rt.network.toString(), mask: rt.mask.toString(),
                nextHop: nh.nextHop, iface: nh.iface,
                cost: 20, routeType: 'type2-external',
                areaId: '0', advertisingRouter: r.ospfEngine.getRouterId(),
                _metricType: 2,
              });
            }
          }
        }
      }
    }

    return routes;
  }

  /** Find the next hop and interface to reach a target router */
  private _findNextHopTo(target: Router): { nextHop: string; iface: string; cost: number } | null {
    if (!this.ospfEngine) return null;

    // Direct neighbor?
    for (const [portName, port] of this.ports) {
      const cable = port.getCable();
      if (!cable) continue;
      const remotePort = cable.getPortA() === port ? cable.getPortB() : cable.getPortA();
      if (!remotePort) continue;
      const remoteEquipId = remotePort.getEquipmentId();

      if (remoteEquipId === target.id) {
        const remoteIP = remotePort.getIPAddress()?.toString();
        if (remoteIP) {
          const localIface = this.ospfEngine.getInterface(portName);
          const cost = localIface?.cost ?? 1;
          return { nextHop: remoteIP, iface: portName, cost };
        }
      }

      // Check through switch
      const remoteEquip = Equipment.getById(remoteEquipId);
      if (remoteEquip && !(remoteEquip instanceof Router)) {
        for (const swPort of remoteEquip.getPorts()) {
          if (swPort === remotePort) continue;
          const swCable = swPort.getCable();
          if (!swCable) continue;
          const otherEnd = swCable.getPortA() === swPort ? swCable.getPortB() : swCable.getPortA();
          if (!otherEnd) continue;
          if (otherEnd.getEquipmentId() === target.id) {
            const remoteIP = otherEnd.getIPAddress()?.toString();
            if (remoteIP) {
              const localIface = this.ospfEngine.getInterface(portName);
              const cost = localIface?.cost ?? 1;
              return { nextHop: remoteIP, iface: portName, cost };
            }
          }
        }
      }
    }

    // Not directly connected - find via SPF routes
    const ospfRoutes = this.ospfEngine.getRoutes();
    for (const [, port] of target.ports) {
      const ip = port.getIPAddress()?.toString();
      if (!ip) continue;
      for (const rt of ospfRoutes) {
        if (rt.nextHop && this._ipInSubnet(ip, rt.network, rt.mask)) {
          return { nextHop: rt.nextHop, iface: rt.iface, cost: rt.cost };
        }
      }
    }

    // BFS through adjacency chain to find path to target
    const visited = new Set<string>();
    const queue: Array<{ router: Router; nextHop: string; iface: string; cost: number }> = [];
    visited.add(this.id);

    // Seed with direct neighbors
    for (const [portName, port] of this.ports) {
      const cable = port.getCable();
      if (!cable) continue;
      const remotePort = cable.getPortA() === port ? cable.getPortB() : cable.getPortA();
      if (!remotePort) continue;
      const remoteEquipId = remotePort.getEquipmentId();
      const remoteEquip = Equipment.getById(remoteEquipId);

      const addCandidate = (r: Router, rPort: Port) => {
        if (visited.has(r.id) || !r.ospfEngine) return;
        const remoteIP = rPort.getIPAddress()?.toString();
        if (!remoteIP) return;
        const localIface = this.ospfEngine!.getInterface(portName);
        const cost = localIface?.cost ?? 1;
        visited.add(r.id);
        queue.push({ router: r, nextHop: remoteIP, iface: portName, cost });
      };

      if (remoteEquip instanceof Router) {
        addCandidate(remoteEquip, remotePort);
      } else if (remoteEquip && !(remoteEquip instanceof Router)) {
        for (const swPort of remoteEquip.getPorts()) {
          if (swPort === remotePort) continue;
          const swCable = swPort.getCable();
          if (!swCable) continue;
          const otherEnd = swCable.getPortA() === swPort ? swCable.getPortB() : swCable.getPortA();
          if (!otherEnd) continue;
          const otherEquip = Equipment.getById(otherEnd.getEquipmentId());
          if (otherEquip instanceof Router) addCandidate(otherEquip, otherEnd);
        }
      }
    }

    while (queue.length > 0) {
      const { router: curr, nextHop, iface, cost } = queue.shift()!;
      if (curr.id === target.id) {
        return { nextHop, iface, cost };
      }
      // Continue BFS through curr's neighbors
      for (const [pn, p] of curr.ports) {
        const cable = p.getCable();
        if (!cable) continue;
        const rp = cable.getPortA() === p ? cable.getPortB() : cable.getPortA();
        if (!rp) continue;
        const rid = rp.getEquipmentId();
        if (visited.has(rid)) continue;
        const re = Equipment.getById(rid);
        if (re instanceof Router && re.ospfEngine) {
          visited.add(rid);
          const currIface = curr.ospfEngine?.getInterface(pn);
          queue.push({ router: re, nextHop, iface, cost: cost + (currIface?.cost ?? 1) });
        } else if (re && !(re instanceof Router)) {
          for (const swPort of re.getPorts()) {
            if (swPort === rp) continue;
            const swCable = swPort.getCable();
            if (!swCable) continue;
            const otherEnd = swCable.getPortA() === swPort ? swCable.getPortB() : swCable.getPortA();
            if (!otherEnd) continue;
            const oid = otherEnd.getEquipmentId();
            if (visited.has(oid)) continue;
            const oe = Equipment.getById(oid);
            if (oe instanceof Router && oe.ospfEngine) {
              visited.add(oid);
              const currIface = curr.ospfEngine?.getInterface(pn);
              queue.push({ router: oe, nextHop, iface, cost: cost + (currIface?.cost ?? 1) });
            }
          }
        }
      }
    }

    return null;
  }

  private _ipInSubnet(ip: string, network: string, mask: string): boolean {
    const ipNum = this._ipToNum(ip);
    const netNum = this._ipToNum(network);
    const maskNum = this._ipToNum(mask);
    return (ipNum & maskNum) === (netNum & maskNum);
  }

  private _ipToNum(ip: string): number {
    const parts = ip.split('.').map(Number);
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  }

  /** Install OSPF-computed routes into the RIB */
  private _installOSPFRoutes(routes: any[]): void {
    // Remove old OSPF routes
    this.routingTable = this.routingTable.filter(r => r.type !== 'ospf');

    // Distribute-list filtering
    const distList = this.ospfExtraConfig.distributeList;

    for (const route of routes) {
      const network = route.network || route.destination;
      const mask = route.mask;
      const iface = route.iface || route.interface || '';
      const nextHop = route.nextHop;

      if (!network || !mask) continue;

      // Don't install if a connected route already covers it
      const existing = this.routingTable.find(
        r => r.type === 'connected' &&
             r.network.toString() === network &&
             r.mask.toString() === mask
      );
      if (existing) continue;

      // Apply distribute-list inbound filtering
      if (distList && distList.direction === 'in') {
        const acl = this.accessLists.find(a => a.id === parseInt(distList.aclId) || a.name === distList.aclId);
        if (acl) {
          let matched = false;
          let action: 'permit' | 'deny' = 'deny'; // implicit deny
          for (const entry of acl.entries) {
            // Standard ACL: match source IP (which is the route network)
            const srcIP = entry.srcIP?.toString() || '0.0.0.0';
            const srcWild = entry.srcWildcard?.toString() || '255.255.255.255';
            if (srcIP === 'any' || srcIP === '0.0.0.0' && srcWild === '255.255.255.255') {
              action = entry.action;
              matched = true;
              break;
            }
            // Check if route network matches the ACL entry
            const netNum = this._ipToNum(network);
            const aclNum = this._ipToNum(srcIP);
            const wildNum = this._ipToNum(srcWild);
            if ((netNum & ~wildNum) === (aclNum & ~wildNum)) {
              action = entry.action;
              matched = true;
              break;
            }
          }
          if (matched && action === 'deny') continue; // filter out this route
          if (!matched) continue; // implicit deny
        }
      }

      const entry: any = {
        network: new IPAddress(network),
        mask: new SubnetMask(mask),
        nextHop: nextHop ? new IPAddress(nextHop) : null,
        iface,
        type: 'ospf' as any,
        ad: 110,
        metric: route.cost ?? 0,
      };
      // Preserve OSPF route metadata for display
      if (route.routeType) entry.routeType = route.routeType;
      if (route._metricType) entry._metricType = route._metricType;
      if (route._isDefault) entry._isDefault = route._isDefault;
      if (route._isStubDefault) entry._isStubDefault = route._isStubDefault;
      this.routingTable.push(entry);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // OSPF Extended Config (used by CLI commands)
  // ═══════════════════════════════════════════════════════════════════

  /** OSPF extra config that's not in the engine (advanced features) */
  private ospfExtraConfig: {
    spfThrottle?: { initial: number; hold: number; max: number };
    maxLsa?: number;
    gracefulRestart?: { enabled: boolean; gracePeriod: number };
    bfdAllInterfaces?: boolean;
    redistributeStatic?: { subnets: boolean; metricType: number };
    redistributeConnected?: { subnets: boolean };
    areaRanges: Map<string, Array<{ network: string; mask: string }>>;
    virtualLinks: Map<string, string>; // areaId -> neighborRouterId
    distributeList?: { aclId: string; direction: 'in' | 'out' };
    defaultInfoMetricType?: number;
    /** Pending per-interface OSPF config (applied when interface activates) */
    pendingIfConfig: Map<string, { cost?: number; priority?: number; helloInterval?: number; deadInterval?: number; authType?: number; authKey?: string; demandCircuit?: boolean; networkType?: string }>;
    /** Pending per-interface OSPFv3 config */
    pendingV3IfConfig: Map<string, { cost?: number; priority?: number; networkType?: string; ipsecAuth?: boolean }>;
    /** OSPFv3 redistribute static */
    redistributeV3Static?: boolean;
    /** OSPFv3 area ranges for summarization */
    v3AreaRanges: Map<string, Array<{ prefix: string }>>;
    /** OSPFv3 virtual links */
    v3VirtualLinks: Map<string, string>;
    /** OSPFv3 distribute-list */
    v3DistributeList?: { aclId: string; direction: 'in' | 'out' };
  } = {
    areaRanges: new Map(),
    virtualLinks: new Map(),
    pendingIfConfig: new Map(),
    pendingV3IfConfig: new Map(),
    v3AreaRanges: new Map(),
    v3VirtualLinks: new Map(),
  };

  /** @internal */
  _getOSPFExtraConfig() { return this.ospfExtraConfig; }

  /** @internal Used by CLI shells */
  _enableOSPFv3(processId: number = 1): void {
    if (this.ospfv3Engine) return;
    this.ospfv3Engine = new OSPFv3Engine(processId);
    Logger.info(this.id, 'ospfv3:enabled', `${this.name}: OSPFv3 process ${processId} enabled`);
  }

  // ─── OS Info ───────────────────────────────────────────────────

  getOSType(): string { return this.shell.getOSType(); }
}


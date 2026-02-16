/**
 * EndHost - Base class for end-user devices (PCs, servers)
 *
 * Implements the full L2/L3 network stack shared by all end-hosts:
 * - ARP resolution (RFC 826)
 * - IPv4 packet handling with proper encapsulation (RFC 791)
 * - ICMP echo request/reply (RFC 792)
 * - Default gateway for inter-subnet communication
 * - Real RTT measurement using performance.now()
 *
 * Subclasses (LinuxPC, WindowsPC) only implement terminal commands
 * and OS-specific output formatting.
 *
 * Encapsulation:
 *   Ethernet Frame
 *     ├─ ARP Packet (etherType 0x0806) — direct L2
 *     └─ IPv4 Packet (etherType 0x0800)
 *          └─ ICMP Packet (protocol 1)
 */

import { Equipment } from '../equipment/Equipment';
import { Port } from '../hardware/Port';
import {
  EthernetFrame, IPv4Packet, MACAddress, IPAddress, SubnetMask,
  ARPPacket, ICMPPacket,
  ETHERTYPE_ARP, ETHERTYPE_IPV4, ETHERTYPE_IPV6,
  IP_PROTO_ICMP, IP_PROTO_ICMPV6,
  createIPv4Packet, verifyIPv4Checksum,
  // IPv6 types
  IPv6Address, IPv6Packet, ICMPv6Packet, NDPNeighborSolicitation, NDPNeighborAdvertisement,
  NDPRouterAdvertisement, NDPOptionPrefixInfo,
  createIPv6Packet, createNeighborSolicitation, createNeighborAdvertisement,
  createICMPv6EchoRequest, createICMPv6EchoReply, createRouterSolicitation,
  IPV6_ALL_NODES_MULTICAST, IPV6_ALL_ROUTERS_MULTICAST,
} from '../core/types';
import { Logger } from '../core/Logger';
import { DHCPClient } from '../dhcp/DHCPClient';
import type { DHCPClientIfaceState } from '../dhcp/types';
import type { DHCPServer } from '../dhcp/DHCPServer';

// ─── Internal Types ────────────────────────────────────────────────

interface ARPEntry {
  mac: MACAddress;
  /** Interface on which this entry was learned */
  iface: string;
  timestamp: number;
}

interface PendingARP {
  resolve: (mac: MACAddress) => void;
  reject: (reason: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface PingResult {
  success: boolean;
  rttMs: number;
  ttl: number;
  /** ICMP error message (e.g. "Time to live exceeded", "Destination unreachable") */
  error?: string;
  seq: number;
  bytes: number;
  fromIP: string;
}

interface PendingPing {
  resolve: (result: PingResult) => void;
  reject: (reason: string) => void;
  timer: ReturnType<typeof setTimeout>;
  sentAt: number; // performance.now() timestamp
}

// ─── IPv6 Neighbor Cache (RFC 4861) ─────────────────────────────────

export type NeighborState = 'incomplete' | 'reachable' | 'stale' | 'delay' | 'probe';

export interface NeighborCacheEntry {
  /** Link-layer (MAC) address */
  mac: MACAddress;
  /** Interface on which this neighbor is reachable */
  iface: string;
  /** NDP state machine state */
  state: NeighborState;
  /** Whether this neighbor is a router */
  isRouter: boolean;
  /** Last reachability confirmation timestamp */
  timestamp: number;
}

interface PendingNDP {
  resolve: (mac: MACAddress) => void;
  reject: (reason: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ─── IPv6 Routing Table Entry ────────────────────────────────────────

export interface HostIPv6RouteEntry {
  /** Network prefix */
  prefix: IPv6Address;
  /** Prefix length (0-128) */
  prefixLength: number;
  /** Next-hop IPv6 address (null for on-link) */
  nextHop: IPv6Address | null;
  /** Outgoing interface */
  iface: string;
  /** Route type */
  type: 'connected' | 'static' | 'default' | 'ra';
  /** Metric */
  metric: number;
}

// ─── Routing Table Types ──────────────────────────────────────────

export interface HostRouteEntry {
  /** Network destination (e.g. 192.168.2.0) */
  network: IPAddress;
  /** Subnet mask (e.g. 255.255.255.0) */
  mask: SubnetMask;
  /** Next-hop IP (null for directly connected — use destination directly) */
  nextHop: IPAddress | null;
  /** Outgoing interface name (e.g. eth0) */
  iface: string;
  /** Route type */
  type: 'connected' | 'static' | 'default';
  /** Metric (lower = preferred when prefix lengths are equal) */
  metric: number;
}

// ─── EndHost ───────────────────────────────────────────────────────

export abstract class EndHost extends Equipment {
  // ─── IPv4 State ─────────────────────────────────────────────────
  /** ARP cache: IP string → { mac, iface, timestamp } */
  protected arpTable: Map<string, ARPEntry> = new Map();
  /** Pending ARP resolutions: IP string → callbacks[] */
  protected pendingARPs: Map<string, PendingARP[]> = new Map();
  /** Pending ICMP echo replies: "srcIP-id-seq" → callback */
  protected pendingPings: Map<string, PendingPing> = new Map();
  /** Monotonically increasing ICMP echo identifier */
  protected pingIdCounter: number = 0;
  /** Default gateway IP (set via `ip route add default via ...` or `route add`) */
  protected defaultGateway: IPAddress | null = null;
  /** Full routing table (connected + static + default) with LPM support */
  protected routingTable: HostRouteEntry[] = [];

  // ─── IPv6 State (RFC 4861, RFC 8200) ─────────────────────────────
  /** Neighbor cache: IPv6 string → { mac, iface, state, isRouter, timestamp } */
  protected neighborCache: Map<string, NeighborCacheEntry> = new Map();
  /** Pending NDP resolutions: IPv6 string → callbacks[] */
  protected pendingNDPs: Map<string, PendingNDP[]> = new Map();
  /** Pending ICMPv6 echo replies: "srcIP-id-seq" → callback */
  protected pendingPing6s: Map<string, PendingPing> = new Map();
  /** Monotonically increasing ICMPv6 echo identifier */
  protected ping6IdCounter: number = 0;
  /** Default IPv6 gateway (learned from RA or configured) */
  protected defaultGateway6: IPv6Address | null = null;
  /** IPv6 routing table */
  protected ipv6RoutingTable: HostIPv6RouteEntry[] = [];

  // ─── DHCP Client (RFC 2131) ─────────────────────────────────────
  protected dhcpClient: DHCPClient;
  /** Track DHCP-configured interfaces for 'dynamic' display */
  protected dhcpInterfaces: Set<string> = new Set();

  /** Default TTL for outgoing packets (Linux=64, Windows=128) */
  protected abstract readonly defaultTTL: number;
  /** Default Hop Limit for IPv6 (typically same as TTL) */
  protected get defaultHopLimit(): number { return this.defaultTTL; }

  constructor(type: any, name: string, x: number, y: number) {
    super(type, name, x, y);
    this.dhcpClient = new DHCPClient(
      (iface: string) => {
        const port = this.ports.get(iface);
        return port ? port.getMAC().toString() : '00:00:00:00:00:00';
      },
      (iface: string, ip: string, mask: string, gateway: string | null) => {
        this.configureInterface(iface, new IPAddress(ip), new SubnetMask(mask));
        if (gateway) this.setDefaultGateway(new IPAddress(gateway));
        this.dhcpInterfaces.add(iface);
      },
      (iface: string) => {
        const port = this.ports.get(iface);
        if (port) port.clearIP();
        // Remove connected route for this interface
        this.routingTable = this.routingTable.filter(
          r => !(r.type === 'connected' && r.iface === iface)
        );
        this.defaultGateway = null;
        this.routingTable = this.routingTable.filter(r => r.type !== 'default');
        this.dhcpInterfaces.delete(iface);
      },
    );
  }

  // ─── Interface Configuration ───────────────────────────────────

  getInterface(name: string): Port | undefined { return this.getPort(name); }
  getInterfaces(): Port[] { return this.getPorts(); }

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
      metric: 0,
    });

    Logger.info(this.id, 'host:interface-config',
      `${this.name}: ${ifName} configured ${ip}/${mask.toCIDR()}`);
    return true;
  }

  // ─── Default Gateway ──────────────────────────────────────────

  getDefaultGateway(): IPAddress | null { return this.defaultGateway; }

  setDefaultGateway(gw: IPAddress): void {
    this.defaultGateway = gw;

    // Remove old default route and add new one
    this.routingTable = this.routingTable.filter(r => r.type !== 'default');

    // Find the interface the gateway is reachable through
    let gwIface = '';
    for (const [, port] of this.ports) {
      const ip = port.getIPAddress();
      const mask = port.getSubnetMask();
      if (ip && mask && ip.isInSameSubnet(gw, mask)) {
        gwIface = port.getName();
        break;
      }
    }

    this.routingTable.push({
      network: new IPAddress('0.0.0.0'),
      mask: new SubnetMask('0.0.0.0'),
      nextHop: gw,
      iface: gwIface,
      type: 'default',
      metric: 0,
    });

    Logger.info(this.id, 'host:gateway', `${this.name}: default gateway set to ${gw}`);
  }

  clearDefaultGateway(): void {
    this.defaultGateway = null;
    this.routingTable = this.routingTable.filter(r => r.type !== 'default');
  }

  // ─── DHCP Client API ──────────────────────────────────────────

  getDHCPClient(): DHCPClient { return this.dhcpClient; }

  getDHCPState(iface: string): { state: string; xid?: number } {
    const s = this.dhcpClient.getState(iface);
    return { state: s.state, xid: s.xid };
  }

  getDHCPLogs(iface: string): string {
    return this.dhcpClient.getLogs(iface);
  }

  getMACAddress(iface: string): MACAddress {
    const port = this.ports.get(iface);
    if (!port) throw new Error(`Interface ${iface} not found`);
    return port.getMAC();
  }

  setMACAddress(iface: string, mac: MACAddress): void {
    const port = this.ports.get(iface);
    if (!port) throw new Error(`Interface ${iface} not found`);
    port.setMAC(mac);
  }

  isDHCPConfigured(iface: string): boolean {
    return this.dhcpInterfaces.has(iface);
  }

  /**
   * Auto-discover DHCP servers reachable through the network topology.
   * Traverses cables and switches to find Routers with DHCP servers,
   * and falls back to scanning all Equipment instances (simulator convenience).
   */
  autoDiscoverDHCPServers(): void {
    this.dhcpClient.clearServers();
    const visited = new Set<string>();

    // Helper: check if an Equipment is a Router with a DHCP server
    const tryRegisterRouter = (equip: Equipment) => {
      if (visited.has(equip.getId())) return;
      visited.add(equip.getId());
      // Use duck-typing to check for getDHCPServer method (avoids circular import of Router)
      const router = equip as any;
      if (typeof router.getDHCPServer === 'function') {
        const dhcpServer: DHCPServer = router.getDHCPServer();
        if (dhcpServer && dhcpServer.isEnabled()) {
          // Find a configured IP on the router to use as server identifier
          const routerPorts = equip.getPorts();
          let serverIP = '0.0.0.0';
          for (const rPort of routerPorts) {
            const ip = rPort.getIPAddress();
            if (ip) { serverIP = ip.toString(); break; }
          }
          this.dhcpClient.registerServer(dhcpServer, serverIP);
        }
      }
    };

    // Strategy 1: Traverse physical topology from our ports
    for (const [, port] of this.ports) {
      const cable = port.getCable();
      if (!cable) continue;
      const remotePort = cable.getPortA() === port ? cable.getPortB() : cable.getPortA();
      if (!remotePort) continue;
      const remoteId = remotePort.getEquipmentId();
      const remoteEquip = Equipment.getById(remoteId);
      if (!remoteEquip) continue;

      // Direct connection to a Router
      tryRegisterRouter(remoteEquip);

      // If connected to a Switch, traverse through the switch's other ports
      const remoteType = remoteEquip.getDeviceType();
      if (remoteType.includes('switch')) {
        for (const swPort of remoteEquip.getPorts()) {
          if (swPort === remotePort) continue; // Skip the port we came from
          const swCable = swPort.getCable();
          if (!swCable) continue;
          const farPort = swCable.getPortA() === swPort ? swCable.getPortB() : swCable.getPortA();
          if (!farPort) continue;
          const farId = farPort.getEquipmentId();
          const farEquip = Equipment.getById(farId);
          if (farEquip) tryRegisterRouter(farEquip);
        }
      }
    }

    // Strategy 2: Fallback — scan all Equipment instances (for tests without cables)
    if (this.dhcpClient['connectedServers'].length === 0) {
      for (const equip of Equipment.getAllEquipment()) {
        if (equip === this) continue;
        tryRegisterRouter(equip);
      }
    }
  }

  // ─── Routing Table Management ──────────────────────────────────

  getRoutingTable(): HostRouteEntry[] {
    return this.buildFullRoutingTable();
  }

  /**
   * Add a static route.
   * Returns true if the route was added successfully.
   */
  addStaticRoute(network: IPAddress, mask: SubnetMask, nextHop: IPAddress, metric: number = 100): boolean {
    // Find the interface the next-hop is reachable through
    let gwIface = '';
    for (const [, port] of this.ports) {
      const ip = port.getIPAddress();
      const pmask = port.getSubnetMask();
      if (ip && pmask && ip.isInSameSubnet(nextHop, pmask)) {
        gwIface = port.getName();
        break;
      }
    }
    if (!gwIface) {
      Logger.warn(this.id, 'host:route-add-fail',
        `${this.name}: next-hop ${nextHop} not reachable`);
      return false;
    }

    this.routingTable.push({
      network, mask, nextHop,
      iface: gwIface,
      type: 'static',
      metric,
    });

    Logger.info(this.id, 'host:route-add',
      `${this.name}: static route ${network}/${mask.toCIDR()} via ${nextHop} metric ${metric}`);
    return true;
  }

  /**
   * Remove a route by network/mask match.
   * Returns true if a route was removed.
   */
  removeRoute(network: IPAddress, mask: SubnetMask): boolean {
    const before = this.routingTable.length;
    this.routingTable = this.routingTable.filter(
      r => !(r.network.equals(network) && r.mask.toCIDR() === mask.toCIDR() && r.type === 'static')
    );
    return this.routingTable.length < before;
  }

  // ─── ARP Table ─────────────────────────────────────────────────

  getARPTable(): Map<string, MACAddress> {
    const result = new Map<string, MACAddress>();
    for (const [ip, entry] of this.arpTable) {
      result.set(ip, entry.mac);
    }
    return result;
  }

  getARPTableWithInterface(): Map<string, ARPEntry> {
    return new Map(this.arpTable);
  }

  // ─── Frame Handling (L2 → L3 dispatch) ────────────────────────

  protected handleFrame(portName: string, frame: EthernetFrame): void {
    const port = this.ports.get(portName);
    if (!port) return;

    // L2 filter: accept frames addressed to us, broadcast, or multicast
    const isForUs = frame.dstMAC.equals(port.getMAC());
    const isBroadcast = frame.dstMAC.isBroadcast();
    // IPv6 multicast MAC: 33:33:XX:XX:XX:XX
    const octets = frame.dstMAC.getOctets();
    const isMulticast = octets[0] === 0x33 && octets[1] === 0x33;

    if (!isForUs && !isBroadcast && !isMulticast) {
      return;
    }

    // For multicast, verify we're actually subscribed (have matching IPv6 address)
    if (isMulticast && frame.etherType === ETHERTYPE_IPV6) {
      // Accept all-nodes multicast (ff02::1) and solicited-node multicast for our addresses
      const ipv6 = frame.payload as IPv6Packet;
      if (!this.shouldAcceptIPv6Multicast(port, ipv6.destinationIP)) {
        return;
      }
    }

    if (frame.etherType === ETHERTYPE_ARP) {
      this.handleARP(portName, frame.payload as ARPPacket);
    } else if (frame.etherType === ETHERTYPE_IPV4) {
      this.handleIPv4(portName, frame.payload as IPv4Packet);
    } else if (frame.etherType === ETHERTYPE_IPV6) {
      this.handleIPv6(portName, frame.payload as IPv6Packet);
    }
  }

  /**
   * Check if we should accept an IPv6 multicast packet.
   * We accept: all-nodes (ff02::1), all-routers (ff02::2 for routers),
   * and solicited-node multicast for any of our unicast addresses.
   */
  private shouldAcceptIPv6Multicast(port: Port, destIP: IPv6Address): boolean {
    // All-nodes multicast (ff02::1)
    if (destIP.isAllNodesMulticast()) return true;

    // Solicited-node multicast — check if any of our addresses match
    if (destIP.isSolicitedNodeMulticast()) {
      const destHextets = destIP.getHextets();
      const low24 = ((destHextets[6] & 0xff) << 16) | destHextets[7];

      for (const entry of port.getIPv6Addresses()) {
        const addrHextets = entry.address.getHextets();
        const addrLow24 = ((addrHextets[6] & 0xff) << 16) | addrHextets[7];
        if (low24 === addrLow24) return true;
      }
    }

    return false;
  }

  // ─── ARP Handling (RFC 826) ──────────────────────────────────

  private handleARP(portName: string, arp: ARPPacket): void {
    if (!arp || arp.type !== 'arp') return;

    const port = this.ports.get(portName);
    if (!port) return;
    const myIP = port.getIPAddress();
    if (!myIP) return;

    // Learn sender's MAC→IP mapping (on the receiving interface)
    this.arpTable.set(arp.senderIP.toString(), {
      mac: arp.senderMAC,
      iface: portName,
      timestamp: Date.now(),
    });

    if (arp.operation === 'request' && arp.targetIP.equals(myIP)) {
      // ARP request for our IP → reply with our MAC
      Logger.info(this.id, 'arp:reply', `${this.name}: ARP reply for ${myIP} via ${portName}`);

      const reply: ARPPacket = {
        type: 'arp',
        operation: 'reply',
        senderMAC: port.getMAC(),
        senderIP: myIP,
        targetMAC: arp.senderMAC,
        targetIP: arp.senderIP,
      };

      this.sendFrame(portName, {
        srcMAC: port.getMAC(),
        dstMAC: arp.senderMAC,
        etherType: ETHERTYPE_ARP,
        payload: reply,
      });
    } else if (arp.operation === 'reply') {
      // ARP reply → resolve pending requests
      const key = arp.senderIP.toString();
      const pending = this.pendingARPs.get(key);
      if (pending) {
        for (const p of pending) {
          clearTimeout(p.timer);
          p.resolve(arp.senderMAC);
        }
        this.pendingARPs.delete(key);
      }
    }
  }

  // ─── IPv4 Handling (RFC 791) ──────────────────────────────────

  private handleIPv4(portName: string, ipPkt: IPv4Packet): void {
    if (!ipPkt || ipPkt.type !== 'ipv4') return;

    // Verify checksum
    if (!verifyIPv4Checksum(ipPkt)) {
      Logger.warn(this.id, 'ipv4:checksum-fail',
        `${this.name}: invalid IPv4 checksum, dropping packet`);
      return;
    }

    // Check if packet is for us
    const port = this.ports.get(portName);
    if (!port) return;
    const myIP = port.getIPAddress();

    const isForUs = myIP && ipPkt.destinationIP.equals(myIP);
    // Also accept if destination is the broadcast for our subnet
    const mask = port.getSubnetMask();
    const isBroadcast = myIP && mask && ipPkt.destinationIP.isBroadcastFor(mask);

    if (isForUs || isBroadcast) {
      // Deliver to upper layer
      if (ipPkt.protocol === IP_PROTO_ICMP) {
        this.handleICMP(portName, ipPkt);
      }
      // Future: TCP, UDP dispatch here
    }
    // End hosts don't forward — they drop packets not addressed to them
  }

  // ─── ICMP Handling (RFC 792) ──────────────────────────────────

  private handleICMP(portName: string, ipPkt: IPv4Packet): void {
    const icmp = ipPkt.payload as ICMPPacket;
    if (!icmp || icmp.type !== 'icmp') return;

    if (icmp.icmpType === 'echo-request') {
      this.sendEchoReply(portName, ipPkt, icmp);
    } else if (icmp.icmpType === 'echo-reply') {
      const key = `${ipPkt.sourceIP}-${icmp.id}-${icmp.sequence}`;
      const pending = this.pendingPings.get(key);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingPings.delete(key);
        const rtt = performance.now() - pending.sentAt;
        pending.resolve({
          success: true,
          rttMs: rtt,
          ttl: ipPkt.ttl,
          seq: icmp.sequence,
          bytes: icmp.dataSize + 8, // ICMP header (8) + data
          fromIP: ipPkt.sourceIP.toString(),
        });
      }
    } else if (icmp.icmpType === 'time-exceeded' || icmp.icmpType === 'destination-unreachable') {
      // ICMP errors come from intermediate routers, not the original target.
      // The error source IP (router) won't match the target IP in pending keys.
      // Since pings are sent sequentially (one outstanding at a time), reject all pending.
      const reason = icmp.icmpType === 'time-exceeded'
        ? `Time to live exceeded (from ${ipPkt.sourceIP})`
        : `Destination unreachable (from ${ipPkt.sourceIP})`;
      for (const [key, pending] of this.pendingPings) {
        clearTimeout(pending.timer);
        this.pendingPings.delete(key);
        pending.reject(reason);
      }
    }
  }

  private sendEchoReply(portName: string, requestIP: IPv4Packet, requestICMP: ICMPPacket): void {
    const port = this.ports.get(portName);
    if (!port) return;
    const myIP = port.getIPAddress();
    if (!myIP) return;

    // Build ICMP echo reply
    const replyICMP: ICMPPacket = {
      type: 'icmp',
      icmpType: 'echo-reply',
      code: 0,
      id: requestICMP.id,
      sequence: requestICMP.sequence,
      dataSize: requestICMP.dataSize,
    };

    const icmpSize = 8 + requestICMP.dataSize; // ICMP header + data
    const replyIP = createIPv4Packet(
      myIP,
      requestIP.sourceIP,
      IP_PROTO_ICMP,
      this.defaultTTL,
      replyICMP,
      icmpSize,
    );

    // Route the reply — source may be on a different subnet (via default gateway)
    const route = this.resolveRoute(requestIP.sourceIP);
    if (!route) return;

    const outPortName = route.port.getName();
    const nextHopMAC = this.arpTable.get(route.nextHopIP.toString());
    if (!nextHopMAC) return;

    this.sendFrame(outPortName, {
      srcMAC: route.port.getMAC(),
      dstMAC: nextHopMAC.mac,
      etherType: ETHERTYPE_IPV4,
      payload: replyIP,
    });
  }

  // ─── ARP Resolution ────────────────────────────────────────────

  /**
   * Resolve an IP address to a MAC address via ARP.
   * Returns cached result if available, otherwise sends ARP request and waits.
   */
  protected resolveARP(portName: string, targetIP: IPAddress, timeoutMs: number = 2000): Promise<MACAddress> {
    const cached = this.arpTable.get(targetIP.toString());
    if (cached) return Promise.resolve(cached.mac);

    const port = this.ports.get(portName);
    if (!port) return Promise.reject('Port not found');
    const myIP = port.getIPAddress();
    if (!myIP) return Promise.reject('No IP configured');

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pendingARPs.get(targetIP.toString());
        if (pending) {
          const idx = pending.findIndex(p => p.resolve === resolve);
          if (idx !== -1) pending.splice(idx, 1);
          if (pending.length === 0) this.pendingARPs.delete(targetIP.toString());
        }
        reject('ARP timeout');
      }, timeoutMs);

      const key = targetIP.toString();
      if (!this.pendingARPs.has(key)) this.pendingARPs.set(key, []);
      this.pendingARPs.get(key)!.push({ resolve, reject, timer });

      // Send ARP broadcast
      const arpReq: ARPPacket = {
        type: 'arp',
        operation: 'request',
        senderMAC: port.getMAC(),
        senderIP: myIP,
        targetMAC: MACAddress.broadcast(),
        targetIP,
      };

      this.sendFrame(portName, {
        srcMAC: port.getMAC(),
        dstMAC: MACAddress.broadcast(),
        etherType: ETHERTYPE_ARP,
        payload: arpReq,
      });
    });
  }

  // ─── Send Ping (ICMP Echo Request via IPv4) ───────────────────

  /**
   * Send a single ICMP echo request encapsulated in IPv4 and wait for reply.
   * Returns PingResult with real measured RTT.
   */
  protected sendPing(
    portName: string,
    targetIP: IPAddress,
    targetMAC: MACAddress,
    seq: number = 1,
    timeoutMs: number = 2000,
    ttl?: number,
  ): Promise<PingResult> {
    const port = this.ports.get(portName);
    if (!port) return Promise.reject('Port not found');
    const myIP = port.getIPAddress();
    if (!myIP) return Promise.reject('No IP configured');

    this.pingIdCounter++;
    const id = this.pingIdCounter;

    return new Promise((resolve, reject) => {
      const key = `${targetIP}-${id}-${seq}`;
      const sentAt = performance.now();

      const timer = setTimeout(() => {
        this.pendingPings.delete(key);
        reject('timeout');
      }, timeoutMs);

      this.pendingPings.set(key, { resolve, reject, timer, sentAt });

      // Build ICMP echo request
      const icmp: ICMPPacket = {
        type: 'icmp',
        icmpType: 'echo-request',
        code: 0,
        id,
        sequence: seq,
        dataSize: 56, // Standard 56 bytes of data
      };

      const icmpSize = 8 + 56; // ICMP header (8) + data (56) = 64
      const ipPkt = createIPv4Packet(
        myIP,
        targetIP,
        IP_PROTO_ICMP,
        ttl ?? this.defaultTTL,
        icmp,
        icmpSize,
      );

      this.sendFrame(portName, {
        srcMAC: port.getMAC(),
        dstMAC: targetMAC,
        etherType: ETHERTYPE_IPV4,
        payload: ipPkt,
      });
    });
  }

  // ─── Route Resolution (LPM — Longest Prefix Match) ──────────────

  /**
   * Build the full routing table including dynamic connected routes
   * from ports that were configured directly (backward compatibility).
   */
  private buildFullRoutingTable(): HostRouteEntry[] {
    const table = [...this.routingTable];

    // Auto-detect connected routes from ports not already in the table
    for (const [, port] of this.ports) {
      const ip = port.getIPAddress();
      const mask = port.getSubnetMask();
      if (!ip || !mask) continue;

      const portName = port.getName();
      const alreadyExists = table.some(
        r => r.type === 'connected' && r.iface === portName
      );
      if (!alreadyExists) {
        const networkOctets = ip.getOctets().map((o, i) => o & mask.getOctets()[i]);
        table.push({
          network: new IPAddress(networkOctets),
          mask,
          nextHop: null,
          iface: portName,
          type: 'connected',
          metric: 0,
        });
      }
    }

    // Auto-detect default gateway not already in the table
    if (this.defaultGateway && !table.some(r => r.type === 'default')) {
      let gwIface = '';
      for (const [, port] of this.ports) {
        const ip = port.getIPAddress();
        const pmask = port.getSubnetMask();
        if (ip && pmask && ip.isInSameSubnet(this.defaultGateway, pmask)) {
          gwIface = port.getName();
          break;
        }
      }
      table.push({
        network: new IPAddress('0.0.0.0'),
        mask: new SubnetMask('0.0.0.0'),
        nextHop: this.defaultGateway,
        iface: gwIface,
        type: 'default',
        metric: 0,
      });
    }

    return table;
  }

  /**
   * Find the outgoing interface and next-hop for a given destination IP
   * using Longest Prefix Match (LPM).
   *
   * Algorithm:
   *   1. Compare destination against every route entry using (dest & mask) == (network & mask)
   *   2. Select the route with the longest prefix (most specific mask)
   *   3. If prefix lengths are equal, select the one with the lowest metric
   *
   * Returns: { port, nextHopIP } or null if unreachable.
   */
  protected resolveRoute(targetIP: IPAddress): { port: Port; nextHopIP: IPAddress } | null {
    const table = this.buildFullRoutingTable();
    const destInt = targetIP.toUint32();

    let bestRoute: HostRouteEntry | null = null;
    let bestPrefix = -1;

    for (const route of table) {
      const netInt = route.network.toUint32();
      const maskInt = route.mask.toUint32();
      const prefix = route.mask.toCIDR();

      if ((destInt & maskInt) === (netInt & maskInt)) {
        if (prefix > bestPrefix ||
            (prefix === bestPrefix && bestRoute && route.metric < bestRoute.metric)) {
          bestPrefix = prefix;
          bestRoute = route;
        }
      }
    }

    if (!bestRoute) return null;

    const port = this.ports.get(bestRoute.iface);
    if (!port) return null;

    // For connected routes (nextHop is null), the next-hop is the destination itself
    const nextHopIP = bestRoute.nextHop || targetIP;

    return { port, nextHopIP };
  }

  // ─── High-level Ping (used by terminal commands) ──────────────

  /**
   * Execute a full ping sequence: route lookup → ARP → ICMP echo × count.
   * Returns an array of PingResult (one per ping attempt).
   */
  protected async executePingSequence(
    targetIP: IPAddress,
    count: number = 4,
    timeoutMs: number = 2000,
    ttl?: number,
  ): Promise<PingResult[]> {
    // Self-ping (loopback)
    for (const [, port] of this.ports) {
      const myIP = port.getIPAddress();
      if (myIP && myIP.equals(targetIP)) {
        const results: PingResult[] = [];
        for (let seq = 1; seq <= count; seq++) {
          results.push({
            success: true,
            rttMs: 0.01,
            ttl: this.defaultTTL,
            seq,
            bytes: 64,
            fromIP: targetIP.toString(),
          });
        }
        return results;
      }
    }

    // Route resolution
    const route = this.resolveRoute(targetIP);
    if (!route) {
      return []; // Empty = unreachable, caller formats the error
    }

    const portName = route.port.getName();

    // ARP resolution (for next-hop, not necessarily the final destination)
    let nextHopMAC: MACAddress;
    try {
      nextHopMAC = await this.resolveARP(portName, route.nextHopIP, timeoutMs);
    } catch {
      return []; // ARP failed = no replies
    }

    // Send pings
    const results: PingResult[] = [];
    for (let seq = 1; seq <= count; seq++) {
      try {
        const result = await this.sendPing(portName, targetIP, nextHopMAC, seq, timeoutMs, ttl);
        results.push(result);
      } catch (err: any) {
        const errorMsg = typeof err === 'string' ? err : '';
        results.push({
          success: false,
          rttMs: 0,
          ttl: 0,
          seq,
          bytes: 0,
          fromIP: '',
          error: errorMsg,
        });
      }
    }
    return results;
  }

  // ─── Traceroute (uses TTL-limited packets) ────────────────────

  /**
   * Execute a traceroute: send ICMP echo with incrementing TTL.
   * Each router along the path returns ICMP Time Exceeded.
   * Returns array of hops: { hopNum, ip, rttMs } or { hopNum, timeout: true }.
   */
  protected async executeTraceroute(
    targetIP: IPAddress,
    maxHops: number = 30,
    timeoutMs: number = 2000,
  ): Promise<Array<{ hop: number; ip?: string; rttMs?: number; timeout: boolean }>> {
    const route = this.resolveRoute(targetIP);
    if (!route) return [];

    const portName = route.port.getName();
    const myIP = route.port.getIPAddress()!;

    // ARP resolve next hop
    let nextHopMAC: MACAddress;
    try {
      nextHopMAC = await this.resolveARP(portName, route.nextHopIP, timeoutMs);
    } catch {
      return [{ hop: 1, timeout: true }];
    }

    const hops: Array<{ hop: number; ip?: string; rttMs?: number; timeout: boolean }> = [];

    for (let ttl = 1; ttl <= maxHops; ttl++) {
      this.pingIdCounter++;
      const id = this.pingIdCounter;
      const seq = 1;

      const result = await new Promise<{ ip?: string; rttMs?: number; timeout: boolean; reached: boolean }>((resolve) => {
        const key = `${targetIP}-${id}-${seq}`;
        const sentAt = performance.now();

        const timer = setTimeout(() => {
          this.pendingPings.delete(key);
          resolve({ timeout: true, reached: false });
        }, timeoutMs);

        this.pendingPings.set(key, {
          resolve: (pingResult) => {
            clearTimeout(timer);
            resolve({ ip: pingResult.fromIP, rttMs: pingResult.rttMs, timeout: false, reached: true });
          },
          reject: (reason) => {
            clearTimeout(timer);
            // Time exceeded or destination unreachable — extract IP from message
            const match = reason.match(/from ([\d.]+)/);
            const rtt = performance.now() - sentAt;
            resolve({ ip: match ? match[1] : undefined, rttMs: rtt, timeout: false, reached: false });
          },
          timer,
          sentAt,
        });

        // Build ICMP with limited TTL
        const icmp: ICMPPacket = {
          type: 'icmp', icmpType: 'echo-request', code: 0,
          id, sequence: seq, dataSize: 56,
        };
        const ipPkt = createIPv4Packet(myIP, targetIP, IP_PROTO_ICMP, ttl, icmp, 64);

        this.sendFrame(portName, {
          srcMAC: route.port.getMAC(),
          dstMAC: nextHopMAC,
          etherType: ETHERTYPE_IPV4,
          payload: ipPkt,
        });
      });

      hops.push({ hop: ttl, ip: result.ip, rttMs: result.rttMs, timeout: result.timeout });

      if (result.reached) break; // Reached destination
    }

    return hops;
  }

  // ═══════════════════════════════════════════════════════════════════
  // IPv6 Stack (RFC 8200, RFC 4861, RFC 4443)
  // ═══════════════════════════════════════════════════════════════════

  // ─── IPv6 Configuration ─────────────────────────────────────────

  /**
   * Enable IPv6 on an interface. Generates link-local address via EUI-64.
   */
  enableIPv6(ifName: string): boolean {
    const port = this.ports.get(ifName);
    if (!port) return false;
    port.enableIPv6();

    // Add connected route for link-local
    const linkLocal = port.getLinkLocalIPv6();
    if (linkLocal) {
      this.ipv6RoutingTable.push({
        prefix: new IPv6Address('fe80::'),
        prefixLength: 10,
        nextHop: null,
        iface: ifName,
        type: 'connected',
        metric: 0,
      });
    }

    return true;
  }

  /**
   * Configure a static IPv6 address on an interface.
   */
  configureIPv6Interface(ifName: string, address: IPv6Address, prefixLength: number): boolean {
    const port = this.ports.get(ifName);
    if (!port) return false;

    port.configureIPv6(address, prefixLength);

    // Add connected route for this prefix
    const networkPrefix = address.getNetworkPrefix(prefixLength);
    const existingRoute = this.ipv6RoutingTable.find(r =>
      r.type === 'connected' && r.iface === ifName && r.prefix.equals(networkPrefix)
    );

    if (!existingRoute) {
      this.ipv6RoutingTable.push({
        prefix: networkPrefix,
        prefixLength,
        nextHop: null,
        iface: ifName,
        type: 'connected',
        metric: 0,
      });
    }

    Logger.info(this.id, 'host:ipv6-config',
      `${this.name}: ${ifName} configured ${address}/${prefixLength}`);
    return true;
  }

  // ─── IPv6 Routing Table ─────────────────────────────────────────

  getIPv6RoutingTable(): HostIPv6RouteEntry[] {
    return [...this.ipv6RoutingTable];
  }

  getDefaultGateway6(): IPv6Address | null {
    return this.defaultGateway6;
  }

  setDefaultGateway6(gw: IPv6Address): void {
    this.defaultGateway6 = gw;

    // Remove old default and add new
    this.ipv6RoutingTable = this.ipv6RoutingTable.filter(r => r.type !== 'default');

    // Find the interface the gateway is reachable through
    let gwIface = '';
    for (const [, port] of this.ports) {
      if (!port.isIPv6Enabled()) continue;
      // Check if gateway is link-local (must be on same link) or matches a prefix
      if (gw.isLinkLocal()) {
        // Link-local gateway — assume same interface if we have IPv6 enabled
        gwIface = port.getName();
        break;
      }
      for (const entry of port.getIPv6Addresses()) {
        if (entry.address.isInSameSubnet(gw, entry.prefixLength)) {
          gwIface = port.getName();
          break;
        }
      }
      if (gwIface) break;
    }

    this.ipv6RoutingTable.push({
      prefix: new IPv6Address('::'),
      prefixLength: 0,
      nextHop: gw,
      iface: gwIface,
      type: 'default',
      metric: 0,
    });

    Logger.info(this.id, 'host:ipv6-gateway', `${this.name}: default IPv6 gateway set to ${gw}`);
  }

  // ─── Neighbor Cache (NDP) ──────────────────────────────────────

  getNeighborCache(): Map<string, NeighborCacheEntry> {
    return new Map(this.neighborCache);
  }

  // ─── IPv6 Packet Handling ──────────────────────────────────────

  private handleIPv6(portName: string, ipv6: IPv6Packet): void {
    if (!ipv6 || ipv6.type !== 'ipv6') return;

    const port = this.ports.get(portName);
    if (!port || !port.isIPv6Enabled()) return;

    // Check if packet is for us
    const isForUs = port.hasIPv6Address(ipv6.destinationIP);
    const isMulticast = ipv6.destinationIP.isMulticast();
    const isLoopback = ipv6.destinationIP.isLoopback();

    if (isForUs || isMulticast || isLoopback) {
      if (ipv6.nextHeader === IP_PROTO_ICMPV6) {
        this.handleICMPv6(portName, ipv6);
      }
      // Future: TCP, UDP dispatch here
    }
    // End hosts don't forward IPv6 packets
  }

  // ─── ICMPv6 Handling (RFC 4443, RFC 4861) ──────────────────────

  private handleICMPv6(portName: string, ipv6: IPv6Packet): void {
    const icmpv6 = ipv6.payload as ICMPv6Packet;
    if (!icmpv6 || icmpv6.type !== 'icmpv6') return;

    switch (icmpv6.icmpType) {
      case 'echo-request':
        this.handleICMPv6EchoRequest(portName, ipv6, icmpv6);
        break;
      case 'echo-reply':
        this.handleICMPv6EchoReply(ipv6, icmpv6);
        break;
      case 'neighbor-solicitation':
        this.handleNeighborSolicitation(portName, ipv6, icmpv6);
        break;
      case 'neighbor-advertisement':
        this.handleNeighborAdvertisement(portName, ipv6, icmpv6);
        break;
      case 'router-advertisement':
        this.handleRouterAdvertisement(portName, ipv6, icmpv6);
        break;
      case 'time-exceeded':
      case 'destination-unreachable':
        this.handleICMPv6Error(ipv6, icmpv6);
        break;
    }
  }

  private handleICMPv6EchoRequest(portName: string, ipv6: IPv6Packet, icmpv6: ICMPv6Packet): void {
    const port = this.ports.get(portName);
    if (!port) return;

    // Determine source address for reply
    let srcIP: IPv6Address | null = null;
    if (ipv6.destinationIP.isLinkLocal()) {
      srcIP = port.getLinkLocalIPv6();
    } else {
      srcIP = port.getGlobalIPv6() || port.getLinkLocalIPv6();
    }
    if (!srcIP) return;

    // Build echo reply
    const reply = createICMPv6EchoReply(icmpv6.id || 0, icmpv6.sequence || 0, icmpv6.dataSize || 56);
    const replyPkt = createIPv6Packet(
      srcIP,
      ipv6.sourceIP,
      IP_PROTO_ICMPV6,
      this.defaultHopLimit,
      reply,
      8 + (icmpv6.dataSize || 56), // ICMPv6 header + data
    );

    // Route the reply
    const route = this.resolveIPv6Route(ipv6.sourceIP);
    if (!route) return;

    const dstMAC = this.neighborCache.get(route.nextHopIP.toString());
    if (dstMAC) {
      this.sendFrame(route.port.getName(), {
        srcMAC: route.port.getMAC(),
        dstMAC: dstMAC.mac,
        etherType: ETHERTYPE_IPV6,
        payload: replyPkt,
      });
    }
  }

  private handleICMPv6EchoReply(ipv6: IPv6Packet, icmpv6: ICMPv6Packet): void {
    const key = `${ipv6.sourceIP}-${icmpv6.id}-${icmpv6.sequence}`;
    const pending = this.pendingPing6s.get(key);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingPing6s.delete(key);
      const rtt = performance.now() - pending.sentAt;
      pending.resolve({
        success: true,
        rttMs: rtt,
        ttl: ipv6.hopLimit,
        seq: icmpv6.sequence || 0,
        bytes: (icmpv6.dataSize || 56) + 8,
        fromIP: ipv6.sourceIP.toString(),
      });
    }
  }

  private handleICMPv6Error(ipv6: IPv6Packet, icmpv6: ICMPv6Packet): void {
    const reason = icmpv6.icmpType === 'time-exceeded'
      ? `Hop limit exceeded (from ${ipv6.sourceIP})`
      : `Destination unreachable (from ${ipv6.sourceIP})`;

    for (const [key, pending] of this.pendingPing6s) {
      clearTimeout(pending.timer);
      this.pendingPing6s.delete(key);
      pending.reject(reason);
    }
  }

  // ─── NDP: Neighbor Solicitation (RFC 4861 §7.2.3) ───────────────

  private handleNeighborSolicitation(portName: string, ipv6: IPv6Packet, icmpv6: ICMPv6Packet): void {
    const ns = icmpv6.ndp as NDPNeighborSolicitation;
    if (!ns || ns.ndpType !== 'neighbor-solicitation') return;

    const port = this.ports.get(portName);
    if (!port) return;

    // Check if the target address is ours
    if (!port.hasIPv6Address(ns.targetAddress)) return;

    // Learn the source's link-layer address if provided
    const srcLLOpt = ns.options.find(o => o.optionType === 'source-link-layer');
    if (srcLLOpt && srcLLOpt.optionType === 'source-link-layer' && !ipv6.sourceIP.isUnspecified()) {
      this.neighborCache.set(ipv6.sourceIP.toString(), {
        mac: srcLLOpt.address,
        iface: portName,
        state: 'stale',
        isRouter: false,
        timestamp: Date.now(),
      });
    }

    // Send Neighbor Advertisement
    const na = createNeighborAdvertisement(ns.targetAddress, port.getMAC(), {
      router: false, // EndHosts are not routers
      solicited: true,
      override: true,
    });

    // Determine response destination and source
    let dstIP: IPv6Address;
    let dstMAC: MACAddress;

    if (ipv6.sourceIP.isUnspecified()) {
      // DAD probe — respond to all-nodes multicast
      dstIP = IPV6_ALL_NODES_MULTICAST;
      dstMAC = dstIP.toMulticastMAC();
    } else {
      // Normal NS — respond to source
      dstIP = ipv6.sourceIP;
      const cached = this.neighborCache.get(ipv6.sourceIP.toString());
      dstMAC = cached?.mac || (srcLLOpt as { address: MACAddress })?.address;
      if (!dstMAC) return; // Can't respond without knowing MAC
    }

    const naPkt = createIPv6Packet(
      ns.targetAddress,
      dstIP,
      IP_PROTO_ICMPV6,
      255, // NDP hop limit must be 255
      na,
      24, // NA size: 8 ICMPv6 + 16 target + option
    );

    this.sendFrame(portName, {
      srcMAC: port.getMAC(),
      dstMAC,
      etherType: ETHERTYPE_IPV6,
      payload: naPkt,
    });

    Logger.debug(this.id, 'ndp:na-sent',
      `${this.name}: NA for ${ns.targetAddress} sent to ${dstIP}`);
  }

  // ─── NDP: Neighbor Advertisement (RFC 4861 §7.2.5) ──────────────

  private handleNeighborAdvertisement(portName: string, ipv6: IPv6Packet, icmpv6: ICMPv6Packet): void {
    const na = icmpv6.ndp as NDPNeighborAdvertisement;
    if (!na || na.ndpType !== 'neighbor-advertisement') return;

    // Extract target link-layer address from options
    const tgtLLOpt = na.options.find(o => o.optionType === 'target-link-layer');
    if (!tgtLLOpt || tgtLLOpt.optionType !== 'target-link-layer') return;

    const mac = tgtLLOpt.address;
    const key = na.targetAddress.toString();

    // Update neighbor cache
    this.neighborCache.set(key, {
      mac,
      iface: portName,
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

    Logger.debug(this.id, 'ndp:na-received',
      `${this.name}: learned ${na.targetAddress} -> ${mac}`);
  }

  // ─── NDP: Router Advertisement (RFC 4861 §6.3.4) ────────────────

  private handleRouterAdvertisement(portName: string, ipv6: IPv6Packet, icmpv6: ICMPv6Packet): void {
    const ra = icmpv6.ndp as NDPRouterAdvertisement;
    if (!ra || ra.ndpType !== 'router-advertisement') return;

    const port = this.ports.get(portName);
    if (!port) return;

    // Learn router's link-layer address
    const srcLLOpt = ra.options.find(o => o.optionType === 'source-link-layer');
    if (srcLLOpt && srcLLOpt.optionType === 'source-link-layer') {
      this.neighborCache.set(ipv6.sourceIP.toString(), {
        mac: srcLLOpt.address,
        iface: portName,
        state: 'reachable',
        isRouter: true,
        timestamp: Date.now(),
      });
    }

    // If router lifetime > 0, consider as default router
    if (ra.routerLifetime > 0 && !this.defaultGateway6) {
      this.setDefaultGateway6(ipv6.sourceIP);
    }

    // Process prefix information for SLAAC
    for (const opt of ra.options) {
      if (opt.optionType === 'prefix-info') {
        const prefixOpt = opt as NDPOptionPrefixInfo;

        // Only process if Autonomous flag is set
        if (prefixOpt.autonomous && prefixOpt.prefixLength === 64) {
          // Generate address via SLAAC
          const slackAddr = port.addSLAACAddress(prefixOpt.prefix, prefixOpt.prefixLength);

          // Add route for this prefix
          const existingRoute = this.ipv6RoutingTable.find(r =>
            r.prefix.equals(prefixOpt.prefix.getNetworkPrefix(prefixOpt.prefixLength)) &&
            r.prefixLength === prefixOpt.prefixLength
          );

          if (!existingRoute && prefixOpt.onLink) {
            this.ipv6RoutingTable.push({
              prefix: prefixOpt.prefix.getNetworkPrefix(prefixOpt.prefixLength),
              prefixLength: prefixOpt.prefixLength,
              nextHop: null,
              iface: portName,
              type: 'ra',
              metric: 0,
            });
          }

          Logger.info(this.id, 'slaac',
            `${this.name}: SLAAC configured ${slackAddr}/${prefixOpt.prefixLength}`);
        }
      }
    }
  }

  // ─── NDP Resolution (IPv6 equivalent of ARP) ────────────────────

  /**
   * Resolve an IPv6 address to a MAC address via NDP.
   * Returns cached result if available, otherwise sends NS and waits.
   */
  protected resolveNDP(portName: string, targetIP: IPv6Address, timeoutMs: number = 2000): Promise<MACAddress> {
    const cached = this.neighborCache.get(targetIP.toString());
    if (cached && cached.state === 'reachable') {
      return Promise.resolve(cached.mac);
    }

    const port = this.ports.get(portName);
    if (!port || !port.isIPv6Enabled()) return Promise.reject('IPv6 not enabled');

    const srcIP = port.getLinkLocalIPv6();
    if (!srcIP) return Promise.reject('No link-local address');

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pendingNDPs.get(targetIP.toString());
        if (pending) {
          const idx = pending.findIndex(p => p.resolve === resolve);
          if (idx !== -1) pending.splice(idx, 1);
          if (pending.length === 0) this.pendingNDPs.delete(targetIP.toString());
        }
        reject('NDP timeout');
      }, timeoutMs);

      const key = targetIP.toString();
      if (!this.pendingNDPs.has(key)) this.pendingNDPs.set(key, []);
      this.pendingNDPs.get(key)!.push({ resolve, reject, timer });

      // Build and send Neighbor Solicitation
      const ns = createNeighborSolicitation(targetIP, port.getMAC());
      const nsPkt = createIPv6Packet(
        srcIP,
        targetIP.toSolicitedNodeMulticast(), // Send to solicited-node multicast
        IP_PROTO_ICMPV6,
        255, // NDP hop limit must be 255
        ns,
        24, // NS size
      );

      // Destination MAC is multicast derived from target's solicited-node address
      const dstMAC = targetIP.toSolicitedNodeMulticast().toMulticastMAC();

      this.sendFrame(portName, {
        srcMAC: port.getMAC(),
        dstMAC,
        etherType: ETHERTYPE_IPV6,
        payload: nsPkt,
      });

      Logger.debug(this.id, 'ndp:ns-sent',
        `${this.name}: NS for ${targetIP} sent`);
    });
  }

  // ─── IPv6 Route Resolution (LPM) ────────────────────────────────

  protected resolveIPv6Route(targetIP: IPv6Address): { port: Port; nextHopIP: IPv6Address } | null {
    let bestRoute: HostIPv6RouteEntry | null = null;
    let bestPrefix = -1;

    for (const route of this.ipv6RoutingTable) {
      if (targetIP.isInSameSubnet(route.prefix, route.prefixLength)) {
        if (route.prefixLength > bestPrefix ||
            (route.prefixLength === bestPrefix && bestRoute && route.metric < bestRoute.metric)) {
          bestPrefix = route.prefixLength;
          bestRoute = route;
        }
      }
    }

    if (!bestRoute) return null;

    const port = this.ports.get(bestRoute.iface);
    if (!port) return null;

    // For connected routes (nextHop is null), use destination directly if on-link,
    // or use link-local address for NDP resolution
    const nextHopIP = bestRoute.nextHop || targetIP;

    return { port, nextHopIP };
  }

  // ─── Send IPv6 Ping ────────────────────────────────────────────

  protected sendPing6(
    portName: string,
    targetIP: IPv6Address,
    targetMAC: MACAddress,
    seq: number = 1,
    timeoutMs: number = 2000,
  ): Promise<PingResult> {
    const port = this.ports.get(portName);
    if (!port || !port.isIPv6Enabled()) return Promise.reject('IPv6 not enabled');

    // Determine source address
    const srcIP = targetIP.isLinkLocal()
      ? port.getLinkLocalIPv6()
      : (port.getGlobalIPv6() || port.getLinkLocalIPv6());

    if (!srcIP) return Promise.reject('No IPv6 address');

    this.ping6IdCounter++;
    const id = this.ping6IdCounter;

    return new Promise((resolve, reject) => {
      const key = `${targetIP}-${id}-${seq}`;
      const sentAt = performance.now();

      const timer = setTimeout(() => {
        this.pendingPing6s.delete(key);
        reject('timeout');
      }, timeoutMs);

      this.pendingPing6s.set(key, { resolve, reject, timer, sentAt });

      // Build ICMPv6 echo request
      const icmpv6 = createICMPv6EchoRequest(id, seq, 56);
      const ipPkt = createIPv6Packet(
        srcIP,
        targetIP,
        IP_PROTO_ICMPV6,
        this.defaultHopLimit,
        icmpv6,
        64, // 8 header + 56 data
      );

      this.sendFrame(portName, {
        srcMAC: port.getMAC(),
        dstMAC: targetMAC,
        etherType: ETHERTYPE_IPV6,
        payload: ipPkt,
      });
    });
  }

  // ─── High-level Ping6 (used by terminal commands) ───────────────

  protected async executePing6Sequence(
    targetIP: IPv6Address,
    count: number = 4,
    timeoutMs: number = 2000,
  ): Promise<PingResult[]> {
    // Self-ping (loopback)
    if (targetIP.isLoopback()) {
      const results: PingResult[] = [];
      for (let seq = 1; seq <= count; seq++) {
        results.push({
          success: true,
          rttMs: 0.01,
          ttl: this.defaultHopLimit,
          seq,
          bytes: 64,
          fromIP: '::1',
        });
      }
      return results;
    }

    // Check if target is one of our addresses
    for (const [, port] of this.ports) {
      for (const entry of port.getIPv6Addresses()) {
        if (entry.address.equals(targetIP)) {
          const results: PingResult[] = [];
          for (let seq = 1; seq <= count; seq++) {
            results.push({
              success: true,
              rttMs: 0.01,
              ttl: this.defaultHopLimit,
              seq,
              bytes: 64,
              fromIP: targetIP.toString(),
            });
          }
          return results;
        }
      }
    }

    // Route resolution
    const route = this.resolveIPv6Route(targetIP);
    if (!route) {
      return []; // Unreachable
    }

    const portName = route.port.getName();

    // NDP resolution (for next-hop)
    let nextHopMAC: MACAddress;
    try {
      nextHopMAC = await this.resolveNDP(portName, route.nextHopIP, timeoutMs);
    } catch {
      return []; // NDP failed
    }

    // Send pings
    const results: PingResult[] = [];
    for (let seq = 1; seq <= count; seq++) {
      try {
        const result = await this.sendPing6(portName, targetIP, nextHopMAC, seq, timeoutMs);
        results.push(result);
      } catch {
        results.push({
          success: false,
          rttMs: 0,
          ttl: 0,
          seq,
          bytes: 0,
          fromIP: '',
        });
      }
    }
    return results;
  }

  // ─── Router Solicitation ────────────────────────────────────────

  /**
   * Send Router Solicitation to discover routers and obtain prefix info.
   */
  protected sendRouterSolicitation(portName: string): void {
    const port = this.ports.get(portName);
    if (!port || !port.isIPv6Enabled()) return;

    const srcIP = port.getLinkLocalIPv6();
    if (!srcIP) return;

    const rs = createRouterSolicitation(port.getMAC());
    const rsPkt = createIPv6Packet(
      srcIP,
      IPV6_ALL_ROUTERS_MULTICAST,
      IP_PROTO_ICMPV6,
      255,
      rs,
      16,
    );

    this.sendFrame(portName, {
      srcMAC: port.getMAC(),
      dstMAC: IPV6_ALL_ROUTERS_MULTICAST.toMulticastMAC(),
      etherType: ETHERTYPE_IPV6,
      payload: rsPkt,
    });

    Logger.debug(this.id, 'ndp:rs-sent',
      `${this.name}: Router Solicitation sent on ${portName}`);
  }
}

/**
 * Router - Layer 3 Forwarding Engine (RFC 791, RFC 1812)
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
 *     - If for us → Control Plane (ICMP echo-reply)
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
 *   - RIB (Routing Information Base) with connected/static/default routes
 *   - ARP cache with interface tracking
 *   - ICMP error generation (Time Exceeded, Dest Unreachable, Frag Needed)
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
  ARPPacket, ICMPPacket,
  ETHERTYPE_ARP, ETHERTYPE_IPV4,
  IP_PROTO_ICMP,
  createIPv4Packet, verifyIPv4Checksum, computeIPv4Checksum,
  DeviceType,
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
  type: 'connected' | 'static' | 'default';
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

// ─── CLI Shell Interface (Management Plane abstraction) ──────────────

interface IRouterShell {
  execute(router: Router, command: string, args: string[]): string;
  getOSType(): string;
}

// ─── Router ────────────────────────────────────────────────────────

export class Router extends Equipment {
  // ── Control Plane ─────────────────────────────────────────────
  private routingTable: RouteEntry[] = [];
  private arpTable: Map<string, ARPEntry> = new Map();
  private pendingARPs: Map<string, PendingARP[]> = new Map();
  private packetQueue: QueuedPacket[] = [];
  private readonly defaultTTL = 255; // Cisco/Huawei default
  private readonly interfaceMTU = 1500; // Standard Ethernet MTU

  // ── Performance Counters ──────────────────────────────────────
  private counters: RouterCounters = {
    ifInOctets: 0, ifOutOctets: 0,
    ipInHdrErrors: 0, ipInAddrErrors: 0, ipForwDatagrams: 0,
    icmpOutMsgs: 0, icmpOutDestUnreachs: 0, icmpOutTimeExcds: 0,
    icmpOutEchoReps: 0,
  };

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

  // ─── Performance Counters ─────────────────────────────────────

  getCounters(): RouterCounters {
    return { ...this.counters };
  }

  resetCounters(): void {
    for (const key of Object.keys(this.counters) as (keyof RouterCounters)[]) {
      this.counters[key] = 0;
    }
  }

  // ─── Data Plane: Phase A — Frame Handling (L2 → dispatch) ─────

  protected handleFrame(portName: string, frame: EthernetFrame): void {
    const port = this.ports.get(portName);
    if (!port) return;

    // Phase A.1: L2 Filter
    if (!frame.dstMAC.isBroadcast() && !frame.dstMAC.equals(port.getMAC())) {
      return;
    }

    // Phase A.2: EtherType dispatch
    if (frame.etherType === ETHERTYPE_ARP) {
      this.handleARP(portName, frame.payload as ARPPacket);
    } else if (frame.etherType === ETHERTYPE_IPV4) {
      this.counters.ifInOctets += (frame.payload as IPv4Packet)?.totalLength || 0;
      this.processIPv4(portName, frame.payload as IPv4Packet);
    }
    // Non-IPv4/ARP frames silently dropped (no IPv6 support)
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

    // C.1: Is this packet for us? (any interface IP)
    for (const [, port] of this.ports) {
      const myIP = port.getIPAddress();
      if (myIP && ipPkt.destinationIP.equals(myIP)) {
        this.handleLocalDelivery(inPort, ipPkt);
        return;
      }
    }

    // C.2: Not for us → forward via FIB
    this.forwardPacket(inPort, ipPkt);
  }

  /**
   * Control Plane: Handle packets addressed to our interface IPs.
   * Supports: ICMP echo-request → echo-reply.
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
      // For now, just forward (fragmentation is rarely needed with standard MTU)
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

  // ─── OS Info ───────────────────────────────────────────────────

  getOSType(): string { return this.shell.getOSType(); }
}

// ═══════════════════════════════════════════════════════════════════
// Management Plane: Cisco IOS Shell
// ═══════════════════════════════════════════════════════════════════

class CiscoIOSShell implements IRouterShell {
  getOSType(): string { return 'cisco-ios'; }

  execute(router: Router, cmd: string, args: string[]): string {
    switch (cmd) {
      case 'show':    return this.cmdShow(router, args);
      case 'ip':      return this.cmdIp(router, args);
      case 'display': return this.cmdShow(router, args); // Alias for compatibility
      default:        return `% Unrecognized command "${cmd}"`;
    }
  }

  private cmdShow(router: Router, args: string[]): string {
    if (args.length === 0) return '% Incomplete command.';
    const sub = args.join(' ').toLowerCase();

    if (sub === 'ip route' || sub === 'ip route table') return this.showIpRoute(router);
    if (sub === 'ip interface brief' || sub === 'ip int brief') return this.showIpIntBrief(router);
    if (sub === 'arp') return this.showArp(router);
    if (sub === 'running-config' || sub === 'run') return this.showRunningConfig(router);
    if (sub === 'counters' || sub === 'ip traffic') return this.showCounters(router);

    return `% Unrecognized command "show ${args.join(' ')}"`;
  }

  private showIpRoute(router: Router): string {
    const table = router.getRoutingTable();
    const lines = ['Codes: C - connected, S - static, * - candidate default', ''];
    const sorted = [...table].sort((a, b) => {
      const order = { connected: 0, static: 1, default: 2 };
      return order[a.type] - order[b.type];
    });
    for (const r of sorted) {
      const code = r.type === 'connected' ? 'C' : r.type === 'default' ? 'S*' : 'S';
      const via = r.nextHop ? `via ${r.nextHop}` : 'is directly connected';
      lines.push(`${code}    ${r.network}/${r.mask.toCIDR()} ${via}, ${r.iface}`);
    }
    return lines.length > 2 ? lines.join('\n') : 'No routes configured.';
  }

  private showIpIntBrief(router: Router): string {
    const ports = router._getPortsInternal();
    const lines = ['Interface                  IP-Address      OK? Method Status                Protocol'];
    for (const [name, port] of ports) {
      const ip = port.getIPAddress()?.toString() || 'unassigned';
      const status = port.isConnected() ? 'up' : 'administratively down';
      const proto = port.isConnected() ? 'up' : 'down';
      lines.push(`${name.padEnd(27)}${ip.padEnd(16)}YES manual ${status.padEnd(22)}${proto}`);
    }
    return lines.join('\n');
  }

  private showArp(router: Router): string {
    const arpTable = router._getArpTableInternal();
    if (arpTable.size === 0) return 'No ARP entries.';
    const lines = ['Protocol  Address          Age (min)   Hardware Addr   Type   Interface'];
    for (const [ip, entry] of arpTable) {
      const age = Math.floor((Date.now() - entry.timestamp) / 60000);
      lines.push(`Internet  ${ip.padEnd(17)}${String(age).padEnd(12)}${entry.mac.toString().padEnd(16)}ARPA   ${entry.iface}`);
    }
    return lines.join('\n');
  }

  private showRunningConfig(router: Router): string {
    const ports = router._getPortsInternal();
    const table = router._getRoutingTableInternal();
    const lines = [`hostname ${router._getHostnameInternal()}`, '!'];
    for (const [name, port] of ports) {
      const ip = port.getIPAddress();
      const mask = port.getSubnetMask();
      lines.push(`interface ${name}`);
      if (ip && mask) {
        lines.push(` ip address ${ip} ${mask}`);
        lines.push(` no shutdown`);
      } else {
        lines.push(` shutdown`);
      }
      lines.push('!');
    }
    for (const r of table) {
      if (r.type === 'static' && r.nextHop) lines.push(`ip route ${r.network} ${r.mask} ${r.nextHop}`);
      if (r.type === 'default' && r.nextHop) lines.push(`ip route 0.0.0.0 0.0.0.0 ${r.nextHop}`);
    }
    return lines.join('\n');
  }

  private showCounters(router: Router): string {
    const c = router.getCounters();
    return [
      'IP statistics:',
      `  Rcvd:  ${c.ifInOctets} total octets`,
      `  Sent:  ${c.ifOutOctets} total octets`,
      `  Frags: ${c.ipForwDatagrams} forwarded`,
      `  Drop:  ${c.ipInHdrErrors} header errors, ${c.ipInAddrErrors} address errors`,
      '',
      'ICMP statistics:',
      `  Sent: ${c.icmpOutMsgs} total`,
      `    Destination unreachable: ${c.icmpOutDestUnreachs}`,
      `    Time exceeded: ${c.icmpOutTimeExcds}`,
      `    Echo replies: ${c.icmpOutEchoReps}`,
    ].join('\n');
  }

  private cmdIp(router: Router, args: string[]): string {
    // ip route <network> <mask> <next-hop>
    if (args.length >= 4 && args[0] === 'route') {
      try {
        const network = new IPAddress(args[1]);
        const mask = new SubnetMask(args[2]);
        const nextHop = new IPAddress(args[3]);

        if (args[1] === '0.0.0.0' && args[2] === '0.0.0.0') {
          return router.setDefaultRoute(nextHop) ? '' : '% Next-hop is not reachable';
        }
        return router.addStaticRoute(network, mask, nextHop) ? '' : '% Next-hop is not reachable';
      } catch (e: any) {
        return `% Invalid input: ${e.message}`;
      }
    }

    // ip address <ip> <mask>
    if (args.length >= 3 && args[0] === 'address') {
      const ports = router._getPortsInternal();
      for (const [name, port] of ports) {
        if (!port.getIPAddress()) {
          try {
            router.configureInterface(name, new IPAddress(args[1]), new SubnetMask(args[2]));
            return '';
          } catch (e: any) {
            return `% Invalid input: ${e.message}`;
          }
        }
      }
      return '% No unconfigured interface available';
    }

    return '% Incomplete command.';
  }
}

// ═══════════════════════════════════════════════════════════════════
// Management Plane: Huawei VRP Shell
// ═══════════════════════════════════════════════════════════════════

class HuaweiVRPShell implements IRouterShell {
  getOSType(): string { return 'huawei-vrp'; }

  execute(router: Router, cmd: string, args: string[]): string {
    switch (cmd) {
      case 'display': return this.cmdDisplay(router, args);
      case 'ip':      return this.cmdIp(router, args);
      case 'show':    return this.cmdDisplay(router, args); // Alias for compatibility
      default:        return `Error: Unrecognized command "${cmd}"`;
    }
  }

  private cmdDisplay(router: Router, args: string[]): string {
    if (args.length === 0) return 'Error: Incomplete command.';
    const sub = args.join(' ').toLowerCase();

    if (sub === 'ip routing-table') return this.displayIpRoutingTable(router);
    if (sub === 'ip interface brief') return this.displayIpIntBrief(router);
    if (sub === 'arp') return this.displayArp(router);
    if (sub === 'current-configuration' || sub === 'current') return this.displayCurrentConfig(router);
    if (sub === 'ip traffic' || sub === 'counters') return this.displayCounters(router);

    return `Error: Unrecognized command "display ${args.join(' ')}"`;
  }

  private displayIpRoutingTable(router: Router): string {
    const table = router.getRoutingTable();
    const lines = [
      'Route Flags: R - relay, D - download to fib',
      '------------------------------------------------------------------------------',
      'Routing Tables: Public',
      '         Destinations : ' + table.length + '        Routes : ' + table.length,
      '',
      'Destination/Mask    Proto   Pre  Cost  Flags NextHop         Interface',
    ];

    for (const r of table) {
      const dest = `${r.network}/${r.mask.toCIDR()}`.padEnd(20);
      const proto = (r.type === 'connected' ? 'Direct' : 'Static').padEnd(8);
      const pre = String(r.ad).padEnd(5);
      const cost = String(r.metric).padEnd(6);
      const flags = 'D'.padEnd(6);
      const nh = r.nextHop ? r.nextHop.toString().padEnd(16) : '0.0.0.0'.padEnd(16);
      lines.push(`${dest}${proto}${pre}${cost}${flags}${nh}${r.iface}`);
    }
    return lines.join('\n');
  }

  private displayIpIntBrief(router: Router): string {
    const ports = router._getPortsInternal();
    const lines = ['Interface                         IP Address/Mask      Physical   Protocol'];
    for (const [name, port] of ports) {
      const ip = port.getIPAddress();
      const mask = port.getSubnetMask();
      const ipStr = ip && mask ? `${ip}/${mask.toCIDR()}` : 'unassigned';
      const phys = port.isConnected() ? 'up' : 'down';
      const proto = port.isConnected() ? 'up' : 'down';
      lines.push(`${name.padEnd(34)}${ipStr.padEnd(21)}${phys.padEnd(11)}${proto}`);
    }
    return lines.join('\n');
  }

  private displayArp(router: Router): string {
    const arpTable = router._getArpTableInternal();
    if (arpTable.size === 0) return 'No ARP entries found.';
    const lines = ['IP ADDRESS      MAC ADDRESS     EXPIRE(M)  TYPE   INTERFACE'];
    for (const [ip, entry] of arpTable) {
      const age = Math.floor((Date.now() - entry.timestamp) / 60000);
      lines.push(`${ip.padEnd(16)}${entry.mac.toString().padEnd(16)}${String(age).padEnd(11)}D      ${entry.iface}`);
    }
    return lines.join('\n');
  }

  private displayCurrentConfig(router: Router): string {
    const ports = router._getPortsInternal();
    const table = router._getRoutingTableInternal();
    const lines = [
      '#',
      `sysname ${router._getHostnameInternal()}`,
      '#',
    ];
    for (const [name, port] of ports) {
      const ip = port.getIPAddress();
      const mask = port.getSubnetMask();
      lines.push(`interface ${name}`);
      if (ip && mask) {
        lines.push(` ip address ${ip} ${mask.toCIDR()}`);
      } else {
        lines.push(` shutdown`);
      }
      lines.push('#');
    }
    for (const r of table) {
      if (r.type === 'static' && r.nextHop) {
        lines.push(`ip route-static ${r.network} ${r.mask} ${r.nextHop}`);
      }
      if (r.type === 'default' && r.nextHop) {
        lines.push(`ip route-static 0.0.0.0 0.0.0.0 ${r.nextHop}`);
      }
    }
    lines.push('#');
    return lines.join('\n');
  }

  private displayCounters(router: Router): string {
    const c = router.getCounters();
    return [
      'IP statistics:',
      `  Input:  ${c.ifInOctets} bytes`,
      `  Output: ${c.ifOutOctets} bytes`,
      `  Forward: ${c.ipForwDatagrams} packets`,
      `  Discard: ${c.ipInHdrErrors} header errors, ${c.ipInAddrErrors} no-route`,
      '',
      'ICMP statistics:',
      `  Output: ${c.icmpOutMsgs} packets`,
      `    Destination unreachable: ${c.icmpOutDestUnreachs}`,
      `    Time exceeded: ${c.icmpOutTimeExcds}`,
      `    Echo reply: ${c.icmpOutEchoReps}`,
    ].join('\n');
  }

  private cmdIp(router: Router, args: string[]): string {
    // ip route-static <network> <mask> <next-hop>
    if (args.length >= 4 && args[0] === 'route-static') {
      try {
        const network = new IPAddress(args[1]);
        const mask = new SubnetMask(args[2]);
        const nextHop = new IPAddress(args[3]);

        if (args[1] === '0.0.0.0' && args[2] === '0.0.0.0') {
          return router.setDefaultRoute(nextHop) ? '' : 'Error: Next-hop is not reachable';
        }
        return router.addStaticRoute(network, mask, nextHop) ? '' : 'Error: Next-hop is not reachable';
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    }

    return 'Error: Incomplete command.';
  }
}

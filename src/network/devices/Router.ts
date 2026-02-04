/**
 * Router - Layer 3 forwarding device (RFC 791)
 *
 * Implements the IPv4 forwarding engine:
 *   1. Receive frame on interface
 *   2. If ARP → respond (for our interface IPs)
 *   3. If IPv4 → verify checksum → check destination
 *      a. If for us (interface IP) → deliver to upper layer (respond to ping)
 *      b. Else → route:
 *         - Decrement TTL → if 0, send ICMP Time Exceeded to source
 *         - LPM lookup in routing table
 *         - If no route → send ICMP Destination Unreachable
 *         - Recalculate checksum
 *         - ARP resolve next-hop → re-encapsulate in new Ethernet frame → send
 *
 * Routing table supports:
 *   - Connected routes (auto-generated from interface IPs)
 *   - Static routes (manually added)
 *   - Default route (gateway of last resort)
 *   - Longest Prefix Match (LPM) for forwarding decisions
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

// ─── Routing Table ─────────────────────────────────────────────────

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

// ─── Router ────────────────────────────────────────────────────────

export class Router extends Equipment {
  private routingTable: RouteEntry[] = [];
  private arpTable: Map<string, ARPEntry> = new Map();
  private pendingARPs: Map<string, PendingARP[]> = new Map();
  private packetQueue: QueuedPacket[] = [];
  private readonly defaultTTL = 255; // Cisco default

  constructor(type: DeviceType = 'router-cisco', name: string = 'Router', x: number = 0, y: number = 0) {
    super(type, name, x, y);
    this.createPorts();
  }

  private createPorts(): void {
    const isCisco = this.deviceType.includes('cisco');
    const portCount = 4;
    for (let i = 0; i < portCount; i++) {
      const portName = isCisco
        ? `GigabitEthernet0/${i}`
        : `eth${i}`;
      this.addPort(new Port(portName, 'ethernet'));
    }
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

  // ─── Routing Table Management ────────────────────────────────

  getRoutingTable(): RouteEntry[] {
    return [...this.routingTable];
  }

  addStaticRoute(network: IPAddress, mask: SubnetMask, nextHop: IPAddress, metric: number = 0): boolean {
    // Find the interface for the next-hop
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
    // Remove existing default
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

  /**
   * Longest Prefix Match (LPM) — find the best route for a destination IP.
   * Tiebreaking: longest prefix → lowest AD → lowest metric.
   */
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
          // Same prefix: prefer lower AD, then lower metric
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

  // ─── Frame Handling (L2 → dispatch) ───────────────────────────

  protected handleFrame(portName: string, frame: EthernetFrame): void {
    const port = this.ports.get(portName);
    if (!port) return;

    // Accept frames for our MAC or broadcast
    if (!frame.dstMAC.isBroadcast() && !frame.dstMAC.equals(port.getMAC())) {
      return;
    }

    if (frame.etherType === ETHERTYPE_ARP) {
      this.handleARP(portName, frame.payload as ARPPacket);
    } else if (frame.etherType === ETHERTYPE_IPV4) {
      this.processIPv4(portName, frame.payload as IPv4Packet);
    }
  }

  // ─── ARP Handling ────────────────────────────────────────────

  private handleARP(portName: string, arp: ARPPacket): void {
    if (!arp || arp.type !== 'arp') return;

    const port = this.ports.get(portName);
    if (!port) return;
    const myIP = port.getIPAddress();
    if (!myIP) return;

    // Learn sender
    this.arpTable.set(arp.senderIP.toString(), {
      mac: arp.senderMAC,
      iface: portName,
      timestamp: Date.now(),
    });

    if (arp.operation === 'request' && arp.targetIP.equals(myIP)) {
      // Reply to ARP for our interface IP
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

      // Forward any queued packets waiting for this ARP
      this.flushPacketQueue(arp.senderIP, arp.senderMAC);
    }
  }

  // ─── IPv4 Processing ─────────────────────────────────────────

  private processIPv4(inPort: string, ipPkt: IPv4Packet): void {
    if (!ipPkt || ipPkt.type !== 'ipv4') return;

    // 1. Verify checksum
    if (!verifyIPv4Checksum(ipPkt)) {
      Logger.warn(this.id, 'router:checksum-fail',
        `${this.name}: invalid IPv4 checksum, dropping`);
      return;
    }

    // 2. Is this packet for us? (any of our interface IPs)
    for (const [, port] of this.ports) {
      const myIP = port.getIPAddress();
      if (myIP && ipPkt.destinationIP.equals(myIP)) {
        this.handleLocalDelivery(inPort, ipPkt);
        return;
      }
    }

    // 3. Not for us → route (forward)
    this.forwardPacket(inPort, ipPkt);
  }

  /**
   * Handle packets addressed to one of our interface IPs.
   * Currently supports: ICMP echo-request → echo-reply.
   */
  private handleLocalDelivery(inPort: string, ipPkt: IPv4Packet): void {
    if (ipPkt.protocol === IP_PROTO_ICMP) {
      const icmp = ipPkt.payload as ICMPPacket;
      if (!icmp || icmp.type !== 'icmp') return;

      if (icmp.icmpType === 'echo-request') {
        // Reply to ping
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

        // Send back via same interface — ARP should already be learned
        const targetMAC = this.arpTable.get(ipPkt.sourceIP.toString());
        if (targetMAC) {
          this.sendFrame(inPort, {
            srcMAC: port.getMAC(), dstMAC: targetMAC.mac,
            etherType: ETHERTYPE_IPV4, payload: replyIP,
          });
        }
      }
    }
  }

  /**
   * Forward an IPv4 packet to the next hop.
   * Implements the full RFC 791 forwarding algorithm.
   */
  private forwardPacket(inPort: string, ipPkt: IPv4Packet): void {
    // 1. Decrement TTL
    const newTTL = ipPkt.ttl - 1;
    if (newTTL <= 0) {
      Logger.info(this.id, 'router:ttl-expired',
        `${this.name}: TTL expired for packet from ${ipPkt.sourceIP} to ${ipPkt.destinationIP}`);
      this.sendICMPError(inPort, ipPkt, 'time-exceeded', 0);
      return;
    }

    // 2. Route lookup (LPM)
    const route = this.lookupRoute(ipPkt.destinationIP);
    if (!route) {
      Logger.info(this.id, 'router:no-route',
        `${this.name}: no route for ${ipPkt.destinationIP}`);
      this.sendICMPError(inPort, ipPkt, 'destination-unreachable', 0);
      return;
    }

    // 3. Create forwarded packet with decremented TTL and new checksum
    const fwdPkt: IPv4Packet = {
      ...ipPkt,
      ttl: newTTL,
      headerChecksum: 0,
    };
    fwdPkt.headerChecksum = computeIPv4Checksum(fwdPkt);

    // 4. Determine next-hop IP
    const nextHopIP = route.nextHop || ipPkt.destinationIP;
    const outPort = this.ports.get(route.iface);
    if (!outPort) return;

    // 5. ARP resolve next-hop → send
    const cached = this.arpTable.get(nextHopIP.toString());
    if (cached) {
      this.sendFrame(route.iface, {
        srcMAC: outPort.getMAC(), dstMAC: cached.mac,
        etherType: ETHERTYPE_IPV4, payload: fwdPkt,
      });
    } else {
      // Queue packet and send ARP
      this.queueAndResolve(fwdPkt, route.iface, nextHopIP, outPort);
    }
  }

  /**
   * Send an ICMP error message (Time Exceeded or Destination Unreachable)
   * back to the source of the offending packet.
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
      type: 'icmp',
      icmpType: icmpType,
      code,
      id: 0,
      sequence: 0,
      dataSize: 0,
    };

    const errorIP = createIPv4Packet(
      myIP, offendingPkt.sourceIP, IP_PROTO_ICMP, this.defaultTTL,
      icmpError, 8,
    );

    // Send back via the interface the packet came in on
    const targetMAC = this.arpTable.get(offendingPkt.sourceIP.toString());
    if (targetMAC) {
      this.sendFrame(inPort, {
        srcMAC: port.getMAC(), dstMAC: targetMAC.mac,
        etherType: ETHERTYPE_IPV4, payload: errorIP,
      });
    } else {
      // Need ARP — queue the error packet
      this.queueAndResolve(errorIP, inPort, offendingPkt.sourceIP, port);
    }
  }

  // ─── ARP Resolution + Packet Queue ────────────────────────────

  private queueAndResolve(pkt: IPv4Packet, iface: string, nextHopIP: IPAddress, port: Port): void {
    const timer = setTimeout(() => {
      // Remove queued packets for this next-hop after timeout
      this.packetQueue = this.packetQueue.filter(
        q => !(q.nextHopIP.equals(nextHopIP) && q.outIface === iface)
      );
    }, 2000);

    this.packetQueue.push({ frame: pkt, outIface: iface, nextHopIP, timer });

    // Send ARP request if not already pending
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
        this.sendFrame(q.outIface, {
          srcMAC: outPort.getMAC(), dstMAC: resolvedMAC,
          etherType: ETHERTYPE_IPV4, payload: q.frame,
        });
      }
    }
  }

  // ─── Terminal (Cisco IOS stub) ────────────────────────────────

  async executeCommand(command: string): Promise<string> {
    if (!this.isPoweredOn) return '% Device is powered off';

    const parts = command.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();

    switch (cmd) {
      case 'show':
        return this.cmdShow(parts.slice(1));
      case 'ip':
        return this.cmdIpConfig(parts.slice(1));
      default:
        return `% Unrecognized command "${cmd}"`;
    }
  }

  private cmdShow(args: string[]): string {
    if (args.length === 0) return '% Incomplete command.';
    const sub = args.join(' ').toLowerCase();

    if (sub === 'ip route' || sub === 'ip route table') {
      return this.showIpRoute();
    }
    if (sub === 'ip interface brief' || sub === 'ip int brief') {
      return this.showIpIntBrief();
    }
    if (sub === 'arp') {
      return this.showArp();
    }
    if (sub === 'running-config' || sub === 'run') {
      return this.showRunningConfig();
    }

    return `% Unrecognized command "show ${args.join(' ')}"`;
  }

  private showIpRoute(): string {
    const lines = [`Codes: C - connected, S - static, * - candidate default`, ''];
    // Sort: connected first, then static, then default
    const sorted = [...this.routingTable].sort((a, b) => {
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

  private showIpIntBrief(): string {
    const lines = ['Interface                  IP-Address      OK? Method Status                Protocol'];
    for (const [name, port] of this.ports) {
      const ip = port.getIPAddress()?.toString() || 'unassigned';
      const status = port.isConnected() ? 'up' : 'administratively down';
      const proto = port.isConnected() ? 'up' : 'down';
      lines.push(`${name.padEnd(27)}${ip.padEnd(16)}YES manual ${status.padEnd(22)}${proto}`);
    }
    return lines.join('\n');
  }

  private showArp(): string {
    if (this.arpTable.size === 0) return 'No ARP entries.';
    const lines = ['Protocol  Address          Age (min)   Hardware Addr   Type   Interface'];
    for (const [ip, entry] of this.arpTable) {
      const age = Math.floor((Date.now() - entry.timestamp) / 60000);
      lines.push(`Internet  ${ip.padEnd(17)}${String(age).padEnd(12)}${entry.mac.toString().padEnd(16)}ARPA   ${entry.iface}`);
    }
    return lines.join('\n');
  }

  private showRunningConfig(): string {
    const lines = [
      `hostname ${this.hostname}`,
      '!',
    ];
    for (const [name, port] of this.ports) {
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
    for (const r of this.routingTable) {
      if (r.type === 'static' && r.nextHop) {
        lines.push(`ip route ${r.network} ${r.mask} ${r.nextHop}`);
      }
      if (r.type === 'default' && r.nextHop) {
        lines.push(`ip route 0.0.0.0 0.0.0.0 ${r.nextHop}`);
      }
    }
    return lines.join('\n');
  }

  // ─── Cisco IOS style config commands ──────────────────────────

  private cmdIpConfig(args: string[]): string {
    // ip route <network> <mask> <next-hop>
    if (args.length >= 4 && args[0] === 'route') {
      try {
        const network = new IPAddress(args[1]);
        const mask = new SubnetMask(args[2]);
        const nextHop = new IPAddress(args[3]);

        // Check for default route
        if (args[1] === '0.0.0.0' && args[2] === '0.0.0.0') {
          return this.setDefaultRoute(nextHop)
            ? '' : '% Next-hop is not reachable';
        }

        return this.addStaticRoute(network, mask, nextHop)
          ? '' : '% Next-hop is not reachable';
      } catch (e: any) {
        return `% Invalid input: ${e.message}`;
      }
    }

    // ip address <ip> <mask> (on current interface context — simplified)
    if (args.length >= 3 && args[0] === 'address') {
      // Use first unconfigured interface
      for (const [name, port] of this.ports) {
        if (!port.getIPAddress()) {
          try {
            this.configureInterface(name, new IPAddress(args[1]), new SubnetMask(args[2]));
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

  // ─── OS Info ───────────────────────────────────────────────────

  getOSType(): string { return 'cisco-ios'; }
}

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
  ETHERTYPE_ARP, ETHERTYPE_IPV4,
  IP_PROTO_ICMP,
  createIPv4Packet, verifyIPv4Checksum, computeIPv4Checksum,
} from '../core/types';
import { Logger } from '../core/Logger';

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

// ─── EndHost ───────────────────────────────────────────────────────

export abstract class EndHost extends Equipment {
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

  /** Default TTL for outgoing packets (Linux=64, Windows=128) */
  protected abstract readonly defaultTTL: number;

  // ─── Interface Configuration ───────────────────────────────────

  getInterface(name: string): Port | undefined { return this.getPort(name); }
  getInterfaces(): Port[] { return this.getPorts(); }

  // ─── Default Gateway ──────────────────────────────────────────

  getDefaultGateway(): IPAddress | null { return this.defaultGateway; }

  setDefaultGateway(gw: IPAddress): void {
    this.defaultGateway = gw;
    Logger.info(this.id, 'host:gateway', `${this.name}: default gateway set to ${gw}`);
  }

  clearDefaultGateway(): void {
    this.defaultGateway = null;
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

    // L2 filter: accept frames addressed to us or broadcast
    if (!frame.dstMAC.isBroadcast() && !frame.dstMAC.equals(port.getMAC())) {
      return;
    }

    if (frame.etherType === ETHERTYPE_ARP) {
      this.handleARP(portName, frame.payload as ARPPacket);
    } else if (frame.etherType === ETHERTYPE_IPV4) {
      this.handleIPv4(portName, frame.payload as IPv4Packet);
    }
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
        this.defaultTTL,
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

  // ─── Route Resolution ─────────────────────────────────────────

  /**
   * Find the outgoing interface and next-hop for a given destination IP.
   * 1. Check if destination is in a directly connected subnet → use that interface
   * 2. Otherwise, use the default gateway (which must be in a connected subnet)
   *
   * Returns: { port, nextHopIP } or null if unreachable.
   */
  protected resolveRoute(targetIP: IPAddress): { port: Port; nextHopIP: IPAddress } | null {
    // 1. Directly connected subnet?
    for (const [, port] of this.ports) {
      const ip = port.getIPAddress();
      const mask = port.getSubnetMask();
      if (ip && mask && ip.isInSameSubnet(targetIP, mask)) {
        return { port, nextHopIP: targetIP };
      }
    }

    // 2. Default gateway?
    if (this.defaultGateway) {
      for (const [, port] of this.ports) {
        const ip = port.getIPAddress();
        const mask = port.getSubnetMask();
        if (ip && mask && ip.isInSameSubnet(this.defaultGateway, mask)) {
          return { port, nextHopIP: this.defaultGateway };
        }
      }
    }

    return null; // Network is unreachable
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
        const result = await this.sendPing(portName, targetIP, nextHopMAC, seq, timeoutMs);
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
}

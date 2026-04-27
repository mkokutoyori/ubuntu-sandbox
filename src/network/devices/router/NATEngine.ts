/**
 * NATEngine — Network Address Translation for Cisco/Huawei routers
 *
 * Supports:
 *   • Static NAT        — one-to-one IP mapping (ip nat inside source static)
 *   • Static NAT server — port forwarding (ip nat inside source static tcp/udp)
 *   • Dynamic PAT       — many-to-one with port translation (ip nat inside source list … overload)
 *   • Dynamic pool NAT  — many-to-pool (ip nat inside source list … pool …)
 *
 * The engine is called from two points in Router.forwardPacket:
 *   1. translateInbound()  — PREROUTING: DNAT on packets arriving from outside
 *   2. translateOutbound() — POSTROUTING: SNAT/PAT on packets leaving to outside
 */

import { IPAddress, IPv4Packet, computeIPv4Checksum, IP_PROTO_ICMP, IP_PROTO_TCP, IP_PROTO_UDP } from '../../core/types';
import type { UDPPacket, ICMPPacket } from '../../core/types';

// ─── Public Types ────────────────────────────────────────────────────────────

export interface NatStaticEntry {
  localIP: string;
  globalIP: string;
  protocol?: 'tcp' | 'udp';
  localPort?: number;
  globalPort?: number;
}

export interface NatPool {
  name: string;
  startIP: string;
  endIP: string;
}

export type NatDynamicRuleType = 'overload' | 'pool';

export interface NatDynamicRule {
  aclId: string | number;
  type: NatDynamicRuleType;
  poolName?: string;
  // When type === 'overload', the global IP comes from the outside interface IP
}

/** A live NAT session entry (for reverse-path translation). */
export interface NatSession {
  protocol: number;       // IP_PROTO_*
  localIP: string;
  localPort: number;
  globalIP: string;
  globalPort: number;
  timestamp: number;
}

/** Result of a NAT translation lookup (for show ip nat translations) */
export interface NatTranslationEntry {
  proto: string;
  insideLocal: string;
  insideGlobal: string;
  outsideLocal: string;
  outsideGlobal: string;
}

// ─── NATEngine ───────────────────────────────────────────────────────────────

export class NATEngine {
  private insideIfaces = new Set<string>();
  private outsideIfaces = new Set<string>();
  private staticEntries: NatStaticEntry[] = [];
  private pools = new Map<string, NatPool>();
  private dynamicRules: NatDynamicRule[] = [];

  // Forward session: "proto:localIP:localPort" → session
  private sessions = new Map<string, NatSession>();
  // Reverse session: "proto:globalIP:globalPort" → session (mirrored for fast lookup)
  private reverseSessions = new Map<string, NatSession>();

  // Callbacks injected by Router
  private matchACLFn?: (aclId: string | number, srcIP: string) => boolean;
  private getIfaceIPFn?: (iface: string) => string | null;

  // PAT port counter
  private nextPort = 10240;
  private readonly maxPort = 65535;

  // ─── Configuration API ────────────────────────────────────────────

  setInsideInterface(iface: string): void   { this.insideIfaces.add(iface); }
  setOutsideInterface(iface: string): void  { this.outsideIfaces.add(iface); }
  removeInsideInterface(iface: string): void  { this.insideIfaces.delete(iface); }
  removeOutsideInterface(iface: string): void { this.outsideIfaces.delete(iface); }

  isInsideInterface(iface: string): boolean  { return this.insideIfaces.has(iface); }
  isOutsideInterface(iface: string): boolean { return this.outsideIfaces.has(iface); }

  addStaticEntry(entry: NatStaticEntry): void {
    // Prevent duplicates
    const key = `${entry.localIP}:${entry.localPort}:${entry.globalIP}:${entry.globalPort}`;
    const exists = this.staticEntries.some(e =>
      e.localIP === entry.localIP && e.globalIP === entry.globalIP &&
      e.localPort === entry.localPort && e.globalPort === entry.globalPort
    );
    if (!exists) this.staticEntries.push(entry);
  }

  removeStaticEntry(localIP: string, globalIP: string): void {
    this.staticEntries = this.staticEntries.filter(
      e => !(e.localIP === localIP && e.globalIP === globalIP)
    );
  }

  addPool(pool: NatPool): void { this.pools.set(pool.name, pool); }
  removePool(name: string): void { this.pools.delete(name); }
  getPool(name: string): NatPool | undefined { return this.pools.get(name); }

  addDynamicRule(rule: NatDynamicRule): void { this.dynamicRules.push(rule); }

  removeDynamicRule(aclId: string | number): void {
    this.dynamicRules = this.dynamicRules.filter(r => String(r.aclId) !== String(aclId));
  }

  /** Provide ACL matching function (injected by Router) */
  setACLMatchFn(fn: (aclId: string | number, srcIP: string) => boolean): void {
    this.matchACLFn = fn;
  }

  /** Provide interface-IP lookup function (injected by Router) */
  setInterfaceIPFn(fn: (iface: string) => string | null): void {
    this.getIfaceIPFn = fn;
  }

  // ─── Translation API (called from Router.forwardPacket) ───────────

  /**
   * PREROUTING / DNAT:
   * Called when a packet arrives on an outside interface.
   * Returns a modified packet (with translated dst) or null if no translation.
   */
  translateInbound(pkt: IPv4Packet, inIface: string): IPv4Packet | null {
    if (!this.outsideIfaces.has(inIface)) return null;

    const dstIP = pkt.destinationIP.toString();
    const dstPort = getPacketDstPort(pkt);
    const proto = pkt.protocol;

    // 1. Reverse PAT session lookup (reply to an inside-to-outside packet)
    const reverseKey = makeKey(proto, dstIP, dstPort);
    const revSession = this.reverseSessions.get(reverseKey);
    if (revSession) {
      revSession.timestamp = Date.now();
      return rewriteDestIP(pkt, revSession.localIP, revSession.localPort);
    }

    // 2. Static NAT / server (DNAT for inbound connections)
    for (const entry of this.staticEntries) {
      if (entry.globalIP !== dstIP) continue;

      if (!entry.protocol) {
        // Pure IP static NAT
        return rewriteDestIP(pkt, entry.localIP);
      }

      // Port-specific static NAT server
      const entryProto = entry.protocol === 'tcp' ? IP_PROTO_TCP : IP_PROTO_UDP;
      if (proto === entryProto && dstPort === entry.globalPort) {
        return rewriteDestIP(pkt, entry.localIP, entry.localPort);
      }
    }

    return null;
  }

  /**
   * POSTROUTING / SNAT:
   * Called when a packet is about to leave on an outside interface.
   * Returns a modified packet (with translated src) or null if no translation.
   */
  translateOutbound(pkt: IPv4Packet, outIface: string, inIface: string): IPv4Packet | null {
    if (!this.outsideIfaces.has(outIface)) return null;
    // Only translate traffic originating from inside
    if (!this.insideIfaces.has(inIface)) return null;

    const srcIP = pkt.sourceIP.toString();
    const srcPort = getPacketSrcPort(pkt);
    const proto = pkt.protocol;

    // 1. Static NAT: inside local → inside global (IP only)
    for (const entry of this.staticEntries) {
      if (entry.localIP === srcIP && !entry.protocol) {
        return rewriteSrcIP(pkt, entry.globalIP);
      }
    }

    // 2. Dynamic rules
    for (const rule of this.dynamicRules) {
      if (!this.matchACL(rule.aclId, srcIP)) continue;

      if (rule.type === 'overload') {
        // PAT: use outside interface IP + allocated port
        const globalIP = this.getIfaceIPFn?.(outIface) ?? null;
        if (!globalIP) continue;

        const sessionKey = makeKey(proto, srcIP, srcPort);
        let session = this.sessions.get(sessionKey);

        if (!session) {
          const globalPort = this.allocatePort();
          session = { protocol: proto, localIP: srcIP, localPort: srcPort, globalIP, globalPort, timestamp: Date.now() };
          this.sessions.set(sessionKey, session);
          const revKey = makeKey(proto, globalIP, globalPort);
          this.reverseSessions.set(revKey, session);
        } else {
          session.timestamp = Date.now();
        }

        return rewriteSrcIP(pkt, session.globalIP, session.globalPort);
      }

      if (rule.type === 'pool' && rule.poolName) {
        const pool = this.pools.get(rule.poolName);
        if (!pool) continue;
        // Simple: use pool start IP as global IP (in a real implementation, iterate through pool)
        const sessionKey = makeKey(proto, srcIP, srcPort);
        let session = this.sessions.get(sessionKey);
        if (!session) {
          session = { protocol: proto, localIP: srcIP, localPort: srcPort, globalIP: pool.startIP, globalPort: srcPort, timestamp: Date.now() };
          this.sessions.set(sessionKey, session);
          const revKey = makeKey(proto, pool.startIP, srcPort);
          this.reverseSessions.set(revKey, session);
        }
        return rewriteSrcIP(pkt, session.globalIP, session.globalPort);
      }
    }

    return null;
  }

  // ─── Show Commands ────────────────────────────────────────────────

  /** All active translations (for show ip nat translations) */
  getTranslations(): NatTranslationEntry[] {
    const entries: NatTranslationEntry[] = [];

    // Static entries (always shown)
    for (const e of this.staticEntries) {
      if (!e.protocol) {
        entries.push({
          proto: '---',
          insideLocal: e.localIP,
          insideGlobal: e.globalIP,
          outsideLocal: '---',
          outsideGlobal: '---',
        });
      } else {
        const lp = e.localPort ?? 0;
        const gp = e.globalPort ?? 0;
        entries.push({
          proto: e.protocol,
          insideLocal: `${e.localIP}:${lp}`,
          insideGlobal: `${e.globalIP}:${gp}`,
          outsideLocal: '---',
          outsideGlobal: '---',
        });
      }
    }

    // Dynamic/PAT sessions
    for (const session of this.sessions.values()) {
      const protoName = protoToName(session.protocol);
      entries.push({
        proto: protoName,
        insideLocal:  `${session.localIP}:${session.localPort}`,
        insideGlobal: `${session.globalIP}:${session.globalPort}`,
        outsideLocal: '---',
        outsideGlobal: '---',
      });
    }

    return entries;
  }

  getStaticEntries(): NatStaticEntry[] { return [...this.staticEntries]; }
  getDynamicRules(): NatDynamicRule[] { return [...this.dynamicRules]; }
  getPools(): Map<string, NatPool> { return new Map(this.pools); }
  getInsideInterfaces(): Set<string> { return new Set(this.insideIfaces); }
  getOutsideInterfaces(): Set<string> { return new Set(this.outsideIfaces); }

  getTranslationCount(): number {
    return this.sessions.size + this.staticEntries.length;
  }

  clearTranslations(): void {
    this.sessions.clear();
    this.reverseSessions.clear();
  }

  clearDynamicTranslations(): void {
    this.sessions.clear();
    this.reverseSessions.clear();
  }

  /** Periodically called to age out stale sessions */
  purgeStale(timeoutMs: number = 300_000): void {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (now - session.timestamp > timeoutMs) {
        const revKey = makeKey(session.protocol, session.globalIP, session.globalPort);
        this.sessions.delete(key);
        this.reverseSessions.delete(revKey);
      }
    }
  }

  // ─── Private Helpers ─────────────────────────────────────────────

  private matchACL(aclId: string | number, srcIP: string): boolean {
    if (this.matchACLFn) return this.matchACLFn(aclId, srcIP);
    // Fallback: no ACL engine → permit all
    return true;
  }

  private allocatePort(): number {
    const p = this.nextPort;
    this.nextPort = (this.nextPort >= this.maxPort) ? 10240 : this.nextPort + 1;
    return p;
  }
}

// ─── Packet Rewrite Helpers ──────────────────────────────────────────────────

function rewriteSrcIP(pkt: IPv4Packet, newSrc: string, newSrcPort?: number): IPv4Packet {
  const result: IPv4Packet = { ...pkt, sourceIP: new IPAddress(newSrc), headerChecksum: 0 };

  if (newSrcPort !== undefined) {
    const payload = pkt.payload as UDPPacket;
    if (payload && (payload.type === 'udp')) {
      result.payload = { ...payload, sourcePort: newSrcPort };
    } else if (pkt.protocol === IP_PROTO_ICMP) {
      // For ICMP, use the identifier field as the "port"
      const icmp = pkt.payload as ICMPPacket;
      if (icmp && icmp.type === 'icmp') {
        result.payload = { ...icmp, identifier: newSrcPort };
      }
    }
  }

  result.headerChecksum = computeIPv4Checksum(result);
  return result;
}

function rewriteDestIP(pkt: IPv4Packet, newDst: string, newDstPort?: number): IPv4Packet {
  const result: IPv4Packet = { ...pkt, destinationIP: new IPAddress(newDst), headerChecksum: 0 };

  if (newDstPort !== undefined) {
    const payload = pkt.payload as UDPPacket;
    if (payload && payload.type === 'udp') {
      result.payload = { ...payload, destinationPort: newDstPort };
    } else if (pkt.protocol === IP_PROTO_ICMP) {
      const icmp = pkt.payload as ICMPPacket;
      if (icmp && icmp.type === 'icmp') {
        result.payload = { ...icmp, identifier: newDstPort };
      }
    }
  }

  result.headerChecksum = computeIPv4Checksum(result);
  return result;
}

function getPacketSrcPort(pkt: IPv4Packet): number {
  const payload = pkt.payload as UDPPacket;
  if (payload && payload.type === 'udp') return payload.sourcePort;
  if (pkt.protocol === IP_PROTO_ICMP) {
    const icmp = pkt.payload as ICMPPacket;
    if (icmp && icmp.type === 'icmp') return icmp.identifier ?? 0;
  }
  return 0;
}

function getPacketDstPort(pkt: IPv4Packet): number {
  const payload = pkt.payload as UDPPacket;
  if (payload && payload.type === 'udp') return payload.destinationPort;
  if (pkt.protocol === IP_PROTO_ICMP) {
    const icmp = pkt.payload as ICMPPacket;
    if (icmp && icmp.type === 'icmp') return icmp.identifier ?? 0;
  }
  return 0;
}

function makeKey(proto: number, ip: string, port: number): string {
  return `${proto}:${ip}:${port}`;
}

function protoToName(proto: number): string {
  if (proto === IP_PROTO_TCP) return 'tcp';
  if (proto === IP_PROTO_UDP) return 'udp';
  if (proto === IP_PROTO_ICMP) return 'icmp';
  return String(proto);
}

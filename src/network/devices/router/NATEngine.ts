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
import type { UDPPacket, TCPPacket, ICMPPacket } from '../../core/types';
import { getDefaultEventBus, type IEventBus } from '@/events/EventBus';
import {
  NATSignalStore,
  makeReadonlyNATObservables,
  projectNatSessions,
  projectNatStats,
  type NATObservables,
} from './nat/observables';
import { NATSignalRefreshActor } from './nat/actors';

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

/** TCP session state (RFC 6146 §2.1). */
export type NatTcpState =
  | 'closed'        // no session
  | 'syn-seen'      // SYN observed (half-open)
  | 'established'   // SYN+ACK seen
  | 'fin-wait'      // FIN observed (closing)
  | 'time-wait';    // both FINs — awaiting expiry

/** A live NAT session entry (for reverse-path translation). */
export interface NatSession {
  protocol: number;       // IP_PROTO_*
  // Inside local (private) address
  localIP: string;
  localPort: number;
  // Inside global (public) address
  globalIP: string;
  globalPort: number;
  // Outside global (destination) address — completes the 4-tuple (RFC 2663 §3.6)
  outsideIP: string;
  outsidePort: number;
  timestamp: number;
  // TCP state machine (undefined for UDP/ICMP)
  tcpState?: NatTcpState;
}

/** Per-protocol session timeout config (milliseconds). */
export interface NatTimeouts {
  /** TCP established session. Default 86400 s (RFC 2663 §2.3.1). */
  tcp: number;
  /** TCP half-open (SYN seen, no response). Default 30 s. */
  tcpHalfOpen: number;
  /** UDP session. Default 300 s. */
  udp: number;
  /** ICMP session. Default 60 s. */
  icmp: number;
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
  // Lookup callback: given an inside IP, return the outside interface it came from
  private getInsideIfaceForIPFn?: (ip: string) => string | null;

  // PAT port counter (RFC 3022: ephemeral range 1024-65535)
  private nextPort = 10240;
  private readonly maxPort = 65535;

  // Per-protocol session timeouts (ms)
  private timeouts: NatTimeouts = {
    tcp:         86_400_000,   // 24 h  — RFC 2663 §2.3.1
    tcpHalfOpen:     30_000,   // 30 s  — RFC 6146 §4
    udp:            300_000,   // 5 min — RFC 4787 REQ-5
    icmp:            60_000,   // 60 s  — common practice
  };

  // Hit/miss counters (RFC 2663 §4)
  private hitCount = 0;
  private missCount = 0;
  private expiredCount = 0;
  // Direction counters (Phase 4b2-NAT)
  private inboundTranslations = 0;
  private outboundTranslations = 0;

  // ─── Reactive plumbing (Phase 4b2-NAT) ────────────────────────────
  private busOverride: IEventBus | null = null;
  private deviceId: string = '';
  private routerName: string = '';
  private readonly signalStore = new NATSignalStore();
  /** Read-only observables (sessions, stats). */
  readonly observables: NATObservables = makeReadonlyNATObservables(this.signalStore);
  private signalRefreshActor: NATSignalRefreshActor | null = null;

  setEventBus(bus: IEventBus | null): void {
    this.busOverride = bus;
    this.attachActors();
  }
  setDeviceId(id: string, routerName?: string): void {
    this.deviceId = id;
    if (routerName !== undefined) this.routerName = routerName;
  }
  getDeviceId(): string { return this.deviceId; }
  private getBus(): IEventBus { return this.busOverride ?? getDefaultEventBus(); }
  private deviceRef() { return { deviceId: this.deviceId, routerName: this.routerName }; }

  private attachActors(): void {
    this.signalRefreshActor?.stop();
    this.signalRefreshActor = new NATSignalRefreshActor(this.getBus(), this);
    this.signalRefreshActor.start();
  }

  /** [actor-API] Refresh sessions + stats. */
  _refreshAll(): void {
    this.signalStore.sessions.set(projectNatSessions(this.sessions));
    this._refreshStats();
  }

  /** [actor-API] Refresh stats only. */
  _refreshStats(): void {
    this.signalStore.stats.set(projectNatStats({
      sessions: this.sessions,
      hits: this.hitCount,
      misses: this.missCount,
      expired: this.expiredCount,
      inboundTranslations: this.inboundTranslations,
      outboundTranslations: this.outboundTranslations,
    }));
  }

  constructor() {
    this.attachActors();
  }

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

  /** Provide inside-interface lookup function (injected by Router) — used for hairpinning */
  setInsideIfaceForIPFn(fn: (ip: string) => string | null): void {
    this.getInsideIfaceForIPFn = fn;
  }

  /** Configure per-protocol session timeouts (milliseconds). */
  setTimeouts(t: Partial<NatTimeouts>): void {
    this.timeouts = { ...this.timeouts, ...t };
  }

  getTimeouts(): NatTimeouts { return { ...this.timeouts }; }

  /** Hit/miss/expired counters for show statistics. */
  getCounters() {
    return { hits: this.hitCount, misses: this.missCount, expired: this.expiredCount };
  }

  resetCounters(): void {
    this.hitCount = 0; this.missCount = 0; this.expiredCount = 0;
  }

  // ─── Translation API (called from Router.forwardPacket) ───────────

  /**
   * PREROUTING / DNAT:
   * Called when a packet arrives on an outside interface.
   * Returns a modified packet (with translated dst) or null if no translation.
   */
  translateInbound(pkt: IPv4Packet, inIface: string): IPv4Packet | null {
    // Standard path: packet arrives on outside interface
    // Hairpin path (RFC 5382 §5): packet arrives on inside interface but targets
    // one of our global/public IPs — DNAT it back to the inside server.
    const isOutside = this.outsideIfaces.has(inIface);
    const isInside  = this.insideIfaces.has(inIface);
    if (!isOutside && !isInside) return null;

    const dstIP = pkt.destinationIP.toString();
    const dstPort = getPacketDstPort(pkt);
    const proto = pkt.protocol;

    // ICMP error messages carry the offending packet as payload (RFC 5508 §3).
    // Translate the embedded original packet so the inside host can correlate it.
    if (proto === IP_PROTO_ICMP) {
      const icmp = pkt.payload as ICMPPacket;
      if (icmp && icmp.type === 'icmp' && icmp.originalPacket) {
        const translated = this.translateIcmpEmbedded(icmp.originalPacket, 'inbound');
        if (translated) {
          const newPkt: IPv4Packet = {
            ...pkt,
            payload: { ...icmp, originalPacket: translated },
            headerChecksum: 0,
          };
          newPkt.headerChecksum = computeIPv4Checksum(newPkt);
          return newPkt;
        }
      }
    }

    // 1. Reverse PAT session lookup (reply to an inside-to-outside packet).
    //    Only for packets arriving from outside (not hairpin).
    if (isOutside) {
      const reverseKey = makeKey(proto, dstIP, dstPort);
      const revSession = this.reverseSessions.get(reverseKey);
      if (revSession) {
        revSession.timestamp = Date.now();
        if (proto === IP_PROTO_TCP) updateTcpState(revSession, pkt, 'in');
        this.hitCount++;
        return rewriteDestIP(pkt, revSession.localIP, revSession.localPort);
      }
    }

    // 2. Static NAT / server (DNAT for inbound connections AND hairpin).
    //    Hairpin: inside host targets the public IP → redirect to inside server.
    for (const entry of this.staticEntries) {
      if (entry.globalIP !== dstIP) continue;

      if (!entry.protocol) {
        this.hitCount++;
        return rewriteDestIP(pkt, entry.localIP);
      }

      const entryProto = entry.protocol === 'tcp' ? IP_PROTO_TCP : IP_PROTO_UDP;
      if (proto === entryProto && dstPort === entry.globalPort) {
        this.hitCount++;
        return rewriteDestIP(pkt, entry.localIP, entry.localPort);
      }
    }

    this.missCount++;
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

    const srcIP   = pkt.sourceIP.toString();
    const srcPort = getPacketSrcPort(pkt);
    const dstIP   = pkt.destinationIP.toString();
    const dstPort = getPacketDstPort(pkt);
    const proto   = pkt.protocol;

    // ICMP error messages: translate the embedded offending packet (RFC 5508 §3).
    if (proto === IP_PROTO_ICMP) {
      const icmp = pkt.payload as ICMPPacket;
      if (icmp && icmp.type === 'icmp' && icmp.originalPacket) {
        const translated = this.translateIcmpEmbedded(icmp.originalPacket, 'outbound');
        if (translated) {
          const newPkt: IPv4Packet = {
            ...pkt,
            payload: { ...icmp, originalPacket: translated },
            headerChecksum: 0,
          };
          newPkt.headerChecksum = computeIPv4Checksum(newPkt);
          return newPkt;
        }
      }
    }

    // 1. Static NAT: inside local → inside global (IP only)
    for (const entry of this.staticEntries) {
      if (entry.localIP === srcIP && !entry.protocol) {
        this.hitCount++;
        return rewriteSrcIP(pkt, entry.globalIP);
      }
    }

    // 2. Dynamic rules
    for (const rule of this.dynamicRules) {
      if (!this.matchACL(rule.aclId, srcIP)) continue;

      if (rule.type === 'overload') {
        const globalIP = this.getIfaceIPFn?.(outIface) ?? null;
        if (!globalIP) continue;

        // Session key includes dst for 4-tuple uniqueness (RFC 5382)
        const sessionKey = makeKey4(proto, srcIP, srcPort, dstIP, dstPort);
        let session = this.sessions.get(sessionKey);

        if (!session) {
          const globalPort = this.allocatePort();
          session = {
            protocol: proto,
            localIP: srcIP, localPort: srcPort,
            globalIP, globalPort,
            outsideIP: dstIP, outsidePort: dstPort,
            timestamp: Date.now(),
            tcpState: proto === IP_PROTO_TCP ? 'syn-seen' : undefined,
          };
          this.sessions.set(sessionKey, session);
          const revKey = makeKey(proto, globalIP, globalPort);
          this.reverseSessions.set(revKey, session);
          this.missCount++;
          this.getBus().publish({
            topic: 'nat.session.created',
            payload: {
              ...this.deviceRef(),
              protocol: proto,
              localIp: srcIP, localPort: srcPort,
              globalIp: globalIP, globalPort,
              outsideIp: dstIP, outsidePort: dstPort,
              kind: 'overload',
            },
          });
        } else {
          const oldTcp = session.tcpState;
          session.timestamp = Date.now();
          if (proto === IP_PROTO_TCP) updateTcpState(session, pkt, 'out');
          this.hitCount++;
          if (oldTcp !== session.tcpState && session.tcpState !== undefined) {
            this.getBus().publish({
              topic: 'nat.tcp.state-changed',
              payload: {
                ...this.deviceRef(),
                localIp: session.localIP, localPort: session.localPort,
                globalIp: session.globalIP, globalPort: session.globalPort,
                oldState: String(oldTcp ?? 'closed'),
                newState: String(session.tcpState),
              },
            });
          }
        }

        return rewriteSrcIP(pkt, session.globalIP, session.globalPort);
      }

      if (rule.type === 'pool' && rule.poolName) {
        const pool = this.pools.get(rule.poolName);
        if (!pool) continue;
        const sessionKey = makeKey4(proto, srcIP, srcPort, dstIP, dstPort);
        let session = this.sessions.get(sessionKey);
        if (!session) {
          session = {
            protocol: proto,
            localIP: srcIP, localPort: srcPort,
            globalIP: pool.startIP, globalPort: srcPort,
            outsideIP: dstIP, outsidePort: dstPort,
            timestamp: Date.now(),
          };
          this.sessions.set(sessionKey, session);
          const revKey = makeKey(proto, pool.startIP, srcPort);
          this.reverseSessions.set(revKey, session);
          this.missCount++;
          this.getBus().publish({
            topic: 'nat.session.created',
            payload: {
              ...this.deviceRef(),
              protocol: proto,
              localIp: srcIP, localPort: srcPort,
              globalIp: pool.startIP, globalPort: srcPort,
              outsideIp: dstIP, outsidePort: dstPort,
              kind: 'pool',
            },
          });
        } else {
          this.hitCount++;
        }
        return rewriteSrcIP(pkt, session.globalIP, session.globalPort);
      }
    }

    this.missCount++;
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

  /**
   * Age out stale sessions using per-protocol timeouts (RFC 4787/6146).
   * Call without arguments to use the configured timeout values.
   * Pass an explicit override (in ms) for testing purposes.
   */
  purgeStale(overrideMs?: number): void {
    const now = Date.now();
    let sweeped = 0;
    for (const [key, session] of this.sessions) {
      const timeout = overrideMs !== undefined
        ? overrideMs
        : this.sessionTimeout(session);
      if (now - session.timestamp > timeout) {
        const revKey = makeKey(session.protocol, session.globalIP, session.globalPort);
        this.sessions.delete(key);
        this.reverseSessions.delete(revKey);
        this.expiredCount++;
        sweeped++;
        this.getBus().publish({
          topic: 'nat.session.removed',
          payload: {
            ...this.deviceRef(),
            protocol: session.protocol,
            localIp: session.localIP, localPort: session.localPort,
            globalIp: session.globalIP, globalPort: session.globalPort,
            reason: 'expired',
          },
        });
      }
    }
    if (sweeped > 0) {
      this.getBus().publish({
        topic: 'nat.stale.sweeped',
        payload: {
          ...this.deviceRef(),
          sweepedCount: sweeped,
          remainingSessions: this.sessions.size,
        },
      });
    }
  }

  /**
   * RFC 5508 §3 — translate the IP header embedded inside an ICMP error.
   * For inbound errors: the embedded packet's src was originally our global IP →
   *   rewrite it back to the local IP so the inside host can match it.
   * For outbound errors: the embedded packet's dst is a global IP that we NATted →
   *   rewrite the src (local) to global so the outside sender can correlate.
   */
  private translateIcmpEmbedded(inner: IPv4Packet, dir: 'inbound' | 'outbound'): IPv4Packet | null {
    if (dir === 'inbound') {
      // The inner packet was sent outbound by an inside host and got an error back.
      // Its source is the globalIP:globalPort assigned by PAT → restore to localIP:localPort.
      const srcIP   = inner.sourceIP.toString();
      const srcPort = getPacketSrcPort(inner);
      const revKey  = makeKey(inner.protocol, srcIP, srcPort);
      const session = this.reverseSessions.get(revKey);
      if (session) {
        return rewriteSrcIP(inner, session.localIP, session.localPort);
      }
    } else {
      // The inner packet arrived inbound and the router is generating an error.
      // Its destination is our global IP → restore to local IP so inside host understands.
      const dstIP   = inner.destinationIP.toString();
      const dstPort = getPacketDstPort(inner);
      for (const entry of this.staticEntries) {
        if (entry.globalIP === dstIP && !entry.protocol) {
          return rewriteDestIP(inner, entry.localIP);
        }
        if (entry.globalIP === dstIP && entry.globalPort === dstPort) {
          return rewriteDestIP(inner, entry.localIP, entry.localPort);
        }
      }
    }
    return null;
  }

  private sessionTimeout(session: NatSession): number {
    if (session.protocol === IP_PROTO_TCP) {
      if (session.tcpState === 'syn-seen')   return this.timeouts.tcpHalfOpen;
      if (session.tcpState === 'time-wait')  return 60_000; // 2 × MSL = 60 s (RFC 793)
      return this.timeouts.tcp;
    }
    if (session.protocol === IP_PROTO_ICMP) return this.timeouts.icmp;
    return this.timeouts.udp; // default for UDP and others
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
    const payload = pkt.payload as (UDPPacket | TCPPacket | ICMPPacket);
    if (payload && payload.type === 'udp') {
      result.payload = { ...payload, sourcePort: newSrcPort };
    } else if (payload && payload.type === 'tcp') {
      result.payload = { ...payload, sourcePort: newSrcPort };
    } else if (pkt.protocol === IP_PROTO_ICMP) {
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
    const payload = pkt.payload as (UDPPacket | TCPPacket | ICMPPacket);
    if (payload && payload.type === 'udp') {
      result.payload = { ...payload, destinationPort: newDstPort };
    } else if (payload && payload.type === 'tcp') {
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
  const payload = pkt.payload as (UDPPacket | TCPPacket);
  if (payload && (payload.type === 'udp' || payload.type === 'tcp')) return payload.sourcePort;
  if (pkt.protocol === IP_PROTO_ICMP) {
    const icmp = pkt.payload as ICMPPacket;
    if (icmp && icmp.type === 'icmp') return icmp.identifier ?? 0;
  }
  return 0;
}

function getPacketDstPort(pkt: IPv4Packet): number {
  const payload = pkt.payload as (UDPPacket | TCPPacket);
  if (payload && (payload.type === 'udp' || payload.type === 'tcp')) return payload.destinationPort;
  if (pkt.protocol === IP_PROTO_ICMP) {
    const icmp = pkt.payload as ICMPPacket;
    if (icmp && icmp.type === 'icmp') return icmp.identifier ?? 0;
  }
  return 0;
}

function makeKey(proto: number, ip: string, port: number): string {
  return `${proto}:${ip}:${port}`;
}

/** Full 4-tuple key for PAT session uniqueness (RFC 5382 §3). */
function makeKey4(proto: number, srcIP: string, srcPort: number, dstIP: string, dstPort: number): string {
  return `${proto}:${srcIP}:${srcPort}:${dstIP}:${dstPort}`;
}

import type { TCPPacket as _TCP } from '../../core/types';

/** Update TCP session state based on observed flags (simplified RFC 6146 §2.1). */
function updateTcpState(session: NatSession, pkt: IPv4Packet, _dir: 'in' | 'out'): void {
  const tcp = pkt.payload as _TCP;
  if (!tcp || tcp.type !== 'tcp') return;

  const flags = tcp.flags;
  if (flags.rst) { session.tcpState = 'closed'; return; }

  switch (session.tcpState) {
    case 'syn-seen':
      if (flags.syn && flags.ack) { session.tcpState = 'established'; break; }
      break;
    case 'established':
      if (flags.fin) { session.tcpState = 'fin-wait'; break; }
      break;
    case 'fin-wait':
      if (flags.fin && flags.ack) { session.tcpState = 'time-wait'; break; }
      break;
  }
}

function protoToName(proto: number): string {
  if (proto === IP_PROTO_TCP) return 'tcp';
  if (proto === IP_PROTO_UDP) return 'udp';
  if (proto === IP_PROTO_ICMP) return 'icmp';
  return String(proto);
}

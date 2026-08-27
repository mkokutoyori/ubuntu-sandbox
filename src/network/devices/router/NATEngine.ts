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
import { computeTcpChecksum, computeUdpChecksum } from '../../tcp/types';
import type { TcpSegment, UdpChecksumInput } from '../../tcp/types';
import { tryIpToUint32, uint32ToIp, prefixLengthToMaskUint32 } from '../../core/ip';
import { type IEventBus } from '@/events/EventBus';
import { BusHolder } from '@/events/BusHolder';
import { Logger } from '../../core/Logger';
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
  vrf?: string;
  isNetwork?: boolean;
  prefixLen?: number;
  rawConfig?: string;
  /** Number of packets this static mapping has translated (`show ip nat statistics`'s per-entry refcount). */
  hitCount?: number;
}

export interface NatOutsideStatic {
  outsideGlobal: string;
  outsideLocal: string;
}

export interface NatPool {
  name: string;
  startIP: string;
  endIP: string;
  netmask?: string;
  prefixLength?: number;
}

export type NatDynamicRuleType = 'overload' | 'pool';

export interface NatDynamicRule {
  aclId: string | number;
  type: NatDynamicRuleType;
  poolName?: string;
  interfaceName?: string;
  overload?: boolean;
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
  /**
   * Outside *local* address:port (Cisco's "Outside local" column) — the
   * address the packet was originally addressed to, before this router's
   * own `translateInbound()` DNAT rewrote the destination. Equal to
   * `outsideIP`/`outsidePort` for every ordinary session, where no
   * destination-side translation happened. Differs only for a NAT
   * hairpinning session (RFC 5382 §5): the inside client addressed the
   * flow to the public/static-NAT address of another inside host, so
   * "outside local" (what the client thinks it's talking to) and "outside
   * global" (the real inside address, post-DNAT) genuinely diverge.
   */
  outsideLocalIP?: string;
  outsideLocalPort?: number;
  /** Last-used time — refreshed on every hit (used both for "use:" and staleness). */
  timestamp: number;
  /** First-created time — set once, never refreshed (used for "create:"). */
  createdAt: number;
  // TCP state machine (undefined for UDP/ICMP)
  tcpState?: NatTcpState;
  /** Inside interface (possibly a dot1q subinterface) this session was created on. */
  inIface?: string;
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
  /** DNS session. Default 60 s. */
  dns: number;
  /** TCP FIN/RST (session closing). Default 60 s. */
  finrst: number;
}

/** Result of a NAT translation lookup (for show ip nat translations) */
export interface NatTranslationEntry {
  proto: string;
  insideLocal: string;
  insideGlobal: string;
  outsideLocal: string;
  outsideGlobal: string;
  /** Session-backed entries only: real create/last-use/timeout for `show ip nat translations verbose`. */
  createdAtMs?: number;
  lastUsedMs?: number;
  timeoutMs?: number;
  /** Inside (possibly dot1q subinterface) this session was created on. */
  inputIface?: string;
}

// ─── NATEngine ───────────────────────────────────────────────────────────────

/** Lower bound of the PAT ephemeral range (Cisco IOS overload default). */
const NAT_EPHEMERAL_MIN = 10240;

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
  private matchACLFn?: (aclId: string | number, srcIP: string, pkt?: IPv4Packet) => boolean;
  private getIfaceIPFn?: (iface: string) => string | null;
  // Lookup callback: given an inside IP, return the outside interface it came from
  private getInsideIfaceForIPFn?: (ip: string) => string | null;

  // PAT port counter (RFC 3022: ephemeral range 1024-65535)
  private nextPort = NAT_EPHEMERAL_MIN;
  private readonly maxPort = 65535;

  // Per-protocol session timeouts (ms)
  private timeouts: NatTimeouts = {
    tcp:         86_400_000,   // 24 h  — RFC 2663 §2.3.1
    tcpHalfOpen:     30_000,   // 30 s  — RFC 6146 §4
    udp:            300_000,   // 5 min — RFC 4787 REQ-5
    icmp:            60_000,   // 60 s  — common practice
    dns:             60_000,   // 60 s  — IOS default
    finrst:          60_000,   // 60 s  — IOS default
  };

  // Hit/miss counters (RFC 2663 §4)
  private hitCount = 0;
  private missCount = 0;
  private expiredCount = 0;
  /** High-water mark of `getTranslationCount()`, for `show ip nat statistics`'s "Peak translations". */
  private peakTranslationCount = 0;
  private maxEntries: number | null = null;
  setMaxEntries(n: number | null): void { this.maxEntries = n; }
  getMaxEntries(): number | null { return this.maxEntries; }
  // Direction counters (Phase 4b2-NAT)
  private inboundTranslations = 0;
  private outboundTranslations = 0;

  // ─── Reactive plumbing (Phase 4b2-NAT) ────────────────────────────
  private readonly busHolder = new BusHolder();
  private deviceId: string = '';
  private routerName: string = '';
  private readonly signalStore = new NATSignalStore();
  /** Read-only observables (sessions, stats). */
  readonly observables: NATObservables = makeReadonlyNATObservables(this.signalStore);
  private signalRefreshActor: NATSignalRefreshActor | null = null;

  setEventBus(bus: IEventBus | null): void {
    this.busHolder.set(bus);
    this.attachActors();
  }
  setDeviceId(id: string, routerName?: string): void {
    this.deviceId = id;
    if (routerName !== undefined) this.routerName = routerName;
  }
  getDeviceId(): string { return this.deviceId; }
  private getBus(): IEventBus { return this.busHolder.get(); }
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

  addStaticEntry(entry: NatStaticEntry): { ok: true } | { ok: false; reason: string } {
    const exists = this.staticEntries.some(e =>
      e.localIP === entry.localIP && e.globalIP === entry.globalIP &&
      e.localPort === entry.localPort && e.globalPort === entry.globalPort &&
      e.protocol === entry.protocol
    );
    if (exists) return { ok: false, reason: 'duplicate' };
    if (!entry.protocol) {
      const localClash = this.staticEntries.some(e => !e.protocol && e.localIP === entry.localIP && e.globalIP !== entry.globalIP);
      if (localClash) return { ok: false, reason: 'local-already-mapped' };
      const globalClash = this.staticEntries.some(e => !e.protocol && e.globalIP === entry.globalIP && e.localIP !== entry.localIP);
      if (globalClash) return { ok: false, reason: 'global-already-mapped' };
    } else {
      const globalPortClash = this.staticEntries.some(e =>
        e.protocol === entry.protocol &&
        e.globalIP === entry.globalIP &&
        e.globalPort === entry.globalPort &&
        (e.localIP !== entry.localIP || e.localPort !== entry.localPort)
      );
      if (globalPortClash) return { ok: false, reason: 'global-port-already-mapped' };
    }
    this.staticEntries.push(entry);
    this.updatePeak();
    return { ok: true };
  }

  removeStaticEntry(localIP: string, globalIP: string): void {
    this.staticEntries = this.staticEntries.filter(
      e => !(e.localIP === localIP && e.globalIP === globalIP)
    );
  }

  removeAllStaticEntries(): void { this.staticEntries = []; }

  private outsideStaticEntries: NatOutsideStatic[] = [];
  addOutsideStatic(o: NatOutsideStatic): void {
    if (!this.outsideStaticEntries.some(e => e.outsideGlobal === o.outsideGlobal && e.outsideLocal === o.outsideLocal)) {
      this.outsideStaticEntries.push(o);
    }
  }
  removeOutsideStatic(outsideGlobal: string, outsideLocal: string): void {
    this.outsideStaticEntries = this.outsideStaticEntries.filter(
      e => !(e.outsideGlobal === outsideGlobal && e.outsideLocal === outsideLocal)
    );
  }
  getOutsideStaticEntries(): readonly NatOutsideStatic[] { return this.outsideStaticEntries; }

  addPool(pool: NatPool): void { this.pools.set(pool.name, pool); }
  removePool(name: string): void { this.pools.delete(name); }
  getPool(name: string): NatPool | undefined { return this.pools.get(name); }

  addDynamicRule(rule: NatDynamicRule): void { this.dynamicRules.push(rule); }

  removeDynamicRule(aclId: string | number): void {
    this.dynamicRules = this.dynamicRules.filter(r => String(r.aclId) !== String(aclId));
  }

  // ─── ALG (Application Layer Gateway, PRD-FTP-SFTP.md §2.1.10) ────────────
  // `nat alg ftp enable/disable` (Huawei) and `ip nat service ftp`/`no ip nat
  // service ftp` (Cisco) both drive this same per-protocol toggle. FTP's ALG
  // is on by default, matching real vsftpd-adjacent router defaults.
  private algEnabled = new Set<string>(['ftp']);
  private algDoors = 0;

  getAlgDoors(): number { return this.algDoors; }

  setAlgEnabled(protocol: string, enabled: boolean): void {
    if (enabled) this.algEnabled.add(protocol); else this.algEnabled.delete(protocol);
  }
  isAlgEnabled(protocol: string): boolean { return this.algEnabled.has(protocol); }

  /**
   * Opens a temporary inbound pinhole for a data channel whose address/port
   * was just announced (and rewritten) in a `PORT`/`PASV` payload — the ALG's
   * dynamic-binding counterpart to a real router's translation table entry.
   * Reuses the exact same session shape `translateInbound()`'s reverse-session
   * lookup (step 1) already knows how to consume, so nothing else changes.
   */
  openAlgPinhole(opts: {
    protocol: number; insideIP: string; insidePort: number;
    globalIP: string; globalPort: number; outsideIP: string; outsidePort: number;
  }): void {
    const session: NatSession = {
      protocol: opts.protocol,
      localIP: opts.insideIP, localPort: opts.insidePort,
      globalIP: opts.globalIP, globalPort: opts.globalPort,
      outsideIP: opts.outsideIP, outsidePort: opts.outsidePort,
      timestamp: Date.now(),
      createdAt: Date.now(),
      tcpState: opts.protocol === IP_PROTO_TCP ? 'syn-seen' : undefined,
    };
    const key = makeKey4(opts.protocol, opts.insideIP, opts.insidePort, opts.outsideIP, opts.outsidePort);
    this.sessions.set(key, session);
    this.reverseSessions.set(makeKey(opts.protocol, opts.globalIP, opts.globalPort), session);
    this.algDoors++;
  }

  /** Provide ACL matching function (injected by Router) */
  setACLMatchFn(fn: (aclId: string | number, srcIP: string, pkt?: IPv4Packet) => boolean): void {
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

    // 0. ip nat outside source static — resolved before FIB lookup.
    let ipPkt = pkt;
    if (this.outsideStaticEntries.length > 0) {
      if (isOutside) {
        const srcIP0 = ipPkt.sourceIP.toString();
        const entry = this.outsideStaticEntries.find(e => e.outsideGlobal === srcIP0);
        if (entry) {
          ipPkt = rewriteSrcIP(ipPkt, entry.outsideLocal);
          this.hitCount++;
        }
      } else {
        const dstIP0 = ipPkt.destinationIP.toString();
        const entry = this.outsideStaticEntries.find(e => e.outsideLocal === dstIP0);
        if (entry) {
          ipPkt = rewriteDestIP(ipPkt, entry.outsideGlobal);
          this.hitCount++;
        }
      }
    }

    const dstIP = ipPkt.destinationIP.toString();
    const dstPort = getPacketDstPort(ipPkt);
    const proto = ipPkt.protocol;

    // NAT translates unicast flows only (RFC 2663/5382 both assume a unicast
    // 5-tuple). Broadcast (255.255.255.255) and multicast (224.0.0.0/4,
    // covering both link-local control traffic like LLMNR/mDNS on
    // 224.0.0.252:5355 and admin-scoped groups routed via PIM) are consumed
    // or replicated per-hop by the router itself, never translated by real
    // Cisco IOS NAT — they were never eligible for translation, so counting
    // one as a "Miss" here would be counting ordinary background multicast
    // chatter as a NAT health problem it isn't. `Router.processIPv4` only
    // special-cases broadcast/multicast *after* calling `translateInbound`,
    // so this check has to live here too rather than solely at the caller.
    if (isBroadcastOrMulticastDest(dstIP)) return ipPkt !== pkt ? ipPkt : null;

    // ICMP error messages carry the offending packet as payload (RFC 5508 §3).
    // Translate the embedded original packet so the inside host can correlate it.
    if (proto === IP_PROTO_ICMP) {
      const icmp = ipPkt.payload as ICMPPacket;
      if (icmp && icmp.type === 'icmp' && icmp.originalPacket) {
        const translated = this.translateIcmpEmbedded(icmp.originalPacket, 'inbound');
        if (translated) {
          const newPkt: IPv4Packet = {
            ...ipPkt,
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
        if (proto === IP_PROTO_TCP) updateTcpState(revSession, ipPkt, 'in');
        this.hitCount++;
        return rewriteDestIP(ipPkt, revSession.localIP, revSession.localPort);
      }
    }

    // 2. Static NAT / server (DNAT for inbound connections AND hairpin).
    //    Hairpin: inside host targets the public IP → redirect to inside server.
    for (const entry of this.staticEntries) {
      if (entry.globalIP !== dstIP) continue;

      if (!entry.protocol) {
        this.hitCount++;
        entry.hitCount = (entry.hitCount ?? 0) + 1;
        return rewriteDestIP(ipPkt, entry.localIP);
      }

      const entryProto = entry.protocol === 'tcp' ? IP_PROTO_TCP : IP_PROTO_UDP;
      if (proto === entryProto && dstPort === entry.globalPort) {
        this.hitCount++;
        entry.hitCount = (entry.hitCount ?? 0) + 1;
        return rewriteDestIP(ipPkt, entry.localIP, entry.localPort);
      }
    }

    // A packet arriving on an INSIDE interface that matched no hairpin
    // candidate above isn't a NAT miss at all — it's just ordinary
    // inside-to-outside traffic that `translateOutbound()` will translate
    // once it's actually routed out. Only genuinely inbound (from outside)
    // traffic that found no reverse session and no static entry is a real
    // "Miss" (an unsolicited/unmapped packet we can't translate).
    if (!isOutside) return ipPkt !== pkt ? ipPkt : null;
    if (ipPkt === pkt) this.missCount++;
    return ipPkt !== pkt ? ipPkt : null;
  }

  /**
   * POSTROUTING / SNAT:
   * Called when a packet is about to leave on an outside interface.
   * Returns a modified packet (with translated src) or null if no translation.
   *
   * `opts.isHairpin` relaxes the "egress must be an outside interface" rule
   * for NAT hairpinning (RFC 5382 §5): an inside host reaching another
   * inside host through that host's own public/static NAT address gets
   * routed back out an INSIDE interface (the hairpin turn), yet still needs
   * its source rewritten so the reply routes back through this device —
   * real IOS applies PAT/overload here despite neither interface being
   * "outside". `opts.aclMatchPkt`, when given, is evaluated against the ACL
   * instead of `pkt` — for a hairpin flow `pkt`'s destination has already
   * been DNAT-rewritten to the inside server's real address, but the
   * operator's ACL (e.g. `permit ip <inside-net> host <public-ip>`) is
   * written against the address the client actually targeted.
   */
  translateOutbound(
    pkt: IPv4Packet, outIface: string, inIface: string,
    opts?: { isHairpin?: boolean; aclMatchPkt?: IPv4Packet },
  ): IPv4Packet | null {
    const isHairpin = opts?.isHairpin ?? false;
    if (!this.outsideIfaces.has(outIface) && !isHairpin) return null;
    // Only translate traffic originating from inside
    if (!this.insideIfaces.has(inIface)) return null;

    const srcIP   = pkt.sourceIP.toString();
    const srcPort = getPacketSrcPort(pkt);
    const dstIP   = pkt.destinationIP.toString();
    const dstPort = getPacketDstPort(pkt);
    const proto   = pkt.protocol;

    // Outside *local* address:port ("Cisco's "Outside local" column) — what
    // the client actually addressed the packet to. For an ordinary session
    // this is the same as `dstIP`/`dstPort` (no destination-side
    // translation happened). For a hairpin flow, `aclMatchPkt` is the
    // pre-DNAT packet (see doc comment above), so its destination is the
    // public/static-NAT address the client targeted, distinct from `dstIP`
    // (already rewritten to the real inside server by `translateInbound`).
    const outsideLocalIP   = opts?.aclMatchPkt ? opts.aclMatchPkt.destinationIP.toString() : dstIP;
    const outsideLocalPort = opts?.aclMatchPkt ? getPacketDstPort(opts.aclMatchPkt) : dstPort;

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

    for (const entry of this.staticEntries) {
      if (entry.protocol) {
        const entryProto = entry.protocol === 'tcp' ? IP_PROTO_TCP : IP_PROTO_UDP;
        if (proto === entryProto && entry.localIP === srcIP && entry.localPort === srcPort) {
          this.hitCount++;
          entry.hitCount = (entry.hitCount ?? 0) + 1;
          return rewriteSrcIP(pkt, entry.globalIP, entry.globalPort);
        }
        continue;
      }
      if (entry.isNetwork) {
        const translated = translateNetworkOffset(srcIP, entry);
        if (translated) {
          this.hitCount++;
          entry.hitCount = (entry.hitCount ?? 0) + 1;
          const key = makeKey(proto, srcIP, srcPort);
          if (!this.sessions.has(key)) {
            const session: NatSession = {
              protocol: proto,
              localIP: srcIP, localPort: srcPort,
              globalIP: translated, globalPort: srcPort,
              outsideIP: dstIP, outsidePort: dstPort,
              timestamp: Date.now(),
              createdAt: Date.now(),
              inIface,
            };
            this.sessions.set(key, session);
            this.reverseSessions.set(makeKey(proto, translated, srcPort), session);
            this.updatePeak();
          }
          return rewriteSrcIP(pkt, translated);
        }
      } else if (entry.localIP === srcIP) {
        this.hitCount++;
        entry.hitCount = (entry.hitCount ?? 0) + 1;
        return rewriteSrcIP(pkt, entry.globalIP);
      }
    }

    // 2. Dynamic rules
    for (const rule of this.dynamicRules) {
      if (!this.matchACL(rule.aclId, srcIP, opts?.aclMatchPkt ?? pkt)) continue;

      if (rule.type === 'overload') {
        // Prefer the interface the operator actually named in
        // `ip nat inside source list <acl> interface <if> overload` — for a
        // hairpin flow `outIface` is the INSIDE egress port, not the public
        // interface whose address the translation must use.
        const globalIP = this.getIfaceIPFn?.(rule.interfaceName ?? outIface) ?? null;
        if (!globalIP) continue;

        // Session key includes dst for 4-tuple uniqueness (RFC 5382)
        const sessionKey = makeKey4(proto, srcIP, srcPort, dstIP, dstPort);
        let session = this.sessions.get(sessionKey);

        if (!session) {
          if (this.maxEntries !== null && this.sessions.size >= this.maxEntries) continue;
          const globalPort = this.allocatePort(proto, globalIP);
          if (globalPort === null) continue; // ephemeral range exhausted
          session = {
            protocol: proto,
            localIP: srcIP, localPort: srcPort,
            globalIP, globalPort,
            outsideIP: dstIP, outsidePort: dstPort,
            outsideLocalIP, outsideLocalPort,
            timestamp: Date.now(),
            createdAt: Date.now(),
            tcpState: proto === IP_PROTO_TCP ? 'syn-seen' : undefined,
            inIface,
          };
          this.sessions.set(sessionKey, session);
          const revKey = makeKey(proto, globalIP, globalPort);
          this.reverseSessions.set(revKey, session);
          // A new dynamic translation is a successful outcome (RFC 2663 §4
          // "Hits" also covers newly-created entries) — only a packet that
          // never gets translated at all is a genuine "Miss".
          this.hitCount++;
          this.updatePeak();
          this.debugLog(`s=${srcIP}->${globalIP}, d=${dstIP} [${session.globalPort}]`);
          this.debugLogDetailed('o', `s=${srcIP}:${srcPort}->${globalIP}:${session.globalPort}, d=${dstIP}:${dstPort}`);
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
          this.debugLog(`s=${srcIP}->${session.globalIP}, d=${dstIP} [${session.globalPort}]`);
          this.debugLogDetailed('o', `s=${srcIP}:${srcPort}->${session.globalIP}:${session.globalPort}, d=${dstIP}:${dstPort}`);
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
          const poolIP = rule.overload
            ? this.overloadPoolAddress(pool, proto)
            : this.allocatePoolAddress(pool, srcIP);
          if (poolIP === null) {
            // Exhausted for this rule — try the next dynamic rule rather
            // than counting a Miss here; the final `missCount++` below
            // covers the case where no rule at all can translate the packet.
            continue;
          }
          const poolPort = rule.overload ? this.allocatePort(proto, poolIP) : srcPort;
          if (poolPort === null) continue;
          session = {
            protocol: proto,
            localIP: srcIP, localPort: srcPort,
            globalIP: poolIP, globalPort: poolPort,
            outsideIP: dstIP, outsidePort: dstPort,
            outsideLocalIP, outsideLocalPort,
            timestamp: Date.now(),
            createdAt: Date.now(),
            inIface,
          };
          this.sessions.set(sessionKey, session);
          const revKey = makeKey(proto, poolIP, poolPort);
          this.reverseSessions.set(revKey, session);
          this.hitCount++;
          this.updatePeak();
          this.getBus().publish({
            topic: 'nat.session.created',
            payload: {
              ...this.deviceRef(),
              protocol: proto,
              localIp: srcIP, localPort: srcPort,
              globalIp: poolIP, globalPort: poolPort,
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
    this.debugLog(`s=${srcIP}, d=${dstIP} [not translated]`, false);
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

    for (const session of this.sessions.values()) {
      const protoName = protoToName(session.protocol);
      const outsideGlobal = session.outsideIP
        ? `${session.outsideIP}:${session.outsidePort}`
        : '---';
      // "Outside local" diverges from "Outside global" only for a hairpin
      // session (see NatSession.outsideLocalIP doc comment) — every
      // ordinary session has them equal, since `outsideLocalIP` defaults to
      // `outsideIP` at creation time.
      const outsideLocal = session.outsideLocalIP
        ? `${session.outsideLocalIP}:${session.outsideLocalPort}`
        : outsideGlobal;
      entries.push({
        proto: protoName,
        insideLocal:  `${session.localIP}:${session.localPort}`,
        insideGlobal: `${session.globalIP}:${session.globalPort}`,
        outsideLocal,
        outsideGlobal,
        createdAtMs: session.createdAt,
        lastUsedMs: session.timestamp,
        timeoutMs: this.sessionTimeout(session),
        inputIface: session.inIface,
      });
    }

    return entries;
  }

  getStaticEntries(): NatStaticEntry[] { return [...this.staticEntries]; }
  getDynamicRules(): NatDynamicRule[] { return [...this.dynamicRules]; }
  getPools(): Map<string, NatPool> { return new Map(this.pools); }
  getSessions(): readonly NatSession[] { return [...this.sessions.values()]; }
  getInsideInterfaces(): Set<string> { return new Set(this.insideIfaces); }
  getOutsideInterfaces(): Set<string> { return new Set(this.outsideIfaces); }

  getTranslationCount(): number {
    return this.sessions.size + this.staticEntries.length;
  }

  /** Update the high-water mark after a translation is added. */
  private updatePeak(): void {
    const n = this.getTranslationCount();
    if (n > this.peakTranslationCount) this.peakTranslationCount = n;
  }

  /** Highest `getTranslationCount()` ever observed (`show ip nat statistics`'s "Peak translations"). */
  getPeakTranslationCount(): number { return this.peakTranslationCount; }

  // ─── debug ip nat ──────────────────────────────────────────────────
  private debugEnabled = false;
  private debugDetailed = false;
  private debugEmitFn?: (line: string) => void;
  setDebugEnabled(v: boolean): void { this.debugEnabled = v; }
  isDebugEnabled(): boolean { return this.debugEnabled; }
  setDebugDetailed(v: boolean): void { this.debugDetailed = v; }
  isDebugDetailed(): boolean { return this.debugDetailed; }
  setDebugEmitter(fn: (line: string) => void): void { this.debugEmitFn = fn; }

  private debugLog(line: string, translated = true): void {
    if (!this.debugEnabled) return;
    const text = `${translated ? 'NAT*' : 'NAT'}: ${line}`;
    this.debugEmitFn?.(text);
    Logger.warn(this.deviceId, 'nat:debug', text);
  }

  private debugLogDetailed(direction: 'i' | 'o', line: string): void {
    if (!this.debugEnabled || !this.debugDetailed) return;
    const text = `NAT: ${direction}: ${line}`;
    this.debugEmitFn?.(text);
    Logger.warn(this.deviceId, 'nat:debug', text);
  }

  clearTranslations(): void {
    this.sessions.clear();
    this.reverseSessions.clear();
  }

  clearDynamicTranslations(): void {
    this.sessions.clear();
    this.reverseSessions.clear();
  }

  // `ifaces` matches against `NatSession.inIface` — sessions carry no `vrf`
  // field, so a VRF's membership is recovered from its bound interfaces.
  clearTranslationsFiltered(filter: {
    insideIP?: string;
    outsideIP?: string;
    poolName?: string;
    ifaces?: ReadonlySet<string>;
  }): number {
    const pool = filter.poolName ? this.pools.get(filter.poolName) : undefined;
    const poolStart = pool ? tryIpToUint32(pool.startIP) : null;
    const poolEnd = pool ? tryIpToUint32(pool.endIP) : null;
    let cleared = 0;
    for (const [key, session] of this.sessions) {
      if (filter.insideIP !== undefined && session.localIP !== filter.insideIP) continue;
      if (filter.outsideIP !== undefined && session.outsideIP !== filter.outsideIP) continue;
      if (filter.ifaces !== undefined && (!session.inIface || !filter.ifaces.has(session.inIface))) continue;
      if (pool) {
        const g = tryIpToUint32(session.globalIP);
        if (g === null || poolStart === null || poolEnd === null || g < poolStart || g > poolEnd) continue;
      }
      this.sessions.delete(key);
      this.reverseSessions.delete(makeKey(session.protocol, session.globalIP, session.globalPort));
      cleared++;
    }
    return cleared;
  }

  /**
   * `clear ip nat translation tcp|udp <local-ip> <local-port> <global-ip>
   * <global-port>` — removes only the ONE session identified. The
   * global (ip, port) pair is the true unique key for a PAT/overload
   * entry (RFC 3022), so that's what's used to find it; `localIP`/
   * `localPort` are not required to also match; other active sessions
   * are left untouched.
   */
  clearTranslation(proto: number, globalIP: string, globalPort: number): boolean {
    const revKey = makeKey(proto, globalIP, globalPort);
    const session = this.reverseSessions.get(revKey);
    if (!session) return false;
    const key = makeKey4(proto, session.localIP, session.localPort, session.outsideIP, session.outsidePort);
    this.sessions.delete(key);
    this.reverseSessions.delete(revKey);
    return true;
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
      // `>=` et non `>` : une entrée qui a ATTEINT son délai a expiré.
      // Avec `>`, un délai de 0 ne purge rien tant qu'une milliseconde
      // entière ne s'est pas écoulée — ce qui rendait
      // `purgeStale(0)` (« vide tout », le seul usage de l'override)
      // dépendant de l'horloge murale, donc intermittent : mesuré
      // 3 échecs sur 5 exécutions du même fichier sur le même arbre.
      // Sur le chemin normal, la différence est d'une milliseconde sur
      // un délai qui se compte en minutes.
      if (now - session.timestamp >= timeout) {
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

  private matchACL(aclId: string | number, srcIP: string, pkt?: IPv4Packet): boolean {
    if (this.matchACLFn) return this.matchACLFn(aclId, srcIP, pkt);
    return true;
  }

  /**
   * RFC 4787 REQ-1: pick a port not held by a live session for this
   * (protocol, global IP). The previous linear cursor wrapped straight
   * onto busy ports and overwrote their reverse mapping — inbound
   * traffic of the older session was then delivered to the newer host.
   * Returns null when the whole ephemeral range is in use.
   */
  /**
   * Allocate the next free pool address for an inside source, sticky per
   * inside IP (RFC 6888 REQ-2 — destination-independent mapping). Returns
   * null when the pool is exhausted (no more unique addresses available).
   */
  private overloadPoolAddress(pool: NatPool, proto: number): string | null {
    const startN = tryIpToUint32(pool.startIP);
    const endN = tryIpToUint32(pool.endIP);
    if (startN == null || endN == null) return null;
    for (let n = startN; n <= endN; n++) {
      const ip = uint32ToIp(n);
      if (this.allocatablePort(proto, ip)) return ip;
    }
    return null;
  }

  private allocatablePort(proto: number, globalIP: string): boolean {
    for (let port = NAT_EPHEMERAL_MIN; port <= this.maxPort; port++) {
      if (!this.reverseSessions.has(makeKey(proto, globalIP, port))) return true;
    }
    return false;
  }

  private allocatePoolAddress(pool: NatPool, insideIP: string): string | null {
    for (const s of this.sessions.values()) {
      if (s.localIP === insideIP) {
        const sN = tryIpToUint32(s.globalIP);
        const start = tryIpToUint32(pool.startIP);
        const end = tryIpToUint32(pool.endIP);
        if (sN != null && start != null && end != null && sN >= start && sN <= end) {
          return s.globalIP;
        }
      }
    }
    const startN = tryIpToUint32(pool.startIP);
    const endN = tryIpToUint32(pool.endIP);
    if (startN == null || endN == null) return null;
    const taken = new Set<string>();
    for (const s of this.sessions.values()) taken.add(s.globalIP);
    for (let n = startN; n <= endN; n++) {
      const ip = uint32ToIp(n);
      if (!taken.has(ip)) return ip;
    }
    return null;
  }

  private allocatePort(proto: number, globalIP: string): number | null {
    const span = this.maxPort - NAT_EPHEMERAL_MIN + 1;
    for (let i = 0; i < span; i++) {
      const candidate = this.nextPort;
      this.nextPort = (this.nextPort >= this.maxPort)
        ? NAT_EPHEMERAL_MIN : this.nextPort + 1;
      if (!this.reverseSessions.has(makeKey(proto, globalIP, candidate))) {
        return candidate;
      }
    }
    this.getBus().publish({
      topic: 'nat.port.exhausted',
      payload: { ...this.deviceRef(), protocol: proto, globalIp: globalIP },
    });
    return null;
  }
}

// ─── Packet Rewrite Helpers ──────────────────────────────────────────────────

function translateNetworkOffset(srcIP: string, entry: NatStaticEntry): string | null {
  const prefix = entry.prefixLen ?? 24;
  if (prefix > 32 || prefix < 0) return null;
  const srcNum = tryIpToUint32(srcIP);
  const localNum = tryIpToUint32(entry.localIP);
  const globalNum = tryIpToUint32(entry.globalIP);
  if (srcNum === null || localNum === null || globalNum === null) return null;
  const mask = prefixLengthToMaskUint32(prefix);
  if ((srcNum & mask) !== (localNum & mask)) return null;
  const offset = srcNum - (localNum & mask);
  return uint32ToIp(((globalNum & mask) + offset) >>> 0);
}

function makeKey(proto: number, ip: string, port: number): string {
  return `${proto}:${ip}:${port}`;
}

/** Full 4-tuple key for PAT session uniqueness (RFC 5382 §3). */
function makeKey4(proto: number, srcIP: string, srcPort: number, dstIP: string, dstPort: number): string {
  return `${proto}:${srcIP}:${srcPort}:${dstIP}:${dstPort}`;
}

import type { TCPPacket as _TCP } from '../../core/types';
import {
  getPacketDstPort,
  getPacketSrcPort,
  isBroadcastOrMulticastDest,
  recomputeL4Checksum,
  rewriteDestIP,
  rewriteSrcIP,
} from '../../nat/rewrite';

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

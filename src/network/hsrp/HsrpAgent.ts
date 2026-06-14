/**
 * HsrpAgent — HSRP v1/v2 (RFC 2281 + Cisco extensions) on the shared
 * FHRP foundation. Protocol-specific here: the active/standby
 * two-tier election, UDP/1985 wire format, interface tracking with
 * priority decrement, and the v1/v2 multicast destinations.
 */
import {
  type HsrpConfig, type HsrpGroupRuntime, type HsrpPacket,
  defaultGroupRuntime, makeKey, compareSpeaker,
  effectivePriority, hsrpVirtualMac,
  UDP_PORT_HSRP, HSRP_MULTICAST_V1, HSRP_MULTICAST_V2,
} from './types';
import {
  MACAddress, IPAddress,
  type EthernetFrame, type IPv4Packet, type UDPPacket,
  IP_PROTO_UDP, ETHERTYPE_IPV4, nextIPv4Id, computeIPv4Checksum,
} from '../core/types';
import { Logger } from '../core/Logger';
import { FhrpAgentBase } from '../fhrp/FhrpAgentBase';
import type { FhrpHost, FhrpRecomputeReason } from '../fhrp/types';

export type HsrpHost = FhrpHost;

export class HsrpAgent extends FhrpAgentBase<HsrpGroupRuntime> {
  getConfig(): Readonly<HsrpConfig> { return this.config; }

  // ── FhrpAgentBase hooks ───────────────────────────────────────────
  protected groupId(g: HsrpGroupRuntime): number { return g.group; }

  protected makeGroup(iface: string, group: number): HsrpGroupRuntime {
    return defaultGroupRuntime(iface, group);
  }

  protected isSpeakingState(g: HsrpGroupRuntime): boolean {
    return g.state === 'active' || g.state === 'standby' || g.state === 'speak';
  }

  protected clearPeerState(g: HsrpGroupRuntime): void {
    g.activeRouterIp = null;
    g.standbyRouterIp = null;
    // The segment may have a different active when the link returns:
    // force a fresh Speak probe before any Active claim.
    g.probed = false;
  }

  protected helloIntervalMs(): number { return 3000; }

  /**
   * The standby/version variant: an EXPLICIT version switches the
   * group; an implicit call (from setters) must never reset it —
   * the old code defaulted to v1 and silently downgraded v2 groups.
   */
  override ensureGroup(
    iface: string, group: number, version?: 1 | 2,
  ): HsrpGroupRuntime {
    const g = super.ensureGroup(iface, group);
    if (version !== undefined) g.version = version;
    return g;
  }

  /**
   * Synchronous stand-in for the RFC 2281 Listen/Learn phase: a fresh
   * (or re-risen) group advertises once in Speak; the incumbent active
   * answers synchronously through maybeAdvertiseBack, and only an
   * unanswered probe lets the group claim Active. This is what keeps a
   * non-preempting higher-priority newcomer from hijacking a live
   * active router, without introducing hold-timer waits everywhere.
   */
  private probeThenClaim(g: HsrpGroupRuntime): void {
    this.recompute(g, 'config');
    this.advertiseIfDue(g); // the Speak probe (or a normal hello)
    if (!g.probed) {
      g.probed = true;
      this.recompute(g, 'config');
      this.advertiseIfDue(g);
    }
  }

  override setVip(iface: string, id: number, vip: string): void {
    const g = this.ensureGroup(iface, id);
    g.vip = vip;
    g.vipLearn = false;
    this.probeThenClaim(g);
  }

  setVipLearn(iface: string, id: number): void {
    const g = this.ensureGroup(iface, id);
    g.vipLearn = true;
    g.vip = null;
    this.recompute(g, 'config');
    this.advertiseIfDue(g);
  }

  /** Unconfiguring an active group resigns first, like real IOS. */
  override removeGroup(iface: string, group: number): void {
    const g = this.getGroup(iface, group);
    if (g && g.state === 'active' && this.linkContext(g).linkUp) {
      this.sendResign(g);
    }
    super.removeGroup(iface, group);
  }

  // HSRP (unlike VRRP/GLBP) also advertises right after a preempt
  // change so the coup is observable immediately.
  override setPreempt(iface: string, group: number, on: boolean): void {
    super.setPreempt(iface, group, on);
    const g = this.ensureGroup(iface, group);
    this.advertiseIfDue(g);
  }

  setTimers(iface: string, group: number, helloSec: number, holdSec: number): void {
    const g = this.ensureGroup(iface, group);
    g.helloSec = helloSec;
    g.holdSec = holdSec;
    this.restartTimers();
  }

  setAuth(iface: string, group: number, text: string): void {
    this.ensureGroup(iface, group).authText = text;
  }

  addTrack(iface: string, group: number, target: string, decrement: number): void {
    const g = this.ensureGroup(iface, group);
    const existing = g.tracks.find((t) => t.target === target);
    if (existing) {
      existing.decrement = decrement;
    } else {
      const port = this.host.getPort(target);
      const down = !!port && (!port.getIsUp() || !port.isConnected());
      g.tracks.push({ target, decrement, down });
    }
    this.recompute(g, 'priority');
    this.advertiseIfDue(g);
  }

  removeTrack(iface: string, group: number, target: string): void {
    const g = this.getGroup(iface, group);
    if (!g) return;
    const idx = g.tracks.findIndex((t) => t.target === target);
    if (idx < 0) return;
    g.tracks.splice(idx, 1);
    this.recompute(g, 'priority');
    this.advertiseIfDue(g);
  }

  setVersion(iface: string, version: 1 | 2): void {
    for (const g of this.config.groups.values()) {
      if (g.iface === iface) g.version = version;
    }
  }

  // ── Receive path ─────────────────────────────────────────────────
  handleUdp(inPort: string, srcIp: IPAddress, udp: UDPPacket): void {
    if (!this.config.enabled) return;
    if (udp.destinationPort !== UDP_PORT_HSRP) return;
    const payload = udp.payload as HsrpPacket | undefined;
    if (!payload || payload.type !== 'hsrp') return;
    const g = this.config.groups.get(makeKey(inPort, payload.group));
    if (!g) return;
    if (g.authText !== payload.authText) return;
    if (g.vip && payload.vip && g.vip !== payload.vip) return;

    this.getBus().publish({
      topic: 'hsrp.packet.received',
      payload: {
        ...this.deviceRef(),
        iface: inPort, group: g.group,
        fromIp: payload.senderIp, fromPriority: payload.priority, fromState: payload.state,
      },
    });

    const now = Date.now();
    const oldActiveIp = g.activeRouterIp;
    if (payload.state === 'active') {
      // RFC 2281 §5.5: an Active router yields only to a HIGHER-priority
      // active claim (active/active collision after a partition heal);
      // an inferior claim is ignored — our next hello makes them back
      // down. Non-active routers always learn the active this way.
      const claimer = { priority: payload.priority, ip: payload.senderIp };
      const me = { priority: effectivePriority(g), ip: this.linkContext(g).myIp };
      if (g.state !== 'active' || compareSpeaker(claimer, me) < 0) {
        g.activeRouterIp = payload.senderIp;
        g.activeRouterPriority = payload.priority;
        g.lastHeardActiveMs = now;
      }
    } else if (payload.state === 'standby') {
      g.standbyRouterIp = payload.senderIp;
      g.standbyRouterPriority = payload.priority;
      g.lastHeardStandbyMs = now;
    }
    if (g.vipLearn && !g.vip && payload.vip && payload.vip !== '0.0.0.0') {
      g.vip = payload.vip;
      this.getBus().publish({
        topic: 'hsrp.vip.learned',
        payload: { ...this.deviceRef(), iface: inPort, group: g.group, vip: g.vip },
      });
    }
    if (payload.opcode === 'resign' && payload.senderIp === g.activeRouterIp) {
      g.activeRouterIp = null;
      g.activeRouterPriority = 0;
    }
    if (oldActiveIp !== g.activeRouterIp) {
      this.publishActiveChanged(g);
    }
    this.recompute(g, 'peer');
    this.maybeAdvertiseBack(g);
  }

  // ── Wire format (UDP/1985, v1 224.0.0.2 / v2 224.0.0.102) ────────
  protected advertise(g: HsrpGroupRuntime): void {
    this.emit(g, 'hello');
  }

  /**
   * RFC 2281 §5.4.3: an active router relinquishing its role sends a
   * Resign so the standby takes over immediately instead of waiting
   * out the hold timer.
   */
  private sendResign(g: HsrpGroupRuntime): void {
    this.emit(g, 'resign');
  }

  private emit(g: HsrpGroupRuntime, opcode: HsrpPacket['opcode']): void {
    const port = this.host.getPort(g.iface);
    if (!port) return;
    const srcIp = port.getIPAddress();
    if (!srcIp) return;
    const payload: HsrpPacket = {
      type: 'hsrp', version: g.version,
      opcode, state: g.state,
      helloSec: g.helloSec, holdSec: g.holdSec,
      priority: effectivePriority(g), group: g.group,
      authText: g.authText, vip: g.vip ?? '0.0.0.0',
      senderIp: srcIp.toString(),
    };
    const udp: UDPPacket = {
      type: 'udp', sourcePort: UDP_PORT_HSRP, destinationPort: UDP_PORT_HSRP,
      length: 8 + 20, checksum: 0, payload,
    };
    const dstIp = new IPAddress(g.version === 2 ? HSRP_MULTICAST_V2 : HSRP_MULTICAST_V1);
    const ipPkt: IPv4Packet = {
      type: 'ipv4', version: 4, ihl: 5, tos: 0, totalLength: 20 + udp.length,
      identification: nextIPv4Id(), flags: 0, fragmentOffset: 0,
      ttl: 1, protocol: IP_PROTO_UDP, headerChecksum: 0,
      sourceIP: srcIp, destinationIP: dstIp, payload: udp,
    };
    ipPkt.headerChecksum = computeIPv4Checksum(ipPkt);
    const eth: EthernetFrame = {
      srcMAC: port.getMAC(), dstMAC: multicastMacFor(dstIp),
      etherType: ETHERTYPE_IPV4, payload: ipPkt,
    };
    // A resign is edge-triggered (once per active→non-active transition)
    // and often fires inside the synchronous receive cascade where the
    // re-entrancy guard is held — send it directly.
    if (opcode === 'resign') this.host.sendFrame(g.iface, eth);
    else this.sendGuarded(g, eth);
    this.getBus().publish({
      topic: 'hsrp.packet.sent',
      payload: {
        ...this.deviceRef(),
        iface: g.iface, group: g.group, opcode, state: g.state, priority: effectivePriority(g),
      },
    });
  }

  // ── State machine (RFC 2281 §5; simplified Learn/Listen tiers) ───
  protected recompute(g: HsrpGroupRuntime, reason: FhrpRecomputeReason): void {
    const oldState = g.state;
    const oldActiveIp = g.activeRouterIp;
    const { myIp, linkUp } = this.linkContext(g);

    if (!linkUp) {
      g.state = 'init';
    } else if (!g.vip) {
      g.state = g.vipLearn ? 'learn' : 'init';
    } else {
      const myPriority = effectivePriority(g);
      const me = { priority: myPriority, ip: myIp };
      if (g.activeRouterIp === myIp) g.activeRouterPriority = myPriority;
      if (g.standbyRouterIp === myIp) g.standbyRouterPriority = myPriority;
      const active = g.activeRouterIp
        ? { priority: g.activeRouterPriority, ip: g.activeRouterIp }
        : null;
      if (!active) {
        if (!g.probed) {
          // Synchronous Listen/Learn: speak first, claim only if the
          // probe goes unanswered (see probeThenClaim).
          g.state = 'speak';
        } else {
          g.state = 'active';
          g.activeRouterIp = myIp;
          g.activeRouterPriority = myPriority;
        }
      } else if (active.ip === myIp) {
        g.state = 'active';
      } else if (compareSpeaker(me, active) < 0 && g.preempt) {
        // RFC 2281 §5.3 / IOS default: preemption is DISABLED. Without
        // `standby <grp> preempt`, a higher-priority router never
        // displaces a live active router — it waits for it to die.
        g.state = 'active';
        g.activeRouterIp = myIp;
        g.activeRouterPriority = myPriority;
      } else {
        const standby = g.standbyRouterIp
          ? { priority: g.standbyRouterPriority, ip: g.standbyRouterIp }
          : null;
        if (!standby || standby.ip === myIp || compareSpeaker(me, standby) < 0) {
          g.state = 'standby';
          g.standbyRouterIp = myIp;
          g.standbyRouterPriority = myPriority;
        } else {
          g.state = 'listen';
        }
      }
    }

    if (oldState !== g.state) {
      g.lastTransitionMs = Date.now();
      this.getBus().publish({
        topic: 'hsrp.state.changed',
        payload: {
          ...this.deviceRef(),
          iface: g.iface, group: g.group,
          oldState, newState: g.state, reason,
        },
      });
      Logger.info(this.host.id, 'hsrp:state',
        `${this.host.name}: ${g.iface} grp ${g.group} ${oldState} → ${g.state}`);
      // New active router claims the virtual MAC on the segment so
      // switches re-learn it and host traffic shifts over.
      if (g.state === 'active') {
        this.gratuitousVipArp(g, hsrpVirtualMac(g.group, g.version));
      }
      // RFC 2281 §5.4.3: relinquishing the active role while the link
      // is still alive (lost election to a preempting peer, priority
      // drop) is announced with a Resign — the peer takes over now
      // instead of waiting out the hold timer.
      if (oldState === 'active' && g.state !== 'active' && linkUp) {
        this.sendResign(g);
      }
    }
    if (oldActiveIp !== g.activeRouterIp) {
      this.publishActiveChanged(g);
    }
  }

  // ── Data-plane hooks (FhrpDataPlane) ─────────────────────────────
  // RFC 2281 §5.3: only the active router answers ARP for the VIP,
  // always with the group's virtual MAC, and forwards frames sent to it.
  protected vipArpMac(g: HsrpGroupRuntime): string | null {
    return g.state === 'active' ? hsrpVirtualMac(g.group, g.version) : null;
  }

  protected ownedVirtualMacs(g: HsrpGroupRuntime): string[] {
    return g.state === 'active' ? [hsrpVirtualMac(g.group, g.version)] : [];
  }

  protected isVipOwner(g: HsrpGroupRuntime): boolean {
    return g.state === 'active';
  }

  private publishActiveChanged(g: HsrpGroupRuntime): void {
    this.getBus().publish({
      topic: 'hsrp.active.changed',
      payload: {
        ...this.deviceRef(),
        iface: g.iface, group: g.group,
        activeIp: g.activeRouterIp, activePriority: g.activeRouterPriority,
      },
    });
  }

  // ── Hold-timer expiry ────────────────────────────────────────────
  protected expireDue(): void {
    const now = Date.now();
    for (const g of this.config.groups.values()) {
      if (g.activeRouterIp && now - g.lastHeardActiveMs > g.holdSec * 1000) {
        g.activeRouterIp = null;
        g.activeRouterPriority = 0;
        this.recompute(g, 'timeout');
      }
      if (g.standbyRouterIp && now - g.lastHeardStandbyMs > g.holdSec * 1000) {
        g.standbyRouterIp = null;
        g.standbyRouterPriority = 0;
        this.recompute(g, 'timeout');
      }
    }
  }

  // ── Link reactions with interface tracking ───────────────────────
  protected override onLinkUp(portName: string): void {
    for (const g of this.config.groups.values()) {
      let touched = false;
      for (const t of g.tracks) {
        if (t.target === portName && t.down) { t.down = false; touched = true; }
      }
      if (g.iface === portName) {
        // Probe again after a link cycle — there may be a live active
        // on the segment we must not displace.
        this.probeThenClaim(g);
        touched = false;
      } else if (touched) {
        this.recompute(g, 'priority');
      }
      if (touched) this.advertiseIfDue(g);
    }
  }

  protected override onLinkDown(portName: string): void {
    for (const g of this.config.groups.values()) {
      let touched = false;
      for (const t of g.tracks) {
        if (t.target === portName && !t.down) { t.down = true; touched = true; }
      }
      if (g.iface === portName) {
        this.clearPeerState(g);
        this.recompute(g, 'timeout');
        touched = true;
      } else if (touched) {
        this.recompute(g, 'priority');
      }
      if (touched) this.advertiseIfDue(g);
    }
  }
}

function multicastMacFor(ip: IPAddress): MACAddress {
  const octets = ip.getOctets();
  return new MACAddress([0x01, 0x00, 0x5e, octets[1] & 0x7f, octets[2], octets[3]]);
}

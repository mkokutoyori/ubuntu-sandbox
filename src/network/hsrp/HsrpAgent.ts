/**
 * HsrpAgent — HSRP v1/v2 (RFC 2281 + Cisco extensions) on the shared
 * FHRP foundation. Protocol-specific here: the active/standby
 * two-tier election, UDP/1985 wire format, interface tracking with
 * priority decrement, and the v1/v2 multicast destinations.
 */
import {
  type HsrpConfig, type HsrpGroupRuntime, type HsrpPacket,
  defaultGroupRuntime, makeKey, compareSpeaker,
  effectivePriority,
  UDP_PORT_HSRP, HSRP_MULTICAST_V1, HSRP_MULTICAST_V2,
} from './types';
import {
  MACAddress, IPAddress,
  type EthernetFrame, type UDPPacket,
} from '../core/types';
import { buildUdpIpv4Frame } from '../core/packetBuilders';
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
      g.activeRouterIp = payload.senderIp;
      g.activeRouterPriority = payload.priority;
      g.lastHeardActiveMs = now;
    } else if (payload.state === 'standby') {
      g.standbyRouterIp = payload.senderIp;
      g.standbyRouterPriority = payload.priority;
      g.lastHeardStandbyMs = now;
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
    const port = this.host.getPort(g.iface);
    if (!port) return;
    const srcIp = port.getIPAddress();
    if (!srcIp) return;
    const opcode: HsrpPacket['opcode'] = 'hello';
    const payload: HsrpPacket = {
      type: 'hsrp', version: g.version,
      opcode, state: g.state,
      helloSec: g.helloSec, holdSec: g.holdSec,
      priority: effectivePriority(g), group: g.group,
      authText: g.authText, vip: g.vip ?? '0.0.0.0',
      senderIp: srcIp.toString(),
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
    this.sendGuarded(g, eth);
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

    if (!linkUp || !g.vip) {
      g.state = 'init';
    } else {
      const myPriority = effectivePriority(g);
      const me = { priority: myPriority, ip: myIp };
      if (g.activeRouterIp === myIp) g.activeRouterPriority = myPriority;
      if (g.standbyRouterIp === myIp) g.standbyRouterPriority = myPriority;
      const active = g.activeRouterIp
        ? { priority: g.activeRouterPriority, ip: g.activeRouterIp }
        : null;
      if (!active) {
        g.state = 'active';
        g.activeRouterIp = myIp;
        g.activeRouterPriority = myPriority;
      } else if (active.ip === myIp) {
        g.state = 'active';
      } else if (compareSpeaker(me, active) < 0) {
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
    }
    if (oldActiveIp !== g.activeRouterIp) {
      this.publishActiveChanged(g);
    }
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
        this.recompute(g, 'config');
        touched = true;
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

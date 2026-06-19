/**
 * SwitchSvi — Layer-3 management plane for a Layer-2 switch.
 *
 * A real Catalyst-class L2 switch has no routing engine, but it does own a
 * small host-grade IP stack bound to one or more Switched Virtual Interfaces
 * (`interface Vlan N`). That stack lets the box be managed in-band: it answers
 * ARP for the SVI address, replies to ICMP echo, and can source its own pings
 * out of the bridge — all of it travelling over real cables through the
 * switch's existing L2 forwarding, exactly like a connected host.
 *
 * This module models only that management subset (IP/mask per VLAN, an ARP
 * cache, ICMP echo request/reply). It deliberately reuses the shared packet
 * builders in `core/types` and the switch's own flood/forward path (via the
 * injected {@link SviHost.egressOnVlan}); it is *not* a second copy of the
 * full host stack in `EndHost`.
 *
 * Determinism: the simulator delivers frames synchronously over a cable
 * (`Cable.transmit`), so a request and its reply complete within the same
 * `egressOnVlan` call. ARP resolution and echo therefore settle inline — no
 * wall-clock timers are needed, which keeps tests fast and reproducible.
 */

import {
  EthernetFrame, MACAddress, IPAddress, SubnetMask,
  ARPPacket, ICMPPacket, IPv4Packet,
  ETHERTYPE_ARP, ETHERTYPE_IPV4, IP_PROTO_ICMP,
  createIPv4Packet,
} from '../core/types';
import { Logger } from '../core/Logger';
import type { CiscoPingRow } from './shells/cisco/ciscoPing';

/** A Switched Virtual Interface. Exists (IP-less) once `interface Vlan N` is
 *  entered; gains an address on `ip address`. */
export interface SviInterface {
  vlan: number;
  ip?: IPAddress;
  mask?: SubnetMask;
  /** `no shutdown` state. SVIs are administratively down until brought up. */
  adminUp: boolean;
}

/** The minimal surface the SVI plane needs from its hosting switch. */
export interface SviHost {
  readonly deviceId: string;
  getHostname(): string;
  /** Bridge base MAC — every SVI shares it, like real IOS. */
  getBridgeMac(): MACAddress;
  /** Inject a frame into L2 forwarding on `vlan` (flood/unicast decision). */
  egressOnVlan(vlan: number, frame: EthernetFrame): void;
  /** True when the VLAN has at least one up, connected member port. */
  vlanHasActivePort(vlan: number): boolean;
  /** Read the switch's shared management ARP cache. */
  lookupArp(ip: string): MACAddress | null;
  /** Populate the switch's shared management ARP cache. */
  learnArp(ip: string, mac: MACAddress, iface: string): void;
}

export class SwitchSvi {
  private readonly svis = new Map<number, SviInterface>();
  private pingId = 0;
  /** Inbound echo-replies observed during the current in-flight probe. */
  private pendingReply: { id: number; seq: number; fromIp: string; ttl: number } | null = null;

  constructor(private readonly host: SviHost) {}

  // ─── Configuration ────────────────────────────────────────────────

  /** `interface Vlan N` — materialise the SVI (admin-down, no IP) if new. */
  ensure(vlan: number): SviInterface {
    let svi = this.svis.get(vlan);
    if (!svi) { svi = { vlan, adminUp: false }; this.svis.set(vlan, svi); }
    return svi;
  }

  /** Create/replace the IP on `interface Vlan <vlan>`; preserves admin state. */
  configure(vlan: number, ip: IPAddress, mask: SubnetMask): void {
    const svi = this.ensure(vlan);
    svi.ip = ip;
    svi.mask = mask;
  }

  /** `no ip address` — drop the L3 address but keep the SVI itself. */
  clearIp(vlan: number): void {
    const svi = this.svis.get(vlan);
    if (svi) { svi.ip = undefined; svi.mask = undefined; }
  }

  /** `shutdown` / `no shutdown` on the SVI. */
  setAdminUp(vlan: number, up: boolean): void {
    this.ensure(vlan).adminUp = up;
  }

  hasSvi(vlan: number): boolean { return this.svis.has(vlan); }
  getSvi(vlan: number): SviInterface | undefined { return this.svis.get(vlan); }
  list(): SviInterface[] {
    return [...this.svis.values()].sort((a, b) => a.vlan - b.vlan);
  }

  /** Line protocol is up when admin-up and the VLAN has a live member port. */
  isLineUp(svi: SviInterface): boolean {
    return svi.adminUp && this.host.vlanHasActivePort(svi.vlan);
  }

  /** Pick the SVI whose subnet contains `target` (source-interface selection). */
  private egressSviFor(target: IPAddress): SviInterface | null {
    for (const svi of this.svis.values()) {
      if (!svi.adminUp || !svi.ip || !svi.mask) continue;
      if (svi.ip.isInSameSubnet(target, svi.mask)) return svi;
    }
    // No connected subnet match: fall back to the first addressed, up SVI
    // (management default-gateway forwarding is a separate, later concern).
    for (const svi of this.svis.values()) if (svi.adminUp && svi.ip) return svi;
    return null;
  }

  // ─── Data-plane intercept ─────────────────────────────────────────

  /**
   * Inspect a frame the switch received on `ingressVlan`. Returns `true` when
   * the frame was consumed by the management plane and must not be forwarded
   * further (unicast addressed to us); `false` lets normal L2 forwarding run
   * (e.g. a broadcast ARP request, which still floods the VLAN).
   */
  intercept(ingressVlan: number, ingressPort: string, frame: EthernetFrame): boolean {
    const svi = this.svis.get(ingressVlan);
    if (!svi || !svi.adminUp || !svi.ip) return false;
    const selfIp = svi.ip;

    const myMac = this.host.getBridgeMac();
    const forUs = frame.dstMAC.equals(myMac);

    if (frame.etherType === ETHERTYPE_ARP) {
      const arp = frame.payload as ARPPacket;
      if (!arp || arp.type !== 'arp') return false;
      // Learn the sender either way, into the switch's shared mgmt cache.
      this.host.learnArp(arp.senderIP.toString(), arp.senderMAC, ingressPort);

      if (arp.operation === 'request' && arp.targetIP.equals(selfIp)) {
        this.sendArpReply(ingressVlan, selfIp, arp);
        return false; // broadcast request still floods the VLAN
      }
      if (arp.operation === 'reply' && (forUs || arp.targetIP.equals(selfIp))) {
        return true; // unicast reply addressed to us — consume
      }
      return false;
    }

    if (frame.etherType === ETHERTYPE_IPV4 && forUs) {
      const ip = frame.payload as IPv4Packet;
      if (!ip || ip.type !== 'ipv4' || !ip.destinationIP.equals(selfIp)) return true;
      if (ip.protocol === IP_PROTO_ICMP) {
        const icmp = ip.payload as ICMPPacket;
        if (icmp?.icmpType === 'echo-request') {
          this.sendEchoReply(ingressVlan, selfIp, ip, icmp);
        } else if (icmp?.icmpType === 'echo-reply') {
          this.pendingReply = {
            id: icmp.id, seq: icmp.sequence,
            fromIp: ip.sourceIP.toString(), ttl: ip.ttl,
          };
        }
      }
      return true; // any IP unicast to the SVI MAC is for the box itself
    }

    return false;
  }

  // ─── Ping driver ──────────────────────────────────────────────────

  /**
   * Drive `count` ICMP echoes from the management SVI to `target`. Mirrors
   * `Router.executePingSequence` so the shared {@link formatCiscoPing} renders
   * both. Returns `[]` when the box has no usable source interface or the
   * peer never answers ARP (rendered as "Success rate is 0 percent").
   */
  async executePingSequence(
    target: IPAddress, count = 5, _timeoutMs = 2000, sourceIPStr?: string,
  ): Promise<CiscoPingRow[]> {
    let svi: SviInterface | null = null;
    if (sourceIPStr) {
      for (const s of this.svis.values()) {
        if (s.adminUp && s.ip?.toString() === sourceIPStr) { svi = s; break; }
      }
    }
    svi ??= this.egressSviFor(target);
    if (!svi || !svi.ip) return [];
    const selfIp = svi.ip;

    // Self-ping: every SVI address answers immediately.
    for (const s of this.svis.values()) {
      if (s.ip?.equals(target)) {
        return Array.from({ length: count }, (_, k) => ({
          success: true, rttMs: 0.01, ttl: 255, seq: k + 1, fromIP: target.toString(),
        }));
      }
    }

    const targetMac = this.resolveArp(svi.vlan, selfIp, target);
    if (!targetMac) return []; // ARP failed → unreachable

    const results: CiscoPingRow[] = [];
    for (let seq = 1; seq <= count; seq++) {
      results.push(this.sendEcho(svi.vlan, selfIp, target, targetMac, seq));
    }
    return results;
  }

  // ─── Outbound frame builders ──────────────────────────────────────

  private resolveArp(vlan: number, selfIp: IPAddress, target: IPAddress): MACAddress | null {
    const cached = this.host.lookupArp(target.toString());
    if (cached) return cached;

    const req: ARPPacket = {
      type: 'arp', operation: 'request',
      senderMAC: this.host.getBridgeMac(), senderIP: selfIp,
      targetMAC: MACAddress.broadcast(), targetIP: target,
    };
    this.host.egressOnVlan(vlan, {
      srcMAC: this.host.getBridgeMac(), dstMAC: MACAddress.broadcast(),
      etherType: ETHERTYPE_ARP, payload: req,
    });
    // Synchronous cable delivery: the reply (if any) was processed by
    // intercept() before egressOnVlan returned.
    return this.host.lookupArp(target.toString());
  }

  private sendEcho(
    vlan: number, selfIp: IPAddress, target: IPAddress, targetMac: MACAddress, seq: number,
  ): CiscoPingRow {
    const id = (this.pingId = (this.pingId + 1) & 0xffff);
    const icmp: ICMPPacket = {
      type: 'icmp', icmpType: 'echo-request', code: 0, id, sequence: seq, dataSize: 56,
    };
    const ipPkt = createIPv4Packet(selfIp, target, IP_PROTO_ICMP, 255, icmp, 8 + 56);
    this.pendingReply = null;

    this.host.egressOnVlan(vlan, {
      srcMAC: this.host.getBridgeMac(), dstMAC: targetMac,
      etherType: ETHERTYPE_IPV4, payload: ipPkt,
    });

    const reply = this.pendingReply;
    this.pendingReply = null;
    if (reply && reply.id === id && reply.seq === seq) {
      return { success: true, rttMs: 1, ttl: reply.ttl, seq, fromIP: reply.fromIp };
    }
    return { success: false, rttMs: 0, ttl: 0, seq, fromIP: '', error: 'timeout' };
  }

  private sendArpReply(vlan: number, selfIp: IPAddress, req: ARPPacket): void {
    Logger.info(this.host.deviceId, 'svi:arp-reply',
      `${this.host.getHostname()}: ARP reply for ${selfIp} (Vlan${vlan})`);
    const reply: ARPPacket = {
      type: 'arp', operation: 'reply',
      senderMAC: this.host.getBridgeMac(), senderIP: selfIp,
      targetMAC: req.senderMAC, targetIP: req.senderIP,
    };
    this.host.egressOnVlan(vlan, {
      srcMAC: this.host.getBridgeMac(), dstMAC: req.senderMAC,
      etherType: ETHERTYPE_ARP, payload: reply,
    });
  }

  private sendEchoReply(
    vlan: number, selfIp: IPAddress, reqIp: IPv4Packet, reqIcmp: ICMPPacket,
  ): void {
    const targetMac = this.host.lookupArp(reqIp.sourceIP.toString());
    const icmp: ICMPPacket = {
      type: 'icmp', icmpType: 'echo-reply', code: 0,
      id: reqIcmp.id, sequence: reqIcmp.sequence, dataSize: reqIcmp.dataSize,
    };
    const ipPkt = createIPv4Packet(selfIp, reqIp.sourceIP, IP_PROTO_ICMP, 255, icmp, 8 + reqIcmp.dataSize);
    this.host.egressOnVlan(vlan, {
      srcMAC: this.host.getBridgeMac(),
      dstMAC: targetMac ?? MACAddress.broadcast(),
      etherType: ETHERTYPE_IPV4, payload: ipPkt,
    });
  }
}

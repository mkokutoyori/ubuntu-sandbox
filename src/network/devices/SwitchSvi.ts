import {
  EthernetFrame, MACAddress, IPAddress, SubnetMask,
  ARPPacket, ICMPPacket, IPv4Packet, UDPPacket,
  ETHERTYPE_ARP, ETHERTYPE_IPV4, IP_PROTO_ICMP, IP_PROTO_UDP,
  createIPv4Packet, computeIPv4Checksum,
} from '../core/types';
import { Logger } from '../core/Logger';
import type { CiscoPingRow } from './shells/cisco/ciscoPing';
import { DHCPPacket } from '../dhcp/DHCPPacket';

/** A Switched Virtual Interface. Exists (IP-less) once `interface Vlan N` is
 *  entered; gains an address on `ip address`. */
export interface SviInterface {
  vlan: number;
  ip?: IPAddress;
  mask?: SubnetMask;
  /** `no shutdown` state. SVIs are administratively down until brought up. */
  adminUp: boolean;
  /**
   * Configured DHCP relay targets (IOS `ip helper-address X` /
   * VRP `dhcp relay server-ip X`). Empty when the SVI is not relaying.
   * DHCP clients on this VLAN reach upstream DHCP servers through them.
   */
  helperAddresses: string[];
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
  /** Forget an ARP entry. */
  forgetArp?(ip: string): void;
  /**
   * FHRP (VRRP/HSRP) VIP resolver — when configured, an ARP request
   * for a virtual IP the switch owns as Master returns the virtual
   * MAC that hosts must learn as their default-gateway MAC. Called
   * with the Vlanif name (e.g. `Vlanif10`) and the requester's IP.
   */
  fhrpVipArpOwner?(vlanIf: string, targetIp: string, requesterIp: string): string | null;
  /** RFC 3046 Option 82 insertion on relay, shared with the box's DHCP server config. */
  isDhcpRelayInfoEnabled?(): boolean;
}

export interface SwitchStaticRoute {
  network: IPAddress;
  mask: SubnetMask;
  nextHop: IPAddress;
}

export class SwitchSvi {
  private readonly svis = new Map<number, SviInterface>();
  private readonly staticRoutes: SwitchStaticRoute[] = [];
  private pingId = 0;
  /** Inbound echo-replies observed during the current in-flight probe. */
  private pendingReply: { id: number; seq: number; fromIp: string; ttl: number } | null = null;

  constructor(private readonly host: SviHost) {}

  // ─── Configuration ────────────────────────────────────────────────

  /** `interface Vlan N` — materialise the SVI (admin-down, no IP) if new. */
  ensure(vlan: number): SviInterface {
    let svi = this.svis.get(vlan);
    if (!svi) { svi = { vlan, adminUp: false, helperAddresses: [] }; this.svis.set(vlan, svi); }
    return svi;
  }

  /** Append a DHCP relay target on `vlan`'s SVI (idempotent). */
  addHelperAddress(vlan: number, ip: string): void {
    const svi = this.ensure(vlan);
    if (!svi.helperAddresses.includes(ip)) svi.helperAddresses.push(ip);
  }

  /** Remove one DHCP relay target on `vlan`'s SVI. */
  removeHelperAddress(vlan: number, ip: string): boolean {
    const svi = this.svis.get(vlan);
    if (!svi) return false;
    const i = svi.helperAddresses.indexOf(ip);
    if (i < 0) return false;
    svi.helperAddresses.splice(i, 1);
    return true;
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

  addStaticRoute(network: IPAddress, mask: SubnetMask, nextHop: IPAddress): void {
    const key = `${network}/${mask.toCIDR()}`;
    const existing = this.staticRoutes.findIndex(r => `${r.network}/${r.mask.toCIDR()}` === key);
    if (existing >= 0) this.staticRoutes[existing] = { network, mask, nextHop };
    else this.staticRoutes.push({ network, mask, nextHop });
  }

  removeStaticRoute(network: IPAddress, mask: SubnetMask): boolean {
    const key = `${network}/${mask.toCIDR()}`;
    const idx = this.staticRoutes.findIndex(r => `${r.network}/${r.mask.toCIDR()}` === key);
    if (idx >= 0) { this.staticRoutes.splice(idx, 1); return true; }
    return false;
  }

  getStaticRoutes(): readonly SwitchStaticRoute[] { return this.staticRoutes; }

  getRoutingTable(): Array<{ network: IPAddress; mask: SubnetMask; nextHop?: IPAddress; iface: string; proto: 'connected' | 'static' }> {
    const rows: Array<{ network: IPAddress; mask: SubnetMask; nextHop?: IPAddress; iface: string; proto: 'connected' | 'static' }> = [];
    for (const svi of this.svis.values()) {
      if (!svi.adminUp || !svi.ip || !svi.mask) continue;
      rows.push({
        network: svi.ip.networkAddress(svi.mask),
        mask: svi.mask,
        iface: `Vlanif${svi.vlan}`,
        proto: 'connected',
      });
    }
    for (const r of this.staticRoutes) {
      const egress = this.svisFor(r.nextHop);
      rows.push({
        network: r.network,
        mask: r.mask,
        nextHop: r.nextHop,
        iface: egress ? `Vlanif${egress.vlan}` : '-',
        proto: 'static',
      });
    }
    return rows;
  }

  private svisFor(addr: IPAddress): SviInterface | null {
    for (const svi of this.svis.values()) {
      if (!this.isLineUp(svi) || !svi.ip || !svi.mask) continue;
      if (svi.ip.isInSameSubnet(addr, svi.mask)) return svi;
    }
    return null;
  }

  private lookupRoute(dst: IPAddress): { nextHop: IPAddress; egress: SviInterface } | null {
    const direct = this.svisFor(dst);
    if (direct) return { nextHop: dst, egress: direct };
    let best: { route: SwitchStaticRoute; prefix: number } | null = null;
    for (const r of this.staticRoutes) {
      if (!dst.isInSameSubnet(r.network, r.mask)) continue;
      const prefix = r.mask.toCIDR();
      if (!best || prefix > best.prefix) best = { route: r, prefix };
    }
    if (!best) return null;
    const egress = this.svisFor(best.route.nextHop);
    if (!egress) return null;
    return { nextHop: best.route.nextHop, egress };
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
    let forUs = frame.dstMAC.equals(myMac);

    if (frame.etherType === ETHERTYPE_ARP) {
      const arp = frame.payload as ARPPacket;
      if (!arp || arp.type !== 'arp') return false;
      // Learn the sender either way, into the switch's shared mgmt cache.
      this.host.learnArp(arp.senderIP.toString(), arp.senderMAC, ingressPort);

      if (arp.operation === 'request' && arp.targetIP.equals(selfIp)) {
        this.sendArpReply(ingressVlan, selfIp, arp);
        return false; // broadcast request still floods the VLAN
      }
      // VRRP: any group Master on this SVI answers ARP for the VIP
      // with the group's virtual MAC. Hosts thus learn the shared
      // gateway MAC rather than any physical bridge address.
      if (arp.operation === 'request' && this.host.fhrpVipArpOwner) {
        const vmac = this.host.fhrpVipArpOwner(
          `Vlanif${ingressVlan}`,
          arp.targetIP.toString(),
          arp.senderIP.toString(),
        );
        if (vmac) {
          this.sendVirtualArpReply(ingressVlan, arp, arp.targetIP, new MACAddress(vmac));
          return false;
        }
      }
      if (arp.operation === 'reply' && (forUs || arp.targetIP.equals(selfIp))) {
        return true; // unicast reply addressed to us — consume
      }
      return false;
    }

    if (frame.etherType === ETHERTYPE_IPV4) {
      const ip = frame.payload as IPv4Packet;
      if (!ip || ip.type !== 'ipv4') return forUs;

      // A relay hop may reply with a broadcast dstMAC but an IP destination
      // that's genuinely one of our own SVIs (mirrors Router's own local-
      // delivery check, which is IP- not MAC-driven) — still "for us".
      if (!forUs && frame.dstMAC.isBroadcast()) {
        forUs = [...this.svis.values()].some(s => s.adminUp && s.ip?.equals(ip.destinationIP));
      }

      // DHCP relay: a client's DISCOVER/REQUEST is broadcast (dstMAC is not
      // ours), so this runs ahead of the forUs gate below — same treatment
      // as a broadcast ARP request, answered/relayed but still flooded.
      if (!forUs && ip.protocol === IP_PROTO_UDP && svi.helperAddresses.length > 0) {
        const udp = ip.payload as UDPPacket | undefined;
        const dhcp = udp?.type === 'udp' ? udp.payload : undefined;
        if (udp?.destinationPort === 67 && dhcp instanceof DHCPPacket && dhcp.op === 1) {
          this.relayDhcpToHelpers(svi, dhcp);
        }
      }

      if (!forUs) return false;

      const dstIsOwnSvi = [...this.svis.values()].some(s => s.adminUp && s.ip?.equals(ip.destinationIP));
      if (dstIsOwnSvi) {
        if (ip.protocol === IP_PROTO_ICMP) {
          const icmp = ip.payload as ICMPPacket;
          if (icmp?.icmpType === 'echo-request') {
            this.sendEchoReply(ingressVlan, ip.destinationIP, ip, icmp);
          } else if (icmp?.icmpType === 'echo-reply') {
            this.pendingReply = {
              id: icmp.id, seq: icmp.sequence,
              fromIp: ip.sourceIP.toString(), ttl: ip.ttl,
            };
          }
        } else if (ip.protocol === IP_PROTO_UDP) {
          const udp = ip.payload as UDPPacket | undefined;
          const dhcp = udp?.type === 'udp' ? udp.payload : undefined;
          if (dhcp instanceof DHCPPacket && dhcp.op === 2) {
            this.relayDhcpReplyToClientVlan(dhcp);
          }
        }
        return true;
      }

      this.forwardIpPacket(ingressVlan, ip);
      return true;
    }

    return false;
  }

  /**
   * `ip helper-address` (Cisco) / `dhcp relay server-ip` (Huawei) on this
   * SVI: stamp giaddr/hop-count (and Option 82 when enabled) and unicast
   * the client's broadcast DISCOVER/REQUEST to each configured helper,
   * routed the same way any other packet the SVI originates would be.
   */
  private relayDhcpToHelpers(svi: SviInterface, pkt: DHCPPacket): void {
    if (pkt.hops >= 16) return;
    pkt.hops++;
    if (pkt.giaddr === '0.0.0.0') pkt.giaddr = svi.ip!.toString();
    if (this.host.isDhcpRelayInfoEnabled?.()) {
      pkt.setOption(82, { circuitId: `Vlanif${svi.vlan}`, remoteId: this.host.getHostname() });
    }
    for (const helper of svi.helperAddresses) {
      const dst = new IPAddress(helper);
      const route = this.lookupRoute(dst);
      if (!route || !route.egress.ip) continue;
      const nextHopMac = this.resolveArp(route.egress.vlan, route.egress.ip, route.nextHop);
      if (!nextHopMac) continue;
      const udp: UDPPacket = {
        type: 'udp', sourcePort: 67, destinationPort: 67, length: 8 + 300, checksum: 0, payload: pkt,
      };
      const relayed = createIPv4Packet(new IPAddress(pkt.giaddr), dst, IP_PROTO_UDP, 64, udp, 8 + 300);
      this.host.egressOnVlan(route.egress.vlan, {
        srcMAC: this.host.getBridgeMac(), dstMAC: nextHopMac,
        etherType: ETHERTYPE_IPV4, payload: relayed,
      });
    }
  }

  /** A relayed OFFER/ACK/NAK addressed back to one of our SVIs (giaddr): strip Option 82 and broadcast it onto the client's own VLAN. */
  private relayDhcpReplyToClientVlan(pkt: DHCPPacket): void {
    for (const svi of this.svis.values()) {
      if (!svi.adminUp || !svi.ip || pkt.giaddr !== svi.ip.toString()) continue;
      pkt.removeOption(82);
      const udp: UDPPacket = {
        type: 'udp', sourcePort: 67, destinationPort: 68, length: 8 + 300, checksum: 0, payload: pkt,
      };
      const relayed = createIPv4Packet(svi.ip, new IPAddress('255.255.255.255'), IP_PROTO_UDP, 64, udp, 8 + 300);
      this.host.egressOnVlan(svi.vlan, {
        srcMAC: this.host.getBridgeMac(), dstMAC: MACAddress.broadcast(),
        etherType: ETHERTYPE_IPV4, payload: relayed,
      });
      return;
    }
  }

  private forwardIpPacket(ingressVlan: number, ip: IPv4Packet): void {
    if (ip.ttl <= 1) {
      const ingressSvi = this.svis.get(ingressVlan);
      if (ingressSvi?.ip) this.sendIcmpTimeExceeded(ingressVlan, ingressSvi.ip, ip);
      return;
    }
    const route = this.lookupRoute(ip.destinationIP);
    if (!route) {
      const ingressSvi = this.svis.get(ingressVlan);
      if (ingressSvi?.ip) this.sendIcmpHostUnreachable(ingressVlan, ingressSvi.ip, ip, 0);
      return;
    }
    const nextHopMac = this.resolveArpFresh(route.egress.vlan, route.egress.ip!, route.nextHop);
    if (!nextHopMac) {
      const ingressSvi = this.svis.get(ingressVlan);
      if (ingressSvi?.ip) this.sendIcmpHostUnreachable(ingressVlan, ingressSvi.ip, ip, 1);
      return;
    }
    const fwd: IPv4Packet = { ...ip, ttl: ip.ttl - 1, headerChecksum: 0 };
    fwd.headerChecksum = computeIPv4Checksum(fwd);
    this.host.egressOnVlan(route.egress.vlan, {
      srcMAC: this.host.getBridgeMac(), dstMAC: nextHopMac,
      etherType: ETHERTYPE_IPV4, payload: fwd,
    });
  }

  private sendIcmpTimeExceeded(_vlan: number, _selfIp: IPAddress, orig: IPv4Packet): void {
    const replyRoute = this.lookupRoute(orig.sourceIP);
    if (!replyRoute || !replyRoute.egress.ip) return;
    const replyMac = this.resolveArp(replyRoute.egress.vlan, replyRoute.egress.ip, replyRoute.nextHop);
    if (!replyMac) return;
    const icmp: ICMPPacket = { type: 'icmp', icmpType: 'time-exceeded', code: 0, id: 0, sequence: 0, dataSize: 0, originalPacket: orig };
    const pkt = createIPv4Packet(replyRoute.egress.ip, orig.sourceIP, IP_PROTO_ICMP, 64, icmp);
    this.host.egressOnVlan(replyRoute.egress.vlan, {
      srcMAC: this.host.getBridgeMac(), dstMAC: replyMac,
      etherType: ETHERTYPE_IPV4, payload: pkt,
    });
  }

  private sendIcmpHostUnreachable(_vlan: number, _selfIp: IPAddress, orig: IPv4Packet, code: number): void {
    const replyRoute = this.lookupRoute(orig.sourceIP);
    if (!replyRoute || !replyRoute.egress.ip) return;
    const replyMac = this.resolveArp(replyRoute.egress.vlan, replyRoute.egress.ip, replyRoute.nextHop);
    if (!replyMac) return;
    const icmp: ICMPPacket = { type: 'icmp', icmpType: 'destination-unreachable', code, id: 0, sequence: 0, dataSize: 0, originalPacket: orig };
    const pkt = createIPv4Packet(replyRoute.egress.ip, orig.sourceIP, IP_PROTO_ICMP, 64, icmp);
    this.host.egressOnVlan(replyRoute.egress.vlan, {
      srcMAC: this.host.getBridgeMac(), dstMAC: replyMac,
      etherType: ETHERTYPE_IPV4, payload: pkt,
    });
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

  private resolveArpFresh(vlan: number, selfIp: IPAddress, target: IPAddress): MACAddress | null {
    this.host.forgetArp?.(target.toString());
    const req: ARPPacket = {
      type: 'arp', operation: 'request',
      senderMAC: this.host.getBridgeMac(), senderIP: selfIp,
      targetMAC: MACAddress.broadcast(), targetIP: target,
    };
    this.host.egressOnVlan(vlan, {
      srcMAC: this.host.getBridgeMac(), dstMAC: MACAddress.broadcast(),
      etherType: ETHERTYPE_ARP, payload: req,
    });
    return this.host.lookupArp(target.toString());
  }

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

  /**
   * VRRP-flavoured ARP reply — sender MAC is the group's virtual MAC
   * (RFC 5798 §7.3), not the bridge MAC. Hosts thus learn the shared
   * gateway MAC and keep sending to it across a Master/Backup swap.
   */
  private sendVirtualArpReply(
    vlan: number, req: ARPPacket, vip: IPAddress, virtualMac: MACAddress,
  ): void {
    Logger.info(this.host.deviceId, 'svi:vrrp-arp-reply',
      `${this.host.getHostname()}: VRRP ARP reply for ${vip} → ${virtualMac} (Vlan${vlan})`);
    const reply: ARPPacket = {
      type: 'arp', operation: 'reply',
      senderMAC: virtualMac, senderIP: vip,
      targetMAC: req.senderMAC, targetIP: req.senderIP,
    };
    this.host.egressOnVlan(vlan, {
      srcMAC: virtualMac, dstMAC: req.senderMAC,
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

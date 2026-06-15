/**
 * GlbpAgent — Cisco GLBP on the shared FHRP foundation. Protocol-
 * specific here: the AVG election, AVF assignment/expiry (up to 4
 * forwarders), the three load-balancing modes, and the UDP/3222
 * TLV wire format.
 */
import {
  type GlbpConfig, type GlbpGroupRuntime, type GlbpPacket,
  type GlbpAvgState, type GlbpForwarder, type GlbpLoadBalancing,
  type GlbpHelloTlv, type GlbpAssignTlv,
  defaultGroupRuntime, makeKey,
  glbpVirtualMac, compareCandidate, effectiveWeighting,
  UDP_PORT_GLBP, GLBP_MULTICAST_IP, GLBP_MULTICAST_MAC,
} from './types';
import {
  MACAddress, IPAddress,
  type EthernetFrame, type IPv4Packet, type UDPPacket,
  IP_PROTO_UDP, ETHERTYPE_IPV4, nextIPv4Id, computeIPv4Checksum,
} from '../core/types';
import { Logger } from '../core/Logger';
import { FhrpAgentBase } from '../fhrp/FhrpAgentBase';
import type { FhrpHost, FhrpRecomputeReason } from '../fhrp/types';

const MAX_FORWARDERS = 4;

export type GlbpHost = FhrpHost;

export class GlbpAgent extends FhrpAgentBase<GlbpGroupRuntime> {
  getConfig(): Readonly<GlbpConfig> { return this.config; }

  // ── FhrpAgentBase hooks ───────────────────────────────────────────
  protected groupId(g: GlbpGroupRuntime): number { return g.group; }

  protected makeGroup(iface: string, group: number): GlbpGroupRuntime {
    return defaultGroupRuntime(iface, group);
  }

  protected isSpeakingState(g: GlbpGroupRuntime): boolean {
    return g.avgState === 'active' || g.avgState === 'standby'
      || g.avgState === 'speak' || g.avgState === 'listen';
  }

  protected clearPeerState(g: GlbpGroupRuntime): void {
    g.avgIp = null;
  }

  protected helloIntervalMs(): number { return 3000; }

  // ── Protocol-specific config ─────────────────────────────────────
  setWeighting(iface: string, group: number, weighting: number): void {
    const g = this.ensureGroup(iface, group);
    g.weighting = weighting;
    this.syncOwnWeighting(g);
  }

  private syncOwnWeighting(g: GlbpGroupRuntime): void {
    const myIp = this.myIpFor(g);
    const own = [...g.forwarders.values()].find(f => f.ownerIp === myIp);
    if (own) own.weighting = effectiveWeighting(g);
  }

  addTrack(iface: string, group: number, target: string, decrement: number): void {
    const g = this.ensureGroup(iface, group);
    const existing = g.tracks.find(t => t.target === target);
    if (existing) {
      existing.decrement = decrement;
    } else {
      const port = this.host.getPort(target);
      const down = !!port && (!port.getIsUp() || !port.isConnected());
      g.tracks.push({ target, decrement, down });
    }
    this.syncOwnWeighting(g);
    this.advertiseIfDue(g);
  }

  removeTrack(iface: string, group: number, target: string): void {
    const g = this.getGroup(iface, group);
    if (!g) return;
    const idx = g.tracks.findIndex(t => t.target === target);
    if (idx < 0) return;
    g.tracks.splice(idx, 1);
    this.syncOwnWeighting(g);
    this.advertiseIfDue(g);
  }

  protected override onLinkUp(portName: string): void {
    for (const g of this.config.groups.values()) {
      let touched = false;
      for (const t of g.tracks) {
        if (t.target === portName && t.down) { t.down = false; touched = true; }
      }
      if (g.iface === portName) {
        this.recompute(g, 'config');
        this.syncOwnWeighting(g);
        this.advertiseIfDue(g);
      } else if (touched) {
        this.syncOwnWeighting(g);
        this.advertiseIfDue(g);
      }
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
      } else if (touched) {
        this.syncOwnWeighting(g);
        this.advertiseIfDue(g);
      }
    }
  }

  setLoadBalancing(iface: string, group: number, mode: GlbpLoadBalancing): void {
    const g = this.ensureGroup(iface, group);
    g.loadBalancing = mode;
    g.rrCursor = 0;
    g.hostMap.clear();
  }

  setTimers(iface: string, group: number, helloSec: number, holdSec: number): void {
    const g = this.ensureGroup(iface, group);
    g.helloSec = helloSec;
    g.holdSec = holdSec;
    this.restartTimers();
  }

  nextForwarderMacForClient(iface: string, group: number, clientIp: string): string | null {
    const g = this.config.groups.get(makeKey(iface, group));
    if (!g) return null;
    const active = [...g.forwarders.values()]
      .filter(f => f.state === 'active' && f.weighting > 0)
      .sort((a, b) => a.forwarderNumber - b.forwarderNumber);
    if (active.length === 0) return null;
    if (g.loadBalancing === 'host-dependent') {
      const cached = g.hostMap.get(clientIp);
      if (cached !== undefined) {
        const f = active.find(x => x.forwarderNumber === cached);
        if (f) return f.vmac;
      }
      const idx = this.hashIp(clientIp) % active.length;
      const chosen = active[idx];
      g.hostMap.set(clientIp, chosen.forwarderNumber);
      return chosen.vmac;
    }
    if (g.loadBalancing === 'weighted') {
      const total = active.reduce((s, f) => s + Math.max(1, f.weighting), 0);
      const pick = (this.hashIp(clientIp) % total);
      let acc = 0;
      for (const f of active) {
        acc += Math.max(1, f.weighting);
        if (pick < acc) return f.vmac;
      }
      return active[active.length - 1].vmac;
    }
    const chosen = active[g.rrCursor % active.length];
    g.rrCursor = (g.rrCursor + 1) % active.length;
    return chosen.vmac;
  }

  // ── Receive path ─────────────────────────────────────────────────
  handleUdp(inPort: string, srcIp: IPAddress, udp: UDPPacket): void {
    if (!this.config.enabled) return;
    if (udp.destinationPort !== UDP_PORT_GLBP) return;
    const payload = udp.payload as GlbpPacket | undefined;
    if (!payload || payload.type !== 'glbp') return;
    const g = this.config.groups.get(makeKey(inPort, payload.group));
    if (!g) return;

    this.getBus().publish({
      topic: 'glbp.packet.received',
      payload: {
        ...this.deviceRef(),
        iface: inPort, group: g.group,
        fromIp: payload.senderIp, fromPriority: this.extractHelloPriority(payload),
      },
    });

    const hello = payload.tlvs.find((t): t is GlbpHelloTlv => t.type === 'hello');
    const assigns = payload.tlvs.filter((t): t is GlbpAssignTlv => t.type === 'assign');
    const hasRequest = payload.tlvs.some(t => t.type === 'request');

    if (hello) {
      if (g.vip && hello.vip && hello.vip !== '0.0.0.0' && hello.vip !== g.vip) return;
      const oldAvgIp = g.avgIp;
      const peer = { priority: hello.priority, ip: payload.senderIp };
      const myIp = this.myIpFor(g);
      const me = { priority: g.priority, ip: myIp };
      if (g.avgState === 'active') {
        if (compareCandidate(peer, me) < 0 && (g.preempt || hello.priority > g.priority)) {
          g.avgIp = payload.senderIp;
          g.avgPriority = hello.priority;
          g.lastHeardAvgMs = Date.now();
        }
      } else {
        if (!g.avgIp || compareCandidate(peer, { priority: g.avgPriority, ip: g.avgIp }) < 0) {
          g.avgIp = payload.senderIp;
          g.avgPriority = hello.priority;
        }
        g.lastHeardAvgMs = Date.now();
      }
      if (oldAvgIp !== g.avgIp) {
        Logger.info(this.host.id, 'glbp:avg',
          `${this.host.name}: ${inPort} grp ${g.group} AVG → ${g.avgIp}`);
      }
      this.upsertForwarderFromHello(g, payload.senderIp, hello);
      this.recompute(g, 'peer');
    }

    if (g.avgIp === payload.senderIp) {
      for (const a of assigns) this.applyAssignment(g, a);
    }

    if (g.avgState === 'active' && hello) {
      const hasForwarder = [...g.forwarders.values()].some(f => f.ownerIp === payload.senderIp);
      if (!hasForwarder) {
        this.assignForwarderFor(g, payload.senderIp);
        this.advertise(g);
      }
    }
    if (hasRequest && g.avgState === 'active') {
      this.assignForwarderFor(g, payload.senderIp);
      this.advertise(g);
    }

    this.maybeAdvertiseBack(g);
  }

  private extractHelloPriority(p: GlbpPacket): number {
    const h = p.tlvs.find(t => t.type === 'hello');
    return h && h.type === 'hello' ? h.priority : 0;
  }

  private upsertForwarderFromHello(g: GlbpGroupRuntime, ip: string, hello: GlbpHelloTlv): void {
    const existing = [...g.forwarders.values()].find(f => f.ownerIp === ip);
    if (existing) {
      existing.priority = hello.priority;
      existing.weighting = hello.weighting;
      existing.lastHeardMs = Date.now();
      // A live owner forwards for its virtual MAC: hearing its hello
      // moves the AVF out of listen/init, so the AVG's load balancing
      // actually rotates over every forwarder (and revives it after a
      // hold-time expiry once the peer comes back).
      if (existing.state === 'listen' || existing.state === 'init') {
        const oldState = existing.state;
        existing.state = 'active';
        this.getBus().publish({
          topic: 'glbp.avf.state.changed',
          payload: {
            ...this.deviceRef(),
            iface: g.iface, group: g.group,
            forwarderNumber: existing.forwarderNumber, oldState, newState: 'active',
          },
        });
      }
    }
  }

  private applyAssignment(g: GlbpGroupRuntime, a: GlbpAssignTlv): void {
    let f = g.forwarders.get(a.forwarderNumber);
    if (!f) {
      f = {
        forwarderNumber: a.forwarderNumber, vmac: a.vmac,
        ownerIp: a.ownerIp, priority: a.priority, weighting: a.weighting,
        state: 'listen', lastHeardMs: Date.now(),
      };
      g.forwarders.set(a.forwarderNumber, f);
    } else {
      f.vmac = a.vmac;
      f.ownerIp = a.ownerIp;
      f.priority = a.priority;
      f.weighting = a.weighting;
      f.lastHeardMs = Date.now();
    }
    const myIp = this.myIpFor(g);
    if (a.ownerIp === myIp) {
      const oldState = f.state;
      f.state = 'active';
      if (oldState !== 'active') {
        this.getBus().publish({
          topic: 'glbp.avf.state.changed',
          payload: {
            ...this.deviceRef(),
            iface: g.iface, group: g.group,
            forwarderNumber: f.forwarderNumber, oldState, newState: 'active',
          },
        });
      }
    }
  }

  private assignForwarderFor(g: GlbpGroupRuntime, ownerIp: string): void {
    const existing = [...g.forwarders.values()].find(f => f.ownerIp === ownerIp);
    if (existing) return;
    let n = 1;
    for (; n <= MAX_FORWARDERS; n++) if (!g.forwarders.has(n)) break;
    if (n > MAX_FORWARDERS) return;
    const vmac = glbpVirtualMac(g.group, n);
    // The AVG only assigns a forwarder to an owner it just heard from
    // (hello/request receipt), so the owner is alive and forwarding:
    // start the AVF active so load balancing rotates over it. expireDue
    // demotes it to init if the owner goes silent past hold time.
    const f: GlbpForwarder = {
      forwarderNumber: n, vmac, ownerIp,
      priority: 100, weighting: 100,
      state: 'active', lastHeardMs: Date.now(),
    };
    g.forwarders.set(n, f);
    this.getBus().publish({
      topic: 'glbp.avf.assigned',
      payload: {
        ...this.deviceRef(),
        iface: g.iface, group: g.group,
        forwarderNumber: n, vmac, ownerIp,
      },
    });
  }

  private myIpFor(g: GlbpGroupRuntime): string {
    return this.linkContext(g).myIp;
  }

  // ── Data-plane hooks (FhrpDataPlane) ─────────────────────────────
  // The AVG answers ARP for the VIP, handing out AVF virtual MACs per
  // the group's load-balancing mode; each AVF forwards the frames
  // addressed to its own virtual MAC.
  protected vipArpMac(g: GlbpGroupRuntime, requesterIp: string): string | null {
    if (g.avgState !== 'active') return null;
    return this.nextForwarderMacForClient(g.iface, g.group, requesterIp);
  }

  protected ownedVirtualMacs(g: GlbpGroupRuntime): string[] {
    const myIp = this.myIpFor(g);
    return [...g.forwarders.values()]
      .filter(f => f.ownerIp === myIp && f.state === 'active')
      .map(f => f.vmac);
  }

  protected isVipOwner(g: GlbpGroupRuntime): boolean {
    return g.avgState === 'active';
  }

  // ── Wire format (UDP/3222, 224.0.0.102) ──────────────────────────
  protected advertise(g: GlbpGroupRuntime): void {
    const port = this.host.getPort(g.iface);
    if (!port) return;
    const srcIp = port.getIPAddress();
    if (!srcIp) return;
    const tlvs: GlbpPacket['tlvs'] = [{
      type: 'hello',
      priority: g.priority,
      weighting: effectiveWeighting(g),
      vip: g.vip ?? '0.0.0.0',
      helloMs: g.helloSec * 1000,
      holdMs: g.holdSec * 1000,
    }];
    if (g.avgState === 'active') {
      for (const f of g.forwarders.values()) {
        if (!f.ownerIp) continue;
        tlvs.push({
          type: 'assign',
          forwarderNumber: f.forwarderNumber,
          vmac: f.vmac, ownerIp: f.ownerIp,
          priority: f.priority, weighting: f.weighting,
        });
      }
    } else if (g.avgIp && g.avgIp !== srcIp.toString()) {
      const owned = [...g.forwarders.values()].some(f => f.ownerIp === srcIp.toString());
      if (!owned) tlvs.push({ type: 'request' });
    }
    const payload: GlbpPacket = {
      type: 'glbp', version: 1, group: g.group,
      senderIp: srcIp.toString(), tlvs,
    };
    const udp: UDPPacket = {
      type: 'udp', sourcePort: UDP_PORT_GLBP, destinationPort: UDP_PORT_GLBP,
      length: 8 + 16 + tlvs.length * 28, checksum: 0, payload,
    };
    const ipPkt: IPv4Packet = {
      type: 'ipv4', version: 4, ihl: 5, tos: 0xc0, totalLength: 20 + udp.length,
      identification: nextIPv4Id(), flags: 0, fragmentOffset: 0,
      ttl: 255, protocol: IP_PROTO_UDP, headerChecksum: 0,
      sourceIP: srcIp, destinationIP: new IPAddress(GLBP_MULTICAST_IP),
      payload: udp,
    };
    ipPkt.headerChecksum = computeIPv4Checksum(ipPkt);
    const eth: EthernetFrame = {
      srcMAC: port.getMAC(), dstMAC: new MACAddress(GLBP_MULTICAST_MAC),
      etherType: ETHERTYPE_IPV4, payload: ipPkt,
    };
    this.sendGuarded(g, eth);
    this.getBus().publish({
      topic: 'glbp.packet.sent',
      payload: {
        ...this.deviceRef(),
        iface: g.iface, group: g.group, avgState: g.avgState, priority: g.priority,
      },
    });
  }

  // ── AVG state machine ────────────────────────────────────────────
  protected recompute(g: GlbpGroupRuntime, reason: FhrpRecomputeReason): void {
    const oldState = g.avgState;
    const { myIp, linkUp } = this.linkContext(g);
    let newState: GlbpAvgState;
    if (!linkUp || !g.vip) {
      newState = 'init';
    } else if (!g.avgIp || g.avgIp === myIp) {
      newState = 'active';
    } else {
      const me = { priority: g.priority, ip: myIp };
      const avg = { priority: g.avgPriority, ip: g.avgIp };
      if (compareCandidate(me, avg) < 0 && (g.preempt || g.priority > g.avgPriority)) {
        newState = 'active';
      } else {
        newState = 'standby';
      }
    }
    g.avgState = newState;
    if (newState === 'active') {
      g.avgIp = myIp;
      g.avgPriority = g.priority;
      this.assignForwarderFor(g, myIp);
    }
    if (oldState !== newState) {
      g.lastTransitionMs = Date.now();
      this.getBus().publish({
        topic: 'glbp.avg.changed',
        payload: {
          ...this.deviceRef(),
          iface: g.iface, group: g.group,
          oldState, newState, reason,
        },
      });
      Logger.info(this.host.id, 'glbp:avg',
        `${this.host.name}: ${g.iface} grp ${g.group} ${oldState} → ${newState}`);
    }
  }

  private hashIp(ip: string): number {
    let h = 0;
    for (const part of ip.split('.')) h = ((h << 5) - h + parseInt(part, 10)) | 0;
    return Math.abs(h);
  }

  // ── AVG + AVF expiry ─────────────────────────────────────────────
  protected expireDue(): void {
    const now = Date.now();
    for (const g of this.config.groups.values()) {
      if (g.avgIp && g.avgState !== 'active' && now - g.lastHeardAvgMs > g.holdSec * 1000) {
        g.avgIp = null;
        g.avgPriority = 0;
        this.recompute(g, 'timeout');
      }
      for (const f of g.forwarders.values()) {
        const myIp = this.myIpFor(g);
        if (f.ownerIp !== myIp && now - f.lastHeardMs > g.holdSec * 1000) {
          if (f.state !== 'init') {
            const oldState = f.state;
            f.state = 'init';
            this.getBus().publish({
              topic: 'glbp.avf.state.changed',
              payload: {
                ...this.deviceRef(),
                iface: g.iface, group: g.group,
                forwarderNumber: f.forwarderNumber, oldState, newState: 'init',
              },
            });
          }
        }
      }
    }
  }
}

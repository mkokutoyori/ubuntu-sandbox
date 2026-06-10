import type { IEventBus } from '@/events/EventBus';
import { getDefaultScheduler, type IScheduler } from '@/events/Scheduler';
import { TimerSet } from '@/events/TimerSet';
import {
  type GlbpConfig, type GlbpGroupRuntime, type GlbpPacket,
  type GlbpAvgState, type GlbpForwarder, type GlbpLoadBalancing,
  type GlbpHelloTlv, type GlbpAssignTlv,
  createDefaultGlbpConfig, defaultGroupRuntime, makeKey,
  glbpVirtualMac, compareCandidate,
  UDP_PORT_GLBP, GLBP_MULTICAST_IP, GLBP_MULTICAST_MAC,
} from './types';
import {
  MACAddress, IPAddress,
  type EthernetFrame, type UDPPacket,
} from '../core/types';
import { buildUdpIpv4Frame } from '../core/packetBuilders';
import { Logger } from '../core/Logger';

const MAX_FORWARDERS = 4;

export interface GlbpHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getPort(name: string): import('../hardware/Port').Port | undefined;
  getPorts(): import('../hardware/Port').Port[];
  sendFrame(portName: string, frame: EthernetFrame): void;
}

export class GlbpAgent {
  private config: GlbpConfig = createDefaultGlbpConfig();
  private readonly emitting = new Set<string>();
  private readonly timers: TimerSet;
  private helloTimer: symbol | null = null;
  private expiryTimer: symbol | null = null;
  private unsubscribers: Array<() => void> = [];
  private running = false;

  constructor(
    private readonly host: GlbpHost,
    private readonly getBus: () => IEventBus,
    private readonly getScheduler: () => IScheduler = () => getDefaultScheduler(),
  ) {
    this.timers = new TimerSet(this.getScheduler);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.installSubscribers();
    if (this.config.enabled) this.startTimers();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
    this.stopTimers();
  }

  getConfig(): Readonly<GlbpConfig> { return this.config; }

  getGroup(iface: string, group: number): GlbpGroupRuntime | undefined {
    return this.config.groups.get(makeKey(iface, group));
  }

  listGroups(): GlbpGroupRuntime[] {
    return Array.from(this.config.groups.values())
      .sort((a, b) => a.iface === b.iface ? a.group - b.group : a.iface.localeCompare(b.iface));
  }

  ensureGroup(iface: string, group: number): GlbpGroupRuntime {
    const k = makeKey(iface, group);
    let g = this.config.groups.get(k);
    if (!g) {
      g = defaultGroupRuntime(iface, group);
      this.config.groups.set(k, g);
    }
    return g;
  }

  removeGroup(iface: string, group: number): void {
    this.config.groups.delete(makeKey(iface, group));
  }

  setVip(iface: string, group: number, vip: string): void {
    const g = this.ensureGroup(iface, group);
    g.vip = vip;
    this.recompute(g, 'config');
    if (this.shouldEmit(g)) this.advertise(g);
  }

  setPriority(iface: string, group: number, priority: number): void {
    const g = this.ensureGroup(iface, group);
    g.priority = priority;
    this.recompute(g, 'priority');
    if (this.shouldEmit(g)) this.advertise(g);
  }

  setPreempt(iface: string, group: number, on: boolean): void {
    const g = this.ensureGroup(iface, group);
    g.preempt = on;
    this.recompute(g, 'preempt');
  }

  setWeighting(iface: string, group: number, weighting: number): void {
    const g = this.ensureGroup(iface, group);
    g.weighting = weighting;
    const myIp = this.myIpFor(g);
    const own = [...g.forwarders.values()].find(f => f.ownerIp === myIp);
    if (own) own.weighting = weighting;
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
    if (this.running) {
      this.stopTimers();
      this.startTimers();
    }
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
        deviceId: this.host.id, hostname: this.host.getHostname(),
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
            deviceId: this.host.id, hostname: this.host.getHostname(),
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
    const f: GlbpForwarder = {
      forwarderNumber: n, vmac, ownerIp,
      priority: 100, weighting: 100,
      state: 'listen', lastHeardMs: Date.now(),
    };
    g.forwarders.set(n, f);
    const myIp = this.myIpFor(g);
    if (ownerIp === myIp) f.state = 'active';
    this.getBus().publish({
      topic: 'glbp.avf.assigned',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        iface: g.iface, group: g.group,
        forwarderNumber: n, vmac, ownerIp,
      },
    });
  }

  private myIpFor(g: GlbpGroupRuntime): string {
    const port = this.host.getPort(g.iface);
    return port?.getIPAddress()?.toString() ?? '0.0.0.0';
  }

  private shouldEmit(g: GlbpGroupRuntime): boolean {
    if (!this.config.enabled) return false;
    if (!g.vip) return false;
    const port = this.host.getPort(g.iface);
    if (!port || !port.getIsUp() || !port.isConnected()) return false;
    return g.avgState === 'active' || g.avgState === 'standby' || g.avgState === 'speak' || g.avgState === 'listen';
  }

  private maybeAdvertiseBack(g: GlbpGroupRuntime): void {
    if (this.emitting.has(makeKey(g.iface, g.group))) return;
    if (this.shouldEmit(g)) this.advertise(g);
  }

  private advertise(g: GlbpGroupRuntime): void {
    const port = this.host.getPort(g.iface);
    if (!port) return;
    const srcIp = port.getIPAddress();
    if (!srcIp) return;
    const tlvs: GlbpPacket['tlvs'] = [{
      type: 'hello',
      priority: g.priority,
      weighting: g.weighting,
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
    const eth = buildUdpIpv4Frame({
      srcIp, dstIp: new IPAddress(GLBP_MULTICAST_IP),
      srcMac: port.getMAC(), dstMac: new MACAddress(GLBP_MULTICAST_MAC),
      srcPort: UDP_PORT_GLBP, dstPort: UDP_PORT_GLBP,
      payload, payloadLength: 16 + tlvs.length * 28,
      ttl: 255, options: { tos: 0xc0, flags: 0 },
    });
    const key = makeKey(g.iface, g.group);
    if (this.emitting.has(key)) return;
    this.emitting.add(key);
    try { this.host.sendFrame(g.iface, eth); }
    finally { this.emitting.delete(key); }
    this.getBus().publish({
      topic: 'glbp.packet.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        iface: g.iface, group: g.group, avgState: g.avgState, priority: g.priority,
      },
    });
  }

  private recompute(g: GlbpGroupRuntime, reason: 'config' | 'peer' | 'timeout' | 'priority' | 'preempt'): void {
    const oldState = g.avgState;
    const port = this.host.getPort(g.iface);
    const myIp = port?.getIPAddress()?.toString() ?? '0.0.0.0';
    const linkUp = !!port && port.getIsUp() && port.isConnected();
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
          deviceId: this.host.id, hostname: this.host.getHostname(),
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

  private startTimers(): void {
    if (this.helloTimer === null) {
      this.helloTimer = this.timers.setInterval(() => {
        for (const g of this.config.groups.values()) {
          if (this.shouldEmit(g)) this.advertise(g);
        }
      }, 3000);
    }
    if (this.expiryTimer === null) {
      this.expiryTimer = this.timers.setInterval(() => this.expireDue(), 1000);
    }
  }

  private stopTimers(): void {
    this.timers.clear(this.helloTimer); this.helloTimer = null;
    this.timers.clear(this.expiryTimer); this.expiryTimer = null;
  }

  private expireDue(): void {
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
                deviceId: this.host.id, hostname: this.host.getHostname(),
                iface: g.iface, group: g.group,
                forwarderNumber: f.forwarderNumber, oldState, newState: 'init',
              },
            });
          }
        }
      }
    }
  }

  private installSubscribers(): void {
    const bus = this.getBus();
    this.unsubscribers.push(bus.subscribeWhere(
      'port.link.up',
      (p) => p.deviceId === this.host.id,
      (e) => this.onLinkUp(e.payload.portName),
    ));
    this.unsubscribers.push(bus.subscribeWhere(
      'port.link.down',
      (p) => p.deviceId === this.host.id,
      (e) => this.onLinkDown(e.payload.portName),
    ));
  }

  private onLinkUp(portName: string): void {
    for (const g of this.config.groups.values()) {
      if (g.iface !== portName) continue;
      this.recompute(g, 'config');
      if (this.shouldEmit(g)) this.advertise(g);
    }
  }

  private onLinkDown(portName: string): void {
    for (const g of this.config.groups.values()) {
      if (g.iface !== portName) continue;
      g.avgIp = null;
      this.recompute(g, 'timeout');
    }
  }
}

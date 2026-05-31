import type { IEventBus } from '@/events/EventBus';
import { getDefaultScheduler, type IScheduler, type TimerHandle } from '@/events/Scheduler';
import {
  type VrrpConfig, type VrrpGroupRuntime, type VrrpPacket, type VrrpState,
  createDefaultVrrpConfig, defaultGroupRuntime, makeKey,
  compareCandidate, masterDownIntervalMs,
  IP_PROTO_VRRP, VRRP_MULTICAST_IP, VRRP_MULTICAST_MAC,
} from './types';
import {
  MACAddress, IPAddress,
  type EthernetFrame, type IPv4Packet,
  ETHERTYPE_IPV4, nextIPv4Id, computeIPv4Checksum,
} from '../core/types';
import { Logger } from '../core/Logger';

export interface VrrpHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getPort(name: string): import('../hardware/Port').Port | undefined;
  getPorts(): import('../hardware/Port').Port[];
  sendFrame(portName: string, frame: EthernetFrame): void;
}

export class VrrpAgent {
  private config: VrrpConfig = createDefaultVrrpConfig();
  private readonly emitting = new Set<string>();
  private adTimer: TimerHandle | null = null;
  private expiryTimer: TimerHandle | null = null;
  private scheduler: IScheduler | null = null;
  private unsubscribers: Array<() => void> = [];
  private running = false;

  constructor(
    private readonly host: VrrpHost,
    private readonly getBus: () => IEventBus,
    private readonly getScheduler: () => IScheduler = () => getDefaultScheduler(),
  ) {}

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

  getConfig(): Readonly<VrrpConfig> { return this.config; }

  getGroup(iface: string, vrid: number): VrrpGroupRuntime | undefined {
    return this.config.groups.get(makeKey(iface, vrid));
  }

  listGroups(): VrrpGroupRuntime[] {
    return Array.from(this.config.groups.values())
      .sort((a, b) => a.iface === b.iface ? a.vrid - b.vrid : a.iface.localeCompare(b.iface));
  }

  ensureGroup(iface: string, vrid: number): VrrpGroupRuntime {
    const k = makeKey(iface, vrid);
    let g = this.config.groups.get(k);
    if (!g) {
      g = defaultGroupRuntime(iface, vrid);
      this.config.groups.set(k, g);
    }
    return g;
  }

  removeGroup(iface: string, vrid: number): void {
    this.config.groups.delete(makeKey(iface, vrid));
  }

  setVip(iface: string, vrid: number, vip: string): void {
    const g = this.ensureGroup(iface, vrid);
    g.vip = vip;
    this.recompute(g, 'config');
    if (this.shouldEmit(g)) this.advertise(g);
  }

  setPriority(iface: string, vrid: number, priority: number): void {
    const g = this.ensureGroup(iface, vrid);
    g.priority = priority;
    this.recompute(g, 'priority');
    if (this.shouldEmit(g)) this.advertise(g);
  }

  setPreempt(iface: string, vrid: number, on: boolean): void {
    const g = this.ensureGroup(iface, vrid);
    g.preempt = on;
    this.recompute(g, 'preempt');
  }

  setAdvertiseSec(iface: string, vrid: number, sec: number): void {
    const g = this.ensureGroup(iface, vrid);
    g.advertiseSec = sec;
    if (this.running) {
      this.stopTimers();
      this.startTimers();
    }
  }

  handleIp(inPort: string, srcIp: IPAddress, ipPkt: IPv4Packet): void {
    if (!this.config.enabled) return;
    if (ipPkt.protocol !== IP_PROTO_VRRP) return;
    const payload = ipPkt.payload as VrrpPacket | undefined;
    if (!payload || payload.type !== 'vrrp') return;
    const g = this.config.groups.get(makeKey(inPort, payload.vrid));
    if (!g) return;
    if (g.vip && payload.vips.length > 0 && !payload.vips.includes(g.vip)) return;

    this.getBus().publish({
      topic: 'vrrp.packet.received',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        iface: inPort, vrid: g.vrid,
        fromIp: payload.senderIp, fromPriority: payload.priority,
      },
    });

    const oldMasterIp = g.masterIp;
    g.masterIp = payload.senderIp;
    g.masterPriority = payload.priority;
    g.lastHeardMasterMs = Date.now();

    if (oldMasterIp !== g.masterIp) {
      this.getBus().publish({
        topic: 'vrrp.master.changed',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          iface: inPort, vrid: g.vrid,
          masterIp: g.masterIp, masterPriority: g.masterPriority,
        },
      });
    }
    this.recompute(g, 'peer');
    this.maybeAdvertiseBack(g);
  }

  private shouldEmit(g: VrrpGroupRuntime): boolean {
    if (!this.config.enabled) return false;
    if (!g.vip) return false;
    const port = this.host.getPort(g.iface);
    if (!port || !port.getIsUp() || !port.isConnected()) return false;
    return g.state === 'master';
  }

  private maybeAdvertiseBack(g: VrrpGroupRuntime): void {
    if (this.emitting.has(makeKey(g.iface, g.vrid))) return;
    if (this.shouldEmit(g)) this.advertise(g);
  }

  private advertise(g: VrrpGroupRuntime): void {
    const port = this.host.getPort(g.iface);
    if (!port) return;
    const srcIp = port.getIPAddress();
    if (!srcIp) return;
    const payload: VrrpPacket = {
      type: 'vrrp', version: 2, vrid: g.vrid,
      priority: g.priority, advertiseSec: g.advertiseSec,
      vips: g.vip ? [g.vip] : [],
      senderIp: srcIp.toString(),
    };
    const ipPkt: IPv4Packet = {
      type: 'ipv4', version: 4, ihl: 5, tos: 0xc0, totalLength: 20 + 8 + g.vip ? 4 : 0,
      identification: nextIPv4Id(), flags: 0, fragmentOffset: 0,
      ttl: 255, protocol: IP_PROTO_VRRP, headerChecksum: 0,
      sourceIP: srcIp, destinationIP: new IPAddress(VRRP_MULTICAST_IP),
      payload,
    };
    ipPkt.headerChecksum = computeIPv4Checksum(ipPkt);
    const eth: EthernetFrame = {
      srcMAC: port.getMAC(), dstMAC: new MACAddress(VRRP_MULTICAST_MAC),
      etherType: ETHERTYPE_IPV4, payload: ipPkt,
    };
    const key = makeKey(g.iface, g.vrid);
    if (this.emitting.has(key)) return;
    this.emitting.add(key);
    try { this.host.sendFrame(g.iface, eth); }
    finally { this.emitting.delete(key); }
    this.getBus().publish({
      topic: 'vrrp.packet.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        iface: g.iface, vrid: g.vrid, state: g.state, priority: g.priority,
      },
    });
  }

  private recompute(g: VrrpGroupRuntime, reason: 'config' | 'peer' | 'timeout' | 'priority' | 'preempt'): void {
    const oldState = g.state;
    const port = this.host.getPort(g.iface);
    const myIp = port?.getIPAddress()?.toString() ?? '0.0.0.0';
    const linkUp = !!port && port.getIsUp() && port.isConnected();
    const newState: VrrpState = (() => {
      if (!linkUp || !g.vip) return 'init';
      if (!g.masterIp || g.masterIp === myIp) return 'master';
      const me = { priority: g.priority, ip: myIp };
      const master = { priority: g.masterPriority, ip: g.masterIp };
      if (compareCandidate(me, master) < 0) {
        if (g.preempt || g.priority === 255) return 'master';
        return 'backup';
      }
      return 'backup';
    })();
    g.state = newState;
    if (newState === 'master' && (g.masterIp === null || g.masterIp !== myIp)) {
      g.masterIp = myIp;
      g.masterPriority = g.priority;
    }
    if (oldState !== g.state) {
      g.lastTransitionMs = Date.now();
      this.getBus().publish({
        topic: 'vrrp.state.changed',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          iface: g.iface, vrid: g.vrid,
          oldState, newState: g.state, reason,
        },
      });
      Logger.info(this.host.id, 'vrrp:state',
        `${this.host.name}: ${g.iface} vrid ${g.vrid} ${oldState} → ${g.state}`);
    }
  }

  private startTimers(): void {
    const s = this.getScheduler();
    this.scheduler = s;
    if (this.adTimer === null) {
      this.adTimer = s.setInterval(() => {
        for (const g of this.config.groups.values()) {
          if (this.shouldEmit(g)) this.advertise(g);
        }
      }, 1000);
    }
    if (this.expiryTimer === null) {
      this.expiryTimer = s.setInterval(() => this.expireDue(), 250);
    }
  }

  private stopTimers(): void {
    const s = this.scheduler ?? this.getScheduler();
    if (this.adTimer !== null) { s.clear(this.adTimer); this.adTimer = null; }
    if (this.expiryTimer !== null) { s.clear(this.expiryTimer); this.expiryTimer = null; }
  }

  private expireDue(): void {
    const now = Date.now();
    for (const g of this.config.groups.values()) {
      if (g.state !== 'backup') continue;
      if (!g.masterIp) continue;
      const downMs = masterDownIntervalMs(g.advertiseSec, g.priority);
      if (now - g.lastHeardMasterMs > downMs) {
        g.masterIp = null;
        g.masterPriority = 0;
        this.recompute(g, 'timeout');
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
      g.masterIp = null;
      this.recompute(g, 'timeout');
    }
  }
}

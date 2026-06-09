import type { IEventBus } from '@/events/EventBus';
import { getDefaultScheduler, type IScheduler, type TimerHandle } from '@/events/Scheduler';
import {
  type HsrpConfig, type HsrpGroupRuntime, type HsrpPacket, type HsrpState,
  createDefaultHsrpConfig, defaultGroupRuntime, makeKey, compareSpeaker,
  effectivePriority, hsrpMaxGroup,
  UDP_PORT_HSRP, HSRP_MULTICAST_V1, HSRP_MULTICAST_V2,
} from './types';
import {
  MACAddress, IPAddress,
  type EthernetFrame, type IPv4Packet, type UDPPacket,
  IP_PROTO_UDP, ETHERTYPE_IPV4, nextIPv4Id, computeIPv4Checksum,
} from '../core/types';
import { Logger } from '../core/Logger';

export interface HsrpHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getPort(name: string): import('../hardware/Port').Port | undefined;
  getPorts(): import('../hardware/Port').Port[];
  sendFrame(portName: string, frame: EthernetFrame): void;
}

export class HsrpAgent {
  private config: HsrpConfig = createDefaultHsrpConfig();
  private readonly emitting = new Set<string>();
  private helloTimer: TimerHandle | null = null;
  private expiryTimer: TimerHandle | null = null;
  private scheduler: IScheduler | null = null;
  private unsubscribers: Array<() => void> = [];
  private running = false;

  constructor(
    private readonly host: HsrpHost,
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

  getConfig(): Readonly<HsrpConfig> { return this.config; }

  getGroup(iface: string, group: number): HsrpGroupRuntime | undefined {
    return this.config.groups.get(makeKey(iface, group));
  }

  listGroups(): HsrpGroupRuntime[] {
    return Array.from(this.config.groups.values())
      .sort((a, b) => a.iface === b.iface ? a.group - b.group : a.iface.localeCompare(b.iface));
  }

  /**
   * Look up or create a group runtime. `version` only (re)assigns the HSRP
   * version when explicitly provided — internal setters that omit it must
   * not silently downgrade an existing v2 group back to v1.
   */
  ensureGroup(iface: string, group: number, version?: 1 | 2): HsrpGroupRuntime {
    const k = makeKey(iface, group);
    let g = this.config.groups.get(k);
    const effectiveVersion = version ?? g?.version ?? 1;
    const max = hsrpMaxGroup(effectiveVersion);
    if (!Number.isInteger(group) || group < 0 || group > max) {
      throw new RangeError(
        `HSRP version ${effectiveVersion} group ${group} is out of range (0-${max})`);
    }
    if (!g) {
      g = defaultGroupRuntime(iface, group, effectiveVersion);
      this.config.groups.set(k, g);
    } else if (version !== undefined && g.version !== version) {
      g.version = version;
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
    if (this.shouldEmit(g)) this.advertise(g);
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
    if (this.shouldEmit(g)) this.advertise(g);
  }

  removeTrack(iface: string, group: number, target: string): void {
    const g = this.config.groups.get(makeKey(iface, group));
    if (!g) return;
    const idx = g.tracks.findIndex((t) => t.target === target);
    if (idx < 0) return;
    g.tracks.splice(idx, 1);
    this.recompute(g, 'priority');
    if (this.shouldEmit(g)) this.advertise(g);
  }

  setVersion(iface: string, version: 1 | 2): void {
    for (const g of this.config.groups.values()) {
      if (g.iface === iface) g.version = version;
    }
  }

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
        deviceId: this.host.id, hostname: this.host.getHostname(),
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
      this.getBus().publish({
        topic: 'hsrp.active.changed',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          iface: inPort, group: g.group,
          activeIp: g.activeRouterIp, activePriority: g.activeRouterPriority,
        },
      });
    }
    this.recompute(g, 'peer');
    this.maybeAdvertiseBack(g);
  }

  private shouldEmit(g: HsrpGroupRuntime): boolean {
    if (!this.config.enabled) return false;
    if (!g.vip) return false;
    const port = this.host.getPort(g.iface);
    if (!port || !port.getIsUp() || !port.isConnected()) return false;
    return g.state === 'active' || g.state === 'standby' || g.state === 'speak';
  }

  private maybeAdvertiseBack(g: HsrpGroupRuntime): void {
    if (this.emitting.has(makeKey(g.iface, g.group))) return;
    if (this.shouldEmit(g)) this.advertise(g);
  }

  private advertise(g: HsrpGroupRuntime): void {
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
    const dstMac = multicastMacFor(dstIp);
    const eth: EthernetFrame = {
      srcMAC: port.getMAC(), dstMAC: dstMac,
      etherType: ETHERTYPE_IPV4, payload: ipPkt,
    };
    const key = makeKey(g.iface, g.group);
    if (this.emitting.has(key)) return;
    this.emitting.add(key);
    try { this.host.sendFrame(g.iface, eth); }
    finally { this.emitting.delete(key); }
    this.getBus().publish({
      topic: 'hsrp.packet.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        iface: g.iface, group: g.group, opcode, state: g.state, priority: effectivePriority(g),
      },
    });
  }

  private recompute(g: HsrpGroupRuntime, reason: 'config' | 'peer' | 'timeout' | 'priority' | 'preempt'): void {
    const oldState = g.state;
    const oldActiveIp = g.activeRouterIp;
    const port = this.host.getPort(g.iface);
    const myIp = port?.getIPAddress()?.toString() ?? `0.0.0.0`;
    const linkUp = !!port && port.getIsUp() && port.isConnected();

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
          deviceId: this.host.id, hostname: this.host.getHostname(),
          iface: g.iface, group: g.group,
          oldState, newState: g.state, reason,
        },
      });
      Logger.info(this.host.id, 'hsrp:state',
        `${this.host.name}: ${g.iface} grp ${g.group} ${oldState} → ${g.state}`);
    }
    if (oldActiveIp !== g.activeRouterIp) {
      this.getBus().publish({
        topic: 'hsrp.active.changed',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          iface: g.iface, group: g.group,
          activeIp: g.activeRouterIp, activePriority: g.activeRouterPriority,
        },
      });
    }
  }

  private startTimers(): void {
    const s = this.getScheduler();
    this.scheduler = s;
    if (this.helloTimer === null) {
      this.helloTimer = s.setInterval(() => {
        for (const g of this.config.groups.values()) {
          if (this.shouldEmit(g)) this.advertise(g);
        }
      }, 3000);
    }
    if (this.expiryTimer === null) {
      this.expiryTimer = s.setInterval(() => this.expireDue(), 1000);
    }
  }

  private stopTimers(): void {
    const s = this.scheduler ?? this.getScheduler();
    if (this.helloTimer !== null) { s.clear(this.helloTimer); this.helloTimer = null; }
    if (this.expiryTimer !== null) { s.clear(this.expiryTimer); this.expiryTimer = null; }
  }

  private expireDue(): void {
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
      if (touched && this.shouldEmit(g)) this.advertise(g);
    }
  }

  private onLinkDown(portName: string): void {
    for (const g of this.config.groups.values()) {
      let touched = false;
      for (const t of g.tracks) {
        if (t.target === portName && !t.down) { t.down = true; touched = true; }
      }
      if (g.iface === portName) {
        g.activeRouterIp = null;
        g.standbyRouterIp = null;
        this.recompute(g, 'timeout');
        touched = true;
      } else if (touched) {
        this.recompute(g, 'priority');
      }
      if (touched && this.shouldEmit(g)) this.advertise(g);
    }
  }
}

function multicastMacFor(ip: IPAddress): MACAddress {
  const octets = ip.getOctets();
  return new MACAddress([0x01, 0x00, 0x5e, octets[1] & 0x7f, octets[2], octets[3]]);
}

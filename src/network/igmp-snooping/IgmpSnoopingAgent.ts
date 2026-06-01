import type { IEventBus } from '@/events/EventBus';
import { getDefaultScheduler, type IScheduler, type TimerHandle } from '@/events/Scheduler';
import {
  type SnoopingConfig, type SnoopingVlanState, type SnoopingGroup,
  createDefaultSnoopingConfig, defaultVlanState,
} from './types';
import {
  IP_PROTO_IGMP, isReservedMulticast, isMulticastIpv4,
  type IgmpPacket,
} from '../igmp/types';
import {
  type EthernetFrame, type IPv4Packet,
} from '../core/types';
import { Logger } from '../core/Logger';

export interface IgmpSnoopingHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getPort(name: string): import('../hardware/Port').Port | undefined;
  getPorts(): import('../hardware/Port').Port[];
  resolveIngressVlan(portName: string): number | undefined;
  isTrunkPort(portName: string): boolean;
}

export class IgmpSnoopingAgent {
  private config: SnoopingConfig = createDefaultSnoopingConfig();
  private expiryTimer: TimerHandle | null = null;
  private scheduler: IScheduler | null = null;
  private unsubscribers: Array<() => void> = [];
  private running = false;

  constructor(
    private readonly host: IgmpSnoopingHost,
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

  getConfig(): Readonly<SnoopingConfig> { return this.config; }

  setEnabled(on: boolean): void {
    if (this.config.enabled === on) return;
    this.config.enabled = on;
    if (on) this.startTimers();
    else this.stopTimers();
  }

  setVlanEnabled(vlan: number, on: boolean): void {
    const v = this.ensureVlan(vlan);
    v.enabled = on;
    if (!on) {
      for (const [k, g] of v.groups) {
        for (const m of g.members.values()) {
          this.emitLeft(v.vlan, g.groupAddress, m.port, 'config');
        }
        v.groups.delete(k);
      }
      for (const p of [...v.routerPorts]) {
        v.routerPorts.delete(p);
        this.emitRouterPort(v.vlan, p, false);
      }
    }
  }

  setImmediateLeave(vlan: number, on: boolean): void {
    if (on) this.config.immediateLeave.add(vlan);
    else this.config.immediateLeave.delete(vlan);
  }

  getVlanState(vlan: number): SnoopingVlanState | undefined {
    return this.config.vlans.get(vlan);
  }

  listVlans(): SnoopingVlanState[] {
    return Array.from(this.config.vlans.values()).sort((a, b) => a.vlan - b.vlan);
  }

  listGroups(vlan?: number): Array<{ vlan: number; group: SnoopingGroup }> {
    const out: Array<{ vlan: number; group: SnoopingGroup }> = [];
    for (const v of this.config.vlans.values()) {
      if (vlan !== undefined && v.vlan !== vlan) continue;
      for (const g of v.groups.values()) out.push({ vlan: v.vlan, group: g });
    }
    return out.sort((a, b) =>
      a.vlan === b.vlan ? a.group.groupAddress.localeCompare(b.group.groupAddress) : a.vlan - b.vlan);
  }

  computeEgressPorts(ingressPort: string, groupAddress: string): string[] {
    const vlan = this.host.resolveIngressVlan(ingressPort);
    if (vlan === undefined) return [];
    if (!this.config.enabled) return [];
    const v = this.config.vlans.get(vlan);
    if (!v || !v.enabled) return [];
    const g = v.groups.get(groupAddress);
    const memberPorts = g ? Array.from(g.members.keys()) : [];
    const routerPorts = Array.from(v.routerPorts);
    const union = new Set<string>([...memberPorts, ...routerPorts]);
    union.delete(ingressPort);
    return Array.from(union);
  }

  handleFrame(portName: string, frame: EthernetFrame): boolean {
    if (!this.config.enabled) return false;
    if (frame.etherType !== 0x0800) return false;
    const ipPkt = frame.payload as IPv4Packet | undefined;
    if (!ipPkt || ipPkt.protocol !== IP_PROTO_IGMP) return false;
    const payload = ipPkt.payload as IgmpPacket | undefined;
    if (!payload || payload.type !== 'igmp') return false;
    const vlan = this.host.resolveIngressVlan(portName);
    if (vlan === undefined) return false;
    const v = this.ensureVlan(vlan);
    if (!v.enabled) return false;

    const senderIp = ipPkt.sourceIP.toString();
    switch (payload.messageType) {
      case 'membership-query':
        this.onQuery(v, portName, senderIp);
        break;
      case 'v1-membership-report':
      case 'v2-membership-report':
        this.onReport(v, portName, payload.groupAddress, senderIp);
        break;
      case 'leave-group':
        this.onLeave(v, portName, payload.groupAddress);
        break;
    }
    return false;
  }

  private onQuery(v: SnoopingVlanState, port: string, senderIp: string): void {
    v.querierIp = senderIp;
    v.lastQuerierMs = Date.now();
    if (!v.routerPorts.has(port)) {
      v.routerPorts.add(port);
      this.emitRouterPort(v.vlan, port, true);
    }
  }

  private onReport(v: SnoopingVlanState, port: string, group: string, reporterIp: string): void {
    if (!isMulticastIpv4(group) || isReservedMulticast(group)) return;
    let g = v.groups.get(group);
    if (!g) {
      g = { vlan: v.vlan, groupAddress: group, members: new Map() };
      v.groups.set(group, g);
    }
    const had = g.members.has(port);
    g.members.set(port, { port, reporterIp, lastReportMs: Date.now() });
    if (!had) {
      this.getBus().publish({
        topic: 'igmp.snooping.member.joined',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          vlan: v.vlan, groupAddress: group, port, reporterIp,
        },
      });
      Logger.info(this.host.id, 'igmp-snooping:join',
        `${this.host.name}: vlan ${v.vlan} ${port} joined ${group}`);
    }
  }

  private onLeave(v: SnoopingVlanState, port: string, group: string): void {
    const g = v.groups.get(group);
    if (!g) return;
    if (this.config.immediateLeave.has(v.vlan)) {
      if (g.members.delete(port)) this.emitLeft(v.vlan, group, port, 'leave');
      if (g.members.size === 0) v.groups.delete(group);
      return;
    }
    const m = g.members.get(port);
    if (m) m.lastReportMs = Date.now() - this.config.groupMembershipSec * 1000;
  }

  private emitLeft(vlan: number, group: string, port: string, reason: 'leave' | 'timeout' | 'config' | 'link'): void {
    this.getBus().publish({
      topic: 'igmp.snooping.member.left',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        vlan, groupAddress: group, port, reason,
      },
    });
  }

  private emitRouterPort(vlan: number, port: string, added: boolean): void {
    this.getBus().publish({
      topic: 'igmp.snooping.router-port.changed',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        vlan, port, added,
      },
    });
  }

  private ensureVlan(vlan: number): SnoopingVlanState {
    let v = this.config.vlans.get(vlan);
    if (!v) {
      v = defaultVlanState(vlan);
      v.enabled = this.config.perVlanDefault;
      this.config.vlans.set(vlan, v);
    }
    return v;
  }

  private startTimers(): void {
    const s = this.getScheduler();
    this.scheduler = s;
    if (this.expiryTimer === null) {
      this.expiryTimer = s.setInterval(() => this.expireDue(), 1000);
    }
  }

  private stopTimers(): void {
    const s = this.scheduler ?? this.getScheduler();
    if (this.expiryTimer !== null) { s.clear(this.expiryTimer); this.expiryTimer = null; }
  }

  private expireDue(): void {
    const now = Date.now();
    for (const v of this.config.vlans.values()) {
      for (const [gk, g] of v.groups) {
        const stale: string[] = [];
        for (const m of g.members.values()) {
          if (now - m.lastReportMs > this.config.groupMembershipSec * 1000) stale.push(m.port);
        }
        for (const p of stale) {
          g.members.delete(p);
          this.emitLeft(v.vlan, g.groupAddress, p, 'timeout');
        }
        if (g.members.size === 0) v.groups.delete(gk);
      }
      if (v.lastQuerierMs > 0 && now - v.lastQuerierMs > this.config.routerPortAgeSec * 1000) {
        for (const p of [...v.routerPorts]) {
          v.routerPorts.delete(p);
          this.emitRouterPort(v.vlan, p, false);
        }
        v.querierIp = null;
        v.lastQuerierMs = 0;
      }
    }
  }

  private installSubscribers(): void {
    const bus = this.getBus();
    this.unsubscribers.push(bus.subscribeWhere(
      'port.link.down',
      (p) => p.deviceId === this.host.id,
      (e) => this.onLinkDown(e.payload.portName),
    ));
  }

  private onLinkDown(portName: string): void {
    for (const v of this.config.vlans.values()) {
      if (v.routerPorts.delete(portName)) {
        this.emitRouterPort(v.vlan, portName, false);
      }
      for (const [gk, g] of v.groups) {
        if (g.members.delete(portName)) {
          this.emitLeft(v.vlan, g.groupAddress, portName, 'link');
        }
        if (g.members.size === 0) v.groups.delete(gk);
      }
    }
  }
}

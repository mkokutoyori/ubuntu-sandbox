import type { IEventBus } from '@/events/EventBus';
import { getDefaultScheduler, type IScheduler } from '@/events/Scheduler';
import { ReactiveAgentBase } from '../core/ReactiveAgentBase';
import {
  type SnoopingConfig, type SnoopingVlanState, type SnoopingGroup,
  createDefaultSnoopingConfig, defaultVlanState,
} from './types';
import {
  IP_PROTO_IGMP, isReservedMulticast, isMulticastIpv4, compareQuerier,
  IGMP_ALL_SYSTEMS, type IgmpPacket,
} from '../igmp/types';
import { igmpSendRequest, igmpQuery } from '../igmp/frames';
import {
  buildIpv4Packet, linkDestinationFor,
} from '../layers/internet/Ipv4Egress';
import {
  IPAddress,
  type EthernetFrame, type IPv4Packet, ETHERTYPE_IPV4 } from '../core/types';
import type { LinkSendRequest } from '../layers/link/LinkLayer';
import { Logger } from '../core/Logger';

export interface IgmpSnoopingHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getPort(name: string): import('../hardware/Port').Port | undefined;
  getPorts(): import('../hardware/Port').Port[];
  sendOnLink(request: LinkSendRequest): boolean;
  resolveIngressVlan(portName: string): number | undefined;
  isTrunkPort(portName: string): boolean;
  /** SVI address of the VLAN, used as the snooping querier's source IP. */
  getSviIp?(vlan: number): string | null;
  /** VLANs configured on the switch, so a global querier covers them all. */
  getVlanIds?(): number[];
}

export class IgmpSnoopingAgent extends ReactiveAgentBase {
  private config: SnoopingConfig = createDefaultSnoopingConfig();

  constructor(
    private readonly host: IgmpSnoopingHost,
    getBus: () => IEventBus,
    getScheduler: () => IScheduler = () => getDefaultScheduler(),
  ) {
    super(host, getBus, getScheduler);
  }

  getConfig(): Readonly<SnoopingConfig> { return this.config; }

  /** Protocol clock — same scheduler that drives the expiry timer. */
  nowMs(): number { return this.getScheduler().now(); }

  setEnabled(on: boolean): void {
    if (this.config.enabled === on) return;
    this.config.enabled = on;
    if (on) this.armTimers();
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
      return;
    }
    // Re-enabling reinstates the configured mrouter ports; the dynamically
    // learned ones have to be relearned from a fresh Query.
    for (const p of v.staticRouterPorts) {
      if (v.routerPorts.has(p)) continue;
      v.routerPorts.add(p);
      this.emitRouterPort(v.vlan, p, true);
    }
  }

  /**
   * `ip igmp snooping vlan <n> mrouter interface <port>` — pin a port as a
   * multicast-router port regardless of whether a Query was ever seen on it.
   */
  setStaticRouterPort(vlan: number, port: string, on: boolean): void {
    const v = this.ensureVlan(vlan);
    if (on) {
      if (v.staticRouterPorts.has(port)) return;
      v.staticRouterPorts.add(port);
      if (!v.routerPorts.has(port)) {
        v.routerPorts.add(port);
        this.emitRouterPort(vlan, port, true);
      }
      return;
    }
    if (!v.staticRouterPorts.delete(port)) return;
    if (v.routerPorts.delete(port)) this.emitRouterPort(vlan, port, false);
  }

  isStaticRouterPort(vlan: number, port: string): boolean {
    return this.config.vlans.get(vlan)?.staticRouterPorts.has(port) ?? false;
  }

  /**
   * `ip igmp snooping querier` — globally when `vlan` is null, otherwise
   * `ip igmp snooping vlan <n> querier`.
   */
  setQuerierEnabled(vlan: number | null, on: boolean): void {
    if (vlan !== null) {
      this.ensureVlan(vlan).querierEnabled = on;
      return;
    }
    this.config.querierEnabled = on;
    // A global querier covers every VLAN on the switch, including ones no
    // IGMP frame has been seen on yet.
    if (on) for (const v of this.host.getVlanIds?.() ?? []) this.ensureVlan(v);
  }

  /** `ip igmp snooping querier address <ip>`. */
  setQuerierAddress(ip: string | null): void {
    this.config.querierAddress = ip;
  }

  /** `ip igmp snooping querier query-interval <sec>`. */
  setQuerierInterval(seconds: number): void {
    this.config.querierIntervalSec = Math.max(1, seconds);
  }

  /**
   * Source address the switch would stamp on its own Queries for a VLAN,
   * or null when it has none — in which case IOS keeps the querier
   * administratively enabled but operationally down.
   */
  querierSourceIp(vlan: number): string | null {
    return this.config.querierAddress ?? this.host.getSviIp?.(vlan) ?? null;
  }

  /** Whether the switch is currently originating Queries on this VLAN. */
  isQuerierOperational(vlan: number): boolean {
    const v = this.config.vlans.get(vlan);
    return v !== undefined && this.querierActiveFor(v);
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
    v.lastQuerierMs = this.nowMs();
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
    g.members.set(port, { port, reporterIp, lastReportMs: this.nowMs() });
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
    if (m) m.lastReportMs = this.nowMs() - this.config.groupMembershipSec * 1000;
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

  protected isEnabled(): boolean { return this.config.enabled; }

  protected armTimers(): void {
    this.scheduleInterval('expiry', () => this.expireDue(), 1000);
    this.scheduleInterval('querier', () => this.querierTick(), 1000);
  }

  /**
   * Snooping-querier election (`ip igmp snooping querier`): a real
   * multicast router always wins, so the switch stays silent while it has
   * heard a Query from a lower address within the other-querier-present
   * window, exactly as `IgmpAgent` does between two routers.
   */
  private querierActiveFor(v: SnoopingVlanState): boolean {
    if (!this.config.enabled || !v.enabled) return false;
    if (!this.config.querierEnabled && !v.querierEnabled) return false;
    const mine = this.querierSourceIp(v.vlan);
    if (!mine) return false;
    if (v.querierIp !== null && v.querierIp !== mine) {
      const heardAgoMs = this.nowMs() - v.lastQuerierMs;
      if (heardAgoMs <= this.config.otherQuerierPresentSec * 1000
          && compareQuerier(v.querierIp, mine) < 0) {
        return false;
      }
    }
    return true;
  }

  private querierTick(): void {
    for (const v of this.config.vlans.values()) {
      if (!this.querierActiveFor(v)) continue;
      const now = this.nowMs();
      if (v.lastSelfQueryMs !== null
          && now - v.lastSelfQueryMs < this.config.querierIntervalSec * 1000) continue;
      v.lastSelfQueryMs = now;
      this.sendGeneralQuery(v);
    }
  }

  private sendGeneralQuery(v: SnoopingVlanState): void {
    const srcIp = this.querierSourceIp(v.vlan);
    if (!srcIp) return;
    const payload = igmpQuery('0.0.0.0', this.config.querierMaxRespTimeDs);
    const dst = new IPAddress(IGMP_ALL_SYSTEMS);
    let sentOn = 0;
    for (const port of this.host.getPorts()) {
      const name = port.getName();
      if (!port.getIsUp() || !port.isConnected()) continue;
      if (this.host.resolveIngressVlan(name) !== v.vlan) continue;
      const request = igmpSendRequest(name, new IPAddress(srcIp), dst, payload);
      const linkDestination = linkDestinationFor(dst);
      if (!linkDestination) continue;
      this.host.sendOnLink({
        iface: name,
        destination: linkDestination,
        etherType: ETHERTYPE_IPV4,
        payload: buildIpv4Packet(new IPAddress(srcIp), request),
      });
      sentOn++;
    }
    if (sentOn === 0) return;
    this.getBus().publish({
      topic: 'igmp.snooping.querier.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        vlan: v.vlan, sourceIp: srcIp, ports: sentOn,
      },
    });
    Logger.info(this.host.id, 'igmp-snooping:query',
      `${this.host.name}: vlan ${v.vlan} general query from ${srcIp} on ${sentOn} port(s)`);
  }

  private expireDue(): void {
    const now = this.nowMs();
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
      // `querierIp` — not `lastQuerierMs > 0` — is what says a Query was
      // ever observed: the very first Query can legitimately land at t = 0.
      if (v.querierIp !== null && now - v.lastQuerierMs > this.config.routerPortAgeSec * 1000) {
        for (const p of [...v.routerPorts]) {
          if (v.staticRouterPorts.has(p)) continue;
          v.routerPorts.delete(p);
          this.emitRouterPort(v.vlan, p, false);
        }
        v.querierIp = null;
        v.lastQuerierMs = 0;
      }
    }
  }

  protected override onPortLinkUp(portName: string): void {
    for (const v of this.config.vlans.values()) {
      if (!v.enabled || !v.staticRouterPorts.has(portName)) continue;
      if (v.routerPorts.has(portName)) continue;
      v.routerPorts.add(portName);
      this.emitRouterPort(v.vlan, portName, true);
    }
  }

  protected override onPortLinkDown(portName: string): void {
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

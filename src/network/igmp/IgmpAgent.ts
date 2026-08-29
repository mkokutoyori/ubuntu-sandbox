import type { IEventBus } from '@/events/EventBus';
import type { Ipv4SendRequest } from '../layers/internet/Ipv4Egress';
import { getDefaultScheduler, type IScheduler, type TimerHandle } from '@/events/Scheduler';
import {
  type IgmpConfig, type IgmpInterfaceRuntime, type IgmpGroupRecord,
  type IgmpPacket, type IgmpGroupOrigin,
  createDefaultIgmpConfig, defaultIfaceRuntime, makeGroupKey,
  groupMembershipIntervalSec, startupQueryIntervalSec,
  isMulticastIpv4, isReservedMulticast,
  isV1CompatActive, isConfiguredGroup,
  compareQuerier,
  IP_PROTO_IGMP, IGMP_ALL_SYSTEMS,
} from './types';
import { igmpSendRequest, igmpQuery, igmpReport, igmpDestination } from './frames';
import {
  IPAddress,
  type EthernetFrame, type IPv4Packet,
} from '../core/types';
import { Logger } from '../core/Logger';

export interface IgmpHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getPort(name: string): import('../hardware/Port').Port | undefined;
  getPorts(): import('../hardware/Port').Port[];
  sendFrame(portName: string, frame: EthernetFrame): void;
  sendIpv4Packet(request: Ipv4SendRequest): boolean;
}

export class IgmpAgent {
  private config: IgmpConfig = createDefaultIgmpConfig();
  private queryTimer: TimerHandle | null = null;
  private expiryTimer: TimerHandle | null = null;
  private scheduler: IScheduler | null = null;
  private unsubscribers: Array<() => void> = [];
  private running = false;

  constructor(
    private readonly host: IgmpHost,
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

  getConfig(): Readonly<IgmpConfig> { return this.config; }

  /**
   * Protocol clock. Every timestamp this agent records and compares comes
   * from the scheduler, so a virtual-time test advancing the scheduler
   * really does age memberships and compatibility timers.
   */
  nowMs(): number { return this.getScheduler().now(); }

  enableInterface(iface: string, version: 1 | 2 = 2): void {
    const rt = this.ensureIface(iface);
    rt.enabled = true;
    rt.version = version;
    rt.state = 'startup';
    rt.startupQueriesSent = 0;
    this.kickStartupQuery(rt);
    for (const [group, origin] of rt.configuredGroups) {
      this.materializeConfiguredGroup(rt, group, origin);
    }
  }

  disableInterface(iface: string): void {
    const rt = this.config.interfaces.get(iface);
    if (!rt) return;
    rt.enabled = false;
    for (const [k, g] of this.config.groups) {
      if (g.iface === iface) {
        this.config.groups.delete(k);
        this.publishGroupLeft(g, 'leave');
      }
    }
  }

  getInterfaceRuntime(iface: string): IgmpInterfaceRuntime | undefined {
    return this.config.interfaces.get(iface);
  }

  listGroups(): IgmpGroupRecord[] {
    return Array.from(this.config.groups.values())
      .sort((a, b) => a.iface === b.iface ? a.groupAddress.localeCompare(b.groupAddress) : a.iface.localeCompare(b.iface));
  }

  groupsFor(iface: string): IgmpGroupRecord[] {
    return this.listGroups().filter(g => g.iface === iface);
  }

  hasMember(iface: string, group: string): boolean {
    return this.config.groups.has(makeGroupKey(iface, group));
  }

  injectReport(iface: string, group: string, reporterIp: string): void {
    if (!isMulticastIpv4(group) || isReservedMulticast(group)) return;
    const rt = this.ensureIface(iface);
    if (!rt.enabled) return;
    this.recordMembership(rt, group, reporterIp);
  }

  /**
   * `ip igmp join-group` / `ip igmp static-group`: the router itself joins
   * the group on that interface. A join-group membership is a real one —
   * the router announces it with an unsolicited Membership Report, exactly
   * as a host would. A static-group is forwarding state only: no Report is
   * ever sent and the last reporter stays 0.0.0.0.
   */
  configuredJoin(iface: string, group: string, origin: Exclude<IgmpGroupOrigin, 'dynamic'>): boolean {
    if (!isMulticastIpv4(group) || isReservedMulticast(group)) return false;
    let rt = this.ensureIface(iface);
    if (!rt.enabled) {
      this.enableInterface(iface, rt.version);
      rt = this.ensureIface(iface);
    }
    rt.configuredGroups.set(group, origin);
    this.materializeConfiguredGroup(rt, group, origin);
    return true;
  }

  configuredLeave(iface: string, group: string, origin: Exclude<IgmpGroupOrigin, 'dynamic'>): boolean {
    const rt = this.config.interfaces.get(iface);
    if (!rt || rt.configuredGroups.get(group) !== origin) return false;
    rt.configuredGroups.delete(group);
    const k = makeGroupKey(iface, group);
    const rec = this.config.groups.get(k);
    if (rec) {
      this.config.groups.delete(k);
      this.publishGroupLeft(rec, 'leave');
    }
    return true;
  }

  listConfiguredGroups(iface: string): Array<{ group: string; origin: Exclude<IgmpGroupOrigin, 'dynamic'> }> {
    const rt = this.config.interfaces.get(iface);
    if (!rt) return [];
    return Array.from(rt.configuredGroups.entries())
      .map(([group, origin]) => ({ group, origin }))
      .sort((a, b) => a.group.localeCompare(b.group));
  }

  private materializeConfiguredGroup(
    rt: IgmpInterfaceRuntime, group: string, origin: Exclude<IgmpGroupOrigin, 'dynamic'>,
  ): void {
    const myIp = this.host.getPort(rt.iface)?.getIPAddress()?.toString() ?? '0.0.0.0';
    const reporterIp = origin === 'join-group' ? myIp : '0.0.0.0';
    this.recordMembership(rt, group, reporterIp, false, origin);
    if (origin === 'join-group') this.sendReport(rt, group);
  }

  handleIp(inPort: string, srcIp: IPAddress, ipPkt: IPv4Packet): void {
    // A stopped agent has no timers and must not answer on the wire
    // either, or a shut-down router keeps driving its peers' state.
    if (!this.running) return;
    if (!this.config.enabled) return;
    if (ipPkt.protocol !== IP_PROTO_IGMP) return;
    const payload = ipPkt.payload as IgmpPacket | undefined;
    if (!payload || payload.type !== 'igmp') return;
    const rt = this.config.interfaces.get(inPort);
    if (!rt || !rt.enabled) return;
    const senderIp = srcIp.toString();

    this.getBus().publish({
      topic: 'igmp.packet.received',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        iface: inPort,
        messageType: payload.messageType,
        groupAddress: payload.groupAddress,
        fromIp: senderIp,
      },
    });

    switch (payload.messageType) {
      case 'membership-query':
        this.onQuery(rt, senderIp);
        break;
      case 'v1-membership-report':
      case 'v2-membership-report':
        this.recordMembership(rt, payload.groupAddress, senderIp,
          payload.messageType === 'v1-membership-report');
        break;
      case 'leave-group':
        this.onLeave(rt, payload.groupAddress);
        break;
    }
  }

  private onQuery(rt: IgmpInterfaceRuntime, senderIp: string): void {
    const port = this.host.getPort(rt.iface);
    const myIp = port?.getIPAddress()?.toString() ?? '0.0.0.0';
    rt.lastQuerierMs = this.nowMs();
    if (rt.state === 'querier' || rt.state === 'startup') {
      if (compareQuerier(senderIp, myIp) < 0) {
        const oldState = rt.state;
        rt.state = 'non-querier';
        rt.querierIp = senderIp;
        this.publishQuerier(rt, oldState);
      } else if (senderIp !== myIp) {
        rt.querierIp = myIp;
      }
    } else if (rt.state === 'non-querier') {
      if (compareQuerier(senderIp, rt.querierIp ?? '255.255.255.255') < 0) {
        rt.querierIp = senderIp;
      }
    }
  }

  private recordMembership(
    rt: IgmpInterfaceRuntime, group: string, reporterIp: string,
    v1 = false, origin: IgmpGroupOrigin = 'dynamic',
  ): void {
    if (!isMulticastIpv4(group) || isReservedMulticast(group)) return;
    const k = makeGroupKey(rt.iface, group);
    const now = this.nowMs();
    // RFC 2236 §4: a v1 Report (re)arms the Version 1 Host Present timer
    // for one full Group Membership Interval.
    const v1Until = v1 ? now + groupMembershipIntervalSec(rt) * 1000 : null;
    const existing = this.config.groups.get(k);
    if (existing) {
      existing.reporters.add(reporterIp);
      existing.lastReporterIp = reporterIp;
      existing.lastReportMs = now;
      if (v1Until !== null) existing.v1CompatUntilMs = v1Until;
      if (origin !== 'dynamic') existing.origin = origin;
      return;
    }
    const rec: IgmpGroupRecord = {
      groupAddress: group, iface: rt.iface,
      reporters: new Set([reporterIp]),
      lastReporterIp: reporterIp,
      lastReportMs: now,
      v1CompatUntilMs: v1Until,
      origin,
    };
    this.config.groups.set(k, rec);
    this.getBus().publish({
      topic: 'igmp.group.joined',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        iface: rt.iface, groupAddress: group, reporterIp,
      },
    });
    Logger.info(this.host.id, 'igmp:join',
      `${this.host.name}: ${rt.iface} joined ${group} (reporter ${reporterIp})`);
  }

  private onLeave(rt: IgmpInterfaceRuntime, group: string): void {
    const k = makeGroupKey(rt.iface, group);
    const rec = this.config.groups.get(k);
    if (!rec) return;
    // RFC 2236 §4: while the Version 1 Host Present timer is running the
    // router must ignore Leave Group for that group — an IGMPv1 member is
    // known to be there and could never have sent this message itself.
    if (isV1CompatActive(rec, this.nowMs())) return;
    // A membership the operator configured is not a host's to withdraw.
    if (isConfiguredGroup(rec)) return;
    if (rt.state === 'querier' || rt.state === 'startup') {
      this.sendGroupSpecificQuery(rt, group);
    }
    this.config.groups.delete(k);
    this.publishGroupLeft(rec, 'leave');
  }

  private publishGroupLeft(rec: IgmpGroupRecord, reason: 'leave' | 'timeout'): void {
    this.getBus().publish({
      topic: 'igmp.group.left',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        iface: rec.iface, groupAddress: rec.groupAddress, reason,
      },
    });
    Logger.info(this.host.id, 'igmp:leave',
      `${this.host.name}: ${rec.iface} left ${rec.groupAddress} (${reason})`);
  }

  private publishQuerier(rt: IgmpInterfaceRuntime, oldState: typeof rt.state): void {
    this.getBus().publish({
      topic: 'igmp.querier.changed',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        iface: rt.iface, oldState, newState: rt.state,
        querierIp: rt.querierIp,
      },
    });
  }

  private kickStartupQuery(rt: IgmpInterfaceRuntime): void {
    if (rt.state === 'querier' || rt.state === 'startup') {
      this.sendGeneralQuery(rt);
    }
  }

  /**
   * RFC 2236 §7.1: a starting router sends `startupQueryCount` General
   * Queries one Startup Query Interval apart before it settles into the
   * querier role, then keeps querying every Query Interval. Both cadences
   * run off this one-second tick.
   */
  private queryTick(): void {
    const now = this.nowMs();
    for (const rt of this.config.interfaces.values()) {
      if (!rt.enabled) continue;
      if (!this.ifaceOperUp(rt)) continue;
      if (rt.state === 'non-querier') continue;
      const periodSec = rt.state === 'startup'
        ? startupQueryIntervalSec(rt)
        : rt.queryIntervalSec;
      if (rt.lastQuerySentMs !== null && now - rt.lastQuerySentMs < periodSec * 1000) continue;
      this.sendGeneralQuery(rt);
    }
  }

  private sendGeneralQuery(rt: IgmpInterfaceRuntime): void {
    rt.lastQuerySentMs = this.nowMs();
    this.sendQuery(rt, '0.0.0.0', IGMP_ALL_SYSTEMS, rt.queryResponseIntervalDs);
    if (rt.state === 'startup') {
      rt.startupQueriesSent++;
      if (rt.startupQueriesSent >= rt.startupQueryCount) {
        const oldState = rt.state;
        rt.state = 'querier';
        // We ARE the querier: the address is this interface's own. Left
        // null, the log read `Querier on Gi0/0 is ?` — a rendered `?` is
        // a value nobody resolved, not a fact.
        rt.querierIp = this.host.getPort(rt.iface)?.getIPAddress()?.toString() ?? null;
        this.publishQuerier(rt, oldState);
      }
    } else if (rt.state === 'non-querier') {
      const oldState = rt.state;
      rt.state = 'querier';
      rt.querierIp = this.host.getPort(rt.iface)?.getIPAddress()?.toString() ?? null;
      this.publishQuerier(rt, oldState);
    }
  }

  private sendGroupSpecificQuery(rt: IgmpInterfaceRuntime, group: string): void {
    // RFC 2236 §4: a Group-Specific Query is meaningless to an IGMPv1
    // member, which would never answer it — suppress it while the
    // Version 1 Host Present timer is running for this group.
    const rec = this.config.groups.get(makeGroupKey(rt.iface, group));
    if (rec && isV1CompatActive(rec, this.nowMs())) return;
    for (let i = 0; i < rt.lastMemberQueryCount; i++) {
      this.sendQuery(rt, group, group, rt.lastMemberQueryIntervalDs);
    }
  }

  /**
   * The one predicate saying an interface can carry IGMP at all. The send
   * sites already used it; the periodic tick did not, so the querier
   * state machine kept advancing on a dead link — after
   * `startupQueryCount` silent ticks it elected ITSELF and announced
   * `Querier on <iface> is …`, tens of seconds after the operator's last
   * command, on an interface reading down/down everywhere else. No
   * periodic work on an interface that is not up.
   */
  private ifaceOperUp(rt: IgmpInterfaceRuntime): boolean {
    const port = this.host.getPort(rt.iface);
    return !!port && port.getIsUp() && port.isConnected();
  }

  private sendQuery(rt: IgmpInterfaceRuntime, group: string, destIp: string, maxRespDs: number): void {
    const port = this.host.getPort(rt.iface);
    if (!port || !port.getIsUp() || !port.isConnected()) return;
    const srcIp = port.getIPAddress();
    if (!srcIp) return;
    this.sendIgmp(rt, srcIp, new IPAddress(destIp), igmpQuery(group, maxRespDs));
  }

  /** Unsolicited Membership Report for a group this router itself joined. */
  private sendReport(rt: IgmpInterfaceRuntime, group: string): void {
    const port = this.host.getPort(rt.iface);
    if (!port || !port.getIsUp() || !port.isConnected()) return;
    const srcIp = port.getIPAddress();
    if (!srcIp) return;
    const payload = igmpReport(group, rt.version);
    this.sendIgmp(rt, srcIp, new IPAddress(igmpDestination(payload)), payload);
  }

  private sendIgmp(rt: IgmpInterfaceRuntime, srcIp: IPAddress, dstIp: IPAddress, payload: IgmpPacket): void {
    if (!this.host.sendIpv4Packet(igmpSendRequest(rt.iface, srcIp, dstIp, payload))) return;
    this.getBus().publish({
      topic: 'igmp.packet.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        iface: rt.iface,
        messageType: payload.messageType,
        groupAddress: payload.groupAddress,
        destinationIp: dstIp.toString(),
      },
    });
  }

  private ensureIface(iface: string): IgmpInterfaceRuntime {
    let rt = this.config.interfaces.get(iface);
    if (!rt) {
      rt = defaultIfaceRuntime(iface);
      this.config.interfaces.set(iface, rt);
    }
    return rt;
  }

  private startTimers(): void {
    const s = this.getScheduler();
    this.scheduler = s;
    if (this.queryTimer === null) {
      this.queryTimer = s.setInterval(() => this.queryTick(), 1000);
    }
    if (this.expiryTimer === null) {
      this.expiryTimer = s.setInterval(() => this.expireDue(), 1000);
    }
  }

  private stopTimers(): void {
    const s = this.scheduler ?? this.getScheduler();
    if (this.queryTimer !== null) { s.clear(this.queryTimer); this.queryTimer = null; }
    if (this.expiryTimer !== null) { s.clear(this.expiryTimer); this.expiryTimer = null; }
  }

  private expireDue(): void {
    const now = this.nowMs();
    for (const rt of this.config.interfaces.values()) {
      if (!rt.enabled) continue;
      // `querierIp` — not `lastQuerierMs > 0` — is what says another querier
      // was heard: the Query that demoted us can legitimately land at t = 0.
      if (!this.ifaceOperUp(rt)) continue;
      if (rt.state === 'non-querier' && rt.querierIp !== null) {
        if (now - rt.lastQuerierMs > rt.otherQuerierPresentSec * 1000) {
          const oldState = rt.state;
          rt.state = 'querier';
          const port = this.host.getPort(rt.iface);
          rt.querierIp = port?.getIPAddress()?.toString() ?? null;
          this.publishQuerier(rt, oldState);
        }
      }
    }
    for (const [k, g] of this.config.groups) {
      const rt = this.config.interfaces.get(g.iface);
      if (!rt) continue;
      if (isConfiguredGroup(g)) continue;
      const ageMs = now - g.lastReportMs;
      if (ageMs > groupMembershipIntervalSec(rt) * 1000) {
        this.config.groups.delete(k);
        this.publishGroupLeft(g, 'timeout');
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
    this.unsubscribers.push(bus.subscribeWhere(
      'port.link.up',
      (p) => p.deviceId === this.host.id,
      (e) => this.onLinkUp(e.payload.portName),
    ));
  }

  private onLinkDown(portName: string): void {
    for (const [k, g] of this.config.groups) {
      if (g.iface === portName) {
        this.config.groups.delete(k);
        this.publishGroupLeft(g, 'timeout');
      }
    }
    const rt = this.config.interfaces.get(portName);
    if (rt) rt.state = 'startup';
  }

  private onLinkUp(portName: string): void {
    const rt = this.config.interfaces.get(portName);
    if (!rt || !rt.enabled) return;
    rt.startupQueriesSent = 0;
    rt.state = 'startup';
    this.kickStartupQuery(rt);
    for (const [group, origin] of rt.configuredGroups) {
      this.materializeConfiguredGroup(rt, group, origin);
    }
  }
}

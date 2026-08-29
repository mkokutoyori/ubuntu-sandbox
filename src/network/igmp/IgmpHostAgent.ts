/**
 * IgmpHostAgent — the receiver half of IGMP (RFC 2236 §3), the role an
 * end host plays: it joins groups, announces them with unsolicited
 * Membership Reports, answers the router's Queries, and leaves.
 *
 * `IgmpAgent` is the router/querier half; this is its counterpart, and
 * the two share the wire format through `igmp/frames.ts`.
 *
 * Version handling follows RFC 2236 §4 from the host's side: a Query with
 * Max Response Time 0 is an IGMPv1 Query, which arms the "Version 1
 * Querier Present" timer. While it runs the host reports as v1 and never
 * sends a Leave Group — an IGMPv1 host has no such message.
 */
import type { IEventBus } from '@/events/EventBus';
import type { Ipv4SendRequest } from '../layers/internet/Ipv4Egress';
import { getDefaultScheduler, type IScheduler, type TimerHandle } from '@/events/Scheduler';
import {
  isMulticastIpv4, isReservedMulticast,
  type IgmpPacket,
  IP_PROTO_IGMP,
} from './types';
import { igmpSendRequest, igmpReport, igmpLeave, igmpDestination } from './frames';
import { IPAddress, type EthernetFrame, type IPv4Packet } from '../core/types';
import { Logger } from '../core/Logger';

export interface IgmpHostAgentHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getPort(name: string): import('../hardware/Port').Port | undefined;
  sendFrame(portName: string, frame: EthernetFrame): void;
  sendIpv4Packet(request: Ipv4SendRequest): boolean;
}

interface HostMembership {
  iface: string;
  group: string;
  joinedAtMs: number;
  pendingReport: TimerHandle | null;
}

/** RFC 2236 §8.10 — Unsolicited Report Interval. */
const UNSOLICITED_REPORT_INTERVAL_MS = 10_000;
/** RFC 2236 §4 — how long a v1 Querier is presumed present after its Query. */
const V1_QUERIER_PRESENT_MS = 400_000;

function key(iface: string, group: string): string { return `${iface}|${group}`; }

export class IgmpHostAgent {
  private readonly memberships = new Map<string, HostMembership>();
  private readonly v1QuerierUntilMs = new Map<string, number>();

  constructor(
    private readonly host: IgmpHostAgentHost,
    private readonly getBus: () => IEventBus,
    private readonly getScheduler: () => IScheduler = () => getDefaultScheduler(),
  ) {}

  nowMs(): number { return this.getScheduler().now(); }

  hasMembership(iface: string, group: string): boolean {
    return this.memberships.has(key(iface, group));
  }

  listMemberships(): Array<{ iface: string; group: string; joinedAtMs: number }> {
    return Array.from(this.memberships.values())
      .map(({ iface, group, joinedAtMs }) => ({ iface, group, joinedAtMs }))
      .sort((a, b) => a.iface === b.iface
        ? a.group.localeCompare(b.group)
        : a.iface.localeCompare(b.iface));
  }

  groupsOn(iface: string): string[] {
    return this.listMemberships().filter(m => m.iface === iface).map(m => m.group);
  }

  /**
   * Whether a frame addressed to an IPv4 multicast group should be taken
   * off the wire: the all-systems group, which every host is permanently a
   * member of, plus whatever this host has actually joined.
   */
  acceptsGroup(iface: string, group: string): boolean {
    if (isReservedMulticast(group)) return true;
    return this.hasMembership(iface, group);
  }

  /**
   * Join a group on an interface. Real hosts send the unsolicited Report
   * immediately and repeat it once after the Unsolicited Report Interval,
   * so a single lost Report does not cost the membership.
   */
  join(iface: string, group: string): boolean {
    if (!isMulticastIpv4(group) || isReservedMulticast(group)) return false;
    if (!this.host.getPort(iface)) return false;
    const k = key(iface, group);
    if (this.memberships.has(k)) return true;
    this.memberships.set(k, {
      iface, group, joinedAtMs: this.nowMs(), pendingReport: null,
    });
    this.getBus().publish({
      topic: 'igmp.host.joined',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        iface, groupAddress: group,
      },
    });
    Logger.info(this.host.id, 'igmp-host:join',
      `${this.host.name}: ${iface} joined ${group}`);
    this.sendReport(iface, group);
    const s = this.getScheduler();
    s.setTimeout(() => {
      if (this.memberships.has(k)) this.sendReport(iface, group);
    }, UNSOLICITED_REPORT_INTERVAL_MS);
    return true;
  }

  /**
   * Leave a group. RFC 2236 §3: the Leave Group message only exists in
   * IGMPv2, so a host that believes it is talking to a v1 querier just
   * goes quiet and lets the router's membership time out.
   */
  leave(iface: string, group: string): boolean {
    const k = key(iface, group);
    const m = this.memberships.get(k);
    if (!m) return false;
    if (m.pendingReport !== null) this.getScheduler().clear(m.pendingReport);
    this.memberships.delete(k);
    this.getBus().publish({
      topic: 'igmp.host.left',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        iface, groupAddress: group,
      },
    });
    Logger.info(this.host.id, 'igmp-host:leave',
      `${this.host.name}: ${iface} left ${group}`);
    if (this.querierVersion(iface) === 2) this.sendLeave(iface, group);
    return true;
  }

  leaveAllOn(iface: string): void {
    for (const g of this.groupsOn(iface)) this.leave(iface, g);
  }

  /** Version of the querier last heard on the interface (RFC 2236 §4). */
  querierVersion(iface: string): 1 | 2 {
    const until = this.v1QuerierUntilMs.get(iface);
    return until !== undefined && until > this.nowMs() ? 1 : 2;
  }

  handleIp(inPort: string, ipPkt: IPv4Packet): void {
    if (ipPkt.protocol !== IP_PROTO_IGMP) return;
    const payload = ipPkt.payload as IgmpPacket | undefined;
    if (!payload || payload.type !== 'igmp') return;
    if (payload.messageType === 'membership-query') {
      this.onQuery(inPort, payload);
      return;
    }
    if (payload.messageType === 'v1-membership-report'
        || payload.messageType === 'v2-membership-report') {
      // RFC 2236 §3 report suppression: another member on the same segment
      // already answered for this group, so cancel our own pending Report.
      this.cancelPendingReport(inPort, payload.groupAddress);
    }
  }

  private onQuery(inPort: string, q: IgmpPacket): void {
    // RFC 2236 §4: Max Response Time 0 identifies an IGMPv1 Query.
    if (q.maxRespTimeDs === 0) {
      this.v1QuerierUntilMs.set(inPort, this.nowMs() + V1_QUERIER_PRESENT_MS);
    } else {
      this.v1QuerierUntilMs.delete(inPort);
    }
    const general = q.groupAddress === '0.0.0.0';
    const maxRespMs = Math.max(1, (q.maxRespTimeDs || 100) * 100);
    for (const m of this.memberships.values()) {
      if (m.iface !== inPort) continue;
      if (!general && m.group !== q.groupAddress) continue;
      this.scheduleReport(m, maxRespMs);
    }
  }

  /**
   * RFC 2236 §3: answer after a random delay in [0, Max Response Time] so
   * the members of a busy segment do not all report at once.
   */
  private scheduleReport(m: HostMembership, maxRespMs: number): void {
    if (m.pendingReport !== null) return;
    const s = this.getScheduler();
    const delay = Math.floor(Math.random() * maxRespMs);
    m.pendingReport = s.setTimeout(() => {
      m.pendingReport = null;
      if (!this.memberships.has(key(m.iface, m.group))) return;
      this.sendReport(m.iface, m.group);
    }, delay);
  }

  private cancelPendingReport(iface: string, group: string): void {
    const m = this.memberships.get(key(iface, group));
    if (!m || m.pendingReport === null) return;
    this.getScheduler().clear(m.pendingReport);
    m.pendingReport = null;
  }

  private sendReport(iface: string, group: string): void {
    this.emit(iface, igmpReport(group, this.querierVersion(iface)));
  }

  private sendLeave(iface: string, group: string): void {
    this.emit(iface, igmpLeave(group));
  }

  private emit(iface: string, payload: IgmpPacket): void {
    const port = this.host.getPort(iface);
    if (!port || !port.getIsUp() || !port.isConnected()) return;
    // RFC 3376 §4 and common practice: a host with no address yet still
    // reports, sourced from 0.0.0.0.
    const srcIp = port.getIPAddress() ?? new IPAddress('0.0.0.0');
    const dstIp = new IPAddress(igmpDestination(payload));
    if (!this.host.sendIpv4Packet(igmpSendRequest(iface, srcIp, dstIp, payload))) return;
    this.getBus().publish({
      topic: 'igmp.packet.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        iface,
        messageType: payload.messageType,
        groupAddress: payload.groupAddress,
        destinationIp: dstIp.toString(),
      },
    });
  }
}

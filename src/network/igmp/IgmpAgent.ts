import type { IEventBus } from '@/events/EventBus';
import { getDefaultScheduler, type IScheduler, type TimerHandle } from '@/events/Scheduler';
import {
  type IgmpConfig, type IgmpInterfaceRuntime, type IgmpGroupRecord,
  type IgmpPacket, type IgmpMessageType,
  createDefaultIgmpConfig, defaultIfaceRuntime, makeGroupKey,
  groupMembershipIntervalSec, ipv4MulticastToMac, isMulticastIpv4, isReservedMulticast,
  compareQuerier,
  IP_PROTO_IGMP, IGMP_ALL_SYSTEMS, IGMP_ALL_ROUTERS,
} from './types';
import {
  MACAddress, IPAddress,
  type EthernetFrame, type IPv4Packet,
  ETHERTYPE_IPV4, nextIPv4Id, computeIPv4Checksum,
} from '../core/types';
import { Logger } from '../core/Logger';

export interface IgmpHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getPort(name: string): import('../hardware/Port').Port | undefined;
  getPorts(): import('../hardware/Port').Port[];
  sendFrame(portName: string, frame: EthernetFrame): void;
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

  enableInterface(iface: string, version: 1 | 2 = 2): void {
    const rt = this.ensureIface(iface);
    rt.enabled = true;
    rt.version = version;
    rt.state = 'startup';
    rt.startupQueriesSent = 0;
    this.kickStartupQuery(rt);
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

  handleIp(inPort: string, srcIp: IPAddress, ipPkt: IPv4Packet): void {
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
    rt.lastQuerierMs = Date.now();
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

  private recordMembership(rt: IgmpInterfaceRuntime, group: string, reporterIp: string, v1 = false): void {
    if (!isMulticastIpv4(group) || isReservedMulticast(group)) return;
    const k = makeGroupKey(rt.iface, group);
    const existing = this.config.groups.get(k);
    if (existing) {
      existing.reporters.add(reporterIp);
      existing.lastReporterIp = reporterIp;
      existing.lastReportMs = Date.now();
      if (v1) existing.v1Compat = true;
      return;
    }
    const rec: IgmpGroupRecord = {
      groupAddress: group, iface: rt.iface,
      reporters: new Set([reporterIp]),
      lastReporterIp: reporterIp,
      lastReportMs: Date.now(),
      v1Compat: v1,
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

  private sendGeneralQuery(rt: IgmpInterfaceRuntime): void {
    this.sendQuery(rt, '0.0.0.0', IGMP_ALL_SYSTEMS, rt.queryResponseIntervalDs);
    if (rt.state === 'startup') {
      rt.startupQueriesSent++;
      if (rt.startupQueriesSent >= rt.startupQueryCount) {
        const oldState = rt.state;
        rt.state = 'querier';
        this.publishQuerier(rt, oldState);
      }
    } else if (rt.state === 'non-querier') {
      const oldState = rt.state;
      rt.state = 'querier';
      this.publishQuerier(rt, oldState);
    }
  }

  private sendGroupSpecificQuery(rt: IgmpInterfaceRuntime, group: string): void {
    for (let i = 0; i < rt.lastMemberQueryCount; i++) {
      this.sendQuery(rt, group, group, rt.lastMemberQueryIntervalDs);
    }
  }

  private sendQuery(rt: IgmpInterfaceRuntime, group: string, destIp: string, maxRespDs: number): void {
    const port = this.host.getPort(rt.iface);
    if (!port || !port.getIsUp() || !port.isConnected()) return;
    const srcIp = port.getIPAddress();
    if (!srcIp) return;
    const payload: IgmpPacket = {
      type: 'igmp', version: 2,
      messageType: 'membership-query',
      maxRespTimeDs: maxRespDs,
      groupAddress: group,
      checksum: 0,
    };
    this.sendIgmp(rt, srcIp, new IPAddress(destIp), payload);
  }

  private sendIgmp(rt: IgmpInterfaceRuntime, srcIp: IPAddress, dstIp: IPAddress, payload: IgmpPacket): void {
    const port = this.host.getPort(rt.iface);
    if (!port) return;
    const ipPkt: IPv4Packet = {
      type: 'ipv4', version: 4, ihl: 6, tos: 0xc0,
      totalLength: 24 + 8,
      identification: nextIPv4Id(), flags: 0, fragmentOffset: 0,
      ttl: 1, protocol: IP_PROTO_IGMP, headerChecksum: 0,
      sourceIP: srcIp, destinationIP: dstIp,
      payload,
    };
    ipPkt.headerChecksum = computeIPv4Checksum(ipPkt);
    const dstMacStr = ipv4MulticastToMac(dstIp.toString());
    const eth: EthernetFrame = {
      srcMAC: port.getMAC(),
      dstMAC: new MACAddress(dstMacStr),
      etherType: ETHERTYPE_IPV4,
      payload: ipPkt,
    };
    this.host.sendFrame(rt.iface, eth);
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
      this.queryTimer = s.setInterval(() => {
        for (const rt of this.config.interfaces.values()) {
          if (!rt.enabled) continue;
          if (rt.state === 'querier') this.sendGeneralQuery(rt);
        }
      }, 1000);
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
    const now = Date.now();
    for (const rt of this.config.interfaces.values()) {
      if (!rt.enabled) continue;
      if (rt.state === 'non-querier' && rt.lastQuerierMs > 0) {
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
  }
}

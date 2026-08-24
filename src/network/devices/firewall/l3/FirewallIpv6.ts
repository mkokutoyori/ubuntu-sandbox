import type { Port } from '../../../hardware/Port';
import type { EthernetFrame, IPv6Address, IPv6Packet } from '../../../core/types';
import type { IEventBus } from '@/events/EventBus';
import type { IScheduler } from '@/events/Scheduler';
import { DHCPv6Server } from '../../../dhcpv6/DHCPv6Server';
import {
  IPv6DataPlane, type IPv6RouterContext, type Ipv6Counters,
} from '../../router/IPv6DataPlane';
import type { RouterCounters } from '../../Router';

export interface FirewallIpv6Deps {
  readonly id: string;
  readonly name: string;
  ports(): Map<string, Port>;
  sendFrame(iface: string, frame: EthernetFrame): void;
  bus(): IEventBus;
  scheduler(): IScheduler;
  managementAllows(iface: string, service: string): boolean;
  onEchoReply(payload: {
    fromIp: string; toIp: string; id: number; seq: number; hopLimit: number;
  }): void;
}

function idleCounters(): RouterCounters {
  return {
    ifInOctets: 0, ifOutOctets: 0, ipInHdrErrors: 0, ipInAddrErrors: 0,
    ipForwDatagrams: 0, icmpOutMsgs: 0, icmpOutDestUnreachs: 0,
    icmpOutTimeExcds: 0, icmpInMsgs: 0, icmpInEchos: 0, icmpOutEchoReps: 0,
  } as RouterCounters;
}

export class FirewallIpv6 {
  private readonly engine: IPv6DataPlane;
  private readonly counters = idleCounters();
  private readonly dhcpv6 = new DHCPv6Server();
  private readonly allowAccess = new Map<string, ReadonlySet<string>>();

  constructor(private readonly deps: FirewallIpv6Deps) {
    this.engine = new IPv6DataPlane(this.context());
    this.engine.enableRouting();
  }

  dataPlane(): IPv6DataPlane { return this.engine; }

  counterView(): Ipv6Counters { return this.engine.getIpv6Counters(); }

  setAllowAccess(iface: string, services: readonly string[]): void {
    this.allowAccess.set(iface, new Set(services.map(s => s.toLowerCase())));
  }

  allowedAccessOn(iface: string): readonly string[] {
    return [...(this.allowAccess.get(iface) ?? [])];
  }

  allowsAccess(iface: string, service: string): boolean {
    const declared = this.allowAccess.get(iface);
    if (declared === undefined) return false;
    return declared.has(service.toLowerCase());
  }

  private context(): IPv6RouterContext {
    return {
      id: this.deps.id,
      name: this.deps.name,
      getPorts: () => this.deps.ports(),
      sendFrame: (iface, frame) => { this.deps.sendFrame(iface, frame); },
      getCounters: () => this.counters,
      getBus: () => this.deps.bus(),
      getScheduler: () => this.deps.scheduler(),
      getDhcpv6Server: () => this.dhcpv6,
      getDhcpv6ServerPool: () => undefined,
      getDhcpv6RelayDestinations: () => [],
      onIcmpv6EchoReply: (payload) => { this.deps.onEchoReply(payload); },
      ipv6FilterPermits: (iface, direction, packet) =>
        this.permits(iface, direction, packet),
    };
  }

  private permits(iface: string, direction: 'in' | 'out', packet: IPv6Packet): boolean {
    if (direction === 'out') return false;
    if (!this.isEchoRequest(packet)) return true;
    if (!this.addressedToUs(packet.destinationIP)) return true;
    return this.allowsAccess(iface, 'ping');
  }

  private isEchoRequest(packet: IPv6Packet): boolean {
    const payload = packet.payload as { type?: string; icmpType?: string } | undefined;
    return payload?.type === 'icmpv6' && payload.icmpType === 'echo-request';
  }

  private addressedToUs(destination: IPv6Address): boolean {
    for (const port of this.deps.ports().values()) {
      if (port.hasIPv6Address(destination)) return true;
    }
    return false;
  }
}

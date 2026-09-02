import type { Port } from '../../../hardware/Port';
import {
  IP_PROTO_ICMPV6,
  type EthernetFrame, type ICMPv6Type, type IPv6Address, type IPv6Packet,
} from '../../../core/types';
import type { PolicyProbe } from '../policy/PolicyProbe';
import type { LocalInTraffic, LocalInVerdict } from '../policy/LocalInPolicy';
import { icmpv6TypeNumber, makeFlowKey } from '../session/FlowKey';
import type { SessionTable } from '../session/SessionTable';

export const IPV6_SESSION_TIMEOUT_SEC = 300;
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
  onEchoFailed?(payload: { fromIp: string; reason: string }): void;
  transitPermitted(probe: PolicyProbe): boolean;
  localInVerdict?(iface: string, traffic: LocalInTraffic): LocalInVerdict;
  sessions(): SessionTable;
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
      onIcmpv6EchoFailed: (payload) => { this.deps.onEchoFailed?.(payload); },
      ipv6FilterPermits: (iface, direction, packet, ingress) =>
        this.permits(iface, direction, packet, ingress),
    };
  }

  private permits(
    iface: string, direction: 'in' | 'out', packet: IPv6Packet, ingress?: string,
  ): boolean {
    if (direction === 'out') return this.transitPermitted(iface, packet, ingress);
    if (!this.addressedToUs(packet.destinationIP)) return true;
    if (this.deps.localInVerdict?.(iface, localInTrafficOf(packet)) === 'deny') return false;
    if (!this.isEchoRequest(packet)) return true;
    return this.allowsAccess(iface, 'ping');
  }

  private transitPermitted(
    egress: string, packet: IPv6Packet, ingress: string | undefined,
  ): boolean {
    const protocol = protocolOf(packet);
    const ports = transportPortsOf(packet);
    const source = packet.sourceIP.toString();
    const destination = packet.destinationIP.toString();

    const key = makeFlowKey(source, ports.sourcePort ?? 0,
      destination, ports.destPort ?? 0, protocol);
    const sessions = this.deps.sessions();
    if (sessions.lookup(key)) return true;

    const permitted = this.deps.transitPermitted({
      ingressZone: '', egressZone: '',
      ingressInterface: ingress ?? '',
      egressInterface: egress,
      sourceIP: source, destIP: destination, protocol,
      ...ports,
    });
    if (!permitted) return false;

    sessions.install(key, {
      ingressZone: '', egressZone: '',
      ingressInterface: ingress ?? '',
      egressInterface: egress,
      timeoutSec: IPV6_SESSION_TIMEOUT_SEC,
      replyKey: makeFlowKey(destination, ports.destPort ?? 0,
        source, ports.sourcePort ?? 0, protocol),
    });
    return true;
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

function protocolOf(packet: IPv6Packet): number {
  const payload = packet.payload as { type?: string } | undefined;
  return payload?.type === 'icmpv6' ? IP_PROTO_ICMPV6 : packet.nextHeader;
}

function localInTrafficOf(packet: IPv6Packet): LocalInTraffic {
  const payload = packet.payload as { icmpType?: ICMPv6Type; code?: number } | undefined;
  const icmp = protocolOf(packet) === IP_PROTO_ICMPV6;
  return {
    sourceIP: packet.sourceIP.toString(),
    destIP: packet.destinationIP.toString(),
    protocol: protocolOf(packet),
    bytes: packet.payloadLength,
    ...transportPortsOf(packet),
    ...(icmp ? { icmpType: icmpv6TypeNumber(payload?.icmpType), icmpCode: payload?.code } : {}),
  };
}

function transportPortsOf(
  packet: IPv6Packet,
): { sourcePort?: number; destPort?: number } {
  const payload = packet.payload as {
    sourcePort?: number; destinationPort?: number;
  } | undefined;
  if (payload?.sourcePort === undefined) return {};
  return { sourcePort: payload.sourcePort, destPort: payload.destinationPort };
}

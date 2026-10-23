import { IPAddress, type IPv4Packet, type UDPPacket } from '@/network/core/types';
import type { VpnPath } from '@/network/bgp/vpn/VpnV4Speaker';
import type { LdpLocalBinding } from '@/network/ldp/LdpEngine';
import type { IlmEntry, Lfib } from '@/network/mpls/Lfib';
import { MplsLabel } from '@/network/mpls/MplsLabel';
import { MAX_MPLS_TTL, makeLabelStackEntry, withBottomOfStack } from '@/network/mpls/LabelStack';
import type { MplsPacket } from '@/network/mpls/MplsPacket';
import { MplsEchoAgent, type EchoReply, type EchoRequestOptions } from '@/network/mpls/oam/EchoAgent';
import {
  DdmapAddressType, DdmapProtocol, ReturnCode,
  type Ddmap, type TargetFec,
} from '@/network/mpls/oam/EchoCodec';
import type { DownstreamPath, EchoReceipt, EchoResponderHost, FecMapping } from '@/network/mpls/oam/EchoResponder';
import { fecStackAfter } from '@/network/mpls/oam/FecStackChange';
import { allocateEphemeralPort } from '@/network/layers/transport/EphemeralPorts';

const EPHEMERAL_FIRST = 49152;
const EPHEMERAL_LAST = 65535;

export interface MplsOamHost {
  routerAddress(): IPAddress;
  interfaceAddress(iface: string): IPAddress | null;
  lfib(): Lfib;
  mplsEnabled(iface: string): boolean;
  ldpBinding(prefix: IPAddress, length: number): LdpLocalBinding | undefined;
  ldpEnabled(iface: string): boolean;
  ldpInstalls(label: MplsLabel): boolean;
  interfaceMtu(iface: string): number;
  vpnPaths(): readonly VpnPath[];
  claimPort(port: number, receive: (packet: IPv4Packet, udp: UDPPacket) => void): void;
  releasePort(port: number): void;
  portTaken(port: number): boolean;
  sendIp(packet: IPv4Packet): boolean;
  sendLabelled(iface: string, nextHop: IPAddress, packet: MplsPacket): void;
  sendUnlabelled(iface: string, nextHop: IPAddress, packet: IPv4Packet): void;
}

export interface LspPingOptions extends EchoRequestOptions {
  readonly ttl?: number;
  readonly trafficClass?: number;
}

export interface LspTraceOptions extends EchoRequestOptions {
  readonly maxTtl?: number;
}

export interface LspTraceHop {
  readonly ttl: number;
  readonly outcome: LspPingOutcome;
  readonly downstream: Ddmap | null;
}

export type LspPingOutcome =
  | { readonly kind: 'reply'; readonly reply: EchoReply }
  | { readonly kind: 'not-sent'; readonly reason: 'no-label-binding' | 'no-vpn-route' | 'interface-not-mpls' | 'size-exceeds-mtu' }
  | { readonly kind: 'timeout' };

export class RouterMplsOam implements EchoResponderHost {
  private readonly agent: MplsEchoAgent;

  constructor(private readonly host: MplsOamHost) {
    this.agent = new MplsEchoAgent({
      localAddress: () => host.routerAddress(),
      allocatePort: () => allocateEphemeralPort(EPHEMERAL_FIRST, EPHEMERAL_LAST, port => host.portTaken(port)),
      releasePort: port => host.releasePort(port),
      sendReply: packet => host.sendIp(packet),
    });
  }

  ping(fecs: readonly TargetFec[], options: LspPingOptions = {}): LspPingOutcome {
    const route = this.routeFor(fecs);
    if (route === 'no-label-binding' || route === 'no-vpn-route') return { kind: 'not-sent', reason: route };
    if (!this.host.mplsEnabled(route.iface) && route.labels.length > 0) return { kind: 'not-sent', reason: 'interface-not-mpls' };
    if (options.targetSize !== undefined && options.targetSize > this.host.interfaceMtu(route.iface)) {
      return { kind: 'not-sent', reason: 'size-exceeds-mtu' };
    }
    const built = this.agent.buildRequest(this.host.routerAddress(), fecs, { ...options, labelBytes: 4 * route.labels.length });
    this.host.claimPort(built.pending.sourcePort, (packet, udp) => this.agent.receiveReply(packet.sourceIP, udp));
    try {
      if (route.labels.length === 0) {
        this.host.sendUnlabelled(route.iface, route.nextHop, built.packet);
      } else {
        const outer = options.ttl ?? MAX_MPLS_TTL;
        const entries = route.labels.map((label, index) => makeLabelStackEntry(
          MplsLabel.of(label), index === route.labels.length - 1 && route.innermostTtl !== null ? route.innermostTtl : outer, options.trafficClass ?? 0));
        this.host.sendLabelled(route.iface, route.nextHop, { type: 'mpls', stack: withBottomOfStack(entries), payload: built.packet });
      }
      const reply = built.pending.reply;
      return reply === null ? { kind: 'timeout' } : { kind: 'reply', reply };
    } finally {
      this.agent.finish(built.pending);
    }
  }

  traceroute(fecs: readonly TargetFec[], options: LspTraceOptions = {}): LspTraceHop[] {
    const route = this.routeFor(fecs);
    if (route === 'no-label-binding' || route === 'no-vpn-route') return [];
    const hops: LspTraceHop[] = [];
    let ddmap: Ddmap | undefined = options.ddmap ?? this.mappingTowards(route);
    let traced: readonly TargetFec[] = fecs;
    for (let ttl = 1; ttl <= (options.maxTtl ?? 30); ttl++) {
      const outcome = this.ping(traced, { ...options, ttl, ddmap });
      const reply = outcome.kind === 'reply' ? outcome.reply.message : null;
      const downstream = reply?.ddmaps[0] ?? null;
      hops.push({ ttl, outcome, downstream });
      if (reply === null || downstream === null) break;
      if (reply.returnCode !== ReturnCode.Switched && reply.returnCode !== ReturnCode.UpstreamInterfaceUnknown) break;
      const changed = fecStackAfter(traced, downstream.fecStackChanges);
      if (changed === null) break;
      traced = changed;
      ddmap = { ...downstream, returnCode: ReturnCode.None, returnSubcode: 0 };
    }
    return hops;
  }

  describeFirstHop(fecs: readonly TargetFec[]): { readonly interfaceAddress: IPAddress; readonly mtu: number; readonly labels: readonly number[] } | null {
    const route = this.routeFor(fecs);
    if (route === 'no-label-binding' || route === 'no-vpn-route') return null;
    return {
      interfaceAddress: this.host.interfaceAddress(route.iface) ?? this.host.routerAddress(),
      mtu: this.host.interfaceMtu(route.iface), labels: route.labels,
    };
  }

  firstHopMapping(fecs: readonly TargetFec[]): Ddmap | null {
    const route = this.routeFor(fecs);
    return route === 'no-label-binding' || route === 'no-vpn-route' ? null : this.mappingTowards(route);
  }

  private mappingTowards(route: { iface: string; nextHop: IPAddress; labels: number[] }): Ddmap {
    return {
      mtu: this.host.interfaceMtu(route.iface), addressType: DdmapAddressType.Ipv4Numbered,
      interfaceAndLabelStackRequested: false, nonIp: false,
      downstreamAddress: route.nextHop, downstreamInterface: route.nextHop, returnCode: ReturnCode.None, returnSubcode: 0,
      multipathType: 0, multipathInformation: new Uint8Array(0),
      labelStack: route.labels.map(label => ({ label, protocol: DdmapProtocol.Ldp })), fecStackChanges: [],
    };
  }

  downstream(entry: IlmEntry, received: readonly number[]): DownstreamPath | null {
    if (entry.kind === 'swap') {
      return {
        nextHop: entry.nextHop, mtu: this.host.interfaceMtu(entry.iface),
        labels: [...entry.outLabels.map(label => label.value), ...received.slice(1)],
        protocol: this.host.ldpInstalls(MplsLabel.of(received[0])) ? DdmapProtocol.Ldp : DdmapProtocol.Unknown,
      };
    }
    if (entry.kind === 'pop' && entry.iface !== null && entry.nextHop !== null) {
      return {
        nextHop: entry.nextHop, mtu: this.host.interfaceMtu(entry.iface),
        labels: [MplsLabel.IMPLICIT_NULL.value, ...received.slice(1)],
        protocol: this.host.ldpInstalls(MplsLabel.of(received[0])) ? DdmapProtocol.Ldp : DdmapProtocol.Unknown,
      };
    }
    return null;
  }

  receiveRequest(inPort: string, packet: IPv4Packet, labels: readonly number[], topTtl: number | null): void {
    const interfaceAddress = this.host.interfaceAddress(inPort);
    const receipt: EchoReceipt = {
      interfaceName: inPort, routerAddress: this.host.routerAddress(),
      interfaceAddress: interfaceAddress ?? this.host.routerAddress(), labels, topTtl,
    };
    this.agent.receiveRequest(packet, receipt, this);
  }

  ilm(label: MplsLabel) { return this.host.lfib().lookupIlm(label); }

  mplsEnabled(iface: string): boolean { return this.host.mplsEnabled(iface); }

  fecMapping(fec: TargetFec, receivedOn: string): FecMapping {
    if (fec.kind === 'ldp-ipv4' || fec.kind === 'generic-ipv4') {
      const binding = this.host.ldpBinding(fec.prefix, fec.length);
      if (binding === undefined) return { present: false, label: null, protocolOnInterface: true };
      const protocolOnInterface = fec.kind === 'generic-ipv4' || this.host.ldpEnabled(receivedOn);
      return { present: true, label: binding.label.value, protocolOnInterface };
    }
    if (fec.kind === 'vpn-ipv4') {
      const local = this.host.vpnPaths().find(path => path.source === 'local' && path.rd === fec.routeDistinguisher
        && path.prefixLength === fec.length && path.network.equals(fec.prefix));
      if (local === undefined) return { present: false, label: null, protocolOnInterface: true };
      return { present: true, label: local.label.value, protocolOnInterface: true };
    }
    return { present: false, label: null, protocolOnInterface: true };
  }

  private routeFor(fecs: readonly TargetFec[]):
    | { iface: string; nextHop: IPAddress; labels: number[]; innermostTtl: number | null }
    | 'no-label-binding' | 'no-vpn-route' {
    const top = fecs[0];
    const vpn = fecs.find(fec => fec.kind === 'vpn-ipv4');
    if (top.kind === 'vpn-ipv4' || vpn !== undefined) {
      const fec = vpn as Extract<TargetFec, { kind: 'vpn-ipv4' }>;
      const path = this.host.vpnPaths().find(candidate => candidate.source !== 'local' && candidate.rd === fec.routeDistinguisher
        && candidate.prefixLength === fec.length && candidate.network.equals(fec.prefix));
      if (path === undefined) return 'no-vpn-route';
      const transport = this.host.lfib().lookupFtn(new IPAddress(path.nextHop));
      if (transport === undefined) return 'no-label-binding';
      return {
        iface: transport.iface, nextHop: transport.nextHop,
        labels: [...transport.outLabels.map(label => label.value), path.label.value], innermostTtl: 1,
      };
    }
    if (top.kind === 'ldp-ipv4' || top.kind === 'generic-ipv4') {
      const entry = this.host.lfib().ftnEntries().find(candidate => candidate.prefixLength === top.length && candidate.prefix.equals(top.prefix));
      if (entry === undefined) return 'no-label-binding';
      return { iface: entry.iface, nextHop: entry.nextHop, labels: entry.outLabels.map(label => label.value), innermostTtl: null };
    }
    return 'no-label-binding';
  }
}

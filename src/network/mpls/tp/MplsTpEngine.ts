import type { IPAddress, IPv4Packet } from '@/network/core/types';
import { makeLabelStackEntry, withBottomOfStack, MAX_MPLS_TTL } from '../LabelStack';
import type { GachDelivery, MplsEngine } from '../MplsEngine';
import { MplsLabel } from '../MplsLabel';
import type { MplsPacket } from '../MplsPacket';
import type { GachPayload } from './GachPacket';

export interface TpIngressLsp {
  readonly name: string;
  readonly iface: string;
  readonly nextHop: IPAddress;
  readonly outLabel: number;
}

export interface TpTransitLsp {
  readonly inLabel: number;
  readonly iface: string;
  readonly nextHop: IPAddress;
  readonly outLabel: number;
}

export interface TpEgressLsp {
  readonly name: string;
  readonly inLabel: number;
}

export interface LspDataCounters {
  txPackets: bigint;
  txOctets: bigint;
  rxPackets: bigint;
  rxOctets: bigint;
}

export type GachHandler = (delivery: GachDelivery) => void;

export interface MplsTpHost {
  mpls(): MplsEngine;
  sendLabelled(iface: string, nextHop: IPAddress, packet: MplsPacket): void;
}

export class MplsTpEngine {
  private readonly ingress = new Map<string, TpIngressLsp>();
  private readonly handlers = new Map<number, GachHandler>();
  readonly counters = { sent: 0, received: 0, unhandled: 0 };
  private readonly data = new Map<string, LspDataCounters>();

  constructor(private readonly host: MplsTpHost) {}

  defineIngress(lsp: TpIngressLsp): void {
    this.host.mpls().enableInterface(lsp.iface);
    this.ingress.set(lsp.name, lsp);
  }

  defineTransit(lsp: TpTransitLsp): void {
    const mpls = this.host.mpls();
    mpls.enableInterface(lsp.iface);
    mpls.lfib.setIlm(MplsLabel.of(lsp.inLabel), {
      kind: 'swap', outLabels: [MplsLabel.of(lsp.outLabel)], iface: lsp.iface, nextHop: lsp.nextHop,
    });
  }

  defineEgress(lsp: TpEgressLsp): void {
    this.host.mpls().lfib.setIlm(MplsLabel.of(lsp.inLabel), { kind: 'tp-lsp', lsp: lsp.name });
  }

  enableSection(iface: string): void {
    this.host.mpls().enableInterface(iface);
  }

  registerChannel(channelType: number, handler: GachHandler): void {
    this.handlers.set(channelType, handler);
  }

  ingressLsp(name: string): TpIngressLsp | undefined {
    return this.ingress.get(name);
  }

  sendOverLsp(name: string, payload: GachPayload, ttl = MAX_MPLS_TTL): boolean {
    const lsp = this.ingress.get(name);
    if (lsp === undefined) return false;
    const stack = withBottomOfStack([
      makeLabelStackEntry(MplsLabel.of(lsp.outLabel), ttl),
      makeLabelStackEntry(MplsLabel.GENERIC_ASSOCIATED_CHANNEL, 1),
    ]);
    this.counters.sent++;
    this.host.sendLabelled(lsp.iface, lsp.nextHop, { type: 'mpls', stack, payload });
    return true;
  }

  sendOverSection(iface: string, nextHop: IPAddress, payload: GachPayload): void {
    const stack = withBottomOfStack([makeLabelStackEntry(MplsLabel.GENERIC_ASSOCIATED_CHANNEL, 1)]);
    this.counters.sent++;
    this.host.sendLabelled(iface, nextHop, { type: 'mpls', stack, payload });
  }

  dataCounters(lsp: string): Readonly<LspDataCounters> {
    return this.countersOf(lsp);
  }

  private countersOf(lsp: string): LspDataCounters {
    let counters = this.data.get(lsp);
    if (counters === undefined) {
      counters = { txPackets: 0n, txOctets: 0n, rxPackets: 0n, rxOctets: 0n };
      this.data.set(lsp, counters);
    }
    return counters;
  }

  sendClientPacket(name: string, packet: IPv4Packet): boolean {
    const lsp = this.ingress.get(name);
    if (lsp === undefined) return false;
    const counters = this.countersOf(name);
    counters.txPackets += 1n;
    counters.txOctets += BigInt(packet.totalLength);
    const stack = withBottomOfStack([makeLabelStackEntry(MplsLabel.of(lsp.outLabel), MAX_MPLS_TTL)]);
    this.host.sendLabelled(lsp.iface, lsp.nextHop, { type: 'mpls', stack, payload: packet });
    return true;
  }

  receiveClientPacket(lsp: string, packet: IPv4Packet): void {
    const counters = this.countersOf(lsp);
    counters.rxPackets += 1n;
    counters.rxOctets += BigInt(packet.totalLength);
  }

  receive(delivery: GachDelivery): void {
    this.counters.received++;
    const handler = this.handlers.get(delivery.payload.channelType);
    if (handler === undefined) {
      this.counters.unhandled++;
      return;
    }
    handler(delivery);
  }
}

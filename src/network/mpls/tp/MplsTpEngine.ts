import type { IPAddress } from '@/network/core/types';
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

export type GachHandler = (delivery: GachDelivery) => void;

export interface MplsTpHost {
  mpls(): MplsEngine;
  sendLabelled(iface: string, nextHop: IPAddress, packet: MplsPacket): void;
}

export class MplsTpEngine {
  private readonly ingress = new Map<string, TpIngressLsp>();
  private readonly handlers = new Map<number, GachHandler>();
  readonly counters = { sent: 0, received: 0, unhandled: 0 };

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

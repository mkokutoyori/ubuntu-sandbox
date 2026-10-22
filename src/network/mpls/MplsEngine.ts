import type { IPAddress, IPv4Packet } from '@/network/core/types';
import { MAX_MPLS_TTL, makeLabelStackEntry, withBottomOfStack } from './LabelStack';
import { MplsLabel } from './MplsLabel';
import { Lfib } from './Lfib';
import { imposeLabels, switchLabelled, type TtlPolicy } from './LabelSwitching';
import { carriesIp, type MplsPacket } from './MplsPacket';
import { isEchoRequestPacket } from './oam/EchoAgent';
import type { PseudowirePayload } from '@/network/pw/PseudowirePacket';

export interface MplsHost {
  sendLabelled(iface: string, nextHop: IPAddress, packet: MplsPacket): void;
  sendUnlabelled(iface: string, nextHop: IPAddress, packet: IPv4Packet): void;
  continueAsIp(inPort: string, packet: IPv4Packet, ttlAccounted: boolean): void;
  continueInVrf(inPort: string, packet: IPv4Packet, vrf: string, ttlAccounted: boolean): void;
  expired(inPort: string, packet: MplsPacket): void;
  echoRequest(inPort: string, packet: MplsPacket): void;
  deliverPseudowire(inPort: string, attachmentCircuit: string, payload: PseudowirePayload): void;
}

export interface MplsCounters {
  labelledIn: number;
  labelledOut: number;
  imposed: number;
  disposed: number;
  expired: number;
  noBinding: number;
  droppedDisabledInterface: number;
  echoRequests: number;
}

export class MplsEngine implements TtlPolicy {
  readonly lfib = new Lfib();
  propagateTtl = true;
  readonly counters: MplsCounters = {
    labelledIn: 0, labelledOut: 0, imposed: 0, disposed: 0, expired: 0, noBinding: 0, droppedDisabledInterface: 0, echoRequests: 0,
  };
  private readonly interfaces = new Set<string>();
  private readonly switchedBytes = new Map<number, number>();

  constructor(private readonly host: MplsHost) {}

  enableInterface(iface: string): void { this.interfaces.add(iface); }
  disableInterface(iface: string): void { this.interfaces.delete(iface); }
  isInterfaceEnabled(iface: string): boolean { return this.interfaces.has(iface); }
  enabledInterfaces(): readonly string[] { return [...this.interfaces]; }

  receive(inPort: string, packet: MplsPacket): void {
    if (!this.interfaces.has(inPort)) {
      this.counters.droppedDisabledInterface++;
      return;
    }
    this.counters.labelledIn++;
    const incoming = packet.stack[0].label.value;
    const decision = switchLabelled(packet, this.lfib, this);
    if (carriesIp(packet)) {
      this.switchedBytes.set(incoming, (this.switchedBytes.get(incoming) ?? 0) + packet.payload.totalLength);
    }
    if (carriesIp(packet) && isEchoRequestPacket(packet.payload) && this.trapsEcho(packet, decision.kind)) {
      this.counters.echoRequests++;
      this.host.echoRequest(inPort, packet);
      return;
    }
    switch (decision.kind) {
      case 'labelled':
        this.counters.labelledOut++;
        this.host.sendLabelled(decision.iface, decision.nextHop, decision.packet);
        return;
      case 'unlabelled':
        this.counters.disposed++;
        this.host.sendUnlabelled(decision.iface, decision.nextHop, decision.packet);
        return;
      case 'deliver':
        this.counters.disposed++;
        this.host.continueAsIp(inPort, decision.packet, decision.ttlAccounted);
        return;
      case 'deliver-vrf':
        this.counters.disposed++;
        this.host.continueInVrf(inPort, decision.packet, decision.vrf, decision.ttlAccounted);
        return;
      case 'deliver-pw':
        this.counters.disposed++;
        this.host.deliverPseudowire(inPort, decision.attachmentCircuit, decision.payload);
        return;
      case 'expired':
        this.counters.expired++;
        this.host.expired(inPort, decision.packet);
        return;
      case 'no-binding':
        this.counters.noBinding++;
    }
  }

  private trapsEcho(packet: MplsPacket, decision: string): boolean {
    if (decision === 'expired' || decision === 'deliver' || decision === 'deliver-vrf') return true;
    return decision === 'no-binding' && packet.stack[0].label.equals(MplsLabel.ROUTER_ALERT);
  }

  tunnel(inPort: string, expired: MplsPacket, error: IPv4Packet): void {
    const restamped = expired.stack.map(entry => ({ ...entry, ttl: MAX_MPLS_TTL }));
    this.receive(inPort, { type: 'mpls', stack: restamped, payload: error });
  }

  bytesSwitched(label: { readonly value: number }): number {
    return this.switchedBytes.get(label.value) ?? 0;
  }

  imposeVpn(packet: IPv4Packet, vpnLabel: MplsLabel, bgpNextHop: IPAddress, iface: string, nextHop: IPAddress): MplsPacket | null {
    if (!this.interfaces.has(iface)) return null;
    const entry = this.lfib.lookupFtn(bgpNextHop);
    if (entry === undefined || entry.iface !== iface || !entry.nextHop.equals(nextHop)) return null;
    const ttl = this.propagateTtl ? packet.ttl : MAX_MPLS_TTL;
    const stack = withBottomOfStack([...entry.outLabels, vpnLabel].map(label => makeLabelStackEntry(label, ttl)));
    this.counters.imposed++;
    return { type: 'mpls', stack, payload: packet };
  }

  imposeUnderlay(
    payload: PseudowirePayload, serviceLabel: MplsLabel, target: IPAddress,
  ): { readonly packet: MplsPacket; readonly iface: string; readonly nextHop: IPAddress } | null {
    const entry = this.lfib.lookupFtn(target);
    if (entry === undefined || !this.interfaces.has(entry.iface)) return null;
    const stack = withBottomOfStack([...entry.outLabels, serviceLabel].map(label => makeLabelStackEntry(label, MAX_MPLS_TTL)));
    this.counters.imposed++;
    return { packet: { type: 'mpls', stack, payload }, iface: entry.iface, nextHop: entry.nextHop };
  }

  impose(packet: IPv4Packet, iface: string, nextHop: IPAddress | null): MplsPacket | null {
    if (!this.interfaces.has(iface)) return null;
    const entry = this.lfib.lookupFtn(packet.destinationIP);
    if (entry === undefined || entry.iface !== iface || entry.outLabels.length === 0) return null;
    if (nextHop !== null && !entry.nextHop.equals(nextHop)) return null;
    this.counters.imposed++;
    return imposeLabels(packet, entry, this);
  }
}

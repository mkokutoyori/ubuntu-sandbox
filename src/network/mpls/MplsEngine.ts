import type { IPAddress, IPv4Packet } from '@/network/core/types';
import { MAX_MPLS_TTL } from './LabelStack';
import { Lfib } from './Lfib';
import { imposeLabels, switchLabelled, type TtlPolicy } from './LabelSwitching';
import type { MplsPacket } from './MplsPacket';

export interface MplsHost {
  sendLabelled(iface: string, nextHop: IPAddress, packet: MplsPacket): void;
  sendUnlabelled(iface: string, nextHop: IPAddress, packet: IPv4Packet): void;
  continueAsIp(inPort: string, packet: IPv4Packet, ttlAccounted: boolean): void;
  expired(inPort: string, packet: MplsPacket): void;
}

export interface MplsCounters {
  labelledIn: number;
  labelledOut: number;
  imposed: number;
  disposed: number;
  expired: number;
  noBinding: number;
  droppedDisabledInterface: number;
}

export class MplsEngine implements TtlPolicy {
  readonly lfib = new Lfib();
  propagateTtl = true;
  readonly counters: MplsCounters = {
    labelledIn: 0, labelledOut: 0, imposed: 0, disposed: 0, expired: 0, noBinding: 0, droppedDisabledInterface: 0,
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
    this.switchedBytes.set(incoming, (this.switchedBytes.get(incoming) ?? 0) + packet.payload.totalLength);
    const decision = switchLabelled(packet, this.lfib, this);
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
      case 'expired':
        this.counters.expired++;
        this.host.expired(inPort, decision.packet);
        return;
      case 'no-binding':
        this.counters.noBinding++;
    }
  }

  tunnel(inPort: string, expired: MplsPacket, error: IPv4Packet): void {
    const restamped = expired.stack.map(entry => ({ ...entry, ttl: MAX_MPLS_TTL }));
    this.receive(inPort, { type: 'mpls', stack: restamped, payload: error });
  }

  bytesSwitched(label: { readonly value: number }): number {
    return this.switchedBytes.get(label.value) ?? 0;
  }

  impose(packet: IPv4Packet, iface: string, nextHop: IPAddress | null): MplsPacket | null {
    if (!this.interfaces.has(iface)) return null;
    const entry = this.lfib.lookupFtn(packet.destinationIP);
    if (entry === undefined || entry.iface !== iface) return null;
    if (nextHop !== null && !entry.nextHop.equals(nextHop)) return null;
    this.counters.imposed++;
    return imposeLabels(packet, entry, this);
  }
}

import type { IPAddress, IPv4Packet } from '@/network/core/types';
import { MAX_MPLS_TTL, makeLabelStackEntry, withBottomOfStack, type LabelStackEntry } from './LabelStack';
import { MplsLabel, MPLS_FIRST_UNRESERVED_LABEL, MPLS_LABEL_MAX } from './MplsLabel';
import { Lfib, type FtnEntry } from './Lfib';
import { imposeLabels, impositionTrafficClass, switchLabelled, type DiffServModel, type TtlPolicy } from './LabelSwitching';
import { carriesIp, type MplsPacket } from './MplsPacket';
import { isEchoRequestPacket } from './oam/EchoAgent';
import type { PseudowirePayload } from '@/network/pw/PseudowirePacket';
import { isGachPayload, type GachPayload } from './tp/GachPacket';

export interface MplsHost {
  sendLabelled(iface: string, nextHop: IPAddress, packet: MplsPacket): void;
  sendUnlabelled(iface: string, nextHop: IPAddress, packet: IPv4Packet): void;
  continueAsIp(inPort: string, packet: IPv4Packet, ttlAccounted: boolean): void;
  continueInVrf(inPort: string, packet: IPv4Packet, vrf: string, ttlAccounted: boolean): void;
  expired(inPort: string, packet: MplsPacket): void;
  echoRequest(inPort: string, packet: MplsPacket): void;
  deliverPseudowire(inPort: string, owner: 'xconnect' | 'vpls', endpoint: string, payload: PseudowirePayload): void;
  deliverGach(inPort: string, delivery: GachDelivery): void;
  deliverTransport(inPort: string, lsp: string, packet: IPv4Packet): void;
}

export interface GachDelivery {
  readonly payload: GachPayload;
  readonly lsp: string | null;
  readonly reason: 'terminated' | 'ttl-expired';
  readonly stack: readonly LabelStackEntry[];
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

export function entropyLabelFor(flowKey: string): MplsLabel {
  let hash = 0x811c9dc5;
  for (let i = 0; i < flowKey.length; i++) hash = Math.imul(hash ^ flowKey.charCodeAt(i), 0x01000193) >>> 0;
  return MplsLabel.of(MPLS_FIRST_UNRESERVED_LABEL + (hash % (MPLS_LABEL_MAX - MPLS_FIRST_UNRESERVED_LABEL + 1)));
}

function flowKeyOf(packet: IPv4Packet): string {
  const transport = packet.payload as { sourcePort?: number; destinationPort?: number } | null;
  return `${packet.sourceIP}|${packet.destinationIP}|${packet.protocol}|${transport?.sourcePort ?? 0}|${transport?.destinationPort ?? 0}`;
}

export class MplsEngine implements TtlPolicy {
  readonly lfib = new Lfib();
  propagateTtl = true;
  entropyLabelCapable = false;
  imposeEntropyLabels = false;
  diffServModel: DiffServModel = 'pipe';
  tunnelTrafficClass = 0;
  private readonly dscpToTrafficClassMap = new Map<number, number>();
  private readonly trafficClassToDscpMap = new Map<number, number>();

  dscpToTrafficClass(dscp: number): number { return this.dscpToTrafficClassMap.get(dscp) ?? 0; }
  trafficClassToDscp(trafficClass: number): number { return this.trafficClassToDscpMap.get(trafficClass) ?? 0; }
  mapDscp(dscp: number, trafficClass: number): void { this.dscpToTrafficClassMap.set(dscp, trafficClass); }
  mapTrafficClass(trafficClass: number, dscp: number): void { this.trafficClassToDscpMap.set(trafficClass, dscp); }
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
      case 'deliver-transport':
        this.counters.disposed++;
        this.host.deliverTransport(inPort, decision.lsp, decision.packet);
        return;
      case 'deliver-gach':
        this.counters.disposed++;
        this.host.deliverGach(inPort, { payload: decision.payload, lsp: decision.lsp, reason: 'terminated', stack: packet.stack });
        return;
      case 'deliver-pw':
        this.counters.disposed++;
        this.host.deliverPseudowire(inPort, decision.owner, decision.endpoint, decision.payload);
        return;
      case 'expired':
        this.counters.expired++;
        if (isGachPayload(packet.payload) && packet.stack[packet.stack.length - 1].label.equals(MplsLabel.GENERIC_ASSOCIATED_CHANNEL)) {
          this.host.deliverGach(inPort, { payload: packet.payload, lsp: null, reason: 'ttl-expired', stack: packet.stack });
          return;
        }
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
    const trafficClass = impositionTrafficClass(packet, this);
    const stack = withBottomOfStack([...this.tunnelEntries(entry, ttl, flowKeyOf(packet), trafficClass), makeLabelStackEntry(vpnLabel, ttl, trafficClass)]);
    this.counters.imposed++;
    return { type: 'mpls', stack, payload: packet };
  }

  imposeUnderlay(
    payload: PseudowirePayload, serviceLabel: MplsLabel, target: IPAddress,
  ): { readonly packet: MplsPacket; readonly iface: string; readonly nextHop: IPAddress } | null {
    const entry = this.lfib.lookupFtn(target);
    if (entry === undefined || !this.interfaces.has(entry.iface)) return null;
    const flowKey = `${payload.frame.srcMAC}|${payload.frame.dstMAC}`;
    const trafficClass = this.tunnelTrafficClass;
    const stack = withBottomOfStack([...this.tunnelEntries(entry, MAX_MPLS_TTL, flowKey, trafficClass), makeLabelStackEntry(serviceLabel, MAX_MPLS_TTL, trafficClass)]);
    this.counters.imposed++;
    return { packet: { type: 'mpls', stack, payload }, iface: entry.iface, nextHop: entry.nextHop };
  }

  lspMtuFor(destination: IPAddress, iface: string): number | undefined {
    const entry = this.lfib.lookupFtn(destination);
    return entry !== undefined && entry.iface === iface && entry.outLabels.length > 0 ? entry.lspMtu : undefined;
  }

  impose(packet: IPv4Packet, iface: string, nextHop: IPAddress | null): MplsPacket | null {
    if (!this.interfaces.has(iface)) return null;
    const entry = this.lfib.lookupFtn(packet.destinationIP);
    if (entry === undefined || entry.iface !== iface || entry.outLabels.length === 0) return null;
    if (nextHop !== null && !entry.nextHop.equals(nextHop)) return null;
    this.counters.imposed++;
    const entropy = this.entropyFor(entry, flowKeyOf(packet));
    return imposeLabels(packet, entry, this, entropy);
  }

  private entropyFor(entry: FtnEntry, flowKey: string): MplsLabel | undefined {
    return this.imposeEntropyLabels && entry.entropyLabelCapable === true && entry.outLabels.length > 0
      ? entropyLabelFor(flowKey) : undefined;
  }

  private tunnelEntries(entry: FtnEntry, ttl: number, flowKey: string, trafficClass: number): LabelStackEntry[] {
    const entries = entry.outLabels.map(label => makeLabelStackEntry(label, ttl, trafficClass));
    const entropy = this.entropyFor(entry, flowKey);
    if (entropy !== undefined) {
      entries.push(makeLabelStackEntry(MplsLabel.ENTROPY_LABEL_INDICATOR, ttl, trafficClass), makeLabelStackEntry(entropy, 0, trafficClass));
    }
    return entries;
  }
}

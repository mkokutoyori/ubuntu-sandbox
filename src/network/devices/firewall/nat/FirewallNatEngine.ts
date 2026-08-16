import type { IPv4Packet } from '../../../core/types';
import {
  getPacketDstPort,
  getPacketSrcPort,
  rewriteDestIP,
  rewriteSrcIP,
} from '../../../nat/rewrite';
import type { ObjectStore } from '../model/ObjectStore';
import type { SessionTranslation } from '../session/SessionTable';
import type { FlowDirection } from '../session/TcpStateMachine';
import type { NatPolicyStore, NatRule } from './NatPolicyStore';

export type NatFailure = 'nat-port-exhausted' | 'nat-no-rule';

export interface NatContext {
  readonly ingressZone: string;
  readonly egressZone: string;
  readonly ingressInterface: string;
  readonly egressInterface: string;
  readonly simulated?: boolean;
}

export interface NatOutcome {
  readonly packet: IPv4Packet;
  readonly translation?: SessionTranslation;
  readonly matchedRuleId?: string;
  readonly failure?: NatFailure;
}

export interface PortRange {
  readonly from: number;
  readonly to: number;
}

export interface FirewallNatEngineDeps {
  objects: ObjectStore;
  policy: NatPolicyStore;
  interfaceAddress: (iface: string) => string | undefined;
  portRange?: PortRange;
}

export interface NatStatistics {
  readonly rulesEvaluated: number;
  readonly translationsCreated: number;
  readonly portExhaustions: number;
  readonly portsInUse: number;
}

const DEFAULT_PORT_RANGE: PortRange = Object.freeze({ from: 1024, to: 65535 });
const ANY = 'any';

export class FirewallNatEngine {
  private readonly deps: FirewallNatEngineDeps;
  private readonly portRange: PortRange;
  private readonly usedPorts = new Map<string, Set<number>>();
  private readonly endpointMappings = new Map<string, number>();
  private rulesEvaluated = 0;
  private translationsCreated = 0;
  private portExhaustions = 0;

  constructor(deps: FirewallNatEngineDeps) {
    this.deps = deps;
    this.portRange = deps.portRange ?? DEFAULT_PORT_RANGE;
  }

  translateOutbound(packet: IPv4Packet, context: NatContext): NatOutcome {
    const rule = this.match(packet, context, 'source');
    if (!rule) return { packet };
    if (rule.noTranslation) return { packet, matchedRuleId: rule.id };

    const translated = this.deps.interfaceAddress(context.egressInterface);
    const target = rule.sourceTranslation?.kind === 'interface-address'
      ? translated
      : rule.sourceTranslation?.translatedAddress?.[0] ?? translated;
    if (target === undefined) return { packet, matchedRuleId: rule.id, failure: 'nat-no-rule' };

    const originalPort = getPacketSrcPort(packet);
    const port = this.mapEndpoint(
      target, packet.sourceIP.toString(), originalPort, context.simulated === true);
    if (port === null) {
      this.portExhaustions++;
      return { packet, matchedRuleId: rule.id, failure: 'nat-port-exhausted' };
    }

    rule.hitCount++;
    rule.byteCount += packet.totalLength;
    this.translationsCreated++;

    return {
      packet: rewriteSrcIP(packet, target, port),
      matchedRuleId: rule.id,
      translation: Object.freeze({
        natRuleId: rule.id,
        originalSource: packet.sourceIP.toString(),
        originalSourcePort: originalPort,
        translatedSource: target,
        translatedSourcePort: port,
        originalDest: packet.destinationIP.toString(),
        originalDestPort: getPacketDstPort(packet),
        translatedDest: packet.destinationIP.toString(),
        translatedDestPort: getPacketDstPort(packet),
      }),
    };
  }

  translateInbound(packet: IPv4Packet, context: NatContext): NatOutcome {
    const rule = this.match(packet, context, 'destination');
    if (!rule) return this.translateInboundBidirectional(packet, context);
    if (rule.noTranslation) return { packet, matchedRuleId: rule.id };

    const translation = rule.destinationTranslation;
    if (!translation) return this.translateInboundBidirectional(packet, context);

    const originalPort = getPacketDstPort(packet);
    const port = translation.translatedPort ?? originalPort;
    const realDest = this.resolveAddress(translation.translatedAddress);

    rule.hitCount++;
    rule.byteCount += packet.totalLength;
    this.translationsCreated++;

    return {
      packet: rewriteDestIP(packet, realDest, port),
      matchedRuleId: rule.id,
      translation: Object.freeze({
        natRuleId: rule.id,
        originalSource: packet.sourceIP.toString(),
        originalSourcePort: getPacketSrcPort(packet),
        translatedSource: packet.sourceIP.toString(),
        translatedSourcePort: getPacketSrcPort(packet),
        originalDest: packet.destinationIP.toString(),
        originalDestPort: originalPort,
        translatedDest: realDest,
        translatedDestPort: port,
      }),
    };
  }

  private translateInboundBidirectional(packet: IPv4Packet, context: NatContext): NatOutcome {
    const rule = this.matchReverse(packet, context);
    if (!rule) return { packet };

    const realAddress = rule.originalSource[0];
    const originalDest = packet.destinationIP.toString();
    const port = getPacketDstPort(packet);

    rule.hitCount++;
    rule.byteCount += packet.totalLength;
    this.translationsCreated++;

    return {
      packet: rewriteDestIP(packet, this.resolveAddress(realAddress), port),
      matchedRuleId: rule.id,
      translation: Object.freeze({
        natRuleId: rule.id,
        originalSource: packet.sourceIP.toString(),
        originalSourcePort: getPacketSrcPort(packet),
        translatedSource: packet.sourceIP.toString(),
        translatedSourcePort: getPacketSrcPort(packet),
        originalDest,
        originalDestPort: port,
        translatedDest: this.resolveAddress(realAddress),
        translatedDestPort: port,
      }),
    };
  }

  private matchReverse(packet: IPv4Packet, context: NatContext): NatRule | undefined {
    const destination = packet.destinationIP.toString();

    for (const rule of this.deps.policy.ordered()) {
      if (!rule.enabled || !rule.bidirectional) continue;
      if (!listMatches(rule.toZone, context.ingressZone)) continue;

      const published = rule.sourceTranslation?.translatedAddress?.[0];
      if (published === undefined) continue;
      if (!this.addressMatches(published, destination)) continue;

      this.rulesEvaluated++;
      return rule;
    }
    return undefined;
  }

  private addressMatches(name: string, candidate: string): boolean {
    if (name === candidate) return true;
    return this.deps.objects.matchesAddress(name, candidate);
  }

  private resolveAddress(name: string): string {
    return this.deps.objects.getAddress(name)?.value ?? name;
  }

  reapply(
    packet: IPv4Packet, translation: SessionTranslation, direction: FlowDirection,
  ): IPv4Packet {
    if (direction === 'c2s') {
      let result = packet;
      if (translation.translatedSource !== translation.originalSource
        || translation.translatedSourcePort !== translation.originalSourcePort) {
        result = rewriteSrcIP(result, translation.translatedSource, translation.translatedSourcePort);
      }
      if (translation.translatedDest !== translation.originalDest
        || translation.translatedDestPort !== translation.originalDestPort) {
        result = rewriteDestIP(result, translation.translatedDest, translation.translatedDestPort);
      }
      return result;
    }

    let result = packet;
    if (translation.translatedSource !== translation.originalSource
      || translation.translatedSourcePort !== translation.originalSourcePort) {
      result = rewriteDestIP(result, translation.originalSource, translation.originalSourcePort);
    }
    if (translation.translatedDest !== translation.originalDest
      || translation.translatedDestPort !== translation.originalDestPort) {
      result = rewriteSrcIP(result, translation.originalDest, translation.originalDestPort);
    }
    return result;
  }

  release(translation: SessionTranslation): void {
    this.usedPorts.get(translation.translatedSource)?.delete(translation.translatedSourcePort);
    this.endpointMappings.delete(endpointKey(
      translation.translatedSource, translation.originalSource, translation.originalSourcePort));
  }

  statistics(): NatStatistics {
    let portsInUse = 0;
    for (const ports of this.usedPorts.values()) portsInUse += ports.size;
    return Object.freeze({
      rulesEvaluated: this.rulesEvaluated,
      translationsCreated: this.translationsCreated,
      portExhaustions: this.portExhaustions,
      portsInUse,
    });
  }

  private match(
    packet: IPv4Packet, context: NatContext, side: 'source' | 'destination',
  ): NatRule | undefined {
    for (const rule of this.deps.policy.ordered()) {
      if (!rule.enabled) continue;
      this.rulesEvaluated++;

      if (!listMatches(rule.fromZone, context.ingressZone)) continue;
      if (context.egressZone !== '' && !listMatches(rule.toZone, context.egressZone)) continue;
      if (!this.deps.objects.matchesAnyAddress(rule.originalSource, packet.sourceIP.toString())) continue;
      if (!this.deps.objects.matchesAnyAddress(rule.originalDestination, packet.destinationIP.toString())) continue;

      if (rule.noTranslation) return rule;
      if (side === 'source' && !rule.sourceTranslation) continue;
      if (side === 'destination' && !rule.destinationTranslation) continue;
      return rule;
    }
    return undefined;
  }

  private mapEndpoint(
    address: string, sourceIP: string, sourcePort: number, simulated: boolean,
  ): number | null {
    const key = endpointKey(address, sourceIP, sourcePort);
    const existing = this.endpointMappings.get(key);
    if (existing !== undefined) return existing;

    const port = this.allocatePort(address, sourcePort, simulated);
    if (port === null || simulated) return port;

    this.endpointMappings.set(key, port);
    return port;
  }

  private allocatePort(address: string, preferred: number, simulated = false): number | null {
    let ports = this.usedPorts.get(address);
    if (!ports) {
      if (simulated) return this.freePortFrom(new Set(), preferred);
      ports = new Set();
      this.usedPorts.set(address, ports);
    }

    const port = this.freePortFrom(ports, preferred);
    if (port !== null && !simulated) ports.add(port);
    return port;
  }

  private freePortFrom(taken: ReadonlySet<number>, preferred: number): number | null {
    if (preferred >= this.portRange.from && preferred <= this.portRange.to
      && !taken.has(preferred)) {
      return preferred;
    }

    for (let port = this.portRange.from; port <= this.portRange.to; port++) {
      if (!taken.has(port)) return port;
    }
    return null;
  }
}

function endpointKey(translatedAddress: string, sourceIP: string, sourcePort: number): string {
  return `${translatedAddress}|${sourceIP}:${sourcePort}`;
}

function listMatches(list: readonly string[], value: string): boolean {
  return list.includes(ANY) || list.includes(value);
}

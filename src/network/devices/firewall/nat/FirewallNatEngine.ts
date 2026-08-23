import type { IPv4Packet } from '../../../core/types';
import {
  getPacketDstPort,
  getPacketSrcPort,
  rewriteDestIP,
  rewriteSrcIP,
} from '../../../nat/rewrite';
import type { ObjectStore } from '../model/ObjectStore';
import type { RealServerPool } from './RealServerPool';
import type { FirewallSession, SessionTranslation } from '../session/SessionTable';
import type { FlowDirection } from '../session/TcpStateMachine';
import { tryIpToUint32, uint32ToIp } from '../../../core/ip';
import type {
  DestinationTranslation, NatPolicyStore, NatRule, PortCriterion, SourceTranslation,
} from './NatPolicyStore';
import type { IpPoolAllocator } from './IpPool';

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
  pools?: IpPoolAllocator;
  portRange?: PortRange;
}

export interface PoolTranslationRequest {
  readonly pool: string;
  readonly fixedPort: boolean;
  readonly simulated: boolean;
  readonly portFrom?: number;
  readonly portTo?: number;
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

    const pool = rule.sourceTranslation?.pool;
    if (pool !== undefined) return this.translateFromPool(packet, rule, pool, context);

    const translated = this.deps.interfaceAddress(context.egressInterface);
    const target = rule.sourceTranslation?.kind === 'interface-address'
      ? translated
      : rule.sourceTranslation?.translatedAddress?.[0] ?? translated;
    if (target === undefined) return { packet, matchedRuleId: rule.id, failure: 'nat-no-rule' };

    const originalPort = getPacketSrcPort(packet);
    const port = this.mapEndpoint(
      target, packet.sourceIP.toString(),
      constrainPort(originalPort, rule.sourceTranslation),
      context.simulated === true);
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

  private translateFromPool(
    packet: IPv4Packet, rule: NatRule, pool: string, context: NatContext,
  ): NatOutcome {
    const outcome = this.allocateFromPool(packet, {
      pool,
      fixedPort: rule.sourceTranslation?.kind === 'static-ip',
      simulated: context.simulated === true,
      portFrom: rule.sourceTranslation?.translatedPortFrom,
      portTo: rule.sourceTranslation?.translatedPortTo,
    });
    if (outcome.failure) return { ...outcome, matchedRuleId: rule.id };

    rule.hitCount++;
    rule.byteCount += packet.totalLength;
    return { ...outcome, matchedRuleId: rule.id };
  }

  allocateFromPool(packet: IPv4Packet, request: PoolTranslationRequest): NatOutcome {
    const allocator = this.deps.pools;
    if (!allocator || allocator.get(request.pool) === undefined) {
      return { packet, failure: 'nat-no-rule' };
    }

    const originalPort = getPacketSrcPort(packet);
    const allocation = allocator.allocate(request.pool, {
      sourceIP: packet.sourceIP.toString(),
      sourcePort: constrainPort(originalPort, {
        kind: 'dynamic-ip-and-port',
        translatedPortFrom: request.portFrom,
        translatedPortTo: request.portTo,
      }),
      fixedPort: request.fixedPort,
      simulated: request.simulated,
    });
    if (allocation === null) {
      this.portExhaustions++;
      return { packet, failure: 'nat-port-exhausted' };
    }

    this.translationsCreated++;
    return {
      packet: rewriteSrcIP(packet, allocation.address, allocation.port),
      translation: Object.freeze({
        natRuleId: request.pool,
        pool: request.pool,
        originalSource: packet.sourceIP.toString(),
        originalSourcePort: originalPort,
        translatedSource: allocation.address,
        translatedSourcePort: allocation.port,
        originalDest: packet.destinationIP.toString(),
        originalDestPort: getPacketDstPort(packet),
        translatedDest: packet.destinationIP.toString(),
        translatedDestPort: getPacketDstPort(packet),
      }),
    };
  }

  hasInboundRule(packet: IPv4Packet, context: NatContext): boolean {
    const rule = this.match(packet, context, 'destination');
    return rule !== undefined && !rule.noTranslation
      && rule.destinationTranslation !== undefined;
  }

  translateInbound(packet: IPv4Packet, context: NatContext): NatOutcome {
    const rule = this.match(packet, context, 'destination');
    if (!rule) return this.translateInboundBidirectional(packet, context);
    if (rule.noTranslation) return { packet, matchedRuleId: rule.id };

    const translation = rule.destinationTranslation;
    if (!translation) return this.translateInboundBidirectional(packet, context);

    const originalPort = getPacketDstPort(packet);
    if (translation.kind === 'load-balance') {
      return this.balanceInbound(rule, translation, packet, originalPort);
    }
    const port = translation.translatedPort ?? originalPort;
    const realDest = this.spreadDestination(translation, packet);

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

  private anyAddressMatches(names: readonly string[], candidate: string): boolean {
    return names.some(name => name === ANY || this.addressMatches(name, candidate));
  }

  private resolveAddress(name: string): string {
    return this.deps.objects.getAddress(name)?.value ?? name;
  }

  private balanceInbound(
    rule: NatRule, translation: DestinationTranslation,
    packet: IPv4Packet, originalPort: number,
  ): NatOutcome {
    const pool = translation.pool === undefined
      ? undefined : this.pools?.(translation.pool);
    const chosen = pool?.pick();
    if (chosen === undefined) return { packet, matchedRuleId: rule.id };

    const port = chosen.port > 0 ? chosen.port : originalPort;
    rule.hitCount++;
    rule.byteCount += packet.totalLength;
    this.translationsCreated++;

    return {
      packet: rewriteDestIP(packet, chosen.address, port),
      matchedRuleId: rule.id,
      translation: Object.freeze({
        natRuleId: rule.id,
        originalSource: packet.sourceIP.toString(),
        originalSourcePort: getPacketSrcPort(packet),
        translatedSource: packet.sourceIP.toString(),
        translatedSourcePort: getPacketSrcPort(packet),
        originalDest: packet.destinationIP.toString(),
        originalDestPort: originalPort,
        translatedDest: chosen.address,
        translatedDestPort: port,
      }),
    };
  }

  setPoolResolver(resolve: (name: string) => RealServerPool | undefined): void {
    this.pools = resolve;
  }

  private pools?: (name: string) => RealServerPool | undefined;

  private spreadDestination(
    translation: DestinationTranslation, packet: IPv4Packet,
  ): string {
    const first = this.resolveAddress(translation.translatedAddress);
    if (translation.translatedEndAddress === undefined) return first;

    const from = tryIpToUint32(first);
    const to = tryIpToUint32(this.resolveAddress(translation.translatedEndAddress));
    const client = tryIpToUint32(packet.sourceIP.toString());
    if (from === null || to === null || client === null || to < from) return first;

    return uint32ToIp((from + (client % (to - from + 1))) >>> 0);
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
    if (translation.pool === undefined) return;
    this.deps.pools?.release(translation.pool, {
      address: translation.translatedSource, port: translation.translatedSourcePort,
    }, translation.originalSource);
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

      if (!sideMatches(rule.fromZone, context.ingressZone, context.ingressInterface)) continue;
      if (context.egressZone !== ''
        && !sideMatches(rule.toZone, context.egressZone, context.egressInterface)) continue;
      if (!this.anyAddressMatches(rule.originalSource, packet.sourceIP.toString())) continue;
      if (!this.anyAddressMatches(
        rule.originalDestination, packet.destinationIP.toString())) continue;
      if (!portMatches(rule.originalPort, packet, getPacketDstPort(packet))) continue;
      if (!portMatches(rule.sourcePort, packet, getPacketSrcPort(packet))) continue;

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

function constrainPort(port: number, translation?: SourceTranslation): number {
  const from = translation?.translatedPortFrom;
  const to = translation?.translatedPortTo ?? from;
  if (from === undefined || to === undefined || to < from) return port;
  if (port >= from && port <= to) return port;
  return from + (port % (to - from + 1));
}

function sideMatches(list: readonly string[], zone: string, iface: string): boolean {
  return listMatches(list, zone) || (iface !== '' && list.includes(iface));
}

function portMatches(
  criterion: PortCriterion | undefined, packet: IPv4Packet, port: number,
): boolean {
  if (criterion === undefined) return true;
  if (criterion.protocol !== 0 && criterion.protocol !== packet.protocol) return false;
  return port >= criterion.from && port <= criterion.to;
}

export function clearVdomTranslations(vdoms: Iterable<{
  sessions: { view(): { all(): readonly FirewallSession[] }; close(s: FirewallSession, r: 'clear'): void };
  nat: { release(translation: NonNullable<FirewallSession['translation']>): void };
}>): number {
  let cleared = 0;
  for (const vdom of vdoms) {
    for (const session of vdom.sessions.view().all()) {
      if (session.translation === undefined) continue;
      vdom.nat.release(session.translation);
      vdom.sessions.close(session, 'clear');
      cleared++;
    }
  }
  return cleared;
}

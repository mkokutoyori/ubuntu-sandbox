import { Continue, Drop, type FilterVerdict } from '../../../../core/FilterChain';
import { IP_PROTO_TCP, type IPv4Packet, type TCPPacket } from '../../../../core/types';
import type { InterfaceTable } from '../../l3/InterfaceTable';
import type { RouteTable } from '../../l3/RouteTable';
import type { ObjectStore } from '../../model/ObjectStore';
import type { PolicyStore } from '../../model/PolicyStore';
import { isDenyAction } from '../../model/SecurityRule';
import type { ZoneTable } from '../../model/ZoneTable';
import type { PolicyEvaluator } from '../../policy/PolicyEvaluator';
import { flowKeyFromPacket } from '../../session/FlowKey';
import type { SessionTable, SessionTranslation } from '../../session/SessionTable';
import { TcpStateMachine, type ObservedTcpFlags } from '../../session/TcpStateMachine';
import type { FirewallNatEngine } from '../../nat/FirewallNatEngine';
import type { NatPolicyStore } from '../../nat/NatPolicyStore';
import type { PacketContext, VerdictReason } from '../PacketContext';
import type { PipelineStage } from '../FirewallPipeline';

export interface FirewallServices {
  zones: ZoneTable;
  interfaces: InterfaceTable;
  routes: RouteTable;
  objects: ObjectStore;
  policy: PolicyStore;
  evaluator: PolicyEvaluator;
  sessions: SessionTable;
  now: () => number;
  natPolicy?: NatPolicyStore;
  nat?: FirewallNatEngine;
  natOrder?: NatOrder;
  defaultTimeoutSec?: number;
  discardTimeoutSec?: number;
}

export interface NatOrder {
  policySeesPreNatSource?: boolean;
  policySeesPreNatDestination?: boolean;
}

const DEFAULT_TIMEOUT_SEC = 3600;
const DISCARD_TIMEOUT_SEC = 5;

const tcpMachines = new WeakMap<object, TcpStateMachine>();
const pendingTranslations = new WeakMap<object, SessionTranslation>();

function deny(
  context: PacketContext, stage: string, reason: VerdictReason, ruleId?: string,
): FilterVerdict<PacketContext> {
  context.verdict = Object.freeze({ action: 'deny' as const, reason, stage, ruleId });
  context.trace.push({ stage, verdict: 'drop', detail: reason, matchedRuleId: ruleId });
  return Drop(reason);
}

function proceed(context: PacketContext, stage: string, detail?: string): FilterVerdict<PacketContext> {
  context.trace.push({ stage, verdict: 'continue', detail });
  return Continue();
}

function ipv4(context: PacketContext): IPv4Packet | undefined {
  return context.packet.type === 'ipv4' ? context.packet : undefined;
}

function tcpFlagsOf(packet: IPv4Packet): ObservedTcpFlags | undefined {
  if (packet.protocol !== IP_PROTO_TCP) return undefined;
  const payload = packet.payload as TCPPacket | null | undefined;
  return payload?.type === 'tcp' ? payload.flags : undefined;
}

export function createCoreStages(services: FirewallServices): PipelineStage[] {
  return [
    ingressZoneStage(services),
    sessionLookupStage(services),
    tcpStateCheckStage(services),
    natDestinationStage(services),
    routeLookupStage(services),
    egressZoneStage(services),
    policyLookupStage(services),
    natSourceStage(services),
    sessionInstallStage(services),
  ];
}

function ingressZoneStage(services: FirewallServices): PipelineStage {
  return {
    name: 'ingress-zone',
    apply(context) {
      const zone = services.zones.zoneOf(context.ingressPort);
      if (zone === undefined) return deny(context, 'ingress-zone', 'zone-mismatch');

      context.ingressZone = zone;
      return proceed(context, 'ingress-zone', zone);
    },
  };
}

function sessionLookupStage(services: FirewallServices): PipelineStage {
  return {
    name: 'session-lookup',
    apply(context) {
      const packet = ipv4(context);
      if (!packet) return proceed(context, 'session-lookup', 'not-ipv4');

      const found = services.sessions.lookup(flowKeyFromPacket(packet));
      if (!found) return proceed(context, 'session-lookup', 'miss');

      context.session = found.session;
      context.sessionDirection = found.direction;
      context.isFirstPacket = false;
      context.egressPort = found.direction === 'c2s'
        ? found.session.egressInterface
        : found.session.ingressInterface;
      context.egressZone = found.direction === 'c2s'
        ? found.session.egressZone
        : found.session.ingressZone;

      if (found.session.state === 'discard') {
        return deny(context, 'session-lookup', 'policy-deny');
      }

      const flags = tcpFlagsOf(packet);
      const machine = found.session.tcpMachine;
      if (flags && machine) {
        const verdict = machine.onPacket(flags, found.direction);
        if (!verdict.accepted) {
          return deny(context, 'session-lookup', verdict.reason as VerdictReason);
        }
        found.session.tcpState = machine.state;
        if (machine.state === 'closed') {
          services.sessions.close(found.session, flags.rst ? 'tcp-rst' : 'tcp-fin');
          context.trace.push({ stage: 'session-lookup', verdict: 'closed' });
          context.verdict = Object.freeze({
            action: 'accept' as const, reason: 'policy-deny' as VerdictReason, stage: 'session-lookup',
          });
          return { kind: 'accept', payload: context };
        }
        services.sessions.setTimeout(found.session, machine.timeoutSec);
      }

      services.sessions.recordTraffic(found.session, found.direction, packet.totalLength);

      const translation = found.session.translation;
      if (translation && services.nat) {
        context.packet = services.nat.reapply(packet, translation, found.direction);
      }

      context.trace.push({ stage: 'session-lookup', verdict: 'fastpath' });
      context.verdict = Object.freeze({
        action: 'accept' as const, reason: 'policy-deny' as VerdictReason, stage: 'session-lookup',
      });
      return { kind: 'accept', payload: context };
    },
  };
}

function tcpStateCheckStage(_services: FirewallServices): PipelineStage {
  return {
    name: 'tcp-state-check',
    apply(context) {
      const packet = ipv4(context);
      const flags = packet ? tcpFlagsOf(packet) : undefined;
      if (!packet || !flags) return proceed(context, 'tcp-state-check', 'not-tcp');

      const machine = new TcpStateMachine();
      const verdict = machine.onFirstPacket(flags);
      if (!verdict.accepted) {
        return deny(context, 'tcp-state-check', verdict.reason as VerdictReason);
      }

      tcpMachines.set(context, machine);
      return proceed(context, 'tcp-state-check', machine.state);
    },
  };
}

function natContextOf(context: PacketContext) {
  return {
    ingressZone: context.ingressZone ?? '',
    egressZone: context.egressZone ?? '',
    ingressInterface: context.ingressPort,
    egressInterface: context.egressPort ?? '',
    simulated: context.simulated,
  };
}

function natDestinationStage(services: FirewallServices): PipelineStage {
  return {
    name: 'nat-destination',
    apply(context) {
      const packet = ipv4(context);
      if (!packet || !services.nat) return proceed(context, 'nat-destination', 'no-nat');

      const outcome = services.nat.translateInbound(packet, natContextOf(context));
      if (!outcome.translation) return proceed(context, 'nat-destination', 'no-match');

      context.packet = outcome.packet;
      pendingTranslations.set(context, outcome.translation);
      return proceed(context, 'nat-destination', outcome.matchedRuleId);
    },
  };
}

function natSourceStage(services: FirewallServices): PipelineStage {
  return {
    name: 'nat-source',
    apply(context) {
      const packet = ipv4(context);
      if (!packet || !services.nat) return proceed(context, 'nat-source', 'no-nat');

      const outcome = services.nat.translateOutbound(packet, natContextOf(context));
      if (outcome.failure === 'nat-port-exhausted') {
        return deny(context, 'nat-source', 'nat-port-exhausted');
      }
      if (!outcome.translation) return proceed(context, 'nat-source', 'no-match');

      context.packet = outcome.packet;
      pendingTranslations.set(context, mergeTranslations(pendingTranslations.get(context), outcome.translation));
      return proceed(context, 'nat-source', outcome.matchedRuleId);
    },
  };
}

function mergeTranslations(
  existing: SessionTranslation | undefined, added: SessionTranslation,
): SessionTranslation {
  if (!existing) return added;
  return Object.freeze({
    natRuleId: existing.natRuleId,
    originalSource: added.originalSource,
    originalSourcePort: added.originalSourcePort,
    translatedSource: added.translatedSource,
    translatedSourcePort: added.translatedSourcePort,
    originalDest: existing.originalDest,
    originalDestPort: existing.originalDestPort,
    translatedDest: existing.translatedDest,
    translatedDestPort: existing.translatedDestPort,
  });
}

function routeLookupStage(services: FirewallServices): PipelineStage {
  return {
    name: 'route-lookup',
    apply(context) {
      const packet = ipv4(context);
      if (!packet) return proceed(context, 'route-lookup', 'not-ipv4');

      const resolved = services.routes.resolveNextHop(packet.destinationIP.toString());
      if (!resolved) return deny(context, 'route-lookup', 'no-route');

      context.egressPort = resolved.iface;
      return proceed(context, 'route-lookup', resolved.iface);
    },
  };
}

function egressZoneStage(services: FirewallServices): PipelineStage {
  return {
    name: 'egress-zone',
    apply(context) {
      if (context.egressPort === undefined) return proceed(context, 'egress-zone', 'no-egress');

      const zone = services.zones.zoneOf(context.egressPort);
      if (zone === undefined) return deny(context, 'egress-zone', 'zone-mismatch');

      context.egressZone = zone;
      return proceed(context, 'egress-zone', zone);
    },
  };
}

function policyLookupStage(services: FirewallServices): PipelineStage {
  return {
    name: 'policy-lookup',
    apply(context) {
      const packet = ipv4(context);
      if (!packet) return proceed(context, 'policy-lookup', 'not-ipv4');

      const decision = services.evaluator.evaluate(
        services.policy.ordered(),
        {
          ingressZone: context.ingressZone ?? '',
          egressZone: context.egressZone ?? '',
          ingressInterface: context.ingressPort,
          egressInterface: context.egressPort ?? '',
          sourceIP: policySource(context, packet, services).sourceIP.toString(),
          destIP: policyDestination(context, packet, services).destinationIP.toString(),
          protocol: packet.protocol,
          ...transportPorts(policyDestination(context, packet, services)),
          application: context.identifiedApplication,
        },
        packet.totalLength,
      );

      context.matchedPolicy = decision.rule;

      if (isDenyAction(decision.action)) {
        installDiscard(services, context, packet);
        return deny(context, 'policy-lookup',
          decision.implicit ? 'implicit-deny' : 'policy-deny',
          decision.implicit ? undefined : decision.rule.id);
      }

      context.trace.push({
        stage: 'policy-lookup', verdict: 'match', matchedRuleId: decision.rule.id,
      });
      return Continue();
    },
  };
}

function sessionInstallStage(services: FirewallServices): PipelineStage {
  return {
    name: 'session-install',
    apply(context) {
      const packet = ipv4(context);
      if (!packet) return proceed(context, 'session-install', 'not-ipv4');
      if (!context.isFirstPacket) return proceed(context, 'session-install', 'already');
      if (context.simulated) return proceed(context, 'session-install', 'simulated');

      if (!services.sessions.hasRoom()) {
        return deny(context, 'session-install', 'session-table-full');
      }

      const session = services.sessions.install(flowKeyFromPacket(packet), {
        ingressZone: context.ingressZone ?? '',
        egressZone: context.egressZone ?? '',
        ingressInterface: context.ingressPort,
        egressInterface: context.egressPort ?? '',
        timeoutSec: services.defaultTimeoutSec ?? DEFAULT_TIMEOUT_SEC,
        policyId: context.matchedPolicy?.id,
        tcpState: tcpMachines.get(context)?.state,
      });
      session.tcpMachine = tcpMachines.get(context);

      const translation = pendingTranslations.get(context);
      if (translation) {
        session.translation = translation;
        session.natRuleId = translation.natRuleId;
      }

      services.sessions.recordTraffic(session, 'c2s', packet.totalLength);
      context.session = session;
      context.sessionDirection = 'c2s';
      return proceed(context, 'session-install', String(session.id));
    },
  };
}

function installDiscard(
  services: FirewallServices, context: PacketContext, packet: IPv4Packet,
): void {
  if (context.simulated) return;
  if (!context.isFirstPacket || !services.sessions.hasRoom()) return;

  services.sessions.installDiscard(flowKeyFromPacket(packet), {
    ingressZone: context.ingressZone ?? '',
    egressZone: context.egressZone ?? '',
    ingressInterface: context.ingressPort,
    egressInterface: context.egressPort ?? '',
    timeoutSec: services.discardTimeoutSec ?? DISCARD_TIMEOUT_SEC,
    policyId: context.matchedPolicy?.id,
  });
}

function policySource(
  context: PacketContext, packet: IPv4Packet, services: FirewallServices,
): IPv4Packet {
  if (services.natOrder?.policySeesPreNatSource === false) return packet;
  const original = context.originalPacket;
  return original.type === 'ipv4' ? original : packet;
}

function policyDestination(
  context: PacketContext, packet: IPv4Packet, services: FirewallServices,
): IPv4Packet {
  if (!services.natOrder?.policySeesPreNatDestination) return packet;
  const original = context.originalPacket;
  return original.type === 'ipv4' ? original : packet;
}

function transportPorts(packet: IPv4Packet): { sourcePort?: number; destPort?: number } {
  const payload = packet.payload as { type?: string; sourcePort?: number; destinationPort?: number } | null;
  if (payload && (payload.type === 'tcp' || payload.type === 'udp')) {
    return { sourcePort: payload.sourcePort, destPort: payload.destinationPort };
  }
  return {};
}

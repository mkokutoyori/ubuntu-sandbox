import { Continue, Drop, type FilterVerdict } from '../../../../core/FilterChain';
import { decrementForForwarding } from '../../../../layers/internet/InternetLayer';
import { getPacketDstPort, getPacketSrcPort, rewriteSrcIP } from '../../../../nat/rewrite';
import {
  IP_PROTO_TCP,
  type IPv4Packet, type MACAddress, type TCPPacket,
} from '../../../../core/types';
import { IPV4_FLAG_DF } from '../../../../core/Ipv4Fragmentation';
import type { InterfaceTable } from '../../l3/InterfaceTable';
import type { RouteTable } from '../../l3/RouteTable';
import type { ObjectStore } from '../../model/ObjectStore';
import type { PolicyStore } from '../../model/PolicyStore';
import { isDenyAction, type SecurityRule } from '../../model/SecurityRule';
import {
  inspectTls, protocolOfFlow, scanAntivirus, scanApplicationControl,
  scanDnsFilter, scanFileFilter,
  scanWebFilter, scanWebFilterHost,
  type InspectedFlow, type UtmVerdict, type UtmVerdictKind,
} from '../../inspection/ContentInspector';
import type { ProtocolOptions, UtmProfileStore } from '../../inspection/UtmProfiles';
import type { IdentityTable } from '../../identity/IdentityTable';
import type { ZoneTable } from '../../model/ZoneTable';
import type { PolicyEvaluator } from '../../policy/PolicyEvaluator';
import { transportPorts } from '../../policy/probeFields';
import { dosFinding } from '../../dos/DosGate';
import type { DosPolicyStore } from '../../dos/DosPolicyStore';
import type { DosFinding, DosSensor } from '../../dos/DosSensor';
import { flowKeyFromPacket, reverseFlowKey, type FlowKey } from '../../session/FlowKey';
import type { AssembledStream } from '../../inspection/StreamAssembler';
import type { SessionTable, SessionTranslation } from '../../session/SessionTable';
import { TcpStateMachine, type ObservedTcpFlags } from '../../session/TcpStateMachine';
import type { FirewallNatEngine } from '../../nat/FirewallNatEngine';
import type { NatPolicyStore } from '../../nat/NatPolicyStore';
import type { PolicyRouteTable } from '../../l3/PolicyRouteTable';
import type { PacketContext, VerdictReason } from '../PacketContext';
import type { PipelineStage } from '../FirewallPipeline';

export interface VdomServices {
  name: string;
  zones: ZoneTable;
  routes: RouteTable;
  objects: ObjectStore;
  policy: PolicyStore;
  evaluator: PolicyEvaluator;
  sessions: SessionTable;
  natPolicy?: NatPolicyStore;
  nat?: FirewallNatEngine;
  policyRoutes?: PolicyRouteTable;
  utm?: UtmProfileStore;
  identities?: IdentityTable;
  centralNat?: boolean;
  opmode?: 'nat' | 'transparent';
  dos?: DosPolicyStore;
  dosSensor?: DosSensor;
}

export interface HaStandby {
  forwardsTransit(): boolean;
}

export interface SdwanSteering {
  steer(
    probe: { readonly sourceIP: string; readonly destinationIP: string },
    matchesAddress: (names: readonly string[], candidate: string) => boolean,
  ): { iface: string; gateway: string; ruleId: string } | undefined;
}

export interface FirewallServices {
  interfaces: InterfaceTable;
  sdwan?: () => SdwanSteering | undefined;
  ha?: () => HaStandby | undefined;
  now: () => number;
  vdomOf: (iface: string) => VdomServices;
  natOrder?: NatOrder;
  policyKeyedBy?: 'zone' | 'interface';
  bridgedWith?: (ingress: string, egress: string) => boolean;
  macLookup?: (destination: MACAddress, ingress: string) => string | undefined;
  defaultTimeoutSec?: number;
  discardTimeoutSec?: number;
  refusesNewSessions?: () => boolean;
  proxyInspectionPosture?: () => 'normal' | 'bypass' | 'block';
  flowInspectionPosture?: () => 'normal' | 'bypass' | 'block';
  assembleStream?: StreamJoiner;
  onInspection?: () => void;
  onDosAnomaly?: (finding: DosFinding, iface: string, packet: IPv4Packet) => void;
}

function vdom(services: FirewallServices, context: PacketContext): VdomServices {
  return services.vdomOf(context.ingressPort);
}

export type StreamJoiner = (
  key: FlowKey, chunk: string, limitMb: number,
) => AssembledStream;

export interface NatOrder {
  natIsPolicyField?: boolean;
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

function sessionPolicy(
  services: FirewallServices, context: PacketContext, session: { policyId?: string },
): SecurityRule | undefined {
  if (session.policyId === undefined) return undefined;
  return vdom(services, context).policy.ordered().find(rule => rule.id === session.policyId);
}

function originalIpv4(context: PacketContext): IPv4Packet | undefined {
  return context.originalPacket.type === 'ipv4' ? context.originalPacket : undefined;
}

function tcpFlagsOf(packet: IPv4Packet): ObservedTcpFlags | undefined {
  if (packet.protocol !== IP_PROTO_TCP) return undefined;
  const payload = packet.payload as TCPPacket | null | undefined;
  return payload?.type === 'tcp' ? payload.flags : undefined;
}

export function createCoreStages(services: FirewallServices): PipelineStage[] {
  return [
    haStandbyStage(services),
    vdomBindStage(services),
    switchBridgeStage(services),
    ingressZoneStage(services),
    dosPolicyStage(services),
    sessionLookupStage(services),
    tcpStateCheckStage(services),
    natDestinationStage(services),
    policyRouteStage(services),
    sdwanRuleStage(services),
    macLookupStage(services),
    routeLookupStage(services),
    ttlDecrementStage(services),
    mtuCheckStage(services),
    egressZoneStage(services),
    policyLookupStage(services),
    authCheckStage(services),
    utmInspectStage(services),
    natSourceStage(services),
    sessionInstallStage(services),
  ];
}

function authCheckStage(services: FirewallServices): PipelineStage {
  return {
    name: 'auth-check',
    apply(context) {
      return checkIdentity(services, context, context.matchedPolicy);
    },
  };
}

function checkIdentity(
  services: FirewallServices, context: PacketContext, rule: SecurityRule | undefined,
): FilterVerdict<PacketContext> {
  const required = requiredIdentities(rule);
  if (!required) return proceed(context, 'auth-check', 'no-auth');

  const identities = vdom(services, context).identities;
  const packet = ipv4(context);
  if (!identities || !packet) return proceed(context, 'auth-check', 'no-identity-table');

  const source = (originalIpv4(context) ?? packet).sourceIP.toString();
  const identity = identities.lookup(source);
  if (!identity) return deny(context, 'auth-check', 'auth-required', rule?.id);

  if (required.users.length > 0 && required.users.includes(identity.user)) {
    context.authenticatedUser = identity.user;
    identities.touch(source, 'in', packet.totalLength);
    return proceed(context, 'auth-check', identity.user);
  }

  if (required.groups.some(group => identity.groups.includes(group))) {
    context.authenticatedUser = identity.user;
    identities.touch(source, 'in', packet.totalLength);
    return proceed(context, 'auth-check', identity.user);
  }

  return deny(context, 'auth-check', 'auth-required', rule?.id);
}

function requiredIdentities(
  rule: SecurityRule | undefined,
): { groups: readonly string[]; users: readonly string[] } | undefined {
  const groups = rule?.authGroups ?? [];
  const users = rule?.authUsers ?? [];
  if (groups.length === 0 && users.length === 0) return undefined;
  return { groups, users };
}

function utmInspectStage(services: FirewallServices): PipelineStage {
  return {
    name: 'utm-inspect',
    apply(context) {
      return inspectUtm(services, context, context.matchedPolicy, 'utm-inspect');
    },
  };
}

function inspectUtm(
  services: FirewallServices, context: PacketContext,
  rule: SecurityRule | undefined, stage: string,
): FilterVerdict<PacketContext> {
  if (rule?.utmEnabled !== true) return proceed(context, stage, 'utm-disabled');

  if (rule.inspectionMode === 'proxy') {
    const posture = services.proxyInspectionPosture?.() ?? 'normal';
    if (posture === 'bypass') return proceed(context, stage, 'av-failopen-pass');
    if (posture === 'block') return deny(context, stage, 'av-failopen-off', rule.id);
  } else {
    const posture = services.flowInspectionPosture?.() ?? 'normal';
    if (posture === 'bypass') return proceed(context, stage, 'ips-fail-open');
    if (posture === 'block') return deny(context, stage, 'ips-fail-closed', rule.id);
  }

  const packet = ipv4(context);
  const profiles = vdom(services, context).utm;
  if (!packet || !profiles) return proceed(context, stage, 'no-profiles');

  const options = profiles.getProtocolOptions(rule.protocolOptions);
  const flow = inspectedFlowOf(packet, options, services.assembleStream);
  if (!flow) return proceed(context, stage, 'no-payload');
  if (flow.oversize && options.blockOversize) {
    return deny(context, stage, 'oversize-blocked', rule.id);
  }
  services.onInspection?.();

  const ssl = rule.sslSshProfile === undefined
    ? undefined
    : profiles.getSslSsh(rule.sslSshProfile);
  const sni = ssl ? inspectTls(flow, ssl) : undefined;
  if (sni !== undefined) context.inspectedSni = sni;

  const verdict = firstBlocking(flow, rule, profiles, sni);
  if (!verdict) return proceed(context, stage, 'clean');

  context.utmVerdict = verdict;
  if (!verdict.blocked) return proceed(context, stage, `monitor:${verdict.detail}`);
  return deny(context, stage, UTM_REASON[verdict.kind], rule.id);
}

const UTM_REASON: Readonly<Record<UtmVerdictKind, VerdictReason>> = Object.freeze({
  clean: 'profile-block',
  virus: 'utm-virus',
  'url-blocked': 'utm-url',
  'category-blocked': 'utm-category',
  'dns-blocked': 'utm-dns',
  'file-type-blocked': 'utm-file-type',
  'application-blocked': 'utm-application',
});

function firstBlocking(
  flow: InspectedFlow, rule: SecurityRule, profiles: UtmProfileStore,
  sni: string | undefined,
): UtmVerdict | undefined {
  const scans: Array<UtmVerdict | undefined> = [];

  const antivirus = rule.antivirusProfile === undefined
    ? undefined
    : profiles.getAntivirus(rule.antivirusProfile);
  if (antivirus) scans.push(scanAntivirus(flow, antivirus));

  const web = rule.webFilterProfile === undefined
    ? undefined
    : profiles.getWebFilter(rule.webFilterProfile);
  if (web && flow.protocol === 'http') {
    scans.push(scanWebFilter(flow, web, profiles.urlFiltersOf(web)));
  }
  if (web && flow.protocol === 'https' && sni !== undefined) {
    scans.push(scanWebFilterHost(sni, web, profiles.urlFiltersOf(web)));
  }

  const dns = rule.dnsFilterProfile === undefined
    ? undefined
    : profiles.getDnsFilter(rule.dnsFilterProfile);
  if (dns && flow.protocol === 'dns') {
    scans.push(scanDnsFilter(flow, dns, profiles.domainFiltersOf(dns)));
  }

  const file = rule.fileFilterProfile === undefined
    ? undefined
    : profiles.getFileFilter(rule.fileFilterProfile);
  if (file) scans.push(scanFileFilter(flow, file));

  const applications = rule.applicationList === undefined
    ? undefined
    : profiles.getApplicationList(rule.applicationList);
  if (applications) scans.push(scanApplicationControl(flow, applications));

  return scans.find(verdict => verdict !== undefined && verdict.kind !== 'clean');
}

function inspectedFlowOf(
  packet: IPv4Packet, options: ProtocolOptions, assemble?: StreamJoiner,
): InspectedFlow | undefined {
  const payload = packet.payload as
    { type?: string; sourcePort?: number; destinationPort?: number; payload?: unknown } | null;
  if (payload?.type !== 'tcp' && payload?.type !== 'udp') return undefined;

  const text = payloadText(payload.payload);
  if (text === undefined || text.length === 0) return undefined;

  const stream = assemble?.(flowKeyFromPacket(packet), text, options.oversizeLimitMb);
  const sourcePort = payload.sourcePort ?? 0;
  const destinationPort = payload.destinationPort ?? 0;
  return Object.freeze({
    protocol: protocolOfFlow(sourcePort, destinationPort, options),
    sourcePort,
    destinationPort,
    payload: stream?.payload ?? text,
    oversize: stream?.oversize === true,
    bytes: payload.payload instanceof Uint8Array ? payload.payload : undefined,
  });
}

function payloadText(payload: unknown): string | undefined {
  if (typeof payload === 'string') return payload;
  if (payload instanceof Uint8Array) {
    return Array.from(payload).map(byte => String.fromCharCode(byte)).join('');
  }
  if (payload !== null && typeof payload === 'object') return JSON.stringify(payload);
  return undefined;
}

function haStandbyStage(services: FirewallServices): PipelineStage {
  return {
    name: 'ha-standby',
    apply(context) {
      const ha = services.ha?.();
      if (!ha || ha.forwardsTransit()) return proceed(context, 'ha-standby', 'forwarding');
      return deny(context, 'ha-standby', 'ha-subordinate');
    },
  };
}

function vdomBindStage(services: FirewallServices): PipelineStage {
  return {
    name: 'vdom-bind',
    apply(context) {
      context.vdom = vdom(services, context).name;
      return proceed(context, 'vdom-bind', context.vdom);
    },
  };
}

function switchBridgeStage(services: FirewallServices): PipelineStage {
  return {
    name: 'switch-bridge',
    apply(context) {
      const bridged = services.bridgedWith;
      if (!bridged) return proceed(context, 'switch-bridge', 'no-switch-interface');

      const egress = services.interfaces.names()
        .find(iface => iface !== context.ingressPort && bridged(context.ingressPort, iface));
      if (egress === undefined) return proceed(context, 'switch-bridge', 'not-bridged');

      context.egressPort = egress;
      context.bridged = true;
      context.trace.push({ stage: 'switch-bridge', verdict: 'bridged', detail: egress });
      context.verdict = Object.freeze({
        action: 'accept' as const, reason: 'policy-deny' as VerdictReason,
        stage: 'switch-bridge',
      });
      return { kind: 'accept', payload: context };
    },
  };
}

function macLookupStage(services: FirewallServices): PipelineStage {
  return {
    name: 'mac-lookup',
    apply(context) {
      if (vdom(services, context).opmode !== 'transparent') {
        return proceed(context, 'mac-lookup', 'not-transparent');
      }

      const frame = context.ingressFrameDestination;
      const egress = frame === undefined
        ? undefined
        : services.macLookup?.(frame, context.ingressPort);
      if (egress === undefined) return proceed(context, 'mac-lookup', 'flood');

      context.egressPort = egress;
      return proceed(context, 'mac-lookup', egress);
    },
  };
}

function zoneNameFor(services: FirewallServices, iface: string): string | undefined {
  const zone = services.vdomOf(iface).zones.zoneOf(iface);
  if (zone !== undefined) return zone;
  return services.policyKeyedBy === 'interface' ? iface : undefined;
}

function ingressZoneStage(services: FirewallServices): PipelineStage {
  return {
    name: 'ingress-zone',
    apply(context) {
      const zone = zoneNameFor(services, context.ingressPort);
      if (zone === undefined) return deny(context, 'ingress-zone', 'zone-mismatch');

      context.ingressZone = zone;
      return proceed(context, 'ingress-zone', zone);
    },
  };
}

function dosPolicyStage(services: FirewallServices): PipelineStage {
  return {
    name: 'dos-policy',
    apply(context) {
      const packet = ipv4(context);
      if (!packet) return proceed(context, 'dos-policy', 'not-ipv4');

      const scope = vdom(services, context);
      if (!scope.dos || !scope.dosSensor) {
        return proceed(context, 'dos-policy', 'no-sensor');
      }
      const finding = dosFinding({
        policies: scope.dos,
        evaluator: scope.evaluator,
        sensor: scope.dosSensor,
        zoneOf: (iface) => zoneNameFor(services, iface) ?? '',
      }, context.ingressPort, packet);
      if (!finding) return proceed(context, 'dos-policy', 'no-anomaly');

      services.onDosAnomaly?.(finding, context.ingressPort, packet);
      if (finding.action === 'pass') {
        return proceed(context, 'dos-policy', `${finding.anomaly}:pass`);
      }
      return deny(context, 'dos-policy', 'dos-anomaly', finding.anomaly);
    },
  };
}

function sessionLookupStage(services: FirewallServices): PipelineStage {
  return {
    name: 'session-lookup',
    apply(context) {
      const packet = ipv4(context);
      if (!packet) return proceed(context, 'session-lookup', 'not-ipv4');

      const found = vdom(services, context).sessions.lookup(flowKeyFromPacket(packet));
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
          vdom(services, context).sessions.close(found.session, flags.rst ? 'tcp-rst' : 'tcp-fin');
          context.trace.push({ stage: 'session-lookup', verdict: 'closed' });
          context.verdict = Object.freeze({
            action: 'accept' as const, reason: 'policy-deny' as VerdictReason, stage: 'session-lookup',
          });
          return { kind: 'accept', payload: context };
        }
        vdom(services, context).sessions.setTimeout(found.session, machine.timeoutSec);
      }

      vdom(services, context).sessions.recordTraffic(found.session, found.direction, packet.totalLength);

      const carried = sessionPolicy(services, context, found.session);
      if (carried !== undefined) context.matchedPolicy = carried;
      if (carried?.utmEnabled === true) {
        const inspected = inspectUtm(services, context, carried, 'utm-inspect');
        if (inspected.kind === 'drop') return inspected;
      }

      const translation = found.session.translation;
      if (translation && vdom(services, context).nat) {
        context.packet = vdom(services, context).nat.reapply(packet, translation, found.direction);
      }

      const expired = transitTtl(services, context, 'session-lookup');
      if (expired) return expired;

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

function applyPolicyNat(
  services: FirewallServices, context: PacketContext, packet: IPv4Packet,
): FilterVerdict<PacketContext> {
  if (context.matchedPolicy?.natEnabled !== true) {
    return proceed(context, 'nat-source', 'policy-no-nat');
  }

  const pool = context.matchedPolicy.natPool;
  if (pool !== undefined && vdom(services, context).nat) {
    const outcome = vdom(services, context).nat.allocateFromPool(packet, {
      pool,
      fixedPort: context.matchedPolicy.fixedPort === true,
      simulated: context.simulated,
    });
    if (outcome.failure === 'nat-port-exhausted') {
      return deny(context, 'nat-source', 'nat-port-exhausted', context.matchedPolicy.id);
    }
    if (outcome.failure) {
      return deny(context, 'nat-source', 'nat-no-rule', context.matchedPolicy.id);
    }

    context.packet = outcome.packet;
    pendingTranslations.set(context,
      mergeTranslations(pendingTranslations.get(context), outcome.translation!));
    return proceed(context, 'nat-source', `${context.matchedPolicy.id}:${pool}`);
  }

  const egress = context.egressPort;
  const address = egress === undefined ? undefined : services.interfaces.get(egress)?.ip;
  if (address === undefined) return proceed(context, 'nat-source', 'no-egress-address');

  const originalPort = getPacketSrcPort(packet);
  context.packet = rewriteSrcIP(packet, address, originalPort);
  pendingTranslations.set(context, mergeTranslations(pendingTranslations.get(context), {
    natRuleId: context.matchedPolicy.id,
    originalSource: packet.sourceIP.toString(),
    originalSourcePort: originalPort,
    translatedSource: address,
    translatedSourcePort: originalPort,
    originalDest: packet.destinationIP.toString(),
    originalDestPort: getPacketDstPort(packet),
    translatedDest: packet.destinationIP.toString(),
    translatedDestPort: getPacketDstPort(packet),
  }));
  return proceed(context, 'nat-source', context.matchedPolicy.id);
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
      if (!packet || !vdom(services, context).nat) return proceed(context, 'nat-destination', 'no-nat');

      const outcome = vdom(services, context).nat.translateInbound(packet, natContextOf(context));
      if (!outcome.translation) return proceed(context, 'nat-destination', 'no-match');

      context.packet = outcome.packet;
      context.destinationTranslated = true;
      context.destinationNatRuleId = outcome.matchedRuleId;
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
      if (!packet || !vdom(services, context).nat) return proceed(context, 'nat-source', 'no-nat');

      if (services.natOrder?.natIsPolicyField && vdom(services, context).centralNat !== true) {
        return applyPolicyNat(services, context, packet);
      }

      const outcome = vdom(services, context).nat.translateOutbound(packet, natContextOf(context));
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
    pool: added.pool ?? existing.pool,
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

function policyRouteStage(services: FirewallServices): PipelineStage {
  return {
    name: 'policy-route',
    apply(context) {
      const packet = ipv4(context);
      const table = vdom(services, context).policyRoutes;
      if (!packet || !table || table.size() === 0) {
        return proceed(context, 'policy-route', 'no-policy-route');
      }

      const ports = transportPorts(packet);
      const decision = table.evaluate({
        ingressInterface: context.ingressPort,
        sourceIP: packet.sourceIP.toString(),
        destinationIP: packet.destinationIP.toString(),
        protocol: packet.protocol,
        sourcePort: ports.sourcePort ?? 0,
        destinationPort: ports.destPort ?? 0,
      });
      if (!decision) return proceed(context, 'policy-route', 'no-match');

      context.policyRouteId = decision.route.id;
      if (decision.action === 'deny') {
        return proceed(context, 'policy-route', `${decision.route.id}:routing-table`);
      }
      if (decision.outputDevice === undefined) {
        return proceed(context, 'policy-route', `${decision.route.id}:no-device`);
      }
      if (!services.interfaces.isUp(decision.outputDevice)) {
        return deny(context, 'policy-route', 'interface-down', decision.route.id);
      }

      context.egressPort = decision.outputDevice;
      context.policyRouteGateway = decision.gateway;
      return proceed(context, 'policy-route', decision.route.id);
    },
  };
}

function sdwanRuleStage(services: FirewallServices): PipelineStage {
  return {
    name: 'sdwan',
    apply(context) {
      const packet = ipv4(context);
      const steering = services.sdwan?.();
      if (!packet || !steering || context.egressPort !== undefined) {
        return proceed(context, 'sdwan', 'no-sdwan-rule');
      }

      const objects = vdom(services, context).objects;
      const chosen = steering.steer({
        sourceIP: packet.sourceIP.toString(),
        destinationIP: packet.destinationIP.toString(),
      }, (names, candidate) => objects.matchesAnyAddress(names, candidate));
      if (!chosen) return proceed(context, 'sdwan', 'no-match');
      if (!services.interfaces.isUp(chosen.iface)) {
        return proceed(context, 'sdwan', `${chosen.ruleId}:interface-down`);
      }

      context.egressPort = chosen.iface;
      context.policyRouteId = `sdwan-${chosen.ruleId}`;
      context.policyRouteGateway = chosen.gateway;
      return proceed(context, 'sdwan', chosen.ruleId);
    },
  };
}

function routeLookupStage(services: FirewallServices): PipelineStage {
  return {
    name: 'route-lookup',
    apply(context) {
      const packet = ipv4(context);
      if (!packet) return proceed(context, 'route-lookup', 'not-ipv4');
      if (context.egressPort !== undefined && context.policyRouteId !== undefined) {
        return proceed(context, 'route-lookup', 'policy-routed');
      }

      const resolved = vdom(services, context).routes.resolveNextHop(packet.destinationIP.toString());
      if (!resolved) return deny(context, 'route-lookup', 'no-route');

      context.egressPort = resolved.iface;
      return proceed(context, 'route-lookup', resolved.iface);
    },
  };
}

function transitTtl(
  services: FirewallServices, context: PacketContext, stage: string,
): FilterVerdict<PacketContext> | null {
  const packet = ipv4(context);
  if (!packet) return null;
  if (context.egressPort === undefined) return null;
  if (vdom(services, context).opmode === 'transparent') return null;
  const decision = decrementForForwarding(packet);
  if (decision.kind === 'expired') return deny(context, stage, 'ttl-expired');

  context.packet = decision.packet;
  return null;
}

function ttlDecrementStage(services: FirewallServices): PipelineStage {
  return {
    name: 'ttl-decrement',
    apply(context) {
      const expired = transitTtl(services, context, 'ttl-decrement');
      if (expired) return expired;
      const packet = ipv4(context);
      return proceed(context, 'ttl-decrement', packet ? String(packet.ttl) : 'not-ipv4');
    },
  };
}

function mtuCheckStage(services: FirewallServices): PipelineStage {
  return {
    name: 'mtu-check',
    apply(context) {
      const packet = ipv4(context);
      if (!packet) return proceed(context, 'mtu-check', 'not-ipv4');
      if (context.egressPort === undefined) return proceed(context, 'mtu-check', 'no-egress');

      const mtu = services.interfaces.get(context.egressPort)?.mtu;
      if (mtu === undefined || packet.totalLength <= mtu) {
        return proceed(context, 'mtu-check', String(mtu ?? 'unknown'));
      }
      if ((packet.flags & IPV4_FLAG_DF) === 0) {
        return proceed(context, 'mtu-check', `fragment-${mtu}`);
      }
      context.egressMtu = mtu;
      return deny(context, 'mtu-check', 'mtu-exceeded-df');
    },
  };
}

function egressZoneStage(services: FirewallServices): PipelineStage {
  return {
    name: 'egress-zone',
    apply(context) {
      if (context.egressPort === undefined) return proceed(context, 'egress-zone', 'no-egress');

      const zone = zoneNameFor(services, context.egressPort);
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

      const decision = vdom(services, context).evaluator.evaluate(
        vdom(services, context).policy.ordered(),
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
          destinationTranslated: context.destinationTranslated === true,
          destinationNatRuleId: context.destinationNatRuleId,
        },
        packet.totalLength,
      );

      context.matchedPolicy = decision.rule;

      if (isDenyAction(decision.action)) {
        if (decision.implicit && decision.sawIdentityGate) {
          return deny(context, 'policy-lookup', 'auth-required');
        }
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

      if (services.refusesNewSessions?.() === true) {
        return deny(context, 'session-install', 'memory-conserve-extreme');
      }
      if (!vdom(services, context).sessions.hasRoom()) {
        return deny(context, 'session-install', 'session-table-full');
      }

      const arrived = originalIpv4(context) ?? packet;
      const session = vdom(services, context).sessions.install(flowKeyFromPacket(arrived), {
        ingressZone: context.ingressZone ?? '',
        egressZone: context.egressZone ?? '',
        ingressInterface: context.ingressPort,
        egressInterface: context.egressPort ?? '',
        timeoutSec: services.defaultTimeoutSec ?? DEFAULT_TIMEOUT_SEC,
        policyId: context.matchedPolicy?.id,
        tcpState: tcpMachines.get(context)?.state,
        replyKey: reverseFlowKey(flowKeyFromPacket(packet)),
      });
      session.tcpMachine = tcpMachines.get(context);

      const translation = pendingTranslations.get(context);
      if (translation) {
        session.translation = translation;
        session.natRuleId = translation.natRuleId;
      }

      vdom(services, context).sessions.recordTraffic(session, 'c2s', packet.totalLength);
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
  if (!context.isFirstPacket || !vdom(services, context).sessions.hasRoom()) return;

  vdom(services, context).sessions.installDiscard(flowKeyFromPacket(packet), {
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


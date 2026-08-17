import type { IPv4Packet, IPv6Packet } from '../../../core/types';
import type { FirewallSession } from '../session/SessionTable';
import type { FlowDirection } from '../session/TcpStateMachine';
import type { SecurityRule } from '../model/SecurityRule';

export type FirewallPacket = IPv4Packet | IPv6Packet;

export type VerdictReason =
  | 'policy-deny'
  | 'implicit-deny'
  | 'security-level'
  | 'no-route'
  | 'policy-route-deny'
  | 'no-session-non-syn'
  | 'invalid-tcp-flags'
  | 'tcp-state-violation'
  | 'sequence-out-of-window'
  | 'session-table-full'
  | 'nat-port-exhausted'
  | 'nat-no-rule'
  | 'screen-anomaly'
  | 'screen-flood'
  | 'screen-recon'
  | 'alg-violation'
  | 'profile-block'
  | 'application-shift-deny'
  | 'zone-mismatch'
  | 'interface-down'
  | 'ttl-expired'
  | 'mtu-exceeded-df'
  | 'unsupported-protocol'
  | 'context-not-found';

export type VerdictAction = 'accept' | 'deny' | 'drop' | 'reset' | 'reject';

export interface FirewallVerdict {
  readonly action: VerdictAction;
  readonly reason: VerdictReason;
  readonly stage: string;
  readonly ruleId?: string;
  readonly sendResetTo?: 'client' | 'server' | 'both';
  readonly icmpCode?: number;
}

export interface PipelineTraceEntry {
  readonly stage: string;
  readonly verdict: string;
  readonly detail?: string;
  readonly matchedRuleId?: string;
}

export interface PacketContext {
  readonly id: number;
  readonly arrivedAt: number;

  ingressPort: string;
  egressPort?: string;
  ingressZone?: string;
  egressZone?: string;

  packet: FirewallPacket;
  readonly originalPacket: FirewallPacket;

  session?: FirewallSession;
  sessionDirection?: FlowDirection;
  isFirstPacket: boolean;

  matchedPolicy?: SecurityRule;
  destinationTranslated?: boolean;
  policyRouteId?: string;
  policyRouteGateway?: string;

  identifiedApplication?: string;
  identifiedUser?: string;

  verdict?: FirewallVerdict;

  readonly simulated: boolean;
  readonly trace: PipelineTraceEntry[];
}

export interface PacketContextInit {
  ingressPort: string;
  packet: FirewallPacket;
  arrivedAt: number;
  ingressZone?: string;
  isFirstPacket?: boolean;
  simulated?: boolean;
}

let nextContextId = 1;

export function makePacketContext(init: PacketContextInit): PacketContext {
  return {
    id: nextContextId++,
    arrivedAt: init.arrivedAt,
    ingressPort: init.ingressPort,
    ingressZone: init.ingressZone,
    packet: init.packet,
    originalPacket: init.packet,
    isFirstPacket: init.isFirstPacket ?? true,
    simulated: init.simulated ?? false,
    trace: [],
  };
}

export function resetPacketContextIds(): void {
  nextContextId = 1;
}

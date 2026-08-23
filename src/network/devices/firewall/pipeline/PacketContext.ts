import type { IPv4Packet, IPv6Packet, MACAddress } from '../../../core/types';
import type { FirewallSession } from '../session/SessionTable';
import type { FlowDirection } from '../session/TcpStateMachine';
import type { SecurityRule } from '../model/SecurityRule';
import type { UtmVerdict } from '../inspection/ContentInspector';

export type FirewallPacket = IPv4Packet | IPv6Packet;

export type VerdictReason =
  | 'policy-deny'
  | 'implicit-deny'
  | 'security-level'
  | 'no-route'
  | 'no-session-non-syn'
  | 'invalid-tcp-flags'
  | 'tcp-state-violation'
  | 'session-table-full'
  | 'memory-conserve-extreme'
  | 'av-failopen-off'
  | 'ips-fail-closed'
  | 'oversize-blocked'
  | 'nat-port-exhausted'
  | 'nat-no-rule'
  | 'profile-block'
  | 'utm-virus'
  | 'utm-url'
  | 'utm-category'
  | 'utm-application'
  | 'utm-dns'
  | 'utm-file-type'
  | 'auth-required'
  | 'ha-subordinate'
  | 'zone-mismatch'
  | 'interface-down'
  | 'ttl-expired'
  | 'mtu-exceeded-df';

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
  egressMtu?: number;
  ingressZone?: string;
  egressZone?: string;
  vdom?: string;
  bridged?: boolean;
  readonly ingressFrameDestination?: MACAddress;

  packet: FirewallPacket;
  readonly originalPacket: FirewallPacket;

  session?: FirewallSession;
  sessionDirection?: FlowDirection;
  isFirstPacket: boolean;

  matchedPolicy?: SecurityRule;
  destinationTranslated?: boolean;
  destinationNatRuleId?: string;
  policyRouteId?: string;
  policyRouteGateway?: string;

  utmVerdict?: UtmVerdict;
  inspectedSni?: string;
  authenticatedUser?: string;

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
  ingressFrameDestination?: MACAddress;
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
    ingressFrameDestination: init.ingressFrameDestination,
    trace: [],
  };
}

export function resetPacketContextIds(): void {
  nextContextId = 1;
}

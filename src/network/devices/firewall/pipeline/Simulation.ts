import type { IPv4Packet } from '../../../core/types';
import type { FirewallVerdict, PacketContext, PipelineTraceEntry } from './PacketContext';
import type { SimulatedFlow } from './SimulatedPacket';

export interface SimulationRequest extends SimulatedFlow {
  readonly ingressPort: string;
}

export interface SimulationResult {
  readonly allowed: boolean;
  readonly verdict?: FirewallVerdict;
  readonly trace: readonly PipelineTraceEntry[];

  readonly ingressPort: string;
  readonly egressPort?: string;
  readonly ingressZone?: string;
  readonly egressZone?: string;

  readonly originalSourceIP: string;
  readonly originalDestinationIP: string;
  readonly translatedSourceIP: string;
  readonly translatedDestinationIP: string;
  readonly originalSourcePort: number;
  readonly translatedSourcePort: number;
  readonly originalDestinationPort: number;
  readonly translatedDestinationPort: number;

  readonly matchedPolicyId?: string;
}

export class UnknownSimulationInterfaceError extends Error {
  constructor(readonly ifaceName: string) {
    super(`no such interface '${ifaceName}'`);
    this.name = 'UnknownSimulationInterfaceError';
  }
}

export function summariseSimulation(
  context: PacketContext, accepted: boolean,
): SimulationResult {
  const original = context.originalPacket as IPv4Packet;
  const current = context.packet as IPv4Packet;

  return Object.freeze({
    allowed: accepted,
    verdict: context.verdict,
    trace: Object.freeze([...context.trace]),

    ingressPort: context.ingressPort,
    egressPort: context.egressPort,
    ingressZone: context.ingressZone,
    egressZone: context.egressZone,

    originalSourceIP: original.sourceIP.toString(),
    originalDestinationIP: original.destinationIP.toString(),
    translatedSourceIP: current.sourceIP.toString(),
    translatedDestinationIP: current.destinationIP.toString(),
    originalSourcePort: portsOf(original).source,
    translatedSourcePort: portsOf(current).source,
    originalDestinationPort: portsOf(original).destination,
    translatedDestinationPort: portsOf(current).destination,

    matchedPolicyId: context.matchedPolicy?.id,
  });
}

function portsOf(packet: IPv4Packet): { source: number; destination: number } {
  const payload = packet.payload as {
    type?: string; sourcePort?: number; destinationPort?: number; id?: number;
  } | null;

  if (payload?.type === 'tcp' || payload?.type === 'udp') {
    return { source: payload.sourcePort ?? 0, destination: payload.destinationPort ?? 0 };
  }
  return { source: payload?.id ?? 0, destination: 0 };
}

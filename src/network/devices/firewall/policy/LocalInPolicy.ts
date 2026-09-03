import type { IPv4Packet } from '../../../core/types';
import { isDenyAction, type SecurityRule } from '../model/SecurityRule';
import type { PolicyEvaluator } from './PolicyEvaluator';
import { transportPorts, type TransportProbeFields } from './probeFields';

export type LocalInVerdict = 'accept' | 'deny' | 'no-match';

export interface LocalInTraffic extends TransportProbeFields {
  readonly sourceIP: string;
  readonly destIP: string;
  readonly protocol: number;
  readonly bytes: number;
}

export interface LocalInDeps {
  readonly rules: readonly SecurityRule[];
  readonly evaluator: PolicyEvaluator;
  readonly zoneOf?: (iface: string) => string;
}

export function localInTrafficOfIpv4(packet: IPv4Packet): LocalInTraffic {
  return {
    sourceIP: packet.sourceIP.toString(),
    destIP: packet.destinationIP.toString(),
    protocol: packet.protocol,
    bytes: packet.totalLength,
    ...transportPorts(packet),
  };
}

export function localInVerdict(
  deps: LocalInDeps, iface: string, traffic: LocalInTraffic,
): LocalInVerdict {
  if (deps.rules.length === 0) return 'no-match';

  const decision = deps.evaluator.evaluateExplicit(deps.rules, {
    ingressZone: deps.zoneOf?.(iface) ?? '',
    egressZone: '',
    ingressInterface: iface,
    egressInterface: '',
    sourceIP: traffic.sourceIP,
    destIP: traffic.destIP,
    protocol: traffic.protocol,
    sourcePort: traffic.sourcePort,
    destPort: traffic.destPort,
    icmpType: traffic.icmpType,
    icmpCode: traffic.icmpCode,
  }, traffic.bytes);

  if (!decision) return 'no-match';
  return isDenyAction(decision.action) ? 'deny' : 'accept';
}

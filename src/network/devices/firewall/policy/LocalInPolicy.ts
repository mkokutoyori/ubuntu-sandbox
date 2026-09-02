import type { IPv4Packet } from '../../../core/types';
import { isDenyAction, type SecurityRule } from '../model/SecurityRule';
import type { PolicyEvaluator } from './PolicyEvaluator';
import { transportPorts } from './probeFields';

export type LocalInVerdict = 'accept' | 'deny' | 'no-match';

export interface LocalInDeps {
  readonly rules: readonly SecurityRule[];
  readonly evaluator: PolicyEvaluator;
  readonly zoneOf?: (iface: string) => string;
}

export function localInVerdict(
  deps: LocalInDeps, iface: string, packet: IPv4Packet,
): LocalInVerdict {
  if (deps.rules.length === 0) return 'no-match';

  const decision = deps.evaluator.evaluateExplicit(deps.rules, {
    ingressZone: deps.zoneOf?.(iface) ?? '',
    egressZone: '',
    ingressInterface: iface,
    egressInterface: '',
    sourceIP: packet.sourceIP.toString(),
    destIP: packet.destinationIP.toString(),
    protocol: packet.protocol,
    ...transportPorts(packet),
  }, packet.totalLength);

  if (!decision) return 'no-match';
  return isDenyAction(decision.action) ? 'deny' : 'accept';
}

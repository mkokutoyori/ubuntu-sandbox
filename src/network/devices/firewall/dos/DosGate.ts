import type { IPv4Packet } from '../../../core/types';
import type { PolicyEvaluator } from '../policy/PolicyEvaluator';
import { transportPorts } from '../policy/probeFields';
import { anomalySpec } from './AnomalyCatalog';
import type { DosPolicyStore } from './DosPolicyStore';
import type { DosFinding, DosSensor } from './DosSensor';

export interface DosGateDeps {
  readonly policies: DosPolicyStore;
  readonly evaluator: PolicyEvaluator;
  readonly sensor: DosSensor;
  readonly zoneOf?: (iface: string) => string;
}

export function dosFinding(
  deps: DosGateDeps, iface: string, packet: IPv4Packet,
): DosFinding | null {
  const rules = deps.policies.ordered();
  if (rules.length === 0) return null;

  const decision = deps.evaluator.evaluateExplicit(rules, {
    ingressZone: deps.zoneOf?.(iface) ?? '',
    egressZone: '',
    ingressInterface: iface,
    egressInterface: '',
    sourceIP: packet.sourceIP.toString(),
    destIP: packet.destinationIP.toString(),
    protocol: packet.protocol,
    ...transportPorts(packet),
  }, packet.totalLength);
  if (!decision) return null;

  const subject = {
    sourceIP: packet.sourceIP.toString(),
    destIP: packet.destinationIP.toString(),
    protocol: packet.protocol,
  };

  for (const setting of deps.policies.anomaliesOf(decision.rule.id)) {
    const spec = anomalySpec(setting.name);
    if (!spec) continue;
    const finding = deps.sensor.evaluate(decision.rule.id, spec, setting, subject);
    if (finding) return finding;
  }
  return null;
}

import type { IPv4Packet } from '../../../core/types';
import type { PolicyEvaluator } from '../policy/PolicyEvaluator';
import { transportPorts, type TransportProbeFields } from '../policy/probeFields';
import { anomalySpec, type IpVersion } from './AnomalyCatalog';
import type { DosPolicyStore } from './DosPolicyStore';
import type { DosFinding, DosSensor } from './DosSensor';

export interface DosTraffic extends TransportProbeFields {
  readonly sourceIP: string;
  readonly destIP: string;
  readonly protocol: number;
  readonly version: IpVersion;
  readonly bytes: number;
}

export interface DosGateDeps {
  readonly policies: DosPolicyStore;
  readonly evaluator: PolicyEvaluator;
  readonly sensor: DosSensor;
  readonly zoneOf?: (iface: string) => string;
}

export function dosTrafficOfIpv4(packet: IPv4Packet): DosTraffic {
  return {
    sourceIP: packet.sourceIP.toString(),
    destIP: packet.destinationIP.toString(),
    protocol: packet.protocol,
    version: 4,
    bytes: packet.totalLength,
    ...transportPorts(packet),
  };
}

export function dosFinding(
  deps: DosGateDeps, iface: string, traffic: DosTraffic,
): DosFinding | null {
  const rules = deps.policies.ordered();
  if (rules.length === 0) return null;

  const decision = deps.evaluator.evaluateExplicit(rules, {
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
  if (!decision) return null;

  const subject = {
    sourceIP: traffic.sourceIP,
    destIP: traffic.destIP,
    protocol: traffic.protocol,
    version: traffic.version,
  };

  for (const setting of deps.policies.anomaliesOf(decision.rule.id)) {
    const spec = anomalySpec(setting.name);
    if (!spec) continue;
    const finding = deps.sensor.evaluate(decision.rule.id, spec, setting, subject);
    if (finding) return finding;
  }
  return null;
}

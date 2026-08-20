import { IMPLICIT_RULE_ID } from '../../model/SecurityRule';
import type { PipelineTraceEntry } from '../../pipeline/PacketContext';
import type { SimulationResult } from '../../pipeline/Simulation';

export interface AsaPhaseNaming {
  readonly type: string;
  readonly subtype: string;
}

const PHASE_NAMES: Readonly<Record<string, AsaPhaseNaming>> = Object.freeze({
  'ingress-zone': { type: 'ACCESS-LIST', subtype: 'ingress' },
  'session-lookup': { type: 'FLOW-LOOKUP', subtype: '' },
  'tcp-state-check': { type: 'TCP-STATE', subtype: 'check' },
  'nat-destination': { type: 'UN-NAT', subtype: 'static' },
  'route-lookup': { type: 'ROUTE-LOOKUP', subtype: 'Resolve Egress Interface' },
  'egress-zone': { type: 'ACCESS-LIST', subtype: 'egress' },
  'policy-lookup': { type: 'ACCESS-LIST', subtype: 'log' },
  'nat-source': { type: 'NAT', subtype: '' },
  'session-install': { type: 'FLOW-CREATION', subtype: '' },
});

const IMPLICIT_CONFIG = 'Implicit Rule';

export function renderPacketTracer(
  result: SimulationResult, zoneNameOf: (iface: string) => string | undefined,
): string {
  const lines: string[] = [];
  let phase = 0;

  for (const entry of result.trace) {
    const naming = PHASE_NAMES[entry.stage];
    if (!naming) continue;

    phase++;
    lines.push(`Phase: ${phase}`);
    lines.push(`Type: ${naming.type}`);
    if (naming.subtype) lines.push(`Subtype: ${naming.subtype}`);
    lines.push(`Result: ${entry.verdict === 'drop' ? 'DROP' : 'ALLOW'}`);
    lines.push(`Config: ${configLineOf(entry, result)}`);
    lines.push('Additional Information:');
    lines.push(additionalOf(entry, result, zoneNameOf));
    lines.push('');
  }

  lines.push('Result:');
  lines.push(`input-interface: ${zoneNameOf(result.ingressPort) ?? result.ingressPort}`);
  lines.push(`input-status: up`);
  lines.push(`input-line-status: up`);
  lines.push(`output-interface: ${outputInterfaceOf(result, zoneNameOf)}`);
  lines.push(`output-status: up`);
  lines.push(`output-line-status: up`);
  lines.push(`Action: ${result.allowed ? 'allow' : 'drop'}`);
  if (!result.allowed) lines.push(`Drop-reason: (${result.verdict?.reason ?? 'unknown'})`);

  return lines.join('\n');
}

function outputInterfaceOf(
  result: SimulationResult, zoneNameOf: (iface: string) => string | undefined,
): string {
  if (result.egressPort === undefined) return 'NP identity Ifc';
  return zoneNameOf(result.egressPort) ?? result.egressPort;
}

function configLineOf(entry: PipelineTraceEntry, result: SimulationResult): string {
  const ruleId = entry.matchedRuleId ?? (entry.stage === 'policy-lookup'
    ? result.matchedPolicyId
    : undefined);
  if (ruleId === undefined || ruleId === IMPLICIT_RULE_ID) return IMPLICIT_CONFIG;
  if (entry.stage === 'nat-source' || entry.stage === 'nat-destination') return `nat ${ruleId}`;
  return `access-list ${ruleId}`;
}

function additionalOf(
  entry: PipelineTraceEntry, result: SimulationResult,
  zoneNameOf: (iface: string) => string | undefined,
): string {
  if (entry.stage === 'nat-source' && result.translatedSourceIP !== result.originalSourceIP) {
    return `Static translate ${result.originalSourceIP}/${result.originalSourcePort}`
      + ` to ${result.translatedSourceIP}/${result.translatedSourcePort}`;
  }
  if (entry.stage === 'nat-destination'
    && result.translatedDestinationIP !== result.originalDestinationIP) {
    return `Untranslate ${result.originalDestinationIP}/${result.originalDestinationPort}`
      + ` to ${result.translatedDestinationIP}/${result.translatedDestinationPort}`;
  }
  if (entry.stage === 'route-lookup' && result.egressPort) {
    return `found next-hop via ${zoneNameOf(result.egressPort) ?? result.egressPort}`;
  }
  if (entry.stage === 'session-install' && result.allowed) {
    return 'New flow created';
  }
  return entry.detail ?? '';
}

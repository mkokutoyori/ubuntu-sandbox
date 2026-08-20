import type { NatRule } from '../../../nat/NatPolicyStore';

const VIP_PREFIX = 'vip:';

function portRange(from?: number, to?: number): string {
  if (from === undefined) return '0-65535';
  return `${from}-${to ?? from}`;
}

function addressRange(from: string, to?: string): string {
  return `${from}-${to ?? from}`;
}

export function renderVipList(rules: readonly NatRule[], vdom: string): string {
  const lines: string[] = [];
  let index = 0;

  for (const rule of rules) {
    if (!rule.id.startsWith(VIP_PREFIX)) continue;
    const destination = rule.destinationTranslation;
    if (destination?.kind !== 'static-ip') continue;

    index++;
    lines.push(`vd ${vdom}/0 name ${rule.name ?? rule.id.slice(VIP_PREFIX.length)}`
      + `/${index} type static-nat`);
    lines.push(`\text-ip ${addressRange(rule.originalDestination[0] ?? '0.0.0.0')}`
      + ` ext-port ${portRange(rule.originalPort?.from, rule.originalPort?.to)}`);
    lines.push(`\tmap-ip ${addressRange(destination.translatedAddress,
      destination.translatedEndAddress)}`
      + ` map-port ${portRange(destination.translatedPort,
        destination.translatedPort)}`);
    lines.push(`\tprotocol ${rule.originalPort?.protocol ?? 'any'}`
      + ` intf ${rule.fromZone.join(',')}`);
  }

  return lines.join('\n');
}

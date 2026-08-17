import type { SecurityRule } from '../../../model/SecurityRule';
import type { ZoneTable } from '../../../model/ZoneTable';

export const IPROPE_POLICY_GROUP = '00100004';

export interface IpropeDeps {
  readonly zones: ZoneTable;
  readonly vdom: number;
}

export function renderIpropeList(
  rules: readonly SecurityRule[], deps: IpropeDeps,
): string {
  const lines: string[] = [`policy group: ${IPROPE_POLICY_GROUP}`];
  for (const rule of rules) lines.push(...renderRule(rule, deps));
  return lines.join('\n');
}

export function renderIpropeShow(
  group: string, index: string, rules: readonly SecurityRule[], deps: IpropeDeps,
): string | null {
  if (group !== IPROPE_POLICY_GROUP) return null;

  const rule = rules.find(candidate => candidate.id === index);
  if (!rule) return null;
  return [`policy group: ${group}`, ...renderRule(rule, deps)].join('\n');
}

function renderRule(rule: SecurityRule, deps: IpropeDeps): string[] {
  return [
    `policy index=${rule.seq} policy id=${rule.id} action=${rule.action}`,
    `flag (0): ${rule.enabled ? 'enabled' : 'disabled'}`
    + `${rule.natEnabled ? ' nat' : ''}${rule.natPool ? ' ippool' : ''}`,
    `schedule(${rule.schedule ?? 'always'}) group=${IPROPE_POLICY_GROUP}`,
    `zone(${rule.from.length}): ${describeSide(rule.from, deps)}`
    + ` -> zone(${rule.to.length}): ${describeSide(rule.to, deps)}`,
    `source(${rule.source.length}): ${rule.source.join(', ')}`,
    `dest(${rule.destination.length}): ${rule.destination.join(', ')}`,
    `service(${rule.service.length}): ${rule.service.join(', ')}`,
    `hit count:${rule.hitCount}`,
    `first hit:${rule.createdAt} last hit:${rule.lastHitAt ?? 0}`,
  ];
}

function describeSide(names: readonly string[], deps: IpropeDeps): string {
  return names.map(name => {
    const zone = deps.zones.getZone(name);
    return zone ? `${name}(zone)` : name;
  }).join(', ');
}

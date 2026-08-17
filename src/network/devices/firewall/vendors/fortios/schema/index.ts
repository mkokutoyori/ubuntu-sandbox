import { pathKey, type FortiTableSpec } from './types';
import { FIREWALL_ADDRESS } from './firewallObjects';
import { FIREWALL_POLICY } from './firewallPolicy';

export const FORTIOS_SCHEMA: readonly FortiTableSpec[] = Object.freeze([
  FIREWALL_ADDRESS,
  FIREWALL_POLICY,
]);

export function schemaIndex(
  specs: readonly FortiTableSpec[] = FORTIOS_SCHEMA,
): ReadonlyMap<string, FortiTableSpec> {
  const map = new Map<string, FortiTableSpec>();
  for (const spec of specs) map.set(pathKey(spec.path), spec);
  return map;
}

export { FIREWALL_ADDRESS, FIREWALL_POLICY };
export * from './types';

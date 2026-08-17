import { pathKey, type FortiTableSpec } from './types';
import {
  FIREWALL_ADDRESS, FIREWALL_ADDRGRP, FIREWALL_SCHEDULE_RECURRING,
  FIREWALL_SERVICE_CUSTOM, FIREWALL_SERVICE_GROUP,
} from './firewallObjects';
import { FIREWALL_POLICY } from './firewallPolicy';
import {
  FIREWALL_CENTRAL_SNAT_MAP, FIREWALL_IPPOOL, FIREWALL_VIP,
} from './firewallNat';
import { SYSTEM_SPECS } from './system';
import { ROUTER_SPECS } from './router';

export const FORTIOS_SCHEMA: readonly FortiTableSpec[] = Object.freeze([
  ...SYSTEM_SPECS,
  FIREWALL_ADDRESS,
  FIREWALL_ADDRGRP,
  FIREWALL_SERVICE_CUSTOM,
  FIREWALL_SERVICE_GROUP,
  FIREWALL_SCHEDULE_RECURRING,
  FIREWALL_IPPOOL,
  FIREWALL_VIP,
  ...ROUTER_SPECS,
  FIREWALL_POLICY,
  FIREWALL_CENTRAL_SNAT_MAP,
]);

export function schemaIndex(
  specs: readonly FortiTableSpec[] = FORTIOS_SCHEMA,
): ReadonlyMap<string, FortiTableSpec> {
  const map = new Map<string, FortiTableSpec>();
  for (const spec of specs) map.set(pathKey(spec.path), spec);
  return map;
}

export {
  FIREWALL_ADDRESS, FIREWALL_ADDRGRP, FIREWALL_POLICY,
  FIREWALL_SCHEDULE_RECURRING, FIREWALL_SERVICE_CUSTOM, FIREWALL_SERVICE_GROUP,
  FIREWALL_CENTRAL_SNAT_MAP, FIREWALL_IPPOOL, FIREWALL_VIP,
};
export * from './types';

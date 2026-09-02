import { pathKey, type FortiTableSpec } from './types';
import {
  FIREWALL_ADDRESS, FIREWALL_ADDRESS6, FIREWALL_ADDRGRP, FIREWALL_ADDRGRP6,
  FIREWALL_SCHEDULE_RECURRING,
  FIREWALL_SCHEDULE_ONETIME, FIREWALL_SCHEDULE_GROUP,
  FIREWALL_SERVICE_CATEGORY, FIREWALL_SERVICE_CUSTOM, FIREWALL_SERVICE_GROUP,
} from './firewallObjects';
import { FIREWALL_POLICY } from './firewallPolicy';
import {
  FIREWALL_LOCAL_IN_POLICY, FIREWALL_LOCAL_IN_POLICY6,
} from './firewallLocalIn';
import {
  FIREWALL_CENTRAL_SNAT_MAP, FIREWALL_IPPOOL, FIREWALL_VIP, LDB_MONITOR,
} from './firewallNat';
import { SYSTEM_SPECS } from './system';
import { ROUTER_SPECS } from './router';
import { LOG_SPECS } from './log';
import { VDOM_SPECS } from './vdom';
import { UTM_SPECS } from './utm';
import { USER_SPECS } from './user';
import { ADMIN_SPECS } from './admin';
import { VPN_SPECS } from './vpn';
import { SDWAN_SPECS } from './sdwan';
import { HA_SPECS } from './ha';
import { ROUTER_DYNAMIC_SPECS } from './routerDynamic';

export const FORTIOS_SCHEMA: readonly FortiTableSpec[] = Object.freeze([
  ...VDOM_SPECS,
  ...SYSTEM_SPECS,
  ...SDWAN_SPECS,
  ...HA_SPECS,
  ...ROUTER_DYNAMIC_SPECS,
  FIREWALL_ADDRESS,
  FIREWALL_ADDRESS6,
  FIREWALL_ADDRGRP,
  FIREWALL_ADDRGRP6,
  FIREWALL_SERVICE_CATEGORY,
  FIREWALL_SERVICE_CUSTOM,
  FIREWALL_SERVICE_GROUP,
  FIREWALL_SCHEDULE_RECURRING,
  FIREWALL_SCHEDULE_ONETIME,
  FIREWALL_SCHEDULE_GROUP,
  FIREWALL_IPPOOL,
  LDB_MONITOR,
  FIREWALL_VIP,
  ...UTM_SPECS,
  ...USER_SPECS,
  ...ADMIN_SPECS,
  ...VPN_SPECS,
  ...ROUTER_SPECS,
  FIREWALL_POLICY,
  FIREWALL_LOCAL_IN_POLICY,
  FIREWALL_LOCAL_IN_POLICY6,
  FIREWALL_CENTRAL_SNAT_MAP,
  ...LOG_SPECS,
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
  FIREWALL_SCHEDULE_RECURRING, FIREWALL_SCHEDULE_ONETIME, FIREWALL_SCHEDULE_GROUP,
  FIREWALL_SERVICE_CATEGORY, FIREWALL_SERVICE_CUSTOM, FIREWALL_SERVICE_GROUP,
  FIREWALL_CENTRAL_SNAT_MAP, FIREWALL_IPPOOL, FIREWALL_VIP,
};
export * from './types';

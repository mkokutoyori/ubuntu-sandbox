import { IPAddress, IPv6Address } from '@/network/core/types';
import { cimNotFound } from './cimQuery';
import {
  type NetAddressFamily, type NetInterfaceRef, type NetIPAddressResolver, type NetPolicyStore,
  NET_ADDRESS_FAMILIES, NET_POLICY_STORES, NO_MATCHING_INTERFACE, TIMESPAN_MAX_SECONDS, matchEnumValue,
} from './netIpAddress';

export type NetRoutePublish = 'No' | 'Age' | 'Yes';
export type NetRouteProtocol =
  | 'Other' | 'Local' | 'NetMgmt' | 'Icmp' | 'Egp' | 'Ggp' | 'Hello' | 'Rip' | 'IsIs'
  | 'EsIs' | 'Igrp' | 'Bbn' | 'Ospf' | 'Bgp' | 'Idpr' | 'Eigrp' | 'Dvmrp' | 'Rpl' | 'Dhcp';

export const NET_ROUTE_PUBLISH: readonly NetRoutePublish[] = ['No', 'Age', 'Yes'];
export const NET_ROUTE_PROTOCOLS: readonly NetRouteProtocol[] = [
  'Other', 'Local', 'NetMgmt', 'Icmp', 'Egp', 'Ggp', 'Hello', 'Rip', 'IsIs',
  'EsIs', 'Igrp', 'Bbn', 'Ospf', 'Bgp', 'Idpr', 'Eigrp', 'Dvmrp', 'Rpl', 'Dhcp',
];

export const UNSPECIFIED_NEXT_HOP: Record<NetAddressFamily, string> = { IPv4: '0.0.0.0', IPv6: '::' };
export const MAX_ROUTE_METRIC = 65535;

export interface ParsedDestinationPrefix {
  family: NetAddressFamily;
  text: string;
  prefixLength: number;
}

export function parseDestinationPrefix(raw: string): ParsedDestinationPrefix | null {
  const token = raw.trim();
  const slash = token.lastIndexOf('/');
  if (slash === -1) return null;
  const network = token.slice(0, slash);
  const lengthText = token.slice(slash + 1);
  if (!/^\d+$/.test(lengthText)) return null;
  const prefixLength = parseInt(lengthText, 10);
  if (network.includes(':')) {
    if (prefixLength > 128) return null;
    try {
      const value = new IPv6Address(network);
      return { family: 'IPv6', text: `${value.toString()}/${prefixLength}`, prefixLength };
    } catch { return null; }
  }
  if (prefixLength > 32) return null;
  const value = IPAddress.tryParse(network);
  return value === null ? null : { family: 'IPv4', text: `${value.toString()}/${prefixLength}`, prefixLength };
}

export function parseNextHop(raw: string): { family: NetAddressFamily; text: string } | null {
  const token = raw.trim();
  if (token === '') return null;
  if (token.includes(':')) {
    try { return { family: 'IPv6', text: new IPv6Address(token).toString() }; } catch { return null; }
  }
  const value = IPAddress.tryParse(token);
  return value === null ? null : { family: 'IPv4', text: value.toString() };
}

export interface NetRouteRequest {
  destinationPrefix?: string;
  interfaceAlias?: string;
  interfaceIndex?: string;
  nextHop?: string;
  addressFamily?: string;
  routeMetric?: string;
  publish?: string;
  protocol?: string;
  policyStore?: string;
  validLifetimeSeconds?: number;
  preferredLifetimeSeconds?: number;
}

export interface NetRoutePlan {
  destination: ParsedDestinationPrefix;
  iface: NetInterfaceRef;
  nextHop: string;
  routeMetric: number;
  publish: NetRoutePublish;
  protocol: NetRouteProtocol;
  policyStore: NetPolicyStore;
  validLifetimeSeconds: number;
  preferredLifetimeSeconds: number;
}

export type NetRouteDecision =
  | { ok: true; plan: NetRoutePlan; message?: undefined }
  | { ok: false; plan?: undefined; message: string };

export function planNetRoute(
  request: NetRouteRequest, resolver: NetIPAddressResolver,
): NetRouteDecision {
  const refuse = (message: string): NetRouteDecision => ({ ok: false, message });
  const rawDestination = (request.destinationPrefix ?? '').trim();
  if (rawDestination === '') {
    return refuse('Cannot process command because of one or more missing mandatory parameters: DestinationPrefix.');
  }
  const destination = parseDestinationPrefix(rawDestination);
  if (!destination) {
    return refuse(`Cannot validate argument on parameter 'DestinationPrefix'. The argument "${rawDestination}" is not a valid IP prefix.`);
  }

  if (request.addressFamily !== undefined) {
    const declared = matchEnumValue(NET_ADDRESS_FAMILIES, request.addressFamily);
    if (declared === null) {
      return refuse(`Cannot validate argument on parameter 'AddressFamily'. The argument does not belong to the set "${NET_ADDRESS_FAMILIES.join(',')}".`);
    }
    if (declared !== destination.family) {
      return refuse(`Cannot validate argument on parameter 'AddressFamily'. The prefix "${destination.text}" is an ${destination.family} prefix.`);
    }
  }

  const hasIndex = request.interfaceIndex !== undefined && request.interfaceIndex.trim() !== '';
  const hasAlias = request.interfaceAlias !== undefined && request.interfaceAlias.trim() !== '';
  if (!hasIndex && !hasAlias) {
    return refuse('Cannot process command because of one or more missing mandatory parameters: InterfaceAlias.');
  }
  const iface = resolver.resolveInterface(hasIndex
    ? { index: Number(request.interfaceIndex!.trim()) }
    : { alias: request.interfaceAlias!.trim() });
  if (!iface) return refuse(NO_MATCHING_INTERFACE);

  let nextHop = UNSPECIFIED_NEXT_HOP[destination.family];
  if (request.nextHop !== undefined && request.nextHop.trim() !== '') {
    const parsed = parseNextHop(request.nextHop);
    if (!parsed) {
      return refuse(`Cannot validate argument on parameter 'NextHop'. The argument "${request.nextHop.trim()}" is not a valid IP address.`);
    }
    if (parsed.family !== destination.family) {
      return refuse(`Cannot validate argument on parameter 'NextHop'. The next hop "${parsed.text}" is not an ${destination.family} address.`);
    }
    nextHop = parsed.text;
  }

  let routeMetric = 256;
  if (request.routeMetric !== undefined && request.routeMetric.trim() !== '') {
    const given = request.routeMetric.trim();
    if (!/^\d+$/.test(given) || parseInt(given, 10) > MAX_ROUTE_METRIC) {
      return refuse(`Cannot convert value "${given}" to type "System.UInt16". Error: "Value was either too large or too small for a UInt16."`);
    }
    routeMetric = parseInt(given, 10);
  }

  const publish = request.publish === undefined ? 'No' : matchEnumValue(NET_ROUTE_PUBLISH, request.publish);
  if (publish === null) {
    return refuse(`Cannot validate argument on parameter 'Publish'. The argument does not belong to the set "${NET_ROUTE_PUBLISH.join(',')}".`);
  }
  const protocol = request.protocol === undefined ? 'NetMgmt' : matchEnumValue(NET_ROUTE_PROTOCOLS, request.protocol);
  if (protocol === null) {
    return refuse(`Cannot validate argument on parameter 'Protocol'. The argument does not belong to the set "${NET_ROUTE_PROTOCOLS.join(',')}".`);
  }
  const policyStore = request.policyStore === undefined ? 'ActiveStore'
    : matchEnumValue(NET_POLICY_STORES, request.policyStore);
  if (policyStore === null) {
    return refuse(`Cannot validate argument on parameter 'PolicyStore'. The argument does not belong to the set "${NET_POLICY_STORES.join(',')}".`);
  }

  const validLifetimeSeconds = request.validLifetimeSeconds ?? TIMESPAN_MAX_SECONDS;
  const preferredLifetimeSeconds = request.preferredLifetimeSeconds ?? validLifetimeSeconds;

  return {
    ok: true,
    plan: {
      destination, iface, nextHop, routeMetric, publish, protocol, policyStore,
      validLifetimeSeconds, preferredLifetimeSeconds,
    },
  };
}

export interface NetRouteIdentity {
  destinationPrefix: string;
  ifAlias: string;
  nextHop: string;
}

export function netRouteKey(route: NetRouteIdentity): string {
  return [route.destinationPrefix, route.ifAlias, route.nextHop]
    .map(part => part.trim().toLowerCase()).join('|');
}

export interface NetRouteEntry extends NetRouteIdentity {
  metric: number;
  publish?: NetRoutePublish;
  protocol?: NetRouteProtocol;
  policyStore?: NetPolicyStore;
  addressFamily?: NetAddressFamily;
  ifIndex?: number;
  validLifetimeSeconds?: number;
  preferredLifetimeSeconds?: number;
}

export interface NetRouteUpdate {
  publish?: NetRoutePublish;
  routeMetric?: number;
  validLifetimeSeconds?: number;
  preferredLifetimeSeconds?: number;
}

export interface NetRouteSelection {
  destinationPrefix?: string[];
  interfaceAlias?: string[];
  interfaceIndex?: string[];
  nextHop?: string[];
  addressFamily?: string[];
  routeMetric?: string[];
  publish?: string[];
  protocol?: string[];
  policyStore?: string[];
  state?: string[];
  validLifetime?: string[];
  preferredLifetime?: string[];
}

export interface NetRouteRow {
  destinationPrefix: string;
  ifAlias: string;
  ifIndex?: number;
  nextHop: string;
  routeMetric: number;
  addressFamily?: string;
  publish?: string;
  protocol?: string;
  policyStore?: string;
  validLifetimeSeconds?: number;
  preferredLifetimeSeconds?: number;
}

export function selectNetRoutes<T extends NetRouteRow>(
  rows: readonly T[], selection: NetRouteSelection,
): T[] {
  const criteria: Array<[string[] | undefined, (row: T) => string]> = [
    [selection.destinationPrefix, r => r.destinationPrefix],
    [selection.interfaceAlias, r => r.ifAlias],
    [selection.interfaceIndex, r => String(r.ifIndex ?? '')],
    [selection.nextHop, r => r.nextHop],
    [selection.addressFamily, r => r.addressFamily ?? (r.destinationPrefix.includes(':') ? 'IPv6' : 'IPv4')],
    [selection.routeMetric, r => String(r.routeMetric)],
    [selection.publish, r => r.publish ?? 'No'],
    [selection.protocol, r => r.protocol ?? 'NetMgmt'],
    [selection.policyStore, r => r.policyStore ?? 'ActiveStore'],
    [selection.state, () => 'Alive'],
    [selection.validLifetime, r => String(r.validLifetimeSeconds ?? TIMESPAN_MAX_SECONDS)],
    [selection.preferredLifetime, r => String(r.preferredLifetimeSeconds ?? TIMESPAN_MAX_SECONDS)],
  ];
  let kept = [...rows];
  for (const [values, of] of criteria) {
    if (values === undefined) continue;
    const wanted = values.map(v => v.trim().toLowerCase());
    kept = kept.filter(r => wanted.includes(of(r).toLowerCase()));
  }
  return kept;
}

export function noMatchingNetRoute(selection: NetRouteSelection): string {
  return cimNotFound('MSFT_NetRoute', [
    ['DestinationPrefix', selection.destinationPrefix],
    ['InterfaceAlias', selection.interfaceAlias],
    ['InterfaceIndex', selection.interfaceIndex],
    ['NextHop', selection.nextHop],
  ]);
}

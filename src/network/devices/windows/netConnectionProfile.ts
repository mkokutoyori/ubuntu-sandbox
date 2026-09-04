import { applyCimCriteria, cimNotFound } from './cimQuery';

export type NetworkCategory = 'Public' | 'Private' | 'DomainAuthenticated';

export const NETWORK_CATEGORIES: readonly NetworkCategory[] = [
  'Public', 'Private', 'DomainAuthenticated',
];

export const SETTABLE_NETWORK_CATEGORIES: readonly NetworkCategory[] = ['Public', 'Private'];

export type NetConnectivity =
  | 'Disconnected' | 'NoTraffic' | 'Subnet' | 'LocalNetwork' | 'Internet';

export const NET_CONNECTIVITIES: readonly NetConnectivity[] = [
  'Disconnected', 'NoTraffic', 'Subnet', 'LocalNetwork', 'Internet',
];

export function connectivityOf(hasAddress: boolean, hasDefaultRoute: boolean): NetConnectivity {
  if (!hasAddress) return 'Disconnected';
  return hasDefaultRoute ? 'Internet' : 'LocalNetwork';
}

export interface NetConnectionProfileRow {
  name: string;
  ifAlias: string;
  ifIndex: number;
  networkCategory: NetworkCategory;
  ipv4Connectivity: NetConnectivity;
  ipv6Connectivity: NetConnectivity;
}

export interface NetConnectionProfileSelection {
  name?: string[];
  interfaceAlias?: string[];
  interfaceIndex?: string[];
  networkCategory?: string[];
  ipv4Connectivity?: string[];
  ipv6Connectivity?: string[];
}

export function selectNetConnectionProfiles<T extends NetConnectionProfileRow>(
  rows: readonly T[], selection: NetConnectionProfileSelection,
): T[] {
  return applyCimCriteria(rows, [
    [selection.name, r => r.name],
    [selection.interfaceAlias, r => r.ifAlias],
    [selection.interfaceIndex, r => String(r.ifIndex)],
    [selection.networkCategory, r => r.networkCategory],
    [selection.ipv4Connectivity, r => r.ipv4Connectivity],
    [selection.ipv6Connectivity, r => r.ipv6Connectivity],
  ]);
}

export function profileSelectionIsEmpty(selection: NetConnectionProfileSelection): boolean {
  return Object.values(selection).every(v => v === undefined);
}

export function noMatchingNetConnectionProfile(selection: NetConnectionProfileSelection): string {
  return cimNotFound('MSFT_NetConnectionProfile', [
    ['Name', selection.name],
    ['InterfaceAlias', selection.interfaceAlias],
    ['InterfaceIndex', selection.interfaceIndex],
    ['NetworkCategory', selection.networkCategory],
    ['IPv4Connectivity', selection.ipv4Connectivity],
    ['IPv6Connectivity', selection.ipv6Connectivity],
  ]);
}

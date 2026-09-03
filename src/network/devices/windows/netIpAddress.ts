import { IPAddress, IPv6Address } from '@/network/core/types';

export type NetAddressFamily = 'IPv4' | 'IPv6';
export type NetIPAddressType = 'Unicast' | 'Anycast';
export type NetPolicyStore = 'ActiveStore' | 'PersistentStore';

export const NET_ADDRESS_FAMILIES: readonly NetAddressFamily[] = ['IPv4', 'IPv6'];
export const NET_IP_ADDRESS_TYPES: readonly NetIPAddressType[] = ['Unicast', 'Anycast'];
export const NET_POLICY_STORES: readonly NetPolicyStore[] = ['ActiveStore', 'PersistentStore'];

export const MAX_PREFIX_LENGTH: Record<NetAddressFamily, number> = { IPv4: 32, IPv6: 128 };

export type ParsedNetAddress =
  | { family: 'IPv4'; value: IPAddress; text: string }
  | { family: 'IPv6'; value: IPv6Address; text: string };

export function parseNetAddress(raw: string): ParsedNetAddress | null {
  const token = raw.trim();
  if (token === '') return null;
  if (token.includes(':')) {
    try {
      const value = new IPv6Address(token);
      return { family: 'IPv6', value, text: value.toString() };
    } catch { return null; }
  }
  const value = IPAddress.tryParse(token);
  return value === null ? null : { family: 'IPv4', value, text: value.toString() };
}

export function matchEnumValue<T extends string>(table: readonly T[], raw: string): T | null {
  const lower = raw.trim().toLowerCase();
  return table.find(v => v.toLowerCase() === lower) ?? null;
}

export function prefixLengthProblem(raw: string, family: NetAddressFamily): string | null {
  const token = raw.trim();
  if (!/^\d+$/.test(token)) {
    return `Cannot convert value "${token}" to type "System.Byte". Error: "Input string was not in a correct format."`;
  }
  const value = parseInt(token, 10);
  if (value > 255) {
    return `Cannot convert value "${token}" to type "System.Byte". Error: "Value was either too large or too small for an unsigned byte."`;
  }
  if (value > MAX_PREFIX_LENGTH[family]) {
    return `The prefix length ${value} is not valid for an ${family} address. `
      + `The valid range is 0 through ${MAX_PREFIX_LENGTH[family]}.`;
  }
  return null;
}

export interface NetIPAddressEntry {
  ifAlias: string;
  prefixLength: number;
  prefixOrigin: string;
  suffixOrigin: string;
  skipAsSource: boolean;
  gateway?: string;
  addressFamily: string;
  type?: NetIPAddressType;
  policyStore?: NetPolicyStore;
  validLifetimeSeconds?: number;
  preferredLifetimeSeconds?: number;
}

export const NO_MATCHING_INTERFACE = 'No matching interface found.';
export const INSTANCE_ALREADY_EXISTS = 'Instance MSFT_NetIPAddress already exists';

export interface NetIPAddressRequest {
  ipAddress?: string;
  interfaceAlias?: string;
  interfaceIndex?: string;
  prefixLength?: string;
  addressFamily?: string;
  type?: string;
  policyStore?: string;
  defaultGateway?: string;
  skipAsSource?: boolean;
}

export interface NetInterfaceRef { alias: string; ifIndex: number }

export interface NetIPAddressResolver {
  resolveInterface(spec: { alias?: string; index?: number }): NetInterfaceRef | null;
}

export interface NetIPAddressPlan {
  address: ParsedNetAddress;
  iface: NetInterfaceRef;
  prefixLength: number;
  type: NetIPAddressType;
  policyStore: NetPolicyStore;
  gateway?: string;
  skipAsSource: boolean;
}

export type NetIPAddressDecision =
  | { ok: true; plan: NetIPAddressPlan; message?: undefined }
  | { ok: false; plan?: undefined; message: string };

const DEFAULT_PREFIX_LENGTH: Record<NetAddressFamily, number> = { IPv4: 24, IPv6: 64 };

export function planNetIPAddress(
  request: NetIPAddressRequest, resolver: NetIPAddressResolver,
): NetIPAddressDecision {
  const refuse = (message: string): NetIPAddressDecision => ({ ok: false, message });
  const rawAddress = (request.ipAddress ?? '').trim();
  if (rawAddress === '') {
    return refuse('Cannot process command because of one or more missing mandatory parameters: IPAddress.');
  }
  const address = parseNetAddress(rawAddress);
  if (!address) {
    return refuse(`Cannot validate argument on parameter 'IPAddress'. The argument "${rawAddress}" is not a valid IP address.`);
  }

  if (request.addressFamily !== undefined) {
    const declared = matchEnumValue(NET_ADDRESS_FAMILIES, request.addressFamily);
    if (declared === null) {
      return refuse(`Cannot validate argument on parameter 'AddressFamily'. The argument does not belong to the set "${NET_ADDRESS_FAMILIES.join(',')}".`);
    }
    if (declared !== address.family) {
      return refuse(`Cannot validate argument on parameter 'AddressFamily'. The address "${address.text}" is an ${address.family} address.`);
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

  let prefixLength = DEFAULT_PREFIX_LENGTH[address.family];
  if (request.prefixLength !== undefined && request.prefixLength.trim() !== '') {
    const problem = prefixLengthProblem(request.prefixLength, address.family);
    if (problem) return refuse(problem);
    prefixLength = parseInt(request.prefixLength.trim(), 10);
  }

  const type = request.type === undefined ? 'Unicast' : matchEnumValue(NET_IP_ADDRESS_TYPES, request.type);
  if (type === null) {
    return refuse(`Cannot validate argument on parameter 'Type'. The argument does not belong to the set "${NET_IP_ADDRESS_TYPES.join(',')}".`);
  }
  const policyStore = request.policyStore === undefined ? 'ActiveStore'
    : matchEnumValue(NET_POLICY_STORES, request.policyStore);
  if (policyStore === null) {
    return refuse(`Cannot validate argument on parameter 'PolicyStore'. The argument does not belong to the set "${NET_POLICY_STORES.join(',')}".`);
  }

  let gateway: string | undefined;
  if (request.defaultGateway !== undefined && request.defaultGateway.trim() !== '') {
    const parsed = parseNetAddress(request.defaultGateway);
    if (!parsed) {
      return refuse(`Cannot validate argument on parameter 'DefaultGateway'. The argument "${request.defaultGateway.trim()}" is not a valid IP address.`);
    }
    if (parsed.family !== address.family) {
      return refuse(`Cannot validate argument on parameter 'DefaultGateway'. The gateway "${parsed.text}" is not an ${address.family} address.`);
    }
    gateway = parsed.text;
  }

  return {
    ok: true,
    plan: { address, iface, prefixLength, type, policyStore, gateway, skipAsSource: request.skipAsSource === true },
  };
}

export interface NetIPAddressSelection {
  ipAddress?: string[];
  interfaceAlias?: string[];
  interfaceIndex?: string[];
  addressFamily?: string[];
  prefixLength?: string[];
  prefixOrigin?: string[];
  suffixOrigin?: string[];
  addressState?: string[];
  type?: string[];
  policyStore?: string[];
  skipAsSource?: string[];
}

export interface NetIPAddressRow {
  ipAddress: string;
  ifAlias: string;
  ifIndex: number;
  addressFamily: string;
  prefixLength: number;
  prefixOrigin: string;
  suffixOrigin: string;
  type?: NetIPAddressType;
  policyStore?: NetPolicyStore;
  skipAsSource?: boolean;
}

export function selectNetIPAddresses<T extends NetIPAddressRow>(
  rows: readonly T[], selection: NetIPAddressSelection,
): T[] {
  const criteria: Array<[string[] | undefined, (row: T) => string]> = [
    [selection.ipAddress, r => r.ipAddress],
    [selection.interfaceAlias, r => r.ifAlias],
    [selection.interfaceIndex, r => String(r.ifIndex)],
    [selection.addressFamily, r => r.addressFamily],
    [selection.prefixLength, r => String(r.prefixLength)],
    [selection.prefixOrigin, r => r.prefixOrigin],
    [selection.suffixOrigin, r => r.suffixOrigin],
    [selection.addressState, () => 'Preferred'],
    [selection.type, r => r.type ?? 'Unicast'],
    [selection.policyStore, r => r.policyStore ?? 'ActiveStore'],
    [selection.skipAsSource, r => String(r.skipAsSource ?? false)],
  ];
  let kept = [...rows];
  for (const [values, of] of criteria) {
    if (values === undefined) continue;
    const wanted = values.map(v => v.trim().toLowerCase());
    kept = kept.filter(r => wanted.includes(of(r).toLowerCase()));
  }
  return kept;
}

export function noMatchingNetIPAddress(selection: NetIPAddressSelection): string {
  const named = selection.ipAddress?.[0];
  return named === undefined
    ? 'No MSFT_NetIPAddress objects found with the specified criteria. Verify the values and retry.'
    : `No MSFT_NetIPAddress objects found with property 'IPAddress' equal to '${named}'. Verify the value of the property and retry.`;
}

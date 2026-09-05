import { MACAddress } from '../../core/types';
import { applyCimCriteria, cimNotFound } from './cimQuery';
import {
  type NetAddressFamily, type NetPolicyStore,
  NET_ADDRESS_FAMILIES, NET_POLICY_STORES, matchEnumValue, parseNetAddress,
} from './netIpAddress';

export type NetNeighborState =
  | 'Unreachable' | 'Incomplete' | 'Probe' | 'Delay' | 'Stale' | 'Reachable' | 'Permanent';

export const NET_NEIGHBOR_STATES: readonly NetNeighborState[] = [
  'Unreachable', 'Incomplete', 'Probe', 'Delay', 'Stale', 'Reachable', 'Permanent',
];

export const NET_NEIGHBOR_CIM_CLASS = 'MSFT_NetNeighbor';

export interface NetNeighborRow {
  ifIndex: number;
  ifAlias: string;
  ipAddress: string;
  linkLayerAddress: string;
  state: NetNeighborState;
  addressFamily: NetAddressFamily;
  policyStore: NetPolicyStore;
}

export interface NetNeighborSelection {
  ipAddress?: string[];
  interfaceIndex?: string[];
  interfaceAlias?: string[];
  linkLayerAddress?: string[];
  state?: string[];
  addressFamily?: string[];
  policyStore?: string[];
}

const UNMATCHABLE = ' ';

export function normalizeLinkLayerAddress(raw: string): string | null {
  try { return new MACAddress(raw.trim()).toWindowsString(); }
  catch { return null; }
}

function canonicalAddress(raw: string): string {
  return parseNetAddress(raw)?.text ?? UNMATCHABLE;
}

function canonicalMac(raw: string): string {
  return normalizeLinkLayerAddress(raw) ?? UNMATCHABLE;
}

export function selectNetNeighbors<T extends NetNeighborRow>(
  rows: readonly T[], selection: NetNeighborSelection,
): T[] {
  return applyCimCriteria(rows, [
    [selection.ipAddress?.map(canonicalAddress), r => r.ipAddress],
    [selection.interfaceIndex, r => String(r.ifIndex)],
    [selection.interfaceAlias, r => r.ifAlias],
    [selection.linkLayerAddress?.map(canonicalMac), r => r.linkLayerAddress],
    [selection.state, r => r.state],
    [selection.addressFamily, r => r.addressFamily],
    [selection.policyStore, r => r.policyStore],
  ]);
}

export function neighborSelectionIsEmpty(selection: NetNeighborSelection): boolean {
  return Object.values(selection).every(v => v === undefined);
}

export function noMatchingNetNeighbor(selection: NetNeighborSelection): string {
  return cimNotFound(NET_NEIGHBOR_CIM_CLASS, [
    ['IPAddress', selection.ipAddress],
    ['InterfaceAlias', selection.interfaceAlias],
    ['InterfaceIndex', selection.interfaceIndex],
    ['LinkLayerAddress', selection.linkLayerAddress],
    ['State', selection.state],
    ['AddressFamily', selection.addressFamily],
  ]);
}

export interface NetNeighborRequest {
  ipAddress?: string;
  interfaceAlias?: string;
  interfaceIndex?: string;
  linkLayerAddress?: string;
  state?: string;
  addressFamily?: string;
  policyStore?: string;
}

export type ParsedNeighborAddress = NonNullable<ReturnType<typeof parseNetAddress>>;

export interface NetNeighborPlan {
  address: ParsedNeighborAddress;
  linkLayerAddress: MACAddress | null;
  interfaceAlias?: string;
  interfaceIndex?: number;
  state: NetNeighborState;
  policyStore: NetPolicyStore;
}

export type NetNeighborDecision =
  | { ok: true; plan: NetNeighborPlan; message?: undefined }
  | { ok: false; plan?: undefined; message: string };

export function planNetNeighbor(request: NetNeighborRequest): NetNeighborDecision {
  const refuse = (message: string): NetNeighborDecision => ({ ok: false, message });

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

  const hasAlias = request.interfaceAlias !== undefined && request.interfaceAlias.trim() !== '';
  const hasIndex = request.interfaceIndex !== undefined && request.interfaceIndex.trim() !== '';
  if (!hasAlias && !hasIndex) {
    return refuse('Cannot process command because of one or more missing mandatory parameters: InterfaceAlias.');
  }
  let interfaceIndex: number | undefined;
  if (hasIndex) {
    const given = request.interfaceIndex!.trim();
    if (!/^\d+$/.test(given)) {
      return refuse(`Cannot convert value "${given}" to type "System.UInt32". Error: "Input string was not in a correct format."`);
    }
    interfaceIndex = parseInt(given, 10);
  }

  let linkLayerAddress: MACAddress | null = null;
  const rawMac = (request.linkLayerAddress ?? '').trim();
  if (rawMac !== '') {
    try { linkLayerAddress = new MACAddress(rawMac); }
    catch {
      return refuse(`Cannot validate argument on parameter 'LinkLayerAddress'. The argument "${rawMac}" is not a valid link-layer address.`);
    }
  }

  const state = request.state === undefined
    ? 'Permanent'
    : matchEnumValue(NET_NEIGHBOR_STATES, request.state);
  if (state === null) {
    return refuse(`Cannot validate argument on parameter 'State'. The argument does not belong to the set "${NET_NEIGHBOR_STATES.join(',')}".`);
  }

  const policyStore = request.policyStore === undefined
    ? 'ActiveStore'
    : matchEnumValue(NET_POLICY_STORES, request.policyStore);
  if (policyStore === null) {
    return refuse(`Cannot validate argument on parameter 'PolicyStore'. The argument does not belong to the set "${NET_POLICY_STORES.join(',')}".`);
  }

  return {
    ok: true,
    plan: {
      address, linkLayerAddress,
      interfaceAlias: hasAlias ? request.interfaceAlias!.trim() : undefined,
      interfaceIndex, state, policyStore,
    },
  };
}

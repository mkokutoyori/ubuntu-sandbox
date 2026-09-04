import { applyCimCriteria, cimNotFound } from './cimQuery';
import type { NetAddressFamily } from './netIpAddress';

export interface DnsClientServerAddressRow {
  ifAlias: string;
  ifIndex: number;
  addressFamily: NetAddressFamily;
  serverAddresses: string[];
}

export interface DnsClientServerAddressSelection {
  interfaceAlias?: string[];
  interfaceIndex?: string[];
  addressFamily?: string[];
}

export function selectDnsClientServerAddresses<T extends DnsClientServerAddressRow>(
  rows: readonly T[], selection: DnsClientServerAddressSelection,
): T[] {
  return applyCimCriteria(rows, [
    [selection.interfaceAlias, r => r.ifAlias],
    [selection.interfaceIndex, r => String(r.ifIndex)],
    [selection.addressFamily, r => r.addressFamily],
  ]);
}

export function dnsServerSelectionIsEmpty(selection: DnsClientServerAddressSelection): boolean {
  return Object.values(selection).every(v => v === undefined);
}

export function noMatchingDnsClientServerAddress(
  selection: DnsClientServerAddressSelection,
): string {
  return cimNotFound('MSFT_DNSClientServerAddress', [
    ['InterfaceAlias', selection.interfaceAlias],
    ['InterfaceIndex', selection.interfaceIndex],
    ['AddressFamily', selection.addressFamily],
  ]);
}

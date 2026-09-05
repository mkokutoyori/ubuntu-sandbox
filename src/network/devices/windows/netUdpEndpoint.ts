import { PortNumber } from '../../core/ports/PortNumber';
import { applyCimCriteria, cimNotFound } from './cimQuery';
import { parseNetAddress } from './netIpAddress';

export const NET_UDP_ENDPOINT_CIM_CLASS = 'MSFT_NetUDPEndpoint';

export interface NetUdpEndpointRow {
  localAddress: string;
  localPort: number;
  pid: number;
  processName: string;
  creationTime?: string;
}

export interface NetUdpEndpointSelection {
  localAddress?: string[];
  localPort?: string[];
  owningProcess?: string[];
  creationTime?: string[];
}

const UNMATCHABLE = ' ';

function canonicalAddress(raw: string): string {
  const token = raw.trim();
  if (token === '*' || token === '') return token;
  return parseNetAddress(token)?.text ?? UNMATCHABLE;
}

export function udpPortProblem(raw: string): string | null {
  const token = raw.trim();
  if (!/^\d+$/.test(token) || !PortNumber.isValid(Number(token))) {
    return `Cannot convert value "${token}" to type "System.UInt16". Error: "Value was either too large or too small for a UInt16."`;
  }
  return null;
}

export function selectNetUdpEndpoints<T extends NetUdpEndpointRow>(
  rows: readonly T[], selection: NetUdpEndpointSelection,
): T[] {
  return applyCimCriteria(rows, [
    [selection.localAddress?.map(canonicalAddress), r => r.localAddress],
    [selection.localPort, r => String(r.localPort)],
    [selection.owningProcess, r => String(r.pid)],
    [selection.creationTime, r => r.creationTime ?? ''],
  ]);
}

export function udpEndpointSelectionIsEmpty(selection: NetUdpEndpointSelection): boolean {
  return Object.values(selection).every(v => v === undefined);
}

export function noMatchingNetUdpEndpoint(selection: NetUdpEndpointSelection): string {
  return cimNotFound(NET_UDP_ENDPOINT_CIM_CLASS, [
    ['LocalAddress', selection.localAddress],
    ['LocalPort', selection.localPort],
    ['OwningProcess', selection.owningProcess],
    ['CreationTime', selection.creationTime],
  ]);
}

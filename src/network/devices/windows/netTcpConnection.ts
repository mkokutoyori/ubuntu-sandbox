import { applyCimCriteria, cimNotFound } from './cimQuery';

export type NetTcpState =
  | 'Closed' | 'Listen' | 'SynSent' | 'SynReceived' | 'Established'
  | 'FinWait1' | 'FinWait2' | 'CloseWait' | 'Closing' | 'LastAck'
  | 'TimeWait' | 'DeleteTCB' | 'Bound';

export const NET_TCP_STATES: readonly NetTcpState[] = [
  'Closed', 'Listen', 'SynSent', 'SynReceived', 'Established',
  'FinWait1', 'FinWait2', 'CloseWait', 'Closing', 'LastAck',
  'TimeWait', 'DeleteTCB', 'Bound',
];

export type NetTcpAppliedSetting = 'Internet' | 'Datacenter' | 'Compat' | 'DatacenterCustom' | 'InternetCustom';

export const NET_TCP_APPLIED_SETTINGS: readonly NetTcpAppliedSetting[] = [
  'Internet', 'Datacenter', 'Compat', 'DatacenterCustom', 'InternetCustom',
];

export type NetTcpOffloadState = 'InHost' | 'Offloading' | 'Offloaded' | 'Uploading';

export const NET_TCP_OFFLOAD_STATES: readonly NetTcpOffloadState[] = [
  'InHost', 'Offloading', 'Offloaded', 'Uploading',
];

export function netTcpStateOf(socketState: string): NetTcpState {
  const spelled = socketState.split('_')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join('');
  const known = NET_TCP_STATES.find(s => s.toLowerCase() === spelled.toLowerCase());
  return known ?? 'Closed';
}

export interface NetTcpConnectionRow {
  localAddress: string;
  localPort: number;
  remoteAddress: string;
  remotePort: number;
  state: NetTcpState;
  appliedSetting: NetTcpAppliedSetting;
  offloadState: NetTcpOffloadState;
  owningProcess: number;
  creationTime: string;
}

export interface NetTcpConnectionSelection {
  localAddress?: string[];
  localPort?: string[];
  remoteAddress?: string[];
  remotePort?: string[];
  state?: string[];
  appliedSetting?: string[];
  offloadState?: string[];
  owningProcess?: string[];
  creationTime?: string[];
}

export function selectNetTcpConnections<T extends NetTcpConnectionRow>(
  rows: readonly T[], selection: NetTcpConnectionSelection,
): T[] {
  return applyCimCriteria(rows, [
    [selection.localAddress, r => r.localAddress],
    [selection.localPort, r => String(r.localPort)],
    [selection.remoteAddress, r => r.remoteAddress],
    [selection.remotePort, r => String(r.remotePort)],
    [selection.state, r => r.state],
    [selection.appliedSetting, r => r.appliedSetting],
    [selection.offloadState, r => r.offloadState],
    [selection.owningProcess, r => String(r.owningProcess)],
    [selection.creationTime, r => r.creationTime],
  ]);
}

export function netTcpSelectionIsEmpty(selection: NetTcpConnectionSelection): boolean {
  return Object.values(selection).every(v => v === undefined);
}

export function noMatchingNetTcpConnection(selection: NetTcpConnectionSelection): string {
  return cimNotFound('MSFT_NetTCPConnection', [
    ['LocalAddress', selection.localAddress],
    ['LocalPort', selection.localPort],
    ['RemoteAddress', selection.remoteAddress],
    ['RemotePort', selection.remotePort],
    ['State', selection.state],
    ['OwningProcess', selection.owningProcess],
  ]);
}

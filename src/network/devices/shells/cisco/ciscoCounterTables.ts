import { renderTableText, FIXED_TABLE } from '../cli/TextTable';

export interface CounterRow {
  port: string;
  inOctets: number;
  inUcast: number;
  inMcast: number;
  inBcast: number;
  outOctets: number;
  outUcast: number;
  outMcast: number;
  outBcast: number;
}

export function renderInterfaceCounters(rows: readonly CounterRow[]): string {
  const entree = renderTableText(rows, [
    { header: 'Port', width: 16, value: (r) => r.port },
    { header: 'InOctets', width: 12, align: 'right', value: (r) => String(r.inOctets) },
    { header: 'InUcastPkts', width: 15, align: 'right', value: (r) => String(r.inUcast) },
    { header: 'InMcastPkts', width: 15, align: 'right', value: (r) => String(r.inMcast) },
    { header: 'InBcastPkts', width: 15, align: 'right', value: (r) => String(r.inBcast) },
  ], FIXED_TABLE);
  const sortie = renderTableText(rows, [
    { header: 'Port', width: 16, value: (r) => r.port },
    { header: 'OutOctets', width: 12, align: 'right', value: (r) => String(r.outOctets) },
    { header: 'OutUcastPkts', width: 15, align: 'right', value: (r) => String(r.outUcast) },
    { header: 'OutMcastPkts', width: 15, align: 'right', value: (r) => String(r.outMcast) },
    { header: 'OutBcastPkts', width: 15, align: 'right', value: (r) => String(r.outBcast) },
  ], FIXED_TABLE);
  return `${entree}\n\n${sortie}`;
}

export interface ErrorCounterRow {
  port: string;
  alignErr: number;
  fcsErr: number;
  xmitErr: number;
  rcvErr: number;
  underSize: number;
  outDiscards: number;
}

export function renderInterfaceErrorCounters(rows: readonly ErrorCounterRow[]): string {
  return renderTableText(rows, [
    { header: 'Port', width: 15, value: (r) => r.port },
    { header: 'Align-Err', width: 9, align: 'right', value: (r) => String(r.alignErr) },
    { header: 'FCS-Err', width: 10, align: 'right', value: (r) => String(r.fcsErr) },
    { header: 'Xmit-Err', width: 10, align: 'right', value: (r) => String(r.xmitErr) },
    { header: 'Rcv-Err', width: 10, align: 'right', value: (r) => String(r.rcvErr) },
    { header: 'UnderSize', width: 10, align: 'right', value: (r) => String(r.underSize) },
    { header: 'OutDiscards', width: 12, align: 'right', value: (r) => String(r.outDiscards) },
  ], FIXED_TABLE);
}

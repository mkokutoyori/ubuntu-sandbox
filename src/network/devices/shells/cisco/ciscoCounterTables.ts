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

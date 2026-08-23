import { renderTable, FIXED_TABLE } from '../../../../shells/cli/TextTable';
import type { FdbEntry } from '../../../l2/BridgeFdb';

export interface BridgePortNumbers {
  numberOf(port: string): number;
}

export function renderBridgeList(names: readonly string[]): string {
  if (names.length === 0) return 'no bridge instance';
  return names.map(name => `list bridge information: ${name}`).join('\n');
}

export function renderBridgeHosts(
  bridge: string, entries: readonly FdbEntry[], ports: BridgePortNumbers,
): string {
  const header = `show bridge control interface ${bridge} host.`;
  const rows = [...entries].sort((a, b) => a.mac.localeCompare(b.mac));

  return [
    header,
    `fdb: size=${rows.length}, used=${rows.length}, num=${rows.length},`
      + ` depth=1, simple=no`,
    ...renderTable(rows, [
      { header: 'Bridge', width: 10, value: () => bridge },
      { header: 'port no', width: 9, value: (row) => String(ports.numberOf(row.port)) },
      { header: 'device', width: 11, value: (row) => row.port },
      { header: 'devname', width: 11, value: (row) => row.port },
      { header: 'mac addr', width: 20, value: (row) => row.mac },
      { header: 'ttl', width: 6, value: (row) => String(row.ttlSeconds) },
      { header: 'attributes', value: () => '' },
    ], FIXED_TABLE),
  ].join('\n');
}

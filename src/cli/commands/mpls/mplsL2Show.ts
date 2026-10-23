import { padToWidth } from '@/network/devices/shells/cli/TextTable';
import { ciscoShortInterfaceName } from '@/network/devices/shells/cisco/CiscoCommonShow';
import { formatUptime } from './mplsShow';

export interface PseudowireRow {
  readonly attachmentCircuit: string;
  readonly attachmentCircuitUp: boolean;
  readonly lineProtocolUp: boolean;
  readonly peer: string;
  readonly pwId: number;
  readonly up: boolean;
  readonly pwClass: string | null;
  readonly localLabel: number | null;
  readonly remoteLabel: number | null;
  readonly mtu: number;
  readonly remoteMtu: number | null;
  readonly groupId: number;
  readonly remoteGroupId: number | null;
  readonly output: { readonly iface: string; readonly nextHop: string; readonly tunnelLabel: string; readonly stack: readonly number[] } | null;
  readonly ageMs: number;
  readonly sinceChangeMs: number;
  readonly signaling: { readonly peerId: string; readonly up: boolean };
  readonly receivedPackets: number;
  readonly receivedBytes: number;
  readonly sentPackets: number;
  readonly sentBytes: number;
  readonly receiveDrops: number;
  readonly sendDrops: number;
}

const circuitText = 'Ethernet';

export function formatL2transportSummary(rows: readonly PseudowireRow[]): string {
  const lines = [
    'Local intf     Local circuit              Dest address    VC ID      Status',
    '-------------  -------------------------- --------------- ---------- ----------',
  ];
  for (const row of rows) {
    lines.push(
      padToWidth(ciscoShortInterfaceName(row.attachmentCircuit), 15) + padToWidth(circuitText, 27)
      + padToWidth(row.peer, 16) + padToWidth(String(row.pwId), 11) + (row.up ? 'UP' : 'DOWN'));
  }
  return lines.join('\n');
}

export function formatL2transportDetail(rows: readonly PseudowireRow[]): string {
  return rows.map(row => {
    const interfaceState = row.attachmentCircuitUp ? 'up' : 'down';
    const labels = (value: number | null) => (value === null ? 'unassigned' : String(value));
    const lines = [
      `Local interface: ${ciscoShortInterfaceName(row.attachmentCircuit)} ${interfaceState}, line protocol ${row.lineProtocolUp ? 'up' : 'down'}, ${circuitText} ${interfaceState}`,
      `  Destination address: ${row.peer}, VC ID: ${row.pwId}, VC status: ${row.up ? 'up' : 'down'}`,
    ];
    if (row.output !== null) {
      lines.push(`    Output interface: ${ciscoShortInterfaceName(row.output.iface)}, imposed label stack {${row.output.stack.join(' ')}}`);
    }
    lines.push('    Preferred path: not configured', '    Default path: active');
    if (row.output !== null) lines.push(`    Tunnel label: ${row.output.tunnelLabel}, next hop ${row.output.nextHop}`);
    lines.push(
      `    Create time: ${formatUptime(row.ageMs)}, last status change time: ${formatUptime(row.sinceChangeMs)}`,
      `    Signaling protocol: LDP, peer ${row.signaling.peerId} ${row.signaling.up ? 'up' : 'down'}`,
      `    MPLS VC labels: local ${labels(row.localLabel)}, remote ${labels(row.remoteLabel)}`,
      `    Group ID: local ${row.groupId}, remote ${row.remoteGroupId ?? 'unknown'}`,
      `    MTU: local ${row.mtu}, remote ${row.remoteMtu ?? 'unknown'}`,
      '    Remote interface description:',
      '    Sequencing: receive disabled, send disabled',
      '    VC statistics:',
      `      packet totals: receive ${row.receivedPackets}, send ${row.sentPackets}`,
      `      byte totals:   receive ${row.receivedBytes}, send ${row.sentBytes}`,
      `      packet drops:  receive ${row.receiveDrops}, send ${row.sendDrops}`,
    );
    return lines.join('\n');
  }).join('\n');
}

export function formatXconnect(rows: readonly PseudowireRow[], detail: boolean): string {
  const lines = [
    'Legend:    XC ST=Xconnect State  S1=Segment1 State  S2=Segment2 State',
    '  UP=Up       DN=Down            AD=Admin Down      IA=Inactive',
    '  SB=Standby  HS=Hot Standby     RV=Recovering      NH=No Hardware',
    '',
    'XC ST  Segment 1                         S1 Segment 2                         S2',
    '------+---------------------------------+--+---------------------------------+--',
  ];
  for (const row of rows) {
    const state = (value: boolean) => (value ? 'UP' : 'DN');
    lines.push(
      padToWidth(state(row.attachmentCircuitUp && row.up), 7)
      + padToWidth(`ac   ${ciscoShortInterfaceName(row.attachmentCircuit)}(${circuitText})`, 34) + padToWidth(state(row.attachmentCircuitUp), 3)
      + padToWidth(`mpls ${row.peer}:${row.pwId}`, 34) + state(row.up));
    if (detail) {
      lines.push(
        `        Interworking: none      Local VC label ${row.localLabel ?? 'unassigned'}`,
        `                                Remote VC label ${row.remoteLabel ?? 'unassigned'}`,
        `        pw-class: ${row.pwClass ?? 'mpls'}`,
      );
    }
  }
  return lines.join('\n');
}

export interface VfiRow {
  readonly name: string;
  readonly up: boolean;
  readonly vpnId: number;
  readonly attachmentCircuits: readonly string[];
  readonly neighbors: ReadonlyArray<{ readonly peer: string }>;
}

export function formatVfi(rows: readonly VfiRow[]): string {
  return rows.map(row => [
    `VFI name: ${row.name}, state: ${row.up ? 'up' : 'down'}`,
    `  VPN ID: ${row.vpnId}`,
    '  Local attachment circuits:',
    ...(row.attachmentCircuits.length === 0 ? [] : [`    ${row.attachmentCircuits.map(ciscoShortInterfaceName).join(' ')}`]),
    '  Neighbors connected via pseudowires:',
    '  Peer Address     VC ID      Split-horizon',
    ...row.neighbors.map(neighbor => `  ${padToWidth(neighbor.peer, 17)}${padToWidth(String(row.vpnId), 11)}Y`),
  ].join('\n')).join('\n');
}

import type { IPAddress } from '@/network/core/types';
import { ciscoShortInterfaceName } from '@/network/devices/shells/cisco/CiscoCommonShow';
import { padToWidth } from '@/network/devices/shells/cli/TextTable';
import type { MplsLabel } from '@/network/mpls/MplsLabel';

export interface MplsInterfaceRow {
  readonly name: string;
  readonly labelling: boolean;
  readonly operational: boolean;
}

export function formatMplsInterfaces(rows: readonly MplsInterfaceRow[]): string {
  const lines = ['Interface              IP            Tunnel   BGP Static Operational'];
  for (const row of rows) {
    lines.push(
      padToWidth(row.name, 23) + padToWidth(row.labelling ? 'Yes (ldp)' : 'No', 14)
      + padToWidth('No', 9) + padToWidth('No', 4) + padToWidth('No', 7) + (row.operational ? 'Yes' : 'No'));
  }
  return lines.join('\n');
}

export function labelText(label: MplsLabel): string {
  return label.isImplicitNull() ? 'imp-null' : String(label.value);
}

export interface LdpNeighborSource {
  readonly targeted: boolean;
  readonly label: string;
  readonly source: string;
  readonly role: 'active' | 'passive';
  readonly localAddress: string;
  readonly holdMs: number;
  readonly intervalMs: number;
}

export interface LdpNeighborView {
  readonly peerId: string;
  readonly localId: string;
  readonly remoteTransport: string;
  readonly remotePort: number;
  readonly localTransport: string;
  readonly localPort: number;
  readonly state: string;
  readonly mode: 'unsolicited' | 'on-demand';
  readonly messagesSent: number;
  readonly messagesReceived: number;
  readonly lastRevisionSent: number;
  readonly upMs: number;
  readonly uid: number;
  readonly peerIndex: number;
  readonly peerHoldMs: number;
  readonly keepAliveMs: number;
  readonly loop: { readonly peer: boolean; readonly local: boolean; readonly peerLimit: number; readonly localLimit: number } | null;
  readonly sources: readonly LdpNeighborSource[];
  readonly addresses: readonly string[];
}

export function formatUptime(ms: number): string {
  const total = Math.floor(ms / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  if (days > 0) return `${days}d${two(hours)}h`;
  return `${two(hours)}:${two(minutes)}:${two(seconds)}`;
}

function addressRows(addresses: readonly string[]): string[] {
  const rows: string[] = [];
  for (let i = 0; i < addresses.length; i += 4) {
    rows.push(`          ${addresses.slice(i, i + 4).map(a => padToWidth(a, 15)).join(' ').trimEnd()}`);
  }
  return rows;
}

export function formatLdpNeighbors(neighbors: readonly LdpNeighborView[], detail = false): string {
  if (neighbors.length === 0) return '';
  const blocks = neighbors.map(n => [
    `    Peer LDP Ident: ${n.peerId}; Local LDP Ident ${n.localId}`,
    `        TCP connection: ${n.remoteTransport}.${n.remotePort} - ${n.localTransport}.${n.localPort}`,
    `        State: ${n.state}; Msgs sent/rcvd: ${n.messagesSent}/${n.messagesReceived}; ${n.mode === 'on-demand' ? 'Downstream on demand' : 'Downstream'}${detail ? `; Last TIB rev sent ${n.lastRevisionSent}` : ''}`,
    `        Up time: ${formatUptime(n.upMs)}${detail ? `; UID: ${n.uid}; Peer Id ${n.peerIndex};` : ''}`,
    '        LDP discovery sources:',
    ...n.sources.flatMap(s => s.targeted
      ? [
        `          Targeted Hello ${s.localAddress} -> ${s.source}, ${s.role};`,
        `            holdtime: ${s.holdMs} ms, hello interval: ${s.intervalMs} ms`,
      ]
      : [
        `          ${s.label}, Src IP addr: ${s.source}`,
        `            holdtime: ${s.holdMs} ms, hello interval: ${s.intervalMs} ms`,
      ]),
    '        Addresses bound to peer LDP Ident:',
    ...addressRows(n.addresses),
    ...(detail ? [`        Peer holdtime: ${n.peerHoldMs} ms; KA interval: ${n.keepAliveMs} ms; Peer state: estab`] : []),
    ...(detail && n.loop !== null ? [
      `        Path Vector Loop Detection Peer/Local: ${n.loop.peer ? 'On' : 'Off'}/${n.loop.local ? 'On' : 'Off'}`,
      `        Path Vector Limit Peer/Local: ${n.loop.peerLimit}/${n.loop.localLimit}`,
    ] : []),
  ].join('\n'));
  return blocks.join('\n');
}

export interface LdpBindingView {
  readonly prefix: string;
  readonly length: number;
  readonly revision: number;
  readonly local: MplsLabel;
  readonly remote: ReadonlyArray<{ readonly peerId: string; readonly label: MplsLabel }>;
  readonly advertisedTo: readonly string[];
}

export function formatLdpBindings(rows: readonly LdpBindingView[], options: { readonly detail?: boolean; readonly showLocal?: boolean } = {}): string {
  const lines: string[] = [];
  for (const row of rows) {
    lines.push(`  lib entry: ${row.prefix}/${row.length}, rev ${row.revision}`);
    if (options.showLocal !== false) lines.push(`        local binding:  label: ${labelText(row.local)}`);
    if (options.detail === true && options.showLocal !== false && row.advertisedTo.length > 0) {
      lines.push('        Advertised to:', `        ${row.advertisedTo.join(' ')}`);
    }
    for (const remote of row.remote) lines.push(`        remote binding: lsr: ${remote.peerId}, label: ${labelText(remote.label)}`);
  }
  return lines.join('\n');
}

export interface LdpDiscoveryView {
  readonly localId: string;
  readonly helloIntervalMs: number;
  readonly transportAddress: string;
  readonly interfaces: ReadonlyArray<{
    readonly iface: string;
    readonly peers: ReadonlyArray<{ readonly id: string; readonly source: string; readonly transport: string; readonly holdSeconds: number; readonly proposedLocal: number; readonly proposedPeer: number }>;
  }>;
  readonly targeted: ReadonlyArray<{
    readonly localAddress: string; readonly remote: string; readonly role: string; readonly peerId: string | null;
    readonly transport: string | null; readonly holdSeconds: number; readonly proposedLocal: number; readonly proposedPeer: number;
  }>;
  readonly targetedIntervalMs: number;
}

export function formatLdpDiscovery(view: LdpDiscoveryView, detail = false): string {
  const lines = [' Local LDP Identifier:', `    ${view.localId}`, '    Discovery Sources:', '    Interfaces:'];
  for (const entry of view.interfaces) {
    lines.push(`        ${entry.iface} (ldp): xmit${entry.peers.length > 0 ? '/recv' : ''}`);
    if (detail) lines.push(`            Hello interval: ${view.helloIntervalMs} ms; Transport IP addr: ${view.transportAddress}`);
    for (const peer of entry.peers) {
      lines.push(`            LDP Id: ${peer.id}`);
      if (detail) {
        lines.push(`              Src IP addr: ${peer.source}; Transport IP addr: ${peer.transport}`);
        lines.push(`              Hold time: ${peer.holdSeconds} sec; Proposed local/peer: ${peer.proposedLocal}/${peer.proposedPeer} sec`);
      }
    }
  }
  if (view.targeted.length > 0) {
    lines.push('    Targeted Hellos:');
    if (detail) lines.push(`        Hello interval: ${view.targetedIntervalMs} ms; Transport IP addr: ${view.transportAddress}`);
    for (const entry of view.targeted) {
      lines.push(`        ${entry.localAddress} -> ${entry.remote} (ldp): ${entry.role}, xmit${entry.peerId === null ? '' : '/recv'}`);
      if (entry.peerId !== null) {
        lines.push(`            LDP Id: ${entry.peerId}`);
        if (detail) {
          lines.push(`              Src IP addr: ${entry.remote}; Transport IP addr: ${entry.transport}`);
          lines.push(`              Hold time: ${entry.holdSeconds} sec; Proposed local/peer: ${entry.proposedLocal}/${entry.proposedPeer} sec`);
        }
      }
    }
  }
  return lines.join('\n');
}

export interface LdpParametersView {
  readonly labelMin: number;
  readonly labelMax: number;
  readonly sessionHoldSeconds: number;
  readonly keepAliveSeconds: number;
  readonly helloHoldSeconds: number;
  readonly helloIntervalSeconds: number;
  readonly targetedHoldSeconds: number;
  readonly targetedIntervalSeconds: number;
  readonly backoffInitialSeconds: number;
  readonly backoffMaximumSeconds: number;
  readonly loop: { readonly maxHops: number; readonly pathVectorLimit: number } | null;
}

export function formatLdpParameters(view: LdpParametersView): string {
  return [
    'Protocol version: 1',
    `Downstream label pool: min label ${view.labelMin}; max label ${view.labelMax}`,
    `Session hold time: ${view.sessionHoldSeconds} sec; keep alive interval: ${view.keepAliveSeconds} sec`,
    `Discovery hello: holdtime: ${view.helloHoldSeconds} sec; interval: ${view.helloIntervalSeconds} sec`,
    `Discovery targeted hello: holdtime: ${view.targetedHoldSeconds} sec; interval: ${view.targetedIntervalSeconds} sec`,
    ...(view.loop === null ? [] : [
      `Downstream on Demand max hop count: ${view.loop.maxHops}`,
      `Downstream on Demand Path Vector Limit: ${view.loop.pathVectorLimit}`,
    ]),
    `LDP initial/maximum backoff: ${view.backoffInitialSeconds}/${view.backoffMaximumSeconds} sec`,
    ...(view.loop === null ? [] : ['LDP loop detection: on']),
  ].join('\n');
}

export function formatLdpBackoff(
  parameters: { readonly initialSeconds: number; readonly maximumSeconds: number },
  entries: ReadonlyArray<{ readonly peer: string; readonly backoffSeconds: number; readonly waitingSeconds: number }>,
): string {
  const lines = [
    `LDP initial/maximum backoff: ${parameters.initialSeconds}/${parameters.maximumSeconds} sec`,
    `Backoff table: ${entries.length} entries`,
    'LDP Id                 Backoff(sec) Waiting(sec)',
  ];
  for (const entry of entries) lines.push(`${padToWidth(`${entry.peer}:0`, 23)}${padToWidth(String(entry.backoffSeconds), 13)}${entry.waitingSeconds}`);
  return lines.join('\n');
}

export function formatLdpCapabilities(capabilities: ReadonlyArray<{ readonly description: string; readonly type: number }>): string {
  return [
    'LDP Capabilities - [<description> (<type>)]',
    '---------------------------------------------------------',
    ...capabilities.map(c => `[${c.description} (0x${c.type.toString(16).padStart(4, '0')})]`),
  ].join('\n');
}

export interface MplsForwardingView {
  readonly localLabel: MplsLabel;
  readonly outgoing: MplsLabel | 'none' | 'aggregate';
  readonly prefix: string;
  readonly bytes: number;
  readonly iface: string;
  readonly nextHop: string;
  readonly detail?: {
    readonly encapsulationBytes: number;
    readonly mtu: number;
    readonly labelStack: readonly number[];
    readonly header: string;
    readonly vpn: string | null;
  };
}

export function formatMplsForwardingTable(rows: readonly MplsForwardingView[], detail = false): string {
  const lines = [
    'Local      Outgoing   Prefix           Bytes Label   Outgoing   Next Hop',
    'Label      Label      or Tunnel Id     Switched      interface',
  ];
  for (const row of rows) {
    const outgoing = row.outgoing === 'none' ? 'No Label' : row.outgoing === 'aggregate' ? 'Aggregate'
      : row.outgoing.isImplicitNull() ? 'Pop Label' : String(row.outgoing.value);
    lines.push(
      padToWidth(String(row.localLabel.value), 11) + padToWidth(outgoing, 11) + padToWidth(row.prefix, 17)
      + padToWidth(String(row.bytes), 14) + padToWidth(ciscoShortInterfaceName(row.iface), 11) + row.nextHop);
    if (detail && row.detail !== undefined) {

      lines.push(`        MAC/Encaps=${row.detail.header.length / 2}/${row.detail.header.length / 2 + 4 * row.detail.labelStack.filter(l => l !== 3).length}, MTU=${row.detail.mtu}, Label Stack{${row.detail.labelStack.filter(l => l !== 3).join(' ')}}`);
      lines.push(`        ${row.detail.header}${row.detail.labelStack.filter(l => l !== 3).map(l => ` ${(l << 12).toString(16).padStart(8, '0').toUpperCase()}`).join('')}`);
      if (row.detail.vpn !== null) lines.push(`        VPN route: ${row.detail.vpn}`);
      lines.push('        No output feature configured');

    }
  }
  return lines.join('\n');
}

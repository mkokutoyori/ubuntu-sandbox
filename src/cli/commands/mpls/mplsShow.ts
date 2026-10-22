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

export interface LdpNeighborView {
  readonly peerId: string;
  readonly localId: string;
  readonly remoteTransport: string;
  readonly remotePort: number;
  readonly localTransport: string;
  readonly localPort: number;
  readonly state: string;
  readonly messagesSent: number;
  readonly messagesReceived: number;
  readonly upMs: number;
  readonly sources: ReadonlyArray<{ readonly iface: string; readonly source: string; readonly holdMs: number; readonly intervalMs: number }>;
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

export function formatLdpNeighbors(neighbors: readonly LdpNeighborView[]): string {
  if (neighbors.length === 0) return '';
  const blocks = neighbors.map(n => [
    `    Peer LDP Ident: ${n.peerId}; Local LDP Ident ${n.localId}`,
    `        TCP connection: ${n.remoteTransport}.${n.remotePort} - ${n.localTransport}.${n.localPort}`,
    `        State: ${n.state}; Msgs sent/rcvd: ${n.messagesSent}/${n.messagesReceived}; Downstream`,
    `        Up time: ${formatUptime(n.upMs)}`,
    '        LDP discovery sources:',
    ...n.sources.flatMap(s => [
      `          ${s.iface}, Src IP addr: ${s.source}`,
      `            holdtime: ${s.holdMs} ms, hello interval: ${s.intervalMs} ms`,
    ]),
    '        Addresses bound to peer LDP Ident:',
    ...addressRows(n.addresses),
  ].join('\n'));
  return blocks.join('\n');
}

export interface LdpBindingView {
  readonly prefix: string;
  readonly length: number;
  readonly revision: number;
  readonly local: MplsLabel;
  readonly remote: ReadonlyArray<{ readonly peerId: string; readonly label: MplsLabel }>;
}

export function formatLdpBindings(rows: readonly LdpBindingView[]): string {
  const lines: string[] = [];
  for (const row of rows) {
    lines.push(`  lib entry: ${row.prefix}/${row.length}, rev ${row.revision}`);
    lines.push(`        local binding:  label: ${labelText(row.local)}`);
    for (const remote of row.remote) lines.push(`        remote binding: lsr: ${remote.peerId}, label: ${labelText(remote.label)}`);
  }
  return lines.join('\n');
}

export interface LdpDiscoveryView {
  readonly localId: string;
  readonly interfaces: ReadonlyArray<{ readonly iface: string; readonly peers: readonly string[] }>;
}

export function formatLdpDiscovery(view: LdpDiscoveryView): string {
  const lines = [' Local LDP Identifier:', `    ${view.localId}`, '    Discovery Sources:', '    Interfaces:'];
  for (const entry of view.interfaces) {
    lines.push(`        ${entry.iface} (ldp): xmit${entry.peers.length > 0 ? '/recv' : ''}`);
    for (const peer of entry.peers) lines.push(`            LDP Id: ${peer}`);
  }
  return lines.join('\n');
}

export interface MplsForwardingView {
  readonly localLabel: MplsLabel;
  readonly outgoing: MplsLabel | 'none';
  readonly prefix: string;
  readonly bytes: number;
  readonly iface: string;
  readonly nextHop: IPAddress;
}

export function formatMplsForwardingTable(rows: readonly MplsForwardingView[]): string {
  const lines = [
    'Local      Outgoing   Prefix           Bytes Label   Outgoing   Next Hop',
    'Label      Label      or Tunnel Id     Switched      interface',
  ];
  for (const row of rows) {
    const outgoing = row.outgoing === 'none' ? 'No Label' : row.outgoing.isImplicitNull() ? 'Pop Label' : String(row.outgoing.value);
    lines.push(
      padToWidth(String(row.localLabel.value), 11) + padToWidth(outgoing, 11) + padToWidth(row.prefix, 17)
      + padToWidth(String(row.bytes), 14) + padToWidth(ciscoShortInterfaceName(row.iface), 11) + String(row.nextHop));
  }
  return lines.join('\n');
}

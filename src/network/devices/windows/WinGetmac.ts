/**
 * Windows GETMAC command — display MAC addresses for network adapters.
 *
 * Supports:
 *   getmac              — basic tabular output (Physical Address + Transport)
 *   getmac /v           — verbose (adds Connection Name + Adapter Description)
 *   getmac /fo csv      — CSV output
 *   getmac /fo list     — list-style output (one block per adapter)
 *   getmac /?           — help text
 *
 * Disconnected adapters are reported with the Transport string
 * `Media disconnected` (matches real getmac behavior).
 */

import type { WinCommandContext } from './WinCommandExecutor';

const GETMAC_HELP = `
GETMAC [/S system [/U username [/P [password]]]] [/FO format] [/NH] [/V]

Description:
    This tool enables an administrator to display the MAC address
    for the network adapters on a system.

Parameter List:
    /FO     format          Specifies the format in which the output
                            is to be displayed.
                            Valid values: "TABLE", "LIST", "CSV".

    /NH                     Specifies that the "Column Header" should
                            not be displayed in the output.
                            Valid only for TABLE and CSV formats.

    /V                      Specifies that verbose information is to be
                            displayed in the output.

    /?                      Displays this help message.

Examples:
    GETMAC /?
    GETMAC /FO csv
    GETMAC /V
    GETMAC /NH /V`.trim();

type Format = 'table' | 'list' | 'csv';

interface Row {
  connectionName: string;
  networkAdapter: string;
  physicalAddress: string;
  transport: string;
}

export function cmdGetmac(ctx: WinCommandContext, args: string[]): string {
  const lower = args.map((a) => a.toLowerCase());

  if (lower.includes('/?') || lower.includes('-?') || lower.includes('--help')) {
    return GETMAC_HELP;
  }

  const verbose = lower.includes('/v');
  const noHeader = lower.includes('/nh');
  let format: Format = 'table';
  const foIdx = lower.findIndex((a) => a === '/fo');
  if (foIdx >= 0 && foIdx + 1 < lower.length) {
    const candidate = lower[foIdx + 1].replace(/^["']|["']$/g, '');
    if (candidate === 'table' || candidate === 'list' || candidate === 'csv') {
      format = candidate;
    }
  }

  const rows = buildRows(ctx);
  if (rows.length === 0) {
    return 'No network adapters were found on the system.';
  }

  if (format === 'csv') return renderCsv(rows, verbose, noHeader);
  if (format === 'list') return renderList(rows, verbose);
  return renderTable(rows, verbose, noHeader);
}

function buildRows(ctx: WinCommandContext): Row[] {
  const rows: Row[] = [];
  for (const [name, port] of ctx.ports) {
    const mac = port.getMAC().toString().replace(/:/g, '-').toUpperCase();
    const displayName = name.replace(/^eth/, 'Ethernet ');
    const isUp = port.getIsUp() && port.isConnected();
    rows.push({
      connectionName: displayName,
      networkAdapter: 'Intel(R) Ethernet Connection',
      physicalAddress: mac,
      transport: isUp
        ? `\\Device\\Tcpip_${displayName.replace(/\s+/g, '_')}`
        : 'Media disconnected',
    });
  }
  return rows;
}

function renderTable(rows: Row[], verbose: boolean, noHeader: boolean): string {
  // Column widths
  const headers = verbose
    ? ['Connection Name', 'Network Adapter', 'Physical Address', 'Transport Name']
    : ['Physical Address', 'Transport Name'];
  const cells = rows.map((r) =>
    verbose
      ? [r.connectionName, r.networkAdapter, r.physicalAddress, r.transport]
      : [r.physicalAddress, r.transport],
  );

  const widths = headers.map((h, i) =>
    Math.max(h.length, ...cells.map((row) => row[i].length)),
  );

  const lines: string[] = [];
  if (!noHeader) {
    lines.push(headers.map((h, i) => h.padEnd(widths[i])).join(' '));
    lines.push(widths.map((w) => '='.repeat(w)).join(' '));
  }
  for (const row of cells) {
    lines.push(row.map((v, i) => v.padEnd(widths[i])).join(' '));
  }
  return lines.join('\n');
}

function renderList(rows: Row[], verbose: boolean): string {
  const blocks: string[] = [];
  for (const r of rows) {
    const pairs: [string, string][] = verbose
      ? [
          ['Connection Name', r.connectionName],
          ['Network Adapter', r.networkAdapter],
          ['Physical Address', r.physicalAddress],
          ['Transport Name', r.transport],
        ]
      : [
          ['Physical Address', r.physicalAddress],
          ['Transport Name', r.transport],
        ];
    const keyWidth = Math.max(...pairs.map(([k]) => k.length));
    blocks.push(pairs.map(([k, v]) => `${k.padEnd(keyWidth)}: ${v}`).join('\n'));
  }
  return blocks.join('\n\n');
}

function renderCsv(rows: Row[], verbose: boolean, noHeader: boolean): string {
  const headers = verbose
    ? ['"Connection Name"', '"Network Adapter"', '"Physical Address"', '"Transport Name"']
    : ['"Physical Address"', '"Transport Name"'];
  const lines: string[] = [];
  if (!noHeader) lines.push(headers.join(','));
  for (const r of rows) {
    const cells = verbose
      ? [r.connectionName, r.networkAdapter, r.physicalAddress, r.transport]
      : [r.physicalAddress, r.transport];
    lines.push(cells.map((c) => `"${c}"`).join(','));
  }
  return lines.join('\n');
}

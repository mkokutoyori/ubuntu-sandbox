import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

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

export class GetmacCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'getmac',
    summary: 'Affiche les adresses MAC des adaptateurs réseau',
    usage: GETMAC_HELP,
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'options getmac' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'réseau',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    const lower = args.map((a) => a.toLowerCase());

    if (lower.includes('/?') || lower.includes('-?') || lower.includes('--help')) {
      await ctx.io.stdout.write(GETMAC_HELP + '\n');
      return EXIT_OK;
    }

    if (!ctx.machine.netConfig) {
      await ctx.io.stdout.write('GETMAC: not supported on this device\n');
      return 1;
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

    const rows = this.buildRows(ctx);
    if (rows.length === 0) {
      await ctx.io.stdout.write('No network adapters were found on the system.\n');
      return EXIT_OK;
    }

    const out = format === 'csv' ? this.renderCsv(rows, verbose, noHeader)
      : format === 'list' ? this.renderList(rows, verbose)
      : this.renderTable(rows, verbose, noHeader);
    await ctx.io.stdout.write(out + '\n');
    return EXIT_OK;
  }

  private buildRows(ctx: CommandContext): Row[] {
    const rows: Row[] = [];
    for (const a of ctx.machine.netConfig!.adapters()) {
      const mac = a.mac.replace(/:/g, '-').toUpperCase();
      const displayName = a.name.replace(/^eth/, 'Ethernet ');
      const isUp = a.isUp && a.isConnected;
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

  private renderTable(rows: Row[], verbose: boolean, noHeader: boolean): string {
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

  private renderList(rows: Row[], verbose: boolean): string {
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

  private renderCsv(rows: Row[], verbose: boolean, noHeader: boolean): string {
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
}

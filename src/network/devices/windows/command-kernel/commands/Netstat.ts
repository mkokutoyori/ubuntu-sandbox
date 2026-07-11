import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { cmdNetstat } from '../../WinFileCommands';
import type { SocketTable } from '@/network/core/SocketTable';

export class NetstatCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'netstat',
    summary: 'Affiche les connexions réseau actives',
    usage: 'netstat [-a] [-n] [-r]',
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'options netstat' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    const socketTable = ctx.machine.net.native as SocketTable | undefined;
    // `-r` (route table) needs the full `WinCommandContext` (gateway, ports,
    // routing table) — not yet threaded through `MachineApi`, so it prints
    // nothing rather than a wrong table; real route printing lands with the
    // `route`/`ipconfig` migration pass.
    const output = cmdNetstat(args, socketTable ?? null, undefined);
    await ctx.io.stdout.write(output + '\n');
    return EXIT_OK;
  }
}

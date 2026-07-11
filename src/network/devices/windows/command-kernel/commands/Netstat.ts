import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

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
    const hasFlag = (ch: string): boolean => args.some((a) => a.startsWith('-') && !a.startsWith('--') && a.includes(ch));

    if (hasFlag('r')) {
      // Route table needs gateway/interface data not yet exposed by
      // `NetworkApi` — prints nothing rather than a wrong table, matching
      // the pre-migration bridge's documented gap.
      await ctx.io.stdout.write('\n');
      return EXIT_OK;
    }

    const showAll = hasFlag('a');
    const lines: string[] = ['', 'Active Connections', '', '  Proto  Local Address          Foreign Address        State'];

    const sockets = (await ctx.machine.net.connections?.()) ?? [];
    for (const sock of sockets) {
      if (!showAll && sock.state !== 'ESTABLISHED') continue;
      const proto = sock.protocol.toUpperCase();
      const local = `0.0.0.0:${sock.localPort}`.padEnd(22);
      const remote = (sock.state === 'LISTEN' ? '0.0.0.0:0' : `${sock.remoteAddress}:${sock.remotePort}`).padEnd(22);
      const state = sock.state === 'LISTEN' ? 'LISTENING' : sock.state;
      lines.push(`  ${proto.padEnd(7)}${local}${remote}${state}`);
    }

    await ctx.io.stdout.write(lines.join('\n') + '\n');
    return EXIT_OK;
  }
}

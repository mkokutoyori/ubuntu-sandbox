import { CommandContext, CommandDescriptor, ExitCode, EXIT_OK } from '@/command-kernel/command/types';
import { BaseCommand } from '@/command-kernel/command/base-command';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ARPING_USAGE = 'Usage: arping [-fqbDUAV] [-c count] [-w timeout] [-I device] destination';

export class ArpingCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'arping',
    summary: 'Send ARP REQUEST to a neighbour host.',
    usage: ARPING_USAGE,
    args: [{ name: 'argv', type: 'string', required: false, variadic: true, description: 'options et destination (analysées par la commande)' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'réseau',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = [...ctx.rawArgv];
    let count = 0;
    let target = '';
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-c') { count = parseInt(args[++i], 10) || 0; continue; }
      if (a === '-I' || a === '-i' || a === '-s' || a === '-w') { i++; continue; }
      if (!a.startsWith('-')) target = a;
    }
    if (!target) {
      await ctx.io.stdout.write(`${ARPING_USAGE}\n`);
      return 2;
    }

    const probes = count > 0 ? count : 1;
    const mac = ctx.machine.netProbe?.neighborMac(target) ?? null;
    const lines = [`ARPING ${target}`];
    if (mac) {
      for (let i = 0; i < probes; i++) {
        lines.push(`Unicast reply from ${target} [${mac}]  0.${String(500 + i).padStart(3, '0')}ms`);
      }
      lines.push(`Sent ${probes} probes (${probes} broadcast(s))`);
      lines.push(`Received ${probes} response(s)`);
      await ctx.io.stdout.write(`${lines.join('\n')}\n`);
      return EXIT_OK;
    }
    lines.push(`Sent ${probes} probes (${probes} broadcast(s))`);
    lines.push('Received 0 response(s)');
    await ctx.io.stdout.write(`${lines.join('\n')}\n`);
    return 1;
  }
}

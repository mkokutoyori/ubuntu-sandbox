import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

export class NbtstatCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'nbtstat',
    summary: 'Affiche les statistiques NetBIOS sur TCP/IP',
    usage: 'nbtstat [-a RemoteName] [-A adresse IP] [-n]',
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'options nbtstat' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    const flag = args[0]?.toLowerCase();
    if (flag === '-n') {
      await ctx.io.stdout.write([
        '',
        '    Node IpAddress: [0.0.0.0] Scope Id: []',
        '',
        '                       NetBIOS Local Name Table',
        '',
        '       Name               Type         Status',
        '    ---------------------------------------------',
        `    ${ctx.machine.hostname.toUpperCase().padEnd(16)} <00>  UNIQUE      Registered`,
        `    WORKGROUP        <00>  GROUP       Registered`,
        '',
      ].join('\n') + '\n');
      return EXIT_OK;
    }
    await ctx.io.stdout.write('NBTSTAT [ [-a RemoteName] [-A IP address] [-c] [-n] [-r] [-R] [-RR] [-s] [-S] [interval] ]\n');
    return EXIT_OK;
  }
}

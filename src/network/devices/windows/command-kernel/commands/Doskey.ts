import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

export class DoskeyCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'doskey',
    summary: 'Définit ou affiche les macros de ligne de commande',
    usage: 'doskey [macro=commande]',
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'définition de macro' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    if (!ctx.machine.macros) {
      await ctx.io.stdout.write('DOSKEY: not supported on this device\n');
      return 1;
    }
    const joined = args.join(' ');
    if (args.length === 0 || !joined.includes('=')) {
      const listing = ctx.machine.macros.list().map((e) => `${e.head}=${e.body}`).join('\n');
      await ctx.io.stdout.write(listing + '\n');
      return EXIT_OK;
    }
    ctx.machine.macros.define(joined);
    return EXIT_OK;
  }
}

import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

export class ScCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'sc',
    aliases: ['sc.exe'],
    summary: 'Contrôle les services Windows',
    usage: 'sc <query|start|stop|config|...> <service>',
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'sous-commande sc' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    if (!ctx.machine.services) {
      await ctx.io.stdout.write('SC: not supported on this device\n');
      return 1;
    }
    const output = await ctx.machine.services.execute(args, { isAdmin: ctx.session.user.isRoot(), userName: ctx.session.user.name });
    await ctx.io.stdout.write(output + '\n');
    return EXIT_OK;
  }
}

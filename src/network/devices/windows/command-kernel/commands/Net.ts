import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

export class NetCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'net',
    summary: 'Administre comptes, groupes, services et partages réseau',
    usage: 'net <user|localgroup|start|stop|share|session|use|accounts> ...',
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'sous-commande net' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    if (!ctx.machine.netExe) {
      await ctx.io.stdout.write('NET: not supported on this device\n');
      return 1;
    }
    const output = await ctx.machine.netExe.execute(args, { isAdmin: ctx.session.user.isRoot(), userName: ctx.session.user.name });
    await ctx.io.stdout.write(output + '\n');
    return EXIT_OK;
  }
}

import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { cmdSc } from '../../WinSc';
import type { WindowsServiceManager } from '../../WindowsServiceManager';
import type { WindowsProcessManager } from '../../WindowsProcessManager';

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
    const serviceManager = ctx.machine.servicesNative as WindowsServiceManager;
    const processManager = ctx.machine.proc.native as WindowsProcessManager;
    const output = cmdSc(
      { serviceManager, processManager, isAdmin: ctx.session.user.isRoot(), currentUser: ctx.session.user.name },
      args,
    );
    await ctx.io.stdout.write(output + '\n');
    return EXIT_OK;
  }
}

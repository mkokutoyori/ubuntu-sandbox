import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { cmdTasklist } from '../../WinTasklist';
import type { WindowsProcessManager } from '../../WindowsProcessManager';

export class TasklistCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'tasklist',
    summary: 'Liste les processus en cours',
    usage: 'tasklist [/svc] [/v] [/fi filtre] [/fo format]',
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'options tasklist' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    const processManager = ctx.machine.proc.native as WindowsProcessManager;
    const output = cmdTasklist(
      { processManager, currentUser: ctx.session.user.name, hostname: ctx.machine.hostname },
      args,
    );
    await ctx.io.stdout.write(output + '\n');
    return EXIT_OK;
  }
}

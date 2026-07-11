import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { cmdTaskkill } from '../../WinTaskkill';
import type { WindowsProcessManager } from '../../WindowsProcessManager';

export class TaskkillCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'taskkill',
    summary: 'Termine un ou plusieurs processus',
    usage: 'taskkill /pid <pid> | /im <nom> [/f] [/t]',
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'options taskkill' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    const processManager = ctx.machine.proc.native as WindowsProcessManager;
    const output = cmdTaskkill({ processManager, isAdmin: ctx.session.user.isRoot() }, args);
    await ctx.io.stdout.write(output + '\n');
    return EXIT_OK;
  }
}

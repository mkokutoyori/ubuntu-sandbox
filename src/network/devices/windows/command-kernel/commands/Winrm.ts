import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

export class WinrmCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'winrm',
    summary: 'Configure et interroge le service Windows Remote Management',
    usage: 'winrm quickconfig|enumerate|get|set [options]',
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'sous-commande winrm' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    if (!ctx.machine.winRm) {
      await ctx.io.stdout.write('WINRM: not supported on this device\n');
      return 1;
    }
    const output = await ctx.machine.winRm.execute(args);
    await ctx.io.stdout.write(output + '\n');
    return EXIT_OK;
  }
}

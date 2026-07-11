import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { cmdReg } from '../../WinRegCommand';

export class RegCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'reg',
    summary: 'Consulte et modifie le registre',
    usage: 'reg query|add|delete <clé> [/v nom] [/t type] [/d données] [/s]',
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'sous-commande reg' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    if (!ctx.machine.registry) {
      await ctx.io.stdout.write('REG: not supported on this device\n');
      return 1;
    }
    const output = cmdReg(ctx.machine.registry, args);
    await ctx.io.stdout.write(output + '\n');
    return output.startsWith('ERROR:') ? 1 : EXIT_OK;
  }
}

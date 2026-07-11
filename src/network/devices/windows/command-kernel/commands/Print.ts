import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

export class PrintCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'print',
    summary: 'Soumet un fichier à l\'impression',
    usage: 'print [/D:device] [[lecteur:][chemin]fichier[...]]',
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'options et fichiers' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    if (!ctx.machine.printing) {
      await ctx.io.stdout.write('PRINT: not supported on this device\n');
      return 1;
    }
    const output = await ctx.machine.printing.execute(args, { userName: ctx.session.user.name });
    await ctx.io.stdout.write(output + '\n');
    return output.includes('service is not running') || output.startsWith('Usage:') ? 1 : EXIT_OK;
  }
}

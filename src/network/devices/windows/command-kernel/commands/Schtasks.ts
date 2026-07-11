import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

export class SchtasksCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'schtasks',
    summary: 'Crée, supprime, interroge et exécute des tâches planifiées',
    usage: 'schtasks /query|/create|/delete|/run|/change|/end [options]',
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'sous-commande schtasks' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    if (!ctx.machine.scheduling) {
      await ctx.io.stdout.write('SCHTASKS: not supported on this device\n');
      return 1;
    }
    const output = await ctx.machine.scheduling.execute(args);
    await ctx.io.stdout.write(output + '\n');
    return output.startsWith('ERROR:') ? 1 : EXIT_OK;
  }
}

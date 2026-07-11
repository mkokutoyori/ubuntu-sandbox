import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

export class TimeCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'time',
    summary: "Affiche l'heure courante",
    usage: 'time',
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: '(ignoré, comme legacy)' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const d = ctx.machine.now();
    const h24 = d.getHours();
    const min = String(d.getMinutes()).padStart(2, '0');
    const tt = h24 >= 12 ? 'PM' : 'AM';
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    await ctx.io.stdout.write(`${h12}:${min} ${tt}\n`);
    return EXIT_OK;
  }
}

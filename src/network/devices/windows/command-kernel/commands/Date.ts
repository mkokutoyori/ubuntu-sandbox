import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export class DateCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'date',
    summary: 'Affiche la date du jour',
    usage: 'date',
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: '(ignoré, comme legacy)' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const d = ctx.machine.now();
    const dow = DAYS[d.getDay()];
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    await ctx.io.stdout.write(`${dow} ${mm}/${dd}/${d.getFullYear()}\n`);
    return EXIT_OK;
  }
}

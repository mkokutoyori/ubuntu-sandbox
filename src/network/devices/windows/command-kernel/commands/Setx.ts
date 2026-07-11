import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

export class SetxCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'setx',
    summary: 'Définit une variable d\'environnement de façon persistante',
    usage: 'setx <variable> <valeur> [/m]',
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'options, variable et valeur' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const tokens = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    const filtered = tokens.filter((t) => t.toUpperCase() !== '/M');
    if (filtered.length < 2) {
      await ctx.io.stdout.write('ERROR: Invalid syntax. Type "SETX /?" for usage.\n');
      return 1;
    }
    const name = filtered[0];
    const value = filtered.slice(1).join(' ').replace(/^"(.*)"$/, '$1');
    ctx.session.env.set(name, value);
    await ctx.io.stdout.write('SUCCESS: Specified value was saved.\n');
    return EXIT_OK;
  }
}

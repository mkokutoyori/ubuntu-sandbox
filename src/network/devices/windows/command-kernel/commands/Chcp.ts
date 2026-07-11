import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

export class ChcpCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'chcp',
    summary: 'Affiche ou définit la page de code active',
    usage: 'chcp [page-de-code]',
    args: [{ name: 'codePage', type: 'string', required: false, description: 'page de code' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    if (!ctx.args.has('codePage')) {
      await ctx.io.stdout.write('Active code page: 65001\n');
      return EXIT_OK;
    }
    const cp = parseInt(ctx.args.get<string>('codePage'), 10);
    await ctx.io.stdout.write((isNaN(cp) ? 'Invalid code page' : `Active code page: ${cp}`) + '\n');
    return EXIT_OK;
  }
}

import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

/**
 * cmd.exe's `echo` has no flags at all — `echo -n foo` prints "-n foo"
 * verbatim. This is why it is a separate class from command-kernel's
 * bash-flavoured `EchoCommand` (which interprets `-n`/`-e`).
 */
export class WinEchoCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'echo',
    summary: 'Affiche ses arguments',
    usage: 'echo [texte...]',
    args: [{ name: 'words', type: 'string', required: false, variadic: true, description: 'texte à afficher' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'session',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const words = ctx.args.has('words') ? ctx.args.get<string[]>('words') : [];
    await ctx.io.stdout.write(words.join(' ') + '\n');
    return EXIT_OK;
  }
}

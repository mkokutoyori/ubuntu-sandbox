import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * `EDIT [fichier]` — édition externe non supportée par ce simulateur ;
 * répond toujours par le message vendeur exact, quel que soit l'argument.
 */
export class SqlPlusEditCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'EDIT',
    summary: 'Édite le tampon SQL (non supporté par ce simulateur)',
    usage: 'EDIT',
    args: [
      { name: 'rest', type: 'string', required: false, variadic: true, description: 'ignoré (parité vendeur)' },
    ],
    options: [],
    privileges: ANY,
    category: 'sqlplus',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stdout.write('SP2-0107: Nothing to save.\n');
    return EXIT_OK;
  }
}

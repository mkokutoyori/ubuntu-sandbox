import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * EXIT / QUIT — déconnecte la session courante et affiche la bannière de
 * déconnexion. Wave 1 : ne signale pas encore la sortie du sous-shell
 * interactif (`SubShellResult.exit`) — ce câblage appartient à la vague qui
 * branchera ce socle sur `SqlPlusSubShell` (voir CHANGELOG).
 */
export class SqlPlusExitCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'EXIT',
    aliases: ['QUIT'],
    summary: 'Déconnecte la session et quitte SQL*Plus',
    usage: 'EXIT',
    args: [
      { name: 'rest', type: 'string', required: false, variadic: true, description: 'ignoré (parité vendeur : EXIT accepte du texte final)' },
    ],
    options: [],
    privileges: ANY,
    category: 'sqlplus',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    ctx.machine.oracle!.disconnect();
    await ctx.io.stdout.write('Disconnected from Oracle Database 19c Enterprise Edition Release 19.0.0.0.0 - Production\n');
    return EXIT_OK;
  }
}

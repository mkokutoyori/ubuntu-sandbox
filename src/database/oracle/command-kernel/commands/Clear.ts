import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * CLEAR <target> (SCR[EEN], BUFFER, COLUMNS…) — no-op côté moteur SQL*Plus,
 * comme le legacy. L'effacement effectif de l'écran terminal reste décidé
 * par l'hôte du sous-shell (`SqlPlusSubShell.processLine`, détection
 * `CLEAR SCR` sur la ligne brute), hors périmètre de cette commande.
 */
export class SqlPlusClearCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'CLEAR',
    summary: 'Efface un tampon SQL*Plus (SCREEN, BUFFER, COLUMNS…)',
    usage: 'CLEAR <target>',
    args: [
      { name: 'target', type: 'string', required: false, variadic: true, description: 'SCR[EEN] | BUFFER | COLUMNS | …' },
    ],
    options: [],
    privileges: ANY,
    category: 'sqlplus',
  };

  async execute(_ctx: CommandContext): Promise<ExitCode> {
    return EXIT_OK;
  }
}

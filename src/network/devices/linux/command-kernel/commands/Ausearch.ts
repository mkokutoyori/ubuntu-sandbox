import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * `ausearch [options]` — délègue à `machine.auditJournal.ausearch`, qui
 * appelle `cmdAusearch` (fonction pure) contre le vrai journal d'audit :
 * c'est la commande elle-même, pas un formateur contourné. Privilège
 * vérifié inline (message vendeur exact `ausearch: Permission denied`,
 * plutôt que la politique générique ROOT dont le motif français ne
 * correspond pas — cf. `mount`/`umount`).
 */
export class AusearchCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'ausearch',
    summary: 'Recherche des événements dans le journal d\'audit',
    usage: 'ausearch [options]',
    args: [
      { name: 'rest', type: 'string', required: false, variadic: true, description: '-m/-ui/-ua/-u/-x/-c/-k/-f/-i/--success' },
    ],
    options: [],
    privileges: ANY,
    category: 'linux',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    if (!ctx.session.user.isRoot()) {
      await ctx.io.stdout.write('ausearch: Permission denied\n');
      return 1;
    }
    const args = ctx.args.get<string[] | undefined>('rest') ?? [];
    await ctx.io.stdout.write(ctx.machine.auditJournal!.ausearch(args) + '\n');
    return EXIT_OK;
  }
}

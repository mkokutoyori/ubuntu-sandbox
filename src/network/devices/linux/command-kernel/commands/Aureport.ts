import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * `aureport [options]` — délègue à `machine.auditJournal.aureport`, qui
 * appelle `cmdAureport` (fonction pure) contre le vrai journal d'audit.
 * Privilège vérifié inline (message vendeur exact, cf. `ausearch`).
 */
export class AureportCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'aureport',
    summary: 'Produit un rapport de synthèse du journal d\'audit',
    usage: 'aureport [options]',
    args: [
      { name: 'rest', type: 'string', required: false, variadic: true, description: '-x/-u/-g/-f/-s/-t/-k/-l/-a/-e/-m/-i/-h/-c' },
    ],
    options: [],
    privileges: ANY,
    category: 'linux',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    if (!ctx.session.user.isRoot()) {
      await ctx.io.stdout.write('aureport: Permission denied\n');
      return 1;
    }
    const args = ctx.args.get<string[] | undefined>('rest') ?? [];
    await ctx.io.stdout.write(ctx.machine.auditJournal!.aureport(args) + '\n');
    return EXIT_OK;
  }
}

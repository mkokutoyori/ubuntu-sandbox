import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * `auditctl [options]` — délègue à `machine.auditJournal.auditctl`, qui
 * appelle le gestionnaire déjà public de l'exécuteur (`handleAuditctl`,
 * qui porte aussi les vérifications de démon `auditd` actif/suspendu).
 * Privilège vérifié inline (message vendeur exact, cf. `ausearch`).
 */
export class AuditctlCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'auditctl',
    summary: 'Configure les règles et le statut du démon d\'audit',
    usage: 'auditctl [options]',
    args: [
      { name: 'rest', type: 'string', required: false, variadic: true, description: '-l/-s/-D/-e/-f/-b/-r/-w/-W/-a/-A/-d' },
    ],
    options: [],
    privileges: ANY,
    category: 'linux',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    if (!ctx.session.user.isRoot()) {
      await ctx.io.stdout.write('auditctl: Permission denied\n');
      return 1;
    }
    const args = ctx.args.get<string[] | undefined>('rest') ?? [];
    const { output, exitCode } = ctx.machine.auditJournal!.auditctl(args);
    if (output) await ctx.io.stdout.write(output + '\n');
    return exitCode;
  }
}

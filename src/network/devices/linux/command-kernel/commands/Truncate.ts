import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { toFileSystemActor } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

/**
 * `truncate` — ajuste la taille d'un fichier. Le simulateur ne modélise pas
 * les tailles d'octets : comme le legacy, la commande se limite à créer un
 * fichier vide s'il n'existe pas, et publie les évènements d'audit
 * (`fsAccess`/`syscall` « truncate ») pour que `auditctl -w` les capte.
 */
export class TruncateCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'truncate',
    summary: 'Ajuste (crée) un fichier à une taille',
    usage: 'truncate -s TAILLE FICHIER...',
    args: [{ name: 'operands', type: 'string', required: false, variadic: true, description: 'FICHIER(s) (et -s TAILLE)' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'fichiers',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const operands = ctx.args.has('operands') ? ctx.args.get<string[]>('operands') : [];
    // Ignore les options (`-s TAILLE` inclus) : seuls les chemins comptent.
    const files = operands.filter((a, i) => !a.startsWith('-') && operands[i - 1] !== '-s');
    const actor = toFileSystemActor(ctx.session.user);

    for (const p of files) {
      const abs = ctx.machine.fs.resolve(ctx.session.cwd, p);
      ctx.machine.audit?.fsAccess(abs, 'w', 'truncate');
      ctx.machine.audit?.syscall('truncate', abs);
      if (!(await ctx.machine.fs.exists(abs, actor))) {
        await ctx.machine.fs.writeFile(abs, '', actor);
      }
    }
    return EXIT_OK;
  }
}

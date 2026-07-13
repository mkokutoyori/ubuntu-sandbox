import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

/**
 * `mktemp` — renvoie un nom de fichier temporaire unique sous `/tmp`. Le
 * simulateur ne matérialise pas le fichier (comportement historique
 * conservé à l'identique) : seul un nom au format `/tmp/tmp.<aléa>` est
 * imprimé. Les options (`-d`, template `XXXXXX`...) sont acceptées mais
 * ignorées, comme dans le legacy.
 */
export class MktempCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'mktemp',
    summary: 'Génère un nom de fichier temporaire unique',
    usage: 'mktemp [OPTION]... [MODÈLE]',
    args: [{ name: 'operands', type: 'string', required: false, variadic: true, description: 'modèle optionnel' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'fichiers',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stdout.write('/tmp/tmp.' + Math.random().toString(36).slice(2, 12) + '\n');
    return EXIT_OK;
  }
}

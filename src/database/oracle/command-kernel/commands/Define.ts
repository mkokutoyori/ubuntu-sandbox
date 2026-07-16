import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * `DEFINE [var[=valeur]]` — sans argument, liste toutes les variables de
 * substitution (ou les 2 built-ins `_SQLPLUS_RELEASE`/`_EDITOR` si aucune
 * n'est définie) ; `DEFINE var` affiche une variable unique (SP2-0135 si
 * absente) ; `DEFINE var=valeur` la positionne (guillemets englobants
 * retirés). Mutation déléguée à `machine.oracle.setDefine` (partagée avec
 * le legacy `SQLPlusSession.handleDefine`).
 */
export class SqlPlusDefineCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'DEFINE',
    summary: 'Définit ou affiche une variable de substitution',
    usage: 'DEFINE [variable[=valeur]]',
    args: [
      { name: 'rest', type: 'string', required: false, variadic: true, description: 'nom[=valeur], vide pour tout lister' },
    ],
    options: [],
    privileges: ANY,
    category: 'sqlplus',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const oracle = ctx.machine.oracle!;
    const args = (ctx.args.get<string[] | undefined>('rest') ?? []).join(' ');

    if (!args) {
      const out: string[] = [];
      for (const [name, value] of oracle.defines()) {
        out.push(`DEFINE ${name}           = "${value}"`);
      }
      if (out.length === 0) {
        out.push('DEFINE _SQLPLUS_RELEASE = "1903000000"');
        out.push('DEFINE _EDITOR         = "vi"');
      }
      await ctx.io.stdout.write(out.join('\n') + '\n');
      return EXIT_OK;
    }

    if (!args.includes('=')) {
      const varName = args.trim().toUpperCase();
      const value = oracle.defines().get(varName);
      if (value !== undefined) {
        await ctx.io.stdout.write(`DEFINE ${varName}           = "${value}"\n`);
      } else {
        await ctx.io.stdout.write(`SP2-0135: symbol ${varName.toLowerCase()} is UNDEFINED\n`);
      }
      return EXIT_OK;
    }

    const eqIdx = args.indexOf('=');
    const varName = args.substring(0, eqIdx).trim().toUpperCase();
    const value = args.substring(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
    oracle.setDefine(varName, value);
    return EXIT_OK;
  }
}

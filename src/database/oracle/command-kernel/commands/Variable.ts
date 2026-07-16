import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * `VARIABLE [nom [type]]` (alias `VAR`) — sans argument, liste les
 * variables liées déjà déclarées (silencieux si aucune, comme le vrai
 * client) ; avec un nom, la déclare (type par défaut `VARCHAR2(100)`).
 * Mutation déléguée à `machine.oracle.declareBindVariable`.
 */
export class SqlPlusVariableCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'VARIABLE',
    aliases: ['VAR'],
    summary: 'Déclare une variable liée',
    usage: 'VARIABLE [nom [type]]',
    args: [
      { name: 'rest', type: 'string', required: false, variadic: true, description: 'nom et type (défaut VARCHAR2(100)), vide pour tout lister' },
    ],
    options: [],
    privileges: ANY,
    category: 'sqlplus',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const oracle = ctx.machine.oracle!;
    const parts = ctx.args.get<string[] | undefined>('rest') ?? [];

    if (parts.length === 0) {
      const out: string[] = [];
      for (const [name, info] of oracle.bindVariables()) {
        out.push(`variable   ${name}`);
        out.push(`datatype   ${info.type}`);
      }
      if (out.length > 0) await ctx.io.stdout.write(out.join('\n') + '\n');
      return EXIT_OK;
    }

    const varName = parts[0].toUpperCase();
    const varType = parts[1] || 'VARCHAR2(100)';
    oracle.declareBindVariable(varName, varType);
    return EXIT_OK;
  }
}

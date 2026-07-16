import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * SET <option> <value> — définit une option système SQL*Plus. Mutation pure
 * déléguée à `machine.oracle.applySetOption` (partagée avec le legacy
 * `SQLPlusSession.handleSet`, qui appelle la même méthode réelle).
 */
export class SqlPlusSetCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'SET',
    summary: 'Définit une option système SQL*Plus (LINESIZE, PAGESIZE, SERVEROUTPUT…)',
    usage: 'SET <option> <value>',
    args: [
      { name: 'option', type: 'string', required: true, description: "nom de l'option (LINESIZE, PAGESIZE, SERVEROUTPUT, FEEDBACK…)" },
      { name: 'value', type: 'string', required: false, variadic: true, description: 'valeur (ON/OFF, entier, chaîne…)' },
    ],
    options: [],
    privileges: ANY,
    category: 'sqlplus',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const option = ctx.args.get<string>('option').toUpperCase();
    const valueParts = ctx.args.get<string[] | undefined>('value') ?? [];
    const value = valueParts.join(' ');
    const result = ctx.machine.oracle!.applySetOption(option, value);
    if (!result.ok) {
      await ctx.io.stdout.write(`${result.error ?? ''}\n`);
      return 1;
    }
    return EXIT_OK;
  }
}

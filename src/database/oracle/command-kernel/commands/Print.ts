import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * `PRINT [nom]` — sans argument, affiche toutes les variables liées
 * (bloc nom + soulignement + valeur par variable) ; avec un nom, affiche
 * cette seule variable (SP2-0552 si non déclarée).
 */
export class SqlPlusPrintCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'PRINT',
    summary: 'Affiche la valeur d\'une variable liée',
    usage: 'PRINT [nom]',
    args: [
      { name: 'rest', type: 'string', required: false, variadic: true, description: 'nom de la variable, vide pour toutes les afficher' },
    ],
    options: [],
    privileges: ANY,
    category: 'sqlplus',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const oracle = ctx.machine.oracle!;
    const parts = ctx.args.get<string[] | undefined>('rest') ?? [];

    const renderValue = (value: unknown): string =>
      value !== null && value !== undefined ? String(value) : '';

    if (parts.length === 0) {
      const out: string[] = [];
      for (const [name, info] of oracle.bindVariables()) {
        out.push('');
        out.push(name);
        out.push('-'.repeat(name.length > 10 ? name.length : 10));
        out.push(renderValue(info.value));
      }
      if (out.length > 0) await ctx.io.stdout.write(out.join('\n') + '\n');
      return EXIT_OK;
    }

    const varName = parts.join(' ').toUpperCase();
    const info = oracle.bindVariables().get(varName);
    if (!info) {
      await ctx.io.stdout.write(`SP2-0552: Bind variable "${varName}" not declared.\n`);
      return EXIT_OK;
    }

    const out = ['', varName, '-'.repeat(varName.length > 10 ? varName.length : 10), renderValue(info.value)];
    await ctx.io.stdout.write(out.join('\n') + '\n');
    return EXIT_OK;
  }
}

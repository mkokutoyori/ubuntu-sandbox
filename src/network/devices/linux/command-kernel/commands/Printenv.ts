import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

/**
 * `printenv` — affiche l'environnement (toutes les variables `NOM=valeur`),
 * ou la valeur de variables nommées (une par ligne, code de sortie 1 si
 * l'une est absente). L'environnement provient de la session command-kernel.
 */
export class PrintenvCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'printenv',
    summary: 'Affiche tout ou partie de l\'environnement',
    usage: 'printenv [VARIABLE...]',
    args: [{ name: 'names', type: 'string', required: false, variadic: true, description: 'variables à afficher' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const operands = ctx.args.has('names') ? ctx.args.get<string[]>('names') : [];
    const names = operands.filter((a) => !a.startsWith('-'));
    const env = ctx.session.env;

    if (names.length === 0) {
      const lines = [...env.entries()].map(([k, v]) => `${k}=${v}`);
      await ctx.io.stdout.write(lines.length ? lines.join('\n') + '\n' : '');
      return EXIT_OK;
    }

    const out: string[] = [];
    let missing = false;
    for (const name of names) {
      const v = env.get(name);
      if (v === undefined) missing = true;
      else out.push(v);
    }
    await ctx.io.stdout.write(out.length ? out.join('\n') + '\n' : '');
    return missing ? 1 : EXIT_OK;
  }
}

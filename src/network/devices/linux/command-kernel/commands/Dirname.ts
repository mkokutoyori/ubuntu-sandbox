import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

/** Composant répertoire d'un chemin (`dirname`), sémantique POSIX. */
function dirComponent(path: string): string {
  let i = path.length;
  while (i > 0 && path[i - 1] === '/') i--;        // slashs finaux
  while (i > 0 && path[i - 1] !== '/') i--;         // dernier composant
  while (i > 0 && path[i - 1] === '/') i--;         // slashs séparateurs
  if (i === 0) return path[0] === '/' ? '/' : '.';
  return path.slice(0, i);
}

export class DirnameCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'dirname',
    summary: 'Affiche le composant répertoire d\'un chemin',
    usage: 'dirname [OPTION] NOM...',
    args: [{ name: 'operands', type: 'string', required: true, variadic: true, description: 'chemin(s)' }],
    options: [
      { long: 'zero', short: 'z', takesValue: false, description: 'termine chaque sortie par NUL au lieu de saut de ligne' },
    ],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'fichiers',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const operands = ctx.args.get<string[]>('operands');
    const sep = ctx.args.flag('zero') ? '\0' : '\n';
    const out = operands.map(dirComponent).join(sep) + sep;
    await ctx.io.stdout.write(out);
    return EXIT_OK;
  }
}

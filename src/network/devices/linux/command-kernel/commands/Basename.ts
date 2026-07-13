import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

/** Dernier composant d'un chemin (`basename`), sémantique POSIX : les slashs finaux sont ignorés, un chemin entièrement composé de slashs donne `/`. */
function baseComponent(path: string): string {
  let end = path.length;
  while (end > 0 && path[end - 1] === '/') end--;
  if (end === 0) return path.length > 0 ? '/' : '';
  let start = end;
  while (start > 0 && path[start - 1] !== '/') start--;
  return path.slice(start, end);
}

/** Retire le suffixe `suffix` de `name` s'il y est présent sans le vider entièrement (comportement coreutils). */
function stripSuffix(name: string, suffix: string): string {
  if (suffix && name !== suffix && name.endsWith(suffix)) return name.slice(0, name.length - suffix.length);
  return name;
}

export class BasenameCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'basename',
    summary: 'Affiche le dernier composant d\'un chemin',
    usage: 'basename NOM [SUFFIXE]\n   ou : basename OPTION... NOM...',
    args: [{ name: 'operands', type: 'string', required: true, variadic: true, description: 'chemin(s) (et suffixe optionnel)' }],
    options: [
      { long: 'multiple', short: 'a', takesValue: false, description: 'traite chaque argument comme un NOM' },
      { long: 'suffix', short: 's', takesValue: true, type: 'string', description: 'retire un SUFFIXE final (implique -a)' },
      { long: 'zero', short: 'z', takesValue: false, description: 'termine chaque sortie par NUL au lieu de saut de ligne' },
    ],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'fichiers',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const operands = ctx.args.get<string[]>('operands');
    const zero = ctx.args.flag('zero');
    const hasSuffixOpt = ctx.args.has('suffix');
    const multiple = ctx.args.flag('multiple') || hasSuffixOpt;

    let names: string[];
    let suffix = '';
    if (multiple) {
      names = operands;
      if (hasSuffixOpt) suffix = ctx.args.get<string>('suffix');
    } else {
      // Forme historique `basename NOM [SUFFIXE]`.
      names = [operands[0]];
      if (operands.length >= 2) suffix = operands[1];
    }

    const sep = zero ? '\0' : '\n';
    const out = names.map((n) => stripSuffix(baseComponent(n), suffix)).join(sep) + sep;
    await ctx.io.stdout.write(out);
    return EXIT_OK;
  }
}

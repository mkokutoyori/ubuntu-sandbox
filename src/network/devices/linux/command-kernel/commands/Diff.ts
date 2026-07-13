import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { toFileSystemActor } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { cmdDiff } from '../../coreutils/DiffCommand';

/**
 * `diff` — compare deux fichiers ligne à ligne (format « normal » GNU).
 * L'algorithme (LCS, hunks) reste porté par le module pur **partagé**
 * `cmdDiff`, qui attend un accès fichier synchrone : les fichiers sont donc
 * pré-lus via `ctx.machine.fs` (asynchrone) puis exposés à `cmdDiff` par un
 * cache indexé sur le chemin résolu.
 */
export class DiffCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'diff',
    summary: 'Compare deux fichiers ligne à ligne',
    usage: 'diff FICHIER1 FICHIER2',
    args: [{ name: 'operands', type: 'string', required: false, variadic: true, description: 'fichiers à comparer' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'texte',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const operands = ctx.args.has('operands') ? ctx.args.get<string[]>('operands') : [];
    const actor = toFileSystemActor(ctx.session.user);
    const resolve = (p: string): string => ctx.machine.fs.resolve(ctx.session.cwd, p);

    // Pré-lecture asynchrone des opérandes (les options `-…` sont ignorées,
    // comme dans `cmdDiff`).
    const cache = new Map<string, string | null>();
    for (const p of operands.filter((a) => !a.startsWith('-'))) {
      const abs = resolve(p);
      if (cache.has(abs)) continue;
      try {
        cache.set(abs, await ctx.machine.fs.readFile(abs, actor));
      } catch {
        cache.set(abs, null);
      }
    }

    const result = cmdDiff(
      {
        readFile: (path) => (cache.has(path) ? cache.get(path)! : null),
        normalizePath: (p, cwd) => ctx.machine.fs.resolve(cwd, p),
      },
      ctx.session.cwd,
      operands,
    );

    await ctx.io.stdout.write(result.output === '' ? '' : result.output + '\n');
    return result.exitCode as ExitCode;
  }
}

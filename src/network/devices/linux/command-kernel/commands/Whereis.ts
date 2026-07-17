import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { toFileSystemActor } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import {
  ALL_CATEGORIES, DEFAULT_WHEREIS_DIRECTORIES, WhereisResolver, WhereisSelector,
} from '@/network/devices/linux/resolve/WhereisResolver';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * `whereis [-b|-m|-s|-l] nom...` — délègue à `WhereisResolver`, classe pure
 * déjà découplée de l'exécuteur (interface `WhereisFs` abstraite). Comme
 * `machine.fs` est asynchrone et `WhereisFs` synchrone, les répertoires de
 * recherche (fixes, une quinzaine) sont pré-listés une fois via `machine.fs`
 * avant de construire l'adaptateur synchrone consommé par le résolveur.
 */
export class WhereisCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'whereis',
    summary: 'Localise binaire/manuel/source d\'une commande',
    usage: 'whereis [-b|-m|-s|-l] nom...',
    args: [
      { name: 'rest', type: 'string', required: false, variadic: true, description: '-b/-m/-s/-l, noms de commandes' },
    ],
    options: [],
    privileges: ANY,
    category: 'linux',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.get<string[] | undefined>('rest') ?? [];
    let b = false, m = false, s = false, listDirs = false;
    const names: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') { names.push(...args.slice(i + 1)); break; }
      if (a === '-b') { b = true; continue; }
      if (a === '-m') { m = true; continue; }
      if (a === '-s') { s = true; continue; }
      if (a === '-l') { listDirs = true; continue; }
      if (a === '-B' || a === '-M' || a === '-S') { while (i + 1 < args.length && args[i + 1] !== '-f') i++; continue; }
      if (a === '-f') continue;
      if (a.startsWith('-')) continue;
      names.push(a);
    }

    const allDirs = [
      ...DEFAULT_WHEREIS_DIRECTORIES.binary,
      ...DEFAULT_WHEREIS_DIRECTORIES.manual,
      ...DEFAULT_WHEREIS_DIRECTORIES.source,
    ];
    if (listDirs) {
      await ctx.io.stdout.write(allDirs.join('\n') + '\n');
      return EXIT_OK;
    }

    const actor = toFileSystemActor(ctx.session.user);
    const listings = new Map<string, string[] | null>();
    for (const dir of allDirs) {
      try {
        const entries = await ctx.machine.fs.list(dir, actor);
        listings.set(dir, entries.map((e) => e.path.slice(e.path.lastIndexOf('/') + 1)));
      } catch {
        listings.set(dir, null);
      }
    }

    const resolver = new WhereisResolver({
      exists: (path) => {
        const slash = path.lastIndexOf('/');
        const dir = path.slice(0, slash);
        const name = path.slice(slash + 1);
        return listings.get(dir)?.includes(name) ?? false;
      },
      list: (dir) => listings.get(dir) ?? null,
    });

    const sel: WhereisSelector = (b || m || s) ? { binary: b, manual: m, source: s } : ALL_CATEGORIES;
    const out = names.map((name) => WhereisResolver.format(resolver.locate(name, sel), sel));
    await ctx.io.stdout.write(out.join('\n') + '\n');
    return EXIT_OK;
  }
}

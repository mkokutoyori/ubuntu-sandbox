import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { toFileSystemActor } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

function matchPattern(name: string, pattern: string): boolean {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp('^' + regex + '$', 'i').test(name);
}

export class WhereCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'where',
    summary: 'Recherche des fichiers correspondant à un motif',
    usage: 'where [/r <répertoire>] <motif>',
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'options et motif' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'fichiers',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const tokens = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    const patterns = tokens.filter((t) => t.toLowerCase() !== '/r');

    if (patterns.length === 0) {
      await ctx.io.stdout.write('ERROR: A pattern must be specified.\n');
      return 1;
    }
    const pattern = patterns[0];

    const actor = toFileSystemActor(ctx.session.user);
    const searchDirs = [ctx.session.cwd];
    const pathVar = ctx.session.env.get('PATH') || '';
    for (const dir of pathVar.split(';')) {
      if (dir.trim()) searchDirs.push(dir.trim());
    }

    const results: string[] = [];
    for (const dir of searchDirs) {
      let entries;
      try {
        entries = await ctx.machine.fs.list(dir, actor);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.type !== 'file') continue;
        const name = entry.path.slice(entry.path.lastIndexOf('\\') + 1);
        if (matchPattern(name, pattern)) results.push(entry.path);
      }
    }

    if (results.length === 0) {
      await ctx.io.stdout.write('INFO: Could not find files for the given pattern(s).\n');
      return 1;
    }
    await ctx.io.stdout.write(results.join('\n') + '\n');
    return EXIT_OK;
  }
}

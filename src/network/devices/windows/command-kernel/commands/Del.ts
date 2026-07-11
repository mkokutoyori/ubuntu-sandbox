import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { toFileSystemActor } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { reportLegacyFsError } from './legacyFsError';

export class DelCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'del',
    aliases: ['erase'],
    summary: 'Supprime un fichier',
    usage: 'del <fichier>',
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'fichier à supprimer' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'fichiers',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const targets = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    const pathParts = targets.filter((a) => {
      const lower = a.toLowerCase();
      return lower !== '/s' && lower !== '/q' && lower !== '/f';
    });
    if (pathParts.length === 0) {
      await ctx.io.stdout.write('The syntax of the command is incorrect.\n');
      return EXIT_OK;
    }

    const pattern = pathParts.join(' ');
    const actor = toFileSystemActor(ctx.session.user);

    // Wildcards: legacy `deleteGlob` matches file names directly against the
    // pattern within `cwd` only (no recursion, no directories) — reproduced
    // here with the generic `list()`/`remove()` capabilities instead of a
    // Windows-only glob method on the shared FileSystemApi contract.
    if (pattern.includes('*') || pattern.includes('?')) {
      const regex = new RegExp(
        '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
        'i',
      );
      const entries = await ctx.machine.fs.list(ctx.session.cwd, actor);
      const matches = entries.filter((e) => e.type === 'file' && regex.test(e.path.slice(e.path.lastIndexOf('\\') + 1)));
      for (const match of matches) await ctx.machine.fs.remove(match.path, actor, false);
      if (matches.length === 0) await ctx.io.stdout.write(`Could Not Find ${pattern}\n`);
      return EXIT_OK;
    }

    const abs = ctx.machine.fs.resolve(ctx.session.cwd, pattern);
    try {
      await ctx.machine.fs.remove(abs, actor, false);
    } catch (err) {
      return reportLegacyFsError(ctx, err);
    }
    return EXIT_OK;
  }
}

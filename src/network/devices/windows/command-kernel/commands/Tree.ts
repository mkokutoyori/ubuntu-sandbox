import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { toFileSystemActor } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { reportLegacyFsError } from './legacyFsError';

function basename(path: string): string {
  return path.slice(path.lastIndexOf('\\') + 1);
}

export class TreeCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'tree',
    summary: 'Affiche l\'arborescence d\'un répertoire',
    usage: 'tree [/f] [répertoire]',
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'répertoire' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'fichiers',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const targets = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    let showFiles = false;
    const pathArgs: string[] = [];
    for (const arg of targets) {
      const lower = arg.toLowerCase();
      if (lower === '/f') showFiles = true;
      else if (lower === '/a') continue;
      else pathArgs.push(arg);
    }

    const abs = ctx.machine.fs.resolve(ctx.session.cwd, pathArgs[0] ?? '.');
    const actor = toFileSystemActor(ctx.session.user);
    const lines: string[] = [abs];

    const walk = async (dir: string, prefix: string): Promise<void> => {
      const entries = await ctx.machine.fs.list(dir, actor);
      const dirs = entries.filter((e) => e.type === 'directory');
      const files = entries.filter((e) => e.type === 'file');
      for (const d of dirs) {
        lines.push(`${prefix}+---${basename(d.path)}`);
        await walk(d.path, `${prefix}|   `);
      }
      if (showFiles) {
        for (const f of files) lines.push(`${prefix}    ${basename(f.path)}`);
      }
    };

    try {
      await walk(abs, '');
    } catch (err) {
      return reportLegacyFsError(ctx, err);
    }
    await ctx.io.stdout.write(lines.join('\n') + '\n');
    return EXIT_OK;
  }
}

import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { FileSystemActor, toFileSystemActor } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { FileSystemApi } from '@/command-kernel/machine/types';

async function copyDir(fs: FileSystemApi, actor: FileSystemActor, src: string, dest: string, recursive: boolean): Promise<number> {
  const entries = await fs.list(src, actor);
  let count = 0;
  for (const entry of entries) {
    const name = entry.path.slice(entry.path.lastIndexOf('\\') + 1);
    const destChild = `${dest}\\${name}`;
    if (entry.type === 'file') {
      await fs.copy(entry.path, destChild, actor);
      count++;
    } else if (entry.type === 'directory' && recursive) {
      await fs.mkdir(destChild, actor, true);
      count += await copyDir(fs, actor, entry.path, destChild, recursive);
    }
  }
  return count;
}

export class XcopyCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'xcopy',
    summary: 'Copie des fichiers et arborescences de répertoires',
    usage: 'xcopy [/s] [/e] [/y] [/i] [/q] [/h] <source> <destination>',
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'options, source et destination' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'fichiers',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const tokens = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];

    let recursive = false;
    const pathParts: string[] = [];
    for (const t of tokens) {
      const lower = t.toLowerCase();
      if (lower === '/s' || lower === '/e') { recursive = true; continue; }
      if (lower === '/y' || lower === '/i' || lower === '/q' || lower === '/h') continue;
      pathParts.push(t);
    }

    if (pathParts.length < 2) {
      await ctx.io.stdout.write('Invalid number of parameters\n');
      return 1;
    }

    const actor = toFileSystemActor(ctx.session.user);
    const src = ctx.machine.fs.resolve(ctx.session.cwd, pathParts[0]);
    const dest = ctx.machine.fs.resolve(ctx.session.cwd, pathParts[1]);

    if (!(await ctx.machine.fs.exists(src, actor))) {
      await ctx.io.stdout.write(`File not found - ${pathParts[0]}\n`);
      return 1;
    }

    const srcStat = await ctx.machine.fs.stat(src, actor);
    if (srcStat.type === 'file') {
      try {
        await ctx.machine.fs.copy(src, dest, actor);
      } catch (err) {
        await ctx.io.stdout.write(`${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
      }
      await ctx.io.stdout.write('1 File(s) copied\n');
      return EXIT_OK;
    }

    if (srcStat.type !== 'directory') {
      await ctx.io.stdout.write(`File not found - ${pathParts[0]}\n`);
      return 1;
    }

    await ctx.machine.fs.mkdir(dest, actor, true);
    const count = await copyDir(ctx.machine.fs, actor, src, dest, recursive);
    await ctx.io.stdout.write(`${count} File(s) copied\n`);
    return EXIT_OK;
  }
}

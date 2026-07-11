import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { FileStat, toFileSystemActor } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

function basename(path: string): string {
  return path.slice(path.lastIndexOf('\\') + 1);
}

function formatDate(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yyyy = d.getFullYear();
  let hh = d.getHours();
  const ampm = hh >= 12 ? 'PM' : 'AM';
  hh = hh % 12 || 12;
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${mm}/${dd}/${yyyy}  ${String(hh).padStart(2, '0')}:${min} ${ampm}`;
}

function dirHelp(): string {
  return [
    'Displays a list of files and subdirectories in a directory.',
    '',
    'DIR [drive:][path][filename] [/W] [/S] [/B]',
    '',
    '  /W   Uses wide list format.',
    '  /S   Displays files in specified directory and all subdirectories.',
    '  /B   Uses bare format (no heading information or summary).',
  ].join('\n');
}

function globToRegex(pattern: string): RegExp {
  return new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
}

export class DirCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'dir',
    summary: 'Liste les fichiers et sous-répertoires',
    usage: 'dir [/w] [/s] [/b] [chemin] [motif]',
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'chemin et/ou options' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'fichiers',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const targets = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    const flags = new Set<string>();
    const positionals: string[] = [];

    for (const arg of targets) {
      const lower = arg.toLowerCase();
      if (lower === '/w') flags.add('wide');
      else if (lower === '/s') flags.add('recursive');
      else if (lower === '/b') flags.add('bare');
      else if (lower === '/?') {
        await ctx.io.stdout.write(dirHelp() + '\n');
        return EXIT_OK;
      } else if (lower === '/a' || lower.startsWith('/a:')) continue;
      else if (lower === '/o' || lower.startsWith('/o:') || lower.startsWith('/od')) continue;
      else if (lower.startsWith('/')) continue;
      else positionals.push(arg);
    }

    let targetPath: string | null = positionals[0] ?? null;
    let wildcard: string | null = null;
    if (positionals.length >= 2 && /[*?]/.test(positionals[positionals.length - 1])) {
      wildcard = positionals[positionals.length - 1];
    } else if (targetPath && /[*?]/.test(targetPath)) {
      const sep = Math.max(targetPath.lastIndexOf('\\'), targetPath.lastIndexOf('/'));
      wildcard = targetPath.slice(sep + 1);
      targetPath = sep >= 0 ? targetPath.slice(0, sep + 1) : null;
    }

    const abs = targetPath ? ctx.machine.fs.resolve(ctx.session.cwd, targetPath) : ctx.session.cwd;
    const actor = toFileSystemActor(ctx.session.user);

    let root: FileStat | undefined;
    try {
      root = await ctx.machine.fs.stat(abs, actor);
    } catch {
      root = undefined;
    }

    if (!root || root.type !== 'directory') {
      if (!root) {
        await ctx.io.stdout.write('File Not Found\n');
        return 1;
      }
      const single = await this.dirSingleFile(ctx, abs, actor);
      await ctx.io.stdout.write(single + '\n');
      return single === 'File Not Found' ? 1 : EXIT_OK;
    }

    if (wildcard) {
      const out = await this.dirWildcard(ctx, abs, wildcard, actor);
      await ctx.io.stdout.write(out + '\n');
      return out === 'File Not Found' ? 1 : EXIT_OK;
    }
    if (flags.has('bare')) {
      await ctx.io.stdout.write((await this.dirBare(ctx, abs, flags.has('recursive'), actor)) + '\n');
      return EXIT_OK;
    }
    if (flags.has('recursive')) {
      await ctx.io.stdout.write((await this.dirRecursive(ctx, abs, actor)) + '\n');
      return EXIT_OK;
    }
    await ctx.io.stdout.write((await this.dirSingle(ctx, abs, flags, actor)) + '\n');
    return EXIT_OK;
  }

  private async volumeHeader(ctx: CommandContext, abs: string, actor: ReturnType<typeof toFileSystemActor>): Promise<string[]> {
    const vol = await ctx.machine.fs.volumeInfo?.(abs);
    return [
      ` Volume in drive ${abs[0]} has no label.`,
      ` Volume Serial Number is ${vol?.serial ?? '0000-0000'}`,
    ];
  }

  private async freeSpaceLine(ctx: CommandContext, abs: string): Promise<string> {
    const vol = await ctx.machine.fs.volumeInfo?.(abs);
    return (vol?.freeBytes ?? 0).toLocaleString('en-US');
  }

  private async dirBare(ctx: CommandContext, absPath: string, recursive: boolean, actor: ReturnType<typeof toFileSystemActor>): Promise<string> {
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      const entries = await ctx.machine.fs.list(dir, actor);
      for (const e of entries) {
        out.push(recursive ? e.path : basename(e.path));
        if (recursive && e.type === 'directory') await walk(e.path);
      }
    };
    await walk(absPath);
    return out.join('\n');
  }

  private async dirWildcard(ctx: CommandContext, absPath: string, pattern: string, actor: ReturnType<typeof toFileSystemActor>): Promise<string> {
    const re = globToRegex(pattern);
    const entries = (await ctx.machine.fs.list(absPath, actor)).filter((e) => re.test(basename(e.path)));
    if (entries.length === 0) return 'File Not Found';
    const lines = await this.volumeHeader(ctx, absPath, actor);
    lines.push('', ` Directory of ${absPath}`, '');
    let fileCount = 0, fileBytes = 0, dirCount = 0;
    for (const e of entries) {
      const date = formatDate(e.modifiedAt);
      if (e.type === 'directory') {
        lines.push(`${date}    <DIR>          ${basename(e.path)}`);
        dirCount++;
      } else {
        lines.push(`${date} ${e.size.toLocaleString('en-US').padStart(14, ' ')} ${basename(e.path)}`);
        fileCount++;
        fileBytes += e.size;
      }
    }
    lines.push(`               ${fileCount} File(s) ${fileBytes.toLocaleString('en-US')} bytes`);
    lines.push(`               ${dirCount} Dir(s)  ${await this.freeSpaceLine(ctx, absPath)} bytes free`);
    return lines.join('\n');
  }

  private async dirSingleFile(ctx: CommandContext, absPath: string, actor: ReturnType<typeof toFileSystemActor>): Promise<string> {
    const lastSep = absPath.lastIndexOf('\\');
    const parent = lastSep > 1 ? absPath.slice(0, lastSep) : absPath.slice(0, lastSep + 1);
    const leaf = absPath.slice(lastSep + 1);
    const entries = await ctx.machine.fs.list(parent, actor);
    const hit = entries.find((e) => basename(e.path).toLowerCase() === leaf.toLowerCase());
    if (!hit) return 'File Not Found';
    const lines = await this.volumeHeader(ctx, absPath, actor);
    lines.push('', ` Directory of ${parent}`, '');
    const date = formatDate(hit.modifiedAt);
    lines.push(`${date} ${hit.size.toLocaleString('en-US').padStart(14, ' ')} ${basename(hit.path)}`);
    lines.push(`               1 File(s) ${hit.size.toLocaleString('en-US')} bytes`);
    lines.push(`               0 Dir(s)  ${await this.freeSpaceLine(ctx, absPath)} bytes free`);
    return lines.join('\n');
  }

  private async dirSingle(ctx: CommandContext, absPath: string, flags: Set<string>, actor: ReturnType<typeof toFileSystemActor>): Promise<string> {
    const entries = await ctx.machine.fs.list(absPath, actor);
    const lines = await this.volumeHeader(ctx, absPath, actor);
    lines.push('', ` Directory of ${absPath}`, '');

    if (flags.has('wide')) return this.dirWide(ctx, absPath, entries, lines);

    const dotDate = formatDate(new Date());
    lines.push(`${dotDate}    <DIR>          .`);
    lines.push(`${dotDate}    <DIR>          ..`);

    let fileCount = 0, fileBytes = 0, dirCount = 2;
    for (const e of entries) {
      const date = formatDate(e.modifiedAt);
      if (e.type === 'directory') {
        lines.push(`${date}    <DIR>          ${basename(e.path)}`);
        dirCount++;
      } else {
        lines.push(`${date} ${e.size.toLocaleString('en-US').padStart(14, ' ')} ${basename(e.path)}`);
        fileCount++;
        fileBytes += e.size;
      }
    }
    lines.push(`               ${fileCount} File(s) ${fileBytes.toLocaleString('en-US')} bytes`);
    lines.push(`               ${dirCount} Dir(s)  ${await this.freeSpaceLine(ctx, absPath)} bytes free`);
    return lines.join('\n');
  }

  private async dirWide(ctx: CommandContext, absPath: string, entries: FileStat[], lines: string[]): Promise<string> {
    const items: string[] = ['.', '..'];
    for (const e of entries) items.push(e.type === 'directory' ? `[${basename(e.path)}]` : basename(e.path));

    const colWidth = 20;
    const cols = 4;
    for (let i = 0; i < items.length; i += cols) {
      lines.push(items.slice(i, i + cols).map((s) => s.padEnd(colWidth)).join(''));
    }

    let fileCount = 0, fileBytes = 0, dirCount = 2;
    for (const e of entries) {
      if (e.type === 'directory') dirCount++;
      else { fileCount++; fileBytes += e.size; }
    }
    lines.push(`               ${fileCount} File(s) ${fileBytes.toLocaleString('en-US')} bytes`);
    lines.push(`               ${dirCount} Dir(s)  ${await this.freeSpaceLine(ctx, absPath)} bytes free`);
    return lines.join('\n');
  }

  private async dirRecursive(ctx: CommandContext, absPath: string, actor: ReturnType<typeof toFileSystemActor>): Promise<string> {
    const lines = await this.volumeHeader(ctx, absPath, actor);
    lines.push('');

    let totalFiles = 0, totalBytes = 0, totalDirs = 0;

    const walk = async (dir: string): Promise<void> => {
      const entries = await ctx.machine.fs.list(dir, actor);
      lines.push(` Directory of ${dir}`, '');
      const dotDate = formatDate(new Date());
      lines.push(`${dotDate}    <DIR>          .`);
      lines.push(`${dotDate}    <DIR>          ..`);

      let fileCount = 0, fileBytes = 0, dirCount = 2;
      const subDirs: string[] = [];
      for (const e of entries) {
        const date = formatDate(e.modifiedAt);
        if (e.type === 'directory') {
          lines.push(`${date}    <DIR>          ${basename(e.path)}`);
          dirCount++;
          subDirs.push(e.path);
        } else {
          lines.push(`${date} ${e.size.toLocaleString('en-US').padStart(14, ' ')} ${basename(e.path)}`);
          fileCount++;
          fileBytes += e.size;
        }
      }
      lines.push(`               ${fileCount} File(s) ${fileBytes.toLocaleString('en-US')} bytes`);
      lines.push(`               ${dirCount} Dir(s)  ${await this.freeSpaceLine(ctx, absPath)} bytes free`, '');

      totalFiles += fileCount;
      totalBytes += fileBytes;
      totalDirs += dirCount;
      for (const sub of subDirs) await walk(sub);
    };
    await walk(absPath);

    lines.push('     Total Files Listed:');
    lines.push(`               ${totalFiles} File(s) ${totalBytes.toLocaleString('en-US')} bytes`);
    lines.push(`               ${totalDirs} Dir(s)  ${await this.freeSpaceLine(ctx, absPath)} bytes free`);
    return lines.join('\n');
  }
}

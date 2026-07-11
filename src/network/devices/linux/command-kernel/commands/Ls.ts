import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { FileNodeType, FileStat, FileSystemActor, toFileSystemActor } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const TYPE_CHAR: Record<FileNodeType, string> = {
  file: '-',
  directory: 'd',
  symlink: 'l',
  fifo: 'p',
  chardev: 'c',
};

function formatMode(type: FileNodeType, mode: number): string {
  const perms = mode & 0o777;
  const special = (mode >> 9) & 0o7;
  const chars = ['r', 'w', 'x'];
  let out = TYPE_CHAR[type];
  const groups: Array<[number, number]> = [
    [6, special & 0b100],
    [3, special & 0b010],
    [0, special & 0b001],
  ];
  for (const [shift, specialBit] of groups) {
    for (let i = 0; i < 3; i++) {
      const bit = (perms >> shift) & (4 >> i);
      if (i === 2 && specialBit) {
        out += bit ? (shift === 0 ? 't' : 's') : (shift === 0 ? 'T' : 'S');
      } else {
        out += bit ? chars[i] : '-';
      }
    }
  }
  return out;
}

function formatDate(date: Date): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = String(date.getDate()).padStart(2, ' ');
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return `${months[date.getMonth()]} ${day} ${time}`;
}

type Entry = FileStat & { name: string };
type Options = { long: boolean; all: boolean; sizeSort: boolean; reverse: boolean; inode: boolean };

export class LsCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'ls',
    summary: 'Liste le contenu d\'un répertoire',
    usage: 'ls [-l] [-a] [-d] [-S] [-R] [-i] [chemin...]',
    args: [{ name: 'targets', type: 'path', required: false, variadic: true, description: 'répertoires ou fichiers' }],
    options: [
      { long: 'long', short: 'l', takesValue: false, description: 'format détaillé' },
      { long: 'all', short: 'a', takesValue: false, description: 'inclut les entrées commençant par .' },
      { long: 'directory', short: 'd', takesValue: false, description: 'liste le répertoire lui-même, pas son contenu' },
      { long: 'size-sort', short: 'S', takesValue: false, description: 'trie par taille décroissante' },
      { long: 'reverse', short: 'r', takesValue: false, description: 'inverse l\'ordre du tri' },
      { long: 'recursive', short: 'R', takesValue: false, description: 'liste récursivement les sous-répertoires' },
      { long: 'inode', short: 'i', takesValue: false, description: 'affiche le numéro d\'inode' },
    ],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'fichiers',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const requestedTargets = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : ['.'];
    const actor = toFileSystemActor(ctx.session.user);
    const options: Options = {
      long: ctx.args.flag('long'),
      all: ctx.args.flag('all'),
      sizeSort: ctx.args.flag('size-sort'),
      reverse: ctx.args.flag('reverse'),
      inode: ctx.args.flag('inode'),
    };
    const asDirectory = ctx.args.flag('directory');
    const recursive = ctx.args.flag('recursive');

    const looseFiles: Entry[] = [];
    const dirSections: string[] = [];

    for (const requested of requestedTargets) {
      const target = ctx.machine.fs.resolve(ctx.session.cwd, requested);
      ctx.machine.audit?.fsAccess(target, 'r');
      const resolved = await ctx.machine.fs.stat(target, actor).catch(() => null);
      const isDirectory = resolved?.type === 'directory' && !asDirectory;

      if (!isDirectory) {
        const own = await ctx.machine.fs.lstat(target, actor);
        looseFiles.push({ ...own, name: requested });
        continue;
      }

      if (recursive) {
        dirSections.push(...(await this.listRecursive(ctx, target, actor, options)));
      } else {
        const entries = await this.listVisible(ctx, target, actor, options);
        const header = requestedTargets.length > 1 ? `${requested}:\n` : '';
        dirSections.push(header + (await this.renderEntries(entries, ctx, options)));
      }
    }

    const parts: string[] = [];
    if (looseFiles.length) parts.push(await this.renderEntries(looseFiles, ctx, options));
    parts.push(...dirSections);
    await ctx.io.stdout.write(parts.join('\n'));
    return EXIT_OK;
  }

  private async listVisible(
    ctx: CommandContext,
    dir: string,
    actor: FileSystemActor,
    options: Pick<Options, 'all' | 'sizeSort' | 'reverse'>,
  ): Promise<Entry[]> {
    const raw = await ctx.machine.fs.list(dir, actor);
    let entries = raw
      .map((e) => ({ ...e, name: e.path.split('/').pop() ?? e.path }))
      .filter((e) => options.all || !e.name.startsWith('.'));
    entries = options.sizeSort
      ? entries.sort((a, b) => b.size - a.size)
      : entries.sort((a, b) => a.name.localeCompare(b.name));
    if (options.reverse) entries.reverse();
    return entries;
  }

  private async listRecursive(
    ctx: CommandContext,
    dir: string,
    actor: FileSystemActor,
    options: Options,
  ): Promise<string[]> {
    const entries = await this.listVisible(ctx, dir, actor, options);
    const body = await this.renderEntries(entries, ctx, options);
    const sections = [`${dir}:\n${body}`];
    for (const entry of entries) {
      if (entry.type === 'directory') {
        sections.push(...(await this.listRecursive(ctx, entry.path, actor, options)));
      }
    }
    return sections;
  }

  private async renderEntries(entries: Entry[], ctx: CommandContext, options: Options): Promise<string> {
    if (!options.long) {
      const names = entries.map((e) => (options.inode ? `${e.inode} ${e.name}` : e.name));
      return names.join('\n');
    }
    const lines = await Promise.all(entries.map((e) => this.formatLong(ctx, e, options.inode)));
    return lines.join('\n');
  }

  private async formatLong(ctx: CommandContext, e: Entry, showInode: boolean): Promise<string> {
    const mode = formatMode(e.type, e.mode);
    const owner = (await ctx.machine.users.findByUid(e.ownerUid))?.name ?? String(e.ownerUid);
    const group = (await ctx.machine.groups.findByGid(e.ownerGid))?.name ?? String(e.ownerGid);
    const label = e.type === 'symlink' && e.symlinkTarget ? `${e.name} -> ${e.symlinkTarget}` : e.name;
    const prefix = showInode ? `${e.inode} ` : '';
    return `${prefix}${mode} ${e.linkCount} ${owner} ${group} ${String(e.size).padStart(6)} ${formatDate(e.modifiedAt)} ${label}`;
  }
}

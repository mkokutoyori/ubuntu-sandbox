import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { FileSystemError } from '@/command-kernel/errors';
import { toFileSystemActor } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { describeArchiveContent } from '../../coreutils/ArchiveCommands';

/**
 * `file` — devine le type de chaque fichier (lien, répertoire, périphérique
 * caractère, archive gz/tar, script `#!`, texte ASCII, données binaires).
 * La classification reproduit à l'identique la logique historique
 * `describeFile`, désormais alimentée par `ctx.machine.fs` (lstat + lecture)
 * et le détecteur d'archives pur partagé `describeArchiveContent`.
 */
export class FileCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'file',
    summary: 'Détermine le type d\'un fichier',
    usage: 'file [OPTION...] FICHIER...',
    args: [{ name: 'operands', type: 'string', required: false, variadic: true, description: 'fichiers à examiner' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'fichiers',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const operands = ctx.args.has('operands') ? ctx.args.get<string[]>('operands') : [];
    const targets = operands.filter((a) => !a.startsWith('-'));
    if (targets.length === 0) {
      await ctx.io.stdout.write('Usage: file [-options] file...\n');
      return 1;
    }
    const lines: string[] = [];
    for (const t of targets) lines.push(await this.describe(ctx, t));
    await ctx.io.stdout.write(lines.join('\n') + '\n');
    return EXIT_OK;
  }

  private async describe(ctx: CommandContext, target: string): Promise<string> {
    const actor = toFileSystemActor(ctx.session.user);
    const abs = ctx.machine.fs.resolve(ctx.session.cwd, target);

    let stat;
    try {
      stat = await ctx.machine.fs.lstat(abs, actor);
    } catch (err) {
      if (err instanceof FileSystemError) return `${target}: cannot open \`${target}' (No such file or directory)`;
      throw err;
    }

    if (stat.type === 'symlink') return `${target}: symbolic link to ${stat.symlinkTarget ?? ''}`;
    if (stat.type === 'directory') return `${target}: directory`;
    if (stat.type === 'chardev') return `${target}: character special`;

    let content = '';
    try {
      content = await ctx.machine.fs.readFile(abs, actor);
    } catch { /* fifo / illisible → traité comme vide */ }

    if (content.length === 0) return `${target}: empty`;
    const archive = describeArchiveContent(content);
    if (archive) return `${target}: ${archive}`;
    if (content.startsWith('#!')) {
      const nl = content.indexOf('\n');
      const interp = content.slice(2, nl > 0 ? nl : undefined).trim();
      return `${target}: ${interp} script, ASCII text executable`;
    }
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x08\x0e-\x1f]/.test(content)) return `${target}: data`;
    return `${target}: ASCII text`;
  }
}

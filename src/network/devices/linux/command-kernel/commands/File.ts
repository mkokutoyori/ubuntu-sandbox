import { ParsedArgs } from '@/command-kernel/args/parsed-args';
import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { FileSystemError } from '@/command-kernel/errors';
import { toFileSystemActor } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel, Session } from '@/command-kernel/session/types';

/**
 * Marqueurs de format des archives simulées (contrat partagé avec les
 * commandes `tar`/`gzip`/`zip`). Répliqués ici pour que `file` reste
 * autonome — ce sont des constantes de format stables, pas de la logique de
 * commande.
 */
const TAR_MAGIC = '!<simtar>';
const GZ_MAGIC = '!<simgz>';
const ZIP_MAGIC = '!<simzip>';

/**
 * `file` — devine le type de chaque fichier (lien, répertoire, périphérique
 * caractère, archive gz/tar/zip, script `#!`, texte ASCII, données
 * binaires). Commande **autonome** : la classification, y compris la
 * détection des archives simulées, est implémentée ici et alimentée par
 * `ctx.machine.fs` (lstat + lecture).
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

  protected override validate(_args: ParsedArgs, _session: Session): void {
    // `file` sans opérande écrit un rappel d'usage avec le code de sortie 1
    // (rendu dans `execute`) ; rien à valider en amont.
  }

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
    const archive = this.detectArchive(content);
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

  /** Reconnaît les archives simulées (gz/tar/zip) et retourne leur description `file`, ou `null`. */
  private detectArchive(raw: string): string | null {
    if (raw.startsWith(`${GZ_MAGIC}\n`)) {
      try {
        const body = JSON.parse(raw.slice(GZ_MAGIC.length + 1)) as { name?: string; mtime?: number; payload?: string };
        if (typeof body.payload === 'string') {
          return `gzip compressed data, was "${body.name ?? ''}", last modified: ${new Date(body.mtime ?? 0).toUTCString()}, from Unix`;
        }
      } catch { /* pas un gzip valide */ }
    }
    if (raw.startsWith(`${TAR_MAGIC}\n`)) return 'POSIX tar archive (GNU)';
    if (raw.startsWith(`${ZIP_MAGIC}\n`)) return 'Zip archive data, at least v2.0 to extract';
    return null;
  }
}

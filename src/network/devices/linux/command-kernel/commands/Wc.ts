import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { FileSystemError } from '@/command-kernel/errors';
import { toFileSystemActor } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

interface Stats {
  lines: number;
  words: number;
  bytes: number;
  chars: number;
  maxLine: number;
}

function statsOf(content: string): Stats {
  const lines = (content.match(/\n/g) ?? []).length;
  const words = content.trim().length === 0 ? 0 : content.trim().split(/\s+/).length;
  const bytes = content.length;
  const chars = bytes;
  let maxLine = 0;
  for (const l of content.split('\n')) {
    if (l.length > maxLine) maxLine = l.length;
  }
  return { lines, words, bytes, chars, maxLine };
}

export class WcCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'wc',
    summary: 'Compte les lignes, mots et octets',
    usage: 'wc [-l] [-w] [-c] [-m] [-L] [fichier...]',
    args: [{ name: 'files', type: 'path', required: false, variadic: true, description: 'fichiers à compter' }],
    options: [
      { long: 'lines', short: 'l', takesValue: false, description: 'compte les lignes' },
      { long: 'words', short: 'w', takesValue: false, description: 'compte les mots' },
      { long: 'bytes', short: 'c', takesValue: false, description: 'compte les octets' },
      { long: 'chars', short: 'm', takesValue: false, description: 'compte les caractères' },
      { long: 'max-line-length', short: 'L', takesValue: false, description: 'longueur de la ligne la plus longue' },
    ],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'texte',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const files = ctx.args.has('files') ? ctx.args.get<string[]>('files') : [];
    let showLines = ctx.args.flag('lines');
    let showWords = ctx.args.flag('words');
    let showBytes = ctx.args.flag('bytes');
    const showChars = ctx.args.flag('chars');
    const showMaxLine = ctx.args.flag('max-line-length');
    if (!showLines && !showWords && !showBytes && !showChars && !showMaxLine) {
      showLines = showWords = showBytes = true;
    }

    const formatRow = (s: Stats, label?: string): string => {
      const fields: string[] = [];
      if (showLines) fields.push(String(s.lines).padStart(7));
      if (showWords) fields.push(String(s.words).padStart(7));
      if (showChars) fields.push(String(s.chars).padStart(7));
      if (showBytes) fields.push(String(s.bytes).padStart(7));
      if (showMaxLine) fields.push(String(s.maxLine).padStart(7));
      return fields.join(' ') + (label ? ` ${label}` : '');
    };

    if (files.length === 0) {
      const content = await ctx.io.stdin.readAll();
      await ctx.io.stdout.write(formatRow(statsOf(content)) + '\n');
      return EXIT_OK;
    }

    const actor = toFileSystemActor(ctx.session.user);
    const rows: string[] = [];
    const totals: Stats = { lines: 0, words: 0, bytes: 0, chars: 0, maxLine: 0 };
    for (const file of files) {
      const path = ctx.machine.fs.resolve(ctx.session.cwd, file);
      try {
        const content = await ctx.machine.fs.readFile(path, actor);
        const s = statsOf(content);
        rows.push(formatRow(s, file));
        totals.lines += s.lines;
        totals.words += s.words;
        totals.bytes += s.bytes;
        totals.chars += s.chars;
        if (s.maxLine > totals.maxLine) totals.maxLine = s.maxLine;
      } catch (err) {
        if (err instanceof FileSystemError) {
          rows.push(`wc: ${file}: No such file or directory`);
          continue;
        }
        throw err;
      }
    }
    if (files.length > 1) rows.push(formatRow(totals, 'total'));

    await ctx.io.stdout.write(rows.join('\n') + '\n');
    return EXIT_OK;
  }
}

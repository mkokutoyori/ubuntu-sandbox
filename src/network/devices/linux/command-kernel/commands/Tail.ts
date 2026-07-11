import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { FileSystemError } from '@/command-kernel/errors';
import { toFileSystemActor } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { sliceTail, tailHeader, type TailOptions } from '../../coreutils/TailCommand';

export class TailCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'tail',
    summary: 'Affiche les dernières lignes d\'un fichier ou de l\'entrée standard',
    usage: 'tail [-n N] [-c N] [-q] [-v] [fichier...]',
    args: [{ name: 'files', type: 'path', required: false, variadic: true, description: 'fichiers à lire' }],
    options: [
      { long: 'lines', short: 'n', takesValue: true, type: 'string', defaultValue: '10', numericShorthand: true, description: 'nombre de lignes' },
      { long: 'bytes', short: 'c', takesValue: true, type: 'string', description: 'nombre d\'octets' },
      { long: 'quiet', short: 'q', takesValue: false, description: 'jamais d\'en-tête de fichier' },
      { long: 'silent', takesValue: false, description: 'alias de --quiet' },
      { long: 'verbose', short: 'v', takesValue: false, description: 'toujours un en-tête de fichier' },
    ],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'texte',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const files = ctx.args.has('files') ? ctx.args.get<string[]>('files') : [];
    const quiet = ctx.args.flag('quiet') || ctx.args.flag('silent');
    const verbose = ctx.args.flag('verbose');

    const opts: TailOptions = ctx.args.has('bytes')
      ? parseCount(ctx.args.get<string>('bytes'), 'bytes')
      : parseCount(ctx.args.has('lines') ? ctx.args.get<string>('lines') : '10', 'lines');

    if (files.length === 0) {
      const content = await ctx.io.stdin.readAll();
      await ctx.io.stdout.write(sliceTail(content, opts));
      return EXIT_OK;
    }

    const actor = toFileSystemActor(ctx.session.user);
    const showHeaders = verbose || (!quiet && files.length > 1);
    const parts: string[] = [];
    let exitCode: ExitCode = EXIT_OK;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const path = ctx.machine.fs.resolve(ctx.session.cwd, file);
      let content: string;
      try {
        content = await ctx.machine.fs.readFile(path, actor);
      } catch (err) {
        if (err instanceof FileSystemError) {
          parts.push(`tail: cannot open '${file}' for reading: No such file or directory`);
          exitCode = 1;
          continue;
        }
        throw err;
      }
      if (showHeaders) {
        if (i > 0) parts.push('');
        parts.push(tailHeader(file));
      }
      const body = sliceTail(content, opts);
      if (body !== '') parts.push(body.replace(/\n$/, ''));
    }
    await ctx.io.stdout.write(parts.length > 0 ? `${parts.join('\n')}\n` : '');
    return exitCode;
  }
}

function parseCount(raw: string, unit: 'lines' | 'bytes'): TailOptions {
  const m = /^([+-]?)(\d+)([bkKMG]?)$/.exec(raw);
  const sign = m?.[1] ?? '';
  const mult: Record<string, number> = { '': 1, b: 512, k: 1024, K: 1024, M: 1024 * 1024, G: 1024 * 1024 * 1024 };
  const n = m ? Number.parseInt(m[2], 10) * (mult[m[3]] ?? 1) : 10;
  return {
    count: n,
    unit,
    fromStart: sign === '+',
    follow: 'none',
    retry: false,
    quiet: false,
    verbose: false,
    pid: null,
    sleepIntervalSeconds: 1,
    maxUnchangedStats: 5,
    zeroTerminated: false,
    files: [],
  };
}

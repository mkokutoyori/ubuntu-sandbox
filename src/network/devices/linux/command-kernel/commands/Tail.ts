import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { FileSystemError } from '@/command-kernel/errors';
import { toFileSystemActor } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { sliceTail, tailHeader, computeAppended, type TailOptions } from '../../coreutils/TailCommand';

export class TailCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'tail',
    summary: 'Affiche les dernières lignes d\'un fichier ou de l\'entrée standard',
    usage: 'tail [-f] [-F] [-n N] [-c N] [-q] [-v] [fichier...]',
    args: [{ name: 'files', type: 'path', required: false, variadic: true, description: 'fichiers à lire' }],
    options: [
      { long: 'lines', short: 'n', takesValue: true, type: 'string', defaultValue: '10', numericShorthand: true, description: 'nombre de lignes' },
      { long: 'bytes', short: 'c', takesValue: true, type: 'string', description: 'nombre d\'octets' },
      { long: 'quiet', short: 'q', takesValue: false, description: 'jamais d\'en-tête de fichier' },
      { long: 'silent', takesValue: false, description: 'alias de --quiet' },
      { long: 'verbose', short: 'v', takesValue: false, description: 'toujours un en-tête de fichier' },
      { long: 'follow', short: 'f', takesValue: false, description: 'suit le fichier et émet les ajouts au fil de l\'eau' },
      { long: 'follow-name', short: 'F', takesValue: false, description: 'comme -f mais réessaie un fichier absent (implique --retry)' },
      { long: 'retry', takesValue: false, description: 'réessaie d\'ouvrir un fichier inaccessible' },
      { long: 'sleep-interval', short: 's', takesValue: true, type: 'string', description: 'intervalle de sondage (sans effet : suivi événementiel)' },
    ],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'texte',
  };

  /**
   * `-f`/`-F` tiennent le terminal et émettent les ajouts au fil de l'eau :
   * l'invocation est en flux continu (§14.6), sinon c'est un instantané. La
   * commande décide selon ses arguments, pas l'hôte.
   */
  override isStreaming(argv: readonly string[]): boolean {
    for (const a of argv) {
      if (a === '--follow' || a.startsWith('--follow=')) return true;
      if (a.startsWith('--')) continue;
      if (a.startsWith('-') && a.length > 1 && /[fF]/.test(a)) return true;
    }
    return false;
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const files = ctx.args.has('files') ? ctx.args.get<string[]>('files') : [];
    const quiet = ctx.args.flag('quiet') || ctx.args.flag('silent');
    const verbose = ctx.args.flag('verbose');

    const opts: TailOptions = ctx.args.has('bytes')
      ? parseCount(ctx.args.get<string>('bytes'), 'bytes')
      : parseCount(ctx.args.has('lines') ? ctx.args.get<string>('lines') : '10', 'lines');

    if (ctx.args.flag('follow') || ctx.args.flag('follow-name')) {
      const retry = ctx.args.flag('follow-name') || ctx.args.flag('retry');
      return this.runFollow(ctx, files, opts, quiet, verbose, retry);
    }

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

  /**
   * Mode suivi (`-f`/`-F`, §14.6) : émet l'instantané tail-N puis s'abonne
   * aux écritures (`ctx.machine.fs.watchWrites`) pour diffuser les octets
   * ajoutés au fil de l'eau, jusqu'à Ctrl+C (`ctx.signal`). Événementiel :
   * chaque écriture déclenche l'émission dans le même tick, sans sondage.
   */
  private async runFollow(
    ctx: CommandContext,
    files: readonly string[],
    opts: TailOptions,
    quiet: boolean,
    verbose: boolean,
    retry: boolean,
  ): Promise<ExitCode> {
    if (files.length === 0) {
      await ctx.io.stdout.write('tail: warning: following standard input indefinitely is ineffective\n');
      if (ctx.io.interaction) await this.blockUntilAborted(ctx);
      return EXIT_OK;
    }

    const actor = toFileSystemActor(ctx.session.user);
    const showHeaders = verbose || (!quiet && files.length > 1);
    const tracked = new Map<string, { abs: string; last: string }>();
    let activeFile: string | null = null;
    let exitCode: ExitCode = EXIT_OK;

    const emitAppend = (display: string, current: string): void => {
      const tracker = tracked.get(display);
      if (!tracker) return;
      const appended = computeAppended(tracker.last, current);
      if (appended === null) {
        void ctx.io.stdout.write(`tail: ${display}: file truncated\n`);
        tracker.last = current;
        return;
      }
      if (appended.length === 0) return;
      if (showHeaders && activeFile !== display) {
        void ctx.io.stdout.write(`\n${tailHeader(display)}\n`);
        activeFile = display;
      } else if (activeFile === null) {
        activeFile = display;
      }
      void ctx.io.stdout.write(appended);
      tracker.last = current;
    };

    // Phase d'amorçage : chaque fichier émet son tail-N avant l'abonnement,
    // pour que le flux vivant reprenne exactement là où l'instantané s'arrête.
    for (let i = 0; i < files.length; i++) {
      const display = files[i];
      const abs = ctx.machine.fs.resolve(ctx.session.cwd, display);
      let initial: string | null;
      try {
        initial = await ctx.machine.fs.readFile(abs, actor);
      } catch (err) {
        if (!(err instanceof FileSystemError)) throw err;
        initial = null;
      }
      if (initial === null) {
        await ctx.io.stdout.write(`tail: cannot open '${display}' for reading: No such file or directory\n`);
        if (retry) {
          tracked.set(display, { abs, last: '' });
        } else {
          exitCode = 1;
        }
        continue;
      }
      tracked.set(display, { abs, last: initial });
      const slice = sliceTail(initial, opts);
      if (showHeaders) {
        if (i > 0 && activeFile !== null) await ctx.io.stdout.write('\n');
        await ctx.io.stdout.write(`${tailHeader(display)}\n`);
        activeFile = display;
      }
      if (slice !== '') await ctx.io.stdout.write(slice.endsWith('\n') ? slice : `${slice}\n`);
    }

    // Suivi seulement sous un flux terminal vivant (`ctx.io.interaction`) :
    // un appel programmatique (`executeCommand`/script, sans annulation)
    // rend juste l'instantané au lieu de bloquer indéfiniment.
    const watch = ctx.machine.fs.watchWrites;
    if (!ctx.io.interaction || !watch) return exitCode;

    const unsubs: Array<() => void> = [];
    for (const [display, tracker] of tracked) {
      unsubs.push(watch.call(ctx.machine.fs, tracker.abs, (current) => emitAppend(display, current)));
    }

    await this.blockUntilAborted(ctx);
    for (const unsub of unsubs) unsub();
    return exitCode;
  }

  private blockUntilAborted(ctx: CommandContext): Promise<void> {
    return new Promise<void>((resolve) => {
      if (ctx.signal.aborted) { resolve(); return; }
      ctx.signal.addEventListener('abort', () => resolve(), { once: true });
    });
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

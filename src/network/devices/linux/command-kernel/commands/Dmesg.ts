import { ParsedArgs } from '@/command-kernel/args/parsed-args';
import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { PermissionError } from '@/command-kernel/errors';
import { KernelMessage } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel, Session } from '@/command-kernel/session/types';
import { PRIORITY_NAMES, formatHumanDate } from './syslog';

const HELP =
  'Usage:\n dmesg [options]\n\nDisplay or control the kernel ring buffer.\n\nOptions:\n' +
  ' -C, --clear        clear the kernel ring buffer\n' +
  ' -c, --read-clear   read and clear all messages\n' +
  ' -T, --ctime        show human-readable timestamp\n' +
  ' -l, --level <list> restrict output to defined levels\n' +
  ' -n, --console-level <level> set level of messages printed to console\n' +
  ' -r, --raw          print the raw message buffer\n' +
  ' -x, --decode       decode facility and level\n' +
  ' -h, --help         display this help\n' +
  ' -V, --version      display version';

const MUTATING = new Set(['-c', '--read-clear', '-C', '--clear', '-n', '--console-level']);

/**
 * `dmesg [options]` — affiche ou contrôle le ring buffer noyau. Commande
 * **autonome** : lit/vide le buffer via `ctx.machine.logging`. Les options
 * qui modifient le buffer ou le niveau console (`-c`/`-C`/`-n`) exigent
 * root (contrôlé dans `validate`, message legacy exact).
 */
export class DmesgCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'dmesg',
    summary: 'Affiche ou contrôle le ring buffer noyau',
    usage: 'dmesg [options]',
    args: [{ name: 'operands', type: 'string', required: false, variadic: true, description: '[options]' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
    lenientOptions: true,
  };

  /**
   * `-w`/`--follow` tient le terminal et diffuse les nouveaux messages
   * noyau au fil de l'eau : l'invocation est en flux continu (§14.6),
   * sinon c'est un instantané. La commande décide selon ses arguments.
   */
  override isStreaming(argv: readonly string[]): boolean {
    return argv.some((a) => a === '-w' || a === '--follow');
  }

  protected override validate(args: ParsedArgs, session: Session): void {
    // Privilège conditionnel (arg-dépendant) : seul root peut vider le
    // buffer ou changer le niveau console. Message identique au legacy.
    const operands = args.has('operands') ? args.get<string[]>('operands') : [];
    if (!session.user.isRoot() && operands.some((a) => MUTATING.has(a))) {
      throw new PermissionError('read kernel buffer failed: Permission denied');
    }
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('operands') ? ctx.args.get<string[]>('operands') : [];
    let humanTime = false;
    let clearBuf = false;
    let clearOnly = false;
    let raw = false;
    let levelFilter: string[] = [];
    let setConsoleLevel: number | null = null;
    let follow = false;

    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      switch (a) {
        case '-T': case '--ctime': case '-H': case '--human': humanTime = true; break;
        case '-c': case '--read-clear': clearBuf = true; break;
        case '-C': case '--clear': clearOnly = true; break;
        case '-r': case '--raw': raw = true; break;
        case '-w': case '--follow': follow = true; break;
        case '-x': case '--decode': case '-d': case '--show-delta': break;
        case '-h': case '--help': await ctx.io.stdout.write(HELP + '\n'); return 0;
        case '-V': case '--version': await ctx.io.stdout.write('dmesg from util-linux 2.37.2\n'); return 0;
        case '-n': case '--console-level': {
          const lvl = args[++i] ?? '';
          const n = /^\d+$/.test(lvl) ? parseInt(lvl, 10) : (PRIORITY_NAMES[lvl] ?? -1);
          if (n < 1 || n > 8) { await ctx.io.stdout.write(`dmesg: invalid console level: ${lvl}\n`); return 1; }
          setConsoleLevel = n; break;
        }
        case '-l': case '--level':
          levelFilter = (args[++i] || '').split(',').map((l) => l.trim()).filter(Boolean);
          break;
        case '-f': case '--facility': i++; break;
        default:
          if (a.startsWith('--level=')) levelFilter = a.slice(8).split(',').map((l) => l.trim()).filter(Boolean);
          break;
      }
    }

    const logging = ctx.machine.logging;
    if (!logging) return 1;

    if (setConsoleLevel !== null) return 0;
    if (clearOnly) { logging.clearKernelBuffer(); return 0; }

    for (const l of levelFilter) {
      if (PRIORITY_NAMES[l] === undefined) { await ctx.io.stdout.write(`dmesg: unknown level '${l}'\n`); return 1; }
    }

    let entries: readonly KernelMessage[] = logging.kernelBuffer();
    if (levelFilter.length > 0) {
      const levelNums = levelFilter.map((l) => PRIORITY_NAMES[l]);
      entries = entries.filter((e) => levelNums.includes(e.level));
    }

    const bootTime = logging.bootTime();
    const lines = entries.map((e) => this.formatEntry(e, { raw, humanTime, bootTime }));

    if (clearBuf) logging.clearKernelBuffer();

    const output = lines.join('\n');
    if (output !== '') await ctx.io.stdout.write(output + '\n');

    // Mode suivi (§14.6) : après l'instantané, diffuse les nouveaux
    // messages noyau au fil de l'eau jusqu'à Ctrl+C (`ctx.signal`).
    if (follow && logging.followKernel) {
      const unsub = logging.followKernel({ raw, humanTime, levelFilter }, (line) => {
        void ctx.io.stdout.write(line.endsWith('\n') ? line : `${line}\n`);
      });
      await new Promise<void>((resolve) => {
        if (ctx.signal.aborted) { resolve(); return; }
        ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      unsub();
    }
    return 0;
  }

  private formatEntry(e: KernelMessage, opts: { raw: boolean; humanTime: boolean; bootTime: Date }): string {
    if (opts.raw) return e.message;
    if (opts.humanTime) {
      const ts = new Date(opts.bootTime.getTime() + e.offsetSec * 1000);
      return `[${formatHumanDate(ts)}] ${e.message}`;
    }
    return `[${e.offsetSec.toFixed(6).padStart(12, ' ')}] ${e.message}`;
  }
}

import { StreamingCommand } from '@/command-kernel/command/streaming-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { renderFree, type FreeRenderOptions } from '../../../host/hardware/MemoryProfile';

interface FreeArgs extends FreeRenderOptions {
  intervalSeconds: number | null;
  count: number | null;
}

function parseFreeArgs(args: readonly string[]): FreeArgs | { error: string } {
  let intervalSeconds: number | null = null;
  let count: number | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-c' || a === '--count') {
      const v = args[++i];
      if (!v || !/^\d+$/.test(v) || parseInt(v, 10) < 1) return { error: `free: invalid count value '${v ?? ''}'` };
      count = parseInt(v, 10);
    } else if (a === '-s' || a === '--seconds') {
      const v = args[++i];
      if (!v || !/^\d+(?:\.\d+)?$/.test(v)) return { error: `free: invalid seconds value '${v ?? ''}'` };
      intervalSeconds = parseFloat(v);
    }
  }
  const human = args.includes('-h') || args.includes('--human-readable');
  const wide = args.includes('-w') || args.includes('--wide');
  const total = args.includes('-t') || args.includes('--total');
  let unit: 'b' | 'k' | 'm' | 'g' = 'k';
  if (args.includes('-b') || args.includes('--bytes')) unit = 'b';
  else if (args.includes('-m') || args.includes('--mega') || args.includes('--mebi')) unit = 'm';
  else if (args.includes('-g') || args.includes('--giga') || args.includes('--gibi')) unit = 'g';
  return { human, wide, unit, total, intervalSeconds, count };
}

/**
 * `free [options] [-s intervalle [-c nombre]]` — usage mémoire.
 * Sans `-s` : une table (instantané). Avec `-s` : commande à sortie continue
 * (§14.6) — réaffiche la table entière à chaque intervalle, jusqu'au `-c`
 * demandé ou Ctrl+C. La commande décide de son mode via `isStreaming(argv)`.
 * Accède à la mémoire live par `ctx.machine.metrics.memory()`.
 */
export class FreeCommand extends StreamingCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'free',
    summary: 'Affiche l\'utilisation mémoire et swap',
    usage: 'free [-b|-k|-m|-g|-h] [-w] [-t] [-s intervalle [-c nombre]]',
    args: [{ name: 'operands', type: 'string', required: false, variadic: true, description: '[options]' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
    lenientOptions: true,
  };

  override isStreaming(argv: readonly string[]): boolean {
    const parsed = parseFreeArgs(argv);
    return !('error' in parsed) && parsed.intervalSeconds !== null;
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const argv = ctx.args.has('operands') ? ctx.args.get<string[]>('operands') : [];
    const parsed = parseFreeArgs(argv);
    if ('error' in parsed) {
      await ctx.io.stdout.write(parsed.error + '\n');
      return 1;
    }
    if (!ctx.machine.metrics) {
      await ctx.io.stdout.write('free: memory metrics unavailable\n');
      return 1;
    }

    const opts: FreeRenderOptions = { human: parsed.human, wide: parsed.wide, unit: parsed.unit, total: parsed.total };
    const frame = () => renderFree(ctx.machine.metrics!.memory(), opts);

    // Instantané : pas d'intervalle, OU appel programmatique (sans flux
    // terminal vivant), qui ne doit jamais tourner indéfiniment.
    if (parsed.intervalSeconds === null || !ctx.io.interaction) {
      await this.emit(ctx, frame());
      return EXIT_OK;
    }

    // Flux continu : réaffiche la table entière à chaque intervalle.
    const intervalMs = Math.max(100, parsed.intervalSeconds * 1000);
    const count = parsed.count;
    for (let i = 0; count === null ? !ctx.signal.aborted : i < count; i++) {
      if (ctx.signal.aborted) break;
      await this.emit(ctx, frame());
      const hasNext = count === null || i < count - 1;
      if (hasNext && !ctx.signal.aborted) await this.pace(intervalMs, ctx.signal);
    }
    return EXIT_OK;
  }
}

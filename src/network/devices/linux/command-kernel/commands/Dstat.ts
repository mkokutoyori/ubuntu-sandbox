import { StreamingCommand } from '@/command-kernel/command/streaming-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import {
  parseDstatArgs, sampleDstat, formatDstatHeader, formatDstatRow, newDstatRateState,
  DSTAT_USAGE, DSTAT_VERSION, DSTAT_LISTING, type DstatInputs,
} from '../../system/Dstat';

/**
 * `dstat [-cdmnsty] [-N iface] [-D disque] [delai [nombre]]` — statistiques
 * système polyvalentes (CPU, disque, mémoire, réseau, paging, système).
 * Purement continu (§14.6) : en-tête une fois, une ligne par intervalle,
 * jusqu'au `nombre` demandé ou Ctrl+C. `--version`/`--help`/`--list` et les
 * erreurs court-circuitent sans flux. Accède à la machine par `ctx.machine`
 * (`processControl` pour la charge, `metrics.memory`/`metrics.network`).
 */
export class DstatCommand extends StreamingCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'dstat',
    summary: 'Statistiques système polyvalentes (CPU, disque, réseau...)',
    usage: 'dstat [-cdmnsty] [-N iface] [-D disque] [delai [nombre]]',
    args: [{ name: 'operands', type: 'string', required: false, variadic: true, description: '[options] [delai [nombre]]' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
    lenientOptions: true,
  };

  override isStreaming(argv: readonly string[]): boolean {
    const p = parseDstatArgs([...argv]);
    return !p.showHelp && !p.showVersion && !p.listStats && !p.parseError;
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const argv = ctx.args.has('operands') ? ctx.args.get<string[]>('operands') : [];
    const parsed = parseDstatArgs([...argv]);

    if (parsed.showVersion) { await ctx.io.stdout.write(DSTAT_VERSION + '\n'); return EXIT_OK; }
    if (parsed.showHelp) { await ctx.io.stdout.write(DSTAT_USAGE + '\n'); return EXIT_OK; }
    if (parsed.listStats) { await ctx.io.stdout.write(DSTAT_LISTING + '\n'); return EXIT_OK; }
    if (parsed.parseError) { await ctx.io.stdout.write(parsed.parseError + '\n'); return 1; }
    if (!ctx.machine.metrics) { await ctx.io.stdout.write('dstat: metrics unavailable\n'); return 1; }

    // dstat est un moniteur pur : un appel programmatique (sans flux terminal
    // vivant) ne produit rien plutôt que de tourner indéfiniment.
    if (!ctx.io.interaction) return EXIT_OK;

    await this.emit(ctx, formatDstatHeader(parsed.groups));

    const intervalMs = Math.max(100, parsed.intervalSeconds * 1000);
    const count = parsed.count;
    const rate = newDstatRateState();
    for (let i = 0; count === null ? !ctx.signal.aborted : i < count; i++) {
      if (ctx.signal.aborted) break;
      await this.emit(ctx, formatDstatRow(sampleDstat(this.inputs(ctx), rate), parsed.groups));
      const hasNext = count === null || i < count - 1;
      if (hasNext && !ctx.signal.aborted) await this.pace(intervalMs, ctx.signal);
    }
    return EXIT_OK;
  }

  private inputs(ctx: CommandContext): DstatInputs {
    const runQueue = (ctx.machine.processControl?.list() ?? []).filter((p) => p.state === 'R').length;
    const mem = ctx.machine.metrics!.memory();
    const net = ctx.machine.metrics!.network();
    return {
      runQueue,
      memory: { totalKib: mem.totalKib, freeKib: mem.freeKib, buffersKib: mem.buffersKib, cacheKib: mem.cacheKib },
      totalBytesIn: net.bytesIn,
      totalBytesOut: net.bytesOut,
    };
  }
}

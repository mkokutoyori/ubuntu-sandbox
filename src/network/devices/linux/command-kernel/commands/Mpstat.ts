import { StreamingCommand } from '@/command-kernel/command/streaming-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import {
  parseMpstatArgs, mpstatBanner, mpstatColumnHeader, formatMpstatRow, formatMpstatAverageRow,
  sampleMpstat, MpstatAccumulator, type MpstatArgs, type MpstatCpuRow,
} from '../../system/Mpstat';

/**
 * `mpstat [-P ALL|liste] [-u] [intervalle [nombre]]` — utilisation CPU.
 * Sans intervalle : bannière + en-tête + ligne(s) (instantané). Avec
 * intervalle : commande à sortie continue (§14.6) — bannière/en-tête une
 * fois, une ligne par intervalle, puis les moyennes (`Average:`) à la sortie
 * (`nombre` atteint ou Ctrl+C). Accède à la machine par `ctx.machine`
 * (`processControl` pour la charge, `metrics.cpu` + `os` pour la bannière).
 */
export class MpstatCommand extends StreamingCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'mpstat',
    summary: 'Statistiques d\'utilisation des processeurs',
    usage: 'mpstat [-P ALL|liste] [-u] [intervalle [nombre]]',
    args: [{ name: 'operands', type: 'string', required: false, variadic: true, description: '[options] [intervalle [nombre]]' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
    lenientOptions: true,
  };

  override isStreaming(argv: readonly string[]): boolean {
    const parsed = parseMpstatArgs([...argv]);
    return !('error' in parsed) && parsed.intervalSeconds !== null;
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const argv = ctx.args.has('operands') ? ctx.args.get<string[]>('operands') : [];
    const parsed = parseMpstatArgs([...argv]);
    if ('error' in parsed) {
      await ctx.io.stdout.write(parsed.error + '\n');
      // `-V`/`--version` sort par le canal d'erreur mais avec le code 0.
      return parsed.error.startsWith('sysstat') ? EXIT_OK : 1;
    }
    if (!ctx.machine.metrics) {
      await ctx.io.stdout.write('mpstat: cpu metrics unavailable\n');
      return 1;
    }

    const now = new Date();
    await this.writeHeader(ctx, now);

    // Instantané : pas d'intervalle, OU appel programmatique (sans flux
    // terminal vivant), qui ne doit jamais tourner indéfiniment.
    if (parsed.intervalSeconds === null || !ctx.io.interaction) {
      for (const row of this.sample(ctx, parsed)) await this.emit(ctx, formatMpstatRow(now, row));
      return EXIT_OK;
    }

    // Flux continu : une ligne par intervalle, puis les moyennes à la sortie.
    const intervalMs = Math.max(100, parsed.intervalSeconds * 1000);
    const count = parsed.count;
    const acc = new MpstatAccumulator();
    for (let i = 0; count === null ? !ctx.signal.aborted : i < count; i++) {
      if (ctx.signal.aborted) break;
      const rows = this.sample(ctx, parsed);
      acc.add(rows);
      const ts = new Date();
      for (const row of rows) await this.emit(ctx, formatMpstatRow(ts, row));
      const hasNext = count === null || i < count - 1;
      if (hasNext && !ctx.signal.aborted) await this.pace(intervalMs, ctx.signal);
    }
    if (acc.sampleCount() > 0) {
      await this.emit(ctx, '');
      for (const row of acc.averages()) await this.emit(ctx, formatMpstatAverageRow(row));
    }
    return EXIT_OK;
  }

  private async writeHeader(ctx: CommandContext, now: Date): Promise<void> {
    const cpu = ctx.machine.metrics!.cpu();
    const banner = mpstatBanner(
      { sysname: 'Linux', release: ctx.machine.os?.kernelRelease ?? '' },
      ctx.machine.hostname,
      { architecture: cpu.architecture, logicalCpus: cpu.logicalCpus },
      now,
    );
    // La bannière porte déjà son `\n` final ; une ligne vide la sépare de
    // l'en-tête de colonnes (format réel de `mpstat`).
    await ctx.io.stdout.write(banner);
    await this.emit(ctx, '');
    await this.emit(ctx, mpstatColumnHeader(now));
  }

  private sample(ctx: CommandContext, parsed: MpstatArgs): MpstatCpuRow[] {
    const runQueue = (ctx.machine.processControl?.list() ?? []).filter((p) => p.state === 'R').length;
    const cpuCount = ctx.machine.metrics!.cpu().logicalCpus;
    return sampleMpstat(parsed, runQueue, cpuCount);
  }
}

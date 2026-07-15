import { StreamingCommand } from '@/command-kernel/command/streaming-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import {
  parsePidstatArgs, pidstatBanner, pidstatColumnHeader,
  sampleCpuRows, sampleMemoryRows,
  formatPidstatCpuRow, formatPidstatMemRow, formatPidstatAverageCpuRow, formatPidstatAverageMemRow,
  PidstatAccumulator,
  type PidstatArgs, type PidstatProc, type PidstatCpuRow, type PidstatMemRow,
} from '../../system/Pidstat';

/**
 * `pidstat [-u|-r] [-p pids|SELF|ALL] [intervalle [nombre]]` — statistiques
 * par processus (CPU ou mémoire). Sans intervalle : bannière + en-tête +
 * lignes (instantané). Avec intervalle : commande à sortie continue (§14.6)
 * — bannière/en-tête une fois, lignes par intervalle, puis les moyennes
 * (`Average:`) à la sortie. Accède à la machine par `ctx.machine`
 * (`processControl` pour la table des processus, `metrics` + `os` pour la
 * bannière et les totaux).
 */
export class PidstatCommand extends StreamingCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'pidstat',
    summary: 'Statistiques par processus (CPU, mémoire)',
    usage: 'pidstat [-u|-r] [-p pids|SELF|ALL] [intervalle [nombre]]',
    args: [{ name: 'operands', type: 'string', required: false, variadic: true, description: '[options] [intervalle [nombre]]' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
    lenientOptions: true,
  };

  override isStreaming(argv: readonly string[]): boolean {
    const parsed = parsePidstatArgs([...argv]);
    return !('error' in parsed) && parsed.intervalSeconds !== null;
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const argv = ctx.args.has('operands') ? ctx.args.get<string[]>('operands') : [];
    const parsed = parsePidstatArgs([...argv]);
    if ('error' in parsed) {
      await ctx.io.stdout.write(parsed.error + '\n');
      return parsed.error.startsWith('sysstat') ? EXIT_OK : 1;
    }
    if (!ctx.machine.metrics) {
      await ctx.io.stdout.write('pidstat: metrics unavailable\n');
      return 1;
    }

    const now = new Date();
    await this.writeHeader(ctx, parsed, now);

    if (parsed.intervalSeconds === null || !ctx.io.interaction) {
      for (const line of this.frame(ctx, parsed, now)) await this.emit(ctx, line);
      return EXIT_OK;
    }

    const intervalMs = Math.max(100, parsed.intervalSeconds * 1000);
    const count = parsed.count;
    if (parsed.report === 'cpu') {
      const acc = new PidstatAccumulator<PidstatCpuRow>('cpu');
      for (let i = 0; count === null ? !ctx.signal.aborted : i < count; i++) {
        if (ctx.signal.aborted) break;
        const rows = sampleCpuRows(parsed, this.procs(ctx), this.cpuCount(ctx), ctx.session.shellPid);
        acc.add(rows);
        const ts = new Date();
        for (const row of rows) await this.emit(ctx, formatPidstatCpuRow(ts, row));
        if ((count === null || i < count - 1) && !ctx.signal.aborted) await this.pace(intervalMs, ctx.signal);
      }
      if (acc.sampleCount() > 0) {
        await this.emit(ctx, '');
        for (const row of acc.averages()) await this.emit(ctx, formatPidstatAverageCpuRow(row));
      }
    } else {
      const acc = new PidstatAccumulator<PidstatMemRow>('memory');
      for (let i = 0; count === null ? !ctx.signal.aborted : i < count; i++) {
        if (ctx.signal.aborted) break;
        const rows = sampleMemoryRows(parsed, this.procs(ctx), this.totalKib(ctx), ctx.session.shellPid);
        acc.add(rows);
        const ts = new Date();
        for (const row of rows) await this.emit(ctx, formatPidstatMemRow(ts, row));
        if ((count === null || i < count - 1) && !ctx.signal.aborted) await this.pace(intervalMs, ctx.signal);
      }
      if (acc.sampleCount() > 0) {
        await this.emit(ctx, '');
        for (const row of acc.averages()) await this.emit(ctx, formatPidstatAverageMemRow(row));
      }
    }
    return EXIT_OK;
  }

  private frame(ctx: CommandContext, parsed: PidstatArgs, now: Date): string[] {
    if (parsed.report === 'cpu') {
      return sampleCpuRows(parsed, this.procs(ctx), this.cpuCount(ctx), ctx.session.shellPid)
        .map((row) => formatPidstatCpuRow(now, row));
    }
    return sampleMemoryRows(parsed, this.procs(ctx), this.totalKib(ctx), ctx.session.shellPid)
      .map((row) => formatPidstatMemRow(now, row));
  }

  private async writeHeader(ctx: CommandContext, parsed: PidstatArgs, now: Date): Promise<void> {
    const cpu = ctx.machine.metrics!.cpu();
    const banner = pidstatBanner(
      { sysname: 'Linux', release: ctx.machine.os?.kernelRelease ?? '' },
      ctx.machine.hostname,
      { architecture: cpu.architecture, logicalCpus: cpu.logicalCpus },
      now,
    );
    await ctx.io.stdout.write(banner);
    await this.emit(ctx, '');
    await this.emit(ctx, pidstatColumnHeader(parsed, now));
  }

  private procs(ctx: CommandContext): readonly PidstatProc[] {
    return (ctx.machine.processControl?.list() ?? []).map((p) => ({
      pid: p.pid, uid: p.uid, state: p.state, comm: p.comm, vsizeKib: p.vsizeKib, rssKib: p.rssKib,
    }));
  }

  private cpuCount(ctx: CommandContext): number {
    return ctx.machine.metrics!.cpu().logicalCpus;
  }

  private totalKib(ctx: CommandContext): number {
    return ctx.machine.metrics!.memory().totalKib;
  }
}

import { StreamingCommand } from '@/command-kernel/command/streaming-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import {
  parseIostatArgs, iostatBanner, sampleIostatCpu, sampleIostatDevices, renderIostatReport,
  type IostatArgs,
} from '../../system/Iostat';

/**
 * `iostat [-c|-d|-x|-k|-m|-t|-z|-p] [intervalle [nombre]]` — statistiques
 * CPU et disques. Sans intervalle : bannière + rapport (instantané). Avec
 * intervalle : commande à sortie continue (§14.6) — bannière une fois, puis
 * le rapport réaffiché à chaque intervalle, borné par `nombre` ou Ctrl+C.
 * Accède à la machine par `ctx.machine` (`processControl` pour la charge,
 * `metrics.cpu`/`metrics.disks`/`os` pour le rapport et la bannière).
 */
export class IostatCommand extends StreamingCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'iostat',
    summary: 'Statistiques d\'utilisation CPU et périphériques',
    usage: 'iostat [-c|-d|-x|-k|-m|-t|-z|-p] [intervalle [nombre]]',
    args: [{ name: 'operands', type: 'string', required: false, variadic: true, description: '[options] [intervalle [nombre]]' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
    lenientOptions: true,
  };

  override isStreaming(argv: readonly string[]): boolean {
    const parsed = parseIostatArgs([...argv]);
    return !('error' in parsed) && parsed.intervalSeconds !== null;
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const argv = ctx.args.has('operands') ? ctx.args.get<string[]>('operands') : [];
    const parsed = parseIostatArgs([...argv]);
    if ('error' in parsed) {
      await ctx.io.stdout.write(parsed.error + '\n');
      return parsed.error.startsWith('sysstat') ? EXIT_OK : 1;
    }
    if (!ctx.machine.metrics) {
      await ctx.io.stdout.write('iostat: metrics unavailable\n');
      return 1;
    }

    const cpu = ctx.machine.metrics.cpu();
    const banner = iostatBanner(
      { sysname: 'Linux', release: ctx.machine.os?.kernelRelease ?? '' },
      ctx.machine.hostname,
      { architecture: cpu.architecture, logicalCpus: cpu.logicalCpus },
      new Date(),
    );
    await ctx.io.stdout.write(banner);

    // Instantané : pas d'intervalle, OU appel programmatique (sans flux
    // terminal vivant), qui ne doit jamais tourner indéfiniment.
    if (parsed.intervalSeconds === null || !ctx.io.interaction) {
      await ctx.io.stdout.write(`\n${this.report(ctx, parsed)}\n`);
      return EXIT_OK;
    }

    // Flux continu : le rapport entier réaffiché à chaque intervalle.
    const intervalMs = Math.max(100, parsed.intervalSeconds * 1000);
    const count = parsed.count;
    for (let i = 0; count === null ? !ctx.signal.aborted : i < count; i++) {
      if (ctx.signal.aborted) break;
      await ctx.io.stdout.write(`\n${this.report(ctx, parsed)}\n`);
      const hasNext = count === null || i < count - 1;
      if (hasNext && !ctx.signal.aborted) await this.pace(intervalMs, ctx.signal);
    }
    return EXIT_OK;
  }

  private report(ctx: CommandContext, parsed: IostatArgs): string {
    const runQueue = (ctx.machine.processControl?.list() ?? []).filter((p) => p.state === 'R').length;
    const cpuRow = sampleIostatCpu(runQueue, ctx.machine.metrics!.cpu().logicalCpus);
    const devices = sampleIostatDevices(parsed, ctx.machine.metrics!.disks());
    return renderIostatReport(parsed, cpuRow, devices, new Date());
  }
}

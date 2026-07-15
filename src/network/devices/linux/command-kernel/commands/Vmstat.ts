import { StreamingCommand } from '@/command-kernel/command/streaming-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { parseVmstatArgs, vmstatHeader, formatVmstatRow, type VmstatSample } from '../../system/Vmstat';

/**
 * `vmstat [options] [intervalle [nombre]]` — statistiques mémoire/procs/cpu.
 * Sans intervalle : en-tête + une ligne (instantané). Avec intervalle :
 * commande à sortie continue (§14.6) — en-tête une fois, puis une ligne par
 * intervalle, jusqu'au `nombre` demandé ou Ctrl+C. La commande décide de son
 * mode via `isStreaming(argv)`. Accède à la machine par `ctx.machine`
 * uniquement (`processControl` pour les états de processus, `metrics.memory`
 * pour la mémoire live).
 */
export class VmstatCommand extends StreamingCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'vmstat',
    summary: 'Statistiques mémoire virtuelle, processus et CPU',
    usage: 'vmstat [-w] [-n] [-S unit] [intervalle [nombre]]',
    args: [{ name: 'operands', type: 'string', required: false, variadic: true, description: '[options] [intervalle [nombre]]' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
    lenientOptions: true,
  };

  override isStreaming(argv: readonly string[]): boolean {
    const parsed = parseVmstatArgs([...argv]);
    return !('error' in parsed) && parsed.intervalSeconds !== null;
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const argv = ctx.args.has('operands') ? ctx.args.get<string[]>('operands') : [];
    const parsed = parseVmstatArgs([...argv]);
    if ('error' in parsed) {
      await ctx.io.stdout.write(parsed.error + '\n');
      return 1;
    }

    await this.emit(ctx, vmstatHeader(parsed));

    // Instantané : pas d'intervalle, OU appel programmatique (sans flux
    // terminal vivant) qui ne doit jamais tourner indéfiniment. Une ligne.
    if (parsed.intervalSeconds === null || !ctx.io.interaction) {
      await this.emit(ctx, formatVmstatRow(this.sample(ctx), parsed));
      return EXIT_OK;
    }

    // Flux continu : une ligne par intervalle (respecte Ctrl+C), bornée par
    // `nombre` si fourni.
    const intervalMs = Math.max(100, parsed.intervalSeconds * 1000);
    const count = parsed.count;
    for (let i = 0; count === null ? !ctx.signal.aborted : i < count; i++) {
      if (ctx.signal.aborted) break;
      await this.emit(ctx, formatVmstatRow(this.sample(ctx), parsed));
      const hasNext = count === null || i < count - 1;
      if (hasNext && !ctx.signal.aborted) await this.pace(intervalMs, ctx.signal);
    }
    return EXIT_OK;
  }

  private sample(ctx: CommandContext): VmstatSample {
    const procs = ctx.machine.processControl?.list() ?? [];
    const procsR = procs.filter((p) => p.state === 'R').length;
    const procsB = procs.filter((p) => p.state === 'D').length;
    const cpuLoad = Math.min(100, procsR * 100);
    const cpuUser = Math.round(cpuLoad * 0.6);
    const cpuSystem = Math.round(cpuLoad * 0.4);
    const cpuIdle = Math.max(0, 100 - cpuUser - cpuSystem);
    const mem = ctx.machine.metrics?.memory();
    return {
      procsR,
      procsB,
      swpdKib: mem?.swapUsedKib ?? 0,
      freeKib: mem?.freeKib ?? 0,
      buffKib: mem?.buffersKib ?? 0,
      cacheKib: mem?.cacheKib ?? 0,
      siKibPerSec: 0,
      soKibPerSec: 0,
      biBlocksPerSec: 0,
      boBlocksPerSec: 0,
      interruptsPerSec: 0,
      ctxSwitchesPerSec: 0,
      cpuUser,
      cpuSystem,
      cpuIdle,
      cpuIowait: 0,
      cpuSteal: 0,
    };
  }
}
